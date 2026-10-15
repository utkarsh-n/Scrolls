// OWNER: WP5
// routes/relationships.mjs — edge cards, human proposals, review and evidence (SPEC §2.C, §7.1, D7).
//
//   GET  /api/relationships/:id            → Relationship (edge card)
//   POST /api/relationships                → Created  (server-forced: evidence_status 'proposed', origin 'human')
//   POST /api/relationships/:id/review     → Review   (confirm | reject | dispute, note ≥ 10 characters;
//                                                      evidence_status never changes)
//   POST /api/relationships/:id/evidence   → Created  (appends an 'add_evidence' revision)

import { attachEvidence, proposeRelationship, relationshipCard } from '../provenance/relationships.mjs';
import { reviewRelationship } from '../provenance/reviews.mjs';
import { HttpError } from '../http/errors.mjs';

const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'E_BAD_ID', `'${req.params.id}' is not a relationship id.`);
  return n;
};
const bodyOf = (req) => {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'E_VALIDATION', 'Send a JSON object (Content-Type: application/json).', null, { field: null });
  }
  return req.body;
};

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'GET', path: '/api/relationships/:id', handler: async (req, ctx) => ({ json: relationshipCard(ctx.db, idOf(req)) }) },
  { method: 'POST', path: '/api/relationships',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => proposeRelationship(db, bodyOf(req))) }) },
  { method: 'POST', path: '/api/relationships/:id/review',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => reviewRelationship(db, idOf(req), bodyOf(req))) }) },
  { method: 'POST', path: '/api/relationships/:id/evidence',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => attachEvidence(db, idOf(req), bodyOf(req))) }) },
];
