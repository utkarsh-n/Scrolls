// OWNER: WP6 — the Scroll's data client (SPEC §8.1): the query body matches the contract, tiles are debounced,
// abort-keyed and cached (LRU 512), an asked-but-missing tile is "loaded, no cells", a different answered tier
// is kept under its own name, marks are fetched once per range.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check } from './helpers/shape.mjs';
import { defaultState, formatFilter } from '../src/shared/viewstate.mjs';
import { arcsAsSaved, createLru, createTilesClient, queryBody, DEBOUNCE_MS } from '../src/ui/timeline/tiles-client.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8'));
const TILES = fixture('GET__api_timeline_tiles.json').variants.ok.body;

function fakeApi(respond) {
  const calls = [];
  const aborted = [];
  return {
    calls, aborted,
    async get(path, query, opts) { calls.push({ path, query, key: opts?.key }); return respond(path, query); },
    abort(key) { aborted.push(key); },
  };
}
function fakeTimers() {
  const list = [];
  return { list, set: (fn, ms) => { list.push({ fn, ms, live: true }); return list.length; }, clear: (id) => { if (list[id - 1]) list[id - 1].live = false; },
    flush() { for (const t of list.splice(0)) if (t.live) t.fn(); } };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the timeline query body is a valid TimelineQueryRequest and caps lanes at the layout limit', () => {
  const v = { ...defaultState('demo'), strands: [{ type: 'expression', id: 12, variants: 'default', glyph: 'circle' }] };
  const body = queryBody(v, { maxLanes: 5, formatFilter });
  assert.deepEqual(check('TimelineQueryRequest', body), []);
  assert.deepEqual(body.strands, [{ type: 'expression', ref: 12 }]);
  assert.equal(body.lanes.max, 5);
  assert.equal(body.f, 'syn:1');
});

test('tiles: debounced, keyed for abort, cached; asked-and-missing tiles are loaded with no cells', async () => {
  const api = fakeApi(() => TILES);
  const t = fakeTimers();
  let changes = 0;
  const c = createTilesClient({ api, onChange: () => { changes++; }, setTimer: t.set, clearTimer: t.clear });
  c.setQuery('9f2c41aa07b3e1d0', 47);
  c.request({ tier: 'L2', visible: [2, 3], prefetch: [1, 4] });
  c.request({ tier: 'L2', visible: [2, 3], prefetch: [1, 4] });
  assert.equal(api.calls.length, 0, 'nothing before the debounce');
  assert.equal(t.list.filter((x) => x.live).length, 1, 'one pending timer');
  assert.equal(t.list.find((x) => x.live).ms, DEBOUNCE_MS);
  t.flush();
  await tick();
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0], { path: '/timeline/tiles', query: { q: '9f2c41aa07b3e1d0', tier: 'L2', tiles: [2, 3, 1, 4] }, key: 'tiles-L2' });
  const map = c.tilesFor('L2');
  assert.equal(map.get(2).tile, 2);
  assert.equal(map.get(1), null, 'tile 1 was asked and not returned: loaded, no cells (uncovered)');
  assert.equal(changes, 1);
  c.request({ tier: 'L2', visible: [2, 3], prefetch: [1, 4] });
  assert.equal(t.list.filter((x) => x.live).length, 0, 'everything cached: no new request');
  assert.equal(c.loading, false);
});

