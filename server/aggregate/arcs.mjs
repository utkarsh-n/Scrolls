// OWNER: WP3
// arcs.mjs — relationship arcs for the Scroll (SPEC §1.8, §1.6 tier budgets, §7.1 GET /api/timeline/arcs).
//
// Scope: relationships with at least one end in a document where a pinned strand is observed in the query's slice
// (an expression's counted matches, a theme's tagged works, a work, a maker's works): "how one occurrence or work
// became material for another" for what the Scroll shows. With ◉ pinned in the demo, only ◉'s documented arc is drawn,
// not the arcs of 'carry the zero' (§9.4 P3).
//
// An arc joins two drawable ends (a document, a passage or an occurrence of a dated document in the slice), earlier →
// later, and is shown once both ends are ≤ the vantage year. Line style follows the immutable evidence status; review
// is an overlay. Feedback (drawn below, arrow on the earlier end) comes only from feedback-capable relationship types
// with status documented or proposed — never from computed similarity, never from a date conflict — and from human
// annotations whose dimensions say `reframes_target`; the earlier mark then gets a violet halo ("re-read after 1994
// (1 documented, 2 annotated)"). A date conflict (a precedence-requiring type whose dependent end is dated before its
// source) is a stub, never feedback. Budget per tier: L0 bundles only, L1 ≤ 150, L2+ ≤ 300 individual arcs, ranked
// documented > computed > proposed, then evidence rows, then nearness to the vantage; the rest are bundled per (lane
// pair, bin pair) with width ∝ log₂(count + 1). kindred / counterpart and rejected relationships are hidden unless asked
// for. A saved view read "as saved" passes its relationship and annotation revision cutoffs and pinned runs.

import { binOf, yearLabel } from '../../src/shared/dates.mjs';
import { REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { reviewStatusOf } from '../provenance/reviews.mjs';
import { laneKeyOfRow } from './lanes.mjs';
import { docWhere, fieldClassesOf, strandDocRows } from './query.mjs';
import { COUNTED, occurrenceSql } from './marks.mjs';

/** Most individual arcs per viewport (§1.8). */
export const ARC_BUDGET = 300;
/** C4 (contract 1.3.0): above this many arcs in the requested range the answer is a summary. */
export const SUMMARY_ABOVE = 1500;
/** C4: individual arcs drawn over a summary (the highest-priority ones). */
export const SUMMARY_INDIVIDUAL = 300;
/** C4: individual arcs of a detail request (detail=1 over a range narrower than 50 years). */
export const DETAIL_MAX = 1500;
/** C4: a detail request needs a range narrower than this many years. */
export const DETAIL_YEARS = 50;
/** Most buckets of a summary: bins coarsen (decade → century → millennium) until the buckets fit. */
export const MAX_BUCKETS = 600;
/** Individual arcs per tier (§1.6): arc bundles only at L0, ≤ 150 at L1, ≤ 300 from L2. */
export const TIER_BUDGET = Object.freeze({ L0: 0, L1: 150, L2: 300, L3: 300, L4: 300, L5: 300 });
const STATUS_RANK = { documented: 0, computed: 1, proposed: 2 };
const HIDDEN_TYPES = new Set(['kindred', 'counterpart']);
const TIER_LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 3, L5: 3 };
const DRAWABLE = "('document', 'passage', 'occurrence')";
const REVIEW_ACTIONS = "('confirm', 'reject', 'dispute', 'retract')";

/**
 * Parse the `ev` parameter: evidence statuses to show, plus 'rejected' and 'kindred' to reveal those.
 * @param {string|string[]|null} ev
 * @returns {{statuses: Set<string>, rejected: boolean, kindred: boolean}}
 */
export function parseEvidence(ev) {
  const list = (Array.isArray(ev) ? ev : String(ev ?? 'documented,computed,proposed').split(',')).map((x) => x.trim()).filter(Boolean);
  const statuses = new Set(list.filter((x) => x in STATUS_RANK));
  for (const x of list) {
    if (!(x in STATUS_RANK) && x !== 'rejected' && x !== 'kindred') {
      throw new HttpError(400, 'E_VALIDATION', `Unknown evidence filter '${x}'.`, 'Use documented, computed, proposed, rejected, kindred.', { field: 'ev' });
    }
  }
  return { statuses, rejected: list.includes('rejected'), kindred: list.includes('kindred') };
}

