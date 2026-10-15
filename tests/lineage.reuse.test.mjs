// OWNER: WP5 — the reuse index (SPEC §4.7): exact quotations (≥ 13 shared tokens) are computed and directed only by
// dates; overlapping or missing dates give shared wording; near quotations are verified; attribution cues give
// proposed + CUE citations; nothing algorithmic is ever documented; rows are invisible until the run succeeds

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { run as gcRuns } from '../server/jobs/tasks/gc-runs.mjs';
import { run as reuseIndex } from '../server/jobs/tasks/reuse-index.mjs';
import { lineageQuery } from '../server/lineage/graph.mjs';
import { traceSpan } from '../server/lineage/trace.mjs';
import { smithWaterman, seedExtend } from '../server/lineage/align.mjs';
import { classifyCandidate } from '../server/lineage/classify.mjs';
import { allCues, findCues, nameMatches } from '../server/lineage/cues.mjs';
import { jaccard, lshBands, minhash, shingles3, unitsOf } from '../server/lineage/minhash.mjs';
import { tokenIds } from '../server/lineage/winnow.mjs';
import { relationshipCard } from '../server/provenance/relationships.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { assertShape } from './helpers/shape.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const ids = (s) => tokenIds(tokenize(s).tokens);

describe('pure parts', () => {
  test('seedExtend grows maximal runs once per diagonal', () => {
    const a = ids('x y the ledger keeps every zero in its column so the sum can stand z');
    const b = ids('q the ledger keeps every zero in its column so the sum can stand w w');
    const runs = seedExtend(a, b, [{ a: 4, b: 3 }, { a: 6, b: 5 }, { a: 0, b: 0 }], { minRun: 8 });
    assert.deepEqual(runs, [{ a0: 2, a1: 15, b0: 1, b1: 14, len: 13 }]);
  });

  test('Smith–Waterman scores the shorter unit: 1 for containment, ≥ 0.75 for one substitution in 13', () => {
    const x = ids('keep every quiet zero in the long column so the sum can stand');
    const y = ids('keep every quiet nought in the long column so the sum can stand');
    const sw = smithWaterman(x, y);
    assert.equal(sw.score, 23);
    assert.ok(Math.abs(sw.normalized - 23 / 26) < 1e-9);
    assert.equal(smithWaterman(x, ids('a b keep every quiet zero in the long column so the sum can stand c')).normalized, 1);
    assert.ok(jaccard(shingles3(x), shingles3(y)) >= 0.5);
    const sx = minhash(shingles3(x)), sy = minhash(shingles3(y));
    assert.equal(sx.length, 128);
    assert.equal(lshBands(sx).length, 32);
    assert.ok(lshBands(sx).some((k, i) => k === lshBands(sy)[i]), 'similar units collide in at least one band');
  });

  test('units are sentences of ≥ 6 tokens (lines in verse)', () => {
    const text = 'Short one. This sentence has more than six tokens in it! Tiny.\nA verse line with enough words in it\nanother';
    const tok = tokenize(text);
    assert.deepEqual(unitsOf(text, tok).map((u) => tok.tokens.slice(u.t0, u.t1).join(' ')),
      ['this sentence has more than six tokens in it', 'a verse line with enough words in it another']);
    assert.deepEqual(unitsOf(text, tok, { verse: true }).length, 2);
  });

  test('classification follows the §4.7 table: dates decide direction, otherwise shared wording', () => {
    const doc = (lo, hi) => ({ lo_day: lo, hi_day: hi, chrono_status: lo === null ? 'undated' : 'dated' });
    const c1 = classifyCandidate({ a: { passage: 1, doc: doc(0, 10) }, b: { passage: 2, doc: doc(20, 30) } });
    assert.deepEqual([c1.rel_type, c1.src.passage, c1.dst.passage, c1.directed, c1.evidence_status], ['exact_quotation', 2, 1, 1, 'computed']);
    const c2 = classifyCandidate({ a: { passage: 1, doc: doc(0, 25) }, b: { passage: 2, doc: doc(20, 30) } });
    assert.deepEqual([c2.rel_type, c2.directed], ['shared_wording', 0]);
    const c3 = classifyCandidate({ a: { passage: 1, doc: doc(null, null) }, b: { passage: 2, doc: doc(20, 30) }, kind: 'near', score: 0.8 });
    assert.deepEqual([c3.rel_type, c3.score], ['shared_wording', { value: 0.8, kind: 'alignment_score' }]);
  });

  test('attribution cues in five languages; names resolve to authors or titles', () => {
    const langs = allCues('as Wrexley put it · in Brennock’s words · comme l’a écrit Hugo · según Galdós · मीरा ने कहा · મીરાં એ કહ્યું')
      .map((c) => [c.lang, c.name]);
    assert.deepEqual(langs, [['en', 'Wrexley'], ['en', 'Brennock'], ['fr', 'Hugo'], ['es', 'Galdós'], ['hi', 'मीरा'], ['gu', 'મીરાં']]);
    const t = '“Carry the zero,” said the clerk.';
    const q = findCues(t, 1, 15)[0];
    assert.equal(q.pattern, 'quotation marks around the span');
    assert.equal(q.quote, '“Carry the zero,”');
    assert.equal(q.name, null);
    assert.ok(nameMatches('Wrexley', { author: 'Tobias Wrexley (synthetic)' }));
    assert.ok(nameMatches('Ready Arithmetic', { title: "Brennock's Ready Arithmetic" }));
    assert.ok(!nameMatches('Mr Smith', { author: 'Ada Brennock', title: 'Ready Arithmetic' }));
  });
});

