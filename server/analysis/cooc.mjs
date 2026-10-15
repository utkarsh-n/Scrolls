// OWNER: WP4
// cooc.mjs — what a vector space is counted from (SPEC §4.8): the documents and passages of a space, its
// vocabulary (targets f ≥ 20, at most 50,000; contexts the 10,000 most frequent types), and the target ×
// context co-occurrence counts in a symmetric window of ±4 tokens clipped at passage boundaries (§4.4).
//
// Counting uses typed-array open-addressing tables sharded by targetIndex mod 8 (key = t·C + c + 1 as u32,
// value u32 — exact integer counts; a JS Map is never used for pairs, it fails near 16.7M entries). The
// shards run in up to 8 worker threads that share the token ids through a SharedArrayBuffer; the same
// workers then turn their rows into PPMI and write them straight into one shared CSR. The calling thread
// only waits, so a job can be cancelled at any moment: the workers are terminated.

import { availableParallelism } from 'node:os';
import { closeSync, openSync, readSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { contextWeights, ppmiCell } from './ppmi.mjs';

/** Window on each side (§4.4 "space building ±4"). */
export const WINDOW = 4;
/** Number of target shards (§4.8). */
export const SHARDS = 8;
/** Vocabulary limits (§4.8). */
export const LIMITS = Object.freeze({ minTargetFreq: 20, maxTargets: 50000, contexts: 10000 });
/** Field classes of running text a space is built from (titles are works, describes/apparatus are excluded, D9). */
export const SPACE_FIELD_CLASSES = Object.freeze(['text', 'abstract']);

const KERNEL = 'scrolls.cooc';
const MIN_LOG2 = 10, START_LOG2 = 23, MAX_LOG2 = 28;
const LOAD = 0.7;
const PROGRESS_EVERY = 1 << 20;

// ── Documents and passages of a space ────────────────────────────────────────────────────────────────

/**
 * The documents a space is built from: not deleted, not translations (D8), not duplicates, in the given
 * collections; with `years`, dated documents whose whole interval fits (fit-or-wash, §13 rule 4); with
 * `docIds`, exactly those (a Compare slice). Tokens are doc_tokens of the language in running-text classes.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{lang: string, collections?: number[]|null, years?: [number, number]|null, docIds?: number[]|null}} sel
 * @returns {{docIds: number[], tokens: number, docs: number, authors: number}}
 */
export function spaceDocuments(db, { lang, collections = null, years = null, docIds = null }) {
  const rows = db.prepare(`SELECT d.id, d.author, d.y_lo, d.y_hi, d.chrono_status AS chrono, d.collection_id AS coll,
      SUM(t.tokens) AS tokens
    FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE t.plang = ? AND t.field_class IN ('text', 'abstract') AND d.deleted_at IS NULL AND d.is_translation = 0
      AND d.dup_of IS NULL
      AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR d.id IN (SELECT value FROM json_each(?)))
    GROUP BY d.id ORDER BY d.id`).all(lang, collections ? 1 : null, JSON.stringify(collections ?? []),
    docIds ? 1 : null, JSON.stringify(docIds ?? []));
  const out = [];
  const authors = new Set();
  let tokens = 0;
  for (const r of rows) {
    if (years && !(r.chrono === 'dated' && r.y_lo >= years[0] && r.y_hi <= years[1])) continue;
    out.push(r.id);
    tokens += r.tokens;
    if (r.author) authors.add(r.author);
  }
  return { docIds: out, tokens, docs: out.length, authors: authors.size };
}

/**
 * Token ranges [start, end) in a language's token stream of the running-text passages of some documents.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{range(passageId: number): [number, number]|null}} stream tokstream.openTokenStream()
 * @param {{lang: string, docIds: number[]}} sel
 * @returns {{ranges: Uint32Array, passages: number, tokens: number, missing: number}} missing = passages absent from the stream
 */
export function passageRanges(db, stream, { lang, docIds }) {
  const out = [];
  let tokens = 0, missing = 0, passages = 0;
  for (const p of db.prepare(`SELECT p.id FROM passage p
    WHERE p.document_id IN (SELECT value FROM json_each(?)) AND p.lang = ? AND p.quality = 'ok'
      AND p.field_class IN ('text', 'abstract') AND p.time_role = 'document' ORDER BY p.id`).iterate(JSON.stringify(docIds), lang)) {
    const r = stream.range(p.id);
    if (!r) { missing++; continue; }
    passages++;
    if (r[1] > r[0]) { out.push(r[0], r[1]); tokens += r[1] - r[0]; }
  }
  return { ranges: Uint32Array.from(out), passages, tokens, missing };
}

/**
 * Frequencies and passage document frequencies of every stream id inside the ranges.
 * @param {Uint32Array} ids
 * @param {Uint32Array} ranges
 * @param {number} vocabSize
 * @param {{tick?: () => void}} [opts]
 * @returns {{counts: Uint32Array, df: Uint32Array, passages: number, tokens: number}}
 */
export function unigramCounts(ids, ranges, vocabSize, { tick = () => {} } = {}) {
  const counts = new Uint32Array(vocabSize), df = new Uint32Array(vocabSize);
  const last = new Int32Array(vocabSize).fill(-1);
  let tokens = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    const s = ranges[r], e = ranges[r + 1];
    for (let i = s; i < e; i++) {
      const id = ids[i];
      counts[id]++;
      if (last[id] !== r) { last[id] = r; df[id]++; }
    }
    tokens += e - s;
    if ((r & 4095) === 0) tick();
  }
  return { counts, df, passages: ranges.length / 2, tokens };
}

