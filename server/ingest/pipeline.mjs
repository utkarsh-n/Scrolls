// OWNER: WP1
// pipeline.mjs — upload → preview → validate (dry run) → commit, over DocumentWriter (SPEC §5).
//
// One driver (runImport) feeds records through the mapping into a sink: DocumentWriter at commit, the
// projector of validate.mjs in the dry run. Both therefore see the same rows, the same rejections and the
// same issue texts. Heavy steps run off the HTTP thread: previews and dry runs in the read pool
// (previewQuery, validateQuery), the commit as the 'import' job (commitImport). Files up to 2 GB are
// streamed to incoming/ and stored content-addressed; parsing holds one decoded file in memory, so a file
// whose text exceeds MAX_PARSE_BYTES is refused until the streaming reader (P2) exists.

import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { slugify } from '../../src/shared/ids.mjs';
import { paths } from '../config.mjs';
import { bumpDataVersion, nowIso, stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { createDocumentWriter, ensureCollection, resolveExt, setFtsBulkLoad } from '../store/document-writer.mjs';
import { csvRecordsChunked, openCsv, openCsvRecords, sniffDelimiter } from './csv.mjs';
import { decodeBytes, fileTextChunks, scanFileEncoding } from './decode.mjs';
import { committedBatchForFile, createIdTracker, dupFileIssue } from './dedupe.mjs';
import { parseJson, pointerOf } from './json.mjs';
import { jsonlRecords, jsonlRecordsChunked } from './jsonl.mjs';
import { applyMapping } from './mapping.mjs';
import { parseMd } from './md.mjs';
import { FILE_FORMATS, sniffFormat } from './sniff.mjs';
import { inferColumn, suggestMapping } from './suggest.mjs';
import { buildSummary, PROBLEMS_HEADER, problemLine } from './summary.mjs';
import { parseTxt } from './txt.mjs';
import { createProjector, validateMapping } from './validate.mjs';

/** Largest upload (§5.1). */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
/** Largest file the in-memory parser reads (V8 strings top out near 512 M characters). */
export const MAX_PARSE_BYTES = 400 * 1024 ** 2;
/** Most rows per import (§5.1). */
export const MAX_ROWS = 5_000_000;
/** CSV, TSV and JSON Lines files above this size are read in chunks (the "2 GB streaming" path). */
export const STREAM_ABOVE_BYTES = 64 * 1024 ** 2;
/** Record formats that can be read in chunks; JSON, TXT and Markdown are one string. */
export const STREAMABLE = Object.freeze(new Set(['csv', 'tsv', 'jsonl']));
/** How much of a large file the preview reads. */
const PREVIEW_PREFIX_BYTES = 4 * 1024 ** 2;
const PREVIEW_RECORDS = 200;
const SAMPLE_ROWS = 20;
const SAMPLE_CHARS = 280;
const PROGRESS_EVERY_MS = 200;
const BULK_FTS_CHARS = 20 * 1024 * 1024;
export const PIPELINE_VERSION = 'import@1.0.0';

// ── files ───────────────────────────────────────────────────────────────────────────────────────────

/** Relative path of a stored original (the layout of DocumentWriter's storeOriginal). */
export const originalRelPath = (sha) => path.join('originals', sha.slice(0, 2), sha);

/**
 * Stream a request body to `file`, hashing it on the way; rejects with 413 E_FILE_TOO_LARGE past `max`.
 * @param {import('node:stream').Readable} stream
 * @param {string} file
 * @param {number} [max]
 * @returns {Promise<{sha256: string, bytes: number}>}
 */
export function streamToFile(stream, file, max = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let n = 0, done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      stream.unpipe?.();
      // The write stream opens its file asynchronously: unlink only once it has closed, or a late open
      // re-creates the file after the unlink (seen under load).
      const cleanup = () => {
        try { unlinkSync(file); } catch { /* never created */ }
        reject(err);
      };
      if (out.closed) cleanup();
      else { out.once('close', cleanup); out.destroy(); }
    };
    stream.on('data', (chunk) => {
      if (done) return;
      n += chunk.length;
      if (n > max) {
        stream.destroy?.();
        fail(tooLarge(n, true));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()); }
    });
    stream.on('end', () => { if (!done) out.end(() => { done = true; resolve({ sha256: hash.digest('hex'), bytes: n }); }); });
    stream.on('aborted', () => fail(new HttpError(400, 'E_UPLOAD_ABORTED', 'The upload stopped before the whole file arrived.', 'Try the upload again.')));
    stream.on('error', fail);
    out.on('error', fail);
  });
}

function tooLarge(bytes, atLeast = false) {
  const gb = (bytes / 1024 ** 3).toFixed(1);
  return new HttpError(413, 'E_FILE_TOO_LARGE', `The file is ${atLeast ? 'over ' : ''}${gb} GB; the limit is 2 GB per file.`,
    'Split the file and import the parts into one collection.', { bytes });
}

/**
 * Move an uploaded file into originals/ (content-addressed, immutable) and return its relative path.
 * @param {string} partFile
 * @param {string} sha
 * @returns {string}
 */
export function storeUploaded(partFile, sha) {
  const rel = originalRelPath(sha);
  const abs = path.join(paths().data, rel);
  if (existsSync(abs)) {
    try { unlinkSync(partFile); } catch { /* already gone */ }
  } else {
    mkdirSync(path.dirname(abs), { recursive: true });
    renameSync(partFile, abs);
  }
  return rel;
}

