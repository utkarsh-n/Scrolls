// OWNER: WP3
// routes/documents.mjs — document metadata and slices of the original text (SPEC §7.1, D4).
//
//   GET /api/documents/:id               metadata, every date assertion, tags with provenance, aliases, fields
//   GET /api/documents/:id/text?from=&to= a ≤ 20,000-character slice of the decoded original (UTF-16 offsets)

import { createHash } from 'node:crypto';
import { formatDateLabel, yearLabel } from '../../src/shared/dates.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { documentOriginal } from '../text/kwic.mjs';

/** Largest slice GET /api/documents/:id/text returns. */
export const MAX_TEXT_SLICE = 20000;

function idParam(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'E_BAD_ID', `'${params.id}' is not a document id.`);
  return id;
}

/**
 * Every date assertion of a document (the time of import excluded: it is not a date of the text), chronology
 * first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} docId
 * @returns {Array<{role: string, label: string, precision: string, basis: string, asserted_by: string, is_chronology: boolean,
 *   raw: string|null, rule: string|null, approx: boolean, note: string|null}>}
 */
export function documentDates(db, docId) {
  return stmt(db, `SELECT * FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND role <> 'ingestion'
    ORDER BY is_chronology DESC, id`).all(docId).map((a) => ({
    role: a.role,
    label: a.lo_day === null ? 'undated' : formatDateLabel({ lo_day: a.lo_day, hi_day: a.hi_day, precision: a.precision,
      approx: a.approx, rule: a.rule, raw: a.raw }),
    precision: a.precision, basis: a.basis, asserted_by: a.asserted_by, is_chronology: a.is_chronology === 1,
    raw: a.raw, rule: a.rule, approx: a.approx === 1, note: a.note,
  }));
}

/**
 * The date card of a document: its chronology with the notes a reader needs (estimated, derived, announced,
 * circa, translation, undated) and any note the source adapter recorded.
 * @param {object} doc document row
 * @param {ReturnType<typeof documentDates>} dates
 * @returns {{label: string, precision: string, basis: string, role: string|null, notes: string[]}}
 */
export function dateCard(doc, dates) {
  const chrono = dates.find((d) => d.is_chronology) ?? null;
  const notes = [];
  if (doc.chrono_status === 'undated') notes.push('No usable date: outside the chronology (Undated shelf).');
  if (doc.basis === 'estimated') notes.push('Estimated date, not stated by the source.');
  if (doc.basis === 'derived') {
    if (chrono?.rule === 'vikram_samvat') notes.push(`Vikram Samvat ${doc.y_lo + 57} → ${yearLabel(doc.y_lo)}–${yearLabel(doc.y_hi)} CE (calendar conversion)`);
    else if (chrono?.rule === 'shaka_samvat') notes.push(`Saka ${doc.y_lo - 78} → ${yearLabel(doc.y_lo)}–${yearLabel(doc.y_hi)} CE (calendar conversion)`);
    else notes.push('Derived by calendar conversion.');
  }
  if (doc.basis === 'announced') notes.push('Announced date after today: shown on the Scheduled shelf, never in rates.');
  if (doc.basis === 'period') notes.push('A period, not a date.');
  if (chrono?.approx) notes.push(`Circa: '${chrono.raw ?? doc.date_label}' is read as an interval (${yearLabel(doc.y_lo)}–${yearLabel(doc.y_hi)}).`);
  if (doc.is_translation) {
    notes.push(`Translation (text reads as ${doc.lang_text}, declared ${doc.lang_declared ?? 'unknown'}): dated by the original's publication and excluded from text-language chronology by default.`);
  }
  if (chrono?.note) notes.push(chrono.note);
  return { label: doc.date_label, precision: doc.precision, basis: doc.basis, role: doc.date_role ?? chrono?.role ?? null, notes };
}

/**
 * GET /api/documents/:id payload (main connection; light).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number}} args
 * @returns {object}
 * @throws {HttpError} 404
 */
