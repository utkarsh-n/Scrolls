// OWNER: WP4 — the meaning constellation (SPEC §2.B): deterministic Fruchterman–Reingold with pinned nodes,
// the layout cache that never moves a placed node, bounds, two-period presence, gates without numerals, and
// the route's cache write / layout-job fallback. The integration part runs on the SYNTHETIC demo.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { BOUNDS, constellationQuery, layoutKey, parsePeriod, POSITION_NOTE, readLayoutCache, RELAYOUT_TOAST, stableLayout,
  writeLayoutCache } from '../server/analysis/layout.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { run as runCluster } from '../server/jobs/tasks/cluster.mjs';
import { run as runLayoutJob } from '../server/jobs/tasks/layout.mjs';
import { persistLayout } from '../server/routes/constellation.mjs';
import { tx } from '../server/db/open.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

function graph() {
  const nodes = ['x:1', 'x:2'], edges = [];
  for (let i = 0; i < 25; i++) { nodes.push(`w:a${i}`); edges.push(['x:1', `w:a${i}`]); }
  for (let i = 0; i < 15; i++) { nodes.push(`w:b${i}`); edges.push(['x:2', `w:b${i}`]); }
  for (let i = 0; i < 4; i++) { nodes.push(`k:${i}`); edges.push(['x:1', `k:${i}`, 2]); }
  return { nodes, edges };
}

describe('stable layout (pure)', () => {
  test('deterministic for a seed, independent of node order, inside the frame, no overlaps', () => {
    const { nodes, edges } = graph();
    const a = stableLayout(nodes, edges, { seed: 99 });
    const b = stableLayout([...nodes].reverse(), [...edges].reverse(), { seed: 99 });
    assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
    const pts = [...a.values()];
    assert.equal(pts.length, nodes.length);
    for (const [x, y] of pts) assert.ok(x >= 0.04 - 1e-9 && x <= 0.96 + 1e-9 && y >= 0.04 - 1e-9 && y <= 0.96 + 1e-9);
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    assert.ok(min >= 0.03, `closest pair ${min}`);
    assert.notDeepEqual([...stableLayout(nodes, edges, { seed: 100 }).values()], pts, 'another seed, another layout');
  });

  test('pinned nodes never move; new nodes are placed around them', () => {
    const { nodes, edges } = graph();
    const first = stableLayout(nodes, edges, { seed: 5 });
    const more = [...nodes, 'w:new1', 'w:new2', 'd:9'];
    const second = stableLayout(more, [...edges, ['x:1', 'w:new1'], ['x:2', 'w:new2'], ['x:2', 'd:9']], { seed: 5, pinned: first });
    for (const id of nodes) assert.deepEqual(second.get(id), first.get(id));
    for (const id of ['w:new1', 'w:new2', 'd:9']) assert.ok(second.get(id));
    assert.equal(stableLayout([], []).size, 0);
  });

  test('layout keys ignore strand order; periods parse; the cache keeps placed nodes unless a newer re-layout replaces them', () => {
    assert.equal(layoutKey({ corpus: 'demo', strands: [3, 1], runs: { a: 1 } }), layoutKey({ corpus: 'demo', strands: [1, 3], runs: { a: 1 } }));
    assert.notEqual(layoutKey({ corpus: 'demo', strands: [1], runs: { a: 1 } }), layoutKey({ corpus: 'demo', strands: [1], runs: { a: 2 } }));
    assert.deepEqual(parsePeriod('1955-1985', 'a'), [1955, 1985]);
    assert.deepEqual(parsePeriod('-500..100', 'a'), [-500, 100]);
    assert.equal(parsePeriod('', 'a'), null);
    assert.throws(() => parsePeriod('1990-1980', 'b'), (e) => e.status === 400);
    const t = makeTmpData({ seed: false });
    try {
      writeLayoutCache(t.db, { key: 'fnv:1', positions: { a: [0.1, 0.1] }, generation: 0, seed: 1 });
      writeLayoutCache(t.db, { key: 'fnv:1', positions: { a: [0.9, 0.9], b: [0.5, 0.5] }, generation: 0, seed: 1 });
      assert.deepEqual(readLayoutCache(t.db, 'fnv:1').positions, { a: [0.1, 0.1], b: [0.5, 0.5] });
      writeLayoutCache(t.db, { key: 'fnv:1', positions: { a: [0.7, 0.7] }, generation: 1, seed: 2, replace: true });
      const c = readLayoutCache(t.db, 'fnv:1');
      assert.deepEqual([c.generation, c.positions], [1, { a: [0.7, 0.7] }]);
    } finally { t.cleanup(); }
  });
});

