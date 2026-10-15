// OWNER: WP5 — fix pass: a saved view opened "as saved" reproduces what it showed (D17, §13 rule 17), also after an import
// it counted is reverted (documents are only soft-deleted), with context-group lanes (the clustering run is pinned) and
// on a virtual corpus (every member's counting run is pinned and the counts span the members).
//
// Every document here is SYNTHETIC (the mini fixture and two synthetic test corpora). The virtual-corpus case composes the
// two synthetic corpora through the `scope` option, the same code path `real` takes for its members (invented text never
// lives in a real corpus).

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { nowIso } from '../server/db/open.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, timelineQuery } from '../server/aggregate/query.mjs';
import { computeTiles } from '../server/aggregate/tiles.mjs';
import { revertImport } from '../server/ingest/pipeline.mjs';
import { DRIFT_MESSAGE, getView, REVERTED_NOTE, saveView } from '../server/provenance/views.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { queryBody } from '../src/ui/timeline/tiles-client.mjs';
import { formatFilter } from '../src/shared/viewstate.mjs';
import { AS_SAVED_NOTE, compareQuery, normalizeCompareRequest } from '../server/analysis/compare.mjs';
import { clusterRunFor, driftRunParams } from '../server/analysis/drift.mjs';
import { createAnnotation, reviseAnnotation } from '../server/provenance/annotations.mjs';
import { pinnedMaterializeRun } from '../server/routes/kwic.mjs';
import { kwicQuery } from '../server/text/kwic.mjs';
import { compareRequest } from '../src/ui/panels/compare.mjs';
import { crossingsQuery } from '../src/ui/panels/crossings.mjs';
import { asSavedParams } from '../src/ui/panels/views-menu.mjs';
import { assertShape } from './helpers/shape.mjs';
import { loadMini, makeTmpData, miniDocuments } from './helpers/tmpdata.mjs';

const lanesOf = (q) => Object.fromEntries(q.lanes.map((l) => [l.key, { n: l.n, coverage: l.coverage }]));
const cellsOf = (t) => JSON.stringify(t.tiles.map((x) => [x.tile, x.lanes, x.coverage]));

describe('as saved after a revert: soft-deleted documents still count (D17)', () => {
  let tmp, db, zero, later, view;
  const state = (id) => ({ v: 1, corpus: 'test', strands: [{ type: 'expression', id }], lanes: { facet: 'collection', order: 'first_observed', max: 10 } });
  /** The request the client sends for a view opened as saved (main.mjs openSavedView + tiles-client queryBody). */
  const asSavedDef = (v) => {
    const opened = { ...v.state, runs: { materialize: v.runIds.materialize } };
    const view = { ...opened, lanes: { facet: 'collection', order: 'first_observed', max: 10, ...opened.lanes }, f: opened.f ?? {},
      toggles: opened.toggles ?? {}, timeBasis: 'publication' };
    const body = queryBody(view, { formatFilter, cutoffs: { ...v.cutoffs, at: v.savedAt } });
    assert.deepEqual(body.cutoffs, { import_batch: v.cutoffs.import_batch, at: v.savedAt }, 'the client sends the save time');
    return buildDef(db, canonicalRequest(body)).def;
  };
  const currentDef = () => buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }],
    lanes: { facet: 'collection' } })).def;

  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    // a second import into the same corpus, counted by the view and reverted after the save
    later = loadMini(db, { docs: miniDocuments().map((d) => ({ ...d, ext_id: `${d.ext_id}-b` })), slug: 'mini-later' });
    zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    materializeInline(db, zero);
  });
  after(() => tmp.cleanup());

  test('the timeline, tiles, exclusions and view counts as saved do not change when a counted import is reverted', async () => {
    view = saveView(db, { name: 'zero before the revert', state: state(zero) });
    const saved = { ...view, state: getView(db, view.slug).state };
    const before0 = timelineQuery(db, { def: asSavedDef(saved) });
    const tiles0 = computeTiles(db, asSavedDef(saved), 'L1', [2, 3]);
    assert.ok(before0.lanes.some((l) => l.key.startsWith('collection:mini-later') && l.n > 0), 'the later import is counted at save');

    await sleep(5);   // the revert happens strictly after the save
    await revertImport({ db, progress() {}, emit() {} }, { batchId: later.batchId });

    const after0 = timelineQuery(db, { def: asSavedDef(saved) });
    assert.equal(after0.totals.n, before0.totals.n, 'as saved: the same number of matches');
    assert.deepEqual(lanesOf(after0), lanesOf(before0), 'as saved: the same lanes, counts and coverage (cube rows of deleted documents)');
    assert.deepEqual(after0.totals.excluded, before0.totals.excluded, 'as saved: the same exclusions');
    assert.equal(cellsOf(computeTiles(db, asSavedDef(saved), 'L1', [2, 3])), cellsOf(tiles0), 'as saved: the same cells and denominators');

    const now = timelineQuery(db, { def: currentDef() });
    assert.ok(now.totals.n < before0.totals.n, 'current data: the reverted documents are gone');
    assert.ok(!now.lanes.some((l) => l.key.startsWith('collection:mini-later')), 'current data: no lane for the reverted import');

    const opened = getView(db, view.slug, { asSaved: true });
    assertShape('View', opened);
    assert.deepEqual(opened.counts.asSaved, view.counts, 'the view’s own as-saved counts are those at save');
    assert.deepEqual(opened.drift.revertedSince.map((b) => b.batch), [later.batchId]);
    assert.equal(opened.drift.dataChanged, true);
    assert.equal(opened.drift.message, `${DRIFT_MESSAGE(view.cutoffs.import_batch)} ${REVERTED_NOTE(opened.drift.revertedSince)}`);
    assert.match(opened.drift.message, /reverted since; 'As saved' still counts its documents\./);
  });

  test('a document deleted before the save is not brought back; a bad save time is refused', () => {
    db.prepare("UPDATE document SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE ext_id = 'mini:01'").run();
    const v = saveView(db, { name: 'after an old deletion', state: state(zero) });
    const q = timelineQuery(db, { def: asSavedDef({ ...v, state: getView(db, v.slug).state }) });
    const cur = timelineQuery(db, { def: currentDef() });
    assert.equal(q.totals.n, cur.totals.n, 'deleted before the save: absent as saved too');
    assert.throws(() => canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], cutoffs: { at: 'yesterday' } }),
      (e) => e.status === 400 && e.detail?.field === 'cutoffs.at');
  });
});

