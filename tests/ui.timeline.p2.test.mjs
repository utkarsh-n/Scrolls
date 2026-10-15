// OWNER: WP6 — the Scroll's P2 layers (SPEC §1.5, §1.7, §1.8, §1.11, §7.3, §8.3, §8.4): arcs above, feedback below
// and only from feedback-capable links, date conflicts as stubs, the vantage on arcs, bundles; etymology periods
// (never dates) with the listed-roots bracket; claims and the external baseline say what they are; the folded
// overview's fixed regimes; theme sub-strands; the coverage-only start state; fill-height lanes; the click/drag
// threshold; the perf bench's 20k rects; snapshots carry the SYNTHETIC stamp; the coach marks' words.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { edgeStyle } from '../src/shared/evidence-style.mjs';
import { buildArcs, arcCurve, arcsNote, evParam, midYearDay, CALM_ARCS, QUIET_MIN, quietAlpha, SUMMARY_TEXTURE, touchesSelection } from '../src/ui/timeline/arcs.mjs';
import { bandLabel, baselinePrims, BASELINE_MULTIWORD, bracketLabel, claimPrims, etymPrims, etymRowHeight, familiesFromSuggestions, NO_FAMILY } from '../src/ui/timeline/deeptime.mjs';
import { buildDisplay, layoutLanes, SLOT_RANGE } from '../src/ui/timeline/display.mjs';
import { foldedParts, REGIME_TIER, regimeScale } from '../src/ui/timeline/folded.mjs';
import { buildHitGrid } from '../src/ui/timeline/hit.mjs';
import { CLICK_MS, CLICK_SLOP, FLICK_PX, isDrag } from '../src/ui/timeline/input.mjs';
import { buildCoverageModel, buildModel, strandRows, SUBSTRANDS } from '../src/ui/timeline/model.mjs';
import { percentile, syntheticTiles } from '../src/ui/timeline/perf.mjs';
import { snapshotCaption, composeSvg } from '../src/ui/timeline/snapshot.mjs';
import { contractAtLeast, extraRows } from '../src/ui/timeline/viewport.mjs';
import { coachCopy } from '../src/ui/tour/coachmarks.mjs';
import { START_CANDIDATES, tourDismissed, setTourDismissed, TOUR_DISMISSED_KEY } from '../src/ui/tour/tour.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8'));
const QUERY = fixture('POST__api_timeline_query.json').variants;
const TILES = fixture('GET__api_timeline_tiles.json').variants;
const ARCS = fixture('GET__api_timeline_arcs.json').variants;
const STRANDS = [{ type: 'expression', id: 12, glyph: 'circle' }];
const RANGE = [dayFromYMD(1880), dayFromYMD(2040, 12, 31)];
const DPP = 30;
const X = (day) => (day - RANGE[0]) / DPP;

function scene() {
  const model = buildModel({ query: QUERY.ready.body, tier: 'L2', tiles: new Map(TILES.ok.body.tiles.map((t) => [t.tile, t])), range: RANGE, strands: STRANDS,
    strandLabels: new Map([['12', 'carry the zero']]) });
  const layout = layoutLanes(model.lanes, model.rowCount, { fillH: 640 });
  return { model, layout };
}

