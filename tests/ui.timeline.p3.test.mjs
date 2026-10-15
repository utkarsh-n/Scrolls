// OWNER: WP6 — the Scroll for contract 1.3.0 (SPEC §1.3, §1.7, §1.8, §1.11, §10.4, §10.5): context-group lanes and
// their not-run / gated cards and transition glyphs (C1); the Term trail preset over the virtual corpus 'real' (C2);
// OpenAlex within-cell share boxes that never join into a trend (C3); the arc summary's ribbons, chip and detail
// window (C4); each etymology root drawn once, with labels that never overlap or cross a seam (C5); coach marks that
// never cover an open panel; the end-of-play repaint. Fixtures are shaped exactly as the contract text says.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { arcsWindow, dominantStatus, ribbonSeries, selParam, summaryChip, summaryRibbons, DETAIL_YEARS } from '../src/ui/timeline/arc-summary.mjs';
import { buildArcs, midYearDay } from '../src/ui/timeline/arcs.mjs';
import { buildTransitions, canClusterLanes, clusterJobLine, clusterLaneState, clusterRunOf, laneLabelOf, parseClusterLaneKey, renderClusterCard,
  RUN_EXPLAINER, SPLIT_CAVEAT, transitionTip } from '../src/ui/timeline/clusters.mjs';
import { byText, installFakeDom, visibleText } from './ui.panels.fakedom.mjs';
import { etymLayout, etymPrims, etymRowHeight, NO_FAMILY, parseHref } from '../src/ui/timeline/deeptime.mjs';
import { buildDisplay, layoutLanes } from '../src/ui/timeline/display.mjs';
import { cellLine } from '../src/ui/timeline/drawer.mjs';
import { buildHitGrid } from '../src/ui/timeline/hit.mjs';
import { buildModel, TRAIL_ETYMOLOGY } from '../src/ui/timeline/model.mjs';
import { fitText, stickyPlace } from '../src/ui/timeline/paint.mjs';
import { shareCellsOfTile, shareColumns, sharePrims, shareTableRows, shareTooltip, SHARE_NOTE, SHARE_STATE } from '../src/ui/timeline/share-cells.mjs';
import { primToSvg } from '../src/ui/timeline/svg.mjs';
import { createTilesClient } from '../src/ui/timeline/tiles-client.mjs';
import { bulkExtentDays, escapeStep, extraRows, laneCap } from '../src/ui/timeline/viewport.mjs';
import { tableModel } from '../src/ui/timeline/a11y-table.mjs';
import { facetOptions, laneNotes } from '../src/ui/shell/lanes-menu.mjs';
import { applyTermTrail, realStrands, REAL_CORPUS, trackInReal, TRAIL_CHIP, trailSeed, trailState } from '../src/ui/shell/presets.mjs';
import { coachPlacement } from '../src/ui/tour/coachmarks.mjs';

const RANGE = [dayFromYMD(1880), dayFromYMD(2040, 12, 31)];
const DPP = 30;
const X = (day) => (day - RANGE[0]) / DPP;
const STRANDS = [{ type: 'expression', id: 8, glyph: 'circle' }];
const lane = (key, extra = {}) => ({ key, label: key, unit: 'per_million_tokens', modality: 'text', order_rule: 'first_observed',
  coverage: { tokens: 1e6, docs: 10, span: [1880, 2026] }, n: 10, docs: 3, first: null, last: null, undated: 0, scheduled: 0, undated_share: 0,
  censor: { left: false, right: false }, synthetic: false, ...extra });
const fakeCtx = { measureText: (t) => ({ width: t.length * 6 }) };

