// OWNER: WP4
// kmeans.mjs — spherical k-means (cosine) with greedy k-means++ initialisation, 10 restarts and ≤ 100 iterations, the
// cosine silhouette, and nearest-centroid assignment with margins (SPEC §4.8).
//
// A point is either dense (Float32Array/Float64Array, e.g. a PPMI-SVD occurrence vector) or sparse
// ({idx: Int32Array ascending, val: Float32Array, dim}, a TF-IDF hash vector); points are L2-normalized.
// Centroids are dense unit vectors (Float64Array). Everything is deterministic for a given seed
// (mulberry32); ties go to the lower cluster index.
//
// The hot loops run on *packed* points (packPoints): one contiguous Float32Array (n × dim) for dense points, or
// CSR arrays for sparse ones, with the centroids in one Float64Array (k × dim). The arithmetic and the order of
// every random draw are the same as point-by-point code, so a seed gives the same clustering either way.

import { mulberry32 } from '../../src/shared/ids.mjs';

/** Silhouettes are exact up to this many points and computed on a seeded sample above it. */
export const SILHOUETTE_MAX_POINTS = 2000;

/** @param {object} p a point @returns {number} */
export function dimOf(p) {
  return p.idx ? p.dim : p.length;
}

/**
 * Dot product of a point with a dense vector.
 * @param {object} p point
 * @param {Float64Array|Float32Array} c dense
 * @returns {number}
 */
export function dotDense(p, c) {
  let s = 0;
  if (p.idx) {
    const { idx, val } = p;
    for (let i = 0; i < idx.length; i++) s += val[i] * c[idx[i]];
  } else {
    for (let i = 0; i < p.length; i++) s += p[i] * c[i];
  }
  return s;
}

/**
 * Cosine of two unit points (their dot product), any mix of sparse and dense.
 * @param {object} p
 * @param {object} q
 * @returns {number}
 */
export function pointCos(p, q) {
  if (p.idx && q.idx) {
    let s = 0, i = 0, j = 0;
    const a = p.idx, b = q.idx;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { s += p.val[i] * q.val[j]; i++; j++; } else if (a[i] < b[j]) i++; else j++;
    }
    return s;
  }
  if (p.idx) return dotDense(p, q);
  return dotDense(q, p);
}

/** Add w·p into a dense accumulator. */
function addInto(acc, p, w = 1) {
  if (p.idx) {
    for (let i = 0; i < p.idx.length; i++) acc[p.idx[i]] += w * p.val[i];
  } else {
    for (let i = 0; i < p.length; i++) acc[i] += w * p[i];
  }
}

/** Normalize in place; returns false for a zero vector. */
function normalizeInPlace(v, off = 0, len = v.length - off) {
  let n = 0;
  for (let i = off; i < off + len; i++) n += v[i] * v[i];
  if (!(n > 0)) return false;
  n = Math.sqrt(n);
  for (let i = off; i < off + len; i++) v[i] /= n;
  return true;
}

/**
 * Dense unit copy of a point.
 * @param {object} p
 * @param {number} [dim]
 * @returns {Float64Array}
 */
export function densify(p, dim = dimOf(p)) {
  const out = new Float64Array(dim);
  addInto(out, p);
  normalizeInPlace(out);
  return out;
}

/**
 * Unit mean direction of a set of points (a centroid), or null when they cancel out or the set is empty.
 * @param {object[]} points
 * @param {number} [dim]
 * @returns {Float64Array|null}
 */
export function meanDirection(points, dim = points.length ? dimOf(points[0]) : 0) {
  if (!points.length) return null;
  const acc = new Float64Array(dim);
  for (const p of points) addInto(acc, p);
  return normalizeInPlace(acc) ? acc : null;
}

/** Cosine of two dense vectors (unit or not; 0 when either is zero). */
export function denseCos(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? s / Math.sqrt(na * nb) : 0;
}

// ── Packed points ────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{packed: true, n: number, dim: number, data: Float32Array|null, indptr: Int32Array|null,
 *   indices: Int32Array|null, values: Float32Array|null}} Packed
 *   dense: `data` holds row i at [i·dim, (i+1)·dim); sparse: CSR (`indptr`, `indices` ascending per row, `values`)
 */

/**
 * Pack points into contiguous typed arrays (a packed input is returned as is).
 * @param {object[]|Packed} points unit points, all dense or all sparse
 * @returns {Packed}
 */
