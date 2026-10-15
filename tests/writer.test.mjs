// OWNER: WP0 — DocumentWriter: offsets, chronology, doc_bin/doc_tokens, FTS parity, duplicates, languages,
// relationships, annotations, rollback (SPEC §3 contracts, §4.3, §5.4, §11)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { binOf, fits } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { checkpointWal, openDb, pauseForWal, walBytes } from '../server/db/open.mjs';
import { createBatch, createDocumentWriter, DUP_RELATIONSHIP_SQL, ensureCollection, minhashSignature, resolveExt, rollbackBatch, setFtsBulkLoad, storeOriginal } from '../server/store/document-writer.mjs';
import { addSignature, bandHashes, clearDupIndexMemo, lshCandidates, openDupIndex, saveDupIndex } from '../server/store/dup-index.mjs';
import { Worker } from 'node:worker_threads';
import { binsFor, rewriteDocTokens } from '../server/store/bins.mjs';
import { createProjector } from '../server/ingest/validate.mjs';
import { ensureMiniCollection, makeTmpData, miniDocuments, miniExpected } from './helpers/tmpdata.mjs';

const NOW = new Date('2026-10-04T12:00:00Z');
const all = (db, sql, ...a) => db.prepare(sql).all(...a);
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

/** The original text a passage's offsets index (§3: body → document_text.original, else document_field.value). */
function sourceOf(db, p) {
  if (p.field === 'body') return one(db, 'SELECT original FROM document_text WHERE document_id = ?', p.document_id).original;
  return one(db, 'SELECT value FROM document_field WHERE document_id = ? AND field = ?', p.document_id, p.field).value;
}

const englishParagraph = (seed) => {
  const base = ['the', 'clerk', 'kept', 'the', 'ledger', 'and', 'he', 'was', 'not', 'sure', 'that', 'the', 'sum', 'would',
    'hold', 'when', 'they', 'came', 'to', 'count', 'it', 'again', 'with', 'all', 'of', 'their', 'books'];
  const rnd = mulberry32(seed);
  return `${Array.from({ length: 400 }, () => base[Math.floor(rnd() * base.length)]).join(' ')}.`;
};

