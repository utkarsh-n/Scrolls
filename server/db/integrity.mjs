// OWNER: WP0 — boot-time integrity check: are the preserved originals (§4.2) still on disk?
//
// Every imported file and source file is kept verbatim under originals/<sha[0:2]>/<sha256> and registered in
// original_file. A data directory restored without that folder (or with a broken symlink) still opens, because
// passages are read from document_text, but the verbatim bytes that documents were made from are gone. The check
// runs once per boot in a read worker; its result is logged and reported in /api/health as `integrity`.

import { statSync } from 'node:fs';
import path from 'node:path';
import { log } from '../config.mjs';
import { nowIso } from './open.mjs';

const SAMPLE = 5;
const QUERY_URL = import.meta.url;

/**
 * Read-pool query: stat every registered original; for missing or truncated ones, count the live documents
 * that were made from them (adapter records via document.source_file_sha256, file imports via their batch).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{dataDir: string}} args
 * @returns {{status: 'ok'|'missing_originals', checked_at: string, files: number, missing_files: number,
 *   size_mismatch: number, referenced_missing: number, documents_affected: number,
 *   sample: Array<{sha256: string, rel_path: string, problem: 'missing'|'size', documents: number}>}}
 */
export function originalsIntegrityQuery(db, { dataDir }) {
  const rows = db.prepare('SELECT sha256, rel_path, byte_size FROM original_file').all();
  const bad = new Map();
  for (const r of rows) {
    let size = null;
    try { size = statSync(path.join(dataDir, r.rel_path)).size; } catch { /* missing */ }
    if (size === null) bad.set(r.sha256, { sha256: r.sha256, rel_path: r.rel_path, problem: 'missing', documents: 0 });
    else if (Number.isInteger(r.byte_size) && size !== r.byte_size) bad.set(r.sha256, { sha256: r.sha256, rel_path: r.rel_path, problem: 'size', documents: 0 });
  }
  if (bad.size) {
    // Only when something is wrong: a full scan of document (no index on source_file_sha256; seconds at STEMM scale).
    const add = (sha, n) => { const b = bad.get(sha); if (b) b.documents += n; };
    for (const r of db.prepare(`SELECT source_file_sha256 AS sha, count(*) AS n FROM document
      WHERE source_file_sha256 IS NOT NULL AND deleted_at IS NULL GROUP BY source_file_sha256`).iterate()) add(r.sha, r.n);
    for (const r of db.prepare(`SELECT b.file_sha256 AS sha, count(*) AS n FROM import_batch b JOIN document d ON d.import_batch_id = b.id
      WHERE b.file_sha256 IS NOT NULL AND d.deleted_at IS NULL AND (d.source_file_sha256 IS NULL OR d.source_file_sha256 != b.file_sha256)
      GROUP BY b.file_sha256`).iterate()) add(r.sha, r.n);
  }
  const list = [...bad.values()];
  const referenced = list.filter((b) => b.documents > 0);
  return {
    status: referenced.length ? 'missing_originals' : 'ok',
    checked_at: nowIso(),
    files: rows.length,
    missing_files: list.filter((b) => b.problem === 'missing').length,
    size_mismatch: list.filter((b) => b.problem === 'size').length,
    referenced_missing: referenced.length,
    documents_affected: referenced.reduce((s, b) => s + b.documents, 0),
    sample: referenced.sort((a, b) => b.documents - a.documents).slice(0, SAMPLE),
  };
}

/**
 * Run the check in the read pool and log a warning when documents point at originals that are gone.
 * Never throws: a failed check reports `status: 'unknown'` with the reason.
 * @param {{run: Function}} pool ReadPool
 * @param {{dataDir: string, timeoutMs?: number}} opts
 * @returns {Promise<object>} the integrity object of /api/health
 */
export async function checkOriginals(pool, { dataDir, timeoutMs = 120000 }) {
  try {
    const r = await pool.run(QUERY_URL, 'originalsIntegrityQuery', { dataDir }, { timeoutMs });
    if (r.status !== 'ok') {
      log('warn', `integrity: ${r.referenced_missing} original file(s) that ${r.documents_affected} document(s) were made from are `
        + 'missing or truncated under originals/. Their text still opens from the database, but the verbatim source bytes '
        + '(SPEC §4.2) cannot be re-read; restore originals/ from a backup of this data directory.', { sample: r.sample });
    } else if (r.missing_files || r.size_mismatch) {
      log('info', `integrity: ${r.missing_files + r.size_mismatch} stored original(s) are missing or truncated; no document refers to them`);
    }
    return r;
  } catch (err) {
    log('warn', 'integrity: the originals check did not finish', { error: String(err?.message ?? err) });
    return { status: 'unknown', checked_at: nowIso(), reason: String(err?.message ?? err) };
  }
}
