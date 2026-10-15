// OWNER: WP4
// tokstream.mjs — token-id streams per language and data version (SPEC §4.7, §0.2 layout):
//   derived/tokens/<lang>.u32        one u32 id per token of every quality='ok' passage of that language, in
//                                    passage-id order (platform byte order, recorded in the manifest)
//   derived/tokens/<lang>.pidx       u32 pairs (passage id, offset of its first token in .u32), by passage id
//   derived/tokens/<lang>.vocab.tsv  id \t token \t count; ids are frequency ranks (0 = most frequent)
//   derived/tokens/<lang>.json       manifest: data_version, content signature, tokenizer, counts, byte order, run id
// Tokens are the folded tokens of src/shared/tokenize.mjs over the original text, exactly what the counts
// use. Used by collocations (WP4), winnowing and the boilerplate pass (WP5, through openTokenStream).
// A stream is current while the passages it holds are unchanged (streamSignature): counting an expression bumps
// the data version but changes no passage, so it no longer makes every stream stale.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { endianness } from 'node:os';
import path from 'node:path';
import { TOKENIZER_VERSION, tokenize } from '../../src/shared/tokenize.mjs';
import { paths } from '../config.mjs';
import { createHash } from 'node:crypto';
import { dataVersion, getMeta, nowIso } from '../db/open.mjs';
import { SEGMENTER_VERSION } from '../text/segment.mjs';

/** Pipeline version recorded on tokstream runs and manifests. */
export const TOKSTREAM_VERSION = 'tokstream@1.0.0';
const CHUNK = 1 << 20; // ids buffered per write

/**
 * File paths of one language's stream.
 * @param {string} dir derived/tokens
 * @param {string} lang
 * @returns {{ids: string, pidx: string, vocab: string, manifest: string}}
 */
export function streamFiles(dir, lang) {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(lang)) throw new TypeError(`bad stream language '${lang}'`);
  return { ids: path.join(dir, `${lang}.u32`), pidx: path.join(dir, `${lang}.pidx`), vocab: path.join(dir, `${lang}.vocab.tsv`),
    manifest: path.join(dir, `${lang}.json`) };
}

/**
 * The manifest of a language's stream, or null when none was written.
 * @param {string} dir
 * @param {string} lang
 * @returns {object|null}
 */
