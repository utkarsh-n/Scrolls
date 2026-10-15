// OWNER: WP2 — loading the STEMM adapters as the Adapters page does (SPEC §10, §6.8 phase C): chained adapter-load jobs
// that resume from what is committed, cancellation that rolls back only the running chunk, the coverage line of what
// was loaded, OpenAlex's within-cell sample (cells, citations in bounded batches, date conflicts), and Wiktionary
// claims written on tracked real expressions (never on synthetic ones, never as occurrences). The staged sources are
// read in place through symlinks from a temp data dir; absent sources skip with a message.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureDirs } from '../server/config.mjs';
import { loadAdapter, registerAdapters } from '../server/adapters/registry.mjs';
import { migrate } from '../server/db/migrate.mjs';
import { nowIso, openDb } from '../server/db/open.mjs';
import { seedVocab } from '../server/db/seed-vocab.mjs';
import { CancelledError, makeTaskContext } from '../server/jobs/context.mjs';
import { OPENALEX_CELLS_KEY, readLoadState, run } from '../server/jobs/tasks/adapter-load.mjs';
import { claimsQuery } from '../server/routes/adapters.mjs';

const REAL = path.join(homedir(), 'Developer', 'scrolls-data', 'sources');
const STAGED = ['gutenberg-stemm', 'openalex', 'wiktionary-coinage'];
const missing = STAGED.filter((s) => !existsSync(path.join(REAL, s, 'MANIFEST.json')));
const SKIP = missing.length > 0 && `staged sources not found: ${missing.join(', ')}`;

