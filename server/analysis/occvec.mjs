// OWNER: WP4
// occvec.mjs — vector spaces on disk and the occurrence vectors made from them (SPEC §4.8).
//
// A space (pooled per language, or one era / Compare slice) is three files under derived/spaces/:
//   <id>.f32        rows × dim word vectors W = U·Σ^½, rows L2-normalized (Float32, byte order in the manifest)
//   <id>.vocab.tsv  row \t word \t frequency \t passage document frequency (rows = targets, f ≥ 20)
//   <id>.json       manifest: language, years, corpora, collections, tokens, documents, authors, parameters …
// and one vector_space row (rel_path 'spaces/<id>') that belongs to a 'vectors' analysis run; only spaces of
// succeeded runs are visible (§3 visibility rule).
//
// Occurrence vectors (Schütze 1998, second order): the weighted mean of the pooled-space vectors of the ±10
// context tokens of one occurrence (clipped at the passage) that are in the space (f ≥ 20), excluding
// stop-words and the target itself, L2-normalized. Fewer than 3 usable context tokens → `context_thin`
// (no vector; excluded from clustering and counted). Weighting 'idf' = log(passages/df); weighting
// 'idf-assoc' (clustering since cluster@1.1.0) = idf × (1 + PPMI of the word with the target), the target
// association measured over the clustered contexts themselves (targetAssociation). This keeps every context
// word but lets the words that co-occur with the target more than chance — Schütze's "local" features — steer
// the vector; see Docs/ANALYSIS-AND-LIMITS.md §7 for the pseudo-word evaluation behind it.
// Cross-package: WP4's clustering imports occurrenceVectors, occurrenceTokens and pooledSpaceFor.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { endianness } from 'node:os';
import path from 'node:path';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { paths } from '../config.mjs';
import { contextStopSet } from './tfidf-hash.mjs';

/** Context window of an occurrence vector, in tokens on each side (§4.4). */
export const OCC_WINDOW = 10;
/** Fewer usable context tokens than this → context_thin (§4.8). */
export const MIN_CONTEXT = 3;
/** Representation names recorded on runs and printed on cluster cards (§4.8, §3 analysis_run.representation). */
export const REPRESENTATION = Object.freeze({ pooled: 'ppmi-svd-pooled', slice: 'ppmi-svd-slice' });

/**
 * File paths of a space.
 * @param {string} dir derived/spaces
 * @param {number|string} id vector_space id (or a temporary stem)
 * @returns {{vectors: string, vocab: string, manifest: string}}
 */
export function spaceFiles(dir, id) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id))) throw new TypeError(`bad space id '${id}'`);
  return { vectors: path.join(dir, `${id}.f32`), vocab: path.join(dir, `${id}.vocab.tsv`), manifest: path.join(dir, `${id}.json`) };
}

/**
 * Vector-space rows of succeeded runs, newest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{lang?: string|null, pooled?: boolean|null, runId?: number|null}} [filter]
 * @returns {object[]} vector_space rows with `collections` parsed and the run's params
 */
export function listSpaces(db, { lang = null, pooled = null, runId = null } = {}) {
  return db.prepare(`SELECT s.*, r.params_json, r.data_version, r.finished_at FROM vector_space s JOIN analysis_run r ON r.id = s.run_id
    WHERE r.status = 'succeeded' AND (? IS NULL OR s.lang = ?) AND (? IS NULL OR s.pooled = ?) AND (? IS NULL OR s.run_id = ?)
    ORDER BY s.id DESC`).all(lang, lang, pooled === null ? null : 1, pooled ? 1 : 0, runId, runId)
    .map((r) => ({ ...r, collections: safeJson(r.collections_json, []), params: safeJson(r.params_json, {}) }));
}

const safeJson = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };

/**
 * The pooled space of a language that fits a scope best (null when none was built — callers then use the TF-IDF
 * fallback, §4.8). With `collections`, a space built from exactly those collections wins, then the smallest space
 * whose collections include all of them, then the newest that includes any; without, the newest.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} lang
 * @param {{collections?: string[]|null}} [opts] collection slugs of the scope (a Compare or clustering scope)
 * @returns {object|null} a listSpaces() row
 */
