// OWNER: WP7
// panels/lineage.mjs — the Lineage explorer, "chain of custody" (SPEC §2.C, §1.8, §8.7, §13 rules 5–6, `G`).
//
// Root: a passage, document or other ref (view.lineage.root). x is a linear time scale of the nodes' years
// (or, when chosen, "ordinal spacing — equal width per dated year", labelled as such); rows are hops from the
// root, never meaning; undated nodes sit in a left gutter; the root is outlined cyan and its document (whose
// links count for the passage too) sits just under it. Edges carry the evidence pattern, endpoint and badge of
// evidence-style.mjs, the type glyph and the role hue; review is an overlay (✓ ✕ ⚖, in words in the lists) that
// never changes the line. Filters: evidence statuses (Documented only), relation types, show rejected. Opens at
// depth 2 with ≤ 60 nodes; ＋ expands one hop; the response's truncation is printed and "Show as list" gives a
// table. Two picked nodes give the least-evidence-cost chain, whose header is the weakest link. Competing
// hypotheses are drawn as a fan labelled "⚖ n competing"; their card shows them side by side and lets a person
// add one (a proposed link, never documented). The graph is drawn at a readable scale and scrolls sideways.

import { h, clear } from '../core/dom.mjs';
import { asSavedParams } from './views-menu.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { EVIDENCE_STATUS, REL_TYPE_BY_CODE, REL_TYPES } from '../../shared/vocab.mjs';
import { formatCount, refWords } from '../../shared/format.mjs';
import { createEdgeCard, lineSample, linkWords, noteProblem, renderLinkLine } from './edge-card.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { selectPassage } from './inspector.mjs';
import { synBadge } from './passage-card.mjs';

export const OPEN_DEPTH = 2;
export const OPEN_MAX_NODES = 60;
export const EXPAND_MAX_NODES = 30;
export const HARD_CAP = 150;
export const ORDINAL_LABEL = 'ordinal spacing — equal width per dated year';
export const ROWS_NOTE = 'x = the Scroll time scale; rows = hops from the root, never meaning';
/** Relation types a person may propose as a competing hypothesis (all `proposed`, never documented). */
export const HYPOTHESIS_TYPES = Object.freeze(REL_TYPES.filter((t) => ['allusion', 'quotation', 'citation', 'adaptation', 'reinterpretation'].includes(t.family)
  && !['exact_quotation', 'near_quotation', 'shared_wording'].includes(t.code)).map((t) => t.code));
/** Px per distinct dated year column before the graph scrolls sideways; the graph never exceeds MAX_W. */
export const YEAR_PX = 112;
export const MAX_W = 2000;
/** Rows per page of "Show as list". */
export const LIST_PAGE = 50;
const GUTTER = 112;
const PAD = 36;
const ROW_H = 96;
const TOP = 40;
const STAGGER = 24;

const csv = (list) => (Array.isArray(list) && list.length ? list.join(',') : null);

/**
 * Evidence statuses to request: view.lineage.status when set, else the view's evidence filter (E).
 * @param {object} view
 * @returns {string[]}
 */
export function statusFilter(view) {
  if (Array.isArray(view.lineage?.status) && view.lineage.status.length) return [...view.lineage.status];
  return EVIDENCE_STATUS.filter((s) => view.evidence?.[s] !== 0);
}

/**
 * GET /api/lineage query for a view.
 * @param {object} view
 * @param {{root?: string, depth?: number, maxNodes?: number, dir?: string}} [opts]
 */
export function lineageQuery(view, { root = view.lineage?.root, depth = view.lineage?.depth ?? OPEN_DEPTH, maxNodes = OPEN_MAX_NODES, dir = 'both' } = {}) {
  const status = statusFilter(view);
  return {
    root, depth, dir, max_nodes: maxNodes,
    types: csv(view.lineage?.types),
    status: status.length === EVIDENCE_STATUS.length ? null : csv(status),
    rejected: view.evidence?.rejected ? 1 : 0,
  };
}

/**
 * Root ref for G: the selected passage or document (an occurrence through its known passage); with nothing
 * selected, the first pinned work strand (works open in Genealogy) or maker strand.
 * @param {{type: string, id: number}|null} selection
 * @param {{selectionContext?: {occ?: number, passage?: number}}} [ui]
 * @param {Array<{type: string, id: number|string}>} [strands]
 * @returns {string|null}
 */
export function rootForSelection(selection, ui = {}, strands = []) {
  if (selection) {
    if (selection.type === 'passage') return `passage:${selection.id}`;
    if (selection.type === 'document') return `document:${selection.id}`;
    if (selection.type === 'occurrence' && ui?.selectionContext?.occ === selection.id && Number.isInteger(ui.selectionContext.passage)) {
      return `passage:${ui.selectionContext.passage}`;
    }
    return null;
  }
  const work = (strands ?? []).find((s) => s.type === 'work' && Number.isInteger(Number(s.id)));
  if (work) return `document:${Number(work.id)}`;
  const maker = (strands ?? []).find((s) => s.type === 'maker' && s.id);
  return maker ? `maker:${maker.id}` : null;
}

/**
 * Edges the client shows under the filters (the server filters too; this keeps an expanded graph consistent).
 * @param {object[]} edges
 * @param {{status: string[], types?: string[], showRejected?: boolean}} f
 */
export function visibleEdges(edges, { status, types = [], showRejected = false }) {
  return (edges ?? []).filter((e) => status.includes(e.evidence_status)
    && (!types.length || types.includes(e.rel_type))
    && (showRejected || e.review_status !== 'rejected'));
}

/**
 * Union of two lineage payloads (an expansion merged into the graph).
 * @param {object} base
 * @param {object} more
 */
export function mergeLineage(base, more) {
  const nodes = new Map((base.nodes ?? []).map((n) => [n.id, n]));
  for (const n of more.nodes ?? []) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const edges = new Map((base.edges ?? []).map((e) => [e.rel_id, e]));
  for (const e of more.edges ?? []) if (!edges.has(e.rel_id)) edges.set(e.rel_id, e);
  const groups = new Map((base.groups ?? []).map((g) => [g.id, g]));
  for (const g of more.groups ?? []) if (!groups.has(g.id)) groups.set(g.id, g);
  return { ...base, nodes: [...nodes.values()], edges: [...edges.values()], groups: [...groups.values()],
    truncated: { nodes: (base.truncated?.nodes ?? 0) + (more.truncated?.nodes ?? 0), reason: more.truncated?.reason ?? base.truncated?.reason ?? null } };
}

