// OWNER: WP0 — the HTTP server: boot sequence, request pipeline, responses with ETags (SPEC §7, §12.2)
//
// Boot order: ensureDirs → openDb → migrate → seedVocab → registerAdapters → startReadPool → createJobQueue →
// recoverInterrupted → enqueue('demo-load') if the demo is absent (await ≤ 10 s) → enqueue('bootstrap-cipher')
// if cipherStatus().ok && !noAutoImport && not yet done → loadRoutes (or mockRoutes) → listen.
// A task module or route file that has not landed yet is logged and skipped; it never stops the boot.
// After listening, the originals integrity check runs once in a read worker (integrity.mjs → /api/health).
//
// Interactive writes never hold up the event loop for a job's write lock (M5 gate item 9): ctx.withWrite waits
// at most WRITE_FAST_MS; when a job holds the lock longer, the request is parked — the wait is announced to
// cooperative writers (open.mjs handoff) and polled without blocking — and the handler runs again once the lock is
// free, its synchronous part inside a transaction this connection already holds. Only a request that has not
// committed anything yet is run again (jobs it queued are remembered, not queued twice); an upload route (rawBody)
// is run again only while its body is unread. A second write in one request keeps the blocking 5 s wait, which a
// cooperative writer cuts short by stepping aside (open.mjs handoff).

import http from 'node:http';
import { cipherStatus, ensureDirs, FLAGS, HOST, log, paths, PORT } from '../config.mjs';
import { registerAdapters } from '../adapters/registry.mjs';
import { checkOriginals } from '../db/integrity.mjs';
import { migrate } from '../db/migrate.mjs';
import { announceWrite, dataVersion, isBusyError, openDb, stmt, tryBeginImmediate, tx } from '../db/open.mjs';
import { startReadPool } from '../db/readpool.mjs';
import { seedVocab } from '../db/seed-vocab.mjs';
import { createJobQueue } from '../jobs/queue.mjs';
import { HttpError, statusOf, toErrorBody } from './errors.mjs';
import { etagFor, etagMatches } from './etag.mjs';
import { createRouter, loadRoutes } from './router.mjs';
import { checkRequest, SECURITY_HEADERS } from './security.mjs';
import { bus, closeAllSse } from './sse.mjs';
import { serveStatic } from './static.mjs';

const ROUTES_DIR = new URL('../routes/', import.meta.url);
const CONTRACT_DIR = new URL('../../tests/contract/', import.meta.url);
const MAX_JSON_BODY = 25 * 1024 * 1024;
const DEMO_WAIT_MS = 10000;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a first interactive write may wait for the lock on the event loop before its request is parked. */
const WRITE_FAST_MS = 25;
/** Poll interval of a parked request (each probe takes the lock or fails at once). */
const WRITE_POLL_MS = 20;
/** A parked request answers 503 E_BUSY after this long. */
export const WRITE_PARK_MAX_MS = 60000;

// ── interactive writes ──────────────────────────────────────────────────────────────────────────────

/** withWrite could not take the lock: a job holds it. `parkable` requests are run again once it is free. */
export class WriteBusyError extends HttpError {
  /** @param {boolean} parkable */
  constructor(parkable) {
    super(503, 'E_BUSY', 'A running job holds the database write lock.',
      'Try again in a moment; jobs commit in short steps.');
    this.parkable = parkable;
  }
}

/**
 * The RouteCtx a handler sees for one request: the shared context with a withWrite that can park the request
 * and a job queue whose enqueue is remembered across runs of the handler.
 * @param {object} base the server's shared RouteCtx
 * @param {{parkable: boolean, raw: import('node:http').IncomingMessage|null, wrote: boolean,
 *   enqueued: Array<{key: string, id: number}>, seq: number}} state raw: an upload's body stream (parkable while unread)
 * @returns {object}
 */
function requestCtx(base, state) {
  const queue = base.jobs;
  const jobs = queue ? Object.create(queue, {
    enqueue: {
      value(type, params, opts) {
        const key = JSON.stringify([type, params ?? {}, opts ?? {}]);
        const i = state.seq++;
        if (state.enqueued[i]?.key === key) return state.enqueued[i].id;
        const id = queue.enqueue(type, params, opts);
        state.enqueued[i] = { key, id };
        return id;
      },
    },
  }) : queue;
  return Object.create(base, {
    jobs: { value: jobs, enumerable: true },
    withWrite: { value: (fn) => requestWrite(base, state, fn), enumerable: true },
  });
}