describe('arcs (§1.8)', () => {
  const { model, layout } = scene();
  const yOf = (lane) => layout.lanes.find((l) => l.key === lane).slots[0].mid;

  test('forward arcs rise above both ends, earlier → later, arrow at the later (derived) end', () => {
    const { prims } = buildArcs(ARCS.ok.body, { layout, X, model });
    const arc = prims.find((p) => p.id === 'arc:7781');
    assert.equal(arc.style, 'arc');
    assert.ok(arc.cy < Math.min(yOf('community:hiphop'), yOf('community:classroom')), 'apex above the strands');
    assert.ok(arc.p0[0] < arc.p1[0], 'drawn from the earlier (1911) to the later (1994) end');
    assert.equal(arc.arrowAt, 'end');
    assert.ok(Math.abs(arc.p0[0] - X(midYearDay(1911))) < 1e-6, 'a year-precision end sits mid-year, never on 1 January');
  });

  test('feedback arcs hang below in violet with the arrow on the earlier end, only where the server says feedback', () => {
    const { prims } = buildArcs(ARCS.ok.body, { layout, X, model });
    const fb = prims.filter((p) => p.style === 'arc-feedback');
    assert.deepEqual(fb.map((p) => p.id), ['arc:7802'], 'only the reframes link (feedback: true)');
    const f = fb[0];
    assert.ok(f.cy > Math.max(f.p0[1], f.p1[1]), 'below the strands');
    assert.equal(f.arrowAt, 'start');
    assert.equal(f.edge.hue, 'violet');
    const halo = prims.find((p) => p.style === 'halo');
    assert.match(halo.tip[0], /^re-read after 2016 \(1 documented\)$/);
    assert.ok(!prims.some((p) => p.style === 'arc-feedback' && p.ref.id !== 7802), 'similarity and computed links never become feedback');
  });

  test('line pattern comes from evidence-style: documented solid, computed dashed, proposed dotted', () => {
    const { prims } = buildArcs(ARCS.ok.body, { layout, X, model });
    const dash = (id) => prims.find((p) => p.id === `arc:${id}`).edge.dash;
    assert.deepEqual(dash(7781), edgeStyle({ evidence_status: 'documented' }).dash);
    assert.deepEqual(dash(7790), [6, 4]);
    assert.deepEqual(dash(7795), [1, 3]);
    assert.equal(prims.find((p) => p.id === 'arc:7795').edge.overlay, 'scales', 'disputed: ⚖ overlay, same line');
  });

  test('the vantage: strict hides an arc until both ends are ≤ the vantage; context ghosts it; no halo before the later work', () => {
    const vantage = { day: dayFromYMD(1925, 12, 31), strict: true };
    const strict = buildArcs(ARCS.ok.body, { layout, X, model, vantage });
    assert.deepEqual(strict.prims.map((p) => p.id), [], 'as of 1925 no link has both ends in the record yet');
    const in1940 = buildArcs(ARCS.ok.body, { layout, X, model, vantage: { day: dayFromYMD(1940, 12, 31), strict: true } });
    assert.deepEqual(in1940.prims.map((p) => p.id), ['arc:7803'], 'the 1936 → 1894 citation appears once the vantage passes 1936');
    assert.ok(strict.prims.every((p) => p.style !== 'halo'), 'no re-read halo before 2016');
    assert.ok(!strict.prims.some((p) => p.id === 'arc:7781'), '1994 → 1911 is not shown as of 1925 (strict)');
    const ctx = buildArcs(ARCS.ok.body, { layout, X, model, vantage: { ...vantage, strict: false } });
    assert.equal(ctx.prims.find((p) => p.id === 'arc:7781').ghost, true, 'context ghosts it');
    assert.ok(strict.stats.hiddenByVantage > 0);
  });

  test('many arcs fade with their number; the selection’s arcs stay at full strength (fix pass, §1.4)', () => {
    assert.equal(quietAlpha(CALM_ARCS), 1);
    assert.equal(quietAlpha(CALM_ARCS * 2), 0.5);
    assert.equal(quietAlpha(5000), QUIET_MIN);
    const base = ARCS.ok.body.items.find((it) => !it.feedback && !it.date_conflict);
    // 120 links from distinct passages (so their arcs do not merge on the same pixels); one of them is selected
    const items = Array.from({ length: 120 }, (_, i) => ({ ...base, rel_id: 90000 + i, src: { ...base.src, passage: 50000 + i, y: base.src.y - (i % 30) },
      dst: { ...base.dst, y: base.dst.y - (i % 11) } }));
    const sel = { type: 'passage', id: 50000 };
    const { prims, stats } = buildArcs({ items, bundles: [] }, { layout, X, model, selection: sel });
    assert.ok(stats.drawn > CALM_ARCS);
    const arcs = prims.filter((p) => p.style === 'arc');
    assert.ok(arcs.filter((p) => !p.quiet).every((p) => touchesSelection({ src: p.ref.src, dst: p.ref.dst, rel_id: p.ref.id }, sel)), 'only the selection is at full strength');
    assert.ok(arcs.some((p) => p.quiet && p.quietAlpha <= quietAlpha(stats.drawn)), 'the others fade');
    // over a summary the individual arcs are a texture under the counted ribbons: half their fade (second session)
    const summary = buildArcs({ mode: 'summary', items, bundles: [], buckets: [] }, { layout, X, model, selection: sel });
    const quiet = summary.prims.filter((p) => p.style === 'arc' && p.quiet);
    assert.ok(quiet.length > 0 && quiet.every((p) => p.quietAlpha <= Math.min(0.5, quietAlpha(summary.stats.drawn)) * SUMMARY_TEXTURE + 1e-9));
  });

  test('a date conflict is a dotted danger stub, never an arc or feedback', () => {
    const item = { ...ARCS.ok.body.items[0], rel_id: 1, date_conflict: true, src: { ...ARCS.ok.body.items[0].src, y: 1900 } };
    const { prims } = buildArcs({ items: [item], bundles: [] }, { layout, X, model });
    assert.equal(prims.length, 1);
    assert.equal(prims[0].style, 'arc-conflict');
    assert.match(prims[0].tip[0], /^⚠ date conflict/);
  });

  test('bundles beyond the budget: width ∝ log2(count+1) with their count; a footer note says what is left out', () => {
    const bundle = { lanes: ['community:office-lab', 'community:classroom'], bins: [196, 191], tier: 'L2', count: 12, width: 3.7, status: { computed: 12 }, label: '12 arcs' };
    const out = buildArcs({ items: [], bundles: [bundle], hidden: { rejected: 1, filtered: 5 } }, { layout, X, model });
    const b = out.prims.find((p) => p.style === 'arc-bundle');
    assert.equal(b.width, 3.7);
    assert.equal(b.label, '12 arcs');
    assert.equal(arcsNote({ hidden: { rejected: 1, filtered: 5 } }, out.stats), '+12 more arcs (bundled) · 1 rejected hidden · 5 filtered by evidence');
  });

  test('arcs are hit along their curve, not anywhere in their bounding box (§8.4)', () => {
    const [a] = buildArcs({ items: [ARCS.ok.body.items[0]] }, { layout, X, model }).prims;
    const grid = buildHitGrid([a]);
    const mid = a.points[8];
    assert.equal(grid.query(mid[0], mid[1] + 3)?.id, a.id, 'near the curve');
    const inside = [(a.x0 + a.x1) / 2, a.y1 - 1];
    assert.equal(grid.query(inside[0], inside[1]), null, 'inside the box, far from the curve: no hit');
  });

  test('the E filter maps to the ev parameter; arcCurve apex height', () => {
    assert.equal(evParam({ documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 }), 'documented,computed,proposed');
    assert.equal(evParam({ documented: 1, computed: 0, proposed: 0, rejected: 1, kindred: 0 }), 'documented,rejected');
    const c = arcCurve(0, 100, 200, 100, 30, -1);
    assert.ok(Math.abs(Math.min(...c.points.map((p) => p[1])) - 70) < 1e-9, 'apex 30 px above');
  });
});