describe('constellation on the synthetic demo', () => {
  let tmp, db, ids, skip = null;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    try {
      const { registerAdapters } = await import('../server/adapters/registry.mjs');
      await registerAdapters(db);
      const demo = await import('../server/jobs/tasks/demo-load.mjs');
      ids = (await demo.run(ctx, { pipeline: false })).human_layer.expressions;
      const materialize = await import('../server/jobs/tasks/materialize.mjs');
      for (const id of Object.values(ids)) await materialize.run(ctx, { expressionId: id });
    } catch (err) {
      skip = `the demo or materialize (WP2/WP3) failed: ${err.message}`;
      return;
    }
    await runCluster(ctx, { expressionId: ids['carry the zero'], params: { representation: 'tfidf-hash-4096', k: 'auto', seed: 1994, with: [] } });
  });
  after(() => tmp?.cleanup());

  const q = (args) => {
    const body = constellationQuery(db, args);
    if (body.cache_write) tx(db, () => writeLayoutCache(db, body.cache_write));
    return body;
  };

  test('two periods: Constellation shape, bounds, legend, presence; gated measures carry no numeral', (t) => {
    if (skip) { t.skip(skip); return; }
    const strands = `${ids['carry the zero']},${ids['ghost in the margin']}`;
    const p = q({ strands, a: '1990-2005', b: '2010-2026' });
    const { cache_write: _cw, ...body } = p;
    assert.deepEqual(check('Constellation', body), []);
    assert.ok(p.nodes.length <= BOUNDS.nodes && p.edges.length <= BOUNDS.edges);
    const types = new Set(p.nodes.map((n) => n.type));
    for (const tname of ['expression', 'cluster', 'word', 'document']) assert.ok(types.has(tname), `has ${tname} nodes`);
    assert.equal(p.legend.note, POSITION_NOTE);
    assert.match(p.legend.size, /occurrences in period/);
    assert.equal(p.layout.algorithm, 'fruchterman-reingold-300');
    assert.equal(p.synthetic, true);
    for (const n of p.nodes) {
      assert.equal(n.pos.length, 2);
      assert.ok(n.pos.every((v) => v >= 0 && v <= 1));
      if (n.type === 'document' && n.synthetic) assert.match(n.label, /\(synthetic\)$/);
      // fix pass (§13 rule 1): a collocate counted in invented text is a synthetic quantity
      if (n.type === 'word') assert.equal(n.synthetic, true, `${n.id} counted in synthetic text`);
    }
    // 'ghost in the margin' has 17 matches in 1990–2005: its collocates there are gated, with no numeral
    const g = p.gates.cooc[`x:${ids['ghost in the margin']}`].a;
    assert.equal(g.gate, 'insufficient_occurrences');
    assert.equal(g.value, null);
    assert.ok(p.edges.filter((e) => e.kind === 'cooc' && e.s === `x:${ids['ghost in the margin']}`).every((e) => e.weight.a === null));
    // 'uncredited' is a context word of both strands in B only
    const unc = p.nodes.find((n) => n.id === 'w:uncredited');
    assert.ok(unc && unc.present.b && !unc.present.a);
    assert.ok(p.diff.only_b.includes('w:uncredited'));
    // relationships keep their evidence status; similarity-only types are never drawn here
    for (const e of p.edges.filter((x) => x.kind === 'rel')) {
      assert.ok(['documented', 'computed', 'proposed'].includes(e.evidence_status));
      assert.notEqual(e.review_status, 'rejected');
    }
    const member = p.edges.filter((e) => e.kind === 'member');
    assert.equal(member.length, 4);
    for (const per of ['a', 'b']) {
      const sum = member.reduce((s, e) => s + (e.weight[per] ?? 0), 0);
      assert.ok(Math.abs(sum - 1) < 1e-3, `member shares in ${per} sum to ${sum}`);
    }
  });

  test('changing or comparing periods never moves a node; re-layout is explicit and says so', (t) => {
    if (skip) { t.skip(skip); return; }
    const strands = String(ids['carry the zero']);
    const a = q({ strands, a: '1955-1985' });
    const ab = q({ strands, a: '1955-1985', b: '1994-2026' });
    const other = q({ strands, a: '1900-1939', b: '2010-2026' });
    assert.equal(ab.layout.key, a.layout.key);
    assert.ok(ab.layout.pinned);
    const at = new Map(a.nodes.map((n) => [n.id, n.pos]));
    let common = 0;
    for (const n of [...ab.nodes, ...other.nodes]) if (at.has(n.id)) { common++; assert.deepEqual(n.pos, at.get(n.id), n.id); }
    assert.ok(common >= a.nodes.length);
    const again = q({ strands, a: '1955-1985' });
    assert.equal(again.layout.placed, 0);
    assert.equal(again.cache_write, null);
    const re = q({ strands, a: '1955-1985', relayout: 1 });
    assert.equal(re.layout.toast, RELAYOUT_TOAST);
    assert.equal(re.layout.generation, a.layout.generation + 1);
    const after = q({ strands, a: '1955-1985' });
    assert.deepEqual(after.nodes.map((n) => n.pos), re.nodes.map((n) => n.pos));
  });

  test('A is always the earlier period; bounds and size modes; expansion adds ≤ 20 neighbours', (t) => {
    if (skip) { t.skip(skip); return; }
    const strands = String(ids['carry the zero']);
    const p = q({ strands, a: '1994-2026', b: '1955-1985', size: 'documents' });
    assert.deepEqual([p.periods.a, p.periods.b, p.periods.swapped], [[1955, 1985], [1994, 2026], true]);
    assert.match(p.legend.size, /documents in period/);
    const x = p.nodes.find((n) => n.type === 'expression');
    assert.ok(x.size.a > 0 && x.size.b > 0);
    const small = q({ strands, a: '1955-1985', max_nodes: 5, max_edges: 3 });
    assert.equal(small.nodes.length, 5);
    assert.ok(small.edges.length <= 3);
    assert.ok(small.truncated.nodes > 0);
    const base = q({ strands, a: '1994-2026' });
    const grown = q({ strands, a: '1994-2026', expand: `x:${ids['carry the zero']}` });
    assert.ok(grown.nodes.length > base.nodes.length && grown.nodes.length - base.nodes.length <= 2 * BOUNDS.expand);
    assert.throws(() => constellationQuery(db, { strands: '1,2,3,4,5' }), (e) => e.status === 400);
    assert.throws(() => constellationQuery(db, { strands, size: 'weight' }), (e) => e.status === 400);
    const whole = q({ strands });
    assert.ok(whole.periods.notes[0].startsWith("Period A defaults to the strands' dated extent"));
  });

  test('a strand without a clustering run shows the gate, not groups', (t) => {
    if (skip) { t.skip(skip); return; }
    const p = q({ strands: String(ids['flux up']), a: '1918-1940' });
    assert.equal(p.gates.member[`x:${ids['flux up']}`].a.gate, 'not_run');
    assert.equal(p.nodes.filter((n) => n.type === 'cluster').length, 0);
  });

  test('positions reach layout_cache on the main connection, or through a layout job when the writer is busy', async (t) => {
    if (skip) { t.skip(skip); return; }
    const write = { key: 'fnv:test', positions: { 'x:1': [0.3, 0.3] }, generation: 0, seed: 3 };
    const ctx = { withWrite: (fn) => tx(db, () => fn(db)), jobs: { enqueue: () => { throw new Error('not expected'); } } };
    assert.equal(persistLayout(ctx, write), 'stored');
    assert.deepEqual(readLayoutCache(db, 'fnv:test').positions, { 'x:1': [0.3, 0.3] });
    const queued = [];
    const busy = { withWrite: () => { throw Object.assign(new Error('database is locked'), { code: 'E_BUSY' }); },
      jobs: { enqueue: (type, params) => { queued.push([type, params]); return 1; } } };
    assert.equal(persistLayout(busy, write), 'queued');
    assert.equal(queued[0][0], 'layout');
    const ctxJob = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    const res = await runLayoutJob(ctxJob, { write: { ...write, positions: { 'x:1': [0.9, 0.9], 'x:2': [0.1, 0.2] } } });
    assert.deepEqual(res, { key: 'fnv:test', stored: 2, kept: 1 });
    assert.deepEqual(readLayoutCache(db, 'fnv:test').positions, { 'x:1': [0.3, 0.3], 'x:2': [0.1, 0.2] });
    const pre = await runLayoutJob(ctxJob, { request: { strands: String(ids['ghost in the margin']), a: '2000-2026' } });
    assert.ok(pre.stored > 0);
    await assert.rejects(runLayoutJob(ctxJob, {}), (e) => e.status === 400);
  });
});
