// OWNER: WP4 — context-group clustering, pure parts (SPEC §4.8): TF-IDF hash vectors, spherical k-means and
// the silhouette, ARI and document-subsample stability, the choice of k, machine labels, windows, shares,
// transitions and convergence. Every input here is invented for the test.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { collocates } from '../server/analysis/collocations.mjs';
import { aggregateWindow, convergence, jaccard, jointWindows, topCollocates } from '../server/analysis/convergence.mjs';
import { assignNearest, cosineGram, denseCos, meanDirection, pointCos, silhouetteFromGram, silhouetteSample, sphericalKMeans } from '../server/analysis/kmeans.mjs';
import { distinctiveTerms, logOddsDirichlet, machineLabels, machineLabelText, MACHINE_LABEL_PREFIX } from '../server/analysis/labels.mjs';
import { adjustedRandIndex, clusterStability, gaussianReference, maxK, referenceSilhouette, sampleDocuments, selectK, shuffledReference, STABILITY } from '../server/analysis/stability.mjs';
import { packPoints, subsetPacked } from '../server/analysis/kmeans.mjs';
import { contextWords, hashTerm, HASH_DIM, idfFromContexts, tfidfHashSparse, tfidfHashVector, tfidfHashVectors } from '../server/analysis/tfidf-hash.mjs';
import { assignWindows, buildWindows, decadeCells, detectTransitions, quantile, transitionText, windowShares } from '../server/analysis/transitions.mjs';

// ── invented contexts: three word pools, each spread over its own documents ──
const POOLS = [
  'column digit place tens units sum slate lesson children write add'.split(' '),
  'auditors forms memo triplicate ledger quota department file clerk budget report'.split(' '),
  'counted hold block verse mic names nobody crew beat floor room'.split(' '),
];
const NOISE = 'river window stone morning bread copper garden lamp harbour letter market winter'.split(' ');

