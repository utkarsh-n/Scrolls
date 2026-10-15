// OWNER: WP5
// tasks/boilerplate.mjs — job 'boilerplate': the boilerplate vs commonplace pass (SPEC §4.7). The Cipher
// bootstrap runs it right after the books load (phase B); it can also be queued on its own, e.g.
// { collections: ['cipher-gutenberg'] }.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { boilerplatePass } from '../../lineage/boilerplate.mjs';

export const type = 'boilerplate';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{collections?: Array<string|number>, dryRun?: boolean}} params
 * @returns {Promise<object>} result_json: the pass metrics (passages flagged, canary, run id …)
 */
export async function run(ctx, params = {}) {
  // the queue announces the data_version bump ('data' event) when the job ends
  return boilerplatePass(ctx.db, ctx, { collections: params.collections ?? null, dryRun: params.dryRun === true });
}
