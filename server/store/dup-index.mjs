// OWNER: WP0 — the duplicate indexes of one collection, built once per chained load (M5 gate item 9)
//
// DocumentWriter flags near duplicates (MinHash LSH over full texts) and metadata duplicates (folded
// title|author|year of metadata-only records) against everything already in the collection. Building those
// indexes means reading every signature and folding every title: 1.3–23 s for the 179k Cipher relation endpoints,
// and a chained load (bootstrap phase A2, STEMM chunks) creates a new writer — in a new worker thread — for every
// chunk. So the index outlives its writer:
//  · in this thread, the finished writer hands it to the next writer of the same collection (memo);
//  · across threads, a large index is written to <data>/cache/dup-index/<collection>.bin at finish().
// A reused index is trusted only while the collection's import batches are exactly as recorded (a revert or a
// rollback changes a batch's status and forces a rebuild); documents added since are read from the database by
// id (> watermark). Hits are re-checked against the database by the writer, so a stale entry can never flag a
// duplicate that is not there.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOKENIZER_VERSION, tokenize } from '../../src/shared/tokenize.mjs';
import { getMeta, stmt } from '../db/open.mjs';

const MAGIC = 0x31494453; // 'SDI1'
const FORMAT_VERSION = 3;
const MINHASH_PERMS = 128;
const LSH_BANDS = 16;
const LSH_ROWS = MINHASH_PERMS / LSH_BANDS;
const TWO32 = 0x100000000;
// u32 word positions inside a u64 pair: the hash must be the high word for the native sort to order by hash
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const ID_WORD = LITTLE_ENDIAN ? 0 : 1;
const HASH_WORD = 1 - ID_WORD;
/** Indexes smaller than this are rebuilt from the database each time (milliseconds) and never written to disk. */
export const DISK_CACHE_MIN = 2000;
/** Above this many signatures, near duplicates are checked within the batch only (memory). */
export const MAX_SIGNATURES = 100000;

const memo = new Map(); // `${dbFile}|${dbCreated}|${collectionId}` → index (owned by at most one writer at a time)

// ── MinHash LSH ─────────────────────────────────────────────────────────────────────────────────────
// The bands of every signature present when the index was built or loaded live in `base`: per band, the pairs
// (hash, id) sorted by hash, packed as u64 (hash · 2³² + id) so a native typed-array sort orders them and a disk load
// needs no rebuild. Signatures added later (top-up, the writer's own documents) go to `lsh`, a small Map from
// band · 2³² + hash to an id (an array only on a collision); saving folds them into a new base.

/**
 * FNV-1a hash of each of the 16 bands (8 rows) of a MinHash signature.
 * @param {Uint32Array} sig
 * @returns {Uint32Array}
 */
export function bandHashes(sig) {
  const out = new Uint32Array(LSH_BANDS);
  for (let b = 0; b < LSH_BANDS; b++) {
    let h = 0x811c9dc5;
    for (let r = 0; r < LSH_ROWS; r++) h = Math.imul(h ^ sig[b * LSH_ROWS + r], 0x01000193);
    out[b] = h >>> 0;
  }
  return out;
}

/**
 * The per-band sorted (hash, id) table of a set of signatures.
 * @param {Map<number, Uint32Array>} sigs
 * @returns {{n: number, pairs: BigUint64Array, words: Uint32Array}} words: the same memory as u32 words
 */
function buildBase(sigs) {
  const n = sigs.size;
  const pairs = new BigUint64Array(LSH_BANDS * n);
  const words = new Uint32Array(pairs.buffer);
  let i = 0;
  for (const [id, sig] of sigs) {
    const hs = bandHashes(sig);
    for (let b = 0; b < LSH_BANDS; b++) {
      const j = 2 * (b * n + i);
      words[j + ID_WORD] = id;
      words[j + HASH_WORD] = hs[b];
    }
    i++;
  }
  for (let b = 0; b < LSH_BANDS; b++) pairs.subarray(b * n, (b + 1) * n).sort();
  return { n, pairs, words };
}

/**
 * Add a document's signature to the index.
 * @param {{sigs: Map<number, Uint32Array>, lsh: Map<number, number|number[]>}} index
 * @param {number} id
 * @param {Uint32Array} sig
 */
export function addSignature(index, id, sig) {
  index.sigs.set(id, sig);
  const hs = bandHashes(sig);
  for (let b = 0; b < LSH_BANDS; b++) {
    const k = b * TWO32 + hs[b];
    const slot = index.lsh.get(k);
    if (slot === undefined) index.lsh.set(k, id);
    else if (typeof slot === 'number') index.lsh.set(k, [slot, id]);
    else slot.push(id);
  }
}