describe('etymology, claims and the external baseline (§1.7)', () => {
  test('periods, not dates: band labels and the listed-roots bracket wording', () => {
    assert.equal(bandLabel({ lang: 'sa', roman: 'śūnyá', form: 'शून्य', gloss: 'blank' }), "Sanskrit śūnyá 'blank' — period of the language, not a date");
    assert.equal(bracketLabel('listed_chain', [{ lang: 'sa' }, { lang: 'ine-pro' }]), 'Wiktionary lists a Sanskrit root and a PIE root (likely a chain; not stated)');
    assert.equal(bracketLabel('listed_variants', [{ lang: 'ine-pro' }, { lang: 'ine-pro' }]), 'variant reconstructions of one root');
    assert.equal(bracketLabel('listed_unresolved', [{ lang: 'ine-pro' }, { lang: 'ine-pro' }, { lang: 'ine-pro' }]),
      'Wiktionary lists 3 roots; how they relate (components or alternatives) is not recorded');
    assert.equal(bracketLabel('listed_chain', [{ lang: 'sa' }]), null, 'one parent: no bracket');
    assert.equal(NO_FAMILY, "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)");
  });

  test('etymology bands span the language period with feathered ends; the bracket groups listed parents; descent is undated', () => {
    const fam = [{ key: 'sa:शून्य', lang: 'sa', form: 'शून्य', roman: 'śūnyá', gloss: 'blank', parent_semantics: 'listed_chain',
      parents: [{ key: 'sa:√śū', lang: 'sa', form: '√śū' }, { key: 'ine-pro:*ḱewh₁-', lang: 'ine-pro', form: '*ḱewh₁-' }] }];
    const row = { y: 0, h: etymRowHeight(fam) };
    const prims = etymPrims(fam, { row, X: (d) => d / 365, firstObservation: { x: 0, y: 200 } });
    const bands = prims.filter((p) => p.style === 'etym-band');
    assert.equal(bands.length, 3);
    assert.ok(bands.every((b) => b.tip[0].endsWith('— period of the language, not a date')));
    assert.ok(bands.every((b) => b.fuzz0 > 0), 'fuzzy ends');
    assert.ok(prims.some((p) => p.style === 'roots-bracket'));
    assert.ok(prims.some((p) => p.style === 'bracket-label' && p.text.includes('likely a chain; not stated')));
    const d = prims.find((p) => p.style === 'descent');
    assert.deepEqual(d.tip, ['descends (Wiktionary via kaikki.org, undated)']);
  });

  test('the search fallback yields the etymon only (no invented parents)', () => {
    const f = familiesFromSuggestions([
      { type: 'etymology', label: "शून्य (sa) 'blank; deserted' — listed by Wiktionary (via kaikki.org)", ref: 'etymon:sa:शून्य', count: null },
      { type: 'etymology', label: NO_FAMILY, ref: 'etymon:none', count: null },
      { type: 'work', label: 'x', ref: 'document:1' }]);
    assert.deepEqual(f, [{ key: 'sa:शून्य', lang: 'sa', form: 'शून्य', roman: null, gloss: 'blank; deserted', parents: [], parent_semantics: null }]);
  });

  test('claims are hollow diamonds labelled "(external claim)"; the baseline says single words only, or draws its own axis', () => {
    const c = claimPrims([{ label: 'Wiktionary: first attested 1898', date: { lo_year: 1898, hi_year: 1898 } }], { X: (d) => d, slot: { y: 0, h: 24, mid: 12 } });
    assert.equal(c[0].style, 'claim');
    assert.equal(c[0].tip[0], 'Wiktionary: first attested 1898 (external claim)');
    assert.equal(c[0].openable, false, 'never an occurrence');
    const none = baselinePrims({ available: false, reason: 'single words only' }, { row: { y: 0, h: 32 }, X: (d) => d, x0: 0, x1: 100 });
    assert.ok(none.some((p) => p.text?.includes(BASELINE_MULTIWORD)));
    const series = baselinePrims({ available: true, label: 'Google Books Ngram, English, 2020 edition — a different corpus', decades: [{ decade: 1900, per_million: 1 }, { decade: 1910, per_million: 2, thin: true }] },
      { row: { y: 0, h: 32 }, X: (d) => d / 100, x0: 0, x1: 100 });
    assert.ok(series.some((p) => p.style === 'baseline-line' || p.style === 'baseline-thin'));
    assert.ok(series.some((p) => p.text?.includes('a different corpus') && p.text.includes('axis 0–2/M')));
  });

  test('extra rows: the etymology lane only at L0–L2 (or folded), a 32 px baseline track per expression when on', () => {
    const fam = [[{ key: 'la:zephirum', lang: 'la', form: 'zephirum', parents: [] }]];
    const layers = defaultState('cipher').layers;
    assert.equal(extraRows({ families: fam, baselines: [{ id: 5 }], tier: 'L2', folded: false, layers }).top.length, 1);
    assert.equal(extraRows({ families: fam, baselines: [{ id: 5 }], tier: 'L3', folded: false, layers }).top.length, 0);
    assert.equal(extraRows({ families: fam, baselines: [{ id: 5 }], tier: 'L3', folded: true, layers }).top.length, 1);
    assert.deepEqual(extraRows({ families: [], baselines: [{ id: 5 }], tier: 'L2', folded: false, layers: { ...layers, baseline: 1 } }).bottom, [{ key: 'baseline:5', h: 32 }]);
    assert.equal(contractAtLeast('1.2.0', [1, 2]), true);
    assert.equal(contractAtLeast('1.1.0', [1, 2]), false);
  });
});

