// OWNER: WP4 — context-group clustering on the SYNTHETIC demo through the real pipeline (SPEC §4.8, §9.6):
// demo-load → materialize → the cluster task. Calibration: carry the zero k = 4, ARI ≥ 0.8 against the planted
// senses, stability ≥ 0.6 for every group; flux up k = 4, ARI ≥ 0.7; ◉ is gated with no value; GET
// /api/clusters payloads keep the Clusters shape; machine labels stay visible after a human rename; a run is
// reused, pinned runs report a newer one; a cancelled job leaves no visible rows; convergence obeys its gate.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { convergence, convergenceInputs } from '../server/analysis/convergence.mjs';
import { MACHINE_LABEL_PREFIX } from '../server/analysis/labels.mjs';
import { normalizeToggles, resolveExpressions } from '../server/analysis/slices.mjs';
import { adjustedRandIndex } from '../server/analysis/stability.mjs';
import { bus } from '../server/http/sse.mjs';
import { createJobQueue } from '../server/jobs/queue.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { clusterParams, run as runCluster } from '../server/jobs/tasks/cluster.mjs';
import { clustersPayload } from '../server/routes/clusters.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';
const DEMO_PARAMS = { representation: 'tfidf-hash-4096', k: 'auto', seed: 1994 };

function taskCtx(db) {
  return makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
}

/** The planted sense of each member of a run (document original_meta.senses[expression]) and its group. */
function plantedVsFound(db, runId, surface) {
  const rows = db.prepare(`SELECT m.cluster_id AS c, d.original_meta_json AS meta FROM cluster_member m
    JOIN sense_cluster s ON s.id = m.cluster_id JOIN occurrence o ON o.id = m.occurrence_id JOIN document d ON d.id = o.document_id
    WHERE s.run_id = ? ORDER BY m.occurrence_id`).all(runId);
  const gold = rows.map((r) => JSON.parse(r.meta).senses?.[surface] ?? '?');
  const names = [...new Set(gold)];
  return { gold: gold.map((g) => names.indexOf(g)), found: rows.map((r) => r.c), names, n: rows.length };
}

