// OWNER: WP2 — the WP2 routes over HTTP on a real server (SPEC §7.1, §7.2): GET /api/corpora, /api/facets and
// /api/tour answer with the contract shapes the UI packages build against (tests/contract fixtures), on a
// fresh data directory where the boot loads the synthetic demo (the Cipher auto-import is off).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkResponse } from './helpers/shape.mjs';
import { startServerProcess } from './helpers/server.mjs';

describe('WP2 routes on a booted server with the demo loaded', () => {
  let srv;
  before(async () => {
    srv = await startServerProcess({ env: { SCROLLS_NO_DEMO: '0' }, timeoutMs: 30000 });
  });
  after(async () => { await srv?.cleanup(); });

  const get = async (p) => {
    const r = await srv.request('GET', p);
    const res = new Response(r.text, { status: r.status, headers: { 'content-type': r.headers['content-type'] ?? '' } });
    return { status: r.status, etag: r.headers.etag, body: await checkResponse(res, 'GET', p.split('?')[0]) };
  };

  test('GET /api/corpora → Corpora: the demo world first, synthetic, with coverage and status', async () => {
    const { status, etag, body } = await get('/api/corpora');
    assert.equal(status, 200);
    assert.match(etag, /^W\/"\d+-[0-9a-f]+"$/);
    const demo = body.find((c) => c.slug === 'demo');
    assert.equal(demo.synthetic, true);
    assert.equal(demo.collections[0].slug, 'demo-world');
    assert.equal(demo.collections[0].status, 'ready');
    assert.ok(demo.collections[0].docs > 200);
    assert.deepEqual(body.find((c) => c.slug === 'cipher').collections, [], 'no Cipher collection before the bootstrap');
  });

  test('GET /api/facets?corpus=demo → Facets; ?f=lang:la → empty facets; a bad corpus slug → 400', async () => {
    const { body } = await get('/api/facets?corpus=demo');
    assert.ok(body.facets.community.length === 10);
    assert.equal(body.provenance.synthetic, true);
    const empty = await get('/api/facets?corpus=demo&f=lang:la');
    assert.deepEqual(empty.body.facets, {});
    const bad = await srv.request('GET', '/api/facets?corpus=DROP%20TABLE');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'E_VALIDATION');
  });

  test('GET /api/tour → Tour: 10 steps with resolved view-state hashes', async () => {
    const { body } = await get('/api/tour');
    assert.equal(body.steps.length, 10);
    assert.ok(body.steps.every((s) => s.state.startsWith('#v=1&c=')));
    assert.ok(body.steps.slice(0, 3).every((s) => s.first_minute));
    assert.match(body.steps[0].state, /&s=e\d+/);
  });
});