describe('lanes, strands and the start state', () => {
  test('lanes fill the height: the slot grows from 24 up to 56 px, every lane equal; extra rows above and below', () => {
    const lanes = Array.from({ length: 8 }, (_, i) => ({ key: `l${i}` }));
    const lay = layoutLanes(lanes, 1, { fillH: 700, top: [{ key: 'etym', h: 40 }], bottom: [{ key: 'baseline:1', h: 32 }] });
    assert.equal(lay.slotH, SLOT_RANGE.max);
    assert.ok(new Set(lay.lanes.map((l) => l.h)).size === 1, 'equal heights');
    assert.equal(lay.extra.etym.y, 0);
    assert.equal(lay.lanes[0].y, 40);
    assert.ok(lay.height <= 700 + 1);
    const tight = layoutLanes(lanes, 2, { fillH: 300 });
    assert.equal(tight.slotH, 24, 'never below the 24 px slot');
  });

  test('a theme strand splits into sub-strands by tag provenance, in the order solid · hatched · dotted', () => {
    const query = { lanes: [{ key: 'domain:culture~titles', strands: { 'theme:hip hop@genre_heuristic': {}, 'theme:hip hop@documented_category': {}, 'theme:hip hop@machine_tag': {} } }] };
    const rows = strandRows(query, [{ type: 'theme', id: 'hip hop', glyph: 'circle' }], new Map([['hip hop', 'hip hop (theme)']]));
    assert.deepEqual(rows.map((r) => r.sub), ['documented_category', 'machine_tag', 'genre_heuristic']);
    assert.equal(rows[1].label, `hip hop (theme) · ${SUBSTRANDS.machine_tag.label}`);
    assert.ok(SUBSTRANDS.machine_tag.label.includes('fallible'));
    assert.deepEqual(strandRows({ lanes: [] }, STRANDS).map((r) => r.ref), ['12'], 'an expression is one row keyed by its id');
  });

  test('no strand pinned: one lane per collection with its dated span, nothing counted', () => {
    const m = buildCoverageModel([{ slug: 'cipher-gutenberg', name: 'Project Gutenberg books (Cipher)', modality: 'text', unit: 'tokens', docs: 691, tokens: 59819711, works: 0,
      undated: 8, scheduled: 0, span: ['1323', '1928'], selection_note: 'chosen by Wikipedia sitelinks' }]);
    assert.equal(m.coverageOnly, true);
    assert.equal(m.lanes[0].header, 'Project Gutenberg books (Cipher) · text · 59.8M tokens, 1323–1928');
    assert.equal(m.lanes[0].undated, 8);
    const layout = layoutLanes(m.lanes, 0);
    const d = buildDisplay(m, { originDay: dayFromYMD(1300), daysPerPx: 100, width: 3000, layout });
    const span = d.lanes.find((p) => p.style === 'cov-span');
    assert.ok(span && span.tip.includes('coverage only: pin a strand to count occurrences'));
    assert.ok(!d.lanes.some((p) => p.style?.startsWith('bar') || p.style === 'absent' || p.style === 'hatch'), 'nothing observed, absent or uncovered is claimed');
  });

  test('start chips are offered only after a check; the Cipher candidates are the QA list, after the Term trail chip', () => {
    assert.equal(START_CANDIDATES.cipher[0].kind, 'trail', '"Follow a word from science into culture" comes first (C2)');
    assert.deepEqual(START_CANDIDATES.cipher.filter((c) => c.kind !== 'trail').map((c) => `${c.q} (${c.kind})`),
      ['virus (expression)', 'zero (expression)', 'sample (expression)', 'hip hop (theme)', "Rapper's Delight (genealogy)"]);
    assert.equal(START_CANDIDATES.real[0].kind, 'trail');
  });
});