export function packPoints(points) {
  if (points?.packed) return points;
  const n = points.length;
  if (!n) return { packed: true, n: 0, dim: 0, data: new Float32Array(0), indptr: null, indices: null, values: null };
  const dim = dimOf(points[0]);
  if (!points[0].idx) {
    const data = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) data.set(points[i], i * dim);
    return { packed: true, n, dim, data, indptr: null, indices: null, values: null };
  }
  let nnz = 0;
  for (const p of points) nnz += p.idx.length;
  const indptr = new Int32Array(n + 1), indices = new Int32Array(nnz), values = new Float32Array(nnz);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    indices.set(p.idx, at);
    values.set(p.val, at);
    at += p.idx.length;
    indptr[i + 1] = at;
  }
  return { packed: true, n, dim, data: null, indptr, indices, values };
}

/**
 * The packed rows `rows` of a packed set (a copy).
 * @param {Packed} P
 * @param {ArrayLike<number>} rows
 * @returns {Packed}
 */
export function subsetPacked(P, rows) {
  const m = rows.length, dim = P.dim;
  if (P.data) {
    const data = new Float32Array(m * dim);
    for (let t = 0; t < m; t++) data.set(P.data.subarray(rows[t] * dim, (rows[t] + 1) * dim), t * dim);
    return { packed: true, n: m, dim, data, indptr: null, indices: null, values: null };
  }
  let nnz = 0;
  for (let t = 0; t < m; t++) nnz += P.indptr[rows[t] + 1] - P.indptr[rows[t]];
  const indptr = new Int32Array(m + 1), indices = new Int32Array(nnz), values = new Float32Array(nnz);
  let at = 0;
  for (let t = 0; t < m; t++) {
    const a = P.indptr[rows[t]], b = P.indptr[rows[t] + 1];
    indices.set(P.indices.subarray(a, b), at);
    values.set(P.values.subarray(a, b), at);
    at += b - a;
    indptr[t + 1] = at;
  }
  return { packed: true, n: m, dim, data: null, indptr, indices, values };
}

/** Dot of packed row i with the dense vector held in `c` at offset `off`. */
function rowDot(P, i, c, off) {
  let s = 0;
  if (P.data) {
    const d = P.data, base = i * P.dim, end = base + P.dim;
    for (let j = base, q = off; j < end; j++, q++) s += d[j] * c[q];
  } else {
    const ix = P.indices, vx = P.values;
    for (let t = P.indptr[i], e = P.indptr[i + 1]; t < e; t++) s += vx[t] * c[off + ix[t]];
  }
  return s;
}

/** Add packed row i into `acc` at offset `off`. */
function rowAdd(P, i, acc, off) {
  if (P.data) {
    const d = P.data, base = i * P.dim;
    for (let j = 0; j < P.dim; j++) acc[off + j] += d[base + j];
  } else {
    const ix = P.indices, vx = P.values;
    for (let t = P.indptr[i], e = P.indptr[i + 1]; t < e; t++) acc[off + ix[t]] += vx[t];
  }
}

/** Unit dense copy of packed row i into `out` at offset `off` (zeros first). */
function rowDensify(P, i, out, off) {
  out.fill(0, off, off + P.dim);
  rowAdd(P, i, out, off);
  normalizeInPlace(out, off, P.dim);
}

/**
 * The point at row i of a packed set, in the per-point form (a view for dense points).
 * @param {Packed} P
 * @param {number} i
 * @returns {object}
 */
export function packedRow(P, i) {
  if (P.data) return P.data.subarray(i * P.dim, (i + 1) * P.dim);
  const a = P.indptr[i], b = P.indptr[i + 1];
  return { idx: P.indices.subarray(a, b), val: P.values.subarray(a, b), dim: P.dim };
}

