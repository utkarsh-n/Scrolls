// OWNER: WP7
// panels/inspector.mjs — the Then / Now / Next inspector (SPEC §2.D, §1.11 step 3, §8.6).
//
// Opens on any selected occurrence, passage or document. THEN (amber) is the passage card: document card with
// the date chip, the passage in the reading face with its matches highlighted at their offsets, neighbouring
// passages on request, "Open in reader", the earlier material it draws on, the contemporary uses of the
// expression with their denominator, and the machine annotations. NOW (violet) is a later item that reuses or
// reframes this one: by default the related item with the strongest evidence, a picker for every later related
// item plus "any later occurrence", its relationship card, and the context words around each use ("context words,
// not meanings"). NEXT lists what followed the Now item, says what a context-group sparkline would need, and holds
// the reader's own hypotheses (dashed violet, "not evidence"). Nothing here invents a later reading.
//
// Where it sits: nothing selected → one slim line under the Scroll; a selection on a wide screen (≥ 1280 px, no
// right-hand view open) → a column right of the Scroll, so the Scroll keeps its height; otherwise a split under
// the Scroll. Both splits have a drag handle (keyboard: arrows) and the size is remembered (localStorage, inside
// try/catch). Narrow (< 720 px): Then / Now / Next tabs inside the shell's bottom sheet (shell/layout.mjs).

import { h, clear } from '../core/dom.mjs';
import { parseDate } from '../../shared/dates.mjs';
import { formatCount, formatTokens } from '../../shared/format.mjs';
import { tokenize } from '../../shared/tokenize.mjs';
import { formatFilter } from '../../shared/viewstate.mjs';
import { renderDateChip } from './date-chip.mjs';
import { createEdgeCard, renderLinkLine } from './edge-card.mjs';
import { renderEmptyCard, renderErrorCard, renderGateCard, renderLoadingLine } from './gate-card.mjs';
import { renderKwicRow, renderPassageCard, renderPassageText, passageCardModel, synBadge } from './passage-card.mjs';
import { createReader } from './reader.mjs';
import { createCrossings } from './crossings.mjs';
import { createGroupBlock, GROUP_CAPTION } from './context-group.mjs';
import { followJob, startSuggestedRun } from './runs.mjs';
import { asSavedParams } from './views-menu.mjs';

/** The fixed footer of §2.D. */
export const FOOTER_TEXT = "Then shows documents and their settings, not anyone's private thoughts.";
/** With no recorded relationship (§2.D NOW). */
export const NO_RELATIONSHIP = 'No recorded relationship; these are separate uses of the same expression.';
/** Label of the context-shift lists (§2.D, §13 rule 11). */
export const CONTEXT_LABEL = 'context words, not meanings';
/** The narrow breakpoint of §8.6 (tokens.css uses the same query). */
export const NARROW_QUERY = '(max-width: 719.98px)';
/** From this width the inspector docks right of the Scroll (QA finding 7: the Scroll keeps its height). */
export const WIDE_QUERY = '(min-width: 1280px)';
export const TABS = Object.freeze([
  Object.freeze({ key: 'then', label: 'Then', sub: 'the passage, in its setting' }),
  Object.freeze({ key: 'now', label: 'Now', sub: 'a later use' }),
  Object.freeze({ key: 'next', label: 'Next', sub: 'what followed' }),
]);
/** Selection types the inspector opens on (§2.D: "any occurrence, passage or work"). */
export const INSPECTABLE = Object.freeze(['occurrence', 'passage', 'document']);
/** Contemporary uses: at most 3 per lane and 9 in all (§2.D). */
export const USES_PER_LANE = 3;
export const USES_MAX = 9;
/** NEXT: subsequent relationships from the Now item, time-sorted, at most 20 (§2.D). */
export const NEXT_MAX = 20;
/** Context shift: tokens on each side of a match (§2.D: ±10 tokens). */
export const CONTEXT_WINDOW = 10;
/** Evidence strength for choosing the default Now item (documented > computed > proposed). */
export const EVIDENCE_RANK = Object.freeze({ documented: 3, computed: 2, proposed: 1 });
/** localStorage key of the remembered split sizes (per-viewer convenience only, §8.2). */
export const SIZE_KEY = 'scrolls.inspector.size.v1';
/** Default split sizes: height of the bottom split, width of the right column (CSS px). */
export const DEFAULT_SIZE = Object.freeze({ h: 320, w: 520 });
/** Keyboard step of the resize handle (px). */
export const RESIZE_STEP = 24;
/** Document kinds that are works (titles of songs, films …): they open Genealogy (§2.C2 entry). */
export const WORK_KINDS = Object.freeze(['song', 'film', 'tv', 'album', 'work', 'channel', 'sport']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * What the inspector should load for a selection. An occurrence resolves to its passage through
 * `ui.selectionContext` ({occ, passage}), which selectPassage() sets; without it the occurrence is unresolved.
 * @param {{type: string, id: number|string}|null} selection
 * @param {{selectionContext?: {occ?: number, passage?: number}|null}} [ui]
 * @returns {null | {kind: 'passage', passage: number, occ: number|null} | {kind: 'document', document: number}
 *   | {kind: 'occurrence', occ: number} | {kind: 'other', type: string, id: number|string}}
 */
export function resolveTarget(selection, ui = {}) {
  if (!selection) return null;
  const ctx = ui?.selectionContext ?? null;
  switch (selection.type) {
    case 'passage': return { kind: 'passage', passage: selection.id, occ: Number.isInteger(ctx?.occ) && ctx?.passage === selection.id ? ctx.occ : null };
    case 'occurrence':
      if (ctx && ctx.occ === selection.id && Number.isInteger(ctx.passage)) return { kind: 'passage', passage: ctx.passage, occ: selection.id };
      return { kind: 'occurrence', occ: selection.id };
    case 'document': return { kind: 'document', document: selection.id };
    default: return { kind: 'other', type: selection.type, id: selection.id };
  }
}

/**
 * Select a passage (optionally one occurrence in it) and open the inspector. Any module can call this; it
 * records the occurrence → passage link the inspector needs (ui.selectionContext) before selecting.
 * @param {{dispatch: Function}} store
 * @param {{passage: number, occ?: number|null}} target
 */
export function selectPassage(store, { passage, occ = null }) {
  store.dispatch({ type: 'UI_SET', key: 'selectionContext', value: { passage, occ } });
  store.dispatch({ type: 'SELECT', selection: Number.isInteger(occ) ? { type: 'occurrence', id: occ } : { type: 'passage', id: passage } });
  store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector', mode: 'tnn' });
}

/**
 * Where the inspector sits. On a Term trail (`trail`: lanes = trail with one expression pinned) the Crossings
 * card is part of the preset (§10.5), so a wide or split desktop shows it even before a mark is selected.
 * @param {{open: boolean, selected: boolean, narrow: boolean, wide: boolean, rightPanel: string|null, trail?: boolean}} s
 * @returns {'closed'|'slim'|'bottom'|'right'|'sheet'}
 */
export function dockFor({ open, selected, narrow, wide, rightPanel, trail = false }) {
  if (!open) return 'closed';
  if (narrow) return selected ? 'sheet' : 'closed';
  if (!selected && !trail) return 'slim';
  return wide && !rightPanel ? 'right' : 'bottom';
}

/**
 * The expression a Term trail is about: the one pinned expression strand when the lanes are the trail.
 * @param {{lanes?: {facet?: string}, strands?: Array<{type: string, id: number}>}} view
 * @returns {number|null}
 */
export function trailExpression(view) {
  if (view?.lanes?.facet !== 'trail') return null;
  const ex = (view.strands ?? []).filter((s) => s.type === 'expression');
  return ex.length === 1 && Number.isInteger(ex[0].id) ? ex[0].id : null;
}

/**
 * Keep split sizes usable: the bottom split leaves the toolbar, minimap and ≥ 200 px of Scroll; the right
 * column leaves ≥ 640 px for the Scroll and is never wider than 900 px.
 * @param {{h?: number, w?: number}} size
 * @param {{vw?: number, vh?: number}} [viewport]
 * @returns {{h: number, w: number}}
 */
export function clampSize(size, { vw = 1440, vh = 900 } = {}) {
  const h0 = Number.isFinite(size?.h) ? size.h : DEFAULT_SIZE.h;
  const w0 = Number.isFinite(size?.w) ? size.w : DEFAULT_SIZE.w;
  return {
    h: Math.round(clamp(h0, 140, Math.max(140, vh - 320))),
    w: Math.round(clamp(w0, 380, Math.max(380, Math.min(900, vw - 640)))),
  };
}

/**
 * The remembered split sizes (defaults when storage is missing, blocked or holds junk).
 * @param {Storage|null|undefined} storage
 * @returns {{h: number, w: number}}
 */
export function readSize(storage) {
  try {
    const v = JSON.parse(storage?.getItem(SIZE_KEY) ?? 'null');
    return { h: Number.isFinite(v?.h) ? v.h : DEFAULT_SIZE.h, w: Number.isFinite(v?.w) ? v.w : DEFAULT_SIZE.w };
  } catch {
    return { ...DEFAULT_SIZE };
  }
}

/**
 * Remember the split sizes; a blocked or full storage is ignored (the page works without it).
 * @param {Storage|null|undefined} storage
 * @param {{h: number, w: number}} size
 */
export function writeSize(storage, size) {
  try { storage?.setItem(SIZE_KEY, JSON.stringify({ h: Math.round(size.h), w: Math.round(size.w) })); } catch { /* per-viewer convenience only */ }
}

/**
 * Year interval of a date card: its `lo_year`/`hi_year` when the server sends them, else the label read by the
 * shared date grammar (a trailing parenthesis such as "(VS 1987)" is ignored).
 * @param {{label?: string, lo_year?: number, hi_year?: number}|null} card
 * @returns {{lo: number, hi: number}|null}
 */
export function cardYears(card) {
  if (!card) return null;
  if (Number.isInteger(card.lo_year) && Number.isInteger(card.hi_year)) return { lo: card.lo_year, hi: card.hi_year };
  for (const raw of [card.label, String(card.label ?? '').replace(/\s*\([^)]*\)\s*$/, '')]) {
    if (!raw) continue;
    const p = parseDate(raw);
    if (!p.issue && Number.isInteger(p.lo_year) && Number.isInteger(p.hi_year)) return { lo: p.lo_year, hi: p.hi_year };
  }
  return null;
}