/**
 * Targets (f ≥ 20, the 50,000 most frequent) and contexts (the 10,000 most frequent) by frequency in the
 * selection; ties by stream id, so the choice is reproducible.
 * @param {Uint32Array} counts
 * @param {{minTargetFreq?: number, maxTargets?: number, contexts?: number}} [limits]
 * @returns {{targets: Uint32Array, contexts: Uint32Array, targetIndex: Int32Array, contextIndex: Int32Array}}
 */
export function chooseVocab(counts, { minTargetFreq = LIMITS.minTargetFreq, maxTargets = LIMITS.maxTargets,
  contexts: nContexts = LIMITS.contexts } = {}) {
  const present = [];
  for (let id = 0; id < counts.length; id++) if (counts[id] > 0) present.push(id);
  present.sort((x, y) => counts[y] - counts[x] || x - y);
  const targets = Uint32Array.from(present.filter((id) => counts[id] >= minTargetFreq).slice(0, maxTargets));
  const contexts = Uint32Array.from(present.slice(0, nContexts));
  const targetIndex = new Int32Array(counts.length).fill(-1);
  const contextIndex = new Int32Array(counts.length).fill(-1);
  targets.forEach((id, i) => { targetIndex[id] = i; });
  contexts.forEach((id, i) => { contextIndex[id] = i; });
  return { targets, contexts, targetIndex, contextIndex };
}

// ── In-memory counting (tests, small inputs) ─────────────────────────────────────────────────────────

/**
 * Target × context counts in one table (no sharding, no workers): the reference the sharded kernels are
 * tested against.
 * @param {{ids: Uint32Array, ranges: Uint32Array}} stream
 * @param {{window?: number, targets: ArrayLike<number>, contexts: ArrayLike<number>}} opts stream ids
 * @returns {{rows: number, cols: number, entries: Array<[number, number, number]>}}
 */
