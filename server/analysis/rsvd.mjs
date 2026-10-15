// OWNER: WP4
// rsvd.mjs — randomized truncated SVD (Halko, Martinsson & Tropp 2011) of the PPMI matrix and the word
// vectors made from it (SPEC §4.8): d = 256, oversampling 16, 2 power iterations, seed 42.
//
// A is the targets × contexts PPMI matrix (m ≤ 50,000 rows, n ≤ 10,000 columns). The range finder runs on
// Aᵀ, whose column space lives in the small context dimension, so every power-iteration QR is n × l:
//   Z = Aᵀ·Ω (Ω m × l Gaussian) → Q = qr(Z);   repeat q times: Q = qr(Aᵀ·(A·Q));
//   C = A·Q (= Bᵀ for B = Qᵀ·Aᵀ) → Householder C = Q_c·R → one-sided Jacobi R = U_r·Σ·V_rᵀ → U = Q_c·U_r.
// Then A ≈ U·Σ·(Q·V_r)ᵀ and the word vectors are W = U_d·Σ_d^½ with rows L2-normalized.
// The sparse × dense products are split by row block (balanced by non-zeros) across worker threads that
// share the CSR and the dense operands through SharedArrayBuffers; the dense steps run in the calling
// thread and call `step()` between columns so a job can be cancelled.

import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { defaultThreads } from './cooc.mjs';
import { gaussianMatrix, householderQr, jacobiSvd, normalizeRows } from './linalg.mjs';

/** Defaults of §4.8. */
export const RSVD = Object.freeze({ d: 256, oversample: 16, powerIters: 2, seed: 42 });
/** Exponent of Σ in W = U·Σ^p (§4.8: ½). */
export const SIGMA_POWER = 0.5;

const KERNEL = 'scrolls.rsvd';
const shared = (Ctor, n) => new Ctor(new SharedArrayBuffer(Math.max(1, n) * Ctor.BYTES_PER_ELEMENT), 0, n);

// ── Kernels ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * out[r] = Σ_k vals[k]·x[colIdx[k]] for rows lo…hi-1 (x n × l, out m × l, row-major).
 */
export function spmmRows(csr, x, out, l, lo, hi) {
  const { rowPtr, colIdx, vals } = csr;
  for (let r = lo; r < hi; r++) {
    const o = r * l;
    for (let j = 0; j < l; j++) out[o + j] = 0;
    for (let k = rowPtr[r], e = rowPtr[r + 1]; k < e; k++) {
      const v = vals[k], xo = colIdx[k] * l;
      for (let j = 0; j < l; j++) out[o + j] += v * x[xo + j];
    }
  }
}

/**
 * out += Aᵀ restricted to rows lo…hi-1 times y (y m × l, out n × l, row-major; out is zeroed first).
 */
export function spmmTransposeRows(csr, y, out, l, lo, hi) {
  out.fill(0);
  const { rowPtr, colIdx, vals } = csr;
  for (let r = lo; r < hi; r++) {
    const yo = r * l;
    for (let k = rowPtr[r], e = rowPtr[r + 1]; k < e; k++) {
      const v = vals[k], o = colIdx[k] * l;
      for (let j = 0; j < l; j++) out[o + j] += v * y[yo + j];
    }
  }
}

/** Row blocks with about equal non-zeros each. */
function rowBlocks(csr, parts) {
  const bounds = [0];
  const per = csr.nnz / parts;
  let r = 0;
  for (let p = 1; p < parts; p++) {
    const target = per * p;
    while (r < csr.rows && csr.rowPtr[r] < target) r++;
    bounds.push(Math.max(bounds[bounds.length - 1], r));
  }
  bounds.push(csr.rows);
  return bounds;
}

/**
 * Sparse products A·X and Aᵀ·Y, in worker threads (threads ≥ 1) or in this thread (threads 0).
 * @param {import('./ppmi.mjs').Csr} csr
 * @param {{threads?: number, signal?: AbortSignal|null, minParallelNnz?: number}} [opts] smaller matrices stay in this thread
 * @returns {{ax(x: Float64Array, l: number): Promise<Float64Array>, aty(y: Float64Array, l: number): Promise<Float64Array>,
 *   close(): Promise<void>}}
 */
