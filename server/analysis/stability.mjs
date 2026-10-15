// OWNER: WP4
// stability.mjs — how far a clustering survives resampling, and the choice of k (SPEC §4.8).
//
// Stability (Hennig 2007): 30 subsamples of 80% of the *documents* (an occurrence goes with its document);
// each subsample is re-clustered with the same k; a cluster's stability is the mean, over subsamples, of
// its best-match Jaccard with the subsample's clusters (< 0.5 → `unstable`, drawn dashed, "tentative").
// The agreement of a subsample's clustering with the full one restricted to the same points is the
// adjusted Rand index; a k whose mean ARI is < 0.6 is rejected. The full clustering takes the best of 10
// greedy k-means++ restarts; each subsample re-clustering the best of 3 (recorded on the run). Every fit has its
// own seed (subsample s draws its documents and its k-means++ starts from seeds derived from (seed, s)), so the
// fits can run in worker threads (kmeans-pool.mjs) and still give exactly what one thread gives.
// Choice of k: k ∈ {1 … min(8, ⌊n/20⌋)}; the largest mean cosine silhouette among stable k wins; a best
// silhouette below 0.10 (or no stable k ≥ 2) gives k = 1, "no separable context groups". Stability is the
// expensive part (30 re-clusterings per k), so it is measured in order of falling silhouette and only until the
// rule is decided: the first stable k in that order is the winner, and once the silhouettes left are below 0.10
// no k can pass. The choice is exactly the rule's; the k never measured say why.

import { mulberry32 } from '../../src/shared/ids.mjs';
import { cosineGram, packedRow, packPoints, silhouetteFromGram, silhouetteSample, sphericalKMeans, subsetPacked } from './kmeans.mjs';
import { createFitter } from './kmeans-pool.mjs';

/** §4.8 constants. */
export const STABILITY = Object.freeze({ subsamples: 30, share: 0.8, minAri: 0.6, unstableBelow: 0.5, kMax: 8, perK: 20,
  minSilhouette: 0.10, subsampleRestarts: 3 });

/**
 * Adjusted Rand index of two labellings of the same points (Hubert & Arabie 1985); 1 when both put every
 * point in one cluster.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function adjustedRandIndex(a, b) {
  const n = a.length;
  if (n !== b.length) throw new RangeError('adjustedRandIndex: labellings differ in length');
  if (n < 2) return 1;
  const cont = new Map(), ra = new Map(), rb = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${a[i]}|${b[i]}`;
    cont.set(key, (cont.get(key) ?? 0) + 1);
    ra.set(a[i], (ra.get(a[i]) ?? 0) + 1);
    rb.set(b[i], (rb.get(b[i]) ?? 0) + 1);
  }
  const c2 = (x) => (x * (x - 1)) / 2;
  let index = 0, sa = 0, sb = 0;
  for (const v of cont.values()) index += c2(v);
  for (const v of ra.values()) sa += c2(v);
  for (const v of rb.values()) sb += c2(v);
  const expected = (sa * sb) / c2(n);
  const max = (sa + sb) / 2;
  if (max === expected) return 1;
  return (index - expected) / (max - expected);
}

/**
 * Seeded subsample of documents: round(share × D) distinct document ids (at least 1).
 * @param {number[]} docs distinct document ids
 * @param {number} share
 * @param {() => number} rng
 * @returns {Set<number>}
 */
export function sampleDocuments(docs, share, rng) {
  const list = [...docs];
  const m = Math.max(1, Math.round(share * list.length));
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rng() * (list.length - i));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return new Set(list.slice(0, m));
}

/** Seeds of subsample s: one for its document draw, one for its k-means++ starts. */
const subsampleSeeds = (seed, s) => [(seed * 7919 + 2 * s + 1) >>> 0, (seed * 7919 + 2 * s + 2) >>> 0];

/**
 * The document subsamples of a stability measurement: the rows each one keeps and the seed of its fit.
 * @param {number} n points
 * @param {ArrayLike<number>} docIds document of each point
 * @param {{k: number, subsamples?: number, share?: number, seed?: number, restarts?: number, maxIter?: number}} opts
 * @returns {import('./kmeans-pool.mjs').FitTask[]} subsamples with fewer than k points are left out
 */
