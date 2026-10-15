// OWNER: WP5
// routes/views.mjs — immutable saved views (SPEC D17, §7.2).
//
//   POST   /api/views          → ViewSaved   (re-saving from a view: { parent_slug } → '<slug>~2')
//   GET    /api/views          → Views       (newest first; ?q= filters by name)
//   GET    /api/views/:slug    → View        (?as=1: "as saved" — pinned imports, runs and revision cutoffs)
//   DELETE /api/views/:slug    → 204         (soft: the link stops resolving, the row stays)

import { deleteView, getView, listViews, saveView } from '../provenance/views.mjs';
import { HttpError } from '../http/errors.mjs';

const bodyOf = (req) => {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'E_VALIDATION', 'Send a JSON object (Content-Type: application/json).', null, { field: null });
  }
  return req.body;
};

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'POST', path: '/api/views', handler: async (req, ctx) => ({ json: ctx.withWrite((db) => saveView(db, bodyOf(req))) }) },
  { method: 'GET', path: '/api/views', handler: async (req, ctx) => ({ json: listViews(ctx.db, req.query) }) },
  { method: 'GET', path: '/api/views/:slug',
    handler: async (req, ctx) => ({ json: getView(ctx.db, req.params.slug, { asSaved: req.query.as === '1' }) }) },
  { method: 'DELETE', path: '/api/views/:slug',
    handler: async (req, ctx) => { ctx.withWrite((db) => deleteView(db, req.params.slug)); return { status: 204 }; } },
];