describe('DocumentWriter on the mini corpus', () => {
  let t, db, ids, expected;
  before(() => {
    t = makeTmpData();
    db = t.db;
    ids = t.mini.ids;
    expected = miniExpected();
  });
  after(() => t.cleanup());

  test('imports all 12 documents with the expected counts', () => {
    const c = t.mini.counts;
    assert.equal(c.documents.created, 12);
    assert.equal(c.documents.rejected, 0);
    assert.equal(c.documents.metadata_only, 2);
    assert.equal(c.documents.translations, 0);
    assert.equal(c.dates.unknown, 1);
    assert.equal(c.dates.scheduled, 1);
    assert.deepEqual(c.issues.by_code, { W_DATE_FUTURE: 1 });
    assert.equal(c.data_version, 1);
    assert.equal(one(db, "SELECT value FROM meta WHERE key = 'data_version'").value, '1');
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', t.mini.batchId).status, 'committed');
    assert.ok(t.mini.results.every((r) => Number.isInteger(r.documentId)));
  });

  test('offset invariant: every passage text is original.slice(start, end)', () => {
    const docs = new Map(miniDocuments().map((d) => [d.ext_id, d]));
    let n = 0;
    for (const p of all(db, 'SELECT p.*, d.ext_id FROM passage p JOIN document d ON d.id = p.document_id ORDER BY p.id')) {
      const src = sourceOf(db, p);
      const d = docs.get(p.ext_id);
      const expectedSrc = p.field === 'body' ? d.text.original : (d.fields?.[p.field] ?? d.title);
      assert.equal(src, expectedSrc, `${p.ext_id} ${p.field}: stored verbatim`);
      const slice = src.slice(p.start_off, p.end_off);
      assert.equal(tokenize(slice).tokens.length, p.token_count, `${p.ext_id} token_count`);
      if (p.field !== 'body') assert.deepEqual([p.start_off, p.end_off], [0, src.length]);
      n++;
    }
    assert.equal(n, t.mini.counts.passages);
    // body passages partition the body's tokens
    for (const [ext, id] of ids) {
      const d = docs.get(ext);
      if (!d.text) continue;
      const sum = one(db, "SELECT SUM(token_count) AS n FROM passage WHERE document_id = ? AND field = 'body'", id).n;
      assert.equal(sum, expected.documents.find((e) => e.ext_id === ext).body.tokens, `${ext} body tokens`);
    }
  });

  test('FTS parity: passage_fts row i holds the JS tokens of the passage, in order', () => {
    for (const p of all(db, 'SELECT * FROM passage')) {
      const js = tokenize(sourceOf(db, p).slice(p.start_off, p.end_off)).tokens;
      const fts = all(db, 'SELECT term, offset FROM passage_vocab_inst WHERE doc = ? ORDER BY offset', p.id);
      assert.equal(fts.length, js.length, `passage ${p.id} token count`);
      fts.forEach((r, i) => {
        assert.equal(r.offset, i);
        if (/^[a-z0-9]+$/.test(js[i])) assert.equal(r.term, js[i]);
      });
    }
  });

  test('probes from expected.json resolve to their tokens', () => {
    for (const e of expected.documents) {
      const id = ids.get(e.ext_id);
      const original = one(db, 'SELECT original FROM document_text WHERE document_id = ?', id)?.original;
      for (const pr of e.probes ?? []) {
        assert.equal(tokenize(original.slice(pr.start, pr.end)).tokens.join(' '), pr.norm, `${e.ext_id} ${pr.surface}`);
        const p = one(db, "SELECT * FROM passage WHERE document_id = ? AND field = 'body' AND start_off <= ? AND end_off >= ?", id, pr.start, pr.end);
        assert.ok(p, `${e.ext_id} probe '${pr.surface}' lies inside a passage`);
      }
    }
  });

  test('token counts per document and the shared 13-token run', () => {
    const bodyTokens = (ext) => all(db, "SELECT start_off, end_off FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off", ids.get(ext))
      .flatMap((p) => tokenize(one(db, 'SELECT original FROM document_text WHERE document_id = ?', ids.get(ext)).original.slice(p.start_off, p.end_off)).tokens);
    for (const [token, perDoc] of Object.entries(expected.token_counts)) {
      for (const [ext, n] of Object.entries(perDoc)) assert.equal(bodyTokens(ext).filter((x) => x === token).length, n, `${token} in ${ext}`);
    }
    for (const run of expected.shared_runs) for (const ext of run.docs) assert.ok(bodyTokens(ext).join(' ').includes(run.norm));
    const hits = all(db, `SELECT DISTINCT d.ext_id FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
      WHERE passage_fts MATCH '"carry the zero"' ORDER BY d.ext_id`).map((r) => r.ext_id);
    assert.deepEqual(hits, expected.phrases['carry the zero']);
  });

  test('chronology is copied from the single is_chronology assertion', () => {
    for (const e of expected.documents) {
      const d = one(db, 'SELECT * FROM document WHERE id = ?', ids.get(e.ext_id));
      const c = e.chronology;
      assert.equal(d.chrono_status, c.chrono_status, e.ext_id);
      assert.equal(d.lo_day, c.lo_day, `${e.ext_id} lo_day`);
      assert.equal(d.hi_day, c.hi_day, `${e.ext_id} hi_day`);
      assert.equal(d.y_lo, c.lo_year);
      assert.equal(d.y_hi, c.hi_year);
      assert.equal(d.precision, c.precision);
      assert.equal(d.basis, c.basis);
      assert.equal(d.date_label, c.label);
      assert.equal(d.date_role, 'publication');
      const chrono = all(db, "SELECT * FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND is_chronology = 1", d.id);
      assert.equal(chrono.length, 1);
      assert.equal(chrono[0].raw, c.raw);
    }
    const memo = ids.get('mini:02');
    const ref = one(db, "SELECT * FROM date_assertion WHERE subject_id = ? AND role = 'referenced'", memo);
    assert.equal(ref.is_chronology, 0);
    assert.equal(ref.lo_year, 1911);
    assert.equal(ref.note, 'the memo quotes a 1911 primer');
    // every document has an ingestion assertion; every dated assertion is in the R*Tree
    assert.equal(one(db, "SELECT count(*) AS n FROM date_assertion WHERE role = 'ingestion'").n, 12);
    assert.equal(one(db, 'SELECT count(*) AS n FROM date_assertion WHERE lo_day IS NOT NULL').n, one(db, 'SELECT count(*) AS n FROM date_rtree').n);
    assert.equal(one(db, 'SELECT count(*) AS n FROM date_rtree r LEFT JOIN date_assertion a ON a.id = r.id WHERE a.lo_day IS NULL').n, 0);
  });

  test('doc_bin: a row at a level iff the interval fits one bin; undated and scheduled have none', () => {
    for (const e of expected.documents) {
      const id = ids.get(e.ext_id);
      const rows = all(db, 'SELECT level, bin FROM doc_bin WHERE document_id = ? ORDER BY level', id).map((r) => [r.level, r.bin]);
      const c = e.chronology;
      if (c.chrono_status !== 'dated') {
        assert.deepEqual(rows, [], `${e.ext_id} (${c.chrono_status}) has no bins`);
        continue;
      }
      const want = [0, 1, 2, 3].filter((l) => fits(c.lo_year, c.hi_year, l)).map((l) => [l, binOf(c.lo_year, l)]);
      assert.deepEqual(rows, want, e.ext_id);
      assert.deepEqual(binsFor(c.lo_year, c.hi_year).map((b) => [b.level, b.bin]), want);
    }
    const levels = (ext) => all(db, 'SELECT level FROM doc_bin WHERE document_id = ?', ids.get(ext)).map((r) => r.level);
    assert.deepEqual(levels('mini:04'), [0, 1, 2]);       // 1890s: in its decade, absent from year bins
    assert.deepEqual(levels('mini:05'), [0, 1]);          // c. 1894 = 1889–1899 crosses a decade
    assert.deepEqual(levels('mini:01'), [0, 1, 2, 3]);
    assert.deepEqual(binsFor(-499, -499).map((b) => b.bin), [-1, -5, -50, -499]);
    assert.deepEqual(binsFor(null, null), []);
  });

  test('doc_tokens = quality ok tokens per passage language × field class', () => {
    for (const id of ids.values()) {
      const want = all(db, `SELECT lang AS plang, field_class, SUM(token_count) AS tokens, COUNT(*) AS passages FROM passage
        WHERE document_id = ? AND quality = 'ok' GROUP BY lang, field_class ORDER BY lang, field_class`, id);
      const have = all(db, 'SELECT plang, field_class, tokens, passages FROM doc_tokens WHERE document_id = ? ORDER BY plang, field_class', id);
      assert.deepEqual(have, want);
    }
    assert.deepEqual(all(db, 'SELECT plang, field_class, tokens FROM doc_tokens WHERE document_id = ? ORDER BY field_class', ids.get('mini:11')).map((r) => [r.plang, r.field_class]),
      [['en', 'describes'], ['gu', 'title']]);
    // after a quality change, rewriteDocTokens recomputes the denominators
    const id = ids.get('mini:01');
    db.prepare("UPDATE passage SET quality = 'boilerplate' WHERE document_id = ?").run(id);
    rewriteDocTokens(db, [id]);
    assert.equal(one(db, 'SELECT count(*) AS n FROM doc_tokens WHERE document_id = ?', id).n, 0);
    db.prepare("UPDATE passage SET quality = 'ok' WHERE document_id = ?").run(id);
    rewriteDocTokens(db, [id]);
    assert.equal(one(db, 'SELECT tokens FROM doc_tokens WHERE document_id = ?', id).tokens, 61);
  });

  test('languages, fields, synthetic flags, labels', () => {
    for (const e of expected.documents) {
      const d = one(db, 'SELECT lang_text, is_translation, is_synthetic FROM document WHERE id = ?', ids.get(e.ext_id));
      assert.equal(d.is_synthetic, 1);
      assert.equal(d.is_translation, 0);
      if (e.ext_id !== 'mini:12') assert.equal(d.lang_text, e.lang, e.ext_id);
    }
    assert.equal(one(db, 'SELECT lang_text FROM document WHERE id = ?', ids.get('mini:12')).lang_text, 'und-Latn');
    assert.equal(one(db, 'SELECT count(*) AS n FROM passage WHERE is_synthetic = 0').n, 0);
    const summary = one(db, "SELECT * FROM passage WHERE document_id = ? AND field = 'summary'", ids.get('mini:12'));
    assert.equal(summary.field_class, 'describes');
    assert.equal(summary.time_role, 'describes');
    assert.equal(summary.unit, 'field');
    const title = one(db, "SELECT * FROM passage WHERE document_id = ? AND field = 'title'", ids.get('mini:12'));
    assert.equal(title.field_class, 'title');
    assert.equal(title.lang, 'und-Latn');
    assert.equal(title.token_count, 4);                     // Zero · Hour · ◉ · 🎬
    assert.equal(one(db, "SELECT count(*) AS n FROM label_tri WHERE kind = 'title'").n, 12);
    assert.equal(one(db, "SELECT count(*) AS n FROM label_tri WHERE kind = 'maker'").n, 12);
    assert.ok(all(db, "SELECT ref FROM label_tri WHERE label_tri MATCH '\"ledger\"'").some((r) => r.ref === `document:${ids.get('mini:02')}`));
    const text = one(db, 'SELECT * FROM document_text WHERE document_id = ?', ids.get('mini:09'));
    assert.equal(text.decoder, 'pages-joined-ff');
    assert.match(text.original_sha256, /^[0-9a-f]{64}$/);
    assert.equal(one(db, 'SELECT has_full_text FROM document WHERE id = ?', ids.get('mini:11')).has_full_text, 0);
    assert.deepEqual(JSON.parse(one(db, 'SELECT original_meta_json AS m FROM document WHERE id = ?', ids.get('mini:03')).m).n, 3);
  });

  test('resolveExt finds documents and aliases', () => {
    assert.equal(resolveExt(db, { collectionSlug: 'mini', extId: 'mini:07' }), ids.get('mini:07'));
    assert.equal(resolveExt(db, { extId: 'mini:07' }), ids.get('mini:07'));
    assert.equal(resolveExt(db, { collectionSlug: 'mini', extId: 'nope' }), null);
  });
});

