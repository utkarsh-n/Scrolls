// OWNER: WP0 — job worker thread: runs server/jobs/tasks/<type>.mjs with its own connection (SPEC §4.12)
//
// Task module contract: export const type, writes, priority; export async function run(ctx, params) →
// result_json. The cancel flag is an Int32Array over a SharedArrayBuffer shared with the main thread.

import { parentPort, workerData } from 'node:worker_threads';
import { JOB_TYPES } from '../../src/shared/vocab.mjs';
import { log } from '../config.mjs';
import { openDb, shareWriteYield } from '../db/open.mjs';
import { CancelledError, makeTaskContext } from './context.mjs';

const { jobId, type, params, dbPath, cancelBuf, yieldBuf, jobIdBuf = null, writes = true } = workerData;
const cancelFlag = new Int32Array(cancelBuf);
const jobIdCell = jobIdBuf instanceof SharedArrayBuffer ? new Int32Array(jobIdBuf) : null;
shareWriteYield(yieldBuf); // bulk writes step aside for the main thread's interactive writes (open.mjs)
const post = (msg) => parentPort.postMessage(msg);
const taskUrl = new URL(`./tasks/${type}.mjs`, import.meta.url);

// A job's error as the API shows it (the Job fixtures): {code, message, hint}. Stacks never leave the server
// log (errors.mjs rule); a stub's 501 NOT_IMPLEMENTED is expected and not logged as a crash.
function serialize(err) {
  if (err?.code !== 'NOT_IMPLEMENTED') log('error', `job ${jobId} (${type}) failed`, { error: String(err?.stack ?? err) });
  return { code: err?.code ?? null, message: String(err?.message ?? err), hint: err?.hint ?? null };
}

const isCancel = (err) => err instanceof CancelledError || err?.name === 'CancelledError' ||
  (err?.name === 'AbortError' && Atomics.load(cancelFlag, 0) !== 0);

async function main() {
  let db = null;
  let ctx = null;
  let outcome;
  try {
    if (!Object.hasOwn(JOB_TYPES, type) || !/^[a-z_][a-z0-9_-]*$/.test(type)) throw new TypeError(`Unknown job type '${type}'.`);
    db = openDb({ path: dbPath });
    ctx = makeTaskContext({ db, jobId, cancelFlag, post, type, codeFiles: [taskUrl], jobIdCell, writesJob: writes !== false });
    parentPort.on('message', (m) => { if (m?.kind === 'cancel') ctx._abort(); });
    const mod = await import(taskUrl.href);
    if (typeof mod.run !== 'function') throw new TypeError(`tasks/${type}.mjs exports no run(ctx, params).`);
    const def = JOB_TYPES[type];
    if ((mod.writes !== undefined && Boolean(mod.writes) !== def.writes) || (mod.priority !== undefined && mod.priority !== def.priority)) {
      ctx.log('warn', `tasks/${type}.mjs declares writes=${mod.writes} priority=${mod.priority}; the queue uses vocab.JOB_TYPES (writes=${def.writes}, priority=${def.priority}).`);
    }
    ctx.checkpoint();
    const result = await mod.run(ctx, params ?? {});
    if (db.isTransaction) db.exec('COMMIT'); // e.g. a writer's last batch awaiting its idle flush
    ctx._flushProgress();
    ctx._closeOpenRuns('failed'); // a task must finish its runs; an unfinished one is never shown as succeeded
    outcome = { kind: 'done', status: 'succeeded', result: result ?? null };
  } catch (err) {
    if (db?.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* connection already unusable */ }
    }
    const status = isCancel(err) ? 'cancelled' : 'failed';
    try { ctx?._closeOpenRuns(status); } catch { /* the main thread fails leftover runs */ }
    outcome = { kind: 'done', status, error: status === 'failed' ? serialize(err) : null };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  post(outcome);
  parentPort.close();
}

main();
