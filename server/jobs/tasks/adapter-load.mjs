// OWNER: WP2
// tasks/adapter-load.mjs — job 'adapter-load': drive one source adapter's iterators into DocumentWriter
// (SPEC §10.1). Adapters never write SQL; this module is where their records become rows:
//  · each source file is copied into originals/ (sha256) before it is read (§6.2, §4.2);
//  · collections are created from the adapter's CollectionSpec (+ probe caveats) in the adapter's corpus;
//  · one import batch and one DocumentWriter per collection; documents, then relationships and annotations
//    (resolved by ext_id at finish); cancellation is checked between records and rolls the batch back;
//  · etymology (cipher.roots → etymons()) and theme associations (cipher.themes → themeAssocs()) are not
//    documents: they are written here into etymon / etymon_parent / etymon_member / theme_assoc.
//
// STEMM loads (§8.6 phase C, user-triggered from the Adapters page) are CHAINED: each job loads ≈ 20 s of
// documents (or ≤ 20,000 citations) in its own batch, then queues the next adapter-load job, so the single writer
// lock is never held for minutes and materialize/import jobs slip in between chunks (the bootstrap's pattern). The
// chain's state lives in meta `adapter_load:<id>` (cursors, counts, status); every chunk resumes from what is
// committed (ext_ids, citation pairs), so a cancelled, failed or interrupted load continues on the next "Load".
// Cancelling the running chunk rolls that chunk back and stops the chain; committed chunks stay (status 'partial').
// Wiktionary loads build the word index, then write entry documents and attestation claims for tracked expressions.
// The bootstrap (tasks/bootstrap-cipher.mjs) and the demo loader reuse loadCollection()/loadAdapterData().

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { fromInterval } from '../../../src/shared/dates.mjs';
import { loadAdapter } from '../../adapters/registry.mjs';
import { readSource } from '../../adapters/cipher/source.mjs';
import { paths } from '../../config.mjs';
import { bumpDataVersion, getMeta, nowIso, setMeta, stmt, tx } from '../../db/open.mjs';
import { createBatch, createDocumentWriter, ensureCollection, storeOriginal } from '../../store/document-writer.mjs';
import { badRequest } from '../../http/errors.mjs';

export const type = 'adapter-load';
export const { writes, priority } = JOB_TYPES[type];

const CHECK_EVERY_MS = 150;
/** Wall time of one chained chunk (the bootstrap's chunk length). */
export const CHAIN_MS = 20000;
/** Relationships resolved per batch (one finish() transaction each). */
export const REL_CHUNK = 20000;
/** Adapters whose loads are chained (document sources); the others load in one job. */
export const CHAINED = Object.freeze(['stemm.gutenberg-stemm', 'stemm.openalex']);
/** meta key holding a chained load's state. */
export const loadStateKey = (adapterId) => `adapter_load:${adapterId}`;
/** meta key holding a collection's load status (read by /api/corpora and the timeline's pending lanes). */
const collectionStatusKey = (slug) => `collection_status:${slug}`;
/** meta key holding the OpenAlex cells (field × bin, population) of the loaded sample. */
export const OPENALEX_CELLS_KEY = 'stemm-openalex.cells';
const INTERNAL_PARAMS = ['chain', 'untilDone', 'chunkMs', 'relChunk', 'adapter', 'apply', 'approve'];

/**
 * The corpus an adapter's collections belong to.
 * @param {string} adapterId
 * @returns {'cipher'|'stemm'|'demo'|'user'}
 */
export function corpusFor(adapterId) {
  if (adapterId === 'demo') return 'demo';
  if (adapterId.startsWith('cipher.')) return 'cipher';
  if (adapterId.startsWith('stemm.')) return 'stemm';
  return 'user';
}

/**
 * A keepOriginal(file, src) hook for AdapterCtx: copies a source file's bytes into originals/ (once per file)
 * and returns its sha256, which the adapter puts in CanonicalDocument.source_file (§4.2: originals first).
 * A file already stored from the same path with the same size, after its last change, is not read again.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {(file: string, src?: {bytes: Uint8Array}) => string}
 */
export function originalsKeeper(db) {
  const kept = new Map();
  return (file, src = null) => {
    if (kept.has(file)) return kept.get(file);
    if (!src) {
      const st = statSync(file);
      const row = stmt(db, `SELECT sha256, rel_path FROM original_file WHERE source_path = ? AND byte_size = ? AND stored_at >= ?
        ORDER BY stored_at DESC LIMIT 1`).get(file, st.size, new Date(st.mtimeMs).toISOString());
      if (row && existsSync(path.join(paths().data, row.rel_path))) { kept.set(file, row.sha256); return row.sha256; }
    }
    const bytes = (src ?? readSource(file, { cache: false })).bytes;
    const hadBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    const sha = storeOriginal(db, bytes, { sourcePath: file, encoding: 'utf-8', hadBom });
    kept.set(file, sha);
    return sha;
  };
}

/**
 * Create (or find) the adapter's collections; probe caveats are added to each collection's own.
 * @returns {object[]} collection rows
 */
export function ensureAdapterCollections(db, adapter, { caveats = [], only = null } = {}) {
  const corpus = corpusFor(adapter.id);
  return adapter.collections.filter((c) => !only || only.includes(c.slug)).map((c) =>
    ensureCollection(db, { ...c, corpus, adapter_id: adapter.id, license: c.license ?? adapter.license,
      attribution: c.attribution ?? adapter.attribution, caveats: [...(c.caveats ?? []), ...caveats] }));
}