/**
 * Ids sharing at least one LSH band with `sig` (each once), with their indexed signatures.
 * @param {{sigs: Map<number, Uint32Array>, lsh: Map<number, number|number[]>, base: object|null}} index
 * @param {Uint32Array} sig
 * @returns {Array<[number, Uint32Array]>}
 */
export function lshCandidates(index, sig) {
  const seen = new Set();
  const hs = bandHashes(sig);
  const base = index.base;
  for (let b = 0; b < LSH_BANDS; b++) {
    const h = hs[b];
    const slot = index.lsh.get(b * TWO32 + h);
    if (typeof slot === 'number') seen.add(slot);
    else if (slot) for (const id of slot) seen.add(id);
    if (!base?.n) continue;
    const { words } = base;
    const end = (b + 1) * base.n;
    let lo = b * base.n, hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (words[2 * mid + HASH_WORD] < h) lo = mid + 1; else hi = mid;
    }
    for (; lo < end && words[2 * lo + HASH_WORD] === h; lo++) seen.add(words[2 * lo + ID_WORD]);
  }
  return [...seen].map((id) => [id, index.sigs.get(id)]);
}

/** Fold the signatures added since the base into a new base (before a save). */
function compact(index) {
  if (!index.lshComplete || (!index.lsh.size && index.base?.n === index.sigs.size)) return;
  index.base = buildBase(index.sigs);
  index.lsh = new Map();
}

const fold = (s) => tokenize(String(s ?? '')).tokens.join(' ');

/**
 * The metadata-duplicate key of a record: folded title | folded author | first year.
 * @param {{title?: string|null, author?: string|null}} doc
 * @param {number|null} yLo
 * @returns {string}
 */
export function metaKey(doc, yLo) {
  return `${fold(doc.title)}|${fold(doc.author)}|${yLo ?? ''}`;
}

function batchesOf(db, collectionId) {
  return stmt(db, 'SELECT id, status FROM import_batch WHERE collection_id = ? ORDER BY id').all(collectionId).map((b) => [b.id, b.status]);
}

/** Every recorded batch is still there with the same status; any other batch is newer than all recorded ones. */
function batchesUnchanged(recorded, current) {
  const was = new Map(recorded);
  const maxRecorded = recorded.length ? recorded[recorded.length - 1][0] : 0;
  let seen = 0;
  for (const [id, status] of current) {
    if (was.has(id)) {
      if (was.get(id) !== status) return false;
      seen++;
    } else if (id < maxRecorded) {
      return false;
    }
  }
  return seen === was.size;
}

function cacheFile(db, collectionId) {
  const file = db.location();
  return file ? path.join(path.dirname(file), 'cache', 'dup-index', `${collectionId}.bin`) : null;
}

// File: 'SDI1' · header length · header JSON (padded to 4 bytes) · metadata-key ids (u32 × nmeta) ·
// signatures ((1 + 128) u32 × nsig: id then the signature) · LSH base (16 × nsig (id, hash) u32 pairs, sorted per band;
// only when lshComplete) · metadata keys (UTF-8, '\n'-joined; folded keys hold no newline). Typed blocks and one
// string parse ~10× faster than JSON, and the stored LSH base needs no rebuild.
function readDisk(file) {
  let buf;
  try { buf = readFileSync(file); } catch { return null; }
  if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) return null;
  const hlen = buf.readUInt32LE(4);
  let head;
  try { head = JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8')); } catch { return null; }
  if (head.version !== FORMAT_VERSION || head.tokenizer !== TOKENIZER_VERSION || head.littleEndian !== LITTLE_ENDIAN) return null;
  const width = 1 + MINHASH_PERMS;
  const nbase = head.lshComplete ? LSH_BANDS * head.nsig : 0;
  const idsAt = 8 + hlen, sigsAt = idsAt + head.nmeta * 4, baseAt = sigsAt + head.nsig * width * 4, keysAt = baseAt + nbase * 8;
  if (buf.length !== keysAt + head.keyBytes) return null;
  const copy = (from, bytes) => buf.buffer.slice(buf.byteOffset + from, buf.byteOffset + from + bytes); // aligned copy
  const ids = new Uint32Array(copy(idsAt, head.nmeta * 4));
  const keys = head.nmeta ? buf.subarray(keysAt).toString('utf8').split('\n') : [];
  if (keys.length !== head.nmeta) return null;
  const metaKeys = new Map();
  for (let i = 0; i < keys.length; i++) metaKeys.set(keys[i], ids[i]);
  const body = new Uint32Array(copy(sigsAt, head.nsig * width * 4));
  const sigs = new Map();
  for (let i = 0; i < head.nsig; i++) sigs.set(body[i * width], body.slice(i * width + 1, (i + 1) * width));
  let base = null;
  if (head.lshComplete) {
    const pairs = new BigUint64Array(copy(baseAt, nbase * 8));
    base = { n: head.nsig, pairs, words: new Uint32Array(pairs.buffer) };
  }
  return { ...head, sigs, metaKeys, base };
}

