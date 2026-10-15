// OWNER: WP4 — the three drift measures (SPEC §4.9, §11 row 7) on in-memory slice spaces: neighbour overlap
// with frequency-matched controls, aligned displacement with the anchor (2,999 / 3,000) and alignment gates,
// out-of-sample controls, the verdict rule (adjusted percentile AND overlap ≤ 0.2), context-share shift with
// its document-block bootstrap, and stored results read back with no value when gated.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, mulberry32 } from '../src/shared/ids.mjs';
import { contextShareShift, driftMeasures, driftRunParams, driftRunScope, frequencyControls, jsdCounts, measureSentence, sharedVocab,
  storedDriftResults, verdict } from '../server/analysis/drift.mjs';
import { gaussianMatrix, householderQr, matmul, normalizeRows } from '../server/analysis/linalg.mjs';
import { ANCHORS } from '../server/analysis/procrustes.mjs';
import { inputFingerprint } from '../server/jobs/context.mjs';
import { nowIso } from '../server/db/open.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

/**
 * Two slice spaces over the same words: B = A rotated, plus noise; `moved` words get a new vector in B.
 * Rows are ordered by frequency (the first 100 are the "stop-words").
 */
function pairOfSpaces({ n = 3300, dim = 16, near = 20, moved = [], count = () => 500, seed = 1, noise = 0.02 } = {}) {
  const words = Array.from({ length: n }, (_, i) => (i === 150 ? 'target' : `w${i}`));
  const a = normalizeRows(Float64Array.from(gaussianMatrix(n, dim, seed)), n, dim);
  // the target's `near` closest words sit right next to it in both spaces
  for (let k = 0; k < near; k++) {
    const r = 200 + k;
    for (let j = 0; j < dim; j++) a[r * dim + j] = a[150 * dim + j] + 0.01 * Math.sin(r + j);
  }
  normalizeRows(a, n, dim);
  const { q: rot } = householderQr(gaussianMatrix(dim, dim, seed + 1), dim, dim);
  const b = matmul(a, rot, n, dim, dim);
  const rng = mulberry32(seed + 2);
  for (let i = 0; i < b.length; i++) b[i] += (rng() - 0.5) * noise;
  for (const w of moved) b.set(gaussianMatrix(1, dim, 1000 + w), w * dim);
  normalizeRows(b, n, dim);
  const counts = Uint32Array.from(words, (_, i) => count(i));
  const mk = (W) => ({ W: Float32Array.from(W), dim, vocab: words, counts, index: new Map(words.map((w, i) => [w, i])), rows: n });
  return { sa: mk(a), sb: mk(b), words };
}

