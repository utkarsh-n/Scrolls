// OWNER: WP4
// linalg.mjs — dense linear algebra for the vector spaces (SPEC §4.8, §4.9): Householder QR (thin Q),
// one-sided Jacobi (Hestenes) SVD for small matrices, seeded Gaussian test matrices and small products.
//
// Matrices are row-major Float64Array unless a name says otherwise. Everything is deterministic: the
// same input gives the same bits (no parallel reductions here; rsvd.mjs parallelizes the sparse products).

import { mulberry32 } from '../../src/shared/ids.mjs';

const noop = () => {};

/**
 * Row-major → column-major copy (or back: the same function transposes either way).
 * @param {ArrayLike<number>} a rows × cols
 * @param {number} rows
 * @param {number} cols
 * @returns {Float64Array} cols × rows
 */
export function transpose(a, rows, cols) {
  const out = new Float64Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    const r = i * cols;
    for (let j = 0; j < cols; j++) out[j * rows + i] = a[r + j];
  }
  return out;
}

/**
 * Thin Householder QR of a row-major rows × cols matrix with rows ≥ cols: A = Q·R, Q rows × cols with
 * orthonormal columns, R cols × cols upper triangular. Reflectors are applied column by column; `step` is
 * called after every column (the vectors job checks for cancellation there).
 * @param {ArrayLike<number>} a
 * @param {number} rows
 * @param {number} cols
 * @param {{step?: (column: number) => void}} [opts]
 * @returns {{q: Float64Array, r: Float64Array}}
 */
export function householderQr(a, rows, cols, { step = noop } = {}) {
  if (rows < cols) throw new RangeError(`householderQr: needs rows ≥ cols (got ${rows} × ${cols})`);
  const A = transpose(a, rows, cols); // column-major working copy: column j at A[j*rows …]
  const head = new Float64Array(cols); // first element of each Householder vector (the tail stays in A)
  const beta = new Float64Array(cols);
  const R = new Float64Array(cols * cols);
  for (let j = 0; j < cols; j++) {
    const cj = j * rows;
    let tail = 0;
    for (let i = j + 1; i < rows; i++) tail += A[cj + i] * A[cj + i];
    const x0 = A[cj + j];
    const norm = Math.sqrt(x0 * x0 + tail);
    if (norm === 0) {
      beta[j] = 0;
    } else {
      const alpha = x0 > 0 ? -norm : norm;
      const v0 = x0 - alpha;
      const vv = v0 * v0 + tail;
      head[j] = v0;
      beta[j] = vv > 0 ? 2 / vv : 0;
      A[cj + j] = alpha;
      for (let k = j + 1; k < cols; k++) {
        const ck = k * rows;
        let w = v0 * A[ck + j];
        for (let i = j + 1; i < rows; i++) w += A[cj + i] * A[ck + i];
        w *= beta[j];
        if (w === 0) continue;
        A[ck + j] -= w * v0;
        for (let i = j + 1; i < rows; i++) A[ck + i] -= w * A[cj + i];
      }
    }
    for (let k = j; k < cols; k++) R[j * cols + k] = A[k * rows + j];
    step(j);
  }
  // Q = H_0 … H_{c-1} [I; 0], applied in reverse; columns k < j are still e_k when H_j is applied.
  const Q = new Float64Array(rows * cols); // column-major
  for (let k = 0; k < cols; k++) Q[k * rows + k] = 1;
  for (let j = cols - 1; j >= 0; j--) {
    if (beta[j] === 0) continue;
    const cj = j * rows;
    const v0 = head[j];
    for (let k = j; k < cols; k++) {
      const ck = k * rows;
      let w = v0 * Q[ck + j];
      for (let i = j + 1; i < rows; i++) w += A[cj + i] * Q[ck + i];
      w *= beta[j];
      if (w === 0) continue;
      Q[ck + j] -= w * v0;
      for (let i = j + 1; i < rows; i++) Q[ck + i] -= w * A[cj + i];
    }
    step(cols + (cols - 1 - j));
  }
  // make R's diagonal non-negative (unique factorization), flipping the matching columns of Q
  for (let j = 0; j < cols; j++) {
    if (R[j * cols + j] >= 0) continue;
    for (let k = j; k < cols; k++) R[j * cols + k] = -R[j * cols + k];
    const cj = j * rows;
    for (let i = 0; i < rows; i++) Q[cj + i] = -Q[cj + i];
  }
  return { q: transpose(Q, cols, rows), r: R };
}

/**
 * Thin SVD of a small row-major matrix by one-sided Jacobi rotations (Hestenes): A = U·diag(s)·Vᵀ with
 * s sorted descending, U rows × p and V cols × p (p = min(rows, cols)). Accurate to working precision for
 * the matrix sizes of §4.8 (≤ a few hundred columns).
 * @param {ArrayLike<number>} a
 * @param {number} rows
 * @param {number} cols
 * @param {{maxSweeps?: number, tol?: number}} [opts]
 * @returns {{u: Float64Array, s: Float64Array, v: Float64Array, sweeps: number}}
 */