describe('saved views pin the clustering run of context-group lanes (§13 rule 17)', () => {
  let tmp, db, zero;
  const clusterRun = (expr, mat) => {
    const id = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
        input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at, finished_at, gate_json)
      VALUES ('cluster', 'test@1', 'x', ?, 'x', ?, 'x', 0, 'u61m-1', 'seg-1', 'icu', 'succeeded', ?, ?, '{"cluster":{"gate":"ok"}}')`)
      .run(JSON.stringify({ expr, materialize: mat }), JSON.stringify({ expression: expr }), nowIso(), nowIso()).lastInsertRowid);
    for (const ord of [1, 2]) {
      db.prepare(`INSERT INTO sense_cluster (run_id, expression_id, ord, label_auto, distinctive_json, size, n_docs, top_doc_share, status)
        VALUES (?, ?, ?, ?, '[]', 1, 1, 1, 'hypothesis')`).run(id, expr, ord, `machine label: group ${ord}`);
    }
    return id;
  };
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
  });
  after(() => tmp.cleanup());

  test('the run on screen is pinned at save, opening as saved uses it, and a newer run is listed as drift', () => {
    const mat = materializeInline(db, zero).run;
    const first = clusterRun(zero, mat);
    const st = { v: 1, corpus: 'test', strands: [{ type: 'expression', id: zero }], lanes: { facet: 'cluster', order: 'first_observed', max: 10 } };
    const v = saveView(db, { name: 'groups of zero', state: st });
    assert.equal(v.runIds.cluster, first, 'the default run (lanes.run unset) is pinned');
    assert.equal(v.runIds.materialize[String(zero)], mat);
    const newer = clusterRun(zero, mat);
    const opened = getView(db, v.slug, { asSaved: true });
    assert.deepEqual(opened.drift.newerRuns.filter((r) => r.stage === 'cluster'), [{ stage: 'cluster', run: newer, pinned: first }]);
    // the request the client sends as saved (lanes.run from runIds.cluster) shows the pinned run's lanes
    const def = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }],
      lanes: { facet: 'cluster', run: opened.runIds.cluster }, runs: { materialize: opened.runIds.materialize } })).def;
    assert.equal(def.cluster.run, first);
    const live = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'cluster' } })).def;
    assert.equal(live.cluster.run, newer, 'with current data the newest run is shown');
    // a recount that finds exactly the same matches (new code, same result) keeps the groups, read over their own count
    const recount = materializeInline(db, zero).run;
    assert.notEqual(recount, mat);
    const after = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'cluster' } })).def;
    assert.equal(after.cluster.state, 'ok');
    assert.equal(after.cluster.run, newer);
    assert.equal(after.strands[0].run, mat, 'the lanes read the count the groups were made of');
    // a recount with different matches asks for a new clustering run
    db.prepare('UPDATE expr_doc SET n = n + 1 WHERE run_id = ? AND document_id = (SELECT min(document_id) FROM expr_doc WHERE run_id = ?)').run(recount, recount);
    const changed = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'cluster' } })).def;
    assert.equal(changed.cluster.state, 'not_run');
    assert.match(changed.cluster.note, /grouped an earlier count/);
  });
});

describe('a saved view of a virtual corpus counts and pins every member (§13 rule 17)', () => {
  let tmp, db, scope, ids;
  const write = (corpus, slug, docs) => {
    db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
      VALUES (?, ?, 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?) ON CONFLICT(slug) DO NOTHING`).run(corpus, `Test ${corpus} (synthetic)`, nowIso());
    const coll = ensureCollection(db, { slug, name: `${slug} (synthetic)`, corpus, adapter_id: 'file.jsonl', domain: 'literature',
      modality: 'text', unit: 'tokens', sampling: 'user', coverage_gate: 2000, selection_note: 'invented test documents' });
    const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: `${slug}.jsonl` });
    const w = createDocumentWriter(db, { batchId, collection: coll.slug, corpus, options: { now: new Date('2026-10-04T12:00:00Z') } });
    docs.forEach((d, i) => w.addDocument(d, { line: i + 1 }));
    w.finish();
  };
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    write('ta', 'ta-books', miniDocuments().slice(0, 6));
    write('tb', 'tb-books', miniDocuments().slice(6).map((d) => ({ ...d, ext_id: `${d.ext_id}-tb` })));
    const members = db.prepare("SELECT id, slug, name FROM corpus WHERE slug IN ('ta', 'tb') ORDER BY id").all().map((r) => ({ ...r }));
    scope = { slug: 'real', name: 'All real corpora', virtual: true, ids: members.map((m) => m.id), members, synthetic: false };
    ids = ['ta', 'tb'].map((c) => {
      const { id } = trackExpression(db, { surface: 'zero', lang: 'en', corpus: c });
      return { id, run: materializeInline(db, id).run };
    });
  });
  after(() => tmp.cleanup());

  test('every member’s counting run is pinned and the counts are the sum of the members', () => {
    const st = { v: 1, corpus: 'real', strands: [{ type: 'expression', id: ids[0].id }], lanes: { facet: 'trail', order: 'first_observed', max: 18 } };
    const v = saveView(db, { name: 'zero across the members', state: st }, { scope });
    assert.deepEqual(v.runIds.materialize, { [ids[0].id]: ids[0].run, [ids[1].id]: ids[1].run }, 'both members pinned');
    const alone = ids.map(({ id, run }) => db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM expr_doc WHERE expression_id = ? AND run_id = ?').get(id, run).n);
    assert.ok(alone[0] > 0 && alone[1] > 0, 'both members count the word');
    const counts = v.counts.strands[String(ids[0].id)];
    assert.equal(counts.n, alone[0] + alone[1], 'the strand count spans the members');
    assert.deepEqual(counts.runs, { [ids[0].id]: ids[0].run, [ids[1].id]: ids[1].run });
    assert.ok(v.counts.documents >= 12 && v.counts.tokens > 0, 'documents and tokens of every member corpus');
  });
});

