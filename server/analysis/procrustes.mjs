// OWNER: WP4
// procrustes.mjs — orthogonal Procrustes alignment between two slice spaces (SPEC §4.9 (c)).
//
// Each slice space has its own arbitrary rotation, so vectors of different slices are compared only after
// aligning them: R = U·Vᵀ from the SVD of M = Aᵀ·B over anchor words (rows a_i of space A, b_i of space B),
// which minimizes Σ‖a_i − R·b_i‖² over orthogonal R. Anchors are shared words with f ≥ 100 in both slices,
// excluding the target and its top-20 neighbours, at most 5,000 (§4.9); an alignment needs ≥ 3,000 anchors
// and a mean anchor cosine ≥ 0.5 after rotation, else the measure is gated `unaligned`.

import { jacobiSvd, matmulTN } from './linalg.mjs';

/** Anchor rules of §4.9 (c). */
export const ANCHORS = Object.freeze({ minFreq: 100, cap: 5000, needed: 3000, minMeanCos: 0.5, excludeNeighbours: 20 });

/**
 * R = U·Vᵀ from the SVD of AᵀB over anchor rows, so that R·b ≈ a.
 * @param {ArrayLike<number>} a anchors × dim, row-major (space A)
 * @param {ArrayLike<number>} b anchors × dim, row-major (space B), same anchor order
 * @param {number} dim
 * @returns {Float64Array} dim × dim, row-major, orthogonal
 */
export function procrustes(a, b, dim) {
  const n = a.length / dim;
  if (!Number.isInteger(n) || b.length !== a.length) throw new RangeError('procrustes: a and b must both be anchors × dim');
  const m = matmulTN(a, b, n, dim, dim); // Σ a_i b_iᵀ
  const { u, v } = jacobiSvd(m, dim, dim);
  const r = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let s = 0;
      for (let k = 0; k < dim; k++) s += u[i * dim + k] * v[j * dim + k];
      r[i * dim + j] = s;
    }
  }
  return r;
}

/**
 * R·x for one vector.
 * @param {Float64Array} r dim × dim
 * @param {ArrayLike<number>} x
 * @param {number} off offset of the vector in x
 * @param {number} dim
 * @returns {Float64Array}
 */
export function rotate(r, x, off, dim) {
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let s = 0;
    const ri = i * dim;
    for (let k = 0; k < dim; k++) s += r[ri + k] * x[off + k];
    out[i] = s;
  }
  return out;
}

/**
 * Cosine of row ia of A with R·(row ib of B).
 * @returns {number}
 */
export function alignedCosine(wa, ia, wb, ib, r, dim) {
  const rb = rotate(r, wb, ib * dim, dim);
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < dim; k++) { const x = wa[ia * dim + k]; dot += x * rb[k]; na += x * x; nb += rb[k] * rb[k]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Anchor words: in both spaces with f ≥ minFreq in each, not excluded; the most frequent first (by the
 * smaller of the two frequencies, then the word), at most `cap`.
 * @param {{vocab: string[], counts: ArrayLike<number>, index: Map<string, number>}} sa
 * @param {{vocab: string[], counts: ArrayLike<number>, index: Map<string, number>}} sb
 * @param {{minFreq?: number, cap?: number, exclude?: Set<string>}} [opts]
 * @returns {{words: string[], rowsA: Int32Array, rowsB: Int32Array, available: number}} available = eligible before the cap
 */
export function chooseAnchors(sa, sb, { minFreq = ANCHORS.minFreq, cap = ANCHORS.cap, exclude = new Set() } = {}) {
  const cand = [];
  for (let i = 0; i < sa.vocab.length; i++) {
    const w = sa.vocab[i];
    if (exclude.has(w) || sa.counts[i] < minFreq) continue;
    const j = sb.index.get(w);
    if (j === undefined || sb.counts[j] < minFreq) continue;
    cand.push([w, i, j, Math.min(sa.counts[i], sb.counts[j])]);
  }
  cand.sort((x, y) => y[3] - x[3] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const kept = cand.slice(0, cap);
  return { words: kept.map((c) => c[0]), rowsA: Int32Array.from(kept, (c) => c[1]), rowsB: Int32Array.from(kept, (c) => c[2]), available: cand.length };
}

/**
 * Align space B onto space A over anchors: the rotation and its quality.
 * @param {{W: Float32Array, dim: number}} sa
 * @param {{W: Float32Array, dim: number}} sb
 * @param {{rowsA: Int32Array, rowsB: Int32Array}} anchors
 * @returns {{r: Float64Array, anchors: number, meanCos: number, meanCosBefore: number}}
 */
export function alignSpaces(sa, sb, anchors) {
  const dim = sa.dim;
  if (sb.dim !== dim) throw new RangeError(`alignSpaces: dimensions differ (${sa.dim} vs ${sb.dim})`);
  const n = anchors.rowsA.length;
  const a = new Float64Array(n * dim), b = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) {
    a.set(sa.W.subarray(anchors.rowsA[i] * dim, (anchors.rowsA[i] + 1) * dim), i * dim);
    b.set(sb.W.subarray(anchors.rowsB[i] * dim, (anchors.rowsB[i] + 1) * dim), i * dim);
  }
  if (n === 0) return { r: identity(dim), anchors: 0, meanCos: 0, meanCosBefore: 0 };
  const r = procrustes(a, b, dim);
  let after = 0, before = 0;
  for (let i = 0; i < n; i++) {
    after += alignedCosine(a, i, b, i, r, dim);
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < dim; k++) { dot += a[i * dim + k] * b[i * dim + k]; na += a[i * dim + k] ** 2; nb += b[i * dim + k] ** 2; }
    before += na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
  }
  return { r, anchors: n, meanCos: after / n, meanCosBefore: before / n };
}

function identity(dim) {
  const r = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) r[i * dim + i] = 1;
  return r;
}

/**
 * Aligned displacement of a word: 1 − cos(W_A[x], R·W_B[x]).
 * @returns {number}
 */
export function displacement(sa, rowA, sb, rowB, r) {
  return 1 - alignedCosine(sa.W, rowA, sb.W, rowB, r, sa.dim);
}
