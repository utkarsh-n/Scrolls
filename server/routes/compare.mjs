// OWNER: WP4
// routes/compare.mjs — POST /api/compare → Compare (heavy; SPEC §2.E, §7.2).
//
// The comparison runs in the read pool (compareQuery), so a slow one never stalls the server; a query over
// 5 s answers 503 QUERY_TIMEOUT. The handler keeps the multiplicity log (compare_log) on the main
// connection: k counts the distinct comparisons of these expressions in this session (X-Scrolls-Session),
// including this one, and the log write never waits on a job's write lock.

import { normalizeCompareRequest } from '../analysis/compare.mjs';
import { comparisonHash, expressionKey, priorComparisons, recordComparison } from '../analysis/multiplicity.mjs';
import { HttpError } from '../http/errors.mjs';

const COMPARE_URL = new URL('../analysis/compare.mjs', import.meta.url).href;
/** Session id used when a client sends no X-Scrolls-Session header. */
export const NO_SESSION = 'no-session';

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
    method: 'POST',
    path: '/api/compare',
    heavy: true,
    async handler(req, ctx) {
      const request = normalizeCompareRequest(req.body);
      const session = req.sessionId ?? NO_SESSION;
      const key = expressionKey(request.expr);
      const hash = comparisonHash(request);
      const prior = priorComparisons(ctx.db, session, key);
      const isNew = !prior.has(hash);
      let notable = 0;
      for (const [h, c] of prior) if (h !== hash && c > 0) notable++;
      const payload = await ctx.pool.run(COMPARE_URL, 'compareQuery',
        { ...request, multiplicity: { k: prior.size + (isNew ? 1 : 0), notable_so_far: notable } }).catch(timeoutCopy('comparison'));
      if (isNew) {
        const notableNow = payload.measures.filter((m) => m.verdict === 'notable').length;
        recordComparison(ctx.db, { sessionId: session, key, requestHash: hash, measures: request.measures, notableCount: notableNow });
      }
      return { json: payload };
    },
  },
];