/**
 * Generation of nodes added by an expansion: hop distance from the original root (expansion rows are
 * relative to the expanded node).
 * @param {object} payload the expansion
 * @param {number} baseGen generation of the expanded node
 */
export function shiftGenerations(payload, baseGen) {
  return { ...payload, nodes: (payload.nodes ?? []).map((n) => (Number.isInteger(n.generation) ? { ...n, generation: n.generation + baseGen } : n)) };
}

/** Round year ticks between lo and hi (inclusive), at most ~6. */
export function niceTicks(lo, hi) {
  if (hi <= lo) return [lo];
  const span = hi - lo;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => span / s <= 6) ?? 1000;
  const out = [lo];
  // Round ticks closer than half a step to either end would collide with the end labels.
  for (let y = Math.ceil(lo / step) * step; y <= hi; y += step) if (y - lo >= step / 2 && hi - y >= step / 2) out.push(y);
  out.push(hi);
  return out;
}

const isGutter = (n) => !(Number.isInteger(n.y) && !n.undated && n.type !== 'commonplace');

/**
 * Layout at a readable scale: x from years (linear, or ordinal by dated year) over a width that grows with the
 * number of distinct years (YEAR_PX each, at most MAX_W), rows by generation; undated and commonplace nodes in
 * the left gutter; the root's own document just under the root; nodes of one row closer than 96 px stagger.
 * @param {{nodes: object[], root?: string}} data
 * @param {{width?: number, ordinal?: boolean}} [opts] width = the minimum (the panel's)
 * @returns {{nodes: Array<object & {x: number, y: number, row: number, gutter: boolean, rootDoc: boolean}>,
 *            ticks: Array<{x: number, label: string}>, rows: Array<{gen: number|null, y: number, label: string}>,
 *            width: number, height: number}}
 */
export function layoutLineage(data, { width = 760, ordinal = false } = {}) {
  const nodes = data.nodes ?? [];
  const dated = nodes.filter((n) => !isGutter(n) && n.root_document !== true);
  const years = [...new Set(dated.map((n) => n.y))].sort((a, b) => a - b);
  const total = Math.min(MAX_W, Math.max(width, GUTTER + 2 * PAD + years.length * YEAR_PX));
  const x0 = GUTTER + PAD, x1 = Math.max(x0 + 40, total - PAD);
  let xOf;
  if (!years.length) xOf = () => (x0 + x1) / 2;
  else if (ordinal) {
    const step = years.length > 1 ? (x1 - x0) / (years.length - 1) : 0;
    xOf = (y) => (years.length > 1 ? x0 + years.indexOf(y) * step : (x0 + x1) / 2);
  } else {
    const lo = years[0], hi = years[years.length - 1];
    xOf = (y) => (hi === lo ? (x0 + x1) / 2 : x0 + ((y - lo) / (hi - lo)) * (x1 - x0));
  }
  const gens = [...new Set(nodes.map((n) => (Number.isInteger(n.generation) ? n.generation : null)))]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  const rowOf = new Map(gens.map((g, i) => [g, i]));
  const out = [];
  const gutterCount = new Map();
  const rootNode = nodes.find((n) => n.id === data.root) ?? null;
  for (const n of nodes) {
    const gen = Number.isInteger(n.generation) ? n.generation : null;
    const row = rowOf.get(gen);
    const rootDoc = n.root_document === true && rootNode !== null && n.id !== rootNode.id;
    const gutter = !rootDoc && isGutter(n);
    let x = gutter ? GUTTER / 2 : rootDoc ? (isGutter(rootNode) ? GUTTER / 2 : xOf(rootNode.y)) : xOf(n.y);
    let y = TOP + row * ROW_H + (rootDoc ? 34 : 0);
    if (gutter) {
      const k = gutterCount.get(row) ?? 0;
      gutterCount.set(row, k + 1);
      y += k * 30;
    }
    out.push({ ...n, x, y, row, gutter, rootDoc });
  }
  for (const r of rowOf.values()) {
    const inRow = out.filter((n) => n.row === r && !n.gutter && !n.rootDoc).sort((a, b) => a.x - b.x);
    for (let i = 1; i < inRow.length; i++) if (inRow[i].x - inRow[i - 1].x < 96) inRow[i].y += (i % 2 ? STAGGER : -STAGGER);
  }
  const ticks = ordinal ? years.map((y) => ({ x: xOf(y), label: String(y) }))
    : years.length ? niceTicks(years[0], years[years.length - 1]).map((y) => ({ x: xOf(y), label: String(y) })) : [];
  const rows = gens.map((g, i) => ({ gen: g, y: TOP + i * ROW_H, label: g === null ? 'not in a hop row' : g === 0 ? 'root' : `${g > 0 ? '+' : ''}${g} hop${Math.abs(g) === 1 ? '' : 's'}` }));
  return { nodes: out, ticks, rows, width: total, height: TOP + Math.max(1, gens.length) * ROW_H };
}

/** Approximate advance width of a label (px) at a font size: wide enough for Latin, Devanagari and Gujarati titles. */
const textWidth = (text, size) => [...String(text)].length * size * 0.6;

/**
 * Greedy label placement (fix pass, §2.C: node and edge labels never overlap): labels in the given order (most important
 * first) take the first candidate position whose box overlaps no label already placed and no obstacle (node dots); a
 * label with no free position is placed at its first candidate when it is required, or left out when `optional` (an edge
 * label: its words stay in the link's aria-label and its card).
 * @param {Array<{key: string, lines: string[], x: number, y: number, size: number, candidates: Array<[number, number, ('middle'|'start'|'end')?]>,
 *   optional?: boolean}>} labels y is the first line's baseline; candidates are [dx, dy, anchor]
 * @param {{obstacles?: Array<{x0: number, y0: number, x1: number, y1: number}>, bounds?: {x0: number, y0: number, x1: number, y1: number}|null}} [opts]
 *   `bounds`: the drawing's extent (a label outside it would be clipped)
 * @returns {Map<string, {x: number, y: number, anchor: string, box: {x0: number, y0: number, x1: number, y1: number}}|null>}
 */