/**
 * An AdapterCtx for adapter calls inside a task, plus `keepOriginal(file, src) → sha256`.
 * @param {object} ctx TaskCtx
 * @param {{keepOriginal?: Function, warn?: Function}} extra
 */
export function adapterCtx(ctx, { keepOriginal = null, warn = () => {} } = {}) {
  return {
    dataDir: ctx.paths?.data ?? null,
    stagedDir: null,
    signal: ctx.signal,
    progress: () => {},
    warn,
    log: (level, msg, data) => ctx.log?.(level === 'warn' || level === 'error' ? level : 'info', msg, data),
    keepOriginal: keepOriginal ?? (ctx.db ? originalsKeeper(ctx.db) : () => null),
  };
}

/** A throttled cancellation check (TaskCtx.checkpoint must run at least every 200 ms of work). */
function throttledCheckpoint(ctx) {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < CHECK_EVERY_MS) return;
    last = now;
    ctx.checkpoint?.();
  };
}

/** Split an adapter record into the CanonicalDocument and its loader-side extras (`_issues`, `_line`, `_cursor` …). */
function splitRecord(rec) {
  const doc = {}, extra = {};
  for (const [k, v] of Object.entries(rec)) (k.startsWith('_') ? extra : doc)[k] = v;
  return { doc, extra };
}

/**
 * Load one adapter collection through DocumentWriter (documents, then relationships and annotations).
 * @param {object} ctx TaskCtx (db, checkpoint, jobId, log)
 * @param {object} adapter SourceAdapter
 * @param {string} collectionSlug
 * @param {object} params adapter params (+ writerOptions)
 * @param {{keepOriginal?: Function, onDocument?: (n: number, result: object, doc: object, extra: object) => void,
 *   relationships?: boolean, annotations?: boolean, deadline?: number|null,
 *   beforeRelationships?: (writer: object, actx: object) => Promise<void>}} [opts]
 *   deadline (epoch ms): stop taking documents after it; beforeRelationships: e.g. aliases onto other collections;
 *   onDocument's `extra` holds the record's loader-side keys (`_cursor`: where a chained load resumes)
 * @returns {Promise<object>} ImportCounts (+ stopped_early)
 */
export async function loadCollection(ctx, adapter, collectionSlug, params = {}, opts = {}) {
  const { keepOriginal = originalsKeeper(ctx.db), onDocument = () => {}, relationships = true, annotations = true, deadline = null } = opts;
  const db = ctx.db;
  const check = throttledCheckpoint(ctx);
  const batchId = createBatch(db, { collection: collectionSlug, adapterId: adapter.id, adapterVersion: adapter.version,
    format: 'adapter', fileName: params.fileName ?? null, options: { params: scrub(params) }, jobId: ctx.jobId ?? null });
  const writer = createDocumentWriter(db, { batchId, collection: collectionSlug, corpus: corpusFor(adapter.id),
    options: { dedupe: 'flag', ...(params.writerOptions ?? {}), checkpoint: check } }); // M5 gate: cancellable preload
  const warn = (code, message, detail = null) => writer.addIssue({ code, severity: 'warning', message,
    value_excerpt: detail?.ext_id ?? null, suggestion: detail?.suggestion ?? 'See the message; the record was skipped or kept as noted.' });
  const actx = adapterCtx(ctx, { keepOriginal, warn });
  let n = 0, stoppedEarly = false;
  try {
    for await (const rec of adapter.documents({ ...params, collection: collectionSlug }, actx)) {
      check();
      const { doc, extra } = splitRecord(rec);
      const r = writer.addDocument(doc, { line: extra._line });
      for (const i of extra._issues ?? []) writer.addIssue({ ...i, value_excerpt: i.value_excerpt ?? doc.ext_id });
      n++;
      onDocument(n, r, doc, extra);
      if (deadline && Date.now() > deadline) { stoppedEarly = true; break; }
    }
    if (opts.beforeRelationships) await opts.beforeRelationships(writer, actx);
    if (relationships && typeof adapter.relationships === 'function') {
      for await (const rel of adapter.relationships({ ...params, collection: collectionSlug }, actx)) {
        check();
        writer.addRelationship(splitRecord(rel).doc);
      }
    }
    if (annotations && typeof adapter.annotations === 'function') {
      for await (const ann of adapter.annotations({ ...params, collection: collectionSlug }, actx)) {
        check();
        writer.addAnnotation(ann);
      }
    }
    check();
    const counts = writer.finish();
    return { ...counts, stopped_early: stoppedEarly };
  } catch (err) {
    try { writer.rollback(); } catch (e) { ctx.log?.('error', `rollback of batch ${batchId} failed: ${e.message}`); }
    if (err?.code === 'E_CANCELLED') stmt(db, "UPDATE import_batch SET status = 'cancelled' WHERE id = ?").run(batchId);
    throw err;
  }
}

/** Params as stored in import_batch.options_json (no huge arrays, no sets). */
function scrub(params) {
  const out = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (k === 'writerOptions' || k === 'skip' || k === 'loaded' || k === 'existing' || k === 'merged' || k === 'siblingKeys') continue;
    out[k] = Array.isArray(v) && v.length > 50 ? `${v.length} items` : v instanceof Set ? `${v.size} items` : v;
  }
  return out;
}

