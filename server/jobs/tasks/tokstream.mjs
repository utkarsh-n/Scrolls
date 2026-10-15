// OWNER: WP4
// tasks/tokstream.mjs — job 'tokstream': write token-id streams per language and data version (SPEC §4.7).
// params: {langs?: string[]} (absent = every language with quality='ok' passages).
//
// The job is read-only for the database (vocab.JOB_TYPES writes=false: it never takes the writer slot); its
// only database write is the analysis_run row. When a write job holds the lock for longer than the busy
// timeout, the streams are still written and their manifest records run_id null.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { buildTokenStreams, TOKSTREAM_VERSION } from '../../analysis/tokstream.mjs';
import { isBusyError } from '../../db/open.mjs';
import { runWrites } from '../../analysis/commit.mjs';

export const type = 'tokstream';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{langs?: string[]|null, lang?: string}} params
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const langs = Array.isArray(params?.langs) && params.langs.length ? params.langs : params?.lang ? [params.lang] : null;
  let runId = null;
  try {
    runId = runWrites(ctx).startRun('tokstream', { pipelineVersion: TOKSTREAM_VERSION, params: { langs }, scope: { langs } });
  } catch (err) {
    if (!isBusyError(err)) throw err;
    ctx.log('warn', 'tokstream: the writer was busy; streams are written without an analysis_run row');
  }
  try {
    const result = buildTokenStreams(ctx.db, { langs, dir: ctx.paths.tokens, runId }, ctx);
    if (runId !== null) runWrites(ctx).finishRun(runId, 'succeeded', { metrics: result });
    return { run_id: runId, ...result };
  } catch (err) {
    if (runId !== null && err?.name !== 'CancelledError') {
      try { runWrites(ctx).finishRun(runId, 'failed'); } catch { /* the worker closes open runs */ }
    }
    throw err;
  }
}