describe('the folded overview (§1.5)', () => {
  test('four linear parts at fixed shares, binned millennium · century · decade · decade', () => {
    const { parts, folded } = foldedParts(1400);
    assert.deepEqual(parts.map((p) => Math.round(p.x1 - p.x0)), [210, 210, 280, 700]);
    assert.deepEqual(parts.map((p) => p.tier), ['L0', 'L1', 'L2', 'L2']);
    assert.deepEqual(Object.values(REGIME_TIER), ['L0', 'L1', 'L2', 'L2']);
    assert.deepEqual(folded.seams.map((s) => s.label), ['×3.3', '×8.9', '×3.3']);
    assert.equal(regimeScale(folded.regimes[0]), '1 px ≈ 31 years');
    const m = parts[3];
    assert.ok(Math.abs((dayFromYMD(1900) - m.originDay) / m.daysPerPx + m.x0 - folded.xOfYear(1900)) < 1, 'each part is linear and agrees with the folded geometry');
  });
});

describe('input, perf, snapshot, coach marks', () => {
  test('a press becomes a pan only after ≥ 4 px and ≥ 150 ms, or a 12 px flick', () => {
    assert.equal(isDrag(3, 400), false);
    assert.equal(isDrag(CLICK_SLOP, CLICK_MS - 1), false, 'a quick shaky click still selects');
    assert.equal(isDrag(CLICK_SLOP, CLICK_MS), true);
    assert.equal(isDrag(FLICK_PX, 10), true);
  });

  test('the perf bench builds ≥ 20,000 shapes through the real model → display pipeline', () => {
    const syn = syntheticTiles({ lanes: 10, strands: 2, bins: 1000 });
    const model = buildModel({ query: syn.query, tier: syn.tier, tiles: syn.tiles, range: syn.range, strands: syn.strands });
    const layout = layoutLanes(model.lanes, model.rowCount, { fillH: 700 });
    const d = buildDisplay(model, { originDay: syn.range[0], daysPerPx: (syn.range[1] - syn.range[0]) / 1440, width: 1440, layout });
    assert.ok(d.stats.rects + d.stats.ticks >= 20000, `${d.stats.rects + d.stats.ticks} shapes`);
    assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100);
    assert.equal(percentile([5, 1, 3], 0.5), 3);
  });

  test('snapshots: the caption says SYNTHETIC; the SVG carries the stamp and the lane names', () => {
    const view = { ...defaultState('demo'), strands: STRANDS };
    const cap = snapshotCaption({ view, query: { dataVersion: 47, totals: { n: 340 }, provenance: { synthetic: true } }, labels: ['carry the zero'] });
    assert.equal(cap, 'Scrolls · demo · carry the zero · data v47 · 340 matches · contains SYNTHETIC data');
    const { model, layout } = scene();
    const display = buildDisplay(model, { originDay: RANGE[0], daysPerPx: DPP, width: (RANGE[1] - RANGE[0]) / DPP, layout });
    const svg = composeSvg({ display, tx: 0, width: 1200, lanesTop: 56, palette: {}, model, layout }, { synthetic: true, caption: cap });
    assert.ok(svg.includes('SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.'));
    assert.ok(svg.includes('>Classroom'), 'lane names are baked in');
    assert.ok(svg.includes('SYN</tspan>'), 'synthetic lanes say SYN');
  });

  test('the coach marks use §1.11’s words, filled from the data on screen', () => {
    const one = coachCopy(1, { label: 'carry the zero' });
    assert.deepEqual(one.lines[0], ["Bars span where 'carry the zero' was ", { strong: 'observed' }, '. Gaps are real: dotted = looked and found none; hatched = no sources.']);
    const two = coachCopy(2, { doc: { src: { y: 1994 }, dst: { y: 1911 }, rel_type: 'explicit_citation', source: 'liner-note record (synthetic)' },
      calc: { src: { y: 1963 }, dst: { y: 1911 }, rel_type: 'exact_quotation', run_id: 9 } });
    assert.deepEqual(two.lines, ['DOC — 1994 explicit citation → 1911: liner-note record (synthetic)', 'CALC — 1963 exact quotation → 1911: computed by text matching (run #9)',
      'Line style = evidence. Click any mark to read its source.']);
    assert.deepEqual(coachCopy(3).lines, ['Press ▶ to watch the phrase acquire history.']);
    const four = coachCopy(4, { health: { cipher: { status: 'fulltext', message: 'full text 312 / 1,516 books indexing' } } });
    assert.equal(four.title, 'Your turn.');
    assert.equal(four.lines[0], 'Cipher titles, relations and etymology ready · full text 312 / 1,516 books indexing');
  });

  test('the tour flag: dismissed only when stored; a failing storage shows the tour (fail safe)', () => {
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    assert.equal(tourDismissed(storage), false);
    setTourDismissed(true, storage);
    assert.equal(mem.get(TOUR_DISMISSED_KEY), '1');
    assert.equal(tourDismissed(storage), true);
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(tourDismissed(broken), false);
    assert.doesNotThrow(() => setTourDismissed(true, broken));
  });
});

