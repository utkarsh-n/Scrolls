// OWNER: WP5
// routes/hypotheses.mjs — competing hypothesis groups (SPEC §2.C).
//
//   GET  /api/hypothesis-groups/:id   → HypothesisGroup
//   POST /api/hypothesis-groups       → Created ({ target, question, relationships? })

import { createHypothesisGroup, getHypothesisGroup } from '../lineage/hypotheses.mjs';
import { HttpError } from '../http/errors.mjs';

const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'E_BAD_ID', `'${req.params.id}' is not a hypothesis group id.`);
  return n;
};

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'GET', path: '/api/hypothesis-groups/:id', handler: async (req, ctx) => ({ json: getHypothesisGroup(ctx.db, idOf(req)) }) },
  { method: 'POST', path: '/api/hypothesis-groups', handler: async (req, ctx) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new HttpError(400, 'E_VALIDATION', 'Send a JSON object (Content-Type: application/json).', null, { field: null });
    }
    return { json: ctx.withWrite((db) => createHypothesisGroup(db, req.body)) };
  } },
];