/** Run an adapter-load chain the way the queue does: each part is a job; the next part's params come from its job row. */
async function runChain(db, params, { maxParts = 400, wrap = null } = {}) {
  const insJob = (p) => Number(db.prepare(`INSERT INTO job (type, params_json, writes, priority, status, created_at)
    VALUES ('adapter-load', ?, 1, 6, 'running', ?)`).run(JSON.stringify(p), nowIso()).lastInsertRowid);
  let jobId = insJob(params), p = params;
  const parts = [];
  for (let i = 0; i < maxParts; i++) {
    const ctx = makeTaskContext({ db, jobId, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    if (wrap) wrap(ctx, i);
    let r;
    try {
      r = await run(ctx, p);
    } catch (err) {
      db.prepare("UPDATE job SET status = ? WHERE id = ?").run(err.code === 'E_CANCELLED' ? 'cancelled' : 'failed', jobId);
      parts.push({ error: err });
      return parts;
    }
    db.prepare("UPDATE job SET status = 'succeeded' WHERE id = ?").run(jobId);
    parts.push(r);
    if (!r.continued_by) return parts;
    jobId = r.continued_by;
    db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(jobId);
    p = JSON.parse(db.prepare('SELECT params_json FROM job WHERE id = ?').get(jobId).params_json);
  }
  throw new Error(`chain did not finish in ${maxParts} parts`);
}

const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;
const collDocs = (db, slug) => count(db, `SELECT count(*) AS n FROM document d JOIN collection c ON c.id = d.collection_id
  WHERE c.slug = ? AND d.deleted_at IS NULL`, slug);

describe('chained STEMM loads on the staged sources (§10.2, phase C)', { skip: SKIP }, () => {
  let dir, db, saved;
  before(async () => {
    saved = process.env.SCROLLS_DATA;
    dir = mkdtempSync(path.join(tmpdir(), 'scrolls-stemm-load-'));
    mkdirSync(path.join(dir, 'sources'), { recursive: true });
    for (const s of STAGED) symlinkSync(path.join(REAL, s), path.join(dir, 'sources', s));
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

  // 2 copyrighted texts, a lifetime estimate before the common era, a two-month issue, MARC 906 and undated rows
  const GS_IDS = [34, 39, 1228, 30155, 14565, 22914, 39854, 64207, 63372, 49];

  test('gutenberg-stemm: a cancelled chunk is rolled back, the chain stops and keeps committed chunks; Load again finishes without duplicates', async () => {
    const parts = await runChain(db, { adapter: 'stemm.gutenberg-stemm', ids: GS_IDS, chunkMs: 1 }, {
      // part 1 commits one document; part 2 is cancelled at its first checkpoint (what POST /api/jobs/:id/cancel causes)
      wrap: (ctx, i) => { if (i === 1) ctx.checkpoint = () => { throw new CancelledError(); }; },
    });
    assert.equal(parts.length, 2);
    assert.equal(parts[0].continued_by > 0, true);
    assert.equal(parts[1].error.code, 'E_CANCELLED');
    assert.equal(collDocs(db, 'stemm-gutenberg') + collDocs(db, 'stemm-gutenberg-restricted'), 1, 'only the committed chunk stays');
    assert.ok(count(db, "SELECT count(*) AS n FROM import_batch WHERE adapter_id = 'stemm.gutenberg-stemm' AND status = 'cancelled'") >= 1);
    const st = readLoadState(db, 'stemm.gutenberg-stemm');
    assert.equal(st.status, 'cancelled');
    assert.match(st.message, /committed chunks are kept/);
    const statuses = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'collection_status:stemm-gutenberg%'").all().map((r) => r.value);
    assert.ok(statuses.includes('partial'));

    // Load again: a new chain resumes from the committed documents
    const again = await runChain(db, { adapter: 'stemm.gutenberg-stemm', ids: GS_IDS, chunkMs: 1 });
    const done = again.at(-1);
    assert.equal(done.phase, 'done');
    assert.ok(again.length >= GS_IDS.length - 1, `one document per 1 ms chunk (${again.length} parts)`);
    assert.ok(again.every((p) => !p.error));
    const ext = db.prepare("SELECT d.ext_id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug LIKE 'stemm-gutenberg%'").all().map((r) => r.ext_id);
    assert.equal(ext.length, GS_IDS.length);
    assert.equal(new Set(ext).size, ext.length, 'no duplicates');
    // the copyrighted texts are in the no-export collection
    const restricted = db.prepare("SELECT d.ext_id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'stemm-gutenberg-restricted'").all().map((r) => r.ext_id).sort();
    assert.deepEqual(restricted, ['pgs:34', 'pgs:39', 'pgs:49']);
    assert.equal(db.prepare("SELECT export_text_allowed FROM collection WHERE slug = 'stemm-gutenberg-restricted'").get().export_text_allowed, 0);
    // the coverage line of what was loaded is a caveat of the collection; the collections are ready
    const cav = JSON.parse(db.prepare("SELECT caveats_json FROM collection WHERE slug = 'stemm-gutenberg'").get().caveats_json);
    assert.ok(cav.some((c) => /^loaded: dated by evidence \d+ · lifetime estimate \d+ · undated \d+ · after 1928 \d+$/.test(c)), cav.join(' | '));
    const cov = done.coverage['stemm-gutenberg'];
    assert.equal(cov.dated_by_evidence + cov.lifetime_estimate + cov.undated, collDocs(db, 'stemm-gutenberg'));
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'collection_status:stemm-gutenberg'").get().value, 'ready');
    // BCE lifetime estimate (#64207: -6 … 50 historical) is astronomical inside, estimated, a range
    const bce = db.prepare("SELECT y_lo, y_hi, basis, precision FROM document WHERE ext_id = 'pgs:64207'").get();
    assert.deepEqual([bce.y_lo, bce.y_hi, bce.basis, bce.precision], [-5, 50, 'estimated', 'range']);
    // a two-month issue (#39854, March–April 1916) spans exactly its two months
    const issue = db.prepare("SELECT kind, date_label, precision FROM document WHERE ext_id = 'pgs:39854'").get();
    assert.equal(issue.kind, 'periodical');
    assert.equal(issue.precision, 'range');
    // transcriber residue is apparatus, not text: #22914's inline "[Transcriber's Note: …]" corrections
    const app = count(db, `SELECT count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id
      WHERE d.ext_id = 'pgs:22914' AND p.time_role = 'apparatus' AND p.field = 'body'`);
    assert.ok(app >= 5, `apparatus passages in #22914: ${app}`);
  });

  test('OpenAlex: a chained load of four cells; every document in its sample cell; citations in bounded batches, no duplicates; conflicts flagged', async () => {
    const params = { adapter: 'stemm.openalex', fields: ['Mathematics'], years: [1665, 1899], chunkMs: 400, relChunk: 7 };
    const parts = await runChain(db, params);
    const done = parts.at(-1);
    assert.equal(done.phase, 'done', JSON.stringify(done).slice(0, 300));
    assert.ok(parts.length > 2, `several parts (${parts.length})`);
    // the four pre-1900 Mathematics cells hold min(200, population) works each
    const oa = await loadAdapter('stemm.openalex');
    const cells = oa.loadCells().filter((c) => c.field === 'Mathematics' && c.bin_end <= 1899);
    assert.equal(cells.length, 4);
    assert.equal(collDocs(db, 'stemm-openalex'), cells.reduce((n, c) => n + c.fetched, 0));
    for (const r of db.prepare("SELECT d.original_meta_json AS m, d.y_lo FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'stemm-openalex'").all()) {
      const m = JSON.parse(r.m);
      assert.equal(m.sample_cell, oa.cellOf({ field: m.field, year: m.year }));
    }
    const meta = JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(OPENALEX_CELLS_KEY).value);
    assert.equal(meta.cells.length, 600);
    assert.equal(meta.bins.length, 30);
    // pre-1900 field labels say they are a modern classifier's guess
    assert.equal(count(db, `SELECT count(*) AS n FROM doc_tag t JOIN document d ON d.id = t.document_id WHERE d.ext_id LIKE 'oa:%'
      AND t.scheme = 'field' AND t.method NOT LIKE '%guess for a pre-1900 work%'`), 0);
    // citations: exactly the pairs of citations.tsv between loaded works, each documented with its locator, none twice
    const ids = new Set(db.prepare("SELECT substr(ext_id, 4) AS w FROM document WHERE ext_id LIKE 'oa:%'").all().map((r) => r.w));
    let expected = 0, conflicts = 0;
    for (const line of readFileSync(path.join(REAL, 'openalex', 'citations.tsv'), 'utf8').split('\n').slice(1)) {
      const [a, b, ya, yb] = line.split('\t');
      if (ids.has(a) && ids.has(b)) { expected++; if (Number(yb) > Number(ya)) conflicts++; }
    }
    const rels = db.prepare("SELECT * FROM relationship WHERE source_dataset = 'openalex'").all();
    assert.equal(rels.length, expected);
    assert.equal(new Set(rels.map((r) => `${r.src_ref}|${r.dst_ref}`)).size, rels.length);
    assert.ok(rels.every((r) => r.evidence_status === 'documented' && r.origin === 'source_dataset' && /^https:\/\/openalex\.org\/W\d+$/.test(r.source_locator)));
    assert.equal(rels.filter((r) => r.date_conflict === 1).length >= conflicts, true, 'every later-dated citation is a date conflict');
    assert.ok(count(db, "SELECT count(*) AS n FROM import_batch WHERE adapter_id = 'stemm.openalex' AND options_json LIKE '%relationships%'") >= Math.ceil(expected / 7));
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'collection_status:stemm-openalex'").get().value, 'ready');
    // abstracts: never 'ok' when gappy or a body excerpt
    const bad = count(db, `SELECT count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id WHERE d.ext_id LIKE 'oa:%' AND p.field = 'body'
      AND p.quality = 'ok' AND json_extract(d.original_meta_json, '$.abstract_tokens') > 1000`);
    assert.equal(bad, 0);
  });

  test('Wiktionary: the word index, one entry document per etymology text, claims on tracked real expressions only', async () => {
    const ins = db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
      VALUES (?, 'word', ?, ?, 'en', ?, ?, 'test', ?)`);
    const real = Number(ins.run(null, 'laser', 'laser', 'user_query', 0, nowIso()).lastInsertRowid);
    const genome = Number(ins.run(null, 'genome', 'genome', 'user_query', 0, nowIso()).lastInsertRowid);
    const demo = db.prepare("SELECT id FROM corpus WHERE slug = 'demo'").get().id;
    const syn = Number(ins.run(demo, 'meme', 'meme', 'demo', 1, nowIso()).lastInsertRowid);
    const [r] = await runChain(db, { adapter: 'stemm.wiktionary' });
    assert.ok(r.claims.written >= 1, JSON.stringify(r.claims));
    const rows = db.prepare("SELECT * FROM date_assertion WHERE subject_type = 'expression' AND role = 'first_attestation_claim'").all();
    assert.ok(rows.every((x) => x.subject_id === real), 'claims only on the real tracked expression (genome: the 1920 date is the German word\'s)');
    assert.ok(!rows.some((x) => x.subject_id === syn || x.subject_id === genome));
    assert.ok(rows.every((x) => x.basis === 'stated' && x.is_chronology === 0 && x.asserted_by === 'wiktionary'));
    // one entry document for laser (noun and verb share the etymology): the entry field only, no title passage
    const docs = db.prepare("SELECT d.id, d.ext_id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'stemm-wiktionary'").all();
    assert.equal(docs.filter((d) => d.ext_id.startsWith('wikt:en:laser:')).length, 1);
    const fields = db.prepare('SELECT DISTINCT p.field, p.time_role FROM passage p WHERE p.document_id = ?').all(docs[0].id);
    assert.deepEqual(fields.map((f) => [f.field, f.time_role]), [['entry', 'describes']]);
    assert.equal(count(db, 'SELECT count(*) AS n FROM occurrence'), 0, 'never an occurrence');
    // the claims endpoint's query: written claims with their highlight in the entry passage
    const q = await claimsQuery(db, { adapter: 'stemm.wiktionary', expr: real });
    assert.equal(q.loaded, true);
    const c = q.claims[0];
    assert.equal(c.label, 'Wiktionary: coined 1957 (external claim)');
    assert.equal(c.display, 'default');
    const passage = db.prepare('SELECT * FROM passage WHERE id = ?').get(c.highlight.passage);
    const value = db.prepare("SELECT value FROM document_field WHERE document_id = ? AND field = 'entry'").get(passage.document_id).value;
    assert.equal(value.slice(c.highlight.start, c.highlight.end), c.span);
    // idempotent: loading again writes nothing new
    const [again] = await runChain(db, { adapter: 'stemm.wiktionary', expressionId: real });
    assert.equal(again.claims.written, 0);
    assert.ok(again.claims.already >= 1);
  });
});