export function stabilityPlan(n, docIds, { k, subsamples = STABILITY.subsamples, share = STABILITY.share, seed = 42, restarts = 10, maxIter = 100 }) {
  const docs = [...new Set(Array.from(docIds))].sort((x, y) => x - y);
  const plan = [];
  for (let s = 0; s < subsamples; s++) {
    const [docSeed, fitSeed] = subsampleSeeds(seed, s);
    const keep = sampleDocuments(docs, share, mulberry32(docSeed));
    const rows = [];
    for (let i = 0; i < n; i++) if (keep.has(docIds[i])) rows.push(i);
    if (rows.length < k) continue;
    plan.push({ k, seed: fitSeed, restarts, maxIter, rows: Int32Array.from(rows) });
  }
  return plan;
}

/**
 * Score subsample fits against the full clustering: per cluster the mean best-match Jaccard, and the mean ARI.
 * @param {import('./kmeans-pool.mjs').FitTask[]} plan
 * @param {Array<{assign: Int32Array}>} fits one per plan entry
 * @param {ArrayLike<number>} assign full clustering
 * @param {number} kk
 * @returns {{perCluster: Float64Array, meanAri: number, aris: number[], subsamples: number}}
 */
export function stabilityScore(plan, fits, assign, kk) {
  const jac = new Float64Array(kk), jacN = new Int32Array(kk);
  const aris = [];
  plan.forEach((t, si) => {
    const sub = fits[si];
    const full = Array.from(t.rows, (i) => assign[i]);
    aris.push(adjustedRandIndex(full, sub.assign));
    const inter = Array.from({ length: kk }, () => new Int32Array(kk));
    const sizeFull = new Int32Array(kk), sizeSub = new Int32Array(kk);
    for (let x = 0; x < full.length; x++) { inter[full[x]][sub.assign[x]]++; sizeFull[full[x]]++; sizeSub[sub.assign[x]]++; }
    for (let c = 0; c < kk; c++) {
      if (!sizeFull[c]) continue;
      let best = 0;
      for (let d = 0; d < kk; d++) {
        const u = sizeFull[c] + sizeSub[d] - inter[c][d];
        if (u > 0) best = Math.max(best, inter[c][d] / u);
      }
      jac[c] += best;
      jacN[c]++;
    }
  });
  const perCluster = new Float64Array(kk);
  for (let c = 0; c < kk; c++) perCluster[c] = jacN[c] ? jac[c] / jacN[c] : 0;
  const meanAri = aris.length ? aris.reduce((x, y) => x + y, 0) / aris.length : 0;
  return { perCluster, meanAri, aris, subsamples: aris.length };
}

/**
 * Per-cluster stability (mean best-match Jaccard) and mean ARI against the full clustering, over document
 * subsamples (fitted in this thread).
 * @param {object[]|import('./kmeans.mjs').Packed} vectors unit points
 * @param {ArrayLike<number>} docIds document of each point
 * @param {ArrayLike<number>} assign full clustering
 * @param {{k?: number, subsamples?: number, share?: number, seed?: number, restarts?: number, maxIter?: number,
 *   checkpoint?: () => void, onSubsample?: (i: number) => void}} [opts]
 * @returns {{perCluster: Float64Array, meanAri: number, aris: number[], subsamples: number}}
 */
export function clusterStability(vectors, docIds, assign, { k = null, subsamples = STABILITY.subsamples, share = STABILITY.share,
  seed = 42, restarts = 10, maxIter = 100, checkpoint = null, onSubsample = null } = {}) {
  const P = packPoints(vectors);
  const kk = k ?? Math.max(...assign) + 1;
  const plan = stabilityPlan(P.n, docIds, { k: kk, subsamples, share, seed, restarts, maxIter });
  const fits = plan.map((t, i) => {
    checkpoint?.();
    onSubsample?.(i);
    return sphericalKMeans(subsetPacked(P, t.rows), kk, { restarts, maxIter, seed: t.seed, checkpoint });
  });
  return stabilityScore(plan, fits, assign, kk);
}

/**
 * Largest k considered: min(8, ⌊n / 20⌋) (at least 1).
 * @param {number} n
 * @returns {number}
 */
export function maxK(n) {
  return Math.max(1, Math.min(STABILITY.kMax, Math.floor(n / STABILITY.perK)));
}

