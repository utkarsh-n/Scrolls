// OWNER: WP1 — test harness for the import pipeline: stage a file like POST /api/imports, dry-run it, commit
// it with the 'import' job body, without an HTTP server (SPEC §5, §11).

import { readFileSync } from 'node:fs';
import { nowIso } from '../../../server/db/open.mjs';
import { makeTaskContext } from '../../../server/jobs/context.mjs';
import { buildPreview, commitImport, validateImport } from '../../../server/ingest/pipeline.mjs';
import { storeOriginal } from '../../../server/store/document-writer.mjs';

export const FIXTURES = new URL('./', import.meta.url);

/** Bytes of a fixture file. */
export const fixtureBytes = (name) => readFileSync(new URL(name, FIXTURES));

/**
 * Store a file and create its batch and preview (what POST /api/imports does after streaming).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Uint8Array|string} input bytes, or text (UTF-8 encoded)
 * @param {{fileName: string, collection?: object|null, overrides?: object}} opts
 * @returns {{batchId: number, preview: object, mapping: object, sha256: string}}
 */
export function stageFile(db, input, { fileName, collection = null, overrides = {} }) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const { preview, sniff } = buildPreview({ bytes, fileName, collection, overrides, now: new Date('2026-10-04T12:00:00Z') });
  const sha = storeOriginal(db, bytes, { sourcePath: `test:${fileName}`, encoding: preview.encoding, hadBom: Boolean(sniff.bom) });
  const r = db.prepare(`INSERT INTO import_batch (collection_id, adapter_id, adapter_version, file_sha256, file_name, format, mapping_json,
      options_json, status, created_at) VALUES (NULL, ?, '1.0.0', ?, ?, ?, ?, ?, 'previewed', ?)`)
    .run(`file.${preview.format}`, sha, fileName, preview.format, JSON.stringify(preview.suggested_mapping),
      JSON.stringify({ collection, sniff, columns: sniff.columns, preview, bytes: bytes.length }), nowIso());
  return { batchId: Number(r.lastInsertRowid), preview, mapping: structuredClone(preview.suggested_mapping), sha256: sha };
}

/** Dry run (validateImport) with a fixed clock. */
export function dryRun(db, batchId, mapping, { streamAboveBytes, chunkSize } = {}) {
  return validateImport(db, batchId, mapping, { now: new Date('2026-10-04T12:00:00Z'), streamAboveBytes, chunkSize });
}

/**
 * Commit through the 'import' job body. `cancelAfterRows` sets the cancel flag once that many progress
 * reports arrived (each is a batch of rows).
 * @returns {Promise<{summary: object|null, error: Error|null, progress: object[]}>}
 */
export async function commit(db, batchId, mapping, { cancelNow = false, streamAboveBytes, chunkSize } = {}) {
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  if (cancelNow) Atomics.store(cancelFlag, 0, 1);
  const progress = [];
  const ctx = makeTaskContext({ db, jobId: null, cancelFlag, post: (m) => { if (m.kind === 'progress') progress.push(m); }, type: 'import' });
  try {
    const summary = await commitImport(ctx, { batchId, mapping, streamAboveBytes, chunkSize });
    return { summary, error: null, progress };
  } catch (error) {
    return { summary: null, error, progress };
  } finally {
    if (db.isTransaction) db.exec('COMMIT');
  }
}

/** Documents of a batch that are not soft-deleted. */
export const liveDocs = (db, batchId) => db.prepare('SELECT count(*) AS n FROM document WHERE import_batch_id = ? AND deleted_at IS NULL').get(batchId).n;
/** All documents of a batch (deleted or not). */
export const allDocs = (db, batchId) => db.prepare('SELECT count(*) AS n FROM document WHERE import_batch_id = ?').get(batchId).n;