export function pooledSpaceFor(db, lang, { collections = null } = {}) {
  const spaces = listSpaces(db, { lang, pooled: true });
  if (!collections?.length) return spaces[0] ?? null;
  const want = new Set(collections);
  const covers = (sp) => [...want].every((c) => sp.collections.includes(c));
  const exact = spaces.find((sp) => covers(sp) && sp.collections.length === want.size);
  if (exact) return exact;
  const superset = spaces.filter(covers).sort((a, b) => a.collections.length - b.collections.length || b.id - a.id)[0];
  if (superset) return superset;
  return spaces.find((sp) => collections.some((c) => sp.collections.includes(c))) ?? null;
}

const cache = new Map(); // id → {stamp, space}; a few spaces per thread
const CACHE_MAX = 4;

/**
 * Load a space: vectors, vocabulary, frequencies and IDF (log(passages / df)). Cached per thread.
 * @param {import('node:sqlite').DatabaseSync|null} db used to check the space's run succeeded (null: skip)
 * @param {number} id vector_space id
 * @param {{dir?: string}} [opts]
 * @returns {{id: number, lang: string, years: [number, number]|null, pooled: boolean, dim: number, rows: number, vocab: string[],
 *   counts: Uint32Array, df: Uint32Array, idf: Float32Array, index: Map<string, number>, W: Float32Array, manifest: object,
 *   synthetic: boolean}}
 * @throws {Error} code E_NO_SPACE when the space is missing or not visible
 */
export function loadSpace(db, id, { dir = paths().spaces } = {}) {
  if (db) {
    const ok = db.prepare(`SELECT 1 FROM vector_space s JOIN analysis_run r ON r.id = s.run_id WHERE s.id = ? AND r.status = 'succeeded'`).get(id);
    if (!ok) throw Object.assign(new Error(`Vector space ${id} does not exist or its run did not succeed.`), { code: 'E_NO_SPACE' });
  }
  const files = spaceFiles(dir, id);
  if (!existsSync(files.manifest)) throw Object.assign(new Error(`Vector space ${id} has no files in ${dir}.`), { code: 'E_NO_SPACE' });
  const stamp = statSync(files.vectors).mtimeMs;
  const hit = cache.get(id);
  if (hit && hit.stamp === stamp && hit.dir === dir) return hit.space;
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'));
  if (manifest.byte_order !== endianness()) throw Object.assign(new Error(`Vector space ${id} was written ${manifest.byte_order}; this machine is ${endianness()}.`), { code: 'E_NO_SPACE' });
  const vocab = [], counts = [], df = [];
  for (const line of readFileSync(files.vocab, 'utf8').split('\n')) {
    if (!line) continue;
    const [row, word, f, d] = line.split('\t');
    vocab[Number(row)] = word;
    counts[Number(row)] = Number(f);
    df[Number(row)] = Number(d);
  }
  const bytes = readFileSync(files.vectors);
  const W = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(W.buffer).set(bytes);
  const passages = Math.max(1, manifest.passages ?? 1);
  const idf = Float32Array.from(df, (d) => Math.log(passages / Math.max(1, d)));
  const space = { id: Number(id), lang: manifest.lang, years: manifest.years ?? null, pooled: Boolean(manifest.pooled), dim: manifest.dim,
    rows: vocab.length, vocab, counts: Uint32Array.from(counts), df: Uint32Array.from(df), idf, index: new Map(vocab.map((w, i) => [w, i])),
    W, manifest, synthetic: Boolean(manifest.synthetic) };
  if (W.length !== space.rows * space.dim) throw Object.assign(new Error(`Vector space ${id}: ${W.length} floats for ${space.rows} × ${space.dim}.`), { code: 'E_NO_SPACE' });
  cache.set(id, { stamp, dir, space });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return space;
}

/**
 * Write a space's files under a temporary stem (renamed to its vector_space id by commitSpaceFiles).
 * @param {string} dir derived/spaces
 * @param {string} stem
 * @param {{W: Float32Array, rows: number, dim: number, vocab: string[], counts: ArrayLike<number>, df: ArrayLike<number>,
 *   manifest: object}} space
 * @returns {{vectors: string, vocab: string, manifest: string}}
 */
