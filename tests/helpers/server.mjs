// OWNER: WP0 — run Scrolls for tests: as a child process (`node server.mjs`, so it can be SIGKILLed and
// restarted on the same data dir) or in-process; plus a raw HTTP client that can send any Host/Origin.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL('../../server.mjs', import.meta.url));

/**
 * One HTTP request with full control over headers (fetch cannot override Host). JSON bodies are encoded;
 * mutations get a same-origin Origin unless `origin: null` or another origin is given.
 * @param {string} baseUrl e.g. http://127.0.0.1:53029
 * @param {string} method
 * @param {string} pathname
 * @param {{body?: unknown, headers?: Record<string, string>, host?: string|null, origin?: string|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: number, headers: object, text: string, json: any}>}
 */
export function request(baseUrl, method, pathname, { body, headers = {}, host, origin, timeoutMs = 10000 } = {}) {
  const u = new URL(pathname, baseUrl);
  const h = { ...headers };
  h.Host = host === undefined ? u.host : host;
  if (h.Host === null) delete h.Host;
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const o = origin === undefined ? (mutating ? `${u.protocol}//${u.host}` : null) : origin;
  if (o) h.Origin = o;
  let payload = null;
  if (body !== undefined) {
    payload = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    if (!('Content-Type' in h)) h['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Read an SSE stream until `until(events)` is true or the timeout passes.
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {{until?: (events: Array<{event: string, data: any}>) => boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{event: string, data: any}>>}
 */
export function readSse(baseUrl, pathname, { until = () => false, timeoutMs = 5000 } = {}) {
  const u = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '';
    let done = false;
    const finish = (req) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(events); };
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Host: u.host, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (!data.length) continue;
          let parsed = data.join('\n');
          try { parsed = JSON.parse(parsed); } catch { /* text event */ }
          events.push({ event, data: parsed });
          if (until(events)) finish(req);
        }
      });
      res.on('end', () => finish(req));
    });
    req.on('error', (err) => (done ? null : reject(err)));
    const timer = setTimeout(() => finish(req), timeoutMs);
  });
}

/**
 * Spawn `node server.mjs` on a data dir (a fresh temp dir by default) and an OS-chosen port.
 * @param {{dataDir?: string|null, env?: Record<string, string>, timeoutMs?: number}} [opts]
 * @returns {Promise<{url: string, dataDir: string, child: import('node:child_process').ChildProcess, stderr: () => string,
 *   request: (method: string, pathname: string, opts?: object) => ReturnType<typeof request>,
 *   kill(signal?: string): Promise<number|null>, cleanup(): Promise<void>}>}
 */
export async function startServerProcess({ dataDir = null, env = {}, timeoutMs = 20000 } = {}) {
  const ownDir = !dataDir;
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), 'scrolls-srv-'));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, SCROLLS_DATA: dir, SCROLLS_PORT: '0', SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_NO_DEMO: '1',
      SCROLLS_LOG_LEVEL: 'warn', SCROLLS_MOCK: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in ${timeoutMs} ms: ${err}`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.startsWith('{') && l.includes('"listening"'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    exited.then((code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before listening: ${err}`)); });
  });
  return {
    url,
    dataDir: dir,
    child,
    stderr: () => err,
    request: (method, pathname, opts) => request(url, method, pathname, opts),
    async kill(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Run `node server.mjs` expecting it to fail at startup.
 * @param {Record<string, string>} env
 * @returns {Promise<{code: number|null, stderr: string}>}
 */
export function runServerExpectingExit(env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, SCROLLS_PORT: '0', SCROLLS_LOG_LEVEL: 'warn', ...env },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not exit')); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/**
 * Start the server in this process on a temp data dir (the caller sets env first if needed).
 * @param {{dataDir?: string|null, mock?: boolean}} [opts]
 * @returns {Promise<{url: string, dataDir: string, app: object, request: Function, cleanup(): Promise<void>}>}
 */
export async function startServerInProcess({ dataDir = null, mock = false } = {}) {
  const ownDir = !dataDir;
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), 'scrolls-srv-'));
  const saved = { ...process.env };
  Object.assign(process.env, { SCROLLS_DATA: dir, SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_NO_DEMO: '1',
    SCROLLS_LOG_LEVEL: process.env.SCROLLS_LOG_LEVEL ?? 'warn' });
  const { startServer } = await import('../../server/http/app.mjs');
  const app = await startServer({ port: 0, mock });
  return {
    url: app.url,
    dataDir: dir,
    app,
    request: (method, pathname, opts) => request(app.url, method, pathname, opts),
    async cleanup() {
      await app.close();
      for (const k of ['SCROLLS_DATA', 'SCROLLS_NO_AUTO_IMPORT', 'SCROLLS_NO_DEMO', 'SCROLLS_LOG_LEVEL']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
