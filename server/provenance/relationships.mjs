// OWNER: WP5
// relationships.mjs — edge cards, human-proposed edges and attached evidence (SPEC §2.C, §7.1, D7).
//
// What a person creates here is ALWAYS evidence_status 'proposed', origin 'human' (the §3 CHECKs enforce it a
// second time); evidence_status and the endpoints are never updated (rel_evidence_immutable trigger). Every
// change appends a relationship_revision; nothing is deleted. Evidence spans carry D18 anchors.

import { canonicalJson, parseRef } from '../../src/shared/ids.mjs';
import { EVIDENCE_ROLES, REL_TYPE_BY_CODE, SCORE_KIND_LABELS } from '../../src/shared/vocab.mjs';
import { nowIso, stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { checkAnchor } from './anchors.mjs';

/** The fixed sentence every edge card carries (§2.C). */
export const CAUTION = 'Shared wording or similar contexts can come from a common source; they do not establish influence or intent.';

/** Evidence status in words (§2.C edge card). */
export const STATUS_WORDS = Object.freeze({
  documented: 'documented — an external record states this link',
  documented_unrecorded: 'documented upstream; source not recorded by Cipher (DOC*)',
  computed: 'computed — an algorithmic estimate, not a record',
  proposed: 'proposed — a hypothesis, not evidence',
});

/** Roles a person may attach (a citation cue is found by the cue detector, not asserted by hand). */
export const HUMAN_EVIDENCE_ROLES = Object.freeze(['supporting', 'contradicting', 'source_span', 'target_span', 'external_record']);

const MIN_NOTE = 10;
const MAX_NOTE = 4000;

const invalid = (message, field, hint = null, extra = {}) => new HttpError(400, 'E_VALIDATION', message, hint, { field, ...extra });
const parseJson = (s, dflt = null) => {
  if (s === null || s === undefined) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
};

// ── actors ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A person's display name from a request (`author`), default 'you'. A leading 'human:' is dropped.
 * @param {unknown} raw
 * @returns {string}
 */
export function authorName(raw) {
  if (raw === undefined || raw === null || raw === '') return 'you';
  if (typeof raw !== 'string') throw invalid('author must be a string.', 'author');
  const name = raw.replace(/^human:/, '').trim();
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw invalid('author must be 1–80 printable characters.', 'author');
  // machine output is told apart by its author (§13 rule 10, fix pass): a person cannot sign as a run, adapter or tagger
  if (MACHINE_AUTHOR.test(name)) {
    throw invalid(`Author names that start with '${name.split(':')[0]}:' are reserved for machine output.`, 'author');
  }
  return name;
}

/** Author prefixes that mark machine output (runs, adapters, taggers, models, jobs). */
export const MACHINE_AUTHOR = /^\s*(machine|run|adapter|algorithm|model|job|system|tagger|analysis)\s*:/i;

/** 'human:<name>' for created_by / actor columns. */
export const humanActor = (name) => `human:${name}`;

/** A review/proposal note: ≥ 10 characters after trimming (§2.C). */
export function checkNote(note, { field = 'note', required = true } = {}) {
  if (note === undefined || note === null || note === '') {
    if (!required) return null;
    throw invalid(`A note of at least ${MIN_NOTE} characters is required.`, field, 'Say what you checked.', { min: MIN_NOTE });
  }
  if (typeof note !== 'string') throw invalid(`${field} must be a string.`, field);
  const t = note.trim();
  if (t.length < MIN_NOTE) throw invalid(`A note needs at least ${MIN_NOTE} characters.`, field, 'Say what you checked.', { min: MIN_NOTE });
  if (t.length > MAX_NOTE) throw invalid(`A note may have at most ${MAX_NOTE} characters.`, field);
  return t;
}

// ── references ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an entity reference to what links and annotations need: existence, document, dates, synthetic flag.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} type passage | document | occurrence | expression | cluster | etymon | relationship |
 *   hypothesis_group | saved_view | time_window | annotation
 * @param {string|number} id
 * @returns {{type: string, ref: string, docId: number|null, passage: object|null, synthetic: number, yLo: number|null,
 *   yHi: number|null, title: string|null, dateLabel: string|null}|null}
 */
export function resolveRef(db, type, id) {
  const base = { type, ref: String(id), docId: null, passage: null, synthetic: 0, yLo: null, yHi: null, title: null, dateLabel: null };
  const num = Number(id);
  const intId = Number.isSafeInteger(num) && num > 0 && String(num) === String(id).trim() ? num : null;
  const docInfo = (d) => ({ docId: d.document_id ?? d.id, synthetic: d.is_synthetic, yLo: d.y_lo, yHi: d.y_hi, title: d.title, dateLabel: d.date_label });
  switch (type) {
    case 'passage': {
      if (intId === null) return null;
      const p = stmt(db, `SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.is_synthetic, d.y_lo, d.y_hi,
        d.title, d.date_label FROM passage p JOIN document d ON d.id = p.document_id WHERE p.id = ? AND d.deleted_at IS NULL`).get(intId);
      return p ? { ...base, ...docInfo(p), passage: p } : null;
    }
    case 'document': {
      if (intId === null) return null;
      const d = stmt(db, 'SELECT id, is_synthetic, y_lo, y_hi, title, date_label FROM document WHERE id = ? AND deleted_at IS NULL').get(intId);
      return d ? { ...base, ...docInfo(d) } : null;
    }
    case 'occurrence': {
      if (intId === null) return null;
      const o = stmt(db, `SELECT o.id, o.document_id, o.passage_id, p.is_synthetic, d.y_lo, d.y_hi, d.title, d.date_label
        FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id WHERE o.id = ?`).get(intId);
      if (!o) return null;
      const p = stmt(db, 'SELECT id, document_id, field, start_off, end_off FROM passage WHERE id = ?').get(o.passage_id);
      return { ...base, ...docInfo(o), passage: p };
    }
    case 'expression': {
      if (intId === null) return null;
      const e = stmt(db, 'SELECT id, is_synthetic, surface FROM expression WHERE id = ?').get(intId);
      return e ? { ...base, synthetic: e.is_synthetic, title: e.surface } : null;
    }
    case 'cluster': {
      if (intId === null) return null;
      const c = stmt(db, `SELECT c.id, c.label_auto, e.is_synthetic FROM sense_cluster c JOIN expression e ON e.id = c.expression_id
        WHERE c.id = ?`).get(intId);
      return c ? { ...base, synthetic: c.is_synthetic, title: c.label_auto } : null;
    }
    case 'etymon': {
      const e = stmt(db, 'SELECT key, form FROM etymon WHERE key = ?').get(String(id));
      return e ? { ...base, title: e.form } : null;
    }
    case 'relationship': {
      if (intId === null) return null;
      const r = stmt(db, 'SELECT id, is_synthetic FROM relationship WHERE id = ?').get(intId);
      return r ? { ...base, synthetic: r.is_synthetic } : null;
    }
    case 'hypothesis_group': {
      if (intId === null) return null;
      const g = stmt(db, 'SELECT id, is_synthetic, question FROM hypothesis_group WHERE id = ?').get(intId);
      return g ? { ...base, synthetic: g.is_synthetic, title: g.question } : null;
    }
    case 'saved_view': {
      const v = stmt(db, `SELECT v.slug, v.name, k.is_synthetic FROM saved_view v
        LEFT JOIN corpus k ON k.slug = json_extract(v.state_json, '$.corpus') WHERE v.slug = ? AND v.deleted_at IS NULL`).get(String(id));
      return v ? { ...base, synthetic: v.is_synthetic ?? 0, title: v.name } : null;
    }
    case 'time_window': {
      if (intId === null) return null;
      const w = stmt(db, 'SELECT id, label FROM time_window WHERE id = ?').get(intId);
      return w ? { ...base, title: w.label } : null;
    }
    case 'annotation': {
      if (intId === null) return null;
      const a = stmt(db, 'SELECT id, is_synthetic FROM annotation WHERE id = ?').get(intId);
      return a ? { ...base, synthetic: a.is_synthetic } : null;
    }
    default:
      return null;
  }
}

/**
 * Parse 'passage:901' (or 'etymon:sa:शून्य') and resolve it.
 * @returns {ReturnType<typeof resolveRef>}
 */
export function resolveRefString(db, s) {
  let r;
  try { r = parseRef(s); } catch { return null; }
  return resolveRef(db, r.type, r.id);
}

// ── evidence spans ──────────────────────────────────────────────────────────────────────────────────

/**
 * Validate one evidence span from a request and anchor it.
 * Spans index the document text (D4); `relative: true` means start/end index the passage text instead.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} ev {passage, start, end, role, quote?, relative?} or {role: 'external_record', locator, quote?}
 * @param {{roles?: readonly string[], field?: string}} [opts]
 * @returns {{passageId: number|null, start: number|null, end: number|null, role: string, anchor: object|null,
 *   detail: object|null, synthetic: number}}
 */
export function checkEvidenceSpan(db, ev, { roles = HUMAN_EVIDENCE_ROLES, field = 'evidence' } = {}) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw invalid('Each evidence item must be an object.', field);
  const role = ev.role ?? 'supporting';
  if (!EVIDENCE_ROLES.includes(role)) {
    throw invalid(`Evidence role '${role}' is not one of ${EVIDENCE_ROLES.join(', ')}.`, 'role');
  }
  if (!roles.includes(role)) throw invalid(`Evidence role '${role}' cannot be attached by hand.`, 'role',
    'Attribution cues are found by the cue detector; attach the span as supporting.');
  if (role === 'external_record') {
    const locator = typeof ev.locator === 'string' ? ev.locator.trim() : '';
    if (!locator) throw invalid('An external record needs a locator (a URL or catalogue reference).', 'locator');
    return { passageId: null, start: null, end: null, role, anchor: null,
      detail: { locator, ...(typeof ev.quote === 'string' && ev.quote ? { quote: ev.quote } : {}) }, synthetic: 0 };
  }
  const pid = Number(ev.passage);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw invalid('Each evidence span needs a passage id.', 'passage');
  const target = resolveRef(db, 'passage', pid);
  if (!target) throw new HttpError(404, 'E_NOT_FOUND', `No passage ${pid}.`, null, { field: 'passage' });
  const p = target.passage;
  if (!Number.isInteger(ev.start) || !Number.isInteger(ev.end)) throw invalid('Each evidence span needs integer start and end.', 'start');
  const shift = ev.relative === true ? p.start_off : 0;
  const start = ev.start + shift, end = ev.end + shift;
  if (start < p.start_off || end > p.end_off || start >= end) {
    throw invalid(`Span ${start}–${end} is not inside passage ${pid} (${p.start_off}–${p.end_off}).`, 'start',
      'Offsets index the document text (D4); send relative: true for offsets into the passage text.');
  }
  const input = { doc_id: p.document_id, field: p.field, start, end, quote: null };
  const text = stmt(db, p.field === 'body' ? 'SELECT original AS t FROM document_text WHERE document_id = ?'
    : 'SELECT value AS t FROM document_field WHERE document_id = ? AND field = ?').get(...(p.field === 'body' ? [p.document_id] : [p.document_id, p.field]));
  input.quote = text ? text.t.slice(start, end) : null;
  if (typeof ev.quote === 'string' && ev.quote && ev.quote !== input.quote) {
    throw invalid('The quoted words do not match the text at these offsets.', 'quote',
      'Offsets are UTF-16 code units into the document text (D4).');
  }
  const { anchor } = checkAnchor(db, input, { docId: p.document_id, passage: p });
  return { passageId: pid, start: anchor.start, end: anchor.end, role, anchor, detail: null, synthetic: target.synthetic };
}