export function readManifest(dir, lang) {
  const f = streamFiles(dir, lang).manifest;
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

/**
 * What a stream's content depends on: the passages (their highest id), the import batches by status (an import
 * adds passages, a revert soft-deletes documents), the passage-quality version (the boilerplate pass) and the
 * tokenizer and segmenter. Cheap (no passage scan).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string}
 */
export function streamSignature(db) {
  const maxPassage = db.prepare('SELECT MAX(id) AS id FROM passage').get()?.id ?? 0;
  const batches = db.prepare('SELECT status, COUNT(*) AS n, MAX(id) AS max FROM import_batch GROUP BY status ORDER BY status').all()
    .map((r) => `${r.status}:${r.n}:${r.max}`);
  const key = JSON.stringify({ maxPassage, batches, quality: getMeta(db, 'quality_version') ?? '0', tokenizer: TOKENIZER_VERSION,
    segmenter: SEGMENTER_VERSION });
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Whether a language's stream matches the database now: same content signature (or, for a stream written before
 * signatures, the same data version), tokenizer and byte order.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir
 * @param {string} lang
 * @returns {{exists: boolean, fresh: boolean, manifest: object|null, data_version: number}}
 */
export function streamStatus(db, dir, lang) {
  const manifest = readManifest(dir, lang);
  const dv = dataVersion(db);
  const same = manifest ? (manifest.signature ? manifest.signature === streamSignature(db) : manifest.data_version === dv) : false;
  return { exists: Boolean(manifest), fresh: Boolean(manifest) && same && manifest.tokenizer === TOKENIZER_VERSION
    && manifest.byte_order === endianness(), manifest, data_version: dv };
}

/** A growable Uint32Array. */
function growable(initial = 1024) {
  let buf = new Uint32Array(initial), len = 0;
  return {
    push(v) {
      if (len === buf.length) { const b = new Uint32Array(buf.length * 2); b.set(buf); buf = b; }
      buf[len++] = v;
    },
    get length() { return len; },
    view() { return buf.subarray(0, len); },
  };
}

/**
 * Write the token streams of quality='ok' passages for one or more languages (the tokstream job). Reads
 * one consistent snapshot; files are written under temporary names and renamed into place, manifest last.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{lang?: string, langs?: string[]|null, dir?: string, runId?: number|null}} [args] langs null/absent = every
 *   language with ok passages; dir defaults to derived/tokens of the data directory; the data version recorded is
 *   the database's at the start of the read
 * @param {{checkpoint?: () => void, progress?: (fraction: number, phase?: string, message?: string) => void}|null} [ctx]
 * @returns {{data_version: number, langs: Array<{lang: string, passages: number, tokens: number, types: number}>}}
 */
export function buildTokenStreams(db, { lang = null, langs = null, dir = paths().tokens, runId = null } = {}, ctx = null) {
  mkdirSync(dir, { recursive: true });
  const checkpoint = ctx?.checkpoint ?? (() => {});
  const progress = ctx?.progress ?? (() => {});
  const ownTx = !db.isTransaction;
  if (ownTx) db.exec('BEGIN');
  try {
    const dv = dataVersion(db);
    const signature = streamSignature(db);
    const all = db.prepare(`SELECT p.lang, count(*) AS passages, sum(p.token_count) AS tokens FROM passage p
      JOIN document d ON d.id = p.document_id WHERE p.quality = 'ok' AND d.deleted_at IS NULL GROUP BY p.lang ORDER BY p.lang`).all();
    const wanted = lang ? [lang] : langs ?? all.map((r) => r.lang);
    const totals = new Map(all.map((r) => [r.lang, r.tokens ?? 0]));
    const grand = wanted.reduce((s, l) => s + (totals.get(l) ?? 0), 0) || 1;
    let doneTokens = 0;
    const out = [];
    for (const l of wanted) {
      const r = writeOne(db, l, { dir, dv, signature, runId, checkpoint, onTokens: (n) => {
        doneTokens += n;
        progress(Math.min(0.99, doneTokens / grand), `tokens ${l}`, `${l}: ${doneTokens} of ${grand} tokens`);
      } });
      out.push(r);
    }
    progress(1, 'done', `${out.length} language stream(s) written`);
    return { data_version: dv, langs: out };
  } finally {
    if (ownTx && db.isTransaction) db.exec('COMMIT');
  }
}

function writeOne(db, lang, { dir, dv, signature, runId, checkpoint, onTokens }) {
  const files = streamFiles(dir, lang);
  const tmp = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, `${f}.tmp-${process.pid}`]));
  const provisional = `${files.ids}.prov-${process.pid}`;
  const vocab = new Map();        // token → provisional id
  const counts = [];              // provisional id → count
  const pidx = growable(1 << 16);
  const words = [];
  let total = 0, passages = 0, lastCheck = Date.now();
  checkpoint();
  const fd = openSync(provisional, 'w');
  try {
    const buf = new Uint32Array(CHUNK);
    let fill = 0;
    const flush = () => { if (fill) { writeSync(fd, new Uint8Array(buf.buffer, 0, fill * 4)); fill = 0; } };
    const body = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
    const field = db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?');
    let curDoc = -1, curText = null;
    for (const p of db.prepare(`SELECT p.id, p.document_id, p.field, p.start_off, p.end_off FROM passage p
      JOIN document d ON d.id = p.document_id WHERE p.quality = 'ok' AND p.lang = ? AND d.deleted_at IS NULL ORDER BY p.id`).iterate(lang)) {
      let src;
      if (p.field === 'body') {
        if (p.document_id !== curDoc) { curDoc = p.document_id; curText = body.get(curDoc)?.original ?? null; }
        src = curText;
      } else {
        src = field.get(p.document_id, p.field)?.value ?? null;
      }
      pidx.push(p.id);
      pidx.push(total);
      passages++;
      if (src === null) continue;
      const { tokens } = tokenize(src.slice(p.start_off, p.end_off));
      for (const t of tokens) {
        let id = vocab.get(t);
        if (id === undefined) { id = words.length; vocab.set(t, id); words.push(t); counts.push(0); }
        counts[id]++;
        buf[fill++] = id;
        if (fill === CHUNK) flush();
      }
      total += tokens.length;
      onTokens(tokens.length);
      if (Date.now() - lastCheck >= 100) { lastCheck = Date.now(); checkpoint(); }
    }
    flush();
  } catch (err) {
    closeSync(fd);
    rmSync(provisional, { force: true });
    throw err;
  }
  closeSync(fd);

  try {
    // ids become frequency ranks: 0 = most frequent (ties by token, so the order is reproducible)
    const c = counts;
    const order = Array.from(words.keys()).sort((x, y) => c[y] - c[x] || (words[x] < words[y] ? -1 : words[x] > words[y] ? 1 : 0));
    const rank = new Uint32Array(words.length);
    order.forEach((prov, r) => { rank[prov] = r; });
    const inFd = openSync(provisional, 'r'), outFd = openSync(tmp.ids, 'w');
    try {
      const chunk = new Uint32Array(CHUNK);
      for (let pos = 0; pos < total; pos += CHUNK) {
        checkpoint();
        const n = Math.min(CHUNK, total - pos);
        readSync(inFd, new Uint8Array(chunk.buffer, 0, n * 4), 0, n * 4, pos * 4);
        for (let i = 0; i < n; i++) chunk[i] = rank[chunk[i]];
        writeSync(outFd, new Uint8Array(chunk.buffer, 0, n * 4));
      }
    } finally {
      closeSync(inFd);
      closeSync(outFd);
    }
    const p = pidx.view();
    writeFileSync(tmp.pidx, new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    writeFileSync(tmp.vocab, order.map((prov, r) => `${r}\t${words[prov]}\t${c[prov]}`).join('\n') + (order.length ? '\n' : ''));
    const manifest = { lang, version: TOKSTREAM_VERSION, data_version: dv, signature, tokenizer: TOKENIZER_VERSION, segmenter: SEGMENTER_VERSION,
      quality_version: getMeta(db, 'quality_version') ?? '0', byte_order: endianness(), passages, tokens: total, types: words.length,
      run_id: runId, built_at: nowIso() };
    writeFileSync(tmp.manifest, JSON.stringify(manifest, null, 1));
    for (const k of ['ids', 'pidx', 'vocab', 'manifest']) renameSync(tmp[k], files[k]);
  } catch (err) {
    for (const f of Object.values(tmp)) rmSync(f, { force: true });
    throw err;
  } finally {
    rmSync(provisional, { force: true });
  }
  return { lang, passages, tokens: total, types: words.length };
}