/** ext_ids already loaded (committed batches) in a collection. @returns {Set<string>} */
export function loadedExtIds(db, slug) {
  const c = stmt(db, 'SELECT id FROM collection WHERE slug = ?').get(slug);
  if (!c) return new Set();
  return new Set(stmt(db, `SELECT d.ext_id FROM document d JOIN import_batch b ON b.id = d.import_batch_id
    WHERE d.collection_id = ? AND b.status = 'committed' AND d.deleted_at IS NULL`).all(c.id).map((r) => r.ext_id));
}

// ── non-document data ───────────────────────────────────────────────────────────────────────────────

/**
 * Write etymon rows (cipher.roots). Existing keys are left as they are (idempotent); typeahead labels are
 * added for new rows only.
 * @param {object} ctx TaskCtx
 * @param {AsyncIterable<object>} rows
 * @returns {Promise<{etymons: number, parents: number, members: number, skipped: number, by_semantics: object}>}
 */
export async function writeEtymons(ctx, rows) {
  const db = ctx.db;
  const check = throttledCheckpoint(ctx);
  const counts = { etymons: 0, parents: 0, members: 0, skipped: 0, by_semantics: {} };
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    tx(db, () => {
      const insE = stmt(db, `INSERT INTO etymon (key, kind, lang, form, roman, gloss, parent_semantics) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING`);
      const insP = stmt(db, 'INSERT INTO etymon_parent (key, parent_key, ord) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
      const insM = stmt(db, 'INSERT INTO etymon_member (key, lang, word, norm, rank) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
      const insL = stmt(db, 'INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)');
      for (const r of buffer) {
        const res = insE.run(r.key, r.kind, r.lang, r.form, r.roman, r.gloss, r.parent_semantics);
        if (!res.changes) { counts.skipped++; continue; }
        counts.etymons++;
        counts.by_semantics[r.parent_semantics] = (counts.by_semantics[r.parent_semantics] ?? 0) + 1;
        for (const p of r.parents) { insP.run(r.key, p.key, p.ord); counts.parents++; }
        for (const m of r.members) { insM.run(r.key, m.lang, m.word, m.norm, m.rank); counts.members++; }
        insL.run(r.roman ? `${r.form} (${r.roman})` : r.form, 'etymon', `etymon:${r.key}`);
      }
      if (counts.etymons) bumpDataVersion(db);
    });
    buffer = [];
  };
  for await (const r of rows) {
    check();
    buffer.push(r);
    if (buffer.length >= 5000) flush();
  }
  flush();
  return counts;
}

/**
 * Write theme associations (cipher.themes) and theme typeahead labels.
 * @param {object} ctx TaskCtx
 * @param {AsyncIterable<{theme: string, other: string, npmi: number}>} assocs
 * @param {AsyncIterable<{label: string}>|null} labels
 * @returns {Promise<{assocs: number, labels: number}>}
 */
export async function writeThemeAssocs(ctx, assocs, labels = null) {
  const db = ctx.db;
  const check = throttledCheckpoint(ctx);
  const hadLabels = Boolean(stmt(db, "SELECT 1 FROM theme_assoc LIMIT 1").get());
  const counts = { assocs: 0, labels: 0 };
  const rows = [];
  for await (const a of assocs) { check(); rows.push(a); }
  const names = [];
  if (labels && !hadLabels) for await (const l of labels) names.push(l.label);
  tx(db, () => {
    const ins = stmt(db, `INSERT INTO theme_assoc (theme, other, npmi) VALUES (?, ?, ?)
      ON CONFLICT(theme, other) DO UPDATE SET npmi = excluded.npmi`);
    for (const a of rows) { ins.run(a.theme, a.other, a.npmi); counts.assocs++; }
    const insL = stmt(db, 'INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)');
    for (const name of names) { insL.run(name, 'theme', `theme:${name}`); counts.labels++; }
    bumpDataVersion(db);
  });
  return counts;
}

// ── Wiktionary claims on a tracked expression (§10.2) ──────────────────────────────────────────────

const CLAIM_PRECISION = { year: 'year', decade: 'decade', century: 'century', range: 'range', alternatives: 'range' };

/** Claim keys already written on an expression (from their JSON notes). */
function writtenClaimKeys(db, expressionId) {
  const keys = new Set();
  for (const r of stmt(db, `SELECT note FROM date_assertion WHERE subject_type = 'expression' AND subject_id = ?
    AND role = 'first_attestation_claim' AND asserted_by = 'wiktionary'`).all(expressionId)) {
    try { keys.add(JSON.parse(r.note).key); } catch { keys.add(r.note); }
  }
  return keys;
}

/**
 * Write each shown Wiktionary date statement as a date_assertion on the expression (role first_attestation_claim,
 * basis stated, asserted_by 'wiktionary', never chronology); the note is the claim's JSON (wiktionary.mjs
 * claimNote), with the loaded entry document and passage when known. Never an occurrence. Statements with an open
 * bound ("before 1900") are not written (an interval needs both ends); the claims lookup still lists them.
 * Idempotent (by claim key).
 * @param {object} ctx TaskCtx
 * @param {number} expressionId
 * @param {object[]} claims from stemm.wiktionary claims().lookup()
 * @param {{docs?: Map<string, {document: number, passage: number|null}>, noteOf?: Function}} [opts] entry ext_id → its
 *   document and `entry` passage; noteOf(claim, where) → note (default: wiktionary.mjs claimNote)
 * @returns {{written: number, skipped_open: number, already: number}}
 */
export function writeExpressionClaims(ctx, expressionId, claims, { docs = new Map(), noteOf = null } = {}) {
  const db = ctx.db;
  const out = { written: 0, skipped_open: 0, already: 0 };
  const note = noteOf ?? ((c, where) => JSON.stringify({ label: c.label, display: c.display, key: c.key, ...where }));
  tx(db, () => {
    const seen = writtenClaimKeys(db, expressionId);
    const ins = stmt(db, `INSERT INTO date_assertion (subject_type, subject_id, role, lo_day, hi_day, lo_year, hi_year, precision, basis, approx,
      raw, rule, asserted_by, is_chronology, note) VALUES ('expression', ?, 'first_attestation_claim', ?, ?, ?, ?, ?, 'stated', ?, ?, ?, 'wiktionary', 0, ?)`);
    const insR = stmt(db, 'INSERT INTO date_rtree (id, lo_day, hi_day) VALUES (?, ?, ?)');
    for (const c of claims) {
      const lo = c.year_lo ?? c.year, hi = c.year_hi ?? c.year;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) { out.skipped_open++; continue; }
      if (seen.has(c.key)) { out.already++; continue; }
      const where = [c.entry_id, ...(c.entry_ids ?? [])].map((e) => docs.get(`wikt:${e}`)).find(Boolean) ?? { document: null, passage: null };
      const p = fromInterval(lo, hi, { precision: CLAIM_PRECISION[c.precision] ?? 'range', basis: 'stated', rule: `wiktionary:${c.rule}`, raw: c.date_text });
      const r = ins.run(expressionId, p.lo_day, p.hi_day, p.lo_year, p.hi_year, p.precision, c.qualifier === 'circa' ? 1 : 0, c.date_text ?? null,
        p.rule, note(c, where));
      insR.run(Number(r.lastInsertRowid), p.lo_day, p.hi_day);
      seen.add(c.key);
      out.written++;
    }
    if (out.written) bumpDataVersion(db);
  });
  return out;
}