/** Absolute path of a batch's stored original. */
function originalPath(db, batch, dataDir) {
  const f = batch.file_sha256 ? db.prepare('SELECT rel_path FROM original_file WHERE sha256 = ?').get(batch.file_sha256) : null;
  if (!f) throw new HttpError(409, 'E_IMPORT_STATE', `Import batch ${batch.id} has no stored file.`, 'Upload the file again.');
  return path.join(dataDir ?? paths().data, f.rel_path);
}

/** Path of a batch's dry-run problems.csv (cache/, rewritten by every dry run). */
export function dryRunProblemsPath(batchId, dataDir = paths().data) {
  return path.join(dataDir, 'cache', 'imports', `batch-${batchId}.dry-run.problems.csv`);
}

/** Read a file, refusing what the in-memory parser cannot hold. */
function readForParse(file) {
  const size = statSync(file).size;
  if (size > MAX_PARSE_BYTES) {
    throw new HttpError(413, 'E_FILE_TOO_LARGE', `The file is ${(size / 1024 ** 2).toFixed(0)} MB; JSON, TXT and Markdown files are read whole, up to ${MAX_PARSE_BYTES / 1024 ** 2} MB.`,
      'Save JSON records as JSON Lines (read in chunks, up to 2 GB), or split the file into parts.', { bytes: size });
  }
  return readFileSync(file);
}

/**
 * A stored file opened for a dry run or a commit: decoded whole, or — CSV, TSV and JSON Lines over
 * `streamAboveBytes` — checked for its encoding and then read in chunks.
 * @returns {{dec: object, size: number, text: string|null, chunks: Iterable<object>|null, textChars: number}}
 */
export function openForRun(file, m, { streamAboveBytes = STREAM_ABOVE_BYTES, chunkSize = undefined } = {}) {
  const size = statSync(file).size;
  if (size > streamAboveBytes && STREAMABLE.has(m.format)) {
    const dec = scanFileEncoding(file, { encoding: m.encoding ?? 'auto', chunkSize });
    const chunks = { [Symbol.iterator]: () => fileTextChunks(file, { decoder: dec.decoder, bomBytes: dec.bomBytes, chunkSize }) };
    return { dec, size, text: null, chunks: dec.fatal ? null : chunks, textChars: size };
  }
  const dec = decodeBytes(readForParse(file), { encoding: m.encoding ?? 'auto' });
  return { dec, size, text: dec.text, chunks: null, textChars: dec.text.length };
}

// ── records ─────────────────────────────────────────────────────────────────────────────────────────

function* numbered(it) {
  let k = 0;
  for (const r of it) {
    if (r.fatal) { yield r; return; }
    r.ordinal = ++k;
    yield r;
  }
}

/**
 * Open a decoded file as records. RawRecord = {line, start, end, ordinal, data, issue?, warnings?, document?,
 * header?}; a fatal problem mid-file ends the iteration with {fatal: Issue}.
 * @param {string} text
 * @param {{format: string, delimiter?: string|null, header?: boolean|null, pointer?: string|null, fileName?: string, lineMode?: boolean}} o
 * @returns {{columns: string[]|null, issues: object[], fatal: object|null, records: Iterable<object>, pointer: string|null, candidates: object[]}}
 */
export function openRecords(text, { format, delimiter = null, header = true, pointer = null, fileName = '', lineMode = false }) {
  switch (format) {
    case 'csv': case 'tsv': {
      const d = delimiter || (format === 'tsv' ? '\t' : sniffDelimiter(text));
      const t = openCsv(text, { delimiter: d, header: header !== false });
      return { columns: t.columns, issues: t.fatal ? [] : t.issues, fatal: t.fatal, records: numbered(t.rows), pointer: null, candidates: [], delimiter: d };
    }
    case 'json': {
      const j = parseJson(text, { pointer });
      return { columns: null, issues: j.issues.filter((i) => i !== j.fatal), fatal: j.fatal, records: numbered(j.records), pointer: j.pointer, candidates: j.candidates };
    }
    case 'jsonl':
      return { columns: null, issues: [], fatal: null, records: numbered(jsonlRecords(text)), pointer: null, candidates: [] };
    case 'txt': case 'md': {
      const f = format === 'md' ? parseMd(text, { fileName, lineMode }) : parseTxt(text, { fileName, lineMode });
      return { columns: Object.keys(f.data), issues: f.issues, fatal: null, pointer: null, candidates: [],
        records: numbered([{ line: 1, start: 0, end: text.length, data: f.data, document: f.document, header: f.header }]) };
    }
    default:
      throw new HttpError(400, 'E_FORMAT', `Unknown import format '${format}'.`, `Use one of ${FILE_FORMATS.join(', ')}.`);
  }
}

/**
 * openRecords for a file read in chunks (CSV, TSV, JSON Lines): records carry byteStart/byteEnd.
 * @param {Iterable<{text: string}>} chunks
 * @param {{format: string, delimiter?: string|null, header?: boolean|null, decoder: string, bomBytes?: number}} o
 */