function requestWrite(base, state, fn) {
  const db = base.db;
  if (!db) throw new HttpError(503, 'E_MOCK', 'Mock mode has no database.');
  const before = dataVersion(db);
  let out;
  if (db.isTransaction) {
    out = tx(db, fn); // the parked run holds the lock already: a savepoint inside it
  } else {
    const parkable = state.parkable && !state.wrote && !state.raw?.readableDidRead;
    try {
      out = tx(db, fn, parkable ? { busyMs: WRITE_FAST_MS } : {});
    } catch (err) {
      if (isBusyError(err) && !db.isTransaction) throw new WriteBusyError(parkable);
      throw err;
    }
  }
  state.wrote = true;
  const after = dataVersion(db);
  if (after !== before) bus.emit('data', { dataVersion: after });
  return out;
}

/**
 * Run `attempt` once the write lock is free: announce the wait, probe without blocking, and on success call
 * `attempt` synchronously inside the transaction just begun, so its first write cannot lose the lock again;
 * commit once its synchronous part has returned.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} deadline epoch ms
 * @param {() => unknown} attempt runs the route handler
 * @returns {Promise<unknown>} the handler's result
 */
function whenWritable(db, deadline, attempt) {
  return new Promise((resolve, reject) => {
    const release = announceWrite();
    const tick = () => {
      let began;
      try { began = tryBeginImmediate(db); } catch (err) { release(); reject(err); return; }
      if (!began) {
        if (Date.now() >= deadline) { release(); reject(new WriteBusyError(false)); return; }
        setTimeout(tick, WRITE_POLL_MS).unref?.();
        return;
      }
      release();
      let result;
      try { result = attempt(); } catch (err) { result = Promise.reject(err); }
      try {
        if (db.isTransaction) db.exec('COMMIT');
      } catch (err) {
        try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* connection unusable */ }
        Promise.resolve(result).catch(() => {});
        reject(err);
        return;
      }
      resolve(result);
    };
    tick();
  });
}

/**
 * Run a route handler; a request parked by WriteBusyError is run again once the write lock is free.
 * @param {object} route
 * @param {object} sreq
 * @param {object} base shared RouteCtx
 * @returns {Promise<object>} Resp
 */
async function runRoute(route, sreq, base) {
  const state = { parkable: Boolean(base.db) && !route.sse, raw: route.rawBody ? sreq.raw ?? null : null, wrote: false,
    enqueued: [], seq: 0 };
  const deadline = Date.now() + WRITE_PARK_MAX_MS;
  const attempt = () => {
    state.seq = 0;
    return route.handler(sreq, requestCtx(base, state));
  };
  let run = attempt;
  for (;;) {
    try {
      return (await run()) ?? {};
    } catch (err) {
      if (!(err instanceof WriteBusyError) || !err.parkable || state.wrote || state.raw?.readableDidRead) throw err;
      run = () => whenWritable(base.db, deadline, attempt);
    }
  }
}

// ── boot helpers ────────────────────────────────────────────────────────────────────────────────────

