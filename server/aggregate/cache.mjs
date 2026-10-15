// OWNER: WP3
// cache.mjs — caches of the aggregation layer:
//  · in-memory LRU caches on the main thread: tile payloads keyed by queryKey | tier | tile | dataVersion (a data
//    change can never serve a stale tile) and registered query defs keyed by queryKey;
//  · memoRows: per-process rows of expression-independent read queries, keyed by data version;
//  · sharedArtifact: a per-data-version value (the slice cube, the tag label index, …) built ONCE and shared by
//    every read worker and across restarts through $SCROLLS_DATA/cache/ (M1 gate: each of the 3 read workers used to
//    pay the same 0.5–2 s scans on its first request).

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { shortHash } from '../../src/shared/ids.mjs';
import { dataVersion, getMeta } from '../db/open.mjs';

/**
 * A least-recently-used cache.
 * @param {{max?: number}} [opts]
 * @returns {{get(key: string): any, set(key: string, value: any): void, has(key: string): boolean, clear(): void,
 *   size(): number}}
 */
export function createTileCache({ max = 512 } = {}) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    has(key) { return map.has(key); },
    clear() { map.clear(); },
    size() { return map.size; },
  };
}

/**
 * Cache key of one tile.
 * @param {string} queryKey
 * @param {string} tier
 * @param {number} tile
 * @param {number} dataVersion
 * @returns {string}
 */
export function tileKey(queryKey, tier, tile, dataVersion) {
  return `${queryKey}|${tier}|${tile}|${dataVersion}`;
}

const memo = createTileCache({ max: 64 });

/**
 * Rows of a read query that does not depend on the expression, kept per database file and data version in this
 * process (a read worker keeps them across requests).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {unknown[]} params
 * @param {number} dv the database's data version (open.mjs dataVersion)
 * @param {(rows: object[]) => any} [build] derive the cached value from the rows (default: the rows)
 * @returns {any}
 */
export function memoRows(db, sql, params, dv, build = (rows) => rows) {
  const key = `${db.location?.() ?? ''}|${dv}|${sql}|${JSON.stringify(params)}`;
  if (memo.has(key)) return memo.get(key);
  const value = build(db.prepare(sql).all(...params));
  memo.set(key, value);
  return value;
}

/**
 * A small per-process memo for values derived from a shared artifact (per def, per tier, …).
 * @param {{max?: number}} [opts]
 * @returns {(key: string, compute: () => any) => any}
 */
export function createMemo({ max = 64 } = {}) {
  const lru = createTileCache({ max });
  return (key, compute) => {
    if (lru.has(key)) return lru.get(key);
    const v = compute();
    lru.set(key, v);
    return v;
  };
}

// ── shared, persisted per-data-version artifacts ──────────────────────────────────────────────────────

// per corpus: cube, relation-endpoint cube, OpenAlex cells, maker names, theme and maker labels — plus one statistics entry
// per collection (contract 1.3.0); a smaller cap made the warm loop evict and decode the large cubes again
const artifacts = createTileCache({ max: 96 });
// A build lock older than this is a builder that died (a read worker is terminated after its 5 s query timeout).
const STALE_LOCK_MS = 30000;
const POLL_MS = 25;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

/**
 * Directory of persisted artifacts of a database: `<dir of the database file>/cache` (the data dir's cache/), or
 * null for an in-memory database.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string|null}
 */
export function cacheDirOf(db) {
  const loc = db.location?.() ?? null;
  return loc ? path.join(path.dirname(loc), 'cache') : null;
}

/**
 * Identity of a database for cache files: a fresh database (new created_at) never reads an older database's files
 * even when their data versions coincide.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string}
 */
export function dbTag(db) {
  return shortHash(`${getMeta(db, 'created_at') ?? ''}|${getMeta(db, 'schema_version') ?? ''}`, 8);
}

function tryLock(file) {
  try {
    closeSync(openSync(file, 'wx'));
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) { unlinkSync(file); closeSync(openSync(file, 'wx')); return true; }
    } catch { /* another worker took it */ }
    return false;
  }
}

function readFileOrNull(file, decode) {
  let bytes;
  try { bytes = readFileSync(file); } catch { return null; }
  try { return decode(bytes); } catch {
    try { unlinkSync(file); } catch { /* already gone */ }
    return null;
  }
}