describe('aligned displacement and neighbour overlap on slice spaces', () => {
  test('a moved word is displaced far beyond its controls; an unmoved one lies inside the control distribution', () => {
    const { sa, sb } = pairOfSpaces({ moved: [150], count: (i) => (i < 100 ? 100000 - i : 500 + (i % 7)) });
    const moved = driftMeasures(sa, sb, 'target', { controls: 300 });
    assert.equal(moved.aligned_displacement.gate, 'ok', JSON.stringify(moved.aligned_displacement));
    assert.ok(moved.aligned_displacement.percentile >= 99, `percentile ${moved.aligned_displacement.percentile}`);
    assert.ok(moved.aligned_displacement.anchors >= ANCHORS.needed && moved.aligned_displacement.mean_anchor_cos > 0.9);
    assert.equal(moved.neighbor_overlap.gate, 'ok');
    assert.ok(moved.neighbor_overlap.jaccard <= 0.2, `jaccard ${moved.neighbor_overlap.jaccard}`);
    assert.equal(verdict(moved.aligned_displacement, moved.neighbor_overlap, 1), 'notable');

    const still = driftMeasures(sa, sb, 'w2500', { controls: 300 });
    assert.equal(still.aligned_displacement.gate, 'ok');
    assert.ok(still.aligned_displacement.percentile < 95, `an unchanged word sits at the ${still.aligned_displacement.percentile}th percentile`);
    assert.equal(verdict(still.aligned_displacement, still.neighbor_overlap, 1), 'within typical variation');
  });

  test('anchors: 2,999 → unaligned (no value); 3,000 → aligned', () => {
    // anchors need f ≥ 100 in both slices: exactly `eligible` words have it besides the target and its 20 nearest
    // neighbours (which are excluded from anchors); every other word has f = 99
    const run = (eligible) => {
      const { sa, sb } = pairOfSpaces({ count: (i) => (i === 150 || (i >= 200 && i < 220) || (i >= 300 && i < 300 + eligible)) ? 1000 : 99 });
      return driftMeasures(sa, sb, 'target', { controls: 60 }).aligned_displacement;
    };
    const below = run(2999);
    assert.equal(below.gate, 'unaligned');
    assert.equal(below.value, null);
    assert.equal(below.percentile, undefined);
    assert.deepEqual(below.needed, { anchors: 3000 });
    assert.deepEqual(below.have, { anchors: 2999 });
    const at = run(3000);
    assert.notEqual(at.gate, 'unaligned', JSON.stringify(at));
  });

  test('spaces that do not align (mean anchor cosine < 0.5) are refused as unaligned', () => {
    const { sa } = pairOfSpaces({ seed: 5 });
    const { sb } = pairOfSpaces({ seed: 9 }); // unrelated vectors for the same words
    const r = driftMeasures(sa, sb, 'target', { controls: 60 }).aligned_displacement;
    assert.equal(r.gate, 'unaligned');
    assert.ok(r.have.mean_anchor_cosine < 0.5);
    assert.equal(r.value, null);
  });

  test('frequency gates: (b) needs f ≥ 50 and (c) f ≥ 100 in both slice spaces (49 and 99 fail)', () => {
    const { sa, sb } = pairOfSpaces({ count: (i) => (i === 150 ? 49 : 500) });
    const r = driftMeasures(sa, sb, 'target', { controls: 60 });
    assert.equal(r.neighbor_overlap.gate, 'insufficient_occurrences');
    assert.equal(r.aligned_displacement.gate, 'insufficient_occurrences');
    const r2 = driftMeasures(...Object.values(pairOfSpaces({ count: (i) => (i === 150 ? 99 : 500) })).slice(0, 2), 'target', { controls: 60 });
    assert.equal(r2.neighbor_overlap.gate, 'ok');
    assert.equal(r2.aligned_displacement.gate, 'insufficient_occurrences');
    const missing = driftMeasures(sa, sb, 'absent', { controls: 60 });
    assert.equal(missing.neighbor_overlap.gate, 'insufficient_occurrences');
  });

  test('controls: same frequency decile in both slices, never the 100 most frequent words, never the target', () => {
    const { sa, sb } = pairOfSpaces({ count: (i) => 5000 - i });
    const shared = sharedVocab(sa, sb);
    const ti = shared.words.indexOf('target');
    const ctl = frequencyControls(sa, sb, shared, ti, { n: 500 });
    assert.ok(ctl.length > 50 && ctl.length <= 500);
    assert.ok(!ctl.includes(ti));
    const decile = (i) => Math.floor((10 * i) / shared.words.length);
    for (const c of ctl) {
      assert.ok(c >= 100, 'not among the 100 most frequent');
      assert.equal(decile(c), decile(ti));
    }
    assert.deepEqual(frequencyControls(sa, sb, shared, ti, { n: 500 }), ctl, 'seeded');
  });
});

describe('the verdict (§4.9) and the words', () => {
  const d = (percentile) => ({ gate: 'ok', percentile });
  const o = (jaccard) => ({ gate: 'ok', jaccard });
  test('notable only when the percentile reaches 100 − 5/k and the neighbour Jaccard is ≤ 0.2', () => {
    assert.equal(verdict(d(95), o(0.2), 1), 'notable');
    assert.equal(verdict(d(94.9), o(0.1), 1), 'within typical variation');
    assert.equal(verdict(d(97.4), o(0.1), 2), 'within typical variation', 'k = 2 → 97.5th');
    assert.equal(verdict(d(97.5), o(0.1), 2), 'notable');
    assert.equal(verdict(d(99), o(0.21), 1), 'within typical variation');
    assert.equal(verdict({ gate: 'unaligned' }, o(0.1), 1), null);
    assert.equal(verdict(d(99), { gate: 'not_run' }, 1), null);
  });

  test('sentences say "estimated shift in usage contexts" and never that meaning changed', () => {
    const s = [
      measureSentence('sense_share_jsd', { value: 0.21, ci: [0.14, 0.29] }, { n: [212, 388], docs: [31, 54] }),
      measureSentence('aligned_displacement', { value: 0.37, percentile: 97, controls: 500 }, { n: [212, 388], docs: [31, 54],
        overlap: { gate: 'ok', jaccard: 0.12 }, verdict: 'notable' }),
      measureSentence('neighbor_overlap', { value: 0.88, jaccard: 0.12, percentile: 64, controls: 500 }, { n: [1, 2], docs: [1, 2] }),
    ];
    assert.equal(s[0], 'Context-share shift JSD 0.21 [0.14, 0.29] · n = 212 / 388 · 31 / 54 documents — an estimated shift in usage contexts.');
    assert.equal(s[1], 'Aligned displacement 0.37 · 97th percentile of 500 frequency-matched controls · neighbour overlap 0.12 → notable · n = 212 / 388 · 31 / 54 documents — an estimated shift in usage contexts.');
    for (const x of s) assert.doesNotMatch(x, /meaning changed|thought|felt|intended|believed/);
  });
});