/** Tracked, real (non-synthetic, non-demo) word and phrase expressions: the ones Wiktionary claims attach to. */
function trackedExpressions(db, { expressionId = null } = {}) {
  return stmt(db, `SELECT e.id, e.surface, e.norm, e.lang FROM expression e LEFT JOIN corpus k ON k.id = e.corpus_id
    WHERE e.is_synthetic = 0 AND IFNULL(k.slug, '') <> 'demo' AND e.kind IN ('word', 'phrase') AND (? IS NULL OR e.id = ?)
    ORDER BY e.id`).all(expressionId, expressionId);
}

const WIKTIONARY_LANGS = new Set(['en', 'fr', 'es', 'hi', 'gu']);
const wiktLang = (lang) => (lang && WIKTIONARY_LANGS.has(lang.split('-')[0]) ? lang.split('-')[0] : 'en');

/**
 * Wiktionary: build the word index, then entry documents + claims for the tracked expressions (one expression with
 * {expressionId}, the given {words}, or every tracked real expression).
 * @param {object} ctx TaskCtx
 * @param {object} adapter the stemm.wiktionary module
 * @param {{expressionId?: number, words?: Array<string|{word: string, lang?: string}>, lang?: string}} params
 * @returns {Promise<object>} result_json
 */
export async function loadWiktionary(ctx, adapter, params = {}) {
  const db = ctx.db;
  const t0 = Date.now();
  const keepOriginal = originalsKeeper(db);
  const probe = await adapter.probe(adapterCtx(ctx, { keepOriginal }));
  if (!probe.available) {
    throw Object.assign(badRequest('E_ADAPTER_UNAVAILABLE', `${adapter.id} is unavailable: ${probe.reason ?? 'no reason given'}`,
      `Run ${adapter.command ?? 'its fetcher'} yourself, then retry.`), { detail: { adapter: adapter.id } });
  }
  ctx.progress?.(0.05, 'index', 'Wiktionary: building the word index (one scan of terms.jsonl)');
  const indexMs = Date.now();
  await adapter.wordIndex();
  const result = { adapter: adapter.id, version: adapter.version, started_at: nowIso(), index_ms: Date.now() - indexMs, expressions: 0,
    entries: null, claims: { written: 0, skipped_open: 0, already: 0, default: 0, dimmed: 0 } };
  if (Number.isInteger(params.expressionId) && !stmt(db, 'SELECT 1 FROM expression WHERE id = ?').get(params.expressionId)) {
    throw badRequest('E_VALIDATION', `No expression ${params.expressionId}.`, 'Track the expression first.');
  }
  const targets = params.words?.length
    ? params.words.map((w) => ({ id: null, surface: typeof w === 'string' ? w : w.word, lang: (typeof w === 'object' && w.lang) || params.lang || 'en' }))
    : trackedExpressions(db, { expressionId: Number.isInteger(params.expressionId) ? params.expressionId : null })
      .map((e) => ({ id: e.id, surface: e.surface, lang: wiktLang(e.lang) }));
  result.expressions = targets.filter((t) => t.id !== null).length;
  const [coll] = ensureAdapterCollections(db, adapter, { caveats: [] });
  const words = [...new Map(targets.map((t) => [`${t.lang}:${t.surface}`, { word: t.surface, lang: t.lang }])).values()];
  if (words.length) {
    ctx.progress?.(0.4, 'entries', `Wiktionary: entries of ${words.length} word(s)`);
    result.entries = await loadCollection(ctx, adapter, coll.slug, { words, skip: loadedExtIds(db, coll.slug) },
      { keepOriginal, relationships: false, annotations: false });
  }
  // entry ext_id (and alias) → the document and its `entry` passage, for the claim's highlight
  const docs = new Map();
  for (const r of stmt(db, `SELECT d.id, d.ext_id, (SELECT p.id FROM passage p WHERE p.document_id = d.id AND p.field = 'entry' ORDER BY p.ord LIMIT 1) AS passage
    FROM document d WHERE d.collection_id = ? AND d.deleted_at IS NULL`).all(coll.id)) docs.set(r.ext_id, { document: r.id, passage: r.passage });
  for (const r of stmt(db, `SELECT a.ext_id, a.document_id FROM document_alias a JOIN document d ON d.id = a.document_id WHERE d.collection_id = ?`).all(coll.id)) {
    if (!docs.has(r.ext_id)) docs.set(r.ext_id, docs.get(stmt(db, 'SELECT ext_id FROM document WHERE id = ?').get(r.document_id).ext_id));
  }
  ctx.progress?.(0.8, 'claims', 'Wiktionary: attestation claims');
  for (const t of targets.filter((x) => x.id !== null)) {
    ctx.checkpoint?.();
    const list = await adapter.claims().lookup(t.surface, { lang: t.lang, surface: t.surface });
    for (const c of list) result.claims[c.display] = (result.claims[c.display] ?? 0) + 1;
    const w = writeExpressionClaims(ctx, t.id, list, { docs, noteOf: adapter.claimNote });
    for (const k of ['written', 'skipped_open', 'already']) result.claims[k] += w[k];
  }
  result.ms = Date.now() - t0;
  result.finished_at = nowIso();
  emitAdapter(ctx, { id: adapter.id, loaded: true, staged: true, message: `Wiktionary: ${result.claims.written} claim(s) written for ${result.expressions} expression(s)` });
  return result;
}

