// OWNER: WP4
// tasks/collocations.mjs — job 'collocations': collocation tables for an expression and slice (SPEC §4.6).
// params: {expr: number[], slice: {years: [lo, hi], f}, toggles?, corpus?}.
//
// Computes what GET /api/collocations computes, without the read pool's time limit (slices too large to
// tokenize within a request and without current token streams), and stores every significant collocate —
// stop-words included, the endpoint hides them — in `collocation` under a run. An identical succeeded run
// (same params and input fingerprint) is reused.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { collocates, collocationRunParams, COLLOCATIONS_VERSION, leadingModality, sliceContexts, sliceKey } from '../../analysis/collocations.mjs';
import { loadScope, modalityEvidence, normalizeSlice, normalizeToggles, resolveExpressions, sliceStats } from '../../analysis/slices.mjs';
import { tx } from '../../db/open.mjs';
import { assertInputsUnchanged, retryBusy, runWrites } from '../../analysis/commit.mjs';

export const type = 'collocations';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{expr: number[]|number, slice: {years: [number, number], f?: string}, toggles?: object, corpus?: string|null}} params
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const db = ctx.db;
  const ids = Array.isArray(params?.expr) ? params.expr : [params?.expr];
  const slice = normalizeSlice(params?.slice, 'a');
  const toggles = normalizeToggles(params?.toggles);
  ctx.progress(0.02, 'scope', 'reading the slice');
  const exprs = resolveExpressions(db, ids);
  const scope = loadScope(db, { exprs, slices: [slice], toggles, corpus: params?.corpus ?? null });
  const spec = scope.specs[0];
  const stats = sliceStats(scope, spec, leadingModality(modalityEvidence(scope, spec)));
  const runParams = collocationRunParams({ exprs, slice, toggles });
  const collections = [...stats.collections].sort();
  const reuse = runWrites(ctx).findReusableRun('collocations', { params: runParams, scope: { collections }, upstream: runParams.materialize });
  if (reuse) return { run_id: reuse, reused: true };

  const runId = runWrites(ctx).startRun('collocations', { pipelineVersion: COLLOCATIONS_VERSION, params: runParams, scope: { collections },
    upstream: runParams.materialize });
  ctx.progress(0.1, 'contexts', `counting contexts of ${stats.n} matches`);
  const contexts = sliceContexts(db, scope, spec, stats, { tokenLimit: Infinity, dir: ctx.paths.tokens, checkpoint: () => ctx.checkpoint() });
  ctx.checkpoint();
  const scored = collocates(contexts, { showStop: true, limit: Infinity });
  ctx.progress(0.9, 'store', `${scored.rows.length} collocates`);
  const key = sliceKey(slice);
  retryBusy(() => tx(db, () => {
    assertInputsUnchanged(db, runId);
    const ins = db.prepare(`INSERT INTO collocation (run_id, expression_id, slice_key, collocate, f_xy, f_x, f_y, n_tokens, g2, q_value,
      log_dice, ppmi) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of scored.rows) ins.run(runId, exprs[0].id, key, r.term, r.f_xy, contexts.fx, r.f_y, contexts.N, r.g2, r.q, r.logDice, r.ppmi);
  }), { checkpoint: () => ctx.checkpoint() });
  const metrics = { source: contexts.source, f_x: contexts.fx, window_positions: contexts.W, slice_tokens: contexts.N,
    candidates: scored.candidates, significant: scored.significant };
  runWrites(ctx).finishRun(runId, 'succeeded', { metrics });
  return { run_id: runId, reused: false, ...metrics };
}