describe('DocumentWriter: duplicates, languages, rejections', () => {
  let t, db;
  before(() => { t = makeTmpData(); db = t.db; });
  after(() => t.cleanup());

  const writer = (options = {}) => createDocumentWriter(db, { batchId: createBatch(db, { collection: 'mini' }), collection: 'mini',
    options: { now: NOW, ...options } });
  const doc = (ext, text, extra = {}) => ({ ext_id: ext, kind: 'essay', title: ext, author: 'Test Author (synthetic)', lang_declared: 'en',
    text: { original: text, decoder: 'utf-8' }, dates: [{ role: 'publication', raw: '1950', asserted_by: 'test', is_chronology: true }],
    original_meta: {}, ...extra });

  test('same body as an existing document → accepted with dup_of and W_DUP_CONTENT', () => {
    const w = writer();
    const orig = miniDocuments()[0];
    const r = w.addDocument({ ...orig, ext_id: 'copy:01' });
    w.finish();
    assert.ok(r.documentId);
    assert.deepEqual(r.issues.map((i) => i.code), ['W_DUP_CONTENT']);
    assert.equal(one(db, 'SELECT dup_of FROM document WHERE id = ?', r.documentId).dup_of, t.mini.ids.get('mini:01'));
  });

  test('the same ext_id twice → E_DUP_ID (within a batch with both lines, and across batches)', () => {
    const w = writer();
    const a = w.addDocument(doc('dup:a', englishParagraph(1)), { line: 3 });
    const b = w.addDocument(doc('dup:a', englishParagraph(2)), { line: 9 });
    const c = w.addDocument(doc('mini:01', englishParagraph(3)), { line: 10 });
    const counts = w.finish();
    assert.ok(a.documentId);
    assert.equal(b.documentId, null);
    assert.equal(b.issues[0].code, 'E_DUP_ID');
    assert.equal(b.issues[0].severity, 'rejected');
    assert.match(b.issues[0].message, /line 3/);
    assert.equal(c.issues[0].code, 'E_DUP_ID');
    assert.equal(counts.documents.rejected, 2);
    const stored = all(db, "SELECT code, line, suggestion FROM import_issue WHERE batch_id = ? AND code = 'E_DUP_ID'", counts.batch_id);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((i) => i.suggestion.length > 0));
  });

  test('near-duplicate text → W_NEAR_DUP; unrelated text → no warning', () => {
    const w = writer();
    const base = englishParagraph(5);
    const near = base.replace('ledger', 'LEDGERS');
    const r1 = w.addDocument(doc('near:a', base));
    const r2 = w.addDocument(doc('near:b', near));
    const r3 = w.addDocument(doc('near:c', englishParagraph(11)));
    w.finish();
    assert.deepEqual(r1.issues, []);
    assert.deepEqual(r2.issues.map((i) => i.code), ['W_NEAR_DUP']);
    assert.ok(!r3.issues.some((i) => i.code === 'W_NEAR_DUP'));
    assert.equal(one(db, 'SELECT length(sig) AS n FROM doc_minhash WHERE document_id = ?', r1.documentId).n, 512);
  });

  test('declared French, English text → translation, dated by the original (W_LANG_MISMATCH)', () => {
    const w = writer();
    const r = w.addDocument(doc('tr:1', 'It was the age of the ledger, and the clerk said that he would not count the sum again until they came back with all of their books.', { lang_declared: 'fr' }));
    const counts = w.finish();
    const d = one(db, 'SELECT * FROM document WHERE id = ?', r.documentId);
    assert.equal(d.is_translation, 1);
    assert.equal(d.lang_text, 'en');
    assert.equal(d.original_lang, 'fr');
    assert.equal(d.date_role, 'original_publication');
    assert.ok(r.issues.some((i) => i.code === 'W_LANG_MISMATCH' && /Declared fr, but the text reads as en/.test(i.message)));
    assert.equal(counts.documents.translations, 1);
    const a = one(db, "SELECT role, note FROM date_assertion WHERE subject_id = ? AND is_chronology = 1", d.id);
    assert.equal(a.role, 'original_publication');
    assert.match(a.note, /reads as en/);
  });

  test('bad records are rejected with actionable issues; bad dates keep the record undated', () => {
    const w = writer();
    const noKind = w.addDocument({ ext_id: 'bad:1', dates: [], original_meta: {} });
    const empty = w.addDocument({ ext_id: 'bad:2', kind: 'book', dates: [], original_meta: {} });
    const badDate = w.addDocument(doc('bad:3', englishParagraph(2).slice(0, 300), { dates: [{ role: 'publication', raw: 'Spring-ish 1850', asserted_by: 'test', is_chronology: true }] }));
    const invalid = w.addDocument(doc('bad:4', englishParagraph(3).slice(0, 300), { dates: [{ role: 'publication', raw: '2019-02-30', asserted_by: 'test' }] }));
    const ambiguous = w.addDocument(doc('bad:5', englishParagraph(4).slice(0, 300), { dates: [{ role: 'publication', raw: "'90s", asserted_by: 'test' }] }));
    w.finish();
    assert.equal(noKind.documentId, null);
    assert.equal(noKind.issues[0].code, 'E_FIELD_TYPE');
    assert.equal(empty.issues[0].code, 'E_MISSING_TEXT');
    for (const [r, code] of [[badDate, 'E_DATE_UNPARSEABLE'], [invalid, 'E_DATE_INVALID'], [ambiguous, 'E_DATE_AMBIGUOUS']]) {
      assert.ok(r.documentId, code);
      const issue = r.issues.find((i) => i.code === code);
      assert.ok(issue, code);
      assert.ok(issue.suggestion.length > 0);
      const d = one(db, 'SELECT chrono_status, date_label FROM document WHERE id = ?', r.documentId);
      assert.deepEqual({ ...d }, { chrono_status: 'undated', date_label: 'undated' });
      const a = one(db, "SELECT raw, rule, precision FROM date_assertion WHERE subject_id = ? AND role = 'publication'", r.documentId);
      assert.equal(a.precision, 'unknown');
      assert.equal(a.rule, 'unparsed');
    }
    assert.match(badDate.issues.find((i) => i.code === 'E_DATE_UNPARSEABLE').suggestion, /spring 1850/);
  });

  test('stored originals: content-addressed file + original_file row; unknown sha is refused', () => {
    const bytes = Buffer.from('a,b\n1,2\n', 'utf8');
    const sha = storeOriginal(db, bytes, { sourcePath: '/tmp/x.csv' });
    const row = one(db, 'SELECT * FROM original_file WHERE sha256 = ?', sha);
    assert.equal(row.byte_size, bytes.length);
    assert.equal(row.rel_path, path.join('originals', sha.slice(0, 2), sha));
    assert.ok(existsSync(path.join(t.dir, row.rel_path)));
    assert.deepEqual(readFileSync(path.join(t.dir, row.rel_path)), bytes);
    assert.equal(storeOriginal(db, bytes), sha);
    const w = writer();
    const ok = w.addDocument(doc('src:1', englishParagraph(6).slice(0, 200), { source_file: { sha256: sha, byte_start: 0, byte_end: 8 } }));
    const bad = w.addDocument(doc('src:2', englishParagraph(7).slice(0, 200), { source_file: { sha256: 'f'.repeat(64), byte_start: 0, byte_end: 8 } }));
    w.finish();
    assert.equal(one(db, 'SELECT source_file_sha256 FROM document WHERE id = ?', ok.documentId).source_file_sha256, sha);
    assert.equal(bad.documentId, null);
  });
});

