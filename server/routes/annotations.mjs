// OWNER: WP5
// routes/annotations.mjs — the interpretation notebook (SPEC §2.F, §7.1): append-only annotations.
//
//   GET   /api/annotations?target=&include=&as_of=&rev_cutoff=&kind=&author=&layer=&tag=&dimension=&contradicted=&from=&to=
//         &machine=&doc=&q=&limit=&cursor=                                                                  → Annotations
//   POST  /api/annotations                       → AnnotationRev
//   PATCH /api/annotations/:id                   → AnnotationRev (a new revision)
//   POST  /api/annotations/:id/reinterpret       → AnnotationReinterpreted
//   POST  /api/annotations/:id/withdraw          → AnnotationRev (+ status 'withdrawn')
//   GET   /api/annotations/:id/revisions         → AnnotationRevisions
// Interactive writes run on the main connection in short BEGIN IMMEDIATE transactions (§4.12).

import {
  annotationRevisions, createAnnotation, listAnnotations, reinterpretAnnotation, reviseAnnotation, withdrawAnnotation,
} from '../provenance/annotations.mjs';
import { HttpError } from '../http/errors.mjs';

const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'E_BAD_ID', `'${req.params.id}' is not an annotation id.`);
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
  { method: 'GET', path: '/api/annotations', handler: async (req, ctx) => ({ json: listAnnotations(ctx.db, req.query) }) },
  { method: 'POST', path: '/api/annotations',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => createAnnotation(db, bodyOf(req))) }) },
  { method: 'PATCH', path: '/api/annotations/:id',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => reviseAnnotation(db, idOf(req), bodyOf(req))) }) },
  { method: 'POST', path: '/api/annotations/:id/reinterpret',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => reinterpretAnnotation(db, idOf(req), bodyOf(req))) }) },
  { method: 'POST', path: '/api/annotations/:id/withdraw',
    handler: async (req, ctx) => ({ json: ctx.withWrite((db) => withdrawAnnotation(db, idOf(req), req.body ?? {})) }) },
  { method: 'GET', path: '/api/annotations/:id/revisions', handler: async (req, ctx) => ({ json: annotationRevisions(ctx.db, idOf(req)) }) },
];