export function documentQuery(db, { id }) {
  const d = stmt(db, `SELECT d.*, c.slug AS collection_slug, c.name AS collection_name, c.license AS collection_license,
      c.export_text_allowed, c.modality FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?`).get(id);
  if (!d) throw new HttpError(404, 'E_NOT_FOUND', `No document ${id}.`);
  const dates = documentDates(db, id);
  const text = d.has_full_text ? stmt(db, 'SELECT length(original) AS chars, body_start, body_end, original_sha256 FROM document_text WHERE document_id = ?').get(id) : null;
  const original = d.has_full_text ? documentOriginal(db, id) : null;
  const out = {
    id: d.id, ext_id: d.ext_id, kind: d.kind, title: d.title, native_title: d.native_title, author: d.author,
    collection: d.collection_slug, collection_name: d.collection_name, has_full_text: d.has_full_text === 1,
    dates, date_card: dateCard(d, dates),
    tags: stmt(db, 'SELECT scheme, value, weight, provenance, method FROM doc_tag WHERE document_id = ? ORDER BY scheme, value').all(id)
      .map((t) => ({ ...t, ...(t.provenance === 'machine_tag' || t.provenance === 'adapter_machine' ? { note: 'machine tag — fallible' } : {}) })),
    aliases: stmt(db, 'SELECT ext_id, title, note FROM document_alias WHERE document_id = ? ORDER BY ext_id').all(id),
    fields: stmt(db, `SELECT field, id AS passage, field_class, time_role, quality, start_off AS start, end_off AS end FROM passage
      WHERE document_id = ? AND field <> 'body' ORDER BY field, ord`).all(id),
    lang_declared: d.lang_declared, lang_text: d.lang_text, is_translation: d.is_translation === 1, dup_of: d.dup_of,
    passages: d.passage_count, tokens: d.token_count, community: d.community, culture: d.culture, field: d.field,
    genre: d.genre, source_url: d.source_url, license: d.license ?? d.collection_license,
    export_text_allowed: d.export_text_allowed === 1,
    synthetic: d.is_synthetic === 1,
  };
  if (original !== null) {
    out.length = original.length;
    out.body = { start: text.body_start, end: text.body_end };
    out.sha256 = text.original_sha256;
  } else {
    out.text_note = d.modality === 'titles'
      ? 'Metadata only: this collection holds titles, not lyrics or scripts.'
      : 'Metadata only: this record has no full text.';
  }
  if (d.deleted_at) out.deleted_at = d.deleted_at;
  return out;
}

/**
 * GET /api/documents/:id/text payload: original.slice(from, to), at most 20,000 code units.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number, from?: number|null, to?: number|null}} args
 * @returns {{document_id: number, from: number, to: number, text: string, length: number, synthetic: boolean}}
 * @throws {HttpError} 404 (no document / no text), 400 E_RANGE
 */
export function documentTextQuery(db, { id, from = null, to = null }) {
  const d = stmt(db, 'SELECT id, has_full_text, is_synthetic FROM document WHERE id = ?').get(id);
  if (!d) throw new HttpError(404, 'E_NOT_FOUND', `No document ${id}.`);
  const original = documentOriginal(db, id);
  if (original === null) throw new HttpError(404, 'E_NOT_FOUND', `Document ${id} has no full text (metadata only).`, 'Open its title or summary passages instead.');
  const length = original.length;
  const f = from ?? 0;
  const t = to ?? Math.min(length, f + MAX_TEXT_SLICE);
  if (!(Number.isInteger(f) && Number.isInteger(t) && f >= 0 && f <= t && t <= length)) {
    throw new HttpError(400, 'E_RANGE', `from/to must lie inside the document (length ${length}).`, 'Ask for a slice inside the document.', { length });
  }
  if (t - f > MAX_TEXT_SLICE) {
    throw new HttpError(400, 'E_RANGE', `A slice is at most ${MAX_TEXT_SLICE} characters (asked for ${t - f}).`, 'Ask for a smaller slice.', { length });
  }
  return { document_id: id, from: f, to: t, text: original.slice(f, t), length, synthetic: d.is_synthetic === 1 };
}

/** sha256 of a string's UTF-8 bytes (anchor key of field passages). */
export function sha256Text(s) {
  return createHash('sha256').update(s).digest('hex');
}

const optInt = (v, field) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'E_RANGE', `${field} must be an integer.`, null, { field });
  return n;
};

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/documents/:id',
    async handler(req, ctx) {
      return { json: documentQuery(ctx.db, { id: idParam(req.params) }) };
    },
  },
  {
    method: 'GET',
    path: '/api/documents/:id/text',
    async handler(req, ctx) {
      return { json: documentTextQuery(ctx.db, { id: idParam(req.params), from: optInt(req.query.from, 'from'), to: optInt(req.query.to, 'to') }) };
    },
  },
];
