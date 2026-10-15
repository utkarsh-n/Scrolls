// OWNER: WP0 — GET /api/events (SPEC §7.1): one SSE stream of 'job', 'data', 'adapter' and 'bootstrap' events

import { openSse } from '../http/sse.mjs';

/** Bus events relayed to every client. */
export const RELAYED = Object.freeze(['job', 'data', 'adapter', 'bootstrap']);

export const routes = [
  {
    method: 'GET',
    path: '/api/events',
    sse: true,
    async handler(req, ctx) {
      return {
        stream(res) {
          const sse = openSse(res);
          // the client learns the current data version at once, so it can drop stale tiles after a reconnect
          sse.send('data', { dataVersion: ctx.dataVersion() });
          const offs = RELAYED.map((name) => {
            const fn = (data) => sse.send(name, data);
            ctx.bus.on(name, fn);
            return () => ctx.bus.off(name, fn);
          });
          sse.onClose(() => { for (const off of offs) off(); });
        },
      };
    },
  },
];