export function openRecordsChunked(chunks, { format, delimiter = null, header = true, decoder, bomBytes = 0 }) {
  if (format === 'jsonl') {
    return { columns: null, issues: [], fatal: null, records: numbered(jsonlRecordsChunked(chunks, { decoder, bomBytes })), pointer: null, candidates: [] };
  }
  if (format !== 'csv' && format !== 'tsv') throw new HttpError(400, 'E_FORMAT', `${format} files are not read in chunks.`, 'Use CSV, TSV or JSON Lines for large files.');
  const d = delimiter || (format === 'tsv' ? '\t' : ',');
  const t = openCsvRecords(csvRecordsChunked(chunks, { delimiter: d, decoder, bomBytes }), { delimiter: d, header: header !== false });
  return { columns: t.columns, issues: t.fatal ? [] : t.issues, fatal: t.fatal, records: numbered(t.rows), pointer: null, candidates: [], delimiter: d };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Columns of JSON records: top-level keys, plus '/key/sub' pointers one level into nested objects. */
function jsonColumns(records) {
  const names = [];
  const seen = new Set();
  const add = (n) => { if (!seen.has(n)) { seen.add(n); names.push(n); } };
  for (const r of records) {
    for (const [k, v] of Object.entries(r.data ?? {})) {
      add(k);
      if (isPlainObject(v)) for (const sub of Object.keys(v)) add(pointerOf([k, sub]));
    }
  }
  return names;
}

const clip = (v) => (typeof v === 'string' && v.length > SAMPLE_CHARS ? `${v.slice(0, SAMPLE_CHARS)}…` : v);
function clipDeep(v) {
  if (typeof v === 'string') return clip(v);
  if (Array.isArray(v)) return v.slice(0, 20).map(clipDeep);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, clipDeep(x)]));
  return v;
}

function columnValue(data, name) {
  if (!data) return undefined;
  if (Object.prototype.hasOwnProperty.call(data, name)) return data[name];
  if (name.startsWith('/')) {
    const [a, b] = name.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    return isPlainObject(data[a]) ? data[a][b] : undefined;
  }
  return undefined;
}

const displayValue = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? clip(v)
  : typeof v === 'number' || typeof v === 'boolean' ? String(v) : clip(JSON.stringify(v)));

/**
 * The preview of a file: format, encoding, delimiter, header, columns with samples and inferred types,
 * 20 sample rows, a suggested mapping and the issues found so far (§5.2 step 1).
 * @param {{bytes: Uint8Array, fileName: string, collection?: object|null, overrides?: object, now?: Date}} a
 * @returns {{preview: object, sniff: object}}
 */
export function buildPreview({ bytes, fileName, collection = null, overrides = {}, now = new Date() }) {
  const sniff = sniffFormat(bytes, { fileName });
  const dec = decodeBytes(bytes, { encoding: overrides.encoding ?? 'auto' });
  const issues = [...dec.issues];
  const format = FILE_FORMATS.includes(overrides.format) ? overrides.format : sniff.format;
  const base = { format, encoding: dec.encoding, delimiter: null, header: null };
  if (dec.fatal) {
    const preview = { ...base, columns: [], sample_rows: [], issues, fatal: dec.fatal,
      suggested_mapping: suggestMapping([], { format, fileName, collection, now }), records_sampled: 0 };
    return { preview, sniff: { ...sniff, ...base, bom: dec.bom, columns: [] } };
  }
  const delimiter = format === 'csv' || format === 'tsv'
    ? (overrides.delimiter ?? (format === 'tsv' ? '\t' : sniff.format === format ? sniff.delimiter : null) ?? sniffDelimiter(dec.text)) : null;
  const header = format === 'csv' || format === 'tsv' ? (overrides.header ?? (sniff.format === format ? sniff.header : null) ?? true) : null;
  const src = openRecords(dec.text, { format, delimiter, header, pointer: overrides.pointer ?? null, fileName, lineMode: Boolean(overrides.line_mode) });
  issues.push(...src.issues);
  if (src.fatal) issues.push(src.fatal);
  if ((format === 'txt' || format === 'md') && dec.text.length > 20 * 1024 * 1024) {
    const mbs = (dec.text.length / 1048576).toFixed(0);
    const tooBig = { code: 'E_ROW_TOO_LARGE', severity: 'fatal', line: null, col: null, field: 'text', value_excerpt: null,
      message: `This ${format.toUpperCase()} file holds ${mbs} M characters of text: it would be one document, and a document holds at most 20 MB.`,
      suggestion: 'Split it into one file per chapter or part, each under 20 MB, and import them into one collection.' };
    issues.push(tooBig);
    src.fatal = src.fatal ?? tooBig;
  }
  const sampled = [];
  let rejectedSeen = 0, midFatal = null;
  for (const r of src.records) {
    if (r.fatal) { issues.push(r.fatal); midFatal = r.fatal; break; }
    if (r.issue) { if (rejectedSeen++ < SAMPLE_ROWS) issues.push(r.issue); continue; }
    for (const w of r.warnings ?? []) if (rejectedSeen++ < SAMPLE_ROWS) issues.push(w);
    sampled.push(r);
    if (sampled.length >= PREVIEW_RECORDS) break;
  }
  const names = src.columns ?? jsonColumns(sampled);
  const columns = names.map((name) => {
    const values = sampled.map((r) => columnValue(r.data, name));
    const inf = inferColumn(name, values, { now });
    const objects = values.filter(isPlainObject).length;
    return { name, samples: values.slice(0, 5).map(displayValue), values, inferred: objects > values.length / 2 ? 'object' : inf.inferred,
      filled: inf.filled, avg_length: Math.round(inf.avgLength), date_share: Math.round(inf.dateShare * 1000) / 1000 };
  });
  const suggested = suggestMapping(columns.filter((c) => c.inferred !== 'object').map((c) => ({ name: c.name, samples: c.samples, values: c.values })),
    { format, delimiter: src.delimiter ?? delimiter, header, encoding: dec.encoding, pointer: src.pointer, fileName, collection, now });
  if (format === 'json' && src.pointer !== null) suggested.pointer = src.pointer;
  if (overrides.line_mode) suggested.options.line_mode = true;
  const preview = {
    ...base,
    delimiter: src.delimiter ?? delimiter,
    header,
    pointer: format === 'json' ? src.pointer : undefined,
    pointer_candidates: format === 'json' ? src.candidates : undefined,
    columns: columns.map(({ values, ...c }) => c),
    sample_rows: sampled.slice(0, SAMPLE_ROWS).map((r) => ({ ...clipDeep(r.data), $line: r.line })),
    suggested_mapping: suggested,
    issues,
    records_sampled: sampled.length,
    fatal: src.fatal ?? midFatal,
  };
  return { preview, sniff: { format, encoding: dec.encoding, delimiter: preview.delimiter, header, pointer: src.pointer, bom: dec.bom,
    columns: preview.columns.map((c) => c.name), sniffed: sniff.format } };
}

