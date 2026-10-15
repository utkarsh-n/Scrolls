// OWNER: WP4
// routes/collocations.mjs — GET /api/collocations?expr=&slice=lo-hi&f=&tr=…&stop=1&limit= → Collocations
// (heavy; SPEC §4.6, §7.1). Collocates or the gate, computed in the read pool.

import { HttpError } from '../http/errors.mjs';
import { limitParam } from '../http/router.mjs';

const COLLOCATIONS_URL = new URL('../analysis/collocations.mjs', import.meta.url).href;
const TOGGLES = ['tr', 'ds', 'ap', 'dup', 'nm', 'est', 'bp'];

/** The §7.2 fixture wording for a heavy read stopped by the read pool. */
function timeoutCopy(what) {
  return (err) => {
    if (err?.code !== 'QUERY_TIMEOUT') throw err;
    throw new HttpError(503, 'QUERY_TIMEOUT', `The ${what} took longer than 5 s and was stopped.`,
      'Narrow the time range or add a filter, then retry.', { timeout_ms: err.detail?.timeoutMs ?? 5000 });
  };
}

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/collocations',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query;
      const toggles = Object.fromEntries(TOGGLES.filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
      const body = await ctx.pool.run(COLLOCATIONS_URL, 'collocationsQuery', {
        expr: q.expr, slice: q.slice, f: q.f ?? '', toggles, stop: q.stop, corpus: q.corpus || null,
        seed: q.seed, lane: q.lane, limit: limitParam(q, { max: 200, dflt: 100 }),
      }).catch(timeoutCopy('collocation query'));
      return { json: body };
    },
  },
];
