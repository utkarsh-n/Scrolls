// OWNER: WP0 — test task: waits (or burns CPU) in small steps, reporting progress and honouring cancellation

export const type = '_noop';
export const writes = false;
export const priority = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} ctx TaskCtx
 * @param {{ms?: number, step?: number, busy?: boolean, fail?: string|null, withRun?: boolean, result?: object, lock?: boolean}} params
 *   ms: total duration · step: work slice between checkpoints · busy: burn CPU instead of sleeping (shows that
 *   cancellation and the HTTP loop are unaffected by a CPU-bound worker) · fail: throw this message at the end ·
 *   withRun: open an analysis_run and close it like a real stage · lock: hold the database write lock (an open
 *   BEGIN IMMEDIATE) for the whole run, as a bulk writer stuck in one transaction would (M5 gate: a job that is
 *   terminated after ignoring cancellation must release it)
 * @returns {Promise<object>}
 */
export async function run(ctx, { ms = 1000, step = 20, busy = false, fail = null, withRun = false, result = {}, lock = false } = {}) {
  const runId = withRun ? ctx.startRun('_noop', { pipelineVersion: '_noop@1.0.0', params: { ms, step, busy } }) : null;
  if (lock) ctx.db.exec('BEGIN IMMEDIATE');
  const start = Date.now();
  let slices = 0;
  for (let elapsed = 0; elapsed < ms; elapsed = Date.now() - start) {
    if (busy) {
      const until = Date.now() + step;
      while (Date.now() < until) { /* burn */ }
    } else {
      await sleep(step);
    }
    slices++;
    ctx.checkpoint();
    ctx.progress(Math.min(1, (Date.now() - start) / ms), busy ? 'burning' : 'waiting', `slice ${slices}`, { slices });
  }
  if (lock) ctx.db.exec('ROLLBACK');
  if (fail) throw new Error(fail);
  if (runId !== null) ctx.finishRun(runId, 'succeeded', { metrics: { slices } });
  ctx.progress(1, 'done', null, { slices });
  return { slices, runId, ...result };
}
