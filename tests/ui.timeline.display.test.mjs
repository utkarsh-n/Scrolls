// OWNER: WP6 — the display list (SPEC §8.3, §8.4, §11 row 3): every openable primitive has a hit entry whose
// ref resolves to a passage or a bin-drawer page; the vantage hides or ghosts later observations but never the
// record's gaps; nothing is drawn across a gap; budgets; marks and coarse-dated bands; the seam; the SVG
// serialiser emits the same list.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { buildModel } from '../src/ui/timeline/model.mjs';
import { buildDisplay, describeModel, layoutLanes, vantageState, BUDGET, GEOM, rulerLabelWidth, seamLabelWidth } from '../src/ui/timeline/display.mjs';
import { buildHitGrid } from '../src/ui/timeline/hit.mjs';
import { toSvg, primToSvg } from '../src/ui/timeline/svg.mjs';
import { FALLBACK } from '../src/ui/timeline/paint.mjs';
import { binId, parseBinId } from '../src/ui/timeline/viewport.mjs';
import { seamCaptionPlace, shortSeamLabel } from '../src/ui/timeline/seams.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8'));
const QUERY = fixture('POST__api_timeline_query.json').variants;
const TILES = fixture('GET__api_timeline_tiles.json').variants;
const BIN = fixture('GET__api_timeline_bin.json');
const STRANDS = [{ type: 'expression', id: 12, glyph: 'circle' }];
const RANGE = [dayFromYMD(1880), dayFromYMD(2040, 12, 31)];
const DPP = 30;

function build({ vantage = null, query = QUERY.ready.body, tiles = TILES.ok.body, layers = {}, marks = null, tier = tiles.tier, range = RANGE, dpp = DPP, seamCollapsed = false } = {}) {
  const model = buildModel({ query, tier, tiles: new Map(tiles.tiles.map((t) => [t.tile, t])), range, strands: STRANDS, marks, strandLabels: new Map([['12', 'carry the zero']]) });
  const layout = layoutLanes(model.lanes, STRANDS.length, { moreRow: model.hiddenLanes > 0 });
  const display = buildDisplay(model, { originDay: range[0], daysPerPx: dpp, width: (range[1] - range[0]) / dpp, layout, vantage, layers, seams: query.seams, seamCollapsed });
  return { model, layout, display };
}
const X = (day) => (day - RANGE[0]) / DPP;

describe('layout (§1.3, §1.4)', () => {
  test('a lane with one strand is 40 px; equal heights per strand count; slots of 24 px', () => {
    const one = layoutLanes([{ key: 'a' }, { key: 'b' }], 1);
    assert.deepEqual(one.lanes.map((l) => l.h), [40, 40]);
    assert.equal(one.lanes[0].slots[0].h, 24);
    assert.equal(one.lanes[0].slots[0].mid, 20);
    const four = layoutLanes([{ key: 'a' }, { key: 'b' }], 4);
    assert.deepEqual(four.lanes.map((l) => l.h), [112, 112]);
    assert.equal(layoutLanes([{ key: 'a' }], 1, { moreRow: true }).more.h, GEOM.moreRowH);
  });
});

describe('every mark resolves to text (§11 row 3, §8.4)', () => {
  test('each openable primitive has a hit entry whose ref resolves to a passage or a bin-drawer page', () => {
    const { display, model } = build();
    const grid = buildHitGrid(display.lanes);
    const ids = new Set(grid.entries.map((e) => e.id));
    const laneKeys = new Set(model.lanes.map((l) => l.key));
    const openable = display.lanes.filter((p) => p.openable);
    assert.ok(openable.length > 30, `${openable.length} openable primitives`);
    for (const p of openable) {
      assert.ok(ids.has(p.id), `${p.id} has a hit entry`);
      const ref = p.ref;
      if (ref.type === 'bin') {
        const b = parseBinId(binId(ref));
        assert.ok(b && laneKeys.has(b.lane) && Number.isInteger(b.bin) && /^L[0-5]$/.test(b.tier), `${p.id}: bin page ${binId(ref)}`);
      } else if (ref.type === 'occurrence') {
        assert.ok(Number.isInteger(ref.passage), `${p.id}: passage`);
      } else if (ref.type === 'wash') {
        assert.ok(laneKeys.has(ref.lane), `${p.id}: wash list of its lane`);
      } else assert.fail(`${p.id}: openable with an unresolvable ref ${JSON.stringify(ref)}`);
    }
    // The bin page the drawer asks for is the contract's BinDrawer (denominator line first).
    assert.ok(BIN.variants.ok.body.denominator.text.startsWith('n = 22 in 1910–1919'));
  });

  test('hit priority: a cap over a bin, a bin over a band', () => {
    const { display } = build();
    const grid = buildHitGrid(display.lanes);
    const cap = display.lanes.find((p) => p.style === 'cap-start' && p.ref.lane === 'community:classroom');
    const hit = grid.query(cap.x0, cap.y0);
    assert.equal(hit.cls, 'cap');
    const bar = display.lanes.find((p) => p.style === 'bar' && p.ref.lane === 'community:classroom' && p.ref.bin === 191);
    assert.equal(grid.query((bar.x0 + bar.x1) / 2 + 3, (bar.y0 + bar.y1) / 2).cls, 'bin');
    const unc = display.lanes.find((p) => p.style === 'hatch' && p.ref?.type === 'uncovered');
    const h = grid.query((unc.x0 + unc.x1) / 2, unc.y0 + 2);
    assert.equal(h.cls, 'band');
    assert.deepEqual(h.tip.slice(-1), ['no sources']);
  });
});

