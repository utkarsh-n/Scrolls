// OWNER: WP0 — SQLite connections, transactions and the meta table (SPEC §3, §4.12, D11)

import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import { assertNotICloud, paths } from '../config.mjs';

// ── Interactive-write handoff (M1 gate) ─────────────────────────────────────────────────────────────
// SQLite's busy handler is not fair: a bulk writer in a job worker that BEGINs again right after its COMMIT can
// starve an interactive write on the main connection (save view, annotation, review) past its 5 s busy_timeout.
// The main thread counts its waiting writes in a shared cell; job workers check it before each transaction and
// step aside (bounded) until the interactive write is done. The queue hands the buffer to every job worker.

/** SharedArrayBuffer of the handoff cell; created on the main thread, adopted by job workers (shareWriteYield). */
export const WRITE_YIELD_BUFFER = isMainThread ? new SharedArrayBuffer(8) : null;
let yieldCell = WRITE_YIELD_BUFFER ? new Int32Array(WRITE_YIELD_BUFFER) : null;

/**
 * Adopt the main thread's handoff buffer in a job worker.
 * @param {SharedArrayBuffer|null|undefined} buf
 */
export function shareWriteYield(buf) {
  if (buf instanceof SharedArrayBuffer) yieldCell = new Int32Array(buf);
}

/**
 * In a job worker, before taking the write lock: wait (≤ maxMs) while an interactive write on the main thread is
 * waiting for it. No-op on the main thread.
 * @param {number} [maxMs]
 */
export function yieldToInteractiveWriters(maxMs = 3000) {
  if (isMainThread || !yieldCell || Atomics.load(yieldCell, 0) <= 0) return;
  const until = Date.now() + maxMs;
  while (Atomics.load(yieldCell, 0) > 0 && Date.now() < until) Atomics.wait(yieldCell, 1, 0, 5);
}

/**
 * In a job worker: whether a write on the main thread is waiting for the lock. A bulk writer that can commit at
 * any point (DocumentWriter) commits early when this is true, so the wait is one record, not one batch.
 * @returns {boolean}
 */
export function interactiveWriteWaiting() {
  return !isMainThread && yieldCell !== null && Atomics.load(yieldCell, 0) > 0;
}

/**
 * On the main thread: announce a write that waits for the lock outside tx() (the job queue's write-behind, a
 * deferred request). Job workers step aside before their next transaction until `release()` is called.
 * @returns {() => void} release (idempotent)
 */
export function announceWrite() {
  if (!isMainThread || !yieldCell) return () => {};
  Atomics.add(yieldCell, 0, 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    Atomics.sub(yieldCell, 0, 1);
  };
}

/**
 * Try to take the write lock at once: BEGIN IMMEDIATE with no busy wait. On success the caller owns an open
 * transaction and must COMMIT or ROLLBACK it.
 * @param {DatabaseSync} db
 * @returns {boolean} false when another connection holds the lock
 */