// ── chained STEMM document loads ────────────────────────────────────────────────────────────────────

/** @returns {object|null} the state of an adapter's chained load */
export function readLoadState(db, adapterId) {
  try { return JSON.parse(getMeta(db, loadStateKey(adapterId)) ?? 'null'); } catch { return null; }
}

function saveLoadState(db, adapterId, state) {
  state.updated_at = nowIso();
  setMeta(db, loadStateKey(adapterId), JSON.stringify(state));
  return state;
}

function emitAdapter(ctx, data) {
  try { ctx.emit?.('adapter', data); } catch { /* outside a job (script, test): no bus */ }
}

const userParams = (params) => Object.fromEntries(Object.entries(params ?? {}).filter(([k]) => !INTERNAL_PARAMS.includes(k)));

/** Citation pairs ('W…|W…') OpenAlex relationships already hold, so a resumed chunk never writes one twice. */
function existingCitationPairs(db) {
  const out = new Set();
  for (const r of stmt(db, `SELECT s.ext_id AS s, d.ext_id AS d FROM relationship r
    JOIN document s ON r.src_type = 'document' AND s.id = CAST(r.src_ref AS INTEGER)
    JOIN document d ON r.dst_type = 'document' AND d.id = CAST(r.dst_ref AS INTEGER)
    WHERE r.source_dataset = 'openalex' AND r.rel_type = 'explicit_citation'`).iterate()) out.add(`${r.s.slice(3)}|${r.d.slice(3)}`);
  return out;
}

/**
 * One batch of relationships (≤ max, or until the deadline), resolved in that batch's finish().
 * @returns {Promise<{counts: object, cursor: number, done: boolean, added: number}>}
 */
async function relationshipChunk(ctx, adapter, slug, params, { max, deadline }) {
  const db = ctx.db;
  const check = throttledCheckpoint(ctx);
  const batchId = createBatch(db, { collection: slug, adapterId: adapter.id, adapterVersion: adapter.version, format: 'adapter',
    options: { params: scrub(params), part: 'relationships', from: params.from ?? 0 }, jobId: ctx.jobId ?? null });
  const writer = createDocumentWriter(db, { batchId, collection: slug, corpus: corpusFor(adapter.id), options: { dedupe: 'off' } });
  let added = 0, cursor = params.from ?? 0, done = true;
  try {
    for await (const rel of adapter.relationships(params, adapterCtx(ctx))) {
      check();
      const { doc, extra } = splitRecord(rel);
      writer.addRelationship(doc);
      params.existing?.add(`${doc.src.ext_id.slice(3)}|${doc.dst.ext_id.slice(3)}`);
      added++;
      if (Number.isInteger(extra._cursor)) cursor = extra._cursor;
      if (added >= max || Date.now() > deadline) { done = false; break; }
    }
    check();
    return { counts: writer.finish(), cursor, done, added };
  } catch (err) {
    try { writer.rollback(); } catch (e) { ctx.log?.('error', `rollback of batch ${batchId} failed: ${e.message}`); }
    if (err?.code === 'E_CANCELLED') stmt(db, "UPDATE import_batch SET status = 'cancelled' WHERE id = ?").run(batchId);
    throw err;
  }
}

