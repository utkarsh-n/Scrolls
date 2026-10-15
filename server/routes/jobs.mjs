// OWNER: WP0 — jobs API (SPEC §7.1, §7.2): list, get, per-job SSE stream, cancel

import { JOB_STATUS } from '../../src/shared/vocab.mjs';
import { badRequest, notFound } from '../http/errors.mjs';
import { decodeCursor, encodeCursor, limitParam } from '../http/router.mjs';
import { openSse } from '../http/sse.mjs';
import { toJobJson } from '../jobs/queue.mjs';

const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

function jobId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('E_BAD_ID', `'${params.id}' is not a job id.`, 'Job ids are positive integers.');
  return id;
}

const progressEvent = (row) => ({ job: row.id, type: row.type, phase: row.phase ?? null, fraction: row.progress ?? 0,
  message: row.message ?? null, counts: toJobJson(row).counts, status: row.status });
const doneEvent = (row) => ({ job: row.id, status: row.status, run_id: row.run_id ?? null, error: toJobJson(row).error });

export const routes = [
  {
    method: 'GET',
    path: '/api/jobs',
    async handler(req, ctx) {
      const status = req.query.status || null;
      if (status && !JOB_STATUS.includes(status)) {
        throw badRequest('E_BAD_STATUS', `Unknown job status '${status}'.`, `Use one of ${JOB_STATUS.join(', ')}.`);
      }
      const limit = limitParam(req.query, { max: 200, dflt: 50 });
      const before = decodeCursor(req.query.cursor)?.before ?? null;
      const rows = ctx.jobs.list({ status, limit, beforeId: before });
      const cursor = rows.length === limit ? encodeCursor({ before: rows[rows.length - 1].id }) : null;
      return { json: { items: rows.map(toJobJson), cursor }, etag: false };
    },
  },
  {
    method: 'GET',
    path: '/api/jobs/:id',
    async handler(req, ctx) {
      const row = ctx.jobs.get(jobId(req.params));
      if (!row) throw notFound(`Job ${req.params.id}`);
      return { json: toJobJson(row), etag: false };
    },
  },
  {
    method: 'GET',
    path: '/api/jobs/:id/events',
    sse: true,
    async handler(req, ctx) {
      const id = jobId(req.params);
      const row = ctx.jobs.get(id);
      if (!row) throw notFound(`Job ${req.params.id}`);
      return {
        stream(res) {
          const sse = openSse(res);
          if (FINAL.has(row.status)) {
            sse.send('done', doneEvent(row));
            sse.close();
            return;
          }
          sse.send('progress', progressEvent(row));
          const off = ctx.jobs.onEvent((ev) => {
            if (ev.job !== id) return;
            if (ev.event === 'done') {
              sse.send('done', { job: id, status: ev.status, run_id: ev.run_id ?? null, error: ev.error ?? null });
              sse.close();
            } else {
              sse.send('progress', { job: id, type: ev.type, phase: ev.phase ?? null, fraction: ev.fraction ?? 0,
                message: ev.message ?? null, counts: ev.counts ?? null, status: ev.status });
            }
          });
          sse.onClose(off);
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/jobs/:id/cancel',
    async handler(req, ctx) {
      return { json: { status: ctx.jobs.cancel(jobId(req.params)) } };
    },
  },
];
