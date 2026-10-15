// OWNER: WP0 — the job queue: priorities, one writer at a time, ≤ 2 read-only jobs, cancellation (SPEC §4.12, D11)
//
// JobQueue = { enqueue, cancel, get, list, recoverInterrupted, onEvent } (+ waitFor, hasTask, close).
// Each job runs in its own worker thread (worker.mjs). The main thread never waits on a job's write lock:
// progress and state changes are kept in memory (what get/list return) and written to job/job_event by a
// write-behind flush that gives up after 10 ms when a job holds the lock, and retries. Queuing a job never waits
// either (M5 gate item 9): its id comes from a counter shared with the job workers (job-rows.mjs) and, while a
// job holds the lock, the row stays pending in memory — visible to get/list/counts/cancel at once — and is
// written by the next flush; the pending write takes part in the interactive-write handoff (open.mjs), so a
// cooperative bulk writer steps aside for it. A pending job starts once its row is written.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { JOB_TYPES } from '../../src/shared/vocab.mjs';
import { log, paths } from '../config.mjs';
import { announceWrite, BUSY_TIMEOUT_MS, dataVersion, isBusyError, isConstraintError, nowIso, stmt, WRITE_YIELD_BUFFER } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { rollbackBatch } from '../store/document-writer.mjs';
import { allocateJobId, createJobIdCell, insertJobRow, newJobRow } from './job-rows.mjs';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const FLUSH_MS = 250;
const FLUSH_BUSY_MS = 10;
/** Retry interval while queued rows wait to be written (busy timeout 0: the poll, not the loop, waits). */
const PENDING_RETRY_MS = 20;
const EVENT_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 5000;
const LIVE_FIELDS = ['status', 'progress', 'phase', 'message', 'counts_json', 'run_id', 'result_json', 'error_json',
  'started_at', 'finished_at', 'cancel_requested', 'heartbeat_at'];
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

