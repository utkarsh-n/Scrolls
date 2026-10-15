// OWNER: WP0 — the one writer every source goes through (SPEC §5, §4.2–4.3, §12.2)
//
// Parsers (WP1) and adapters (WP2) hand CanonicalDocument / CanonicalRelationship / CanonicalAnnotation
// objects (§12.3) to a DocumentWriter. The writer parses dates, segments and tokenizes the ORIGINAL text,
// identifies languages, and writes document, document_text, document_field, passage + passage_fts,
// date_assertion (+ date_rtree), chronology, doc_bin, doc_tokens, aliases, tags, label_tri, text_sha256 /
// dup_of and doc_minhash. Relationships and annotations are resolved by ext_id at finish().
//
// Invariants enforced here (tests/writer.test.mjs):
//  · passage text === original.slice(start_off, end_off) (body) or document_field.value.slice(…) (fields);
//  · passage_fts row i holds exactly the JS tokens of that slice (FTS token i = JS token i);
//  · is_synthetic is copied from the corpus onto every row this writer creates;
//  · doc_bin only for chrono_status='dated'; doc_tokens = quality='ok' passages only;
//  · rollback() leaves zero rows of the batch.
// Transactions: one BEGIN IMMEDIATE per ≤ 5,000 documents / 50,000 rows / 500 ms (whichever comes first),
// so interactive writes on the main connection never wait long; each document is atomic (SAVEPOINT).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from '../../src/shared/contracts.mjs';
import { parseDate, todayDay, ymdFromDay } from '../../src/shared/dates.mjs';
import { canonicalJson, mulberry32, parseRef } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { DOC_FIELDS, fillTemplate, ISSUE_CODES, REL_ENDPOINT_TYPES, REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { log, paths } from '../config.mjs';
import { bumpDataVersion, ftsDelete, interactiveWriteWaiting, isConstraintError, nowIso, pauseForWal, stmt, tx,
  yieldToInteractiveWriters } from '../db/open.mjs';
import { detectLangFromTokens, documentLang, scriptOf } from '../text/langid.mjs';
import { segment } from '../text/segment.mjs';
import { writeDocBins } from './bins.mjs';
import { addSignature, lshCandidates, metaKey, openDupIndex, saveDupIndex } from './dup-index.mjs';

const FLUSH_DOCS = 5000;
const FLUSH_ROWS = 50000;
const MAX_TX_MS = 500;
const MAX_TEXT_CHARS = 20 * 1024 * 1024;
const MAX_META_JSON = 64 * 1024;
const MINHASH_PERMS = 128;
const MINHASH_SHINGLE = 5;
const MINHASH_MIN_TOKENS = 20;
const NEAR_DUP_JACCARD = 0.9;
const ANCHOR_CONTEXT = 32;
const CHRONO_ROLES = ['publication', 'original_publication', 'creation', 'publication_unspecified', 'release',
  'recording', 'performance'];
const SCAN_LANG_CLASSES = new Set(['text', 'title', 'abstract']);
const ISSUES_KEPT = 20;

/** Default suggestion per issue code (every stored issue carries a non-empty suggestion). */
const SUGGESTIONS = {
  E_DATE_UNPARSEABLE: 'Write the date as YYYY, YYYY-MM-DD, "c. YYYY" or a range; the record was kept as undated.',
  E_DATE_AMBIGUOUS: 'Write the full year, or set "two-digit years → 19xx" in the date options; the record was kept as undated.',
  E_DATE_INVALID: 'Check the day and month; the record was kept as undated.',
  W_DATE_FUTURE: 'If this is a plan or an announcement, nothing to do (Scheduled shelf); otherwise correct the date.',
  W_AMBIGUOUS_HUNDREDS: 'Write e.g. 1800–1809 if the decade was meant.',
  W_DATE_SEASON: 'Give the month if it is known.',
  W_LANG_MISMATCH: 'Nothing to do if this is a translation (excluded from text-language chronology by default); otherwise correct the declared language.',
  W_MIXED_LANGUAGE: 'Nothing to do: lanes split by passage language.',
  W_DUP_CONTENT: 'Keep it flagged (excluded from counts by default), or revert one of the two imports.',
  W_NEAR_DUP: 'Choose "keep both" or "mark as duplicate" in the import summary.',
  W_DUP_METADATA: 'Check whether the two records describe the same work.',
  E_DUP_ID: 'Give every record a unique id, or revert the earlier import first.',
  E_FIELD_TYPE: 'Fix the field in the source file; the message names the expected shape.',
  E_MISSING_TEXT: 'Map a text column or a title, or allow metadata-only rows.',
  E_ROW_TOO_LARGE: 'Split the file, or import the text as TXT.',
  W_UNRESOLVED_TARGET: 'Check the target id: it must be an ext_id (or alias) in this collection, or name its collection.',
  W_SYNTHETIC_TARGET: 'Link real records to real records only: the demo is invented material and never part of your data.',
};

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const excerpt = (v) => (v === undefined || v === null ? null : String(v).slice(0, 200));

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function fieldClassOf(field, roles) {
  if (field === 'title' || field === 'native_title') return { field_class: 'title', time_role: 'document' };
  if (field === 'summary') {
    return (roles?.summary ?? 'describes') === 'document' ? { field_class: 'text', time_role: 'document' }
      : { field_class: 'describes', time_role: 'describes' };
  }
  if (field === 'abstract') {
    return (roles?.abstract ?? 'document') === 'describes' ? { field_class: 'describes', time_role: 'describes' }
      : { field_class: 'abstract', time_role: 'document' };
  }
  return { field_class: 'describes', time_role: 'describes' }; // gloss, entry: written later, about the item
}

function rowOf(db, table, keyCol, value) {
  return stmt(db, `SELECT * FROM ${table} WHERE ${keyCol} = ?`).get(value) ?? null;
}

function resolveCorpus(db, corpus) {
  if (corpus === undefined || corpus === null) return null;
  if (typeof corpus === 'object') return corpus.id ? rowOf(db, 'corpus', 'id', corpus.id) : rowOf(db, 'corpus', 'slug', corpus.slug);
  return typeof corpus === 'number' ? rowOf(db, 'corpus', 'id', corpus) : rowOf(db, 'corpus', 'slug', corpus);
}

function resolveCollection(db, collection) {
  if (typeof collection === 'object' && collection) {
    return collection.id ? rowOf(db, 'collection', 'id', collection.id) : rowOf(db, 'collection', 'slug', collection.slug);
  }
  return typeof collection === 'number' ? rowOf(db, 'collection', 'id', collection) : rowOf(db, 'collection', 'slug', collection);
}

// ── originals, collections, batches (shared helpers for WP1/WP2) ───────────────────────────────────

/**
 * Store verbatim bytes under originals/<sha[0:2]>/<sha256> (content-addressed, immutable) and record the
 * original_file row. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Uint8Array|Buffer} bytes
 * @param {{sourcePath?: string|null, encoding?: string, hadBom?: boolean}} [meta]
 * @returns {string} sha256 hex
 */
export function storeOriginal(db, bytes, { sourcePath = null, encoding = 'utf-8', hadBom = false } = {}) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rel = path.join('originals', sha.slice(0, 2), sha);
  const abs = path.join(paths().data, rel);
  if (!existsSync(abs)) {
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  }
  stmt(db, `INSERT INTO original_file (sha256, rel_path, source_path, byte_size, encoding, had_bom, stored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`)
    .run(sha, rel, sourcePath, bytes.byteLength, encoding, hadBom ? 1 : 0, nowIso());
  return sha;
}

/**
 * Create a collection if its slug is new (is_synthetic copied from the corpus); returns its row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{slug: string, name: string, corpus: string|number, adapter_id: string, domain: string, modality: string,
 *   unit: string, sampling: string, rate_eligible?: boolean|number, coverage_gate?: number|null,
 *   export_text_allowed?: boolean|number, license?: string|null, attribution?: string|null,
 *   selection_note?: string|null, caveats?: string[], source_uri?: string|null, retrieved_at?: string|null}} spec
 * @returns {object} the collection row
 */