/**
 * Choose k (§4.8): cluster at every k ∈ {2 … maxK(n)} and measure the mean cosine silhouette; the stable k
 * (mean ARI ≥ 0.6) with the largest silhouette wins unless that silhouette is < 0.10, which gives k = 1.
 * Stability is measured in order of falling silhouette until the rule is decided (see the file comment), so a
 * candidate that was never needed has `meanAri: null` and a `skipped` reason. A fixed k skips the choice but
 * is still measured. With `threads` ≥ 2 the fits run in worker threads, with identical results.
 * @param {object[]|import('./kmeans.mjs').Packed} vectors unit points
 * @param {ArrayLike<number>} docIds
 * @param {{k?: number|'auto', seed?: number, restarts?: number, maxIter?: number, subsamples?: number, subsampleRestarts?: number,
 *   threads?: number, signal?: AbortSignal|null, checkpoint?: () => void, onProgress?: (fraction: number, message: string) => void}} [opts]
 * @returns {Promise<{k: number, reason: 'chosen'|'fixed'|'no_structure'|'no_stable_k'|'too_few', best: object|null,
 *   candidates: Array<{k: number, silhouette: number, meanAri: number|null, stable: boolean|null, perClusterStability: number[]|null,
 *   perClusterSilhouette: number[], subsamples: number, skipped: string|null, fit: object}>, threads: number}>}
 */
export async function selectK(vectors, docIds, { k = 'auto', seed = 42, restarts = 10, maxIter = 100, subsamples = STABILITY.subsamples,
  subsampleRestarts = STABILITY.subsampleRestarts, threads = 0, signal = null, checkpoint = null, onProgress = null } = {}) {
  const P = packPoints(vectors);
  const n = P.n;
  const ks = [];
  if (Number.isInteger(k)) { if (k >= 2 && k <= n) ks.push(k); } else for (let j = 2; j <= maxK(n); j++) ks.push(j);
  if (!ks.length) return { k: 1, reason: Number.isInteger(k) ? 'fixed' : 'too_few', best: null, candidates: [], threads: 0 };
  const fitter = createFitter(P, { threads, signal, checkpoint });
  try {
    const sample = silhouetteSample(n, { seed });
    const gram = cosineGram(P, sample, { checkpoint });
    // Progress: the full fits are the first fifth; each stability measurement one more share of the rest.
    let done = 0;
    const fits = await fitter.fit(ks.map((kk) => ({ k: kk, seed: seed + kk, restarts, maxIter })),
      () => onProgress?.(0.2 * ++done / ks.length, 'clustering at every k'));
    const candidates = ks.map((kk, i) => {
      const sil = silhouetteFromGram(gram, Array.from(sample, (x) => fits[i].assign[x]), kk);
      return { k: kk, silhouette: sil.mean, meanAri: null, stable: null, perClusterStability: null,
        perClusterSilhouette: Array.from(sil.perCluster), subsamples: 0, skipped: null, fit: fits[i] };
    });
    let measured = 0;
    const measure = async (c) => {
      const plan = stabilityPlan(n, docIds, { k: c.k, subsamples, seed: seed * 31 + c.k, restarts: subsampleRestarts, maxIter });
      let s = 0;
      const subFits = await fitter.fit(plan, () => onProgress?.(Math.min(0.99, 0.2 + 0.8 * (measured + ++s / (plan.length + 1)) / Math.min(ks.length, 3)),
        `k = ${c.k}: subsample ${s}/${plan.length}`));
      measured++;
      const stab = stabilityScore(plan, subFits, c.fit.assign, c.k);
      Object.assign(c, { meanAri: stab.meanAri, stable: stab.meanAri >= STABILITY.minAri, perClusterStability: Array.from(stab.perCluster),
        subsamples: stab.subsamples });
    };
    if (Number.isInteger(k)) {
      await measure(candidates[0]);
      return { k, reason: 'fixed', best: candidates[0], candidates, threads: fitter.threads };
    }
    const order = [...candidates].sort((x, y) => y.silhouette - x.silhouette || x.k - y.k);
    let best = null;
    for (const c of order) {
      if (best) { c.skipped = `not needed: k = ${best.k} has a larger silhouette and is stable`; continue; }
      if (c.silhouette < STABILITY.minSilhouette) { c.skipped = `not needed: silhouette below ${STABILITY.minSilhouette}`; continue; }
      await measure(c);
      if (c.stable) best = c;
    }
    if (best) return { k: best.k, reason: 'chosen', best, candidates, threads: fitter.threads };
    // No stable k reached the silhouette gate. When at least one k was measured and found unstable, say so.
    const anyMeasured = candidates.some((c) => c.meanAri !== null);
    return { k: 1, reason: anyMeasured ? 'no_stable_k' : 'no_structure', best: null, candidates, threads: fitter.threads };
  } finally {
    await fitter.close();
  }
}

