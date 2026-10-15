// OWNER: WP6 — tiles → model on the contract fixtures (SPEC §1.2, §1.6, §1.7; §13 rules 3, 4):
// bars never bridge, states come from cells, a bin without a cell is uncovered, washes stay out of bars,
// conservation per lane, exact caps and censoring, unit scales, the occurrence override and its reconciliation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildColumns, buildModel, findBars, markLabel, reconcileMarks, stepClass, strandSummary, MAX_MARKS, STATE } from '../src/ui/timeline/model.mjs';
import { binStartDay, binEndDay } from '../src/ui/timeline/tiers.mjs';
import { formatTokens, unitLabel } from '../src/shared/format.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8'));
const QUERY = fixture('POST__api_timeline_query.json').variants;
const TILES = fixture('GET__api_timeline_tiles.json').variants;
const MARKS = fixture('GET__api_timeline_marks.json').variants;
const STRANDS = [{ type: 'expression', id: 12, glyph: 'circle' }];
const RANGE = [dayFromYMD(1880), dayFromYMD(2040, 12, 31)];

function model({ query = QUERY.ready.body, tiles = TILES.ok.body, marks = null, range = RANGE, visible = range, laneLimit = 10, strands = STRANDS, lanesView = null } = {}) {
  const map = new Map(tiles.tiles.map((t) => [t.tile, t]));
  return buildModel({ query, tier: tiles.tier, tiles: map, range, visible, strands, marks, laneLimit, lanesView, strandLabels: new Map([['12', 'carry the zero']]) });
}
const lane = (m, key) => m.lanes.find((l) => l.key === `community:${key}`);

describe('the fixtures this package builds against are valid contract shapes', () => {
  test('TimelineQuery, Tiles and Marks', () => {
    for (const v of ['ready', 'materializing', 'cipher_seam']) assertShape('TimelineQuery', QUERY[v].body, `query ${v}`);
    for (const v of ['ok', 'pending']) assertShape('Tiles', TILES[v].body, `tiles ${v}`);
    for (const v of ['ok', 'truncated', 'empty']) assertShape('Marks', MARKS[v].body, `marks ${v}`);
  });
});

describe('bars (§1.2)', () => {
  const m = model();

  test('a bar is a maximal run of consecutive OBSERVED bins and never bridges a gap', () => {
    for (const l of m.lanes) for (const s of l.strands) {
      for (const b of s.bars) {
        for (let i = b.start; i <= b.end; i++) {
          assert.equal(s.cols.state[i], STATE.observed, `${l.key} bin ${s.cols.bin[i]}`);
          if (i > b.start) assert.equal(s.cols.bin[i], s.cols.bin[i - 1] + 1, `${l.key}: bars never jump a bin`);
        }
        const before = b.start - 1, after = b.end + 1;
        assert.ok(before < 0 || s.cols.state[before] !== STATE.observed || s.cols.bin[before] !== s.cols.bin[b.start] - 1, 'maximal on the left');
        assert.ok(after >= s.cols.length || s.cols.state[after] !== STATE.observed || s.cols.bin[after] !== s.cols.bin[b.end] + 1, 'maximal on the right');
      }
    }
    const classroom = lane(m, 'classroom').strands[0];
    assert.deepEqual(classroom.bars.map((b) => [b.loDay, b.hiDay]), [[dayFromYMD(1900), dayFromYMD(1939, 12, 31)], [dayFromYMD(1950), dayFromYMD(1959, 12, 31)]],
      'the 1940s (no cell anywhere) split the Classroom bar in two');
  });

  test('states come from the cells; a bin without a cell is uncovered, never inferred', () => {
    const c = lane(m, 'classroom');
    const s = c.strands[0];
    const stateOf = (bin) => s.cols.state[[...s.cols.bin].indexOf(bin)];
    assert.equal(stateOf(189), STATE.low, '1890s: low coverage');
    assert.equal(stateOf(196), STATE.absent, '1960s: looked, found none');
    assert.equal(stateOf(194), undefined, '1940s: no cell');
    assert.ok(c.uncovered.some((r) => r[2] <= 194 && r[3] >= 194), '1940s is an uncovered run');
    const hip = lane(m, 'hiphop').strands[0];
    assert.equal(hip.cols.state[0], STATE.absent, 'Hip-hop 1980s: 0 in 6.2k tokens');
    assert.equal(hip.cols.denom[0], 6200);
    for (const l of m.lanes) for (const st of l.strands) for (let i = 0; i < st.cols.length; i++) {
      if (st.cols.state[i] >= STATE.low) assert.ok(Number.isNaN(st.cols.rate[i]), `${l.key}: a ${st.cols.state[i]} cell carries no rate`);
    }
  });

  test('low-coverage bins never become bars, even with n > 0', () => {
    const crit = lane(m, 'criticism').strands[0];
    assert.equal(crit.cols.state[0], STATE.low);
    assert.equal(crit.cols.n[0], 2);
    assert.deepEqual(crit.bars.map((b) => [b.loDay, b.hiDay]), [[dayFromYMD(2010), dayFromYMD(2019, 12, 31)]]);
  });

  test('caps sit at the exact first/last observed date when known; otherwise on the bar edge, labelled by bin', () => {
    const [a, b] = lane(m, 'classroom').strands[0].bars;
    assert.deepEqual([a.startCap.day, a.startCap.exact, a.startCap.label], [dayFromYMD(1905), true, '1905']);
    assert.deepEqual([a.endCap.exact, a.endCap.label], [false, 'in 1930–1939']);
    assert.deepEqual([b.endCap.day, b.endCap.exact, b.endCap.label], [dayFromYMD(1959, 12, 31), true, '1959']);
    const hip = lane(m, 'hiphop').strands[0].bars[0];
    assert.equal(hip.startCap.day, 8902, 'first observed 17 May 1994');
    const crit = lane(m, 'criticism').strands[0].bars[0];
    assert.deepEqual([crit.startCap.exact, crit.startCap.label], [false, 'in 2010–2019'], 'the lane’s first date lies in a low bin, not in this bar');
  });

  test('censoring: ◁ when the run starts in the lane’s first covered bin, ▷ at its last', () => {
    assert.equal(lane(m, 'office-lab').strands[0].bars[0].startCap.censored, true);
    assert.equal(lane(m, 'classroom').strands[0].bars[0].startCap.censored, false);
    assert.equal(lane(m, 'hiphop').strands[0].bars[0].endCap.censored, true);
    assert.equal(lane(m, 'hiphop').strands[0].bars[0].startCap.censored, false);
    assert.equal(lane(m, 'software').strands[0].bars[0].startCap.censored, true);
  });

  test('with several strands the lane’s first/last date is not attributed to a strand', () => {
    const two = model({ strands: [...STRANDS, { type: 'expression', id: 99, glyph: 'square' }] });
    assert.equal(lane(two, 'classroom').strands[0].bars[0].startCap.exact, false);
    assert.equal(lane(two, 'classroom').strands[1].bars.length, 0, 'strand 99 has no cells: nothing is drawn');
  });
});

