// OWNER: WP3
// routes/passages.mjs — a passage with offsets into the original, highlights, its document and date card
// (SPEC §7.2, I2: every occurrence opens its passage).
//
//   GET /api/passages/:id?context=1&expr=12,13&occ=55012
//
// `start`/`end` index the document text (body) or the field value; `highlights` are relative to `text`.
// Highlights are the occurrences of each tracked expression's current run (plus `occ`, which may belong to a
// pinned older run); `expr` restricts them to some expressions.

import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { passageBase } from '../text/kwic.mjs';
import { dateCard, documentDates, sha256Text } from './documents.mjs';

function idList(v, field) {
  if (v === undefined || v === '') return null;
  const ids = String(v).split(',').map((x) => Number(x.trim()));
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) throw new HttpError(400, 'E_VALIDATION', `${field} must be a list of ids.`, null, { field });
  return ids;
}

/** Machine annotations of a passage (cluster memberships of its occurrences, succeeded runs only); [] when none. */
function machineOf(db, passageId) {
  try {
    return stmt(db, `SELECT DISTINCT 'cluster' AS kind, sc.id AS cluster, sc.label_auto AS label, cm.margin, sc.run_id AS run
      FROM occurrence o JOIN cluster_member cm ON cm.occurrence_id = o.id JOIN sense_cluster sc ON sc.id = cm.cluster_id
      JOIN analysis_run r ON r.id = sc.run_id AND r.status = 'succeeded' WHERE o.passage_id = ? ORDER BY sc.id`).all(passageId);
  } catch {
    return [];
  }
}

/**
 * GET /api/passages/:id payload (main connection; light).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number, context?: boolean, expr?: number[]|null, occ?: number|null}} args
 * @returns {object}
 * @throws {HttpError} 404
 */
export function passageQuery(db, { id, context = false, expr = null, occ = null }) {
  const p = stmt(db, 'SELECT * FROM passage WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'E_NOT_FOUND', `No passage ${id}.`);
  const d = stmt(db, `SELECT d.*, c.slug AS collection_slug, c.license AS collection_license FROM document d
    JOIN collection c ON c.id = d.collection_id WHERE d.id = ?`).get(p.document_id);
  const base = passageBase(db, p) ?? '';
  const text = base.slice(p.start_off, p.end_off);

  const exprFilter = expr ? 'AND o.expression_id IN (SELECT value FROM json_each(?))' : '';
  const highlights = stmt(db, `SELECT o.id AS occ, o.expression_id AS expr, o.start_off, o.end_off, o.name_flag, v.form AS variant
    FROM occurrence o JOIN analysis_run r ON r.id = o.run_id AND r.status = 'succeeded'
    LEFT JOIN expression_variant v ON v.id = o.variant_id
    WHERE o.passage_id = ? AND (o.run_id IN (SELECT run_id FROM expression_state WHERE expression_id = o.expression_id) OR o.id = ?)
    ${exprFilter} ORDER BY o.start_off, o.id`).all(id, occ ?? -1, ...(expr ? [JSON.stringify(expr)] : []))
    .map((h) => ({ start: h.start_off - p.start_off, end: h.end_off - p.start_off, expr: h.expr, occ: h.occ, variant: h.variant,
      ...(h.name_flag ? { name_flag: true, note: 'excluded as a name (proper-noun guard)' } : {}) }));

  const neighbour = (ord) => {
    const n = stmt(db, 'SELECT * FROM passage WHERE document_id = ? AND field = ? AND ord = ?').get(p.document_id, p.field, ord);
    return n ? { passage: n.id, text: base.slice(n.start_off, n.end_off), quality: n.quality } : null;
  };
  const dates = documentDates(db, d.id);
  const referenced = dates.find((x) => x.role === 'referenced');
  const sha = p.field === 'body'
    ? stmt(db, 'SELECT original_sha256 FROM document_text WHERE document_id = ?').get(d.id)?.original_sha256 ?? sha256Text(base)
    : sha256Text(base);
  const relCount = (side) => stmt(db, `SELECT count(*) AS n FROM relationship WHERE ${side}_type = 'passage' AND ${side}_ref = ?`).get(String(id)).n;
  const docRelCount = (side) => stmt(db, `SELECT count(*) AS n FROM relationship WHERE ${side}_type = 'document' AND ${side}_ref = ?`).get(String(d.id)).n;
  const out = {
    id: p.id, field: p.field, start: p.start_off, end: p.end_off, text,
    before: context ? neighbour(p.ord - 1) : null,
    after: context ? neighbour(p.ord + 1) : null,
    highlights,
    lang: p.lang, quality: p.quality, time_role: p.time_role, field_class: p.field_class, page_no: p.page_no,
    document: {
      id: d.id, title: d.title, author: d.author, kind: d.kind, dates, date_card: dateCard(d, dates),
      collection: d.collection_slug, license: d.license ?? d.collection_license, is_translation: d.is_translation === 1,
      synthetic: d.is_synthetic === 1,
    },
    anchor: { doc_id: d.id, sha256: sha, field: p.field, start: p.start_off, end: p.end_off },
    machine: machineOf(db, id),
    relationships: { out: relCount('src'), in: relCount('dst'), document_out: docRelCount('src'), document_in: docRelCount('dst') },
    annotations: stmt(db, "SELECT count(*) AS n FROM annotation WHERE target_type = 'passage' AND target_ref = ? AND status = 'active'").get(String(id)).n,
    synthetic: p.is_synthetic === 1,
  };
  if (referenced) out.refers_to = { label: referenced.label, precision: referenced.precision };
  if (p.quality !== 'ok') out.quality_note = `This passage is marked '${p.quality}' and is excluded from counts.`;
  if (p.time_role === 'describes') out.time_note = 'A retrospective description: written later, about the item; excluded from frequency by default.';
  if (p.time_role === 'apparatus') out.time_note = 'Editorial apparatus (heuristic): excluded from frequency by default.';
  return out;
}

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/passages/:id',
    async handler(req, ctx) {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'E_BAD_ID', `'${req.params.id}' is not a passage id.`);
      const occ = idList(req.query.occ, 'occ');
      return { json: passageQuery(ctx.db, { id, context: req.query.context === '1' || req.query.context === 'true',
        expr: idList(req.query.expr, 'expr'), occ: occ ? occ[0] : null }) };
    },
  },
  {
    // M1 gate (WP7 need): resolve an occurrence id to its passage, so a reloaded URL with sel=occ:N opens it.
    method: 'GET',
    path: '/api/occurrences/:id',
    async handler(req, ctx) {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'E_BAD_ID', `'${req.params.id}' is not an occurrence id.`);
      const o = stmt(ctx.db, `SELECT o.id, o.passage_id, o.document_id, o.expression_id, o.start_off, o.end_off, o.name_flag,
          o.run_id, d.is_synthetic FROM occurrence o JOIN document d ON d.id = o.document_id WHERE o.id = ?`).get(id);
      if (!o) throw new HttpError(404, 'E_NOT_FOUND', `No occurrence ${id}.`, 'Occurrences belong to a materialize run; search the expression again.');
      return { json: { id: o.id, passage: o.passage_id, doc: o.document_id, expr: o.expression_id, start: o.start_off, end: o.end_off,
        name_flag: o.name_flag === 1, run_id: o.run_id, synthetic: o.is_synthetic === 1 } };
    },
  },
];