describe('splits (§1.8)', () => {
  test('a split is a dashed S-curve from the parent group into the child lane at the year it emerges, with ⑂ and the caveat', async () => {
    const { buildSplits, SPLIT_CAVEAT } = await import('../src/ui/timeline/arcs.mjs');
    const clusters = fixture('GET__api_clusters.json').variants.ok.body;
    const layout = layoutLanes([{ key: 'cluster:40' }, { key: 'cluster:41' }, { key: 'cluster:42' }], 1);
    const prims = buildSplits(clusters, { layout, X });
    const curve = prims.find((p) => p.style === 'split-curve');
    assert.ok(curve, 'the 1955 split 40 → 41');
    assert.equal(curve.points[0][1], layout.lanes[0].slots[0].mid, 'starts on the parent strand');
    assert.equal(curve.points[3][1], layout.lanes[1].slots[0].mid, 'ends in the child lane');
    assert.ok(Math.abs(curve.points[3][0] - X(midYearDay(1955))) < 1e-9);
    assert.ok(curve.tip.some((t) => t.includes('not a claim about speakers')) || curve.tip.includes(SPLIT_CAVEAT));
    assert.equal(prims.find((p) => p.style === 'split-glyph').text, '⑂');
    assert.equal(prims.filter((p) => p.style === 'split-curve').length, 1, "an 'emerge' without a parent draws nothing");
    assert.deepEqual(buildSplits(clusters, { layout, X, vantage: { day: dayFromYMD(1950, 12, 31), strict: true } }), [], 'not before the vantage reaches it');
  });
});
