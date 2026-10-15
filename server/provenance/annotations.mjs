// OWNER: WP5
// annotations.mjs — the interpretation notebook's storage (SPEC §2.F, §3, D18): append-only annotations.
//
//  · editing appends an annotation_revision (UPDATE/DELETE of revisions are refused by triggers);
//  · reinterpreting creates a NEW annotation with `supersedes`; the old one becomes 'superseded' and stays
//    visible as a layer ("Layer 'Reader A, 2026-10-03' — superseded 2026-11-12");
//  · withdrawing appends a last revision and sets status 'withdrawn'; nothing is ever deleted;
//  · as-of (a date, or a saved view's revision cutoff) shows what existed then, with the text it had then;
//  · machine annotations (machine_tag, machine_tone, machine_gloss) cannot be created, edited, withdrawn or
//    reinterpreted here — only countered with a person's own annotation (honesty rule 10).

import { check } from '../../src/shared/contracts.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { ANNOTATION_KINDS, ANNOTATION_TARGETS, MACHINE_ANNOTATION_KINDS, STANCES } from '../../src/shared/vocab.mjs';
import { nowIso, stmt, tx } from '../db/open.mjs';
import { decodeCursor, encodeCursor, limitParam } from '../http/router.mjs';
import { HttpError } from '../http/errors.mjs';
import { checkAnchor, loadFieldText } from './anchors.mjs';
import { authorName, resolveRef } from './relationships.mjs';

/** Kinds a person writes (machine kinds come only from analysis runs and imports). */
export const HUMAN_KINDS = Object.freeze(ANNOTATION_KINDS.filter((k) => !MACHINE_ANNOTATION_KINDS.includes(k)));

const MAX_BODY = 20000;
const MAX_TAGS = 32;
const MAX_TAG_LEN = 64;
const MAX_REFS = 50;
const DIM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const REF_TYPES = new Set(['passage', 'document', 'occurrence', 'relationship', 'annotation', 'expression', 'cluster']);
const REF_ROLES = new Set(['supporting', 'contradicting']);

const invalid = (message, field, hint = null, extra = {}) => new HttpError(400, 'E_VALIDATION', message, hint, { field, ...extra });
const parseJson = (s, dflt) => {
  if (s === null || s === undefined) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── validation ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Fill what the server can derive before the shape check: a numeric target ref becomes a string; an anchor sent
 * with offsets only gets doc_id (from a passage/occurrence target), field 'body', its quote and the text sha256.
 */
function completeRequest(db, body) {
  const out = { ...body };
  if (isObj(out.target) && typeof out.target.ref === 'number') out.target = { ...out.target, ref: String(out.target.ref) };
  if (!isObj(out.anchor)) return out;
  const a = { field: 'body', ...out.anchor };
  if (!Number.isInteger(a.doc_id) && isObj(out.target) && ['passage', 'occurrence'].includes(out.target.type)) {
    a.doc_id = resolveRef(db, out.target.type, out.target.ref)?.docId ?? a.doc_id;
  }
  if (Number.isInteger(a.doc_id) && (typeof a.quote !== 'string' || typeof a.sha256 !== 'string')) {
    const t = loadFieldText(db, a.doc_id, a.field);
    if (t) {
      if (typeof a.sha256 !== 'string') a.sha256 = t.sha;
      if (typeof a.quote !== 'string' && Number.isInteger(a.start) && Number.isInteger(a.end)) a.quote = t.text.slice(a.start, a.end);
    }
  }
  out.anchor = a;
  return out;
}

function checkShape(shape, body) {
  const errs = check(shape, body);
  if (!errs.length) return;
  const first = errs[0].replace(/^\$\.?/, '');
  const field = /^[a-z_]+/.exec(first)?.[0] ?? null;
  const anchorMissing = errs.find((e) => /needs an anchor/.test(e));
  if (anchorMissing) throw invalid(anchorMissing.replace(/^\$:\s*/, ''), 'anchor', 'Select the words the note is about.');
  throw invalid(`The request does not match ${shape}: ${errs.slice(0, 3).join('; ')}`, field, null, { errors: errs.slice(0, 10) });
}

function checkBody(body) {
  if (typeof body !== 'string' || !body.trim()) throw invalid('The note is empty.', 'body_md', 'Write what you read in the passage.');
  if (body.length > MAX_BODY) throw invalid(`The note is longer than ${MAX_BODY} characters.`, 'body_md');
  return body;
}

function checkTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw invalid('tags must be a list of strings.', 'tags');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw invalid('tags must be a list of strings.', 'tags');
    const v = t.trim();
    if (!v) continue;
    if (v.length > MAX_TAG_LEN) throw invalid(`A tag may have at most ${MAX_TAG_LEN} characters.`, 'tags');
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_TAGS) throw invalid(`At most ${MAX_TAGS} tags.`, 'tags');
  return out;
}