function insertEvidence(db, relId, span, actor, at) {
  return Number(stmt(db, `INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off, anchor_json,
      detail_json, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(relId, span.passageId, span.role, span.start, span.end, span.anchor ? JSON.stringify(span.anchor) : null,
      span.detail ? JSON.stringify(span.detail) : null, actor, at).lastInsertRowid);
}

/**
 * Append a relationship_revision and move current_rev (review_status optionally).
 * @returns {number} the new rev
 */
export function appendRelRevision(db, rel, { actor, action, before = null, after, reason = null, annotationId = null, reviewStatus = null, at = nowIso() }) {
  const rev = rel.current_rev + 1;
  stmt(db, `INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, before_json, after_json, reason, annotation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rel.id, rev, actor, at, action, before === null ? null : canonicalJson(before),
    canonicalJson(after), reason, annotationId);
  if (reviewStatus) stmt(db, 'UPDATE relationship SET current_rev = ?, review_status = ? WHERE id = ?').run(rev, reviewStatus, rel.id);
  else stmt(db, 'UPDATE relationship SET current_rev = ? WHERE id = ?').run(rev, rel.id);
  return rev;
}

/**
 * The relationship row or a 404. Rows of an analysis run that has not succeeded (running, failed, cancelled) do
 * not exist for readers or reviewers (§3 visibility rule); rows of a superseded run stay reachable (saved views pin them).
 */
export function relationshipRow(db, id) {
  const n = Number(id);
  const r = Number.isSafeInteger(n) && n > 0 ? stmt(db, `SELECT r.* FROM relationship r WHERE r.id = ? AND (r.run_id IS NULL
    OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id AND a.status IN ('succeeded', 'superseded')))`).get(n) : null;
  if (!r) throw new HttpError(404, 'E_NOT_FOUND', `No relationship ${id}.`);
  return r;
}

// ── POST /api/relationships ─────────────────────────────────────────────────────────────────────────

/**
 * Create a human-proposed relationship. The server forces evidence_status 'proposed' and origin 'human'
 * whatever the request says; a person never creates documented or computed links (D7).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{src: string, dst: string, rel_type: string, evidence: object[], note: string, group?: number|null, author?: string}} body
 * @returns {{id: number, evidence_status: 'proposed', origin: 'human', hypothesis_group: number|null, date_conflict: boolean, note?: string}}
 */
export function proposeRelationship(db, body) {
  if (!body || typeof body !== 'object') throw invalid('Send a JSON object.', null);
  const author = authorName(body.author);
  const actor = humanActor(author);
  const type = REL_TYPE_BY_CODE[body.rel_type];
  if (!type) throw invalid(`Unknown relationship type '${body.rel_type}'.`, 'rel_type');
  if (typeof body.src !== 'string' || typeof body.dst !== 'string') throw invalid('src and dst are references like passage:901.', 'src');
  const src = resolveRefString(db, body.src), dst = resolveRefString(db, body.dst);
  for (const [end, r, raw] of [['src', src, body.src], ['dst', dst, body.dst]]) {
    if (!r) throw new HttpError(404, 'E_NOT_FOUND', `No ${raw}.`, 'Link existing passages, documents, occurrences, expressions, clusters or etymons.', { field: end });
    if (!['document', 'passage', 'occurrence', 'expression', 'etymon', 'cluster'].includes(r.type)) {
      throw invalid(`A relationship cannot point at a ${r.type}.`, end);
    }
  }
  if (src.type === dst.type && src.ref === dst.ref) throw invalid('A relationship needs two different items.', 'dst');
  const note = checkNote(body.note);
  if (!Array.isArray(body.evidence) || body.evidence.length === 0) {
    throw invalid('A proposed link needs at least one evidence span.', 'evidence', 'Select the words that support it, then propose again.');
  }
  if (body.evidence.length > 50) throw invalid('At most 50 evidence spans per request.', 'evidence');

  return tx(db, () => {
    const spans = body.evidence.map((ev) => checkEvidenceSpan(db, ev));
    let groupId = null;
    if (body.group !== undefined && body.group !== null) {
      const g = stmt(db, 'SELECT * FROM hypothesis_group WHERE id = ?').get(Number(body.group));
      if (!g) throw new HttpError(404, 'E_NOT_FOUND', `No hypothesis group ${body.group}.`, null, { field: 'group' });
      if (g.target_type !== src.type || g.target_ref !== src.ref) {
        throw invalid(`A hypothesis in group ${g.id} must start at ${g.target_type}:${g.target_ref} (the item whose source is asked about).`,
          'src', 'Use the group target as src and the proposed source as dst.');
      }
      groupId = g.id;
    }
    // a date conflict only when the dates make the stated order impossible (later item certainly earlier)
    const conflict = type.requires_precedence && src.yHi !== null && dst.yLo !== null && src.yHi < dst.yLo ? 1 : 0;
    const synthetic = src.synthetic || dst.synthetic || spans.some((s) => s.synthetic) ? 1 : 0;
    const at = nowIso();
    const id = Number(stmt(db, `INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status,
        origin, source_dataset, source_locator, provenance_quality, method, run_id, created_by, review_status, score, score_kind,
        date_conflict, src_year, dst_year, hypothesis_group_id, license, attribution, provenance_note, is_synthetic, current_rev,
        created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'proposed', 'human', NULL, NULL, 'complete', NULL, NULL, ?, 'unreviewed', NULL, NULL, ?, ?, ?, ?,
        NULL, NULL, ?, ?, 1, ?)`)
      .run(type.code, src.type, src.ref, dst.type, dst.ref, type.directed, actor, conflict, src.yLo, dst.yLo, groupId, note,
        synthetic, at).lastInsertRowid);
    const evIds = spans.map((s) => insertEvidence(db, id, s, actor, at));
    stmt(db, `INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, before_json, after_json, reason)
      VALUES (?, 1, ?, ?, 'create', NULL, ?, ?)`).run(id, actor, at, canonicalJson({
      rel_type: type.code, src: `${src.type}:${src.ref}`, dst: `${dst.type}:${dst.ref}`, evidence_status: 'proposed', origin: 'human',
      evidence: evIds, hypothesis_group: groupId }), note);
    const out = { id, evidence_status: 'proposed', origin: 'human', hypothesis_group: groupId, date_conflict: conflict === 1 };
    if ((body.evidence_status && body.evidence_status !== 'proposed') || (body.origin && body.origin !== 'human')) {
      out.note = 'A link created by a person is always proposed (origin human); the requested status was not applied.';
    }
    return out;
  });
}

// ── POST /api/relationships/:id/evidence ────────────────────────────────────────────────────────────

/**
 * Attach an evidence span to a relationship (appends an 'add_evidence' revision; the status never changes).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @param {{passage?: number, start?: number, end?: number, role: string, note: string, quote?: string, relative?: boolean,
 *   locator?: string, author?: string}} body
 * @returns {{id: number, relationship: number, revision: number}}
 */
export function attachEvidence(db, id, body) {
  if (!body || typeof body !== 'object') throw invalid('Send a JSON object.', null);
  const actor = humanActor(authorName(body.author));
  const note = checkNote(body.note);
  return tx(db, () => {
    const rel = relationshipRow(db, id);
    const span = checkEvidenceSpan(db, body, { field: 'role' });
    const at = nowIso();
    const evId = insertEvidence(db, rel.id, span, actor, at);
    const rev = appendRelRevision(db, rel, { actor, action: 'add_evidence', at, reason: note,
      after: { evidence_id: evId, role: span.role, passage: span.passageId, start: span.start, end: span.end,
        quote: span.anchor?.quote ?? span.detail?.quote ?? null, locator: span.detail?.locator ?? null } });
    return { id: evId, relationship: rel.id, revision: rev };
  });
}

// ── GET /api/relationships/:id ──────────────────────────────────────────────────────────────────────

function endpointCard(db, type, ref, year) {
  const r = resolveRef(db, type, ref);
  const out = { ref: `${type}:${ref}`, type, y: year ?? r?.yLo ?? null };
  if (r?.docId) {
    out.doc = r.title;
    out.doc_id = r.docId;
    out.label = r.dateLabel;
  } else if (r?.title) {
    out.label = r.title;
  }
  if (!r) out.missing = true;
  return out;
}

/** Status in words, with DOC* for documented links whose source was not recorded. */
export function statusWords(rel) {
  if (rel.evidence_status === 'documented' && rel.provenance_quality === 'source_unrecorded') return STATUS_WORDS.documented_unrecorded;
  return STATUS_WORDS[rel.evidence_status];
}

/**
 * The edge card (§2.C): type and direction, status in words, origin, method or annotator, run, score with its
 * kind, locator, evidence spans, revisions, review state, annotations and the fixed caution.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @returns {object} SHAPES.Relationship
 */
export function relationshipCard(db, id) {
  const r = relationshipRow(db, id);
  const type = REL_TYPE_BY_CODE[r.rel_type];
  const evidence = stmt(db, `SELECT id, role, passage_id, start_off, end_off, anchor_json, detail_json, added_by, added_at
    FROM relationship_evidence WHERE relationship_id = ? ORDER BY id`).all(r.id).map((e) => {
    const anchor = parseJson(e.anchor_json);
    const detail = parseJson(e.detail_json);
    return {
      id: e.id, role: e.role, passage: e.passage_id ?? null, start: e.start_off ?? null, end: e.end_off ?? null,
      quote: anchor?.quote ?? detail?.quote ?? null, anchor, detail, added_by: e.added_by, added_at: e.added_at,
    };
  });
  const revisions = stmt(db, `SELECT rev, action, actor, at, reason, annotation_id, before_json, after_json
    FROM relationship_revision WHERE relationship_id = ? ORDER BY rev`).all(r.id).map((v) => ({
    rev: v.rev, action: v.action, actor: v.actor, at: v.at, reason: v.reason ?? null, annotation_id: v.annotation_id ?? null,
    before: parseJson(v.before_json), after: parseJson(v.after_json),
  }));
  const annotations = stmt(db, `SELECT id FROM annotation WHERE target_type = 'relationship' AND target_ref = ? ORDER BY id`)
    .all(String(r.id)).map((a) => a.id);
  const cueRow = evidence.find((e) => e.role === 'citation_cue');
  const card = {
    id: r.id,
    rel_type: r.rel_type,
    label: type?.label ?? r.rel_type,
    inverse_label: type?.inverse_label ?? null,
    glyph: type?.glyph ?? null,
    family: type?.family ?? 'similarity',
    directed: r.directed === 1,
    evidence_status: r.evidence_status,
    status_words: statusWords(r),
    origin: r.origin,
    created_by: r.created_by,
    method: r.method ?? null,
    run_id: r.run_id ?? null,
    source_dataset: r.source_dataset ?? null,
    source_locator: r.source_locator ?? null,
    locator_external: typeof r.source_locator === 'string' && /^https?:\/\//.test(r.source_locator),
    provenance_quality: r.provenance_quality,
    provenance_note: r.provenance_note ?? null,
    review_status: r.review_status,
    score: r.score === null ? null : { value: r.score, kind: r.score_kind },
    score_label: r.score === null ? null : SCORE_KIND_LABELS[r.score_kind] ?? null,
    hypothesis_group: r.hypothesis_group_id ?? null,
    date_conflict: r.date_conflict === 1,
    license: r.license ?? null,
    attribution: r.attribution ?? null,
    src: endpointCard(db, r.src_type, r.src_ref, r.src_year),
    dst: endpointCard(db, r.dst_type, r.dst_ref, r.dst_year),
    evidence,
    revisions,
    annotations,
    caution: CAUTION,
    created_at: r.created_at,
    synthetic: r.is_synthetic === 1,
  };
  if (r.run_id !== null && r.run_id !== undefined) {
    const run = stmt(db, 'SELECT stage, pipeline_version, params_json, status FROM analysis_run WHERE id = ?').get(r.run_id);
    if (run) card.run = { id: r.run_id, stage: run.stage, pipeline_version: run.pipeline_version, params: parseJson(run.params_json, {}), status: run.status };
  }
  if (cueRow) card.cue = { quote: cueRow.quote, referent: 'inferred' };
  return card;
}
