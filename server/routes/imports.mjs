// OWNER: WP1
// routes/imports.mjs — the import API (SPEC §5.2, §7.1; shapes ImportCreated, ImportPreview, ImportValidation,
// JobRef in src/shared/contracts.mjs, fixtures tests/contract/*imports*.json).
//
//   POST /api/imports                    raw body; X-Scrolls-Filename, X-Scrolls-Collection (URL-encoded JSON)
//   GET  /api/imports/:id/preview        stored preview; ?format=&delimiter=&header=&pointer=&encoding=&line_mode= re-reads
//   PUT  /api/imports/:id/mapping        {mapping} → {validation: projected ImportSummary} (dry run in the read pool)
//   POST /api/imports/:id/commit         {mapping} → {job: {id}} ('import' job; its result is the ImportSummary)
//   GET  /api/imports/:id/problems.csv   every issue of the batch (the commit's, else the latest dry run's)
//   POST /api/imports/:id/revert         → {job: {id}} ('revert' job: soft-delete, bump data_version)

import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { slugify } from '../../src/shared/ids.mjs';
import { paths } from '../config.mjs';
import { nowIso, stmt } from '../db/open.mjs';
import { badRequest, HttpError } from '../http/errors.mjs';
import { FILE_ADAPTERS } from '../adapters/registry.mjs';
import { committedBatchForFile } from '../ingest/dedupe.mjs';
import {
  batchOptions, checkMapping, dryRunProblemsPath, getBatch, MAX_UPLOAD_BYTES, storeUploaded, streamToFile, stripMapping,
} from '../ingest/pipeline.mjs';
import { formatFromName, FILE_FORMATS } from '../ingest/sniff.mjs';
import { PROBLEMS_HEADER, problemLine } from '../ingest/summary.mjs';

const PIPELINE_URL = new URL('../ingest/pipeline.mjs', import.meta.url).href;
const PREVIEW_TIMEOUT_MS = 60000;
const DRY_RUN_TIMEOUT_MS = 180000;
const DELIMITER_WORDS = { comma: ',', tab: '\t', '\\t': '\t', semicolon: ';', pipe: '|', ',': ',', '\t': '\t', ';': ';', '|': '|' };
const FILE_ADAPTER_VERSION = Object.fromEntries(FILE_ADAPTERS.map((a) => [a.id, a.version]));

/** Run a read-pool query, or in-process when no pool exists (route tests without a server). */
async function heavy(ctx, fn, args, timeoutMs) {
  if (ctx.pool) return ctx.pool.run(PIPELINE_URL, fn, args, { timeoutMs });
  const mod = await import(PIPELINE_URL);
  return mod[fn](ctx.db, args);
}

function headerValue(v) {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === null || s === '') return null;
  try { return decodeURIComponent(String(s)); } catch { return String(s); }
}

/** X-Scrolls-Collection: URL-encoded JSON {slug, name, unit, license}; null when absent. */
export function parseCollectionHeader(v) {
  const raw = headerValue(v);
  if (raw === null) return null;
  let c;
  try { c = JSON.parse(raw); } catch {
    throw badRequest('E_BAD_COLLECTION', 'X-Scrolls-Collection is not URL-encoded JSON.', 'Send encodeURIComponent(JSON.stringify({slug, name, unit, license})).');
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw badRequest('E_BAD_COLLECTION', 'X-Scrolls-Collection must be a JSON object.', 'Send {"slug", "name", "unit", "license"}.');
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, 200) : '';
  const slug = slugify(typeof c.slug === 'string' && c.slug.trim() ? c.slug : name || '');
  if (slug === 'untitled' && !c.slug && !name) throw badRequest('E_BAD_COLLECTION', 'The collection needs a name or a slug.', 'Name the collection.');
  if (c.unit !== undefined && c.unit !== null && !['tokens', 'works'].includes(c.unit)) {
    throw badRequest('E_BAD_COLLECTION', `Collection unit '${c.unit}' is not 'tokens' or 'works'.`, "Use 'tokens' for texts, 'works' for title lists.");
  }
  return { slug, name: name || slug, unit: c.unit ?? null, license: typeof c.license === 'string' ? c.license.slice(0, 500) : null };
}

/** Refuse a collection slug that belongs to the demo, Cipher or STEMM corpus. */
function assertUserCollection(db, slug) {
  const r = db.prepare('SELECT k.slug AS corpus FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.slug = ?').get(slug);
  if (r && r.corpus !== 'user') {
    throw new HttpError(409, 'E_COLLECTION_NOT_USER', `Collection '${slug}' belongs to the ${r.corpus} corpus; imports go into your own collections.`,
      'Choose another collection name.', { collection: slug, corpus: r.corpus });
  }
}