/**
 * Read-pool entry: preview of a stored file.
 * @param {import('node:sqlite').DatabaseSync|null} db unused (the file is read from disk)
 * @param {{path: string, fileName: string, collection?: object|null, overrides?: object}} args
 */
export function previewQuery(db, { path: file, fileName, collection = null, overrides = {}, batchId = null, streamAboveBytes = STREAM_ABOVE_BYTES }) {
  const size = statSync(file).size;
  let out;
  let large = size > streamAboveBytes;
  if (large && size <= MAX_PARSE_BYTES) {
    // JSON, TXT and Markdown are read whole anyway: only record formats get the partial preview
    const fd = openSync(file, 'r');
    const head = Buffer.alloc(65536);
    let got;
    try { got = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
    const fmt = FILE_FORMATS.includes(overrides.format) ? overrides.format : sniffFormat(head.subarray(0, got), { fileName }).format;
    large = STREAMABLE.has(fmt);
  }
  if (large) out = previewLarge(file, size, { fileName, collection, overrides });
  else out = buildPreview({ bytes: readForParse(file), fileName, collection, overrides });
  out.preview.file = { name: fileName, bytes: size };
  if (db) out.preview.previous_mappings = previousMappings(db, { columns: out.sniff.columns, format: out.preview.format, exceptBatch: batchId });
  return out;
}

/**
 * Preview of a file too large to read whole: the first 4 MB (cut at a line end) for format, columns and
 * sample rows, plus an encoding check of the whole file; JSON, TXT and Markdown are refused or warned here,
 * before any dry run.
 */
function previewLarge(file, size, { fileName, collection, overrides }) {
  const fd = openSync(file, 'r');
  let head;
  try {
    const b = Buffer.alloc(Math.min(size, PREVIEW_PREFIX_BYTES));
    head = b.subarray(0, readSync(fd, b, 0, b.length, 0));
  } finally { closeSync(fd); }
  const nl = head.lastIndexOf(0x0a);
  if (nl > 0) head = head.subarray(0, nl + 1);
  const enc = scanFileEncoding(file, { encoding: overrides.encoding ?? 'auto' });
  const out = buildPreview({ bytes: head, fileName, collection, now: new Date(),
    overrides: enc.fatal ? overrides : { ...overrides, encoding: enc.decoder } });
  const p = out.preview;
  p.issues = [...enc.issues.filter((i) => !p.issues.some((x) => x.code === i.code)), ...p.issues.filter((x) => x.code !== 'W_ENCODING_FALLBACK' || !enc.issues.length)];
  if (enc.fatal) p.fatal = enc.fatal;
  p.encoding = enc.fatal ? p.encoding : enc.encoding;
  p.partial = { bytes_read: head.length, bytes_total: size };
  const mb = (n) => `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (STREAMABLE.has(p.format)) {
    p.issues.push({ code: 'E_ROW_TOO_LARGE', severity: 'info', line: null, col: null, field: null, value_excerpt: null,
      message: `The file is ${mb(size)}: the preview shows its first ${mb(head.length)}; the dry run and the commit read all of it, in chunks.`,
      suggestion: 'Nothing to do; a dry run over a large file takes a while (it shows its progress in seconds).' });
  } else if (size > MAX_PARSE_BYTES || p.format === 'txt' || p.format === 'md') {
    const fatal = { code: 'E_FILE_TOO_LARGE', severity: 'fatal', line: null, col: null, field: null, value_excerpt: null,
      message: p.format === 'json' ? `This JSON file is ${mb(size)}; JSON files are read whole, up to ${mb(MAX_PARSE_BYTES)}.`
        : `This ${p.format.toUpperCase()} file is ${mb(size)}: it would be one document, and a document holds at most 20 MB of text.`,
      suggestion: p.format === 'json' ? 'Save the records as JSON Lines (one object per line): those are read in chunks, up to 2 GB.'
        : 'Split it into one file per chapter or part, each under 20 MB, and import them into one collection.' };
    p.issues.push(fatal);
    p.fatal = fatal;
  }
  out.sniff = { ...out.sniff, encoding: p.encoding };
  return out;
}

const REUSE_SCAN = 200;
const REUSE_OFFERED = 5;

/**
 * Mapping reuse (§5.2: "Mappings are saved in import_batch.mapping_json and offered for reuse"): the newest
 * validated or committed file imports whose columns are the same as this file's, with their mappings.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{columns: string[], format: string, exceptBatch?: number|null}} q
 * @returns {Array<{batch: number, file_name: string|null, status: string, at: string, collection: string|null, mapping: object}>}
 */
export function previousMappings(db, { columns, format, exceptBatch = null }) {
  if (!columns?.length) return [];
  const want = [...columns].sort().join('\u0000');
  const out = [];
  const rows = db.prepare(`SELECT id, file_name, status, created_at, committed_at, format, mapping_json, options_json FROM import_batch
    WHERE adapter_id LIKE 'file.%' AND status IN ('validated', 'committed', 'reverted') AND id IS NOT ? ORDER BY id DESC LIMIT ?`).all(exceptBatch, REUSE_SCAN);
  for (const r of rows) {
    const opts = parseJsonCol(r.options_json);
    if (!Array.isArray(opts.columns) || [...opts.columns].sort().join('\u0000') !== want) continue;
    const mapping = parseJsonCol(r.mapping_json, null);
    if (!mapping?.fields || !Object.keys(mapping.fields).length) continue;
    const { collection, ...rest } = mapping;
    out.push({ batch: r.id, file_name: r.file_name, status: r.status, at: r.committed_at ?? r.created_at,
      collection: collection?.slug ?? null, same_format: r.format === format, mapping: { ...rest, collection: collection ?? null } });
    if (out.length >= REUSE_OFFERED) break;
  }
  return out;
}

// ── the driver ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Feed every record of a decoded file through the mapping into a sink (DocumentWriter or the projector).
 * Pre-checks shared by both: the row's own parse issues, size, missing text and title, repeated or existing
 * ids. Relationships are handed over at the end, once every id of the file is known.
 * @returns {Promise<{rows: object, dateStats: object, fatal: object|null, aborted: object|null}>}
 */
export async function runImport({ text = null, chunks = null, size = null, decoder, bomBytes = 0, mapping, sink, db = null, batchId = null,
  fileName, sha256, format, now = new Date(), onProgress = null, checkpoint = null, yieldEvery = false }) {
  const m = mapping;
  const abort = m.options.on_bad_row === 'abort';
  const src = chunks
    ? openRecordsChunked(chunks, { format, delimiter: m.delimiter ?? null, header: m.header ?? true, decoder, bomBytes })
    : openRecords(text, { format, delimiter: m.delimiter ?? null, header: m.header ?? true, pointer: m.pointer ?? null,
      fileName, lineMode: Boolean(m.options.line_mode) });
  const fractionOf = (rec) => (chunks ? (size ? (rec.byteEnd ?? 0) / size : 0) : text.length ? rec.end / text.length : 1);
  const rows = { seen: 0, accepted: 0, accepted_with_warnings: 0, rejected: 0 };
  const dateStats = {};
  for (const t of ['date', 'referenced_date']) if (m.fields[t]) dateStats[t] = { nonEmpty: 0, parsed: 0 };
  if (src.fatal) return { rows, dateStats, fatal: src.fatal, aborted: null };
  for (const i of src.issues) sink.addIssue(i);

  const ids = createIdTracker(db, { collectionSlug: m.collection.slug });
  const fileIds = new Set(); // every id this file names, rejected rows included
  const rels = [];
  let lastChar = 0, lastByte = bomBytes;
  const byteAt = (c) => {
    if (decoder === 'windows-1252') return bomBytes + c;
    if (c < lastChar) { lastChar = 0; lastByte = bomBytes; }
    lastByte += utf8Count(text, lastChar, c);
    lastChar = c;
    return lastByte;
  };
  const ctxBase = { fileName, sha256, decoder, batchId, format, now };
  let fatal = null, aborted = null, lastTick = Date.now();
  const rejectRow = (issue) => {
    sink.addIssue(issue);
    rows.rejected++;
    if (abort) aborted = issue;
  };

  for (const rec of src.records) {
    checkpoint?.();
    if (rec.fatal) { fatal = rec.fatal; break; }
    rows.seen++;
    if (rows.seen > MAX_ROWS) {
      fatal = { code: 'E_ROW_TOO_LARGE', severity: 'fatal', line: rec.line, col: null, field: null, value_excerpt: null,
        message: `The file has more than ${MAX_ROWS.toLocaleString('en-US')} records (the limit per import).`,
        suggestion: 'Split the file and import the parts into one collection.' };
      break;
    }
    if (rec.issue) { rejectRow(rec.issue); if (aborted) break; continue; }
    const start = rec.byteStart ?? byteAt(rec.start), end = rec.byteEnd ?? byteAt(rec.end);
    const res = applyMapping(rec, m, { ...ctxBase, byteRange: { start, end } });
    if (res.extId) fileIds.add(res.extId);
    for (const [t, st] of Object.entries(res.stats ?? {})) {
      if (!dateStats[t] || st === null) continue;
      dateStats[t].nonEmpty++;
      if (st === 'parsed') dateStats[t].parsed++;
    }
    const pre = [...(rec.warnings ?? []), ...res.issues];
    for (const i of pre) sink.addIssue(i);
    if (res.reject) { rejectRow(res.reject); if (aborted) break; continue; }
    const dup = ids.check(res.doc.ext_id, rec.line);
    if (dup) { rejectRow(dup); if (aborted) break; continue; }
    const out = sink.addDocument(res.doc, { line: rec.line });
    if (out.documentId === null) { rows.rejected++; if (abort) { aborted = out.issues.at(-1) ?? null; break; } continue; }
    ids.accept(res.doc.ext_id, rec.line);
    rows.accepted++;
    if (pre.some((i) => i.severity === 'warning') || out.issues.some((i) => i.severity === 'warning')) rows.accepted_with_warnings++;
    for (const r of res.rels) rels.push(r);

    const t = Date.now();
    if (t - lastTick >= PROGRESS_EVERY_MS) {
      lastTick = t;
      onProgress?.({ fraction: fractionOf(rec), line: rec.line, rows });
      if (yieldEvery) await new Promise((r) => setImmediate(r));
    }
  }
  // fix pass (brief §12): a file with nothing to import says so, rather than committing "0 documents imported" silently
  if (!fatal && !aborted && rows.seen === 0) {
    const tabular = (format === 'csv' || format === 'tsv') && (m.header ?? true);
    sink.addIssue({ code: 'W_NO_RECORDS', severity: 'warning', line: tabular ? 1 : null, col: null, field: null, value_excerpt: null,
      message: tabular ? 'The file has a header row but no records: nothing will be imported.' : 'The file holds no records: nothing will be imported.',
      suggestion: tabular ? 'Check that this is the right file and that its records follow the header row.'
        : 'Check that this is the right file and that the mapping points at the array that holds the records.' });
  }
  if (fatal || aborted) return { rows, dateStats, fatal, aborted };

  // A namespaced id ('pg:1342', 'cw:4948') that is neither in this file nor in the collection may name one
  // document elsewhere in Scrolls; a plain id ('z001') is only ever read inside this file and collection, so a
  // documented link never lands on an unrelated record that happens to share a short id.
  const inCollection = db ? db.prepare(`SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL LIMIT 1`) : null;
  for (const rel of rels) {
    const d = rel.dst;
    if (db && d.ext_id && !d.collection && /^[\p{L}\p{N}_.-]+:\S/u.test(d.ext_id) && !fileIds.has(d.ext_id) && !inCollection.get(m.collection.slug, d.ext_id)) {
      const id = resolveExt(db, { extId: d.ext_id });
      if (id) rel.dst = { ref: `document:${id}` };
    }
    sink.addRelationship(rel);
  }
  return { rows, dateStats, fatal: null, aborted: null };
}

/** UTF-8 bytes of text[a, b) (see decode.utf8Length; inlined for the hot loop). */
function utf8Count(s, a, b) {
  let n = 0;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < b) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

// ── batches ─────────────────────────────────────────────────────────────────────────────────────────

/** The import_batch row or 404. */
export function getBatch(db, batchId) {
  const id = Number(batchId);
  const b = Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM import_batch WHERE id = ?').get(id) : null;
  if (!b) throw new HttpError(404, 'E_NOT_FOUND', `No import batch ${batchId}.`, null, null);
  if (b.adapter_id && !String(b.adapter_id).startsWith('file.')) {
    throw new HttpError(404, 'E_NOT_FOUND', `Import batch ${batchId} is not a file import (adapter ${b.adapter_id}).`, null, null);
  }
  return b;
}

function parseJsonCol(s, d = {}) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
/** Options stored with a batch at upload (sniff results, preview, collection). */
export const batchOptions = (b) => parseJsonCol(b.options_json);

/**
 * Preview of an uploaded file as stored at upload time (the read pool recomputes it on overrides).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} batchId
 * @returns {object|null}
 */
export function previewImport(db, batchId) {
  return batchOptions(getBatch(db, batchId)).preview ?? null;
}

/** The file facts of a batch for summaries. */
function fileInfo(db, batch, decoded, mapping) {
  const f = db.prepare('SELECT byte_size FROM original_file WHERE sha256 = ?').get(batch.file_sha256);
  return { name: batch.file_name ?? 'upload', sha256: batch.file_sha256, bytes: f?.byte_size ?? 0, encoding: decoded?.encoding ?? 'unknown',
    format: batch.format, delimiter: batch.format === 'csv' || batch.format === 'tsv' ? mapping.delimiter ?? null : null };
}

/** Normalize and check a mapping against the batch; 400 E_MAPPING_INVALID listing every problem. */
export function checkMapping(batch, rawMapping) {
  const opts = batchOptions(batch);
  const raw = { ...(rawMapping ?? {}) };
  raw.format = FILE_FORMATS.includes(raw.format) ? raw.format : batch.format;
  const v = validateMapping(raw, { columns: opts.columns ?? null, format: raw.format });
  if (v.errors.length) {
    const e = v.errors[0];
    throw new HttpError(400, 'E_MAPPING_INVALID', e.message, e.hint ?? null,
      { target: e.target ?? null, from: e.from ?? null, errors: v.errors.map(({ target, message, hint, from }) => ({ target, message, hint, from })) });
  }
  v.mapping.collection = { ...v.mapping.collection, slug: slugify(v.mapping.collection.slug) };
  return v;
}

/**
 * Dry run over all rows → projected ImportSummary (§5.2 step 3). Writes nothing to the database; every
 * issue goes to the batch's dry-run problems.csv.
 * @param {import('node:sqlite').DatabaseSync} db read-only is enough
 * @param {number} batchId
 * @param {object} mapping
 * @param {{dataDir?: string, now?: Date}} [opts]
 * @returns {Promise<object>} ImportSummary (projected: true)
 */
export async function validateImport(db, batchId, mapping, { dataDir = paths().data, now = new Date(), streamAboveBytes, chunkSize } = {}) {
  const t0 = Date.now(), startedAt = new Date(t0).toISOString();
  const batch = getBatch(db, batchId);
  const { mapping: m, warnings } = checkMapping(batch, mapping);
  const opened = openForRun(originalPath(db, batch, dataDir), m, { streamAboveBytes, chunkSize });
  const dec = opened.dec;

  const csvPath = dryRunProblemsPath(batch.id, dataDir);
  mkdirSync(path.dirname(csvPath), { recursive: true });
  const tmp = `${csvPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = openSync(tmp, 'w');
  let buf = PROBLEMS_HEADER;
  const flush = () => { if (buf) { writeSync(fd, buf); buf = ''; } };
  const projector = createProjector(db, { collectionSlug: m.collection.slug, options: { dedupe: m.options.dedupe, detectLanguage: m.options.detect_language !== false },
    textChars: opened.textChars, onIssue: (i) => { buf += problemLine(i); if (buf.length > 65536) flush(); } });

  let res = { rows: { seen: 0, accepted: 0, accepted_with_warnings: 0, rejected: 0 }, dateStats: {}, fatal: null, aborted: null };
  try {
    const existing = committedBatchForFile(db, { collectionSlug: m.collection.slug, sha256: batch.file_sha256, exceptBatch: batch.id });
    if (dec.fatal) res.fatal = dec.fatal;
    else if (existing) res.fatal = dupFileIssue(existing, m.collection.slug);
    else {
      for (const w of [...dec.issues, ...warnings]) projector.addIssue(w);
      res = await runImport({ text: opened.text, chunks: opened.chunks, size: opened.size, decoder: dec.decoder, bomBytes: dec.bomBytes, mapping: m,
        sink: projector, db, batchId: batch.id, fileName: batch.file_name ?? 'upload', sha256: batch.file_sha256, format: m.format, now });
    }
    if (res.fatal) projector.addIssue(res.fatal);
    const counts = projector.finish();
    const t1 = Date.now();
    return buildSummary(counts, {
      batchId: batch.id, collection: m.collection.slug, file: fileInfo(db, batch, dec, m), rows: res.rows, mapping: m,
      dateStats: res.dateStats, projected: true, fatal: res.fatal, aborted: res.aborted, notes: projector.notes,
      startedAt, finishedAt: new Date(t1).toISOString(), durationMs: t1 - t0, status: 'validated',
    });
  } finally {
    flush();
    closeSync(fd);
    renameSync(tmp, csvPath);
  }
}

/**
 * Read-pool entry for the dry run.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{batchId: number, mapping: object, dataDir?: string}} args
 */
export function validateQuery(db, { batchId, mapping, dataDir, streamAboveBytes, chunkSize }) {
  return validateImport(db, batchId, mapping, { dataDir, streamAboveBytes, chunkSize });
}

/**
 * The user collection an import goes into, created on first use; 409 when the slug belongs to another
 * corpus (Cipher, STEMM, the demo).
 */
export function ensureUserCollection(db, c, { format, hasText, fileName }) {
  const existing = db.prepare('SELECT c.*, k.slug AS corpus_slug FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.slug = ?').get(c.slug);
  if (existing && existing.corpus_slug !== 'user') {
    throw new HttpError(409, 'E_COLLECTION_NOT_USER', `Collection '${c.slug}' belongs to the ${existing.corpus_slug} corpus; imports go into your own collections.`,
      'Choose another collection name.', { collection: c.slug, corpus: existing.corpus_slug });
  }
  if (existing) return existing;
  return ensureCollection(db, {
    slug: c.slug, name: c.name || c.slug, corpus: 'user', adapter_id: `file.${format}`, domain: 'imported',
    modality: hasText ? 'text' : 'titles', unit: c.unit === 'works' || c.unit === 'tokens' ? c.unit : hasText ? 'tokens' : 'works',
    sampling: 'user', license: c.license ?? null, selection_note: `your import (${fileName})`, caveats: [],
  });
}

function jobError(issue, code = issue.code) {
  const err = new Error(issue.message);
  err.code = code;
  err.hint = issue.suggestion ?? null;
  return err;
}

/**
 * Commit job body ('import' task): drive every record into DocumentWriter; on a fatal problem, an abort or a
 * cancel, roll the batch back (zero documents) and say why.
 * @param {object} ctx TaskCtx
 * @param {{batchId: number, mapping: object}} params
 * @returns {Promise<object>} ImportSummary
 */
export async function commitImport(ctx, { batchId, mapping, streamAboveBytes, chunkSize }) {
  const db = ctx.db;
  const t0 = Date.now(), startedAt = new Date(t0).toISOString();
  const now = new Date(t0);
  const batch = getBatch(db, batchId);
  if (batch.status === 'committed' || batch.status === 'reverted') {
    throw Object.assign(new Error(`Batch ${batch.id} was already committed${batch.job_id ? ` (job ${batch.job_id})` : ''}.`), { code: 'E_IMPORT_STATE', hint: 'Open the import summary instead.' });
  }
  const { mapping: m, warnings } = checkMapping(batch, mapping);
  const fileName = batch.file_name ?? 'upload';
  ctx.progress(0, 'read', `reading ${fileName}`);
  const opened = openForRun(originalPath(db, batch, ctx.paths?.data), m, { streamAboveBytes, chunkSize });
  const dec = opened.dec;
  const coll = ensureUserCollection(db, m.collection, { format: m.format, hasText: Boolean(m.fields.text), fileName });
  db.prepare("UPDATE import_batch SET status = 'committing', collection_id = ?, format = ?, adapter_id = ?, mapping_json = ?, job_id = ? WHERE id = ?")
    .run(coll.id, m.format, `file.${m.format}`, JSON.stringify(stripMapping(m)), ctx.jobId ?? null, batch.id);
  db.prepare('DELETE FROM import_issue WHERE batch_id = ?').run(batch.id); // issues of an earlier failed attempt
  const runId = ctx.startRun('import', { pipelineVersion: PIPELINE_VERSION, params: { batch: batch.id, mapping: stripMapping(m) },
    scope: { collections: [coll.slug] }, codeFiles: [new URL(import.meta.url)] });
  const writer = createDocumentWriter(db, { batchId: batch.id, collection: coll.slug, corpus: 'user',
    options: { dedupe: m.options.dedupe, detectLanguage: m.options.detect_language !== false, onBadRow: m.options.on_bad_row, now } });
  const bulk = opened.textChars > BULK_FTS_CHARS;
  let finished = false, res = null;
  const fail = (issue, code) => { writer.addIssue(issue); return jobError(issue, code); };
  try {
    if (bulk) setFtsBulkLoad(db, true);
    if (dec.fatal) throw fail(dec.fatal);
    const existing = committedBatchForFile(db, { collectionSlug: coll.slug, sha256: batch.file_sha256, exceptBatch: batch.id });
    if (existing) throw fail(dupFileIssue(existing, coll.slug));
    for (const w of [...dec.issues, ...warnings]) writer.addIssue(w);
    ctx.progress(0.01, 'write', `writing ${fileName}`);
    res = await runImport({ text: opened.text, chunks: opened.chunks, size: opened.size, decoder: dec.decoder, bomBytes: dec.bomBytes, mapping: m, sink: writer, db, batchId: batch.id,
      fileName, sha256: batch.file_sha256, format: m.format, now, checkpoint: () => ctx.checkpoint(), yieldEvery: true,
      onProgress: ({ fraction, line, rows }) => ctx.progress(Math.min(0.95, 0.01 + fraction * 0.94), 'write',
        `line ${line.toLocaleString('en-US')} · ${rows.accepted.toLocaleString('en-US')} accepted · ${rows.rejected.toLocaleString('en-US')} rejected`,
        { rows: rows.seen, accepted: rows.accepted, rejected: rows.rejected }) });
    if (res.fatal) throw fail(res.fatal);
    if (res.aborted) {
      throw jobError({ message: `Import aborted at line ${res.aborted.line ?? '?'}: ${res.aborted.message}`, suggestion: `${res.aborted.suggestion} (on_bad_row is 'abort': no rows were kept).` }, 'E_IMPORT_ABORTED');
    }
    ctx.checkpoint();
    ctx.progress(0.96, 'links', 'resolving links and committing');
    const counts = writer.finish();
    finished = true;
    const t1 = Date.now();
    const summary = buildSummary(counts, {
      batchId: batch.id, collection: coll.slug, file: fileInfo(db, batch, dec, m), rows: res.rows, mapping: m, dateStats: res.dateStats,
      dataVersion: counts.data_version, runId, startedAt, finishedAt: new Date(t1).toISOString(), durationMs: t1 - t0, status: 'committed',
    });
    db.prepare('UPDATE import_batch SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), batch.id);
    ctx.finishRun(runId, 'succeeded', { metrics: { rows: res.rows, documents: counts.documents.created, passages: counts.passages, tokens: counts.tokens } });
    ctx.progress(1, 'done', `${counts.documents.created.toLocaleString('en-US')} documents imported`);
    return summary;
  } catch (err) {
    const cancelled = err?.name === 'CancelledError' || err?.code === 'E_CANCELLED';
    if (!finished) {
      writer.rollback();
      const status = cancelled ? 'cancelled' : 'failed';
      const counts = writer.counts();
      const summary = buildSummary(counts, {
        batchId: batch.id, collection: coll.slug, file: fileInfo(db, batch, dec, m), rows: res?.rows ?? { seen: 0, accepted: 0, accepted_with_warnings: 0, rejected: 0 },
        mapping: m, dateStats: res?.dateStats ?? {}, startedAt, finishedAt: nowIso(), durationMs: Date.now() - t0, status,
        fatal: res?.fatal ?? (cancelled ? null : { code: err?.code ?? 'E_IMPORT_FAILED', message: String(err?.message ?? err), suggestion: err?.hint ?? null }),
      });
      summary.documents.created = 0;
      db.prepare('UPDATE import_batch SET status = ?, summary_json = ? WHERE id = ?').run(status, JSON.stringify(summary), batch.id);
      ctx.finishRun(runId, cancelled ? 'cancelled' : 'failed');
    }
    throw err;
  } finally {
    if (bulk) { try { setFtsBulkLoad(db, false); } catch { /* best effort */ } }
  }
}

/** The mapping as stored (normalized, without parsed transform objects). */
export function stripMapping(m) {
  const fields = Object.fromEntries(Object.entries(m.fields).map(([k, { transformList, ...rest }]) => [k, rest]));
  return { ...m, fields };
}

/**
 * Revert job body ('revert' task): soft-delete the batch's documents and bump data_version (§5.2).
 * @param {object} ctx TaskCtx
 * @param {{batchId: number}} params
 */
export async function revertImport(ctx, { batchId }) {
  const db = ctx.db;
  const batch = getBatch(db, batchId);
  if (batch.status !== 'committed') {
    throw Object.assign(new Error(`Batch ${batch.id} is ${batch.status}; only a committed import can be reverted.`), { code: 'E_IMPORT_STATE', hint: 'Nothing to revert.' });
  }
  ctx.progress(0.1, 'revert', `reverting batch ${batch.id}`);
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  let n, version;
  try {
    n = Number(stmt(db, 'UPDATE document SET deleted_at = ? WHERE import_batch_id = ? AND deleted_at IS NULL').run(at, batch.id).changes);
    // Live documents flagged as duplicates of a reverted one would stay excluded as duplicates of nothing (M1 gate):
    // the earliest live copy becomes the original and the other copies point to it.
    const orphans = stmt(db, `SELECT d.id, d.dup_of AS old FROM document d JOIN document r ON r.id = d.dup_of
      WHERE r.import_batch_id = ? AND d.deleted_at IS NULL ORDER BY d.id`).all(batch.id);
    const head = new Map();
    for (const o of orphans) {
      if (!head.has(o.old)) { head.set(o.old, o.id); stmt(db, 'UPDATE document SET dup_of = NULL WHERE id = ?').run(o.id); }
      else stmt(db, 'UPDATE document SET dup_of = ? WHERE id = ?').run(head.get(o.old), o.id);
    }
    stmt(db, "UPDATE import_batch SET status = 'reverted' WHERE id = ?").run(batch.id);
    version = bumpDataVersion(db);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  ctx.emit?.('data', { dataVersion: version });
  ctx.progress(1, 'done', `${n.toLocaleString('en-US')} documents reverted`);
  return { import_batch_id: batch.id, documents: n, data_version: version, reverted_at: at };
}

