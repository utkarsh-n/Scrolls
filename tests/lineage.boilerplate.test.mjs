// OWNER: WP5 — the boilerplate pass and the virus canary (SPEC §4.7, §11): licence text shared by > 25 documents at
// their edges becomes quality='boilerplate'; commonplaces stay counted; afterwards no ok passage contains
// "computer virus, or computer codes that damage". The fixture books are invented (synthetic test corpus); the real
// Gutenberg check runs with SCROLLS_TEST_CIPHER=1 (npm run test:cipher).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { CIPHER } from '../server/config.mjs';
import { dataVersion, getMeta } from '../server/db/open.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { boilerplatePass, canaryCount, CANARY_TOKENS, lexiconStarts } from '../server/lineage/boilerplate.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const WORDS = ('the a and of to in that it was he she they we his her their for on with as at by from but not or one ' +
  'all were when there which said would been this had could clerk ledger column margin river garden window morning ' +
  'evening letter house street market harbour winter summer lamp table chair door road field hill bridge village town ' +
  'mother father brother sister friend neighbour teacher farmer sailor baker miller weaver carpenter shepherd rain snow ' +
  'wind stone bread salt iron silver copper paper ink candle bell clock coat boot hat basket barrel wagon horse dog cat ' +
  'bird fish apple pear plum walked carried counted wrote read opened closed waited listened answered laughed slept ' +
  'early late quiet loud slow quick old young little great long short green grey white black brown warm cold').split(' ');

/** Invented licence-like trailer: it carries the canary sentence and lexicon words (synthetic, for tests). */
const LICENCE = 'This synthetic test edition is offered under the test licence of the Fixture Foundation. Volunteers expend ' +
  'considerable effort, yet a copy may contain defects, such as a defective or damaged disk or other medium, a computer ' +
  'virus, or computer codes that damage or cannot be read by your equipment. Donations keep the test archive going and ' +
  'the trademark stays with the fixture.';
/** Invented commonplace (a saying many books quote in their middle): widespread but not boilerplate. */
const SAYING = 'Every clerk who counts the long rows by lamplight learns that a zero kept in its column is worth more than ' +
  'a number lost in the margin of the book.';
/** An older, different licence wording that shares only the canary sentence with LICENCE. */
const OLD_LICENCE = 'Small print for the fixture etexts: by reading any part of this text you accept the license here. Despite ' +
  'these efforts the etexts may hold flaws, a defective or damaged disk or other medium, a computer virus, or computer ' +
  'codes that damage or cannot be read by your equipment.';

function prose(rnd, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return `${out.join(' ')}.`;
}

/** A synthetic book: paragraphs of random words, with optional saying (middle), licence (end) and footer. */
function book(seed, { saying = false, licence = 'body', oldLicence = false } = {}) {
  const rnd = mulberry32(seed);
  const paras = [];
  if (oldLicence) paras.push(OLD_LICENCE);
  for (let i = 0; i < 12; i++) paras.push(prose(rnd, 60));
  if (saying) paras.splice(6, 0, SAYING);
  if (licence === 'body') paras.push(LICENCE);
  const body = paras.join('\n\n');
  if (licence !== 'footer') return { original: `${body}\n`, body_start: 0, body_end: body.length };
  const original = `${body}\n\n*** END OF THE FIXTURE ***\n\n${LICENCE}\n`;
  return { original, body_start: 0, body_end: body.length };
}

function loadBooks(db, slug, specs) {
  const coll = ensureCollection(db, { slug, name: `${slug} (synthetic)`, corpus: 'test', adapter_id: 'file.jsonl', domain: 'imported',
    modality: 'text', unit: 'tokens', sampling: 'user' });
  const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id, format: 'jsonl' }), collection: slug, corpus: 'test' });
  specs.forEach((s, i) => {
    const t = book(s.seed ?? i + 1, s);
    const r = w.addDocument({ ext_id: `${slug}:${i}`, kind: 'book', title: `Fixture book ${i} (synthetic)`, lang_declared: 'en',
      text: { original: t.original, decoder: 'utf-8', body_start: t.body_start, body_end: t.body_end }, dates: [],
      original_meta: { fixture: 'synthetic boilerplate test' } });
    assert.ok(r.documentId, `book ${i} imported: ${JSON.stringify(r.issues)}`);
  });
  w.finish();
  return coll;
}

const passagesWith = (db, collId, text) => db.prepare(`SELECT p.id, p.quality FROM passage p JOIN document d ON d.id = p.document_id
  JOIN document_text t ON t.document_id = d.id WHERE d.collection_id = ? AND p.field = 'body'
  AND substr(t.original, p.start_off + 1, p.end_off - p.start_off) LIKE ?`).all(collId, `%${text.slice(0, 40)}%`);

