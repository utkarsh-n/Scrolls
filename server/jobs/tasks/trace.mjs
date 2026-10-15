// OWNER: WP5
// tasks/trace.mjs — job 'trace': the targeted quotation trace of one span (SPEC §4.7). POST /api/trace waits
// ≤ 1.5 s for it and otherwise answers with the job, which continues in the background.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { traceSpan } from '../../lineage/trace.mjs';

export const type = 'trace';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{passage: number, start: number, end: number, relative?: boolean}} params
 * @returns {Promise<object>} result_json: the Trace payload with created_relationships and run_id
 */
export async function run(ctx, params = {}) {
  return traceSpan(ctx.db, ctx, params);
}
