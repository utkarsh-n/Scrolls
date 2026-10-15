// OWNER: WP0 — route table, auto-registration of server/routes/*.mjs, paging helpers (SPEC §7, §12.1)
//
// Route    = { method, path /* '/api/passages/:id' */, heavy?, sse?, handler(req: SReq, ctx: RouteCtx): Promise<Resp> }
// SReq     = { method, path, params, query, headers, body, raw, sessionId }
// RouteCtx = { db, pool, jobs, bus, dataVersion(), withWrite(fn) }
// Resp     = { status?, json?, body?, headers?, stream?: (res) => void, etag?: boolean }
// `heavy: true` marks routes whose query runs in the read pool (ctx.pool.run); `sse: true` marks streams;
// `rawBody: true` leaves the request body unread (req.body null) for the handler to stream from req.raw.

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log } from '../config.mjs';
import { badRequest } from './errors.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function compile(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new TypeError(`route path must start with /api/: ${path}`);
  const segments = path.split('/').slice(1).map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { lit: s }));
  for (const s of segments) if ('param' in s && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s.param)) throw new TypeError(`bad param in ${path}`);
  return segments;
}

function matchSegments(segments, parts) {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if ('lit' in s) {
      if (s.lit !== parts[i]) return null;
    } else {
      if (parts[i] === '') return null;
      try { params[s.param] = decodeURIComponent(parts[i]); } catch { return null; }
    }
  }
  return params;
}

/** Literal segments outrank parameters, position by position ('/api/lineage/path' beats '/api/lineage/:id'). */
function specificity(segments) {
  return segments.map((s) => ('lit' in s ? '1' : '0')).join('');
}

/**
 * @returns {{add(route: object): void, match(method: string, pathname: string): {route: object, params: object}|null,
 *   methods(pathname: string): string[], list(): object[]}}
 */
export function createRouter() {
  const routes = [];
  return {
    add(route) {
      if (!route || typeof route.handler !== 'function') throw new TypeError(`route ${route?.method} ${route?.path} has no handler`);
      const method = String(route.method).toUpperCase();
      if (!METHODS.has(method)) throw new TypeError(`unsupported method ${route.method}`);
      const segments = compile(route.path);
      const key = `${method} ${segments.map((s) => ('lit' in s ? s.lit : ':')).join('/')}`;
      const dup = routes.find((r) => r.key === key);
      if (dup) throw new Error(`route collision: ${method} ${route.path} (already ${dup.route.method} ${dup.route.path})`);
      routes.push({ key, method, segments, rank: specificity(segments), route: { ...route, method } });
      routes.sort((a, b) => (a.rank < b.rank ? 1 : a.rank > b.rank ? -1 : 0));
    },
    match(method, pathname) {
      const parts = pathname.split('/').slice(1);
      const m = String(method).toUpperCase() === 'HEAD' ? 'GET' : String(method).toUpperCase();
      for (const r of routes) {
        if (r.method !== m) continue;
        const params = matchSegments(r.segments, parts);
        if (params) return { route: r.route, params };
      }
      return null;
    },
    methods(pathname) {
      const parts = pathname.split('/').slice(1);
      return [...new Set(routes.filter((r) => matchSegments(r.segments, parts)).map((r) => r.method))];
    },
    list() {
      return routes.map((r) => r.route);
    },
  };
}

/**
 * Import every `*.mjs` in a directory and add its exported `routes`. A module that fails to load is logged
 * and skipped (a package's routes being unfinished must not stop the server).
 * @param {ReturnType<typeof createRouter>} router
 * @param {URL|string} dirUrl
 * @returns {Promise<number>} routes added
 */
export async function loadRoutes(router, dirUrl) {
  let base = dirUrl instanceof URL ? dirUrl : String(dirUrl).startsWith('file:') ? new URL(dirUrl) : pathToFileURL(String(dirUrl));
  if (!base.href.endsWith('/')) base = new URL(`${base.href}/`);
  let added = 0;
  const files = readdirSync(fileURLToPath(base)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  for (const file of files) {
    let mod;
    try {
      mod = await import(new URL(file, base).href);
    } catch (err) {
      log('warn', `routes/${file} failed to load; its endpoints are unavailable`, { error: String(err?.stack ?? err) });
      continue;
    }
    if (!Array.isArray(mod.routes)) {
      log('warn', `routes/${file} exports no routes array; skipped`);
      continue;
    }
    for (const route of mod.routes) {
      try {
        router.add(route);
        added++;
      } catch (err) {
        log('error', `routes/${file}: ${err.message}`);
      }
    }
  }
  return added;
}

// ── Paging (§7: every list takes limit ≤ 200 and an opaque cursor) ──────────────────────────────────

/**
 * Encode a cursor object as an opaque URL-safe string.
 * @param {object} obj
 * @returns {string}
 */
export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/**
 * @param {string|undefined|null} s
 * @returns {object|null}
 * @throws {HttpError} 400 E_BAD_CURSOR
 */
export function decodeCursor(s) {
  if (s === undefined || s === null || s === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  throw badRequest('E_BAD_CURSOR', 'The cursor is not one this server issued.', 'Restart the list without a cursor.');
}

/**
 * `limit` from a query object, clamped to [1, max].
 * @param {Record<string, string>} query
 * @param {{max?: number, dflt?: number}} [opts]
 * @returns {number}
 */
export function limitParam(query, { max = 200, dflt = 50 } = {}) {
  if (query.limit === undefined || query.limit === '') return Math.min(dflt, max);
  const n = Number(query.limit);
  if (!Number.isInteger(n) || n < 1) throw badRequest('E_BAD_LIMIT', `limit must be a positive integer (got '${query.limit}').`, `Use 1–${max}.`);
  return Math.min(n, max);
}
