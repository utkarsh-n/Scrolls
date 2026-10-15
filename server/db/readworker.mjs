// OWNER: WP0 — read-pool worker: one readOnly connection, runs `fn(db, args)` from a query module (SPEC §4.12)

import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './open.mjs';

const db = openDb({ path: workerData.dbPath, readOnly: true });
const modules = new Map();

async function load(moduleUrl) {
  let mod = modules.get(moduleUrl);
  if (!mod) {
    mod = await import(moduleUrl);
    modules.set(moduleUrl, mod);
  }
  return mod;
}

function serializeError(err) {
  return {
    message: String(err?.message ?? err),
    code: err?.code ?? null,
    status: Number.isInteger(err?.status) ? err.status : undefined,
    hint: err?.hint ?? null,
    detail: err?.detail ?? null,
    errcode: err?.errcode,
    stack: err?.stack,
  };
}

parentPort.on('message', async ({ id, moduleUrl, fnName, args }) => {
  try {
    const mod = await load(moduleUrl);
    const fn = mod[fnName];
    if (typeof fn !== 'function') throw new TypeError(`${moduleUrl} has no exported function ${fnName}`);
    // A reader never holds a transaction across requests: each call reads one consistent WAL snapshot.
    const result = await fn(db, args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    }
    parentPort.postMessage({ id, ok: false, error: serializeError(err) });
  }
});