export function cooccurrence(stream, { window = WINDOW, targets, contexts }) {
  const vocab = Math.max(0, ...Array.from(targets), ...Array.from(contexts)) + 1;
  const ti = new Int32Array(Math.max(vocab, 1)).fill(-1), ci = new Int32Array(Math.max(vocab, 1)).fill(-1);
  Array.from(targets).forEach((id, i) => { ti[id] = i; });
  Array.from(contexts).forEach((id, i) => { ci[id] = i; });
  const counts = new Map();
  const { ids, ranges } = stream;
  for (let r = 0; r < ranges.length; r += 2) {
    const s = ranges[r], e = ranges[r + 1];
    for (let i = s; i < e; i++) {
      const t = ids[i] < vocab ? ti[ids[i]] : -1;
      if (t < 0) continue;
      for (let j = Math.max(s, i - window); j < Math.min(e, i + window + 1); j++) {
        if (j === i) continue;
        const c = ids[j] < vocab ? ci[ids[j]] : -1;
        if (c < 0) continue;
        const k = `${t}|${c}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  const entries = [...counts].map(([k, n]) => { const [t, c] = k.split('|').map(Number); return [t, c, n]; })
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return { rows: targets.length, cols: contexts.length, entries };
}

// ── Sharded kernels (pure; run in workers or in-process) ─────────────────────────────────────────────

function newTable(log2) {
  const cap = 2 ** log2;
  return { log2, cap, mask: cap - 1, keys: new Uint32Array(cap), vals: new Uint32Array(cap), size: 0, limit: Math.floor(cap * LOAD) };
}

function growTable(t) {
  if (t.log2 >= MAX_LOG2) throw new RangeError(`co-occurrence shard exceeded 2^${MAX_LOG2} slots`);
  const n = newTable(t.log2 + 1);
  const shift = 32 - n.log2;
  for (let i = 0; i < t.cap; i++) {
    const k = t.keys[i];
    if (k === 0) continue;
    let h = Math.imul(k, 0x9E3779B1) >>> shift;
    while (n.keys[h] !== 0) h = (h + 1) & n.mask;
    n.keys[h] = k;
    n.vals[h] = t.vals[i];
  }
  n.size = t.size;
  return n;
}

/**
 * Count the pairs of the given shards in one pass over the ranges.
 * @param {{ids: Uint32Array, ranges: Uint32Array, targetIndex: Int32Array, contextIndex: Int32Array, nContexts: number,
 *   window: number, shards: number[], totalShards: number, startLog2?: number}} job
 * @param {{onProgress?: (tokens: number) => void}} [hooks]
 * @returns {Map<number, ReturnType<typeof newTable>>} shard → table
 */
export function countShards(job, { onProgress = () => {} } = {}) {
  const { ids, ranges, targetIndex, contextIndex, nContexts, window, shards, totalShards } = job;
  const tables = new Array(totalShards).fill(null);
  for (const s of shards) tables[s] = newTable(job.startLog2 ?? START_LOG2);
  let scanned = 0, nextReport = PROGRESS_EVERY;
  for (let r = 0; r < ranges.length; r += 2) {
    const s0 = ranges[r], e0 = ranges[r + 1];
    for (let i = s0; i < e0; i++) {
      const t = targetIndex[ids[i]];
      if (t < 0) continue;
      let tab = tables[t % totalShards];
      if (tab === null) continue;
      const base = t * nContexts + 1;
      const lo = i - window > s0 ? i - window : s0;
      const hi = i + window + 1 < e0 ? i + window + 1 : e0;
      for (let j = lo; j < hi; j++) {
        if (j === i) continue;
        const c = contextIndex[ids[j]];
        if (c < 0) continue;
        const key = base + c;
        const keys = tab.keys;
        let h = Math.imul(key, 0x9E3779B1) >>> (32 - tab.log2);
        for (;;) {
          const k = keys[h];
          if (k === key) { tab.vals[h]++; break; }
          if (k === 0) {
            keys[h] = key;
            tab.vals[h] = 1;
            if (++tab.size > tab.limit) { tab = growTable(tab); tables[t % totalShards] = tab; }
            break;
          }
          h = (h + 1) & tab.mask;
        }
      }
    }
    scanned += e0 - s0;
    if (scanned >= nextReport) { onProgress(scanned); nextReport = scanned + PROGRESS_EVERY; }
  }
  onProgress(scanned);
  const out = new Map();
  for (const s of shards) out.set(s, tables[s]);
  return out;
}

/**
 * Margins of a shard's table: row sums of its targets, column sums and the number of distinct pairs.
 * @param {ReturnType<typeof newTable>} tab
 * @param {number} nTargets
 * @param {number} nContexts
 * @returns {{rowSums: Float64Array, colSums: Float64Array, pairs: number, total: number}}
 */
export function tableMargins(tab, nTargets, nContexts) {
  const rowSums = new Float64Array(nTargets), colSums = new Float64Array(nContexts);
  let total = 0;
  for (let i = 0; i < tab.cap; i++) {
    const k = tab.keys[i];
    if (k === 0) continue;
    const v = tab.vals[i], key = k - 1;
    const t = Math.floor(key / nContexts), c = key - t * nContexts;
    rowSums[t] += v;
    colSums[c] += v;
    total += v;
  }
  return { rowSums, colSums, pairs: tab.size, total };
}

/**
 * Positive-PPMI entries per row of a shard.
 * @returns {Uint32Array} nTargets counts (0 for rows of other shards)
 */
export function ppmiRowCounts(tab, { rowSums, colAlpha, sumAlpha, nTargets, nContexts }) {
  const nnz = new Uint32Array(nTargets);
  for (let i = 0; i < tab.cap; i++) {
    const k = tab.keys[i];
    if (k === 0) continue;
    const key = k - 1, t = Math.floor(key / nContexts), c = key - t * nContexts;
    if (ppmiCell(tab.vals[i], rowSums[t], colAlpha[c], sumAlpha) > 0) nnz[t]++;
  }
  return nnz;
}

/**
 * Write a shard's positive-PPMI entries into the shared CSR (rows of a shard never overlap other shards').
 */
export function ppmiWrite(tab, { rowSums, colAlpha, sumAlpha, nTargets, nContexts, rowPtr, colIdx, vals }) {
  const cursor = new Float64Array(nTargets);
  for (let i = 0; i < tab.cap; i++) {
    const k = tab.keys[i];
    if (k === 0) continue;
    const key = k - 1, t = Math.floor(key / nContexts), c = key - t * nContexts;
    const v = ppmiCell(tab.vals[i], rowSums[t], colAlpha[c], sumAlpha);
    if (!(v > 0)) continue;
    const at = rowPtr[t] + cursor[t]++;
    colIdx[at] = c;
    vals[at] = v;
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────────────────

const shared = (Ctor, n) => new Ctor(new SharedArrayBuffer(Math.max(1, n) * Ctor.BYTES_PER_ELEMENT), 0, n);
const toShared = (arr) => {
  if (arr.buffer instanceof SharedArrayBuffer) return arr;
  const out = shared(arr.constructor, arr.length);
  out.set(arr);
  return out;
};

/**
 * Read a .u32 token stream into a SharedArrayBuffer (so counting workers share it without copies).
 * @param {string} file
 * @param {number} tokens
 * @param {{tick?: () => void}} [opts]
 * @returns {Uint32Array}
 */
export function readSharedIds(file, tokens, { tick = () => {} } = {}) {
  const ids = shared(Uint32Array, tokens);
  const bytes = new Uint8Array(ids.buffer, 0, tokens * 4);
  const fd = openSync(file, 'r');
  try {
    const CH = 64 << 20;
    for (let off = 0; off < bytes.length; off += CH) {
      const n = Math.min(CH, bytes.length - off);
      let got = 0;
      while (got < n) got += readSync(fd, bytes, off + got, n - got, off + got);
      tick();
    }
  } finally {
    closeSync(fd);
  }
  return ids;
}

/** Worker threads used by default: up to 8, leaving a core for the server. */
export function defaultThreads() {
  return Math.max(1, Math.min(SHARDS, availableParallelism() - 1));
}

/**
 * Count co-occurrences and build the PPMI matrix (rows = targets, columns = contexts) in shared memory.
 * @param {{ids: Uint32Array, ranges: Uint32Array, targetIndex: Int32Array, contextIndex: Int32Array, nTargets: number,
 *   nContexts: number, window?: number, alpha?: number}} input
 * @param {{threads?: number, signal?: AbortSignal|null, onProgress?: (fraction: number, message: string) => void,
 *   tick?: () => void}} [opts] threads 0 = in this thread (tick() is called between steps for cancellation)
 * @returns {Promise<{csr: import('./ppmi.mjs').Csr, pairs: number, total: number, rowSums: Float64Array, colSums: Float64Array}>}
 */
export async function cooccurrencePpmi(input, { threads = defaultThreads(), signal = null, onProgress = () => {}, tick = () => {} } = {}) {
  const { nTargets, nContexts, window = WINDOW, alpha } = input;
  const scanTotal = Math.max(1, rangeTokens(input.ranges));
  const startLog2 = Math.max(MIN_LOG2, Math.min(START_LOG2, Math.ceil(Math.log2((scanTotal * 2 * window) / SHARDS / LOAD + 1))));
  if (threads <= 0) return inProcess(input, { window, alpha, startLog2, onProgress, tick, scanTotal });

  const T = Math.min(threads, SHARDS);
  const common = { ids: toShared(input.ids), ranges: toShared(input.ranges), targetIndex: toShared(input.targetIndex),
    contextIndex: toShared(input.contextIndex), nTargets, nContexts, window, totalShards: SHARDS, startLog2 };
  const workers = [];
  const scanned = new Float64Array(T);
  const abort = () => { for (const w of workers) w.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason;
    for (let w = 0; w < T; w++) {
      const shards = [];
      for (let s = w; s < SHARDS; s += T) shards.push(s);
      workers.push(new Worker(new URL(import.meta.url), { workerData: { [KERNEL]: true, ...common, shards } }));
    }
    const channels = workers.map((w, i) => channel(w, signal, (m) => {
      if (m.type === 'progress') {
        scanned[i] = m.scanned;
        let sum = 0;
        for (const x of scanned) sum += x;
        onProgress(Math.min(1, sum / (scanTotal * T)), `counted ${Math.round(sum / T).toLocaleString('en-US')} of ${scanTotal.toLocaleString('en-US')} tokens`);
      }
    }));
    const counted = await Promise.all(channels.map((c) => c.next('counted')));
    const rowSums = new Float64Array(nTargets), colSums = new Float64Array(nContexts);
    let pairs = 0, total = 0;
    for (const m of counted) {
      for (let i = 0; i < nTargets; i++) rowSums[i] += m.rowSums[i];
      for (let c = 0; c < nContexts; c++) colSums[c] += m.colSums[c];
      pairs += m.pairs;
      total += m.total;
    }
    const { colAlpha, sumAlpha } = contextWeights(colSums, alpha);
    const margins = { rowSums: toShared(rowSums), colAlpha: toShared(colAlpha), sumAlpha };
    workers.forEach((w) => w.postMessage({ type: 'ppmi', ...margins }));
    const rowNnz = new Float64Array(nTargets);
    for (const m of await Promise.all(channels.map((c) => c.next('rownnz')))) for (let i = 0; i < nTargets; i++) rowNnz[i] += m.nnz[i];
    const rowPtr = shared(Float64Array, nTargets + 1);
    for (let i = 0; i < nTargets; i++) rowPtr[i + 1] = rowPtr[i] + rowNnz[i];
    const nnz = rowPtr[nTargets];
    const colIdx = shared(nContexts <= 0xffff ? Uint16Array : Uint32Array, nnz);
    const vals = shared(Float32Array, nnz);
    workers.forEach((w) => w.postMessage({ type: 'write', rowPtr, colIdx, vals }));
    await Promise.all(channels.map((c) => c.next('written')));
    return { csr: { rows: nTargets, cols: nContexts, nnz, rowPtr, colIdx, vals }, pairs, total, rowSums, colSums };
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

function rangeTokens(ranges) {
  let n = 0;
  for (let r = 0; r < ranges.length; r += 2) n += ranges[r + 1] - ranges[r];
  return n;
}

function inProcess(input, { window, alpha, startLog2, onProgress, tick, scanTotal }) {
  const { nTargets, nContexts } = input;
  const all = Array.from({ length: SHARDS }, (_, s) => s);
  const tables = countShards({ ...input, window, shards: all, totalShards: SHARDS, startLog2 }, {
    onProgress: (n) => { tick(); onProgress(n / scanTotal, `counted ${n.toLocaleString('en-US')} of ${scanTotal.toLocaleString('en-US')} tokens`); },
  });
  const rowSums = new Float64Array(nTargets), colSums = new Float64Array(nContexts);
  let pairs = 0, total = 0;
  for (const tab of tables.values()) {
    const m = tableMargins(tab, nTargets, nContexts);
    for (let i = 0; i < nTargets; i++) rowSums[i] += m.rowSums[i];
    for (let c = 0; c < nContexts; c++) colSums[c] += m.colSums[c];
    pairs += m.pairs;
    total += m.total;
  }
  tick();
  const { colAlpha, sumAlpha } = contextWeights(colSums, alpha);
  const rowNnz = new Float64Array(nTargets);
  for (const tab of tables.values()) {
    const n = ppmiRowCounts(tab, { rowSums, colAlpha, sumAlpha, nTargets, nContexts });
    for (let i = 0; i < nTargets; i++) rowNnz[i] += n[i];
  }
  const rowPtr = new Float64Array(nTargets + 1);
  for (let i = 0; i < nTargets; i++) rowPtr[i + 1] = rowPtr[i] + rowNnz[i];
  const nnz = rowPtr[nTargets];
  const colIdx = nContexts <= 0xffff ? new Uint16Array(nnz) : new Uint32Array(nnz);
  const vals = new Float32Array(nnz);
  for (const tab of tables.values()) {
    tick();
    ppmiWrite(tab, { rowSums, colAlpha, sumAlpha, nTargets, nContexts, rowPtr, colIdx, vals });
  }
  return Promise.resolve({ csr: { rows: nTargets, cols: nContexts, nnz, rowPtr, colIdx, vals }, pairs, total, rowSums, colSums });
}

/**
 * Message channel over a worker: next(type) resolves with the next message of that type; an error, an exit
 * or an abort rejects every waiter.
 */
function channel(worker, signal, onOther) {
  const queue = [];
  const waiters = [];
  let failure = null;
  const fail = (err) => {
    failure ??= err;
    while (waiters.length) waiters.shift().reject(failure);
  };
  worker.on('message', (m) => {
    if (m?.type === 'progress') { onOther(m); return; }
    if (m?.type === 'error') { fail(Object.assign(new Error(m.message), { code: m.code ?? 'E_KERNEL' })); return; }
    const i = waiters.findIndex((w) => w.type === m?.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  worker.on('error', fail);
  worker.on('exit', (code) => fail(signal?.aborted ? signal.reason : new Error(`co-occurrence worker exited (${code})`)));
  return {
    next(type) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
    },
  };
}

// ── Worker entry ─────────────────────────────────────────────────────────────────────────────────────

function kernelMain(job) {
  const { nTargets, nContexts } = job;
  let tables;
  try {
    tables = countShards(job, { onProgress: (scanned) => parentPort.postMessage({ type: 'progress', scanned }) });
    const rowSums = new Float64Array(nTargets), colSums = new Float64Array(nContexts);
    let pairs = 0, total = 0;
    for (const tab of tables.values()) {
      const m = tableMargins(tab, nTargets, nContexts);
      for (let i = 0; i < nTargets; i++) rowSums[i] += m.rowSums[i];
      for (let c = 0; c < nContexts; c++) colSums[c] += m.colSums[c];
      pairs += m.pairs;
      total += m.total;
    }
    parentPort.postMessage({ type: 'counted', rowSums, colSums, pairs, total }, [rowSums.buffer, colSums.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message ?? err), code: err?.code ?? null });
    return;
  }
  let margins = null;
  parentPort.on('message', (m) => {
    try {
      if (m.type === 'ppmi') {
        margins = { rowSums: m.rowSums, colAlpha: m.colAlpha, sumAlpha: m.sumAlpha, nTargets, nContexts };
        const nnz = new Uint32Array(nTargets);
        for (const tab of tables.values()) {
          const n = ppmiRowCounts(tab, margins);
          for (let i = 0; i < nTargets; i++) nnz[i] += n[i];
        }
        parentPort.postMessage({ type: 'rownnz', nnz }, [nnz.buffer]);
      } else if (m.type === 'write') {
        for (const tab of tables.values()) ppmiWrite(tab, { ...margins, rowPtr: m.rowPtr, colIdx: m.colIdx, vals: m.vals });
        tables = null;
        parentPort.postMessage({ type: 'written' });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: String(err?.message ?? err), code: err?.code ?? null });
    }
  });
}

if (!isMainThread && workerData?.[KERNEL] === true) kernelMain(workerData);