const cutoffParam = (v, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'E_VALIDATION', `${field} must be a non-negative integer.`, null, { field });
  return n;
};

const runList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => Number(String(x).trim())).filter((n) => Number.isSafeInteger(n) && n > 0);

/**
 * Documents where a pinned strand is observed in the def's slice (any chronology).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {Set<number>}
 */
export function strandDocIds(db, def) {
  const out = new Set();
  for (const s of def.strands) {
    if (s.type === 'expression' || s.type === 'theme') {
      for (const r of strandDocRows(db, def, s)) if (r.v > 0) out.add(r.doc);
    } else if (s.type === 'work') {
      out.add(Number(s.ref));
    } else if (s.type === 'maker') {
      const dw = docWhere(def);
      const names = JSON.stringify(s.names ?? [s.ref]);
      for (const r of stmt(db, `SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id
        WHERE (d.author IN (SELECT value FROM json_each(?)) OR d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'maker'
          AND value IN (SELECT value FROM json_each(?)))) AND ${dw.sql}`).all(names, names, ...dw.params)) out.add(r.id);
    }
  }
  return out;
}

/**
 * Relationships (visible runs only: succeeded or pinned) between drawable ends with an end in one of the documents,
 * directly or through a passage or an occurrence of it, overlapping [from, to] when their years are known. Rows carry
 * `ev_rows` (evidence rows) and `cue` (an attribution-cue evidence row).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} docIds
 * @param {{from?: number|null, to?: number|null, runs?: number[], relRevCutoff?: number|null, columns?: 'all'|'arcs'}} [opts]
 * @returns {object[]} relationship rows, by id
 */
/** The relationship columns arcs read (`columns: 'arcs'`): a few of a row's columns, not its locator, licence and notes. */
const ARC_COLUMNS = `r.id, r.rel_type, r.src_type, r.src_ref, r.dst_type, r.dst_ref, r.directed, r.evidence_status, r.origin, r.provenance_quality,
  r.run_id, r.review_status, r.score, r.score_kind, r.date_conflict, r.src_year, r.dst_year, r.hypothesis_group_id, r.is_synthetic`;

export function relationshipsTouching(db, docIds, { from = null, to = null, runs = [], relRevCutoff = null, columns = 'all' } = {}) {
  if (!docIds.length) return [];
  const where = [`(r.run_id IS NULL OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id
    AND (a.status = 'succeeded' OR a.id IN (SELECT value FROM json_each(?)))))`, `r.src_type IN ${DRAWABLE}`, `r.dst_type IN ${DRAWABLE}`];
  const params = [JSON.stringify(runs)];
  if (Number.isInteger(to)) { where.push('(r.src_year IS NULL OR r.dst_year IS NULL OR MIN(r.src_year, r.dst_year) <= ?)'); params.push(to); }
  if (Number.isInteger(from)) { where.push('(r.src_year IS NULL OR r.dst_year IS NULL OR MAX(r.src_year, r.dst_year) >= ?)'); params.push(from); }
  if (relRevCutoff !== null) {
    // as saved: only links that existed at the view's relationship revision cutoff
    where.push('EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id AND v.rev = 1 AND v.id <= ?)');
    params.push(relRevCutoff);
  }
  const ids = JSON.stringify(docIds.map(String));
  const nums = JSON.stringify(docIds);
  const w = where.join(' AND ');
  const sql = `SELECT ${columns === 'arcs' ? ARC_COLUMNS : 'r.*'}, (SELECT count(*) FROM relationship_evidence e WHERE e.relationship_id = r.id) AS ev_rows,
      EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'citation_cue') AS cue FROM relationship r
    WHERE r.id IN (
      SELECT id FROM relationship WHERE src_type = 'document' AND src_ref IN (SELECT value FROM json_each(?))
      UNION SELECT id FROM relationship WHERE dst_type = 'document' AND dst_ref IN (SELECT value FROM json_each(?))
      UNION SELECT x.id FROM relationship x JOIN passage p ON p.id = CAST(x.src_ref AS INTEGER)
        WHERE x.src_type = 'passage' AND p.document_id IN (SELECT value FROM json_each(?))
      UNION SELECT x.id FROM relationship x JOIN passage p ON p.id = CAST(x.dst_ref AS INTEGER)
        WHERE x.dst_type = 'passage' AND p.document_id IN (SELECT value FROM json_each(?))
      UNION SELECT x.id FROM relationship x JOIN occurrence o ON o.id = CAST(x.src_ref AS INTEGER)
        WHERE x.src_type = 'occurrence' AND o.document_id IN (SELECT value FROM json_each(?))
      UNION SELECT x.id FROM relationship x JOIN occurrence o ON o.id = CAST(x.dst_ref AS INTEGER)
        WHERE x.dst_type = 'occurrence' AND o.document_id IN (SELECT value FROM json_each(?)))
    AND ${w} ORDER BY r.id`;
  return stmt(db, sql).all(ids, ids, nums, nums, nums, nums, ...params);
}