describe('washes, conservation and units (§1.7)', () => {
  const m = model();

  test('washes come from the server list, deduplicated, and are never added to bins', () => {
    const c = lane(m, 'classroom').strands[0];
    assert.equal(c.washes.length, 1);
    assert.deepEqual([c.washes[0].loDay, c.washes[0].hiDay, c.washes[0].n], [dayFromYMD(1900), dayFromYMD(1933, 12, 31), 1]);
    const o = lane(m, 'office-lab').strands[0];
    assert.equal(o.washes[0].circa, true, 'c. 1960 feathers');
    const barN = c.bars.reduce((s, b) => s + b.n, 0);
    assert.equal(barN, 87, 'bars count only binned matches');
  });

  test('conservation per lane: Σ bin n + Σ wash n + undated + scheduled = total n', () => {
    for (const l of m.lanes) {
      const s = l.strands[0];
      const sum = s.totals.binN + s.totals.washN + l.undated + l.scheduled;
      assert.equal(sum, l.n, `${l.key}: ${s.totals.binN} + ${s.totals.washN} + ${l.undated} + ${l.scheduled}`);
    }
  });

  test('one thickness scale per unit, from the largest observed rate', () => {
    assert.deepEqual(Object.keys(m.units), ['per_million_tokens']);
    assert.equal(m.units.per_million_tokens.max, 10789.5);
  });

  test('coverage step classes and the coverage track (units never mix)', () => {
    assert.deepEqual([0, 1, 9999, 10000, 99999, 100000, 999999, 1e6].map((n) => stepClass(n)), [0, 1, 1, 2, 2, 3, 3, 4]);
    assert.deepEqual([0, 9, 10, 999, 1000].map((n) => stepClass(n, 'works')), [0, 1, 2, 3, 4]);
    assert.deepEqual(m.coverageTrack.map((r) => r.unit), ['tokens']);
    const c194 = m.coverageTrack[0].cells.find((c) => c.bin === 194);
    assert.equal(c194, undefined, 'no lane covers the 1940s');
  });

  test('the bar summary is generated from the same numbers (§1.2 item 9)', () => {
    const l = lane(m, 'classroom');
    const txt = strandSummary(l, l.strands[0], { tier: 'L2', formatTokens, unitLabel });
    assert.equal(txt, 'carry the zero · Classroom · first observed 1905 · last observed 1959 · observed in 5 of 7 covered decades · 1 gap · 88 matches in range (1 in washes) · per million tokens over 14.4k tokens · SYNTHETIC');
  });

  test('pending lanes and cells: "indexing — not yet looked", no bars', () => {
    const p = model({ tiles: TILES.pending.body });
    for (const l of p.lanes) {
      assert.equal(l.strands[0].bars.length, 0);
      assert.ok(l.pendingRuns.length > 0, `${l.key} has pending runs`);
    }
    const seam = buildModel({ query: QUERY.cipher_seam.body, tier: 'L2', tiles: new Map([[3, null]]), range: [dayFromYMD(1920), dayFromYMD(2030)], strands: STRANDS });
    assert.equal(seam.lanes[0].pending, true);
    assert.ok(seam.lanes[0].pendingRuns.length && !seam.lanes[0].uncovered.length, 'a pending lane is never drawn as "no sources"');
    assert.ok(seam.lanes[1].uncovered.length, 'the titles lane with no cells in loaded tiles is uncovered');
  });

  test('tiles not loaded are "unloaded", never absence', () => {
    const m2 = model({ tiles: { ...TILES.ok.body, tiles: [TILES.ok.body.tiles[1]] } });
    assert.deepEqual(m2.missingTiles, [2]);
    assert.ok(lane(m2, 'classroom').unloaded.length > 0);
    assert.ok(!lane(m2, 'classroom').uncovered.some((r) => r[3] < 192), 'no uncovered run inside the unloaded tile');
    assert.equal(m2.wantMarks, false, 'no override decision while tiles are missing');
  });
});