/**
 * The contemporary window W = max(10 y, 2 × date width), centred on the date (§2.D).
 * @param {{lo: number, hi: number}|null} years
 * @returns {{from: number, to: number}|null}
 */
export function contemporaryWindow(years) {
  if (!years) return null;
  const width = years.hi - years.lo + 1;
  const w = Math.max(10, 2 * width);
  const mid = (years.lo + years.hi) / 2;
  return { from: Math.floor(mid - w / 2), to: Math.ceil(mid + w / 2) };
}

/**
 * Stratify KWIC rows: drop the passage itself, keep at most `perLane` rows per lane and `max` in all, in the
 * server's order (spread).
 * @param {Array<{passage: number, lane?: string}>} rows
 * @param {{exclude?: number|null, perLane?: number, max?: number}} [opts]
 */
export function stratifyUses(rows, { exclude = null, perLane = USES_PER_LANE, max = USES_MAX } = {}) {
  const per = new Map();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (out.length >= max) break;
    if (exclude !== null && r.passage === exclude) continue;
    const lane = r.lane ?? '';
    const k = per.get(lane) ?? 0;
    if (k >= perLane) continue;
    per.set(lane, k + 1);
    out.push(r);
  }
  return out;
}

/**
 * The denominator line of the contemporary uses: "n = 37 in 1925–1945 · 6.1M tokens" (tokens when the server
 * sends them).
 * @param {{total?: number, denominator?: {tokens?: number}}} kwic
 * @param {{from: number, to: number}} win
 */
export function usesDenominator(kwic, win) {
  const n = Number.isInteger(kwic?.total) ? formatCount(kwic.total) : '—';
  const tokens = kwic?.denominator?.tokens;
  return `n = ${n} in ${win.from}–${win.to}${Number.isFinite(tokens) ? ` · ${formatTokens(tokens)} tokens` : ''}`;
}

/** Words for one direction of the relationship counts. */
function linkWordsCount(n, one, many) {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * NOW and NEXT summaries from the passage's recorded relationship counts (shown while the links load, or when
 * they cannot be loaded). Canonical direction is later → earlier, so `in` counts later items that use this
 * passage and `out` counts earlier material it uses; `document_in`/`document_out` count its document's links.
 * @param {object|null} p
 * @returns {{now: string, next: string, hasLater: boolean, hasAny: boolean}}
 */
export function relationSummary(p) {
  const rel = p?.relationships;
  const inN = Number.isInteger(rel?.in) ? rel.in : null;
  const outN = Number.isInteger(rel?.out) ? rel.out : null;
  const docIn = Number.isInteger(rel?.document_in) ? rel.document_in : 0;
  const docOut = Number.isInteger(rel?.document_out) ? rel.document_out : 0;
  if (inN === null && outN === null) {
    return { now: 'The record does not report relationships for this passage.', next: '', hasLater: false, hasAny: false };
  }
  const hasLater = (inN ?? 0) + docIn > 0;
  const hasAny = hasLater || (outN ?? 0) + docOut > 0;
  let now;
  if ((inN ?? 0) > 0) now = `${linkWordsCount(inN, 'later item is', 'later items are')} linked to this passage by recorded relationships.`;
  else if (docIn > 0) now = `${linkWordsCount(docIn, 'later item is', 'later items are')} linked to this passage's document by recorded relationships.`;
  else now = NO_RELATIONSHIP;
  const next = outN === null ? '' : `${linkWordsCount(outN + docOut, 'recorded link leads', 'recorded links lead')} from this ${outN ? 'passage' : 'document'} to earlier material.`;
  return { now, next, hasLater, hasAny };
}

/**
 * The links around the inspected item (a depth-1 lineage), split into later items that use it (NOW candidates)
 * and earlier material it uses. The root and its document both count as "this item". Order: strongest evidence
 * first (documented > computed > proposed), then the nearest in time, then the relationship id.
 * @param {{nodes?: object[], edges?: object[]}|null} lineage
 * @returns {{later: Array<{edge: object, node: object, rank: number}>, earlier: Array<{edge: object, node: object, rank: number}>}}
 */
export function splitLinks(lineage) {
  const nodes = new Map((lineage?.nodes ?? []).map((n) => [n.id, n]));
  const own = new Set((lineage?.nodes ?? []).filter((n) => n.direction === 'root' || n.root_document === true).map((n) => n.id));
  if (lineage?.root) own.add(lineage.root);
  const rootYear = (lineage?.nodes ?? []).find((n) => own.has(n.id) && Number.isInteger(n.y))?.y ?? null;
  const later = [], earlier = [];
  for (const e of lineage?.edges ?? []) {
    const srcOwn = own.has(e.src), dstOwn = own.has(e.dst);
    if (srcOwn === dstOwn) continue;
    const node = nodes.get(srcOwn ? e.dst : e.src) ?? { id: srcOwn ? e.dst : e.src };
    const item = { edge: e, node, rank: EVIDENCE_RANK[e.evidence_status] ?? 0 };
    // Canonical direction is derived → source; an undirected pair is placed by its dates.
    const isLater = e.directed === false && Number.isInteger(node.y) && rootYear !== null ? node.y > rootYear : dstOwn;
    (isLater ? later : earlier).push(item);
  }
  const order = (a, b) => b.rank - a.rank || (a.node.y ?? Infinity) - (b.node.y ?? Infinity) || (a.edge.rel_id ?? 0) - (b.edge.rel_id ?? 0);
  return { later: later.sort(order), earlier: earlier.sort(order) };
}