function writeDisk(file, index, dbCreated) {
  const sigs = index.lshComplete ? index.sigs : new Map();
  const ids = new Uint32Array(index.metaKeys.size);
  let i = 0;
  for (const id of index.metaKeys.values()) ids[i++] = id;
  const keys = Buffer.from([...index.metaKeys.keys()].join('\n'), 'utf8');
  const width = 1 + MINHASH_PERMS;
  const body = new Uint32Array(sigs.size * width);
  i = 0;
  for (const [id, sig] of sigs) { body[i * width] = id; body.set(sig, i * width + 1); i++; }
  const base = index.lshComplete ? index.base : null;
  if (index.lshComplete && base?.n !== sigs.size) throw new Error('dup-index: the LSH base is not compacted');
  const head = Buffer.from(JSON.stringify({ version: FORMAT_VERSION, tokenizer: TOKENIZER_VERSION, db: dbCreated,
    collection: index.collectionId, watermark: index.watermark, batches: index.batches, lshComplete: index.lshComplete,
    littleEndian: LITTLE_ENDIAN, nmeta: ids.length, nsig: sigs.size, keyBytes: keys.length }), 'utf8');
  const pad = (4 - (head.length % 4)) % 4; // the typed blocks start 4-byte aligned (JSON ignores trailing spaces)
  const pre = Buffer.alloc(8);
  pre.writeUInt32LE(MAGIC, 0);
  pre.writeUInt32LE(head.length + pad, 4);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const parts = [pre, head, Buffer.alloc(pad, 0x20), Buffer.from(ids.buffer), Buffer.from(body.buffer, body.byteOffset, body.byteLength)];
  if (base) parts.push(Buffer.from(base.pairs.buffer, base.pairs.byteOffset, base.pairs.byteLength));
  parts.push(keys);
  writeFileSync(tmp, Buffer.concat(parts));
  renameSync(tmp, file);
}

function emptyIndex(collectionId) {
  return { collectionId, watermark: 0, batches: [], sigs: new Map(), lsh: new Map(), base: null, lshComplete: true,
    metaKeys: new Map() };
}

const sigOf = (blob) => new Uint32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/** Every signature and metadata key of the collection's live documents. @returns {number} the highest id read */
function readAll(db, index, checkpoint) {
  let i = 0, max = 0;
  const tick = () => { if (checkpoint && ++i % 5000 === 0) checkpoint(); };
  if (index.lshComplete) {
    for (const r of stmt(db, `SELECT m.document_id AS id, m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id
      WHERE d.collection_id = ? AND d.deleted_at IS NULL`).iterate(index.collectionId)) {
      index.sigs.set(r.id, sigOf(r.sig));
      if (r.id > max) max = r.id;
      tick();
    }
    index.base = buildBase(index.sigs);
  }
  for (const r of stmt(db, `SELECT id, title, author, y_lo FROM document WHERE collection_id = ? AND deleted_at IS NULL
    AND has_full_text = 0`).iterate(index.collectionId)) {
    index.metaKeys.set(metaKey(r, r.y_lo), r.id);
    if (r.id > max) max = r.id;
    tick();
  }
  return max;
}

/**
 * The collection's live documents with id > after, added to a reused index. Driven by the collection's own index
 * (rowids above the watermark), so a top-up costs the new rows, not a pass over the collection's signatures.
 * @returns {number} the new watermark
 */
