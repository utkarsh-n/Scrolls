// OWNER: WP0 — job rows: ids from one shared counter, so a row can be written later than its id is handed out
//
// The main thread must never wait on a job's write lock to queue a job (a writer may hold one transaction for
// many seconds). It takes the id from a counter in a SharedArrayBuffer that the queue shares with every job
// worker, answers at once and writes the row when the lock is free (queue.mjs write-behind). A worker that queues
// a follow-up job inside its own transaction takes its id from the same counter, so the two never collide.

import { JOB_TYPES } from '../../src/shared/vocab.mjs';
import { nowIso, stmt } from '../db/open.mjs';

const COLUMNS = ['id', 'type', 'params_json', 'writes', 'priority', 'status', 'created_at'];
const INSERT_SQL = `INSERT INTO job (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

/** @returns {Int32Array} a fresh id counter cell (its buffer is what job workers receive) */
export function createJobIdCell() {
  return new Int32Array(new SharedArrayBuffer(4));
}

/**
 * The next job id: above every committed row this connection can see and above every id already handed out
 * through `cell`, so ids still waiting to be written are never reused.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Int32Array} cell shared counter (the last id handed out)
 * @returns {number}
 */
export function allocateJobId(db, cell) {
  const floor = Number(stmt(db, 'SELECT max(id) AS m FROM job').get().m ?? 0);
  for (;;) {
    const cur = Atomics.load(cell, 0);
    const next = Math.max(cur, floor) + 1;
    if (Atomics.compareExchange(cell, 0, cur, next) === cur) return next;
  }
}

/**
 * A queued job row (DB columns), not yet written.
 * @param {number} id from allocateJobId
 * @param {string} type a vocab.JOB_TYPES key (the caller validated it)
 * @param {object} [params]
 * @param {{priority?: number, writes?: boolean}} [opts] `writes: true` makes a job exclusive (never the reverse)
 * @returns {object}
 */
export function newJobRow(id, type, params = {}, { priority, writes } = {}) {
  const def = JOB_TYPES[type];
  return {
    id, type, params_json: JSON.stringify(params ?? {}), writes: def.writes || writes === true ? 1 : 0,
    priority: Number.isInteger(priority) ? priority : def.priority, status: 'queued', progress: 0, phase: null,
    message: null, counts_json: null, cancel_requested: 0, run_id: null, result_json: null, error_json: null,
    created_at: nowIso(), started_at: null, finished_at: null, heartbeat_at: null,
  };
}

/**
 * Write a row made by newJobRow (on the caller's connection and, when one is open, in its transaction).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row
 */
export function insertJobRow(db, row) {
  stmt(db, INSERT_SQL).run(...COLUMNS.map((c) => row[c]));
}
