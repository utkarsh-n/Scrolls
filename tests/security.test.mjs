// OWNER: WP0 — localhost only: Host/Origin checks (403 E_FORBIDDEN_ORIGIN), loopback bind, static file
// containment, iCloud refusal, error bodies and ETags (SPEC D12, §7, §11 "Security and localhost")

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CONTRACT_VERSION } from '../src/shared/contracts.mjs';
import { dataDir } from '../server/config.mjs';
import { etagFor, etagMatches } from '../server/http/etag.mjs';
import { HttpError, toErrorBody } from '../server/http/errors.mjs';
import { createRouter } from '../server/http/router.mjs';
import { checkRequest } from '../server/http/security.mjs';
import { resolveStatic } from '../server/http/static.mjs';
import { runServerExpectingExit, startServerInProcess, startServerProcess } from './helpers/server.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

describe('checkRequest', () => {
  const ok = (headers, method = 'GET') => checkRequest({ method, headers }, { port: 3460 });
  const forbidden = (headers, method = 'GET') => assert.throws(() => ok(headers, method),
    (e) => e instanceof HttpError && e.status === 403 && e.code === 'E_FORBIDDEN_ORIGIN' && Boolean(e.hint));

  test('Host must be this server on the loopback name and port', () => {
    ok({ host: '127.0.0.1:3460' });
    ok({ host: 'localhost:3460' });
    ok({ host: 'LOCALHOST:3460' });
    forbidden({ host: 'evil.example:3460' });
    forbidden({ host: 'attacker.example' });
    forbidden({ host: '127.0.0.1:3461' });
    forbidden({ host: '127.0.0.1' });
    forbidden({ host: '[::1]:3460' });
    forbidden({});
  });

  test('mutations need a same-origin Origin; cross-site fetches are refused', () => {
    ok({ host: '127.0.0.1:3460', origin: 'http://127.0.0.1:3460' }, 'POST');
    ok({ host: '127.0.0.1:3460', origin: 'http://localhost:3460' }, 'DELETE');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      forbidden({ host: '127.0.0.1:3460' }, m);
      forbidden({ host: '127.0.0.1:3460', origin: 'http://evil.example' }, m);
      forbidden({ host: '127.0.0.1:3460', origin: 'null' }, m);
      forbidden({ host: '127.0.0.1:3460', origin: 'https://127.0.0.1:3460' }, m);
    }
    ok({ host: '127.0.0.1:3460' }, 'GET');
    forbidden({ host: '127.0.0.1:3460', 'sec-fetch-site': 'cross-site' }, 'GET');
    ok({ host: '127.0.0.1:3460', 'sec-fetch-site': 'same-origin' }, 'GET');
  });
});

describe('static file containment', () => {
  test('only public/, src/ui and src/shared are reachable', () => {
    assert.ok(resolveStatic('/shared/vocab.mjs')?.endsWith(path.join('src', 'shared', 'vocab.mjs')));
    assert.ok(resolveStatic('/ui/main.mjs')?.endsWith(path.join('src', 'ui', 'main.mjs')));
    assert.ok(resolveStatic('/')?.endsWith(path.join('public', 'index.html')));
    for (const bad of ['/../server/config.mjs', '/ui/../../server/config.mjs', '/%2e%2e/server/config.mjs', '/shared/..%2f..%2fserver%2fconfig.mjs',
      '/.git/config', '/ui/.hidden.mjs', '/shared/%00vocab.mjs', '/shared/vocab.mjs\\..', '/ui/x.sh', '/%E0%A4%A']) {
      assert.equal(resolveStatic(bad), null, bad);
    }
    assert.ok(!resolveStatic('/server/config.mjs') || !existsSync(resolveStatic('/server/config.mjs')), 'server/** is never served');
  });
});