export function tryBeginImmediate(db) {
  if (db.isTransaction) return false;
  db.exec('PRAGMA busy_timeout = 0');
  try {
    db.exec('BEGIN IMMEDIATE');
    return true;
  } catch (err) {
    if (isBusyError(err)) return false;
    throw err;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

const MEMORY = ':memory:';
/** The busy timeout of every connection (§4.12). */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Open a connection with the pragmas of §3. Writers get WAL + synchronous NORMAL + autocheckpoint 1,000
 * pages; read-only connections (read workers) only set the read-side pragmas.
 * @param {{path?: string, readOnly?: boolean}} [opts]
 * @returns {DatabaseSync}
 * @throws {Error} code E_DB_IN_ICLOUD when the file would live under iCloud
 */
export function openDb({ path = paths().db, readOnly = false } = {}) {
  if (path !== MEMORY) assertNotICloud(path);
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;`);
  if (!readOnly) {
    if (path !== MEMORY) db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000;');
  }
  return db;
}

const stmtCache = new WeakMap();

/**
 * A prepared statement cached per connection (statements are cheap to keep and costly to re-prepare in
 * hot loops).
 * @param {DatabaseSync} db
 * @param {string} sql
 * @returns {import('node:sqlite').StatementSync}
 */
export function stmt(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) stmtCache.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

/**
 * Run a DELETE on an FTS5 table. A contentless_delete=1 table leaves an internal tombstone rowid (> 2^53) in
 * the connection's last_insert_rowid, which makes every later `run()` on that connection throw a RangeError
 * in node:sqlite until the next INSERT; this helper reads that result as BigInt and then resets the value.
 * @param {DatabaseSync} db
 * @param {string} sql a DELETE … FROM <fts table> statement
 * @param {...unknown} params
 * @returns {number} rows changed
 */
export function ftsDelete(db, sql, ...params) {
  const s = stmt(db, sql);
  s.setReadBigInts(true);
  const r = s.run(...params);
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _scrolls_rowid_reset (x INTEGER); INSERT INTO _scrolls_rowid_reset VALUES (0); DELETE FROM _scrolls_rowid_reset;');
  return Number(r.changes);
}

let savepointSeq = 0;

/**
 * Run `fn(db)` in a write transaction: BEGIN IMMEDIATE … COMMIT, ROLLBACK + rethrow on error. Nested calls
 * use a SAVEPOINT, so a helper that opens its own transaction can run inside a caller's.
 * @template T
 * @param {DatabaseSync} db
 * @param {(db: DatabaseSync) => T} fn
 * @param {{busyMs?: number}} [opts] how long BEGIN IMMEDIATE may wait for the lock (default: the connection's 5 s)
 * @returns {T}
 */
export function tx(db, fn, { busyMs = null } = {}) {
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn(db);
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }
  const interactive = isMainThread && yieldCell !== null;
  if (interactive) Atomics.add(yieldCell, 0, 1); else yieldToInteractiveWriters();
  const shortWait = Number.isInteger(busyMs) && busyMs >= 0 && busyMs !== BUSY_TIMEOUT_MS;
  if (shortWait) db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  try {
    db.exec('BEGIN IMMEDIATE');
  } finally {
    if (shortWait) db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (interactive) Atomics.sub(yieldCell, 0, 1);
  }
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @returns {string|null}
 */
export function getMeta(db, key) {
  const row = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string|number} value
 */
export function setMeta(db, key, value) {
  stmt(db, 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/**
 * The committed data version (meta.data_version), 0 before the first write.
 * @param {DatabaseSync} db
 * @returns {number}
 */
export function dataVersion(db) {
  return Number(getMeta(db, 'data_version') ?? 0);
}

/**
 * Increment meta.data_version; call inside the committing transaction of a write job.
 * @param {DatabaseSync} db
 * @returns {number} the new version
 */
export function bumpDataVersion(db) {
  const row = stmt(db, `INSERT INTO meta(key, value) VALUES ('data_version', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value`).get();
  return Number(row.value);
}

/** @returns {string} the current time as an ISO-8601 UTC string */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Whether an error is a SQLite constraint failure (CHECK, UNIQUE, FOREIGN KEY, NOT NULL or a RAISE(ABORT)
 * trigger). node:sqlite reports extended result codes; the primary code is the low byte.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isConstraintError(err) {
  return Boolean(err && err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === 19);
}

/**
 * Whether an error is SQLITE_BUSY / SQLITE_LOCKED (another connection holds the write lock).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isBusyError(err) {
  return Boolean(err && err.code === 'ERR_SQLITE_ERROR' && ((err.errcode & 0xff) === 5 || (err.errcode & 0xff) === 6));
}

// ── WAL policy (§4.12) ──────────────────────────────────────────────────────────────────────────────

/** WAL size above which a bulk writer pauses until a TRUNCATE checkpoint succeeds. */
export const WAL_PAUSE_BYTES = 1024 ** 3;

/**
 * Bytes in the connection's -wal file (0 for in-memory databases or when there is none).
 * @param {DatabaseSync} db
 * @returns {number}
 */
export function walBytes(db) {
  const file = db.location();
  if (!file) return 0;
  try { return statSync(`${file}-wal`).size; } catch { return 0; }
}

/**
 * PRAGMA wal_checkpoint(mode). RESTART/TRUNCATE wait (busy_timeout) for readers; `busy` is 1 when they
 * could not finish.
 * @param {DatabaseSync} db
 * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode]
 * @returns {{busy: number, log: number, checkpointed: number}}
 */
export function checkpointWal(db, mode = 'PASSIVE') {
  if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) throw new TypeError(`checkpointWal: bad mode ${mode}`);
  const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
  return { busy: r.busy, log: r.log, checkpointed: r.checkpointed };
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * If the WAL is over 1 GB, block (sleeping between attempts) until a TRUNCATE checkpoint succeeds or
 * `maxWaitMs` passes. Bulk writers call this between batches; bootstrap phases also set
 * wal_autocheckpoint=0 and TRUNCATE after each phase.
 * @param {DatabaseSync} db
 * @param {{maxWaitMs?: number}} [opts]
 * @returns {boolean} true when the WAL is (now) below the limit
 */
export function pauseForWal(db, { maxWaitMs = 60000 } = {}) {
  if (walBytes(db) <= WAL_PAUSE_BYTES) return true;
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    // TRUNCATE, not RESTART: a RESTART leaves the -wal file at its size, so walBytes() stays over the limit and
    // every later call would checkpoint (and, with a reader pinned, wait the full maxWaitMs) again.
    if (checkpointWal(db, 'TRUNCATE').busy === 0) return true;
    Atomics.wait(pauseCell, 0, 0, 100);
  }
  return walBytes(db) <= WAL_PAUSE_BYTES;
}
