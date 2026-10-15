// OWNER: WP4
// commit.mjs — how analysis jobs write (SPEC §4.12): everything is computed first, from one consistent read of the
// inputs, and the rows of a run are written at the end in short transactions. Each write is retried while another
// connection holds the write lock (SQLITE_BUSY after the connection's 5 s busy timeout), with a cancellation
// checkpoint between attempts, so an analysis job never needs the queue's exclusive writer slot to finish: it waits
// for the lock only for its own few-millisecond commits.

import { isBusyError } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { inputFingerprint } from '../jobs/context.mjs';

/** How long a commit keeps retrying before the job fails with the busy error (a writer holding the lock this long is stuck). */
export const COMMIT_RETRY_MS = 120000;
const PAUSE_MS = 50;
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run a short write and retry it while the database is busy.
 * @template T
 * @param {() => T} fn one statement or one transaction (tx()); it must be safe to run again after a busy error
 * @param {{checkpoint?: () => void, maxMs?: number}} [opts] checkpoint throws when the job was cancelled
 * @returns {T}
 */
export function retryBusy(fn, { checkpoint = () => {}, maxMs = COMMIT_RETRY_MS } = {}) {
  const until = Date.now() + maxMs;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= until) throw err;
      checkpoint();
      Atomics.wait(pause, 0, 0, PAUSE_MS);
    }
  }
}

/**
 * The run bookkeeping of a task context, each call retried while the database is busy.
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @returns {{startRun: Function, finishRun: Function, findReusableRun: Function}}
 */
export function runWrites(ctx) {
  const opts = { checkpoint: () => ctx.checkpoint() };
  return {
    startRun: (stage, def) => retryBusy(() => ctx.startRun(stage, def), opts),
    finishRun: (runId, status, extra) => retryBusy(() => ctx.finishRun(runId, status, extra), opts),
    findReusableRun: (stage, def) => retryBusy(() => ctx.findReusableRun(stage, def), opts),
  };
}

/**
 * Inside the transaction that stores a run's rows: the run's inputs must still be the ones it started on. A job that
 * computes beside other writers reads its inputs in several statements; when an import (or a quality pass) into its
 * collections committed meanwhile, its input fingerprint moved and the rows would mix two data states, so nothing is
 * stored and the job fails with E_INPUTS_CHANGED (start the run again). Inside the write transaction no other writer
 * can commit between this check and the rows.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId a run opened by ctx.startRun (its scope, upstream runs and fingerprint are on the row)
 * @throws {HttpError} 409 E_INPUTS_CHANGED
 */
export function assertInputsUnchanged(db, runId) {
  const row = db.prepare('SELECT scope_json, upstream_run_ids, input_fingerprint FROM analysis_run WHERE id = ?').get(runId);
  if (!row) return;
  const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
  const upstream = parse(row.upstream_run_ids, []);
  const now = inputFingerprint(db, { scope: parse(row.scope_json, {}), upstream: Array.isArray(upstream) ? upstream : [upstream] });
  if (now !== row.input_fingerprint) {
    throw new HttpError(409, 'E_INPUTS_CHANGED', `The data run #${runId} reads changed while it was computing (an import or a quality pass committed); nothing of it was stored.`,
      'Start the run again: it will read the new data.');
  }
}
