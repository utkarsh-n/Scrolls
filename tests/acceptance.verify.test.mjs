// OWNER: WP8 — the verification tools themselves: `npm run verify` (scripts/verify.mjs, verify-journey.mjs) and the
// in-browser self-test (src/ui/selftest.mjs) (SPEC §11, §12.5). The journey itself runs against a snapshot clone
// (npm run verify); here: its helpers, its import files, its clean skip without a snapshot, and the self-test's
// checks and its promise to do nothing unless asked.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatTable, parseTestOutput, resolveSnapshot } from '../scripts/verify.mjs';
import { buildImportFiles, createClient, runJourney } from '../scripts/verify-journey.mjs';
import { createBatch, createDocumentWriter } from '../server/store/document-writer.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { expectedModuleIds, isPainted, mount, requiredLayer, selftestMode, summarize } from '../src/ui/selftest.mjs';
import { ensureMiniCollection, makeTmpData } from './helpers/tmpdata.mjs';
import { startServerProcess } from './helpers/server.mjs';

const VERIFY = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
const FIXTURES = new URL('./fixtures/ingest/', import.meta.url);

describe('npm run verify: helpers', () => {
  test('test counts and failing names from TAP and spec output', () => {
    const tap = ['TAP version 13', '# Subtest: a', 'ok 1 - a', '    not ok 2 - inner check fails', 'not ok 3 - suite B # time=1',
      '# tests 12', '# suites 3', '# pass 10', '# fail 2', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n');
    assert.deepEqual(parseTestOutput(tap), { tests: 12, pass: 10, fail: 2, skipped: 0, todo: 0, failing: ['inner check fails', 'suite B'] });
    const spec = 'ℹ tests 5\nℹ pass 4\nℹ fail 0\nℹ skipped 1\nℹ todo 0\n';
    assert.deepEqual(parseTestOutput(spec), { tests: 5, pass: 4, fail: 0, skipped: 1, todo: 0, failing: [] });
    const specFail = ['✖ suite A (865.2ms)', 'ℹ tests 3', 'ℹ pass 2', 'ℹ fail 1', 'ℹ skipped 0', 'ℹ todo 0', '', '✖ failing tests:', '',
      'test at tests/acceptance.m5-gate.test.mjs:37:3', '✖ the job stays cancelling (534.560167ms)', '  AssertionError [ERR_ASSERTION]: x',
      '  ✖ not a heading', ''].join('\n');
    assert.deepEqual(parseTestOutput(specFail).failing, ['the job stays cancelling (acceptance.m5-gate.test.mjs)']);
    assert.ok(Number.isNaN(parseTestOutput('no summary').tests));
  });

  test('the table says PASS, FAIL or SKIP for every step', () => {
    const out = formatTable([{ name: 'npm test', ok: true, ms: 12345, detail: '3 tests' }, { name: 'search', ok: false, ms: 20, detail: 'HTTP 503' },
      { name: 'journey', ok: null, ms: 0, detail: 'skipped: no snapshot' }]);
    const lines = out.split('\n');
    assert.match(lines[2], /^ 1 {2}npm test +PASS +12 s +3 tests$/);
    assert.match(lines[3], /FAIL +20 ms +HTTP 503/);
    assert.match(lines[4], /SKIP +skipped: no snapshot/);
  });

  test('a snapshot is a directory with scrolls.db; a missing one, a live data dir or a database in use is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-snap-'));
    const saved = process.env.SCROLLS_DATA;
    try {
      assert.match(resolveSnapshot(path.join(dir, 'nope')).skip, /^no snapshot at /);
      writeFileSync(path.join(dir, 'scrolls.db'), 'x');
      assert.deepEqual(resolveSnapshot(dir), { db: path.join(dir, 'scrolls.db'), dir });
      assert.deepEqual(resolveSnapshot(path.join(dir, 'scrolls.db')), { db: path.join(dir, 'scrolls.db'), dir });
      writeFileSync(path.join(dir, 'scrolls.db-wal'), 'y');
      assert.match(resolveSnapshot(dir).skip, /non-empty WAL/);
      rmSync(path.join(dir, 'scrolls.db-wal'));
      process.env.SCROLLS_DATA = dir;
      assert.match(resolveSnapshot(dir).skip, /inside the live data directory/);
    } finally {
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a snapshot the journey is skipped with a message and the exit code is 0', () => {
    const r = spawnSync(process.execPath, [VERIFY, '--no-test', '--snapshot', path.join(tmpdir(), 'scrolls-no-such-snapshot')],
      { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /acceptance journey +SKIP +skipped: no snapshot at /);
    assert.match(r.stdout, /\nPASS \(with skipped steps\)\n/);
    assert.equal(spawnSync(process.execPath, [VERIFY, '--bogus'], { encoding: 'utf8' }).status, 2);
  });
});

