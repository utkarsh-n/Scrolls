// OWNER: WP0 — GET /api/health (SPEC §7.1, §7.2): version, contract, data version, DB size, jobs, read pool,
// optional adapters and the Cipher bootstrap status. Cheap enough to answer in < 50 ms during any job.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONTRACT_VERSION } from '../../src/shared/contracts.mjs';
import { cipherStatus, FLAGS, paths, VERSION } from '../config.mjs';
import { stmt } from '../db/open.mjs';

const CIPHER_CACHE_MS = 60000;
let cipherCache = { at: 0, value: null };

function cachedCipherStatus() {
  if (!cipherCache.value || Date.now() - cipherCache.at > CIPHER_CACHE_MS) cipherCache = { at: Date.now(), value: cipherStatus() };
  return cipherCache.value;
}

function fileSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

/** Database bytes on disk: the file plus its WAL. */
function dbBytes() {
  const db = paths().db;
  return fileSize(db) + fileSize(`${db}-wal`);
}

const STATUS_OF_JOB = { queued: 'queued', succeeded: 'ready', failed: 'failed', cancelled: 'cancelled',
  interrupted: 'interrupted' };

/**
 * vocab.CIPHER_STATUS of a bootstrap job: while it runs, phase B (full text) is 'fulltext' and every other phase
 * (A metadata, A2 genealogy, not reported yet) is 'metadata' (§6.8, §7.2 example).
 * @param {{status: string, phase?: string|null}} job
 * @returns {string}
 */
export function bootstrapStatus(job) {
  if (job.status !== 'running' && job.status !== 'cancelling') return STATUS_OF_JOB[job.status] ?? 'failed';
  // 'boilerplate' is the phase-B boilerplate pass (WP5's boilerplatePass reports its own phase label)
  return /^B\b|full ?text|^boilerplate/i.test(job.phase ?? '') ? 'fulltext' : 'metadata';
}

/**
 * Cipher bootstrap status for the health payload.
 * @param {object} ctx RouteCtx
 * @returns {{status: string, phase: string|null, progress: number|null, message: string|null}}
 */
export function cipherInfo(ctx) {
  const last = stmt(ctx.db, "SELECT id FROM job WHERE type = 'bootstrap-cipher' ORDER BY id DESC LIMIT 1").get();
  const job = last ? ctx.jobs.get(last.id) : null;
  if (job) {
    return { status: bootstrapStatus(job), phase: job.phase ?? null, progress: job.progress ?? null,
      message: job.message ?? null };
  }
  const st = cachedCipherStatus();
  if (!st.ok) return { status: 'absent', phase: null, progress: null, message: `Cipher files not found: ${st.missing.join(', ')}` };
  if (FLAGS.noAutoImport) return { status: 'disabled', phase: null, progress: null, message: 'automatic import is off (SCROLLS_NO_AUTO_IMPORT=1)' };
  return { status: 'not_started', phase: null, progress: null, message: null };
}

/**
 * The health payload.
 * @param {object} ctx RouteCtx
 * @returns {object}
 */
export function healthBody(ctx) {
  const pool = ctx.pool.stats();
  return {
    ok: true,
    version: VERSION,
    contract: CONTRACT_VERSION,
    dataVersion: ctx.dataVersion(),
    dbBytes: dbBytes(),
    jobs: ctx.jobs.counts(),
    readPool: { size: pool.size, busy: pool.busy, queued: pool.queued },
    adapters: {
      nl: existsSync(path.join(paths().bin, 'scrolls-nl')) ? 'installed' : 'missing',
      registered: stmt(ctx.db, 'SELECT count(*) AS n FROM source_adapter WHERE enabled = 1').get().n,
    },
    cipher: cipherInfo(ctx),
    // the boot-time originals check (server/db/integrity.mjs): 'checking' | 'ok' | 'missing_originals' | 'unknown'
    ...(ctx.integrity ? { integrity: ctx.integrity } : {}),
  };
}

export const routes = [
  { method: 'GET', path: '/api/health', handler: async (req, ctx) => ({ json: healthBody(ctx), etag: false }) },
];