export function placeLabels(labels, { obstacles = [], bounds = null } = {}) {
  const taken = [...obstacles];
  // a box that leaves the drawing is clipped: it counts as taken (the graph's right edge cut 'Ledgers of the Uncou…')
  const outside = (b) => Boolean(bounds) && (b.x0 < bounds.x0 || b.x1 > bounds.x1 || b.y0 < bounds.y0 || b.y1 > bounds.y1);
  const hit = (b) => outside(b) || taken.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  const out = new Map();
  for (const l of labels) {
    const w = Math.max(...l.lines.map((t) => textWidth(t, l.size)));
    const lineH = l.size * 1.2;
    const boxAt = ([dx, dy, anchor = 'middle']) => {
      const x = l.x + dx, y = l.y + dy;
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      return { x, y, anchor, box: { x0: x0 - 2, y0: y - l.size * 0.85, x1: x0 + w + 2, y1: y + (l.lines.length - 1) * lineH + l.size * 0.3 } };
    };
    let chosen = null;
    for (const c of l.candidates) {
      const p = boxAt(c);
      if (!hit(p.box)) { chosen = p; break; }
    }
    // a required label with no free candidate moves away from each candidate in turn, a line at a time
    for (let k = 1; !chosen && !l.optional && k <= 8; k++) {
      for (const [dx, dy, anchor] of l.candidates) {
        for (const sign of [1, -1]) {
          const p = boxAt([dx, dy + sign * k * lineH, anchor]);
          if (!hit(p.box)) { chosen = p; break; }
        }
        if (chosen) break;
      }
    }
    // still no free place: the candidate inside the drawing that overlaps the least (never one the edge clips)
    if (!chosen && !l.optional) {
      const area = (b) => taken.reduce((acc, o) => acc + Math.max(0, Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0))
        * Math.max(0, Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0)), 0);
      const tries = l.candidates.flatMap(([dx, dy, anchor]) => [0, 1, -1, 2, -2].map((k) => boxAt([dx, dy + k * lineH, anchor])));
      const inside = tries.filter((p) => !outside(p.box));
      chosen = (inside.length ? inside : tries).reduce((best, p) => (area(p.box) < area(best.box) ? p : best));
    }
    if (chosen) taken.push(chosen.box);
    out.set(l.key, chosen);
  }
  return out;
}

/**
 * The root of a lineage in words: its title from the loaded graph, with its reference ('Zero Holds the Place · passage 53'),
 * or the reference alone ('passage 53') before the graph arrives.
 * @param {string} ref
 * @param {{root?: string, nodes?: object[]}|null} [data]
 * @returns {string}
 */
export function rootWords(ref, data = null) {
  const node = data?.root === ref ? (data.nodes ?? []).find((n) => n.id === ref) : null;
  const title = node?.title ?? null;
  return title ? `${title} · ${refWords(ref)}` : refWords(ref);
}

/**
 * The scrollLeft that centres the root of a lineage graph in its scroller (fix pass: it opened scrolled to the left edge,
 * away from the root).
 * @param {number} rootX the root's x in the graph
 * @param {number} viewport the scroller's visible width
 * @param {number} total the graph's width
 * @returns {number}
 */
export function rootScrollLeft(rootX, viewport, total) {
  return Math.max(0, Math.min(total - viewport, Math.round(rootX - viewport / 2)));
}

/**
 * The chain-of-custody header: the weakest link in capitals, or the server's note when no chain exists.
 * @param {{path: object[], weakest: string|null, text?: string, note?: string}} res
 */
export function chainText(res) {
  if (!res || !Array.isArray(res.path) || !res.path.length) return res?.note ?? 'No chain of recorded links joins these two items.';
  return res.text ?? `Chain strength: weakest link ${String(res.weakest ?? '—').toUpperCase()}.`;
}

/** Short words for an edge: glyph, type, badge, review overlay (see edge-card.mjs linkWords). */
export function edgeWords(e) {
  return linkWords(e);
}

/**
 * Where each hypothesis group's fan starts: the node all of its alternative links leave from, with the count.
 * @param {{groups?: object[], edges?: object[]}} data
 * @returns {Array<{group: number, node: string, n: number, question: string}>}
 */
