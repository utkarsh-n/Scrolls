// OWNER: WP5
// reviews.mjs — the human review layer (SPEC D7, I3, §2.F): confirm / reject / dispute. A review writes an
// annotation (confirm → evidence_for; reject → evidence_against; dispute → evidence_against with stance
// 'alternative') and a relationship_revision, then recomputes review_status from each reviewer's latest
// decision. evidence_status never changes: the §3 trigger refuses any UPDATE of it.

import { check } from '../../src/shared/contracts.mjs';
import { nowIso, stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { createAnnotation } from './annotations.mjs';
import { appendRelRevision, authorName, checkNote, humanActor, relationshipRow } from './relationships.mjs';

const REVIEW_ACTIONS = Object.freeze(['confirm', 'reject', 'dispute']);
const ANNOTATION_FOR = Object.freeze({
  confirm: { kind: 'evidence_for', stance: 'supports' },
  reject: { kind: 'evidence_against', stance: 'contradicts' },
  dispute: { kind: 'evidence_against', stance: 'alternative' },
});

/**
 * Review status from each reviewer's latest decision: disputed when anyone disputes or when confirmations
 * and rejections coexist; confirmed when there are only confirmations; rejected when only rejections.
 * @param {Array<{actor: string, action: string}>} revisions in rev order
 * @returns {'unreviewed'|'confirmed'|'rejected'|'disputed'}
 */
export function reviewStatusOf(revisions) {
  const latest = new Map();
  for (const r of revisions) {
    if (REVIEW_ACTIONS.includes(r.action)) latest.set(r.actor, r.action);
    else if (r.action === 'retract') latest.delete(r.actor);
  }
  let confirms = 0, rejects = 0, disputes = 0;
  for (const a of latest.values()) {
    if (a === 'confirm') confirms++;
    else if (a === 'reject') rejects++;
    else disputes++;
  }
  if (disputes > 0 || (confirms > 0 && rejects > 0)) return 'disputed';
  if (confirms > 0) return 'confirmed';
  if (rejects > 0) return 'rejected';
  return 'unreviewed';
}

/**
 * POST /api/relationships/:id/review { action, note (≥ 10 characters), author? }.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @param {{action: string, note: string, author?: string}} body
 * @returns {{review_status: string, revision: number, annotation_id: number, evidence_status: string}}
 */
export function reviewRelationship(db, id, body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'E_VALIDATION', 'Send a JSON object.', null, { field: null });
  if (!REVIEW_ACTIONS.includes(body.action)) {
    throw new HttpError(400, 'E_VALIDATION', `action must be one of ${REVIEW_ACTIONS.join(', ')}.`, null, { field: 'action' });
  }
  const note = checkNote(body.note);
  if (check('ReviewRequest', { action: body.action, note }).length) {
    throw new HttpError(400, 'E_VALIDATION', 'A review note needs at least 10 characters.', 'Say what you checked.', { field: 'note', min: 10 });
  }
  const author = authorName(body.author);
  const actor = humanActor(author);
  return tx(db, () => {
    const rel = relationshipRow(db, id);
    const { kind, stance } = ANNOTATION_FOR[body.action];
    const ann = createAnnotation(db, { target: { type: 'relationship', ref: String(rel.id) }, kind, stance, body_md: note, author });
    const revs = stmt(db, 'SELECT actor, action FROM relationship_revision WHERE relationship_id = ? ORDER BY rev').all(rel.id);
    const next = reviewStatusOf([...revs, { actor, action: body.action }]);
    const rev = appendRelRevision(db, rel, {
      actor, action: body.action, at: nowIso(), reason: note, annotationId: ann.id, reviewStatus: next,
      before: { review_status: rel.review_status }, after: { review_status: next },
    });
    const evidence = stmt(db, 'SELECT evidence_status FROM relationship WHERE id = ?').get(rel.id).evidence_status;
    return { review_status: next, revision: rev, annotation_id: ann.id, evidence_status: evidence };
  });
}
