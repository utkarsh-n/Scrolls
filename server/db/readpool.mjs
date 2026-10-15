// OWNER: WP0 — read-only worker pool for heavy queries (SPEC §4.12, D11)
//
// ReadPool = { run(moduleUrl, fnName, args, { timeoutMs = 5000 }), stats(), close() }
// Heavy query functions have the signature `export function xxxQuery(db, args) → plain JSON` and run in a
// worker with its own readOnly connection. A query exceeding its timeout terminates that worker (the only
// way to stop synchronous SQLite work), a fresh worker takes its place and the promise rejects with
// HttpError(503, 'QUERY_TIMEOUT').

import { Worker } from 'node:worker_threads';
import { FLAGS, log, paths } from '../config.mjs';
import { HttpError } from '../http/errors.mjs';

const WORKER_URL = new URL('./readworker.mjs', import.meta.url);

function rebuildError(e) {
  if (e && Number.isInteger(e.status) && typeof e.code === 'string') {
    return new HttpError(e.status, e.code, e.message, e.hint ?? null, e.detail ?? null);
  }
  const err = new Error(e?.message ?? 'read query failed');
  if (e?.code) err.code = e.code;
  if (e?.errcode !== undefined) err.errcode = e.errcode;
  if (e?.stack) err.workerStack = e.stack;
  return err;
}

/**
 * @param {{size?: number, dbPath?: string}} [opts]
 * @returns {{run(moduleUrl: string, fnName: string, args?: object, opts?: {timeoutMs?: number}): Promise<any>,
 *   stats(): {size: number, busy: number, queued: number}, close(): Promise<void>}}
 */
export function startReadPool({ size = FLAGS.readWorkers, dbPath = paths().db } = {}) {
  const slots = [];
  const queue = [];
  let nextId = 1;
  let closing = false;

  function spawn(slot) {
    const worker = new Worker(WORKER_URL, { workerData: { dbPath } });
    slot.worker = worker;
    slot.task = null;
    slot.spawnedAt = Date.now();
    worker.on('message', (msg) => {
      const task = slot.task;
      if (!task || msg.id !== task.id) return;
      clearTimeout(task.timer);
      slot.task = null;
      if (msg.ok) task.resolve(msg.result); else task.reject(rebuildError(msg.error));
      pump();
    });
    worker.on('error', (err) => {
      log('error', 'read worker crashed', { error: String(err?.stack ?? err) });
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return; // replaced after a timeout (or already being replaced)
      const task = slot.task;
      slot.task = null;
      if (task) {
        clearTimeout(task.timer);
        task.reject(new HttpError(500, 'E_READ_WORKER', `The read worker stopped (exit ${code}).`, 'Try again.'));
      }
      if (closing) return;
      // A worker that dies right after starting (e.g. the database cannot be opened) is restarted with a
      // growing delay instead of in a tight loop.
      slot.failures = Date.now() - slot.spawnedAt < 1000 ? (slot.failures ?? 0) + 1 : 0;
      slot.worker = null;
      const delay = slot.failures ? Math.min(30000, 100 * 2 ** slot.failures) : 0;
      setTimeout(() => { if (!closing) { spawn(slot); pump(); } }, delay).unref?.();
    });
  }

  for (let i = 0; i < Math.max(1, size); i++) {
    const slot = { worker: null, task: null, spawnedAt: 0, failures: 0 };
    slots.push(slot);
    spawn(slot);
  }

  function timeout(slot, task) {
    if (slot.task !== task) return;
    const old = slot.worker;
    slot.task = null;
    task.reject(new HttpError(503, 'QUERY_TIMEOUT', `The query took longer than ${task.timeoutMs} ms and was stopped.`,
      'Narrow the time range or filters, or wait for indexing jobs to finish, then retry.',
      { module: task.moduleUrl, fn: task.fnName, timeoutMs: task.timeoutMs }));
    spawn(slot);
    old.terminate().catch(() => {});
    pump();
  }

  function pump() {
    for (const slot of slots) {
      if (!queue.length) return;
      if (slot.task || !slot.worker) continue;
      const task = queue.shift();
      slot.task = task;
      task.timer = setTimeout(() => timeout(slot, task), task.timeoutMs);
      slot.worker.postMessage({ id: task.id, moduleUrl: task.moduleUrl, fnName: task.fnName, args: task.args });
    }
  }

  return {
    run(moduleUrl, fnName, args = {}, { timeoutMs = 5000 } = {}) {
      if (closing) return Promise.reject(new HttpError(503, 'E_SHUTTING_DOWN', 'The server is shutting down.'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, moduleUrl: String(moduleUrl), fnName, args, timeoutMs, resolve, reject, timer: null });
        pump();
      });
    },
    stats() {
      return { size: slots.length, busy: slots.filter((s) => s.task).length, queued: queue.length };
    },
    async close() {
      closing = true;
      for (const task of queue.splice(0)) task.reject(new HttpError(503, 'E_SHUTTING_DOWN', 'The server is shutting down.'));
      await Promise.all(slots.map(async (slot) => {
        if (slot.task) {
          clearTimeout(slot.task.timer);
          slot.task.reject(new HttpError(503, 'E_SHUTTING_DOWN', 'The server is shutting down.'));
          slot.task = null;
        }
        await slot.worker?.terminate();
      }));
    },
  };
}
