// OWNER: WP0 — the client for the local JSON API (SPEC §7, §8.1): fetch, abort-on-supersede, ETags,
// error mapping, uploads with progress and shared SSE subscriptions.

import { createSseHub } from './sse.mjs';

/** Error of a failed API call: the server's `{error: {code, message, hint, detail}}`, or a local one. */
export class ApiError extends Error {
  /**
   * @param {{status: number, code: string, message: string, hint?: string|null, detail?: unknown, path?: string}} e
   */
  constructor({ status, code, message, hint = null, detail = null, path = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.detail = detail;
    this.path = path;
  }
}

/**
 * True for the AbortError thrown when a request was superseded or cancelled; callers ignore these.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

const ETAG_CACHE_MAX = 256;
const JSON_TYPE = /\bjson\b/i;

/**
 * Build a query string: null/undefined values are skipped, arrays are joined with ','.
 * @param {Record<string, unknown>|null|undefined} query
 * @returns {string} '' or '?a=1&b=x'
 */
export function queryString(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function errorFrom(res, path) {
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
  const e = body?.error;
  if (e && typeof e.code === 'string') {
    return new ApiError({ status: res.status, code: e.code, message: e.message ?? e.code, hint: e.hint ?? null, detail: e.detail ?? null, path });
  }
  return new ApiError({ status: res.status, code: `HTTP_${res.status}`, message: `The server answered ${res.status} ${res.statusText || ''}`.trim(), path });
}

function networkError(err, path) {
  return new ApiError({
    status: 0, code: 'E_NETWORK', path, detail: String(err?.message ?? err),
    message: 'The local Scrolls server is not responding.',
    hint: 'Check that `npm start` is still running, then retry.',
  });
}

/**
 * @typedef {{ signal?: AbortSignal, key?: string, headers?: Record<string, string>, as?: 'json'|'text'|'blob' }} RequestOpts
 *   `key`: a newer request with the same key aborts this one (e.g. key 'tiles' while panning).
 * @typedef {{
 *   get(path: string, query?: Record<string, unknown>|null, opts?: RequestOpts): Promise<any>,
 *   post(path: string, body?: unknown, opts?: RequestOpts & {query?: Record<string, unknown>}): Promise<any>,
 *   put(path: string, body?: unknown, opts?: RequestOpts & {query?: Record<string, unknown>}): Promise<any>,
 *   patch(path: string, body?: unknown, opts?: RequestOpts & {query?: Record<string, unknown>}): Promise<any>,
 *   del(path: string, opts?: RequestOpts & {query?: Record<string, unknown>}): Promise<any>,
 *   upload(path: string, file: Blob, headers?: Record<string, string>, onProgress?: (fraction: number, loaded: number, total: number) => void): Promise<any>,
 *   sse(path: string, handlers: import('./sse.mjs').SseHandlers): () => void,
 *   url(path: string, query?: Record<string, unknown>|null): string,
 *   abort(key: string): void
 * }} Api
 */

/**
 * Create the API client. Paths are relative to `base` ('/search' → '/api/search'). Every request sends
 * `X-Scrolls-Session` (the multiplicity log, §2.E) and, in mock mode, `X-Scrolls-Mock: <variant>` to pick
 * a canned variant (gated, empty, error …; see Docs/API.md). GET responses are cached by URL with their
 * ETag and revalidated with If-None-Match. Non-2xx answers throw ApiError; superseded requests reject
 * with an AbortError (see isAbort).
 * @param {{ base?: string, sessionId: string, mockVariant?: string|null, fetchImpl?: typeof fetch,
 *           EventSourceImpl?: typeof EventSource, XhrImpl?: typeof XMLHttpRequest }} opts
 * @returns {Api}
 */
export function createApi({ base = '/api', sessionId, mockVariant = null, fetchImpl = globalThis.fetch?.bind(globalThis),
  EventSourceImpl = globalThis.EventSource, XhrImpl = globalThis.XMLHttpRequest } = {}) {
  const inflight = new Map();
  const etags = new Map();
  let hub = null;

  const url = (path, query = null) => `${base}${path.startsWith('/') ? path : `/${path}`}${queryString(query)}`;

  function baseHeaders(extra) {
    const hdr = { Accept: 'application/json', 'X-Scrolls-Session': String(sessionId ?? '') };
    if (mockVariant) hdr['X-Scrolls-Mock'] = mockVariant;
    return { ...hdr, ...extra };
  }

  function signalFor(key, external) {
    let own = null;
    if (key) {
      inflight.get(key)?.abort();
      own = new AbortController();
      inflight.set(key, own);
    }
    const signals = [own?.signal, external].filter(Boolean);
    const signal = signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
    return { signal, own };
  }

  function remember(u, etag, body) {
    if (!etag) return;
    etags.delete(u);
    etags.set(u, { etag, body });
    if (etags.size > ETAG_CACHE_MAX) etags.delete(etags.keys().next().value);
  }

  async function request(method, path, { query = null, body, raw, signal: external, key, headers, as = 'json' } = {}) {
    const u = url(path, query);
    const { signal, own } = signalFor(key, external);
    const hdr = baseHeaders(headers);
    const cached = method === 'GET' ? etags.get(u) : null;
    if (cached) hdr['If-None-Match'] = cached.etag;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined && body !== null && method !== 'GET') {
      payload = JSON.stringify(body);
      hdr['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetchImpl(u, { method, headers: hdr, body: payload, signal, credentials: 'same-origin' });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw networkError(err, u);
    } finally {
      if (own && inflight.get(key) === own) inflight.delete(key);
    }
    if (res.status === 304 && cached) return structuredClone(cached.body);
    if (!res.ok) throw await errorFrom(res, u);
    if (res.status === 204) return null;
    if (as === 'blob') return res.blob();
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const out = as === 'text' || !JSON_TYPE.test(type) ? text : text ? JSON.parse(text) : null;
    if (method === 'GET' && as === 'json') remember(u, res.headers.get('etag'), out);
    return out;
  }

  function upload(path, file, headers = {}, onProgress = null) {
    const u = url(path);
    if (typeof XhrImpl !== 'function') {
      return request('POST', path, { headers: { ...headers, 'Content-Type': file?.type || 'application/octet-stream' }, raw: file });
    }
    return new Promise((resolve, reject) => {
      const xhr = new XhrImpl();
      xhr.open('POST', u);
      for (const [k, v] of Object.entries(baseHeaders(headers))) xhr.setRequestHeader(k, v);
      if (!headers['Content-Type']) xhr.setRequestHeader('Content-Type', file?.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total, e.loaded, e.total); };
      xhr.onerror = () => reject(networkError(new Error('upload failed'), u));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      xhr.onload = () => {
        let body = null;
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { body = null; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return; }
        const e = body?.error;
        reject(new ApiError({
          status: xhr.status, code: e?.code ?? `HTTP_${xhr.status}`, message: e?.message ?? `The server answered ${xhr.status}`,
          hint: e?.hint ?? null, detail: e?.detail ?? null, path: u,
        }));
      };
      xhr.send(file);
    });
  }

  return {
    get: (path, query = null, opts = {}) => request('GET', path, { ...opts, query }),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    put: (path, body, opts = {}) => request('PUT', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    del: (path, opts = {}) => request('DELETE', path, opts),
    upload,
    sse(path, handlers) {
      hub ??= createSseHub({ EventSourceImpl });
      const q = mockVariant ? queryString({ mock: mockVariant }) : '';
      return hub.subscribe(url(path) + q, handlers);
    },
    url,
    abort(key) { inflight.get(key)?.abort(); inflight.delete(key); },
  };
}
