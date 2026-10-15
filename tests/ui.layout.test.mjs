// OWNER: WP6 — the shell's pure rules (SPEC §8.6, §1.3, §1.7, §8.5): desktop vs narrow breakpoints, the
// bottom-sheet snaps, lane headers and their warnings, shelves, search suggestions, filters, the jobs chip,
// the ribbon and the shortcut sheet.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFor, nearestSnap, SHEET_SNAPS } from '../src/ui/shell/layout.mjs';
import { laneNotes, laneSubtitle, nextFacet, UNDATED_WARN } from '../src/ui/shell/lanes-menu.mjs';
import { suggestionAction, TYPE_BADGE } from '../src/ui/shell/search.mjs';
import { activeCount, cycleValue, TOGGLE_ROWS } from '../src/ui/shell/filters.mjs';
import { chipText } from '../src/ui/shell/jobs-chip.mjs';
import { ribbonVisible } from '../src/ui/shell/ribbon.mjs';
import { KEY_MAP } from '../src/ui/shell/help.mjs';
import { cipherOpenable } from '../src/ui/shell/toolbar.mjs';
import { shelfCounts } from '../src/ui/timeline/shelves.mjs';
import { unitScaleLines, coverageClassLabels, SWATCHES, STRIP_ROWS } from '../src/ui/timeline/legend.mjs';
import { minimapRows } from '../src/ui/timeline/minimap.mjs';
import { seedStrands } from '../src/ui/tour/tour.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { LANE_FACETS, LANE_ORDER_NOTE, TOGGLE_DEFAULTS } from '../src/shared/vocab.mjs';
import { RIBBON_TEXT } from '../src/ui/main.mjs';
import { fitPriority, popoverPosition, WIDE_MIN } from '../src/ui/shell/layout.mjs';
import { regimeName } from '../src/ui/timeline/minimap.mjs';
import { gateLine } from '../src/ui/timeline/legend.mjs';
import { LAYER_ITEMS } from '../src/ui/shell/toolbar.mjs';

describe('breakpoints (§8.6)', () => {
  test('375 px is narrow: 5 lanes, 20 px minimap, chips for shelves, bottom toolbar, sheet inspector, legend chip', () => {
    const n = layoutFor(375, 812);
    assert.deepEqual([n.mode, n.maxLanes, n.minimapH, n.shelves, n.toolbar, n.inspector, n.legend], ['narrow', 5, 20, 'chips', 'bottom', 'sheet', 'chip']);
    assert.equal(n.timelineH, Math.round(812 * 0.55), 'the timeline takes the top 55vh');
  });
  test('the breakpoint is 720 px; 1440 px is desktop with 10 lanes and a 28 px minimap', () => {
    assert.equal(layoutFor(719).mode, 'narrow');
    assert.equal(layoutFor(720).mode, 'desktop');
    const d = layoutFor(1440, 900);
    assert.deepEqual([d.mode, d.maxLanes, d.minimapH, d.headerW, d.timelineH], ['desktop', 10, 28, 168, null]);
  });
  test('the inspector sheet snaps to 30% / 60% / 92%', () => {
    assert.deepEqual(SHEET_SNAPS, [0.3, 0.6, 0.92]);
    assert.equal(nearestSnap(0.4), 0.3);
    assert.equal(nearestSnap(0.5), 0.6);
    assert.equal(nearestSnap(1), 0.92);
  });
});

describe('lane headers (§1.3, §1.7)', () => {
  const lane = { label: 'Hip-hop', header: 'Hip-hop · text · 18.4k tokens, 1980–2026', modality: 'text', unit: 'per_million_tokens', covUnit: 'tokens',
    laneCoverage: { tokens: 18400, span: [1980, 2026] }, undatedShare: 0.34, pending: false, selection: 'selected by prominence', synthetic: false };
  test('label · unit · coverage', () => {
    assert.equal(laneSubtitle(lane), 'text · 18.4k tokens, 1980–2026');
    assert.equal(laneSubtitle({ ...lane, header: null }), 'text · 18.4k tokens, 1980–2026');
  });
  test('"⚠ 34% of matches undated" from 20%, the selection note, pending and machine labels', () => {
    const notes = laneNotes(lane, 'community').map((n) => n.text);
    assert.deepEqual(notes, ['selected by prominence', '⚠ 34% of matches undated']);
    assert.equal(laneNotes({ ...lane, undatedShare: UNDATED_WARN - 0.01 }, 'community').some((n) => n.kind === 'warn'), false);
    assert.deepEqual(laneNotes({ ...lane, pending: true, selection: null, undatedShare: 0 }, 'cluster').map((n) => n.text), ['indexing — not yet looked', 'machine label (editable)']);
  });
  test('L cycles through every facet (cluster only for one pinned expression; the Term trail only through its preset)', () => {
    let f = 'domain';
    const seen = new Set();
    for (let i = 0; i < LANE_FACETS.length; i++) { seen.add(f); f = nextFacet(f, false); }
    assert.ok(!seen.has('cluster'));
    assert.ok(!seen.has('trail'), 'the trail spans every real corpus: never reached by cycling the facet');
    assert.equal(seen.size, LANE_FACETS.filter((x) => x !== 'cluster' && x !== 'trail').length);
    assert.equal(nextFacet('modality', true), 'cluster');
  });
  test('the lane-order note is the spec’s sentence', () => {
    assert.equal(LANE_ORDER_NOTE, 'Lane order is a sorting choice (first observed), not a scale of meaning.');
  });
});