const addCounts = (into, c) => {
  into.documents = (into.documents ?? 0) + (c.documents?.created ?? 0);
  into.rejected = (into.rejected ?? 0) + (c.documents?.rejected ?? 0);
  into.metadata_only = (into.metadata_only ?? 0) + (c.documents?.metadata_only ?? 0);
  into.translations = (into.translations ?? 0) + (c.documents?.translations ?? 0);
  into.passages = (into.passages ?? 0) + (c.passages ?? 0);
  into.tokens = (into.tokens ?? 0) + (c.tokens ?? 0);
  for (const [k, v] of Object.entries(c.relationships ?? {})) if (v) into[`rel_${k}`] = (into[`rel_${k}`] ?? 0) + v;
  for (const [k, v] of Object.entries(c.issues?.by_code ?? {})) (into.issues ??= {})[k] = (into.issues[k] ?? 0) + v;
  into.batches = (into.batches ?? 0) + 1;
  return into;
};

/** Collection caveats after a load: the spec's own, the probe's, and (gutenberg-stemm) the coverage line of what is loaded. */
async function finishCollections(ctx, adapter, rows, probe) {
  const db = ctx.db;
  const out = {};
  for (const c of rows) {
    const spec = adapter.collections.find((x) => x.slug === c.slug) ?? {};
    let extra = [];
    if (adapter.id === 'stemm.gutenberg-stemm' && typeof adapter.coverageCounts === 'function') {
      const loaded = loadedExtIds(db, c.slug);
      const cov = adapter.coverageCounts(adapter.loadCatalog().filter((r) => loaded.has(`pgs:${r.id}`)));
      out[c.slug] = cov;
      extra = [`loaded: ${adapter.coverageLine(cov)}`];
    }
    const caveats = [...new Set([...(spec.caveats ?? []), ...extra, ...(probe.caveats ?? []).filter((x) => !/^dated by evidence/.test(x))])];
    tx(db, () => {
      stmt(db, 'UPDATE collection SET caveats_json = ?, retrieved_at = ? WHERE id = ?').run(JSON.stringify(caveats), nowIso(), c.id);
      // prominence terciles per kind (sitelinks, citation counts): prominence is never an evidence weight
      stmt(db, `UPDATE document SET prominence_tercile = x.t FROM (SELECT id, NTILE(3) OVER (PARTITION BY kind ORDER BY prominence) AS t
          FROM document WHERE collection_id = ? AND prominence IS NOT NULL AND deleted_at IS NULL) AS x WHERE x.id = document.id`).run(c.id);
      setMeta(db, collectionStatusKey(c.slug), 'ready');
      bumpDataVersion(db);
    });
  }
  if (adapter.id === 'stemm.openalex' && typeof adapter.loadCells === 'function') {
    const cells = adapter.loadCells();
    tx(db, () => setMeta(db, OPENALEX_CELLS_KEY, JSON.stringify({ source: 'sources/openalex/coverage.tsv', bins: adapter.BINS.map((b) => b.bin),
      selection: adapter.SELECTION_LABEL, cells })));
    out.cells = cells.length;
  }
  return out;
}

/**
 * One chunk of a chained STEMM load: documents (each collection in order) → relationships → finish. Queues the
 * next chunk when time is up.
 * @param {object} ctx TaskCtx
 * @param {object} adapter
 * @param {object} params the job params (user params + `chain`, `untilDone`, `chunkMs`, `relChunk`)
 * @returns {Promise<object>} result_json
 */