// ── C1: context-group lanes ─────────────────────────────────────────────────────────────────────────
describe('context-group lanes (C1, §1.3, §1.8)', () => {
  test('lane keys cluster:<run>:<ord> and cluster:<run>:residual, with ~titles sub-lanes; labels {machine, human}', () => {
    assert.deepEqual(parseClusterLaneKey('cluster:24:3'), { run: 24, group: 3, residual: false, unitClass: 'text' });
    assert.deepEqual(parseClusterLaneKey('cluster:24:residual'), { run: 24, group: null, residual: true, unitClass: 'text' });
    assert.equal(parseClusterLaneKey('cluster:24:3~titles').unitClass, 'titles');
    assert.equal(parseClusterLaneKey('language:en'), null);
    assert.deepEqual(laneLabelOf({ machine: 'machine label: hold · mic · verse · block', human: null }),
      { text: 'hold · mic · verse · block', machine: 'hold · mic · verse · block', human: null });
    assert.equal(laneLabelOf({ machine: 'hold · mic', human: 'honoring the uncounted' }).text, 'honoring the uncounted', 'the human label reads first');
    assert.equal(laneLabelOf({ machine: 'hold · mic', human: 'honoring the uncounted' }).machine, 'hold · mic', 'the machine label stays (§13 rule 10)');
    assert.equal(laneLabelOf('Classroom').text, 'Classroom');
  });

  test('the menu offers context groups only for exactly one pinned expression', () => {
    assert.equal(canClusterLanes([{ type: 'expression', id: 1 }]), true);
    assert.equal(canClusterLanes([{ type: 'expression', id: 1 }, { type: 'expression', id: 2 }]), false);
    assert.equal(canClusterLanes([{ type: 'theme', id: 'hip hop' }]), false);
    const one = facetOptions({ ...defaultState('demo'), strands: [{ type: 'expression', id: 1 }] }).find((o) => o.value === 'cluster');
    const two = facetOptions({ ...defaultState('demo'), strands: [{ type: 'expression', id: 1 }, { type: 'expression', id: 2 }] }).find((o) => o.value === 'cluster');
    assert.equal(one.label, 'Context groups');
    assert.equal(one.disabled, false);
    assert.equal(two.disabled, true);
    assert.match(two.title, /exactly one pinned expression/);
  });

  test('not run → the run to start (suggestion.run); gated → the gate, never a value; lanes → drawn', () => {
    const notRun = { lanes: [], lane_state: 'not_run', suggestion: { run: { stage: 'cluster', params: { expressionId: 1 } } } };
    assert.deepEqual(clusterLaneState(notRun, 'cluster'), { kind: 'not_run', run: { stage: 'cluster', params: { expressionId: 1 } }, note: null });
    const gate = { gate: 'no_cluster_structure', value: null, needed: { silhouette: 0.1 }, have: { occurrences: 2924 }, suggestion: null };
    const gated = clusterLaneState({ lanes: [], lane_state: 'gated', gate }, 'cluster');
    assert.equal(gated.kind, 'gated');
    assert.equal(gated.gate, gate);
    assert.equal(clusterLaneState({ lanes: [lane('cluster:24:1')] }, 'cluster').kind, 'lanes');
    assert.equal(clusterLaneState(notRun, 'language').kind, 'none', 'other facets never show the card');
    assert.equal(clusterRunOf({ lanes: [lane('cluster:24:1'), lane('cluster:24:residual')] }), 24);
    assert.equal(clusterRunOf({ lanes: [] }, 19), 19, 'a pinned run wins');
    assert.match(clusterJobLine({ status: 'running', progress: 0.41, message: 'counting contexts' }), /^clustering… 41% · counting contexts$/);
    assert.match(clusterJobLine({ status: 'failed', error: { message: 'boom' } }), /failed: boom/);
  });

  test('the cards: not run offers the server’s run and follows its job; gated shows the gate and never a value', () => {
    const dom = installFakeDom();
    try {
      let ran = 0, back = 0;
      const notRun = renderClusterCard({ kind: 'not_run', run: { stage: 'cluster', params: { expressionId: 3 } }, note: 'No clustering run exists for this expression yet.' },
        { label: 'ghost in the margin', onRun: () => { ran++; }, onBack: () => { back++; } });
      const t = visibleText(notRun);
      assert.match(t, /Context groups of 'ghost in the margin' need a clustering run/);
      assert.ok(t.includes('No clustering run exists for this expression yet.') && t.includes(RUN_EXPLAINER));
      byText(notRun, 'Run clustering').click();
      byText(notRun, 'Lanes by language').click();
      assert.deepEqual([ran, back], [1, 1]);
      const running = renderClusterCard({ kind: 'not_run', run: { stage: 'cluster' } }, { label: 'x', started: true, job: { status: 'running', progress: 0.05, message: '94 usable contexts of 94' }, onRun() {}, onBack() {} });
      assert.equal(byText(running, 'Clustering…').disabled, true);
      assert.match(visibleText(running), /clustering… 5% · 94 usable contexts of 94/);
      const gated = renderClusterCard({ kind: 'gated', gate: { gate: 'no_cluster_structure', value: null, needed: { silhouette: 0.1 }, have: { best_silhouette: 'below 0.10' }, suggestion: null } },
        { label: 'war', onRun() {}, onBack() {} });
      const g = visibleText(gated);
      assert.match(g, /No context groups for 'war'/);
      // the gate in words in the header; its code only in the card's details line (fix pass)
      assert.equal(gated.querySelector('.gate-code').textContent, 'no stable context groups');
      assert.match(g, /Gate\s*no_cluster_structure/);
      assert.ok(!byText(gated, 'Run clustering'), 'no run to offer without a suggestion');
    } finally { dom.restore(); }
  });

  test('model: one lane per group plus the residual; human labels with the machine label kept; cluster ids for renaming', () => {
    const query = { lanes: [lane('cluster:24:1', { label: { machine: 'machine label: lesson · write', human: null }, cluster_id: 101, ord: 1 }),
      lane('cluster:24:3', { label: { machine: 'hold · mic · verse', human: 'honoring the uncounted' }, cluster_id: 103, ord: 3 }),
      lane('cluster:24:residual', { label: { machine: 'other contexts', human: null }, cluster_id: null, ord: null })] };
    const model = buildModel({ query, tier: 'L2', tiles: new Map(), range: RANGE, strands: STRANDS });
    assert.deepEqual(model.lanes.map((l) => l.label), ['lesson · write', 'honoring the uncounted', 'other contexts']);
    assert.equal(model.lanes[1].machineLabel, 'hold · mic · verse');
    assert.equal(model.lanes[1].clusterId, 103);
    assert.equal(model.lanes[2].residual, true);
    const notes = laneNotes(model.lanes[1], 'cluster').map((n) => n.text);
    assert.deepEqual(notes, ['machine label: hold · mic · verse']);
    assert.deepEqual(laneNotes(model.lanes[0], 'cluster').map((n) => n.text), ['machine label (editable)']);
  });

  test('transitions: ⑂ split / ⑃ merge between group lanes (matched by ord), emergence and fading as dashed ticks, all computed', () => {
    const lanes = [lane('cluster:24:1'), lane('cluster:24:2'), lane('cluster:24:3')];
    const layout = layoutLanes(lanes, 1);
    const model = buildModel({ query: { lanes }, tier: 'L2', tiles: new Map(), range: RANGE, strands: STRANDS });
    const clusters = { run: 24, k: 3, representation: 'tfidf-hash-4096', clusters: [{ id: 501, ord: 1, stability: 0.97, machine_label: 'machine label: a · b' },
      { id: 502, ord: 2, stability: 0.81, machine_label: 'machine label: c · d' }, { id: 503, ord: 3, stability: 0.9, machine_label: 'machine label: e · f' }],
    transitions: [
      { kind: 'split', from: 501, to: 502, from_ord: 1, to_ord: 2, year: 1955, cosine: 0.58, text: "Context group 2 'c · d' emerges 1955. Nearest earlier group: 1 (centroid cosine 0.58)." },
      { kind: 'merge', from: 502, to: 503, from_ord: 2, to_ord: 3, year: 1994 },
      { kind: 'emerge', from: null, to: 503, from_ord: null, to_ord: 3, year: 1990, text: "Context group 3 'e · f' emerges in 1990–2009 (first observed 1994)." },
      { kind: 'vanish', from: 501, to: null, from_ord: 1, to_ord: null, year: 1970 },
      { kind: 'unknown_gap', from: 501, to: null, year: 1940 }] };
    const prims = buildTransitions(clusters, { layout, X, lanes: model.lanes });
    const split = prims.find((p) => p.style === 'split-curve' && p.id.startsWith('split:0'));
    assert.equal(split.points[0][1], layout.lanes[0].slots[0].mid, 'from the parent group (ord 1)');
    assert.equal(split.points[3][1], layout.lanes[1].slots[0].mid, 'into the child (ord 2)');
    assert.ok(Math.abs(split.points[3][0] - X(midYearDay(1955))) < 1e-9, 'at its date, mid-year');
    assert.ok(split.tip.includes(SPLIT_CAVEAT), 'the §1.8 caveat');
    assert.ok(split.tip.some((t) => /Run #24, k=3, stability 0.81, representation tfidf-hash-4096/.test(t)));
    assert.deepEqual(prims.filter((p) => p.style === 'split-glyph').map((p) => p.text), ['⑂', '⑃']);
    assert.ok(prims.find((p) => p.style === 'split-curve' && p.id.startsWith('split:1')).tip.some((t) => /merge in usage contexts, not a claim about speakers/.test(t)));
    assert.equal(prims.filter((p) => p.style === 'transition-emerge').length, 1);
    assert.equal(prims.filter((p) => p.style === 'transition-vanish').length, 1);
    assert.ok(prims.every((p) => p.style === 'split-glyph' || p.tip.some((t) => /not a claim about speakers/.test(t))), 'every transition says it is computed');
    assert.equal(prims.filter((p) => p.id.includes('unknown')).length, 0, 'an unknown gap draws nothing (the hatch says it)');
    const strict = buildTransitions(clusters, { layout, X, lanes: model.lanes, vantage: { day: dayFromYMD(1960, 12, 31), strict: true } });
    assert.deepEqual(strict.filter((p) => p.style === 'split-glyph').map((p) => p.text), ['⑂'], 'a later merge waits for the vantage');
    assert.match(transitionTip({ kind: 'split', from: 1, to: 2, to_ord: 2, year: 1955, cosine: 0.58, nearest: { cluster: 1, cosine: 0.58 } }, clusters)[0],
      /^Context group 2 .* emerges 1955\. Nearest earlier group: 1/);
  });
});

// ── C3: OpenAlex share cells ────────────────────────────────────────────────────────────────────────
describe('OpenAlex within-cell share boxes (C3, D14, §10.4)', () => {
  const cells = [
    { lo_year: 1875, hi_year: 1899, k: 3, n: 14, share: 0.21, ci: [0.07, 0.48], state: 'low' },
    { lo_year: 1900, hi_year: 1904, k: 0, n: 200, share: 0, ci: [0, 0.019], state: 'absent' },
    { lo_year: 1905, hi_year: 1909, k: 12, n: 200, share: 0.06, ci: [0.035, 0.102], state: 'observed' },
    { lo_year: 1910, hi_year: 1914, k: 30, n: 200, share: 0.15, ci: [0.107, 0.206], state: 'observed' },
  ];
  const shareLane = lane('trail:stemm-abstracts:medicine-health', { unit: 'share_of_sampled_works', modality: 'abstracts', label: 'Medicine & health · OpenAlex top-cited sample' });
  // Cells come on OpenAlex's own 30 bins at every tier; a cell overlapping two tiles is listed in both.
  const tiles = new Map([[29, { tile: 29, bin0: 29 * 64, lanes: { [shareLane.key]: { strands: { 8: cells.slice(0, 3) } } }, coverage: {}, washes: [] }],
    [30, { tile: 30, bin0: 30 * 64, lanes: { [shareLane.key]: { strands: { 8: cells.slice(2) } } }, coverage: {}, washes: [] }]]);
  const model = buildModel({ query: { lanes: [shareLane] }, tier: 'L3', tiles, range: [dayFromYMD(1870), dayFromYMD(1930, 12, 31)], strands: STRANDS });
  const strand = model.lanes[0].strands[0];

  test('cells are deduplicated, typed, and a low cell (n < 20) has no share even when the payload carries one', () => {
    assert.equal(strand.share.length, 4);
    assert.deepEqual([...strand.share.loYear], [1875, 1900, 1905, 1910]);
    assert.equal(strand.share.state[0], SHARE_STATE.low);
    assert.ok(Number.isNaN(strand.share.share[0]) && Number.isNaN(strand.share.ciLo[0]), 'gated: no value (§13 rule 7)');
    assert.equal(strand.share.share[2], 0.06);
    assert.deepEqual(strand.bars, [], 'never a bar');
    assert.ok(model.lanes[0].share);
    assert.equal(model.units.share_of_sampled_works.max, 0.206, 'one height scale: the largest upper bound');
    assert.deepEqual(model.lanes[0].uncovered.map((r) => [r[2], r[3]]), [[1870, 1874], [1915, 1930]], 'only the years no cell covers are "no sources"');
  });

  test('boxes span each cell, never touch or join; CI whiskers; low cells hollow with "n < 20"; absent is a dotted floor', () => {
    const layout = layoutLanes(model.lanes, 1);
    const Xc = (d) => (d - dayFromYMD(1870)) / 10;
    const prims = sharePrims(model.lanes[0], strand, { slot: layout.lanes[0].slots[0], X: Xc, max: 0.206, tier: 'L3', gate: (p) => p });
    assert.deepEqual(prims.map((p) => p.style), ['share-low', 'share-absent', 'share-box', 'share-box']);
    for (let i = 1; i < prims.length; i++) assert.ok(prims[i].x0 - prims[i - 1].x1 >= 4 - 1e-9, 'a clear gap between neighbouring cells: no line, no trend');
    const [a, b] = [Xc(dayFromYMD(1905, 1, 1)), Xc(dayFromYMD(1909, 12, 31) + 1)];
    assert.ok(prims[2].x0 > a && prims[2].x0 <= a + 4 && prims[2].x1 < b && prims[2].x1 >= b - 4, 'within lo_year..hi_year');
    assert.ok(prims[3].y0 < prims[2].y0, 'a larger share is a taller box (within the lane scale)');
    assert.ok(Array.isArray(prims[2].whisker) && prims[2].whisker[1] < prims[2].whisker[0], 'the Wilson interval as a whisker');
    assert.equal(prims[0].whisker, undefined);
    assert.match(prims[0].tip[1], /3 of 14 sampled works .* n < 20/);
    assert.ok(prims.every((p) => p.tip.some((t) => /not a trend/.test(t))));
    assert.match(prims[2].tip[1], /12 of 200 sampled works mention it · 6% \[3\.5%, 10\.2%\] \(Wilson 95%\)/);
    assert.equal(prims[2].ref.type, 'cell');
    assert.ok(prims.every((p) => p.openable), 'every box opens its passages (≤ 2 clicks)');
    const wide = sharePrims(model.lanes[0], strand, { slot: layout.lanes[0].slots[0], X: (d) => (d - dayFromYMD(1870)) / 0.5, max: 0.2, tier: 'L3', gate: (p) => p });
    assert.equal(wide[0].label, 'n < 20');
  });

  test('display: the share lane draws boxes, no bars; the hit grid opens them; the table reads the same columns', () => {
    const layout = layoutLanes(model.lanes, 1);
    const d = buildDisplay(model, { originDay: dayFromYMD(1870), daysPerPx: 10, width: 2200, layout });
    assert.ok(d.lanes.some((p) => p.style === 'share-box'));
    assert.ok(!d.lanes.some((p) => p.style === 'bar' || p.style === 'bar-sparse'));
    const grid = buildHitGrid(d.lanes);
    const box = d.lanes.find((p) => p.style === 'share-box');
    assert.equal(grid.query((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, 2)?.ref?.type, 'cell');
    const t = tableModel(model)[0];
    assert.equal(t.source, strand.share, 'identity: the table reads the painter’s columns');
    assert.equal(t.unit, SHARE_NOTE);
    assert.deepEqual(shareTableRows(strand)[0], { bin: '1875–1899', n: '3 of 14', rate: '—', ci: '—', coverage: '14 sampled works', state: 'n < 20: no share', flags: 'within-cell share, not a trend' });
    assert.match(cellLine({ k: 12, n: 200, from: 1905, to: 1909 }), /^12 of 200 sampled works in 1905–1909 mention it · .*not a trend$/);
    assert.equal(SHARE_NOTE, 'share of the top-cited sample in each cell — not a trend');
    assert.match(shareTooltip(model.lanes[0], strand, strand.share, 1)[1], /^0 of 200 sampled works — looked, found none/);
  });

  test('share lanes carry the header note and never join the marks override', () => {
    assert.ok(laneNotes(model.lanes[0], 'trail').some((n) => n.kind === 'share' && n.text === SHARE_NOTE));
    const marks = { fromDay: RANGE[0], toDay: RANGE[1], items: [{ occ: 1, passage: 2, doc: 3, lane: shareLane.key, strand: 8, lo_day: dayFromYMD(1906), hi_day: dayFromYMD(1906, 12, 31), precision: 'year', basis: 'stated', kind: 'abstract' }], truncated: false, total: 1 };
    const m2 = buildModel({ query: { lanes: [shareLane] }, tier: 'L3', tiles, range: [dayFromYMD(1870), dayFromYMD(1930, 12, 31)], strands: STRANDS, marks });
    assert.equal(m2.override, false);
    assert.equal(m2.lanes[0].strands[0].marks, null);
  });

  test('the contract places cells at tile.cells[lane][strand] (with `owner` per tile): read and deduplicated', () => {
    const t1 = { tile: 29, lanes: {}, cells: { [shareLane.key]: { 8: [{ ...cells[2], owner: true }, { ...cells[3], owner: false }] } } };
    const t2 = { tile: 30, lanes: {}, cells: { [shareLane.key]: { 8: [{ ...cells[3], owner: true }] } } };
    const got = [t1, t2].flatMap((t) => shareCellsOfTile(t).get(shareLane.key)?.get('8') ?? []);
    assert.equal(got.length, 3);
    assert.equal(shareColumns(got).length, 2, 'one box per cell');
    const uncovered = shareColumns([{ lo_year: 1665, hi_year: 1799, k: 0, n: 0, share: null, ci: null, state: 'uncovered', n_cell: 200 }]);
    assert.equal(uncovered.state[0], SHARE_STATE.uncovered);
    const withCell = shareColumns([{ ...cells[2], n_cell: 200, n: 150 }]);
    assert.match(shareTooltip(model.lanes[0], strand, withCell, 0)[1], /200 works sampled in this cell; 150 in the strand’s languages/);
  });

  test('svg serialises the boxes', () => {
    const svg = primToSvg({ style: 'share-box', kind: 'rect', x0: 0, x1: 10, y0: 2, y1: 20, whisker: [1, 12] }, { ink: '#EDE6D6', 'ink-2': '#BDB5A5', 'ink-3': '#8E887B', 'font-ui': 'x' });
    assert.match(svg, /<rect .*<line /);
  });
});

// ── C4: arc summary ─────────────────────────────────────────────────────────────────────────────────
describe('arc summary (C4, §1.8)', () => {
  const lanes = [lane('field:life-sciences'), lane('field:medicine-health'), lane('field:computing')];
  const layout = layoutLanes(lanes, 1, { fillH: 600 });
  const model = buildModel({ query: { lanes }, tier: 'L2', tiles: new Map(), range: RANGE, strands: STRANDS });
  const summary = {
    mode: 'summary', total: 21490, tier: 'L2',
    buckets: [
      { src_lane: 'field:medicine-health', dst_lane: 'field:medicine-health', src_bin: 199, dst_bin: 198, n: 1203, by_status: { documented: 1203, computed: 0, proposed: 0 } },
      { src_lane: 'field:medicine-health', dst_lane: 'field:medicine-health', src_bin: 200, dst_bin: 199, n: 3, by_status: { documented: 3, computed: 0, proposed: 0 } },
      { src_lane: 'field:life-sciences', dst_lane: 'field:medicine-health', src_bin: 199, dst_bin: 201, n: 40, by_status: { documented: 10, computed: 30, proposed: 0 } },
      { src_lane: 'field:nowhere', dst_lane: 'field:computing', src_bin: 199, dst_bin: 200, n: 7, by_status: { documented: 7, computed: 0, proposed: 0 } },
    ],
    individual: [{ rel_id: 9001, rel_type: 'explicit_citation', family: 'citation', evidence_status: 'documented', src: { passage: 1, doc: 11, y: 1995, lane: 'field:medicine-health' },
      dst: { passage: 2, doc: 12, y: 1987, lane: 'field:medicine-health' }, feedback: false, synthetic: false },
    { rel_id: 9002, rel_type: 'explicit_citation', family: 'citation', evidence_status: 'documented', src: { passage: 3, doc: 13, y: 2001, lane: 'field:life-sciences' },
      dst: { passage: 4, doc: 14, y: 1999, lane: 'field:medicine-health' }, feedback: false, synthetic: false }],
  };

  test('the chip says what was summarised and how to see more', () => {
    assert.equal(summaryChip(summary), '21,490 citation links — summarised; zoom in for detail');
    assert.equal(summaryChip({ ...summary, individual: [...summary.individual, { family: 'quotation' }] }), '21,490 links — summarised; zoom in for detail');
    assert.equal(summaryChip({ mode: 'individual', items: [] }), '');
  });

  test('below 50 visible years: detail=1 over a window narrower than 50 years; above: the built range, no detail', () => {
    const narrow = arcsWindow({ loDay: dayFromYMD(1990), hiDay: dayFromYMD(2009, 12, 31) }, [dayFromYMD(1970), dayFromYMD(2030)]);
    assert.equal(narrow.detail, 1);
    assert.ok(narrow.toYear - narrow.fromYear + 1 < DETAIL_YEARS, 'a range narrower than 50 years');
    assert.ok(narrow.fromYear <= 1990 && narrow.toYear >= 2009, 'covers the view');
    const wide = arcsWindow({ loDay: dayFromYMD(1900), hiDay: dayFromYMD(2000) }, [dayFromYMD(1800), dayFromYMD(2100)]);
    assert.deepEqual(wide, { fromYear: 1800, toYear: 2100, detail: 0 });
  });

  test('ribbons per lane pair in the lane of the later end; thickness ∝ log2(n+1); pattern by the dominant status', () => {
    const series = ribbonSeries(summary.buckets);
    assert.deepEqual(series.map((p) => `${p.other}→${p.host}`), ['field:medicine-health→field:medicine-health', 'field:life-sciences→field:medicine-health', 'field:nowhere→field:computing']);
    assert.equal(series[1].bins.get(201).n, 40, 'keyed by the later bin');
    assert.equal(dominantStatus({ documented: 10, computed: 30, proposed: 0 }), 'computed');
    assert.equal(dominantStatus({ documented: 5, computed: 5 }), 'documented', 'ties go to the stronger status');
    const { prims, stats } = summaryRibbons(summary, { layout, X, tier: 'L2' });
    assert.equal(stats.offLane, 7, 'a pair with a lane not shown is counted, not drawn');
    const big = prims.find((p) => p.id === 'rib:field:medicine-health:field:medicine-health:198'.replace(':198', ':199'));
    const small = prims.find((p) => p.id.endsWith('field:medicine-health:200'));
    assert.ok(big && small);
    const t = (p) => p.y1 - p.y0;
    assert.ok(Math.abs(t(big) / t(small) - Math.min(9, Math.log2(1204)) / Math.log2(4)) < 0.01, 'thickness ∝ log2(n + 1) (capped)');
    assert.equal(prims.find((p) => p.id.endsWith('field:life-sciences:201')).status, 'computed');
    const lay = layout.lanes.find((l) => l.key === 'field:medicine-health');
    assert.ok(prims.every((p) => p.y0 >= lay.y && p.y1 <= lay.slots[0].y + lay.slots[0].h * 0.35 + 1e-9), 'in the arc zone: the lane top and the top third of the strand slot');
    assert.ok(prims.every((p) => p.tip.some((s) => /not a rate, and not evidence that one lane influenced another/.test(s))));
    const strict = summaryRibbons(summary, { layout, X, tier: 'L2', vantage: { day: dayFromYMD(1995, 12, 31), strict: true } });
    assert.ok(strict.prims.every((p) => p.ref.hiDay <= dayFromYMD(1995, 12, 31)), 'the vantage hides later bins');
  });

  test('buildArcs: ribbons under at most the individual arcs, drawn quieter unless they touch the selection; no bundles', () => {
    const { prims, stats } = buildArcs({ ...summary, bundles: [{ lanes: ['field:life-sciences', 'field:medicine-health'], bins: [199, 200], count: 5, tier: 'L2' }] },
      { layout, X, model, selection: { type: 'passage', id: 3 } });
    assert.ok(prims.some((p) => p.style === 'arc-ribbon'));
    assert.ok(!prims.some((p) => p.style === 'arc-bundle'));
    const arcs = prims.filter((p) => p.style === 'arc');
    assert.equal(arcs.length, 2);
    assert.equal(arcs.find((p) => p.ref.id === 9001).quiet, true);
    assert.equal(arcs.find((p) => p.ref.id === 9002).quiet, false, 'it touches the selected passage');
    assert.ok(prims.findIndex((p) => p.style === 'arc-ribbon') < prims.findIndex((p) => p.style === 'arc'), 'ribbons first: arcs on top');
    assert.equal(stats.chip, '21,490 citation links — summarised; zoom in for detail');
    assert.equal(stats.summarised, 21490);
  });

  test('the server may coarsen the buckets: bucket_width decides the ribbon bins; sel names the selection', () => {
    const coarse = { ...summary, bucket_level: 1, bucket_width: 100, buckets: [{ src_lane: 'field:medicine-health', dst_lane: 'field:medicine-health', src_bin: 19, dst_bin: 19, n: 30, by_status: { documented: 30 } }] };
    const { prims } = summaryRibbons(coarse, { layout, X, tier: 'L2' });
    assert.equal(prims.length, 1);
    assert.equal(prims[0].ref.loDay, dayFromYMD(1900, 1, 1));
    assert.equal(prims[0].ref.hiDay, dayFromYMD(1999, 12, 31));
    assert.equal(selParam({ type: 'passage', id: 9 }), 'passage:9');
    assert.equal(selParam({ type: 'relationship', id: 9 }), null);
    assert.equal(selParam(null), null);
    const { prims: p2 } = buildArcs({ ...summary, individual: [{ ...summary.individual[0], selected: true }] }, { layout, X, model });
    assert.equal(p2.find((p) => p.style === 'arc').quiet, false, 'the server marks the links touching the selection');
  });

  test('summary arcs on the same pixels are drawn once and say how many more they stand for', () => {
    const twin = { ...summary.individual[0], rel_id: 9003, src: { ...summary.individual[0].src, passage: 7 } };
    const { prims, stats } = buildArcs({ ...summary, individual: [summary.individual[0], twin] }, { layout, X, model });
    const arcs = prims.filter((p) => p.style === 'arc');
    assert.equal(arcs.length, 1);
    assert.equal(stats.overplotted, 1);
    assert.ok(arcs[0].tip.some((t) => /\+1 more link on the same pixels/.test(t)));
    const sel = buildArcs({ ...summary, individual: [summary.individual[0], twin] }, { layout, X, model, selection: { type: 'passage', id: 7 } });
    assert.equal(sel.prims.filter((p) => p.style === 'arc').length, 2, 'a link touching the selection always draws');
  });

  test('arcs the busy read pool could not answer (503) are asked again, later, before an error is shown', async () => {
    let n = 0;
    const errors = [];
    const timers = [];
    const api = { async get() { n++; if (n < 3) throw Object.assign(new Error('The query took longer than 5000 ms and was stopped.'), { status: 503 }); return summary; }, abort() {} };
    const c = createTilesClient({ api, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, onError: (e) => errors.push(e) });
    c.setQuery('q2', 1);
    await c.requestArcs({ fromYear: 1900, toYear: 2020, ev: 'documented', tier: 'L2' });
    assert.equal(c.arcs, null);
    await timers.shift()();
    await timers.shift()();
    assert.equal(n, 3);
    assert.equal(c.arcs.data.mode, 'summary');
    assert.deepEqual(errors, []);
  });

  test('beyond 40 bundles the bundles are quiet ribbons, never fat arcs (the gene hairball)', () => {
    const bundles = Array.from({ length: 41 }, (_, i) => ({ lanes: ['field:medicine-health', 'field:medicine-health'], bins: [1990 + (i % 20), 1990 + (i % 20)], count: 10 + i, tier: 'L3', status: { documented: 10 + i } }));
    const { prims, stats } = buildArcs({ mode: 'individual', total: 2000, items: [], bundles, hidden: {} }, { layout, X, model, tier: 'L3' });
    assert.ok(!prims.some((p) => p.style === 'arc-bundle'));
    assert.ok(prims.some((p) => p.style === 'arc-ribbon'));
    assert.equal(stats.ribboned, bundles.reduce((n, b) => n + b.count, 0));
    const few = buildArcs({ mode: 'individual', total: 20, items: [], bundles: bundles.slice(0, 3), hidden: {} }, { layout, X, model, tier: 'L3' });
    assert.equal(few.prims.filter((p) => p.style === 'arc-bundle').length, 3, 'a few bundles stay arcs with their counts');
  });

  test('a detail answer of up to 1,500 arcs draws at most 300 of them; the rest join the ribbons (§1.8, §8.3)', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({ ...summary.individual[0], rel_id: 10000 + i,
      src: { ...summary.individual[0].src, passage: 100 + i, y: 1980 + (i % 30) }, dst: { ...summary.individual[0].dst, passage: 900 + i, y: 1975 + (i % 20) } }));
    items[350].src = { ...items[350].src, passage: 4242 };
    const { prims, stats } = buildArcs({ mode: 'individual', detail: true, total: 400, items, bundles: [], hidden: {} },
      { layout, X, model, tier: 'L3', selection: { type: 'passage', id: 4242 } });
    const drawn = new Set(prims.filter((p) => p.style === 'arc').map((p) => p.ref.id));
    assert.ok(drawn.size <= 301);
    assert.ok(drawn.has(10350), 'the link touching the selection is drawn even past the first 300');
    assert.equal(stats.ribboned, 99);
    assert.ok(prims.some((p) => p.style === 'arc-ribbon'));
  });

  test('the client asks for detail=1 with up to 1,500 arcs', async () => {
    const calls = [];
    const api = { async get(path, query) { calls.push({ path, query }); return { mode: 'individual', total: 0, returned: 0, hidden: {}, items: [], bundles: [] }; }, abort() {} };
    const c = createTilesClient({ api });
    c.setQuery('q1', 1);
    await c.requestArcs({ fromYear: 1990, toYear: 2020, ev: 'documented', tier: 'L3', detail: 1 });
    assert.equal(calls[0].query.detail, 1);
    assert.equal(calls[0].query.limit, 1500);
    await c.requestArcs({ fromYear: 1900, toYear: 2020, ev: 'documented', tier: 'L2' });
    assert.equal(calls[1].query.detail, undefined);
    assert.equal(calls[1].query.limit, 300);
  });
});

// ── C5: etymology, each root once; labels ──────────────────────────────────────────────────────────
describe('etymology bands: each root once, labels never overlap or cross a seam (C5, §1.7)', () => {
  const roots = [{ key: 'ine-pro:*weys-', lang: 'ine-pro', form: '*weys-' }, { key: 'ine-pro:*dʰewb-', lang: 'ine-pro', form: '*dʰewb-' },
    { key: 'ine-pro:*dʰewbʰ-', lang: 'ine-pro', form: '*dʰewbʰ-' }];
  const fams = [
    { key: 'la:virus', lang: 'la', form: 'virus', gloss: 'venom', parent_semantics: 'listed_unresolved', parents: roots },
    { key: 'ine-pro:*wisós', lang: 'ine-pro', form: '*wisós', parent_semantics: 'listed_unresolved', parents: roots.map((r) => ({ ...r, families: ['la:virus', 'ine-pro:*wisós'] })) },
  ];

  test('two etyma listing the same three roots: 5 bands, one bracket naming both etyma', () => {
    const lay = etymLayout(fams);
    assert.equal(lay.rows.filter((r) => r.type === 'band').length, 5);
    assert.equal(lay.groups.length, 1);
    assert.deepEqual(lay.groups[0].families, ['la:virus', 'ine-pro:*wisós']);
    assert.deepEqual(lay.items.get('ine-pro:*weys-').listedBy, ['la:virus', 'ine-pro:*wisós']);
    const prims = etymPrims(fams, { row: { y: 0, h: etymRowHeight(fams) }, X: (d) => d / 365 });
    const bands = prims.filter((p) => p.style === 'etym-band');
    assert.equal(bands.length, 5);
    assert.equal(new Set(bands.map((b) => b.id)).size, 5, 'never the same root twice');
    assert.equal(prims.filter((p) => p.style === 'bracket-label').length, 1);
    assert.match(prims.find((p) => p.style === 'bracket-label').text, /how they relate .* is not recorded — for Latin virus and PIE \*wisós$/);
    assert.ok(bands.find((b) => b.ref.key === 'ine-pro:*weys-').tip.some((t) => /drawn once/.test(t)));
  });

  test('a partial overlap: the comb touches exactly the roots each etymon lists', () => {
    const f2 = [fams[0], { key: 'la:viscum', lang: 'la', form: 'viscum', parent_semantics: 'listed_unresolved', parents: [roots[0], { key: 'ine-pro:*weys-2', lang: 'ine-pro', form: '*weys-2' }] }];
    const prims = etymPrims(f2, { row: { y: 0, h: etymRowHeight(f2) }, X: (d) => d / 365 });
    assert.equal(prims.filter((p) => p.style === 'etym-band').length, 6);
    const teeth = prims.filter((p) => p.style === 'roots-bracket' && /^etb:1:/.test(p.id));
    assert.deepEqual(teeth.map((p) => p.id).sort(), ['etb:1:ine-pro:*weys-', 'etb:1:ine-pro:*weys-2']);
  });

  test('labels: one band per row (no two labels share a row), sticky, cut at the band end or the next seam', () => {
    const prims = etymPrims(fams, { row: { y: 0, h: etymRowHeight(fams) }, X: (d) => d / 365, barriers: [-2000] });
    const labels = prims.filter((p) => p.style === 'etym-label');
    assert.equal(new Set(labels.map((l) => l.y0)).size, labels.length, 'no overlap');
    assert.ok(labels.every((l) => l.sticky));
    const pie = labels.find((l) => l.id === 'et:ine-pro:*weys-:l');
    assert.ok(pie.maxX <= -2004, 'never across the seam');
    const place = stickyPlace({ minX: 0, maxX: 100 }, { x0: 40, x1: 500 });
    assert.deepEqual(place, { x: 46, maxW: 54 });
    assert.equal(stickyPlace({ minX: 0, maxX: 100 }, { x0: 90, x1: 500 }), null, 'less than 24 px left: no label');
    assert.equal(fitText(fakeCtx, 'Latin virus — period of the language, not a date', 60), 'Latin vir…', '10 glyphs of 6 px with the ellipsis');
    assert.equal(fitText(fakeCtx, 'short', 60), 'short');
    assert.match(primToSvg({ style: 'etym-label', sticky: true, minX: 0, maxX: 70, x0: 0, y0: 10, text: 'Latin virus — period of the language, not a date' }, { amber: '#E8A84A', 'font-ui': 'x' }, { x0: 0, x1: 900 }),
      />Latin vir…</);
  });

  test('the trail always has its etymology row, and says so when there is no family', () => {
    const layers = defaultState('real').layers;
    assert.equal(extraRows({ families: [[]], baselines: [], tier: 'L3', folded: false, layers, trail: true }).top.length, 1);
    assert.equal(extraRows({ families: [[]], baselines: [], tier: 'L3', folded: false, layers, trail: false }).top.length, 0);
    const p = etymPrims([], { row: { y: 0, h: 26 }, X: (d) => d, empty: NO_FAMILY });
    assert.equal(p[0].text, NO_FAMILY);
    assert.deepEqual(parseHref('/api/baseline?word=virus&lang=en'), { path: '/baseline', query: { word: 'virus', lang: 'en' } });
    assert.equal(parseHref('https://elsewhere.example/api/baseline'), null, 'local only');
  });

  test('the trail etymology lane is drawn as the etymology row, never as counted bins', () => {
    const model = buildModel({ query: { lanes: [lane(TRAIL_ETYMOLOGY, { unit: 'period_bands', label: 'Etymology — periods, not dates' }), lane('trail:literature-text')] },
      tier: 'L2', tiles: new Map(), range: RANGE, strands: STRANDS });
    assert.deepEqual(model.lanes.map((l) => l.key), ['trail:literature-text']);
    assert.equal(model.etymLane.key, TRAIL_ETYMOLOGY);
  });
});

// ── C2: the Term trail ──────────────────────────────────────────────────────────────────────────────
describe('Term trail (C2, §10.5)', () => {
  test('state: corpus real (never the demo), lanes = trail, etymology + claims + baseline on, the whole lane set', () => {
    const st = trailState(defaultState('cipher'), [{ type: 'expression', id: 6 }]);
    // fix pass (§1.3 limits): the trail keeps 10 lanes on a desktop and 5 on a phone; its culture lanes stay (trailShownLanes)
    assert.equal(laneCap(st, { mode: 'desktop', maxLanes: 10 }), 10, 'the trail keeps the desktop limit');
    assert.equal(laneCap(st, { mode: 'narrow', maxLanes: 5 }), 5, 'and the phone limit');
    assert.equal(laneCap({ lanes: { facet: 'domain', max: 12 } }, { mode: 'narrow', maxLanes: 5 }), 5, 'other narrow views keep five lanes');
    assert.equal(laneCap(defaultState('cipher'), { mode: 'desktop', maxLanes: 10 }), 10);
    assert.equal(st.corpus, REAL_CORPUS);
    assert.equal(st.lanes.facet, 'trail');
    assert.deepEqual([st.layers.etymology, st.layers.claims, st.layers.baseline], [1, 1, 1]);
    assert.deepEqual(st.strands, [{ type: 'expression', id: 6, variants: 'default' }]);
  });

  test('a synthetic (demo) expression never joins a real trail; real ones keep their ids', async () => {
    const api = { async get(path) { return { expression: { id: Number(path.split('/').pop()), surface: 'x', synthetic: path.endsWith('/1') } }; } };
    assert.deepEqual(await realStrands(api, [{ type: 'expression', id: 1 }, { type: 'expression', id: 6 }, { type: 'theme', id: 'hip hop' }]), [{ type: 'expression', id: 6 }]);
  });

  test('the start chip seed: the first word with matches across the real corpora; none on a server without them', async () => {
    const api = { async get(path, q) { return { suggestions: [{ type: 'expression', ref: q.q === 'gene' ? 'expression:8' : 'expression:new', count: q.q === 'gene' ? 4118 : 0 }], query: { surface: q.q } }; } };
    const seed = await trailSeed(api);
    assert.deepEqual([seed.surface, seed.count, seed.ref], ['gene', 4118, 'expression:8']);
    assert.equal(await trackInReal(api, seed), 8, 'an existing expression is pinned as it is');
    const old = { async get() { throw Object.assign(new Error('unknown corpus'), { status: 400 }); } };
    assert.equal(await trailSeed(old), null);
    assert.equal(TRAIL_CHIP, 'Follow a word from science into culture');
  });

  test('applying the trail loads one reproducible state; with nothing pinned it focuses the search', async () => {
    const actions = [];
    let view = { ...defaultState('cipher'), strands: [] };
    const store = { get: () => ({ view }), dispatch: (a) => { actions.push(a); if (a.type === 'LOAD_STATE') view = a.state; } };
    await applyTermTrail({ store, api: {} });
    assert.equal(actions[0].type, 'LOAD_STATE');
    assert.equal(actions[0].state.corpus, 'real');
    assert.equal(actions[1].key, 'focusSearch');
  });
});

// ── Coach marks and panels ──────────────────────────────────────────────────────────────────────────
describe('coach marks never cover an open panel (§1.11)', () => {
  test('the first place that covers no panel; none → wait', () => {
    const vp = { w: 1440, h: 900 };
    const size = { w: 340, h: 140 };
    const inspector = { x: 920, y: 0, w: 520, h: 900 };
    assert.deepEqual(coachPlacement([{ x: 1000, y: 200 }, { x: 400, y: 200 }], size, [inspector], vp), { x: 400, y: 200 });
    assert.deepEqual(coachPlacement([{ x: 100, y: 100 }], size, [], vp), { x: 100, y: 100 });
    assert.equal(coachPlacement([{ x: 100, y: 100 }], size, [{ x: 0, y: 0, w: 1440, h: 900 }], vp), null);
    assert.deepEqual(coachPlacement([{ x: 1300, y: 850 }], size, [], vp), { x: 1092, y: 752 }, 'kept inside the viewport');
  });
});

// ── Against the contract 1.3.0 fixtures (tests/contract) ─────────────────────────────────────────────
import { readFileSync } from 'node:fs';
const fx = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8')).variants;

describe('the 1.3.0 fixtures render as the contract says', () => {
  test('POST /api/timeline/query: cluster lanes, not run, gated; the Term trail', () => {
    const Q = fx('POST__api_timeline_query.json');
    assert.equal(clusterLaneState(Q.cluster_lanes.body, 'cluster').kind, 'lanes');
    assert.equal(clusterRunOf(Q.cluster_lanes.body), 38);
    assert.deepEqual(clusterLaneState(Q.cluster_not_run.body, 'cluster').run, { stage: 'cluster', params: { expressionId: 14 } });
    const g = clusterLaneState(Q.cluster_gated.body, 'cluster');
    assert.equal(g.kind, 'gated');
    assert.equal(g.gate.value, null);
    const m = buildModel({ query: Q.cluster_lanes.body, tier: 'L2', tiles: new Map(), range: RANGE, strands: [{ type: 'expression', id: 1, glyph: 'circle' }] });
    assert.deepEqual(m.lanes.map((l) => l.residual), [false, false, false, false, true]);
    assert.ok(m.lanes.every((l) => typeof l.label === 'string' && l.label.length));
    const trail = Q.trail_real.body;
    const tm = buildModel({ query: trail, tier: 'L2', tiles: new Map(), range: RANGE, strands: [{ type: 'expression', id: 8, glyph: 'circle' }], laneLimit: 24 });
    assert.equal(tm.lanes[0].key, 'trail:literature-text', 'the etymology lane is the etymology row, not counted bins');
    assert.ok(tm.etymLane);
    assert.ok(tm.lanes.filter((l) => l.share).length >= 1);
    assert.deepEqual(trail.provenance.corpora, ['cipher', 'stemm'], 'the demo is never a member');
  });

  test('GET /api/timeline/tiles share_cells: one box per OpenAlex cell, never a bar', () => {
    const T = fx('GET__api_timeline_tiles.json').share_cells.body;
    const trail = fx('POST__api_timeline_query.json').trail_real.body;
    const lanes = trail.lanes.filter((l) => l.key === 'trail:stemm-abstracts:physical-sciences');
    const model = buildModel({ query: { ...trail, lanes }, tier: T.tier, tiles: new Map(T.tiles.map((t) => [t.tile, t])), range: [dayFromYMD(1900), dayFromYMD(2030, 12, 31)],
      strands: [{ type: 'expression', id: 8, glyph: 'circle' }] });
    const s = model.lanes[0].strands[0];
    assert.ok(s.share.length > 0);
    assert.deepEqual(s.bars, []);
    for (let i = 0; i < s.share.length; i++) if (s.share.state[i] === SHARE_STATE.low) assert.ok(Number.isNaN(s.share.share[i]));
    const d = buildDisplay(model, { originDay: dayFromYMD(1900), daysPerPx: 20, width: 2400, layout: layoutLanes(model.lanes, 1) });
    assert.ok(d.lanes.some((p) => p.style?.startsWith('share-')));
  });

  test('GET /api/timeline/arcs summary: ribbons, the chip, the bucket width the server chose', () => {
    const A = fx('GET__api_timeline_arcs.json').summary.body;
    const keys = [...new Set(A.buckets.flatMap((b) => [b.src_lane, b.dst_lane]))];
    const lanes = keys.map((k) => lane(k));
    const layout = layoutLanes(lanes, 1, { fillH: 900 });
    const model = buildModel({ query: { lanes }, tier: 'L2', tiles: new Map(), range: [dayFromYMD(1600), dayFromYMD(2040)], strands: STRANDS, laneLimit: 48 });
    const { prims, stats } = buildArcs(A, { layout, X: (d) => (d - dayFromYMD(1600)) / 200, model, tier: 'L2' });
    assert.equal(stats.chip, '21,490 citation links — summarised; zoom in for detail');
    const rib = prims.filter((p) => p.style === 'arc-ribbon');
    assert.ok(rib.length > 0);
    assert.ok(rib.every((p) => (p.ref.hiDay - p.ref.loDay + 1) % 1 === 0 && p.ref.hiDay - p.ref.loDay > 365 * 99), 'century buckets (bucket_width 100)');
    assert.ok(!prims.some((p) => p.style === 'arc-bundle'));
  });

  test('GET /api/etymology virus: two etyma, three shared roots, each drawn once', () => {
    const E = fx('GET__api_etymology.json').virus.body;
    const prims = etymPrims(E.families, { row: { y: 0, h: etymRowHeight(E.families) }, X: (d) => d / 365 });
    const bands = prims.filter((p) => p.style === 'etym-band');
    assert.equal(bands.length, 5);
    assert.equal(new Set(bands.map((b) => b.ref.key)).size, 5);
    assert.equal(prims.filter((p) => p.style === 'bracket-label').length, 1);
    assert.ok(!prims.some((p) => /non-ablauting/.test(p.text ?? '')), 'a PIE form is shown as written, not by a qualifier');
  });
});

test('Esc closes the topmost layer first: an open panel before the selection (fix pass, §8.5)', () => {
  assert.equal(escapeStep({ panel: true, selection: true }), 'panel', 'Lineage beside the inspector closes first');
  assert.equal(escapeStep({ panel: false, selection: true }), 'selection');
  assert.equal(escapeStep({ actionSheet: true, panel: true, selection: true }), 'actionSheet');
  assert.equal(escapeStep({ arcCard: true, panel: true }), 'arcCard');
  assert.equal(escapeStep({ range: true, folded: true }), 'range');
  assert.equal(escapeStep({}), null);
});

test('the Term trail keeps its literature and culture lanes within the lane limit, in its fixed order (fix pass, §1.3, §10.5)', async () => {
  const { trailShownLanes } = await import('../src/ui/timeline/model.mjs');
  const keys = ['trail:literature-text', ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((f) => `trail:stemm-text:${f}`),
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => `trail:stemm-abstracts:${f}`), 'trail:culture-titles', 'trail:music-relations'];
  const lanes = keys.map((key, i) => ({ key, n: key.includes('stemm') ? 100 - i : 1 }));
  for (const limit of [10, 5]) {
    const shown = trailShownLanes(lanes, limit).map((l) => l.key);
    assert.equal(shown.length, limit);
    for (const k of ['trail:literature-text', 'trail:culture-titles', 'trail:music-relations']) assert.ok(shown.includes(k), `${limit}: ${k}`);
    assert.deepEqual(shown, keys.filter((k) => shown.includes(k)), 'the fixed order is kept');
  }
  assert.deepEqual(trailShownLanes(lanes.slice(0, 4), 10).map((l) => l.key), keys.slice(0, 4), 'nothing folds under the limit');
  const model = buildModel({ query: { lanes: lanes.map((l) => lane(l.key, { n: l.n })) }, tier: 'L2', tiles: new Map(), range: RANGE, strands: STRANDS,
    laneLimit: 5, lanesView: { facet: 'trail', order: 'first_observed' } });
  assert.ok(model.lanes.some((l) => l.key === 'trail:culture-titles'), 'the culture end is on screen');
});