function addDocs(db, slug, docs) {
  const coll = ensureCollection(db, { slug, name: `${slug} (synthetic)`, corpus: 'test', adapter_id: 'file.jsonl', domain: 'imported',
    modality: 'text', unit: 'tokens', sampling: 'user' });
  const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id, format: 'jsonl' }), collection: slug, corpus: 'test' });
  const out = {};
  for (const d of docs) {
    const r = w.addDocument({ ext_id: d.ext_id, kind: 'document', title: d.title, author: d.author, lang_declared: 'en',
      text: { original: d.text, decoder: 'utf-8' }, dates: d.date ? [{ role: 'publication', raw: d.date, asserted_by: 'fixture', is_chronology: true }] : [],
      original_meta: { fixture: 'synthetic reuse test' } });
    assert.ok(r.documentId, JSON.stringify(r.issues));
    out[d.ext_id] = r.documentId;
  }
  w.finish();
  return { coll, ids: out };
}

describe('reuse-index job', () => {
  let tmp, db, ctx, result, extra;
  before(async () => {
    tmp = makeTmpData();
    db = tmp.db;
    extra = addDocs(db, 'reuse-extra', [
      { ext_id: 'cue', title: 'Lab notebook (synthetic)', author: 'Wren Fixture-Notes (synthetic)', date: '1971',
        text: 'Bit 7 flips on the third pass, as Fixture put it, a ghost in the margin. The tape runs again tomorrow morning.' },
      { ext_id: 'fixture-2', title: 'Second ledger tale (synthetic)', author: 'Ada Fixture (synthetic)', date: '1910',
        text: 'The clerk saw a ghost in the margin of the account and closed the book before supper came.' },
      { ext_id: 'toc-a', title: 'Almanac one (synthetic)', author: 'Press A (synthetic)', date: '1880',
        text: 'Chapter I Chapter II Chapter III Chapter IV Chapter V Chapter VI Chapter VII Chapter VIII. The first almanac begins with rain.' },
      { ext_id: 'toc-b', title: 'Almanac two (synthetic)', author: 'Press B (synthetic)', date: '1890',
        text: 'Chapter I Chapter II Chapter III Chapter IV Chapter V Chapter VI Chapter VII Chapter VIII. A second almanac starts with snow.' },
      { ext_id: 'near-a', title: 'Workshop rules (synthetic)', author: 'Bench A (synthetic)', date: '1970',
        text: 'Keep every quiet zero in the long column so the sum can stand. Other words follow here today.' },
      { ext_id: 'near-b', title: 'Bench song (synthetic)', author: 'Bench B (synthetic)', date: '1990',
        text: 'Keep every quiet nought in the long column so the sum can stand. Nothing else is the same here.' },
      { ext_id: 'undated-a', title: 'Flyer one (synthetic)', author: 'Crew A (synthetic)',
        text: 'Paint the wall with the kiln eye so every crew on the block knows that we came through the fire together tonight.' },
      { ext_id: 'undated-b', title: 'Flyer two (synthetic)', author: 'Crew B (synthetic)',
        text: 'Old notes say: paint the wall with the kiln eye so every crew on the block knows that we came through the fire.' },
      { ext_id: 'ed-1', title: 'The Counting Table (synthetic)', author: 'Ivo Same (synthetic)', date: '1901',
        text: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty, counted the boy at the long counting table by the window.' },
      { ext_id: 'ed-2', title: 'The Counting Table, 2nd ed. (synthetic)', author: 'Ivo Same (synthetic)', date: '1905',
        text: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty, counted the boy at the long counting table by the door.' },
    ]);
    ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    result = await reuseIndex(ctx, {});
  });
  after(() => tmp.cleanup());

  const rels = () => db.prepare('SELECT * FROM relationship WHERE run_id = ? ORDER BY id').all(result.run_id);
  const passageOf = (docId) => String(db.prepare("SELECT id FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off LIMIT 1").get(docId).id);

  test('the 13-token run shared by the 1963 bulletin and the 1958 memo is a computed exact quotation, bulletin → memo', () => {
    const memo = passageOf(tmp.mini.ids.get('mini:02')), bulletin = passageOf(tmp.mini.ids.get('mini:03'));
    const r = rels().find((x) => x.rel_type === 'exact_quotation' && x.src_ref === bulletin && x.dst_ref === memo);
    assert.ok(r, `exact quotation found: ${JSON.stringify(rels().map((x) => [x.rel_type, x.src_ref, x.dst_ref]))}`);
    assert.equal(r.evidence_status, 'computed');
    assert.equal(r.origin, 'algorithm');
    assert.equal(r.method, 'winnow k=8 w=6 + seed-extend');
    const card = relationshipCard(db, r.id);
    assertShape('Relationship', card);
    assert.deepEqual(card.score, { value: 1, kind: 'match_ratio' });
    assert.equal(card.evidence.find((e) => e.role === 'source_span').quote, 'it holds the place where nothing is, so that something can be counted');
    assert.equal(card.evidence[0].detail.tokens, 13);
    assert.deepEqual(card.revisions.map((v) => [v.rev, v.action, v.actor]), [[1, 'create', `run:${result.run_id}`]]);
    assert.equal(card.run.stage, 'reuse-index');
  });

  test('no algorithmic link is documented; undated pairs are shared wording; editions of one work are not quotations', () => {
    const all = rels();
    assert.ok(all.length >= 4);
    assert.ok(all.every((r) => r.evidence_status !== 'documented' && r.origin === 'algorithm'));
    const ua = passageOf(extra.ids['undated-a']), ub = passageOf(extra.ids['undated-b']);
    const sw = all.find((r) => [r.src_ref, r.dst_ref].sort().join() === [ua, ub].sort().join());
    assert.equal(sw.rel_type, 'shared_wording');
    assert.equal(sw.directed, 0);
    const e1 = passageOf(extra.ids['ed-1']), e2 = passageOf(extra.ids['ed-2']);
    assert.ok(!all.some((r) => [r.src_ref, r.dst_ref].includes(e1) && [r.src_ref, r.dst_ref].includes(e2)), 'same work, other edition');
    assert.ok(result.same_work_pairs >= 1);
    const ta = passageOf(extra.ids['toc-a']), tb = passageOf(extra.ids['toc-b']);
    assert.ok(!all.some((r) => [r.src_ref, r.dst_ref].includes(ta) && [r.src_ref, r.dst_ref].includes(tb)), 'a shared table of contents is structure, not wording');
    assert.ok(result.structural_runs >= 1);
  });

  test('a near quotation (one word changed) is verified and directed by dates', () => {
    const a = passageOf(extra.ids['near-a']), b = passageOf(extra.ids['near-b']);
    const r = rels().find((x) => x.rel_type === 'near_quotation');
    assert.ok(r, 'near quotation found');
    assert.deepEqual([r.src_ref, r.dst_ref], [b, a]);
    assert.equal(r.score_kind, 'alignment_score');
    const ev = relationshipCard(db, r.id).evidence[0];
    assert.ok(ev.detail.alignment_score >= 0.75 && ev.detail.jaccard >= 0.5);
  });

  test('an attribution cue gives a proposed citation with a CUE row, never a documented one', () => {
    const cue = passageOf(extra.ids.cue);
    const cites = rels().filter((x) => x.rel_type === 'explicit_citation');
    const r = cites.find((x) => x.dst_ref === passageOf(tmp.mini.ids.get('mini:01')));
    assert.ok(r, 'cue citation of the 1903 book by Ada Fixture found');
    assert.equal(r.src_ref, cue);
    assert.equal(r.evidence_status, 'proposed');
    assert.equal(r.origin, 'algorithm');
    assert.match(r.method, /^attribution cue \(en\): "as <Name>/);
    const card = relationshipCard(db, r.id);
    assert.deepEqual(card.cue, { quote: 'as Fixture put it', referent: 'inferred' });
    assert.equal(card.evidence.find((e) => e.role === 'source_span').quote, 'a ghost in the margin');
    // Ada Fixture has two texts with the words: both referents are kept as competing hypotheses
    assert.deepEqual(cites.map((x) => x.dst_ref).sort(), [passageOf(tmp.mini.ids.get('mini:01')), passageOf(extra.ids['fixture-2'])].sort());
    assert.ok(cites[0].hypothesis_group_id && cites[0].hypothesis_group_id === cites[1].hypothesis_group_id);
    assert.equal(db.prepare('SELECT question FROM hypothesis_group WHERE id = ?').get(cites[0].hypothesis_group_id).question,
      'Which text does “as Fixture put it” refer to?');
  });

  test('a run is reused while its inputs are unchanged; a forced rerun supersedes the old run', async () => {
    const again = await reuseIndex(ctx, {});
    assert.deepEqual(again, { run_id: result.run_id, reused: true });
    const forced = await reuseIndex(ctx, { force: true });
    assert.notEqual(forced.run_id, result.run_id);
    assert.equal(db.prepare('SELECT status FROM analysis_run WHERE id = ?').get(result.run_id).status, 'superseded');
    assert.equal(db.prepare('SELECT status FROM analysis_run WHERE id = ?').get(forced.run_id).status, 'succeeded');
    assert.equal(forced.relationships, rels().length, 'the old rows stay (pinned views still resolve them)');
  });

  test('a targeted trace reports the link the reuse index already made instead of duplicating it', () => {
    const memo = tmp.mini.ids.get('mini:02');
    const p = db.prepare("SELECT p.id, t.original FROM passage p JOIN document_text t ON t.document_id = p.document_id WHERE p.document_id = ? AND p.field = 'body'").get(memo);
    const quote = 'it holds the place where nothing is, so that something can be counted';
    const start = p.original.indexOf(quote);
    const out = traceSpan(db, ctx, { passage: p.id, start, end: start + quote.length });
    const indexed = db.prepare(`SELECT r.id FROM relationship r JOIN analysis_run a ON a.id = r.run_id WHERE a.stage = 'reuse-index'
      AND a.status = 'succeeded' AND r.rel_type = 'exact_quotation' AND r.dst_ref = ?`).get(String(p.id)).id;
    assert.deepEqual(out.created_relationships, [indexed]);
  });

  test('a cancelled run leaves nothing visible, and gc-runs removes its rows (never a reviewed one)', async () => {
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const cctx = makeTaskContext({ db, jobId: null, cancelFlag: cancel, post: (m) => { if (m.kind === 'progress' && m.phase === 'write') Atomics.store(cancel, 0, 1); } });
    await assert.rejects(() => reuseIndex(cctx, { force: true }), (e) => e.name === 'CancelledError');
    cctx._closeOpenRuns('cancelled');
    const run = db.prepare("SELECT id, status FROM analysis_run WHERE stage = 'reuse-index' ORDER BY id DESC LIMIT 1").get();
    assert.equal(run.status, 'cancelled');
    const left = db.prepare('SELECT count(*) AS n FROM relationship WHERE run_id = ?').get(run.id).n;
    assert.ok(left > 0, 'the cancelled run had written rows');
    const memo = passageOf(tmp.mini.ids.get('mini:02'));
    assert.ok(!lineageQuery(db, { root: `passage:${memo}` }).edges.some((e) => e.run_id === run.id), 'rows of a cancelled run are invisible');
    // a person reviewed one of them before gc: it has a revision and is kept
    const keep = db.prepare('SELECT id FROM relationship WHERE run_id = ? LIMIT 1').get(run.id).id;
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'human:x', '2026-10-04', 'create', '{}')`).run(keep);
    const gctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    const out = await gcRuns(gctx, { runs: [run.id] });
    assert.deepEqual(out.runs, [run.id]);
    // the first run was superseded by the forced rerun: its rows and metrics stay, its lookup files go
    const oldDir = path.join(tmp.dir, 'derived', 'reuse', `run-${result.run_id}`);
    assert.equal(out.index_files_removed, 2);
    assert.ok(!existsSync(path.join(oldDir, 'lsh.bin')) && existsSync(path.join(oldDir, 'metrics.json')));
    assert.equal(out.rows.relationship, left - 1);
    assert.equal(out.kept.relationships, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM relationship WHERE run_id = ?').get(run.id).n, 1);
    assert.match(db.prepare('SELECT notes FROM analysis_run WHERE id = ?').get(run.id).notes, /gc-runs/);
    const ok = db.prepare("SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' LIMIT 1").get().id;
    assert.deepEqual((await gcRuns(gctx, { runs: [ok] })).runs, [], 'succeeded runs are never collected');
  });
});

// ── §12.4 acceptance on the synthetic demo (data/demo, WP2): the detector finds A11→A4 and A20→A3 (computed exact
// quotations) and A13→A3 (proposed + CUE) and creates no documented edge. Skipped while the demo files are absent.

const DEMO = new URL('../data/demo/documents.jsonl', import.meta.url);

describe('reuse index on the demo world', () => {
  let tmp, db, result, skip = null;
  before(async () => {
    if (!existsSync(DEMO)) { skip = 'data/demo is not built yet (WP2)'; return; }
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    try {
      const { registerAdapters } = await import('../server/adapters/registry.mjs');
      await registerAdapters(db);
      const demo = await import('../server/jobs/tasks/demo-load.mjs');
      await demo.run(ctx, { pipeline: false });
    } catch (err) {
      skip = `the demo loader (WP2) failed: ${err.message}`;
      return;
    }
    result = await reuseIndex(ctx, { collections: ['demo-world'] });
  });
  after(() => tmp?.cleanup());

  test('A11→A4 and A20→A3 are computed exact quotations; A13→A3 is a proposed CUE citation; nothing is documented', (t) => {
    if (skip) { t.skip(skip); return; }
    const rows = db.prepare(`SELECT r.rel_type, r.evidence_status, r.origin, ds.ext_id AS src, dd.ext_id AS dst,
        EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'citation_cue') AS cue
      FROM relationship r JOIN passage ps ON ps.id = CAST(r.src_ref AS INTEGER) JOIN document ds ON ds.id = ps.document_id
      JOIN passage pd ON pd.id = CAST(r.dst_ref AS INTEGER) JOIN document dd ON dd.id = pd.document_id WHERE r.run_id = ?`).all(result.run_id);
    const has = (src, dst, type, status, cue = 0) => rows.some((r) => r.src === src && r.dst === dst && r.rel_type === type &&
      r.evidence_status === status && r.cue === cue);
    assert.ok(has('demo:A11', 'demo:A4', 'exact_quotation', 'computed'), JSON.stringify(rows));
    assert.ok(has('demo:A20', 'demo:A3', 'exact_quotation', 'computed'));
    assert.ok(has('demo:A13', 'demo:A3', 'explicit_citation', 'proposed', 1));
    assert.ok(rows.every((r) => r.evidence_status !== 'documented' && r.origin === 'algorithm'));
  });
});