/**
 * Later links from the Now item for NEXT: edges that point at it from a later item, time-sorted, at most NEXT_MAX.
 * @param {{nodes?: object[], edges?: object[]}|null} lineage a lineage rooted at the Now item
 * @returns {Array<{edge: object, node: object}>}
 */
export function nextLinks(lineage) {
  return splitLinks(lineage).later
    .sort((a, b) => (a.node.y ?? Infinity) - (b.node.y ?? Infinity) || (a.edge.rel_id ?? 0) - (b.edge.rel_id ?? 0))
    .slice(0, NEXT_MAX);
}

/** True when a document is a work (a title of a song, film …), which opens Genealogy (§2.C2). */
export function isWork(doc, passage = null) {
  return WORK_KINDS.includes(doc?.kind) || passage?.field === 'title' || passage?.field_class === 'title';
}

/**
 * Context words within ±`window` tokens of each highlighted match, counted (the match's own tokens excluded;
 * one-letter tokens and bare numbers skipped).
 * @param {string} text
 * @param {Array<{start: number, end: number}>} spans offsets relative to `text`
 * @param {{window?: number}} [opts]
 * @returns {Map<string, number>}
 */
export function contextWords(text, spans, { window = CONTEXT_WINDOW } = {}) {
  const out = new Map();
  if (typeof text !== 'string' || !Array.isArray(spans) || !spans.length) return out;
  const { tokens, starts, ends } = tokenize(text);
  for (const s of spans) {
    let first = -1, last = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (ends[i] > s.start && starts[i] < s.end) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) continue;
    for (let i = Math.max(0, first - window); i <= Math.min(tokens.length - 1, last + window); i++) {
      if (i >= first && i <= last) continue;
      const t = tokens[i];
      if ([...t].length < 2 || /^\p{N}+$/u.test(t)) continue;
      out.set(t, (out.get(t) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * The context shift between Then and Now: words only around Then, only around Now, and shared — each list by
 * frequency, at most `max`. These are context words, not meanings.
 * @param {Map<string, number>} thenWords
 * @param {Map<string, number>} nowWords
 * @param {{max?: number}} [opts]
 * @returns {{onlyThen: string[], onlyNow: string[], shared: string[]}}
 */
export function contextShift(thenWords, nowWords, { max = 8 } = {}) {
  const top = (m, keep) => [...m].filter(([t]) => keep(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([t]) => t);
  return {
    onlyThen: top(thenWords, (t) => !nowWords.has(t)),
    onlyNow: top(nowWords, (t) => !thenWords.has(t)),
    shared: top(thenWords, (t) => nowWords.has(t)),
  };
}

/** Expression of the first highlight of a passage (the one the inspector is about). */
function exprOf(p) {
  return (p?.highlights ?? []).map((x) => x.expr).find((x) => Number.isInteger(x)) ?? null;
}

/** Highlights of one expression in a passage. */
function spansOf(p, expr) {
  return (p?.highlights ?? []).filter((x) => expr === null || x.expr === expr);
}

// ── The module ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Mount the inspector into #inspector.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = ctx.announce ?? (() => {});
  const doc = el.ownerDocument;
  const win = doc?.defaultView ?? globalThis.window;
  const region = el.id === 'inspector' ? el : el.closest?.('#inspector') ?? el.parentElement ?? el;
  const narrowMq = win?.matchMedia?.(NARROW_QUERY) ?? null;
  const wideMq = win?.matchMedia?.(WIDE_QUERY) ?? null;
  const storage = (() => { try { return win?.localStorage ?? null; } catch { return null; } })();
  const local = {
    target: null, passage: null, doc: null, error: null, loading: false, withContext: false,
    uses: null, selectedSpan: null, tab: 'then', reader: null, readerDoc: null, seq: 0, crossings: null, crossingsOpen: null,
    links: null, nowChoice: null, nowCard: null, nowItem: null, next: null, hypotheses: null, nextCards: new Map(), groups: null,
    size: readSize(storage), dock: 'closed',
  };
  const root = h('div.inspector', { dataset: { layout: 'desktop' } });
  el.appendChild(root);

  const narrow = () => Boolean(narrowMq?.matches);
  const wide = () => Boolean(wideMq?.matches);
  const view = () => store.get().view;

  // ── placement ──
  function applyDock() {
    const v = view();
    const inspectable = Boolean(v.selection && INSPECTABLE.includes(v.selection.type));
    const dock = dockFor({ open: v.panels.inspector !== null && !(v.selection && !inspectable), selected: inspectable,
      narrow: narrow(), wide: wide(), rightPanel: v.panels.right, trail: trailExpression(v) !== null });
    local.dock = dock;
    const size = clampSize(local.size, { vw: win?.innerWidth || 1440, vh: win?.innerHeight || 900 });
    region.dataset.dock = dock;
    region.style.setProperty('--insp-h', `${size.h}px`);
    region.style.setProperty('--insp-w', `${size.w}px`);
    if (doc?.documentElement) doc.documentElement.dataset.inspDock = dock;
    return dock;
  }

  // The remembered size is what the person chose; the viewport clamp applies only when it is shown, so a size
  // chosen on a large window comes back when the window is large again.
  function setSize(next, { save = false } = {}) {
    const vp = { vw: win?.innerWidth || 1440, vh: win?.innerHeight || 900 };
    const shown = clampSize({ ...local.size, ...next }, vp);
    if (Number.isFinite(next.h)) local.size.h = shown.h;
    if (Number.isFinite(next.w)) local.size.w = shown.w;
    region.style.setProperty('--insp-h', `${shown.h}px`);
    region.style.setProperty('--insp-w', `${shown.w}px`);
    const handle = root.querySelector('.insp-resize');
    if (handle) handle.setAttribute('aria-valuenow', String(local.dock === 'right' ? shown.w : shown.h));
    if (save) writeSize(storage, local.size);
  }

  function renderResizeHandle() {
    const vertical = local.dock === 'right';
    const now = vertical ? local.size.w : local.size.h;
    const handle = h('div.insp-resize', {
      role: 'separator', tabindex: '0', 'aria-orientation': vertical ? 'vertical' : 'horizontal',
      'aria-valuenow': String(now), 'aria-valuemin': vertical ? '380' : '140', 'aria-valuemax': vertical ? '900' : String(Math.max(140, (win?.innerHeight || 900) - 320)),
      'aria-label': vertical ? 'Inspector width: drag, or use the left and right arrow keys' : 'Inspector height: drag, or use the up and down arrow keys',
      title: 'Drag to resize (double-click resets)',
      onKeyDown: (e) => {
        const d = { ArrowUp: vertical ? 0 : RESIZE_STEP, ArrowDown: vertical ? 0 : -RESIZE_STEP, ArrowLeft: vertical ? RESIZE_STEP : 0, ArrowRight: vertical ? -RESIZE_STEP : 0 }[e.key];
        if (!d) return;
        e.preventDefault();
        const vp = { vw: win?.innerWidth || 1440, vh: win?.innerHeight || 900 };
        const cur = clampSize(local.size, vp);
        setSize(vertical ? { w: cur.w + d } : { h: cur.h + d }, { save: true });
        announce(vertical ? `Inspector width ${local.size.w} pixels` : `Inspector height ${local.size.h} pixels`);
      },
      onDblClick: () => { setSize(vertical ? { w: DEFAULT_SIZE.w } : { h: DEFAULT_SIZE.h }, { save: true }); },
      onPointerDown: (e) => startResize(e, vertical),
    }, h('span.insp-resize-grip', { 'aria-hidden': 'true' }));
    return handle;
  }

  // The drag listens on the window, so a re-render of the inspector during the drag does not end it.
  function startResize(e, vertical) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault?.();
    const shown = clampSize(local.size, { vw: win?.innerWidth || 1440, vh: win?.innerHeight || 900 });
    const start = { x: e.clientX, y: e.clientY, h: shown.h, w: shown.w };
    region.classList?.add('is-resizing');
    const move = (ev) => setSize(vertical ? { w: start.w + (start.x - ev.clientX) } : { h: start.h + (start.y - ev.clientY) });
    const up = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', up);
      region.classList?.remove('is-resizing');
      writeSize(storage, local.size);
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', up);
  }

  // ── loading ──
  function resetLater() {
    local.links = null; local.nowChoice = null; local.nowCard = null; local.nowItem = null; local.next = null;
    local.hypotheses = null; local.nextCards = new Map();
    local.groups?.stopJob?.();
    local.groups = null;
  }

  /**
   * The selected occurrence comes from the query's pinned materialization run; the passage highlights the newest run's
   * occurrences. When its id is not among the highlights, its offsets mark the highlight covering the same characters.
   */
  async function loadSelectedSpan(seq, t, p) {
    if (!Number.isInteger(t?.occ) || !Array.isArray(p?.highlights) || p.highlights.some((hl) => hl?.occ === t.occ)) return;
    try {
      const o = await api.get(`/occurrences/${t.occ}`, null, { key: 'inspector-occurrence-span' });
      if (seq !== local.seq || o?.passage !== p.id || !Number.isInteger(p.start)) return;
      local.selectedSpan = { start: o.start - p.start, end: o.end - p.start };
      render();
    } catch { /* the ring is a convenience; the passage is already shown */ }
  }

  async function loadTarget() {
    const seq = ++local.seq;
    const t = local.target;
    local.passage = null; local.doc = null; local.error = null; local.uses = null; local.selectedSpan = null;
    resetLater();
    local.loading = Boolean(t && (t.kind === 'passage' || t.kind === 'document' || t.kind === 'occurrence'));
    render();
    if (!local.loading) return;
    try {
      if (t.kind === 'occurrence') {
        // No selection context (e.g. a reloaded URL with sel=occ:N): ask the server which passage holds it.
        const o = await api.get(`/occurrences/${t.occ}`, null, { key: 'inspector-occurrence' });
        if (seq !== local.seq) return;
        t.kind = 'passage'; t.passage = o.passage;
        // publish what the server answered, so Lineage (G) and the Notebook (N) can root at this passage too (M5 gate)
        store.dispatch({ type: 'UI_SET', key: 'selectionContext', value: { passage: o.passage, occ: t.occ } });
        // that dispatch re-resolves the target and starts its own load; this one must not race it for the same request key
        if (seq !== local.seq) return;
      }
      if (t.kind === 'passage') {
        const p = await api.get(`/passages/${t.passage}`, local.withContext ? { context: 1 } : null, { key: 'inspector-passage' });
        if (seq !== local.seq) return;
        local.passage = p;
        local.loading = false;
        render();
        announce(`Passage open: ${p?.document?.title ?? `passage ${t.passage}`}${p?.document?.date_card?.label ? `, ${p.document.date_card.label}` : ''}`);
        loadSelectedSpan(seq, t, p);
        loadUses(seq);
        loadLinks(seq, `passage:${p.id}`);
        loadHypotheses(seq, `passage:${p.id}`);
        loadGroups(seq);
      } else {
        const d = await api.get(`/documents/${t.document}`, null, { key: 'inspector-document' });
        if (seq !== local.seq) return;
        local.doc = d;
        local.loading = false;
        render();
        loadLinks(seq, `document:${d.id}`);
      }
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err;
      local.loading = false;
      render();
    }
  }

  /**
   * The context group of this use (Passage.machine, from a succeeded clustering run) and the group's share per window
   * from GET /api/clusters — the NEXT column's "later uses in the same context group" (§2.D). Without a membership the
   * expression's clusters still say why: no run yet (with the run to start), a gated run, or a use the run left out.
   * The group block persists across reloads, so an open rename form survives them.
   */
  async function loadGroups(seq) {
    const p = local.passage;
    // as saved (RF-2): the clustering run the view pinned, when it has one, and the readers' labels as they stood then
    const saved = store.get().ui.savedView;
    const pinnedRun = saved?.asSaved && Number.isInteger(saved.runIds?.cluster) ? saved.runIds.cluster : null;
    const m = (p?.machine ?? []).find((x) => x.kind === 'cluster' && Number.isInteger(x.cluster) && (pinnedRun === null || x.run === pinnedRun)) ?? null;
    const expr = exprOf(p);
    const prev = local.groups;
    if (!Number.isInteger(expr)) { prev?.stopJob?.(); local.groups = { state: 'none' }; render(); return; }
    local.groups = { ...(prev ?? {}), state: prev?.state === 'ok' ? 'ok' : 'loading', member: m, expr };
    render();
    try {
      const res = await api.get('/clusters', { expr, run: pinnedRun ?? m?.run ?? null, ...asSavedParams(saved, 'clusters') }, { key: 'inspector-groups' });
      if (seq !== local.seq) return;
      const c = m ? (res?.clusters ?? []).find((x) => x.id === m.cluster) ?? null : null;
      const state = res?.gate === 'ok' ? (c ? 'ok' : m ? 'missing' : 'unassigned') : res?.gate === 'not_run' ? 'not_run' : 'gated';
      const g = { ...local.groups, state, data: res, cluster: c, error: null };
      if (state === 'ok') {
        if (g.block && g.blockId === c.id) g.block.update({ cluster: c, data: res });
        else {
          g.blockId = c.id;
          g.block = createGroupBlock({ api, cluster: c, data: res, announce, compact: true,
            onRenamed: (label) => {
              for (const x of local.passage?.machine ?? []) if (x.cluster === c.id) x.human_label = label;
              loadGroups(local.seq);
            } });
        }
      }
      local.groups = g;
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.groups = { ...local.groups, state: 'error', error: err };
    }
    render();
  }

  /** Start the clustering run the not_run card suggests (a person pressed its button), then follow its job. */
  async function startGroupsRun(suggestion) {
    const seq = local.seq;
    const g = local.groups;
    try {
      g.job = { id: null, fraction: 0 };
      render();
      const started = await startSuggestedRun(api, suggestion);
      if (seq !== local.seq) return;
      g.job = { id: started.job, fraction: 0 };
      if (Number.isInteger(started.job)) store.dispatch({ type: 'UI_JOB', job: { id: started.job, type: started.stage, status: 'queued', progress: 0 } });
      announce(`Clustering started${Number.isInteger(started.job) ? ` (job ${started.job})` : ''}`);
      g.stopJob = followJob(api, started.job, {
        progress: (f) => { g.job = { ...g.job, fraction: f }; if (seq === local.seq) render(); },
        done: (d) => { g.job = null; if (seq !== local.seq) return; if (d?.status && d.status !== 'succeeded') g.jobEnd = d; loadGroups(seq); },
      });
      render();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      g.job = null; g.jobError = err;
      render();
    }
  }

  async function loadUses(seq) {
    const p = local.passage;
    const expr = exprOf(p);
    if (!Number.isInteger(expr)) { local.uses = null; render(); return; }
    const card = p.document?.date_card ?? null;
    const w = contemporaryWindow(cardYears(card));
    if (!w) { local.uses = { state: 'nodate', label: card?.label ?? 'undated' }; render(); return; }
    local.uses = { state: 'loading', win: w };
    render();
    try {
      const f = formatFilter(view().f);
      const kwic = await api.get('/kwic', { expr, from: w.from, to: w.to, sort: 'spread', limit: 60, f: f || null,
        ...asSavedParams(store.get().ui.savedView, 'kwic') }, { key: 'inspector-uses' });
      if (seq !== local.seq) return;
      local.uses = { state: 'ok', win: w, kwic, rows: stratifyUses(kwic?.rows, { exclude: p.id }) };
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.uses = { state: 'error', win: w, error: err };
    }
    render();
  }

  async function loadLinks(seq, ref) {
    local.links = { state: 'loading', ref };
    render();
    try {
      const data = await api.get('/lineage', { root: ref, depth: 1, dir: 'both', max_nodes: 60, ...asSavedParams(store.get().ui.savedView, 'lineage') },
        { key: 'inspector-links' });
      if (seq !== local.seq) return;
      const split = splitLinks(data);
      local.links = { state: 'ok', ref, data, ...split };
      if (split.later.length) chooseNow(split.later[0].edge.rel_id, { quiet: true });
      else render();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.links = { state: 'error', ref, error: err };
      render();
    }
  }

  async function loadHypotheses(seq, target) {
    try {
      const res = await api.get('/annotations', { target, kind: 'hypothesis', limit: 20, ...asSavedParams(store.get().ui.savedView, 'annotations') },
        { key: 'inspector-hypotheses' });
      if (seq !== local.seq) return;
      local.hypotheses = (res?.items ?? []).filter((a) => a.kind === 'hypothesis');
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.hypotheses = null;
    }
    render();
  }

  /** Choose the Now item: a relationship id, or 'any' (the next later occurrence of the expression). */
  function chooseNow(choice, { quiet = false } = {}) {
    const seq = local.seq;
    local.nowChoice = choice;
    local.nowCard = null; local.nowItem = null; local.next = null; local.nextCards = new Map();
    if (choice === 'any') { loadAnyLater(seq); return; }
    const item = local.links?.later?.find((x) => x.edge.rel_id === choice);
    if (!item) { render(); return; }
    local.nowCard = createEdgeCard({ api, relId: choice, announce, onOpenPassage: (id) => selectPassage(store, { passage: id }),
      onChanged: () => loadLinks(local.seq, local.links.ref) });
    local.nowItem = { kind: 'link', node: item.node, edge: item.edge, passage: null };
    render();
    if (!quiet) announce(`Now: ${item.node.title ?? item.node.id}`);
    const m = /^passage:(\d+)$/.exec(item.node.id ?? '');
    if (m) loadNowPassage(seq, Number(m[1]));
    loadNext(seq, item.node.id);
  }

  async function loadNowPassage(seq, id) {
    try {
      const p = await api.get(`/passages/${id}`, null, { key: 'inspector-now-passage' });
      if (seq !== local.seq || !local.nowItem) return;
      local.nowItem = { ...local.nowItem, passage: p };
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq || !local.nowItem) return;
      local.nowItem = { ...local.nowItem, passageError: err };
    }
    render();
  }

  async function loadAnyLater(seq) {
    const p = local.passage;
    const expr = exprOf(p);
    const years = cardYears(p?.document?.date_card ?? null);
    local.nowItem = { kind: 'any', state: 'loading' };
    render();
    if (!Number.isInteger(expr) || !years) {
      local.nowItem = { kind: 'any', state: 'none', reason: !years ? 'This passage has no year to look after.' : 'No tracked expression is highlighted in this passage.' };
      render();
      return;
    }
    try {
      const f = formatFilter(view().f);
      const kwic = await api.get('/kwic', { expr, from: years.hi + 1, to: 2100, sort: 'date', limit: 1, f: f || null,
        ...asSavedParams(store.get().ui.savedView, 'kwic') }, { key: 'inspector-any-later' });
      if (seq !== local.seq || local.nowChoice !== 'any') return;
      const row = (kwic?.rows ?? []).find((r) => r.passage !== p.id) ?? null;
      if (!row) { local.nowItem = { kind: 'any', state: 'none', reason: `No later occurrence after ${years.hi} in the loaded corpus. 0 is an observation about this index.` }; render(); return; }
      local.nowItem = { kind: 'any', state: 'ok', row, total: kwic.total ?? null, node: { id: `passage:${row.passage}`, title: row.title, y: cardYears(row.date)?.lo ?? null } };
      render();
      loadNowPassage(seq, row.passage);
      loadNext(seq, `passage:${row.passage}`);
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.nowItem = { kind: 'any', state: 'error', error: err };
      render();
    }
  }

  async function loadNext(seq, ref) {
    local.next = { state: 'loading', ref };
    render();
    try {
      const data = await api.get('/lineage', { root: ref, depth: 1, dir: 'in', max_nodes: 60, ...asSavedParams(store.get().ui.savedView, 'lineage') },
        { key: 'inspector-next' });
      if (seq !== local.seq || local.next?.ref !== ref) return;
      local.next = { state: 'ok', ref, items: nextLinks(data) };
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.next = { state: 'error', ref, error: err };
    }
    render();
  }

  // ── actions ──
  const close = () => {
    store.dispatch({ type: 'SELECT', selection: null });
    store.dispatch({ type: 'CLOSE_PANEL', panel: 'inspector' });
  };
  const openReader = () => store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector', mode: 'reader' });
  const closeReader = () => store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector', mode: 'tnn' });
  const openLineage = (ref) => {
    store.dispatch({ type: 'SET_LINEAGE', lineage: { root: ref } });
    store.dispatch({ type: 'OPEN_PANEL', panel: 'lineage' });
  };
  const openGenealogy = (docId) => {
    store.dispatch({ type: 'SET_LINEAGE', lineage: { root: `document:${docId}` } });
    store.dispatch({ type: 'OPEN_PANEL', panel: 'genealogy' });
  };
  const annotate = (kind) => store.dispatch({ type: 'UI_SET', key: 'notebookCompose', value: { kind, at: Date.now() } });
  const toggleContext = () => { local.withContext = !local.withContext; loadTarget(); };
  const setTab = (key) => { local.tab = key; render(); root.querySelector(`[data-tab="${key}"]`)?.focus?.(); };

  // ── rendering: THEN ──
  function renderUses() {
    const u = local.uses;
    if (!u) return null;
    const head = h('h4.section-title', null, 'Contemporary uses');
    if (u.state === 'nodate') return h('section.insp-uses', null, head, h('p.meta', null, `No year interval to centre a window on (date: ${u.label}).`));
    if (u.state === 'loading') return h('section.insp-uses', null, head, renderLoadingLine(`Looking in ${u.win.from}–${u.win.to}…`));
    if (u.state === 'error') return h('section.insp-uses', null, head, renderErrorCard(u.error, { onRetry: () => loadUses(local.seq) }));
    const denom = usesDenominator(u.kwic, u.win);
    if (!u.rows.length) {
      const only = (u.kwic?.total ?? 0) > 0;
      return h('section.insp-uses', null, head, h('p.denominator.num', null, denom),
        renderEmptyCard(only
          ? `No other use of this expression is listed in ${u.win.from}–${u.win.to}.`
          : `No uses of this expression in ${u.win.from}–${u.win.to} in the loaded corpus. 0 is an observation about this index.`));
    }
    return h('section.insp-uses', null, head,
      h('p.denominator.num', null, `${denom} · showing ${u.rows.length}, at most ${USES_PER_LANE} per lane`),
      h('ul.kwic-list', { role: 'list' }, u.rows.map((r) => renderKwicRow(r, { onOpen: (id) => selectPassage(store, { passage: id }) }))));
  }

  function renderDrawsOn() {
    const l = local.links;
    if (!l || l.state !== 'ok' || !l.earlier.length) return null;
    const shown = l.earlier.slice(0, 5);
    return h('section.insp-drawson', { 'aria-label': 'Earlier material this item draws on' },
      h('h4.section-title', null, 'Draws on'),
      h('ul.link-list', { role: 'list' }, shown.map((x) => h('li', null, renderLinkLine(x.edge, { other: x.node, direction: 'earlier' })))),
      l.earlier.length > shown.length ? h('p.meta', null, `+${formatCount(l.earlier.length - shown.length)} more in Lineage (G)`) : null);
  }

  function renderThen() {
    const t = local.target;
    if (local.loading) return renderLoadingLine(t?.kind === 'document' ? 'Opening the document…' : 'Opening the passage…');
    if (local.error) return renderErrorCard(local.error, { what: 'This selection could not be opened.', onRetry: loadTarget });
    if (t?.kind === 'occurrence') {
      return renderEmptyCard(`Occurrence ${t.occ} is selected, but its passage could not be found, so nothing is shown rather than a guess. Open it from the bin drawer or a list to read its passage.`);
    }
    if (t?.kind === 'document' && local.doc) return h('div.insp-then', null, renderDocument(local.doc), renderDrawsOn());
    const p = local.passage;
    if (!p) return null;
    const docId = p.document?.id;
    const actions = h('div.insp-actions', null,
      h('button.btn', { type: 'button', 'aria-pressed': String(local.withContext), onClick: toggleContext },
        local.withContext ? 'Hide neighbouring passages' : 'Show neighbouring passages'),
      h('button.btn', { type: 'button', onClick: openReader }, 'Open in reader'),
      h('button.btn', { type: 'button', onClick: () => openLineage(`passage:${p.id}`) }, 'Lineage (G)'),
      Number.isInteger(docId) && isWork(p.document, p) ? h('button.btn', { type: 'button', onClick: () => openGenealogy(docId) }, 'Genealogy: who sampled, covered, remixed it') : null,
      h('button.btn', { type: 'button', onClick: () => annotate('interpretation') }, 'Annotate (N)'));
    return h('div.insp-then', null,
      renderPassageCard(p, { selectedOcc: local.target?.occ ?? null, selectedSpan: local.selectedSpan, actions }),
      renderDrawsOn(),
      renderUses());
  }

  function renderDocument(d) {
    const tags = Array.isArray(d.tags) ? d.tags : [];
    return h('article.passage-card', { class: { 'syn-frame': d.synthetic === true } },
      h('header.doc-card', null,
        h('div.doc-title-row', null, h('h3.doc-title', null, d.title ?? `Document ${d.id}`), d.synthetic ? synBadge() : null),
        d.author || d.kind ? h('p.doc-byline', null, [d.author, d.kind].filter(Boolean).join(' · ')) : null,
        h('div.doc-date', null, renderDateChip(d.date_card ?? null, { isTranslation: d.is_translation === true })),
        h('p.doc-meta.meta', null, [d.collection ? `collection ${d.collection}` : null, d.license ? `licence ${d.license}` : null].filter(Boolean).join(' · '))),
      tags.length ? h('ul.tag-list', { role: 'list' }, tags.map((t) => h('li.chip', { dataset: { provenance: t.provenance ?? '' } },
        `${t.scheme}: ${t.value}`, t.provenance === 'machine_tag' || t.provenance === 'adapter_machine' ? ' · machine tag, fallible' : ''))) : null,
      d.text_note ? h('p.meta', null, d.text_note) : null,
      h('div.insp-actions', null,
        d.has_full_text ? h('button.btn', { type: 'button', onClick: openReader }, 'Open in reader') : null,
        h('button.btn', { type: 'button', onClick: () => openLineage(`document:${d.id}`) }, 'Lineage (G)'),
        isWork(d) ? h('button.btn', { type: 'button', onClick: () => openGenealogy(d.id) }, 'Genealogy: who sampled, covered, remixed it') : null));
  }

  // ── rendering: NOW ──
  function renderPicker(later, { any = true } = {}) {
    return h('div.now-picker', { role: 'group', 'aria-label': 'Later items to compare with' },
      later.length ? h('ul.link-list', { role: 'list' }, later.map((x) => h('li', null,
        renderLinkLine(x.edge, { other: x.node, direction: 'later', pressed: local.nowChoice === x.edge.rel_id, onOpen: (e) => chooseNow(e.rel_id) })))) : null,
      any ? h('button.btn.now-any', { type: 'button', 'aria-pressed': String(local.nowChoice === 'any'), onClick: () => chooseNow('any') }, 'Any later occurrence (no recorded link)') : null);
  }

  function renderShift(nowPassage) {
    const p = local.passage;
    const expr = exprOf(p);
    if (!p || !nowPassage) return null;
    const thenSpans = spansOf(p, expr);
    const nowSpans = spansOf(nowPassage, expr);
    const head = h('h4.section-title', null, `Context shift — ${CONTEXT_LABEL}`);
    if (!thenSpans.length || !nowSpans.length) {
      return h('section.insp-shift', null, head, h('p.meta', null, 'The later passage does not contain the highlighted expression, so no context words are compared.'));
    }
    const s = contextShift(contextWords(p.text, thenSpans), contextWords(nowPassage.text, nowSpans));
    const list = (words) => (words.length ? words.map((w) => h('span.chip.ctx-word', null, w)) : h('span.meta', null, 'none'));
    return h('section.insp-shift', null, head,
      h('p.meta', null, `Words within ±${CONTEXT_WINDOW} tokens of each match.`),
      h('dl.shift-rows', null,
        h('div.shift-row', { dataset: { side: 'then' } }, h('dt', null, 'only around Then'), h('dd', null, list(s.onlyThen))),
        h('div.shift-row', { dataset: { side: 'now' } }, h('dt', null, 'only around Now'), h('dd', null, list(s.onlyNow))),
        s.shared.length ? h('div.shift-row', { dataset: { side: 'both' } }, h('dt', null, 'around both'), h('dd', null, list(s.shared))) : null));
  }

  function renderNowPassage(item) {
    if (item.passageError) return renderErrorCard(item.passageError, { what: 'The later passage could not be opened.' });
    const np = item.passage;
    if (!np) return null;
    const m = passageCardModel(np);
    return h('article.now-passage', { class: { 'syn-frame': m.synthetic } },
      h('header.doc-card', null,
        h('div.doc-title-row', null, h('h4.doc-title', null, m.title), m.synthetic ? synBadge() : null),
        h('div.doc-date', null, renderDateChip(m.dateCard, { isTranslation: m.isTranslation }))),
      renderPassageText(np, m),
      h('button.btn', { type: 'button', onClick: () => selectPassage(store, { passage: np.id }) }, 'Open this passage as Then'));
  }

  function renderNow() {
    const p = local.passage;
    const l = local.links;
    if (!p && !local.doc) return h('p.meta', null, 'Select a passage to see what the record holds about its later use.');
    if (!l || l.state === 'loading') {
      const s = relationSummary(p);
      return h('div.insp-now', null, renderLoadingLine('Looking for later uses…'), p ? h('p.meta', null, s.now) : null);
    }
    if (l.state === 'error') {
      return h('div.insp-now', null, p ? h('p', null, relationSummary(p).now) : null,
        renderErrorCard(l.error, { what: 'The recorded links could not be loaded.', onRetry: () => loadLinks(local.seq, l.ref) }));
    }
    const later = l.later;
    const body = [];
    if (!later.length) body.push(h('p.now-none', null, NO_RELATIONSHIP));
    if (p || later.length) body.push(renderPicker(later, { any: Boolean(p) }));
    const it = local.nowItem;
    if (it?.kind === 'link') {
      body.push(h('div.now-card', null, local.nowCard?.el ?? null), renderNowPassage(it), renderShift(it.passage));
    } else if (it?.kind === 'any') {
      if (it.state === 'loading') body.push(renderLoadingLine('Finding the next later occurrence…'));
      else if (it.state === 'error') body.push(renderErrorCard(it.error, { onRetry: () => chooseNow('any') }));
      else if (it.state === 'none') body.push(renderEmptyCard(it.reason));
      else {
        body.push(h('p.now-none', null, NO_RELATIONSHIP),
          h('p.denominator.num', null, `The next later occurrence${Number.isInteger(it.total) ? ` (of ${formatCount(it.total)} after this date)` : ''}:`),
          h('ul.kwic-list', { role: 'list' }, renderKwicRow(it.row, { onOpen: (id) => selectPassage(store, { passage: id }) })),
          renderShift(it.passage));
      }
    }
    return h('div.insp-now', null, body);
  }

  // ── rendering: NEXT ──
  function renderHypotheses() {
    const list = local.hypotheses ?? [];
    if (!list.length) return null;
    return h('section.insp-hypotheses', { 'aria-label': 'Hypotheses about later reinterpretation' },
      list.map((a) => h('article.ann-card.is-hypothesis', { dataset: { annotation: String(a.id) } },
        h('header.ann-head', null, h('strong', null, `Hypothesis — by ${a.author ?? 'unknown'}, ${String(a.created_at ?? '').slice(0, 10)} — not evidence`),
          a.synthetic ? synBadge() : null),
        h('p.ann-body', null, a.body_md))));
  }

  /**
   * "Later uses in the same context group" (§2.D): the group of this use with its machine and reader's labels, its
   * share of the grouped uses per window over time, and a rename control; or why there is no group.
   */
  function renderGroups() {
    const g = local.groups;
    const head = h('h4.insp-subhead', null, 'Later uses in the same context group');
    const section = (...content) => h('section.insp-groups', null, head, ...content);
    if (!g || g.state === 'loading') return section(renderLoadingLine('Reading the context groups…'));
    if (g.state === 'none') return section(h('p.meta', null, 'No tracked expression is highlighted in this passage, so no context group is looked up.'));
    if (g.state === 'error') return section(renderErrorCard(g.error, { onRetry: () => loadGroups(local.seq) }));
    const d = g.data ?? {};
    const meta = [Number.isInteger(d.run) ? `run #${d.run}` : null, d.representation ?? null, Number.isInteger(d.k) ? `k = ${d.k}` : null].filter(Boolean).join(' · ');
    if (g.state === 'not_run') {
      if (g.job) return section(renderLoadingLine(`Clustering the contexts${Number.isInteger(g.job.id) ? ` (job ${g.job.id})` : ''}…`, g.job.fraction));
      return section(
        renderGateCard(d, { title: 'No context groups yet', onRun: (s) => startGroupsRun(s) }),
        g.jobEnd ? h('p.meta', null, `The clustering job ended ${g.jobEnd.status}${g.jobEnd.error?.message ? `: ${g.jobEnd.error.message}` : ''}.`) : null,
        g.jobError ? renderErrorCard(g.jobError, { what: 'The clustering run could not be started.' }) : null);
    }
    if (g.state === 'gated') return section(renderGateCard(d, { title: 'Context groups not estimated' }), meta ? h('p.meta', null, meta) : null);
    if (g.state === 'unassigned' || g.state === 'missing') {
      return section(h('p.meta', null, g.state === 'missing'
        ? `The run that grouped this use (${meta}) no longer lists its group; a newer run may exist.`
        : `No context group of ${meta || 'the latest run'} holds this use: its context was too thin to group, or the use is excluded by default (names, translations, retrospective descriptions …). Nothing is estimated for it.`));
    }
    return section(meta ? h('p.meta', null, meta) : null, g.block?.el ?? null, h('p.meta', null, GROUP_CAPTION));
  }

  function renderNext() {
    const p = local.passage;
    if (!p && !local.doc) return null;
    const it = local.nowItem;
    const n = local.next;
    const nowName = it?.node?.title ?? it?.node?.id ?? null;
    let links = null;
    if (it && nowName) {
      const head = h('h4.insp-subhead', null, `After ${nowName}`);
      if (!n || n.state === 'loading') links = h('section.insp-next-links', null, head, renderLoadingLine('Looking for later links…'));
      else if (n.state === 'error') links = h('section.insp-next-links', null, head, renderErrorCard(n.error, { onRetry: () => loadNext(local.seq, n.ref) }));
      else if (!n.items.length) links = h('section.insp-next-links', null, head, h('p.meta', null, `No recorded later links from ${nowName}.`));
      else {
        links = h('section.insp-next-links', null, head,
          h('p.meta', null, `${formatCount(n.items.length)} recorded later ${n.items.length === 1 ? 'link' : 'links'}, by date${n.items.length === NEXT_MAX ? ` (first ${NEXT_MAX})` : ''}`),
          h('ul.link-list', { role: 'list' }, n.items.map((x) => {
            const open = local.nextCards.get(x.edge.rel_id);
            return h('li', null,
              renderLinkLine(x.edge, { other: x.node, direction: 'later', pressed: Boolean(open), onOpen: (e) => {
                if (local.nextCards.has(e.rel_id)) local.nextCards.delete(e.rel_id);
                else local.nextCards.set(e.rel_id, createEdgeCard({ api, relId: e.rel_id, announce, onOpenPassage: (id) => selectPassage(store, { passage: id }) }));
                render();
              } }),
              open ? open.el : null);
          })));
      }
    } else if (local.links?.state === 'ok' && !local.links.later.length && !it) {
      links = h('p.meta', null, 'Choose "Any later occurrence" in Now to follow what came after this use.');
    }
    const s = relationSummary(p);
    return h('div.insp-next', null,
      links,
      p ? renderGroups() : null,
      renderHypotheses(),
      h('button.btn.insp-hypo', { type: 'button', onClick: () => annotate('hypothesis') }, 'Add a hypothesis about later reinterpretation'),
      p?.reread?.label ? h('p.chip.chip-reread', null, p.reread.label) : null,
      p && Number.isInteger(p.annotations)
        ? h('p.meta', null, `${formatCount(p.annotations)} ${p.annotations === 1 ? 'annotation' : 'annotations'} on this passage (Notebook, N).`) : null,
      p && s.next && local.links?.state !== 'ok' ? h('p.meta', null, s.next) : null);
  }

  function renderReader() {
    const docId = local.passage?.document?.id ?? local.doc?.id ?? (local.target?.kind === 'document' ? local.target.document : null);
    if (!Number.isInteger(docId)) return local.loading ? renderLoadingLine('Opening the passage…') : renderEmptyCard('Select a passage or document to read it in full.');
    if (!local.reader || local.readerDoc !== docId) {
      local.reader?.destroy();
      local.reader = createReader({ api, documentId: docId, passage: local.passage, onClose: closeReader, announce });
      local.readerDoc = docId;
    }
    return local.reader.el;
  }

  // The Crossings card (§2.D header) loads only when opened, except on a Term trail, where it is part of the preset
  // (§10.5) and opens by itself. Its rows open their first passages here.
  function crossingsCard(expr) {
    const saved = store.get().ui.savedView;
    const savedKey = saved?.asSaved ? saved.slug : null;
    if (local.crossings?.expr !== expr || local.crossings?.savedKey !== savedKey) {
      local.crossings?.card?.destroy?.();
      local.crossings = { expr, savedKey, card: null };
    }
    if (!local.crossings.card) {
      const v = view();
      // opening a lane's first passage folds the card, so the passage (THEN) is what the reader sees; the toggle reopens it
      local.crossings.card = createCrossings({ api, exprId: expr, corpus: v.corpus, toggles: v.toggles, saved, announce,
        onOpenPassage: (id) => { local.crossingsOpen = false; selectPassage(store, { passage: id }); },
        onOpenSources: () => store.dispatch({ type: 'OPEN_PANEL', panel: 'adapters' }) });
    }
    return local.crossings.card;
  }

  function renderCrossings(expr = exprOf(local.passage)) {
    if (!Number.isInteger(expr)) return null;
    const open = local.crossingsOpen ?? trailExpression(view()) !== null;
    const toggle = h('button.btn.insp-crossings-toggle', { type: 'button', 'aria-expanded': String(open), onClick: () => {
      local.crossingsOpen = !open;
      render();
    } }, open ? 'Hide crossings' : 'Crossings: where this expression appears across the record');
    return h('div.insp-crossings', null, toggle, open ? crossingsCard(expr).el : null);
  }

  function renderTabs() {
    return h('div.insp-tabs', { role: 'tablist', 'aria-label': 'Then, Now, Next' },
      TABS.map((t) => h('button.insp-tab', {
        type: 'button', role: 'tab', id: `insp-tab-${t.key}`, 'aria-controls': `insp-col-${t.key}`,
        'aria-selected': String(local.tab === t.key), tabindex: local.tab === t.key ? '0' : '-1', dataset: { tab: t.key },
        onClick: () => setTab(t.key),
        onKeyDown: (e) => {
          const i = TABS.findIndex((x) => x.key === t.key);
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            setTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].key);
          }
        },
      }, t.label)));
  }

  function render() {
    const v = view();
    const mode = v.panels.inspector;
    const dock = applyDock();
    const isNarrow = narrow();
    root.dataset.layout = isNarrow ? 'narrow' : 'desktop';
    root.dataset.mode = mode ?? 'closed';
    root.dataset.dock = dock;
    clear(root);
    if (dock === 'closed') { root.hidden = true; return; }
    root.hidden = false;
    if (dock === 'slim') {
      root.classList.remove('syn-frame');
      root.appendChild(h('p.insp-slim', null,
        h('span.insp-slim-label', null, 'Inspector'),
        ' Select a mark on the Scroll to read its passage — ',
        h('span.insp-slim-then', null, 'Then'), ' · ', h('span.insp-slim-now', null, 'Now'), ' · ', h('span.insp-slim-next', null, 'Next')));
      return;
    }
    const synthetic = local.passage?.synthetic === true || local.doc?.synthetic === true;
    root.classList.toggle('syn-frame', synthetic);
    if (dock === 'right' || dock === 'bottom') root.appendChild(renderResizeHandle());
    const v0 = view();
    if (!(v0.selection && INSPECTABLE.includes(v0.selection.type))) {
      // a Term trail with nothing selected: the Crossings card of the pinned expression (§10.5)
      root.appendChild(h('header.insp-head', null,
        h('h2.insp-title', null, 'Crossings'),
        h('button.btn.insp-close', { type: 'button', 'aria-label': 'Close the inspector', title: 'Close (Esc)', onClick: close }, '×')));
      root.appendChild(h('div.insp-body', null,
        h('p.meta.insp-trail-hint', null, 'Term trail: select a mark on the Scroll to read its passage (Then · Now · Next).'),
        h('div.insp-crossings', null, crossingsCard(trailExpression(v0)).el)));
      return;
    }
    const titleText = local.passage?.document?.title ?? local.doc?.title ?? 'Inspector';
    root.appendChild(h('header.insp-head', null,
      h('h2.insp-title', null, mode === 'reader' ? `Reader — ${titleText}` : titleText),
      synthetic ? synBadge() : null,
      h('button.btn.insp-close', { type: 'button', 'aria-label': 'Close the inspector and clear the selection', title: 'Close (Esc)', onClick: close }, '×')));
    const body = h('div.insp-body');
    root.appendChild(body);
    if (mode === 'reader') {
      body.appendChild(h('div.insp-reader', null, renderReader()));
    } else {
      local.reader?.destroy();
      local.reader = null; local.readerDoc = null;
      const cols = [['then', renderThen()], ['now', renderNow()], ['next', renderNext()]];
      const crossings = renderCrossings();
      if (crossings) body.appendChild(crossings);
      if (isNarrow) body.appendChild(renderTabs());
      body.appendChild(h('div.insp-cols', null, cols.map(([key, content]) => {
        const tab = TABS.find((t) => t.key === key);
        return h('section.insp-col', {
          id: `insp-col-${key}`, role: isNarrow ? 'tabpanel' : 'region', 'aria-labelledby': isNarrow ? `insp-tab-${key}` : `insp-coltitle-${key}`,
          dataset: { col: key }, hidden: isNarrow && local.tab !== key,
        }, h('h3.insp-col-title', { id: `insp-coltitle-${key}` }, h('span.insp-col-name', null, tab.label), h('span.insp-col-sub', null, ` · ${tab.sub}`)), content);
      })));
    }
    body.appendChild(h('footer.insp-foot.meta', null, FOOTER_TEXT));
  }

  // ── subscriptions ──
  function onSelection() {
    const s = store.get();
    const next = resolveTarget(s.view.selection, s.ui);
    if (JSON.stringify(next) === JSON.stringify(local.target)) { render(); return; }
    local.target = next;
    local.withContext = false;
    loadTarget();
  }
  const unsubs = [
    store.subscribe((s) => s.view.selection, (sel, prev) => {
      const v = view();
      const inspectable = sel && INSPECTABLE.includes(sel.type);
      if (inspectable && v.panels.inspector === null) store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector', mode: 'tnn' });
      else if (inspectable && prev && v.panels.inspector === 'reader') store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector', mode: 'tnn' });
      local.tab = 'then';
      onSelection();
    }),
    store.subscribe((s) => s.ui.selectionContext, onSelection),
    // "Show as saved" ↔ "Show current data" (RF-2): the counts, links and groups follow the view's pins and cutoffs
    store.subscribe((s) => s.ui.savedView, () => { if (local.target) loadTarget(); }),
    store.subscribe((s) => s.view.panels.inspector, render),
    // A right-hand view (Lineage, Compare …) takes the right side; the inspector moves under the Scroll.
    store.subscribe((s) => s.view.panels.right, () => { if (applyDock() !== root.dataset.dock) render(); }),
    // A Term trail (lanes = trail, one expression) shows its Crossings card even before a selection (§10.5).
    store.subscribe((s) => trailExpression(s.view), () => render()),
  ];
  const onMedia = () => render();
  narrowMq?.addEventListener?.('change', onMedia);
  wideMq?.addEventListener?.('change', onMedia);
  const onResize = () => setSize({});
  win?.addEventListener?.('resize', onResize);
  onSelection();

  return {
    unmount() {
      for (const u of unsubs) u();
      narrowMq?.removeEventListener?.('change', onMedia);
      wideMq?.removeEventListener?.('change', onMedia);
      win?.removeEventListener?.('resize', onResize);
      local.reader?.destroy();
      local.crossings?.card?.destroy?.();
      local.groups?.stopJob?.();
      local.seq++;
      delete region.dataset.dock;
      if (doc?.documentElement) delete doc.documentElement.dataset.inspDock;
      root.remove();
    },
  };
}
