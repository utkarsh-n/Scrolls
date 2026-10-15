// OWNER: WP1
// tasks/revert.mjs — job 'revert': soft-delete an import batch's documents and bump data_version (SPEC §5.2).
// Documents are only ever soft-deleted (D17): saved views pinned to an earlier data version keep resolving.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { revertImport } from '../../ingest/pipeline.mjs';

export const type = 'revert';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{batchId: number}} params
 * @returns {Promise<{import_batch_id: number, documents: number, data_version: number, reverted_at: string}>}
 */
export async function run(ctx, params) {
  return revertImport(ctx, params);
}
