// OWNER: WP6
// timeline/viewport.mjs — the Scroll (SPEC §1, §8.3–§8.6): viewport state ↔ pixels, the render loop
// (query → tiles → model → display list → paint), pointer/wheel/touch/keyboard input, the playhead, hover
// tooltips, selection, the marks region (roving focus via a DOM proxy), arcs and their evidence card, the
// folded deep-time overview, and the start / loading / error states.
//
// Other timeline and shell modules (lanes column, shelves, minimap, legend, toolbar, table, drawer, tour,
// snapshot, perf HUD) read the Scroll through `scrollHub` and act on it through `scrollHub.actions`; the
// reproducible view state stays in the store. Sub-day pan offsets live here and are committed to the store
// when a gesture ends (store axis values are rounded).

import { dayFromYMD, todayDay, yearRangeLabel, ymdFromDay } from '../../shared/dates.mjs';
import { formatCount, formatNumber, formatTokens, totalsText, unitLabel } from '../../shared/format.mjs';
import { AXIS_LIMITS, defaultState, formatFilter, VANTAGE_OPEN_DAY } from '../../shared/viewstate.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { createEdgeCard } from '../panels/edge-card.mjs';
import { layoutFor } from '../shell/layout.mjs';
import { REAL_CORPUS, TRAIL_FACET } from '../shell/presets.mjs';
import { chipAction, renderStartCard, startChips } from '../tour/tour.mjs';
import { arcsWindow, selParam } from './arc-summary.mjs';
import { arcsNote, buildArcs, evParam } from './arcs.mjs';
import { buildTransitions, clusterLanesLine, clusterLaneState, clusterRunOf, renderClusterCard } from './clusters.mjs';
import { baselinePrims, claimPrims, createDeepTimeData, DEEP, ETYM_EMPTY_H, etymPrims, etymRowHeight, ETYM_TIERS, NO_FAMILY } from './deeptime.mjs';
import { buildDisplay, describeModel, layoutLanes, GEOM, LANES_TOP, REGIME_LABEL_Y } from './display.mjs';
import { foldedParts, regimeScale, seamZigzag, SEAM_PX } from './folded.mjs';
import { attachTouch } from './gestures.mjs';
import { buildHitGrid, TOLERANCE } from './hit.mjs';
import { attachPointer, capturePointer } from './input.mjs';
import { buildCoverageModel, buildModel, parseLabel, strandSummary, STATE } from './model.mjs';
import { createLayer, paintList, readPalette, withAlpha } from './paint.mjs';
import { perf } from './perf.mjs';
import { autoPanCenter, createPlayer, needsAutoPan } from './playhead.mjs';
import { binCaption, createScale, dayLabel } from './scale.mjs';
import { BIN_ADJECTIVE, coarserTier, daysPerPxForTier, effectiveTier, finerTier, snapToBinEnd, tierForDaysPerPx,
  tilesForDays, TIER_LEVEL } from './tiers.mjs';
import { arcsAsSaved, createTilesClient, queryBody, RETRIES } from './tiles-client.mjs';

/** Footer height under the canvas (caption line). */
export const FOOTER_H = 26;
const PILL_MS = 1500;
const REVEAL_MS = 150;
const STAGGER_MS = 600;
/** Contract version from which GET /api/etymology exists (a proposed additive endpoint). */
const ETYMOLOGY_CONTRACT = [1, 2];

// ── Pure viewport math ──────────────────────────────────────────────────────────────────────────────

/**
 * Clamp an axis to the pan and zoom domain (§1.5: 10000 BCE – 2100 CE; 0.05 px/year – 40 px/day). With the view's
 * width, the whole visible range stays inside the domain (zooming out stops when it fills the width).
 * @param {{centerDay: number, daysPerPx: number}} axis
 * @param {number} [width] the view's width in px
 * @returns {{centerDay: number, daysPerPx: number}}
 */
export function clampAxis({ centerDay, daysPerPx }, width = 0) {
  let dpp = Math.min(AXIS_LIMITS.maxDaysPerPx, Math.max(AXIS_LIMITS.minDaysPerPx, daysPerPx));
  if (!(width > 0)) return { centerDay: Math.min(AXIS_LIMITS.maxDay, Math.max(AXIS_LIMITS.minDay, centerDay)), daysPerPx: dpp };
  // with a known width the whole visible range stays inside the pan domain [10000 BCE, 2100 CE] (§1.5, fix pass: the
  // centre alone was clamped, so the axis reached 10,000 CE and the minimap lost its bracket)
  const domain = AXIS_LIMITS.maxDay - AXIS_LIMITS.minDay;
  dpp = Math.min(dpp, domain / width);
  const half = (width / 2) * dpp;
  return { centerDay: Math.min(AXIS_LIMITS.maxDay - half, Math.max(AXIS_LIMITS.minDay + half, centerDay)), daysPerPx: dpp };
}

/**
 * Zoom by `factor` (> 1 zooms in) keeping the day under pixel `x` fixed.
 * @param {{centerDay: number, daysPerPx: number}} axis
 * @param {number} width
 * @param {number} x
 * @param {number} factor
 */
export function zoomAxis(axis, width, x, factor) {
  const dpp = Math.min(AXIS_LIMITS.maxDaysPerPx, Math.max(AXIS_LIMITS.minDaysPerPx, axis.daysPerPx / factor));
  const anchor = axis.centerDay + (x - width / 2) * axis.daysPerPx;
  return clampAxis({ centerDay: anchor - (x - width / 2) * dpp, daysPerPx: dpp }, width);
}

/**
 * Pan by a drag of `dxPx` pixels (content follows the pointer: dragging right shows earlier time).
 * @param {{centerDay: number, daysPerPx: number}} axis
 * @param {number} dxPx
 */
export function panAxis(axis, dxPx) {
  return clampAxis({ centerDay: axis.centerDay - dxPx * axis.daysPerPx, daysPerPx: axis.daysPerPx });
}

/**
 * The axis that shows [loDay, hiDay] with a margin.
 * @param {number} loDay
 * @param {number} hiDay
 * @param {number} width
 * @param {number} [pad=0.06] share of the width left on each side
 */
export function fitAxis(loDay, hiDay, width, pad = 0.06) {
  const span = Math.max(1, hiDay - loDay + 1);
  return clampAxis({ centerDay: (loDay + hiDay + 1) / 2, daysPerPx: span / Math.max(1, width * (1 - 2 * pad)) }, width);
}

/** Encode / decode the id of a bin selection: 'community:classroom~12~L2~191'. */
export const binId = (ref) => `${ref.lane}~${ref.strand}~${ref.tier}~${ref.bin}`;
export function parseBinId(id) {
  const parts = String(id ?? '').split('~');
  if (parts.length !== 4) return null;
  const bin = Number(parts[3]);
  return Number.isInteger(bin) && /^L[0-5]$/.test(parts[2]) ? { lane: parts[0], strand: parts[1], tier: parts[2], bin } : null;
}

/** Days of the query extent ('1905'–'2026'), or null. */
export function extentDays(query) {
  const a = parseLabel(query?.extent?.from), b = parseLabel(query?.extent?.to);
  return a && b ? [a.lo_day, b.hi_day] : null;
}

/** An estimated first observation this far before the next lane's is an outlier for the opening frame. */
const OUTLIER_DAYS = 200 * 365.25;

/**
 * The days a view opens on (fix pass): the extent of the data, except that a lane's first observation dated only by an
 * estimate, centuries before every other lane's ("44–79 CE (estimated)" in Life sciences), does not stretch the frame —
 * the bulk of the evidence gets the canvas; the outlier is still there when zooming out, and Fit (0) shows everything.
 * @param {object|null} query
 * @returns {[number, number]|null}
 */
export function bulkExtentDays(query) {
  const all = extentDays(query);
  const lanes = (query?.lanes ?? []).filter((l) => Number.isFinite(l.first?.lo_day) && Number.isFinite(l.last?.hi_day));
  if (!all || lanes.length < 2) return all;
  const firsts = lanes.map((l) => ({ day: l.first.lo_day, est: l.first.basis === 'estimated' })).sort((a, b) => a.day - b.day);
  let i = 0;
  while (i < firsts.length - 1 && firsts[i].est && firsts[i + 1].day - firsts[i].day > OUTLIER_DAYS) i++;
  return [Math.max(all[0], firsts[i].day), all[1]];
}

/**
 * How many lanes the Scroll asks for and draws: the layout's limit (10 desktop, 5 narrow, §1.3), unless the view
 * asks for more on a desktop ("+n more lanes"). The Term trail keeps the limit too (fix pass): model.trailShownLanes
 * keeps its literature and culture lanes on screen and folds the STEMM lanes with the fewest matches.
 * @param {{lanes: {max: number, facet: string}}} view
 * @param {{mode: string, maxLanes: number}} layout
 * @returns {number}
 */
export function laneCap(view, layout) {
  if (layout.mode !== 'narrow' && view.lanes.max > layout.maxLanes) return view.lanes.max;
  return Math.min(view.lanes.max, layout.maxLanes);
}

/** Is a contract version string at least [major, minor]? */
export function contractAtLeast(version, [major, minor]) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  return Boolean(m) && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

/**
 * Extra layout rows: the etymology lane above (L0–L2 or folded), one baseline track per expression strand below.
 * On a Term trail (`trail`) the etymology lane is one of the trail's fixed lanes: it is shown at every tier, and
 * says so when no family exists (§10.5 guardrail 5).
 */
export function extraRows({ families, baselines, tier, folded, layers, trail = false }) {
  const top = [];
  const bottom = [];
  const fam = families.flat();
  if (layers.etymology !== 0 && (trail || (fam.length && (folded || ETYM_TIERS.includes(tier))))) top.push({ key: 'etym', h: fam.length ? etymRowHeight(fam) : ETYM_EMPTY_H });
  if (layers.baseline === 1) for (const b of baselines) bottom.push({ key: `baseline:${b.id}`, h: DEEP.baselineH });
  return { top, bottom };
}

// ── The hub other modules read ──────────────────────────────────────────────────────────────────────

function createHub() {
  const subs = new Set();
  let state = {
    status: 'idle', error: null, query: null, model: null, layout: null, scale: null, tier: null, drawnTier: null,
    scrollY: 0, lanesTop: LANES_TOP, canvasH: 0, playing: false, speed: 1, strandLabels: new Map(), simplified: null,
    focusLane: 0, job: null, dimmed: false, folded: false, arcs: null, extraRows: [],
  };
  let queued = false;
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        for (const fn of [...subs]) { try { fn(state); } catch (err) { console.error('[scrolls] scroll hub subscriber:', err); } }
      });
    },
    subscribe(fn, { immediate = false } = {}) {
      subs.add(fn);
      if (immediate) fn(state);
      return () => subs.delete(fn);
    },
    /** Filled by the mounted Scroll; calls before that are no-ops. */
    actions: {},
  };
}

/**
 * Where Home and End land among a lane's focusable items (sorted left to right): the first or last observation — a bar,
 * a mark, a low-coverage tick, a wash — never a bin that was looked at and found empty (fix pass: Home opened '0 of 0').
 * @param {Array<{style?: string}>} items
 * @param {boolean} first
 * @returns {number} an index into items (0 or the last index when no item is an observation)
 */
export function observationIndex(items, first) {
  const isObservation = (p) => p.style !== 'absent';
  const i = first ? items.findIndex(isObservation) : items.findLastIndex(isObservation);
  return i >= 0 ? i : first ? 0 : Math.max(0, items.length - 1);
}

/** The Scroll's shared state and actions (lanes column, shelves, minimap, legend, toolbar, table, drawer, tour). */
export const scrollHub = createHub();

/**
 * What the Scroll's Esc closes next: the topmost layer first (§8.5 "close panel, clear selection, dismiss coach mark";
 * fix pass: the selection was cleared while its Lineage panel stayed open).
 * @param {{actionSheet?: boolean, arcCard?: boolean, panel?: boolean, selection?: boolean, range?: boolean, folded?: boolean}} open
 * @returns {'actionSheet'|'arcCard'|'panel'|'selection'|'range'|'folded'|null}
 */
export function escapeStep(open) {
  for (const k of ['actionSheet', 'arcCard', 'panel', 'selection', 'range', 'folded']) if (open[k]) return k;
  return null;
}