/** Points a reference clustering is computed on (a seeded sample above this). */
export const REFERENCE_MAX_POINTS = 2000;
/** Data points whose spread the Gaussian reference copies (a seeded sample above this). */
export const REFERENCE_BASIS = 1000;

/**
 * The silhouette a clustering at k must beat (the clustering gate's reference): for dense vectors the Gaussian
 * with the same mean and covariance (gaussianReference), for sparse ones the coordinate shuffle
 * (shuffledReference), which keeps them sparse and cheap.
 * @param {object[]|import('./kmeans.mjs').Packed} vectors
 * @param {number} k
 * @param {{seed?: number, checkpoint?: () => void}} [opts]
 * @returns {{k: number, silhouette: number, points: number, method: string}}
 */
export function referenceSilhouette(vectors, k, opts = {}) {
  const P = packPoints(vectors);
  return P.data ? gaussianReference(P, k, opts) : shuffledReference(P, k, opts);
}

/**
 * The silhouette k-means reaches at k on points drawn from a Gaussian with the data's mean and covariance (then put
 * on the unit sphere like the data): the same spread and the same elongation, but one lump and no groups. Each
 * reference point is μ + Σᵢ gᵢ (xᵢ − μ) / √m over m sampled data points with gᵢ ~ N(0, 1), whose covariance is the
 * sample's. A clustering that does not beat it shows nothing beyond the cloud's shape.
 * @param {object[]|import('./kmeans.mjs').Packed} vectors dense unit points
 * @param {number} k ≥ 2
 * @param {{seed?: number, restarts?: number, max?: number, basis?: number, checkpoint?: () => void}} [opts]
 * @returns {{k: number, silhouette: number, points: number, method: string}}
 */
export function gaussianReference(vectors, k, { seed = 42, restarts = 3, max = REFERENCE_MAX_POINTS, basis = REFERENCE_BASIS, checkpoint = null } = {}) {
  const P = packPoints(vectors);
  if (!P.data) throw new TypeError('gaussianReference: dense points only');
  const n = P.n, dim = P.dim, X = P.data;
  const method = `Gaussian with the data's mean and covariance (from ${Math.min(n, basis)} points), put on the unit sphere; best of ${restarts} k-means++ runs`;
  const mu = new Float64Array(dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) mu[j] += X[i * dim + j];
  for (let j = 0; j < dim; j++) mu[j] /= n;
  const rows = silhouetteSample(n, { max: basis, seed: seed + 3 });
  const m = rows.length, mOut = Math.min(n, max);
  const C = new Float64Array(m * dim);
  rows.forEach((r, t) => { for (let j = 0; j < dim; j++) C[t * dim + j] = X[r * dim + j] - mu[j]; });
  const rng = mulberry32(seed + 19);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const out = new Float32Array(mOut * dim);
  const y = new Float64Array(dim);
  const scale = 1 / Math.sqrt(m);
  for (let t = 0; t < mOut; t++) {
    if (checkpoint && t % 100 === 0) checkpoint();
    y.set(mu);
    for (let b = 0; b < m; b++) {
      const g = gauss() * scale, off = b * dim;
      for (let j = 0; j < dim; j++) y[j] += g * C[off + j];
    }
    let s2 = 0;
    for (let j = 0; j < dim; j++) s2 += y[j] * y[j];
    const inv = s2 > 0 ? 1 / Math.sqrt(s2) : 0;
    for (let j = 0; j < dim; j++) out[t * dim + j] = y[j] * inv;
  }
  const R = { packed: true, n: mOut, dim, data: out, indptr: null, indices: null, values: null };
  if (mOut < 2 * k) return { k, silhouette: 0, points: mOut, method };
  const fit = sphericalKMeans(R, k, { restarts, seed: seed + 17 * k, checkpoint });
  const all = Int32Array.from({ length: mOut }, (_, i) => i);
  return { k, silhouette: silhouetteFromGram(cosineGram(R, all, { checkpoint }), fit.assign, k).mean, points: mOut, method };
}