const parse = (s) => {
  if (s === null || s === undefined) return null;
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * The API form of a job row (§7.2 Job shape).
 * @param {object} row job row (DB columns)
 * @returns {object}
 */
export function toJobJson(row) {
  return {
    id: row.id, type: row.type, status: row.status, progress: row.progress ?? 0, phase: row.phase ?? null,
    message: row.message ?? null, counts: parse(row.counts_json), run_id: row.run_id ?? null,
    result: parse(row.result_json), error: parse(row.error_json), params: parse(row.params_json) ?? {},
    writes: row.writes === 1, priority: row.priority, created_at: row.created_at, started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db the main connection
 * @param {{bus?: import('node:events').EventEmitter|null, dbPath?: string, maxReaders?: number, cancelGraceMs?: number}} [opts]
 */
export function createJobQueue(db, { bus = null, dbPath = paths().db, maxReaders = 2, cancelGraceMs = 10000 } = {}) {
  const running = new Map();   // jobId → { worker, flag, writes, type, cancelRequested, killTimer }
  const live = new Map();      // jobId → overlay of LIVE_FIELDS not yet (or just) persisted
  const dirty = new Set();     // jobIds whose overlay must be written
  const pendingRows = new Map(); // jobId → queued job row not written yet (a job held the lock)
  const events = [];           // job_event rows waiting to be written
  const failRuns = [];         // [jobId, status]: runs a dead worker left 'running'
  const listeners = new Set();
  const waiters = new Map();   // jobId → [resolve]
  const lastEventAt = new Map();
  const idCell = createJobIdCell();
  Atomics.store(idCell, 0, Number(stmt(db, 'SELECT max(id) AS m FROM job').get().m ?? 0));
  let lastDataVersion = dataVersion(db);
  let closed = false;
  let flushTimer = null;
  let heartbeatAt = 0;
  let releasePending = null;   // the handoff announcement held while pendingRows is not empty

  // ── persistence (write-behind) ──

  function overlay(id, fields) {
    live.set(id, { ...(live.get(id) ?? {}), ...fields });
    dirty.add(id);
    scheduleFlush();
  }

  function addEvent(jobId, level, phase, progress, message, data = null) {
    events.push([jobId, nowIso(), level, phase ?? null, progress ?? null, message ?? null, data === null ? null : JSON.stringify(data)]);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (closed) return;
    const ms = pendingRows.size ? PENDING_RETRY_MS : FLUSH_MS;
    if (flushTimer) {
      if (!pendingRows.size || flushTimer.ms <= ms) return;
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => { flushTimer = null; flush({ busyMs: pendingRows.size ? 0 : FLUSH_BUSY_MS }); }, ms);
    flushTimer.ms = ms;
    flushTimer.unref?.();
  }

  /**
   * Hold a queued row until the lock is free. While any row waits, the handoff is announced, so a cooperative
   * writer (tx(), DocumentWriter) steps aside before its next transaction and the retry gets in.
   */
  function addPending(row) {
    pendingRows.set(row.id, row);
    releasePending ??= announceWrite();
    scheduleFlush();
  }

  /**
   * Write a queued row now if that needs no wait: inside a transaction this connection already holds (a route's
   * write), or when the lock is free. Rows queued earlier and still pending go first.
   * @returns {boolean}
   */
  function insertNow(row) {
    if (db.isTransaction) {
      insertJobRow(db, row);
      return true;
    }
    if (pendingRows.size) return false;
    db.exec('PRAGMA busy_timeout = 0');
    try {
      insertJobRow(db, row);
      return true;
    } catch (err) {
      if (isBusyError(err)) return false;
      throw err;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  /** Write the overlay; returns false (and keeps it) when a job holds the write lock. */
  function flush({ busyMs = FLUSH_BUSY_MS } = {}) {
    const now = Date.now();
    if (running.size && now - heartbeatAt >= HEARTBEAT_MS) {
      heartbeatAt = now;
      const iso = nowIso();
      for (const id of running.keys()) overlay(id, { heartbeat_at: iso });
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty.size && !events.length && !failRuns.length && !pendingRows.size) return true;
    if (db.isTransaction) { // called while a route holds a transaction on this connection: try again shortly
      scheduleFlush();
      return false;
    }
    db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    const refused = [];
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of pendingRows.values()) {
          // a row someone else wrote under the same id (never through this queue) must not block every later flush
          try { insertJobRow(db, row); } catch (err) { if (isConstraintError(err)) refused.push([row.id, err]); else throw err; }
        }
        for (const id of dirty) {
          const o = live.get(id);
          if (!o) continue;
          const keys = LIVE_FIELDS.filter((k) => k in o);
          if (!keys.length) continue;
          stmt(db, `UPDATE job SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => o[k]), id);
        }
        const refusedIds = new Set(refused.map(([id]) => id));
        const ins = stmt(db, 'INSERT INTO job_event (job_id, at, level, phase, progress, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const e of events) if (!refusedIds.has(e[0])) ins.run(...e);
        for (const [jobId, status] of failRuns) {
          stmt(db, "UPDATE analysis_run SET status = ?, finished_at = ? WHERE job_id = ? AND status = 'running'").run(status, nowIso(), jobId);
        }
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
      for (const [id, err] of refused) {
        log('error', `job ${id} could not be recorded: the id is taken`, { error: String(err?.message ?? err) });
        live.delete(id);
      }
      const inserted = pendingRows.size - refused.length;
      for (const id of dirty) if (FINAL.has(live.get(id)?.status) && !running.has(id)) live.delete(id);
      dirty.clear();
      events.length = 0;
      failRuns.length = 0;
      pendingRows.clear();
      releasePending?.();
      releasePending = null;
      if (inserted > 0) setImmediate(schedule);
      return true;
    } catch (err) {
      if (!isBusyError(err)) log('error', 'job state flush failed', { error: String(err?.stack ?? err) });
      scheduleFlush();
      return false;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  // ── events ──

  function emit(ev) {
    for (const fn of listeners) {
      try { fn(ev); } catch (err) { log('error', 'job listener failed', { error: String(err) }); }
    }
    if (!bus) return;
    bus.emit('job', ev);
    // Contract 1.2.0 (M5 gate): the 'adapter' and 'bootstrap' channels carry only the objects their tasks emit
    // (AdapterEvent; BootstrapEvent = the Health.cipher object). Forwarding the job events there too mixed two shapes
    // on one channel (the UI merged a job's status 'running' into health.cipher). Job progress stays on 'job'.
  }

  function checkDataVersion() {
    const v = dataVersion(db);
    if (v !== lastDataVersion) {
      lastDataVersion = v;
      bus?.emit('data', { dataVersion: v });
    }
  }

  // ── reading ──

  function rowOf(id) {
    const row = stmt(db, 'SELECT * FROM job WHERE id = ?').get(id) ?? pendingRows.get(id);
    if (!row) return null;
    const o = live.get(id);
    return o ? { ...row, ...o } : { ...row };
  }

  /** Queue a row: written now when the lock is free, else held (visible at once) and written by the next flush. */
  function queueRow(row) {
    if (!insertNow(row)) addPending(row);
    emit({ event: 'queued', job: row.id, type: row.type, status: 'queued', phase: null, fraction: 0, message: null, counts: null });
    setImmediate(schedule);
  }

  // ── running jobs ──

  /**
   * A worker that was terminated never ran its own rollback: its open transaction died with its connection, but
   * import batches it had already flushed stay 'committing' with partial rows. Roll them back as boot recovery
   * would (zero documents from an unfinished batch), now that the thread has exited and released the lock.
   */
  function rollbackTerminatedBatches(id) {
    let batches = [];
    try {
      batches = stmt(db, "SELECT id FROM import_batch WHERE status = 'committing' AND job_id = ?").all(id);
    } catch (err) {
      log('error', `job ${id}: could not list its unfinished import batches`, { error: String(err) });
    }
    for (const b of batches) {
      try {
        const n = rollbackBatch(db, b.id, { status: 'cancelled' });
        log('warn', `rolled back unfinished import batch ${b.id} (${n} documents) of terminated job ${id}`);
      } catch (err) {
        log('error', `job ${id}: rollback of import batch ${b.id} failed; boot recovery will retry`, { error: String(err) });
      }
    }
  }

  function finish(id, status, { result = null, error = null } = {}) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    lastEventAt.delete(id);
    clearTimeout(r.killTimer);
    if (r.terminated && r.writes) rollbackTerminatedBatches(id);
    if (r.shutdown) status = 'interrupted';
    const o = live.get(id) ?? {};
    const fields = { status, finished_at: nowIso(), result_json: result === null ? null : JSON.stringify(result),
      error_json: error === null ? null : JSON.stringify(error) };
    if (status === 'succeeded') fields.progress = 1;
    overlay(id, fields);
    if (status !== 'succeeded') failRuns.push([id, status === 'cancelled' ? 'cancelled' : 'failed']);
    addEvent(id, status === 'failed' ? 'error' : 'info', o.phase ?? null, status === 'succeeded' ? 1 : o.progress ?? null,
      status === 'failed' ? `failed: ${error?.message ?? 'unknown error'}` : status);
    flush();
    emit({ event: 'done', job: id, type: r.type, status, run_id: o.run_id ?? null, error });
    checkDataVersion();
    for (const resolve of waiters.get(id) ?? []) resolve(rowOf(id));
    waiters.delete(id);
    setImmediate(schedule);
  }

  function onMessage(id, msg) {
    const r = running.get(id);
    if (!r || !msg) return;
    switch (msg.kind) {
      case 'progress': {
        const status = r.cancelRequested ? 'cancelling' : 'running';
        const prev = live.get(id) ?? {};
        overlay(id, { status, progress: msg.fraction, phase: msg.phase ?? null, message: msg.message ?? null,
          counts_json: msg.counts ? JSON.stringify(msg.counts) : prev.counts_json ?? null });
        const t = Date.now();
        if (msg.phase !== prev.phase || t - (lastEventAt.get(id) ?? 0) >= EVENT_INTERVAL_MS) {
          lastEventAt.set(id, t);
          addEvent(id, 'info', msg.phase, msg.fraction, msg.message, msg.counts ?? null);
        }
        emit({ event: 'progress', job: id, type: r.type, status, phase: msg.phase ?? null, fraction: msg.fraction,
          message: msg.message ?? null, counts: msg.counts ?? null });
        break;
      }
      case 'log':
        addEvent(id, msg.level, live.get(id)?.phase ?? null, live.get(id)?.progress ?? null, msg.message, msg.data ?? null);
        log(msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'debug', `job ${id} (${r.type}): ${msg.message}`, msg.data ?? undefined);
        break;
      case 'run':
        if (!live.get(id)?.run_id) overlay(id, { run_id: msg.runId });
        break;
      case 'enqueued':
        setImmediate(schedule);
        break;
      case 'enqueue': // a follow-up job of a task outside any transaction: its row is written here
        if (msg.row && Number.isInteger(msg.row.id) && Object.hasOwn(JOB_TYPES, msg.row.type)) queueRow(msg.row);
        break;
      case 'emit':
        bus?.emit(msg.event, msg.data);
        if (msg.event === 'data') checkDataVersion();
        break;
      case 'done':
        finish(id, msg.status, { result: msg.result ?? null, error: msg.error ?? null });
        break;
      default:
        break;
    }
  }

  function start(job) {
    const cancelBuf = new SharedArrayBuffer(4);
    const flag = new Int32Array(cancelBuf);
    let params;
    try { params = JSON.parse(job.params_json); } catch { params = {}; }
    const worker = new Worker(WORKER_URL, { workerData: { jobId: job.id, type: job.type, params, dbPath, cancelBuf,
      yieldBuf: WRITE_YIELD_BUFFER, jobIdBuf: idCell.buffer, writes: job.writes === 1 } });
    const r = { worker, flag, writes: job.writes === 1, type: job.type, cancelRequested: false, shutdown: false, killTimer: null };
    running.set(job.id, r);
    overlay(job.id, { status: 'running', started_at: nowIso(), heartbeat_at: nowIso(), progress: 0 });
    addEvent(job.id, 'info', null, 0, 'started');
    flush(); // persist 'running' now, so a crash right after the start is recovered as 'interrupted', not re-run
    emit({ event: 'started', job: job.id, type: job.type, status: 'running', phase: null, fraction: 0, message: null, counts: null });
    worker.on('message', (msg) => onMessage(job.id, msg));
    worker.on('error', (err) => {
      log('error', `job ${job.id} (${job.type}) worker error`, { error: String(err?.stack ?? err) });
      finish(job.id, running.get(job.id)?.cancelRequested ? 'cancelled' : 'failed', { error: { message: String(err?.message ?? err), code: err?.code ?? null } });
    });
    worker.on('exit', (code) => {
      if (!running.has(job.id)) return;
      const cancelled = running.get(job.id).cancelRequested;
      finish(job.id, cancelled ? 'cancelled' : 'failed', { error: cancelled ? null : { message: `The job worker stopped (exit ${code}).`, code: 'E_WORKER_EXIT' } });
    });
  }

  function schedule() {
    if (closed) return;
    let writers = 0, readers = 0;
    for (const r of running.values()) if (r.writes) writers++; else readers++;
    if (writers >= 1 && readers >= maxReaders) return;
    const queued = stmt(db, "SELECT * FROM job WHERE status = 'queued' ORDER BY priority, created_at, id").all();
    for (const job of queued) {
      if (running.has(job.id) || (live.get(job.id)?.status ?? 'queued') !== 'queued') continue;
      if (job.writes === 1) {
        if (writers >= 1) continue;
        writers++;
      } else {
        if (readers >= maxReaders) continue;
        readers++;
      }
      start(job);
    }
  }

  // ── public API ──

  const queue = {
    /**
     * Queue a job. Never waits for the write lock: while a job holds it, the row is kept in memory (get, list,
     * counts and cancel see it at once) and written as soon as the lock is free; the job starts after that.
     * @param {string} type vocab.JOB_TYPES key
     * @param {object} [params]
     * @param {{priority?: number, writes?: boolean}} [opts] `writes: true` makes a job exclusive (never the reverse)
     * @returns {number} job id
     */
    enqueue(type, params = {}, { priority, writes } = {}) {
      if (closed) throw new HttpError(503, 'E_SHUTTING_DOWN', 'The server is shutting down.');
      if (!Object.hasOwn(JOB_TYPES, type)) {
        throw new HttpError(400, 'E_JOB_TYPE', `Unknown job type '${type}'.`, `Known types: ${Object.keys(JOB_TYPES).join(', ')}.`);
      }
      const row = newJobRow(allocateJobId(db, idCell), type, params, { priority, writes });
      queueRow(row);
      return row.id;
    },

    /** @returns {number} queued rows not written yet (a job holds the write lock) */
    pendingWrites() {
      return pendingRows.size;
    },

    /**
     * Request cancellation. A queued job is cancelled at once; a running one gets its flag set and is
     * 'cancelling' until its next checkpoint (≤ 500 ms for well-behaved tasks); a task that never checks is
     * terminated after the grace period.
     * @param {number} id
     * @returns {'cancelling'|'cancelled'|'finished'|'not_found'}
     */
    cancel(id) {
      const r = running.get(id);
      if (r) {
        if (r.cancelRequested) return 'cancelling';
        r.cancelRequested = true;
        Atomics.store(r.flag, 0, 1);
        Atomics.notify(r.flag, 0);
        r.worker.postMessage({ kind: 'cancel' });
        overlay(id, { status: 'cancelling', cancel_requested: 1 });
        addEvent(id, 'info', live.get(id)?.phase ?? null, live.get(id)?.progress ?? null, 'cancel requested');
        emit({ event: 'progress', job: id, type: r.type, status: 'cancelling', phase: live.get(id)?.phase ?? null,
          fraction: live.get(id)?.progress ?? 0, message: 'cancelling', counts: null });
        r.killTimer = setTimeout(() => {
          if (!running.has(id)) return;
          log('warn', `job ${id} (${r.type}) ignored cancellation for ${cancelGraceMs} ms; terminating its worker`);
          // M5 gate: the job stays 'cancelling' and keeps its slot until the thread has really exited. terminate()
          // cannot stop a synchronous SQLite step, and until that step returns the worker's connection still holds
          // the write lock; freeing the slot earlier let the next writer (and every interactive write) hit E_BUSY.
          // The 'exit' handler finishes the job; terminated: true makes it roll back the batches the job left open.
          r.terminated = true;
          overlay(id, { message: 'stopping: waiting for the current database step to end' });
          r.worker.terminate().catch(() => {});
        }, cancelGraceMs);
        r.killTimer.unref?.();
        return 'cancelling';
      }
      const row = rowOf(id);
      if (!row) return 'not_found';
      if (row.status === 'queued') {
        overlay(id, { status: 'cancelled', cancel_requested: 1, finished_at: nowIso() });
        addEvent(id, 'info', null, 0, 'cancelled before start');
        flush();
        emit({ event: 'done', job: id, type: row.type, status: 'cancelled', run_id: null, error: null });
        for (const resolve of waiters.get(id) ?? []) resolve(rowOf(id));
        waiters.delete(id);
        return 'cancelled';
      }
      return row.status === 'cancelling' ? 'cancelling' : 'finished';
    },

    /** @param {number} id @returns {object|null} job row (DB columns, live state applied) */
    get(id) {
      return rowOf(id);
    },

    /**
     * @param {{status?: string|null, limit?: number, beforeId?: number|null}} [opts]
     * @returns {object[]} newest first
     */
    list({ status = null, limit = 200, beforeId = null } = {}) {
      const rows = stmt(db, 'SELECT * FROM job WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?')
        .all(beforeId, beforeId, status ? 5000 : limit);
      const pending = [...pendingRows.values()].filter((r) => beforeId === null || r.id < beforeId);
      const all = pending.length ? [...rows, ...pending].sort((a, b) => b.id - a.id) : rows;
      const merged = all.map((row) => (live.has(row.id) ? { ...row, ...live.get(row.id) } : row));
      return (status ? merged.filter((r) => r.status === status) : merged).slice(0, limit);
    },

    /** @returns {{running: number, queued: number}} */
    counts() {
      const ids = [...stmt(db, "SELECT id FROM job WHERE status = 'queued'").all().map((r) => r.id), ...pendingRows.keys()];
      const queued = ids.filter((id) => (live.get(id)?.status ?? 'queued') === 'queued' && !running.has(id)).length;
      return { running: running.size, queued };
    },

    /**
     * Boot recovery: jobs left running/cancelling become 'interrupted', their runs 'failed', and import
     * batches they left half-written are rolled back (zero documents from an unfinished batch).
     * @returns {number} jobs marked interrupted
     */
    recoverInterrupted() {
      const at = nowIso();
      const ids = stmt(db, "SELECT id FROM job WHERE status IN ('running', 'cancelling')").all().map((r) => r.id);
      db.exec('BEGIN IMMEDIATE');
      try {
        stmt(db, "UPDATE job SET status = 'interrupted', finished_at = ?, message = 'interrupted: the server stopped while this job ran' WHERE status IN ('running', 'cancelling')").run(at);
        stmt(db, "UPDATE analysis_run SET status = 'failed', finished_at = ?, notes = 'interrupted: the server stopped while this run was open' WHERE status = 'running'").run(at);
        for (const id of ids) stmt(db, 'INSERT INTO job_event (job_id, at, level, message) VALUES (?, ?, ?, ?)').run(id, at, 'warn', 'interrupted by a restart');
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
      const jobSet = JSON.stringify(ids);
      const batches = stmt(db, `SELECT b.id FROM import_batch b WHERE b.status = 'committing'
        AND (b.job_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM document d WHERE d.import_batch_id = b.id))`).all(jobSet);
      for (const b of batches) {
        const n = rollbackBatch(db, b.id, { status: 'failed' });
        log('warn', `rolled back unfinished import batch ${b.id} (${n} documents) after a restart`);
      }
      return ids.length;
    },

    /** @param {(ev: object) => void} fn @returns {() => void} unsubscribe */
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Resolve with the job row once it is final (or null after timeoutMs).
     * @param {number} id
     * @param {{timeoutMs?: number}} [opts]
     * @returns {Promise<object|null>}
     */
    waitFor(id, { timeoutMs = 30000 } = {}) {
      const row = rowOf(id);
      if (!row) return Promise.resolve(null);
      if (FINAL.has(row.status)) return Promise.resolve(row);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const list = waiters.get(id) ?? [];
          waiters.set(id, list.filter((f) => f !== done));
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        const done = (r) => { clearTimeout(timer); resolve(r); };
        waiters.set(id, [...(waiters.get(id) ?? []), done]);
      });
    },

    /** Whether tasks/<type>.mjs exists (boot skips jobs whose package has not landed). @param {string} type */
    hasTask(type) {
      return Object.hasOwn(JOB_TYPES, type) && existsSync(fileURLToPath(new URL(`./tasks/${type}.mjs`, import.meta.url)));
    },

    /** Start queued jobs (called after recovery and whenever capacity frees up). */
    schedule,

    /**
     * Stop: running jobs are cancelled, then terminated, and recorded as 'interrupted'.
     * @returns {Promise<void>}
     */
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(flushTimer);
      const stops = [...running.entries()].map(async ([id, r]) => {
        clearTimeout(r.killTimer);
        r.shutdown = true;
        Atomics.store(r.flag, 0, 1);
        r.worker.postMessage({ kind: 'cancel' });
        const exited = new Promise((res) => r.worker.once('exit', res));
        const t = setTimeout(() => r.worker.terminate().catch(() => {}), 1000);
        // terminate() waits for a synchronous SQLite step to return; do not let one hang shutdown. The open
        // transaction dies with the process (WAL), and boot recovery rolls back the batch it left 'committing'.
        let giveUp;
        const bounded = new Promise((res) => { giveUp = setTimeout(res, 15000); giveUp.unref?.(); });
        await Promise.race([exited, bounded]);
        clearTimeout(giveUp);
        clearTimeout(t);
        if (running.has(id)) {
          running.delete(id);
          overlay(id, { status: 'interrupted', finished_at: nowIso(), message: 'interrupted: the server stopped' });
          failRuns.push([id, 'failed']);
        }
      });
      await Promise.all(stops);
      for (const [id, list] of waiters) for (const resolve of list) resolve(rowOf(id));
      waiters.clear();
      flush({ busyMs: BUSY_TIMEOUT_MS });
      if (pendingRows.size) log('warn', `${pendingRows.size} queued job(s) could not be written before shutdown`, { ids: [...pendingRows.keys()] });
      releasePending?.();
      releasePending = null;
    },
  };
  return queue;
}
