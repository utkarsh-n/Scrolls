// OWNER: WP4
// ppmi.mjs — positive pointwise mutual information with context smoothing α = 0.75 (Levy, Goldberg & Dagan
// 2015) and the compressed sparse rows it is stored in (SPEC §4.8).
//
//   PPMI(t, c) = max(0, log( n(t,c) · Σ_c' f(c')^α / ( f(t) · f(c)^α ) ))
// where n(t,c) is the window count, f(t) = Σ_c n(t,c) the target's row sum and f(c) = Σ_t n(t,c) the
// context's column sum (both over the counted target × context table; the total N cancels). The sharded
// counting kernels in cooc.mjs call ppmiCell() on their own rows; ppmi() is the same computation for an
// in-memory triplet table (tests, small inputs).

/** Context-distribution smoothing exponent (§4.8). */
export const ALPHA = 0.75;

/**
 * Smoothed context weights from column sums.
 * @param {ArrayLike<number>} colSums
 * @param {number} [alpha]
 * @returns {{colAlpha: Float64Array, sumAlpha: number}}
 */
export function contextWeights(colSums, alpha = ALPHA) {
  const colAlpha = new Float64Array(colSums.length);
  let sumAlpha = 0;
  for (let c = 0; c < colSums.length; c++) {
    const w = colSums[c] > 0 ? Math.pow(colSums[c], alpha) : 0;
    colAlpha[c] = w;
    sumAlpha += w;
  }
  return { colAlpha, sumAlpha };
}

/**
 * One PPMI cell; 0 when the association is not positive (or a margin is empty).
 * @param {number} n window count n(t, c)
 * @param {number} rowSum f(t)
 * @param {number} colAlpha f(c)^α
 * @param {number} sumAlpha Σ f(c')^α
 * @returns {number}
 */
export function ppmiCell(n, rowSum, colAlpha, sumAlpha) {
  if (!(n > 0 && rowSum > 0 && colAlpha > 0)) return 0;
  const v = Math.log((n * sumAlpha) / (rowSum * colAlpha));
  return v > 0 ? v : 0;
}

/**
 * A CSR matrix: row r holds columns colIdx[rowPtr[r] … rowPtr[r+1]) with values vals[…].
 * @typedef {{rows: number, cols: number, nnz: number, rowPtr: Uint32Array|Float64Array, colIdx: Uint16Array|Uint32Array,
 *   vals: Float32Array}} Csr
 */

/**
 * PPMI of an in-memory co-occurrence table → CSR (rows = targets, columns = contexts, columns ascending).
 * @param {{rows: number, cols: number, entries: Array<[number, number, number]>}} cooc (target, context, count) triplets
 * @param {{alpha?: number}} [opts]
 * @returns {Csr}
 */
export function ppmi(cooc, { alpha = ALPHA } = {}) {
  const { rows, cols, entries } = cooc;
  const rowSums = new Float64Array(rows), colSums = new Float64Array(cols);
  for (const [t, c, n] of entries) { rowSums[t] += n; colSums[c] += n; }
  const { colAlpha, sumAlpha } = contextWeights(colSums, alpha);
  const kept = [];
  for (const [t, c, n] of entries) {
    const v = ppmiCell(n, rowSums[t], colAlpha[c], sumAlpha);
    if (v > 0) kept.push([t, c, v]);
  }
  kept.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const rowPtr = new Uint32Array(rows + 1);
  for (const [t] of kept) rowPtr[t + 1]++;
  for (let r = 0; r < rows; r++) rowPtr[r + 1] += rowPtr[r];
  const colIdx = cols <= 0xffff ? new Uint16Array(kept.length) : new Uint32Array(kept.length);
  const vals = new Float32Array(kept.length);
  kept.forEach(([, c, v], i) => { colIdx[i] = c; vals[i] = v; });
  return { rows, cols, nnz: kept.length, rowPtr, colIdx, vals };
}

/**
 * Dense row-major copy of a CSR matrix (tests and tiny inputs only).
 * @param {Csr} csr
 * @returns {Float64Array}
 */
export function csrToDense(csr) {
  const out = new Float64Array(csr.rows * csr.cols);
  for (let r = 0; r < csr.rows; r++) {
    for (let k = csr.rowPtr[r]; k < csr.rowPtr[r + 1]; k++) out[r * csr.cols + csr.colIdx[k]] = csr.vals[k];
  }
  return out;
}