describe('honest drawing', () => {
  test('nothing is drawn across a gap: no bar overlaps an uncovered run of its lane', () => {
    const { display, model } = build();
    for (const lane of model.lanes) {
      const bars = display.lanes.filter((p) => p.ref?.lane === lane.key && p.style?.startsWith('bar'));
      for (const r of lane.uncovered) {
        const [x0, x1] = [X(r[0]), X(r[1] + 1)];
        for (const b of bars) assert.ok(b.x1 <= x0 + 1e-6 || b.x0 >= x1 - 1e-6, `${lane.key}: bar ${b.id} crosses the gap ${r[2]}–${r[3]}`);
      }
    }
  });

  test('absent is a dotted baseline, low a hollow tick of raw n (no rate), observed sparse bins are outlined', () => {
    const { display } = build();
    assert.ok(display.lanes.some((p) => p.style === 'absent' && p.ref.lane === 'community:hiphop' && p.tip.some((t) => /0 occurrences in 6.2k tokens — looked, found none/.test(t))));
    const low = display.lanes.find((p) => p.style === 'low-tick' && p.ref.lane === 'community:criticism');
    assert.ok(low && low.n === 2 && low.tip.some((t) => /low coverage: n = 2 in 900 tokens — rate not shown/.test(t)));
    assert.ok(display.lanes.some((p) => p.style === 'bar-sparse' && p.ref.lane === 'community:criticism'));
    assert.ok(display.lanes.filter((p) => p.style === 'bar').every((p) => p.y1 - p.y0 >= 2 && p.y1 - p.y0 <= 0.7 * 24 + 1e-9), 'heights within 2 px … 70% of the slot');
  });

  test('washes are bands with a count label; synthetic bars carry the stripe overlay', () => {
    const { display } = build();
    const w = display.lanes.find((p) => p.kind === 'wash' && p.ref.lane === 'community:classroom');
    assert.equal(w.ref.label, 'early 20th century');
    assert.ok(display.lanes.some((p) => p.style === 'wash-label' && p.text === '1 · early 20th century'));
    assert.ok(display.lanes.filter((p) => p.style === 'bar').every((p) => p.pattern === 'syn' || p.pattern === 'stripes'));
    const o = display.lanes.find((p) => p.kind === 'wash' && p.ref.lane === 'community:office-lab');
    assert.equal(o.feather, 0.1, 'circa washes feather');
  });

  test('the vantage: strict hides later observations, context ghosts them, gaps and absences stay', () => {
    const v = dayFromYMD(1925, 12, 31);
    const all = build().display.lanes;
    const strict = build({ vantage: { day: v, strict: true } }).display.lanes;
    const ctx = build({ vantage: { day: v, strict: false } }).display.lanes;
    const later = (p) => p.layer === 'data' && p.style?.startsWith('bar') && p.ref.bin * 10 + 9 > 1925;
    assert.ok(all.some(later));
    assert.ok(!strict.some(later), 'strict: no later bar');
    assert.ok(ctx.filter(later).every((p) => p.ghost === true) && ctx.some(later), 'context: later bars ghosted');
    assert.ok(!ctx.some((p) => p.style?.startsWith('bar') && p.ref.bin === 192 && !p.ghost), 'the 1920s bin straddles the vantage: not shown in full');
    for (const list of [strict, ctx]) {
      assert.ok(list.some((p) => p.style === 'absent' && p.ref.lane === 'community:hiphop'), 'looked-and-found-none stays');
      assert.ok(list.some((p) => p.style === 'hatch'), 'no sources stays');
    }
    assert.equal(vantageState(10, { day: 5, strict: true }), 'hide');
    assert.equal(vantageState(10, { day: 5, strict: false }), 'ghost');
    assert.equal(vantageState(10, null), 'show');
  });

  test('the washes layer can be switched off; coverage underlay follows the coverage layer', () => {
    const { display } = build({ layers: { washes: 0, coverage: 0 } });
    assert.ok(!display.lanes.some((p) => p.kind === 'wash'));
    assert.ok(!display.top.some((p) => p.id.startsWith('ct:')));
  });
});