async function runChained(ctx, adapter, params) {
  const db = ctx.db;
  const t0 = Date.now();
  const deadline = params.untilDone ? Infinity : t0 + (params.chunkMs ?? CHAIN_MS);
  const user = userParams(params);
  let state = readLoadState(db, adapter.id);
  if (!(params.chain?.root && state?.root === params.chain.root)) {
    state = { root: ctx.jobId ?? null, part: 0, params: scrub(user), status: 'running', phase: 'documents', cursors: {}, done_collections: [],
      rel_cursor: 0, counts: {}, started_at: nowIso(), ms: 0 };
  }
  state.part++;
  state.job = ctx.jobId ?? null;
  state.next_job = null;
  state.status = 'running';
  saveLoadState(db, adapter.id, state);

  const keepOriginal = originalsKeeper(db);
  const probe = await adapter.probe(adapterCtx(ctx, { keepOriginal }));
  if (!probe.available) {
    throw Object.assign(badRequest('E_ADAPTER_UNAVAILABLE', `${adapter.id} is unavailable: ${probe.reason ?? 'no reason given'}`,
      `Run ${adapter.command ?? 'its fetcher'} yourself, then retry.`), { detail: { adapter: adapter.id } });
  }
  const rows = tx(db, () => {
    const r = ensureAdapterCollections(db, adapter, { caveats: probe.caveats ?? [], only: user.collections ?? null });
    for (const c of r) if (!state.done_collections.includes(c.slug) || state.phase !== 'finish') setMeta(db, collectionStatusKey(c.slug), 'indexing');
    return r;
  });
  state.units ??= (await adapter.plan(user, adapterCtx(ctx, { keepOriginal }))).units;
  const docShare = typeof adapter.relationships === 'function' ? 0.85 : 0.98;
  const relBytes = typeof adapter.citationsBytes === 'function' ? adapter.citationsBytes() : 1;
  const report = (fraction, phase, message) => {
    ctx.progress?.(Math.min(0.999, fraction), phase, message, { part: state.part });
    state.progress = Math.min(0.999, fraction);
    state.message = message;
  };
  const docsDone = () => rows.reduce((n, c) => n + loadedExtIds(db, c.slug).size, 0);
  const continueChain = () => {
    state.ms += Date.now() - t0;
    const next = ctx.enqueue ? ctx.enqueue('adapter-load', { ...user, adapter: adapter.id, chain: { root: state.root, part: state.part + 1 },
      ...(params.chunkMs ? { chunkMs: params.chunkMs } : {}), ...(params.relChunk ? { relChunk: params.relChunk } : {}) }) : null;
    state.next_job = next;
    saveLoadState(db, adapter.id, state);
    emitAdapter(ctx, { id: adapter.id, loaded: false, staged: true, message: state.message, job: next, progress: state.progress });
    return { adapter: adapter.id, version: adapter.version, part: state.part, phase: state.phase, continued_by: next, counts: state.counts,
      message: state.message };
  };

  // 1. documents, collection by collection; each chunk is one batch
  if (state.phase === 'documents') {
    let base = docsDone();
    for (const c of rows) {
      if (state.done_collections.includes(c.slug)) continue;
      let cursor = state.cursors[c.slug] ?? 0;
      const counts = await loadCollection(ctx, adapter, c.slug, { ...user, skip: loadedExtIds(db, c.slug), from: cursor,
        writerOptions: { ...(adapter.writerOptions ?? {}) } }, {
        keepOriginal, relationships: false, annotations: false, deadline,
        onDocument: (n, r, doc, extra) => {
          if (Number.isInteger(extra._cursor)) cursor = extra._cursor;
          if (n % 250 === 0) report(docShare * ((base + n) / Math.max(1, state.units)), 'documents', `${adapter.label}: ${(base + n).toLocaleString('en')} / ${state.units.toLocaleString('en')}`);
        },
      });
      state.cursors[c.slug] = cursor;
      addCounts(state.counts[c.slug] ??= {}, counts);
      base = docsDone();
      report(docShare * (base / Math.max(1, state.units)), 'documents', `${adapter.label}: ${base.toLocaleString('en')} / ${state.units.toLocaleString('en')}`);
      if (counts.stopped_early) return continueChain();
      state.done_collections.push(c.slug);
      saveLoadState(db, adapter.id, state);
    }
    state.phase = typeof adapter.relationships === 'function' ? 'relationships' : 'finish';
    saveLoadState(db, adapter.id, state);
  }

  // 2. relationships (OpenAlex citations between loaded works), ≤ relChunk per batch
  if (state.phase === 'relationships') {
    const slug = rows[0].slug;
    const loaded = new Set([...loadedExtIds(db, slug)].map((x) => x.slice(3)));
    const existing = existingCitationPairs(db);
    for (;;) {
      const r = await relationshipChunk(ctx, adapter, slug, { ...user, loaded, existing, from: state.rel_cursor },
        { max: params.relChunk ?? REL_CHUNK, deadline });
      state.rel_cursor = r.cursor;
      addCounts(state.counts.relationships ??= {}, r.counts);
      report(docShare + (1 - docShare - 0.02) * (state.rel_cursor / Math.max(1, relBytes)), 'relationships',
        `${adapter.label}: citations ${Math.round(100 * state.rel_cursor / Math.max(1, relBytes))}% read`);
      saveLoadState(db, adapter.id, state);
      if (r.done) break;
      if (Date.now() > deadline) return continueChain();
    }
    state.phase = 'finish';
    saveLoadState(db, adapter.id, state);
  }

  // 3. aliases onto other collections (Cipher books on the STEMM shelf), caveats, terciles, status
  if (typeof adapter.aliases === 'function') {
    const batchId = createBatch(db, { collection: rows[0].slug, adapterId: adapter.id, adapterVersion: adapter.version, format: 'adapter',
      options: { part: 'aliases' }, jobId: ctx.jobId ?? null });
    const writer = createDocumentWriter(db, { batchId, collection: rows[0].slug, corpus: corpusFor(adapter.id), options: { dedupe: 'off' } });
    let n = 0;
    try {
      for (const a of await adapter.aliases(user)) if (writer.addAlias(a.target, a.alias)) n++;
      writer.finish();
    } catch (err) { writer.rollback(); throw err; }
    state.counts.aliases = n;
  }
  state.coverage = await finishCollections(ctx, adapter, rows, probe);
  state.status = 'done';
  state.phase = 'done';
  state.ms += Date.now() - t0;
  state.finished_at = nowIso();
  report(1, 'done', `${adapter.label}: loaded`);
  state.progress = 1;
  saveLoadState(db, adapter.id, state);
  emitAdapter(ctx, { id: adapter.id, loaded: true, staged: true, message: state.message, job: null, progress: 1 });
  return { adapter: adapter.id, version: adapter.version, part: state.part, phase: 'done', counts: state.counts, coverage: state.coverage,
    total_ms: state.ms, started_at: state.started_at, finished_at: state.finished_at };
}