test('a new query or data version clears in-flight work and the marks', async () => {
  const api = fakeApi(() => ({ marks: [], truncated: false, total: 0 }));
  const c = createTilesClient({ api, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  c.setQuery('a', 1);
  await c.requestMarks({ fromYear: 1990, toYear: 1999, fromDay: 0, toDay: 1 });
  await c.requestMarks({ fromYear: 1990, toYear: 1999, fromDay: 0, toDay: 1 });
  assert.equal(api.calls.filter((x) => x.path === '/timeline/marks').length, 1, 'once per range');
  assert.deepEqual(api.calls[0].query, { q: 'a', from: 1990, to: 1999, limit: 4000 });
  assert.ok(c.marks);
  assert.equal(c.setQuery('a', 2), true);
  assert.equal(c.marks, null);
  assert.ok(api.aborted.includes('tiles-L2') && api.aborted.includes('marks') && api.aborted.includes('arcs'));
});

test('a different answered tier is cached under its own name and the asked tiles are not refetched', async () => {
  const api = fakeApi(() => TILES);   // always answers L2
  const c = createTilesClient({ api, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  c.setQuery('q', 1);
  c.request({ tier: 'L3', visible: [29, 30] });
  await tick();
  assert.equal(c.tierFor('L3'), 'L2');
  assert.equal(c.tilesFor('L3').size, 0, 'nothing is relabelled as L3');
  assert.equal(c.tilesFor('L2').size, 2);
  c.request({ tier: 'L3', visible: [29, 30] });
  await tick();
  assert.equal(api.calls.length, 1);
});

test('the LRU keeps the 512 most recent entries', () => {
  const l = createLru(512);
  for (let i = 0; i < 600; i++) l.set(i, i);
  assert.equal(l.size, 512);
  assert.equal(l.has(0), false);
  l.get(100);
  l.set(1000, 1);
  assert.equal(l.has(100), true, 'a read refreshes recency');
  assert.equal(l.has(88), false, 'the least recent goes first');
});

test('the folded overview asks several tiers at once: one debounced request per tier', async () => {
  const api = fakeApi((path, q) => ({ ...TILES, tier: q.tier, tiles: [] }));
  const t = fakeTimers();
  const c = createTilesClient({ api, setTimer: t.set, clearTimer: t.clear });
  c.setQuery('k', 1);
  c.request({ tier: 'L0', visible: [-1, 0] });
  c.request({ tier: 'L1', visible: [-1, 0] });
  c.request({ tier: 'L2', visible: [2, 3] });
  assert.equal(t.list.filter((x) => x.live).length, 3, 'a pending request per tier, none overwritten');
  t.flush();
  await tick();
  assert.deepEqual(api.calls.map((x) => x.query.tier).sort(), ['L0', 'L1', 'L2']);
  assert.equal(c.tilesFor('L0').get(0), null, 'asked and empty: loaded, no cells');
});

test('arcs: fetched once per range and evidence filter; the vantage is applied client-side (no refetch)', async () => {
  const api = fakeApi(() => ({ total: 0, returned: 0, hidden: {}, items: [], bundles: [] }));
  const c = createTilesClient({ api, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  c.setQuery('a', 1);
  await c.requestArcs({ fromYear: 1880, toYear: 2030, ev: 'documented,computed,proposed', tier: 'L2' });
  await c.requestArcs({ fromYear: 1880, toYear: 2030, ev: 'documented,computed,proposed', tier: 'L2' });
  const calls = api.calls.filter((x) => x.path === '/timeline/arcs');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].query, { q: 'a', from: 1880, to: 2030, ev: 'documented,computed,proposed', tier: 'L2', limit: 300 });
  assert.equal('vantage' in calls[0].query, false);
  await c.requestArcs({ fromYear: 1880, toYear: 2030, ev: '', tier: 'L2' });
  assert.equal(api.calls.filter((x) => x.path === '/timeline/arcs').length, 1, 'an empty evidence filter shows no arcs without asking');
  assert.deepEqual(c.arcs.data.items, []);
});

test('a tile request the server could not answer in time (503) is retried twice, later, before an error is shown', async () => {
  let calls = 0;
  const api = fakeApi(() => { calls++; if (calls < 3) { throw Object.assign(new Error('The query took longer than 5000 ms and was stopped.'), { status: 503, code: 'QUERY_TIMEOUT' }); } return TILES; });
  const t = fakeTimers();
  const errors = [];
  const c = createTilesClient({ api, setTimer: t.set, clearTimer: t.clear, onError: (e) => errors.push(e) });
  c.setQuery('9f2c41aa07b3e1d0', 47);
  c.request({ tier: 'L2', visible: [2], immediate: true });
  await tick();
  assert.equal(calls, 1);
  c.request({ tier: 'L2', visible: [2], immediate: true });
  await tick();
  assert.equal(calls, 1, 'while it waits to retry, the tile counts as in flight');
  t.flush(); await tick();
  t.flush(); await tick();
  assert.equal(calls, 3);
  assert.deepEqual(errors, [], 'no error toast when a retry succeeds');
  assert.equal(c.tilesFor('L2').get(2).tile, 2);
});

test('a saved view opened as saved sends its save time with the query, and its cutoffs and pinned runs with the arcs (D17, D7)', async () => {
  const view = defaultState('demo');
  const body = queryBody(view, { formatFilter, cutoffs: { import_batch: 15, annotation_rev: 2985, relationship_rev: 213721, at: '2026-10-08T20:00:00.000Z' } });
  assert.deepEqual(body.cutoffs, { import_batch: 15, at: '2026-10-08T20:00:00.000Z' });
  const saved = { slug: 'v', asSaved: true, cutoffs: { import_batch: 15, annotation_rev: 2985, relationship_rev: 213721 }, runIds: { quotes: 5, cluster: 12 } };
  assert.deepEqual(arcsAsSaved(saved), { rel_rev_cutoff: 213721, rev_cutoff: 2985, runs: '5,12' });
  assert.equal(arcsAsSaved({ ...saved, asSaved: false }), null, 'current data: no cutoffs');
  assert.equal(arcsAsSaved(null), null);

  const api = fakeApi(() => ({ total: 0, returned: 0, hidden: {}, items: [], bundles: [] }));
  const client = createTilesClient({ api, setTimer: fakeTimers().set });
  client.setQuery('abc', 1);
  await client.requestArcs({ fromYear: 1900, toYear: 2000, ev: 'documented', tier: 'L2', saved: arcsAsSaved(saved) });
  const q = api.calls.find((c) => c.path === '/timeline/arcs').query;
  assert.equal(q.rel_rev_cutoff, 213721);
  assert.equal(q.rev_cutoff, 2985);
  assert.equal(q.runs, '5,12');
});