function contexts({ perGroup = 40, docsPerGroup = 6, seed = 7, groups = POOLS } = {}) {
  const rng = mulberry32(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const out = [], gold = [], docs = [];
  groups.forEach((pool, g) => {
    for (let i = 0; i < perGroup; i++) {
      const words = [];
      for (let j = 0; j < 4; j++) words.push(pick(pool));
      for (let j = 0; j < 3; j++) words.push(pick(NOISE));
      out.push(words);
      gold.push(g);
      docs.push(g * 100 + (i % docsPerGroup));
    }
  });
  return { contexts: out, gold, docs };
}

describe('tfidf-hash', () => {
  test('context words: ±window clipped at the passage, without stop-words, the expression or letterless tokens', () => {
    const toks = 'the 1911 primer said carry the zero for the tens column ◉ and more'.split(' ');
    const stop = new Set(['the', 'and', 'for']);
    const exclude = new Set(['carry', 'the', 'zero']);
    assert.deepEqual(contextWords(toks, 4, 7, { window: 3, stop, exclude }), ['primer', 'said', 'tens']);
    assert.deepEqual(contextWords(toks, 4, 7, { window: 10, stop, exclude }), ['primer', 'said', 'tens', 'column', 'more']);
    assert.deepEqual(contextWords(toks, 0, 1, { window: 2, stop }), ['primer']);
  });

  test('hashing: FNV-1a-32 mod 4096 with a sign bit, deterministic', () => {
    for (const t of ['zero', 'शून्य', 'શૂન્ય', 'cero', '◉']) {
      const h = hashTerm(t);
      assert.ok(h.index >= 0 && h.index < HASH_DIM);
      assert.ok(h.sign === 1 || h.sign === -1);
      assert.deepEqual(hashTerm(t), h);
    }
  });

  test('IDF is smoothed ln((1+N)/(1+df)) + 1 and vectors are L2-normalized, sparse = dense', () => {
    const ctxs = [['a', 'b'], ['a', 'c'], ['a', 'b', 'b']];
    const idf = idfFromContexts(ctxs);
    assert.ok(Math.abs(idf.get('a') - (Math.log(4 / 4) + 1)) < 1e-12);
    assert.ok(Math.abs(idf.get('c') - (Math.log(4 / 2) + 1)) < 1e-12);
    const s = tfidfHashSparse(ctxs[2], idf);
    let n = 0;
    for (const v of s.val) n += v * v;
    assert.ok(Math.abs(n - 1) < 1e-6);
    assert.ok([...s.idx].every((x, i, arr) => i === 0 || arr[i - 1] < x));
    const d = tfidfHashVector(ctxs[2], idf);
    for (let i = 0; i < s.idx.length; i++) assert.ok(Math.abs(d[s.idx[i]] - s.val[i]) < 1e-7);
    assert.equal(tfidfHashSparse([], idf).idx.length, 0);
  });
});

describe('spherical k-means, silhouette, ARI, stability', () => {
  const data = contexts();
  const { vectors } = tfidfHashVectors(data.contexts);

  test('ARI: 1 for identical or relabelled partitions, 0.2424… for the textbook example', () => {
    assert.equal(adjustedRandIndex([0, 0, 1, 1], [1, 1, 0, 0]), 1);
    assert.ok(Math.abs(adjustedRandIndex([0, 0, 0, 1, 1, 1], [0, 0, 1, 1, 2, 2]) - 0.24242424242424) < 1e-9);
    assert.throws(() => adjustedRandIndex([0], [0, 1]), RangeError);
  });

  test('k-means++ recovers three separable groups, deterministically for a seed', () => {
    const a = sphericalKMeans(vectors, 3, { seed: 11 });
    const b = sphericalKMeans(vectors, 3, { seed: 11 });
    assert.deepEqual(Array.from(a.assign), Array.from(b.assign));
    assert.ok(adjustedRandIndex(data.gold, a.assign) > 0.95, `ARI ${adjustedRandIndex(data.gold, a.assign)}`);
    assert.equal(a.sizes.reduce((x, y) => x + y, 0), vectors.length);
    for (const c of a.centroids) assert.ok(Math.abs(denseCos(c, c) - 1) < 1e-9);
    assert.equal(sphericalKMeans(vectors, 1).sizes[0], vectors.length);
    assert.throws(() => sphericalKMeans(vectors, 0), RangeError);
    assert.throws(() => sphericalKMeans([], 1), RangeError);
  });

  test('nearest-centroid assignment gives the cosine and the margin over the runner-up', () => {
    const fit = sphericalKMeans(vectors, 3, { seed: 3 });
    const near = assignNearest(vectors, fit.centroids);
    for (let i = 0; i < vectors.length; i++) {
      const cs = fit.centroids.map((c) => pointCos({ ...vectors[i] }, c));
      const sorted = [...cs].sort((x, y) => y - x);
      assert.ok(Math.abs(near.cos[i] - sorted[0]) < 1e-9);
      assert.ok(Math.abs(near.margin[i] - (sorted[0] - sorted[1])) < 1e-9);
    }
  });

  test('cosine silhouette matches a hand-computed case; a singleton scores 0', () => {
    const pts = [Float32Array.of(1, 0), Float32Array.of(1, 0), Float32Array.of(0, 1), Float32Array.of(0, 1)];
    const gram = cosineGram(pts, silhouetteSample(4));
    assert.equal(silhouetteFromGram(gram, [0, 0, 1, 1], 2).mean, 1);
    const s = silhouetteFromGram(gram, [0, 0, 0, 1], 2);
    assert.equal(s.perPoint[3], 0);
    // point 2 sits with two orthogonal points (a = 1) while its twin is the singleton (b = 0) → −1
    assert.equal(s.perPoint[2], -1);
    assert.equal(silhouetteSample(5000, { max: 100, seed: 1 }).length, 100);
  });

  test('stability: separable groups are stable (Jaccard and ARI near 1); noise at k = 4 is not', () => {
    const fit = sphericalKMeans(vectors, 3, { seed: 5 });
    const st = clusterStability(vectors, data.docs, fit.assign, { k: 3, subsamples: 10, seed: 5 });
    assert.ok(st.meanAri > 0.9, `mean ARI ${st.meanAri}`);
    assert.ok([...st.perCluster].every((j) => j > 0.9));
    const rng = mulberry32(9);
    const noise = tfidfHashVectors(Array.from({ length: 120 }, () => Array.from({ length: 6 }, () => NOISE[Math.floor(rng() * NOISE.length)]))).vectors;
    const docs = noise.map((_, i) => i % 30);
    const nf = sphericalKMeans(noise, 4, { seed: 5 });
    const ns = clusterStability(noise, docs, nf.assign, { k: 4, subsamples: 10, seed: 5 });
    assert.ok(ns.meanAri < 0.6, `noise mean ARI ${ns.meanAri}`);
  });

  test('document subsamples keep whole documents (80% of them)', () => {
    const s = sampleDocuments([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8, mulberry32(1));
    assert.equal(s.size, 8);
    assert.equal(maxK(59), 2);
    assert.equal(maxK(1000), 8);
    assert.equal(maxK(10), 1);
  });

  test('choice of k: three separable groups → k = 3; pure noise → k = 1', async () => {
    const sel = await selectK(vectors, data.docs, { seed: 21, subsamples: 8 });
    assert.equal(sel.k, 3, JSON.stringify(sel.candidates.map((c) => [c.k, c.silhouette, c.meanAri])));
    assert.equal(sel.reason, 'chosen');
    assert.ok(adjustedRandIndex(data.gold, sel.best.fit.assign) > 0.95);
    const rng = mulberry32(4);
    const noise = tfidfHashVectors(Array.from({ length: 100 }, () => Array.from({ length: 5 }, () => NOISE[Math.floor(rng() * NOISE.length)]))).vectors;
    const ns = await selectK(noise, noise.map((_, i) => i % 25), { seed: 4, subsamples: 6 });
    assert.equal(ns.k, 1);
    assert.ok(['no_structure', 'no_stable_k'].includes(ns.reason));
    assert.equal((await selectK(vectors.slice(0, 30), data.docs.slice(0, 30))).reason, 'too_few');
  });
});

describe('choosing k fast, with the same answer (cluster@1.1.0)', () => {
  const { vectors } = tfidfHashVectors(contexts().contexts);
  /** The §4.8 rule evaluated exhaustively: every k fitted and measured, then the largest silhouette among stable k. */
  function exhaustive(vectors, docs, seed) {
    const P = packPoints(vectors);
    const smp = silhouetteSample(P.n, { seed });
    const gram = cosineGram(P, smp);
    const rows = [];
    for (let k = 2; k <= maxK(P.n); k++) {
      const fit = sphericalKMeans(P, k, { seed: seed + k });
      const sil = silhouetteFromGram(gram, Array.from(smp, (i) => fit.assign[i]), k).mean;
      const st = clusterStability(P, docs, fit.assign, { k, seed: seed * 31 + k, restarts: STABILITY.subsampleRestarts });
      rows.push({ k, sil, stable: st.meanAri >= STABILITY.minAri });
    }
    const stable = rows.filter((r) => r.stable);
    if (!stable.length) return 1;
    const best = stable.reduce((x, y) => (y.sil > x.sil + 1e-12 ? y : x));
    return best.sil < STABILITY.minSilhouette ? 1 : best.k;
  }

  function blobs({ groups, per, dim = 24, spread, seed }) {
    const rng = mulberry32(seed);
    const pts = [], docs = [];
    for (let g = 0; g < groups; g++) {
      for (let i = 0; i < per; i++) {
        const v = new Float32Array(dim);
        for (let j = 0; j < dim; j++) v[j] = (rng() - 0.5) * spread + (j % groups === g ? 1 : 0);
        const n = Math.hypot(...v);
        pts.push(v.map((x) => x / n));
        docs.push(g * 1000 + (i % 12));
      }
    }
    return { pts, docs };
  }

  test('stability is measured only where the rule needs it, and k is what the exhaustive rule gives', async () => {
    for (const [i, d] of [blobs({ groups: 3, per: 60, spread: 0.6, seed: 1 }), blobs({ groups: 2, per: 80, spread: 2.5, seed: 2 }),
      blobs({ groups: 4, per: 40, spread: 1.2, seed: 3 })].entries()) {
      const sel = await selectK(d.pts, d.docs, { seed: 11 + i });
      assert.equal(sel.k, exhaustive(d.pts, d.docs, 11 + i), `dataset ${i}`);
      const measured = sel.candidates.filter((c) => c.meanAri !== null);
      for (const c of sel.candidates) if (c.meanAri === null) assert.match(c.skipped, /^not needed/);
      if (sel.reason === 'chosen') assert.ok(measured.every((c) => c.silhouette >= sel.best.silhouette - 1e-12));
    }
  });

  test('fits in worker threads give exactly the single-thread clustering', async () => {
    const d = blobs({ groups: 3, per: 270, dim: 256, spread: 1.4, seed: 9 }); // 810 × 256 points: enough work for the pool
    const one = await selectK(d.pts, d.docs, { seed: 5, threads: 0 });
    const many = await selectK(d.pts, d.docs, { seed: 5, threads: 3 });
    assert.equal(one.threads, 0);
    assert.equal(many.threads, 3);
    const sig = (r) => JSON.stringify({ k: r.k, reason: r.reason, c: r.candidates.map((c) => [c.k, c.silhouette, c.meanAri, c.perClusterStability,
      Array.from(c.fit.assign)]) });
    assert.equal(sig(many), sig(one));
  });

  test('the no-groups reference: far below real groups, close to a structureless elongated cloud', () => {
    const real = blobs({ groups: 3, per: 80, spread: 0.6, seed: 4 });
    const fit = sphericalKMeans(real.pts, 3, { seed: 1 });
    const smp = silhouetteSample(real.pts.length);
    const observed = silhouetteFromGram(cosineGram(real.pts, smp), Array.from(smp, (i) => fit.assign[i]), 3).mean;
    const ref = referenceSilhouette(real.pts, 3, { seed: 1 });
    assert.match(ref.method, /^Gaussian with the data's mean and covariance/);
    assert.ok(observed > ref.silhouette + 0.2, `observed ${observed} vs reference ${ref.silhouette}`);
    // one long axis and no groups: k-means alone finds a silhouette far above 0.10, and so does the reference
    const rng = mulberry32(8);
    const flat = Array.from({ length: 300 }, () => {
      const v = Float32Array.from({ length: 16 }, (_, j) => (j === 0 ? 3 + (rng() - 0.5) * 6 : (rng() - 0.5) * 0.6) + (j === 1 ? 2 : 0));
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
    const ff = sphericalKMeans(flat, 2, { seed: 1 });
    const fs = silhouetteSample(flat.length);
    const fo = silhouetteFromGram(cosineGram(flat, fs), Array.from(fs, (i) => ff.assign[i]), 2).mean;
    const fr = gaussianReference(flat, 2, { seed: 1 });
    assert.ok(fo > 0.3, `elongation alone gives silhouette ${fo}`);
    assert.ok(fr.silhouette > 0.3 && fr.silhouette > fo - 0.2, `reference ${fr.silhouette} vs observed ${fo}`);
    // sparse (TF-IDF hash) vectors get the coordinate shuffle, which keeps them sparse
    const sp = referenceSilhouette(vectors, 3, { seed: 2 });
    assert.match(sp.method, /permuted independently/);
    assert.ok(sp.points > 0 && sp.silhouette < 0.9);
    assert.deepEqual(shuffledReference(vectors, 3, { seed: 2 }), sp);
    assert.throws(() => gaussianReference(vectors, 2), TypeError);
  });

  test('packed subsets equal the per-point subsets', () => {
    const P = packPoints(vectors);
    const sub = subsetPacked(P, [5, 1, 9]);
    const a = sphericalKMeans(sub, 2, { seed: 3 }), b = sphericalKMeans([vectors[5], vectors[1], vectors[9]], 2, { seed: 3 });
    assert.deepEqual(Array.from(a.assign), Array.from(b.assign));
  });
});

describe('machine labels', () => {
  test('weighted log-odds with an informative Dirichlet prior: in-group words score high, shared words low', () => {
    const inG = new Map([['digit', 30], ['place', 20], ['ones', 10]]);
    const rest = new Map([['ones', 12], ['hold', 25]]);
    const scored = logOddsDirichlet(inG, rest);
    assert.equal(scored[0].term, 'digit');
    assert.ok(scored.find((x) => x.term === 'ones').z < scored.find((x) => x.term === 'place').z);
    const d = distinctiveTerms(inG, rest);
    assert.ok(d.every((x) => x.z >= 1.96 && x.f_in >= 3));
    assert.deepEqual(machineLabels(inG, rest, { top: 2 }), ['digit', 'place']);
    assert.equal(machineLabelText(['digit', 'place']), `${MACHINE_LABEL_PREFIX}digit · place`);
    assert.match(machineLabelText([]), /no distinctive context words/);
    assert.equal(distinctiveTerms(new Map([['rare', 2]]), new Map()).length, 0);
  });
});

describe('windows, shares and transitions', () => {
  test('decades merge forward to n ≥ 30, never across an uncovered decade; a remainder joins its stretch', () => {
    const cells = [
      { lo: 1900, hi: 1909, n: 10, covered: true }, { lo: 1910, hi: 1919, n: 25, covered: true }, { lo: 1920, hi: 1929, n: 5, covered: true },
      { lo: 1930, hi: 1939, n: 0, covered: false }, { lo: 1940, hi: 1949, n: 31, covered: true }, { lo: 1950, hi: 1959, n: 12, covered: true },
      { lo: 1960, hi: 1969, n: 0, covered: false }, { lo: 1970, hi: 1979, n: 7, covered: true },
    ];
    const w = buildWindows(cells);
    assert.deepEqual(w.map((x) => [x.label, x.state, x.scheme]), [
      ['1900–1929', 'measured', 'merged_for_min_n'], ['1930–1939', 'uncovered', 'fixed'], ['1940–1959', 'measured', 'merged_for_min_n'],
      ['1960–1969', 'uncovered', 'fixed'], ['1970–1979', 'thin', 'fixed'],
    ]);
  });

  test('decade cells and fit-or-wash placement: an interval wider than its window is "date too coarse"', () => {
    const items = [{ y_lo: 1903, y_hi: 1903 }, { y_lo: 1905, y_hi: 1915 }, { y_lo: 1925, y_hi: 1925 }, { y_lo: null, y_hi: null }];
    const cells = decadeCells(items.filter((x) => x.y_lo !== null), (lo) => (lo === 1910 ? 0 : 1000));
    assert.deepEqual(cells.map((c) => [c.lo, c.n, c.covered]), [[1900, 1, true], [1910, 0, false], [1920, 1, true]]);
    const windows = [{ lo: 1900, hi: 1909 }, { lo: 1910, hi: 1919 }, { lo: 1920, hi: 1929 }];
    assert.deepEqual(Array.from(assignWindows(items, windows)), [0, -1, 2, -1]);
  });

  test('shares sum to 1 per window and each share lies inside its document-block bootstrap CI', () => {
    const items = [];
    for (let d = 0; d < 12; d++) for (let i = 0; i < 4; i++) items.push({ window: 0, cluster: d < 8 ? 0 : 1, doc: d });
    const s = windowShares(items, [{ state: 'measured' }], 2, { resamples: 400, seed: 3 });
    assert.equal(s.length, 1);
    assert.ok(Math.abs(s[0].clusters.reduce((x, c) => x + c.share, 0) - 1) < 1e-12);
    for (const c of s[0].clusters) assert.ok(c.ci[0] <= c.share && c.share <= c.ci[1], JSON.stringify(c));
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  });

  const unit = (...xs) => { const v = Float64Array.from(xs); const n = Math.hypot(...xs); return v.map((x) => x / n); };
  const sharesOf = (rows) => rows.map((r, w) => ({ window: w, n: 100, clusters: r.map((sh, c) => ({ cluster: c, n: Math.round(sh * 100), share: sh, ci: [sh, sh] })) }));

  test('emerge, split, vanish and unknown gap', () => {
    const windows = ['measured', 'measured', 'measured', 'uncovered', 'measured', 'measured'].map((state, i) => ({ state, label: `w${i}`, lo: 1900 + 10 * i, hi: 1909 + 10 * i }));
    // group 0 from the start, fades after w2; group 1 emerges at w1 near group 0 (split); group 2 emerges at w4 far from both
    const shares = sharesOf([[1, 0, 0], [0.7, 0.3, 0], [0.5, 0.5, 0], null, [0.01, 0.6, 0.39], [0.0, 0.5, 0.5]].map((r) => r ?? [0, 0, 0]))
      .filter((s) => windows[s.window].state === 'measured');
    const centroids = [unit(1, 0.2, 0), unit(1, 0.6, 0), unit(0, 0, 1)];
    const t = detectTransitions({ windows, shares, centroids, windowCentroids: [], firstYear: () => 1911 });
    const kinds = t.map((x) => `${x.kind}:${x.from}>${x.to}@${x.window}`);
    assert.ok(kinds.includes('split:0>1@1'), kinds.join(' '));
    assert.ok(kinds.includes('emerge:null>2@4'), kinds.join(' '));
    assert.ok(kinds.includes('unknown_gap:0>null@3'), kinds.join(' '));
    assert.ok(kinds.includes('unknown_gap:1>null@3'), kinds.join(' '));
    assert.ok(kinds.includes('vanish:0>null@4'), kinds.join(' '));
    assert.ok(!kinds.some((k) => k.startsWith('emerge:null>0')), 'present from the first window is not an emergence');
    const split = t.find((x) => x.kind === 'split');
    const text = transitionText({ ...split }, { window: 'w1', labelOf: (c) => ['a · b', 'c · d', 'e · f'][c], run: 7, k: 3, representation: 'tfidf-hash-4096' });
    assert.match(text, /^Context group 1 'c · d' emerges in w1 \(first observed 1911\)\. Nearest earlier group: 0 \(centroid cosine 0\.9\d\)\./);
    assert.match(text, /Computed: a split in usage contexts, not a claim about speakers\.$/);
  });

  test('merge: per-window centroids move from cosine < 0.5 to ≥ 0.7', () => {
    const windows = [0, 1, 2].map((i) => ({ state: 'measured', label: `w${i}`, lo: i, hi: i }));
    const shares = sharesOf([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
    const wc = [[{ vec: unit(1, 0), n: 9 }, { vec: unit(0, 1), n: 9 }], [{ vec: unit(1, 0.3), n: 9 }, { vec: unit(0.3, 1), n: 9 }],
      [{ vec: unit(1, 0.9), n: 9 }, { vec: unit(0.9, 1), n: 9 }]];
    const t = detectTransitions({ windows, shares, centroids: [unit(1, 0), unit(0, 1)], windowCentroids: wc });
    const m = t.find((x) => x.kind === 'merge');
    assert.ok(m && m.window === 2 && m.score >= 0.7 && m.detail.apart.window === 0, JSON.stringify(t));
  });
});

describe('convergence', () => {
  test('topCollocates ranks exactly as collocations.collocates() (same gates, logDice order, stop-words hidden)', () => {
    const rng = mulberry32(17);
    const terms = Array.from({ length: 80 }, (_, i) => `t${i}`);
    terms[3] = 'the';
    const fxy = new Float64Array(80), fy = new Float64Array(80);
    for (let i = 0; i < 80; i++) { fy[i] = 10 + Math.floor(rng() * 400); fxy[i] = Math.floor(rng() * Math.min(60, fy[i])); }
    const fx = 200, W = 2000, N = 60000;
    const ref = collocates({ fxy: new Map(terms.map((t, i) => [t, fxy[i]])), fy: new Map(terms.map((t, i) => [t, fy[i]])), fx, W, N, sumFyAlpha: 0,
      stop: new Set(['the']) }, { limit: 50 }).rows.map((r) => r.term);
    const stop = new Uint8Array(80); stop[3] = 1;
    const mine = topCollocates({ fxy, fy, fx, W, N }, { terms, stop, top: 50 }).map((t) => terms[t]);
    assert.deepEqual(mine, ref);
    assert.ok(!mine.includes('the'));
  });

  test('jaccard and joint windows (both expressions ≥ 20 per window, never across an uncovered decade)', () => {
    assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
    assert.equal(jaccard([], []), 0);
    const cells = [[10, 30], [15, 0], [0, 25], [40, 40], [5, 2]].map((n, i) => ({ lo: 1900 + 10 * i, hi: 1909 + 10 * i, n, covered: i !== 1 }));
    assert.deepEqual(jointWindows(cells).map((w) => w.label), ['1900–1909', '1920–1949']);
  });

  // invented window data: two expressions whose ±5 contexts share more words in the later window
  function windowData(shared, rng) {
    const T = 40;
    const terms = Array.from({ length: T }, (_, i) => `w${i}`);
    const docs = [];
    for (let d = 0; d < 30; d++) {
      const fy = new Map(), ex = [new Map(), new Map()];
      for (let t = 0; t < T; t++) fy.set(t, 30 + Math.floor(rng() * 10));
      const own = [[0, 1, 2, 3, 4, 5], [10, 11, 12, 13, 14, 15]];
      for (let e = 0; e < 2; e++) {
        for (const t of [...own[e], ...shared]) ex[e].set(t, (ex[e].get(t) ?? 0) + 2 + Math.floor(rng() * 2));
      }
      const sp = (m) => ({ idx: Int32Array.from([...m.keys()]), cnt: Float64Array.from([...m.values()]) });
      docs.push({ N: 3000, fy: sp(fy), ex: ex.map((m) => ({ fx: 10, W: 100, fxy: sp(m) })) });
    }
    return { terms, stop: new Uint8Array(T), docs };
  }

  test('a rise of J with a CI excluding 0 is reported; fewer than two gated windows is a gate with no value', () => {
    const rng = mulberry32(5);
    const w1 = { label: '1900–1949', lo: 1900, hi: 1949, n: [300, 300], ...windowData([], rng) };
    const w2 = { label: '1990–2026', lo: 1990, hi: 2026, n: [300, 300], ...windowData([20, 21, 22, 23, 24, 25], rng) };
    const agg = aggregateWindow(w2);
    assert.equal(agg.ex[0].fx, 300);
    const r = convergence([w1, w2], { resamples: 200, seed: 1 });
    assert.equal(r.gate, 'ok');
    assert.ok(r.value >= 0.15 && r.ci[0] > 0 && r.reported, JSON.stringify({ value: r.value, ci: r.ci }));
    const g = convergence([w1, { label: 'x', lo: 2000, hi: 2009, n: [300, 12] }], { resamples: 50 });
    assert.equal(g.gate, 'insufficient_occurrences');
    assert.equal(g.value, null);
    assert.equal(g.ci, null);
    assert.deepEqual(g.needed, { occurrences_per_window: 20, windows: 2 });
  });

  test('mean directions of sparse vectors', () => {
    const { vectors } = tfidfHashVectors([['a', 'b'], ['a', 'c']]);
    const m = meanDirection(vectors);
    assert.ok(Math.abs(denseCos(m, m) - 1) < 1e-9);
    assert.equal(meanDirection([]), null);
  });
});