function dupFileError(found) {
  const date = String(found.committed_at ?? '').slice(0, 10) || 'an earlier date';
  return new HttpError(409, 'E_DUP_FILE', `Already imported on ${date} as batch ${found.batch}.`,
    `Open batch ${found.batch} instead, or import a changed file.`, { batch: found.batch });
}

/** Preview overrides from a query string. */
function overridesOf(q) {
  const o = {};
  if (q.format) {
    if (!FILE_FORMATS.includes(q.format)) throw badRequest('E_BAD_FORMAT', `Unknown format '${q.format}'.`, `Use one of ${FILE_FORMATS.join(', ')}.`);
    o.format = q.format;
  }
  if (q.delimiter !== undefined && q.delimiter !== '') {
    const d = DELIMITER_WORDS[q.delimiter] ?? (q.delimiter.length === 1 ? q.delimiter : null);
    if (!d || /[\r\n"]/.test(d)) throw badRequest('E_BAD_DELIMITER', `'${q.delimiter}' cannot be a delimiter.`, 'Use comma, tab, semicolon or pipe.');
    o.delimiter = d;
  }
  if (q.header !== undefined && q.header !== '') o.header = !['0', 'false', 'no'].includes(String(q.header).toLowerCase());
  if (q.pointer !== undefined) o.pointer = q.pointer;
  if (q.encoding) {
    if (!['auto', 'utf-8', 'windows-1252'].includes(q.encoding)) throw badRequest('E_BAD_ENCODING', `Unknown encoding '${q.encoding}'.`, 'Use utf-8 or windows-1252.');
    o.encoding = q.encoding;
  }
  if (q.line_mode !== undefined) o.line_mode = ['1', 'true', 'yes'].includes(String(q.line_mode).toLowerCase());
  return o;
}

/** A batch whose commit job is queued or running, or null. */
function activeJob(db, batch) {
  if (!batch.job_id) return null;
  const j = db.prepare('SELECT id, status FROM job WHERE id = ?').get(batch.job_id);
  return j && ['queued', 'running', 'cancelling'].includes(j.status) ? j : null;
}

function assertEditable(db, batch, ctx) {
  const live = batch.job_id ? ctx.jobs?.get(batch.job_id) : null;
  const job = live && ['queued', 'running', 'cancelling'].includes(live.status) ? live : activeJob(db, batch);
  if (job) throw new HttpError(409, 'E_IMPORT_STATE', `Batch ${batch.id} is being committed (job ${job.id}).`, 'Follow the job, or cancel it first.', { job: job.id });
  if (batch.status === 'committed' || batch.status === 'committing') {
    throw new HttpError(409, 'E_IMPORT_STATE', `Batch ${batch.id} was already committed${batch.job_id ? ` (job ${batch.job_id})` : ''}.`,
      'Open the import summary instead.', { job: batch.job_id ?? null });
  }
  if (batch.status === 'reverted') throw new HttpError(409, 'E_IMPORT_STATE', `Batch ${batch.id} was committed and then reverted.`, 'Upload the file again to import it into a new collection.', { job: batch.job_id ?? null });
}

export const routes = [
  {
    method: 'POST',
    path: '/api/imports',
    rawBody: true,
    async handler(req, ctx) {
      const fileName = (headerValue(req.headers['x-scrolls-filename']) ?? 'upload').split(/[\\/]/).pop().slice(0, 255) || 'upload';
      if (req.body !== null && req.body !== undefined) {
        throw new HttpError(415, 'E_UPLOAD_TYPE', 'The file arrived as a parsed JSON body, not as raw bytes.',
          'Send the file with Content-Type: application/octet-stream (the Scrolls page does this).');
      }
      const collection = parseCollectionHeader(req.headers['x-scrolls-collection']);
      if (collection) assertUserCollection(ctx.db, collection.slug);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        req.raw.resume();
        throw new HttpError(413, 'E_FILE_TOO_LARGE', `The file is ${(declared / 1024 ** 3).toFixed(1)} GB; the limit is 2 GB per file.`,
          'Split the file and import the parts into one collection.', { bytes: declared });
      }
      const guess = formatFromName(fileName) ?? 'txt';
      const batchId = ctx.withWrite((db) => Number(stmt(db, `INSERT INTO import_batch (collection_id, adapter_id, adapter_version, file_name, format,
          mapping_json, options_json, status, created_at) VALUES (NULL, ?, ?, ?, ?, '{}', ?, 'uploaded', ?)`)
        .run(`file.${guess}`, FILE_ADAPTER_VERSION[`file.${guess}`] ?? '1.0.0', fileName, guess, JSON.stringify({ collection }), nowIso()).lastInsertRowid));
      const markFailed = (why) => ctx.withWrite((db) => stmt(db, "UPDATE import_batch SET status = 'failed', options_json = json_set(options_json, '$.failure', ?) WHERE id = ?").run(why, batchId));

      const part = path.join(paths().incoming, `${batchId}.part`);
      let up;
      try {
        up = await streamToFile(req.raw, part);
      } catch (err) {
        markFailed(err.code ?? 'upload failed');
        throw err;
      }
      if (up.bytes === 0) {
        markFailed('empty file');
        throw badRequest('E_EMPTY_FILE', `${fileName} is empty.`, 'Choose a file with content.');
      }
      const rel = storeUploaded(part, up.sha256);
      if (collection) {
        const found = committedBatchForFile(ctx.db, { collectionSlug: collection.slug, sha256: up.sha256 });
        if (found) { markFailed('E_DUP_FILE'); throw dupFileError(found); }
      }
      let pv;
      try {
        pv = await heavy(ctx, 'previewQuery', { path: path.join(paths().data, rel), fileName, collection, batchId }, PREVIEW_TIMEOUT_MS);
      } catch (err) {
        markFailed(err.code ?? 'preview failed');
        throw err;
      }
      const preview = { ...pv.preview, file: { name: fileName, bytes: up.bytes, sha256: up.sha256 } };
      const fmt = preview.format;
      ctx.withWrite((db) => {
        stmt(db, `INSERT INTO original_file (sha256, rel_path, source_path, byte_size, encoding, had_bom, stored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`)
          .run(up.sha256, rel, `upload:${fileName}`, up.bytes, preview.encoding, pv.sniff.bom ? 1 : 0, nowIso());
        stmt(db, `UPDATE import_batch SET file_sha256 = ?, format = ?, adapter_id = ?, adapter_version = ?, status = 'previewed',
          options_json = ?, mapping_json = ? WHERE id = ?`)
          .run(up.sha256, fmt, `file.${fmt}`, FILE_ADAPTER_VERSION[`file.${fmt}`] ?? '1.0.0',
            JSON.stringify({ collection, sniff: pv.sniff, columns: pv.sniff.columns, preview, bytes: up.bytes }),
            JSON.stringify(preview.suggested_mapping), batchId);
      });
      return { json: { import_batch_id: batchId, preview } };
    },
  },
  {
    method: 'GET',
    path: '/api/imports/:id/preview',
    heavy: true,
    async handler(req, ctx) {
      const batch = getBatch(ctx.db, req.params.id);
      const opts = batchOptions(batch);
      const overrides = overridesOf(req.query);
      if (!Object.keys(overrides).length && opts.preview) return { json: opts.preview, etag: false };
      if (!batch.file_sha256) throw new HttpError(409, 'E_IMPORT_STATE', `Import batch ${batch.id} has no stored file.`, 'Upload the file again.');
      const f = ctx.db.prepare('SELECT rel_path FROM original_file WHERE sha256 = ?').get(batch.file_sha256);
      const pv = await heavy(ctx, 'previewQuery', { path: path.join(paths().data, f.rel_path), fileName: batch.file_name ?? 'upload',
        collection: opts.collection ?? null, overrides, batchId: batch.id }, PREVIEW_TIMEOUT_MS);
      const preview = { ...pv.preview, file: { name: batch.file_name, bytes: opts.bytes ?? pv.preview.file?.bytes ?? null, sha256: batch.file_sha256 } };
      if (!['committing', 'committed', 'reverted'].includes(batch.status)) {
        ctx.withWrite((db) => stmt(db, `UPDATE import_batch SET format = ?, adapter_id = ?, options_json = ?, mapping_json = ? WHERE id = ?`)
          .run(preview.format, `file.${preview.format}`, JSON.stringify({ ...opts, sniff: pv.sniff, columns: pv.sniff.columns, preview, overrides }),
            JSON.stringify(preview.suggested_mapping), batch.id));
      }
      return { json: preview, etag: false };
    },
  },
  {
    method: 'PUT',
    path: '/api/imports/:id/mapping',
    heavy: true,
    async handler(req, ctx) {
      const batch = getBatch(ctx.db, req.params.id);
      assertEditable(ctx.db, batch, ctx);
      if (!req.body || typeof req.body !== 'object' || !req.body.mapping) throw badRequest('E_VALIDATION', 'The body must be {"mapping": {…}}.', 'Send the mapping chosen in the wizard.');
      const { mapping } = checkMapping(batch, req.body.mapping);
      assertUserCollection(ctx.db, mapping.collection.slug);
      const bytes = ctx.db.prepare('SELECT byte_size FROM original_file WHERE sha256 = ?').get(batch.file_sha256)?.byte_size ?? 0;
      // ≈ 10 MB/s measured on the 50 MB acceptance file; allow 2 MB/s before the read pool stops the dry run
      const timeoutMs = Math.max(DRY_RUN_TIMEOUT_MS, Math.ceil(bytes / (2 * 1024 * 1024)) * 1000);
      const validation = await heavy(ctx, 'validateQuery', { batchId: batch.id, mapping: req.body.mapping, dataDir: paths().data }, timeoutMs);
      ctx.withWrite((db) => {
        // after a failed or cancelled commit, problems.csv follows this newer dry run
        if (batch.status === 'failed' || batch.status === 'cancelled') stmt(db, 'DELETE FROM import_issue WHERE batch_id = ?').run(batch.id);
        stmt(db, "UPDATE import_batch SET status = 'validated', format = ?, adapter_id = ?, mapping_json = ?, summary_json = ? WHERE id = ? AND status IN ('uploaded', 'previewed', 'validated', 'failed', 'cancelled')")
          .run(mapping.format, `file.${mapping.format}`, JSON.stringify(stripMapping(mapping)), JSON.stringify(validation), batch.id);
      });
      return { json: { validation } };
    },
  },
  {
    method: 'POST',
    path: '/api/imports/:id/commit',
    async handler(req, ctx) {
      const batch = getBatch(ctx.db, req.params.id);
      assertEditable(ctx.db, batch, ctx);
      if (!req.body || typeof req.body !== 'object' || !req.body.mapping) throw badRequest('E_VALIDATION', 'The body must be {"mapping": {…}}.', 'Send the mapping to commit.');
      const { mapping } = checkMapping(batch, req.body.mapping);
      assertUserCollection(ctx.db, mapping.collection.slug);
      const found = committedBatchForFile(ctx.db, { collectionSlug: mapping.collection.slug, sha256: batch.file_sha256, exceptBatch: batch.id });
      if (found) throw dupFileError(found);
      const job = ctx.jobs.enqueue('import', { batchId: batch.id, mapping: req.body.mapping });
      ctx.withWrite((db) => stmt(db, 'UPDATE import_batch SET job_id = ?, mapping_json = ? WHERE id = ?').run(job, JSON.stringify(stripMapping(mapping)), batch.id));
      return { json: { job: { id: job } } };
    },
  },
  {
    method: 'GET',
    path: '/api/imports/:id/problems.csv',
    async handler(req, ctx) {
      const batch = getBatch(ctx.db, req.params.id);
      const headers = { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="import-${batch.id}-problems.csv"`,
        'Cache-Control': 'no-store' };
      const stored = ctx.db.prepare('SELECT count(*) AS n FROM import_issue WHERE batch_id = ?').get(batch.id).n;
      const dryRun = dryRunProblemsPath(batch.id);
      if (!stored && existsSync(dryRun)) {
        return { headers, stream(res) { res.writeHead(200); createReadStream(dryRun).pipe(res); } };
      }
      const rows = ctx.db.prepare('SELECT code, severity, line, col, field, value_excerpt, message, suggestion FROM import_issue WHERE batch_id = ? ORDER BY id');
      return {
        headers,
        stream(res) {
          res.writeHead(200);
          let buf = PROBLEMS_HEADER;
          for (const r of rows.iterate(batch.id)) {
            buf += problemLine(r);
            if (buf.length > 65536) { res.write(buf); buf = ''; }
          }
          res.end(buf);
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/imports/:id/revert',
    async handler(req, ctx) {
      const batch = getBatch(ctx.db, req.params.id);
      if (batch.status !== 'committed') {
        throw new HttpError(409, 'E_IMPORT_STATE', `Batch ${batch.id} is ${batch.status}; only a committed import can be reverted.`, 'Nothing to revert.', { status: batch.status });
      }
      const job = ctx.jobs.enqueue('revert', { batchId: batch.id });
      return { json: { job: { id: job } } };
    },
  },
];
