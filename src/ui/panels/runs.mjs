// OWNER: WP7
// panels/runs.mjs — starting the analysis run a gate card suggests, and following its job (API.md 1.2.0: "A gate
// card may carry suggestion.run = {stage, params}: exactly the body to POST to /api/analysis/runs"; GET
// /api/clusters' not_run card carries the same as suggestion.request = {method, path, body}). A run is only ever
// started by a person pressing the card's button; nothing here starts one on its own.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * The request a suggestion asks for, or null when it names no run.
 * @param {unknown} suggestion a gate's suggestion
 * @returns {{path: string, body: object}|null} path relative to /api
 */
export function runRequestOf(suggestion) {
  if (!isObj(suggestion)) return null;
  if (isObj(suggestion.run) && typeof suggestion.run.stage === 'string') {
    return { path: '/analysis/runs', body: { stage: suggestion.run.stage, ...(isObj(suggestion.run.params) ? { params: suggestion.run.params } : {}) } };
  }
  const r = suggestion.request;
  if (isObj(r) && String(r.method ?? 'POST').toUpperCase() === 'POST' && r.path === '/api/analysis/runs' && isObj(r.body) && typeof r.body.stage === 'string') {
    return { path: '/analysis/runs', body: r.body };
  }
  return null;
}

/**
 * POST the suggested run. Resolves to the started (or reused) run's job id.
 * @param {{post: Function}} api
 * @param {object} suggestion
 * @returns {Promise<{job: number|null, run: number|null, reused: boolean, stage: string}>}
 */
export async function startSuggestedRun(api, suggestion) {
  const req = runRequestOf(suggestion);
  if (!req) throw new Error('This suggestion names no analysis run.');
  const res = await api.post(req.path, req.body, { key: `run-${req.body.stage}` });
  const job = Number.isInteger(res?.job?.id) ? res.job.id : Number.isInteger(res?.job) ? res.job : null;
  return { job, run: Number.isInteger(res?.run) ? res.run : null, reused: res?.reused === true, stage: req.body.stage };
}

/**
 * Follow one job's own event stream: progress fractions, then done. Returns a stop function. Without an SSE
 * client the job is not followed (the jobs tray still shows it) and `done` is never called.
 * @param {{sse?: Function}} api
 * @param {number} jobId
 * @param {{progress?: (fraction: number|null, data: object) => void, done?: (data: object) => void}} handlers
 * @returns {() => void}
 */
export function followJob(api, jobId, { progress = null, done = null } = {}) {
  if (!Number.isInteger(jobId) || typeof api?.sse !== 'function') return () => {};
  let stop = () => {};
  try {
    stop = api.sse(`/jobs/${jobId}/events`, {
      progress: (d) => progress?.(Number.isFinite(d?.fraction) ? d.fraction : Number.isFinite(d?.progress) ? d.progress : null, d ?? {}),
      done: (d) => { try { stop(); } catch { /* already closed */ } done?.(d ?? {}); },
    });
  } catch { /* the jobs tray still follows it */ }
  return () => { try { stop(); } catch { /* already closed */ } };
}

/**
 * Library module: nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