export function ensureCollection(db, spec) {
  const existing = rowOf(db, 'collection', 'slug', spec.slug);
  if (existing) return existing;
  const corpus = resolveCorpus(db, spec.corpus);
  if (!corpus) throw new TypeError(`ensureCollection: unknown corpus '${spec.corpus}'`);
  const bit = (v, d) => (v === undefined || v === null ? d : v ? 1 : 0);
  stmt(db, `INSERT INTO collection (corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, rate_eligible,
      coverage_gate, export_text_allowed, is_synthetic, license, attribution, selection_note, caveats_json, source_uri,
      retrieved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(corpus.id, spec.adapter_id, spec.slug, spec.name, spec.domain, spec.modality, spec.unit, spec.sampling,
      bit(spec.rate_eligible, 1), spec.coverage_gate ?? null, bit(spec.export_text_allowed, 1), corpus.is_synthetic,
      spec.license ?? null, spec.attribution ?? null, spec.selection_note ?? null, JSON.stringify(spec.caveats ?? []),
      spec.source_uri ?? null, spec.retrieved_at ?? null, nowIso());
  return rowOf(db, 'collection', 'slug', spec.slug);
}

/**
 * Create an import_batch row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{collection: string|number|object, adapterId?: string, adapterVersion?: string, format?: string,
 *   fileSha256?: string|null, fileName?: string|null, mapping?: object, options?: object, status?: string,
 *   jobId?: number|null}} spec
 * @returns {number} batch id
 */
export function createBatch(db, { collection, adapterId, adapterVersion, format = 'adapter', fileSha256 = null,
  fileName = null, mapping = {}, options = {}, status = 'committing', jobId = null }) {
  const coll = resolveCollection(db, collection);
  if (!coll) throw new TypeError(`createBatch: unknown collection '${collection}'`);
  const adapter = adapterId ?? coll.adapter_id;
  const version = adapterVersion ?? rowOf(db, 'source_adapter', 'id', adapter)?.version ?? '0';
  const r = stmt(db, `INSERT INTO import_batch (collection_id, adapter_id, adapter_version, file_sha256, file_name, format,
      mapping_json, options_json, status, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(coll.id, adapter, version, fileSha256, fileName, format, JSON.stringify(mapping), JSON.stringify(options),
      status, jobId, nowIso());
  return Number(r.lastInsertRowid);
}

/**
 * Document id for an ext_id (or an alias) in a collection; with no collection, the unique match across
 * collections (null when absent or ambiguous).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{collectionSlug?: string|null, extId: string}} q
 * @returns {number|null}
 */
export function resolveExt(db, { collectionSlug = null, extId }) {
  if (collectionSlug) {
    const d = stmt(db, `SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL`).get(collectionSlug, extId);
    if (d) return d.id;
    const a = stmt(db, `SELECT a.document_id AS id FROM document_alias a JOIN document d ON d.id = a.document_id
      JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND a.ext_id = ? AND d.deleted_at IS NULL
      ORDER BY a.document_id LIMIT 1`).get(collectionSlug, extId);
    return a ? a.id : null;
  }
  const rows = stmt(db, `SELECT id FROM document WHERE ext_id = ? AND deleted_at IS NULL
    UNION SELECT a.document_id FROM document_alias a JOIN document d ON d.id = a.document_id
    WHERE a.ext_id = ? AND d.deleted_at IS NULL LIMIT 2`).all(extId, extId);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * FTS bulk-load mode (§4.4): automerge off while loading many documents, then back on and `optimize`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {boolean} on
 */
export function setFtsBulkLoad(db, on) {
  if (on) {
    db.exec("INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 0)");
  } else {
    db.exec("INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 4)");
    db.exec("INSERT INTO passage_fts (passage_fts) VALUES ('optimize')");
  }
}

// ── MinHash (128 permutations over 5-token shingles) ────────────────────────────────────────────────

const PERM_A = new Uint32Array(MINHASH_PERMS);
const PERM_B = new Uint32Array(MINHASH_PERMS);
{
  const rnd = mulberry32(0x5c2011);
  for (let i = 0; i < MINHASH_PERMS; i++) {
    PERM_A[i] = (Math.floor(rnd() * 0xffffffff) | 1) >>> 0;
    PERM_B[i] = Math.floor(rnd() * 0xffffffff) >>> 0;
  }
}

function tokenHash(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * MinHash signature of a folded token sequence (whole-document near-duplicate detection, §5.4).
 * @param {string[]} tokens
 * @returns {Uint32Array|null} null when there are fewer than 20 tokens
 */
export function minhashSignature(tokens) {
  if (tokens.length < MINHASH_MIN_TOKENS) return null;
  const th = new Uint32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) th[i] = tokenHash(tokens[i]);
  const shingles = new Set();
  for (let i = 0; i + MINHASH_SHINGLE <= th.length; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < MINHASH_SHINGLE; j++) h = Math.imul(h ^ th[i + j], 0x01000193);
    shingles.add(h >>> 0);
  }
  const sig = new Uint32Array(MINHASH_PERMS).fill(0xffffffff);
  for (const h of shingles) {
    for (let p = 0; p < MINHASH_PERMS; p++) {
      const v = (Math.imul(PERM_A[p], h) + PERM_B[p]) >>> 0;
      if (v < sig[p]) sig[p] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures. */
export function minhashJaccard(a, b) {
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

// ── rollback of a whole batch (also used by boot recovery) ──────────────────────────────────────────

/**
 * Delete every row created for the documents of an import batch and mark the batch failed. Relationships
 * and annotations are written only by a successful finish(), so a batch that never committed has none.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} batchId
 * @param {{status?: string}} [opts]
 * @returns {number} documents removed
 */
export function rollbackBatch(db, batchId, { status = 'failed' } = {}) {
  return tx(db, () => {
    const ids = stmt(db, 'SELECT id FROM document WHERE import_batch_id = ?').all(batchId).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = JSON.stringify(ids.slice(i, i + 500));
      const inDocs = '(SELECT value FROM json_each(?))';
      const passageIds = JSON.stringify(stmt(db, `SELECT id FROM passage WHERE document_id IN ${inDocs}`).all(chunk).map((r) => r.id));
      const inPass = '(SELECT value FROM json_each(?))';
      ftsDelete(db, `DELETE FROM passage_fts WHERE rowid IN ${inPass}`, passageIds);
      stmt(db, `DELETE FROM relationship_evidence WHERE passage_id IN ${inPass}`).run(passageIds);
      stmt(db, `DELETE FROM cluster_member WHERE occurrence_id IN (SELECT id FROM occurrence WHERE passage_id IN ${inPass})`).run(passageIds);
      stmt(db, `DELETE FROM occurrence WHERE passage_id IN ${inPass}`).run(passageIds);
      stmt(db, `DELETE FROM expr_doc WHERE document_id IN ${inDocs}`).run(chunk);
      const assertion = `SELECT id FROM date_assertion WHERE (subject_type = 'document' AND subject_id IN ${inDocs})
        OR (subject_type = 'passage' AND subject_id IN ${inPass})`;
      stmt(db, `DELETE FROM date_rtree WHERE id IN (${assertion})`).run(chunk, passageIds);
      stmt(db, `DELETE FROM date_assertion WHERE id IN (${assertion})`).run(chunk, passageIds);
      for (const table of ['doc_bin', 'doc_tokens', 'doc_minhash', 'doc_tag', 'document_alias', 'document_field', 'document_text']) {
        stmt(db, `DELETE FROM ${table} WHERE document_id IN ${inDocs}`).run(chunk);
      }
      stmt(db, `DELETE FROM passage WHERE document_id IN ${inDocs}`).run(chunk);
      const refs = JSON.stringify(ids.slice(i, i + 500).map((id) => `document:${id}`));
      ftsDelete(db, 'DELETE FROM label_tri WHERE ref IN (SELECT value FROM json_each(?))', refs);
      stmt(db, `UPDATE document SET dup_of = NULL WHERE dup_of IN ${inDocs}`).run(chunk);
      stmt(db, `DELETE FROM document WHERE id IN ${inDocs}`).run(chunk);
    }
    stmt(db, 'UPDATE import_batch SET status = ? WHERE id = ?').run(status, batchId);
    return ids.length;
  });
}

// ── the writer ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The repeat-load check of a relationship (M5 gate): the same type, ends, status, origin, author, dataset, locator and
 * run is written once. The unary `+` keeps rel_type and evidence_status off the rel_kind index, so the planner seeks an
 * endpoint index (rel_src / rel_dst). Without it, an unanalysed database scans every link of the type for each new
 * link: quadratic, and a fresh Cipher bootstrap stalled for over 45 min in its 170k music-relation links (final gate).
 */
export const DUP_RELATIONSHIP_SQL = `SELECT id FROM relationship WHERE src_type = ? AND src_ref = ? AND dst_type = ? AND dst_ref = ?
  AND +rel_type = ? AND +evidence_status = ? AND origin = ? AND created_by = ? AND IFNULL(source_dataset, '') = ?
  AND IFNULL(source_locator, '') = ? AND IFNULL(run_id, -1) = ? LIMIT 1`;

/**
 * @param {import('node:sqlite').DatabaseSync} db a writable connection
 * @param {{batchId?: number|null, collection: string|number|object, corpus?: string|number|object|null,
 *   options?: {dedupe?: 'flag'|'skip'|'off', detectLanguage?: boolean, onBadRow?: 'skip_and_report'|'abort',
 *   dateOptions?: object, now?: Date}}} cfg
 */
export function createDocumentWriter(db, { batchId = null, collection, corpus = null, options = {} }) {
  const { dedupe = 'flag', detectLanguage = true, onBadRow = 'skip_and_report', dateOptions = {}, now = new Date() } = options;
  const coll = resolveCollection(db, collection);
  if (!coll) throw new TypeError(`DocumentWriter: unknown collection '${typeof collection === 'object' ? JSON.stringify(collection) : collection}'`);
  const corp = resolveCorpus(db, corpus ?? coll.corpus_id);
  if (!corp) throw new TypeError(`DocumentWriter: unknown corpus '${corpus}'`);
  if (corp.id !== coll.corpus_id) throw new TypeError(`DocumentWriter: collection '${coll.slug}' does not belong to corpus '${corp.slug}'`);
  const synthetic = corp.is_synthetic ? 1 : 0;
  const batch = batchId ?? createBatch(db, { collection: coll.id });
  if (!rowOf(db, 'import_batch', 'id', batch)) throw new TypeError(`DocumentWriter: unknown import batch ${batch}`);
  const assertedIngestion = `import:${batch}`;
  const today = todayDay(now);
  const todayYear = ymdFromDay(today).y;

  let ownsTx = false, txStart = 0, docsInTx = 0, rowsInTx = 0, idleTimer = null, closed = false, commits = 0;
  let uncommittedIssues = [];
  const pendingRels = [];
  const pendingAnns = [];
  const extLines = new Map();       // ext_id → first line (E_DUP_ID within this batch)
  const addedAliases = [];          // aliases added to documents of other batches (for rollback)
  let dup = null;                   // the collection's duplicate indexes (dup-index.mjs), owned until finish/rollback
  let dupInfo = null;               // where they came from and what opening them cost
  let maxDocId = 0;
  const preloadCheckpoint = typeof options.checkpoint === 'function' ? options.checkpoint : null;
  const dupDiskMin = Number.isInteger(options.dupIndexDiskMin) ? options.dupIndexDiskMin : undefined;
  const counts = {
    documents: { created: 0, rejected: 0, duplicates_flagged: 0, near_duplicates: 0, metadata_only: 0, translations: 0 },
    passages: 0, tokens: 0,
    dates: { day: 0, month: 0, year: 0, decade: 0, century: 0, millennium: 0, range: 0, period: 0, circa: 0, unknown: 0,
      scheduled: 0, span: { from: null, to: null } },
    languages: {},
    relationships: { documented: 0, computed: 0, proposed: 0, unresolved_targets: 0, rejected: 0 },
    annotations: { created: 0, rejected: 0 },
    issues: { total: 0, by_code: {}, first: [] },
  };
  let spanLo = null, spanHi = null, spanLoLabel = null, spanHiLabel = null;

  // ── transactions ──

  function begin() {
    if (db.isTransaction) return; // inside the caller's transaction (or our own)
    // M5 gate: the duplicate indexes of the collection are read before the first write lock, not inside it, and
    // once per chain rather than once per chunk (dup-index.mjs: the previous writer's index, or its disk cache).
    if (dedupe !== 'off' && !dup) openIndex();
    yieldToInteractiveWriters(); // a waiting save-view/annotation write goes first (open.mjs, M1 gate)
    db.exec('BEGIN IMMEDIATE');
    ownsTx = true;
    txStart = Date.now();
    docsInTx = 0;
    rowsInTx = 0;
  }

  function commit() {
    if (ownsTx && db.isTransaction) {
      db.exec('COMMIT');
      if (++commits % 20 === 0) pauseForWal(db); // §4.12: a WAL over 1 GB pauses the next batch
    }
    ownsTx = false;
    uncommittedIssues = [];
  }

  function scheduleIdleFlush() {
    clearTimeout(idleTimer);
    if (!ownsTx) return;
    idleTimer = setTimeout(() => { if (!closed && ownsTx) commit(); }, MAX_TX_MS);
    idleTimer.unref?.();
  }

  function maybeFlush() {
    // a save-view or annotation waiting on the main thread (open.mjs handoff) gets the lock after this record
    if (ownsTx && (docsInTx >= FLUSH_DOCS || rowsInTx >= FLUSH_ROWS || Date.now() - txStart >= MAX_TX_MS
      || interactiveWriteWaiting())) commit();
  }

  // ── issues ──

  function recordIssue(issue) {
    const def = ISSUE_CODES[issue.code];
    const full = {
      code: issue.code,
      severity: issue.severity ?? def?.severity ?? 'warning',
      line: Number.isInteger(issue.line) ? issue.line : null,
      col: Number.isInteger(issue.col) ? issue.col : null,
      field: issue.field ?? null,
      value_excerpt: excerpt(issue.value_excerpt),
      message: issue.message || (def ? fillTemplate(def.template, issue.vars ?? {}) : issue.code),
      suggestion: issue.suggestion || SUGGESTIONS[issue.code] || 'See the message for what to change.',
    };
    begin();
    stmt(db, `INSERT INTO import_issue (batch_id, severity, code, line, col, field, value_excerpt, message, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(batch, full.severity, full.code, full.line, full.col, full.field, full.value_excerpt, full.message, full.suggestion);
    rowsInTx++;
    uncommittedIssues.push(full);
    counts.issues.total++;
    counts.issues.by_code[full.code] = (counts.issues.by_code[full.code] ?? 0) + 1;
    if (counts.issues.first.length < ISSUES_KEPT) counts.issues.first.push(full);
    return full;
  }

  function reject(issues, issue) {
    issues.push(recordIssue({ severity: 'rejected', ...issue }));
    counts.documents.rejected++;
    if (onBadRow === 'abort') {
      api.rollback();
      const err = new Error(`Import aborted: ${issue.message ?? issue.code}`);
      err.code = 'E_IMPORT_ABORTED';
      err.issues = issues;
      throw err;
    }
    return { documentId: null, issues };
  }

  // ── dates ──

  function parseAssertions(doc, line, issues) {
    return (doc.dates ?? []).map((d) => {
      let parsed = d.parsed ?? null, issue = null;
      if (!parsed) {
        const r = parseDate(d.raw ?? null, { ...dateOptions, now });
        if (r.issue) issue = r.issue; else parsed = r;
      }
      if (issue) {
        issues.push(recordIssue({ code: issue.code, line, field: `date:${d.role}`, value_excerpt: d.raw,
          message: `${doc.ext_id}: ${issue.message}`,
          suggestion: issue.suggestions?.length ? `Try ${issue.suggestions.map((s) => `'${s}'`).join(' or ')}; the record was kept as undated.` : undefined }));
      }
      for (const w of parsed?.warnings ?? []) {
        issues.push(recordIssue({ code: w, line, field: `date:${d.role}`, value_excerpt: d.raw ?? parsed.raw,
          vars: { value: d.raw ?? parsed.raw, from: parsed.lo_year, to: parsed.hi_year } }));
      }
      return { role: d.role, parsed, raw: d.raw ?? parsed?.raw ?? null, asserted_by: d.asserted_by,
        is_chronology: d.is_chronology === true, note: d.note ?? null, issue };
    });
  }

  function chronologyOf(assertions) {
    const flagged = assertions.find((a) => a.is_chronology);
    if (flagged) return flagged;
    const chosen = assertions.find((a) => CHRONO_ROLES.includes(a.role));
    if (chosen) chosen.is_chronology = true;
    return chosen ?? null;
  }

  // ── passages ──

  function langOf(tokens, slice, declared) {
    if (!detectLanguage) return { lang: declared ?? 'und', confidence: declared ? 1 : 0 };
    return detectLangFromTokens(tokens, { declared, script: scriptOf(slice) });
  }

  function bodyPassages(doc) {
    const t = doc.text;
    const original = t.original;
    const tok = tokenize(original);
    const start = t.body_start ?? 0, end = t.body_end ?? original.length;
    const segs = segment(original, { mode: t.mode ?? 'auto', lang: doc.lang_declared ?? null, regions: t.regions ?? [],
      start, end, tokens: tok });
    const out = segs.map((s) => {
      const i0 = lowerBound(tok.starts, s.start), i1 = lowerBound(tok.starts, s.end);
      const tokens = tok.tokens.slice(i0, i1);
      const slice = original.slice(s.start, s.end);
      return { ...s, field: 'body', tokens, norm: tokens.join(' '), ...langOf(tokens, slice, doc.lang_declared) };
    });
    const b0 = lowerBound(tok.starts, start), b1 = lowerBound(tok.starts, end);
    return { passages: out, bodyTokens: tok.tokens.slice(b0, b1) };
  }

  function fieldPassages(doc, fields) {
    const out = [];
    for (const field of DOC_FIELDS) {
      const value = fields[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const tokens = tokenize(value).tokens;
      out.push({ field, start: 0, end: value.length, unit: 'field', page_no: null, quality: 'ok',
        ...fieldClassOf(field, doc.field_roles), token_count: tokens.length, tokens, norm: tokens.join(' '),
        ...langOf(tokens, value, doc.lang_declared) });
    }
    return out;
  }

  // ── duplicates ──

  function openIndex() {
    const r = openDupIndex(db, coll.id, { checkpoint: preloadCheckpoint });
    dup = r.index;
    dupInfo = { source: r.source, ms: Math.round(r.ms), metaKeys: dup.metaKeys.size, signatures: dup.sigs.size };
    log('debug', `duplicate index of '${coll.slug}' from ${r.source} in ${dupInfo.ms} ms`, dupInfo);
  }

  function indexSig(id, sig) {
    if (dup) addSignature(dup, id, sig);
  }

  /** A candidate from the index, confirmed against the live row (an index entry is never trusted alone). */
  function liveSignature(id) {
    const r = stmt(db, `SELECT m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id
      WHERE m.document_id = ? AND d.collection_id = ? AND d.deleted_at IS NULL`).get(id, coll.id);
    return r ? new Uint32Array(r.sig.buffer.slice(r.sig.byteOffset, r.sig.byteOffset + r.sig.byteLength)) : null;
  }

  function nearDuplicate(sig) {
    if (!dup) openIndex();
    let best = null;
    for (const [id, indexed] of lshCandidates(dup, sig)) {
      const j = minhashJaccard(sig, indexed);
      if (j < NEAR_DUP_JACCARD || (best && j <= best.j)) continue;
      const stored = liveSignature(id);
      const jl = stored ? minhashJaccard(sig, stored) : 0;
      if (jl >= NEAR_DUP_JACCARD && (!best || jl > best.j)) best = { id, j: jl };
    }
    return best;
  }

  function metadataDuplicate(key) {
    if (!dup) openIndex();
    const id = dup.metaKeys.get(key);
    if (id === undefined) return null;
    const r = stmt(db, `SELECT title, author, y_lo FROM document WHERE id = ? AND collection_id = ? AND deleted_at IS NULL
      AND has_full_text = 0`).get(id, coll.id);
    if (r && metaKey(r, r.y_lo) === key) return id;
    dup.metaKeys.delete(key);
    return null;
  }

  // ── insertion ──

  function insertDocument(doc, line, issues) {
    const assertions = parseAssertions(doc, line, issues);
    const chrono = chronologyOf(assertions);
    const cp = chrono?.parsed && chrono.parsed.lo_day !== null ? chrono.parsed : null;
    const chronoStatus = !cp ? 'undated' : cp.basis === 'announced' ? 'scheduled' : 'dated';

    const fields = { ...(doc.fields ?? {}) };
    if (!doc.text && !Object.values(fields).some((v) => typeof v === 'string' && v) && doc.title) fields.title = doc.title;
    const body = doc.text ? bodyPassages(doc) : { passages: [], bodyTokens: [] };
    const passages = [...body.passages, ...fieldPassages(doc, fields)];

    const langPassages = passages.filter((p) => SCAN_LANG_CLASSES.has(p.field_class) && p.quality === 'ok')
      .map((p) => ({ lang: p.lang, tokens: p.token_count, confidence: p.confidence }));
    const dl = detectLanguage ? documentLang(langPassages, doc.lang_declared ?? null)
      : { lang_text: doc.lang_declared ?? 'und', confidence: doc.lang_declared ? 1 : 0, is_translation: false, by_lang: {} };
    if (dl.is_translation) {
      issues.push(recordIssue({ code: 'W_LANG_MISMATCH', line, field: 'lang_declared', value_excerpt: doc.lang_declared,
        vars: { declared: doc.lang_declared, detected: dl.lang_text,
          scores: Object.entries(dl.by_lang).map(([l, s]) => `${l} ${s.toFixed(2)}`).join(' / ') } }));
      if (chrono && chrono.role === 'publication') {
        chrono.role = 'original_publication';
        chrono.note = [chrono.note, `role set to original_publication: the text reads as ${dl.lang_text}, not the declared ${doc.lang_declared}`]
          .filter(Boolean).join('; ');
      }
    }
    // An adapter can know what language identification cannot: a text in its declared language that is still a
    // translation (a credited translator, an author who predates the language as written). Same treatment (D8).
    const credited = !dl.is_translation && Boolean(doc.translation?.reason);
    if (credited) {
      issues.push(recordIssue({ code: 'W_TRANSLATION_CREDITED', line, field: 'translation', value_excerpt: doc.ext_id,
        vars: { title: doc.title ?? doc.ext_id, reason: doc.translation.reason } }));
      if (chrono && chrono.role === 'publication') {
        chrono.role = 'original_publication';
        chrono.note = [chrono.note, `role set to original_publication: ${doc.translation.reason}`].filter(Boolean).join('; ');
      }
    }
    const isTranslation = dl.is_translation || credited;
    const detected = Object.entries(dl.by_lang ?? {}).filter(([l]) => !l.startsWith('und'));
    if (detected.length > 1 && detected[1][1] >= 0.15) {
      issues.push(recordIssue({ code: 'W_MIXED_LANGUAGE', line,
        vars: { title: doc.title ?? doc.ext_id, mix: detected.map(([l, s]) => `${l} (${Math.round(s * 100)}%)`).join(' and ') } }));
    }

    // exact and near duplicates of the normalized body
    const textSha = body.bodyTokens.length ? sha256(body.bodyTokens.join(' ')) : null;
    let dupOf = null;
    if (textSha && dedupe !== 'off') {
      const d = stmt(db, 'SELECT id FROM document WHERE text_sha256 = ? AND deleted_at IS NULL AND dup_of IS NULL ORDER BY id LIMIT 1').get(textSha);
      if (d) {
        if (dedupe === 'skip') {
          return reject(issues, { code: 'W_DUP_CONTENT', line, value_excerpt: doc.ext_id, vars: { other: d.id },
            message: `${doc.ext_id}: same text as document ${d.id}; skipped (dedupe = skip).` });
        }
        dupOf = d.id;
        issues.push(recordIssue({ code: 'W_DUP_CONTENT', line, value_excerpt: doc.ext_id, vars: { other: d.id } }));
        counts.documents.duplicates_flagged++;
      }
    }
    const sig = doc.text && !dupOf ? minhashSignature(body.bodyTokens) : null;
    if (sig && dedupe !== 'off') {
      const near = nearDuplicate(sig);
      if (near) {
        issues.push(recordIssue({ code: 'W_NEAR_DUP', line, value_excerpt: doc.ext_id, vars: { other: near.id, jaccard: near.j.toFixed(2) } }));
        counts.documents.near_duplicates++;
      }
    }
    if (!doc.text && dedupe !== 'off' && doc.title) {
      const key = metaKey(doc, cp?.lo_year ?? null);
      const other = metadataDuplicate(key);
      if (other) issues.push(recordIssue({ code: 'W_DUP_METADATA', line, value_excerpt: doc.title, vars: { other } }));
    }

    let sourceSha = null;
    if (doc.source_file) {
      if (!rowOf(db, 'original_file', 'sha256', doc.source_file.sha256)) {
        return reject(issues, { code: 'E_FIELD_TYPE', line, field: 'source_file',
          message: `${doc.ext_id}: source_file.sha256 is not a stored original.`,
          suggestion: 'Store the source file with storeOriginal() before writing its documents.' });
      }
      sourceSha = doc.source_file.sha256;
    }
    let metaJson = JSON.stringify(doc.original_meta ?? {});
    if (metaJson.length > MAX_META_JSON && doc.source_file) {
      metaJson = JSON.stringify({ $source: { sha256: doc.source_file.sha256, byte_start: doc.source_file.byte_start,
        byte_end: doc.source_file.byte_end }, note: 'record larger than 64 KB: read it from the original bytes' });
    }

    const tokenTotal = passages.reduce((s, p) => s + p.token_count, 0);
    const docRow = stmt(db, `INSERT INTO document (collection_id, import_batch_id, ext_id, kind, title, native_title, author,
        genre, community, culture, field, lang_declared, lang_text, lang_confidence, is_translation, original_lang,
        has_full_text, lo_day, hi_day, y_lo, y_hi, precision, basis, date_role, chrono_status, date_label, source_url,
        license, source_file_sha256, source_byte_start, source_byte_end, original_meta_json, text_sha256, dup_of,
        token_count, passage_count, prominence, is_synthetic, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(coll.id, batch, doc.ext_id, doc.kind, doc.title ?? null, doc.native_title ?? null, doc.author ?? null,
        doc.genre ?? null, doc.community ?? null, doc.culture ?? null, doc.field ?? null, doc.lang_declared ?? null,
        dl.lang_text, dl.confidence, isTranslation ? 1 : 0, dl.is_translation ? doc.lang_declared : (doc.translation?.original_lang ?? null),
        doc.text ? 1 : 0, cp?.lo_day ?? null, cp?.hi_day ?? null, cp?.lo_year ?? null, cp?.hi_year ?? null,
        cp?.precision ?? 'unknown', cp?.basis ?? 'unknown', chrono?.role ?? null, chronoStatus, cp?.label ?? 'undated',
        doc.source_url ?? null, doc.license ?? null, sourceSha, doc.source_file?.byte_start ?? null,
        doc.source_file?.byte_end ?? null, metaJson, textSha, dupOf, tokenTotal, passages.length,
        doc.prominence ?? null, synthetic, nowIso());
    const id = Number(docRow.lastInsertRowid);
    let rows = 1;

    if (doc.text) {
      stmt(db, `INSERT INTO document_text (document_id, original, body_start, body_end, original_sha256, decoder)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, doc.text.original, doc.text.body_start ?? 0,
        doc.text.body_end ?? doc.text.original.length, sha256(doc.text.original), doc.text.decoder);
      rows++;
    }
    const insField = stmt(db, 'INSERT INTO document_field (document_id, field, value) VALUES (?, ?, ?)');
    for (const field of DOC_FIELDS) if (typeof fields[field] === 'string' && fields[field]) { insField.run(id, field, fields[field]); rows++; }

    const insPassage = stmt(db, `INSERT INTO passage (document_id, ord, field, field_class, time_role, unit, quality,
        start_off, end_off, page_no, lang, lang_confidence, token_count, y_lo, y_hi, is_synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insFts = stmt(db, 'INSERT INTO passage_fts (rowid, norm) VALUES (?, ?)');
    const ords = {};
    const okTokens = new Map();
    for (const p of passages) {
      const ord = ords[p.field] = (ords[p.field] ?? -1) + 1;
      const r = insPassage.run(id, ord, p.field, p.field_class, p.time_role, p.unit, p.quality, p.start, p.end,
        p.page_no ?? null, p.lang, p.confidence ?? null, p.token_count, cp?.lo_year ?? null, cp?.hi_year ?? null, synthetic);
      insFts.run(Number(r.lastInsertRowid), p.norm);
      rows += 2;
      if (p.quality === 'ok') {
        const k = `${p.lang}\u0000${p.field_class}`;
        const cur = okTokens.get(k) ?? { lang: p.lang, field_class: p.field_class, tokens: 0, passages: 0 };
        cur.tokens += p.token_count;
        cur.passages++;
        okTokens.set(k, cur);
      }
    }
    const insTokens = stmt(db, 'INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages) VALUES (?, ?, ?, ?, ?)');
    for (const t of okTokens.values()) { insTokens.run(id, t.lang, t.field_class, t.tokens, t.passages); rows++; }

    const insDate = stmt(db, `INSERT INTO date_assertion (subject_type, subject_id, role, lo_day, hi_day, lo_year, hi_year,
        precision, basis, approx, raw, rule, asserted_by, is_chronology, note)
      VALUES ('document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insRtree = stmt(db, 'INSERT INTO date_rtree (id, lo_day, hi_day) VALUES (?, ?, ?)');
    const writeAssertion = (a) => {
      const p = a.parsed;
      const dated = p && p.lo_day !== null;
      const note = a.issue ? [a.note, `${a.issue.code}: ${a.issue.message}`].filter(Boolean).join('; ') : a.note;
      const r = insDate.run(id, a.role, dated ? p.lo_day : null, dated ? p.hi_day : null, dated ? p.lo_year : null,
        dated ? p.hi_year : null, dated ? p.precision : 'unknown', dated ? p.basis : 'unknown', p?.approx ?? 0,
        a.raw === null || a.raw === undefined ? null : String(a.raw), a.issue ? 'unparsed' : p?.rule ?? 'unknown',
        a.asserted_by, a === chrono ? 1 : 0, note ?? null);
      if (dated) insRtree.run(Number(r.lastInsertRowid), p.lo_day, p.hi_day);
      rows += dated ? 2 : 1;
    };
    for (const a of assertions) writeAssertion(a);
    writeAssertion({ role: 'ingestion', parsed: { lo_day: today, hi_day: today, lo_year: todayYear, hi_year: todayYear,
      precision: 'day', basis: 'stated', approx: 0, rule: 'ingestion' }, raw: now.toISOString(),
    asserted_by: assertedIngestion, is_chronology: false, note: 'time of import (not a date of the text)', issue: null });

    if (chronoStatus === 'dated') writeDocBins(db, id, cp.lo_year, cp.hi_year);

    const insAlias = stmt(db, 'INSERT INTO document_alias (document_id, ext_id, title, note) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
    for (const a of doc.aliases ?? []) { insAlias.run(id, a.ext_id, a.title ?? null, a.note ?? null); rows++; }
    const insTag = stmt(db, `INSERT INTO doc_tag (document_id, scheme, value, weight, provenance, method)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    for (const t of doc.tags ?? []) { insTag.run(id, t.scheme, t.value, t.weight ?? null, t.provenance, t.method); rows++; }
    const insLabel = stmt(db, 'INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)');
    const ref = `document:${id}`;
    if (doc.title) { insLabel.run(doc.title, 'title', ref); rows++; }
    if (doc.native_title && doc.native_title !== doc.title) { insLabel.run(doc.native_title, 'title', ref); rows++; }
    if (doc.author) { insLabel.run(doc.author, 'maker', ref); rows++; }

    if (sig) {
      stmt(db, 'INSERT INTO doc_minhash (document_id, sig) VALUES (?, ?)').run(id, new Uint8Array(sig.buffer));
      indexSig(id, sig);
      rows++;
    }
    if (dup && !doc.text && doc.title) dup.metaKeys.set(metaKey(doc, cp?.lo_year ?? null), id);
    if (id > maxDocId) maxDocId = id;

    // counts
    counts.documents.created++;
    if (!doc.text) counts.documents.metadata_only++;
    if (isTranslation) counts.documents.translations++;
    counts.passages += passages.length;
    counts.tokens += tokenTotal;
    counts.languages[dl.lang_text] = (counts.languages[dl.lang_text] ?? 0) + 1;
    const dk = chronoStatus === 'undated' ? 'unknown' : chronoStatus === 'scheduled' ? 'scheduled' : cp.approx ? 'circa' : cp.precision;
    counts.dates[dk] = (counts.dates[dk] ?? 0) + 1;
    if (chronoStatus === 'dated') {
      if (spanLo === null || cp.lo_day < spanLo) { spanLo = cp.lo_day; spanLoLabel = cp.label; }
      if (spanHi === null || cp.hi_day > spanHi) { spanHi = cp.hi_day; spanHiLabel = cp.label; }
      counts.dates.span = { from: spanLoLabel, to: spanHiLabel };
    }
    docsInTx++;
    rowsInTx += rows;
    return { documentId: id, issues };
  }

  // ── relationships and annotations (resolved at finish) ──

  const extMaps = new Map(); // collection slug → Map(ext_id → document id), aliases included

  function extMap(slug) {
    let m = extMaps.get(slug);
    if (m) return m;
    m = new Map();
    const c = rowOf(db, 'collection', 'slug', slug);
    if (c) {
      for (const r of stmt(db, `SELECT a.ext_id, a.document_id AS id FROM document_alias a JOIN document d ON d.id = a.document_id
        WHERE d.collection_id = ? AND d.deleted_at IS NULL`).iterate(c.id)) if (!m.has(r.ext_id)) m.set(r.ext_id, r.id);
      for (const r of stmt(db, 'SELECT ext_id, id FROM document WHERE collection_id = ? AND deleted_at IS NULL').iterate(c.id)) m.set(r.ext_id, r.id);
    }
    extMaps.set(slug, m);
    return m;
  }

  function docYears(docId) {
    return stmt(db, 'SELECT y_lo, y_hi, chrono_status FROM document WHERE id = ?').get(docId) ?? null;
  }

  /** @returns {{type, ref, docId}|null} */
  function resolveEndpoint(e) {
    if (e?.ref) {
      let r;
      try { r = parseRef(e.ref); } catch { return null; }
      if (!REL_ENDPOINT_TYPES.includes(r.type)) return null;
      if (r.type === 'document') return docYears(Number(r.id)) ? { type: 'document', ref: String(r.id), docId: Number(r.id) } : null;
      if (r.type === 'passage') {
        const p = stmt(db, 'SELECT document_id FROM passage WHERE id = ?').get(Number(r.id));
        return p ? { type: 'passage', ref: String(r.id), docId: p.document_id } : null;
      }
      return { type: r.type, ref: String(r.id), docId: null };
    }
    if (!e?.ext_id) return null;
    const id = extMap(e.collection ?? coll.slug).get(e.ext_id);
    return id ? { type: 'document', ref: String(id), docId: id } : null;
  }

  function anchorFor(docId, field, start, end) {
    let text = null, sha = null;
    if (field === 'body') {
      const t = stmt(db, 'SELECT original, original_sha256 FROM document_text WHERE document_id = ?').get(docId);
      if (t) { text = t.original; sha = t.original_sha256; }
    } else {
      const f = stmt(db, 'SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(docId, field);
      if (f) { text = f.value; sha = sha256(f.value); }
    }
    if (text === null || !(start >= 0 && start <= end && end <= text.length)) return null;
    const passage = stmt(db, `SELECT id FROM passage WHERE document_id = ? AND field = ? AND start_off <= ? AND end_off >= ?
      ORDER BY start_off DESC LIMIT 1`).get(docId, field, start, end);
    return {
      passageId: passage?.id ?? null,
      anchor: { doc_id: docId, sha256: sha, field, start, end, quote: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start), suffix: text.slice(end, end + ANCHOR_CONTEXT) },
    };
  }

  const groups = new Map();
  let newGroupKey = null; // a group created inside the current relationship's savepoint
  // A group's target is the item whose source is asked about: the (later) src every hypothesis starts from (§2.C;
  // POST /api/relationships requires src = target). Before the M5 gate this was the first hypothesis's dst.
  function hypothesisGroup(spec, target, createdBy) {
    if (!spec) return null;
    if (groups.has(spec.key)) return groups.get(spec.key);
    newGroupKey = spec.key;
    const existing = stmt(db, 'SELECT id FROM hypothesis_group WHERE target_type = ? AND target_ref = ? AND question = ?')
      .get(target.type, target.ref, spec.question);
    const id = existing ? existing.id : Number(stmt(db, `INSERT INTO hypothesis_group (target_type, target_ref, question,
      created_by, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(target.type, target.ref, spec.question, createdBy, synthetic, nowIso()).lastInsertRowid);
    groups.set(spec.key, id);
    return id;
  }

  /** Whether a resolved endpoint lies in a synthetic document (the demo). */
  function syntheticEnd(e) {
    let docId = e.docId;
    if (docId === null && e.type === 'occurrence') docId = stmt(db, 'SELECT document_id FROM occurrence WHERE id = ?').get(Number(e.ref))?.document_id ?? null;
    return docId !== null && stmt(db, 'SELECT is_synthetic FROM document WHERE id = ?').get(docId)?.is_synthetic === 1;
  }

  function writeRelationship(rel) {
    const src = resolveEndpoint(rel.src), dst = resolveEndpoint(rel.dst);
    if (!src || !dst) {
      counts.relationships.unresolved_targets++;
      const which = !src ? rel.src : rel.dst;
      recordIssue({ code: 'W_UNRESOLVED_TARGET', severity: 'warning', field: !src ? 'src' : 'dst',
        value_excerpt: which?.ext_id ?? which?.ref ?? null,
        message: `Relationship ${rel.rel_type}: ${!src ? 'source' : 'target'} '${which?.ext_id ?? which?.ref ?? '?'}' was not found; the link was not created.` });
      return;
    }
    // §13 rule 1 (fix pass): invented material exists only in the demo; a link from real data into it would carry a
    // non-synthetic (even documented) edge into invented records, so it is refused and reported
    if (!synthetic && (syntheticEnd(src) || syntheticEnd(dst))) {
      counts.relationships.unresolved_targets++;
      const end = syntheticEnd(src) ? 'source' : 'target';
      const which = end === 'source' ? rel.src : rel.dst;
      recordIssue({ code: 'W_SYNTHETIC_TARGET', severity: 'warning', field: end === 'source' ? 'src' : 'dst',
        value_excerpt: which?.ext_id ?? which?.ref ?? null,
        message: `Relationship ${rel.rel_type}: ${end} '${which?.ext_id ?? which?.ref ?? '?'}' is in the synthetic demo (invented material); the link was not created.` });
      return;
    }
    // M5 gate: loading a source again (the Adapters page's "Load again") must not duplicate its links. The same
    // relationship — type, ends, status, origin, author, dataset, locator and run — is written once; the repeat is
    // counted and skipped.
    const dup = stmt(db, DUP_RELATIONSHIP_SQL).get(src.type, String(src.ref), dst.type, String(dst.ref),
      rel.rel_type, rel.evidence_status, rel.origin, rel.created_by, rel.source_dataset ?? '', rel.source_locator ?? '', rel.run_id ?? -1);
    if (dup) {
      counts.relationships.duplicates = (counts.relationships.duplicates ?? 0) + 1;
      return;
    }
    const type = REL_TYPE_BY_CODE[rel.rel_type];
    const sy = src.docId ? docYears(src.docId) : null, dy = dst.docId ? docYears(dst.docId) : null;
    // a conflict only when the dates make the stated order impossible (later item certainly earlier)
    const conflict = type?.requires_precedence && sy?.y_hi !== null && sy?.y_hi !== undefined && dy?.y_lo !== null &&
      dy?.y_lo !== undefined && sy.y_hi < dy.y_lo ? 1 : 0;
    const createdAt = nowIso();
    let relId;
    db.exec('SAVEPOINT w_rel');
    newGroupKey = null;
    try {
      const groupId = hypothesisGroup(rel.hypothesis_group, src, rel.created_by);
      relId = Number(stmt(db, `INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed,
          evidence_status, origin, source_dataset, source_locator, provenance_quality, method, run_id, created_by, score,
          score_kind, date_conflict, src_year, dst_year, hypothesis_group_id, license, attribution, provenance_note,
          is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rel.rel_type, src.type, src.ref, dst.type, dst.ref, type ? type.directed : 1, rel.evidence_status, rel.origin,
          rel.source_dataset ?? null, rel.source_locator ?? null, rel.provenance_quality ?? 'complete', rel.method ?? null,
          rel.run_id ?? null, rel.created_by, rel.score?.value ?? null, rel.score?.kind ?? null, conflict,
          sy?.y_lo ?? null, dy?.y_lo ?? null, groupId, rel.license ?? null, rel.attribution ?? null,
          rel.provenance_note ?? null, synthetic, createdAt).lastInsertRowid);
      const insEv = stmt(db, `INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off,
        anchor_json, detail_json, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const ev of rel.evidence ?? []) {
        let docId = null, passageId = null;
        if (Number.isInteger(ev.passage)) {
          const p = stmt(db, 'SELECT id, document_id, field FROM passage WHERE id = ?').get(ev.passage);
          if (p) { passageId = p.id; docId = p.document_id; }
        } else if (ev.ext_id) {
          docId = extMap(ev.collection ?? coll.slug).get(ev.ext_id) ?? null;
        }
        let anchor = null;
        if (docId !== null && Number.isInteger(ev.start) && Number.isInteger(ev.end)) {
          const a = anchorFor(docId, ev.field ?? 'body', ev.start, ev.end);
          if (!a || (ev.quote && a.anchor.quote !== ev.quote)) {
            recordIssue({ code: 'E_FIELD_TYPE', severity: 'warning', field: 'evidence', value_excerpt: ev.quote ?? null,
              message: `Relationship ${rel.rel_type}: evidence span ${ev.start}–${ev.end} does not match the text; the span was not attached.` });
            continue;
          }
          anchor = a.anchor;
          passageId = passageId ?? a.passageId;
        }
        insEv.run(relId, passageId, ev.role, anchor ? anchor.start : null, anchor ? anchor.end : null,
          anchor ? JSON.stringify(anchor) : null, ev.detail ? JSON.stringify(ev.detail) : null, rel.created_by, createdAt);
      }
      stmt(db, `INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, before_json, after_json, reason)
        VALUES (?, 1, ?, ?, 'create', NULL, ?, NULL)`).run(relId, rel.created_by, createdAt, canonicalJson({
        rel_type: rel.rel_type, src: `${src.type}:${src.ref}`, dst: `${dst.type}:${dst.ref}`, evidence_status: rel.evidence_status,
        origin: rel.origin, source_dataset: rel.source_dataset ?? null, source_locator: rel.source_locator ?? null,
        method: rel.method ?? null, run_id: rel.run_id ?? null, score: rel.score ?? null }));
      db.exec('RELEASE w_rel');
    } catch (err) {
      db.exec('ROLLBACK TO w_rel; RELEASE w_rel');
      if (newGroupKey !== null) groups.delete(newGroupKey);
      if (!isConstraintError(err)) throw err;
      counts.relationships.rejected++;
      recordIssue({ code: 'E_FIELD_TYPE', severity: 'rejected', field: 'relationship', value_excerpt: rel.rel_type,
        message: `Relationship ${rel.rel_type} ${src.type}:${src.ref} → ${dst.type}:${dst.ref} was refused: ${err.message}`,
        suggestion: 'Documented links need a source dataset and a locator (or source_unrecorded); computed links need a run and a method.' });
      return;
    }
    counts.relationships[rel.evidence_status] = (counts.relationships[rel.evidence_status] ?? 0) + 1;
  }

  const annKeys = new Map();

  /** target_ref and anchor of an annotation target, or null when it cannot be resolved. */
  function annotationTarget(t, anchorSpec) {
    let docId = null, passageId = null;
    if (t.ext_id) docId = extMap(t.collection ?? coll.slug).get(t.ext_id) ?? null;
    else if (t.ref) {
      const r = resolveEndpoint({ ref: t.ref });
      if (!r) return t.type === 'passage' || t.type === 'occurrence' || t.type === 'document' ? null : { targetRef: String(parseRef(t.ref).id), anchor: null };
      docId = r.docId;
      if (r.type === 'passage') passageId = Number(r.ref);
    }
    if (t.type !== 'passage' && t.type !== 'occurrence' && t.type !== 'document') return null; // other targets need a ref
    if (docId === null) return null;
    let anchor = null;
    if (anchorSpec) {
      const a = anchorFor(docId, anchorSpec.field ?? 'body', anchorSpec.start, anchorSpec.end);
      if (!a || a.anchor.quote !== anchorSpec.quote) return { error: 'anchor' };
      anchor = a.anchor;
      passageId = passageId ?? a.passageId;
    }
    if (t.type === 'document') return { targetRef: String(docId), anchor };
    if (t.type === 'occurrence') return t.ref ? { targetRef: String(parseRef(t.ref).id), anchor } : null;
    return passageId ? { targetRef: String(passageId), anchor } : null;
  }

  function writeAnnotation(ann) {
    const t = ann.target;
    const resolved = annotationTarget(t, ann.anchor);
    if (!resolved || resolved.error) {
      counts.annotations.rejected++;
      if (resolved?.error) {
        recordIssue({ code: 'E_FIELD_TYPE', severity: 'rejected', field: 'anchor', value_excerpt: ann.anchor.quote,
          message: `Annotation anchor ${ann.anchor.start}–${ann.anchor.end} does not match the quoted text.`,
          suggestion: 'The quote must equal the original text between start and end (UTF-16 offsets).' });
      } else {
        recordIssue({ code: 'W_UNRESOLVED_TARGET', severity: 'warning', field: 'target', value_excerpt: t.ext_id ?? t.ref,
          message: `Annotation target '${t.ext_id ?? t.ref ?? t.type}' was not found; the annotation was not created.` });
      }
      return;
    }
    const { targetRef, anchor } = resolved;
    const targetDoc = t.type === 'document' ? Number(targetRef) : t.type === 'passage'
      ? stmt(db, 'SELECT document_id FROM passage WHERE id = ?').get(Number(targetRef))?.document_id ?? null
      : t.type === 'occurrence' ? stmt(db, 'SELECT document_id FROM occurrence WHERE id = ?').get(Number(targetRef))?.document_id ?? null : null;
    if (!synthetic && targetDoc !== null && stmt(db, 'SELECT is_synthetic FROM document WHERE id = ?').get(targetDoc)?.is_synthetic === 1) {
      counts.annotations.rejected++;
      recordIssue({ code: 'W_SYNTHETIC_TARGET', severity: 'warning', field: 'target', value_excerpt: t.ext_id ?? t.ref,
        message: `Annotation target '${t.ext_id ?? t.ref ?? t.type}' is in the synthetic demo (invented material); the annotation was not created.` });
      return;
    }
    // M5 gate: the same annotation loaded again (same target, kind, author, layer and first text) is written once
    const dupAnn = stmt(db, `SELECT a.id FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = 1
      WHERE a.target_type = ? AND a.target_ref = ? AND a.kind = ? AND a.author = ? AND IFNULL(a.layer, '') = ? AND r.body_md = ? LIMIT 1`)
      .get(t.type, targetRef, ann.kind, ann.author, ann.layer ?? '', ann.body_md);
    if (dupAnn) {
      if (ann.key) annKeys.set(ann.key, dupAnn.id);
      counts.annotations.duplicates = (counts.annotations.duplicates ?? 0) + 1;
      return;
    }
    const at = nowIso();
    db.exec('SAVEPOINT w_ann');
    try {
      const supersedes = ann.supersedes_key ? annKeys.get(ann.supersedes_key) ?? null : null;
      const annId = Number(stmt(db, `INSERT INTO annotation (target_type, target_ref, anchor_json, kind, author, is_machine,
          method, run_id, layer, supersedes, status, is_synthetic, current_rev, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?)`)
        .run(t.type, targetRef, anchor ? JSON.stringify(anchor) : null, ann.kind, ann.author, ann.is_machine ? 1 : 0,
          ann.method ?? null, ann.run_id ?? null, ann.layer ?? null, supersedes, synthetic, at).lastInsertRowid);
      if (supersedes) stmt(db, "UPDATE annotation SET status = 'superseded' WHERE id = ?").run(supersedes);
      const tags = ann.tags ?? [];
      const revId = Number(stmt(db, `INSERT INTO annotation_revision (annotation_id, rev, body_md, stance, dimensions_json,
          tags_json, evidence_refs_json, reason, author, at) VALUES (?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(annId, ann.body_md, ann.stance ?? null, JSON.stringify(ann.dimensions ?? {}), JSON.stringify(tags),
          JSON.stringify(ann.evidence_refs ?? []), ann.author, at).lastInsertRowid);
      stmt(db, 'INSERT INTO annotation_fts (rowid, body, tags) VALUES (?, ?, ?)')
        .run(revId, tokenize(ann.body_md).tokens.join(' '), tokenize(tags.join(' ')).tokens.join(' '));
      if (ann.key) annKeys.set(ann.key, annId);
      db.exec('RELEASE w_ann');
      counts.annotations.created++;
    } catch (err) {
      db.exec('ROLLBACK TO w_ann; RELEASE w_ann');
      if (!isConstraintError(err)) throw err;
      counts.annotations.rejected++;
      recordIssue({ code: 'E_FIELD_TYPE', severity: 'rejected', field: 'annotation', value_excerpt: ann.kind,
        message: `Annotation was refused: ${err.message}` });
    }
  }

  /** Validate and write one document (the caller schedules the flush). */
  function addOne(doc, line) {
    const issues = [];
    const errs = check('CanonicalDocument', doc);
    if (errs.length) {
      return reject(issues, { code: 'E_FIELD_TYPE', line, value_excerpt: doc?.ext_id,
        message: `Record ${doc?.ext_id ?? '(no ext_id)'} does not match the document contract: ${errs.slice(0, 3).join('; ')}` });
    }
    if (doc.text && doc.text.original.length > MAX_TEXT_CHARS) {
      return reject(issues, { code: 'E_ROW_TOO_LARGE', line, field: 'text', value_excerpt: doc.ext_id,
        vars: { line: line ?? doc.ext_id, field: 'text', size: `${(doc.text.original.length / 1048576).toFixed(1)} M characters` } });
    }
    const hasText = doc.text || Object.values(doc.fields ?? {}).some((v) => typeof v === 'string' && v) || doc.title;
    if (!hasText) return reject(issues, { code: 'E_MISSING_TEXT', line, value_excerpt: doc.ext_id, vars: { line: line ?? doc.ext_id } });
    const first = extLines.get(doc.ext_id);
    if (first !== undefined) {
      return reject(issues, { code: 'E_DUP_ID', line, field: 'ext_id', value_excerpt: doc.ext_id,
        vars: { line: line ?? '?', value: doc.ext_id, first_line: first ?? '?' } });
    }
    if (stmt(db, 'SELECT 1 FROM document WHERE collection_id = ? AND ext_id = ?').get(coll.id, doc.ext_id)) {
      return reject(issues, { code: 'E_DUP_ID', line, field: 'ext_id', value_excerpt: doc.ext_id,
        message: `${doc.ext_id} already exists in collection '${coll.slug}' (an earlier import).` });
    }
    extLines.set(doc.ext_id, line ?? null);

    begin();
    db.exec('SAVEPOINT w_doc');
    let out;
    try {
      out = insertDocument(doc, line ?? null, issues);
      db.exec('RELEASE w_doc');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK TO w_doc; RELEASE w_doc');
      if (!isConstraintError(err)) throw err;
      return reject(issues, { code: 'E_FIELD_TYPE', line, value_excerpt: doc.ext_id,
        message: `${doc.ext_id} was refused by the database: ${err.message}` });
    }
    return out;
  }

  // ── public API ──

  const api = {
    batchId: batch,
    collection: coll,
    corpus: corp,

    /**
     * Write one document (atomic). Rejected records return documentId null with their issues.
     * @param {object} doc CanonicalDocument
     * @param {{line?: number}} [where] source line, for issues
     * @returns {{documentId: number|null, issues: object[]}}
     */
    addDocument(doc, { line } = {}) {
      if (closed) throw new Error('DocumentWriter: already finished or rolled back');
      try {
        return addOne(doc, line);
      } finally {
        if (!closed) {
          maybeFlush();
          scheduleIdleFlush();
        }
      }
    },

    /**
     * Add an alias to a document that already exists (e.g. a relation endpoint that is a known work).
     * @param {{collection?: string, ext_id: string}} target
     * @param {{ext_id: string, title?: string|null, note?: string|null}} alias
     * @returns {boolean} false when the target does not exist
     */
    addAlias(target, alias) {
      const id = resolveExt(db, { collectionSlug: target.collection ?? coll.slug, extId: target.ext_id });
      if (!id) return false;
      begin();
      const r = stmt(db, 'INSERT INTO document_alias (document_id, ext_id, title, note) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(id, alias.ext_id, alias.title ?? null, alias.note ?? null);
      if (r.changes) addedAliases.push([id, alias.ext_id]);
      extMaps.get(target.collection ?? coll.slug)?.set(alias.ext_id, id);
      rowsInTx++;
      maybeFlush();
      scheduleIdleFlush();
      return true;
    },

    /**
     * Queue a relationship; endpoints are resolved by ext_id at finish().
     * @param {object} rel CanonicalRelationship
     * @returns {{pending: boolean, issues?: object[]}}
     */
    addRelationship(rel) {
      const errs = check('CanonicalRelationship', rel);
      if (errs.length) {
        counts.relationships.rejected++;
        scheduleIdleFlush();
        return { pending: false, issues: [recordIssue({ code: 'E_FIELD_TYPE', severity: 'rejected', field: 'relationship',
          value_excerpt: rel?.rel_type, message: `Relationship does not match the contract: ${errs.slice(0, 3).join('; ')}` })] };
      }
      pendingRels.push(rel);
      return { pending: true };
    },

    /**
     * Queue an annotation; its target and anchor are resolved at finish().
     * @param {object} ann CanonicalAnnotation (optional `key`, referenced by a later `supersedes_key`)
     * @returns {{pending: boolean, issues?: object[]}}
     */
    addAnnotation(ann) {
      const errs = check('CanonicalAnnotation', ann);
      if (errs.length) {
        counts.annotations.rejected++;
        scheduleIdleFlush();
        return { pending: false, issues: [recordIssue({ code: 'E_FIELD_TYPE', severity: 'rejected', field: 'annotation',
          value_excerpt: ann?.kind, message: `Annotation does not match the contract: ${errs.slice(0, 3).join('; ')}` })] };
      }
      pendingAnns.push(ann);
      return { pending: true };
    },

    /** Record an issue found by the caller (parser/adapter). @param {object} issue */
    addIssue(issue) {
      recordIssue(issue);
      maybeFlush();
      scheduleIdleFlush();
    },

    /** Commit what has been written so far. */
    flush() {
      clearTimeout(idleTimer);
      commit();
    },

    /** Live counts (the same object finish() returns, without data_version). */
    counts() {
      return counts;
    },

    /**
     * Resolve pending relationships and annotations, mark the batch committed and bump data_version, in one
     * transaction.
     * @returns {object} ImportCounts
     */
    finish() {
      if (closed) throw new Error('DocumentWriter: already finished or rolled back');
      clearTimeout(idleTimer);
      commit();
      const version = tx(db, () => {
        for (const rel of pendingRels) writeRelationship(rel);
        for (const ann of pendingAnns) writeAnnotation(ann);
        stmt(db, "UPDATE import_batch SET status = 'committed', committed_at = ? WHERE id = ?").run(nowIso(), batch);
        return bumpDataVersion(db);
      });
      closed = true;
      uncommittedIssues = [];
      if (dup) {
        // the next writer of this collection (the next chunk of a chain) starts from this index
        try { saveDupIndex(db, dup, { batchId: batch, maxDocumentId: maxDocId, diskMin: dupDiskMin }); } catch (err) {
          log('warn', `duplicate index of '${coll.slug}' not kept`, { error: String(err?.message ?? err) });
        }
        dup = null;
      }
      return { batch_id: batch, collection: coll.slug, ...counts, data_version: version };
    },

    /**
     * Where this writer's duplicate indexes came from: the previous writer of the collection in this thread
     * ('memo'), its disk cache ('disk') or the database ('db'), with the time it took. null before the first write
     * or with dedupe 'off'.
     * @returns {{source: 'memo'|'disk'|'db', ms: number, metaKeys: number, signatures: number}|null}
     */
    dupIndex() {
      return dupInfo;
    },

    /** Remove everything this batch wrote (documents and their rows; aliases added to other documents). */
    rollback() {
      clearTimeout(idleTimer);
      if (ownsTx && db.isTransaction) db.exec('ROLLBACK');
      ownsTx = false;
      closed = true;
      dup = null; // it holds this batch's documents: never handed on
      const keep = uncommittedIssues;
      uncommittedIssues = [];
      rollbackBatch(db, batch);
      tx(db, () => {
        const del = stmt(db, 'DELETE FROM document_alias WHERE document_id = ? AND ext_id = ?');
        for (const [id, ext] of addedAliases) del.run(id, ext);
        const ins = stmt(db, `INSERT INTO import_issue (batch_id, severity, code, line, col, field, value_excerpt, message, suggestion)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const i of keep) ins.run(batch, i.severity, i.code, i.line, i.col, i.field, i.value_excerpt, i.message, i.suggestion);
      });
    },
  };
  return api;
}
