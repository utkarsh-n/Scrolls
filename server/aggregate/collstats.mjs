// OWNER: WP3 — performance round of contract 1.3.0 (used by routes/corpora.mjs, warmed by warm.mjs)
// collstats.mjs — per-collection statistics for GET /api/corpora.
//
// The corpus list used to scan every document (≈ 400k rows, 8 s cold on a STEMM-loaded database) once per data
// version, and every materialization bumps the data version. The statistics of each collection are now a shared
// artifact (cache.sharedArtifact: memory → $SCROLLS_DATA/cache/ → one scan of that collection only) keyed by what they
// read — the collection row, its import batches by status and the passage quality version — so a
// materialization, an annotation or a review keeps them, and a load rescans only the collections it touched.
// warm.mjs builds them when a load or the bootstrap settles ("precomputed at load end").

import { shortHash } from '../../src/shared/ids.mjs';
import { sharedArtifact } from './cache.mjs';

const STATS_VERSION = 1;
const TEXT_CLASSES = "('text','abstract')";
const metaValue = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

/**
 * Fingerprint of what a collection's statistics read (cheap: the import_batch table, no document rows).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} c collection row
 * @returns {string}
 */
export function collectionStatsKey(db, c) {
  // documents change only through import batches (written, reverted, rolled back): their statuses date the statistics
  const batches = db.prepare(`SELECT status, count(*) AS n, max(id) AS m FROM import_batch WHERE collection_id = ? GROUP BY status
    ORDER BY status`).all(c.id);
  return shortHash(JSON.stringify([STATS_VERSION, c, batches, metaValue(db, 'quality_version') ?? '0']), 16);
}

/**
 * Statistics of one collection: document counts by chronology and date basis, the earliest and latest dated labels,
 * full-text tokens. One pass over the collection's own id range (a rowid range scan), not the whole table.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} c collection row
 * @returns {object}
 */
export function buildCollectionStats(db, c) {
  const ids = db.prepare('SELECT min(id) AS lo, max(id) AS hi FROM document WHERE collection_id = ?').get(c.id);
  const s = { docs: 0, undated: 0, scheduled: 0, b_stated: 0, b_estimated: 0, b_derived: 0, b_period: 0, after_1928: 0,
    lo_day: null, lo_label: null, hi_day: null, hi_label: null, tokens: 0 };
  if (ids.lo === null) return s;
  // `+collection_id` keeps SQLite on the rowid range instead of the (collection_id, …) index
  for (const r of db.prepare(`SELECT chrono_status AS cs, basis, y_lo, lo_day, hi_day, date_label FROM document
    WHERE id BETWEEN ? AND ? AND +collection_id = ? AND deleted_at IS NULL`).iterate(ids.lo, ids.hi, c.id)) {
    s.docs++;
    if (r.cs === 'undated') { s.undated++; continue; }
    if (r.cs === 'scheduled') { s.scheduled++; continue; }
    if (r.basis === 'stated') s.b_stated++;
    else if (r.basis === 'estimated') s.b_estimated++;
    else if (r.basis === 'derived') s.b_derived++;
    else if (r.basis === 'period') s.b_period++;
    if (r.y_lo > 1928) s.after_1928++;
    if (s.lo_day === null || r.lo_day < s.lo_day) { s.lo_day = r.lo_day; s.lo_label = r.date_label; }
    if (s.hi_day === null || r.hi_day > s.hi_day) { s.hi_day = r.hi_day; s.hi_label = r.date_label; }
  }
  s.tokens = db.prepare(`SELECT IFNULL(SUM(t.tokens), 0) AS n FROM doc_tokens t WHERE t.document_id BETWEEN ? AND ?
    AND t.field_class IN ${TEXT_CLASSES} AND t.document_id IN (SELECT id FROM document WHERE id BETWEEN ? AND ? AND +collection_id = ?
      AND deleted_at IS NULL)`).get(ids.lo, ids.hi, ids.lo, ids.hi, c.id).n;
  return s;
}

/** The sharedArtifact spec of a collection's statistics (warm.mjs ensures it). */
export const statsSpec = (c) => ({
  name: `cstats${STATS_VERSION}-k${c.id}`, key: (d) => collectionStatsKey(d, c), build: (d) => buildCollectionStats(d, c),
  encode: (v) => Buffer.from(JSON.stringify(v)), decode: (bytes) => JSON.parse(bytes.toString('utf8')),
});

/**
 * A collection's statistics (shared artifact; rebuilt only when its inputs change).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} c collection row
 * @param {{waitMs?: number}} [opts] how long to wait for another worker that is building the same statistics
 * @returns {object}
 */
export function collectionStats(db, c, { waitMs = 3000 } = {}) {
  return sharedArtifact(db, { ...statsSpec(c), waitMs });
}

