// OWNER: WP5
// carry.mjs — human review survives a re-run (SPEC D7, §2.C). A rerun of the reuse index writes new rows and
// supersedes the old run, whose rows then leave the default views. What people decided about those rows must not
// vanish with them: each review (confirm / reject / dispute / retract), attached evidence span and regrouping by a
// person is appended to the new run's link between the same two passages as a new revision by the same actor, citing
// the original note's annotation and the row it came from. Evidence status is never touched (the line keeps its
// pattern); the old rows keep their full history and stay reachable from views that pinned their run.

import { nowIso, stmt } from '../db/open.mjs';
import { appendRelRevision } from '../provenance/relationships.mjs';
import { reviewStatusOf } from '../provenance/reviews.mjs';

const CARRIED = Object.freeze(['confirm', 'reject', 'dispute', 'retract', 'add_evidence', 'regroup']);
const REVIEW = new Set(['confirm', 'reject', 'dispute', 'retract']);

/** Links between the same two passages match when both are citations or both are reuse (exact/near/shared wording). */
const pairKey = (r) => {
  const kind = r.rel_type === 'explicit_citation' ? 'cite' : 'reuse';
  const [a, b] = [`${r.src_type}:${r.src_ref}`, `${r.dst_type}:${r.dst_ref}`].sort();
  return `${kind}|${a}|${b}`;
};

/**
 * Carry people's decisions from rows of superseded runs to the new run's matching rows (call inside the
 * transaction that supersedes them).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{fromRuns: number[], toRun: number}} runs
 * @returns {{reviews_carried: number, links: number, not_found: number, not_found_ids: number[]}}
 */
export function carryReviews(db, { fromRuns, toRun }) {
  const out = { reviews_carried: 0, links: 0, not_found: 0, not_found_ids: [] };
  if (!fromRuns.length) return out;
  const old = stmt(db, `SELECT r.* FROM relationship r WHERE r.run_id IN (SELECT value FROM json_each(?)) AND EXISTS (
      SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id AND v.actor LIKE 'human:%'
        AND v.action IN (SELECT value FROM json_each(?))) ORDER BY r.id`).all(JSON.stringify(fromRuns), JSON.stringify(CARRIED));
  if (!old.length) return out;
  const fresh = new Map();
  for (const r of stmt(db, 'SELECT * FROM relationship WHERE run_id = ?').all(toRun)) {
    const k = pairKey(r);
    // prefer the row of the same type when a pair has several
    if (!fresh.has(k) || r.rel_type === fresh.get(k).rel_type) fresh.set(k, r);
  }
  const relRow = stmt(db, 'SELECT * FROM relationship WHERE id = ?');
  const revisionsOf = stmt(db, 'SELECT * FROM relationship_revision WHERE relationship_id = ? ORDER BY rev');
  const evidenceRow = stmt(db, 'SELECT * FROM relationship_evidence WHERE id = ?');
  const insertEvidence = stmt(db, `INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off, anchor_json,
    detail_json, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const o of old) {
    const target = fresh.get(pairKey(o));
    if (!target) {
      out.not_found++;
      if (out.not_found_ids.length < 50) out.not_found_ids.push(o.id);
      continue;
    }
    let carriedHere = 0;
    for (const v of revisionsOf.all(o.id)) {
      if (!v.actor.startsWith('human:') || !CARRIED.includes(v.action)) continue;
      const rel = relRow.get(target.id);
      const from = { relationship: o.id, rev: v.rev, run: o.run_id };
      const reason = v.reason ?? null;
      const at = nowIso();
      if (REVIEW.has(v.action)) {
        const prior = revisionsOf.all(rel.id).map((x) => ({ actor: x.actor, action: x.action }));
        const next = reviewStatusOf([...prior, { actor: v.actor, action: v.action }]);
        appendRelRevision(db, rel, { actor: v.actor, action: v.action, at, reason, annotationId: v.annotation_id ?? null, reviewStatus: next,
          before: { review_status: rel.review_status }, after: { review_status: next, carried_from: from } });
      } else if (v.action === 'add_evidence') {
        const after = JSON.parse(v.after_json ?? '{}');
        const ev = after.evidence_id ? evidenceRow.get(after.evidence_id) : null;
        if (!ev) continue;
        const evId = Number(insertEvidence.run(rel.id, ev.passage_id, ev.role, ev.start_off, ev.end_off, ev.anchor_json, ev.detail_json,
          ev.added_by, at).lastInsertRowid);
        appendRelRevision(db, rel, { actor: v.actor, action: 'add_evidence', at, reason, after: { ...after, evidence_id: evId, carried_from: from } });
      } else {
        const after = JSON.parse(v.after_json ?? '{}');
        const group = after.hypothesis_group ?? null;
        if (group === null || (rel.hypothesis_group_id !== null && rel.hypothesis_group_id !== group)) continue;
        stmt(db, 'UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?').run(group, rel.id);
        appendRelRevision(db, rel, { actor: v.actor, action: 'regroup', at, reason,
          before: { hypothesis_group: rel.hypothesis_group_id ?? null }, after: { hypothesis_group: group, carried_from: from } });
      }
      carriedHere++;
    }
    if (carriedHere) { out.links++; out.reviews_carried += carriedHere; }
  }
  return out;
}
