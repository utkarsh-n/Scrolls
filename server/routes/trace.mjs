// OWNER: WP5
// routes/trace.mjs — targeted quotation trace (SPEC §4.7, §7.1).
//
//   POST /api/trace { passage, start, end, relative? } → Trace
// The search and its writes run as a 'trace' job (a worker thread, never the HTTP loop); the request waits up to
// 1.5 s for it and otherwise returns { status: 'running', job: { id } } while the job continues.

import { HttpError } from '../http/errors.mjs';
import { checkTraceRequest } from '../lineage/trace.mjs';

const SYNC_MS = 1500;

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'POST', path: '/api/trace', heavy: true, handler: async (req, ctx) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'E_VALIDATION', 'Send { passage, start, end } as JSON.', null, { field: null });
    }
    checkTraceRequest(ctx.db, body); // 400 / 404 at once, before a job is queued
    const params = { passage: Number(body.passage), start: body.start, end: body.end, relative: body.relative === true };
    const id = ctx.jobs.enqueue('trace', params);
    const row = await ctx.jobs.waitFor(id, { timeoutMs: SYNC_MS });
    if (!row) return { json: { status: 'running', job: { id }, note: `The trace continues as job ${id}.` } };
    if (row.status === 'succeeded') return { json: JSON.parse(row.result_json) };
    const err = JSON.parse(row.error_json ?? 'null');
    if (row.status === 'cancelled') throw new HttpError(409, 'E_CANCELLED', `Trace job ${id} was cancelled.`);
    throw new HttpError(err?.code === 'E_VALIDATION' ? 400 : 500, err?.code ?? 'E_TRACE_FAILED', err?.message ?? `Trace job ${id} failed.`,
      err?.hint ?? null, { job: id });
  } },
];