export function groupFans(data) {
  const byId = new Map((data.edges ?? []).map((e) => [e.rel_id, e]));
  const out = [];
  for (const g of data.groups ?? []) {
    const edges = (g.edges ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (!edges.length) continue;
    const counts = new Map();
    for (const e of edges) counts.set(e.src, (counts.get(e.src) ?? 0) + 1);
    const [node] = [...counts].sort((a, b) => b[1] - a[1])[0];
    out.push({ group: g.id, node, n: g.edges.length, question: g.question });
  }
  return out;
}

/**
 * The POST /api/relationships body of a new competing hypothesis (server-forced proposed + human).
 * @param {{target: string, source: string, relType: string, note: string, group: number, evidence?: object|null}} f
 */
export function hypothesisRequest({ target, source, relType, note, group, evidence = null }) {
  return { src: target, dst: source, rel_type: relType, note: String(note ?? '').trim(), group,
    evidence: evidence ? [{ ...evidence, role: evidence.role ?? 'supporting' }] : [] };
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Mount the Lineage explorer into #panel.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { data: null, error: null, loading: false, seq: 0, ordinal: false, list: false, listPage: 0, detail: null, pathMode: false,
    picks: [], path: null, lastKey: null };
  const root = h('div.lineage', { hidden: true });
  el.appendChild(root);
  const view = () => store.get().view;
  const isOpen = () => view().panels.right === 'lineage';

  async function load({ force = false } = {}) {
    if (!isOpen()) return;
    const v = view();
    if (!v.lineage.root) {
      // opened without a root (a hand-written or older link): follow the current selection when it resolves
      const s = store.get();
      const r = rootForSelection(s.view.selection, s.ui, s.view.strands);
      if (r && /^(passage|document):/.test(r)) { store.dispatch({ type: 'SET_LINEAGE', lineage: { root: r } }); return; }
      local.data = null; render(); return;
    }
    const q = lineageQuery(v);
    const key = JSON.stringify(q);
    if (!force && key === local.lastKey && (local.data || local.loading)) { render(); return; }
    local.lastKey = key;
    const seq = ++local.seq;
    local.loading = true; local.error = null; local.detail = null; local.picks = []; local.path = null;
    render();
    try {
      const data = await api.get('/lineage', { ...q, ...asSavedParams(store.get().ui.savedView, 'lineage') }, { key: 'lineage' });
      if (seq !== local.seq) return;
      local.data = data; local.loading = false;
      render();
      announce(`Lineage of ${data.root}: ${data.nodes?.length ?? 0} nodes, ${data.edges?.length ?? 0} links`);
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err; local.loading = false; local.lastKey = null;
      render();
    }
  }

  async function expand(node) {
    try {
      const more = await api.get('/lineage', { ...lineageQuery(view(), { root: node.id, depth: 1, maxNodes: EXPAND_MAX_NODES }),
        ...asSavedParams(store.get().ui.savedView, 'lineage') }, { key: `lineage-expand-${node.id}` });
      local.data = mergeLineage(local.data, shiftGenerations(more, node.generation ?? 0));
      if (local.data.nodes.length > HARD_CAP) local.list = true;
      render();
      announce(`Expanded ${node.title ?? node.id}: ${more.nodes?.length ?? 0} nodes`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message, hint: err.hint ?? null } });
    }
  }

  async function findPath() {
    const [a, b] = local.picks;
    local.path = { loading: true };
    render();
    try {
      const res = await api.get('/lineage/path', { from: a, to: b, ...asSavedParams(store.get().ui.savedView, 'lineage') }, { key: 'lineage-path' });
      local.path = { res };
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.path = { error: err };
    }
    render();
  }

  /** Open the card of one link (created once; re-renders of the panel keep it). */
  function openEdge(relId) {
    const card = createEdgeCard({ api, relId, announce, onOpenPassage: (id) => selectPassage(store, { passage: id }),
      // A review changes the review overlay of the graph, so the graph is reloaded; the card stays open.
      onChanged: () => { const keep = local.detail; load({ force: true }).then(() => { local.detail = keep; render(); }); } });
    local.detail = { kind: 'edge', rel: relId, card };
    render();
    root.querySelector('.lin-detail')?.scrollIntoView?.({ block: 'nearest' });
  }

  function pickNode(n) {
    if (local.pathMode) {
      local.picks = [...local.picks.filter((p) => p !== n.id), n.id].slice(-2);
      local.path = null;
      render();
      if (local.picks.length === 2) findPath();
      return;
    }
    local.detail = { kind: 'node', node: n };
    render();
    root.querySelector('.lin-detail')?.scrollIntoView?.({ block: 'nearest' });
  }

  const setLineage = (patch) => store.dispatch({ type: 'SET_LINEAGE', lineage: patch });
  const close = () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'lineage' });

  // ── pieces ──
  function renderFilters(data) {
    const v = view();
    const status = statusFilter(v);
    const types = [...new Set((data?.edges ?? []).map((e) => e.rel_type))].sort();
    const chosen = v.lineage.types ?? [];
    return h('div.lin-filters', { role: 'group', 'aria-label': 'Filters' },
      h('fieldset.lin-status', null, h('legend', null, 'Evidence'),
        EVIDENCE_STATUS.map((s) => {
          const st = edgeStyle({ evidence_status: s, family: 'quotation' });
          return h('label.lin-check', null,
            h('input', { type: 'checkbox', checked: status.includes(s), onChange: (e) => {
              const next = e.target.checked ? [...new Set([...status, s])] : status.filter((x) => x !== s);
              setLineage({ status: next.length === EVIDENCE_STATUS.length ? [] : next });
            } }), lineSample(st), ` ${st.badge} ${s}`);
        }),
        h('button.btn', { type: 'button', 'aria-pressed': String(status.length === 1 && status[0] === 'documented'), onClick: () => setLineage({ status: ['documented'] }) }, 'Documented only'),
        h('label.lin-check', null, h('input', { type: 'checkbox', checked: Boolean(v.evidence.rejected),
          onChange: (e) => store.dispatch({ type: 'SET_EVIDENCE', evidence: { rejected: e.target.checked ? 1 : 0 } }) }), ' show rejected (✕, struck)')),
      types.length ? h('div.lin-types', { role: 'group', 'aria-label': 'Relation types' }, types.map((t) => {
        const on = !chosen.length || chosen.includes(t);
        const rt = REL_TYPE_BY_CODE[t];
        return h('button.chip.lin-type', { type: 'button', 'aria-pressed': String(on), dataset: { type: t }, onClick: () => {
          const all = types;
          const cur = chosen.length ? chosen : all;
          const next = on ? cur.filter((x) => x !== t) : [...cur, t];
          setLineage({ types: next.length === all.length ? [] : next });
        } }, `${rt?.glyph ?? ''} ${rt?.short ?? t}`);
      })) : null,
      h('div.lin-view-opts', null,
        h('label.lin-check', null, h('input', { type: 'checkbox', checked: local.ordinal, onChange: (e) => { local.ordinal = e.target.checked; render(); } }), ` ${ORDINAL_LABEL}`),
        h('button.btn', { type: 'button', 'aria-pressed': String(local.list), onClick: () => { local.list = !local.list; local.listPage = 0; render(); } }, local.list ? 'Show as graph' : 'Show as list'),
        h('button.btn', { type: 'button', 'aria-pressed': String(local.pathMode), onClick: () => { local.pathMode = !local.pathMode; local.picks = []; local.path = null; render(); } },
          local.pathMode ? 'Stop chain of custody' : 'Chain of custody: pick two nodes')));
  }

  function renderGraph(data) {
    const v = view();
    const edges = visibleEdges(data.edges, { status: statusFilter(v), types: v.lineage.types, showRejected: Boolean(v.evidence.rejected) });
    const lay = layoutLineage(data, { width: 640, ordinal: local.ordinal });
    const pos = new Map(lay.nodes.map((n) => [n.id, n]));
    const fans = groupFans(data);
    const H = lay.height + 30;
    // every label is placed before drawing, most important first: the root's, node titles (with their date line), the
    // competing-hypotheses fans, then edge labels (left out where no free place remains)
    const titleOf = (n) => (n.type === 'commonplace' ? n.label : n.rootDoc ? `its document: ${truncate(n.title ?? n.id, 22)}` : truncate(n.title ?? n.id, 24));
    const subOf = (n) => (n.type === 'commonplace' || n.rootDoc ? null
      : [n.label ?? (Number.isInteger(n.y) ? String(n.y) : 'undated'), n.kind, n.synthetic ? 'SYN' : null].filter(Boolean).join(' · '));
    const labels = [];
    const nodeOrder = [...lay.nodes].sort((a, b) => (b.id === data.root) - (a.id === data.root) || (a.rootDoc - b.rootDoc));
    for (const n of nodeOrder) {
      const lines = [titleOf(n), subOf(n)].filter(Boolean);
      labels.push({ key: `n:${n.id}`, lines, x: n.x, y: n.y, size: 11.5,
        candidates: n.rootDoc ? [[10, 4, 'start'], [0, 22], [-10, 4, 'end'], [0, -14]]
          : [[0, 20], [0, -16 - (lines.length - 1) * 13.8], [12, 4, 'start'], [-12, 4, 'end'], [0, 34], [0, -30 - (lines.length - 1) * 13.8]] });
    }
    for (const f of fans) {
      const n = pos.get(f.node);
      if (n) labels.push({ key: `f:${f.group}`, lines: [`⚖ ${f.n} competing`], x: n.x, y: n.y, size: 11, candidates: [[0, -16], [0, -30], [14, -16, 'start'], [-14, -16, 'end']] });
    }
    const curve = new Map();
    for (const e of edges) {
      const a = pos.get(e.src), b = pos.get(e.dst);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 22 - Math.min(48, Math.abs(a.x - b.x) / 5);
      const w = edgeWords(e);
      curve.set(e.rel_id, { a, b, mx, my, w });
      labels.push({ key: `e:${e.rel_id}`, lines: [`${w.glyph} ${w.badge}${w.overlay}`.trim()], x: mx, y: 0.25 * a.y + 0.5 * my + 0.25 * b.y - 4, size: 11,
        optional: true, candidates: [[0, 0], [0, -12], [0, 12], [-24, 0], [24, 0]] });
    }
    const dots = lay.nodes.map((n) => ({ x0: n.x - 8, y0: n.y - 8, x1: n.x + 8, y1: n.y + 8 }));
    // the '?' endpoint of a proposed link sits above-right of its source node: labels keep clear of it too
    for (const e of edges) {
      const a = pos.get(e.src);
      if (a && edgeWords(e).style.endpoint === 'question') dots.push({ x0: a.x + 3, y0: a.y - 16, x1: a.x + 13, y1: a.y - 2 });
    }
    // the row names ('root', '+2 hops') and the gutter's 'undated' are fixed: node labels go around them
    const fixed = [...lay.rows.map((r) => ({ x0: GUTTER + 4, y0: r.y - ROW_H / 2 + 10, x1: GUTTER + 10 + textWidth(r.label.toUpperCase(), 10.5) * 1.1, y1: r.y - ROW_H / 2 + 24 })),
      { x0: 6, y0: 6, x1: 70, y1: 20 }];
    const placed = placeLabels(labels, { obstacles: [...dots, ...fixed], bounds: { x0: 0, y0: 0, x1: lay.width, y1: H } });
    const qMarked = new Set();   // one '?' endpoint marker per node, however many proposed links leave it
    const svg = h('svg', { class: 'lin-svg', width: String(lay.width), height: String(H), viewBox: `0 0 ${lay.width} ${H}`, role: 'group',
      'aria-label': `Lineage graph: ${lay.nodes.length} nodes, ${edges.length} links. ${ROWS_NOTE}.` },
      lay.rows.map((r, i) => h('svg:rect', { x: '0', y: String(r.y - ROW_H / 2 + 6), width: String(lay.width), height: String(ROW_H), class: `lin-band${i % 2 ? ' is-alt' : ''}` })),
      h('svg:line', { x1: String(GUTTER), y1: '0', x2: String(GUTTER), y2: String(lay.height), class: 'lin-gutter-rule' }),
      h('svg:text', { x: '8', y: '16', class: 'lin-axis-label' }, 'undated'),
      lay.rows.map((r) => h('svg:text', { x: String(GUTTER + 6), y: String(r.y - ROW_H / 2 + 20), class: 'lin-row-label' }, r.label)),
      lay.ticks.map((t) => h('svg:g', { class: 'lin-tick' },
        h('svg:line', { x1: String(t.x), y1: String(lay.height), x2: String(t.x), y2: String(lay.height + 6) }),
        h('svg:text', { x: String(t.x), y: String(lay.height + 20), 'text-anchor': 'middle' }, t.label))),
      edges.map((e) => {
        const c = curve.get(e.rel_id);
        if (!c) return null;
        const { a, b, mx, my, w } = c;
        const d = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
        const label = `${w.glyph} ${w.badge}${w.overlay}`.trim();
        const at = placed.get(`e:${e.rel_id}`);
        return h('svg:g', { class: `lin-edge role-${w.style.hue}`, tabindex: '0', role: 'button', dataset: { rel: String(e.rel_id), status: e.evidence_status },
          'aria-label': `${a.title ?? e.src} ${w.label} ${b.title ?? e.dst}: ${e.evidence_status}${w.review ? `, ${w.review}` : ''}`,
          onClick: () => openEdge(e.rel_id),
          onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdge(e.rel_id); } } },
        h('svg:path', { d, fill: 'none', class: 'lin-hit' }),
        h('svg:path', { d, fill: 'none', 'stroke-width': String(w.style.width), 'stroke-dasharray': w.style.dash.length ? w.style.dash.join(' ') : null,
          opacity: String(w.style.opacity), class: w.style.strike ? 'lin-line is-struck' : 'lin-line' }),
        w.style.endpoint === 'dot' ? h('svg:circle', { cx: String(a.x), cy: String(a.y), r: '3.5', class: 'ev-end' })
          : w.style.endpoint === 'square' ? h('svg:rect', { x: String(a.x - 3.5), y: String(a.y - 3.5), width: '7', height: '7', class: 'ev-end hollow' })
            : qMarked.has(e.src) ? null : (qMarked.add(e.src), h('svg:text', { x: String(a.x + 5), y: String(a.y - 5), class: 'ev-end-q' }, '?')),
        at ? h('svg:text', { x: String(at.x), y: String(at.y), 'text-anchor': at.anchor, class: 'lin-edge-label' }, label) : null);
      }),
      fans.map((f) => {
        const at = placed.get(`f:${f.group}`);
        return at ? h('svg:text', { x: String(at.x), y: String(at.y), 'text-anchor': at.anchor, class: 'lin-fan', dataset: { group: String(f.group) } }, `⚖ ${f.n} competing`) : null;
      }),
      lay.nodes.map((n) => {
        const isRoot = n.id === data.root;
        const picked = local.picks.includes(n.id);
        const title = titleOf(n);
        const sub = subOf(n);
        const at = placed.get(`n:${n.id}`);
        return h('svg:g', { class: `lin-node${isRoot ? ' is-root' : ''}${picked ? ' is-picked' : ''}${n.gutter ? ' in-gutter' : ''}${n.rootDoc ? ' is-rootdoc' : ''}`, tabindex: '0', role: 'button',
          dataset: { node: n.id }, 'aria-label': `${n.title ?? n.label ?? n.id}${n.label && n.title ? `, ${n.label}` : ''}${isRoot ? ', root' : ''}${n.rootDoc ? ', the root passage\'s document' : ''}${n.undated ? ', undated' : ''}`,
          onClick: () => pickNode(n),
          onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pickNode(n); } } },
        n.type === 'commonplace' || n.rootDoc ? h('svg:rect', { x: String(n.x - 6), y: String(n.y - 6), width: '12', height: '12', class: `lin-dot${n.type === 'commonplace' ? ' commonplace' : ' rootdoc'}` })
          : h('svg:circle', { cx: String(n.x), cy: String(n.y), r: isRoot ? '7.5' : '6', class: 'lin-dot' }),
        h('svg:text', { x: String(at.x), y: String(at.y), 'text-anchor': at.anchor, class: 'lin-label' }, title),
        sub ? h('svg:text', { x: String(at.x), y: String(at.y + 13.8), 'text-anchor': at.anchor, class: 'lin-sublabel' }, sub) : null);
      }));
    const scroller = h('div.lin-scroll', { tabindex: '0', 'aria-label': 'Lineage graph (scrolls sideways)' }, svg);
    // open centred on the root (once per root; the reader's own scrolling is kept after that)
    const rootPos = pos.get(data.root);
    if (rootPos && local.centeredFor !== data.root) {
      const centre = () => {
        if (!scroller.isConnected || !scroller.clientWidth) return;
        scroller.scrollLeft = rootScrollLeft(rootPos.x, scroller.clientWidth, lay.width);
        local.centeredFor = data.root;
      };
      (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(centre);
    }
    return h('div.lin-graph', null, scroller,
      h('p.meta', null, local.ordinal ? `${ORDINAL_LABEL}. ${ROWS_NOTE}.` : `${ROWS_NOTE}.`));
  }

  function renderList(data) {
    const v = view();
    const edges = visibleEdges(data.edges, { status: statusFilter(v), types: v.lineage.types, showRejected: Boolean(v.evidence.rejected) });
    const byId = new Map((data.nodes ?? []).map((n) => [n.id, n]));
    const name = (id) => byId.get(id)?.title ?? byId.get(id)?.label ?? id;
    const year = (id) => (Number.isInteger(byId.get(id)?.y) ? ` (${byId.get(id).y})` : '');
    const pages = Math.max(1, Math.ceil(edges.length / LIST_PAGE));
    const page = Math.min(local.listPage, pages - 1);
    const shown = edges.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);
    const nav = pages > 1 ? h('div.lin-pager', null,
      h('button.btn', { type: 'button', disabled: page === 0, onClick: () => { local.listPage = page - 1; render(); } }, 'Previous'),
      h('span.meta', null, `links ${page * LIST_PAGE + 1}–${page * LIST_PAGE + shown.length} of ${edges.length}`),
      h('button.btn', { type: 'button', disabled: page >= pages - 1, onClick: () => { local.listPage = page + 1; render(); } }, 'Next')) : null;
    return h('div.lin-list', null, nav, h('table.lin-table', null,
      h('caption.meta', null, `${edges.length} links among ${data.nodes?.length ?? 0} nodes`),
      h('thead', null, h('tr', null, ['later', 'link', 'evidence', 'review', 'earlier'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, shown.map((e) => {
        const w = edgeWords(e);
        return h('tr', null,
          h('td', null, `${name(e.src)}${year(e.src)}`),
          h('td', null, h('button.btn.btn-link', { type: 'button', onClick: () => openEdge(e.rel_id) }, `${w.glyph} ${w.short}`)),
          h('td', null, lineSample(w.style), ' ', h('span.badge', null, w.badge), ` ${w.status}`),
          h('td', null, w.review ?? (e.review_status ?? 'unreviewed')),
          h('td', null, `${name(e.dst)}${year(e.dst)}`));
      }))));
  }

  function renderDetail(data) {
    const d = local.detail;
    if (!d) return null;
    const closeBtn = h('button.btn.lin-detail-close', { type: 'button', onClick: () => { local.detail = null; render(); } }, 'Close');
    if (d.kind === 'edge') return h('div.lin-detail', null, h('div.lin-detail-bar', null, h('span.meta', null, `Link ${d.rel}`), closeBtn), d.card.el);
    if (d.kind === 'node') {
      const n = d.node;
      const pid = /^passage:(\d+)$/.exec(n.id)?.[1];
      const did = /^document:(\d+)$/.exec(n.id)?.[1];
      const links = visibleEdges(data.edges, { status: statusFilter(view()), types: view().lineage.types, showRejected: Boolean(view().evidence.rejected) })
        .filter((e) => e.src === n.id || e.dst === n.id);
      const byId = new Map((data.nodes ?? []).map((x) => [x.id, x]));
      return h('div.lin-detail.lin-node-card', null,
        h('div.lin-detail-bar', null, h('h3.lin-node-title', null, n.title ?? n.label ?? n.id, n.synthetic ? synBadge() : null), closeBtn),
        h('p.meta', null, [n.author, n.label, n.precision, n.kind, Number.isInteger(n.generation) ? `${n.generation} ${n.generation === 1 ? 'hop' : 'hops'} from the root` : null, n.undated ? 'undated' : null].filter(Boolean).join(' · ')),
        n.snippet ? h('blockquote.lin-snippet', null, n.snippet) : null,
        n.type === 'commonplace' ? h('p.meta', null, 'Text shared by many documents is one node, not a quotation edge between every pair.') : null,
        links.length ? h('ul.link-list', { role: 'list' }, links.map((e) => {
          const other = byId.get(e.src === n.id ? e.dst : e.src) ?? { id: e.src === n.id ? e.dst : e.src };
          return h('li', null, renderLinkLine(e, { other, direction: e.src === n.id ? 'earlier' : 'later', onOpen: (x) => openEdge(x.rel_id) }));
        })) : null,
        h('div.insp-actions', null,
          pid ? h('button.btn', { type: 'button', onClick: () => selectPassage(store, { passage: Number(pid) }) }, 'Open passage') : null,
          did ? h('button.btn', { type: 'button', onClick: () => store.dispatch({ type: 'SELECT', selection: { type: 'document', id: Number(did) } }) }, 'Open document') : null,
          n.expandable ? h('button.btn', { type: 'button', onClick: () => expand(n) }, `＋ Expand one hop (${formatCount(n.expandable)})`) : null,
          n.id !== data.root && n.type !== 'commonplace' ? h('button.btn', { type: 'button', onClick: () => setLineage({ root: n.id }) }, 'Lineage from here') : null));
    }
    if (d.kind === 'group') return d.el;
    return null;
  }

  function renderGroups(data) {
    const groups = data.groups ?? [];
    if (!groups.length) return null;
    return h('section.lin-groups', { 'aria-label': 'Competing hypotheses' },
      h('h4.section-title', null, 'Competing hypotheses'),
      h('ul.lin-group-list', { role: 'list' }, groups.map((g) => h('li', null,
        h('button.btn.lin-group', { type: 'button', onClick: () => openGroup(g.id) }, `⚖ ${g.edges?.length ?? 0} competing — ${g.question}`)))));
  }

  function hypothesisForm(g, onDone) {
    const nodes = (local.data?.nodes ?? []).filter((n) => n.id !== g.target && n.type !== 'commonplace');
    const source = h('select.hyp-source', { 'aria-label': 'Proposed source' },
      h('option', { value: '' }, 'Choose an item in this graph…'),
      nodes.map((n) => h('option', { value: n.id }, `${truncate(n.title ?? n.label ?? n.id, 40)}${Number.isInteger(n.y) ? ` (${n.y})` : ''}`)));
    const other = h('input.hyp-ref', { type: 'text', placeholder: 'or a reference such as passage:77', 'aria-label': 'Proposed source reference' });
    const type = h('select.hyp-type', { 'aria-label': 'Kind of link' }, HYPOTHESIS_TYPES.map((t) => h('option', { value: t, selected: t === 'proposed_allusion' }, `${REL_TYPE_BY_CODE[t].glyph} ${REL_TYPE_BY_CODE[t].label}`)));
    const passage = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Evidence passage id' });
    const start = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Evidence start offset' });
    const end = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Evidence end offset' });
    const note = h('textarea.edge-note', { rows: '3', 'aria-label': 'Why (at least 10 characters)', placeholder: 'Why this source? (at least 10 characters)' });
    const status = h('div.edge-form-status', { role: 'status' });
    const submit = h('button.btn.btn-primary', { type: 'button', onClick: async () => {
      clear(status);
      const src = other.value.trim() || source.value;
      const ev = { passage: Number.parseInt(passage.value, 10), start: Number.parseInt(start.value, 10), end: Number.parseInt(end.value, 10) };
      const problem = !src ? 'Choose the proposed source.' : noteProblem(note.value)
        ?? (![ev.passage, ev.start, ev.end].every(Number.isInteger) || ev.start >= ev.end ? 'A proposed link needs an evidence span: a passage id and a start offset before the end offset.' : null);
      if (problem) { status.appendChild(renderErrorCard({ message: problem })); return; }
      submit.disabled = true;
      try {
        const res = await api.post('/relationships', hypothesisRequest({ target: g.target, source: src, relType: type.value, note: note.value, group: g.id,
          evidence: { ...ev, relative: true } }), { key: `hypothesis-${g.id}` });
        announce(`Hypothesis ${res?.id ?? ''} added to group ${g.id} as proposed`);
        onDone?.();
      } catch (err) {
        if (err?.name === 'AbortError') return;
        status.appendChild(renderErrorCard(err));
      } finally { submit.disabled = false; }
    } }, 'Add as a proposed hypothesis');
    return h('div.edge-form.hyp-form', { role: 'group', 'aria-label': 'Add a hypothesis' },
      h('p', null, `Propose another source for ${g.target}. It is stored as a proposed link by you — never documented — and joins the group beside the others.`),
      h('label.ann-row', null, h('span', null, 'Source'), source), other,
      h('label.ann-row', null, h('span', null, 'Link'), type),
      h('div.edge-attach', null, h('label', null, 'Evidence passage ', passage), h('label', null, 'start ', start), h('label', null, 'end ', end)),
      h('p.meta', null, 'Offsets are characters (UTF-16) into that passage’s text.'),
      note, h('div.edge-actions', null, submit), status);
  }

  async function openGroup(id) {
    const host = h('div.lin-detail.lin-group-card', null, renderLoadingLine(`Loading hypothesis group ${id}…`));
    local.detail = { kind: 'group', el: host };
    render();
    host.scrollIntoView?.({ block: 'nearest' });
    try {
      const g = await api.get(`/hypothesis-groups/${id}`, null, { key: `lineage-group-${id}` });
      let adding = false;
      const addSlot = h('div.hyp-add');
      const addBtn = h('button.btn', { type: 'button', onClick: () => {
        adding = !adding;
        clear(addSlot);
        if (adding) addSlot.appendChild(hypothesisForm(g, () => { openGroup(id); load({ force: true }); }));
        addBtn.textContent = adding ? 'Cancel' : 'Add a hypothesis';
      } }, 'Add a hypothesis');
      clear(host).append(
        h('div.lin-detail-bar', null, h('h3', null, g.question, g.synthetic ? synBadge() : null),
          h('button.btn.lin-detail-close', { type: 'button', onClick: () => { local.detail = null; render(); } }, 'Close')),
        h('p.meta', null, `${g.text ?? `⚖ ${g.hypotheses?.length ?? 0} competing`} · target ${g.target}${g.created_by ? ` · asked by ${String(g.created_by).replace(/^human:/, '')}` : ''}`),
        h('div.lin-hypotheses', null, (g.hypotheses ?? []).map((x) => {
          const w = edgeWords({ rel_type: x.rel_type ?? 'proposed_allusion', evidence_status: x.evidence_status, review_status: x.review_status, glyph: x.glyph, date_conflict: x.date_conflict });
          return h('article.lin-hypothesis', { dataset: { rel: String(x.rel_id) } },
            h('p.lin-hyp-head', null, lineSample(w.style), ' ', h('span.badge', null, w.badge), ` ${w.status}`, w.review ? ` · ${w.review}` : ''),
            h('p.lin-hyp-label', null, h('strong', null, x.label)),
            h('p.meta', null, `by ${x.author ?? '—'} · ${formatCount(x.evidence)} evidence ${x.evidence === 1 ? 'span' : 'spans'}${x.score ? ` · ${x.score}` : ''}`),
            h('button.btn', { type: 'button', onClick: () => openEdge(x.rel_id) }, 'Open link card (review, evidence)'));
        })),
        h('p.meta', null, g.note ?? 'Nothing is deleted: confirming one hypothesis leaves the others as they were.'),
        h('div.edge-actions', null, addBtn), addSlot);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      clear(host).appendChild(renderErrorCard(err, { onRetry: () => openGroup(id) }));
    }
  }

  function renderPath() {
    if (!local.pathMode) return null;
    const p = local.path;
    const head = h('p.lin-path-hint', null, local.picks.length < 2 ? `Pick ${2 - local.picks.length} more node${local.picks.length === 1 ? '' : 's'} (least-evidence-cost chain: documented 1, computed 3, proposed 5; rejected excluded).` : `${local.picks[0]} → ${local.picks[1]}`);
    if (!p) return h('section.lin-path', null, head);
    if (p.loading) return h('section.lin-path', null, head, renderLoadingLine('Finding the chain…'));
    if (p.error) return h('section.lin-path', null, head, renderErrorCard(p.error, { onRetry: findPath }));
    const res = p.res;
    return h('section.lin-path', { 'aria-label': 'Chain of custody' }, head,
      h('h4.lin-chain', null, chainText(res)),
      res.path?.length ? h('ol.lin-chain-list', null, res.path.map((e) => {
        const w = edgeWords(e);
        return h('li', null, h('button.btn.lin-link-card', { type: 'button', onClick: () => openEdge(e.rel_id) },
          lineSample(w.style), ` ${e.src} ${w.glyph} ${w.label} ${e.dst} · `, h('span.badge', null, w.badge), ` ${w.status}${w.review ? ` · ${w.review}` : ''} · cost ${e.cost ?? '—'}`));
      })) : null,
      Number.isFinite(res.cost) && res.path?.length ? h('p.meta', null, `total cost ${res.cost}`) : null);
  }

  function renderLegend() {
    return h('div.lin-legend', { role: 'note', 'aria-label': 'Line legend' },
      EVIDENCE_STATUS.map((s) => {
        const st = edgeStyle({ evidence_status: s, family: 'quotation' });
        return h('span.lin-legend-item', null, lineSample(st), ` ${st.badge} ${s}`);
      }),
      h('span.lin-legend-item', null, '✓ confirmed · ✕ rejected · ⚖ disputed — review never changes the line'),
      h('span.lin-legend-item', null, h('span.role-amber', null, 'amber'), ' transmission · ', h('span.role-violet', null, 'violet'), ' reinterpretation · ', h('span.role-ivory2', null, 'ivory'), ' similarity'));
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    const v = view();
    root.appendChild(h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: close, 'aria-label': 'Close Lineage' }, '← Back'),
      h('div.cmp-heading', null, h('h2.cmp-h', null, 'Lineage — chain of custody'), h('p.cmp-sub', null, v.lineage.root ? `root: ${rootWords(v.lineage.root, local.data)}` : 'no root selected'))));
    if (!v.lineage.root) { root.appendChild(renderEmptyCard('Select a passage or document and press G (or "Lineage" in the inspector) to see its links.')); return; }
    if (local.error) { root.appendChild(renderErrorCard(local.error, { what: 'The lineage could not be loaded.', onRetry: () => load({ force: true }) })); return; }
    if (local.loading && !local.data) { root.appendChild(renderLoadingLine(`Loading the lineage of ${refWords(v.lineage.root)}…`)); return; }
    const data = local.data;
    if (!data) return;
    root.classList.toggle('syn-frame', (data.nodes ?? []).some((n) => n.synthetic));
    root.appendChild(renderFilters(data));
    const tr = data.truncated ?? {};
    if (tr.nodes > 0) {
      root.appendChild(h('p.lin-truncated', { role: 'note' }, `showing ${formatCount(data.nodes.length)} of ${formatCount(data.nodes.length + tr.nodes)} nodes${tr.reason ? ` — ${tr.reason}` : ''}`));
    }
    if (!(data.edges ?? []).length) root.appendChild(renderEmptyCard('No recorded links for this root under these filters.'));
    root.appendChild(local.list || data.nodes.length > HARD_CAP ? renderList(data) : renderGraph(data));
    root.appendChild(renderLegend());
    const detail = renderDetail(data);
    if (detail) root.appendChild(detail);
    const path = renderPath();
    if (path) root.appendChild(path);
    const groups = renderGroups(data);
    if (groups) root.appendChild(groups);
  }

  const unkeys = keys?.register?.('global', {
    g: { run: () => {
      const s = store.get();
      const r = rootForSelection(s.view.selection, s.ui, s.view.strands);
      if (r) store.dispatch({ type: 'SET_LINEAGE', lineage: { root: r } });
      // Works (a selected document, a pinned work or maker) open in Genealogy, the works mode of the explorer (§8.5).
      store.dispatch({ type: 'OPEN_PANEL', panel: r && /^(document|maker):/.test(r) ? 'genealogy' : 'lineage' });
    }, label: 'Lineage of the selection (works: Genealogy)' },
  }) ?? (() => {});
  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { load(); render(); }),
    store.subscribe((s) => s.view.lineage, () => load()),
    store.subscribe((s) => s.view.evidence, () => load()),
    store.subscribe((s) => s.ui.selectionContext, () => { if (!view().lineage.root) load(); }),
  ];
  if (isOpen()) load();
  render();
  return {
    unmount() { unkeys(); for (const u of unsubs) u(); local.seq++; root.remove(); },
  };
}