describe('errors and ETags', () => {
  test('error bodies never leak internals', () => {
    assert.deepEqual(toErrorBody(new HttpError(404, 'E_NOT_FOUND', 'Job 3 not found.')),
      { error: { code: 'E_NOT_FOUND', message: 'Job 3 not found.', hint: null, detail: null } });
    const internal = toErrorBody(new Error('SELECT secret FROM x failed at /Users/…'));
    assert.equal(internal.error.code, 'E_INTERNAL');
    assert.doesNotMatch(JSON.stringify(internal), /SELECT|Users/);
    const sqlite = Object.assign(new Error('CHECK constraint failed: relationship evidence fields are immutable'), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
    assert.equal(toErrorBody(sqlite).error.code, 'E_CONSTRAINT');
  });

  test('etagFor / etagMatches', () => {
    const tag = etagFor(47, '{"a":1}');
    assert.match(tag, /^W\/"47-[0-9a-f]{8}"$/);
    assert.equal(etagFor(47, '{"a":1}'), tag);
    assert.notEqual(etagFor(48, '{"a":1}'), tag);
    assert.notEqual(etagFor(47, '{"a":2}'), tag);
    assert.ok(etagMatches(tag, tag));
    assert.ok(etagMatches(`"x", ${tag.slice(2)}`, tag));
    assert.ok(etagMatches('*', tag));
    assert.ok(!etagMatches(undefined, tag));
    assert.ok(!etagMatches('W/"47-00000000"', tag));
  });

  test('router: collisions refused, literals beat parameters, 405 lists methods', () => {
    const r = createRouter();
    const h = async () => ({});
    r.add({ method: 'GET', path: '/api/lineage/:id', handler: h });
    r.add({ method: 'GET', path: '/api/lineage/path', handler: h });
    assert.throws(() => r.add({ method: 'GET', path: '/api/lineage/:other', handler: h }), /collision/);
    assert.throws(() => r.add({ method: 'GET', path: '/nope', handler: h }), /\/api\//);
    assert.equal(r.match('GET', '/api/lineage/path').route.path, '/api/lineage/path');
    assert.deepEqual(r.match('GET', '/api/lineage/passage%3A77').params, { id: 'passage:77' });
    assert.equal(r.match('POST', '/api/lineage/path'), null);
    assert.deepEqual(r.methods('/api/lineage/path'), ['GET']);
  });
});

describe('the running server', () => {
  let srv;
  before(async () => {
    srv = await startServerInProcess();
    srv.app.router.add({ method: 'GET', path: '/api/_test/etag', handler: async () => ({ json: { hello: 'scrolls' } }) });
    srv.app.router.add({ method: 'POST', path: '/api/_test/echo', handler: async (req) => ({ json: { body: req.body, session: req.sessionId } }) });
  });
  after(async () => { await srv.cleanup(); });

  test('listens on 127.0.0.1 only and answers /api/health', async () => {
    assert.equal(srv.app.server.address().address, '127.0.0.1');
    const r = await srv.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.contract, CONTRACT_VERSION);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /connect-src 'self'/);
  });

  test('a foreign Host or a cross-origin mutation gets 403 E_FORBIDDEN_ORIGIN', async () => {
    const port = new URL(srv.url).port;
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`]) {
      const r = await srv.request('GET', '/api/health', { host });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error.code, 'E_FORBIDDEN_ORIGIN');
    }
    assert.equal((await srv.request('GET', '/api/health', { host: `localhost:${port}` })).status, 200);
    const noOrigin = await srv.request('POST', '/api/jobs/1/cancel', { origin: null });
    assert.equal(noOrigin.status, 403);
    const foreign = await srv.request('POST', '/api/jobs/1/cancel', { origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, 'E_FORBIDDEN_ORIGIN');
    const same = await srv.request('POST', '/api/jobs/1/cancel');
    assert.equal(same.status, 200);
    assert.deepEqual(same.json, { status: 'not_found' });
    const page = await srv.request('GET', '/', { host: 'rebind.attacker.example' });
    assert.equal(page.status, 403, 'the page itself is refused to a rebinding host');
  });

  test('server code and traversal attempts are 404; shared modules are served', async () => {
    for (const p of ['/server/config.mjs', '/ui/../../server/config.mjs', '/%2e%2e/server/config.mjs', '/package.json', '/tests/helpers/server.mjs']) {
      const r = await srv.request('GET', p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /OWNER: WP0 — runtime configuration/);
    }
    const shared = await srv.request('GET', '/shared/vocab.mjs');
    assert.equal(shared.status, 200);
    assert.match(shared.headers['content-type'], /^text\/javascript/);
    const again = await srv.request('GET', '/shared/vocab.mjs', { headers: { 'If-None-Match': shared.headers.etag } });
    assert.equal(again.status, 304);
  });

  test('JSON errors: 404, 405 with Allow, 400 bad JSON; session ids are sanitised', async () => {
    const nf = await srv.request('GET', '/api/does-not-exist');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'E_NOT_FOUND');
    const m = await srv.request('DELETE', '/api/health');
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET');
    const bad = await srv.request('POST', '/api/_test/echo', { body: '{"oops":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'E_BAD_JSON');
    const echo = await srv.request('POST', '/api/_test/echo', { body: { a: 1 }, headers: { 'X-Scrolls-Session': 'tab-1' } });
    assert.deepEqual(echo.json, { body: { a: 1 }, session: 'tab-1' });
    const evil = await srv.request('POST', '/api/_test/echo', { body: {}, headers: { 'X-Scrolls-Session': '../../etc' } });
    assert.equal(evil.json.session, null);
  });

  test('GET responses carry W/"<dataVersion>-<hash>" and honour If-None-Match', async () => {
    const r = await srv.request('GET', '/api/_test/etag');
    assert.equal(r.status, 200);
    assert.equal(r.headers.etag, etagFor(0, JSON.stringify({ hello: 'scrolls' })));
    const r2 = await srv.request('GET', '/api/_test/etag', { headers: { 'If-None-Match': r.headers.etag } });
    assert.equal(r2.status, 304);
    assert.equal(r2.text, '');
    srv.app.ctx.withWrite((db) => db.prepare("UPDATE meta SET value = '5' WHERE key = 'data_version'").run());
    const r3 = await srv.request('GET', '/api/_test/etag', { headers: { 'If-None-Match': r.headers.etag } });
    assert.equal(r3.status, 200, 'a new data version invalidates the tag');
    assert.match(r3.headers.etag, /^W\/"5-/);
  });
});

describe('process level', () => {
  test('a data directory under iCloud is refused with E_DB_IN_ICLOUD (exit 2) and nothing is created', async () => {
    const dir = path.join(homedir(), 'Documents', `scrolls-icloud-refusal-test-${process.pid}`);
    const saved = process.env.SCROLLS_DATA;
    process.env.SCROLLS_DATA = dir;
    try {
      assert.throws(() => dataDir(), { code: 'E_DB_IN_ICLOUD' });
    } finally {
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
    }
    const { code, stderr } = await runServerExpectingExit({ SCROLLS_DATA: dir });
    assert.equal(code, 2);
    assert.match(stderr, /E_DB_IN_ICLOUD/);
    assert.equal(existsSync(dir), false);
  });

  test('`node server.mjs` starts on a temp data dir and /api/health answers', async () => {
    const s = await startServerProcess();
    try {
      assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const r = await s.request('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.readPool.size, 3);
      assert.ok(existsSync(path.join(s.dataDir, 'scrolls.db')));
      assert.equal(await s.kill('SIGTERM'), 0, 'clean shutdown on SIGTERM');
    } finally {
      await s.cleanup();
    }
  });
});
