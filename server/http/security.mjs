// OWNER: WP0 — localhost-only request checks: DNS-rebinding guard and same-origin mutations (SPEC §7, D12)

import { HttpError } from './errors.mjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];

/**
 * Response headers set on every response. The CSP keeps the app local (rule 16): scripts, styles, fetches
 * and workers only from this origin; images may also be data:/blob: (canvas snapshots).
 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
});

/** @param {number} port @returns {string[]} the accepted Host header values */
export function allowedHosts(port) {
  return LOOPBACK_NAMES.map((h) => `${h}:${port}`);
}

/** @param {number} port @returns {string[]} the accepted Origin header values */
export function allowedOrigins(port) {
  return allowedHosts(port).map((h) => `http://${h}`);
}

function forbidden(message, hint) {
  return new HttpError(403, 'E_FORBIDDEN_ORIGIN', message, hint, null);
}

/**
 * Reject requests that did not come from this app on this machine.
 *  · Host must be 127.0.0.1:<port> or localhost:<port> (a rebinding attacker's page sends its own name).
 *  · POST/PUT/PATCH/DELETE must carry a same-origin Origin header (browsers always send one on these
 *    methods; scripts and tests set it explicitly).
 *  · A cross-site Sec-Fetch-Site on any request is refused.
 * @param {{method?: string, headers: Record<string, string|string[]|undefined>}} req
 * @param {{port: number}} opts
 * @throws {HttpError} 403 E_FORBIDDEN_ORIGIN
 */
export function checkRequest(req, { port }) {
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (!allowedHosts(port).includes(host)) {
    throw forbidden(`Host '${host || '(none)'}' is not this Scrolls server.`,
      `Open http://127.0.0.1:${port}/ directly; Scrolls only answers on the loopback address.`);
  }
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') {
    throw forbidden('Cross-site requests are refused.', 'Use the Scrolls page itself.');
  }
  if (MUTATING.has(String(req.method ?? 'GET').toUpperCase())) {
    const origin = String(req.headers.origin ?? '').trim().toLowerCase();
    if (!allowedOrigins(port).includes(origin)) {
      throw forbidden(origin ? `Origin '${origin}' may not change data here.` : 'A change request must carry this page\'s Origin header.',
        `Send 'Origin: http://127.0.0.1:${port}' (the Scrolls page does this automatically).`);
    }
  }
}