describe('shelves, legend, minimap', () => {
  test('per-lane shelf counts', () => {
    const m = { lanes: [{ key: 'a', label: 'A', undated: 1, scheduled: 0 }, { key: 'b', label: 'B', undated: 0, scheduled: 2 }] };
    assert.deepEqual(shelfCounts(m, 'undated').map((x) => x.n), [1, 0]);
    assert.deepEqual(shelfCounts(m, 'scheduled').map((x) => x.n), [0, 2]);
    assert.deepEqual(shelfCounts(null, 'undated'), []);
  });
  test('the legend prints one height scale per unit and the coverage step classes', () => {
    assert.deepEqual(unitScaleLines({ per_million_tokens: { unit: 'per_million_tokens', max: 84 } }), ['height: per million tokens · full = 84/M tokens']);
    assert.deepEqual(coverageClassLabels('tokens'), ['0', '<10k', '<100k', '<1M', '≥1M']);
    assert.deepEqual(coverageClassLabels('works'), ['0', '<10', '<100', '<1k', '≥1k']);
    for (const [key] of STRIP_ROWS) assert.ok(SWATCHES[key], `swatch ${key}`);
  });
  test('minimap rows: one 3 px row per lane, folded when they do not fit', () => {
    assert.deepEqual(minimapRows(5, 28), { rows: 5, rowH: 3, top: 9 });
    assert.equal(minimapRows(10, 20).rows, 3);
  });
});

describe('search, filters, jobs, ribbon, tour', () => {
  test('typed suggestions: expressions and themes pin, works open, the etymology note is information only', () => {
    assert.deepEqual(suggestionAction({ type: 'expression', ref: 'expression:12' }), { kind: 'pin', strand: { type: 'expression', id: 12 } });
    assert.deepEqual(suggestionAction({ type: 'expression', ref: 'expression:new' }), { kind: 'track' });
    assert.deepEqual(suggestionAction({ type: 'work', ref: 'document:44' }), { kind: 'select', selection: { type: 'document', id: 44 } });
    assert.deepEqual(suggestionAction({ type: 'maker', ref: 'maker:mc-ledgerline' }), { kind: 'pin', strand: { type: 'maker', id: 'mc-ledgerline' } });
    assert.deepEqual(suggestionAction({ type: 'theme', ref: 'theme:hip hop' }), { kind: 'pin', strand: { type: 'theme', id: 'hip hop' } });
    assert.deepEqual(suggestionAction({ type: 'etymology', ref: 'etymon:none' }), { kind: 'info' });
    assert.deepEqual(suggestionAction({ type: 'adapter', ref: 'adapters' }), { kind: 'panel', panel: 'adapters' });
    assert.equal(TYPE_BADGE.expression, 'EXPR');
  });
  test('filters: include → exclude → off, and the active count includes changed default exclusions', () => {
    assert.deepEqual(cycleValue([], 'estimated'), ['estimated']);
    assert.deepEqual(cycleValue(['estimated'], 'estimated'), ['-estimated']);
    assert.deepEqual(cycleValue(['-estimated'], 'estimated'), []);
    const v = defaultState('demo');
    assert.equal(activeCount(v), 0);
    assert.equal(activeCount({ ...v, f: { ...v.f, lang: ['en'] }, toggles: { ...v.toggles, tr: 1 } }), 2);
    assert.deepEqual(TOGGLE_ROWS.map((r) => r.key), Object.keys(TOGGLE_DEFAULTS), 'every default exclusion is shown');
  });
  test('the jobs chip always carries a number while the bootstrap runs', () => {
    assert.deepEqual(chipText({ status: 'metadata', progress: 0.12 }), { text: 'Cipher: importing titles & relations · 12%', kind: 'busy', title: '', short: '12%' });
    assert.equal(chipText({ status: 'ready' }).short, 'ready', 'the short form (tight toolbars, phones) still says something');
    assert.equal(chipText({ status: 'fulltext', progress: 0.21, message: 'full text 312 / 1,516 books' }).text, 'Cipher: full text 312 / 1,516 books · 21%');
    assert.equal(chipText({ status: 'ready' }).kind, 'ok');
    assert.equal(chipText(null, [{ type: 'materialize', status: 'running', progress: 0.41 }]).text, 'materialize 41%');
    assert.equal(chipText(null, []).text, '');
    assert.equal(cipherOpenable({ cipher: { status: 'metadata' } }), false);
    assert.equal(cipherOpenable({ cipher: { status: 'fulltext' } }), true);
  });
  test('the SYNTHETIC ribbon shows for the demo or any synthetic query, with §1.11’s words', () => {
    assert.equal(ribbonVisible('demo', null), true);
    assert.equal(ribbonVisible('cipher', { provenance: { synthetic: false } }), false);
    assert.equal(ribbonVisible('user', { provenance: { synthetic: true } }), true);
    assert.equal(RIBBON_TEXT, 'SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.');
  });
  test('the first demo strand comes from the tour’s step 1 state, never a hard-coded id', () => {
    const tour = { steps: [{ n: 1, state: '#v=1&c=demo&s=e12' }] };
    assert.deepEqual(seedStrands(tour, defaultState('demo')), [{ type: 'expression', id: 12 }]);
    assert.deepEqual(seedStrands(tour, { ...defaultState('demo'), strands: [{ type: 'expression', id: 3 }] }), []);
    assert.deepEqual(seedStrands(tour, defaultState('cipher')), []);
    assert.deepEqual(seedStrands(null, defaultState('demo')), []);
  });
  test('the shortcut sheet lists every key of §8.5', () => {
    const keys = KEY_MAP.map(([k]) => k).join(' ');
    for (const k of ['/', 'Space', '[', '{', '←', '↑', '+', '0', '1 – 6', 'D', 'Home', 'Tab', 'Enter', 'Esc', 'L', 'E', 'V', 'R', 'T', 'P', 'A / B', 'C', 'G', 'K', 'N', 'S', 'X', '?']) {
      assert.ok(keys.includes(k), k);
    }
  });
});