describe('budgets and the occurrence override (§1.6, §8.3)', () => {
  test('fillText stays ≤ 150 and an over-budget list says so', () => {
    const { display } = build();
    assert.ok(display.stats.texts <= BUDGET.texts);
    // 25,000 observed bins at L5 exceed 20,000 shapes.
    const cells = Array.from({ length: 64 }, (_, i) => [i, 9, 3, 2, 3000, 3000, 1000, 5000, 1, 0, 0.3]);
    const tiles = { tier: 'L5', tiles: Array.from({ length: 400 }, (_, t) => ({ tile: t + 100, bin0: (t + 100) * 64, lanes: { 'community:hiphop': { strands: { 12: cells } } }, coverage: {}, washes: [] })) };
    const q = { ...QUERY.ready.body, lanes: [QUERY.ready.body.lanes[2]] };
    const range = [6400, 6400 + 400 * 64 - 1];
    const big = build({ query: q, tiles, tier: 'L5', range, dpp: 0.05 });
    assert.equal(big.display.overBudget, true);
  });

  test('override: marks replace bars (bars become a 20% backdrop); year-precision marks at month tier sit in the coarse band, never on 1 January', () => {
    // May 1994 holds the day-precision match (low: 1 in 400 tokens); the year-precision match does not fit a month: a wash.
    const idx = 1994 * 12 + 4 - 373 * 64;
    const wash = { lane: 'community:hiphop', strand: 12, lo: '1994', hi: '1994', precision: 'year', label: '1994', n: 1 };
    const tiles = { tier: 'L4', tiles: [{ tile: 373, bin0: 373 * 64, lanes: { 'community:hiphop': { strands: { 12: [[idx, 1, 1, 1, 400, null, null, null, 3, 17, null]] } } },
      coverage: { 'community:hiphop': [[idx, 0, 1, 400, 1]] }, washes: [wash] }, { tile: 374, bin0: 374 * 64, lanes: {}, coverage: {}, washes: [wash] }] };
    const q = { ...QUERY.ready.body, lanes: [QUERY.ready.body.lanes[2]] };
    const range = [dayFromYMD(1994, 1, 1), dayFromYMD(1994, 12, 31)];
    const items = [
      { occ: 1, passage: 901, doc: 44, lane: 'community:hiphop', strand: 12, lo_day: 8902, hi_day: 8902, precision: 'day', basis: 'stated', kind: 'text', name_flag: false, synthetic: true },
      { occ: 2, passage: 950, doc: 46, lane: 'community:hiphop', strand: 12, lo_day: 8766, hi_day: 9130, precision: 'year', basis: 'stated', kind: 'text', name_flag: false, synthetic: true },
    ];
    const marks = { items, truncated: false, total: 2, fromDay: range[0], toDay: range[1] };
    const { display, model } = build({ query: q, tiles, tier: 'L4', range, dpp: 0.5, marks });
    assert.equal(model.override, true);
    const day = display.lanes.find((p) => p.ref?.type === 'occurrence' && p.ref.id === 1);
    assert.equal(day.style, 'mark-text');
    const coarse = display.lanes.find((p) => p.style === 'coarse');
    assert.ok(coarse, 'the year-precision mark is a coarse-dated band');
    assert.ok(Math.abs(coarse.x0 - (8766 - range[0]) / 0.5) < 1e-6 && Math.abs(coarse.x1 - (9131 - range[0]) / 0.5) < 1e-6, 'spanning the whole year');
    assert.match(coarse.tip[0], /1 item dated only to 1994 — not drawn at a finer date/);
    assert.ok(!display.lanes.some((p) => p.ref?.id === 2 && p.kind === 'tick'), 'never a tick at 1 January');
  });
});