export function jacobiSvd(a, rows, cols, { maxSweeps = 80, tol = 1e-15 } = {}) {
  if (rows < cols) {
    const t = jacobiSvd(transpose(a, rows, cols), cols, rows, { maxSweeps, tol });
    return { u: t.v, s: t.s, v: t.u, sweeps: t.sweeps };
  }
  const m = rows, n = cols;
  const U = transpose(a, m, n); // column-major: column j at U[j*m …]
  const V = new Float64Array(n * n); // column-major
  for (let j = 0; j < n; j++) V[j * n + j] = 1;
  const norms = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0, c = j * m; i < m; i++) s += U[c + i] * U[c + i];
    norms[j] = s;
  }
  let sweeps = 0;
  for (; sweeps < maxSweeps; sweeps++) {
    let rotated = false;
    for (let p = 0; p < n - 1; p++) {
      const cp = p * m;
      for (let q = p + 1; q < n; q++) {
        const cq = q * m;
        const alpha = norms[p], beta = norms[q];
        if (alpha === 0 || beta === 0) continue;
        let gamma = 0;
        for (let i = 0; i < m; i++) gamma += U[cp + i] * U[cq + i];
        if (Math.abs(gamma) <= tol * Math.sqrt(alpha * beta)) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t), s = c * t;
        for (let i = 0; i < m; i++) {
          const x = U[cp + i], y = U[cq + i];
          U[cp + i] = c * x - s * y;
          U[cq + i] = s * x + c * y;
        }
        for (let i = 0, vp = p * n, vq = q * n; i < n; i++) {
          const x = V[vp + i], y = V[vq + i];
          V[vp + i] = c * x - s * y;
          V[vq + i] = s * x + c * y;
        }
        norms[p] = alpha - t * gamma;
        norms[q] = beta + t * gamma;
      }
    }
    // the incremental norms drift slowly; refresh them once per sweep
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0, c = j * m; i < m; i++) s += U[c + i] * U[c + i];
      norms[j] = s;
    }
    if (!rotated) break;
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((x, y) => norms[y] - norms[x] || x - y);
  const s = new Float64Array(n), u = new Float64Array(m * n), v = new Float64Array(n * n);
  order.forEach((j, k) => {
    const sv = Math.sqrt(norms[j]);
    s[k] = sv;
    const inv = sv > 0 ? 1 / sv : 0;
    for (let i = 0; i < m; i++) u[i * n + k] = U[j * m + i] * inv;
    for (let i = 0; i < n; i++) v[i * n + k] = V[j * n + i];
  });
  return { u, s, v, sweeps };
}

/**
 * A rows × cols matrix of independent standard normal draws (Box–Muller over mulberry32), row-major.
 * @param {number} rows
 * @param {number} cols
 * @param {number} seed
 * @returns {Float64Array}
 */
export function gaussianMatrix(rows, cols, seed) {
  const rng = mulberry32(seed);
  const out = new Float64Array(rows * cols);
  for (let i = 0; i < out.length; i += 2) {
    let u1 = rng();
    while (u1 <= 1e-300) u1 = rng();
    const r = Math.sqrt(-2 * Math.log(u1)), th = 2 * Math.PI * rng();
    out[i] = r * Math.cos(th);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(th);
  }
  return out;
}

/**
 * Row-major product C = A·B (A m × k, B k × n).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number} m
 * @param {number} k
 * @param {number} n
 * @returns {Float64Array}
 */
export function matmul(a, b, m, k, n) {
  const c = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const ci = i * n, ai = i * k;
    for (let p = 0; p < k; p++) {
      const x = a[ai + p];
      if (x === 0) continue;
      const bp = p * n;
      for (let j = 0; j < n; j++) c[ci + j] += x * b[bp + j];
    }
  }
  return c;
}

/**
 * Row-major product C = Aᵀ·B (A m × k, B m × n → C k × n).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number} m
 * @param {number} k
 * @param {number} n
 * @returns {Float64Array}
 */
export function matmulTN(a, b, m, k, n) {
  const c = new Float64Array(k * n);
  for (let i = 0; i < m; i++) {
    const ai = i * k, bi = i * n;
    for (let p = 0; p < k; p++) {
      const x = a[ai + p];
      if (x === 0) continue;
      const cp = p * n;
      for (let j = 0; j < n; j++) c[cp + j] += x * b[bi + j];
    }
  }
  return c;
}

/**
 * Scale each row to unit Euclidean length in place (rows of length 0 stay 0).
 * @param {Float32Array|Float64Array} a rows × cols
 * @param {number} rows
 * @param {number} cols
 * @returns {typeof a}
 */
export function normalizeRows(a, rows, cols) {
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const r = i * cols;
    for (let j = 0; j < cols; j++) s += a[r + j] * a[r + j];
    if (s > 0) {
      const inv = 1 / Math.sqrt(s);
      for (let j = 0; j < cols; j++) a[r + j] *= inv;
    }
  }
  return a;
}

/**
 * Dot product of row i of A and row j of B (both with `dim` columns).
 * @param {ArrayLike<number>} a
 * @param {number} i
 * @param {ArrayLike<number>} b
 * @param {number} j
 * @param {number} dim
 * @returns {number}
 */
export function rowDot(a, i, b, j, dim) {
  let s = 0;
  const ai = i * dim, bj = j * dim;
  for (let k = 0; k < dim; k++) s += a[ai + k] * b[bj + k];
  return s;
}