describe('npm run verify: import files built from the snapshot\'s own texts', () => {
  let t;
  before(() => {
    t = makeTmpData({ seed: false });
    // ten long documents of invented test prose (a synthetic test collection), 40 paragraphs each
    ensureMiniCollection(t.db, 'verify-books');
    const words = ['the', 'and', 'of', 'to', 'was', 'he', 'that', 'in', 'it', 'with', 'they', 'her', 'the', 'and', 'of',
      'clerk', 'kept', 'ledger', 'accounts', 'carefully', 'counted', 'columns', 'evening', 'office', 'returned', 'figures',
      'balanced', 'morning', 'written', 'letters', 'remained', 'quietly', 'satisfactorily'];
    const rnd = mulberry32(7);
    const para = () => `${Array.from({ length: 70 }, () => words[Math.floor(rnd() * words.length)]).join(' ')}.`;
    const w = createDocumentWriter(t.db, { batchId: createBatch(t.db, { collection: 'verify-books' }), collection: 'verify-books',
      options: { dedupe: 'off' } });
    for (let i = 0; i < 10; i++) {
      w.addDocument({ ext_id: `vb:${i}`, kind: 'book', title: `Test Book ${i} (synthetic)`, author: 'Test Author (synthetic)', lang_declared: 'en',
        text: { original: Array.from({ length: 40 }, para).join('\n\n'), decoder: 'utf-8' },
        dates: [{ role: 'publication', raw: String(1850 + i), asserted_by: 'test', is_chronology: true }], original_meta: {} });
    }
    w.finish();
    t.db.close();
  });
  after(() => t.cleanup());

  test('6 CSV rows, 4 JSONL rows and a malformed file (bad JSON on line 3, an invalid date) of verbatim paragraphs', () => {
    const f = buildImportFiles(t.dbPath, FIXTURES, { collection: 'verify-books' });
    assert.equal(f.kind, 'real');
    assert.deepEqual([f.csvRows, f.jsonlRows], [6, 4]);
    const csv = f.csv.toString('utf8').trim().split('\n');
    assert.equal(csv[0], 'id,title,author,published,language,text');
    assert.equal(csv.length, 7);
    const jsonl = f.jsonl.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(jsonl.length, 4);
    assert.deepEqual(Object.keys(jsonl[0]), ['id', 'title', 'author', 'date', 'lang', 'body']);
    const bad = f.malformed.toString('utf8').trim().split('\n');
    assert.equal(bad.length, 5);
    assert.throws(() => JSON.parse(bad[2]));
    assert.equal(JSON.parse(bad[3]).date, '2019-02-30');
    assert.ok(tokenize(csv[1]).tokens.join(' ').includes(tokenize(f.phrase).tokens.join(' ')), 'the search phrase is in the first CSV paragraph');
    assert.match(f.word, /^\p{Ll}{7,}$/u);
  });

  test('without English full texts in that collection, the synthetic ingest fixtures are used', () => {
    const f = buildImportFiles(t.dbPath, FIXTURES, { collection: 'no-such-collection' });
    assert.equal(f.kind, 'synthetic');
    assert.ok(f.csv.length > 0 && f.jsonl.length > 0);
    const bad = f.malformed.toString('utf8').trim().split('\n');
    assert.equal(bad.length, 5, 'five records, as with real text');
    assert.throws(() => JSON.parse(bad[2]));
    assert.deepEqual(bad.filter((_, i) => i !== 2).map((l) => JSON.parse(l).id), ['p1-again', 'p2-again', 'p1-again2', 'p4-again'],
      'made from the fixture\'s valid records only');
    assert.equal(JSON.parse(bad[3]).date, '2019-02-30');
  });
});