test('a view opens on the bulk of its evidence: an estimated first date centuries before every other lane does not stretch it (fix pass)', () => {
  const lane = (lo, hi, basis = 'stated') => ({ key: `k${lo}`, first: { lo_day: dayFromYMD(lo), basis }, last: { hi_day: dayFromYMD(hi, 12, 31) } });
  const q = { extent: { from: '44', to: '2026' }, lanes: [lane(44, 1900, 'estimated'), lane(1806, 2026), lane(1880, 2020), lane(1950, 2024)] };
  const [lo, hi] = bulkExtentDays(q);
  assert.equal(lo, dayFromYMD(1806));
  assert.equal(hi, dayFromYMD(2026, 12, 31));
  const stated = { ...q, lanes: [lane(44, 1900), ...q.lanes.slice(1)] };
  assert.equal(bulkExtentDays(stated)[0], dayFromYMD(44), 'a stated early date is evidence: it stays in the frame');
  const near = { ...q, lanes: [lane(1750, 1900, 'estimated'), ...q.lanes.slice(1)] };
  assert.equal(bulkExtentDays(near)[0], dayFromYMD(1750), 'an estimate near the rest stays too');
});

test('Home and End in the marks region land on the first and last observation, never an empty bin (fix pass, §8.5)', async () => {
  const { observationIndex } = await import('../src/ui/timeline/viewport.mjs');
  const items = [{ style: 'absent' }, { style: 'absent' }, { style: 'bar' }, { style: 'mark-text' }, { style: 'bar-sparse' }, { style: 'absent' }];
  assert.equal(observationIndex(items, true), 2);
  assert.equal(observationIndex(items, false), 4);
  assert.equal(observationIndex([{ style: 'absent' }], true), 0, 'a lane with nothing observed keeps its first item');
  assert.equal(observationIndex([], false), 0);
});