/**
 * The silhouette the same vectors reach at k once their joint structure is destroyed: every coordinate is
 * permuted independently across the points (each coordinate keeps its distribution), rows are re-normalized and
 * clustered (best of 3 k-means++ runs). Used for sparse vectors, where it stays sparse; it also removes the
 * correlations between coordinates, so it is a floor rather than a match for the cloud's shape.
 * @param {object[]|import('./kmeans.mjs').Packed} vectors unit points (dense or sparse)
 * @param {number} k ≥ 2
 * @param {{seed?: number, restarts?: number, max?: number, checkpoint?: () => void}} [opts]
 * @returns {{k: number, silhouette: number, points: number, method: string}}
 */
export function shuffledReference(vectors, k, { seed = 42, restarts = 3, max = REFERENCE_MAX_POINTS, checkpoint = null } = {}) {
  const P = packPoints(vectors);
  const rows = silhouetteSample(P.n, { max, seed: seed + 7 });
  const m = rows.length, dim = P.dim;
  const rng = mulberry32(seed + 13);
  const perm = Int32Array.from({ length: m }, (_, i) => i);
  const shuffle = () => {
    for (let i = m - 1; i > 0; i--) { const r = Math.floor(rng() * (i + 1)); const t = perm[i]; perm[i] = perm[r]; perm[r] = t; }
  };
  let Q;
  if (P.data) {
    const out = new Float32Array(m * dim);
    for (let j = 0; j < dim; j++) {
      if (checkpoint && j % 64 === 0) checkpoint();
      shuffle();
      for (let i = 0; i < m; i++) out[i * dim + j] = P.data[rows[perm[i]] * dim + j];
    }
    Q = { packed: true, n: m, dim, data: out, indptr: null, indices: null, values: null };
  } else {
    // A sparse column keeps its non-zeros; only the rows they sit in are permuted, so the result stays sparse.
    const cols = Array.from({ length: dim }, () => []);
    rows.forEach((r, t) => {
      const p = packedRow(P, r);
      for (let i = 0; i < p.idx.length; i++) cols[p.idx[i]].push(t, p.val[i]);
    });
    const byRow = Array.from({ length: m }, () => []);
    for (let j = 0; j < dim; j++) {
      if (checkpoint && j % 512 === 0) checkpoint();
      if (!cols[j].length) continue;
      shuffle();
      for (let e = 0; e < cols[j].length; e += 2) byRow[perm[cols[j][e]]].push(j, cols[j][e + 1]);
    }
    const pts = byRow.map((list) => {
      const order = [];
      for (let e = 0; e < list.length; e += 2) order.push(e);
      order.sort((a, b) => list[a] - list[b]);
      return { idx: Int32Array.from(order, (e) => list[e]), val: Float32Array.from(order, (e) => list[e + 1]), dim };
    });
    Q = packPoints(pts);
  }
  const keep = [];
  for (let i = 0; i < m; i++) {
    const p = packedRow(Q, i);
    const v = p.idx ? p.val : p;
    let s2 = 0;
    for (let j = 0; j < v.length; j++) s2 += v[j] * v[j];
    if (!(s2 > 0)) continue;
    const inv = 1 / Math.sqrt(s2);
    for (let j = 0; j < v.length; j++) v[j] *= inv;
    keep.push(i);
  }
  const R = subsetPacked(Q, keep);
  const method = 'every coordinate permuted independently across the points, rows re-normalized, best of 3 k-means++ runs';
  if (R.n < 2 * k) return { k, silhouette: 0, points: R.n, method };
  const fit = sphericalKMeans(R, k, { restarts, seed: seed + 17 * k, checkpoint });
  const all = Int32Array.from({ length: R.n }, (_, i) => i);
  const sil = silhouetteFromGram(cosineGram(R, all, { checkpoint }), fit.assign, k);
  return { k, silhouette: sil.mean, points: R.n, method };
}