describe('a count records the matching code it was made with (fix pass, §13 rule 17)', () => {
  let tmp, db;
  before(() => { tmp = makeTmpData(); db = tmp.db; });
  after(() => tmp.cleanup());

  test('the run hashes the guard and matching modules, and a count made under other matching code is stale', async () => {
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const { freshness, MATCHING_CODE_FILES, matchingCodeHash } = await import('../server/aggregate/materialize.mjs');
    const id = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    const run = materializeInline(db, id).run;
    const row = db.prepare('SELECT code_hash, params_json FROM analysis_run WHERE id = ?').get(run);
    assert.equal(JSON.parse(row.params_json).code, matchingCodeHash());
    const names = MATCHING_CODE_FILES.map((u) => u.pathname.split('/').slice(-2).join('/'));
    for (const f of ['text/names.mjs', 'text/variants.mjs', 'aggregate/materialize.mjs', 'shared/tokenize.mjs']) assert.ok(names.includes(f), f);
    const wrapperOnly = createHash('sha256').update(readFileSync(new URL('../server/jobs/tasks/materialize.mjs', import.meta.url))).digest('hex');
    assert.notEqual(row.code_hash, wrapperOnly, 'not the task wrapper alone');
    assert.equal(freshness(db, id).fresh, true);
    // the same count recorded under other matching code: a copy of the run whose params name another code hash
    const params = { ...JSON.parse(row.params_json), code: '0000000000000000' };
    const { canonicalJson } = await import('../src/shared/ids.mjs');
    const pj = canonicalJson(params);
    const older = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
        input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      SELECT stage, 'materialize@1.0.0', 'older', ?, ?, scope_json, input_fingerprint, data_version, tokenizer_version, segmenter_version,
        icu_version, 'succeeded', started_at FROM analysis_run WHERE id = ?`).run(pj, createHash('sha256').update(pj).digest('hex'), run).lastInsertRowid);
    db.prepare('UPDATE expression_state SET run_id = ? WHERE expression_id = ?').run(older, id);
    assert.deepEqual(freshness(db, id), { runId: older, fresh: false }, 'stale: it is counted again');
  });
});

// ── RF-2 (IOS-SPEC §2.1, ref-freeze-1): Compare and the inspector's counts as saved ─────────────────────────────────
// Before RF-2 a saved view opened as saved drew its Scroll from the pinned runs and cutoffs, while Compare and the
// inspector's concordance counts read current data: after a revert or a recount they changed under the reader.

describe('RF-2: Compare and the inspector\'s counts as saved (D17)', () => {
  let tmp, db, zero, later, view, asSaved;
  // the later import repeats the mini texts (duplicates of them): the comparisons count duplicates, so the revert shows
  const req = (extra = {}) => ({ expr: [zero], a: { years: [1900, 1950] }, b: { years: [1951, 2000] }, seed: 1, toggles: { dup: 1 }, ...extra });
  const counts = (p) => ['a', 'b'].map((k) => ({ tokens: p.coverage[k].tokens, docs: p.coverage[k].docs, occurrences: p.freq[k].occurrences,
    n: p.freq[k].n, collections: p.coverage[k].collections }));
  const kwicDef = (extra = {}) => buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }],
    lanes: { facet: 'language' }, toggles: { dup: 1 }, ...extra })).def;

  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    later = loadMini(db, { docs: miniDocuments().map((d) => ({ ...d, ext_id: `${d.ext_id}-b` })), slug: 'mini-later' });
    zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    materializeInline(db, zero);
  });
  after(() => tmp.cleanup());

  test('Compare as saved counts what the view counted, after a revert and a recount; current data moves on', async () => {
    const doc = db.prepare("SELECT id FROM document WHERE ext_id = 'mini:01'").get().id;
    const ann = createAnnotation(db, { target: { type: 'document', ref: String(doc) }, kind: 'interpretation', body_md: 'a sincere use',
      dimensions: { pragmatic_function: 'sincere' } });
    view = saveView(db, { name: 'zero compared', state: { v: 1, corpus: 'test', strands: [{ type: 'expression', id: zero }],
      lanes: { facet: 'collection', order: 'first_observed', max: 10 }, toggles: { dup: 1 },
      compare: { a: { years: [1900, 1950], f: '' }, b: { years: [1951, 2000], f: '' } } } });
    asSaved = { runs: { materialize: view.runIds.materialize }, cutoffs: { import_batch: view.cutoffs.import_batch, at: view.savedAt,
      annotation_rev: view.cutoffs.annotation_rev } };
    const pinned = view.runIds.materialize[String(zero)];
    const atSave = compareQuery(db, req(asSaved));
    assertShape('Compare', atSave);
    assert.deepEqual(counts(atSave), counts(compareQuery(db, req())), 'at the save, as saved = current');
    assert.equal(atSave.as_saved.note, AS_SAVED_NOTE);
    assert.deepEqual(atSave.as_saved.cutoffs, asSaved.cutoffs);
    assert.ok(atSave.coverage.a.collections.includes('mini-later'), 'the later import is counted at the save');
    assert.deepEqual(atSave.human.pragmatic_function.a, { sincere: 1 });

    await sleep(5);   // everything below happens strictly after the save
    await revertImport({ db, progress() {}, emit() {} }, { batchId: later.batchId });
    const recount = materializeInline(db, zero).run;
    assert.notEqual(recount, pinned, 'a new counting run exists');
    reviseAnnotation(db, ann.id, { body_md: 'read again: ironic', dimensions: { pragmatic_function: 'ironic' } });
    createAnnotation(db, { target: { type: 'document', ref: String(doc) }, kind: 'question', body_md: 'parody?', dimensions: { pragmatic_function: 'parodic' } });

    const reopened = compareQuery(db, req(asSaved));
    assert.deepEqual(counts(reopened), counts(atSave), 'as saved: the same documents, tokens and matches');
    assert.equal(reopened.provenance.run_ids.materialize[zero], pinned, 'as saved: the pinned counting run');
    assert.deepEqual(reopened.human.pragmatic_function.a, { sincere: 1 }, 'as saved: the annotations as they stood at the save');
    assert.deepEqual(reopened.passages, atSave.passages, 'as saved: the same seeded passages');

    const now = compareQuery(db, req());
    assert.equal(now.as_saved, undefined, 'current data carries no as_saved block');
    assert.equal(now.provenance.run_ids.materialize[zero], recount);
    assert.ok(now.coverage.a.docs < atSave.coverage.a.docs, 'current data: the reverted documents are gone');
    assert.ok(!now.coverage.a.collections.includes('mini-later'));
    assert.deepEqual(now.human.pragmatic_function.a, { ironic: 1, parodic: 1 });
  });

  test('the concordance as saved (GET /api/kwic … runs, import_batch, at) counts the as-saved timeline\'s matches', () => {
    const pinned = view.runIds.materialize[String(zero)];
    const current = db.prepare("SELECT run_id FROM expression_state WHERE expression_id = ?").get(zero).run_id;
    assert.equal(pinnedMaterializeRun(db, `${current},${pinned}`.split(',').reverse().join(','), zero), Math.max(pinned, current),
      'the expression\'s own counting run among the pins (the newest when several are listed)');
    assert.equal(pinnedMaterializeRun(db, String(pinned), zero), pinned);
    assert.equal(pinnedMaterializeRun(db, '', zero), null);
    const cutoffs = { import_batch: view.cutoffs.import_batch, at: view.savedAt };
    const savedDef = kwicDef({ runs: { materialize: { [zero]: pinned } }, cutoffs });
    const tl = timelineQuery(db, { def: savedDef });
    const kw = kwicQuery(db, { def: savedDef, limit: 5 });
    assert.equal(kw.total, tl.totals.n, 'as saved: concordance = timeline');
    const cur = kwicQuery(db, { def: kwicDef(), limit: 5 });
    assert.ok(cur.total < kw.total, `current data counts fewer (${cur.total} < ${kw.total})`);
  });

  test('a pin that is not a counting run of the expression is refused; requests normalize to themselves', () => {
    assert.throws(() => compareQuery(db, req({ runs: { materialize: { [zero]: 999999 } } })), (e) => e.status === 400 && e.detail?.field === 'runs');
    assert.throws(() => normalizeCompareRequest(req({ cutoffs: { at: 'yesterday' } })), (e) => e.status === 400 && e.detail?.field === 'cutoffs.at');
    assert.throws(() => normalizeCompareRequest(req({ runs: { cluster: 0 } })), (e) => e.status === 400 && e.detail?.field === 'runs.cluster');
    const n = normalizeCompareRequest(req({ runs: { materialize: { [zero]: 5, 424242: 6 }, cluster: 9 }, cutoffs: { import_batch: 3, at: view.savedAt, other: 1 } }));
    assert.deepEqual(n.runs, { materialize: { [zero]: 5 }, cluster: 9 }, 'only the compared expressions\' pins');
    assert.deepEqual(n.cutoffs, { import_batch: 3, at: view.savedAt });
    assert.deepEqual(normalizeCompareRequest(n), n, 'idempotent');
    assert.equal(normalizeCompareRequest(req()).runs, undefined, 'current data: no runs, no cutoffs');
    assert.notEqual(driftRunParams(n), driftRunParams(req()), 'an as-saved drift run is its own comparison');
    assert.deepEqual(driftRunParams(normalizeCompareRequest(req())), driftRunParams({ ...normalizeCompareRequest(req()) }));
  });

  test('the clustering run as saved: the pinned one, else the newest finished at the save; labels as they stood', async () => {
    const mat = view.runIds.materialize[String(zero)];
    const run = (label) => {
      const at = nowIso();
      const id = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
          input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at, finished_at, gate_json)
        VALUES ('cluster', 'test@1', 'x', ?, 'x', ?, 'x', 0, 'u61m-1', 'seg-1', 'icu', 'succeeded', ?, ?, '{"cluster":{"gate":"ok"}}')`)
        .run(JSON.stringify({ expr: zero, materialize: mat }), JSON.stringify({ expression: zero, modality: 'text' }), at, at).lastInsertRowid);
      const c = Number(db.prepare(`INSERT INTO sense_cluster (run_id, expression_id, ord, label_auto, distinctive_json, size, n_docs, top_doc_share, status)
        VALUES (?, ?, 1, ?, '[]', 1, 1, 1, 'hypothesis')`).run(id, zero, label).lastInsertRowid);
      return { id, cluster: c };
    };
    const first = run('machine label: first');
    const label = createAnnotation(db, { target: { type: 'cluster', ref: String(first.cluster) }, kind: 'label', body_md: 'counting places' });
    await sleep(5);
    const savedAt = nowIso();
    const annCut = db.prepare('SELECT MAX(id) AS n FROM annotation_revision').get().n;
    await sleep(5);
    const second = run('machine label: second');
    reviseAnnotation(db, label.id, { body_md: 'renamed later' });
    assert.equal(clusterRunFor(db, zero, { modality: 'text' }).run, second.id, 'current data: the newest run');
    assert.equal(clusterRunFor(db, zero, { modality: 'text', run: first.id }).run, first.id, 'as saved: the pinned run');
    const then = clusterRunFor(db, zero, { modality: 'text', before: savedAt, revCutoff: annCut });
    assert.equal(then.run, first.id, 'as saved without a pin: the newest run finished at the save');
    assert.equal(then.clusters[0].human_label, 'counting places', 'the reader\'s label as it stood');
    assert.equal(clusterRunFor(db, zero, { modality: 'text', run: first.id }).clusters[0].human_label, 'renamed later', 'current labels without a cutoff');
    assert.equal(clusterRunFor(db, zero, { modality: 'titles', run: first.id }), null, 'a pinned run of another medium is not used');
  });

  test('the UI sends the pins and cutoffs only as saved (Compare body, inspector concordance)', () => {
    const saved = { slug: view.slug, asSaved: true, cutoffs: { ...view.cutoffs, at: view.savedAt }, runIds: { ...view.runIds, cluster: 77 } };
    const state = { v: 1, corpus: 'test', strands: [{ type: 'expression', id: zero }, { type: 'expression', id: 424242 }], f: {}, toggles: {},
      compare: { a: { years: [1900, 1950], f: '' }, b: { years: [1951, 2000], f: '' } } };
    const body = compareRequest(state, { saved }).body;
    assert.deepEqual(body.runs, { materialize: { [zero]: view.runIds.materialize[String(zero)] }, cluster: 77 });
    assert.deepEqual(body.cutoffs, { import_batch: view.cutoffs.import_batch, at: view.savedAt, annotation_rev: view.cutoffs.annotation_rev });
    assert.deepEqual(normalizeCompareRequest(body).runs, body.runs, 'the server keeps what the page sends');
    const cur = compareRequest(state, { saved: { ...saved, asSaved: false } }).body;
    assert.equal(cur.runs, undefined);
    assert.equal(cur.cutoffs, undefined);
    assert.deepEqual(asSavedParams(saved, 'kwic'), { runs: String(view.runIds.materialize[String(zero)]), import_batch: view.cutoffs.import_batch, at: view.savedAt });
    assert.deepEqual(asSavedParams(saved, 'clusters'), { rev_cutoff: view.cutoffs.annotation_rev });
    assert.deepEqual(asSavedParams({ ...saved, asSaved: false }, 'kwic'), {});
    // the Crossings card in the inspector queries as the Scroll does: pinned runs, import cutoff and save time
    const cq = crossingsQuery(zero, { trail: false, corpus: 'test', toggles: { dup: 1 }, saved });
    assert.deepEqual(cq.runs, { materialize: view.runIds.materialize });
    assert.deepEqual(cq.cutoffs, { import_batch: view.cutoffs.import_batch, at: view.savedAt });
    const asSavedN = timelineQuery(db, { def: buildDef(db, canonicalRequest(cq)).def }).totals.n;
    const currentN = timelineQuery(db, { def: buildDef(db, canonicalRequest(crossingsQuery(zero, { trail: false, corpus: 'test', toggles: { dup: 1 } }))).def }).totals.n;
    assert.ok(asSavedN > currentN, `the card counts as saved (${asSavedN}) what current data no longer has (${currentN})`);
  });
});
