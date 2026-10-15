// OWNER: WP4
// kmeans-pool.mjs — spherical k-means fits run in worker threads (SPEC §4.8, §4.12).
//
// Choosing k fits every candidate k ten times, and each stability measurement re-clusters 30 document
// subsamples: independent fits, each with its own explicit seed, so they can run anywhere and in any order and
// still give exactly the clustering one thread gives. The points are copied once into shared memory; each worker
// fits the subsets it is sent. The calling thread only waits, so a cancelled job terminates its workers at once.

import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { sphericalKMeans, subsetPacked } from './kmeans.mjs';

const KERNEL = 'scrolls.kmeans';
/** At most this many workers. */
export const MAX_THREADS = 8;
/** Below this many point-coordinates (n × dim, or non-zeros) fits stay in the calling thread: workers would cost more. */
export const MIN_PARALLEL_WORK = 200000;

/** Worker threads used by default: up to 8, leaving a core for the server. */
export function defaultFitThreads() {
  return Math.max(1, Math.min(MAX_THREADS, availableParallelism() - 1));
}

/**
 * @typedef {{k: number, seed: number, restarts?: number, maxIter?: number, rows?: Int32Array|number[]|null}} FitTask
 * @typedef {{assign: Int32Array, objective: number, iterations: number, centroids: Float64Array[], sizes: Int32Array}} FitResult
 */

/** One fit in this thread. */
function fitOne(P, t) {
  const pts = t.rows ? subsetPacked(P, t.rows) : P;
  return sphericalKMeans(pts, t.k, { restarts: t.restarts ?? 10, maxIter: t.maxIter ?? 100, seed: t.seed });
}

const toShared = (arr) => {
  if (!arr) return null;
  const out = new arr.constructor(new SharedArrayBuffer(arr.byteLength));
  out.set(arr);
  return out;
};

/**
 * A fitter: `fit(tasks)` resolves to one FitResult per task, in order. With threads ≤ 1 (or little work) the
 * fits run in this thread; otherwise in a pool of workers that share the points.
 * @param {import('./kmeans.mjs').Packed} P
 * @param {{threads?: number, signal?: AbortSignal|null, checkpoint?: () => void}} [opts]
 * @returns {{fit: (tasks: FitTask[], onDone?: (i: number) => void) => Promise<FitResult[]>, close: () => Promise<void>, threads: number}}
 */
export function createFitter(P, { threads = defaultFitThreads(), signal = null, checkpoint = null } = {}) {
  const work = P.data ? P.n * P.dim : P.values.length;
  const n = Math.max(0, Math.min(MAX_THREADS, threads));
  if (n <= 1 || work < MIN_PARALLEL_WORK) {
    return {
      threads: 0,
      async fit(tasks, onDone) {
        const out = [];
        for (const [i, t] of tasks.entries()) {
          checkpoint?.();
          if (signal?.aborted) throw signal.reason;
          out.push(fitOne(P, t));
          onDone?.(i);
          // let a cancel message reach this thread between fits
          await new Promise((resolve) => setImmediate(resolve));
        }
        return out;
      },
      async close() {},
    };
  }
  const shared = { n: P.n, dim: P.dim, data: toShared(P.data), indptr: toShared(P.indptr), indices: toShared(P.indices), values: toShared(P.values) };
  const workers = Array.from({ length: n }, () => new Worker(new URL(import.meta.url), { workerData: { [KERNEL]: true, shared } }));
  let failure = null;
  const pending = new Map();
  const onAbort = () => {
    failure = signal.reason ?? new Error('cancelled');
    for (const w of workers) w.terminate();
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  for (const w of workers) {
    w.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'error') p.reject(Object.assign(new Error(m.message), { code: 'E_KMEANS_WORKER' }));
      else {
        const k = m.k, dim = P.dim;
        const centroids = Array.from({ length: k }, (_, j) => m.centroids.slice(j * dim, (j + 1) * dim));
        p.resolve({ assign: m.assign, objective: m.objective, iterations: m.iterations, centroids, sizes: m.sizes });
      }
    });
    w.on('error', (err) => { failure ??= err; for (const p of pending.values()) p.reject(err); pending.clear(); });
    w.on('exit', (code) => {
      if (code !== 0 && !failure) { failure = new Error(`k-means worker exited (${code})`); for (const p of pending.values()) p.reject(failure); pending.clear(); }
    });
  }
  let nextId = 0;
  return {
    threads: n,
    fit(tasks, onDone) {
      if (failure) return Promise.reject(failure);
      if (signal?.aborted) return Promise.reject(signal.reason);
      // a shared queue: each worker takes the next task when it finishes one, so long fits do not hold up short ones
      let at = 0;
      const results = new Array(tasks.length);
      return new Promise((resolve, reject) => {
        let left = tasks.length, stop = false;
        if (!left) { resolve(results); return; }
        const feed = (w) => {
          if (stop || at >= tasks.length) return;
          const i = at++;
          const t = tasks[i];
          const id = nextId++;
          pending.set(id, {
            resolve: (r) => {
              results[i] = r;
              onDone?.(i);
              if (--left === 0) resolve(results); else feed(w);
            },
            reject: (err) => { stop = true; reject(err); },
          });
          const rows = t.rows ? Int32Array.from(t.rows) : null;
          w.postMessage({ type: 'fit', id, k: t.k, seed: t.seed, restarts: t.restarts ?? 10, maxIter: t.maxIter ?? 100, rows }, rows ? [rows.buffer] : []);
        };
        for (const w of workers) feed(w);
      });
    },
    async close() {
      signal?.removeEventListener('abort', onAbort);
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

// ── Worker entry ─────────────────────────────────────────────────────────────────────────────────────

function kernelMain({ shared }) {
  const P = { packed: true, ...shared };
  parentPort.on('message', (m) => {
    if (m?.type !== 'fit') return;
    try {
      const r = fitOne(P, m);
      const flat = new Float64Array(m.k * P.dim);
      r.centroids.forEach((c, j) => flat.set(c, j * P.dim));
      parentPort.postMessage({ type: 'done', id: m.id, k: m.k, assign: r.assign, objective: r.objective, iterations: r.iterations, centroids: flat,
        sizes: r.sizes }, [r.assign.buffer, flat.buffer, r.sizes.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
    }
  });
}

if (!isMainThread && workerData?.[KERNEL] === true) kernelMain(workerData);
