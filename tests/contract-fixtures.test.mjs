// OWNER: WP0 — every contract fixture matches its shape and the honesty rules; mock mode serves each endpoint (SPEC §7, §12.2, §13)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { check, ENDPOINTS } from '../src/shared/contracts.mjs';
import { decodeHash } from '../src/shared/viewstate.mjs';
import { GATE_CODES, CELL_STATE_CODES } from '../src/shared/vocab.mjs';
import { ALL_ENDPOINTS, EXTRA_ENDPOINTS, CONTRACT_DIR, fixtureVariants, loadFixtures, endpointFor, assertShape } from './helpers/shape.mjs';
import { mockRoutes, fixtureFileName, parseFixtureFileName, selectVariant, variantResponse } from '../server/http/mock.mjs';

const fixtures = loadFixtures(CONTRACT_DIR);
const variants = fixtureVariants();
const byKey = new Map(fixtures.map((f) => [`${f.method} ${f.path}`, f]));
const CAUTION = 'Shared wording or similar contexts can come from a common source; they do not establish influence or intent.';

/** Visit every plain object inside a value, with its path. */
function walk(v, fn, path = '$') {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    fn(v, path);
    for (const [k, x] of Object.entries(v)) walk(x, fn, `${path}.${k}`);
  }
}
const bodiesOf = ({ variant }) => [variant.body, variant.request, ...(variant.events ?? []).map((e) => e.data)].filter((b) => b !== undefined);