export function writeSpaceFiles(dir, stem, { W, rows, dim, vocab, counts, df, manifest }) {
  if (W.length !== rows * dim || vocab.length !== rows) throw new RangeError(`writeSpaceFiles: ${W.length} floats, ${vocab.length} words for ${rows} × ${dim}`);
  mkdirSync(dir, { recursive: true });
  const files = spaceFiles(dir, stem);
  writeFileSync(files.vectors, new Uint8Array(W.buffer, W.byteOffset, W.byteLength));
  const lines = new Array(rows);
  for (let i = 0; i < rows; i++) lines[i] = `${i}\t${vocab[i]}\t${counts[i]}\t${df[i]}`;
  writeFileSync(files.vocab, lines.join('\n') + (rows ? '\n' : ''));
  writeFileSync(files.manifest, JSON.stringify({ ...manifest, rows, dim, byte_order: endianness() }, null, 1));
  return files;
}

/**
 * Rename a temporary stem's files to the space id (manifest last, so a half-renamed space never loads).
 * @param {string} dir
 * @param {string} stem
 * @param {number} id
 * @param {object} [patch] keys merged into the manifest (e.g. its id)
 */
export function commitSpaceFiles(dir, stem, id, patch = {}) {
  const from = spaceFiles(dir, stem), to = spaceFiles(dir, id);
  const manifest = { ...JSON.parse(readFileSync(from.manifest, 'utf8')), ...patch, id };
  renameSync(from.vectors, to.vectors);
  renameSync(from.vocab, to.vocab);
  writeFileSync(to.manifest, JSON.stringify(manifest, null, 1));
  rmSync(from.manifest, { force: true });
}

/** Remove a temporary stem's files (a cancelled or failed build). */
export function discardSpaceFiles(dir, stem) {
  for (const f of Object.values(spaceFiles(dir, stem))) rmSync(f, { force: true });
}

// ── Occurrence contexts ──────────────────────────────────────────────────────────────────────────────

/**
 * Tokens of the passages holding some occurrences and each occurrence's token span (what
 * occurrenceVectors needs). Occurrence offsets index the document text; passages are read once each.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{id: number, passage_id: number, start_off: number, end_off: number}>} occs occurrence rows
 * @returns {Array<{id: number, passage: number, tokens: string[], start: number, end: number}|{id: number, passage: number, missing: true}>}
 */
export function occurrenceTokens(db, occs) {
  const passage = db.prepare('SELECT id, document_id, field, start_off, end_off FROM passage WHERE id = ?');
  const body = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
  const field = db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?');
  const byPassage = new Map();
  for (const o of occs) {
    if (!byPassage.has(o.passage_id)) byPassage.set(o.passage_id, []);
    byPassage.get(o.passage_id).push(o);
  }
  const out = new Map();
  let lastDoc = -1, lastBody = null;
  for (const pid of [...byPassage.keys()].sort((a, b) => a - b)) {
    const p = passage.get(pid);
    let text = null;
    if (p) {
      let src;
      if (p.field === 'body') {
        if (p.document_id !== lastDoc) { lastDoc = p.document_id; lastBody = body.get(p.document_id)?.original ?? null; }
        src = lastBody;
      } else {
        src = field.get(p.document_id, p.field)?.value ?? null;
      }
      text = src === null ? null : src.slice(p.start_off, p.end_off);
    }
    const tk = text === null ? null : tokenize(text);
    for (const o of byPassage.get(pid)) {
      if (!tk) { out.set(o.id, { id: o.id, passage: pid, missing: true }); continue; }
      const rs = o.start_off - p.start_off, re = o.end_off - p.start_off;
      let start = 0;
      while (start < tk.tokens.length && tk.ends[start] <= rs) start++;
      let end = start;
      while (end < tk.tokens.length && tk.starts[end] < re) end++;
      out.set(o.id, { id: o.id, passage: pid, tokens: tk.tokens, start, end: Math.max(end, start + 1) });
    }
  }
  return occs.map((o) => out.get(o.id));
}

/** Minimum count of a context word near the target for it to get an association weight (as the label rule's in-group f ≥ 3). */
export const ASSOC_MIN_F = 3;
/** Occurrence-vector weightings. */
export const WEIGHTINGS = Object.freeze({ idf: 'idf', assoc: 'idf-assoc' });

/**
 * Association of each context word with the target over a set of its contexts: PPMI =
 * max(0, ln((f(w near target) / W) / (f(w) / T))), W = context positions counted, f(w) and T the space's word
 * frequency and token count; words seen fewer than ASSOC_MIN_F times near the target, stop-words and words
 * outside the space get none.
 * @param {string[][]} contexts context words of the target's occurrences
 * @param {ReturnType<typeof loadSpace>} space
 * @param {{stop?: Set<string>|null, minF?: number}} [opts]
 * @returns {Map<string, number>} word → PPMI (> 0 only)
 */
