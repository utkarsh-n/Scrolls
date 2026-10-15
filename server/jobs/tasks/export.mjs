// OWNER: WP3
// tasks/export.mjs — job 'export': build an export file under $SCROLLS_DATA/exports/ (SPEC §7.3) for exports too
// large to stream in one response. Params: { view?, state?, what, format, tier? }. Read-only on the database.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { exportQuery } from '../../export/manifest.mjs';

export const type = 'export';
export const { writes, priority } = JOB_TYPES[type];

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{view?: string|null, state?: string|null, what?: string, format?: string, tier?: string}} params
 * @returns {Promise<{file: string, bytes: number, rows: number}>}
 */
export async function run(ctx, params) {
  ctx.progress(0, 'export', `building ${params?.what ?? 'occurrences'} export`);
  const r = exportQuery(ctx.db, params ?? {});
  ctx.checkpoint();
  mkdirSync(ctx.paths.exports, { recursive: true });
  const file = `${Date.now()}-${r.filename}`;
  writeFileSync(path.join(ctx.paths.exports, file), r.body);
  ctx.progress(1, 'done', `${r.rows} rows`);
  return { file, bytes: Buffer.byteLength(r.body), rows: r.rows };
}
