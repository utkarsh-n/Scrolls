// OWNER: WP1
// tasks/import.mjs — job 'import': commit an import batch through DocumentWriter (SPEC §5.2 step 4).
// The work is server/ingest/pipeline.mjs commitImport; its result is the ImportSummary (§5.7).

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { commitImport } from '../../ingest/pipeline.mjs';

export const type = 'import';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{batchId: number, mapping: object}} params
 * @returns {Promise<object>} the ImportSummary
 */
export async function run(ctx, params) {
  return commitImport(ctx, params);
}