export function sparseOps(csr, { threads = defaultThreads(), signal = null, minParallelNnz = 200000 } = {}) {
  const { rows: m, cols: n } = csr;
  if (threads <= 0 || csr.nnz < minParallelNnz) {
    return {
      async ax(x, l) { const out = new Float64Array(m * l); spmmRows(csr, x, out, l, 0, m); return out; },
      async aty(y, l) { const out = new Float64Array(n * l); spmmTransposeRows(csr, y, out, l, 0, m); return out; },
      async close() {},
    };
  }
  const T = Math.max(1, Math.min(threads, 8));
  const toShared = (a) => {
    if (a.buffer instanceof SharedArrayBuffer) return a;
    const s = shared(a.constructor, a.length);
    s.set(a);
    return s;
  };
  const sh = { rowPtr: toShared(csr.rowPtr), colIdx: toShared(csr.colIdx), vals: toShared(csr.vals), rows: m, cols: n, nnz: csr.nnz };
  const bounds = rowBlocks(sh, T);
  const workers = Array.from({ length: T }, () => new Worker(new URL(import.meta.url), { workerData: { [KERNEL]: true, ...sh } }));
  let failure = null;
  const pending = new Map();
  let seq = 0;
  const failAll = (err) => {
    failure ??= err;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
  };
  const abort = () => { for (const w of workers) w.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  for (const w of workers) {
    w.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error));
      else if (--p.left === 0) { pending.delete(msg.id); p.resolve(); }
    });
    w.on('error', failAll);
    w.on('exit', () => failAll(signal?.aborted ? signal.reason : new Error('sparse-product worker exited')));
  }
  const run = (op, bufs) => {
    if (failure) return Promise.reject(failure);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, left: T });
      workers.forEach((w, i) => w.postMessage({ id, op, lo: bounds[i], hi: bounds[i + 1], part: i, ...bufs }));
    });
  };
  return {
    async ax(x, l) {
      const xs = toShared(x);
      const out = shared(Float64Array, m * l);
      await run('ax', { x: xs, out, l });
      return out;
    },
    async aty(y, l) {
      const ys = toShared(y);
      const parts = shared(Float64Array, T * n * l);
      await run('aty', { y: ys, out: parts, l, partLen: n * l });
      const out = new Float64Array(n * l);
      for (let p = 0; p < T; p++) {
        const o = p * n * l;
        for (let i = 0; i < n * l; i++) out[i] += parts[o + i];
      }
      return out;
    },
    async close() {
      signal?.removeEventListener('abort', abort);
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

// ── The decomposition ────────────────────────────────────────────────────────────────────────────────

/**
 * Truncated SVD of a sparse matrix: A ≈ U·diag(s)·Vᵀ with the d largest singular values.
 * @param {import('./ppmi.mjs').Csr} csr
 * @param {{d?: number, oversample?: number, powerIters?: number, seed?: number, threads?: number, signal?: AbortSignal|null,
 *   step?: () => void, onProgress?: (fraction: number, message: string) => void, minParallelNnz?: number}} [opts]
 * @returns {Promise<{u: Float64Array, s: Float64Array, d: number, l: number, rows: number}>} u is rows × d, row-major
 */
export async function randomizedSvd(csr, { d = RSVD.d, oversample = RSVD.oversample, powerIters = RSVD.powerIters, seed = RSVD.seed,
  threads = defaultThreads(), signal = null, step = () => {}, onProgress = () => {}, minParallelNnz } = {}) {
  const m = csr.rows, n = csr.cols;
  const l = Math.max(1, Math.min(d + oversample, m, n));
  const k = Math.min(d, l);
  const ops = sparseOps(csr, { threads, signal, ...(minParallelNnz === undefined ? {} : { minParallelNnz }) });
  const stages = 3 + 2 * powerIters;
  let done = 0;
  const advance = (what) => { step(); onProgress(++done / stages, what); };
  try {
    const omega = gaussianMatrix(m, l, seed);
    let z = await ops.aty(omega, l);
    advance('range: Aᵀ·Ω');
    let q = householderQr(z, n, l, { step }).q;
    for (let it = 0; it < powerIters; it++) {
      const y = await ops.ax(q, l);
      step();
      z = await ops.aty(y, l);
      q = householderQr(z, n, l, { step }).q;
      advance(`power iteration ${it + 1} of ${powerIters}`);
      advance(`power iteration ${it + 1} of ${powerIters}`);
    }
    const c = await ops.ax(q, l);
    advance('projection: A·Q');
    const qr = householderQr(c, m, l, { step });
    const svd = jacobiSvd(qr.r, l, l);
    advance('small SVD');
    const u = new Float64Array(m * k);
    // U = Q_c · U_r[:, :k]
    for (let i = 0; i < m; i++) {
      const qi = i * l, ui = i * k;
      for (let p = 0; p < l; p++) {
        const x = qr.q[qi + p];
        if (x === 0) continue;
        const rp = p * l;
        for (let j = 0; j < k; j++) u[ui + j] += x * svd.u[rp + j];
      }
      if ((i & 1023) === 0) step();
    }
    return { u, s: svd.s.slice(0, k), d: k, l, rows: m };
  } finally {
    await ops.close();
  }
}

/**
 * Word vectors W = U·Σ^p, rows L2-normalized (§4.8: p = ½).
 * @param {{u: Float64Array, s: Float64Array, d: number, rows: number}} svd
 * @param {{power?: number}} [opts]
 * @returns {Float32Array} rows × d
 */
export function wordVectors(svd, { power = SIGMA_POWER } = {}) {
  const { u, s, d, rows } = svd;
  const w = new Float32Array(rows * d);
  const scale = Array.from(s, (x) => Math.pow(Math.max(0, x), power));
  for (let i = 0; i < rows; i++) for (let j = 0; j < d; j++) w[i * d + j] = u[i * d + j] * scale[j];
  return normalizeRows(w, rows, d);
}

// ── Worker entry ─────────────────────────────────────────────────────────────────────────────────────

function kernelMain(csr) {
  parentPort.on('message', (msg) => {
    try {
      if (msg.op === 'ax') spmmRows(csr, msg.x, msg.out, msg.l, msg.lo, msg.hi);
      else if (msg.op === 'aty') {
        const part = msg.out.subarray(msg.part * msg.partLen, (msg.part + 1) * msg.partLen);
        spmmTransposeRows(csr, msg.y, part, msg.l, msg.lo, msg.hi);
      }
      parentPort.postMessage({ id: msg.id });
    } catch (err) {
      parentPort.postMessage({ id: msg.id, error: String(err?.message ?? err) });
    }
  });
}

if (!isMainThread && workerData?.[KERNEL] === true) kernelMain(workerData);