function checkLayer(layer) {
  if (layer === undefined || layer === null || layer === '') return null;
  if (typeof layer !== 'string' || layer.trim().length > 80) throw invalid('layer must be a string of at most 80 characters.', 'layer');
  return layer.trim();
}

function checkStance(stance) {
  if (stance === undefined || stance === null) return null;
  if (!STANCES.includes(stance)) throw invalid(`stance must be one of ${STANCES.join(', ')}.`, 'stance');
  return stance;
}

/**
 * Validate dimension values against dimension_def. An unknown key defines a custom dimension (type inferred:
 * text, scale or bool) created by the author (§2.F "custom dimensions via dimension_def").
 */
function checkDimensions(db, dims, author) {
  if (dims === undefined || dims === null) return {};
  if (!isObj(dims)) throw invalid('dimensions must be an object of key → value.', 'dimensions');
  const out = {};
  for (const [key, value] of Object.entries(dims)) {
    if (!DIM_KEY.test(key)) throw invalid(`Dimension key '${key}' must be lowercase letters, digits or _.`, 'dimensions');
    if (value === null) continue;
    let def = stmt(db, 'SELECT key, type, options_json FROM dimension_def WHERE key = ?').get(key);
    if (!def) {
      const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'scale' : 'text';
      if (type === 'text' && typeof value !== 'string') throw invalid(`Dimension '${key}' needs a string, number or boolean.`, 'dimensions');
      stmt(db, `INSERT INTO dimension_def (key, label, type, options_json, builtin, created_by) VALUES (?, ?, ?, NULL, 0, ?)`)
        .run(key, key.replace(/_/g, ' '), type, `human:${author}`);
      def = { key, type, options_json: null };
    }
    const opts = parseJson(def.options_json, null);
    switch (def.type) {
      case 'enum':
        if (!Array.isArray(opts) || !opts.includes(value)) throw invalid(`Dimension '${key}' must be one of ${(opts ?? []).join(', ')}.`, 'dimensions');
        break;
      case 'scale': {
        const min = opts?.min ?? -Infinity, max = opts?.max ?? Infinity;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
          throw invalid(`Dimension '${key}' must be a number${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}.`, 'dimensions');
        }
        break;
      }
      case 'bool':
        if (typeof value !== 'boolean') throw invalid(`Dimension '${key}' must be true or false.`, 'dimensions');
        break;
      default:
        if (typeof value !== 'string' || value.length > 2000) throw invalid(`Dimension '${key}' must be text (≤ 2,000 characters).`, 'dimensions');
    }
    out[key] = value;
  }
  return out;
}

/** Evidence references of a note: each resolves; passage spans get a D18 anchor so they survive re-segmentation. */
function checkEvidenceRefs(db, refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) throw invalid('evidence_refs must be a list.', 'evidence_refs');
  if (refs.length > MAX_REFS) throw invalid(`At most ${MAX_REFS} evidence references.`, 'evidence_refs');
  return refs.map((r) => {
    if (!isObj(r) || !REF_TYPES.has(r.type)) {
      throw invalid(`Each evidence reference needs a type (${[...REF_TYPES].join(', ')}) and an id.`, 'evidence_refs');
    }
    const role = r.role ?? 'supporting';
    if (!REF_ROLES.has(role)) throw invalid("An evidence reference's role is 'supporting' or 'contradicting'.", 'evidence_refs');
    const target = resolveRef(db, r.type, r.id);
    if (!target) throw new HttpError(404, 'E_NOT_FOUND', `No ${r.type} ${r.id}.`, null, { field: 'evidence_refs' });
    const out = { type: r.type, id: Number(r.id), role };
    if (r.type === 'passage' && (r.start !== undefined || r.end !== undefined)) {
      const p = target.passage;
      const shift = r.relative === true ? p.start_off : 0;
      const start = Number(r.start) + shift, end = Number(r.end) + shift;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < p.start_off || end > p.end_off || start >= end) {
        throw invalid(`Span ${r.start}–${r.end} is not inside passage ${p.id} (${p.start_off}–${p.end_off}).`, 'evidence_refs',
          'Offsets index the document text (D4); send relative: true for offsets into the passage text.');
      }
      const textRow = p.field === 'body'
        ? stmt(db, 'SELECT original AS t FROM document_text WHERE document_id = ?').get(p.document_id)
        : stmt(db, 'SELECT value AS t FROM document_field WHERE document_id = ? AND field = ?').get(p.document_id, p.field);
      const { anchor } = checkAnchor(db, { doc_id: p.document_id, field: p.field, start, end, quote: textRow.t.slice(start, end) },
        { docId: p.document_id, passage: p });
      Object.assign(out, { start: anchor.start, end: anchor.end, quote: anchor.quote, anchor });
    }
    return out;
  });
}