describe('context-share shift (a)', () => {
  test('JSD of context-group shares with a document-block bootstrap CI', () => {
    assert.equal(jsdCounts([5, 5], [5, 5]), 0);
    assert.equal(jsdCounts([10, 0], [0, 10]), 1);
    assert.equal(jsdCounts([0, 0], [1, 1]), null);
    const same = Array.from({ length: 20 }, (_, i) => [3 + (i % 2), 3 - (i % 2)]);
    const r0 = contextShareShift(same, same.map((x) => [...x]), 2);
    assert.ok(r0.value < 1e-9 && r0.ci[0] >= 0 && r0.ci[0] <= 0.01);
    const a = Array.from({ length: 20 }, () => [9, 1]), b = Array.from({ length: 20 }, () => [1, 9]);
    const r = contextShareShift(a, b, 2);
    assert.ok(r.value > 0.4);
    assert.ok(r.ci[0] <= r.value && r.value <= r.ci[1]);
    assert.equal(r.nA, 200);
    assert.deepEqual(contextShareShift(a, b, 2), r, 'seeded');
  });
});

describe('stored drift results', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: false }); });
  after(() => tmp.cleanup());

  test('a drift run of exactly this comparison on the current data is read back; gated rows carry no value', () => {
    const db = tmp.db;
    const req = { expr: [3], a: { years: [1850, 1874], f: '' }, b: { years: [1900, 1928], f: '' }, toggles: { tr: 0 }, corpus: null };
    const params = driftRunParams(req);
    const fp = driftRunScope(['mini'], [{ run: 1 }]);
    const hash = createHash('sha256').update(canonicalJson(params)).digest('hex');
    const run = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, upstream_run_ids, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES ('drift', 'drift@1.0.0', 'x', ?, ?, ?, ?, 0, '[1]', 'u61m-1', 'seg-1', 'x', 'succeeded', ?)`)
      .run(canonicalJson(params), hash, canonicalJson(fp.scope), inputFingerprint(db, fp), nowIso()).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO drift_result (run_id, expression_id, slice_a_json, slice_b_json, metric, value, null_percentile, gate,
      gate_detail_json) VALUES (?, 3, '{}', '{}', ?, ?, ?, ?, ?)`);
    ins.run(run, 'aligned_displacement', 0.37, 97.2, 'ok', JSON.stringify({ anchors: 4100, mean_anchor_cos: 0.61, controls: 500 }));
    ins.run(run, 'neighbor_overlap', null, null, 'slice_too_small', JSON.stringify({ needed: { controls: 50 }, have: { controls: 12 }, note: 'x' }));
    const got = storedDriftResults(db, params, fp);
    assert.equal(got.run, run);
    assert.equal(got.measures.aligned_displacement.value, 0.37);
    assert.equal(got.measures.aligned_displacement.percentile, 97.2);
    assert.equal(got.measures.aligned_displacement.anchors, 4100);
    assert.equal(got.measures.neighbor_overlap.gate, 'slice_too_small');
    assert.equal(got.measures.neighbor_overlap.value, null);
    assert.deepEqual(got.measures.neighbor_overlap.have, { controls: 12 });
    // another comparison, or the same one on other data, finds nothing
    assert.equal(storedDriftResults(db, driftRunParams({ ...req, b: { years: [1900, 1927], f: '' } }), fp), null);
    assert.equal(storedDriftResults(db, params, driftRunScope(['mini'], [{ run: 2 }])), null);
  });
});
