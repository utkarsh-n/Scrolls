#!/usr/bin/env node
// OWNER: N0
// Runs the reference's own contract validator (src/shared/contracts.mjs `check`, which also enforces "a gated value has
// no numeral") over responses the Swift engine encoded (IOS-SPEC §2.2 G7). Input is JSONL, one exchange per line:
//   {"id": "…", "method": "GET", "path": "/api/passages/901?x=1", "status": 200, "body": {…}}      (shape from ENDPOINTS)
//   {"id": "…", "shape": "Passage", "body": {…}}                                                (an explicit shape)
// Request bodies are checked the same way when an exchange carries "request" and the endpoint names a request shape.
//   node Golden/validate-contracts.mjs <responses.jsonl> [--report <file.json>]
// Exit 0 when every body validates, 1 otherwise. Non-JSON endpoints (SSE, CSV, downloads, 204) are listed as skipped.

import { readFileSync, writeFileSync } from 'node:fs';
import { ENDPOINTS, check } from '../../src/shared/contracts.mjs';

const routes = ENDPOINTS.map(({ method, path, request, response }) => ({
  method, path, request, response,
  re: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z_]+/gi, '[^/]+')}$`),
}));

/** The ENDPOINTS row of a concrete request (query string ignored), or null. */
export function routeOf(method, path) {
  const p = String(path).split('?')[0];
  return routes.find((r) => r.method === method && r.re.test(p)) ?? null;
}

/** Validates one exchange; returns {id, shape, errors} rows (empty errors = valid) or a skip. */
export function validateExchange(x) {
  const out = [];
  const route = x.method ? routeOf(x.method, x.path) : null;
  const responseShape = x.shape ?? route?.response ?? null;
  if (!responseShape) return [{ id: x.id ?? null, shape: null, skipped: `no JSON shape for ${x.method} ${x.path}` }];
  if (x.status === undefined || (x.status >= 200 && x.status < 300)) {
    out.push({ id: x.id ?? null, shape: responseShape, errors: check(responseShape, x.body) });
  } else {
    out.push({ id: x.id ?? null, shape: 'ErrorBody', errors: check('ErrorBody', x.body) });
  }
  if (x.request !== undefined && route?.request) out.push({ id: x.id ?? null, shape: route.request, errors: check(route.request, x.request) });
  return out;
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error('usage: validate-contracts.mjs <responses.jsonl> [--report <file.json>]');
  const reportPath = rest[0] === '--report' ? rest[1] : null;
  const rows = [];
  readFileSync(file, 'utf8').split('\n').filter(Boolean).forEach((line, i) => {
    let x;
    try { x = JSON.parse(line); } catch (e) { rows.push({ id: `line ${i + 1}`, shape: null, errors: [`not JSON: ${e.message}`] }); return; }
    rows.push(...validateExchange(x));
  });
  const failures = rows.filter((r) => r.errors?.length);
  const report = { checked: rows.filter((r) => r.errors).length, skipped: rows.filter((r) => r.skipped).length,
    failures: failures.length, rows: failures.concat(rows.filter((r) => r.skipped)) };
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const f of failures.slice(0, 20)) console.error(`FAIL ${f.id ?? '?'} (${f.shape}): ${f.errors.slice(0, 3).join('; ')}`);
  console.log(JSON.stringify({ checked: report.checked, skipped: report.skipped, failures: report.failures }));
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-contracts.mjs')) {
  try { main(); } catch (e) { console.error(`[validate-contracts] FAILED: ${e?.message ?? e}`); process.exit(1); }
}