function writeArtifact(dir, base, file, bytes) {
  const tmp = `${file}.${process.pid}-${threadId}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  // older versions of the same artifact of the same database are never read again
  for (const f of readdirSync(dir)) {
    if (f !== path.basename(file) && f.startsWith(`${base}-`) && f.endsWith('.bin')) {
      try { unlinkSync(path.join(dir, f)); } catch { /* another worker pruned it */ }
    }
  }
}

const keyMemo = createTileCache({ max: 160 });

/** Where an artifact lives: its memory key, its file and its lock, for the current inputs of the database. */
function locate(db, name, key) {
  const loc = db.location?.() ?? ':memory:';
  const base = `${name}-${dbTag(db)}`;
  const dvKey = `${loc}|${base}|${dataVersion(db)}`;
  let k = keyMemo.get(dvKey);
  if (k === undefined) { k = key(db); keyMemo.set(dvKey, k); }
  const dir = cacheDirOf(db);
  return { loc, base, k, dir, memKey: (kk) => `${loc}|${base}|${kk}`, fileOf: (kk) => (dir ? path.join(dir, `${base}-${kk}.bin`) : null),
    lockFile: dir ? path.join(dir, `${base}.lock`) : null };
}

const defaultKey = (d) => `v${dataVersion(d)}`;

/**
 * A shared artifact when it is ready — in this process's memory or in the cache directory — else null. Never builds,
 * never waits: for request paths that have a cheaper fallback while the artifact is built elsewhere (warm.mjs).
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{name: string, key?: (db: import('node:sqlite').DatabaseSync) => string, decode: (bytes: Buffer) => T}} spec
 * @returns {T|null}
 */
export function peekArtifact(db, { name, key = defaultKey, decode }) {
  const a = locate(db, name, key);
  if (artifacts.has(a.memKey(a.k))) return artifacts.get(a.memKey(a.k));
  const hit = a.dir ? readFileOrNull(a.fileOf(a.k), decode) : null;
  if (hit !== null) artifacts.set(a.memKey(a.k), hit);
  return hit;
}

/**
 * Make sure a shared artifact exists for the current inputs — in this process's memory or as a file — building it only
 * when neither does, and never decoding an existing file (warm.mjs: after a data change that did not touch the inputs,
 * checking costs the key, not a decode of a 12 MB cube in a worker that does not hold it).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} spec the sharedArtifact spec
 * @returns {boolean} whether it was built now
 */
export function ensureArtifact(db, spec) {
  const a = locate(db, spec.name, spec.key ?? defaultKey);
  if (artifacts.has(a.memKey(a.k))) return false;
  if (a.dir && existsSync(a.fileOf(a.k))) return false;
  sharedArtifact(db, spec);
  return true;
}

/**
 * A value derived from the database, built once and shared: this process's memory →
 * `<data dir>/cache/<name>-<dbTag>-<key>.bin` → build. `key(db)` fingerprints the inputs the value reads (default: the
 * data version), so a data-version bump that does not touch them (a materialization) keeps the value; it is evaluated
 * once per data version. While another worker holds the build lock this one waits up to `waitMs` for its file (instead
 * of repeating the scan), then builds itself; a lock left by a terminated worker goes stale after 30 s. The build runs
 * inside one read transaction together with `key`, so the value and the key it is filed under belong to the same
 * snapshot; every builder writes its result (atomic rename), so no finished build is wasted.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{name: string, key?: (db: import('node:sqlite').DatabaseSync) => string,
 *   build: (db: import('node:sqlite').DatabaseSync) => T, encode: (value: T) => Uint8Array, decode: (bytes: Buffer) => T,
 *   waitMs?: number}} spec `name` and `key` must be safe file-name parts; keep `waitMs` well under the 5 s read timeout
 *   on request paths
 * @returns {T}
 */
export function sharedArtifact(db, { name, key = defaultKey, build, encode, decode, waitMs = 3000 }) {
  const ready = peekArtifact(db, { name, key, decode });
  if (ready !== null) return ready;
  const a = locate(db, name, key);
  let locked = false;
  if (a.dir) {
    try { mkdirSync(a.dir, { recursive: true }); } catch { /* read-only data dir: build in memory */ }
    locked = tryLock(a.lockFile);
    // another worker is building it: wait for its file rather than scanning the same rows again
    for (let waited = 0; !locked && waited < waitMs; waited += POLL_MS) {
      sleep(POLL_MS);
      const hit = readFileOrNull(a.fileOf(a.k), decode);
      if (hit !== null) { artifacts.set(a.memKey(a.k), hit); return hit; }
      locked = tryLock(a.lockFile);
    }
  }
  try {
    const own = !db.isTransaction;
    if (own) db.exec('BEGIN');
    let value, k;
    try {
      k = key(db);
      value = build(db);
    } finally {
      if (own) db.exec('COMMIT');
    }
    artifacts.set(a.memKey(k), value);
    if (a.dir) {
      try { writeArtifact(a.dir, a.base, a.fileOf(k), encode(value)); } catch { /* a full or read-only disk only costs a rebuild */ }
    }
    return value;
  } finally {
    if (locked) { try { unlinkSync(a.lockFile); } catch { /* already gone */ } }
  }
}

/** Forget every in-memory shared artifact of this process (tests). */
export function clearSharedArtifacts() {
  artifacts.clear();
  keyMemo.clear();
}
