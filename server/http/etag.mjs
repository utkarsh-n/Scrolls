// OWNER: WP0 — weak ETags W/"<dataVersion>-<fnv1a32 hex>" and If-None-Match matching (SPEC §7, D12)

import { fnv1a32 } from '../../src/shared/ids.mjs';

/**
 * @param {number} dataVersion meta.data_version when the body was computed
 * @param {string|Uint8Array} body the exact response body
 * @returns {string} e.g. W/"47-3b91c2d0"
 */
export function etagFor(dataVersion, body) {
  return `W/"${dataVersion}-${fnv1a32(body).toString(16).padStart(8, '0')}"`;
}

/**
 * Weak comparison of an If-None-Match header against an ETag (RFC 9110 §13.1.2).
 * @param {string|undefined} header
 * @param {string} etag
 * @returns {boolean}
 */
export function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const opaque = (t) => t.trim().replace(/^W\//, '');
  const want = opaque(etag);
  return header.split(',').some((t) => opaque(t) === want);
}