const metaCache = new Map(); // dir|lang → { builtAt, stream } (per thread: read workers keep the index, not the ids)
// A lazily read stream holds one descriptor of its ids file from its first read until close(); a stream dropped
// without close() gives it back when collected. (Opening the file per read cost more than the reads: about 5 s of a
// 24 s clustering run went to open/close while convergence read one passage at a time.)
const descriptors = new FinalizationRegistry((cell) => { if (cell.fd !== null) try { closeSync(cell.fd); } catch { /* already closed */ } });

function readUint32File(file) {
  const bytes = readFileSync(file);
  const out = new Uint32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

/**
 * Map a written stream: token ids (unless `ids: false`), passage index and vocabulary.
 * Cross-package: WP5 winnowing and boilerplate read token streams through this (§12.4).
 * @param {string} lang
 * @param {{dir: string, ids?: boolean}} opts derived/tokens directory; `ids: false` keeps the ids on disk
 *   (read ranges with readIds) — what the read workers do; such a stream keeps its file open from the first
 *   readIds until close()
 * @returns {{lang: string, manifest: object, ids: Uint32Array|null, pidx: {passages: Uint32Array, offsets: Uint32Array},
 *   vocab: string[], counts: Uint32Array, tokens: number, range(passageId: number): [number, number]|null,
 *   readIds(start: number, end: number): Uint32Array, idOf(token: string): number|undefined, close(): void}}
 * @throws {Error} code E_NO_STREAM when the stream has not been built
 */
export function openTokenStream(lang, { dir, ids = true }) {
  const files = streamFiles(dir, lang);
  const manifest = readManifest(dir, lang);
  if (!manifest) throw Object.assign(new Error(`No token stream for '${lang}' in ${dir}.`), { code: 'E_NO_STREAM' });
  const key = `${dir}|${lang}`;
  let base = metaCache.get(key)?.builtAt === manifest.built_at ? metaCache.get(key).stream : null;
  if (!base) {
    const raw = readUint32File(files.pidx);
    const P = raw.length / 2;
    const passages = new Uint32Array(P), offsets = new Uint32Array(P);
    for (let i = 0; i < P; i++) { passages[i] = raw[2 * i]; offsets[i] = raw[2 * i + 1]; }
    const vocab = [], countsArr = [];
    const text = readFileSync(files.vocab, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const t1 = line.indexOf('\t'), t2 = line.lastIndexOf('\t');
      vocab[Number(line.slice(0, t1))] = line.slice(t1 + 1, t2);
      countsArr.push(Number(line.slice(t2 + 1)));
    }
    base = { manifest, pidx: { passages, offsets }, vocab, counts: Uint32Array.from(countsArr), tokens: statSync(files.ids).size / 4, index: null };
    metaCache.set(key, { builtAt: manifest.built_at, stream: base });
  }
  const all = ids ? readUint32File(files.ids) : null;
  const { passages, offsets } = base.pidx;
  const cell = { fd: null };
  const stream = {
    lang,
    manifest: base.manifest,
    ids: all,
    pidx: base.pidx,
    vocab: base.vocab,
    counts: base.counts,
    tokens: base.tokens,
    range(passageId) {
      let lo = 0, hi = passages.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (passages[mid] < passageId) lo = mid + 1; else if (passages[mid] > passageId) hi = mid - 1;
        else return [offsets[mid], mid + 1 < passages.length ? offsets[mid + 1] : base.tokens];
      }
      return null;
    },
    readIds(start, end) {
      if (all) return all.subarray(start, end);
      const out = new Uint32Array(Math.max(0, end - start));
      if (!out.length) return out;
      if (cell.fd === null) cell.fd = openSync(files.ids, 'r');
      readSync(cell.fd, new Uint8Array(out.buffer), 0, out.byteLength, start * 4);
      return out;
    },
    idOf(token) {
      if (!base.index) base.index = new Map(base.vocab.map((t, i) => [t, i]));
      return base.index.get(token);
    },
    /** Release the ids file (a later readIds opens it again). */
    close() {
      if (cell.fd === null) return;
      const fd = cell.fd;
      cell.fd = null;
      closeSync(fd);
    },
  };
  if (!all) descriptors.register(stream, cell, stream);
  return stream;
}
