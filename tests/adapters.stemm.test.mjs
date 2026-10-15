// OWNER: WP2 — the STEMM adapters on the staged sources (SPEC §10): each reads FORMAT.md + MANIFEST.json first and
// says why it is unavailable instead of crashing; gutenberg-stemm (byte bounds → offsets, sha256 check, dates by
// basis, copyrighted texts kept from export), OpenAlex (within-cell sample, gappy/low abstracts, machine tags,
// documented citations with date conflicts), Wiktionary (claims with display rules, never occurrences), the Ngram
// baseline (per-decade per-million, single words only), and the /api/adapters and /api/baseline routes.
// The staged sources are read in place through symlinks from a temp data dir; absent sources skip with a message.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { ensureDirs } from '../server/config.mjs';
import { loadAdapter, registerAdapters } from '../server/adapters/registry.mjs';
import { migrate } from '../server/db/migrate.mjs';
import { openDb } from '../server/db/open.mjs';
import { seedVocab } from '../server/db/seed-vocab.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { loadAdapterData, writeExpressionClaims } from '../server/jobs/tasks/adapter-load.mjs';
import { checkResponse } from './helpers/shape.mjs';
import { startServerProcess } from './helpers/server.mjs';

const REAL = path.join(homedir(), 'Developer', 'scrolls-data', 'sources');
const STAGED = ['gutenberg-stemm', 'openalex', 'wiktionary-coinage', 'ngram-baseline'];
const missing = STAGED.filter((s) => !existsSync(path.join(REAL, s, 'MANIFEST.json')));
const SKIP = missing.length > 0 && `staged sources not found: ${missing.join(', ')}`;
const taskCtx = (db) => makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });

/** A temp data dir whose sources/ point at the staged folders (read-only use). */
function stagedDataDir({ only = STAGED } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-stemm-'));
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  for (const s of only) symlinkSync(path.join(REAL, s), path.join(dir, 'sources', s));
  return dir;
}