describe('QA pass: toolbar, popovers, phone layout', () => {
  test('priority+: the lowest priorities give way first, and only as many as needed', () => {
    const shown = new Set(['a', 'b', 'c', 'd']);
    const prio = { a: 10, b: 40, c: 20, d: 30 };
    const width = { a: 50, b: 50, c: 50, d: 50 };
    const items = Object.keys(prio).map((k) => ({ prio: prio[k], hide: () => shown.delete(k), show: () => shown.add(k) }));
    const used = () => [...shown].reduce((s, k) => s + width[k], 0);
    assert.equal(fitPriority(items, () => used() > 120), 2);
    assert.deepEqual([...shown].sort(), ['b', 'd'], 'a (10) and c (20) went into More');
    assert.equal(fitPriority(items, () => used() > 400), 0, 'room again: everything comes back');
  });

  test('a floating popover stays on screen, below its anchor when there is room, above it otherwise', () => {
    const vp = { width: 375, height: 812 };
    const below = popoverPosition({ left: 300, right: 360, top: 40, bottom: 70, width: 60 }, { width: 300, height: 400 }, vp, { align: 'end' });
    assert.deepEqual([below.left, below.top], [60, 76]);
    const above = popoverPosition({ left: 300, right: 360, top: 768, bottom: 812, width: 60 }, { width: 300, height: 400 }, vp, { align: 'end' });
    assert.ok(above.top + 400 <= 768 && above.top >= 8, 'opens above the bottom bar');
    const clamp = popoverPosition({ left: -40, right: 10, top: 10, bottom: 30, width: 50 }, { width: 200, height: 100 }, vp);
    assert.equal(clamp.left, 8);
  });

  test('phones get a ≤ 88 px lane rail; the inspector docks right from 1280 px', () => {
    assert.ok(layoutFor(375, 812).headerW <= 88);
    assert.equal(WIDE_MIN, 1280);
    assert.equal(layoutFor(1440, 900).inspectorSide, 'right');
    assert.equal(layoutFor(1024, 768).inspectorSide, 'bottom');
  });

  test('minimap regime names shorten instead of being cut', () => {
    const measure = (t) => t.length * 5;
    assert.equal(regimeName('classical', 200, measure), 'Classical–medieval');
    assert.equal(regimeName('classical', 50, measure), 'Classical');
    assert.equal(regimeName('classical', 31, measure), 'Class.');
    assert.equal(regimeName('classical', 10, measure), '');
  });

  test('the legend keeps the demo gate note; the More menu switches every layer of §8.2', () => {
    assert.equal(gateLine({ coverage_gate: { tokens: 2000, works: null }, note: 'demo setting; real collections use 50,000 tokens' }),
      'rates from 2,000 tokens per bin (demo setting; real collections use 50,000 tokens)');
    assert.deepEqual(LAYER_ITEMS.map(([k]) => k), ['arcs', 'feedback', 'washes', 'coverage', 'etymology', 'claims', 'baseline']);
  });
});