describe('clustering on the synthetic demo (carry the zero world)', () => {
  let tmp, db, ctx, ids, cz, flux, kiln, skip = null;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    ctx = taskCtx(db);
    try {
      const { registerAdapters } = await import('../server/adapters/registry.mjs');
      await registerAdapters(db);
      const demo = await import('../server/jobs/tasks/demo-load.mjs');
      ids = (await demo.run(ctx, { pipeline: false })).human_layer.expressions;
      const materialize = await import('../server/jobs/tasks/materialize.mjs');
      for (const id of Object.values(ids)) await materialize.run(ctx, { expressionId: id });
    } catch (err) {
      skip = `the demo or materialize (WP2/WP3) failed: ${err.message}`;
      return;
    }
    cz = await runCluster(ctx, { expressionId: ids['carry the zero'], expr: ids['carry the zero'], params: DEMO_PARAMS });
    flux = await runCluster(ctx, { expressionId: ids['flux up'], expr: ids['flux up'], params: DEMO_PARAMS });
    kiln = await runCluster(ctx, { expressionId: ids['◉'], params: DEMO_PARAMS });
  });
  after(() => tmp?.cleanup());

  test('§9.6: carry the zero → k = 4, ARI ≥ 0.8 against the planted senses, every group stable (≥ 0.6)', (t) => {
    if (skip) { t.skip(skip); return; }
    assert.equal(cz.gate, 'ok');
    assert.equal(cz.k, 4);
    const pv = plantedVsFound(db, cz.run_id, 'carry the zero');
    assert.equal(pv.n, 340);
    assert.deepEqual(pv.names.sort(), ['honor', 'irony', 'null', 'place']);
    const ari = adjustedRandIndex(pv.gold, pv.found);
    assert.ok(ari >= 0.8, `ARI ${ari}`);
    const groups = db.prepare('SELECT * FROM sense_cluster WHERE run_id = ? ORDER BY ord').all(cz.run_id);
    assert.equal(groups.length, 4);
    for (const g of groups) {
      assert.ok(g.stability >= 0.6, `group ${g.ord} stability ${g.stability}`);
      assert.ok(g.label_auto.startsWith(MACHINE_LABEL_PREFIX));
      assert.equal(g.status, 'hypothesis');
    }
    const run = db.prepare('SELECT * FROM analysis_run WHERE id = ?').get(cz.run_id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.representation, 'tfidf-hash-4096');
    assert.equal(run.seed, 1994);
    assert.equal(JSON.parse(run.scope_json).expression, ids['carry the zero']);
  });

  test('§9.6: flux up → k = 4, ARI ≥ 0.7', (t) => {
    if (skip) { t.skip(skip); return; }
    assert.equal(flux.k, 4);
    const pv = plantedVsFound(db, flux.run_id, 'flux up');
    const ari = adjustedRandIndex(pv.gold, pv.found);
    assert.ok(ari >= 0.7, `ARI ${ari}`);
  });

  test('windows: the synthetic 1940s archive gap is an uncovered window; shares carry CIs; transitions are computed sentences', (t) => {
    if (skip) { t.skip(skip); return; }
    const p = clustersPayload(db, { expr: ids['carry the zero'] });
    assert.deepEqual(check('Clusters', p), []);
    const gap = p.windows.find((w) => w.lo <= 1940 && w.hi >= 1949);
    assert.equal(gap.state, 'uncovered');
    assert.equal(gap.note, `No sources in ${gap.label}.`);
    assert.ok(p.windows.filter((w) => w.state === 'measured').every((w) => w.n >= 30));
    for (const s of p.shares) assert.ok(s.ci[0] <= s.share && s.share <= s.ci[1]);
    for (const w of p.windows.filter((x) => x.state === 'measured')) {
      const sum = p.shares.filter((s) => s.window === w.id).reduce((x, s) => x + s.share, 0);
      assert.ok(Math.abs(sum - 1) < 1e-3, `window ${w.label} shares sum ${sum}`);
    }
    assert.ok(p.transitions.length > 0);
    for (const tr of p.transitions) {
      assert.equal(tr.evidence_status, 'computed');
      assert.ok(tr.text.length > 20);
      assert.doesNotMatch(tr.text, /\b(thought|felt|intended|meant to|wanted|believed)\b/i);
    }
    assert.ok(p.transitions.some((tr) => tr.kind === 'unknown_gap' && tr.window === gap.id), 'a group present before the gap gets an unknown_gap');
    const emerged = p.transitions.filter((tr) => tr.kind === 'emerge' || tr.kind === 'split').map((tr) => tr.to_ord).sort();
    assert.deepEqual(emerged, [2, 3, 4], 'the three later groups emerge after the first measured window');
    assert.equal(p.representation, 'tfidf-hash-4096');
    assert.match(p.clusters[0].card, /representation: tfidf-hash-4096/);
    assert.equal(p.synthetic, true);
    assert.equal(p.provenance.synthetic, true);
  });

  test('◉ (26 matches in 9 documents) is gated: the run succeeds with no group and the payload carries no numeral', (t) => {
    if (skip) { t.skip(skip); return; }
    assert.equal(kiln.gate, 'insufficient_occurrences');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sense_cluster WHERE run_id = ?').get(kiln.run_id).n, 0);
    const p = clustersPayload(db, { expr: ids['◉'] });
    assert.deepEqual(check('Clusters', p), []);
    assert.equal(p.gate, 'insufficient_occurrences');
    assert.equal(p.value, null);
    // §4.11 copy; one of the 26 matches has fewer than 3 usable context words and is counted apart
    assert.equal(p.note, 'Clustering unavailable: 25 occurrences in 9 documents. (1 more had fewer than 3 usable context words)');
    assert.equal(p.excluded.context_thin, 1);
    assert.deepEqual(p.needed, { occurrences: 60, documents: 5 });
    assert.equal(p.fallback_lanes, 'language');
    assert.equal(p.clusters, undefined);
  });

  test('without a run: not_run with how to start one', (t) => {
    if (skip) { t.skip(skip); return; }
    const p = clustersPayload(db, { expr: ids['ghost in the margin'] });
    assert.deepEqual(check('Clusters', p), []);
    assert.equal(p.gate, 'not_run');
    assert.deepEqual(p.suggestion.request, { method: 'POST', path: '/api/analysis/runs', body: { stage: 'cluster', expr: ids['ghost in the margin'] } });
    assert.throws(() => clustersPayload(db, { expr: 'x' }), (e) => e.status === 400);
    assert.throws(() => clustersPayload(db, { expr: ids['carry the zero'], run: 999999 }), (e) => e.status === 404 && e.code === 'E_NOT_FOUND');
    assert.throws(() => clustersPayload(db, { expr: 999999 }), (e) => e.status === 404);
  });

  test('an identical run is reused; a pinned older run reports the newer one', async (t) => {
    if (skip) { t.skip(skip); return; }
    const again = await runCluster(ctx, { expressionId: ids['carry the zero'], params: DEMO_PARAMS });
    assert.deepEqual(again, { run_id: cz.run_id, reused: true });
    const other = await runCluster(ctx, { expressionId: ids['carry the zero'], params: { ...DEMO_PARAMS, seed: 7, with: [] } });
    assert.notEqual(other.run_id, cz.run_id);
    assert.equal(other.k, 4);
    const pinned = clustersPayload(db, { expr: ids['carry the zero'], run: cz.run_id });
    assert.equal(pinned.run, cz.run_id);
    assert.equal(pinned.newer_run, other.run_id);
    assert.equal(pinned.newer_note, `A newer analysis exists (run #${other.run_id}).`);
    assert.equal(clustersPayload(db, { expr: ids['carry the zero'] }).run, other.run_id);
  });

  test('a human label renames a group; the machine label stays visible beside it', async (t) => {
    if (skip) { t.skip(skip); return; }
    const p0 = clustersPayload(db, { expr: ids['carry the zero'], run: cz.run_id });
    const target = p0.clusters.find((c) => c.first?.year >= 1990) ?? p0.clusters[0];
    const { createAnnotation } = await import('../server/provenance/annotations.mjs');
    createAnnotation(db, { target: { type: 'cluster', ref: String(target.id) }, kind: 'label', body_md: 'honoring the uncounted',
      author: 'Reader A (synthetic)' });
    const p = clustersPayload(db, { expr: ids['carry the zero'], run: cz.run_id });
    const c = p.clusters.find((x) => x.id === target.id);
    assert.equal(c.human_label, 'honoring the uncounted');
    assert.equal(c.label, target.label);
    assert.equal(c.machine_label, target.label);
    assert.ok(c.label.startsWith(MACHINE_LABEL_PREFIX));
    assert.match(c.card, /machine label kept: /);
    assert.equal(clustersPayload(db, { expr: ids['carry the zero'], run: cz.run_id, rev_cutoff: 1 }).clusters.find((x) => x.id === target.id).human_label,
      null, 'a saved view from before the rename shows no human label');
  });

  test('convergence obeys its gate: stored pairs are gated (no value) or carry J, CI and the reporting rule', (t) => {
    if (skip) { t.skip(skip); return; }
    const p = clustersPayload(db, { expr: ids['carry the zero'], run: cz.run_id });
    assert.ok(p.convergence.length >= 1);
    for (const c of p.convergence) {
      if (c.gate !== 'ok') { assert.equal(c.value, null); assert.equal(c.ci, null); continue; }
      assert.ok(Number.isFinite(c.value) && c.ci[0] <= c.ci[1]);
      assert.equal(c.reported, c.value >= 0.15 && c.ci[0] > 0);
      assert.match(c.text, /not meanings; not evidence of influence/);
    }
    const reported = db.prepare("SELECT count(*) AS n FROM cluster_transition WHERE run_id = ? AND kind = 'convergence'").get(cz.run_id).n;
    assert.equal(reported, p.convergence.filter((c) => c.reported).length);
    // Recorded calibration gap (§9.6): in the windows the spec names, 'ghost in the margin' has 17 counted occurrences in
    // 1990–2005, under the collocation gate of 20, so convergence there is gated — and has no value.
    const exprs = resolveExpressions(db, [ids['carry the zero'], ids['ghost in the margin']]);
    const wins = convergenceInputs(db, { exprs, windows: [{ lo: 1990, hi: 2005 }, { lo: 2010, hi: 2026 }], toggles: normalizeToggles({}) });
    assert.deepEqual(wins.map((w) => w.n), [[40, 17], [127, 22]]);
    const r = convergence(wins, { resamples: 100 });
    assert.equal(r.gate, 'insufficient_occurrences');
    assert.equal(r.value, null);
  });

  test('convergence inputs read from a token stream (counted on ids, runs read at once) equal those of tokenized text', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const { buildTokenStreams, streamStatus } = await import('../server/analysis/tokstream.mjs');
    const exprs = resolveExpressions(db, [ids['carry the zero'], ids['ghost in the margin']]);
    const windows = [{ lo: 1990, hi: 2005 }, { lo: 2010, hi: 2026 }];
    const toggles = normalizeToggles({});
    const none = mkdtempSync(path.join(tmpdir(), 'scrolls-nostream-'));
    const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-stream-'));
    try {
      const fromText = convergenceInputs(db, { exprs, windows, toggles, dir: none });
      buildTokenStreams(db, { langs: ['en'], dir });
      assert.equal(streamStatus(db, dir, 'en').fresh, true);
      const fromStream = convergenceInputs(db, { exprs, windows, toggles, dir });
      assert.ok(fromText.some((w) => w.docs?.length), 'a window with both expressions above the gate');
      assert.deepEqual(fromStream, fromText);
    } finally {
      rmSync(none, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pooled PPMI-SVD space of the language becomes the representation (by occvec\'s API), recorded on the run', async (t) => {
    if (skip) { t.skip(skip); return; }
    // an invented 16-dimensional space over the demo's context words (a test fixture, not a built space)
    const { commitSpaceFiles, writeSpaceFiles } = await import('../server/analysis/occvec.mjs');
    const { paths } = await import('../server/config.mjs');
    const { nowIso } = await import('../server/db/open.mjs');
    const words = [...new Set(db.prepare(`SELECT distinct_json FROM (SELECT distinctive_json AS distinct_json FROM sense_cluster)`).all()
      .flatMap((r) => JSON.parse(r.distinct_json).map((d) => d.term)))].sort();
    const dim = 16, rng = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296); })();
    const W = new Float32Array(words.length * dim);
    for (let i = 0; i < words.length; i++) {
      let n = 0;
      for (let j = 0; j < dim; j++) { W[i * dim + j] = rng() - 0.5; n += W[i * dim + j] ** 2; }
      for (let j = 0; j < dim; j++) W[i * dim + j] /= Math.sqrt(n);
    }
    const runId = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, representation, tokenizer_version, segmenter_version, icu_version, status, started_at, finished_at)
      VALUES ('vectors', 'test-fixture', 'x', '{}', 'x', '{}', 'x', 1, 'ppmi-svd-pooled', 'u61m-1', 'seg-1', 'x', 'succeeded', ?, ?)`)
      .run(nowIso(), nowIso()).lastInsertRowid);
    const spaceId = Number(db.prepare(`INSERT INTO vector_space (run_id, lang, lo_year, hi_year, pooled, collections_json, tokens, docs, authors,
      vocab_size, dim, rel_path) VALUES (?, 'en', NULL, NULL, 1, '["demo-world"]', 64000, 200, 40, ?, ?, 'pending')`).run(runId, words.length, dim).lastInsertRowid);
    writeSpaceFiles(paths().spaces, 'tmp-test', { W, rows: words.length, dim, vocab: words, counts: words.map(() => 100), df: words.map(() => 10),
      manifest: { lang: 'en', pooled: true, passages: 1000, synthetic: true, note: 'invented test space' } });
    commitSpaceFiles(paths().spaces, 'tmp-test', spaceId);
    const r = await runCluster(ctx, { expressionId: ids['flux up'], params: { representation: 'ppmi-svd-pooled', k: 'auto', seed: 3, with: [] } });
    const run = db.prepare('SELECT * FROM analysis_run WHERE id = ?').get(r.run_id);
    assert.equal(run.representation, 'ppmi-svd-pooled');
    assert.deepEqual(JSON.parse(run.upstream_run_ids), [db.prepare('SELECT run_id FROM expression_state WHERE expression_id = ?').get(ids['flux up']).run_id, runId]);
    assert.equal(JSON.parse(run.params_json).space, spaceId);
    const p = clustersPayload(db, { expr: ids['flux up'] });
    assert.equal(p.representation, 'ppmi-svd-pooled');
    assert.deepEqual(check('Clusters', p), []);
    // the TF-IDF request still gets TF-IDF; 'auto' now takes the space
    const auto = await runCluster(ctx, { expressionId: ids['flux up'], params: { k: 'auto', seed: 3, with: [] } });
    assert.equal(db.prepare('SELECT representation FROM analysis_run WHERE id = ?').get(auto.run_id).representation, 'ppmi-svd-pooled');
    assert.equal(db.prepare('SELECT representation FROM analysis_run WHERE id = ?').get(flux.run_id).representation, 'tfidf-hash-4096');
  });

  test('params are validated', () => {
    assert.throws(() => clusterParams({}), (e) => e.status === 400);
    assert.throws(() => clusterParams({ expressionId: 1, params: { k: 9 } }), (e) => e.status === 400);
    assert.throws(() => clusterParams({ expressionId: 1, params: { representation: 'word2vec' } }), (e) => e.status === 400);
    assert.deepEqual(clusterParams({ expressionId: 3, expr: 3, params: { k: 'auto', seed: 1994, with: [3, 5, 5] } }).with, [5]);
  });

  test('a cluster job in a worker cancels cleanly: run cancelled, no rows of it visible', async (t) => {
    if (skip) { t.skip(skip); return; }
    const q = createJobQueue(db, { bus, dbPath: tmp.dbPath, cancelGraceMs: 5000 });
    try {
      const id = q.enqueue('cluster', { expressionId: ids['carry the zero'], params: { ...DEMO_PARAMS, seed: 4242 } });
      const t0 = Date.now();
      while (q.get(id).status !== 'running' || !(q.get(id).run_id || q.get(id).progress > 0.1)) {
        if (Date.now() - t0 > 60000) break;
        if (['succeeded', 'failed'].includes(q.get(id).status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const asked = Date.now();
      q.cancel(id);
      const row = await q.waitFor(id, { timeoutMs: 15000 });
      if (row.status === 'succeeded') { t.diagnostic('the job finished before the cancel arrived'); return; }
      assert.equal(row.status, 'cancelled');
      t.diagnostic(`cancel acknowledged in ${Date.now() - asked} ms`);
      const runs = db.prepare("SELECT id, status FROM analysis_run WHERE stage = 'cluster' AND seed = 4242").all();
      for (const r of runs) {
        assert.notEqual(r.status, 'succeeded');
        assert.equal(db.prepare('SELECT count(*) AS n FROM sense_cluster WHERE run_id = ?').get(r.id).n, 0);
      }
    } finally {
      await q.close();
    }
  });
});
