// OWNER: WP0 — mock mode (SCROLLS_MOCK=1): serves tests/contract/*.json as the API (SPEC §12.2)
//
// One route per fixture file `<METHOD>__<path>.json`, where the path drops its leading '/', '/' becomes '_'
// and a ':param' segment is written '{param}' (GET /api/passages/:id → GET__api_passages_{id}.json; no ':'
// in file names, which iCloud and Windows checkouts handle badly). A fixture holds named variants (ok,
// gated, empty, error …). The variant served is, in order: the one named by the `X-Scrolls-Mock` header or
// the `mock` query parameter; the first whose `when` matches the request; the fixture's `default`.
// Request bodies are checked against the endpoint's request shape exactly as the real server would.
// Every variant was validated against src/shared/contracts.mjs by tests/contract-fixtures.test.mjs.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { check } from '../../src/shared/contracts.mjs';

export const MOCK_HEADER = 'x-scrolls-mock';
const HEARTBEAT_MS = 15000;

/**
 * Fixture file name of an endpoint: ('GET', '/api/passages/:id') → 'GET__api_passages_{id}.json'.
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
export function fixtureFileName(method, path) {
  if (!/^\/api(\/[\w.{}:-]+)*$/.test(path) || path.includes('_')) throw new TypeError(`fixtureFileName: unsupported path '${path}'`);
  return `${method.toUpperCase()}__${path.slice(1).replace(/:([A-Za-z]\w*)/g, '{$1}').replace(/\//g, '_')}.json`;
}

/**
 * Inverse of fixtureFileName, or null for a name that is not a fixture.
 * @param {string} name
 * @returns {{method: string, path: string}|null}
 */
export function parseFixtureFileName(name) {
  const m = /^(GET|POST|PUT|PATCH|DELETE)__(api(?:_[\w.{}-]+)*)\.json$/.exec(name);
  if (!m) return null;
  return { method: m[1], path: `/${m[2].replace(/_/g, '/').replace(/\{(\w+)\}/g, ':$1')}` };
}

const toDirPath = (dir) => (dir instanceof URL || String(dir).startsWith('file:') ? fileURLToPath(dir) : String(dir));

/**
 * Read every fixture of a contract directory, sorted by file name.
 * @param {URL|string} contractDir
 * @returns {Array<{file: string, method: string, path: string, fixture: object}>}
 */
export function loadFixtures(contractDir) {
  const dir = toDirPath(contractDir);
  return readdirSync(dir).filter((f) => parseFixtureFileName(f)).sort().map((file) => {
    const { method, path } = parseFixtureFileName(file);
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (fixture.method !== method || fixture.path !== path) {
      throw new Error(`${file}: declares ${fixture.method} ${fixture.path}, file name says ${method} ${path}`);
    }
    if (!fixture.variants?.[fixture.default]) throw new Error(`${file}: default variant '${fixture.default}' is missing`);
    return { file, method, path, fixture };
  });
}

/**
 * Shape a variant's body must satisfy: its own `shape`, else the endpoint's response shape for a
 * success and ErrorBody for status ≥ 400; null when the variant has no JSON body (204, text, binary, SSE)
 * or is declared `unshaped`.
 * @param {object} fixture
 * @param {object} variant
 * @returns {string|null}
 */
export function variantShape(fixture, variant) {
  if (variant.shape !== undefined) return variant.shape;
  if (variant.body === undefined) return null;
  return (variant.status ?? 200) >= 400 ? 'ErrorBody' : fixture.response ?? null;
}