describe('DocumentWriter: relationships and annotations', () => {
  let t, db, ids;
  before(() => { t = makeTmpData(); db = t.db; ids = t.mini.ids; });
  after(() => t.cleanup());

  test('relationships resolve by ext_id; CHECKs reject bad provenance; date conflicts are flagged', () => {
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'mini' }), collection: 'mini', options: { now: NOW } });
    const memoStart = 62, memoEnd = 131; // "it holds the place … counted" in mini:02 (expected.json probe)
    const cite = w.addRelationship({ src: { ext_id: 'mini:03' }, dst: { ext_id: 'mini:02' }, rel_type: 'explicit_citation',
      evidence_status: 'documented', origin: 'source_dataset', source_dataset: 'demo-records', source_locator: 'fixture:mini#3',
      created_by: 'adapter:test@1', evidence: [{ role: 'source_span', ext_id: 'mini:02', start: memoStart, end: memoEnd,
        quote: 'it holds the place where nothing is, so that something can be counted' }],
      hypothesis_group: { key: 'g1', question: 'Where does the bulletin line come from?' } });
    assert.deepEqual(cite, { pending: true });
    w.addRelationship({ src: { ext_id: 'mini:01' }, dst: { ext_id: 'mini:02' }, rel_type: 'samples', evidence_status: 'documented',
      origin: 'source_dataset', source_dataset: 'demo-records', provenance_quality: 'source_unrecorded', created_by: 'adapter:test@1' });
    const bad = w.addRelationship({ src: { ext_id: 'mini:03' }, dst: { ext_id: 'mini:02' }, rel_type: 'near_quotation',
      evidence_status: 'documented', origin: 'algorithm', run_id: 1, method: 'winnow', created_by: 'run:1' });
    assert.equal(bad.pending, false); // the contract itself refuses documented-by-algorithm
    w.addRelationship({ src: { ext_id: 'mini:03' }, dst: { ext_id: 'nope:9' }, rel_type: 'inspired_by', evidence_status: 'proposed',
      origin: 'human', created_by: 'human:tester' });
    w.addRelationship({ src: { ref: `document:${ids.get('mini:04')}` }, dst: { ext_id: 'mini:05' }, rel_type: 'proposed_allusion',
      evidence_status: 'proposed', origin: 'human', created_by: 'human:tester', hypothesis_group: { key: 'g1', question: 'x' } });
    const counts = w.finish();
    assert.equal(counts.relationships.documented, 2);
    assert.equal(counts.relationships.proposed, 1);
    assert.equal(counts.relationships.unresolved_targets, 1);
    assert.equal(counts.relationships.rejected, 1);

    const rels = all(db, 'SELECT * FROM relationship ORDER BY id');
    const c = rels.find((r) => r.rel_type === 'explicit_citation');
    assert.deepEqual([c.src_type, c.src_ref, c.dst_type, c.dst_ref], ['document', String(ids.get('mini:03')), 'document', String(ids.get('mini:02'))]);
    assert.equal(c.is_synthetic, 1);
    assert.equal(c.date_conflict, 0);
    assert.equal(c.src_year, 1963);
    assert.equal(c.dst_year, 1958);
    assert.ok(c.hypothesis_group_id);
    const ev = one(db, 'SELECT * FROM relationship_evidence WHERE relationship_id = ?', c.id);
    const anchor = JSON.parse(ev.anchor_json);
    assert.equal(anchor.quote, 'it holds the place where nothing is, so that something can be counted');
    assert.equal(anchor.prefix, 'MEMO — Felbridge Accounts Office\r\n\r\nCarry the zero, children: '.slice(-32));
    assert.equal(ev.passage_id, one(db, "SELECT id FROM passage WHERE document_id = ? AND field = 'body'", ids.get('mini:02')).id);
    const s = rels.find((r) => r.rel_type === 'samples');
    assert.equal(s.date_conflict, 1, 'a 1903 work cannot sample a 1958 one');
    assert.equal(s.provenance_quality, 'source_unrecorded');
    assert.equal(one(db, 'SELECT count(*) AS n FROM relationship_revision WHERE rev = 1 AND action = ?', 'create').n, rels.length);
    const allusion = rels.find((r) => r.rel_type === 'proposed_allusion');
    assert.equal(allusion.hypothesis_group_id, c.hypothesis_group_id, 'same key → same group');
  });

  test('annotations: anchored to a passage, quote checked, searchable', () => {
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'mini' }), collection: 'mini', options: { now: NOW } });
    w.addAnnotation({ target: { type: 'passage', ext_id: 'mini:02' }, anchor: { field: 'body', start: 36, end: 50, quote: 'Carry the zero' },
      kind: 'interpretation', author: 'human:Reader A (synthetic)', is_machine: false, body_md: 'A classroom rule quoted in an office.',
      dimensions: { pragmatic_function: 'ironic' }, tags: ['irony'], key: 'a1' });
    w.addAnnotation({ target: { type: 'passage', ext_id: 'mini:02' }, anchor: { field: 'body', start: 36, end: 50, quote: 'Carry the ZERO' },
      kind: 'interpretation', author: 'human:Reader A (synthetic)', is_machine: false, body_md: 'wrong quote' });
    const machine = w.addAnnotation({ target: { type: 'document', ext_id: 'mini:11' }, kind: 'machine_gloss', author: 'cipher',
      is_machine: true, body_md: 'a song about zeros' });
    assert.equal(machine.pending, false, 'machine annotations need a method');
    w.addAnnotation({ target: { type: 'document', ext_id: 'mini:11' }, kind: 'machine_gloss', author: 'cipher', is_machine: true,
      method: 'Cipher tagging pass (Claude sub-agent, Oct 2026)', body_md: 'a song about zeros' });
    w.addAnnotation({ target: { type: 'passage', ext_id: 'mini:02' }, anchor: { field: 'body', start: 36, end: 50, quote: 'Carry the zero' },
      kind: 'interpretation', author: 'human:Reader A (synthetic)', is_machine: false, body_md: 'Revised: a reclaimed rule.', supersedes_key: 'a1' });
    const counts = w.finish();
    assert.equal(counts.annotations.created, 3);
    assert.equal(counts.annotations.rejected, 2);
    const anns = all(db, 'SELECT * FROM annotation ORDER BY id');
    const first = anns[0];
    assert.equal(first.target_type, 'passage');
    assert.equal(first.target_ref, String(one(db, "SELECT id FROM passage WHERE document_id = ? AND field = 'body'", ids.get('mini:02')).id));
    assert.equal(first.status, 'superseded');
    assert.equal(first.is_synthetic, 1);
    const anchor = JSON.parse(first.anchor_json);
    assert.deepEqual([anchor.doc_id, anchor.field, anchor.start, anchor.end, anchor.quote], [ids.get('mini:02'), 'body', 36, 50, 'Carry the zero']);
    assert.equal(anchor.sha256, one(db, 'SELECT original_sha256 FROM document_text WHERE document_id = ?', ids.get('mini:02')).original_sha256);
    assert.equal(anchor.suffix, ', children: it holds the place w');
    assert.equal(anns.at(-1).supersedes, first.id);
    const rev = one(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ?', first.id);
    assert.deepEqual(JSON.parse(rev.dimensions_json), { pragmatic_function: 'ironic' });
    assert.deepEqual(all(db, "SELECT rowid FROM annotation_fts WHERE annotation_fts MATCH '\"classroom rule\"'").map((r) => r.rowid), [rev.id]);
  });
});

