// OWNER: WP0 — validate API bodies against src/shared/contracts.mjs SHAPES (used by every package's tests)
//
//   import { assertShape, checkResponse } from './helpers/shape.mjs';
//   assertShape('Passage', body);                                          // throws with every mismatch
//   const body = await checkResponse(res, 'GET', '/api/passages/:id');     // fetch Response → validated JSON

import assert from 'node:assert/strict';
import { check, ENDPOINTS, SHAPES } from '../../src/shared/contracts.mjs';
import { loadFixtures, variantShape, fixtureFileName } from '../../server/http/mock.mjs';

export { check, SHAPES, ENDPOINTS, fixtureFileName, variantShape };

/** Directory of the canned responses (one file per endpoint). */
export const CONTRACT_DIR = new URL('../contract/', import.meta.url);

/**
 * §7.1 endpoints that contracts.ENDPOINTS does not list because their body is not one JSON shape
 * (event streams, downloads, a 204), or because they reuse another endpoint's shape. Each has a fixture.
 */
export const EXTRA_ENDPOINTS = Object.freeze([
  { method: 'GET', path: '/api/events', response: null, owner: 'WP0', kind: 'sse' },
  { method: 'GET', path: '/api/jobs/:id/events', response: null, owner: 'WP0', kind: 'sse' },
  { method: 'GET', path: '/api/imports/:id/problems.csv', response: null, owner: 'WP1', kind: 'csv' },
  { method: 'POST', path: '/api/adapters/:id/enable', response: 'Adapters', owner: 'WP2', kind: 'json' },
  { method: 'GET', path: '/api/export', response: null, owner: 'WP3', kind: 'download' },
  { method: 'GET', path: '/api/snapshots/:file', response: null, owner: 'WP3', kind: 'binary' },
  { method: 'DELETE', path: '/api/views/:slug', response: null, owner: 'WP5', kind: 'empty' },
]);

/** Every endpoint with a fixture: contracts.ENDPOINTS plus EXTRA_ENDPOINTS. */
export const ALL_ENDPOINTS = Object.freeze([
  ...ENDPOINTS.map((e) => ({ ...e, kind: 'json' })),
  ...EXTRA_ENDPOINTS.map((e) => ({ ...e, request: null })),
]);

/**
 * Turn a concrete request path into its route pattern: '/api/passages/901' → '/api/passages/:id'.
 * @param {string} method
 * @param {string} pathname
 * @returns {{method: string, path: string, request: string|null, response: string|null}|null}
 */
export function endpointFor(method, pathname) {
  const want = pathname.split('?')[0].split('/');
  const hits = ALL_ENDPOINTS.filter((e) => {
    if (e.method !== method.toUpperCase()) return false;
    const segs = e.path.split('/');
    return segs.length === want.length && segs.every((s, i) => s.startsWith(':') || s === want[i]);
  });
  // A static segment beats a parameter ('/api/lineage/path' over a hypothetical '/api/lineage/:id').
  hits.sort((a, b) => a.path.split(':').length - b.path.split(':').length);
  return hits[0] ?? null;
}

/**
 * Throw an AssertionError listing every mismatch between `obj` and a shape.
 * @param {string} shapeName
 * @param {unknown} obj
 * @param {string} [label]
 */
export function assertShape(shapeName, obj, label = shapeName) {
  const errs = check(shapeName, obj);
  assert.deepEqual(errs, [], `${label} does not match ${shapeName}:\n  ${errs.join('\n  ')}`);
}

/**
 * Read a fetch Response, validate it against its endpoint's shape (ErrorBody when status ≥ 400) and
 * return the parsed body. `pattern` may be the route pattern or the concrete path.
 * @param {Response} res
 * @param {string} method
 * @param {string} pattern
 * @returns {Promise<unknown>}
 */
export async function checkResponse(res, method, pattern) {
  const ep = endpointFor(method, pattern);
  assert.ok(ep, `no endpoint ${method} ${pattern} in contracts.ENDPOINTS or EXTRA_ENDPOINTS`);
  if (res.status === 204) return null;
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { assert.fail(`${method} ${pattern}: body is not JSON: ${text.slice(0, 200)}`); }
  const shape = res.status >= 400 ? 'ErrorBody' : ep.response;
  if (shape) assertShape(shape, body, `${method} ${pattern} (${res.status})`);
  return body;
}

/**
 * All contract fixtures with their variants flattened, for table-driven tests.
 * @returns {Array<{file: string, method: string, path: string, fixture: object, name: string, variant: object, shape: string|null}>}
 */
export function fixtureVariants() {
  return loadFixtures(CONTRACT_DIR).flatMap(({ file, method, path, fixture }) =>
    Object.entries(fixture.variants).map(([name, variant]) => ({ file, method, path, fixture, name, variant, shape: variantShape(fixture, variant) })));
}

export { loadFixtures };
