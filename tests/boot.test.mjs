// OWNER: WP0 — the stitched foundation boots (SPEC §12.1 "mechanisms that keep ownership disjoint", §12.2 "WP0
// done when"): every task, adapter and route module honours the contract its loader expects; SCROLLS_MOCK=1
// serves every fixture variant over HTTP; GET / serves the shell and every module and stylesheet it loads;
// the real server migrates, seeds and answers on a temp data dir. Stubs and real modules are checked alike, so
// a package that breaks a loader contract or imports a missing file fails here.

import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { ADAPTER_MODULES, FILE_ADAPTERS, loadAdapter } from '../server/adapters/registry.mjs';
import { loadFixtures, selectVariant } from '../server/http/mock.mjs';
import { createRouter } from '../server/http/router.mjs';
import { bootstrapStatus } from '../server/routes/health.mjs';
import { originalsIntegrityQuery } from '../server/db/integrity.mjs';
import { createBatch, createDocumentWriter, storeOriginal } from '../server/store/document-writer.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { CIPHER_STATUS, JOB_TYPES } from '../src/shared/vocab.mjs';
import { readSse, startServerInProcess, startServerProcess } from './helpers/server.mjs';
import { assertShape, CONTRACT_DIR } from './helpers/shape.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

const ROUTES_DIR = new URL('../server/routes/', import.meta.url);
const HAS_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** Run async thunks at most `limit` at a time (macOS caps a listen backlog at 128 connections). */
async function runLimited(thunks, limit = 12) {
  let next = 0;
  const worker = async () => { while (next < thunks.length) await thunks[next++](); };
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
}

/** A concrete request path for a route pattern: '/api/passages/:id' → '/api/passages/1'. */
const concrete = (pattern) => pattern.replace(/:(\w+)/g, (_, k) => (k === 'file' ? 'snapshot-1.png' : k === 'slug' ? 'view-1' : '1'));

/**
 * Module specifiers a browser would fetch for this source: static and dynamic imports and
 * `new URL('…', import.meta.url)` (workers). Comments are stripped first.
 * @param {string} source
 * @returns {string[]}
 */
function moduleSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [];
  for (const re of [/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g]) {
    for (const m of code.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

describe('loader contracts (§12.1): what worker.mjs, registry.mjs and app.mjs load', () => {
  test('every vocab.JOB_TYPES type has tasks/<type>.mjs with the same type, writes and priority, and run()', async () => {
    for (const [type, def] of Object.entries(JOB_TYPES)) {
      const mod = await import(`../server/jobs/tasks/${type}.mjs`);
      assert.equal(mod.type, type, `tasks/${type}.mjs type`);
      assert.equal(mod.writes, def.writes, `tasks/${type}.mjs writes`);
      assert.equal(mod.priority, def.priority, `tasks/${type}.mjs priority`);
      assert.equal(typeof mod.run, 'function', `tasks/${type}.mjs run`);
    }
  });

  test('every adapter id of ADAPTER_MODULES loads and satisfies SourceAdapter (§10.1)', async () => {
    for (const id of Object.keys(ADAPTER_MODULES)) {
      const adapter = await loadAdapter(id);   // throws E_ADAPTER_MISSING / E_ADAPTER_INVALID with the problems
      assert.equal(adapter.id, id);
    }
  });

  test('every server/routes/*.mjs exports a routes array; no two files claim the same endpoint', async () => {
    const router = createRouter();
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'));
    assert.ok(files.length >= 27, `the 27 route files of §12.1 (found ${files.length})`);
    for (const file of files) {
      const mod = await import(new URL(file, ROUTES_DIR).href);
      assert.ok(Array.isArray(mod.routes), `routes/${file} exports routes`);
      for (const r of mod.routes) {
        assert.match(r.path, /^\/api\//, `routes/${file}: ${r.method} ${r.path}`);
        assert.equal(typeof r.handler, 'function', `routes/${file}: ${r.method} ${r.path} handler`);
        router.add(r);   // throws on a collision
      }
    }
  });
});

describe('SCROLLS_MOCK=1 over HTTP', () => {
  const fixtures = loadFixtures(CONTRACT_DIR);
  let s;
  before(async () => { s = await startServerInProcess({ mock: true }); });
  after(async () => { await s?.cleanup(); });

  test('every variant of every fixture is served when named', async () => {
    const checks = [];
    for (const { file, method, path: pattern, fixture } of fixtures) {
      const url = concrete(pattern);
      for (const [name, variant] of Object.entries(fixture.variants)) {
        const label = `${file} '${name}'`;
        if (variant.events) {
          checks.push(() => readSse(s.url, `${url}?mock=${encodeURIComponent(name)}`,
            { until: (ev) => ev.length >= variant.events.length, timeoutMs: 8000 }).then((events) => {
            assert.deepEqual(events, variant.events.map((e) => ({ event: e.event ?? 'message', data: e.data })), label);
          }));
          continue;
        }
        if (variant.base64 !== undefined) {
          checks.push(() => fetch(`${s.url}${url}`, { headers: { 'X-Scrolls-Mock': name } }).then(async (r) => {
            assert.equal(r.status, variant.status ?? 200, label);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(variant.base64, 'base64'), label);
          }));
          continue;
        }
        const body = HAS_BODY.has(method) ? (fixture.example_request ?? {}) : undefined;
        checks.push(() => s.request(method, url, { headers: { 'X-Scrolls-Mock': name }, body }).then((r) => {
          assert.equal(r.status, variant.status ?? 200, label);
          assert.equal(r.headers['x-scrolls-mock-variant'], name, label);
          if (variant.body !== undefined) assert.deepEqual(r.json, variant.body, label);
          if (variant.text !== undefined) {
            assert.equal(r.text, variant.text, label);
            assert.equal(r.headers['content-type'], variant.content_type, label);
          }
          if ((variant.status ?? 200) === 204) assert.equal(r.text, '', label);
          if (method === 'GET' && r.status === 200) assert.match(r.headers.etag ?? '', /^W\/"0-[0-9a-f]{8}"$/, `${label} ETag`);
        }));
      }
    }
    const total = fixtures.reduce((n, f) => n + Object.keys(f.fixture.variants).length, 0);
    assert.equal(checks.length, total);
    assert.ok(total >= 190, `all fixture variants (${total})`);
    await runLimited(checks);
  });

  test('without a variant name, the example request selects what selectVariant says (and passes validation)', async () => {
    for (const { file, method, path: pattern, fixture } of fixtures) {
      if (fixture.variants[fixture.default].events) continue;   // streams are covered above
      const params = Object.fromEntries([...pattern.matchAll(/:(\w+)/g)].map((m) => [m[1], concrete(`:${m[1]}`)]));
      const body = HAS_BODY.has(method) ? (fixture.example_request ?? undefined) : undefined;
      const expected = selectVariant(fixture, { query: {}, params, headers: {}, body: body ?? null }).name;
      const r = await s.request(method, concrete(pattern), { body });
      assert.equal(r.headers['x-scrolls-mock-variant'], expected, `${file}: ${r.status} ${r.text.slice(0, 160)}`);
    }
  });

  test('mock /api/health says mock: true and matches Health', async () => {
    const r = await s.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.mock, true);
    assertShape('Health', r.json);
  });

  test('GET / serves the shell; every stylesheet and every module it imports is served as such', async () => {
    const index = await s.request('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    const sheets = [...index.text.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.equal(sheets.length, 6, 'the six stylesheets of §12.2');
    for (const href of sheets) {
      const r = await s.request('GET', href);
      assert.equal(r.status, 200, href);
      assert.match(r.headers['content-type'], /^text\/css/, href);
    }
    const icons = await s.request('GET', '/icons.svg');
    assert.equal(icons.status, 200);
    assert.match(icons.headers['content-type'], /^image\/svg\+xml/);

    const entries = [...index.text.matchAll(/<script type="module" src="([^"]+)">/g)].map((m) => m[1]);
    assert.deepEqual(entries, ['/ui/main.mjs'], 'one module script');
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const r = await s.request('GET', url);
      assert.equal(r.status, 200, `${url} is served`);
      assert.match(r.headers['content-type'], /^text\/javascript/, `${url} is JavaScript`);
      for (const spec of moduleSpecifiers(r.text)) {
        assert.match(spec, /^(?:\.\.?\/|\/)/, `${url} imports '${spec}': browsers need a relative or absolute path`);
        queue.push(new URL(spec, `http://scrolls.local${url}`).pathname);
      }
    }
    for (const must of ['/ui/registry.mjs', '/ui/core/store.mjs', '/shared/viewstate.mjs', '/ui/panels/layout.worker.mjs', '/ui/selftest.mjs']) {
      assert.ok(seen.has(must), `${must} is reached from /ui/main.mjs`);
    }
    assert.ok(seen.size >= 70, `main, registry, core, shared and the 56 UI modules plus the worker (${seen.size})`);
  });
});

describe('the real server on a temp data dir', () => {
  test('health reports the bootstrap job in vocab.CIPHER_STATUS words (§7.2: "fulltext" while phase B runs)', () => {
    const cases = [[{ status: 'queued' }, 'queued'], [{ status: 'running', phase: null }, 'metadata'],
      [{ status: 'running', phase: 'A' }, 'metadata'], [{ status: 'running', phase: 'A2' }, 'metadata'],
      [{ status: 'running', phase: 'B' }, 'fulltext'], [{ status: 'cancelling', phase: 'B · full text' }, 'fulltext'],
      [{ status: 'succeeded', phase: 'B' }, 'ready'], [{ status: 'failed' }, 'failed'], [{ status: 'cancelled' }, 'cancelled'],
      [{ status: 'interrupted' }, 'interrupted']];
    for (const [job, want] of cases) {
      assert.equal(bootstrapStatus(job), want, JSON.stringify(job));
      assert.ok(CIPHER_STATUS.includes(want));
    }
  });

  test('boots, migrates, seeds, registers every adapter, loads every route file and answers /api/health', async () => {
    const s = await startServerProcess({ env: { SCROLLS_LOG_LEVEL: 'warn' } });
    try {
      const health = await s.request('GET', '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assertShape('Health', health.json);
      const jobs = await s.request('GET', '/api/jobs');
      assert.equal(jobs.status, 200);
      assertShape('JobList', jobs.json);
      assert.doesNotMatch(s.stderr(), /failed to load|exports no routes|not registered|is invalid/, 'no module was skipped at boot');
      assert.equal(await s.kill('SIGTERM'), 0, 'clean shutdown');

      const db = new DatabaseSync(path.join(s.dataDir, 'scrolls.db'), { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
        assert.ok(db.prepare('SELECT COUNT(*) AS n FROM rel_type').get().n > 0, 'rel_type seeded');
        const corpora = db.prepare('SELECT slug FROM corpus ORDER BY slug').all().map((r) => r.slug);
        assert.deepEqual(corpora, ['cipher', 'demo', 'stemm', 'user']);
        const adapters = new Set(db.prepare('SELECT id FROM source_adapter').all().map((r) => r.id));
        for (const id of [...FILE_ADAPTERS.map((a) => a.id), ...Object.keys(ADAPTER_MODULES)]) assert.ok(adapters.has(id), `source_adapter ${id}`);
      } finally {
        db.close();
      }
    } finally {
      await s.cleanup();
    }
  });

  test('first launch with the demo step on still boots (the boot waits ≤ 10 s for demo-load)', async () => {
    const s = await startServerProcess({ env: { SCROLLS_NO_DEMO: '0' }, timeoutMs: 30000 });
    try {
      const health = await s.request('GET', '/api/health');
      assert.equal(health.status, 200);
      const jobs = await s.request('GET', '/api/jobs');
      const demo = jobs.json.items.filter((j) => j.type === 'demo-load');
      assert.equal(demo.length, 1, 'one demo-load job was enqueued');
      assert.ok(['succeeded', 'failed', 'running'].includes(demo[0].status), `demo-load is ${demo[0].status}`);
    } finally {
      await s.cleanup();
    }
  });
});

// ── boot-time integrity check: originals/ entries that documents were made from (server/db/integrity.mjs) ─────

describe('boot-time check of originals/', () => {
  /** A data dir whose document 'orig:1' was made from a stored original; returns the original's path. */
  function dataWithOriginal() {
    const t = makeTmpData();
    const bytes = Buffer.from('id,title\norig:1,A record kept verbatim\n', 'utf8');
    const sha = storeOriginal(t.db, bytes, { sourcePath: 'test:originals.csv' });
    const w = createDocumentWriter(t.db, { batchId: createBatch(t.db, { collection: 'mini' }), collection: 'mini', options: {} });
    const r = w.addDocument({ ext_id: 'orig:1', kind: 'letter', title: 'A record kept verbatim', dates: [], original_meta: {},
      source_file: { sha256: sha, byte_start: 9, byte_end: bytes.length } });
    w.finish();
    assert.ok(r.documentId);
    const rel = t.db.prepare('SELECT rel_path FROM original_file WHERE sha256 = ?').get(sha).rel_path;
    return { t, sha, file: path.join(t.dir, rel), bytes };
  }

  test('the query: ok while the files are there; a missing or truncated original is reported with its documents', () => {
    const { t, sha, file, bytes } = dataWithOriginal();
    try {
      const ok = originalsIntegrityQuery(t.db, { dataDir: t.dir });
      assert.equal(ok.status, 'ok');
      assert.equal(ok.missing_files, 0);
      assert.ok(ok.files >= 1);
      writeFileSync(file, bytes.subarray(0, 5));
      const short = originalsIntegrityQuery(t.db, { dataDir: t.dir });
      assert.deepEqual([short.status, short.size_mismatch, short.documents_affected], ['missing_originals', 1, 1]);
      rmSync(file);
      const gone = originalsIntegrityQuery(t.db, { dataDir: t.dir });
      assert.deepEqual([gone.status, gone.missing_files, gone.referenced_missing, gone.documents_affected], ['missing_originals', 1, 1, 1]);
      assert.deepEqual(gone.sample, [{ sha256: sha, rel_path: path.relative(t.dir, file), problem: 'missing', documents: 1 }]);
    } finally {
      t.cleanup();
    }
  });

  test('the server warns at boot and reports it in /api/health; a healthy data dir reports ok', async () => {
    const { t, file } = dataWithOriginal();
    t.db.close();
    let s;
    try {
      s = await startServerProcess({ dataDir: t.dir, env: { SCROLLS_LOG_LEVEL: 'warn' } });
      const settled = async () => {
        for (let i = 0; i < 200; i++) {
          const h = await s.request('GET', '/api/health');
          assert.equal(h.status, 200);
          assertShape('Health', h.json);
          if (h.json.integrity && h.json.integrity.status !== 'checking') return h.json.integrity;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.fail('the integrity check did not finish');
      };
      assert.equal((await settled()).status, 'ok');
      await s.kill('SIGTERM');
      rmSync(file);
      s = await startServerProcess({ dataDir: t.dir, env: { SCROLLS_LOG_LEVEL: 'warn' } });
      const bad = await settled();
      assert.deepEqual([bad.status, bad.referenced_missing, bad.documents_affected], ['missing_originals', 1, 1]);
      for (let i = 0; i < 50 && !/integrity:/.test(s.stderr()); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(s.stderr(), /integrity: 1 original file\(s\) that 1 document\(s\) were made from are missing/);
    } finally {
      await s?.cleanup();
      t.cleanup();
    }
  });
});