/** Review status of each relationship as of a revision cutoff (each reviewer's latest decision then). */
function reviewAsOf(db, relIds, cutoff) {
  const byRel = new Map();
  for (const v of stmt(db, `SELECT relationship_id, actor, action FROM relationship_revision
    WHERE relationship_id IN (SELECT value FROM json_each(?)) AND action IN ${REVIEW_ACTIONS} AND id <= ? ORDER BY relationship_id, rev`)
    .all(JSON.stringify(relIds), cutoff)) {
    if (!byRel.has(v.relationship_id)) byRel.set(v.relationship_id, []);
    byRel.get(v.relationship_id).push(v);
  }
  return (r) => reviewStatusOf(byRel.get(r.id) ?? []);
}

/** Resolve drawable ends (document / passage / occurrence refs) to {doc, passage, p}. */
function endResolver(db, refs) {
  const passIds = new Set(), occIds = new Set();
  for (const [t, ref] of refs) {
    if (t === 'passage') passIds.add(Number(ref)); else if (t === 'occurrence') occIds.add(Number(ref));
  }
  const occ = new Map(stmt(db, 'SELECT id, passage_id FROM occurrence WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...occIds])).map((o) => [o.id, o.passage_id]));
  for (const p of occ.values()) passIds.add(p);
  const pass = new Map(stmt(db, `SELECT id, document_id, lang AS plang, field_class, quality FROM passage
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...passIds])).map((p) => [p.id, p]));
  return (type, ref) => {
    if (type === 'document') return { doc: Number(ref), passage: null };
    const pid = type === 'passage' ? Number(ref) : type === 'occurrence' ? occ.get(Number(ref)) : null;
    const p = pid ? pass.get(pid) : null;
    return p ? { doc: p.document_id, passage: p.id, p, occ: type === 'occurrence' ? Number(ref) : null } : null;
  };
}

/**
 * Slice documents (corpus, filters, toggles) among ids, with what places them on a lane: only the columns arcs read
 * (the original metadata of 20k OpenAlex works made `d.*` the cost of an arcs request), and the language and field
 * class of the document's main counted text from doc_tokens (a few rows per document; reading its passages in order
 * scanned whole books).
 */
function sliceDocs(db, def, ids) {
  const dw = docWhere(def);
  const fcs = JSON.stringify(fieldClassesOf(def));
  const main = (col) => `(SELECT t.${col} FROM doc_tokens t WHERE t.document_id = d.id AND t.field_class IN (SELECT value FROM json_each(?))
    ORDER BY CASE t.field_class WHEN 'text' THEN 0 WHEN 'abstract' THEN 1 ELSE 2 END, t.tokens DESC, t.plang LIMIT 1)`;
  return new Map(stmt(db, `SELECT d.id, d.y_lo, d.y_hi, d.lo_day, d.hi_day, d.chrono_status, d.is_synthetic, d.lang_text, d.kind,
      d.culture, d.field, d.community, d.basis, c.domain, c.slug AS coll, c.sampling, c.rate_eligible,
      ${main('plang')} AS first_lang, ${main('field_class')} AS first_fc
    FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE d.id IN (SELECT value FROM json_each(?)) AND ${dw.sql}`).all(fcs, fcs, JSON.stringify([...ids]), ...dw.params).map((d) => [d.id, d]));
}

const laneOf = (def, e, doc, groups = null) => laneKeyOfRow(def.lanes.facet, { domain: doc.domain, community: doc.community, kind: doc.kind,
  culture: doc.culture, coll: doc.coll, field: doc.field, basis: doc.basis, sampling: doc.sampling,
  plang: e.p?.plang ?? doc.first_lang ?? doc.lang_text ?? 'und', field_class: e.p?.field_class ?? doc.first_fc ?? 'text',
  grp: groups ? groups.of(e) : null });

const endJson = (def, e, doc, groups = null) => ({ ...(e.passage ? { passage: e.passage } : {}), doc: e.doc, y: doc.y_lo, lo_day: doc.lo_day,
  hi_day: doc.hi_day, lane: laneOf(def, e, doc, groups) });

/**
 * Context-group lanes of arc ends (cluster lanes): an occurrence end sits in its own group's lane; a passage or document
 * end in the group holding most of the strand's counted occurrences there (ties → the lowest group); an end with none
 * in the residual lane.
 */
function endGroups(db, def, docIds) {
  if (def.lanes.facet !== 'cluster' || def.cluster?.state !== 'ok' || !docIds.length) return null;
  const strand = def.strands.find((s) => s.type === 'expression');
  const q = occurrenceSql(def, strand, { where: 'd.id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(docIds)] });
  const byOcc = new Map(), byPassage = new Map(), byDoc = new Map();
  const vote = (m, k, g) => { const c = m.get(k) ?? new Map(); c.set(g, (c.get(g) ?? 0) + 1); m.set(k, c); };
  for (const r of stmt(db, `WITH m AS (${q.sql}) SELECT occ, passage, doc, lv FROM m WHERE ${COUNTED}`).all(...q.params)) {
    byOcc.set(r.occ, r.lv);
    vote(byPassage, r.passage, r.lv);
    vote(byDoc, r.doc, r.lv);
  }
  const best = (c) => (c ? [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { numeric: true }))[0][0] : null);
  const residual = `${def.cluster.run}:residual`;
  return { of: (e) => byOcc.get(e.occ) ?? best(byPassage.get(e.passage)) ?? best(byDoc.get(e.doc)) ?? residual };
}

/**
 * Reframing annotations (§1.8 feedback (b)): human annotations whose dimensions (as of the revision cutoff) say
 * `reframes_target`, on a passage, occurrence or document of a strand. Each counts on the target's halo; each
 * evidence reference to a later dated item in the slice also draws an annotated feedback arc.
 * @returns {Array<{id: number, author: string, layer: string|null, year: number, synthetic: boolean, target: object,
 *   sources: Array<{type: string, ref: string}>}>}
 */
function reframingAnnotations(db, revCutoff) {
  const revs = stmt(db, `SELECT v.annotation_id, v.id, v.rev, v.at, v.dimensions_json, v.evidence_refs_json FROM annotation_revision v
    JOIN annotation a ON a.id = v.annotation_id
    WHERE a.is_machine = 0 AND a.target_type IN ${DRAWABLE} ORDER BY v.annotation_id, v.rev`).all();
  const byAnn = new Map();
  for (const v of revs) {
    if (!byAnn.has(v.annotation_id)) byAnn.set(v.annotation_id, []);
    byAnn.get(v.annotation_id).push(v);
  }
  if (!byAnn.size) return [];
  const anns = stmt(db, `SELECT a.*, (SELECT min(v.id) FROM annotation_revision v WHERE v.annotation_id = s.id) AS successor_rev
    FROM annotation a LEFT JOIN annotation s ON s.supersedes = a.id WHERE a.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...byAnn.keys()]));
  const out = [];
  for (const a of anns) {
    const all = byAnn.get(a.id);
    const visible = all.filter((v) => revCutoff === null || v.id <= revCutoff);
    if (!visible.length) continue;
    const shown = visible[visible.length - 1];
    const last = all[all.length - 1];
    // the state then (as WP5's notebook reads it): withdrawn once its last revision is visible; superseded once its
    // successor exists
    if (a.status === 'withdrawn' && (revCutoff === null || last.id <= revCutoff)) continue;
    if (a.successor_rev !== null && (revCutoff === null || a.successor_rev <= revCutoff)) continue;
    let dims = {}, refs = [];
    try { dims = JSON.parse(shown.dimensions_json ?? '{}') ?? {}; } catch { dims = {}; }
    if (dims.reframes_target !== true) continue;
    try { refs = JSON.parse(shown.evidence_refs_json ?? '[]') ?? []; } catch { refs = []; }
    out.push({ id: a.id, author: a.author, layer: a.layer ?? null, year: Number(String(visible[0].at).slice(0, 4)),
      synthetic: a.is_synthetic === 1, target: { type: a.target_type, ref: a.target_ref },
      sources: (Array.isArray(refs) ? refs : []).filter((r) => r && ['passage', 'occurrence', 'document'].includes(r.type) && r.id !== undefined
        && r.role !== 'contradicting').map((r) => ({ type: r.type, ref: String(r.id) })) });
  }
  return out;
}

/**
 * The selected item of a request (`sel`): document, passage or occurrence, as `document:12` / `doc:12`, `passage:9` /
 * `psg:9`, `occurrence:4` / `occ:4`.
 * @returns {{doc?: number, passage?: number, occ?: number}|null}
 */
export function parseSelection(sel) {
  const m = /^(document|doc|passage|psg|occurrence|occ):(\d{1,15})$/.exec(String(sel ?? '').trim());
  if (!m) {
    if (sel === null || sel === undefined || sel === '') return null;
    throw new HttpError(400, 'E_VALIDATION', `sel must be document:<id>, passage:<id> or occurrence:<id> (got '${sel}').`, null, { field: 'sel' });
  }
  const id = Number(m[2]);
  return m[1].startsWith('doc') ? { doc: id } : m[1].startsWith('p') ? { passage: id } : { occ: id };
}

/**
 * GET /api/timeline/arcs. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'arcsQuery', args).
 *
 * C4 (contract 1.3.0): `mode` is 'individual' when at most 1,500 arcs fall in the requested range (items within the tier
 * budget, the rest bundled, as before) and 'summary' above: `buckets` count every arc per (lane pair, bin pair) by
 * evidence status — their n add up to `total` — and `individual` holds the ≤ 300 highest-priority arcs (touching the
 * selected item, documented first, nearest the vantage; also returned as `items`). `detail=1` over a range narrower than
 * 50 years returns individual arcs up to 1,500.
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, from?: number|null, to?: number|null, vantage?: number|null, ev?: string|null, limit?: number,
 *   tier?: string, rel_rev_cutoff?: number|string|null, rev_cutoff?: number|string|null, runs?: string|number[]|null,
 *   sel?: string|null, detail?: boolean, lanes?: string|string[]|null, summary_above?: number}} args from/to/vantage are
 *   astronomical years; the cutoffs and runs read a saved view "as saved"; `lanes` (the lane keys the Scroll shows, folded
 *   ones left out) ranks arcs between shown lanes first; summary_above (tests) moves the summary threshold
 * @returns {object} Arcs
 */
export function arcsQuery(db, { def, from = null, to = null, vantage = null, ev = null, limit = ARC_BUDGET, tier = 'L2',
  rel_rev_cutoff: relRev = null, rev_cutoff: annRev = null, runs = null, sel = null, detail = false, lanes = null,
  summary_above: summaryAbove = SUMMARY_ABOVE }) {
  const level = TIER_LEVEL[tier] ?? 2;
  const shownLanes = laneList(lanes);
  // 0 when both ends sit in lanes the Scroll shows, 1 for one end, 2 for none (an arc into a folded lane draws nothing)
  const offLanes = (a) => (shownLanes ? (shownLanes.has(a.src?.lane) ? 0 : 1) + (shownLanes.has(a.dst?.lane) ? 0 : 1) : 0);
  const evid = parseEvidence(ev);
  const relRevCutoff = cutoffParam(relRev, 'rel_rev_cutoff');
  const revCutoff = cutoffParam(annRev, 'rev_cutoff');
  const selected = parseSelection(sel);
  const detailed = Boolean(detail) && Number.isInteger(from) && Number.isInteger(to) && to - from < DETAIL_YEARS;
  const budget = detailed ? DETAIL_MAX : Math.max(0, Math.min(TIER_BUDGET[tier] ?? ARC_BUDGET, Number.isInteger(limit) ? limit : ARC_BUDGET));
  const strandDocs = strandDocIds(db, def);
  const rels = relationshipsTouching(db, [...strandDocs], { from, to, runs: runList(runs), relRevCutoff, columns: 'arcs' });
  const review = relRevCutoff === null ? (r) => r.review_status : reviewAsOf(db, rels.map((r) => r.id), relRevCutoff);
  const anns = reframingAnnotations(db, revCutoff);

  const end = endResolver(db, [...rels.flatMap((r) => [[r.src_type, r.src_ref], [r.dst_type, r.dst_ref]]),
    ...anns.flatMap((a) => [[a.target.type, a.target.ref], ...a.sources.map((s) => [s.type, s.ref])])]);
  const resolved = rels.map((r) => ({ r, s: end(r.src_type, r.src_ref), d: end(r.dst_type, r.dst_ref) }));
  const docIds = new Set();
  for (const { s, d } of resolved) { if (s) docIds.add(s.doc); if (d) docIds.add(d.doc); }
  for (const a of anns) {
    const t = end(a.target.type, a.target.ref);
    if (t) docIds.add(t.doc);
    for (const x of a.sources) { const e = end(x.type, x.ref); if (e) docIds.add(e.doc); }
  }
  const docs = sliceDocs(db, def, docIds);
  const groups = endGroups(db, def, [...docIds].filter((id) => strandDocs.has(id)));
  const touches = (e) => Boolean(selected && e && ((selected.doc !== undefined && e.doc === selected.doc)
    || (selected.passage !== undefined && e.passage === selected.passage) || (selected.occ !== undefined && e.occ === selected.occ)));

  const hidden = { budget: 0, kindred: 0, rejected: 0, filtered: 0, vantage: 0, outside: 0 };
  const shown = [];
  let candidates = 0;
  for (const { r, s, d } of resolved) {
    // drawn only where a strand is observed: one end must be a strand document
    if (!(s && strandDocs.has(s.doc)) && !(d && strandDocs.has(d.doc))) continue;
    candidates++;
    const type = REL_TYPE_BY_CODE[r.rel_type];
    const reviewStatus = review(r);
    if (HIDDEN_TYPES.has(r.rel_type) && !evid.kindred) { hidden.kindred++; continue; }
    if (reviewStatus === 'rejected' && !evid.rejected) { hidden.rejected++; continue; }
    if (!evid.statuses.has(r.evidence_status)) { hidden.filtered++; continue; }
    const sd = s && docs.get(s.doc), dd = d && docs.get(d.doc);
    if (!sd || !dd || sd.chrono_status !== 'dated' || dd.chrono_status !== 'dated') { hidden.outside++; continue; }
    const sy = sd.y_lo, dy = dd.y_lo;
    if (Number.isInteger(from) && Math.max(sy, dy) < from) { hidden.outside++; continue; }
    if (Number.isInteger(to) && Math.min(sy, dy) > to) { hidden.outside++; continue; }
    if (Number.isInteger(vantage) && Math.max(sy, dy) > vantage) { hidden.vantage++; continue; }
    // src is the later / dependent end: a precedence-requiring type whose dependent end is dated before its source
    const conflict = r.date_conflict === 1 || Boolean(type?.requires_precedence && sd.y_hi < dd.y_lo);
    const feedback = Boolean(type?.feedback_capable) && r.evidence_status !== 'computed' && !conflict;
    const item = {
      rel_id: r.id, rel_type: r.rel_type, family: type?.family ?? 'similarity', evidence_status: r.evidence_status,
      provenance_quality: r.provenance_quality, review_status: reviewStatus, cue: r.cue === 1,
      src: endJson(def, s, sd, groups), dst: endJson(def, d, dd, groups),
      feedback, date_conflict: conflict, synthetic: r.is_synthetic === 1, glyph: type?.glyph ?? null,
      directed: r.directed === 1,
    };
    if (r.run_id !== null) item.run_id = r.run_id;
    if (r.score !== null) item.score = { value: r.score, kind: r.score_kind };
    if (r.hypothesis_group_id !== null) item.hypothesis_group = r.hypothesis_group_id;
    if (r.origin === 'human') item.human = true;
    if (touches(s) || touches(d)) item.selected = true;
    const near = Number.isInteger(vantage) ? Math.abs(vantage - Math.max(sy, dy)) : 0;
    const off = offLanes(item);
    shown.push({ item, rank: [off, STATUS_RANK[r.evidence_status], -r.ev_rows, near, r.id],
      priority: [item.selected ? 0 : 1, off, STATUS_RANK[r.evidence_status], near, -r.ev_rows, r.id] });
  }
  const byRank = (key) => (a, b) => {
    for (let i = 0; i < a[key].length; i++) if (a[key][i] !== b[key][i]) return a[key][i] - b[key][i];
    return 0;
  };
  const total = shown.length;
  const summary = !detailed && total > summaryAbove;
  let items, bundles = [], buckets = null, bucketLevel = null;
  if (summary) {
    shown.sort(byRank('priority'));
    items = shown.slice(0, SUMMARY_INDIVIDUAL).map((x) => x.item);
    ({ buckets, level: bucketLevel } = bucketize(shown.map((x) => x.item), level));
    hidden.budget = total - items.length;
  } else {
    shown.sort(byRank('rank'));
    items = shown.slice(0, budget).map((x) => x.item);
    const rest = shown.slice(budget);
    hidden.budget = rest.length;
    bundles = bundle(rest.map((x) => x.item), tier, level);
  }

  const { annotated, annotationHalos } = annotationFeedback(def, anns, end, docs, strandDocs, vantage, groups);
  return {
    mode: summary ? 'summary' : 'individual',
    total, candidates, returned: items.length, hidden, items, bundles, budget: summary ? SUMMARY_INDIVIDUAL : budget,
    ...(summary ? { individual: items, buckets, bucket_level: bucketLevel, bucket_width: [1000, 100, 10, 1][bucketLevel],
      summary_note: `${total.toLocaleString('en')} arcs in this range: counted per lane pair and period by evidence status; the ${items.length} drawn individually are those touching the selection${shownLanes ? ', then those between the lanes shown' : ''}, documented first, nearest the vantage.` } : {}),
    ...(detailed ? { detail: true } : {}),
    chip: hidden.budget ? { count: hidden.budget, label: `+${hidden.budget} more arc${hidden.budget === 1 ? '' : 's'} (${summary ? 'summarized' : 'filtered'})` } : null,
    halos: halos(shown.map((x) => x.item).filter((a) => a.feedback), annotationHalos),
    annotated,
    scope: 'strands',
  };
}

/** The `lanes` parameter as a set of lane keys (comma-separated or an array; at most 200), or null. */
function laneList(lanes) {
  const list = (Array.isArray(lanes) ? lanes : typeof lanes === 'string' ? lanes.split(',') : []).map((k) => String(k).trim()).filter(Boolean);
  return list.length ? new Set(list.slice(0, 200)) : null;
}

/**
 * Summary buckets (C4): every arc counted once per (src lane, dst lane, src bin, dst bin) with its evidence status; bins
 * coarsen from the tier's level until at most MAX_BUCKETS remain.
 * @param {object[]} arcs
 * @param {number} level 0–3
 * @returns {{buckets: object[], level: number}}
 */
export function bucketize(arcs, level) {
  for (let lv = Math.min(3, Math.max(0, level)); ; lv--) {
    const groups = new Map();
    for (const a of arcs) {
      const sb = binOf(a.src.y, lv), db = binOf(a.dst.y, lv);
      const k = `${a.src.lane}|${a.dst.lane}|${sb}|${db}`;
      let g = groups.get(k);
      if (!g) {
        g = { src_lane: a.src.lane, dst_lane: a.dst.lane, src_bin: sb, dst_bin: db, n: 0, by_status: { documented: 0, computed: 0, proposed: 0 },
          feedback: 0, date_conflicts: 0, synthetic: false };
        groups.set(k, g);
      }
      g.n++;
      g.by_status[a.evidence_status]++;
      if (a.feedback) g.feedback++;
      if (a.date_conflict) g.date_conflicts++;
      if (a.synthetic) g.synthetic = true;
    }
    if (groups.size <= MAX_BUCKETS || lv === 0) {
      const w = [1000, 100, 10, 1][lv];
      const buckets = [...groups.values()].map((g) => ({ ...g, src_years: [g.src_bin * w, g.src_bin * w + w - 1], dst_years: [g.dst_bin * w, g.dst_bin * w + w - 1] }))
        // fully ordered (lane keys break ties), so the buckets never depend on the order the arcs were ranked in
        .sort((a, b) => b.n - a.n || a.src_bin - b.src_bin || a.dst_bin - b.dst_bin
          || String(a.src_lane).localeCompare(String(b.src_lane)) || String(a.dst_lane).localeCompare(String(b.dst_lane)));
      return { buckets, level: lv };
    }
  }
}

/** Bundles per (lane pair, bin pair) at the tier's level, width ∝ log₂(count + 1). */
function bundle(arcs, tier, level) {
  const groups = new Map();
  for (const a of arcs) {
    const bins = [binOf(a.src.y, level), binOf(a.dst.y, level)];
    const k = `${a.src.lane}|${a.dst.lane}|${bins[0]}|${bins[1]}`;
    let g = groups.get(k);
    if (!g) {
      g = { lanes: [a.src.lane, a.dst.lane], bins, tier, count: 0, status: {}, feedback: 0, date_conflicts: 0, synthetic: false };
      groups.set(k, g);
    }
    g.count++;
    g.status[a.evidence_status] = (g.status[a.evidence_status] ?? 0) + 1;
    if (a.feedback) g.feedback++;
    if (a.date_conflict) g.date_conflicts++;
    if (a.synthetic) g.synthetic = true;
  }
  return [...groups.values()].map((g) => ({ ...g, width: Math.round(Math.log2(g.count + 1) * 10) / 10,
    label: `${g.count} arc${g.count === 1 ? '' : 's'}` })).sort((a, b) => b.count - a.count);
}

/**
 * Annotated feedback arcs and halo contributions of reframing annotations whose target is a dated strand document
 * in the slice. An annotation counts once the vantage reaches the year it was written; its arc (from each later
 * evidence item in the slice) once the vantage also reaches that item.
 */
function annotationFeedback(def, anns, end, docs, strandDocs, vantage, groups = null) {
  const annotated = [], annotationHalos = [];
  for (const a of anns) {
    const t = end(a.target.type, a.target.ref);
    const td = t && docs.get(t.doc);
    if (!td || !strandDocs.has(t.doc) || td.chrono_status !== 'dated') continue;
    if (Number.isInteger(vantage) && a.year > vantage) continue;
    const dst = endJson(def, t, td, groups);
    let after = a.year;
    for (const x of a.sources) {
      const e = end(x.type, x.ref);
      const ed = e && docs.get(e.doc);
      if (!ed || ed.chrono_status !== 'dated' || !(ed.y_lo > td.y_hi)) continue;
      if (Number.isInteger(vantage) && ed.y_lo > vantage) continue;
      after = Math.min(after, ed.y_lo);
      annotated.push({ annotation: a.id, author: a.author, layer: a.layer, kind: 'annotation', label: 'annotated', feedback: true,
        evidence_status: 'proposed', src: endJson(def, e, ed, groups), dst, synthetic: a.synthetic || td.is_synthetic === 1 });
    }
    // the reading exists from the year it was written; a later item it cites dates the re-reading itself
    annotationHalos.push({ dst, after, visibleFrom: a.year, annotation: a.id, synthetic: a.synthetic || td.is_synthetic === 1 });
  }
  return { annotated, annotationHalos };
}

/**
 * Halos on earlier marks re-read by feedback: "re-read after 1994 (1 documented, 2 annotated)". Each source carries
 * the vantage year from which it counts (`visible_from`), so a client that applies the vantage itself can recount.
 */
function halos(feedbackArcs, annotationHalos) {
  const byDoc = new Map();
  const at = (dst) => {
    let h = byDoc.get(dst.doc);
    if (!h) {
      h = { doc: dst.doc, passages: [], y: dst.y, lane: dst.lane, after: null, documented: 0, proposed: 0, annotated: 0, synthetic: false,
        sources: [] };
      byDoc.set(dst.doc, h);
    }
    if (dst.passage && !h.passages.includes(dst.passage)) h.passages.push(dst.passage);
    return h;
  };
  for (const a of feedbackArcs) {
    const h = at(a.dst);
    h[a.evidence_status] += 1;
    h.after = h.after === null ? a.src.y : Math.min(h.after, a.src.y);
    h.sources.push({ kind: a.evidence_status, rel_id: a.rel_id, y: a.src.y, visible_from: a.src.y });
    if (a.synthetic) h.synthetic = true;
  }
  for (const x of annotationHalos) {
    const h = at(x.dst);
    h.annotated += 1;
    h.after = h.after === null ? x.after : Math.min(h.after, x.after);
    h.sources.push({ kind: 'annotated', annotation: x.annotation, y: x.after, visible_from: Math.max(x.after, x.visibleFrom) });
    if (x.synthetic) h.synthetic = true;
  }
  return [...byDoc.values()].map((h) => {
    const parts = [['documented', h.documented], ['proposed', h.proposed], ['annotated', h.annotated]].filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    return { ...h, label: `re-read after ${yearLabel(h.after)} (${parts.join(', ')})` };
  }).sort((a, b) => a.y - b.y || a.doc - b.doc);
}