describe('DocumentWriter: transactions and rollback', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; ensureMiniCollection(db); });
  after(() => t.cleanup());

  test('rollback() leaves zero rows of the batch (and keeps its issues)', () => {
    const batchId = createBatch(db, { collection: 'mini' });
    const w = createDocumentWriter(db, { batchId, collection: 'mini', options: { now: NOW } });
    for (const d of miniDocuments()) w.addDocument(d);
    w.flush();
    assert.equal(one(db, 'SELECT count(*) AS n FROM document WHERE import_batch_id = ?', batchId).n, 12);
    w.rollback();
    const left = (sql) => one(db, sql).n;
    assert.equal(left('SELECT count(*) AS n FROM document'), 0);
    for (const table of ['passage', 'document_text', 'document_field', 'doc_bin', 'doc_tokens', 'date_assertion', 'date_rtree', 'label_tri']) {
      assert.equal(left(`SELECT count(*) AS n FROM ${table}`), 0, table);
    }
    assert.equal(all(db, `SELECT rowid FROM passage_fts WHERE passage_fts MATCH '"carry the zero"'`).length, 0);
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', batchId).status, 'failed');
    assert.equal(left(`SELECT count(*) AS n FROM import_issue WHERE batch_id = ${batchId} AND code = 'W_DATE_FUTURE'`), 1);
    assert.throws(() => w.addDocument(miniDocuments()[0]), /already finished or rolled back/);
  });

  test("onBadRow 'abort' stops the import with zero documents", () => {
    const batchId = createBatch(db, { collection: 'mini' });
    const w = createDocumentWriter(db, { batchId, collection: 'mini', options: { now: NOW, onBadRow: 'abort' } });
    w.addDocument(miniDocuments()[0]);
    assert.throws(() => w.addDocument({ ext_id: 'broken', original_meta: {}, dates: [] }), { code: 'E_IMPORT_ABORTED' });
    assert.equal(one(db, 'SELECT count(*) AS n FROM document WHERE import_batch_id = ?', batchId).n, 0);
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', batchId).status, 'failed');
  });

  test('rollbackBatch removes a half-written batch left by a crash', () => {
    const batchId = createBatch(db, { collection: 'mini' });
    const w = createDocumentWriter(db, { batchId, collection: 'mini', options: { now: NOW } });
    for (const d of miniDocuments().slice(0, 5)) w.addDocument(d);
    w.flush(); // committed, but finish() never ran
    assert.equal(rollbackBatch(db, batchId), 5);
    assert.equal(one(db, 'SELECT count(*) AS n FROM passage').n, 0);
  });

  test('FTS bulk-load mode and WAL checkpoints', () => {
    setFtsBulkLoad(db, true);
    const batchId = createBatch(db, { collection: 'mini' });
    const w = createDocumentWriter(db, { batchId, collection: 'mini', options: { now: NOW } });
    for (const d of miniDocuments().slice(5, 8)) w.addDocument(d);
    w.finish();
    setFtsBulkLoad(db, false);
    assert.equal(all(db, `SELECT rowid FROM passage_fts WHERE passage_fts MATCH '"pingüino"'`).length, 1);
    assert.ok(walBytes(db) > 0);
    assert.equal(checkpointWal(db, 'TRUNCATE').busy, 0);
    assert.equal(walBytes(db), 0);
    assert.equal(pauseForWal(db), true);
    assert.throws(() => checkpointWal(db, 'NOPE'), TypeError);
  });

  test('an idle writer commits within 500 ms, so other connections are not starved', async () => {
    const batchId = createBatch(db, { collection: 'mini' });
    const w = createDocumentWriter(db, { batchId, collection: 'mini', options: { now: NOW } });
    w.addDocument(miniDocuments()[1]);
    const other = openDb({ path: t.dbPath });
    try {
      assert.equal(one(other, 'SELECT count(*) AS n FROM document WHERE import_batch_id = ?', batchId).n, 0);
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(db.isTransaction, false);
      assert.equal(one(other, 'SELECT count(*) AS n FROM document WHERE import_batch_id = ?', batchId).n, 1);
    } finally {
      other.close();
    }
    w.finish();
  });
});

