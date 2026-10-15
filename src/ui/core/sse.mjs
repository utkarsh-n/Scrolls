// OWNER: WP0 — shared Server-Sent Events connections (SPEC §7.1 /api/events, /api/jobs/:id/events)
//
// Browsers allow only ~6 HTTP/1.1 connections per origin and every EventSource holds one open, so all
// subscribers of the same URL share a single EventSource (reference-counted; closed with the last
// subscriber). EventSource retries on its own after a dropped connection; when the browser gives up
// (readyState CLOSED, e.g. after a 404) the hub reconnects with backoff while anyone is still subscribed.

const LIFECYCLE = new Set(['onOpen', 'onError']);
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Parse an SSE data field: JSON when it parses, else the raw string.
 * @param {string} raw
 * @returns {unknown}
 */
export function parseSseData(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * @typedef {Record<string, ((data: unknown, evt: MessageEvent) => void) | undefined> & {
 *   onOpen?: () => void, onError?: (info: { readyState: number, retryInMs: number|null }) => void }} SseHandlers
 *   Keys are SSE event names ('progress', 'done', 'job', 'data' …; 'message' for unnamed events) plus the
 *   lifecycle callbacks onOpen / onError.
 */

/**
 * Create a hub of shared EventSource connections.
 * @param {{ EventSourceImpl?: typeof EventSource, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [opts]
 * @returns {{ subscribe(url: string, handlers: SseHandlers): () => void, close(): void, size(): number }}
 */
export function createSseHub({ EventSourceImpl = globalThis.EventSource, setTimer = setTimeout,
  clearTimer = clearTimeout } = {}) {
  /** @type {Map<string, {es: EventSource|null, subs: Set<SseHandlers>, events: Set<string>, attempt: number, timer: any}>} */
  const conns = new Map();

  function fanOut(conn, name, evt) {
    const data = parseSseData(evt.data);
    for (const h of [...conn.subs]) {
      try { h[name]?.(data, evt); } catch (err) { console.error(`[scrolls] sse handler '${name}':`, err); }
    }
  }

  function listen(conn, name) {
    if (conn.events.has(name)) return;
    conn.events.add(name);
    conn.es?.addEventListener(name, (evt) => fanOut(conn, name, evt));
  }

  function open(url, conn) {
    const es = new EventSourceImpl(url);
    conn.es = es;
    const events = [...conn.events];
    conn.events.clear();
    for (const name of events) listen(conn, name);
    es.onopen = () => {
      conn.attempt = 0;
      for (const h of [...conn.subs]) h.onOpen?.();
    };
    es.onerror = () => {
      const closed = es.readyState === 2;   // EventSource.CLOSED: the browser will not retry
      let retryInMs = null;
      if (closed && conn.subs.size) {
        retryInMs = BACKOFF_MS[Math.min(conn.attempt, BACKOFF_MS.length - 1)];
        conn.attempt += 1;
        conn.timer = setTimer(() => { conn.timer = null; if (conn.subs.size) open(url, conn); }, retryInMs);
      }
      for (const h of [...conn.subs]) h.onError?.({ readyState: es.readyState, retryInMs });
    };
  }

  return {
    subscribe(url, handlers) {
      if (typeof EventSourceImpl !== 'function') throw new Error('EventSource is not available in this environment');
      let conn = conns.get(url);
      if (!conn) {
        conn = { es: null, subs: new Set(), events: new Set(), attempt: 0, timer: null };
        conns.set(url, conn);
        open(url, conn);
      }
      conn.subs.add(handlers);
      for (const name of Object.keys(handlers)) if (!LIFECYCLE.has(name)) listen(conn, name);
      if (conn.es?.readyState === 1) handlers.onOpen?.();
      return function unsubscribe() {
        conn.subs.delete(handlers);
        if (conn.subs.size) return;
        if (conn.timer) clearTimer(conn.timer);
        conn.es?.close();
        conns.delete(url);
      };
    },

    close() {
      for (const conn of conns.values()) {
        if (conn.timer) clearTimer(conn.timer);
        conn.es?.close();
      }
      conns.clear();
    },

    size() { return conns.size; },
  };
}