/**
 * Record how a chained load stopped (cancelled → 'cancelled', otherwise 'failed'); collections with committed
 * documents are 'partial', the others go back to their earlier status.
 */
function stopChain(ctx, adapter, err) {
  const db = ctx.db;
  const state = readLoadState(db, adapter.id);
  if (!state || state.job !== (ctx.jobId ?? null)) return;
  const cancelled = err?.code === 'E_CANCELLED';
  state.status = cancelled ? 'cancelled' : 'failed';
  state.error = cancelled ? null : { code: err?.code ?? 'E_INTERNAL', message: String(err?.message ?? err) };
  state.message = cancelled ? 'Load cancelled: committed chunks are kept; Load again continues from them.' : `Load failed: ${err?.message ?? err}`;
  try {
    tx(db, () => {
      for (const c of adapter.collections) {
        if (getMeta(db, collectionStatusKey(c.slug)) !== 'indexing') continue;
        setMeta(db, collectionStatusKey(c.slug), loadedExtIds(db, c.slug).size ? 'partial' : 'empty');
      }
      saveLoadState(db, adapter.id, state);
    });
  } catch (e) { ctx.log?.('error', `could not record the stopped load of ${adapter.id}: ${e.message}`); }
  emitAdapter(ctx, { id: adapter.id, loaded: false, staged: true, message: state.message, job: null, status: state.status });
}

// ── the generic job ─────────────────────────────────────────────────────────────────────────────────

/**
 * Load everything an adapter offers in one call (the demo, tests, scripts).
 * @param {object} ctx TaskCtx
 * @param {object} adapter SourceAdapter
 * @param {object} params adapter params; `collections` limits which collections load
 * @param {{onProgress?: (fraction: number, message: string) => void}} [opts]
 * @returns {Promise<object>} result_json
 */
export async function loadAdapterData(ctx, adapter, params = {}, { onProgress = () => {} } = {}) {
  const keepOriginal = originalsKeeper(ctx.db);
  const actx = adapterCtx(ctx, { keepOriginal });
  const probe = await adapter.probe(actx);
  if (!probe.available) {
    throw Object.assign(badRequest('E_ADAPTER_UNAVAILABLE', `${adapter.id} is unavailable: ${probe.reason ?? 'no reason given'}`,
      'Stage the source files (see FORMAT.md) and retry.'), { detail: { adapter: adapter.id } });
  }
  const result = { adapter: adapter.id, version: adapter.version, started_at: nowIso(), collections: {}, probe: probe.counts };
  const rows = ensureAdapterCollections(ctx.db, adapter, { caveats: probe.caveats ?? [], only: params.collections ?? null });
  const { units } = await adapter.plan(params, actx);
  let done = 0;
  for (const [i, c] of rows.entries()) {
    const p = adapter.writerOptions ? { ...params, writerOptions: { ...adapter.writerOptions, ...(params.writerOptions ?? {}) } } : params;
    result.collections[c.slug] = await loadCollection(ctx, adapter, c.slug, p, {
      keepOriginal, onDocument: () => { done++; onProgress(units ? done / units : 0, `${adapter.label}: ${done} / ${units}`); },
      // aliases onto documents of other collections (e.g. a STEMM book that is a Cipher book), once
      beforeRelationships: i === 0 && typeof adapter.aliases === 'function' ? async (writer) => {
        let n = 0;
        for (const a of await adapter.aliases(params)) if (writer.addAlias(a.target, a.alias)) n++;
        result.aliases = n;
      } : undefined,
    });
  }
  if (typeof adapter.etymons === 'function') result.etymology = await writeEtymons(ctx, adapter.etymons(params, actx));
  if (typeof adapter.themeAssocs === 'function') {
    result.themes = await writeThemeAssocs(ctx, adapter.themeAssocs(params, actx), adapter.themeLabels?.(params, actx) ?? null);
  }
  result.finished_at = nowIso();
  return result;
}

/**
 * @param {object} ctx TaskCtx
 * @param {{adapter: string, apply?: 'deferred', chain?: {root: number, part: number}, untilDone?: boolean}} params adapter id +
 *   adapter params; {adapter:'demo', apply:'deferred'} applies the demo's deferred reviews and labels; STEMM document
 *   adapters run as a chain of ≈ 20 s chunks (untilDone: one call loads everything — scripts and tests)
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  if (!params?.adapter) throw badRequest('E_VALIDATION', 'adapter-load needs {adapter: "<id>"}.', 'Name a registered adapter.');
  if (params.adapter === 'demo' && params.apply === 'deferred') {
    // the demo's human layer on rows the pipeline made after loading (see tasks/demo-load.mjs)
    const { applyDeferred } = await import('./demo-load.mjs');
    return applyDeferred(ctx);
  }
  const adapter = await loadAdapter(params.adapter);
  if (adapter.id === 'stemm.wiktionary') return loadWiktionary(ctx, adapter, userParams(params));
  if (CHAINED.includes(adapter.id)) {
    try {
      return await runChained(ctx, adapter, params);
    } catch (err) {
      stopChain(ctx, adapter, err);
      throw err;
    }
  }
  return loadAdapterData(ctx, adapter, userParams(params), { onProgress: (f, m) => ctx.progress(f, 'load', m) });
}