describe('licence lexicon', () => {
  test('single terms match token starts, pairs match two tokens', () => {
    const toks = tokenize('Project Gutenberg-tm ebooks are licensed; a computer virus, computer codes, small print. Notebook.').tokens;
    const lex = lexiconStarts(toks);
    const hits = toks.filter((_, i) => lex[i]);
    assert.deepEqual(hits, ['project', 'ebooks', 'licensed', 'computer', 'computer', 'small']);
    assert.deepEqual([...lex].filter(Boolean), [2, 1, 1, 2, 2, 2], 'pairs span two tokens');
    assert.equal(lex[toks.indexOf('notebook')], 0, "'ebook' inside 'notebook' is not a match");
    assert.deepEqual(CANARY_TOKENS, tokenize('computer virus, or computer codes that damage').tokens);
  });
});

describe('boilerplatePass on synthetic books', () => {
  let tmp, db;
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
  });
  after(() => tmp.cleanup());

  test('> 25 books: the shared edge licence becomes boilerplate, the shared saying stays counted, the canary holds', () => {
    const coll = loadBooks(db, 'bp-wide', Array.from({ length: 30 }, () => ({ saying: true })));
    const tokensBefore = db.prepare(`SELECT SUM(t.tokens) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
      WHERE d.collection_id = ?`).get(coll.id).n;
    assert.equal(canaryCount(db, [coll.id]), 30);
    const dv = dataVersion(db);
    const qv = Number(getMeta(db, 'quality_version') ?? 0);
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: cancel, post: () => {} });
    const m = boilerplatePass(db, ctx, { collections: ['bp-wide'] });

    assert.equal(m.documents, 30);
    assert.ok(m.boilerplate > 0 && m.commonplace > 0, `boilerplate ${m.boilerplate} and commonplace ${m.commonplace} groups`);
    assert.equal(m.passages_flagged, 30);
    assert.equal(m.flagged_by_rule.shared_text, 30);
    assert.equal(m.canary_ok_passages, 0);
    assert.ok(passagesWith(db, coll.id, LICENCE).every((p) => p.quality === 'boilerplate'));
    const saying = passagesWith(db, coll.id, SAYING);
    assert.equal(saying.length, 30);
    assert.ok(saying.every((p) => p.quality === 'ok'), 'a commonplace is counted normally');
    assert.ok(m.commonplace_passages >= 30);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id
      WHERE d.collection_id = ? AND p.quality = 'boilerplate'`).get(coll.id).n, 30, 'no random prose flagged');
    // denominators rewritten, versions bumped, run recorded
    const licenceTokens = tokenize(LICENCE).tokens.length;
    const tokensAfter = db.prepare(`SELECT SUM(t.tokens) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
      WHERE d.collection_id = ?`).get(coll.id).n;
    assert.equal(tokensBefore - tokensAfter, 30 * licenceTokens);
    assert.equal(dataVersion(db), dv + 1);
    assert.equal(Number(getMeta(db, 'quality_version')), qv + 1);
    const run = db.prepare('SELECT * FROM analysis_run WHERE id = ?').get(m.run_id);
    assert.equal(run.stage, 'boilerplate');
    assert.equal(run.status, 'succeeded');
    assert.equal(JSON.parse(run.metrics_json).canary_ok_passages, 0);
    assert.equal(JSON.parse(run.params_json).min_docs, 25);
    // a second pass finds nothing new and bumps nothing
    const again = boilerplatePass(db, null, { collections: ['bp-wide'] });
    assert.equal(again.passages_flagged, 0);
    assert.equal(dataVersion(db), dv + 1);
  });

  test('≤ 25 books: nothing is widespread, nothing is flagged (the threshold is > 25 documents)', () => {
    const coll = loadBooks(db, 'bp-few', Array.from({ length: 25 }, (_, i) => ({ seed: 100 + i })));
    const m = boilerplatePass(db, null, { collections: ['bp-few'] });
    assert.equal(m.widespread, 0);
    assert.equal(m.passages_flagged, 0);
    assert.equal(canaryCount(db, [coll.id]), 25);
  });

  test('duplicates do not count toward document frequency', () => {
    const specs = [...Array.from({ length: 20 }, (_, i) => ({ seed: 200 + i })), ...Array.from({ length: 10 }, (_, i) => ({ seed: 200 + i }))];
    const coll = loadBooks(db, 'bp-dups', specs);
    assert.equal(db.prepare('SELECT count(*) AS n FROM document WHERE collection_id = ? AND dup_of IS NOT NULL').get(coll.id).n, 10);
    const m = boilerplatePass(db, null, { collections: ['bp-dups'] });
    assert.equal(m.duplicates_not_counted, 10);
    assert.equal(m.widespread, 0, '20 distinct documents are not > 25');
  });

  test('licence text cut off as a footer still identifies the one copy left inside a body', () => {
    const specs = [...Array.from({ length: 29 }, (_, i) => ({ seed: 300 + i, licence: 'footer' })), { seed: 399, licence: 'body' }];
    const coll = loadBooks(db, 'bp-footer', specs);
    assert.equal(canaryCount(db, [coll.id]), 1);
    const m = boilerplatePass(db, null, { collections: ['bp-footer'] });
    assert.equal(m.passages_flagged, 1);
    assert.equal(m.canary_ok_passages, 0);
  });

  test('a rarer licence wording at the body edge is caught by its lexicon and shared canary sentence (rule B)', () => {
    const specs = [...Array.from({ length: 28 }, (_, i) => ({ seed: 400 + i })), { seed: 499, licence: 'none', oldLicence: true }];
    const coll = loadBooks(db, 'bp-old', specs);
    assert.equal(canaryCount(db, [coll.id]), 29);
    const old = passagesWith(db, coll.id, OLD_LICENCE)[0];
    const m = boilerplatePass(db, null, { collections: ['bp-old'], explain: [old.id] });
    assert.ok(m.explain[old.id].boilerplate < m.explain[old.id].fingerprints / 2, 'under 50% shared: rule A alone would miss it');
    assert.equal(m.flagged_by_rule.licence_wording_at_edge, 1);
    assert.equal(m.canary_ok_passages, 0);
  });

  test('dry run reports without writing', () => {
    loadBooks(db, 'bp-dry', Array.from({ length: 27 }, (_, i) => ({ seed: 500 + i })));
    const dv = dataVersion(db);
    const m = boilerplatePass(db, null, { collections: ['bp-dry'], dryRun: true });
    assert.equal(m.passages_would_flag, 27);
    assert.equal(m.passages_flagged, 0);
    assert.equal(m.canary_ok_passages, 27);
    assert.equal(dataVersion(db), dv);
  });
});

// ── the real canary: Cipher's Gutenberg texts under exact-marker stripping (SPEC §0.1: 29+ files keep the licence's
// "computer virus" inside the body) ──────────────────────────────────────────────────────────────────────────────

const REAL = process.env.SCROLLS_TEST_CIPHER === '1' && existsSync(CIPHER.gutenbergDir);

describe('virus canary on the real Gutenberg texts', { skip: REAL ? false : 'set SCROLLS_TEST_CIPHER=1 with the Cipher files present (npm run test:cipher)' }, () => {
  let tmp;
  after(() => tmp?.cleanup());

  test('after the pass no ok passage of cipher-gutenberg holds "computer virus, or computer codes that damage"', { timeout: 15 * 60 * 1000 }, () => {
    tmp = makeTmpData({ seed: false });
    const db = tmp.db;
    db.prepare(`INSERT INTO source_adapter (id, version, label, access) VALUES ('cipher.books', '0.0.0', 'Cipher books', 'local-dataset')
      ON CONFLICT(id) DO NOTHING`).run();
    const coll = ensureCollection(db, { slug: 'cipher-gutenberg', name: 'Gutenberg (canary test)', corpus: 'cipher', adapter_id: 'cipher.books',
      domain: 'literature', modality: 'text', unit: 'tokens', sampling: 'prominence_selected' });
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id }), collection: coll.slug, corpus: 'cipher',
      options: { detectLanguage: false } });
    const files = readdirSync(CIPHER.gutenbergDir).filter((f) => f.endsWith('.txt')).sort();
    for (const f of files) {
      const bytes = readFileSync(path.join(CIPHER.gutenbergDir, f));
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      // exact-marker stripping (the §0.1 measurement): body between "*** START OF" and "*** END OF"
      const s = text.indexOf('*** START OF');
      const bodyStart = s >= 0 && text.indexOf('\n', s) >= 0 ? text.indexOf('\n', s) + 1 : 0;
      const e = text.indexOf('*** END OF', bodyStart);
      w.addDocument({ ext_id: `pg:${f.slice(0, -4)}`, kind: 'book', title: f, lang_declared: 'en',
        text: { original: text, decoder: 'utf-8', body_start: bodyStart, body_end: e >= 0 ? e : text.length }, dates: [],
        original_meta: { file: f } });
    }
    w.finish();
    const before = canaryCount(db, [coll.id]);
    assert.ok(before >= 25, `the licence sentence is inside ${before} bodies before the pass`);
    const m = boilerplatePass(db, null, { collections: ['cipher-gutenberg'] });
    assert.equal(m.canary_ok_passages, 0, JSON.stringify(m.flagged_by_rule));
    assert.equal(canaryCount(db, [coll.id]), 0);
  });
});
