// OWNER: WP0 — precision-aware bin membership (doc_bin) and denominators (doc_tokens) (SPEC §3, D2, D6)
//
// A document has a doc_bin row at level L (0 millennium, 1 century, 2 decade, 3 year) iff its year interval
// fits ONE bin of that level (fit-or-wash). Only `chrono_status = 'dated'` documents get rows: undated and
// scheduled items never enter rates (honesty rule 4). doc_tokens counts quality='ok' passages only.

import { binOf, fits, LEVELS } from '../../src/shared/dates.mjs';
import { stmt } from '../db/open.mjs';

const YEAR_LEVELS = LEVELS.filter((l) => l.width).map((l) => l.level); // [0, 1, 2, 3]

/**
 * Levels at which [yLo, yHi] fits one bin, with that bin.
 * @param {number|null} yLo astronomical year
 * @param {number|null} yHi astronomical year
 * @returns {Array<{level: 0|1|2|3, bin: number}>}
 */
export function binsFor(yLo, yHi) {
  if (!Number.isInteger(yLo) || !Number.isInteger(yHi) || yLo > yHi) return [];
  return YEAR_LEVELS.filter((level) => fits(yLo, yHi, level)).map((level) => ({ level, bin: binOf(yLo, level) }));
}

/**
 * Replace a document's doc_bin rows. Pass nulls (undated) or call for a scheduled document with nulls to
 * clear them.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} documentId
 * @param {number|null} yLo
 * @param {number|null} yHi
 */
export function writeDocBins(db, documentId, yLo, yHi) {
  stmt(db, 'DELETE FROM doc_bin WHERE document_id = ?').run(documentId);
  const ins = stmt(db, 'INSERT INTO doc_bin (level, bin, document_id) VALUES (?, ?, ?)');
  for (const { level, bin } of binsFor(yLo, yHi)) ins.run(level, bin, documentId);
}

/**
 * Recompute doc_tokens (quality='ok' tokens and passages per passage language × field class) for documents,
 * e.g. after the boilerplate pass changes passage quality.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Iterable<number>} documentIds
 */
export function rewriteDocTokens(db, documentIds) {
  const del = stmt(db, 'DELETE FROM doc_tokens WHERE document_id = ?');
  const ins = stmt(db, `INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages)
    SELECT document_id, lang, field_class, SUM(token_count), COUNT(*) FROM passage
    WHERE document_id = ? AND quality = 'ok' GROUP BY lang, field_class`);
  for (const id of documentIds) {
    del.run(id);
    ins.run(id);
  }
}
