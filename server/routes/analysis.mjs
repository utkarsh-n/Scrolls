// OWNER: WP4
// routes/analysis.mjs — analysis runs (SPEC §4.0, §7.1):
//   GET  /api/analysis/runs?stage=&expr=&limit=&cursor= → AnalysisRuns (newest first)
//   POST /api/analysis/runs {stage, params?, expr?}     → AnalysisRunStarted (a job, or the identical finished run reused)
// Startable stages: tokstream (token streams), collocations (stored collocate tables), vectors (PPMI-SVD spaces of
// a language: {lang, corpora? | collections?, scope?}), drift and tone (params = the Compare request: {expr, a, b, toggles?,
// corpus?}), and the other packages' cluster, layout and reuse-index tasks (params passed through).

import { canonicalJson } from '../../src/shared/ids.mjs';
import { STAGES } from '../../src/shared/vocab.mjs';
import { asSavedParams, normalizeCompareRequest } from '../analysis/compare.mjs';
import { streamStatus } from '../analysis/tokstream.mjs';
import { normalizeVectorsParams } from '../jobs/tasks/vectors.mjs';
import { paths } from '../config.mjs';
import { badRequest } from '../http/errors.mjs';
import { decodeCursor, encodeCursor, limitParam } from '../http/router.mjs';

const COLLOCATIONS_URL = new URL('../analysis/collocations.mjs', import.meta.url).href;
const STARTABLE = ['tokstream', 'collocations', 'vectors', 'drift', 'tone', 'cluster', 'layout', 'reuse-index'];

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function runJson(r) {
  return { id: r.id, stage: r.stage, status: r.status, pipeline_version: r.pipeline_version, params: parse(r.params_json) ?? {},
    scope: parse(r.scope_json) ?? {}, started_at: r.started_at, finished_at: r.finished_at ?? null, representation: r.representation ?? null,
    data_version: r.data_version, job: r.job_id ?? null, metrics: parse(r.metrics_json), gate: parse(r.gate_json) ?? {} };
}

function startTokstream(ctx, params) {
  const langs = params.langs ?? (params.lang ? [params.lang] : null);
  if (langs !== null && (!Array.isArray(langs) || !langs.every((l) => typeof l === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(l)))) {
    throw badRequest('E_VALIDATION', 'params.langs must list language codes.', "e.g. {\"langs\": [\"en\"]}", { field: 'params.langs' });
  }
  if (langs?.length) {
    const st = langs.map((l) => streamStatus(ctx.db, paths().tokens, l));
    if (st.every((s) => s.fresh)) {
      const runId = st[0].manifest.run_id ?? null;
      const job = runId ? ctx.db.prepare('SELECT job_id FROM analysis_run WHERE id = ?').get(runId)?.job_id ?? null : null;
      if (job) return { job: { id: job }, run: runId, reused: true };
    }
  }
  return { job: { id: ctx.jobs.enqueue('tokstream', { langs }) }, run: null, reused: false };
}

/** drift and tone take a Compare request; the job reuses an identical succeeded run. */
function startComparisonRun(ctx, stage, params, expr) {
  const req = normalizeCompareRequest({ ...params, ...(expr && !params.expr ? { expr: [expr] } : {}) });
  // as saved (RF-2): the run computes the comparison of the saved view's pins and cutoffs, which Compare then reads back
  const job = ctx.jobs.enqueue(stage, { expr: req.expr, a: req.a, b: req.b, toggles: req.toggles, corpus: req.corpus, ...asSavedParams(req) });
  return { job: { id: job }, run: null, reused: false };
}

async function startCollocations(ctx, params, expr) {
  const plan = await ctx.pool.run(COLLOCATIONS_URL, 'collocationsPlanQuery', { expr: params.expr ?? expr, years: params.years,
    f: params.f ?? '', toggles: params.toggles, corpus: params.corpus ?? null });
  if (plan.stored_run && plan.job) return { job: { id: plan.job }, run: plan.stored_run, reused: true };
  const job = ctx.jobs.enqueue('collocations', { expr: plan.expr, slice: plan.slice, toggles: plan.toggles, corpus: plan.corpus });
  return { job: { id: job }, run: null, reused: false };
}

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/analysis/runs',
    async handler(req, ctx) {
      const stage = req.query.stage || null;
      if (stage && !STAGES.includes(stage)) throw badRequest('E_VALIDATION', `Unknown stage '${stage}'.`, `Use one of ${STAGES.join(', ')}.`, { stage });
      const expr = req.query.expr ? Number(req.query.expr) : null;
      if (expr !== null && !(Number.isSafeInteger(expr) && expr > 0)) throw badRequest('E_BAD_ID', `'${req.query.expr}' is not an expression id.`);
      const limit = limitParam(req.query, { max: 200, dflt: 50 });
      const before = decodeCursor(req.query.cursor)?.before ?? null;
      const rows = ctx.db.prepare(`SELECT * FROM analysis_run r WHERE (? IS NULL OR r.stage = ?) AND (? IS NULL OR r.id < ?)
        AND (? IS NULL OR json_extract(r.params_json, '$.expr') = ? OR json_extract(r.params_json, '$.expression') = ?
             OR EXISTS (SELECT 1 FROM json_each(r.params_json, '$.expr') j WHERE j.value = ?)
             OR json_extract(r.scope_json, '$.expression') = ?)
        ORDER BY r.id DESC LIMIT ?`).all(stage, stage, before, before, expr, expr, expr, expr, expr, limit);
      const cursor = rows.length === limit ? encodeCursor({ before: rows[rows.length - 1].id }) : null;
      return { json: { items: rows.map(runJson), cursor }, etag: false };
    },
  },
  {
    method: 'POST',
    path: '/api/analysis/runs',
    async handler(req, ctx) {
      const body = req.body ?? {};
      const stage = body.stage;
      if (typeof stage !== 'string' || !STARTABLE.includes(stage)) {
        throw badRequest('E_VALIDATION', `Unknown stage '${stage ?? ''}'.`, `Use ${STARTABLE.join(', ')}.`, { stage: stage ?? null });
      }
      const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
      if (canonicalJson(params).length > 10000) throw badRequest('E_VALIDATION', 'params is too large.', null, { field: 'params' });
      if (stage === 'tokstream') return { json: startTokstream(ctx, params) };
      if (stage === 'collocations') return { json: await startCollocations(ctx, params, body.expr ?? null) };
      if (stage === 'vectors') {
        const p = normalizeVectorsParams(params);
        return { json: { job: { id: ctx.jobs.enqueue('vectors', { lang: p.lang, corpora: p.corpora ?? undefined, collections: p.collections ?? undefined,
          scope: p.scope, ...(params.threads !== undefined ? { threads: p.threads } : {}) }) }, run: null, reused: false } };
      }
      if (stage === 'drift' || stage === 'tone') return { json: startComparisonRun(ctx, stage, params, body.expr ?? null) };
      return { json: { job: { id: ctx.jobs.enqueue(stage, { ...params, ...(body.expr ? { expr: body.expr } : {}) }) }, run: null, reused: false } };
    },
  },
];