describe('npm run verify: the journey over HTTP on a fresh data directory (demo + synthetic import fixtures)', () => {
  test('every step passes and every JSON response matches its contract shape', { timeout: 600000 }, async () => {
    const env = { SCROLLS_NO_DEMO: '0' };
    let srv = await startServerProcess({ env, timeoutMs: 120000 });
    const dataDir = srv.dataDir;
    try {
      // the demo is loaded at first launch; the journey searches and draws it
      for (let i = 0; ; i++) {
        const jobs = (await srv.request('GET', '/api/jobs?limit=50')).json;
        const demo = (Array.isArray(jobs) ? jobs : jobs?.items ?? []).find((j) => j.type === 'demo-load');
        if (demo?.status === 'succeeded') break;
        assert.ok(!['failed', 'cancelled', 'interrupted'].includes(demo?.status), `demo-load ${demo?.status}`);
        assert.ok(i < 1200, 'the demo did not load in 10 minutes');
        await new Promise((r) => setTimeout(r, 500));
      }
      const files = buildImportFiles(path.join(dataDir, 'scrolls.db'), FIXTURES);
      assert.equal(files.kind, 'synthetic', 'a fresh data directory has no Gutenberg texts to sample');
      const recorded = [];
      const client = createClient(srv.url, { record: (e) => recorded.push(e) });
      const steps = await runJourney({ client, files, restart: async () => {
        await srv.kill('SIGTERM');
        srv = await startServerProcess({ dataDir, env, timeoutMs: 120000 });
        return srv.url;
      } });
      const table = formatTable(steps);
      assert.deepEqual(steps.filter((r) => r.ok !== true).map((r) => `${r.name}: ${r.detail}`), [], table);
      assert.ok(steps.length >= 22, table);
      assert.equal(client.stats.errors.length, 0);
      assert.ok(client.stats.checked >= 60, `${client.stats.checked} responses checked`);
      // RF-3: the steps the phone journey needs, and the JSONL record of every request and response (G7)
      const names = steps.map((r) => r.name);
      for (const want of ['timeline tiers L0–L5 + conservation (demo)', 'Compare + save a view of the imported text (as saved = current at the save)',
        'review a link (demo)', 'revert an import after the save', 'as-saved reopen after the revert (timeline, tiles L0–L5, concordance, lineage)',
        'as-saved Compare (RF-2)']) assert.ok(names.includes(want), `step '${want}' in ${names.join(' | ')}`);
      const requests = recorded.filter((e) => !e.event);
      assert.equal(requests.length, client.stats.calls, 'every call is recorded');
      assert.deepEqual(recorded.map((e) => e.seq), recorded.map((_, i) => i + 1), 'in request order');
      assert.deepEqual(recorded.filter((e) => e.event).map((e) => e.event), ['restart']);
      assert.ok(requests.every((e) => typeof e.step === 'string' && typeof e.method === 'string' && Number.isInteger(e.status)));
      const uploads = requests.filter((e) => e.raw);
      assert.equal(uploads.length, 3, 'the three uploads carry their bytes');
      for (const u of uploads) {
        const bytes = Buffer.from(u.raw.base64, 'base64');
        assert.equal(bytes.length, u.raw.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), u.raw.sha256);
        assert.ok(u.headers['X-Scrolls-Filename'], 'the upload headers are kept');
      }
      assert.ok(requests.some((e) => e.method === 'POST' && e.path === '/api/compare' && e.body?.cutoffs && e.response?.as_saved), 'an as-saved Compare');
      assert.ok(requests.some((e) => e.path.startsWith('/api/timeline/tiles') && e.path.includes('tier=L5')), 'tiles at L5');
      assert.ok(requests.some((e) => e.poll), 'repeated reads are marked');
    } finally {
      await srv.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('the in-browser self-test (src/ui/selftest.mjs)', () => {
  test('runs only when the URL asks', () => {
    assert.equal(selftestMode(''), null);
    assert.equal(selftestMode('?view=x'), null);
    assert.equal(selftestMode('?selftest=0'), null);
    assert.equal(selftestMode('?selftest=false'), null);
    assert.equal(selftestMode('?selftest=1'), 'checks');
    assert.equal(selftestMode('?selftest'), 'checks');
    assert.equal(selftestMode('?a=1&selftest=journey'), 'journey');
  });

  test('mount() without ?selftest touches nothing (no overlay, no hooks, no request)', () => {
    const trap = new Proxy({}, { get: (_, k) => { throw new Error(`the self-test used document.${String(k)} without being asked`); } });
    const win = { location: { search: '?view=abc' }, document: trap };
    const api = new Proxy({}, { get: () => { throw new Error('the self-test called the API without being asked'); } });
    const handle = mount({ ownerDocument: { defaultView: win } }, { api, store: null });
    assert.equal(typeof handle.unmount, 'function');
    handle.unmount();
  });

  test('every registry module with a region is expected to be mounted (the self-test itself excluded)', async () => {
    const { MODULES, MOUNT_POINTS, regionsOf } = await import('../src/ui/registry.mjs');
    const regions = new Set(['app', ...MOUNT_POINTS]);
    const want = expectedModuleIds(MODULES, regionsOf, (r) => regions.has(r));
    const withRegion = MODULES.filter((m) => regionsOf(m).length && m.id !== 'selftest.mjs').map((m) => m.id);
    assert.deepEqual(want, withRegion);
    assert.ok(want.includes('timeline/viewport.mjs') && want.includes('panels/inspector.mjs'));
    assert.ok(!want.includes('timeline/paint.mjs'), 'libraries without a region are not mounted');
    assert.deepEqual(expectedModuleIds(MODULES, regionsOf, (r) => r === 'scroll'), ['timeline/viewport.mjs']);
  });

  test('painted pixels and the verdict', () => {
    assert.equal(isPainted(new Uint8ClampedArray(16)), false);
    assert.equal(isPainted(Uint8ClampedArray.from([0, 0, 0, 0, 10, 20, 30, 1])), true);
    assert.equal(requiredLayer(1)('bg'), false, 'with a strand pinned, a painted background alone is not enough');
    assert.equal(requiredLayer(1)('data'), true);
    assert.equal(requiredLayer(0)('bg'), true);
    assert.equal(summarize([{ ok: true }, { ok: null }]), 'pass');
    assert.equal(summarize([{ ok: true }, { ok: false }]), 'fail');
    assert.equal(summarize([{ ok: true }, { ok: null, skipped: true }]), 'incomplete', 'a check that could not be judged is not a pass');
    assert.equal(summarize([{ ok: false }, { ok: null, skipped: true }]), 'fail');
  });
});