// Greedy k-means++ (Arthur & Vassilvitskii 2007; the greedy variant scikit-learn uses) with cosine distance
// 1 − cos: each new centre is the best of 2 + ⌊ln k⌋ D²-sampled candidates by the potential it leaves.
function initCenters(P, k, rng) {
  const n = P.n, dim = P.dim;
  const trials = 2 + Math.floor(Math.log(k));
  const C = new Float64Array(k * dim);
  rowDensify(P, Math.floor(rng() * n), C, 0);
  let d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) { const d = Math.max(0, 1 - rowDot(P, i, C, 0)); d2[i] = d * d; }
  const drawIndex = (total) => {
    if (!(total > 0)) return Math.floor(rng() * n);
    let r = rng() * total;
    for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) return i; }
    return n - 1;
  };
  const cand = new Float64Array(dim);
  let next = new Float64Array(n), keep = new Float64Array(n), keepC = new Float64Array(dim);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += d2[i];
    let bestPot = Infinity;
    for (let t = 0; t < trials; t++) {
      rowDensify(P, drawIndex(total), cand, 0);
      let pot = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.max(0, 1 - rowDot(P, i, cand, 0));
        next[i] = Math.min(d2[i], d * d);
        pot += next[i];
      }
      if (t === 0 || pot < bestPot) {
        bestPot = pot;
        [keep, next] = [next, keep];
        keepC.set(cand);
      }
    }
    C.set(keepC, c * dim);
    [d2, keep] = [keep, d2];
  }
  return C;
}

function lloyd(P, C, k, { maxIter, checkpoint }) {
  const n = P.n, dim = P.dim;
  const assign = new Int32Array(n).fill(-1);
  const best = new Float64Array(n);
  const sums = new Float64Array(k * dim);
  const counts = new Int32Array(k);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    if (checkpoint && iter % 5 === 0) checkpoint();
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bj = 0, bc = -Infinity;
      for (let j = 0; j < k; j++) {
        const c = rowDot(P, i, C, j * dim);
        if (c > bc) { bc = c; bj = j; }
      }
      best[i] = bc;
      if (assign[i] !== bj) { assign[i] = bj; changed++; }
    }
    if (iter > 0 && changed === 0) break;
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) { rowAdd(P, i, sums, assign[i] * dim); counts[assign[i]]++; }
    for (let j = 0; j < k; j++) {
      if (counts[j] === 0 || !normalizeInPlace(sums, j * dim, dim)) {
        // an empty (or cancelled-out) cluster takes the point that fits its own centroid worst
        let worst = -1, wc = Infinity;
        for (let i = 0; i < n; i++) if (counts[assign[i]] > 1 && best[i] < wc) { wc = best[i]; worst = i; }
        if (worst < 0) { sums.set(C.subarray(j * dim, (j + 1) * dim), j * dim); continue; }
        counts[assign[worst]]--;
        assign[worst] = j;
        counts[j] = 1;
        best[worst] = 1;
        rowDensify(P, worst, sums, j * dim);
      }
    }
    C.set(sums);
  }
  let objective = 0;
  for (let i = 0; i < n; i++) objective += rowDot(P, i, C, assign[i] * dim);
  return { assign, C, objective, iterations: iter + 1 };
}

/**
 * Spherical k-means: the best of `restarts` k-means++ runs by total cosine to the assigned centroid.
 * @param {object[]|Packed} vectors unit points (sparse or dense), or packPoints() of them
 * @param {number} k 1 ≤ k ≤ vectors.length
 * @param {{restarts?: number, maxIter?: number, seed?: number, rng?: () => number, checkpoint?: () => void}} [opts]
 * @returns {{assign: Int32Array, centroids: Float64Array[], objective: number, iterations: number, sizes: Int32Array}}
 */
export function sphericalKMeans(vectors, k, { restarts = 10, maxIter = 100, seed = 42, rng = null, checkpoint = null } = {}) {
  const P = packPoints(vectors);
  const n = P.n;
  if (!(n > 0)) throw new RangeError('sphericalKMeans: no points');
  if (!(Number.isInteger(k) && k >= 1 && k <= n)) throw new RangeError(`sphericalKMeans: k = ${k} with ${n} points`);
  const random = rng ?? mulberry32(seed);
  let best = null;
  for (let r = 0; r < (k === 1 ? 1 : restarts); r++) {
    checkpoint?.();
    const res = lloyd(P, initCenters(P, k, random), k, { maxIter, checkpoint });
    if (!best || res.objective > best.objective + 1e-12) best = res;
  }
  const sizes = new Int32Array(k);
  for (const a of best.assign) sizes[a]++;
  const centroids = Array.from({ length: k }, (_, j) => best.C.slice(j * P.dim, (j + 1) * P.dim));
  return { assign: best.assign, centroids, objective: best.objective, iterations: best.iterations, sizes };
}

