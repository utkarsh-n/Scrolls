// OWNER: WP3
// exprdoc.mjs — expr_doc rows: exact counts per expression × document × passage language × field class (SPEC
// D6, §3). THE aggregation base of every tile: n excludes proper-noun-guard hits (n_names holds them) and
// counts only quality='ok' passages, so it divides cleanly by doc_tokens (which counts the same passages).

import { stmt } from '../db/open.mjs';

/**
 * Accumulates matches into expr_doc rows, one per (document, passage language, field class).
 */
export class ExprDocAccumulator {
  constructor() {
    /** @type {Map<string, {document_id: number, plang: string, field_class: string, n: number, n_names: number, passages: Set<number>, first_off: number|null}>} */
    this.rows = new Map();
  }

  /**
   * Add a match of a quality='ok' passage (or `count` matches at once: the very-frequent path counts from the index).
   * @param {{document_id: number, lang: string, field_class: string, id: number}} passage
   * @param {{start: number, nameFlag: boolean}} match start = absolute offset (of the first match)
   * @param {number} [count=1]
   */
  add(passage, match, count = 1) {
    const key = `${passage.document_id}\u0000${passage.lang}\u0000${passage.field_class}`;
    let r = this.rows.get(key);
    if (!r) {
      r = { document_id: passage.document_id, plang: passage.lang, field_class: passage.field_class, n: 0, n_names: 0,
        passages: new Set(), first_off: null };
      this.rows.set(key, r);
    }
    // n_passages counts passages with a counted match (name-guard hits alone do not make a passage a hit)
    if (match.nameFlag) r.n_names += count; else { r.n += count; r.passages.add(passage.id); }
    if (r.first_off === null || match.start < r.first_off) r.first_off = match.start;
  }

  /** Rows accumulated so far (and forget them). @returns {object[]} */
  drain() {
    const out = [...this.rows.values()].map((r) => ({ ...r, n_passages: r.passages.size, passages: undefined }));
    this.rows.clear();
    return out;
  }
}

/**
 * Insert expr_doc rows of one materialize run (inside the caller's transaction). Rows for the same key are
 * summed, so a document split across write batches stays exact.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @param {number} expressionId
 * @param {Array<{document_id: number, plang: string, field_class: string, n: number, n_names: number, n_passages: number,
 *   first_off: number|null}>} rows
 * @returns {number} rows written
 */
export function writeExprDoc(db, runId, expressionId, rows) {
  const ins = stmt(db, `INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_names, n_passages,
      first_off, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (expression_id, run_id, document_id, plang, field_class) DO UPDATE SET n = n + excluded.n,
      n_names = n_names + excluded.n_names, n_passages = n_passages + excluded.n_passages,
      first_off = MIN(IFNULL(first_off, excluded.first_off), IFNULL(excluded.first_off, first_off))`);
  for (const r of rows) {
    ins.run(expressionId, r.document_id, r.plang, r.field_class, r.n, r.n_names, r.n_passages, r.first_off, runId);
  }
  return rows.length;
}