test('there is exactly one fixture per endpoint, named <METHOD>__<path>.json', () => {
  const want = ALL_ENDPOINTS.map((e) => fixtureFileName(e.method, e.path)).sort();
  const have = readdirSync(CONTRACT_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(have, want);
  assert.equal(new Set(want).size, ALL_ENDPOINTS.length, 'endpoints are unique');
  assert.equal(ENDPOINTS.length + EXTRA_ENDPOINTS.length, fixtures.length);
  for (const f of have) {
    assert.ok(!f.includes(':'), `${f}: no ':' in fixture names`);
    const { method, path } = parseFixtureFileName(f);
    assert.equal(fixtureFileName(method, path), f, 'file name round-trips');
  }
});

test('each fixture declares its endpoint as contracts.ENDPOINTS does', () => {
  for (const e of ALL_ENDPOINTS) {
    const f = byKey.get(`${e.method} ${e.path}`);
    assert.ok(f, `fixture for ${e.method} ${e.path}`);
    const fx = f.fixture;
    assert.match(fx['//'], /^OWNER: WP0 — /, `${f.file}: owner line first`);
    assert.equal(Object.keys(fx)[0], '//', `${f.file}: the owner line is the first key`);
    assert.equal(fx.owner, e.owner, `${f.file}: owner`);
    assert.equal(fx.response, e.response, `${f.file}: response shape`);
    assert.equal(fx.request, e.request ?? null, `${f.file}: request shape`);
    assert.ok(typeof fx.summary === 'string' && fx.summary.length > 10, `${f.file}: summary`);
    assert.ok(fx.variants[fx.default], `${f.file}: default variant '${fx.default}' exists`);
  }
});

test('every variant body, SSE event and request example matches its shape', () => {
  const problems = [];
  for (const v of variants) {
    const where = `${v.file} [${v.name}]`;
    const { variant } = v;
    const kinds = ['body', 'text', 'base64', 'events'].filter((k) => variant[k] !== undefined);
    if (variant.status === 204) { if (kinds.length) problems.push(`${where}: a 204 has no body`); continue; }
    if (kinds.length !== 1) { problems.push(`${where}: exactly one of body/text/base64/events, got ${kinds.join(',') || 'none'}`); continue; }
    if (v.shape) problems.push(...check(v.shape, variant.body).map((m) => `${where} ${v.shape}: ${m}`));
    else if (!variant.events && !variant.unshaped) problems.push(`${where}: no shape and no 'unshaped' reason`);
    if (variant.text !== undefined || variant.base64 !== undefined) {
      if (!variant.content_type) problems.push(`${where}: a text/binary variant needs content_type`);
    }
    for (const e of variant.events ?? []) {
      if (!e.event) problems.push(`${where}: event without a name`);
      if (e.shape) problems.push(...check(e.shape, e.data).map((m) => `${where} event ${e.event} ${e.shape}: ${m}`));
      else if (!e.unshaped) problems.push(`${where}: event ${e.event} has no shape and no 'unshaped' reason`);
    }
    if (variant.request && v.fixture.request) {
      problems.push(...check(v.fixture.request, variant.request).map((m) => `${where} request ${v.fixture.request}: ${m}`));
    }
  }
  for (const f of fixtures) {
    const ex = f.fixture.example_request;
    if (ex && f.fixture.request) problems.push(...check(f.fixture.request, ex).map((m) => `${f.file} example_request: ${m}`));
    if (f.fixture.request && !ex) problems.push(`${f.file}: endpoints with a request shape carry an example_request`);
  }
  assert.deepEqual(problems, []);
});

test('every endpoint has a success and an error variant; gated and empty variants where they apply', () => {
  for (const f of fixtures) {
    const st = Object.values(f.fixture.variants).map((v) => v.status ?? 200);
    assert.ok(st.some((s) => s < 300), `${f.file}: a success variant`);
    assert.ok(st.some((s) => s >= 400), `${f.file}: an error variant`);
  }
  for (const key of ['POST /api/compare', 'GET /api/collocations', 'GET /api/clusters']) {
    const fx = byKey.get(key).fixture;
    assert.ok(fx.variants.gated, `${key}: a 'gated' variant`);
    let gates = 0;
    walk(fx.variants.gated.body, (o) => { if (typeof o.gate === 'string' && o.gate !== 'ok') gates++; });
    assert.ok(gates > 0, `${key}: the gated variant contains a gate`);
  }
  for (const key of ['GET /api/jobs', 'GET /api/search', 'GET /api/facets', 'GET /api/adapters', 'GET /api/timeline/marks', 'GET /api/timeline/shelf',
    'GET /api/kwic', 'GET /api/analysis/runs', 'GET /api/lineage/path', 'GET /api/genealogy', 'GET /api/annotations', 'GET /api/views']) {
    assert.ok(byKey.get(key).fixture.variants.empty, `${key}: an 'empty' variant`);
  }
  for (const key of ['GET /api/timeline/tiles', 'POST /api/timeline/query']) {
    const fx = byKey.get(key).fixture;
    assert.ok(Object.keys(fx.variants).some((n) => /pending|materializing/.test(n)), `${key}: a pending/materializing variant`);
  }
});

test('gates never carry a numeral and always say what is needed (§13 rule 7)', () => {
  const problems = [];
  for (const v of variants) {
    for (const body of bodiesOf(v)) {
      walk(body, (o, path) => {
        if (typeof o.gate !== 'string' || o.gate === 'ok') return;
        if (!GATE_CODES.includes(o.gate)) problems.push(`${v.file} [${v.name}] ${path}: unknown gate '${o.gate}'`);
        for (const k of ['needed', 'have', 'suggestion']) if (!(k in o)) problems.push(`${v.file} [${v.name}] ${path}: gate without '${k}'`);
        for (const k of ['value', 'ci', 'rate', 'ratio']) if (k in o && o[k] !== null) problems.push(`${v.file} [${v.name}] ${path}: gated '${k}' is not null`);
      });
    }
  }
  assert.deepEqual(problems, []);
});

test('fixtures follow the honesty rules: synthetic labels, provenance, fixed caution, mock label', () => {
  const problems = [];
  const PEOPLE_KEYS = ['author', 'maker', 'actor', 'created_by', 'human_label_by'];
  for (const v of variants) {
    for (const body of bodiesOf(v)) {
      walk(body, (o, path) => {
        if (o.synthetic === true) {
          for (const k of PEOPLE_KEYS) {
            const s = o[k];
            if (typeof s !== 'string' || /^(adapter|run):/.test(s)) continue;
            if (!s.endsWith('(synthetic)')) problems.push(`${v.file} [${v.name}] ${path}.${k}: '${s}' must end with "(synthetic)"`);
          }
        }
        if (o.synthetic === false) {
          walk(o, (inner, p) => {
            if (inner !== o && inner.synthetic === true) return;
            for (const [k, s] of Object.entries(inner)) {
              if (typeof s === 'string' && s.includes('(synthetic)')) problems.push(`${v.file} [${v.name}] ${path}${p.slice(1)}.${k}: synthetic text under synthetic:false`);
            }
          });
        }
        if (o.provenance && typeof o.provenance === 'object') {
          problems.push(...check('Provenance', o.provenance).map((m) => `${v.file} [${v.name}] ${path}.provenance ${m}`));
        }
      });
    }
  }
  for (const [name, variant] of Object.entries(byKey.get('GET /api/relationships/:id').fixture.variants)) {
    if ((variant.status ?? 200) < 300) assert.equal(variant.body.caution, CAUTION, `relationship ${name}: the fixed caution sentence (§2.C)`);
  }
  for (const [name, variant] of Object.entries(byKey.get('GET /api/health').fixture.variants)) {
    if ((variant.status ?? 200) < 300) assert.equal(variant.body.mock, true, `health ${name}: mock bodies say so`);
  }
  assert.deepEqual(problems, []);
});

test('tour states are canonical view hashes and every step opens on demo or Cipher', () => {
  const steps = byKey.get('GET /api/tour').fixture.variants.ok.body.steps;
  assert.equal(steps.length, 10);
  steps.forEach((s, i) => {
    assert.equal(s.n, i + 1);
    const { warnings, state } = decodeHash(s.state);
    assert.deepEqual(warnings, [], `step ${s.n} state decodes cleanly`);
    assert.equal(state.corpus, s.n === 10 ? 'cipher' : 'demo');
  });
});

test('passages: highlights slice to their variant, anchors span the text, offsets are consistent', () => {
  for (const [name, variant] of Object.entries(byKey.get('GET /api/passages/:id').fixture.variants)) {
    if ((variant.status ?? 200) >= 400) continue;
    const p = variant.body;
    assert.equal(p.end - p.start, p.text.length, `${name}: end − start = text length (UTF-16 units)`);
    assert.equal(p.anchor.end - p.anchor.start, p.text.length, `${name}: anchor spans the passage`);
    for (const h of p.highlights) assert.equal(p.text.slice(h.start, h.end).toLowerCase(), h.variant, `${name}: highlight ${h.start}–${h.end}`);
  }
  const doc = byKey.get('GET /api/documents/:id/text').fixture.variants.ok.body;
  const p901 = byKey.get('GET /api/passages/:id').fixture.variants.p901.body;
  assert.equal(doc.text.slice(p901.start, p901.end), p901.text, 'the passage is a slice of its document text');
});

test('tiles: cell numbers agree with their state, and conservation holds per lane', () => {
  const tiles = byKey.get('GET /api/timeline/tiles').fixture.variants.ok.body.tiles;
  const query = byKey.get('POST /api/timeline/query').fixture.variants.ready.body;
  const GATE = 2000;   // demo coverage gate (tokens)
  for (const t of tiles) {
    for (const [lane, { strands }] of Object.entries(t.lanes)) {
      for (const cell of Object.values(strands).flat()) {
        const [, n, , , denom, rate, lo, hi, state] = cell;
        if (state === CELL_STATE_CODES.observed) {
          assert.ok(Math.abs(rate - (n / denom) * 1e6) < 0.06, `${lane}: rate = n / denom`);
          assert.ok(lo <= rate && rate <= hi, `${lane}: CI contains the rate`);
          assert.ok(denom >= GATE, `${lane}: an observed rate needs the coverage gate`);
        }
        if (state === CELL_STATE_CODES.absent) assert.ok(n === 0 && denom >= GATE, `${lane}: absent = looked and found none`);
        if (state === CELL_STATE_CODES.low) assert.ok(denom > 0 && denom < GATE, `${lane}: low = 0 < denom < gate`);
      }
    }
  }
  for (const lane of query.lanes) {
    let sum = lane.undated + lane.scheduled;
    for (const t of tiles) {
      for (const cell of t.lanes[lane.key]?.strands['12'] ?? []) sum += cell[1];
      for (const w of t.washes) if (w.lane === lane.key) sum += w.n;
    }
    assert.equal(sum, lane.n, `${lane.key}: Σ bins + washes + undated + scheduled = n`);
  }
  assert.equal(query.lanes.reduce((s, l) => s + l.n, 0), query.totals.n);
  assert.equal(query.totals.dated + query.totals.undated + query.totals.scheduled, query.totals.n);
});

// ── Mock mode ─────────────────────────────────────────────────────────────────────────────────────

const routes = mockRoutes(CONTRACT_DIR);
const route = (method, path) => routes.find((r) => r.method === method && r.path === path);
const req = (o = {}) => ({ query: {}, params: {}, headers: {}, body: null, ...o });

test('mock mode has one route per fixture and serves the default variant', async () => {
  assert.equal(routes.length, fixtures.length);
  for (const f of fixtures) {
    const r = route(f.method, f.path);
    assert.ok(r, `route ${f.method} ${f.path}`);
    if (f.fixture.request) continue;   // request-validated routes are covered below
    const res = await r.handler(req({ params: { id: '1', slug: 'x', file: 'x.png' } }));
    assert.ok(res.headers['x-scrolls-mock-variant'], `${f.file}: names the variant served`);
  }
  const health = await route('GET', '/api/health').handler(req());
  assert.equal(health.json.ok, true);
  assertShape('Health', health.json);
});

test('mock variant selection: header or ?mock= first, then `when`, then the default', async () => {
  const passages = route('GET', '/api/passages/:id');
  assert.equal((await passages.handler(req({ params: { id: '901' } }))).json.id, 901);
  assert.equal((await passages.handler(req({ params: { id: '77' } }))).json.id, 77);
  const missing = await passages.handler(req({ params: { id: '901' }, headers: { 'x-scrolls-mock': 'not_found' } }));
  assert.equal(missing.status, 404);
  assertShape('ErrorBody', missing.json);
  const search = route('GET', '/api/search');
  const empty = await search.handler(req({ query: { q: 'hacker' } }));
  assert.match(empty.json.empty_note, /0 is an observation about this index/);
  assert.equal((await search.handler(req({ query: { q: 'x', mock: 'error' } }))).status, 503);
  const fx = byKey.get('GET /api/search').fixture;
  assert.equal(selectVariant(fx, req({ query: new URLSearchParams('q=hackers') })).name, 'hackers', 'URLSearchParams queries work too');
  const unknown = await search.handler(req({ headers: { 'x-scrolls-mock': 'no-such-variant' } }));
  assert.equal(unknown.headers['x-scrolls-mock-variant'], fx.default, 'an unknown variant name falls back to the default');
});

test('mock mode validates request bodies like the real server', async () => {
  const review = route('POST', '/api/relationships/:id/review');
  const short = await review.handler(req({ params: { id: '7811' }, body: { action: 'confirm', note: 'short' } }));
  assert.equal(short.status, 400);
  assert.equal(short.json.error.code, 'E_VALIDATION');
  assertShape('ErrorBody', short.json);
  const ok = await review.handler(req({ params: { id: '7811' }, body: byKey.get('POST /api/relationships/:id/review').fixture.example_request }));
  assert.equal(ok.status, 200);
  assertShape('Review', ok.json);
  const disputed = await review.handler(req({ params: { id: '7795' }, body: { action: 'reject', note: 'A common phrase; not this novel.' } }));
  assert.equal(disputed.json.review_status, 'disputed', '`when` can match on the body');
  const compare = route('POST', '/api/compare');
  const gated = await compare.handler(req({ body: { expr: [15], a: { years: [1890, 1950] }, b: { years: [1980, 2026] } } }));
  assert.equal(gated.json.measures[0].gate, 'insufficient_occurrences');
  assert.equal(gated.json.measures[0].value, null);
});

test('mock mode serves 204, CSV and binary variants', async () => {
  const del = await route('DELETE', '/api/views/:slug').handler(req({ params: { slug: 'x' } }));
  assert.equal(del.status, 204);
  assert.equal(del.json, undefined);
  const csv = await route('GET', '/api/imports/:id/problems.csv').handler(req({ params: { id: '17' } }));
  assert.match(csv.headers['content-type'], /^text\/csv/);
  assert.match(csv.body, /^code,severity,line/);
  const png = await route('GET', '/api/snapshots/:file').handler(req({ params: { file: 'a.png' } }));
  assert.equal(png.headers['content-type'], 'image/png');
  assert.deepEqual([...png.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG signature');
  const json = variantResponse(byKey.get('GET /api/health').fixture, 'ok', byKey.get('GET /api/health').fixture.variants.ok);
  json.json.ok = false;
  assert.equal(byKey.get('GET /api/health').fixture.variants.ok.body.ok, true, 'responses are copies, not the fixture itself');
});

test('mock SSE streams the fixture events in order and ends', async () => {
  const r = route('GET', '/api/jobs/:id/events');
  assert.equal(r.sse, true);
  const resp = await r.handler(req({ params: { id: '303' }, headers: { 'x-scrolls-mock': 'cancelled' } }));
  const chunks = [];
  const res = {
    headersSent: false, statusCode: 0, headers: null, onClose: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    write(c) { chunks.push(c); },
    end() { this.ended = true; this.done?.(); },
    on(evt, fn) { if (evt === 'close') this.onClose = fn; },
  };
  await new Promise((resolve, reject) => {
    res.done = resolve;
    setTimeout(() => reject(new Error('stream did not end')), 5000).unref();
    resp.stream(res);
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  const events = chunks.join('').split('\n\n').filter((b) => b.includes('data: ')).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(b)[1]),
  }));
  assert.deepEqual(events.map((e) => e.event), ['progress', 'done']);
  assertShape('JobProgressEvent', events[0].data);
  assertShape('JobDoneEvent', events[1].data);
  assert.equal(events[1].data.status, 'cancelled');
});

test('the shape helper maps concrete paths to their endpoint', () => {
  assert.equal(endpointFor('GET', '/api/passages/901').path, '/api/passages/:id');
  assert.equal(endpointFor('GET', '/api/lineage/path?from=a').path, '/api/lineage/path');
  assert.equal(endpointFor('DELETE', '/api/views/abc').response, null);
  assert.equal(endpointFor('GET', '/api/nothing'), null);
});

test('Docs/API.md indexes every fixture and variant', () => {
  const doc = readFileSync(new URL('../Docs/API.md', import.meta.url), 'utf8');
  for (const f of fixtures) {
    assert.ok(doc.includes(f.file), `API.md lists ${f.file}`);
    for (const name of Object.keys(f.fixture.variants)) assert.ok(doc.includes(`\`${name}\``), `API.md names variant ${name} of ${f.file}`);
  }
});