function readSince(db, index, after, checkpoint) {
  let i = 0, max = after;
  const sig = stmt(db, 'SELECT sig FROM doc_minhash WHERE document_id = ?');
  for (const r of stmt(db, `SELECT id, title, author, y_lo, has_full_text FROM document WHERE collection_id = ? AND id > ?
    AND deleted_at IS NULL`).iterate(index.collectionId, after)) {
    if (r.has_full_text === 0) index.metaKeys.set(metaKey(r, r.y_lo), r.id);
    else if (index.lshComplete) {
      const m = sig.get(r.id);
      if (m) addSignature(index, r.id, sigOf(m.sig));
    }
    if (r.id > max) max = r.id;
    if (checkpoint && ++i % 5000 === 0) checkpoint();
  }
  return max;
}

function buildFromDb(db, collectionId, checkpoint) {
  const index = emptyIndex(collectionId);
  const n = stmt(db, `SELECT count(*) AS n FROM doc_minhash m JOIN document d ON d.id = m.document_id
    WHERE d.collection_id = ? AND d.deleted_at IS NULL`).get(collectionId).n;
  index.lshComplete = n <= MAX_SIGNATURES;
  index.batches = batchesOf(db, collectionId);
  index.watermark = readAll(db, index, checkpoint);
  return index;
}

/**
 * The duplicate indexes of a collection for one writer: the memo of this thread, else the disk cache, else
 * built from the database; reused ones are topped up with documents added since. The writer owns the returned
 * index until save() or discard().
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} collectionId
 * @param {{checkpoint?: (() => void)|null}} [opts] cancellation check (called every 5,000 rows read)
 * @returns {{index: object, source: 'memo'|'disk'|'db', ms: number}}
 */
export function openDupIndex(db, collectionId, { checkpoint = null } = {}) {
  const t0 = performance.now();
  const dbCreated = getMeta(db, 'created_at') ?? '';
  const key = `${db.location() ?? ':memory:'}|${dbCreated}|${collectionId}`;
  const current = batchesOf(db, collectionId);
  let index = memo.get(key) ?? null;
  let source = 'memo';
  memo.delete(key);
  if (index && !batchesUnchanged(index.batches, current)) index = null;
  const file = cacheFile(db, collectionId);
  if (!index && file) {
    const disk = readDisk(file);
    if (disk && disk.db === dbCreated && disk.collection === collectionId && batchesUnchanged(disk.batches, current)) {
      index = { ...emptyIndex(collectionId), watermark: disk.watermark, batches: disk.batches, lshComplete: disk.lshComplete,
        metaKeys: disk.metaKeys, sigs: disk.sigs, base: disk.base };
      source = 'disk';
    } else if (disk) {
      rmSync(file, { force: true });
    }
  }
  if (index) {
    index.watermark = readSince(db, index, index.watermark, checkpoint);
    index.batches = current;
  } else {
    index = buildFromDb(db, collectionId, checkpoint);
    source = 'db';
  }
  index.batchesAtOpen = current;
  return { index, source, ms: performance.now() - t0 };
}

/**
 * After the writer's batch committed: keep the index for the next writer of this collection (memo, and on disk
 * when it is large). Skipped when another batch of the collection changed while the writer ran.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} index from openDupIndex, with the writer's documents added
 * @param {{batchId: number, maxDocumentId: number, diskMin?: number}} opts
 * @returns {{kept: boolean, disk: boolean}}
 */
export function saveDupIndex(db, index, { batchId, maxDocumentId, diskMin = DISK_CACHE_MIN }) {
  const current = batchesOf(db, index.collectionId);
  const others = (list) => list.filter(([id]) => id !== batchId);
  const file = cacheFile(db, index.collectionId);
  if (JSON.stringify(others(current)) !== JSON.stringify(others(index.batchesAtOpen ?? []))) {
    if (file) rmSync(file, { force: true });
    return { kept: false, disk: false };
  }
  index.batches = current;
  index.watermark = Math.max(index.watermark, maxDocumentId);
  delete index.batchesAtOpen;
  if (!index.lshComplete || index.sigs.size > MAX_SIGNATURES) {
    // near duplicates are then checked within each batch only: the next writer starts with no signatures
    index.lshComplete = false;
    index.sigs = new Map();
    index.lsh = new Map();
    index.base = null;
  }
  compact(index);
  const dbCreated = getMeta(db, 'created_at') ?? '';
  memo.set(`${db.location() ?? ':memory:'}|${dbCreated}|${index.collectionId}`, index);
  let disk = false;
  if (file && index.metaKeys.size + (index.lshComplete ? index.sigs.size : 0) >= diskMin) {
    writeDisk(file, index, dbCreated);
    disk = true;
  }
  return { kept: true, disk };
}

/** Forget every in-thread index (tests). */
export function clearDupIndexMemo() {
  memo.clear();
}