describe('occurrence override (§1.6)', () => {
  test('wanted when 0 < dated matches in view ≤ 4,000', () => {
    const m = model();
    assert.equal(m.visibleN, 338);
    assert.equal(m.wantMarks, true);
    assert.ok(MAX_MARKS === 4000);
  });

  test('marks that do not reconcile with the bins are never drawn in place of bars', () => {
    const marks = { items: MARKS.ok.body.marks, truncated: false, total: 23, fromDay: RANGE[0], toDay: RANGE[1] };
    const m = model({ marks });
    assert.equal(m.override, false);
    assert.equal(m.marksCheck.ok, false);
    assert.match(m.marksCheck.reason, /do not reconcile/);
    const t = model({ marks: { ...marks, truncated: true } });
    assert.equal(t.marksCheck.reason, 'marks truncated');
  });

  test('reconciling marks replace bars and give exact caps', () => {
    // A small synthetic tile whose bins are fully accounted for by its marks.
    const tiles = { tier: 'L3', tiles: [{ tile: 31, bin0: 1984, lanes: { 'community:hiphop': { strands: { 12: [[10, 2, 2, 2, 3000, 666.7, 80, 2400, 1, 17, 0.5]] } } },
      coverage: { 'community:hiphop': [[10, 0, 2, 3000, 1]] }, washes: [] }] };
    const q = { ...QUERY.ready.body, lanes: [QUERY.ready.body.lanes[2]] };
    const items = [
      { occ: 1, passage: 11, doc: 1, lane: 'community:hiphop', strand: 12, lo_day: 8902, hi_day: 8902, precision: 'day', basis: 'stated', kind: 'text', name_flag: false, synthetic: true },
      { occ: 2, passage: 12, doc: 2, lane: 'community:hiphop', strand: 12, lo_day: 8766, hi_day: 9130, precision: 'year', basis: 'stated', kind: 'text', name_flag: false, synthetic: true },
    ];
    const range = [dayFromYMD(1990), dayFromYMD(1998, 12, 31)];
    const m = buildModel({ query: q, tier: 'L3', tiles: new Map([[31, tiles.tiles[0]]]), range, strands: STRANDS,
      marks: { items, truncated: false, total: 2, fromDay: range[0], toDay: range[1] } });
    assert.equal(m.marksCheck.ok, true);
    assert.equal(m.override, true);
    const bar = m.lanes[0].strands[0].bars[0];
    assert.deepEqual([bar.startCap.day, bar.startCap.exact, bar.startCap.label], [8766, true, '1994']);
    assert.equal(markLabel(items[0]), '17 May 1994');
  });

  test('reconcileMarks counts only shown lanes and pinned strands', () => {
    const r = reconcileMarks({ marks: null, lanes: [], refs: [], cellsBy: new Map(), washesBy: new Map(), tier: 'L2' });
    assert.equal(r.ok, false);
  });
});

describe('lanes', () => {
  test('a lane limit folds the rest into "+n more lanes" with their n', () => {
    const m = model({ laneLimit: 5 });
    assert.equal(m.lanes.length, 5);
    assert.equal(m.hiddenLanes, 5);
    assert.equal(m.hiddenN, 0, 'the five hidden demo lanes have n = 0');
  });

  test('manual order is applied client-side from the view', () => {
    const m = model({ lanesView: { order: 'manual', manual: ['community:software', 'community:classroom'] } });
    assert.deepEqual(m.lanes.slice(0, 2).map((l) => l.key), ['community:software', 'community:classroom']);
  });

  test('columns are typed arrays aligned to bins', () => {
    const cols = buildColumns([[191, 22, 6, 5, 2700, 8148.1, 5106.4, 12336.4, 1, 16, 0.31]], 'L2');
    assert.ok(cols.bin instanceof Int32Array && cols.rate instanceof Float64Array && cols.state instanceof Uint8Array);
    assert.deepEqual([cols.lo[0], cols.hi[0]], [binStartDay('L2', 191), binEndDay('L2', 191)]);
    assert.deepEqual(findBars(cols), [{ start: 0, end: 0 }]);
  });
});