async function ensureDemo(db, jobs) {
  if (FLAGS.noDemo) return;
  if (!jobs.hasTask('demo-load')) {
    log('info', 'demo-load task not installed yet; the demo corpus is not loaded');
    return;
  }
  const present = stmt(db, `SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id
    JOIN corpus k ON k.id = c.corpus_id WHERE k.slug = 'demo' AND d.deleted_at IS NULL LIMIT 1`).get();
  if (present) { requeueStubbedJobs(db, jobs); return; }
  const pending = stmt(db, "SELECT id FROM job WHERE type = 'demo-load' AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get();
  const id = pending?.id ?? jobs.enqueue('demo-load', {});
  const row = await jobs.waitFor(id, { timeoutMs: DEMO_WAIT_MS });
  if (!row) log('warn', `demo-load (job ${id}) still running after ${DEMO_WAIT_MS / 1000} s; serving while it finishes`);
  else if (row.status !== 'succeeded') log('warn', `demo-load (job ${id}) ${row.status}`, { error: row.error_json });
}

/** Job types that were WP0 stubs at M1 and that the demo pipeline queues (tasks/demo-load.mjs). */
const ONCE_STUBBED = ['cluster', 'layout'];

/**
 * Jobs that failed only because their task was still the WP0 stub (501 NOT_IMPLEMENTED) never ran. On a database
 * from M1 these are the demo's two clustering runs: queue each once, now that the task exists, then the demo's
 * deferred human layer (the label rename waits for a context group). A later job with the same type and params
 * marks it done, so this runs once (M5 gate).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{enqueue: Function, hasTask: Function}} jobs
 * @returns {number} jobs queued again
 */
export function requeueStubbedJobs(db, jobs) {
  const rows = stmt(db, `SELECT j.id, j.type, j.params_json FROM job j WHERE j.status = 'failed'
    AND json_extract(j.error_json, '$.code') = 'NOT_IMPLEMENTED' AND j.type IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM job k WHERE k.type = j.type AND k.params_json = j.params_json AND k.id > j.id)`).all(JSON.stringify(ONCE_STUBBED))
    .filter((r) => jobs.hasTask(r.type));
  if (!rows.length) return 0;
  for (const r of rows) {
    let params = {};
    try { params = JSON.parse(r.params_json); } catch { /* malformed: run with defaults */ }
    jobs.enqueue(r.type, params);
  }
  if (jobs.hasTask('adapter-load')) jobs.enqueue('adapter-load', { adapter: 'demo', apply: 'deferred' }, { priority: 9 });
  log('info', `queued ${rows.length} job(s) again that failed while their task was not built yet (${rows.map((r) => `#${r.id} ${r.type}`).join(', ')})`);
  return rows.length;
}

function ensureBootstrap(db, jobs) {
  if (FLAGS.noAutoImport) return;
  const st = cipherStatus();
  if (!st.ok) {
    log('info', 'Cipher files not found; no automatic import', { missing: st.missing });
    return;
  }
  if (!jobs.hasTask('bootstrap-cipher')) {
    log('info', 'bootstrap-cipher task not installed yet; no automatic import');
    return;
  }
  // "not yet done": never started, interrupted by a restart, or failed only because the task was still the
  // WP0 stub (501 NOT_IMPLEMENTED), so it never ran. Any other failed or cancelled bootstrap waits for the
  // user to start it again.
  const last = stmt(db, `SELECT status, json_extract(error_json, '$.code') AS code FROM job
    WHERE type = 'bootstrap-cipher' ORDER BY id DESC LIMIT 1`).get();
  const neverRan = last?.status === 'failed' && last.code === 'NOT_IMPLEMENTED';
  if (last && last.status !== 'interrupted' && !neverRan) return;
  jobs.enqueue('bootstrap-cipher', {});
}

// ── request pipeline ────────────────────────────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BODY) {
        reject(new HttpError(413, 'E_BODY_TOO_LARGE', 'The JSON body is larger than 25 MB.', 'Upload files through /api/imports.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(null);
      try { resolve(JSON.parse(text)); } catch (err) {
        reject(new HttpError(400, 'E_BAD_JSON', `The request body is not valid JSON: ${err.message}`, 'Send a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function wantsJson(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && /\bjson\b/i.test(String(req.headers['content-type'] ?? ''));
}

function sendError(req, res, err) {
  const status = statusOf(err);
  if (status >= 500 && err?.code !== 'QUERY_TIMEOUT') log('error', `${req.method} ${req.url} → ${status}`, { error: String(err?.stack ?? err) });
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(toErrorBody(err));
  const headers = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body) };
  if (err?.allow) headers.Allow = err.allow;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(req, res, resp, ctx) {
  const status = resp.status ?? 200;
  const headers = { ...SECURITY_HEADERS, ...(resp.headers ?? {}) };
  if (typeof resp.stream === 'function') {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    resp.stream(res);
    return;
  }
  let body = '';
  if (resp.json !== undefined) {
    body = JSON.stringify(resp.json);
    headers['Content-Type'] ??= 'application/json; charset=utf-8';
  } else if (resp.body !== undefined && resp.body !== null) {
    body = resp.body;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && status === 200 && resp.etag !== false) {
    const tag = etagFor(ctx.dataVersion(), typeof body === 'string' ? body : new Uint8Array(body));
    headers.ETag = tag;
    headers['Cache-Control'] ??= 'no-cache';
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  } else {
    headers['Cache-Control'] ??= 'no-store';
  }
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Start Scrolls.
 * @param {{port?: number, host?: string, mock?: boolean}} [opts]
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, ctx: object, router: object, close(): Promise<void>}>}
 */
export async function startServer({ port = PORT, host = HOST, mock = FLAGS.mock } = {}) {
  const router = createRouter();
  let db = null, pool = null, jobs = null;
  const ctx = {
    get db() { return db; },
    get pool() { return pool; },
    get jobs() { return jobs; },
    bus,
    dataVersion: () => (db ? dataVersion(db) : 0),
    /** The originals check of this boot (integrity.mjs): null until it has run. */
    integrity: null,
    /**
     * Short interactive write on the main connection (BEGIN IMMEDIATE, busy_timeout 5 s). Route handlers get a
     * per-request version that parks the request instead of waiting (runRoute).
     */
    withWrite(fn) {
      if (!db) throw new HttpError(503, 'E_MOCK', 'Mock mode has no database.');
      const before = dataVersion(db);
      const out = tx(db, fn);
      const after = dataVersion(db);
      if (after !== before) bus.emit('data', { dataVersion: after });
      return out;
    },
  };

  if (mock) {
    const { mockRoutes } = await import('./mock.mjs');
    for (const route of mockRoutes(CONTRACT_DIR)) router.add(route);
    // The fixtures include canned /api/events and /api/jobs/:id/events streams; a real SSE route is added
    // only where no fixture answers (the real ones need nothing but the bus)
    const { routes: sseRoutes } = await import('../routes/events.mjs');
    for (const r of sseRoutes) if (!router.match(r.method, r.path)) router.add(r);
    log('info', `mock mode: ${router.list().length} routes from tests/contract`);
  } else {
    try {
      ensureDirs();
      db = openDb();
      const m = migrate(db);
      if (m.from !== m.to) log('info', `database created (schema ${m.to})`);
      if (m.repaired) log('info', `data repaired at boot: ${JSON.stringify(m.repaired)}`);
      seedVocab(db);
      const reg = await registerAdapters(db);
      log('info', `adapters registered: ${reg.registered.length}; not installed: ${reg.skipped.length}`);
      pool = startReadPool();
      jobs = createJobQueue(db, { bus });
      const interrupted = jobs.recoverInterrupted();
      if (interrupted) log('warn', `${interrupted} job(s) were interrupted by the last shutdown`);
      jobs.schedule();
      await ensureDemo(db, jobs);
      ensureBootstrap(db, jobs);
      const n = await loadRoutes(router, ROUTES_DIR);
      log('info', `${n} routes loaded`);
    } catch (err) {
      await jobs?.close().catch(() => {});
      await pool?.close().catch(() => {});
      try { db?.close(); } catch { /* not open */ }
      throw err;
    }
  }

  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      checkRequest(req, { port: boundPort });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (serveStatic(req, res)) return;
        throw new HttpError(404, 'E_NOT_FOUND', `Nothing at ${url.pathname}.`, 'Open / for the app.');
      }
      const m = router.match(req.method, url.pathname);
      if (!m) {
        const allowed = router.methods(url.pathname);
        if (allowed.length) {
          throw Object.assign(new HttpError(405, 'E_METHOD_NOT_ALLOWED', `${req.method} is not supported on ${url.pathname}.`,
            `Use ${allowed.join(' or ')}.`), { allow: allowed.join(', ') });
        }
        throw new HttpError(404, 'E_NOT_FOUND', `No endpoint ${req.method} ${url.pathname}.`, 'See Docs/API.md for the endpoint list.');
      }
      const session = String(req.headers['x-scrolls-session'] ?? '');
      const sreq = {
        method: req.method === 'HEAD' ? 'GET' : req.method,
        path: url.pathname,
        params: m.params,
        query: Object.fromEntries(url.searchParams),
        searchParams: url.searchParams,
        headers: req.headers,
        // A route marked rawBody (file uploads) reads req.raw itself, whatever the Content-Type: a .json file
        // sent as application/json is a file, not a request body.
        body: wantsJson(req) && !m.route.rawBody ? await readJsonBody(req) : null,
        raw: req,
        sessionId: SESSION_RE.test(session) ? session : null,
      };
      const resp = await runRoute(m.route, sreq, ctx);
      send(req, res, resp, ctx);
    } catch (err) {
      sendError(req, res, err);
    }
  });
  server.keepAliveTimeout = 5000;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    await jobs?.close().catch(() => {});
    await pool?.close().catch(() => {});
    try { db?.close(); } catch { /* not open */ }
    throw err;
  }
  boundPort = server.address().port;
  const url = `http://${host}:${boundPort}`;
  log('info', `Scrolls ${mock ? '(mock) ' : ''}listening on ${url}`);
  if (pool) {
    ctx.integrity = { status: 'checking' };
    checkOriginals(pool, { dataDir: paths().data }).then((r) => { ctx.integrity = r; });
  }

  let closing = null;
  return {
    server,
    url,
    port: boundPort,
    ctx,
    router,
    close() {
      closing ??= (async () => {
        closeAllSse();
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await closed;
        await jobs?.close();
        await pool?.close();
        db?.close();
      })();
      return closing;
    },
  };
}