/** Resolve and check the target of a new annotation; returns {type, ref, synthetic, anchor}. */
function checkTarget(db, body, { kind }) {
  const t = body.target;
  if (!ANNOTATION_TARGETS.includes(t.type)) throw invalid(`Annotation target type '${t.type}' is not supported.`, 'target');
  if (kind === 'label' && t.type !== 'cluster') {
    throw invalid("A 'label' renames a machine context group; its target must be a cluster.", 'kind',
      'Use kind interpretation for other notes.');
  }
  const target = resolveRef(db, t.type, t.ref);
  if (!target) throw new HttpError(404, 'E_NOT_FOUND', `No ${t.type} ${t.ref}.`, null, { field: 'target' });
  let anchor = null, relocated = null;
  if (t.type === 'passage' || t.type === 'occurrence') {
    ({ anchor, relocated } = checkAnchor(db, body.anchor, { docId: target.docId, passage: target.passage }));
  } else if (t.type === 'document' && body.anchor) {
    ({ anchor, relocated } = checkAnchor(db, body.anchor, { docId: target.docId }));
  } else if (body.anchor) {
    throw invalid(`A ${t.type} target takes no anchor.`, 'anchor');
  }
  return { type: t.type, ref: target.ref, synthetic: target.synthetic ? 1 : 0, anchor, relocated };
}

function indexRevision(db, revId, body, tags) {
  stmt(db, 'INSERT INTO annotation_fts (rowid, body, tags) VALUES (?, ?, ?)')
    .run(revId, tokenize(body).tokens.join(' '), tokenize(tags.join(' ')).tokens.join(' '));
}