export function targetAssociation(contexts, space, { stop = null, minF = ASSOC_MIN_F } = {}) {
  const stops = stop ?? contextStopSet(space.lang);
  const near = new Map();
  let W = 0;
  for (const c of contexts) {
    for (const w of c) {
      if (stops.has(w) || !space.index.has(w)) continue;
      near.set(w, (near.get(w) ?? 0) + 1);
      W++;
    }
  }
  const T = Math.max(1, space.manifest?.tokens ?? 0);
  const out = new Map();
  for (const [w, f] of near) {
    if (f < minF) continue;
    const fw = space.counts[space.index.get(w)];
    if (!(fw > 0)) continue;
    const pmi = Math.log((f / W) / (fw / T));
    if (pmi > 0) out.set(w, pmi);
  }
  return out;
}

/**
 * Second-order occurrence vectors in a space.
 * @param {Array<{tokens: string[], start: number, end: number}|{context: string[], target?: string[]}|{missing: true}>} occurrences
 *   either a passage's folded tokens with the occurrence's token span [start, end), or context tokens already cut
 * @param {ReturnType<typeof loadSpace>} space
 * @param {{window?: number, stop?: Set<string>|null, minContext?: number, weighting?: 'idf'|'idf-assoc',
 *   assoc?: Map<string, number>|null}} [opts] stop defaults to the space language's context stop-set (stop-words and contraction fragments); 'idf-assoc' uses `assoc`
 *   (targetAssociation() of these contexts when not given)
 * @returns {{representation: string, space: number, dim: number, n: number, data: Float32Array, vectors: Float32Array[],
 *   thin: Uint8Array, usable: Uint16Array, thinCount: number, weighting: string, associated: number}}
 */
export function occurrenceVectors(occurrences, space, { window = OCC_WINDOW, stop = null, minContext = MIN_CONTEXT, weighting = WEIGHTINGS.idf,
  assoc = null } = {}) {
  if (!Object.values(WEIGHTINGS).includes(weighting)) throw new TypeError(`occurrenceVectors: unknown weighting '${weighting}'`);
  const n = occurrences.length, dim = space.dim;
  const stops = stop ?? contextStopSet(space.lang);
  const contexts = new Array(n), targets = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = occurrences[i];
    if (!o || o.missing) { contexts[i] = []; targets[i] = new Set(); }
    else if (Array.isArray(o.context)) { contexts[i] = o.context; targets[i] = new Set(o.target ?? []); }
    else {
      targets[i] = new Set(o.tokens.slice(o.start, o.end));
      contexts[i] = [...o.tokens.slice(Math.max(0, o.start - window), o.start), ...o.tokens.slice(o.end, o.end + window)];
    }
  }
  const boost = weighting === WEIGHTINGS.assoc
    ? assoc ?? targetAssociation(contexts.map((c, i) => c.filter((w) => !targets[i].has(w))), space, { stop: stops })
    : null;
  const data = new Float32Array(n * dim);
  const thin = new Uint8Array(n), usable = new Uint16Array(n);
  const acc = new Float64Array(dim);
  let thinCount = 0;
  for (let i = 0; i < n; i++) {
    const target = targets[i];
    acc.fill(0);
    let used = 0;
    for (const w of contexts[i]) {
      if (target.has(w) || stops.has(w)) continue;
      const row = space.index.get(w);
      if (row === undefined) continue;
      const weight = boost ? space.idf[row] * (1 + (boost.get(w) ?? 0)) : space.idf[row];
      if (!(weight > 0)) continue;
      const off = row * dim;
      for (let j = 0; j < dim; j++) acc[j] += weight * space.W[off + j];
      used++;
    }
    usable[i] = Math.min(used, 0xffff);
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += acc[j] * acc[j];
    if (used < minContext || norm === 0) { thin[i] = 1; thinCount++; continue; }
    const inv = 1 / Math.sqrt(norm);
    for (let j = 0; j < dim; j++) data[i * dim + j] = acc[j] * inv;
  }
  const vectors = Array.from({ length: n }, (_, i) => data.subarray(i * dim, (i + 1) * dim));
  return { representation: space.pooled ? REPRESENTATION.pooled : REPRESENTATION.slice, space: space.id, dim, n, data, vectors, thin, usable,
    thinCount, weighting, associated: boost ? boost.size : 0 };
}