// ── M5 gate item 9: the duplicate indexes are built once per chain, not once per chunk ─────────────────────

describe('DocumentWriter: duplicate indexes carried across the writers of a chained load', () => {
  let t, db, coll;
  before(() => {
    t = makeTmpData({ seed: false });
    db = t.db;
    coll = ensureMiniCollection(db, 'chain');
    clearDupIndexMemo();
  });
  after(() => { clearDupIndexMemo(); t.cleanup(); });

  const writer = (options = {}) => createDocumentWriter(db, { batchId: createBatch(db, { collection: 'chain' }), collection: 'chain',
    options: { now: NOW, dupIndexDiskMin: 1, ...options } });
  const meta = (ext, title, year = '1950') => ({ ext_id: ext, kind: 'song', title, author: 'Brennock Fixture (synthetic)',
    dates: [{ role: 'release', raw: year, asserted_by: 'test', is_chronology: true }], original_meta: {} });
  const text = (ext, body) => ({ ext_id: ext, kind: 'essay', title: ext, author: 'Test Author (synthetic)', lang_declared: 'en',
    text: { original: body, decoder: 'utf-8' }, dates: [{ role: 'publication', raw: '1950', asserted_by: 'test', is_chronology: true }],
    original_meta: {} });
  const codes = (r) => r.issues.map((i) => i.code);
  const cacheFile = () => path.join(t.dir, 'cache', 'dup-index', `${coll.id}.bin`);

  /** One writer in a fresh worker thread (a chained job's next chunk): what it flags and where its index came from. */
  function chunkInWorker(docs) {
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { openDb } = await import(workerData.open);
        const { createBatch, createDocumentWriter } = await import(workerData.writer);
        const db = openDb({ path: workerData.dbPath });
        const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'chain' }), collection: 'chain',
          options: { now: new Date(workerData.now), dupIndexDiskMin: 1 } });
        const issues = workerData.docs.map((d) => w.addDocument(d).issues.map((i) => i.code));
        const info = w.dupIndex();
        w.finish();
        db.close();
        parentPort.postMessage({ info, issues });
      })().catch((e) => parentPort.postMessage({ error: String(e && e.stack || e) }));`;
    return new Promise((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { docs, dbPath: t.dbPath, now: NOW.toISOString(),
        open: new URL('../server/db/open.mjs', import.meta.url).href, writer: new URL('../server/store/document-writer.mjs', import.meta.url).href } });
      w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
      w.once('error', reject);
    });
  }

  test('the next writer reuses the index (same thread), a new thread reads the disk cache; both flag what a fresh build flags', async () => {
    const base = englishParagraph(21);
    const a = writer();
    const m1 = a.addDocument(meta('chain:m1', 'Ledger Song'));
    const t1 = a.addDocument(text('chain:t1', base));
    assert.deepEqual([codes(m1), codes(t1)], [[], []]);
    assert.equal(a.dupIndex().source, 'db');
    a.finish();
    assert.ok(existsSync(cacheFile()), 'a finished writer leaves the index on disk');

    const b = writer();
    const dm = b.addDocument(meta('chain:m2', 'Ledger Song'));
    const dt = b.addDocument(text('chain:t2', base.replace('ledger', 'LEDGERS')));
    const m3 = b.addDocument(meta('chain:m3', 'Carry Song'));
    assert.equal(b.dupIndex().source, 'memo', 'the second writer in this thread starts from the first one\'s index');
    assert.deepEqual(codes(dm), ['W_DUP_METADATA']);
    assert.match(dm.issues[0].message, new RegExp(`\\b${m1.documentId}\\b`), 'it names the earlier document');
    assert.deepEqual(codes(dt), ['W_NEAR_DUP']);
    assert.deepEqual(codes(m3), []);
    b.finish();

    // a new worker thread: no memo; the disk cache (rewritten by b) holds m3, which b added after a's cache
    const c = await chunkInWorker([meta('chain:m4', 'Carry Song'), text('chain:t3', base.replace('clerk', 'CLERKS'))]);
    assert.equal(c.info.source, 'disk');
    assert.deepEqual(c.issues, [['W_DUP_METADATA'], ['W_NEAR_DUP']]);
    // a document added by a writer that kept no index (dedupe off) is picked up as a document above the watermark
    const off = writer({ dedupe: 'off' });
    off.addDocument(meta('chain:m5', 'Zero Hour Blues'));
    off.finish();
    const d = await chunkInWorker([meta('chain:m6', 'Zero Hour Blues')]);
    assert.equal(d.info.source, 'disk');
    assert.deepEqual(d.issues, [['W_DUP_METADATA']]);
  });

  test('LSH candidates from the stored per-band table and from later signatures equal a brute-force band match', () => {
    const lsh = ensureMiniCollection(db, 'lsh');
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'lsh' }), collection: 'lsh', options: { now: NOW, dedupe: 'off' } });
    for (let i = 0; i < 40; i++) w.addDocument(text(`lsh:${i}`, englishParagraph(1000 + i)));
    w.finish();
    clearDupIndexMemo();
    const { index, source } = openDupIndex(db, lsh.id);
    assert.equal(source, 'db');
    assert.equal(index.sigs.size, 40);
    const rnd = mulberry32(99);
    const stored = [...index.sigs.values()];
    /** A signature sharing the bands in `keep` with `from` (other rows changed), or a fresh random one. */
    const probe = (from, keep) => Uint32Array.from({ length: 128 }, (_, r) => (from && keep.has(r >> 3) ? from[r] : Math.floor(rnd() * 2 ** 32)));
    // later signatures (as a chunk's own documents would be), some sharing bands with stored ones and with each other
    for (let i = 0; i < 12; i++) addSignature(index, 900000 + i, probe(stored[i % stored.length], new Set([i % 16])));
    addSignature(index, 900100, probe(index.sigs.get(900003), new Set([5, 9])));
    const brute = (index, q) => {
      const hq = bandHashes(q);
      return [...index.sigs].filter(([, s]) => bandHashes(s).some((h, b) => h === hq[b])).map(([id]) => id).sort((a, b) => a - b);
    };
    const ids = (index, q) => lshCandidates(index, q).map(([id, sig]) => { assert.equal(sig, index.sigs.get(id)); return id; }).sort((a, b) => a - b);
    const queries = [
      ...stored.slice(0, 10).map((s, i) => probe(s, new Set([i % 16, (i + 7) % 16]))),
      probe(index.sigs.get(900003), new Set([3])), probe(index.sigs.get(900100), new Set([9])), probe(null, new Set()),
      stored[0],
    ];
    let hits = 0;
    for (const q of queries) {
      const want = brute(index, q);
      assert.deepEqual(ids(index, q), want);
      hits += want.length;
    }
    assert.ok(hits >= queries.length, 'the probes do share bands');
    // saved (the later signatures folded into the table) and read back from disk in this thread: the same answers
    saveDupIndex(db, index, { batchId: -1, maxDocumentId: 0, diskMin: 1 });
    clearDupIndexMemo();
    const again = openDupIndex(db, lsh.id);
    assert.equal(again.source, 'disk');
    assert.equal(again.index.lsh.size, 0, 'nothing left outside the stored table');
    for (const q of queries) assert.deepEqual(ids(again.index, q), brute(again.index, q));
    clearDupIndexMemo();
  });

  test('a reverted batch forces a rebuild: a deleted document is never flagged', () => {
    const a = writer();
    const x = a.addDocument(meta('chain:x', 'Counting House Stomp'));
    const batch = a.finish().batch_id;
    db.prepare('UPDATE document SET deleted_at = ? WHERE import_batch_id = ?').run(NOW.toISOString(), batch);
    db.prepare("UPDATE import_batch SET status = 'reverted' WHERE id = ?").run(batch);
    const b = writer();
    const again = b.addDocument(meta('chain:x2', 'Counting House Stomp'));
    assert.equal(b.dupIndex().source, 'db', 'the batch statuses changed: the index is rebuilt');
    assert.deepEqual(codes(again), [], `document ${x.documentId} was reverted`);
    b.finish();
  });

  test('a rolled-back writer hands nothing on; an entry whose row changed is checked against the database', () => {
    const r = writer();
    r.addDocument(meta('chain:rb', 'Rolled Back Reel'));
    r.rollback();
    const a = writer();
    const fresh = a.addDocument(meta('chain:rb2', 'Rolled Back Reel'));
    // the memo went with the rollback; the disk cache an earlier writer left is still valid (the rolled-back batch is
    // newer than every batch it records, and its rows are gone)
    assert.notEqual(a.dupIndex().source, 'memo', 'a rolled-back writer hands no index on');
    assert.deepEqual(codes(fresh), [], 'the rolled-back document is not a duplicate of anything');
    const y = a.addDocument(meta('chain:y', 'Place Holder Waltz'));
    const body = englishParagraph(77);
    const ty = a.addDocument(text('chain:ty', body));
    a.finish();
    // the rows change under the kept index (no batch status changes): the index still says 'Place Holder Waltz' and
    // still holds the old signature, the database no longer does
    db.prepare("UPDATE document SET title = 'Another Title' WHERE id = ?").run(y.documentId);
    const other = minhashSignature(tokenize(englishParagraph(78)).tokens);
    db.prepare('UPDATE doc_minhash SET sig = ? WHERE document_id = ?').run(new Uint8Array(other.buffer), ty.documentId);
    const b = writer();
    const m = b.addDocument(meta('chain:y2', 'Place Holder Waltz'));
    const n = b.addDocument(text('chain:ty2', body.replace('ledger', 'LEDGERS')));
    assert.equal(b.dupIndex().source, 'memo');
    assert.deepEqual(codes(m), [], 'the live row is checked before W_DUP_METADATA');
    assert.deepEqual(codes(n), [], 'the live signature is checked before W_NEAR_DUP');
    b.finish();
  });
});

describe('DocumentWriter: the repeat-load check of relationships (final gate)', () => {
  test('seeks an endpoint index, never every link of one type (a fresh Cipher bootstrap stalled on that scan)', () => {
    const t = makeTmpData({ seed: false });
    try {
      const args = ['document', '1', 'document', '2', 'samples', 'documented', 'source_dataset', 'adapter:test', 'musicbrainz', '', -1];
      const plan = t.db.prepare(`EXPLAIN QUERY PLAN ${DUP_RELATIONSHIP_SQL}`).all(...args).map((r) => r.detail).join(' | ');
      assert.match(plan, /USING INDEX rel_(src|dst) /, plan);
      assert.doesNotMatch(plan, /rel_kind|SCAN relationship/, plan);
    } finally {
      t.cleanup();
    }
  });
});

describe('real data never links into the synthetic demo (fix pass, §13 rule 1)', () => {
  let tmp, db;
  before(() => { tmp = makeTmpData({ seed: false }); db = tmp.db; });
  after(() => tmp.cleanup());

  const writeInto = (corpus, slug, docs, rels = []) => {
    const coll = ensureCollection(db, { slug, name: slug, corpus, adapter_id: 'file.jsonl', domain: 'imported', modality: 'text',
      unit: 'tokens', sampling: 'user', coverage_gate: 2000, selection_note: 'test' });
    const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: `${slug}.jsonl` });
    const w = createDocumentWriter(db, { batchId, collection: coll.slug, corpus, options: { now: NOW } });
    const ids = docs.map((d, i) => w.addDocument(d, { line: i + 1 }).documentId);
    for (const r of rels) w.addRelationship(r);
    const counts = w.finish();
    return { ids, counts, batchId, issues: all(db, 'SELECT code, message FROM import_issue WHERE batch_id = ?', batchId) };
  };
  const doc = (ext, title, extra = {}) => ({ ext_id: ext, kind: 'book', title, lang_declared: 'en',
    text: { original: `${title}. The clerk carried the zero and wrote the sum again.\n`, decoder: 'utf-8' },
    dates: [{ role: 'publication', raw: '1990', asserted_by: 'fixture', is_chronology: true }], original_meta: { fixture: true }, ...extra });
  const cite = (src, dst) => ({ src: { ext_id: src }, dst, rel_type: 'explicit_citation', evidence_status: 'documented', origin: 'source_dataset',
    source_dataset: 'your import: imp3.jsonl', source_locator: 'sha256:x#line=1', provenance_quality: 'complete', created_by: 'import:1' });

  test('a documented citation from a user import to a demo document is refused with W_SYNTHETIC_TARGET; real → real is kept', () => {
    const demo = writeInto('demo', 'demo-fixture', [doc('demo:A3', 'The Ledger House (synthetic)', { author: 'Invented Author (synthetic)' })]);
    const demoId = demo.ids[0];
    assert.equal(one(db, 'SELECT is_synthetic FROM document WHERE id = ?', demoId).is_synthetic, 1);
    const user = writeInto('user', 'rh-imp3', [doc('w1', 'A real essay'), doc('w4', 'Another real essay')],
      [cite('w4', { ref: `document:${demoId}` }), cite('w4', { ext_id: 'w1' })]);
    const rels = all(db, `SELECT src_ref, dst_ref, is_synthetic FROM relationship WHERE created_by = 'import:1'`);
    assert.deepEqual(rels.map((r) => r.dst_ref), [String(user.ids[0])], 'only the real → real link was written');
    assert.ok(!rels.some((r) => r.dst_ref === String(demoId)), 'no non-synthetic edge into the demo');
    assert.equal(user.counts.relationships.documented, 1);
    const issue = user.issues.find((i) => i.code === 'W_SYNTHETIC_TARGET');
    assert.ok(issue, 'the refusal is reported');
    assert.match(issue.message, /is in the synthetic demo \(invented material\); the link was not created/);
    // the dry run says the same before anything is written
    const seen = [];
    const proj = createProjector(db, { collectionSlug: 'rh-imp3-dry', onIssue: (i) => seen.push(i) });
    proj.addDocument(doc('w9', 'A third real essay'), { line: 1 });
    proj.addRelationship(cite('w9', { ref: `document:${demoId}` }));
    const sum = proj.finish();
    assert.equal(sum.relationships.documented, 0);
    assert.ok(seen.some((i) => i.code === 'W_SYNTHETIC_TARGET'), 'the dry run reports it');
  });
});