function insertRevision(db, annId, rev, { body, stance, dimensions, tags, refs, reason, author, at }) {
  const revId = Number(stmt(db, `INSERT INTO annotation_revision (annotation_id, rev, body_md, stance, dimensions_json, tags_json,
      evidence_refs_json, reason, author, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(annId, rev, body, stance, JSON.stringify(dimensions), JSON.stringify(tags), JSON.stringify(refs), reason, author, at)
    .lastInsertRowid);
  indexRevision(db, revId, body, tags);
  return revId;
}

function annotationRow(db, id) {
  const n = Number(id);
  const a = Number.isSafeInteger(n) && n > 0 ? stmt(db, 'SELECT * FROM annotation WHERE id = ?').get(n) : null;
  if (!a) throw new HttpError(404, 'E_NOT_FOUND', `No annotation ${id}.`);
  return a;
}

function refuseMachine(a) {
  if (a.is_machine === 1 || MACHINE_ANNOTATION_KINDS.includes(a.kind)) {
    throw new HttpError(409, 'E_MACHINE_ANNOTATION', 'Machine annotations cannot be edited, only countered.',
      'Add your own annotation of kind evidence_against.', { kind: a.kind });
  }
}

function supersededBy(db, id) {
  return stmt(db, 'SELECT id, created_at FROM annotation WHERE supersedes = ? ORDER BY id LIMIT 1').get(id) ?? null;
}

function refuseInactive(db, a, verb) {
  if (a.status === 'superseded') {
    const by = supersededBy(db, a.id);
    throw new HttpError(409, 'E_ANNOTATION_SUPERSEDED', `Annotation ${a.id} was already reinterpreted as ${by?.id ?? 'a newer one'}.`,
      by ? `${verb} ${by.id} instead.` : null, { by: by?.id ?? null });
  }
  if (a.status === 'withdrawn') {
    throw new HttpError(409, 'E_ANNOTATION_WITHDRAWN', `Annotation ${a.id} was withdrawn.`,
      'Write a new annotation; the withdrawn one stays in the history.', { id: a.id });
  }
}

const lastRevision = (db, id) => stmt(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ? ORDER BY rev DESC LIMIT 1').get(id);

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/annotations. Passage and occurrence targets need an anchor (D18); the server recomputes its
 * prefix/suffix and re-locates stale offsets by the quote.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} body AnnotationRequest (+ optional author)
 * @returns {{id: number, rev: 1, anchor?: object, relocated?: string}}
 */
export function createAnnotation(db, request) {
  if (!isObj(request)) throw invalid('Send a JSON object.', null);
  const body = completeRequest(db, request);
  checkShape('AnnotationRequest', body);
  if (MACHINE_ANNOTATION_KINDS.includes(body.kind)) {
    throw invalid(`Kind '${body.kind}' is written by analysis runs, not by hand.`, 'kind',
      'Counter a machine annotation with your own note (evidence_against).');
  }
  const author = authorName(body.author);
  return tx(db, () => insertAnnotation(db, body, { author, supersedes: null }));
}

function insertAnnotation(db, body, { author, supersedes }) {
  const kind = body.kind;
  const text = checkBody(body.body_md);
  const target = checkTarget(db, body, { kind });
  const tags = checkTags(body.tags);
  const dimensions = checkDimensions(db, body.dimensions, author);
  const refs = checkEvidenceRefs(db, body.evidence_refs);
  const stance = checkStance(body.stance);
  const layer = checkLayer(body.layer);
  const at = nowIso();
  const id = Number(stmt(db, `INSERT INTO annotation (target_type, target_ref, anchor_json, kind, author, is_machine, method, run_id,
      layer, supersedes, status, is_synthetic, current_rev, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, 'active', ?, 1, ?)`)
    .run(target.type, target.ref, target.anchor ? JSON.stringify(target.anchor) : null, kind, author, layer, supersedes,
      target.synthetic, at).lastInsertRowid);
  insertRevision(db, id, 1, { body: text, stance, dimensions, tags, refs, reason: null, author, at });
  const out = { id, rev: 1 };
  if (target.anchor) out.anchor = target.anchor;
  if (target.relocated) out.relocated = target.relocated;
  return out;
}

/**
 * PATCH /api/annotations/:id — append a revision. Omitted dimensions, tags, stance and evidence_refs carry
 * over from the previous revision.
 * @returns {{id: number, rev: number}}
 */
export function reviseAnnotation(db, id, body) {
  if (!isObj(body)) throw invalid('Send a JSON object.', null);
  checkShape('AnnotationPatch', body);
  return tx(db, () => {
    const a = annotationRow(db, id);
    refuseMachine(a);
    refuseInactive(db, a, 'Edit');
    const author = body.author === undefined ? a.author : authorName(body.author);
    const prev = lastRevision(db, a.id);
    const rev = a.current_rev + 1;
    insertRevision(db, a.id, rev, {
      body: checkBody(body.body_md),
      stance: body.stance === undefined ? prev.stance : checkStance(body.stance),
      dimensions: body.dimensions === undefined ? parseJson(prev.dimensions_json, {}) : checkDimensions(db, body.dimensions, author),
      tags: body.tags === undefined ? parseJson(prev.tags_json, []) : checkTags(body.tags),
      refs: body.evidence_refs === undefined ? parseJson(prev.evidence_refs_json, []) : checkEvidenceRefs(db, body.evidence_refs),
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 2000) : null,
      author,
      at: nowIso(),
    });
    stmt(db, 'UPDATE annotation SET current_rev = ? WHERE id = ?').run(rev, a.id);
    return { id: a.id, rev };
  });
}

/**
 * POST /api/annotations/:id/reinterpret — a new annotation on the same target that supersedes this one; the
 * old one stays as a visible layer. The new layer defaults to "<author>, <date>".
 * @returns {{id: number, supersedes: number, rev: 1}}
 */
export function reinterpretAnnotation(db, id, body) {
  if (!isObj(body)) throw invalid('Send a JSON object.', null);
  return tx(db, () => {
    const old = annotationRow(db, id);
    refuseMachine(old);
    refuseInactive(db, old, 'Reinterpret');
    const target = body.target ?? { type: old.target_type, ref: old.target_ref };
    if (target.type !== old.target_type || String(target.ref) !== old.target_ref) {
      throw invalid(`A reinterpretation keeps the target ${old.target_type}:${old.target_ref}.`, 'target',
        'Write a new annotation for another target.');
    }
    const author = authorName(body.author ?? old.author);
    const next = {
      ...body,
      target: { type: old.target_type, ref: old.target_ref },
      kind: body.kind ?? old.kind,
      anchor: body.anchor ?? parseJson(old.anchor_json, undefined) ?? undefined,
      layer: body.layer ?? `${author}, ${nowIso().slice(0, 10)}`,
    };
    if (next.anchor === null) delete next.anchor;
    checkShape('AnnotationRequest', completeRequest(db, next));
    if (MACHINE_ANNOTATION_KINDS.includes(next.kind)) throw invalid(`Kind '${next.kind}' is written by analysis runs, not by hand.`, 'kind');
    const created = insertAnnotation(db, completeRequest(db, next), { author, supersedes: old.id });
    stmt(db, "UPDATE annotation SET status = 'superseded' WHERE id = ?").run(old.id);
    return { id: created.id, supersedes: old.id, rev: 1 };
  });
}

/**
 * POST /api/annotations/:id/withdraw — append a last revision (same text) and set status 'withdrawn'.
 * @returns {{id: number, rev: number, status: 'withdrawn'}}
 */
export function withdrawAnnotation(db, id, body = {}) {
  return tx(db, () => {
    const a = annotationRow(db, id);
    refuseMachine(a);
    refuseInactive(db, a, 'Withdraw');
    const author = body?.author === undefined ? a.author : authorName(body.author);
    const prev = lastRevision(db, a.id);
    const rev = a.current_rev + 1;
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? `withdrawn: ${body.reason.trim().slice(0, 2000)}` : 'withdrawn';
    insertRevision(db, a.id, rev, { body: prev.body_md, stance: prev.stance, dimensions: parseJson(prev.dimensions_json, {}),
      tags: parseJson(prev.tags_json, []), refs: parseJson(prev.evidence_refs_json, []), reason, author, at: nowIso() });
    stmt(db, "UPDATE annotation SET current_rev = ?, status = 'withdrawn' WHERE id = ?").run(rev, a.id);
    return { id: a.id, rev, status: 'withdrawn' };
  });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────

function revisionJson(r) {
  return {
    rev: r.rev, body_md: r.body_md, stance: r.stance ?? null, dimensions: parseJson(r.dimensions_json, {}),
    tags: parseJson(r.tags_json, []), evidence_refs: parseJson(r.evidence_refs_json, []), author: r.author, at: r.at,
    reason: r.reason ?? null,
  };
}

/**
 * GET /api/annotations/:id/revisions — every revision, oldest first.
 * @returns {object[]} SHAPES.AnnotationRevisions
 */
export function annotationRevisions(db, id) {
  const a = annotationRow(db, id);
  return stmt(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ? ORDER BY rev').all(a.id).map(revisionJson);
}

/**
 * Parse an as-of bound: 'YYYY-MM-DD' (end of that day, UTC) or an ISO date-time.
 * @param {string|undefined} s
 * @returns {string|null} ISO bound for string comparison with stored nowIso() values
 */
export function parseAsOf(s) {
  if (s === undefined || s === null || s === '') return null;
  if (DATE_ONLY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return `${s}T23:59:59.999Z`;
  if (DATETIME.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  throw invalid(`as_of '${s}' is not a date (YYYY-MM-DD) or an ISO date-time.`, 'as_of');
}

function splitList(v) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

const hypothesisLabel = (a) => `Hypothesis — by ${a.author}, ${a.created_at.slice(0, 10)} — not evidence`;

/**
 * The state of each annotation at a bound (none = now): which revision was visible, and its status then.
 * Returns null for an annotation that did not exist yet.
 */
function stateAt(a, revs, successor, bound) {
  const visible = (r) => (bound === null ? true : bound.time ? r.at <= bound.time : r.id <= bound.revCutoff);
  const shownRevs = revs.filter(visible);
  if (!shownRevs.length) return null;
  const shown = shownRevs[shownRevs.length - 1];
  let status = 'active', withdrawnAt = null, supersededAt = null;
  const last = revs[revs.length - 1];
  if (a.status === 'withdrawn' && visible(last)) { status = 'withdrawn'; withdrawnAt = last.at; }
  if (successor && visible(successor.first)) { status = 'superseded'; supersededAt = successor.created_at; }
  return { shown, status, withdrawnAt, supersededAt, count: shownRevs.length };
}

/**
 * The revision an annotation showed at a saved view's annotation revision cutoff, and its status then (RF-2: Compare's
 * human counts as saved), or null when it did not exist yet — the rule of GET /api/annotations?rev_cutoff=.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} a annotation row
 * @param {number} revCutoff
 * @returns {{revision: object, status: 'active'|'superseded'|'withdrawn'}|null}
 */
export function annotationShownAt(db, a, revCutoff) {
  const revs = stmt(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ? ORDER BY rev').all(a.id);
  const succ = supersededBy(db, a.id);
  const successor = succ ? { ...succ, first: stmt(db, 'SELECT id, at FROM annotation_revision WHERE annotation_id = ? AND rev = 1').get(succ.id) } : null;
  const st = stateAt(a, revs, successor, { revCutoff });
  return st ? { revision: st.shown, status: st.status } : null;
}

/**
 * GET /api/annotations?target=passage:901&include=superseded,withdrawn&as_of=2026-11-01&kind=&author=&layer=&tag=
 *   &dimension=key[:value]&contradicted=1&from=&to=&machine=0|1|only&doc=44&q=&rev_cutoff=&limit=&cursor=
 * Default: active annotations (human and machine; machine ones carry fallible: true). `include=superseded`
 * adds the superseded layers, `include=withdrawn` the withdrawn ones (`all` both). `as_of` / `rev_cutoff`
 * show what existed at that time / at a saved view's annotation revision cutoff, with the text of then.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string>} query
 * @returns {{items: object[], cursor: string|null}} SHAPES.Annotations
 */
export function listAnnotations(db, query = {}) {
  const limit = limitParam(query, { max: 200, dflt: 50 });
  const after = decodeCursor(query.cursor)?.after ?? 0;
  const include = new Set(splitList(query.include) ?? []);
  if (include.has('all')) { include.add('superseded'); include.add('withdrawn'); }
  const asOf = parseAsOf(query.as_of);
  let revCutoff = null;
  if (query.rev_cutoff !== undefined && query.rev_cutoff !== '') {
    revCutoff = Number(query.rev_cutoff);
    if (!Number.isSafeInteger(revCutoff) || revCutoff < 0) throw invalid('rev_cutoff must be a non-negative integer.', 'rev_cutoff');
  }
  const bound = asOf ? { time: asOf } : revCutoff !== null ? { revCutoff } : null;
  const facets = parseFacets(query);
  const from = parseAsOf(query.from), to = parseAsOf(query.to);

  const where = ['a.id > ?'];
  const args = [after];
  if (query.target) {
    const i = String(query.target).indexOf(':');
    if (i <= 0) throw invalid(`target '${query.target}' must look like passage:901.`, 'target');
    const type = query.target.slice(0, i), ref = query.target.slice(i + 1);
    if (!ANNOTATION_TARGETS.includes(type)) throw invalid(`Annotation target type '${type}' is not supported.`, 'target');
    where.push('a.target_type = ? AND a.target_ref = ?');
    args.push(type, ref);
  }
  if (query.doc) {
    const doc = Number(query.doc);
    if (!Number.isSafeInteger(doc)) throw invalid('doc must be a document id.', 'doc');
    where.push(`((a.target_type = 'document' AND a.target_ref = ?) OR json_extract(a.anchor_json, '$.doc_id') = ?)`);
    args.push(String(doc), doc);
  }
  const kinds = splitList(query.kind);
  if (kinds) {
    for (const k of kinds) if (!ANNOTATION_KINDS.includes(k)) throw invalid(`Unknown kind '${k}'.`, 'kind');
    where.push(`a.kind IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(kinds));
  }
  if (query.author) { where.push('a.author = ?'); args.push(String(query.author)); }
  if (query.layer) { where.push('a.layer = ?'); args.push(String(query.layer)); }
  if (query.machine === '0') where.push('a.is_machine = 0');
  else if (query.machine === 'only') where.push('a.is_machine = 1');
  if (query.q) {
    const terms = tokenize(String(query.q)).tokens;
    if (!terms.length) return { items: [], cursor: null };
    where.push(`a.id IN (SELECT r.annotation_id FROM annotation_fts f JOIN annotation_revision r ON r.id = f.rowid
      WHERE annotation_fts MATCH ?)`);
    args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '));
  }
  if (asOf) { where.push('a.created_at <= ?'); args.push(asOf); }
  if (from) { where.push('a.created_at >= ?'); args.push(from.slice(0, 10)); }
  if (to) { where.push('a.created_at <= ?'); args.push(to); }

  const sql = `SELECT a.* FROM annotation a WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT ?`;
  const items = [];
  let lastId = after, exhausted = false;
  const batch = Math.max(limit * 2, 50);
  while (items.length < limit && !exhausted) {
    const rows = db.prepare(sql).all(...args.map((x, i) => (i === 0 ? lastId : x)), batch);
    if (rows.length < batch) exhausted = true;
    for (const a of rows) {
      lastId = a.id;
      const item = annotationJson(db, a, bound, include, facets);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
  }
  const more = items.length >= limit && (!exhausted || db.prepare(sql).all(...args.map((x, i) => (i === 0 ? lastId : x)), 1).length > 0);
  return { items, cursor: more ? encodeCursor({ after: lastId }) : null };
}

/** Facets applied to the revision an annotation shows (tag, dimension) and to its counter-evidence. */
function parseFacets(query) {
  let dimension = null;
  if (query.dimension) {
    const [key, ...rest] = String(query.dimension).split(':');
    if (!DIM_KEY.test(key)) throw invalid(`dimension '${query.dimension}' must look like key or key:value.`, 'dimension');
    dimension = { key, value: rest.length ? rest.join(':') : null };
  }
  return { tag: query.tag ? String(query.tag) : null, dimension, contradicted: query.contradicted === '1' };
}

/** Whether something argues against an annotation: a contradicting evidence reference, or a counter-annotation. */
function isContradicted(db, a, r) {
  if (r.evidence_refs.some((x) => x.role === 'contradicting')) return true;
  return Boolean(stmt(db, `SELECT 1 FROM annotation WHERE target_type = 'annotation' AND target_ref = ? AND kind = 'evidence_against'
    AND status = 'active' LIMIT 1`).get(String(a.id)));
}

function annotationJson(db, a, bound, include, facets) {
  const revs = stmt(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ? ORDER BY rev').all(a.id);
  const succ = supersededBy(db, a.id);
  const successor = succ ? { ...succ, first: stmt(db, 'SELECT id, at FROM annotation_revision WHERE annotation_id = ? AND rev = 1').get(succ.id) } : null;
  const st = stateAt(a, revs, successor, bound);
  if (!st) return null;
  if (st.status === 'superseded' && !include.has('superseded')) return null;
  if (st.status === 'withdrawn' && !include.has('withdrawn')) return null;
  const r = revisionJson(st.shown);
  if (facets.tag && !r.tags.includes(facets.tag)) return null;
  if (facets.dimension) {
    const v = r.dimensions[facets.dimension.key];
    if (v === undefined || (facets.dimension.value !== null && String(v) !== facets.dimension.value)) return null;
  }
  const contradicted = isContradicted(db, a, r);
  if (facets.contradicted && !contradicted) return null;
  const item = {
    id: a.id,
    target: { type: a.target_type, ref: a.target_ref },
    kind: a.kind,
    author: a.author,
    is_machine: a.is_machine === 1,
    method: a.method ?? null,
    run_id: a.run_id ?? null,
    status: st.status,
    rev: r.rev,
    revisions: st.count,
    body_md: r.body_md,
    stance: r.stance,
    dimensions: r.dimensions,
    tags: r.tags,
    evidence_refs: r.evidence_refs,
    rev_at: r.at,
    reason: r.reason,
    layer: a.layer ?? null,
    supersedes: a.supersedes ?? null,
    superseded_by: st.status === 'superseded' ? successor.id : null,
    superseded_at: st.supersededAt,
    withdrawn_at: st.withdrawnAt,
    anchor: parseJson(a.anchor_json, null),
    contradicted,
    created_at: a.created_at,
    synthetic: a.is_synthetic === 1,
  };
  if (a.kind === 'hypothesis') item.label = hypothesisLabel(a);
  if (item.is_machine) item.fallible = true;
  return item;
}