// ── The Scroll ──────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} el this module's slot in #scroll
 * @param {{store: object, api: object, keys: object, announce: Function, regions: Record<string, HTMLElement>}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys, announce } = ctx;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const cleanups = [];
  const on = (target, evt, fn, opts) => { target.addEventListener(evt, fn, opts); cleanups.push(() => target.removeEventListener(evt, fn, opts)); };

  // ── DOM ──
  const layers = ['bg', 'data', 'arcs', 'overlay'].map((name) => h(`canvas.layer.layer-${name}`, { dataset: { layer: name }, 'aria-hidden': name === 'overlay' ? null : 'true' }));
  const overlay = layers[3];
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-describedby', 'scroll-summary');
  overlay.setAttribute('aria-label', 'The Scroll: expressions over time, by lane');
  const summary = h('p#scroll-summary.visually-hidden');
  const canvasWrap = h('div.scroll-canvas', null, layers);
  const handleLabel = h('span.playhead-label');
  const handle = h('button.playhead-handle', { type: 'button', role: 'slider', 'aria-label': 'Vantage: the reading clock', 'aria-valuemin': String(AXIS_LIMITS.minDay), 'aria-valuemax': String(AXIS_LIMITS.maxDay) },
    h('span.playhead-knob', { 'aria-hidden': 'true' }), handleLabel);
  const pill = h('div.tier-pill', { role: 'status', hidden: true });
  const tip = h('div.scroll-tip', { role: 'tooltip', hidden: true });
  const stateCard = h('div.scroll-state', { hidden: true });
  const marksOption = h('div#scroll-mark-active.visually-hidden', { role: 'option', 'aria-selected': 'true' });
  const marksProxy = h('div.marks-proxy', { tabindex: '0', role: 'listbox', 'aria-label': 'Marks of the focused lane: arrows move, Enter opens',
    'aria-activedescendant': 'scroll-mark-active' }, marksOption);
  const caption = h('span.footer-caption');
  const vantageNote = h('span.footer-vantage');
  const statusNote = h('span.footer-status', { role: 'status' });
  const arcsChip = h('span.chip.footer-arcs', { hidden: true });
  const membersNote = h('span.footer-members', { hidden: true, title: 'The virtual corpus of every real corpus: each counted alone and summed, with its own variants and exclusions' });
  const simplifiedBadge = h('span.chip.footer-simplified', { hidden: true });
  const seamToggle = h('button.chip.footer-seam', { type: 'button', hidden: true, 'aria-pressed': 'false', onClick: () => { seamCollapsed = !seamCollapsed; seamToggle.setAttribute('aria-pressed', String(seamCollapsed)); seamToggle.textContent = seamCollapsed ? 'Show seam caption' : 'Collapse seam to a tick'; invalidate('display'); } }, 'Collapse seam to a tick');
  const foldedExit = h('button.chip.footer-fold', { type: 'button', hidden: true, onClick: () => toggleFolded(false) }, 'Linear axis (D)');
  const footer = h('div.scroll-footer', null, caption, vantageNote, membersNote, arcsChip, simplifiedBadge, seamToggle, foldedExit, statusNote);
  const actionSheet = h('div.scroll-actions', { role: 'menu', hidden: true });
  const arcCard = h('section.arc-card', { role: 'dialog', 'aria-label': 'Evidence card of the link', hidden: true });
  const thumb = h('div.lanes-thumb');
  const scrollbar = h('div.lanes-scrollbar', { hidden: true, 'aria-hidden': 'true' }, thumb);
  const root = h('div.scroll-root', null, canvasWrap, handle, pill, stateCard, tip, actionSheet, arcCard, marksProxy, scrollbar, footer, summary);
  el.appendChild(root);
  const bgL = createLayer(layers[0]), dataL = createLayer(layers[1]), arcsL = createLayer(layers[2]), ovL = createLayer(layers[3]);

  // ── State ──
  let view = store.get().view;
  let layout = store.get().ui.layout ?? layoutFor(win.innerWidth, win.innerHeight);
  let axis = view.axis.mode === 'linear' ? { centerDay: view.axis.centerDay, daysPerPx: view.axis.daysPerPx } : { centerDay: defaultState(view.corpus).axis.centerDay, daysPerPx: defaultState(view.corpus).axis.daysPerPx };
  let width = 0, height = 0;
  let palette = readPalette(doc.documentElement);
  let query = null, qStatus = 'idle', qError = null, qJob = null, qSeq = 0;
  const strandLabels = new Map();
  const strandInfo = new Map();     // expression id → Expression response (surface, lang, claims)
  let built = null;
  let lastDrawn = null;             // { tier } of the last model that had data (kept, dimmed, during a level change)
  let lastGood = null;              // the last built picture with data (kept, dimmed, while a new query's tiles load)
  let scrollY = 0;
  let hover = null;
  let focusLane = 0, focusIndex = -1;
  let seamCollapsed = false;
  let dirty = { model: true, display: true, paint: true, overlay: true };
  let raf = 0;
  let commitTimer = 0;
  let pillTimer = 0;
  let prevDrawnTier = null;
  let reveal = new Map();
  let staggerStart = 0;
  let staggerQuery = null;
  let prevVisibleIds = null;
  let brush = null;                 // { x0, x1 } during a shift-drag on the ruler
  let playTier = null;
  let modelSeq = 0;
  let labelsSeq = 0;
  let autoFitted = false;           // the axis was set by a fit, not by the user: refit when the width changes
  let corpora = null;               // GET /api/corpora (start state)
  let start = { corpus: null, chips: null, error: null };
  let openArc = null;               // { relId, at }
  const clusters = { key: null, data: null };   // GET /api/clusters for the split glyphs (lanes = cluster)
  let queryRetry = 0;               // timer of a query asked again after a 503
  let queryBusy = '';               // the footer's words while it waits to ask again
  let clusterJob = null;            // { id, job, error } of a clustering run started from the not-run card (C1)
  let clusterPoll = 0;
  let buildMs = 0;

  const reduced = () => doc.documentElement.dataset.motion === 'reduce';
  const isFolded = () => view.axis.mode === 'folded';
  const scale = () => createScale({ centerDay: axis.centerDay, daysPerPx: axis.daysPerPx, width: Math.max(1, width) });
  const lanesViewportH = () => Math.max(0, height - LANES_TOP);

  /** Screen geometry: linear (createScale) or folded (fixed regimes); both map days ↔ canvas x. */
  function screen() {
    if (built?.folded) {
      const f = built.folded;
      return { folded: true, width, x: f.xOfDay, day: f.dayOfX, loDay: f.dayOfX(0), hiDay: f.dayOfX(width), centerDay: f.dayOfX(width / 2), daysPerPx: NaN };
    }
    return scale();
  }

  const data = createTilesClient({
    api,
    onChange: () => invalidate('model'),
    onError: (err, what) => {
      if (isAbort(err)) return;
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: `${{ marks: 'Marks', arcs: 'Arcs' }[what] ?? 'Tiles'}: ${err.message}`, hint: err.hint ?? null } });
    },
  });
  const deep = createDeepTimeData({ api, onChange: () => invalidate('model'),
    hasEtymologyEndpoint: () => contractAtLeast(store.get().ui.health?.contract, ETYMOLOGY_CONTRACT) });

  // ── Render loop ──
  function invalidate(level = 'paint') {
    if (level === 'model') dirty.model = dirty.display = dirty.paint = true;
    else if (level === 'display') dirty.display = dirty.paint = true;
    else if (level === 'paint') dirty.paint = true;
    dirty.overlay = true;
    if (!raf) raf = win.requestAnimationFrame(frame);
  }

  function currentTier() {
    if (playTier) return playTier;
    return effectiveTier(tierForDaysPerPx(axis.daysPerPx), view.tier);
  }

  /** Is there something to draw (a ready query, or the corpus listing before any strand is pinned)? */
  const drawable = () => (qStatus === 'ready' && query) || (qStatus === 'start' && corpora);

  function frame() {
    if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
    if (!width || !height) return;
    const t0 = performance.now();
    if (isFolded()) frameFolded(); else frameLinear();
    dirty.model = dirty.display = false;
    buildMs = performance.now() - t0;
    paintFrame();
    hubSync();
    // Fades run only while something is fading; entries of primitives that were never painted expire too. A fade
    // that ends is painted once more at full opacity: a slow frame must never leave marks half-faded (M5 gate: lanes
    // stayed dim at the end of play until the next interaction).
    const now = performance.now();
    const fading = reveal.size > 0 || staggerStart > 0;
    for (const [id, t] of reveal) if (now - t > REVEAL_MS) reveal.delete(id);
    if (staggerStart && now - staggerStart >= STAGGER_MS + REVEAL_MS) staggerStart = 0;
    if (fading) invalidate('paint');
  }

  function frameLinear() {
    const sc = scale();
    const tier = currentTier();
    const visible = [sc.loDay, sc.hiDay];
    const span = sc.hiDay - sc.loDay;
    const range = [sc.loDay - span, sc.hiDay + span];
    if (qStatus === 'ready' && query) {
      const vis = tilesForDays(tier, visible[0], visible[1], 24);
      const pre = tilesForDays(tier, range[0], range[1], 48).filter((t) => !vis.includes(t));
      data.request({ tier, visible: vis, prefetch: pre });
      if (view.layers.arcs !== 0 && view.strands.length) {
        // Below 50 visible years the arcs come one by one (detail=1, C4); above, a summary may answer.
        const w = arcsWindow({ loDay: sc.loDay, hiDay: sc.hiDay }, range);
        data.requestArcs({ fromYear: w.fromYear, toYear: w.toYear, ev: evParam(view.evidence), tier, detail: w.detail, sel: selParam(view.selection),
          // the lanes on screen rank first: folded by the server (other) or by the Scroll (the Term trail's limit)
          lanes: query.other?.lanes ? query.lanes?.map((l) => l.key) ?? null : built?.model?.hiddenLanes ? built.model.lanes.map((l) => l.key) : null,
          saved: arcsAsSaved(store.get().ui.savedView) });
      }
      deep.want({ strands: expressionStrands(), corpus: view.corpus, layers: view.layers, baselineOf: (id) => extrasOf(id)?.baseline ?? null });
      if (view.lanes.facet === 'cluster') loadClusters();
    }
    const needModel = dirty.model || !built || built.folded || built.daysPerPx !== axis.daysPerPx || built.askedTier !== tier
      || sc.loDay < built.range[0] || sc.hiDay > built.range[1];
    if (needModel && drawable()) rebuild(tier, data.tierFor(tier), range, visible);
    else if ((dirty.display || needModel) && built && !built.folded) rebuildDisplay();
  }

  /** Context groups and their transitions for the ⑂/⑃ glyphs (lanes = cluster): the run the lanes were drawn from. */
  function loadClusters() {
    const s = view.strands.find((x) => x.type === 'expression');
    const run = clusterRunOf(query, view.lanes.run ?? null);
    const k = s && query?.lanes?.length ? `${s.id}|${run ?? ''}|${query?.dataVersion ?? ''}` : null;
    if (!k || clusters.key === k) return;
    clusters.key = k;
    clusters.data = null;
    api.get('/clusters', { expr: s.id, run }, { key: 'clusters' })
      .then((res) => { if (clusters.key === k) { clusters.data = res?.gate === 'ok' ? res : null; invalidate('display'); } })
      .catch((err) => { if (!isAbort(err) && clusters.key === k) clusters.data = null; });
  }

  /** The query's extras of one strand (C2: baseline and claims, per strand or for the single strand). */
  function extrasOf(id) {
    const by = query?.strand_extras ?? query?.by_strand ?? null;
    if (by && by[String(id)]) return by[String(id)];
    return expressionStrands().length === 1 ? { baseline: query?.baseline ?? null, claims: query?.claims ?? null } : null;
  }

  /** Claims of a strand: the query's (C2: written in any member corpus) before the Expression's own. */
  function claimsOf(id) {
    const q = extrasOf(id)?.claims;
    if (Array.isArray(q) && q.length) return q;
    return strandInfo.get(String(id))?.claims ?? null;
  }

  function expressionStrands() {
    return view.strands.filter((s) => s.type === 'expression').map((s) => ({ id: s.id, surface: strandInfo.get(String(s.id))?.expression?.surface ?? null }))
      .filter((s) => s.surface);
  }

  /** The model for a tier and range: counted tiles, or the corpus listing before a strand is pinned. */
  function modelFor(tier, range, visible, { marks = data.marks } = {}) {
    if (qStatus === 'start') {
      const c = corpora?.find((x) => x.slug === view.corpus);
      return buildCoverageModel(c?.collections ?? [], { synthetic: Boolean(c?.synthetic), tier });
    }
    const laneLimit = laneCap(view, layout);
    return buildModel({ query, tier, tiles: data.tilesFor(tier), range, visible, strands: view.strands, marks, strandLabels, laneLimit, lanesView: view.lanes });
  }

  const isTrail = () => view.lanes.facet === TRAIL_FACET;

  function layoutFor_(model, tier, folded = false) {
    const rows = extraRows({ families: expressionStrands().map((s) => deep.families(s.id) ?? []), baselines: expressionStrands(), tier, folded, layers: view.layers,
      trail: isTrail() && view.strands.length > 0 });
    return layoutLanes(model.lanes, model.rowCount ?? view.strands.length, { slotH: layout.slotH, moreRow: model.hiddenLanes > 0, fillH: lanesViewportH() - 6,
      top: rows.top, bottom: rows.bottom });
  }

  function rebuild(tier, answeredTier, range, visible) {
    let drawTier = qStatus === 'start' ? tier : answeredTier;
    let dimmed = false;
    if (qStatus !== 'start') {
      // Level change: keep the previous tier (dimmed 40%) until the new tier's visible tiles arrive (§8.3).
      const tiles = data.tilesFor(drawTier);
      const visTiles = tilesForDays(drawTier, visible[0], visible[1], 24);
      if (!visTiles.some((t) => tiles.has(t)) && lastDrawn && lastDrawn.tier !== drawTier) {
        const prev = data.tilesFor(lastDrawn.tier);
        if (tilesForDays(lastDrawn.tier, visible[0], visible[1], 24).some((t) => prev.has(t))) { drawTier = lastDrawn.tier; dimmed = true; }
      }
    }
    let model = modelFor(drawTier, range, visible);
    // A new query (filters, lanes, a resize across breakpoints) has no tiles yet: keep the last picture, dimmed,
    // at the same zoom until the first tile arrives — never a blank Scroll in between (QA finding 8).
    if (qStatus === 'ready' && !model.coverageOnly && !model.loadedTiles.length && lastGood && lastGood.daysPerPx === axis.daysPerPx) {
      built = { ...lastGood, dimmed: true, askedTier: '' };
      return;
    }
    if (model.wantMarks) requestMarksFor(model, range, visible);
    modelSeq++;
    built = { askedTier: tier, drawTier, dimmed, model, layout: layoutFor_(model, drawTier), range, visible, daysPerPx: axis.daysPerPx, originDay: range[0], simplified: null };
    rebuildDisplay();
    // Over budget: step to coarser tiers with a 'simplified' badge (§8.3).
    let guard = 0;
    while (built.display.overBudget && guard++ < 5 && TIER_LEVEL[drawTier] > 0) {
      drawTier = coarserTier(drawTier);
      model = modelFor(drawTier, range, visible, { marks: null });
      modelSeq++;
      built = { ...built, drawTier, model, layout: layoutFor_(model, drawTier), simplified: `Simplified: more than 20,000 shapes — showing ${BIN_ADJECTIVE[drawTier]} bins` };
      rebuildDisplay();
    }
    if (!dimmed && model.loadedTiles.length) { lastDrawn = { tier: drawTier }; lastGood = built; }
    if (prevDrawnTier && prevDrawnTier !== drawTier && !dimmed && qStatus === 'ready') showPill(`Now showing ${BIN_ADJECTIVE[drawTier]} bins`);
    if (!dimmed) prevDrawnTier = drawTier;
    if (query && staggerQuery !== query.queryKey && model.loadedTiles.length) {
      staggerQuery = query.queryKey;
      staggerStart = reduced() ? 0 : performance.now();
    }
    summary.textContent = describeModel(model);
  }

  function requestMarksFor(model, range, visible) {
    const yearOf = (d) => ymdFromDay(Math.floor(d)).y;
    const useRange = model.rangeN <= 4000;
    const [lo, hi] = useRange ? range : visible;
    const fromYear = yearOf(lo) - 1, toYear = yearOf(hi) + 1;
    data.requestMarks({ fromYear, toYear, fromDay: dayFromYMD(fromYear, 1, 1), toDay: dayFromYMD(toYear, 12, 31) });
  }

  /**
   * Deep-time and external-layer primitives for one linear stretch (X maps days to content x). `barriers`: content
   * x of the seams no etymology label may cross (the folded overview's regime seams, the modality seam).
   */
  function extraPrims(model, lay, X, x0, x1, keyPrefix = '', barriers = []) {
    const out = [];
    const strands = expressionStrands();
    const etymRow = lay.extra.etym;
    if (etymRow) {
      const families = strands.flatMap((s) => deep.families(s.id) ?? []);
      const loaded = strands.every((s) => deep.families(s.id) !== null);
      out.push(...etymPrims(families, { row: etymRow, X, firstObservation: firstObservation(model, lay, X), barriers,
        empty: loaded ? NO_FAMILY : 'looking up the etymology…' }).map((p) => ({ ...p, id: `${keyPrefix}${p.id}` })));
    }
    if (view.layers.claims !== 0) {
      for (const s of strands) {
        const claims = claimsOf(s.id);
        if (!claims?.length) continue;
        const lane = model.lanes.find((l) => l.strands.some((r) => String(r.id) === String(s.id) && r.bars.length)) ?? model.lanes[0];
        const li = lane ? lay.lanes.find((l) => l.key === lane.key) : null;
        const row = lane ? lane.strands.findIndex((r) => String(r.id) === String(s.id)) : -1;
        out.push(...claimPrims(claims, { X, slot: li?.slots[Math.max(0, row)] ?? null, key: `${keyPrefix}${s.id}` }));
      }
    }
    for (const s of strands) {
      const row = lay.extra[`baseline:${s.id}`];
      if (!row) continue;
      const glyph = { circle: '●', square: '■', triangle: '▲', diamond: '◆' }[view.strands.find((x) => String(x.id) === String(s.id))?.glyph] ?? '●';
      out.push(...baselinePrims(deep.baseline(s.id), { row, X, x0, x1, glyph, id: `${keyPrefix}bl:${s.id}` }));
    }
    return out;
  }

  /** The first corpus observation of the first strand (where the descent connector lands). */
  function firstObservation(model, lay, X) {
    let best = null;
    for (const lane of model.lanes) {
      const li = lay.lanes.find((l) => l.key === lane.key);
      for (const [si, s] of lane.strands.entries()) {
        const b = s.bars[0];
        if (b && (!best || b.startCap.day < best.day)) best = { day: b.startCap.day, x: X(b.startCap.day), y: li?.slots[si]?.mid ?? 0 };
      }
    }
    return best;
  }

  function rebuildDisplay() {
    if (!built || built.folded) return;
    const contentW = (built.range[1] - built.range[0]) / built.daysPerPx;
    const vantage = view.vantage.day >= VANTAGE_OPEN_DAY ? null : view.vantage;
    const display = buildDisplay(built.model, {
      originDay: built.originDay, daysPerPx: built.daysPerPx, width: contentW, layout: built.layout,
      vantage, layers: view.layers, seams: query?.seams ?? [], seamCollapsed,
    });
    const X = (day) => (day - built.originDay) / built.daysPerPx;
    const seamXs = (query?.seams ?? []).map((sm) => X(dayFromYMD(sm.year, 1, 1)));
    display.lanes.push(...extraPrims(built.model, built.layout, X, 0, contentW, '', seamXs));
    const arcs = qStatus === 'ready' ? data.arcs : null;
    const { prims, stats } = buildArcs(arcs?.data ?? null, { layout: built.layout, X, model: built.model, vantage, layers: view.layers,
      selection: view.selection, tier: built.drawTier, visible: built.visible ? [X(built.visible[0]), X(built.visible[1])] : null });
    display.lanes.push(...prims);
    if (view.lanes.facet === 'cluster' && clusters.data) display.lanes.push(...buildTransitions(clusters.data, { layout: built.layout, X, vantage, lanes: built.model.lanes }));
    built.arcStats = stats;
    built.arcsData = arcs?.data ?? null;
    trackReveal(display.lanes);
    built.display = display;
    built.hitTop = buildHitGrid(display.top, { group: 'top' });
    built.hitLanes = buildHitGrid(display.lanes, { group: 'lanes' });
  }

  /** Fade in what the vantage newly revealed (150 ms), never in reduced motion. */
  function trackReveal(prims) {
    const ids = new Set();
    for (const p of prims) if ((p.layer === 'data' || p.layer === 'arcs') && !p.ghost) ids.add(p.id);
    if (prevVisibleIds && !reduced()) {
      const now = performance.now();
      for (const id of ids) if (!prevVisibleIds.has(id)) reveal.set(id, now);
    }
    prevVisibleIds = ids;
  }

  // ── Folded overview (§1.5): four fixed linear regimes side by side, panning disabled ──
  function frameFolded() {
    const fp = foldedParts(width);
    if (qStatus === 'ready' && query) {
      for (const p of fp.parts) data.request({ tier: p.tier, visible: tilesForDays(p.tier, p.originDay, p.endDay, 64), immediate: true });
      deep.want({ strands: expressionStrands(), corpus: view.corpus, layers: view.layers, baselineOf: (id) => extrasOf(id)?.baseline ?? null });
    }
    if (!drawable()) return;
    if (!dirty.model && !dirty.display && built?.folded && built.width === width) return;
    const vantage = view.vantage.day >= VANTAGE_OPEN_DAY ? null : view.vantage;
    const parts = fp.parts.map((p) => ({ ...p, model: modelFor(p.tier, [p.originDay, p.endDay], [p.originDay, p.endDay], { marks: null }) }));
    const model = parts.find((p) => p.regime.key === 'modern')?.model ?? parts[0].model;
    const lay = layoutFor_(model, 'L2', true);
    const top = [], lanes = [];
    for (const p of parts) {
      const d = buildDisplay(p.model, { originDay: p.originDay, daysPerPx: p.daysPerPx, width: p.x1 - p.x0, layout: lay, vantage, layers: view.layers,
        seams: query?.seams ?? [], seamCollapsed, xOffset: p.x0 });
      const tag = (prim) => ({ ...prim, id: `${p.regime.key}:${prim.id}`, part: p.regime.key });
      p.display = d;
      p.top = d.top.map(tag);
      p.lanes = d.lanes.map(tag);
      p.hitTop = buildHitGrid(p.top, { group: 'top' });
      p.hitLanes = buildHitGrid(p.lanes, { group: 'lanes' });
      top.push(...p.top);
      lanes.push(...p.lanes);
    }
    // Seams: 10 px zig-zags labelled with the ratio of the neighbouring scales (×3.3 · ×8.9 · ×3.3).
    for (const s of fp.folded.seams) {
      const pts = seamZigzag(s.x, 0, LANES_TOP + lay.height);
      top.push({ id: `fs:${s.x}`, kind: 'path', layer: 'bg', style: 'regime-seam', points: pts.filter(([, y]) => y <= LANES_TOP), x0: s.x - SEAM_PX / 2, x1: s.x + SEAM_PX / 2, y0: 0, y1: LANES_TOP, openable: false, ref: { type: 'seam' }, tip: [`seam: the scales differ ${s.label} on either side`] });
      top.push({ id: `fsl:${s.x}`, kind: 'text', layer: 'bg', style: 'regime-label', x0: s.x + 7, y0: GEOM.rulerH + 15, x1: s.x + 7, y1: GEOM.rulerH + 16, text: s.label, openable: false, ref: null });
      lanes.push({ id: `fs2:${s.x}`, kind: 'path', layer: 'bg', style: 'regime-seam', points: seamZigzag(s.x, 0, lay.height), x0: s.x - SEAM_PX / 2, x1: s.x + SEAM_PX / 2, y0: 0, y1: lay.height, openable: false, ref: null });
    }
    // the regime's name on the ruler's top line, above the year labels (fix pass: at y 12 'Deep time' was printed over
    // '5000 BCE', 'Modern' over '1800'; the year labels stay, on their own line)
    for (const p of fp.parts) top.push({ id: `rgl:${p.regime.key}`, kind: 'text', layer: 'bg', style: 'regime-label', x0: p.x0 + 8, y0: REGIME_LABEL_Y, x1: p.x0 + 8, y1: REGIME_LABEL_Y, text: p.regime.label, openable: false, ref: null });
    // Etymology periods, claims and the baseline span regimes: drawn once through the folded geometry.
    const extras = extraPrims(model, lay, (day) => fp.folded.xOfDay(day), 0, width, 'fx:', fp.folded.seams.map((sm) => sm.x));
    lanes.push(...extras);
    modelSeq++;
    built = { folded: fp.folded, parts, width, model, layout: lay, drawTier: 'L2', dimmed: false, extras, extrasHit: buildHitGrid(extras, { group: 'lanes' }),
      display: { top, lanes, stats: { rects: 0, ticks: 0, texts: 0, marks: 0 } }, simplified: null };
    summary.textContent = `Folded overview of all time (four fixed linear regimes). ${describeModel(model)}`;
  }

  function alphaOf(p) {
    let a = built?.dimmed ? 0.4 : 1;
    const now = performance.now();
    if (staggerStart && p.layer === 'data' && !built?.folded) {
      const x = p.x0 + (built.originDay - scale().loDay) / built.daysPerPx;
      const delay = Math.max(0, Math.min(1, x / Math.max(1, width))) * STAGGER_MS;
      a *= Math.max(0, Math.min(1, (now - staggerStart - delay) / REVEAL_MS));
      if (now - staggerStart > STAGGER_MS + REVEAL_MS) staggerStart = 0;
    }
    const r = reveal.get(p.id);
    if (r !== undefined) {
      const k = (now - r) / REVEAL_MS;
      if (k >= 1) reveal.delete(p.id); else a *= Math.max(0, k);
    }
    return a;
  }

  /** Paint the dirty layers, timing them for the perf HUD (§8.3 budgets: layers ≤ 8 ms, overlay ≤ 2 ms). */
  function paintFrame() {
    palette = palette ?? readPalette(doc.documentElement);
    if (dirty.paint) {
      dirty.paint = false;
      const tL = performance.now();
      const ctxBg = bgL.begin(palette);
      dataL.begin(palette);
      arcsL.begin(palette);
      ctxBg.fillStyle = palette['bg-0'];
      ctxBg.fillRect(0, 0, width, height);
      // Ruler and coverage-track grounds.
      ctxBg.fillStyle = palette['bg-1'];
      ctxBg.fillRect(0, 0, width, GEOM.rulerH);
      ctxBg.fillStyle = palette['bg-0'];
      ctxBg.fillRect(0, GEOM.rulerH, width, GEOM.coverageH);
      ctxBg.fillStyle = palette.rule;
      ctxBg.fillRect(0, GEOM.rulerH - 1, width, 1);
      ctxBg.fillRect(0, LANES_TOP - 1, width, 1);
      const clipLanes = [0, LANES_TOP, width, height - LANES_TOP];
      const ty = LANES_TOP - scrollY;
      if (built?.folded) {
        for (const p of built.parts) {
          const clipTop = [p.x0, 0, p.x1 - p.x0, LANES_TOP];
          const clip = [p.x0, LANES_TOP, p.x1 - p.x0, height - LANES_TOP];
          paintList(bgL, p.top, { clip: clipTop, palette, layerName: 'bg' });
          paintList(bgL, p.lanes, { ty, clip, palette, layerName: 'bg' });
          paintList(dataL, p.lanes, { ty, clip, palette, layerName: 'data' });
        }
        paintList(bgL, built.extras, { ty, clip: clipLanes, palette, layerName: 'bg' });
        paintList(dataL, built.extras, { ty, clip: clipLanes, palette, layerName: 'data' });
        paintList(bgL, built.display.top.filter((x) => x.style === 'regime-seam' || x.style === 'regime-label'), { palette });
        paintList(bgL, built.display.lanes.filter((x) => x.style === 'regime-seam'), { ty, clip: clipLanes, palette });
      } else if (built?.display) {
        const tx = (built.originDay - scale().loDay) / built.daysPerPx;
        paintList(bgL, built.display.top, { tx, ty: 0, clip: [0, 0, width, LANES_TOP], palette, layerName: 'bg' });
        paintList(bgL, built.display.lanes, { tx, ty, clip: clipLanes, palette, layerName: 'bg', alphaOf: built.dimmed ? () => 0.4 : null });
        paintList(dataL, built.display.lanes, { tx, ty, clip: clipLanes, palette, layerName: 'data', alphaOf });
        paintList(arcsL, built.display.lanes, { tx, ty, clip: clipLanes, palette, layerName: 'arcs', alphaOf });
      } else if (qStatus !== 'ready') {
        paintSkeleton(dataL.ctx);
      }
      if (built?.layout?.more) {
        const c = dataL.ctx;
        c.save();
        c.fillStyle = withAlpha(palette.ink, 0.04);
        c.fillRect(0, LANES_TOP - scrollY + built.layout.more.y, width, built.layout.more.h);
        c.restore();
      }
      perf.record('paint', performance.now() - tL, { build: buildMs, shapes: built?.display?.stats ?? null });
    }
    if (dirty.overlay) {
      dirty.overlay = false;
      const tO = performance.now();
      paintOverlay();
      perf.record('overlay', performance.now() - tO);
    }
    positionHandle();
    positionScrollbar();
    positionArcCard();
  }

  function paintSkeleton(c) {
    const n = Math.min(layout.maxLanes, 6);
    for (let i = 0; i < n; i++) {
      const y = LANES_TOP + i * GEOM.laneMinH;
      c.fillStyle = i % 2 ? palette['bg-1'] : palette['bg-0'];
      c.fillRect(0, y, width, GEOM.laneMinH);
      c.fillStyle = withAlpha(palette.ink, 0.06);
      const x = ((i * 0.13 + 0.1) % 0.7) * width;
      c.fillRect(x, y + GEOM.laneMinH / 2 - 3, width * 0.22, 6);
    }
  }

  /** A primitive's box in canvas coordinates. */
  function screenPrim(p, group) {
    const tx = built?.folded ? 0 : (built.originDay - scale().loDay) / built.daysPerPx;
    const ty = group === 'top' ? 0 : LANES_TOP - scrollY;
    return { x0: p.x0 + tx, x1: p.x1 + tx, y0: p.y0 + ty, y1: p.y1 + ty };
  }

  function findPrim(match) {
    if (!built?.display) return null;
    for (const p of built.display.lanes) if (p.ref && match(p)) return p;
    return null;
  }

  function selectedPrim() {
    const sel = view.selection;
    if (!sel || !built) return null;
    if (sel.type === 'bin') {
      const b = parseBinId(sel.id);
      return b ? findPrim((p) => p.ref.type === 'bin' && p.kind !== 'glyph' && p.ref.lane === b.lane && String(p.ref.strand) === b.strand && p.ref.bin === b.bin && p.ref.tier === b.tier && !p.style?.startsWith('cap')) : null;
    }
    if (sel.type === 'occurrence') return findPrim((p) => p.ref.type === 'occurrence' && p.ref.id === sel.id);
    if (sel.type === 'passage') return findPrim((p) => p.ref.type === 'occurrence' && p.ref.passage === sel.id);
    if (sel.type === 'relationship') return findPrim((p) => p.ref.type === 'relationship' && p.ref.id === sel.id && p.kind === 'path');
    return null;
  }

  function paintOverlay() {
    const c = ovL.begin(palette);
    const sc = screen();
    const v = view.vantage;
    // The vantage: later time is veiled; the cyan playhead line.
    if (v.day < VANTAGE_OPEN_DAY) {
      const x = sc.x(v.day + 1);
      if (x < width) {
        c.fillStyle = withAlpha(palette['bg-0'], v.strict ? 0.22 : 0.12);
        c.fillRect(Math.max(0, x), LANES_TOP, width - Math.max(0, x), height - LANES_TOP);
      }
      if (x >= 0 && x <= width) {
        c.fillStyle = withAlpha(palette.cyan, 0.18);
        c.fillRect(Math.round(x) - 3, 0, 6, height);
        c.fillStyle = palette.cyan;
        c.fillRect(Math.round(x) - 1, 0, 2, height);
      }
    }
    if (brush || view.range) {
      const [a, b] = brush ? [Math.min(brush.x0, brush.x1), Math.max(brush.x0, brush.x1)] : [sc.x(view.range[0]), sc.x(view.range[1] + 1)];
      c.fillStyle = withAlpha(palette.cyan, 0.10);
      c.fillRect(a, 0, b - a, height);
      c.fillStyle = palette.cyan;
      c.fillRect(Math.round(a), 0, 1, height);
      c.fillRect(Math.round(b), 0, 1, height);
    }
    if (!built?.display) return;
    const ring = (p, group, color, halo) => {
      c.save();
      c.beginPath();
      c.rect(0, LANES_TOP, width, height - LANES_TOP);
      c.clip();
      if (p.kind === 'path' && p.ref?.type === 'relationship') {
        const r = screenPrim({ ...p, x0: 0, x1: 0, y0: 0, y1: 0 }, group);
        c.translate(r.x0, r.y0);
        if (halo) { c.strokeStyle = withAlpha(palette.cyan, 0.2); c.lineWidth = 6; strokeArc(c, p); }
        c.strokeStyle = color; c.lineWidth = 2; strokeArc(c, p);
        c.restore();
        return;
      }
      const r = screenPrim(p, group);
      const pad = p.kind === 'glyph' ? 7 : 2;
      const x0 = (p.kind === 'glyph' ? r.x0 - 6 : r.x0) - pad + 1, y0 = (p.kind === 'glyph' ? r.y0 - 6 : r.y0) - pad + 1;
      const w = (p.kind === 'glyph' ? 12 : Math.max(2, r.x1 - r.x0)) + 2 * pad - 2, hh = (p.kind === 'glyph' ? 12 : Math.max(2, r.y1 - r.y0)) + 2 * pad - 2;
      if (halo) { c.strokeStyle = withAlpha(palette.cyan, 0.2); c.lineWidth = 6; c.strokeRect(x0, y0, w, hh); }
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.strokeRect(x0, y0, w, hh);
      c.restore();
    };
    if (hover?.prim && hover.group === 'lanes' && hover.openable) ring(hover.prim, 'lanes', withAlpha(palette.ink, 0.7), false);
    const sel = selectedPrim();
    if (sel) ring(sel, 'lanes', palette.cyan, true);
    const f = focusedItem();
    if (f && doc.activeElement === marksProxy) ring(f, 'lanes', palette.cyan, false);
  }

  function strokeArc(c, p) {
    c.beginPath();
    if (p.p0 && p.p1 && Number.isFinite(p.cx)) { c.moveTo(p.p0[0], p.p0[1]); c.quadraticCurveTo(p.cx, p.cy, p.p1[0], p.p1[1]); } else p.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
  }

  /** A thin scrollbar on the right of the lanes when they overflow (the canvas wheel zooms, so it is shown). */
  function positionScrollbar() {
    const total = (built?.layout?.height ?? 0) + 8;
    const vh = lanesViewportH();
    const over = total > vh + 1;
    scrollbar.hidden = !over;
    if (!over) return;
    const h0 = Math.max(24, (vh / total) * vh);
    thumb.style.height = `${Math.round(h0)}px`;
    thumb.style.transform = `translateY(${Math.round((scrollY / (total - vh)) * (vh - h0))}px)`;
  }

  function positionHandle() {
    const v = view.vantage;
    const open = v.day >= VANTAGE_OPEN_DAY;
    const x = open ? NaN : screen().x(v.day + 1);
    handle.hidden = open || !(x >= -20 && x <= width + 20);
    const precision = { L4: 'month', L5: 'day' }[built?.drawTier ?? currentTier()] ?? 'year';
    const text = open ? 'as of: no limit' : `as of ${dayLabel(v.day, precision)}`;
    handleLabel.textContent = text;
    handle.classList.toggle('label-left', x > width - 120);
    handle.setAttribute('aria-valuenow', String(v.day));
    handle.setAttribute('aria-valuetext', `${text} · ${v.strict ? 'strict: later evidence hidden' : 'context: later evidence ghosted'}`);
    if (!handle.hidden) handle.style.transform = `translateX(${Math.round(x)}px)`;
  }

  // ── Hub ──
  let lastSig = '';
  function hubSync(force = false) {
    if (force) lastSig = '';
    const model = built?.model ?? null;
    const sc = screen();
    if (built?.folded) {
      caption.textContent = built.parts.map((p) => `${p.regime.label}: ${regimeScale(p.regime)}`).join(' · ');
    } else {
      caption.textContent = binCaption(built?.drawTier ?? currentTier(), axis.daysPerPx) + (built?.drawTier && built.drawTier !== currentTier() && !built.dimmed ? ` (the server answered with ${BIN_ADJECTIVE[built.drawTier]} bins)` : '');
    }
    caption.title = caption.textContent;   // the footer's sentences shrink with an ellipsis; each keeps its whole text here
    const v = view.vantage;
    vantageNote.textContent = v.day >= VANTAGE_OPEN_DAY ? '' : `as of ${dayLabel(v.day)} · ${v.strict ? 'strict: later observations hidden (V shows them ghosted)' : 'context: later observations ghosted (V hides them)'}`;
    vantageNote.title = vantageNote.textContent;
    simplifiedBadge.hidden = !built?.simplified;
    simplifiedBadge.textContent = built?.simplified ?? '';
    seamToggle.hidden = !(query?.seams?.length) || Boolean(built?.folded);
    foldedExit.hidden = !built?.folded;
    // C2: a view over every real corpus names its members (the demo is never one).
    const members = view.corpus === REAL_CORPUS && Array.isArray(query?.provenance?.corpora) ? query.provenance.corpora : null;
    membersNote.hidden = !members?.length;
    membersNote.textContent = members?.length ? `all real corpora: ${members.join(' + ')} · never the demo` : '';
    const note = arcsNote(built?.arcsData ?? null, built?.arcStats ?? null);
    arcsChip.hidden = !note;
    arcsChip.textContent = note;
    arcsChip.title = note;   // the whole sentence when the footer is too narrow for it
    statusNote.textContent = queryBusy || (data.loading ? 'loading tiles…' : model && !model.complete ? 'some tiles not loaded' : '');
    // Publish only when something other modules read has changed (frames run while fading).
    const sig = [qStatus, query?.queryKey, query?.dataVersion, query === null, modelSeq, scrollY, currentTier(), built?.drawTier, Math.round(sc.loDay),
      Math.round(sc.hiDay), width, height, built?.simplified, focusLane, built?.dimmed, labelsSeq, qError?.message, Boolean(built?.folded)].join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    scrollHub.set({
      status: qStatus, error: qError, query, model, layout: built?.layout ?? null, scale: sc, tier: currentTier(), drawnTier: built?.drawTier ?? null,
      scrollY, lanesTop: LANES_TOP, canvasH: height, strandLabels, labelsSeq, simplified: built?.simplified ?? null, focusLane, job: qJob,
      dimmed: Boolean(built?.dimmed), axis: { ...axis }, width, folded: Boolean(built?.folded), arcs: built?.arcsData ?? null,
      corpusCollections: qStatus === 'start' ? (corpora?.find((c) => c.slug === view.corpus)?.collections ?? null) : null,
    });
  }

  // ── Query ──
  function requery(attempt = 0) {
    const seq = ++qSeq;
    win.clearTimeout(queryRetry);
    if (view.lanes.facet !== 'cluster' && clusterJob) { clusterJob = null; win.clearTimeout(clusterPoll); }
    if (built) built.dimmed = true;   // the old picture stays (dimmed) until the new one is ready: no blank frames
    closeArcCard();
    if (!view.strands.length) { enterStart(seq); return; }
    const laneMax = laneCap(view, layout);
    const saved = store.get().ui.savedView;
    const body = queryBody(view, { maxLanes: laneMax, formatFilter, cutoffs: saved?.asSaved ? saved.cutoffs ?? null : null });
    qStatus = 'loading';
    qError = null;
    showState();
    invalidate('model');
    api.post('/timeline/query', body, { key: 'timeline-query' }).then((res) => {
      if (seq !== qSeq) return;
      queryBusy = '';
      query = res;
      qJob = res.job ?? null;
      qStatus = res.status === 'ready' ? 'ready' : res.status === 'materializing' || res.status === 'pending' ? 'materializing' : res.status;
      data.setQuery(res.queryKey, res.dataVersion);
      lastDrawn = null;
      prevVisibleIds = null;
      if (qStatus === 'ready') built = null;
      fitIfDefaultAxis();
      showState();
      invalidate('model');
      const groups = view.lanes.facet === 'cluster' ? clusterLanesLine(res) : '';
      announce(qStatus === 'ready' ? `Timeline ready: ${groups || `${res.lanes.length} lanes`}, ${totalsText(res.totals)}.` : 'Counting the expression in the corpus.');
    }).catch((err) => {
      if (isAbort(err) || seq !== qSeq) return;
      // A busy read pool (503 QUERY_TIMEOUT) usually clears: ask again twice, later, before showing the error (as tiles do).
      if (err?.status === 503 && attempt < RETRIES.length) {
        queryBusy = `the server is busy: asking again (${attempt + 2} of ${RETRIES.length + 1})…`;
        hubSync(true);
        queryRetry = win.setTimeout(() => { if (seq === qSeq) requery(attempt + 1); }, RETRIES[attempt]);
        return;
      }
      queryBusy = '';
      qStatus = 'error';
      qError = { code: err.code, message: err.message, hint: err.hint ?? null };
      showState();
      invalidate('paint');
    });
  }

  /** No strand pinned: never ask the server for a zero-strand query; show the collections and the start card. */
  function enterStart(seq) {
    qStatus = 'start';
    qError = null;
    query = null;
    data.setQuery(null);
    api.abort?.('timeline-query');
    const corpus = view.corpus;
    const ready = () => { if (seq !== qSeq) return; built = null; showState(); invalidate('model'); };
    if (corpora) ready();
    else api.get('/corpora', null, { key: 'corpora-scroll' }).then((list) => { corpora = Array.isArray(list) ? list : []; ready(); })
      .catch((err) => { if (!isAbort(err)) { corpora = []; ready(); } });
    if (start.corpus !== corpus) {
      start = { corpus, chips: null, error: null };
      const progress = (chips) => { if (start.corpus === corpus) { start.partial = chips; showState(); } };
      startChips(api, corpus, { onChip: progress }).then((chips) => { if (start.corpus === corpus) { start.chips = chips; showState(); } })
        .catch((err) => { if (!isAbort(err) && start.corpus === corpus) { start.chips = []; start.error = err.message; showState(); } });
    }
    showState();
  }

  function loadStrandLabels() {
    for (const s of view.strands) {
      const ref = String(s.id);
      if (strandLabels.has(ref)) continue;
      if (s.type !== 'expression') { strandLabels.set(ref, s.type === 'theme' ? `${s.id} (theme)` : String(s.id)); continue; }
      strandLabels.set(ref, `expression ${s.id}`);
      api.get(`/expressions/${encodeURIComponent(s.id)}`).then((res) => {
        strandInfo.set(ref, res);
        if (res?.expression?.surface) { strandLabels.set(ref, res.expression.surface); labelsSeq++; invalidate('model'); }
      }).catch(() => { /* the numeric label stays */ });
    }
  }

  function showState() {
    clear(stateCard);
    stateCard.hidden = true;
    stateCard.dataset.kind = '';
    if (qStatus === 'error' && qError) {
      stateCard.hidden = false;
      stateCard.dataset.kind = 'error';
      stateCard.append(...[
        h('p.state-title', null, qError.message),
        qError.hint ? h('p.state-hint', null, qError.hint) : null,
        h('button.btn', { type: 'button', onClick: () => requery() }, 'Retry')].filter(Boolean));
    } else if (qStatus === 'materializing') {
      const job = qJob ? store.get().ui.jobs?.[qJob] : null;
      const pct = Math.round((job?.progress ?? 0) * 100);
      stateCard.hidden = false;
      stateCard.dataset.kind = 'loading';
      stateCard.append(h('p.state-title', null, `counting… ${pct}%`),
        h('p.state-hint', null, job?.message ?? 'Counting every occurrence and its date before anything is drawn.'));
    } else if (qStatus === 'start') {
      stateCard.hidden = false;
      stateCard.dataset.kind = 'start';
      stateCard.append(renderStartCard({ corpus: view.corpus, chips: start.chips ?? start.partial ?? null, pending: start.chips === null, error: start.error,
        onChip: (chip) => chipAction(ctx, chip).catch((err) => { if (!isAbort(err)) store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message, hint: err.hint ?? null } }); }),
        onSearch: () => store.dispatch({ type: 'UI_SET', key: 'focusSearch', value: Date.now() }) }));
    } else if (qStatus === 'ready' && query && ['not_run', 'gated'].includes(clusterLaneState(query, view.lanes.facet).kind)) {
      stateCard.hidden = false;
      stateCard.dataset.kind = 'cluster';
      stateCard.append(clusterCard(clusterLaneState(query, view.lanes.facet)));
    } else if (qStatus === 'ready' && query && !query.lanes?.length) {
      stateCard.hidden = false;
      stateCard.dataset.kind = 'empty';
      stateCard.append(h('p.state-title', null, 'No lanes for this query'),
        h('p.state-hint', null, `0 matches with these filters (${formatFilter(view.f) || 'no filter'}). 0 is an observation about this index, not about culture.`));
    }
  }

  /**
   * The card of a cluster-facet query without lanes (C1): no run yet → offer the run (POST /api/analysis/runs with
   * the server's suggestion) and follow its job; gated → the gate card (gate, needed, have, suggestion — no value).
   */
  function clusterCard(st) {
    const job = clusterJob?.job ?? (clusterJob?.id ? store.get().ui.jobs?.[clusterJob.id] ?? null : null);
    return renderClusterCard(st, { label: strandLabels.get(String(view.strands[0]?.id)) ?? 'this expression', job, started: Boolean(clusterJob),
      error: clusterJob?.error ?? null, onRun: () => runClustering(st.run),
      onBack: () => store.dispatch({ type: 'SET_LANES', lanes: { facet: 'language', run: null } }) });
  }

  async function runClustering(run) {
    clusterJob = { id: null, job: null, error: null };
    showState();
    try {
      const res = await api.post('/analysis/runs', run);
      clusterJob = { id: res?.job?.id ?? null, job: null, error: null };
      if (res?.reused || !clusterJob.id) { clusterJob = null; requery(); return; }
      announce('Clustering started.');
      pollClusterJob();
    } catch (err) {
      if (isAbort(err)) return;
      clusterJob = { id: null, job: null, error: err.message };
    }
    showState();
  }

  /** Follow the clustering job (the shared job events update ui.jobs too; this also covers a missed event). */
  function pollClusterJob() {
    win.clearTimeout(clusterPoll);
    if (!clusterJob?.id) return;
    clusterPoll = win.setTimeout(() => {
      api.get(`/jobs/${clusterJob.id}`, null, { key: 'cluster-job' }).then((job) => { if (clusterJob?.id === job?.id) onClusterJob(job); })
        .catch((err) => { if (!isAbort(err)) pollClusterJob(); });
    }, 2000);
  }

  function onClusterJob(job) {
    if (!clusterJob || !job) return;
    clusterJob.job = job;
    if (job.status === 'succeeded') { clusterJob = null; win.clearTimeout(clusterPoll); requery(); return; }
    if (['failed', 'cancelled', 'interrupted'].includes(job.status)) { win.clearTimeout(clusterPoll); showState(); return; }
    showState();
    pollClusterJob();
  }

  // ── Interaction helpers ──
  function setAxis(next, { commit = true, auto = false } = {}) {
    if (!auto) autoFitted = false;
    const a = clampAxis(next, width);
    if (a.centerDay === axis.centerDay && a.daysPerPx === axis.daysPerPx) return;
    const zoomed = a.daysPerPx !== axis.daysPerPx;
    axis = a;
    if (zoomed && playing()) player.pause();
    hideTip();
    invalidate(zoomed ? 'display' : 'paint');
    if (commit) scheduleCommit();
  }

  function scheduleCommit(ms = 180) {
    win.clearTimeout(commitTimer);
    commitTimer = win.setTimeout(() => {
      const cur = store.get().view.axis;
      if (cur.mode === 'linear' && Math.round(axis.centerDay) === cur.centerDay && Number(axis.daysPerPx.toPrecision(6)) === cur.daysPerPx) return;
      store.dispatch({ type: 'SET_AXIS', axis: { mode: 'linear', centerDay: axis.centerDay, daysPerPx: axis.daysPerPx } });
    }, ms);
  }

  function zoomBy(factor, x = null) {
    if (isFolded()) { if (factor > 1) unfoldAt(x ?? width / 2); return; }
    // Zooming out past 0.05 px/year folds the axis unless "keep linear" is set (§1.5).
    if (factor < 1 && axis.daysPerPx >= AXIS_LIMITS.maxDaysPerPx * 0.999 && !view.axis.keepLinear) { toggleFolded(true); return; }
    const sc = scale();
    let ax = x;
    if (ax === null) {
      const vx = sc.x(view.vantage.day + 1);
      ax = view.vantage.day < VANTAGE_OPEN_DAY && vx >= 0 && vx <= width ? vx : width / 2;
    }
    setAxis(zoomAxis(axis, width, ax, factor));
  }

  function zoomToTier(tier, x = null) {
    if (isFolded()) { unfoldAt(x ?? width / 2, daysPerPxForTier(tier)); return; }
    zoomBy(axis.daysPerPx / daysPerPxForTier(tier), x);
  }

  function fit() {
    const ext = extentDays(query) ?? coverageExtent();
    if (!ext) return;
    if (isFolded()) toggleFolded(false);
    setAxis(fitAxis(ext[0], ext[1], width), { auto: true });
    autoFitted = true;
  }

  function coverageExtent() {
    const lanes = built?.model?.coverageOnly ? built.model.lanes.filter((l) => l.span) : [];
    if (!lanes.length) return null;
    return [Math.min(...lanes.map((l) => l.span.loDay)), Math.max(...lanes.map((l) => l.span.hiDay))];
  }

  /** An untouched view (the corpus's default axis) opens on the data's extent at any screen width. */
  function fitIfDefaultAxis() {
    const v = store.get().view;
    const d = defaultState(v.corpus).axis;
    if (!width || v.axis.mode !== 'linear') return;
    const isDefault = v.axis.centerDay === d.centerDay && v.axis.daysPerPx === d.daysPerPx;
    if (!isDefault && !autoFitted) return;
    const ext = bulkExtentDays(query);
    if (ext) { setAxis(fitAxis(ext[0], ext[1], width), { auto: true }); autoFitted = true; }
  }

  function centerOn(day) {
    if (isFolded()) return;
    setAxis({ centerDay: day, daysPerPx: axis.daysPerPx });
  }

  function setScrollY(y) {
    const max = Math.max(0, (built?.layout?.height ?? 0) - lanesViewportH() + 8);
    const next = Math.max(0, Math.min(max, y));
    if (next === scrollY) return;
    scrollY = next;
    invalidate('paint');
  }

  function showPill(text) {
    pill.textContent = text;
    pill.hidden = false;
    pill.classList.toggle('is-static', reduced());
    announce(text);
    win.clearTimeout(pillTimer);
    pillTimer = win.setTimeout(() => { pill.hidden = true; }, PILL_MS);
  }

  /** The folded deep-time overview ↔ linear (D, the Deep-time button). */
  function toggleFolded(force) {
    const want = force ?? !isFolded();
    if (want === isFolded()) return;
    if (want) {
      if (playing()) player.pause();
      store.dispatch({ type: 'SET_AXIS', axis: { mode: 'folded' } });
      showPill('Folded overview: four fixed linear regimes · panning off · click a regime to unfold');
    } else {
      store.dispatch({ type: 'SET_AXIS', axis: { mode: 'linear', centerDay: axis.centerDay, daysPerPx: axis.daysPerPx } });
    }
  }

  /** Unfold to a linear axis centred on the day under `x`, at that regime's own scale (or `dpp`). */
  function unfoldAt(x, dpp = null) {
    if (!built?.folded) { toggleFolded(false); return; }
    const part = built.parts.find((p) => x >= p.x0 && x < p.x1) ?? built.parts[built.parts.length - 1];
    const day = built.folded.dayOfX(x);
    const daysPerPx = dpp ?? part.daysPerPx;
    axis = clampAxis({ centerDay: day, daysPerPx });
    store.dispatch({ type: 'SET_AXIS', axis: { mode: 'linear', centerDay: axis.centerDay, daysPerPx: axis.daysPerPx } });
    const yrs = axis.daysPerPx / 365.2425;
    store.dispatch({ type: 'UI_TOAST', toast: { kind: 'note', text: `Linear axis · 1 px = ${yrs >= 1 ? `${formatNumber(yrs, 2)} yr` : `${formatNumber(yrs, 2)} yr`}` } });
  }

  function hitAt(x, y, tol = TOLERANCE.mouse) {
    if (!built?.display) return null;
    if (built.folded) {
      const p = built.parts.find((q) => x >= q.x0 && x < q.x1);
      if (!p) return null;
      if (y < LANES_TOP) return p.hitTop.query(x, y, tol);
      return p.hitLanes.query(x, y - LANES_TOP + scrollY, tol) ?? built.extrasHit.query(x, y - LANES_TOP + scrollY, tol);
    }
    const tx = (built.originDay - scale().loDay) / built.daysPerPx;
    if (y < LANES_TOP) return built.hitTop.query(x - tx, y, tol);
    return built.hitLanes.query(x - tx, y - LANES_TOP + scrollY, tol);
  }

  function hideTip() { tip.hidden = true; }

  function showTip(entry, x, y) {
    if (!entry?.tip?.length) { hideTip(); return; }
    clear(tip);
    const lines = [...entry.tip];
    // The bar summary (§1.2 item 9) under an observed bin's own numbers.
    let summaryAt = -1;
    if (entry.ref?.type === 'bin' && built?.model) {
      const lane = built.model.lanes.find((l) => l.key === entry.ref.lane);
      const strand = lane?.strands.find((s) => s.ref === String(entry.ref.strand));
      if (lane && strand && strand.cols.state[entry.ref.i] === STATE.observed) {
        summaryAt = lines.length;
        lines.push(strandSummary(lane, strand, { tier: built.drawTier, formatTokens, unitLabel }));
      }
    }
    lines.forEach((l, i) => tip.append(h(i === 0 ? 'p.tip-head' : i === summaryAt ? 'p.tip-line.tip-summary' : 'p.tip-line', null, l)));
    if (entry.openable && !entry.tip.some((l) => /^Click/.test(l))) {
      tip.append(h('p.tip-action', null, entry.ref?.type === 'occurrence' ? 'Click to read the passage' : entry.ref?.type === 'wash' ? 'Click to list these records' : 'Click to list the passages in this bin'));
    }
    tip.hidden = false;
    const tw = tip.offsetWidth || 280, th = tip.offsetHeight || 60;
    const left = Math.min(Math.max(8, x + 14), Math.max(8, width - tw - 8));
    const top = y + 18 + th > height ? Math.max(4, y - th - 12) : y + 18;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function open(entry, at = null) {
    if (!entry?.openable || !entry.ref) return;
    const ref = entry.ref;
    if (ref.type === 'bin') {
      store.dispatch({ type: 'SELECT', selection: { type: 'bin', id: binId(ref) } });
    } else if (ref.type === 'occurrence') {
      // The inspector resolves an occurrence to its passage through ui.selectionContext (panels/inspector.mjs).
      if (Number.isInteger(ref.passage)) store.dispatch({ type: 'UI_SET', key: 'selectionContext', value: { occ: Number.isInteger(ref.id) ? ref.id : null, passage: ref.passage } });
      store.dispatch({ type: 'SELECT', selection: Number.isInteger(ref.id) ? { type: 'occurrence', id: ref.id } : { type: 'passage', id: ref.passage } });
      store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' });
    } else if (ref.type === 'wash') {
      store.dispatch({ type: 'UI_SET', key: 'drawer', value: { kind: 'shelf', which: 'washes', lane: ref.lane, strand: ref.strand, title: `Records dated ${ref.label}` } });
    } else if (ref.type === 'relationship') {
      store.dispatch({ type: 'SELECT', selection: { type: 'relationship', id: ref.id } });
      openArcCard(ref, at);
    } else if (ref.type === 'cell') {
      // An OpenAlex cell (C3): its passages, with the cell's k of n on top.
      const lane = built?.model?.lanes.find((l) => l.key === ref.lane);
      const strand = lane?.strands.find((x) => x.ref === String(ref.strand));
      store.dispatch({ type: 'UI_SET', key: 'drawer', value: { kind: 'cell', lane: ref.lane, strand: ref.strand, from: ref.lo, to: ref.hi, k: ref.k, n: ref.n,
        expr: strand?.type === 'expression' ? strand.id : null, title: `${ref.lo}–${ref.hi} · ${lane?.label ?? ref.lane}${strand ? ` · ${strand.label}` : ''}` } });
    } else if (ref.type === 'ribbon') {
      // A summarised stretch of links (C4): zoom in until each link is drawn on its own (below 50 years).
      const pad = Math.max(365, (ref.hiDay - ref.loDay) * 0.6);
      setAxis(fitAxis(ref.loDay - pad, ref.hiDay + pad, width));
    }
  }

  // ── The evidence card of an arc (edge card of panels/edge-card.mjs, WP7) ──
  function openArcCard(ref, at = null) {
    closeArcCard();
    const card = createEdgeCard({
      api, relId: ref.id, announce,
      onOpenPassage: (id) => { store.dispatch({ type: 'SELECT', selection: { type: 'passage', id } }); store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' }); },
    });
    const lineageRoot = Number.isInteger(ref.dst?.passage) ? `passage:${ref.dst.passage}` : Number.isInteger(ref.dst?.doc) ? `document:${ref.dst.doc}` : null;
    arcCard.append(...[
      h('div.arc-card-head', null, h('h2.arc-card-title', null, 'Evidence for this link'),
        h('button.btn.arc-card-close', { type: 'button', 'aria-label': 'Close the evidence card', onClick: () => { closeArcCard(); if (view.selection?.type === 'relationship') store.dispatch({ type: 'SELECT', selection: null }); } }, '×')),
      card.el,
      lineageRoot ? h('div.arc-card-foot', null, h('button.btn', { type: 'button', onClick: () => { store.dispatch({ type: 'SET_LINEAGE', lineage: { root: lineageRoot } }); store.dispatch({ type: 'OPEN_PANEL', panel: 'lineage' }); } }, 'Open lineage (G)')) : null].filter(Boolean));
    arcCard.hidden = false;
    openArc = { relId: ref.id, at };
    positionArcCard();
  }

  function closeArcCard() {
    if (!openArc && arcCard.hidden) return;
    openArc = null;
    clear(arcCard);
    arcCard.hidden = true;
  }

  function positionArcCard() {
    if (!openArc || arcCard.hidden) return;
    const w = Math.min(380, width - 16);
    arcCard.style.width = `${w}px`;
    const p = selectedPrim();
    let x = openArc.at?.[0] ?? width - w - 8, y = openArc.at?.[1] ?? LANES_TOP + 8;
    if (p?.ref?.type === 'relationship') {
      const r = screenPrim(p, 'lanes');
      x = (r.x0 + r.x1) / 2; y = r.y1 + 8;
    }
    const left = Math.max(8, Math.min(x - w / 2, width - w - 8));
    const top = Math.max(LANES_TOP + 4, Math.min(y, height - 160));
    arcCard.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    arcCard.style.maxHeight = `${Math.max(160, height - top - 8)}px`;
  }

  // ── Marks region: roving focus over the openable items of the focused lane ──
  function laneItems() {
    if (!built?.display || built.folded) return [];
    const lane = built.model.lanes[focusLane];
    if (!lane) return [];
    const items = built.display.lanes.filter((p) => p.openable && p.ref?.lane === lane.key && p.kind !== 'glyph' && !p.style?.startsWith('cap') && p.style !== 'none');
    return items.sort((a, b) => a.x0 - b.x0);
  }
  function focusedItem() { const items = laneItems(); return items[focusIndex] ?? null; }
  function moveFocus(delta, absolute = null) {
    const items = laneItems();
    if (!items.length) { marksOption.textContent = 'No marks in this lane in view.'; return; }
    if (absolute !== null) focusIndex = absolute < 0 ? items.length - 1 : 0;
    else focusIndex = Math.max(0, Math.min(items.length - 1, (focusIndex < 0 ? 0 : focusIndex + delta)));
    const p = items[focusIndex];
    marksOption.textContent = (p.tip ?? []).join('. ');
    // Keep the focused item on screen.
    const x = p.x0 + (built.originDay - scale().loDay) / built.daysPerPx;
    if (x < 0 || x > width) centerOn(built.originDay + ((p.x0 + p.x1) / 2) * built.daysPerPx);
    invalidate('overlay');
  }
  function setFocusLane(i) {
    const n = built?.model?.lanes.length ?? 0;
    if (!n) return;
    focusLane = Math.max(0, Math.min(n - 1, i));
    focusIndex = -1;
    const lay = built.layout.lanes[focusLane];
    if (lay) {
      if (lay.y < scrollY) setScrollY(lay.y);
      else if (lay.y + lay.h > scrollY + lanesViewportH()) setScrollY(lay.y + lay.h - lanesViewportH());
    }
    marksProxy.setAttribute('aria-label', `Lane ${built.model.lanes[focusLane].label}: arrows move between marks, Enter opens`);
    moveFocus(0);
    hubSync();
  }

  // ── Player ──
  const player = createPlayer({
    get: () => {
      const ext = extentDays(query);
      const endDay = Math.min(ext ? ext[1] : todayDay(), todayDay());
      return { day: view.vantage.day, tier: built?.drawTier ?? currentTier(), model: built?.model ?? null, seams: query?.seams ?? [], endDay,
        reduced: reduced(), synthetic: Boolean(query?.provenance?.synthetic) };
    },
    setVantage: (day, { strict }) => {
      const action = { type: 'SET_VANTAGE', day };
      if (strict !== undefined) action.strict = strict;
      store.dispatch(action);
      if (player?.playing && !isFolded()) {
        const x = scale().x(day);
        if (needsAutoPan(x, width)) setAxis({ centerDay: autoPanCenter(day, width, axis.daysPerPx), daysPerPx: axis.daysPerPx }, { auto: autoFitted });
      }
      if (reduced()) announce(`As of ${dayLabel(day)}.`);
    },
    onMessage: (text, kind) => {
      store.dispatch({ type: 'UI_TOAST', toast: { kind: kind === 'end' ? 'info' : 'note', text } });
      announce(text);
    },
    onState: (isPlaying) => {
      playTier = isPlaying ? currentTier() : null;   // the bin level is frozen during play
      if (!isPlaying) invalidate('model');           // the end of play repaints every lane at the live tier
      scrollHub.set({ playing: isPlaying, speed: player.speed });
      root.classList.toggle('is-playing', isPlaying);
    },
  });
  const playing = () => player.playing;

  function play() {
    if (qStatus !== 'ready') {
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: 'Pin a strand first: play moves the vantage over what has been counted.' } });
      return;
    }
    const ext = extentDays(query);
    const sc = screen();
    if (view.vantage.day >= VANTAGE_OPEN_DAY || (ext && view.vantage.day >= Math.min(ext[1], todayDay()))) {
      const startDay = snapToBinEnd(currentTier(), Math.max(sc.loDay, ext ? ext[0] : sc.loDay));
      store.dispatch({ type: 'SET_VANTAGE', day: startDay, strict: true });
    }
    player.play();
  }

  // ── Input wiring ──
  cleanups.push(attachPointer(overlay, {
    onPan: (dx) => {
      if (brush || isFolded()) return;
      setAxis(panAxis(axis, dx), { commit: false });
    },
    onPanEnd: () => { if (!isFolded()) scheduleCommit(0); },
    onClick: (x, y) => {
      hideTip();
      const hit = hitAt(x, y);
      if (hit?.openable) open(hit, [x, y]);
      else if (isFolded() && y >= LANES_TOP - GEOM.coverageH) unfoldAt(x);
      else if (hit?.ref?.type !== 'relationship') closeArcCard();
      overlay.focus?.({ preventScroll: true });
    },
    onHover: (x, y) => {
      if (x === null) { hover = null; hideTip(); invalidate('overlay'); return; }
      const hit = hitAt(x, y);
      if (hit?.id !== hover?.id) { hover = hit; invalidate('overlay'); }
      overlay.style.cursor = hit?.openable ? 'pointer' : isFolded() ? 'zoom-in' : '';
      if (hit) showTip(hit, x, y);
      else if (isFolded()) showTip({ tip: ['Click to unfold to a linear axis here'] }, x, y);
      else hideTip();
    },
    onWheel: (action, x) => {
      if (action.type === 'zoom') zoomBy(action.factor, x);
      else if (action.type === 'pan') { if (!isFolded()) setAxis(panAxis(axis, -action.dx)); }
      else if (action.type === 'scrollY') setScrollY(scrollY + action.dy);
    },
    onDoubleClick: (x) => zoomToTier(finerTier(built?.drawTier ?? currentTier()), x),
    reducedMotion: reduced,
  }));
  cleanups.push(attachTouch(overlay, {
    onPan: (dx) => { if (!isFolded()) setAxis(panAxis(axis, dx), { commit: false }); },
    onPanEnd: () => { if (!isFolded()) scheduleCommit(0); },
    onScrollY: (dy) => setScrollY(scrollY + dy),
    onPinch: (factor, midX) => { if (isFolded()) { if (factor > 1.05) unfoldAt(midX); return; } setAxis(zoomAxis(axis, width, midX, factor), { commit: false }); },
    onPinchEnd: () => { if (!isFolded()) scheduleCommit(0); },
    onTap: (x, y) => {
      const hit = hitAt(x, y, TOLERANCE.touch);
      if (hit?.openable) open(hit, [x, y]);
      else if (isFolded()) unfoldAt(x);
      else if (hit?.tip) showTip(hit, x, y); else hideTip();
    },
    onDoubleTap: (x) => zoomToTier(finerTier(built?.drawTier ?? currentTier()), x),
    onTwoFingerTap: (x) => zoomToTier(coarserTier(built?.drawTier ?? currentTier()), x),
    onLongPress: (x, y) => openActionSheet(hitAt(x, y, TOLERANCE.touch), x, y),
  }));

  // Shift-drag on the ruler or coverage track selects a range (§8.5); in the folded overview it unfolds to it.
  on(overlay, 'pointerdown', (e) => {
    if (!e.shiftKey || e.pointerType === 'touch') return;
    const r = overlay.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y > LANES_TOP) return;
    e.stopImmediatePropagation();
    const x = e.clientX - r.left;
    brush = { x0: x, x1: x };
    capturePointer(overlay, e.pointerId);
    invalidate('overlay');
  }, { capture: true });
  on(overlay, 'pointermove', (e) => {
    if (!brush) return;
    brush.x1 = e.clientX - overlay.getBoundingClientRect().left;
    invalidate('overlay');
  });
  on(overlay, 'pointerup', () => {
    if (!brush) return;
    const sc = screen();
    const [a, b] = [Math.min(brush.x0, brush.x1), Math.max(brush.x0, brush.x1)];
    brush = null;
    if (b - a >= 4) {
      const lo = Math.round(sc.day(a)), hiRaw = Math.round(sc.day(b));
      if (sc.folded) {
        toggleFolded(false);
        axis = fitAxis(lo, hiRaw, width, 0.02);
        store.dispatch({ type: 'SET_AXIS', axis: { mode: 'linear', ...axis } });
      } else {
        const hi = snapToBinEnd(built?.drawTier ?? currentTier(), hiRaw);
        store.dispatch({ type: 'SET_RANGE', range: [lo, hi] });
        announce(`Range ${dayLabel(lo)}–${dayLabel(hi)} selected. Press A or B to use it as a Compare slice.`);
      }
    }
    invalidate('overlay');
  });

  // The lanes scrollbar thumb: drag to scroll the lanes.
  let thumbDrag = null;
  on(thumb, 'pointerdown', (e) => { thumbDrag = { y: e.clientY, s: scrollY }; capturePointer(thumb, e.pointerId); e.preventDefault(); });
  on(thumb, 'pointermove', (e) => {
    if (!thumbDrag) return;
    const total = (built?.layout?.height ?? 0) + 8, vh = lanesViewportH();
    setScrollY(thumbDrag.s + ((e.clientY - thumbDrag.y) * total) / Math.max(1, vh));
  });
  on(thumb, 'pointerup', () => { thumbDrag = null; });

  // The playhead handle: drag to scrub (discrete by bin); arrows step.
  let scrub = null;
  on(handle, 'pointerdown', (e) => { scrub = { id: e.pointerId }; capturePointer(handle, e.pointerId); if (playing()) player.pause(); e.preventDefault(); });
  on(handle, 'pointermove', (e) => {
    if (!scrub) return;
    const x = e.clientX - canvasWrap.getBoundingClientRect().left;
    const day = snapToBinEnd(built?.drawTier ?? currentTier(), Math.round(screen().day(x)));
    if (day !== view.vantage.day) store.dispatch({ type: 'SET_VANTAGE', day });
  });
  on(handle, 'pointerup', () => { scrub = null; });
  on(handle, 'keydown', (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
    if (steps) { e.preventDefault(); player.step(steps); }
  });

  function openActionSheet(entry, x, y) {
    clear(actionSheet);
    if (!entry?.openable) { actionSheet.hidden = true; return; }
    const close = () => { actionSheet.hidden = true; };
    const item = (label, fn) => h('button.action-item', { type: 'button', role: 'menuitem', onClick: () => { close(); fn(); } }, label);
    actionSheet.append(
      item('Open', () => open(entry, [x, y])),
      item('Annotate', () => { open(entry); store.dispatch({ type: 'OPEN_PANEL', panel: 'notebook' }); }),
      item('Lineage', () => { open(entry); store.dispatch({ type: 'OPEN_PANEL', panel: 'lineage' }); }),
      item('Compare', () => store.dispatch({ type: 'OPEN_PANEL', panel: 'compare' })),
      item('Pin', () => store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: true })),
      item('Close', close),
    );
    actionSheet.hidden = false;
    actionSheet.style.transform = `translate(${Math.round(Math.min(x, width - 200))}px, ${Math.round(Math.min(y, height - 260))}px)`;
    actionSheet.querySelector('button')?.focus();
  }

  // ── Marks proxy (keyboard) ──
  on(marksProxy, 'focus', () => { keys.setScope('marks'); if (focusIndex < 0) moveFocus(0); invalidate('overlay'); });
  on(marksProxy, 'blur', () => { if (keys.getScope() === 'marks') keys.setScope('global'); invalidate('overlay'); });
  cleanups.push(keys.register('marks', {
    ArrowLeft: { run: () => moveFocus(-1), label: 'previous mark' },
    ArrowRight: { run: () => moveFocus(1), label: 'next mark' },
    ArrowUp: { run: () => setFocusLane(focusLane - 1), label: 'previous lane' },
    ArrowDown: { run: () => setFocusLane(focusLane + 1), label: 'next lane' },
    Home: { run: () => homeEnd(true), label: 'first observation in the lane' },
    End: { run: () => homeEnd(false), label: 'last observation in the lane' },
    Enter: { run: () => open({ ...focusedItem(), openable: focusedItem()?.openable, ref: focusedItem()?.ref }), label: 'open the focused mark or bin' },
  }));

  function homeEnd(first) {
    const lane = built?.model?.lanes[focusLane];
    const s = lane?.strands[0];
    const bar = s?.bars[first ? 0 : s.bars.length - 1];
    if (bar) centerOn(first ? bar.startCap.day : bar.endCap.day);
    const items = laneItems();
    focusIndex = observationIndex(items, first);
    moveFocus(0);
  }

  // ── Global keys (§8.5) ──
  const panBy = (share) => { if (!isFolded()) setAxis({ centerDay: axis.centerDay + share * width * axis.daysPerPx, daysPerPx: axis.daysPerPx }); };
  const vantageStep = (n) => () => { if (view.vantage.day >= VANTAGE_OPEN_DAY) store.dispatch({ type: 'SET_VANTAGE', day: snapToBinEnd(built?.drawTier ?? currentTier(), Math.round(screen().centerDay)) }); else player.step(n); };
  const sliceFromRange = (slice) => () => {
    const sc = screen();
    const r = view.range ?? [Math.round(sc.loDay), Math.round(sc.hiDay)];
    const years = [ymdFromDay(r[0]).y, ymdFromDay(r[1]).y];
    store.dispatch({ type: 'SET_COMPARE', slice, years, f: formatFilter(view.f) });
    store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: `Compare slice ${slice.toUpperCase()}: ${yearRangeLabel(years[0], years[1])}` } });
  };
  cleanups.push(keys.register('global', {
    Space: { run: () => togglePlay(), label: 'play / pause' },
    '[': { run: vantageStep(-1), label: 'vantage −1 bin' },
    ']': { run: vantageStep(1), label: 'vantage +1 bin' },
    '{': { run: vantageStep(-10), label: 'vantage −10 bins' },
    '}': { run: vantageStep(10), label: 'vantage +10 bins' },
    ArrowLeft: { run: () => panBy(-0.1), label: 'pan 10% earlier' },
    ArrowRight: { run: () => panBy(0.1), label: 'pan 10% later' },
    'Shift+ArrowLeft': { run: () => panBy(-0.5), label: 'pan 50% earlier' },
    'Shift+ArrowRight': { run: () => panBy(0.5), label: 'pan 50% later' },
    ArrowUp: { run: () => setFocusLane(focusLane - 1), label: 'lane focus up' },
    ArrowDown: { run: () => setFocusLane(focusLane + 1), label: 'lane focus down' },
    '+': { run: () => zoomBy(1.5), label: 'zoom in' },
    '=': { run: () => zoomBy(1.5), label: 'zoom in' },
    '-': { run: () => zoomBy(1 / 1.5), label: 'zoom out' },
    0: { run: () => fit(), label: 'fit data' },
    ...Object.fromEntries(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map((t, i) => [String(i + 1), { run: () => zoomToTier(t), label: `jump to tier ${t}` }])),
    d: { run: () => toggleFolded(), label: 'folded deep-time overview ↔ linear' },
    v: { run: () => store.dispatch({ type: 'SET_VANTAGE', toggleStrict: true }), label: 'vantage strict ↔ context' },
    e: { run: () => store.dispatch({ type: 'SET_EVIDENCE', cycle: true }), label: 'evidence filter' },
    r: { run: () => store.dispatch({ type: 'SET_REDUCED_MOTION', value: reduced() ? 'off' : 'on' }), label: 'reduced motion' },
    a: { run: sliceFromRange('a'), label: 'Compare slice A from the range' },
    b: { run: sliceFromRange('b'), label: 'Compare slice B from the range' },
    c: { run: () => store.dispatch({ type: 'OPEN_PANEL', panel: 'compare' }), label: 'Compare' },
    g: { run: () => store.dispatch({ type: 'OPEN_PANEL', panel: view.selection?.type === 'document' ? 'genealogy' : 'lineage' }), label: 'Lineage' },
    k: { run: () => store.dispatch({ type: 'OPEN_PANEL', panel: 'constellation' }), label: 'Constellation' },
    n: { run: () => store.dispatch({ type: 'OPEN_PANEL', panel: 'notebook' }), label: 'annotate the selection' },
    Escape: { run: () => escape(), label: 'close, clear selection' },
  }));

  function togglePlay() { if (playing()) player.pause(); else play(); }

  function escape() {
    const v = store.get().view;
    switch (escapeStep({ actionSheet: !actionSheet.hidden, arcCard: Boolean(openArc), panel: Boolean(v.panels.right), selection: Boolean(v.selection),
      range: Boolean(v.range), folded: isFolded() })) {
      case 'actionSheet': actionSheet.hidden = true; return true;
      case 'arcCard': closeArcCard(); if (view.selection?.type === 'relationship') store.dispatch({ type: 'SELECT', selection: null }); return true;
      case 'panel': store.dispatch({ type: 'CLOSE_PANEL', panel: 'right' }); return true;
      case 'selection': store.dispatch({ type: 'SELECT', selection: null }); return true;
      case 'range': store.dispatch({ type: 'SET_RANGE', range: null }); return true;
      case 'folded': toggleFolded(false); return true;
      default: return false;
    }
  }

  // ── Store subscriptions ──
  // runs and asSaved too: "Show as saved" ↔ "Show current data" must re-query (M1 gate)
  const queryKeyOf = (v) => JSON.stringify([v.corpus, v.strands.map((s) => [s.type, s.id]), v.lanes.facet, v.lanes.order, v.lanes.max, v.lanes.run, v.f, v.toggles, v.timeBasis, v.runs?.materialize ?? null, Boolean(v.asSaved)]);
  let lastQueryKey = queryKeyOf(view);
  cleanups.push(store.subscribe((s) => s.view, (v) => {
    const prev = view;
    view = v;
    const qk = queryKeyOf(v);
    if (v.axis.mode !== prev.axis.mode) { built = null; scrollY = 0; invalidate('model'); }
    if (qk !== lastQueryKey) { lastQueryKey = qk; loadStrandLabels(); requery(); return; }
    if (v.axis !== prev.axis && v.axis.mode === 'linear') {
      const fromStore = { centerDay: v.axis.centerDay, daysPerPx: v.axis.daysPerPx };
      // Ignore our own rounded commit; follow anything else (URL, back/forward, saved views).
      if (Math.abs(fromStore.centerDay - axis.centerDay) > 1 || Math.abs(fromStore.daysPerPx / axis.daysPerPx - 1) > 1e-4) { axis = clampAxis(fromStore); autoFitted = false; invalidate('display'); }
    }
    if (v.lanes.manual !== prev.lanes.manual || v.tier !== prev.tier || v.layers !== prev.layers || v.evidence !== prev.evidence) invalidate('model');
    if (v.vantage !== prev.vantage) invalidate('display');
    if (v.selection !== prev.selection || v.range !== prev.range) {
      invalidate('overlay');
      if (v.selection?.type === 'relationship' && openArc?.relId !== v.selection.id) openArcCard({ id: v.selection.id });
      else if (v.selection?.type !== 'relationship' && openArc) closeArcCard();
    }
    if (v.reducedMotion !== prev.reducedMotion) { reveal.clear(); staggerStart = 0; }
  }));
  cleanups.push(store.subscribe((s) => s.ui.layout, (l) => {
    if (!l) return;
    const prevMax = layout.maxLanes;
    layout = l;
    if (l.maxLanes !== prevMax && view.strands.length) requery(); else invalidate('model');
  }));
  cleanups.push(store.subscribe((s) => s.ui.jobs, (jobs) => {
    if (clusterJob?.id && jobs?.[clusterJob.id]) onClusterJob(jobs[clusterJob.id]);
    if (qStatus !== 'materializing' || !qJob) return;
    const job = jobs?.[qJob];
    if (job?.status === 'succeeded') requery();
    else if (job?.status === 'failed' || job?.status === 'cancelled') {
      qStatus = 'error';
      qError = { message: job.error?.message ?? `Counting ${job.status}.`, hint: job.error?.hint ?? 'Retry, or search for another expression.' };
      showState();
    } else showState();
  }));
  cleanups.push(store.subscribe((s) => s.ui.dataVersion, (dv) => { if (query && Number.isInteger(dv) && dv !== query.dataVersion) requery(); }));

  // ── Size: repaint in the same ResizeObserver callback (before the browser paints), so a resize never shows
  // an empty canvas; the canvas backing stores are reallocated only when the size really changed. ──
  const ro = new win.ResizeObserver(() => {
    const r = canvasWrap.getBoundingClientRect();
    const w = Math.floor(r.width), hh = Math.floor(r.height);
    if (w === width && hh === height) return;
    const widthChanged = w !== width;
    width = w;
    height = hh;
    for (const L of [bgL, dataL, arcsL, ovL]) L.resize(width, height);
    palette = readPalette(doc.documentElement);
    if (qStatus === 'ready' && widthChanged) fitIfDefaultAxis();
    dirty = { model: true, display: true, paint: true, overlay: true };
    frame();
  });
  ro.observe(canvasWrap);
  cleanups.push(() => ro.disconnect());

  // ── Coach marks and snapshots: where things are on screen ──
  /**
   * Page rectangle of something on the Scroll, for coach marks: 'first-bar' (the earliest bar of the first
   * lane), 'arc:documented' / 'arc:computed' (a drawn arc of that status), 'play' is the toolbar's.
   * @param {string} what
   * @returns {{x: number, y: number, w: number, h: number, label?: string, item?: object}|null}
   */
  function locate(what) {
    if (!built?.display || built.folded) return null;
    const base = canvasWrap.getBoundingClientRect();
    const toPage = (p) => { const r = screenPrim(p, 'lanes'); return { x: base.left + r.x0, y: base.top + r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }; };
    if (what === 'first-bar') {
      const lane = built.model.lanes[0];
      const bar = lane && built.display.lanes.find((p) => p.ref?.type === 'bin' && p.ref.lane === lane.key && p.kind === 'rect' && p.style?.startsWith('bar') && !p.ghost);
      return bar ? { ...toPage(bar), label: lane.label } : null;
    }
    if (what.startsWith('arc:')) {
      const st = what.slice(4);
      const arc = built.display.lanes.find((p) => p.ref?.type === 'relationship' && p.kind === 'path' && p.style === 'arc' && p.edge?.badge?.startsWith(st === 'documented' ? 'DOC' : st === 'computed' ? 'CALC' : 'PROP'));
      if (!arc) return null;
      const item = built.arcsData?.items?.find((x) => x.rel_id === arc.ref.id) ?? null;
      const mid = { x0: (arc.p0[0] + 2 * arc.cx + arc.p1[0]) / 4, y0: (arc.p0[1] + 2 * arc.cy + arc.p1[1]) / 4 };
      const r = toPage({ x0: mid.x0, x1: mid.x0, y0: mid.y0, y1: mid.y0 });
      return { ...r, item, ghost: Boolean(arc.ghost) };
    }
    return null;
  }

  // ── Actions for other modules ──
  scrollHub.actions = {
    zoomBy, zoomToTier, fit, centerOn, setScrollY, scrollBy: (dy) => setScrollY(scrollY + dy),
    panBy, play, pause: () => player.pause(), togglePlay, step: (n) => player.step(n), setSpeed: (s) => { player.setSpeed(s); scrollHub.set({ speed: player.speed }); },
    retry: () => requery(), focusLane: setFocusLane, escape, toggleFolded, unfoldAt, locate,
    folded: () => toggleFolded(),
    /** What the snapshot needs: the four canvases, the display list and the lane geometry (§7.3). */
    snapshotInput: () => (built?.display ? {
      canvases: layers, width, height, lanesTop: LANES_TOP, scrollY, display: built.display, layout: built.layout, model: built.model,
      tx: built.folded ? 0 : (built.originDay - scale().loDay) / built.daysPerPx, folded: Boolean(built.folded), query, view, caption: caption.textContent,
      palette,
    } : null),
    exportSvgInput: () => (built?.display ? { display: built.display, tx: built.folded ? 0 : (built.originDay - scale().loDay) / built.daysPerPx, viewWidth: width } : null),
  };

  // ── Boot ── (tour.mjs seeds the demo's first strand when the view has none)
  // Paused is context (§1.9: play runs strict, pausing switches to context): a view whose URL does not set
  // the vantage mode opens in context, so later evidence is ghosted rather than missing before play.
  const pausedContext = (checkHash) => {
    const v = store.get().view;
    if (v.vantage.strict && v.vantage.day < VANTAGE_OPEN_DAY && !playing() && !(checkHash && /(?:^|[#&])t=/.test(win.location.hash))) {
      store.dispatch({ type: 'SET_VANTAGE', strict: false });
    }
  };
  pausedContext(true);
  cleanups.push(store.subscribe((s) => s.view.corpus, () => queueMicrotask(() => pausedContext(false))));
  loadStrandLabels();
  // A demo view without strands waits briefly for the tour to seed its first strand instead of flashing the start card.
  if (!view.strands.length && view.corpus === 'demo') {
    qStatus = 'loading';
    showState();
    const t = win.setTimeout(() => { if (!view.strands.length) requery(); }, 1500);
    cleanups.push(() => win.clearTimeout(t));
  } else requery();

  return {
    unmount() {
      player.dispose();
      data.dispose();
      win.cancelAnimationFrame(raf);
      win.clearTimeout(commitTimer);
      win.clearTimeout(pillTimer);
      win.clearTimeout(clusterPoll);
      win.clearTimeout(queryRetry);
      for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* already gone */ } }
      scrollHub.actions = {};
      root.remove();
    },
  };
}