describe('the modality seam and the summary (§1.10, §8.6)', () => {
  test('the seam crosses every lane with its ruler caption; collapsed it stays a ruler tick', () => {
    const tiles = { tier: 'L2', tiles: [] };
    const q = QUERY.cipher_seam.body;
    const open = build({ query: q, tiles }).display;
    assert.ok(open.lanes.some((p) => p.style === 'seam'));
    assert.ok(open.top.some((p) => p.style === 'seam-label' && p.text === 'Full text ends 1928 →'));
    const shut = build({ query: q, tiles, seamCollapsed: true }).display;
    assert.ok(!shut.lanes.some((p) => p.style === 'seam'));
    assert.ok(shut.top.some((p) => p.style === 'seam-tick'), 'never hidden');
    assert.equal(shortSeamLabel({ label: 'no arrow', year: 1929 }), 'seam 1929');
  });

  test('the seam caption is never cut by the view\'s end nor printed over a ruler label (fix pass)', () => {
    const q = QUERY.cipher_seam.body;
    const dpp = 365.25 / 2, width = 1000;
    const origin = dayFromYMD(1929, 1, 1) - (width - 60) * dpp;
    const model = buildModel({ query: q, tier: 'L2', tiles: new Map(), range: [origin, origin + width * dpp], strands: STRANDS, marks: null, strandLabels: new Map() });
    const display = buildDisplay(model, { originDay: origin, daysPerPx: dpp, width, layout: layoutLanes(model.lanes, STRANDS.length, {}), seams: q.seams });
    const cap = display.top.find((p) => p.style === 'seam-label');
    assert.equal(cap.text, 'Full text ends 1928 →');
    assert.equal(cap.w, seamLabelWidth(cap.text));
    // the seam 60 px before the visible end: painted left of its line, inside the view
    const near = seamCaptionPlace(cap, { x0: 0, x1: width });
    assert.equal(near.align, 'end');
    assert.ok(near.x0 >= 0 && near.x1 <= width, `inside the view: ${near.x0}–${near.x1}`);
    // panned so that there is room on the right: painted right of its line
    const room = seamCaptionPlace(cap, { x0: 400, x1: 400 + width });
    assert.equal(room.align, 'start');
    // the painter and the SVG drop the ruler labels under the caption, never the ticks
    const labels = display.top.filter((p) => p.style === 'ruler-label');
    assert.ok(labels.every((p) => p.w === rulerLabelWidth(p.text)));
    const under = labels.filter((p) => p.x0 < near.x1 + 4 && p.x0 + p.w > near.x0 - 4);
    assert.ok(under.length > 0, 'this frame has year labels under the caption');
    const svg = toSvg(display, { viewWidth: width });
    for (const p of under) assert.ok(!svg.includes(`>${p.text}</text>`), `${p.text} gives way in the snapshot`);
    assert.ok(svg.includes('text-anchor="end"') && svg.includes('Full text ends 1928 →'));
    assert.equal(display.top.filter((p) => p.style === 'ruler-major').length, labels.length, 'every tick is still drawn');
  });

  test('the canvas summary names runs and gaps', () => {
    const txt = describeModel(build().model);
    assert.match(txt, /Lane Classroom · text: 'carry the zero' observed 1900–1939 and 1950–1959 in 2 bars; gap 1940–1949: no sources \(synthetic\)\./);
  });
});

describe('SVG snapshot of the same display list (§7.3)', () => {
  test('one SVG element per painted primitive; text is escaped; synthetic stamp', () => {
    const { display } = build();
    const svg = toSvg(display, { title: 'a <b> & c', synthetic: true, caption: 'Scrolls · data v47 · contains SYNTHETIC data' });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes('<title>a &lt;b&gt; &amp; c</title>'));
    assert.ok(svg.includes('SYNTHETIC — invented demonstration data'));
    const painted = [...display.top, ...display.lanes].filter((p) => primToSvg(p, FALLBACK)).length;
    assert.ok(painted > 100);
    assert.equal(primToSvg({ style: 'ruler-label', x0: 0, y0: 0, x1: 0, y1: 0, text: '<script>' }, FALLBACK).includes('<script>'), false);
  });
});

test('wash labels never overprint each other, nor run past their band (fix pass, §1.4)', () => {
  // two overlapping washes in one lane, as in Life sciences: '3 · 1810–1860' and '2 · 1842–1882'
  const tiles = structuredClone(TILES.ok.body);
  const t0 = tiles.tiles[0];
  t0.washes = [
    { lane: 'community:classroom', strand: 12, lo: '1810', hi: '1860', precision: 'range', label: '1810–1860', n: 3 },
    { lane: 'community:classroom', strand: 12, lo: '1842', hi: '1882', precision: 'range', label: '1842–1882', n: 2 },
  ];
  const { display } = build({ tiles, range: [dayFromYMD(1780), dayFromYMD(1900, 12, 31)], dpp: 160 });   // both bands wide enough for a label, the labels close
  const labels = display.lanes.filter((p) => p.style === 'wash-label' && p.text && /1810|1842/.test(p.text));
  const width = (p) => Math.ceil(p.text.length * 5.8) + 4;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    if (labels[i].y0 !== labels[j].y0) continue;
    const a = labels[i], b = labels[j];
    assert.ok(a.x0 + width(a) <= b.x0 || b.x0 + width(b) <= a.x0, `'${a.text}' and '${b.text}' overlap`);
  }
  assert.ok(labels.length >= 1, 'the first wash keeps its label');
});
