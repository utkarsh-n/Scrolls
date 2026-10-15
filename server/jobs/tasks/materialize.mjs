// OWNER: WP3
// tasks/materialize.mjs — job 'materialize': count a tracked expression into occurrence + expr_doc rows of a new
// analysis run (SPEC §4.6). Params: { expressionId }. writes and priority come from vocab.JOB_TYPES.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { HttpError } from '../../http/errors.mjs';
import { materialize } from '../../aggregate/materialize.mjs';

export const type = 'materialize';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{expressionId: number, sampleAbove?: number, samplePerGroup?: number}} params the optional thresholds override §4.6 (tests)
 * @returns {Promise<object>} result_json: { run, occurrences, counted, documents, names_excluded, candidates }
 */
export async function run(ctx, params) {
  const expressionId = Number(params?.expressionId);
  if (!Number.isInteger(expressionId) || expressionId <= 0) {
    throw new HttpError(400, 'E_VALIDATION', 'materialize needs params.expressionId (a positive integer).');
  }
  const pos = (x) => (Number.isInteger(x) && x > 0 ? x : undefined);
  return materialize(ctx.db, { expressionId, sampleAbove: pos(params?.sampleAbove), samplePerGroup: pos(params?.samplePerGroup) }, ctx);
}