/**
 * Assign points to their nearest centroid, with the cosine to it and the margin over the runner-up.
 * @param {object[]|Packed} vectors
 * @param {Float64Array[]} centroids
 * @returns {{assign: Int32Array, cos: Float64Array, margin: Float64Array}}
 */
export function assignNearest(vectors, centroids) {
  const P = packPoints(vectors);
  const n = P.n, dim = P.dim, k = centroids.length;
  const C = new Float64Array(k * dim);
  centroids.forEach((c, j) => C.set(c, j * dim));
  const assign = new Int32Array(n), cos = new Float64Array(n), margin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let b = -1, bc = -Infinity, sc = -Infinity;
    for (let j = 0; j < k; j++) {
      const c = rowDot(P, i, C, j * dim);
      if (c > bc) { sc = bc; bc = c; b = j; } else if (c > sc) sc = c;
    }
    assign[i] = b;
    cos[i] = bc;
    margin[i] = k > 1 ? bc - sc : 1;
  }
  return { assign, cos, margin };
}

/**
 * Indexes of the points silhouettes are computed on: all of them up to SILHOUETTE_MAX_POINTS, else a seeded
 * sample of that size (ascending).
 * @param {number} n
 * @param {{max?: number, seed?: number}} [opts]
 * @returns {Int32Array}
 */
export function silhouetteSample(n, { max = SILHOUETTE_MAX_POINTS, seed = 42 } = {}) {
  if (n <= max) return Int32Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(seed);
  const idx = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx.slice(0, max).sort();
}

/**
 * Cosines among a sample of points (m × m, row-major), computed once and reused for every candidate k.
 * @param {object[]|Packed} vectors
 * @param {Int32Array} sample indexes into vectors
 * @param {{checkpoint?: () => void}} [opts]
 * @returns {Float32Array}
 */
export function cosineGram(vectors, sample, { checkpoint = null } = {}) {
  const P = packPoints(vectors);
  const m = sample.length;
  const g = new Float32Array(m * m);
  const row = new Float64Array(P.dim);
  for (let a = 0; a < m; a++) {
    if (checkpoint && a % 200 === 0) checkpoint();
    g[a * m + a] = 1;
    // row a as a dense vector, so every pair costs one packed-row dot (pointCos of two sparse rows gives the same sum)
    row.fill(0);
    rowAdd(P, sample[a], row, 0);
    for (let b = a + 1; b < m; b++) {
      const c = rowDot(P, sample[b], row, 0);
      g[a * m + b] = c;
      g[b * m + a] = c;
    }
  }
  return g;
}

/**
 * Mean cosine silhouette (distance 1 − cos; Rousseeuw 1987) of a labelling of the sampled points; a point
 * alone in its cluster scores 0.
 * @param {Float32Array} gram cosineGram() of the sample
 * @param {Int32Array|number[]} labels cluster of each sampled point (same order as the gram)
 * @param {number} k
 * @returns {{mean: number, perCluster: Float64Array, perPoint: Float64Array}}
 */
export function silhouetteFromGram(gram, labels, k) {
  const m = labels.length;
  const perPoint = new Float64Array(m);
  const sizes = new Int32Array(k);
  for (const l of labels) sizes[l]++;
  const sum = new Float64Array(k);
  for (let a = 0; a < m; a++) {
    sum.fill(0);
    const row = a * m;
    for (let b = 0; b < m; b++) if (b !== a) sum[labels[b]] += 1 - gram[row + b];
    const own = labels[a];
    if (sizes[own] <= 1) { perPoint[a] = 0; continue; }
    const ai = sum[own] / (sizes[own] - 1);
    let bi = Infinity;
    for (let j = 0; j < k; j++) if (j !== own && sizes[j] > 0) bi = Math.min(bi, sum[j] / sizes[j]);
    perPoint[a] = Number.isFinite(bi) ? (bi - ai) / Math.max(ai, bi, 1e-12) : 0;
  }
  const perCluster = new Float64Array(k);
  for (let a = 0; a < m; a++) perCluster[labels[a]] += perPoint[a];
  for (let j = 0; j < k; j++) perCluster[j] = sizes[j] ? perCluster[j] / sizes[j] : 0;
  let mean = 0;
  for (const s of perPoint) mean += s;
  return { mean: m ? mean / m : 0, perCluster, perPoint };
}