const getHeader = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const getQuery = (query, name) => {
  if (!query) return undefined;
  if (typeof query.get === 'function') return query.get(name) ?? undefined;
  const v = query[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Does a variant's `when` ({query, params, body} of expected values) match the request? */
function matches(when, req) {
  if (!when) return false;
  for (const [k, v] of Object.entries(when.query ?? {})) if (getQuery(req.query, k) !== String(v)) return false;
  for (const [k, v] of Object.entries(when.params ?? {})) if (String(req.params?.[k]) !== String(v)) return false;
  for (const [k, v] of Object.entries(when.body ?? {})) {
    if (JSON.stringify(req.body?.[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

/**
 * Choose the variant for a request.
 * @param {object} fixture
 * @param {{query?: any, params?: object, headers?: any, body?: any}} req
 * @returns {{name: string, variant: object, requested: string|null}}
 */
export function selectVariant(fixture, req) {
  const requested = getHeader(req.headers, MOCK_HEADER) ?? getQuery(req.query, 'mock') ?? null;
  if (requested && fixture.variants[requested]) return { name: requested, variant: fixture.variants[requested], requested };
  for (const [name, variant] of Object.entries(fixture.variants)) {
    if (matches(variant.when, req)) return { name, variant, requested };
  }
  return { name: fixture.default, variant: fixture.variants[fixture.default], requested };
}

/** Format one SSE message. */
export function formatSse({ event, data, id }) {
  let out = '';
  if (id !== undefined) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  out += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  return out;
}

function sseStream(variant, name) {
  const events = variant.events ?? [];
  return (res) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive',
        'x-scrolls-mock-variant': name,
      });
    }
    res.write('retry: 3000\n\n');
    let i = 0, timer = null, heartbeat = null, closed = false;
    const stop = () => { closed = true; clearTimeout(timer); clearInterval(heartbeat); };
    res.on?.('close', stop);
    const next = () => {
      if (closed) return;
      if (i >= events.length) {
        if (variant.keep_open) heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
        else { stop(); res.end(); }
        return;
      }
      const e = events[i++];
      timer = setTimeout(() => { if (!closed) { res.write(formatSse(e)); next(); } }, e.delay_ms ?? 0);
    };
    next();
  };
}

/**
 * Turn a variant into a route response (SPEC §12.2 Resp).
 * @param {object} fixture
 * @param {string} name
 * @param {object} variant
 * @returns {{status?: number, json?: unknown, body?: string|Buffer, headers?: Record<string, string>, stream?: (res: any) => void}}
 */
export function variantResponse(fixture, name, variant) {
  const headers = {
    'x-scrolls-mock-variant': name,
    'x-scrolls-mock-variants': Object.keys(fixture.variants).join(','),
    ...(variant.headers ?? {}),
  };
  const status = variant.status ?? 200;
  if (variant.events) return { status: 200, headers, stream: sseStream(variant, name) };
  if (status === 204) return { status, headers };
  if (variant.text !== undefined) return { status, headers: { 'content-type': variant.content_type ?? 'text/plain; charset=utf-8', ...headers }, body: variant.text };
  if (variant.base64 !== undefined) return { status, headers: { 'content-type': variant.content_type ?? 'application/octet-stream', ...headers }, body: Buffer.from(variant.base64, 'base64') };
  return { status, headers, json: structuredClone(variant.body) };
}

function validationError(shape, errors) {
  return {
    status: 400,
    headers: { 'x-scrolls-mock-variant': '(request validation)' },
    json: { error: { code: 'E_VALIDATION', message: `The request body does not match ${shape}.`, hint: errors[0] ?? null, detail: errors } },
  };
}

/**
 * Routes that answer every endpoint from its fixture. Fixtures whose variants break their shape are
 * still served, with one warning each at load (the contract test fails on them).
 * @param {URL|string} contractDirUrl e.g. new URL('../../tests/contract/', import.meta.url)
 * @returns {Array<{method: string, path: string, heavy: false, sse: boolean, mock: true,
 *                  handler: (req: object, ctx?: object) => Promise<object>}>}
 */
export function mockRoutes(contractDirUrl) {
  const routes = [];
  for (const { file, method, path, fixture } of loadFixtures(contractDirUrl)) {
    for (const [name, variant] of Object.entries(fixture.variants)) {
      const shape = variantShape(fixture, variant);
      const errs = shape ? check(shape, variant.body) : [];
      if (errs.length) console.warn(`[scrolls mock] ${file} variant '${name}' does not match ${shape}: ${errs[0]}`);
    }
    const sse = Object.values(fixture.variants).some((v) => v.events);
    routes.push({
      method, path, heavy: false, sse, mock: true,
      async handler(req) {
        const { name, variant, requested } = selectVariant(fixture, req);
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        if (!requested && fixture.request && hasBody) {
          const errs = check(fixture.request, req.body ?? null);
          if (errs.length) return validationError(fixture.request, errs);
        }
        return variantResponse(fixture, name, variant);
      },
    });
  }
  // Static segments before parameters, so '/api/lineage/path' never falls to a ':param' route.
  const weight = (p) => p.split('/').map((s) => (s.startsWith(':') ? '1' : '0')).join('');
  return routes.sort((a, b) => weight(a.path).localeCompare(weight(b.path)) || a.path.localeCompare(b.path));
}
