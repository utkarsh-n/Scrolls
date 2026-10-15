// OWNER: WP0 — the TaskCtx handed to every job task (SPEC §4.0, §4.12, §12.2)
//
// TaskCtx = { db, paths, jobId, signal, progress(), checkpoint(), startRun(), finishRun(), enqueue(), log() }
// plus findReusableRun() and emit(). Tasks run in a worker thread with their own connection; progress,
// logs and events are posted to the main thread, which persists them and relays them over SSE.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/shared/ids.mjs';
import { TOKENIZER_VERSION } from '../../src/shared/tokenize.mjs';
import { JOB_TYPES, RUN_STATUS } from '../../src/shared/vocab.mjs';
import { paths } from '../config.mjs';
import { dataVersion, getMeta, nowIso, stmt } from '../db/open.mjs';
import { SEGMENTER_VERSION } from '../text/segment.mjs';
import { allocateJobId, insertJobRow, newJobRow } from './job-rows.mjs';

const PROGRESS_INTERVAL_MS = 250; // ≤ 4 progress messages per second
const RELAYED_EVENTS = new Set(['adapter', 'bootstrap', 'data']);

/** Thrown by ctx.checkpoint() once cancellation was requested. */
export class CancelledError extends Error {
  constructor(message = 'The job was cancelled.') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'E_CANCELLED';
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const codeHashes = new Map();

function hashFiles(files) {
  const key = files.join('\n');
  if (!codeHashes.has(key)) {
    const h = createHash('sha256');
    for (const f of files) {
      const p = f instanceof URL || String(f).startsWith('file:') ? fileURLToPath(f) : String(f);
      try { h.update(readFileSync(p)); } catch { h.update(`missing:${p}`); }
    }
    codeHashes.set(key, h.digest('hex'));
  }
  return codeHashes.get(key);
}

/**
 * Input fingerprint of a run (§3, §4.0): the scope, the newest committed import batch of each collection in
 * scope (all collections when the scope names none), the passage-quality version, upstream runs and the
 * tokenizer/segmenter versions — so an unrelated import does not invalidate a run.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{scope?: object, upstream?: number[]}} opts
 * @returns {string}
 */
export function inputFingerprint(db, { scope = {}, upstream = [] } = {}) {
  const wanted = Array.isArray(scope?.collections) ? scope.collections.map(String) : null;
  const batches = {};
  for (const r of stmt(db, `SELECT c.slug, c.id, MAX(b.id) AS batch FROM collection c
    LEFT JOIN import_batch b ON b.collection_id = c.id AND b.status = 'committed' GROUP BY c.id ORDER BY c.slug`).all()) {
    if (!wanted || wanted.includes(r.slug) || wanted.includes(String(r.id))) batches[r.slug] = r.batch ?? 0;
  }
  return sha256(canonicalJson({ scope, batches, quality: getMeta(db, 'quality_version') ?? '0',
    upstream: [...upstream].sort((a, b) => a - b), tokenizer: TOKENIZER_VERSION, segmenter: SEGMENTER_VERSION }));
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, jobId: number, cancelFlag: Int32Array, post: (msg: object) => void,
 *   type?: string|null, codeFiles?: Array<string|URL>, jobIdCell?: Int32Array|null, writesJob?: boolean}} opts
 *   jobIdCell: the queue's shared job-id counter (job-rows.mjs; absent outside a queue: tests, scripts);
 *   writesJob: whether this job holds the writer slot (a read-only job never waits on a writer's lock)
 * @returns {object} TaskCtx
 */
export function makeTaskContext({ db, jobId, cancelFlag, post, type = null, codeFiles = [], jobIdCell = null, writesJob = true }) {
  const controller = new AbortController();
  const openRuns = new Set();
  let lastSent = 0, lastPhase, pending = null, timer = null;

  function sendProgress(p) {
    lastSent = Date.now();
    lastPhase = p.phase;
    pending = null;
    post({ kind: 'progress', ...p });
  }

  const ctx = {
    db,
    paths: paths(),
    jobId,
    signal: controller.signal,

    /**
     * Report progress; throttled to 4/s (phase changes and completion are sent at once).
     * @param {number} fraction 0–1
     * @param {string} [phase]
     * @param {string} [message]
     * @param {object} [counts]
     */
    progress(fraction, phase = lastPhase ?? null, message = null, counts = null) {
      const p = { fraction: Math.max(0, Math.min(1, Number(fraction) || 0)), phase, message, counts };
      if (phase !== lastPhase || p.fraction >= 1 || Date.now() - lastSent >= PROGRESS_INTERVAL_MS) {
        clearTimeout(timer);
        timer = null;
        sendProgress(p);
        return;
      }
      pending = p;
      if (!timer) {
        timer = setTimeout(() => { timer = null; if (pending) sendProgress(pending); }, PROGRESS_INTERVAL_MS - (Date.now() - lastSent));
        timer.unref?.();
      }
    },

    /** Throw CancelledError when cancellation was requested; call at least every 200 ms of work. */
    checkpoint() {
      if (Atomics.load(cancelFlag, 0) !== 0) {
        if (!controller.signal.aborted) controller.abort(new CancelledError());
        throw new CancelledError();
      }
    },

    /**
     * Open an analysis_run (status 'running') for this job.
     * @param {string} stage vocab.STAGES
     * @param {{pipelineVersion: string, params?: object, scope?: object, upstream?: number[], representation?: string|null,
     *   model?: string|null, modelVersion?: string|null, seed?: number|null, codeFiles?: Array<string|URL>}} opts
     * @returns {number} run id
     */
    startRun(stage, { pipelineVersion, params = {}, scope = {}, upstream = [], representation = null, model = null,
      modelVersion = null, seed = null, codeFiles: extra = [] } = {}) {
      if (!pipelineVersion) throw new TypeError('startRun: pipelineVersion is required (e.g. "cluster@1.0.0")');
      const paramsJson = canonicalJson(params);
      const r = stmt(db, `INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
          input_fingerprint, data_version, upstream_run_ids, representation, model, model_version, seed, tokenizer_version,
          segmenter_version, icu_version, status, job_id, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
        .run(stage, pipelineVersion, hashFiles([...codeFiles, ...extra]), paramsJson, sha256(paramsJson), canonicalJson(scope),
          inputFingerprint(db, { scope, upstream }), dataVersion(db), JSON.stringify(upstream), representation, model,
          modelVersion, seed, TOKENIZER_VERSION, SEGMENTER_VERSION, process.versions.icu ?? 'none', jobId, nowIso());
      const runId = Number(r.lastInsertRowid);
      openRuns.add(runId);
      post({ kind: 'run', runId });
      return runId;
    },

    /**
     * Close a run. Rows of a run are visible only once it is 'succeeded' (visibility rule, §3).
     * @param {number} runId
     * @param {'succeeded'|'failed'|'cancelled'|'superseded'} status
     * @param {{metrics?: object|null, gate?: object}} [opts]
     */
    finishRun(runId, status, { metrics = null, gate = {} } = {}) {
      if (!RUN_STATUS.includes(status) || status === 'running') throw new TypeError(`finishRun: bad status '${status}'`);
      stmt(db, 'UPDATE analysis_run SET status = ?, metrics_json = ?, gate_json = ?, finished_at = ? WHERE id = ?')
        .run(status, metrics === null ? null : JSON.stringify(metrics), JSON.stringify(gate ?? {}), nowIso(), runId);
      openRuns.delete(runId);
    },

    /**
     * A succeeded run with the same (stage, params_hash, input_fingerprint), to reuse instead of recomputing.
     * @param {string} stage
     * @param {{params?: object, scope?: object, upstream?: number[]}} opts
     * @returns {number|null}
     */
    findReusableRun(stage, { params = {}, scope = {}, upstream = [] } = {}) {
      const row = stmt(db, `SELECT id FROM analysis_run WHERE stage = ? AND params_hash = ? AND input_fingerprint = ?
        AND status = 'succeeded' ORDER BY id DESC LIMIT 1`)
        .get(stage, sha256(canonicalJson(params)), inputFingerprint(db, { scope, upstream }));
      return row ? row.id : null;
    },

    /**
     * Queue a follow-up job. Inside this task's transaction (or in a writer job) the row is written on this
     * connection, so it commits or rolls back with the task's work and the main thread schedules it once
     * committed. A read-only job outside a transaction hands the row to the main thread instead, which writes it
     * without waiting on a writer's lock. Either way the id is final at once (one shared counter).
     * @param {string} jobType vocab.JOB_TYPES key
     * @param {object} [params]
     * @param {{priority?: number}} [opts]
     * @returns {number} job id
     */
    enqueue(jobType, params = {}, { priority } = {}) {
      if (!Object.hasOwn(JOB_TYPES, jobType)) throw new TypeError(`enqueue: unknown job type '${jobType}'`);
      if (!jobIdCell) {
        const def = JOB_TYPES[jobType];
        const r = stmt(db, `INSERT INTO job (type, params_json, writes, priority, status, created_at)
          VALUES (?, ?, ?, ?, 'queued', ?)`).run(jobType, JSON.stringify(params ?? {}), def.writes ? 1 : 0,
          Number.isInteger(priority) ? priority : def.priority, nowIso());
        const id = Number(r.lastInsertRowid);
        post({ kind: 'enqueued', jobId: id });
        return id;
      }
      const row = newJobRow(allocateJobId(db, jobIdCell), jobType, params, { priority });
      if (db.isTransaction || writesJob) {
        insertJobRow(db, row);
        post({ kind: 'enqueued', jobId: row.id });
      } else {
        post({ kind: 'enqueue', row });
      }
      return row.id;
    },

    /** @param {'info'|'warn'|'error'} level @param {string} message @param {object} [data] */
    log(level, message, data = null) {
      post({ kind: 'log', level: ['info', 'warn', 'error'].includes(level) ? level : 'info', message: String(message), data });
    },

    /**
     * Relay an event to the server bus (SSE): 'adapter' | 'bootstrap' | 'data'.
     * @param {string} event
     * @param {object} data
     */
    emit(event, data) {
      if (!RELAYED_EVENTS.has(event)) throw new TypeError(`emit: event '${event}' is not relayed`);
      post({ kind: 'emit', event, data });
    },
  };

  Object.defineProperties(ctx, {
    /** Internal: abort the signal (the main thread asked to cancel). */
    _abort: { value: () => { if (!controller.signal.aborted) controller.abort(new CancelledError()); } },
    /** Internal: close runs the task left open (on cancel/failure). */
    _closeOpenRuns: { value: (status) => { for (const id of [...openRuns]) ctx.finishRun(id, status); } },
    /** Internal: flush a throttled progress message. */
    _flushProgress: { value: () => { clearTimeout(timer); timer = null; if (pending) sendProgress(pending); } },
    type: { value: type, enumerable: true },
  });
  return ctx;
}
