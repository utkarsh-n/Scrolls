// OWNER: WP4
// tasks/layout.mjs — job 'layout': store constellation positions in layout_cache (SPEC §2.B). writes and
// priority come from vocab.JOB_TYPES.
//
// params: {write: {key, positions, generation, seed, replace?}} — positions a read worker computed while the
// writer was busy (routes/constellation.mjs) — or {request: <GET /api/constellation query>} to compute a
// constellation's layout ahead of time. Cached nodes are never moved; only an explicit re-layout (a newer
// generation with replace) replaces them.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { constellationQuery, writeLayoutCache } from '../../analysis/layout.mjs';
import { tx } from '../../db/open.mjs';
import { HttpError } from '../../http/errors.mjs';
import { retryBusy } from '../../analysis/commit.mjs';

export const type = 'layout';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{write?: object, request?: object}} params
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params = {}) {
  let write = params.write ?? null;
  if (!write && params.request && typeof params.request === 'object') {
    ctx.progress(0.1, 'layout', 'computing the constellation');
    const body = constellationQuery(ctx.db, params.request);
    write = body.cache_write;
    if (!write) return { key: body.layout.key, stored: 0, note: 'every node already had a cached position' };
  }
  if (!write || typeof write.key !== 'string' || !write.positions || typeof write.positions !== 'object') {
    throw new HttpError(400, 'E_VALIDATION', 'A layout job needs {write: {key, positions, generation, seed}} or {request}.');
  }
  ctx.checkpoint();
  const res = retryBusy(() => tx(ctx.db, () => writeLayoutCache(ctx.db, { key: write.key, positions: write.positions,
    generation: Number(write.generation) || 0, seed: Number(write.seed) || 0, replace: Boolean(write.replace) })), { checkpoint: () => ctx.checkpoint() });
  ctx.progress(1, 'layout', `${res.stored} positions`);
  return { key: write.key, ...res };
}
