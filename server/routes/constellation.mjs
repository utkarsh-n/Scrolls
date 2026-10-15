// OWNER: WP4
// routes/constellation.mjs — GET /api/constellation?strands=&a=lo-hi&b=lo-hi&size=&edges=&max_nodes=&max_edges=&expand=
//   &relayout=1&runs=expr:run,…&corpus=&tr=…  → Constellation (heavy; SPEC §2.B, §7.1).
//
// Nodes and edges are computed in the read pool (analysis/layout.mjs constellationQuery). Positions of new
// nodes are stored in layout_cache on the main connection (a short write that never moves a cached node);
// when the writer is busy the write goes to a 'layout' job instead, and the positions already returned stay
// the ones the client shows.

import { log } from '../config.mjs';
import { isBusyError } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { writeLayoutCache } from '../analysis/layout.mjs';

const LAYOUT_URL = new URL('../analysis/layout.mjs', import.meta.url).href;
const TOGGLES = ['tr', 'ds', 'ap', 'dup', 'nm', 'est', 'bp'];
// On a STEMM-loaded database the first constellation per read worker builds its slice caches: 1.3 s warm, but over
// 5 s cold on a loaded machine (final gate), so it gets the timeline query's limit.
const TIMEOUT_MS = 15000;

function timeout(err) {
  if (err?.code !== 'QUERY_TIMEOUT') throw err;
  throw new HttpError(503, 'QUERY_TIMEOUT', `The constellation query took longer than ${TIMEOUT_MS / 1000} s and was stopped.`,
    'Narrow the time range or add a filter, then retry.', { timeout_ms: err.detail?.timeoutMs ?? TIMEOUT_MS });
}

/**
 * Persist positions computed by a read worker: on the main connection, or through a 'layout' job when the
 * writer is busy. Never throws (the response already carries the positions).
 * @param {object} ctx RouteCtx
 * @param {object} write cache_write of constellationQuery
 * @returns {'stored'|'queued'|'failed'}
 */
export function persistLayout(ctx, write) {
  try {
    ctx.withWrite((db) => writeLayoutCache(db, write));
    return 'stored';
  } catch (err) {
    if (isBusyError(err) || err?.code === 'E_BUSY') {
      try { ctx.jobs.enqueue('layout', { write }); return 'queued'; } catch { /* fall through */ }
    }
    log('warn', 'constellation: layout cache write failed', { error: String(err?.message ?? err) });
    return 'failed';
  }
}

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/constellation',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query;
      const toggles = Object.fromEntries(TOGGLES.filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
      const body = await ctx.pool.run(LAYOUT_URL, 'constellationQuery', {
        strands: q.strands ?? q.expr, a: q.a, b: q.b, size: q.size, edges: q.edges, max_nodes: q.max_nodes, max_edges: q.max_edges,
        toggles, corpus: q.corpus || null, expand: q.expand, relayout: q.relayout, runs: q.runs, rev_cutoff: q.rev_cutoff,
      }, { timeoutMs: TIMEOUT_MS }).catch(timeout);
      const write = body.cache_write;
      delete body.cache_write;
      if (write) body.layout.cache = persistLayout(ctx, write);
      return { json: body };
    },
  },
];
