// OWNER: WP5
// classify.mjs — from verified reuse candidates to relationships (SPEC §4.7 table), and the writer for
// algorithm-made links. Every row written here has origin 'algorithm', a run id and a method; none is ever
// 'documented' (the §3 CHECKs refuse it anyway):
//
//  | situation                                              | rel_type                        | direction            | status   |
//  | both dated and A.hi_day < B.lo_day                     | exact_quotation / near_quotation | B → A                | computed |
//  | intervals overlap, or either undated                   | shared_wording                  | undirected           | computed |
//  | an attribution cue in B names A's author (or title)    | explicit_citation               | B → A                | proposed + citation_cue |
//  | B matches A and an earlier C that A also matches       | hypothesis group "Source of B's wording?" with B→A and B→C |  | computed |
//
// The 'create' revision of a run's rows is written when the run succeeds (writeCreateRevisions), so the rows of a
// cancelled or failed run carry no revision and gc-runs can remove them (relationship_revision is append-only).

import { REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { nowIso, stmt } from '../db/open.mjs';
import { makeAnchor } from '../provenance/anchors.mjs';

/** Methods recorded on computed rows. */
export const METHODS = Object.freeze({
  exact: 'winnow k=8 w=6 + seed-extend',
  near: 'minhash 128 / LSH 32×4 + Smith–Waterman (2/−1/−1)',
  traceExact: 'targeted trace: FTS phrase windows + seed-extend',
  traceNear: 'targeted trace: FTS 3-shingle candidates + Smith–Waterman (2/−1/−1)',
  traceNearLsh: 'targeted trace: LSH 32×4 lookup + Smith–Waterman (2/−1/−1)',
});

const dated = (d) => d && d.lo_day !== null && d.lo_day !== undefined && d.chrono_status === 'dated';

/**
 * Relationship type, direction and status of a verified candidate between two passages.
 * @param {{a: object, b: object, kind?: 'exact'|'near', score?: number|null}} candidate a and b are
 *   {passage, doc: {id, lo_day, hi_day, chrono_status, y_lo, y_hi}} for the two sides
 * @returns {{rel_type: string, src: object, dst: object, directed: 0|1, evidence_status: 'computed', score: {value: number, kind: string},
 *   swapped: boolean, direction_known: boolean}} src is the later/dependent side; `swapped` says src is `a`
 */
export function classifyCandidate({ a, b, kind = 'exact', score = null }) {
  const scoreObj = kind === 'exact' ? { value: 1, kind: 'match_ratio' } : { value: Math.round((score ?? 0) * 1000) / 1000, kind: 'alignment_score' };
  if (dated(a.doc) && dated(b.doc)) {
    if (a.doc.hi_day < b.doc.lo_day) {
      return { rel_type: kind === 'exact' ? 'exact_quotation' : 'near_quotation', src: b, dst: a, directed: 1,
        evidence_status: 'computed', score: scoreObj, swapped: false, direction_known: true };
    }
    if (b.doc.hi_day < a.doc.lo_day) {
      return { rel_type: kind === 'exact' ? 'exact_quotation' : 'near_quotation', src: a, dst: b, directed: 1,
        evidence_status: 'computed', score: scoreObj, swapped: true, direction_known: true };
    }
  }
  // overlapping or missing dates: shared wording, direction unknown (canonical order: higher passage id first)
  const [src, dst] = a.passage > b.passage ? [a, b] : [b, a];
  return { rel_type: 'shared_wording', src, dst, directed: 0, evidence_status: 'computed', score: scoreObj, swapped: src === a,
    direction_known: false };
}

/** Whether the stated order is impossible by the dates (the later item is certainly earlier). */
export function dateConflict(relType, srcDoc, dstDoc) {
  const t = REL_TYPE_BY_CODE[relType];
  return t?.requires_precedence && srcDoc?.y_hi !== null && srcDoc?.y_hi !== undefined && dstDoc?.y_lo !== null &&
    dstDoc?.y_lo !== undefined && srcDoc.y_hi < dstDoc.y_lo ? 1 : 0;
}

/**
 * Insert one algorithm-made relationship with its evidence spans (anchored, D18). No revision yet.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{rel_type: string, evidence_status: 'computed'|'proposed', src: {passage: number, doc: object}, dst: {passage: number, doc: object},
 *   directed: 0|1, score?: {value: number, kind: string}|null, method: string, runId: number, groupId?: number|null,
 *   evidence: Array<{role: string, passage: number|null, doc: object, field?: string, start: number, end: number, text: string, sha?: string, detail?: object}>}} rel
 * @returns {number} relationship id
 */
export function insertAlgorithmRelationship(db, rel) {
  const at = nowIso();
  const synthetic = rel.src.doc.is_synthetic || rel.dst.doc.is_synthetic ? 1 : 0;
  const id = Number(stmt(db, `INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      provenance_quality, method, run_id, created_by, review_status, score, score_kind, date_conflict, src_year, dst_year,
      hypothesis_group_id, is_synthetic, current_rev, created_at)
    VALUES (?, 'passage', ?, 'passage', ?, ?, ?, 'algorithm', 'complete', ?, ?, ?, 'unreviewed', ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(rel.rel_type, String(rel.src.passage), String(rel.dst.passage), rel.directed, rel.evidence_status, rel.method, rel.runId,
      `run:${rel.runId}`, rel.score?.value ?? null, rel.score?.kind ?? null, dateConflict(rel.rel_type, rel.src.doc, rel.dst.doc),
      rel.src.doc.y_lo ?? null, rel.dst.doc.y_lo ?? null, rel.groupId ?? null, synthetic, at).lastInsertRowid);
  const ins = stmt(db, `INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off, anchor_json, detail_json,
    added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const ev of rel.evidence ?? []) {
    const anchor = makeAnchor(ev.text, { field: ev.field ?? 'body', start: ev.start, end: ev.end }, { docId: ev.doc.id, sha: ev.sha ?? null });
    ins.run(id, ev.passage, ev.role, ev.start, ev.end, JSON.stringify(anchor), ev.detail ? JSON.stringify(ev.detail) : null, `run:${rel.runId}`, at);
  }
  return id;
}

/**
 * Write the 'create' revision of every row of a run that has none yet (call when the run succeeds).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @returns {number} revisions written
 */
export function writeCreateRevisions(db, runId) {
  return Number(stmt(db, `INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, before_json, after_json, reason)
    SELECT r.id, 1, r.created_by, ?, 'create', NULL,
      json_object('rel_type', r.rel_type, 'src', r.src_type || ':' || r.src_ref, 'dst', r.dst_type || ':' || r.dst_ref,
        'evidence_status', r.evidence_status, 'origin', r.origin, 'method', r.method, 'run_id', r.run_id,
        'score', CASE WHEN r.score IS NULL THEN NULL ELSE json_object('value', r.score, 'kind', r.score_kind) END), NULL
    FROM relationship r WHERE r.run_id = ? AND NOT EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id)`)
    .run(nowIso(), runId).changes);
}

/**
 * Hypothesis groups for a run (§4.7 last row): when a later passage B is linked to two sources A and C and A is
 * itself linked to C, B's wording has competing explanations; both links join a group "Source of B's wording?".
 * Only directed quotation links of the run are considered.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @returns {number[]} group ids created
 */
export function groupCompetingSources(db, runId) {
  const rels = stmt(db, `SELECT id, src_ref, dst_ref, is_synthetic FROM relationship WHERE run_id = ? AND directed = 1
    AND rel_type IN ('exact_quotation', 'near_quotation') AND hypothesis_group_id IS NULL`).all(runId);
  const out = new Map();
  for (const r of rels) {
    if (!out.has(r.src_ref)) out.set(r.src_ref, []);
    out.get(r.src_ref).push(r);
  }
  const linked = new Set(rels.map((r) => `${r.src_ref}>${r.dst_ref}`));
  const created = [];
  for (const [src, list] of out) {
    if (list.length < 2) continue;
    const members = new Set();
    for (const x of list) for (const y of list) if (x !== y && linked.has(`${x.dst_ref}>${y.dst_ref}`)) { members.add(x); members.add(y); }
    if (members.size < 2) continue;
    const doc = stmt(db, 'SELECT d.title FROM passage p JOIN document d ON d.id = p.document_id WHERE p.id = ?').get(Number(src));
    const question = `Source of the wording in “${doc?.title ?? `passage ${src}`}”?`;
    const synthetic = [...members].some((m) => m.is_synthetic) ? 1 : 0;
    const gid = Number(stmt(db, `INSERT INTO hypothesis_group (target_type, target_ref, question, created_by, is_synthetic, created_at)
      VALUES ('passage', ?, ?, ?, ?, ?)`).run(src, question, `run:${runId}`, synthetic, nowIso()).lastInsertRowid);
    const upd = stmt(db, 'UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?');
    for (const m of members) upd.run(gid, m.id);
    created.push(gid);
  }
  return created;
}

// ── candidate inputs ────────────────────────────────────────────────────────────────────────────────

/** Document columns the classification needs. */
export const DOC_COLUMNS = 'd.id, d.collection_id, d.title, d.author, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.chrono_status, d.dup_of, d.is_synthetic, d.lang_text, d.date_label';