describe('STEMM adapters on the staged sources (§10.2)', { skip: SKIP }, () => {
  let dir, db, saved;
  before(async () => {
    saved = process.env.SCROLLS_DATA;
    dir = stagedDataDir();
    process.env.SCROLLS_DATA = dir;
    ensureDirs();
    db = openDb();
    migrate(db);
    seedVocab(db);
    await registerAdapters(db);
  });
  after(() => {
    db?.close();
    if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test('every STEMM adapter probes its MANIFEST.json + FORMAT.md and is available', async () => {
    for (const id of ['stemm.gutenberg-stemm', 'stemm.openalex', 'stemm.wiktionary', 'stemm.ngram']) {
      const p = await (await loadAdapter(id)).probe({});
      assert.equal(p.available, true, `${id}: ${p.reason}`);
      assert.ok(p.manifest_ok && p.format_ok, id);
    }
  });

  test('Ngram: per-decade per-million (Σ counts / Σ tokens); virus 1820s = 1.07; single words only', async () => {
    const ngram = await loadAdapter('stemm.ngram');
    const s = ngram.baseline().series('virus');
    assert.deepEqual(check('Baseline', s), []);
    assert.equal(s.decades.find((d) => d.decade === 1820).per_million, 1.07);
    assert.ok(s.label.includes('a different corpus'));
    assert.ok(s.attribution);
    assert.deepEqual(ngram.baseline().series('carry the zero'), { available: false, reason: 'single words only' });
    assert.ok(ngram.baseline().series('hacker').caveats.some((c) => /proper-noun or sentence-initial/.test(c)));
    assert.equal(ngram.baseline().series('cold-wire').available, false);
  });

  test('gutenberg-stemm: byte bounds become UTF-16 offsets; dates by basis; copyrighted texts are kept from export', async () => {
    const gs = await loadAdapter('stemm.gutenberg-stemm');
    const r = await loadAdapterData(taskCtx(db), gs, { ids: [34, 39, 1228, 30155] });
    assert.equal(r.collections['stemm-gutenberg'].documents.created + r.collections['stemm-gutenberg-restricted'].documents.created, 4);
    assert.equal(db.prepare("SELECT export_text_allowed FROM collection WHERE slug = 'stemm-gutenberg-restricted'").get().export_text_allowed, 0);
    const cat = new Map(readFileSync(path.join(REAL, 'gutenberg-stemm', 'catalog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.id, x]));
    for (const d of db.prepare("SELECT d.ext_id, t.original, t.body_start, t.body_end FROM document d JOIN document_text t ON t.document_id = d.id WHERE d.ext_id LIKE 'pgs:%'").all()) {
      const row = cat.get(Number(d.ext_id.slice(4)));
      const bytes = readFileSync(path.join(REAL, 'gutenberg-stemm', row.file));
      const body = new TextDecoder(row.encoding === '8-bit (not valid UTF-8)' ? 'windows-1252' : 'utf-8').decode(bytes.subarray(row.body_start_byte, row.body_end_byte));
      assert.equal(d.original.slice(d.body_start, d.body_end), body.replace(/^﻿/, ''), d.ext_id);
    }
    const zen = db.prepare("SELECT * FROM document WHERE ext_id = 'pgs:34'").get();
    assert.deepEqual([zen.basis, zen.precision], ['estimated', 'range']);
    const origin = db.prepare("SELECT * FROM document WHERE ext_id = 'pgs:1228'").get();
    assert.equal(origin.field, 'life-sciences');
    const rel = db.prepare("SELECT role, is_chronology FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND role = 'release'").get(origin.id);
    assert.equal(rel.is_chronology, 0);
  });

  test('gutenberg-stemm: a file whose sha256 differs from the catalogue is skipped with W_SHA_MISMATCH', async () => {
    // a private staged copy whose catalogue lies about one file's sha256
    const alt = path.join(dir, 'sources', 'gutenberg-stemm-alt');
    mkdirSync(path.join(alt, 'texts'), { recursive: true });
    for (const f of ['MANIFEST.json', 'FORMAT.md', 'cipher-overlap.jsonl']) copyFileSync(path.join(REAL, 'gutenberg-stemm', f), path.join(alt, f));
    const row = JSON.parse(readFileSync(path.join(REAL, 'gutenberg-stemm', 'catalog.jsonl'), 'utf8').split('\n').find((l) => l.includes('"id":39,')));
    copyFileSync(path.join(REAL, 'gutenberg-stemm', row.file), path.join(alt, row.file));
    writeFileSync(path.join(alt, 'catalog.jsonl'), `${JSON.stringify({ ...row, sha256: '0'.repeat(64) })}\n`);
    const gsMod = await import('../server/adapters/stemm/gutenberg-stemm.mjs');
    const warnings = [];
    const docs = [];
    const real = path.join(dir, 'sources', 'gutenberg-stemm');
    rmSync(real);
    symlinkSync(alt, real);
    try {
      for await (const d of gsMod.documents({}, { warn: (code, msg) => warnings.push(code), keepOriginal: () => null })) docs.push(d);
    } finally {
      rmSync(real);
      symlinkSync(path.join(REAL, 'gutenberg-stemm'), real);
    }
    assert.equal(docs.length, 0);
    assert.deepEqual(warnings, ['W_SHA_MISMATCH']);
  });

  test('Wiktionary: claims carry display rules and "(external claim)"; loading writes them on the expression, never as occurrences', async () => {
    const wk = await loadAdapter('stemm.wiktionary');
    const virus = await wk.claims().lookup('virus');
    assert.ok(virus.length >= 1);
    assert.ok(virus.every((c) => c.label.endsWith('(external claim)') && ['default', 'dimmed'].includes(c.display)));
    assert.equal(virus[0].year, 1972);
    assert.deepEqual(await wk.claims().lookup('algorithm'), []);
    db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
      VALUES (NULL, 'word', 'virus', 'virus', 'en', 'stemm_seed', 0, 'test', '2026-10-04T00:00:00Z')`).run();
    const exprId = db.prepare("SELECT id FROM expression WHERE norm = 'virus'").get().id;
    const w = writeExpressionClaims(taskCtx(db), exprId, virus);
    assert.equal(w.written, virus.length);
    const a = db.prepare("SELECT * FROM date_assertion WHERE subject_type = 'expression' AND subject_id = ?").all(exprId);
    assert.ok(a.every((x) => x.role === 'first_attestation_claim' && x.basis === 'stated' && x.asserted_by === 'wiktionary' && x.is_chronology === 0));
    assert.equal(writeExpressionClaims(taskCtx(db), exprId, virus).written, 0, 'idempotent');
    assert.equal(db.prepare('SELECT count(*) AS n FROM occurrence').get().n, 0);
  });

  test('OpenAlex: a field × period slice; abstracts flagged gappy/low; machine tags; documented citations; no text export', async () => {
    const oa = await loadAdapter('stemm.openalex');
    const r = await loadAdapterData(taskCtx(db), oa, { fields: ['Computer Science'], years: [1950, 1959] });
    const c = r.collections['stemm-openalex'];
    assert.ok(c.documents.created > 100);
    assert.equal(db.prepare("SELECT export_text_allowed, sampling FROM collection WHERE slug = 'stemm-openalex'").get().export_text_allowed, 0);
    const q = Object.fromEntries(db.prepare(`SELECT p.quality, count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id
      WHERE d.ext_id LIKE 'oa:%' AND p.field = 'body' GROUP BY p.quality`).all().map((x) => [x.quality, x.n]));
    assert.ok(q.ok > 0);
    const tags = db.prepare("SELECT DISTINCT provenance, method FROM doc_tag t JOIN document d ON d.id = t.document_id WHERE d.ext_id LIKE 'oa:%' AND t.scheme IN ('field','topic')").all();
    assert.deepEqual(tags.map((t) => t.provenance), ['adapter_machine']);
    const rels = db.prepare("SELECT * FROM relationship WHERE source_dataset = 'openalex'").all();
    assert.ok(rels.length > 0 && rels.every((x) => x.evidence_status === 'documented' && x.source_locator.startsWith('https://openalex.org/W')));
    const note = db.prepare("SELECT note FROM date_assertion a JOIN document d ON a.subject_type = 'document' AND a.subject_id = d.id WHERE d.ext_id LIKE 'oa:%' AND a.role = 'publication' LIMIT 1").get().note;
    assert.match(note, /reprint or digitisation year/);
    // fix pass (D18): every work points at its own line of the kept works.jsonl
    const docs = db.prepare(`SELECT d.ext_id, d.source_file_sha256 AS sha, d.source_byte_start AS s, d.source_byte_end AS e, f.rel_path
      FROM document d LEFT JOIN original_file f ON f.sha256 = d.source_file_sha256 WHERE d.ext_id LIKE 'oa:%'`).all();
    assert.ok(docs.length > 100 && docs.every((d) => d.sha && d.rel_path && Number.isInteger(d.s) && d.e > d.s), 'a pointer on every work');
    const bytes = readFileSync(path.join(process.env.SCROLLS_DATA, docs[0].rel_path));
    for (const d of docs.slice(0, 25)) assert.equal(`oa:${JSON.parse(bytes.toString('utf8', d.s, d.e)).id}`, d.ext_id);
  });
});

describe('the /api/adapters and /api/baseline routes', { skip: SKIP }, () => {
  let srv, dir;
  before(async () => {
    dir = stagedDataDir({ only: ['openalex', 'ngram-baseline', 'wiktionary-coinage'] });
    srv = await startServerProcess({ dataDir: dir, timeoutMs: 30000 });
  });
  after(async () => {
    await srv?.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET /api/adapters → Adapters: every adapter, staged probes, the fetch command when a source is missing', async () => {
    const r = await srv.request('GET', '/api/adapters');
    const body = await checkResponse(new Response(r.text, { status: r.status }), 'GET', '/api/adapters');
    const by = Object.fromEntries(body.map((a) => [a.id, a]));
    assert.equal(by['stemm.openalex'].available, true);
    assert.ok(by['stemm.openalex'].staged.manifest_ok);
    assert.equal(by['stemm.gutenberg-stemm'].available, false);
    assert.equal(by['stemm.gutenberg-stemm'].command, 'node tools/fetch/gutenberg-stemm.mjs');
    assert.ok(by.demo);
  });

  test('POST /api/adapters/:id/load: unavailable → 409 with the fetcher to run; the Ngram store has nothing to load', async () => {
    const un = await srv.request('POST', '/api/adapters/stemm.gutenberg-stemm/load', { body: {} });
    assert.equal(un.status, 409);
    assert.equal(un.json.error.code, 'E_ADAPTER_UNAVAILABLE');
    assert.match(un.json.error.hint, /tools\/fetch\/gutenberg-stemm\.mjs/);
    const ng = await srv.request('POST', '/api/adapters/stemm.ngram/load', { body: {} });
    assert.equal(ng.status, 409);
    const nf = await srv.request('POST', '/api/adapters/nope/load', { body: {} });
    assert.equal(nf.status, 404);
  });

  test('POST /api/adapters/:id/load validates its params per adapter; GET /api/adapters says what can be loaded', async () => {
    const bad = await srv.request('POST', '/api/adapters/stemm.openalex/load', { body: { years: [1900] } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'E_VALIDATION');
    const list = await srv.request('GET', '/api/adapters');
    const by = Object.fromEntries(list.json.map((a) => [a.id, a]));
    assert.equal(by['stemm.openalex'].loadable, true);
    assert.equal(by['stemm.ngram'].loadable, false);
    assert.match(by['stemm.ngram'].note, /\/api\/baseline/);
    assert.equal(by['stemm.openalex'].staged.counts.abstracts, 60574);
  });

  test('GET /api/adapters/:id/claims: the word index first; then Wiktionary claims quoted as external claims; other adapters state none', async () => {
    const slow = { timeoutMs: 60000 }; // the first lookups parse the 7 MB word index in a read worker
    const before = await srv.request('GET', '/api/adapters/stemm.wiktionary/claims?word=laser', slow);
    assert.equal(before.status, 200);
    assert.equal(before.json.available, false);
    assert.match(before.json.reason, /word index is not built/);
    const load = await srv.request('POST', '/api/adapters/stemm.wiktionary/load', { body: {}, ...slow });
    assert.equal(load.status, 200);
    let job;
    for (let i = 0; i < 240; i++) {
      job = (await srv.request('GET', `/api/jobs/${load.json.job.id}`, slow)).json;
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    const after = await srv.request('GET', '/api/adapters/stemm.wiktionary/claims?word=laser&lang=en', slow);
    assert.equal(after.json.available, true);
    assert.equal(after.json.loaded, false);
    assert.deepEqual(after.json.claims.map((c) => [c.label, c.display]), [['Wiktionary: coined 1957 (external claim)', 'default']]);
    assert.match(after.json.attribution, /Wiktionary contributors/);
    assert.equal((await srv.request('GET', '/api/adapters/stemm.ngram/claims?word=laser')).json.error.code, 'E_NO_CLAIMS');
    assert.equal((await srv.request('GET', '/api/adapters/stemm.wiktionary/claims')).status, 400);
    assert.equal((await srv.request('GET', '/api/adapters/stemm.wiktionary/claims?expr=999999')).status, 404);
  });

  test('GET /api/baseline → Baseline; multi-word → single words only', async () => {
    const r = await srv.request('GET', '/api/baseline?word=virus&from=1800&to=1899');
    const body = await checkResponse(new Response(r.text, { status: r.status }), 'GET', '/api/baseline');
    assert.equal(body.available, true);
    assert.ok(body.decades.every((d) => d.decade >= 1800 && d.decade <= 1890));
    const m = await srv.request('GET', `/api/baseline?word=${encodeURIComponent('carry the zero')}`);
    assert.deepEqual(m.json, { available: false, reason: 'single words only' });
    const fr = await srv.request('GET', '/api/baseline?word=virus&lang=fr');
    assert.deepEqual(fr.json, { available: false, reason: 'The Ngram store holds English words only.' });
    assert.equal((await srv.request('GET', '/api/baseline?word=virus&lang=1')).status, 400);
    assert.equal((await srv.request('GET', '/api/baseline?word=virus&from=1900&to=1800')).status, 400);
  });
});

// ── P2: pure rules of the STEMM adapters (no database) ─────────────────────────────────────────────

describe('Gutenberg residue inside the body is flagged, never deleted (gutenberg-stemm FORMAT.md "Gutenberg residue")', () => {
  test('bracketed transcriber notes, a note under its heading, an ASCII box and convention notes are apparatus; the author\'s text is not', async () => {
    const { residueRegions, bodyRegions } = await import('../server/adapters/cipher/gutenberg-text.mjs');
    const text = [
      'Produced by A. Volunteer and the Online Distributed Proofreading Team at https://www.pgdp.net',
      '',
      '[Transcriber\'s Note:',
      '',
      'Obvious printer errors have been corrected.]',
      '',
      'Text printed in italics has been transcribed between _underscores_.',
      '',
      'CHAPTER I.',
      '',
      'The author wrote this sentence about the Elutherius [Transcriber\'s Note: Eleutherius] experiment in 1661.',
      '',
      'Another paragraph by the author, with no notes at all, long enough to be a real paragraph of the book.',
      '',
      '+----------------------------------+',
      '| Transcriber\'s Note: the tables   |',
      '| were split to fit the e-text.    |',
      '+----------------------------------+',
      '',
      'More of the author\'s own words follow here and are kept as text.',
      '',
      'Transcriber\'s Notes',
      '',
      'Page 23: "teh" changed to "the".',
      '',
    ].join('\n');
    const regions = residueRegions(text, 0, text.length);
    const quoted = regions.map((r) => text.slice(r.start, r.end));
    assert.ok(regions.every((r) => r.time_role === 'apparatus' && r.field_class === 'apparatus'));
    assert.ok(quoted.some((q) => q.startsWith('[Transcriber\'s Note:') && q.endsWith('corrected.]')));
    assert.ok(quoted.includes('[Transcriber\'s Note: Eleutherius]'), 'an inline correction is flagged alone');
    assert.ok(quoted.some((q) => q.startsWith('Text printed in italics')));
    assert.ok(quoted.some((q) => q.startsWith('+---') && q.includes('e-text')));
    assert.ok(quoted.some((q) => q.startsWith('Transcriber\'s Notes') && q.includes('changed to')));
    assert.ok(!quoted.some((q) => /author wrote|Another paragraph|own words/.test(q)), 'the author\'s text is never swallowed');
    const credits = bodyRegions(text, 0, text.length).regions.filter((r) => r.quality === 'boilerplate').map((r) => text.slice(r.start, r.end));
    assert.ok(credits.some((q) => q.startsWith('Produced by')));
  });
});

describe('gutenberg-stemm dates by basis over the whole catalogue (§10.2)', { skip: SKIP }, () => {
  test('stated · estimated range · undated match MANIFEST.counts.by_basis; historical years become astronomical; release is never chronology', async () => {
    const saved = process.env.SCROLLS_DATA;
    const dir = stagedDataDir({ only: ['gutenberg-stemm'] });
    process.env.SCROLLS_DATA = dir;
    try {
      const gs = await import('../server/adapters/stemm/gutenberg-stemm.mjs');
      const rows = gs.loadCatalog();
      const manifest = JSON.parse(readFileSync(path.join(REAL, 'gutenberg-stemm', 'MANIFEST.json'), 'utf8'));
      const by = { stated: 0, estimated: 0, unknown: 0 };
      for (const r of rows) {
        const d = gs.primaryDate(r, 'adapter:test');
        by[d.parsed.basis]++;
        assert.equal(d.is_chronology, true);
        if (d.parsed.basis === 'estimated') assert.equal(d.parsed.precision, 'range');
        if (r.year_lo !== null && r.year_lo < 0) assert.equal(d.parsed.lo_year, r.year_lo + 1, 'BCE → astronomical');
        if (r.date_precision === 'month-range') assert.match(d.note, /two-month issue/);
      }
      const b = manifest.counts.by_basis;
      assert.equal(by.stated, b['title-stated'] + b['gutenberg-marc906'] + b['wikidata-P577'] + b['wikidata-work-P577']);
      assert.equal(by.estimated, b['author-lifetime-estimate']);
      assert.equal(by.unknown, b.unknown);
      const cov = gs.coverageCounts(rows);
      assert.equal(cov.dated_by_evidence + cov.lifetime_estimate + cov.undated, rows.length);
      assert.equal(cov.restricted, manifest.counts.text_export_blocked);
      assert.equal(rows.filter((r) => gs.collectionOf(r) === 'stemm-gutenberg-restricted').length, 20);
    } finally {
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('OpenAlex within-cell sample (§10.4) on the whole staged file', { skip: SKIP }, () => {
  let dir, saved, oa;
  before(async () => {
    saved = process.env.SCROLLS_DATA;
    dir = stagedDataDir({ only: ['openalex'] });
    process.env.SCROLLS_DATA = dir;
    oa = await import('../server/adapters/stemm/openalex.mjs');
  });
  after(() => {
    if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test('30 bins; every work\'s cell (field × bin of its year) is its sample_cell; gappy and body-excerpt counts equal FORMAT.md', async () => {
    assert.equal(oa.BINS.length, 30);
    assert.deepEqual([oa.BINS[0].bin, oa.BINS[3].bin, oa.BINS[4].bin, oa.BINS[29].bin], ['1665-1799', '1875-1899', '1900-1904', '2025-2026']);
    assert.equal(oa.binOfYear(1664), null);
    let n = 0, mismatch = 0, gaps = 0, long = 0, gappy = 0;
    for await (const { line } of oa.fileLines(path.join(REAL, 'openalex', 'works.jsonl'))) {
      n++;
      const year = Number(/"year":(-?\d+)/.exec(line)[1]);
      const field = JSON.parse(`"${/"field":"((?:[^"\\]|\\.)*)"/.exec(line)[1]}"`);
      const cell = JSON.parse(`"${/"sample_cell":"((?:[^"\\]|\\.)*)"/.exec(line)[1]}"`);
      if (oa.cellOf({ field, year }) !== cell) mismatch++;
      const tok = Number(/"abstract_tokens":(\d+)/.exec(line)[1]), gap = Number(/"abstract_gaps":(\d+)/.exec(line)[1]);
      if (gap > 0.1 * tok && tok > 0) gaps++;
      if (tok > 1000) long++;
      if (tok > 0 && oa.abstractQuality({ abstract_tokens: tok, abstract_gaps: gap, abstract: 'x '.repeat(20) }) === 'gappy') gappy++;
    }
    assert.equal(n, 118466);
    assert.equal(mismatch, 0);
    assert.equal(gaps, 74, 'FORMAT.md: 74 works have more gaps than 10% of their tokens');
    assert.equal(long, 259, 'FORMAT.md: 259 have over 1,000 tokens (body excerpts)');
    assert.ok(gappy >= Math.max(gaps, long) && gappy <= gaps + long);
    assert.equal(oa.abstractQuality({ abstract_tokens: 3, abstract_gaps: 0, abstract: 'Volume: 4' }), 'low');
    const cells = oa.loadCells();
    assert.equal(cells.length, 600);
    assert.ok(cells.every((c) => c.fetched === Math.min(200, c.population)));
  });

  test('citations: every in-sample pair documented with its locator; 6,666 cite a later-dated work (date conflicts, never feedback)', async () => {
    const ids = new Set();
    for await (const { line } of oa.fileLines(path.join(REAL, 'openalex', 'works.jsonl'))) ids.add(/^\{"id":"(W\d+)"/.exec(line)[1]);
    let total = 0, later = 0;
    for await (const r of oa.relationships({ loaded: ids })) {
      total++;
      if (r.provenance_note?.includes('date conflict, not feedback')) later++;
      if (total === 1) {
        assert.equal(r.evidence_status, 'documented');
        assert.equal(r.origin, 'source_dataset');
        assert.match(r.source_locator, /^https:\/\/openalex\.org\/W\d+$/);
        assert.ok(Number.isInteger(r._cursor));
      }
    }
    assert.equal(total, 381800);
    assert.equal(later, 6666);
    const p = await oa.probe();
    assert.deepEqual([p.counts.works, p.counts.abstracts, p.counts.citations, p.counts.citations_cited_later], [118466, 60574, 381800, 6666]);
  });
});

describe('Wiktionary claim rules (§1.7, §10.2): external claims, display rules, never occurrences', () => {
  const entry = (over = {}) => ({ id: 'en:testword:noun:1', word: 'testword', lang: 'en', pos: 'noun', url: 'https://en.wiktionary.org/wiki/testword#English',
    etymology_text: 'Coined by a scientist in 1946. First attested in 1943 or 1944.', coinage: null, coinage_other: [], attestations: [], ...over });
  const att = (over = {}) => ({ relation: 'coined', rule: 'coined', basis: 'stated', year: 1946, year_lo: 1946, year_hi: 1946, precision: 'year',
    alternatives: null, qualifier: null, period_part: null, era: null, ambiguous: false, span: 'Coined by a scientist in 1946', span_start: 0, span_end: 29,
    date_text: '1946', subject_hint: 'headword', context_language: null, sense_specific: false, in_parentheses: false, via_template: null, ...over });

  test('display: headword → default; unclear, sense-specific, a "computer context" span, a proper noun, another spelling → dimmed; other-language → never', async () => {
    const w = await import('../server/adapters/stemm/wiktionary.mjs');
    assert.equal(w.displayOf(att()).display, 'default');
    assert.deepEqual(w.displayOf(att({ subject_hint: 'unclear' })), { display: 'dimmed', reasons: ['subject unclear'] });
    assert.equal(w.displayOf(att({ sense_specific: true })).display, 'dimmed');
    assert.equal(w.displayOf(att({ span: 'First use in the computer context by David Gerrold in his 1972' })).display, 'dimmed');
    assert.equal(w.displayOf(att({ context_language: 'German' })).display, 'dimmed');
    assert.equal(w.displayOf(att({ context_language: 'Middle English' })).display, 'default');
    assert.equal(w.displayOf(att(), { entry: entry({ pos: 'name' }) }).display, 'dimmed');
    assert.equal(w.displayOf(att(), { entry: entry({ word: 'Testword' }), surface: 'testword' }).display, 'dimmed');
    assert.equal(w.displayOf(att({ subject_hint: 'other-language-context' })).display, 'never');
  });

  test('labels quote the source and say "(external claim)"; alternatives say "one of these"; BCE is astronomical; noun + verb state a claim once', async () => {
    const w = await import('../server/adapters/stemm/wiktionary.mjs');
    const alt = att({ relation: 'first-attested', rule: 'first-attested', precision: 'alternatives', year: null, year_lo: 1943, year_hi: 1944,
      alternatives: [{ year: 1943, year_lo: 1943, year_hi: 1943, precision: 'year' }, { year: 1944, year_lo: 1944, year_hi: 1944, precision: 'year' }],
      date_text: '1943 or 1944', span: 'First attested in 1943 or 1944', span_start: 30, span_end: 60 });
    const bce = att({ relation: 'other', rule: 'dates-from', year: -300, year_lo: -300, year_hi: -300, date_text: '300 BCE', era: 'BCE', span: 'dates from 300 BCE', span_start: 0, span_end: 18 });
    const noun = entry({ attestations: [att(), alt, bce] });
    const verb = entry({ id: 'en:testword:verb:1', pos: 'verb', attestations: [att(), alt, bce] });
    const claims = w.claimsOfEntries([noun, verb], { surface: 'testword' });
    assert.equal(claims.length, 3);
    assert.ok(claims.every((c) => c.label.startsWith('Wiktionary: ') && c.label.endsWith('(external claim)') && c.entry_ids.length === 2));
    assert.ok(claims.some((c) => c.label === 'Wiktionary: coined 1946 (external claim)'));
    assert.ok(claims.some((c) => c.label === 'Wiktionary: first attested 1943 or 1944 (one of these) (external claim)'));
    const b = claims.find((c) => c.era === 'BCE');
    assert.equal(b.year_lo, -299);
    assert.equal(b.label, 'Wiktionary: dates from 300 BCE (external claim)');
  });

  test('a coinage template\'s year is dimmed, and dropped when the prose dates another language\'s word with it (genome ← German Genom 1920)', async () => {
    const w = await import('../server/adapters/stemm/wiktionary.mjs');
    const coin = { source: 'template', template: 'coin', kind: 'coined', year: 1920, year_lo: 1920, year_hi: 1920, year_precision: 'year', year_qualifier: null,
      year_raw: '1920', year_basis: 'stated', expansion: 'coined by German botanist Hans Winkler in 1920' };
    const genome = entry({ word: 'genome', etymology_text: 'From German Genom, coined by German botanist Hans Winkler in 1920.', coinage: coin,
      attestations: [att({ subject_hint: 'other-language-context', context_language: 'German', year: 1920, year_lo: 1920, year_hi: 1920 })] });
    assert.deepEqual(w.claimsOfEntry(genome, { surface: 'genome' }), []);
    const only = entry({ word: 'blorp', etymology_text: 'Coined by Ann Example in 1980.', coinage: { ...coin, year: 1980, year_lo: 1980, year_hi: 1980, year_raw: '1980',
      expansion: 'Coined by Ann Example in 1980' } });
    const [c] = w.claimsOfEntry(only, { surface: 'blorp' });
    assert.equal(c.kind, 'coinage-template');
    assert.equal(c.display, 'dimmed');
    assert.equal(c.span_start, 0);
  });

  test('claimNote ↔ claimFromAssertion round-trips; the highlight is given only when the span lies in the stored excerpt', async () => {
    const w = await import('../server/adapters/stemm/wiktionary.mjs');
    const [c] = w.claimsOfEntries([entry({ attestations: [att()] })], { surface: 'testword' });
    const note = w.claimNote(c, { document: 7, passage: 70 });
    const back = w.claimFromAssertion({ id: 1, subject_id: 3, lo_year: 1946, hi_year: 1946, precision: 'year', approx: 0, raw: '1946', rule: 'wiktionary:coined', note });
    assert.equal(back.label, c.label);
    assert.equal(back.display, 'default');
    assert.deepEqual(back.highlight, { passage: 70, start: 0, end: 29 });
    const outside = w.claimFromAssertion({ id: 2, subject_id: 3, lo_year: 1946, hi_year: 1946, precision: 'year', approx: 0, raw: '1946', rule: 'x',
      note: w.claimNote({ ...c, span_in_excerpt: false }, { document: 7, passage: 70 }) });
    assert.equal(outside.highlight, null);
  });
});

describe('Ngram baseline rules (§10.2): its own corpus, single English words', { skip: SKIP }, () => {
  test('blobs decode as little-endian u32; another language is refused; hyphenated and pre-1800 caveats', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const ng = await import('../server/adapters/stemm/ngram.mjs');
    const buf = Buffer.alloc(520 * 4);
    buf.writeUInt32LE(7, 0);
    buf.writeUInt32LE(0x01020304, 4 * 519);
    const s = ng.decodeSeries(deflateRawSync(buf));
    assert.equal(s[0], 7);
    assert.equal(s[519], 0x01020304);
    const saved = process.env.SCROLLS_DATA;
    const dir = stagedDataDir({ only: ['ngram-baseline'] });
    process.env.SCROLLS_DATA = dir;
    try {
      assert.deepEqual(ng.series('virus', { lang: 'fr' }), { available: false, reason: 'The Ngram store holds English words only.' });
      const xr = ng.series('x-ray');
      assert.ok(xr.available && xr.caveats.some((c) => /split by Google's tokenizer/.test(c)));
      const v = ng.series('virus', { from: 1700, to: 1899 });
      assert.ok(v.caveats.some((c) => /long s/.test(c)));
      assert.ok(v.decades.every((d) => d.per_million === Number(((d.matches / d.tokens) * 1e6).toPrecision(4))), 'Σ counts / Σ tokens');
    } finally {
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
