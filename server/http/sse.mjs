// OWNER: WP0 — Server-Sent Events and the in-process event bus (SPEC §7.1 /api/events, §12.2)

import { EventEmitter } from 'node:events';

/**
 * The process-wide bus. Events: 'job' (job progress/state), 'data' ({dataVersion} after a committed write),
 * 'adapter' (adapter load state), 'bootstrap' (Cipher bootstrap progress).
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const open = new Set();

/**
 * Turn a response into an SSE stream. Sends a heartbeat comment every `heartbeatMs` so proxies and the
 * browser keep the connection; stops on close.
 * @param {import('node:http').ServerResponse} res
 * @param {{heartbeatMs?: number}} [opts]
 * @returns {{send(event: string, data: unknown): void, close(): void, onClose(fn: () => void): void}}
 */
export function openSse(res, { heartbeatMs = 15000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let closed = false;
  const closers = [];
  const timer = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, heartbeatMs);
  timer.unref?.();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    open.delete(handle);
    for (const fn of closers.splice(0)) {
      try { fn(); } catch { /* a closer never breaks the others */ }
    }
  };
  const handle = {
    send(event, data) {
      if (closed) return;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      let out = `event: ${event}\n`;
      for (const line of payload.split(/\r?\n/)) out += `data: ${line}\n`;
      res.write(out + '\n');
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
    onClose(fn) {
      if (closed) fn(); else closers.push(fn);
    },
  };
  res.on('close', finish);
  open.add(handle);
  return handle;
}

/** Close every open SSE stream (server shutdown). */
export function closeAllSse() {
  for (const h of [...open]) h.close();
}
