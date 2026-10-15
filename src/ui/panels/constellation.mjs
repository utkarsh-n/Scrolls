// OWNER: WP7
// panels/constellation.mjs — the meaning constellation (SPEC §2.B, `K`). Nodes keep the stable positions the
// server computed for the layout key; changing period or comparing never moves a node. Shape = type
// (expression ○, context group ⬡, work/document □, theme ◇, etymon ▽, context word ·); area ∝ one named
// quantity (sqrt radius) with three reference circles in the legend; edges carry their measure (logDice,
// share) or the evidence style of a relationship. Two periods: split (identical coordinates side by side,
// stacked when narrow) or overlay (A only = hollow amber ring, B only = dashed ivory ring, both = filled,
// size change = two-tone ring), plus a diff list. Re-layout is an explicit button followed by "Positions
// recomputed — movement is not semantic." Nodes the server sends without a position (an expansion) are
// placed by the layout worker with every positioned node pinned.

import { h, clear } from '../core/dom.mjs';
import { yearRangeLabel, ymdFromDay } from '../../shared/dates.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { formatCount, formatNumber } from '../../shared/format.mjs';
import { CONSTELLATION_SIZES } from '../../shared/vocab.mjs';
import { createEdgeCard } from './edge-card.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { selectPassage } from './inspector.mjs';
import { renderKwicRow, synBadge } from './passage-card.mjs';
import { stableLayout } from './layout.worker.mjs';

export const RELAYOUT_TOAST = 'Positions recomputed — movement is not semantic.';
export const SIZE_LABELS = Object.freeze({ occurrences: 'occurrences in period', documents: 'documents in period', authors: 'distinct authors' });
export const MAX_RADIUS = 28;
export const MIN_RADIUS = 3;
/** Node labels: font size (px, = .con-svg text), the longest label shown whole, shorter fallbacks, padding. */
export const LABEL = Object.freeze({ font: 11, maxChars: 40, fallbackChars: [24, 14, 7], pad: 4, gap: 3 });
const W = 640, H = 420;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * A label cut to `max` characters with an ellipsis (whole code points; never splits a surrogate pair).
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateLabel(text, max) {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Collision-aware label placement inside the drawing (§2.B; M5 gate: labels clipped at the panel edges). Larger
 * nodes are placed first; each label tries below, above, right and left of its node (then the diagonals),
 * shifted inside the viewport when it would cross an edge, and never over another label or another node. A label
 * that does not fit whole is cut (full text in the tooltip); one that fits nowhere is left out and the node keeps
 * its tooltip and its accessible name.
 * @param {Array<{id: string, x: number, y: number, r: number, text: string, priority?: number}>} items pixel coordinates
 * @param {{width: number, height: number, measure?: (s: string) => number, font?: number, pad?: number, gap?: number,
 *   maxChars?: number, fallbackChars?: number[]}} opts
 * @returns {Map<string, {x: number, y: number, text: string, full: string, truncated: boolean, hidden: boolean, box: number[]|null}>}
 *   x, y = the left end of the text's baseline (text-anchor start)
 */
export function placeLabels(items, { width, height, measure = (s) => [...s].length * 6.4, font = LABEL.font, pad = LABEL.pad, gap = LABEL.gap,
  maxChars = LABEL.maxChars, fallbackChars = LABEL.fallbackChars } = {}) {
  const discs = new Map(items.map((it) => [it.id, [it.x - it.r, it.y - it.r, it.x + it.r, it.y + it.r]]));
  const placed = [];
  const out = new Map();
  const order = [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)));
  const lh = Math.ceil(font * 1.15);
  for (const it of order) {
    const full = String(it.text ?? '');
    const variants = [...new Set([maxChars, ...fallbackChars].map((n) => truncateLabel(full, n)))];
    let done = null;
    for (const text of variants) {
      const w = Math.ceil(measure(text)) + 2;
      if (w > width - 2 * pad) continue;
      const { x, y, r } = it;
      // candidate boxes [x0, y0, x1, y1]: below, above, right, left, then the four diagonals
      const cands = [
        [x - w / 2, y + r + gap], [x - w / 2, y - r - gap - lh], [x + r + gap, y - lh / 2], [x - r - gap - w, y - lh / 2],
        [x + r * 0.7, y + r * 0.7 + gap], [x - r * 0.7 - w, y + r * 0.7 + gap], [x + r * 0.7, y - r * 0.7 - gap - lh], [x - r * 0.7 - w, y - r * 0.7 - gap - lh],
      ];
      for (const [cx0, cy0] of cands) {
        const x0 = Math.min(Math.max(cx0, pad), width - pad - w);
        if (cy0 < pad || cy0 + lh > height - pad) continue;
        const box = [x0, cy0, x0 + w, cy0 + lh];
        if (placed.some((b) => overlaps(b, box))) continue;
        if ([...discs].some(([id, d]) => id !== it.id && overlaps(d, box))) continue;
        done = { x: x0 + 1, y: cy0 + font, text, full, truncated: text !== full, hidden: false, box };
        break;
      }
      if (done) break;
    }
    if (done) placed.push(done.box);
    out.set(it.id, done ?? { x: it.x, y: it.y, text: '', full, truncated: false, hidden: true, box: null });
  }
  return out;
}

/**
 * A node's tooltip: its full label and type; a renamed context group also names its machine label (§13 rule 10).
 * @param {{label?: string, type?: string, machine_label?: string|null, human_label?: string|null}} n
 * @returns {string}
 */
export function nodeTitle(n) {
  const machine = n.human_label && n.machine_label && n.machine_label !== n.label
    ? ` — machine label: ${String(n.machine_label).replace(/^machine label: /, '')}` : '';
  return `${n.label ?? ''} (${n.type ?? 'node'})${machine}`;
}

/** Text width in px at the label font: the canvas when there is one, else ≈ 0.58 em per character. */
function labelMeasure(el) {
  try {
    const ctx = el?.ownerDocument?.createElement?.('canvas')?.getContext?.('2d');
    if (ctx && typeof ctx.measureText === 'function') {
      const family = el.ownerDocument.defaultView?.getComputedStyle?.(el)?.getPropertyValue?.('--font-ui')?.trim() || 'system-ui, -apple-system, sans-serif';
      ctx.font = `${LABEL.font}px ${family}`;
      if (ctx.measureText('mm').width > 0) return (s) => ctx.measureText(s).width;
    }
  } catch { /* fall back to the estimate */ }
  return (s) => [...s].length * LABEL.font * 0.58;
}

/**
 * Period A: the view's constellation.a, else the Scroll range, else the decade holding the playhead.
 * @param {object} view
 * @returns {[number, number]}
 */
export function periodA(view) {
  if (Array.isArray(view.constellation?.a)) return view.constellation.a;
  if (Array.isArray(view.range)) return [ymdFromDay(view.range[0]).y, ymdFromDay(view.range[1]).y];
  // a vantage with no limit (beyond the record) reads as now: the decade of the current year, not an empty 2100s
  const y = Math.min(ymdFromDay(view.vantage?.day ?? 0).y, new Date().getUTCFullYear());
  const d = Math.floor(y / 10) * 10;
  return [d, d + 9];
}

/**
 * GET /api/constellation query.
 * @param {object} view
 * @param {{relayout?: boolean}} [opts]
 */
export function constellationQuery(view, { relayout = false } = {}) {
  const strands = (view.strands ?? []).filter((s) => s.type === 'expression').map((s) => s.id);
  const a = periodA(view);
  const b = view.constellation?.b ?? null;
  const q = { strands: strands.join(','), a: `${a[0]}-${a[1]}`, b: b ? `${b[0]}-${b[1]}` : null,
    // the edge kinds GET /api/constellation computes (M5 gate: 'theme' was asked for and answered 400 — theme–theme
    // NPMI edges are not built server-side)
    size: view.constellation?.size ?? 'occurrences', edges: 'cooc,rel,member,occurs,etym', max_nodes: 150 };
  if (view.constellation?.layoutKey) q.layout = view.constellation.layoutKey;
  if (relayout) q.relayout = 1;
  return q;
}

/**
 * Radius for a value: area ∝ value, the largest value in either period gets MAX_RADIUS.
 * @param {number} value
 * @param {number} max
 */
export function radius(value, max) {
  if (!isNum(value) || value <= 0 || !(max > 0)) return 0;
  return Math.max(MIN_RADIUS, MAX_RADIUS * Math.sqrt(value / max));
}

/** Largest size across both periods. */
export function maxSize(nodes) {
  return Math.max(0, ...nodes.flatMap((n) => [n.size?.a, n.size?.b].filter(isNum)));
}

/**
 * The overlay encoding of a node (§2.B): which periods it is present in and how its size changed.
 * @param {{present?: {a?: boolean, b?: boolean}, size?: {a?: number, b?: number}}} n
 * @returns {'both'|'a_only'|'b_only'|'none'}
 */
export function presence(n) {
  const a = n.present?.a === true, b = n.present?.b === true;
  return a && b ? 'both' : a ? 'a_only' : b ? 'b_only' : 'none';
}

/**
 * Diff list of a two-period constellation: only in A, only in B, grew more than 2×.
 * @param {object[]} nodes
 */
export function diffList(nodes) {
  const onlyA = nodes.filter((n) => presence(n) === 'a_only');
  const onlyB = nodes.filter((n) => presence(n) === 'b_only');
  const grew = nodes.filter((n) => presence(n) === 'both' && isNum(n.size?.a) && n.size.a > 0 && isNum(n.size?.b) && n.size.b > 2 * n.size.a);
  return { onlyA, onlyB, grew };
}

/** Three round reference values for the legend (or the server's). */
export function referenceValues(legend, max) {
  if (Array.isArray(legend?.reference_circles) && legend.reference_circles.length) return legend.reference_circles;
  if (!(max > 0)) return [];
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = Math.max(1, Math.floor(max / mag) * mag);
  return [...new Set([Math.max(1, Math.round(top / 10)), Math.max(1, Math.round(top / 2)), top])];
}

/**
 * Nodes without a position get one from stableLayout, with every positioned node pinned.
 * @param {{nodes: object[], edges: object[], layout?: {key?: string}}} data
 */
export function placeUnpositioned(data) {
  const missing = (data.nodes ?? []).filter((n) => !(Array.isArray(n.pos) && n.pos.length === 2));
  if (!missing.length) return data;
  const pos = stableLayout({ key: data.layout?.key ?? 'client', nodes: data.nodes.map((n) => ({ id: n.id, pos: n.pos ?? null })), edges: data.edges ?? [] });
  return { ...data, nodes: data.nodes.map((n) => (n.pos ? n : { ...n, pos: pos[n.id], placed: 'client' })) };
}

/** Above this many nodes the client layout runs in the layout worker (§8.1), off the main thread. */
export const WORKER_THRESHOLD = 300;

/**
 * placeUnpositioned() in the layout worker; falls back to the main thread where workers are unavailable.
 * @param {object} data
 * @returns {Promise<object>}
 */
export function layoutInWorker(data) {
  const missing = (data.nodes ?? []).some((n) => !(Array.isArray(n.pos) && n.pos.length === 2));
  if (!missing || typeof Worker !== 'function') return Promise.resolve(placeUnpositioned(data));
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./layout.worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data?.error) { resolve(placeUnpositioned(data)); return; }
      const pos = e.data.positions ?? {};
      resolve({ ...data, nodes: data.nodes.map((n) => (n.pos ? n : { ...n, pos: pos[n.id], placed: 'client' })) });
    };
    worker.onerror = () => { worker.terminate(); resolve(placeUnpositioned(data)); };
    worker.postMessage({ id: 1, key: data.layout?.key ?? 'client', nodes: data.nodes.map((n) => ({ id: n.id, pos: n.pos ?? null })), edges: data.edges ?? [] });
  });
}

function shape(type, x, y, r, cls) {
  const s = Math.max(r, 3);
  switch (type) {
    case 'cluster': {
      const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(x + s * Math.cos(a)).toFixed(1)},${(y + s * Math.sin(a)).toFixed(1)}`; });
      return h('svg:polygon', { points: pts.join(' '), class: cls });
    }
    case 'document': case 'work': return h('svg:rect', { x: String(x - s), y: String(y - s), width: String(2 * s), height: String(2 * s), class: cls });
    case 'theme': case 'motif': return h('svg:polygon', { points: `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`, class: cls });
    case 'etymon': return h('svg:polygon', { points: `${x - s},${y - s * 0.8} ${x + s},${y - s * 0.8} ${x},${y + s}`, class: cls });
    default: return h('svg:circle', { cx: String(x), cy: String(y), r: String(s), class: cls });
  }
}

/**
 * Mount the constellation into #panel.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { data: null, error: null, loading: false, seq: 0, lastKey: null, mode: 'overlay', detail: null, legendOpen: true };
  const root = h('div.constellation', { hidden: true });
  el.appendChild(root);
  const view = () => store.get().view;
  const isOpen = () => view().panels.right === 'constellation';

  async function load({ force = false, relayout = false } = {}) {
    if (!isOpen()) return;
    const v = view();
    if (!v.strands.some((s) => s.type === 'expression')) { local.data = null; render(); return; }
    const q = constellationQuery(v, { relayout });
    const key = JSON.stringify(q);
    if (!force && key === local.lastKey && (local.data || local.loading)) { render(); return; }
    local.lastKey = relayout ? null : key;
    const seq = ++local.seq;
    local.loading = true; local.error = null;
    render();
    try {
      const raw = await api.get('/constellation', q, { key: 'constellation' });
      const data = (raw.nodes?.length ?? 0) > WORKER_THRESHOLD ? await layoutInWorker(raw) : placeUnpositioned(raw);
      if (seq !== local.seq) return;
      local.data = data; local.loading = false;
      if (data.layout?.key && data.layout.key !== v.constellation.layoutKey) {
        // Pinning the layout key must not trigger a second request for the same graph.
        local.lastKey = JSON.stringify(constellationQuery({ ...v, constellation: { ...v.constellation, layoutKey: data.layout.key } }));
        store.dispatch({ type: 'SET_CONSTELLATION', constellation: { layoutKey: data.layout.key } });
      }
      if (relayout) store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: RELAYOUT_TOAST } });
      render();
      announce(`Constellation: ${data.nodes?.length ?? 0} nodes, ${data.edges?.length ?? 0} edges`);
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err; local.loading = false; local.lastKey = null;
      render();
    }
  }

  async function openNode(n) {
    if (/^d:\d+$/.test(n.id)) { store.dispatch({ type: 'SELECT', selection: { type: 'document', id: Number(n.id.slice(2)) } }); return; }
    const sizeWord = SIZE_LABELS[view().constellation.size];
    const host = h('div.lin-detail', null, h('h3', null, n.label),
      h('p.meta', null, `${n.type} · A ${isNum(n.size?.a) ? formatCount(n.size.a) : '—'} · B ${isNum(n.size?.b) ? formatCount(n.size.b) : '—'} (${sizeWord})`),
      n.type === 'cluster' ? h('p.meta', null, 'A context group is a machine hypothesis about usage contexts; its label is a machine label (editable in the notebook).') : null,
      n.type === 'word' ? h('p.meta', null, 'A context word: it occurs near the expression (context words, not meanings).') : null);
    local.detail = { el: host };
    render();
    const x = /^x:(\d+)$/.exec(n.id);
    if (!x) return;
    const [from, to] = periodA(view());
    const list = h('ul.kwic-list', { role: 'list' });
    const status = h('div.con-kwic-status', null, renderLoadingLine('Loading supporting passages…'));
    host.append(status, list);
    let shown = 0;
    const page = async (cursor = null) => {
      try {
        const k = await api.get('/kwic', { expr: x[1], from, to, sort: 'date', limit: 20, cursor }, { key: 'constellation-kwic' });
        shown += (k.rows ?? []).length;
        clear(status).append(h('p.denominator.num', null, `n = ${formatCount(k.total ?? shown)} in ${from}–${to} · showing ${formatCount(shown)} by date, 20 per page`));
        if (!shown) status.appendChild(renderEmptyCard('No passages in this period. 0 is an observation about this index.'));
        for (const r of k.rows ?? []) list.appendChild(renderKwicRow(r, { onOpen: (id) => selectPassage(store, { passage: id }) }));
        if (k.cursor) status.appendChild(h('button.btn', { type: 'button', onClick: (ev) => { ev.currentTarget.remove(); page(k.cursor); } }, 'Next 20'));
      } catch (err) {
        if (err?.name === 'AbortError') return;
        clear(status).appendChild(renderErrorCard(err));
      }
    };
    page();
  }

  function openEdge(e) {
    if (Number.isInteger(e.rel_id)) { local.detail = createEdgeCard({ api, relId: e.rel_id, announce, onOpenPassage: (id) => selectPassage(store, { passage: id }) }); render(); return; }
    const w = (p) => (isNum(e.weight?.[p]) ? formatNumber(e.weight[p]) : 'absent in this period');
    const what = { cooc: 'co-occurrence of the two terms', member: 'share of the expression\'s occurrences in this context group', theme: 'theme association (NPMI), computed by Cipher',
      etym: 'shared ancestry, not shared meaning' }[e.kind] ?? e.kind;
    const params = e.params && typeof e.params === 'object' ? Object.entries(e.params).map(([k, v]) => `${k} ${v}`).join(' · ') : null;
    local.detail = { el: h('div.lin-detail', null,
      h('h3', null, `${labelOf(e.s)} — ${labelOf(e.t)}`),
      h('dl.edge-rows', null,
        h('div.edge-row', null, h('dt', null, 'Quantity'), h('dd', null, `${what}${e.measure ? ` · measured as ${e.measure}` : ''}`)),
        h('div.edge-row', null, h('dt', null, 'Values'), h('dd.num', null, `A ${w('a')} · B ${w('b')}`)),
        h('div.edge-row', null, h('dt', null, 'Computed by'), h('dd', null, [Number.isInteger(e.run) ? `run ${e.run}` : null, params, local.data?.legend?.edge ?? null].filter(Boolean).join(' · ') || 'not stated by the server'))),
      e.kind === 'cooc' ? h('p.meta', null, 'context words, not meanings. Open the expression node to read the passages of this period.') : null) };
    render();
  }

  const labelOf = (id) => local.data?.nodes?.find((n) => n.id === id)?.label ?? id;

  function periodEditor() {
    const v = view();
    const a = periodA(v), b = v.constellation.b;
    const yearInput = (val, label) => h('input.cmp-year', { type: 'number', inputmode: 'numeric', value: val ?? '', 'aria-label': label });
    const aLo = yearInput(a[0], 'Period A from'), aHi = yearInput(a[1], 'Period A to');
    const bLo = yearInput(b?.[0], 'Period B from (optional)'), bHi = yearInput(b?.[1], 'Period B to (optional)');
    const status = h('span.meta', { role: 'status' });
    const apply = () => {
      const n = (el) => Number.parseInt(el.value, 10);
      const A = [n(aLo), n(aHi)], B = [n(bLo), n(bHi)];
      if (!A.every(Number.isInteger) || A[0] > A[1]) { status.textContent = 'Period A needs two years, earliest first.'; return; }
      const hasB = B.every(Number.isInteger);
      if (hasB && B[0] > B[1]) { status.textContent = 'Period B needs two years, earliest first.'; return; }
      if (hasB && B[0] <= A[1]) { status.textContent = 'A is always the earlier period: B must start after A ends.'; return; }
      store.dispatch({ type: 'SET_CONSTELLATION', constellation: { a: A, b: hasB ? B : null } });
    };
    return h('div.con-periods', { role: 'group', 'aria-label': 'Periods' },
      h('span.cmp-slice-name', null, 'A'), aLo, '–', aHi,
      h('span.cmp-slice-name', null, 'B'), bLo, '–', bHi,
      h('button.btn', { type: 'button', onClick: apply }, 'Apply'),
      b ? h('button.btn', { type: 'button', onClick: () => store.dispatch({ type: 'SET_CONSTELLATION', constellation: { b: null } }) }, 'One period') : null,
      status);
  }

  // The drawing is laid out in CSS pixels at the width it is shown at (labels are measured, never scaled down),
  // with a margin so no node sits on the edge; it is redrawn when the panel width changes.
  function drawingSize() {
    const cs = root.ownerDocument?.defaultView?.getComputedStyle?.(root);
    const padX = cs ? (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0) : 0;
    const avail = Math.floor((root.clientWidth || root.getBoundingClientRect?.().width || 0) - padX);
    const split = local.mode === 'split' && view().constellation.b;
    const w0 = avail >= 200 ? avail - 2 : W;
    const w = split && w0 >= 1100 ? Math.floor((w0 - 8) / 2) : w0;
    return { w, h: Math.round(Math.min(560, Math.max(300, w * 0.66))) };
  }

  function renderSvg(data, period, size = { w: W, h: H }) {
    const nodes = data.nodes ?? [];
    const max = maxSize(nodes);
    const { w: SW, h: SH } = size;
    const m = MAX_RADIUS + 4;
    const pos = new Map(nodes.map((n) => [n.id, [m + n.pos[0] * (SW - 2 * m), m + n.pos[1] * (SH - 2 * m)]]));
    const nodeR = (n) => (period === 'overlay' ? Math.max(radius(n.size?.a, max), radius(n.size?.b, max), MIN_RADIUS) : radius(n.size?.[period], max) || MIN_RADIUS);
    const labels = placeLabels(nodes.map((n) => ({ id: n.id, x: pos.get(n.id)[0], y: pos.get(n.id)[1], r: nodeR(n), text: n.label ?? n.id,
      priority: (n.type === 'expression' ? 1e9 : 0) + Math.max(n.size?.a ?? 0, n.size?.b ?? 0) })), { width: SW, height: SH, measure: local.measure });
    const edges = (data.edges ?? []).map((e) => {
      const a = pos.get(e.s), b = pos.get(e.t);
      if (!a || !b) return null;
      const weight = period === 'overlay' ? (e.weight?.b ?? e.weight?.a) : e.weight?.[period];
      const absent = e.kind !== 'rel' && !isNum(weight);
      const st = e.kind === 'rel' && e.evidence_status ? edgeStyle({ evidence_status: e.evidence_status, family: 'citation' }) : null;
      const width = e.kind === 'cooc' && isNum(weight) ? Math.max(0.6, Math.min(4, weight / 4)) : e.kind === 'member' ? 0.8 : 1.5;
      return h('svg:line', { x1: String(a[0]), y1: String(a[1]), x2: String(b[0]), y2: String(b[1]), class: `con-edge kind-${e.kind}${absent ? ' is-absent' : ''}${st ? ` role-${st.hue}` : ''}`,
        'stroke-width': String(width), 'stroke-dasharray': st?.dash.length ? st.dash.join(' ') : e.kind === 'etym' ? '1 3' : null, tabindex: '0', role: 'button',
        'aria-label': `${e.s} to ${e.t}: ${e.kind}${e.measure ? ` (${e.measure})` : ''}`, onClick: () => openEdge(e),
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); openEdge(e); } } });
    });
    const nodeEls = nodes.map((n) => {
      const [x, y] = pos.get(n.id);
      const pres = presence(n);
      let cls = 'con-node';
      let marks;
      if (period === 'overlay') {
        const ra = radius(n.size?.a, max), rb = radius(n.size?.b, max);
        cls += ` pres-${pres}`;
        marks = pres === 'both' && ra && rb && Math.abs(ra - rb) > 1
          ? [shape(n.type, x, y, Math.max(ra, rb), 'ring-outer'), shape(n.type, x, y, Math.min(ra, rb), 'ring-inner')]
          : [shape(n.type, x, y, Math.max(ra, rb, MIN_RADIUS), 'con-shape')];
      } else {
        const present = n.present?.[period] === true;
        cls += present ? '' : ' is-absent';
        marks = [shape(n.type, x, y, radius(n.size?.[period], max) || MIN_RADIUS, 'con-shape')];
      }
      const words = { both: 'present in A and B', a_only: 'present only in A', b_only: 'new in B', none: 'not present in either period' }[pres];
      const lab = labels.get(n.id);
      return h('svg:g', { class: `${cls} type-${n.type}`, tabindex: '0', role: 'button', dataset: { node: n.id, label: lab.hidden ? 'hidden' : lab.truncated ? 'truncated' : 'whole' },
        'aria-label': `${n.label} (${n.type}): ${period === 'overlay' ? words : `${n.present?.[period] ? 'present' : 'absent'} in ${period.toUpperCase()}`}`,
        onClick: () => openNode(n), onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); openNode(n); } } },
      h('svg:title', null, nodeTitle(n)),
      ...marks,
      lab.hidden ? null : h('svg:text', { x: lab.x.toFixed(1), y: lab.y.toFixed(1), 'text-anchor': 'start', class: 'con-label' }, lab.text));
    });
    return h('svg', { class: 'con-svg', width: String(SW), height: String(SH), viewBox: `0 0 ${SW} ${SH}`, role: 'group',
      'aria-label': `Constellation, ${period === 'overlay' ? 'A and B overlaid' : `period ${period.toUpperCase()}`}` }, edges, nodeEls);
  }

  function renderLegend(data) {
    const max = maxSize(data.nodes ?? []);
    const refs = referenceValues(data.legend, max);
    const sizeWord = SIZE_LABELS[view().constellation.size] ?? data.legend?.size;
    if (!local.legendOpen) {
      return h('div.con-legend.is-collapsed', null, h('button.btn', { type: 'button', onClick: () => { local.legendOpen = true; render(); } },
        `Legend: area ∝ ${sizeWord} (sqrt radius) · ${data.legend?.edge ?? 'edges by measure'}`));
    }
    return h('div.con-legend', { role: 'group', 'aria-label': 'Legend' },
      h('div.con-legend-row', null,
        h('svg', { width: String(2 * MAX_RADIUS * 3 + 40), height: String(2 * MAX_RADIUS + 16), 'aria-hidden': 'true' },
          refs.map((v, i) => h('svg:g', null,
            h('svg:circle', { cx: String(MAX_RADIUS + i * (2 * MAX_RADIUS + 8)), cy: String(MAX_RADIUS), r: String(radius(v, max) || MIN_RADIUS), class: 'con-ref' }),
            h('svg:text', { x: String(MAX_RADIUS + i * (2 * MAX_RADIUS + 8)), y: String(2 * MAX_RADIUS + 12), 'text-anchor': 'middle' }, formatCount(v))))),
        h('p', null, `area ∝ ${sizeWord} (sqrt radius); reference circles ${refs.map(formatCount).join(', ')}`)),
      h('p.meta', null, `edges: ${data.legend?.edge ?? '—'} · membership thin · relationships in evidence style · etymology dotted (shared ancestry, not shared meaning)`),
      h('p.meta', null, 'shape = type: ○ expression · ⬡ context group · □ work or document · ◇ theme · ▽ etymon · small ○ context word'),
      local.mode === 'overlay' && view().constellation.b ? h('p.meta', null, 'hollow amber ring = present only in A · dashed ivory ring = new in B · filled = both · two-tone ring = size changed') : null,
      h('p.meta', null, data.legend?.note ?? 'Positions are fixed for this layout key; movement is not semantic.'),
      h('button.btn', { type: 'button', onClick: () => { local.legendOpen = false; render(); } }, 'Collapse legend'));
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    const v = view();
    const a = periodA(v), b = v.constellation.b;
    root.appendChild(h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'constellation' }), 'aria-label': 'Close Constellation' }, '← Back'),
      h('div.cmp-heading', null, h('h2.cmp-h', null, 'Constellation'), h('p.cmp-sub', null, `A ${yearRangeLabel(a[0], a[1])}${b ? ` · B ${yearRangeLabel(b[0], b[1])}` : ''}`))));
    if (!v.strands.some((s) => s.type === 'expression')) { root.appendChild(renderEmptyCard('Pin an expression (P) to see its constellation.')); return; }
    const controls = h('div.con-controls', null,
      h('label', null, 'Size: ', h('select', { 'aria-label': 'Node size quantity', onChange: (e) => store.dispatch({ type: 'SET_CONSTELLATION', constellation: { size: e.target.value } }) },
        CONSTELLATION_SIZES.map((s) => h('option', { value: s, selected: s === v.constellation.size }, SIZE_LABELS[s])))),
      b ? h('div.con-mode', { role: 'group', 'aria-label': 'Two-period view' },
        ['overlay', 'split'].map((m) => h('button.btn', { type: 'button', 'aria-pressed': String(local.mode === m), onClick: () => { local.mode = m; render(); } }, m))) : null,
      h('button.btn', { type: 'button', onClick: () => load({ force: true, relayout: true }) }, 'Re-layout'));
    root.appendChild(periodEditor());
    root.appendChild(controls);
    if (local.error?.status === 404 && local.error.code === 'E_NOT_FOUND') {
      root.appendChild(renderEmptyCard('This server does not provide the constellation endpoint yet (GET /api/constellation answered 404), so nothing is drawn rather than a guess.'));
      return;
    }
    if (local.error) { root.appendChild(renderErrorCard(local.error, { what: 'The constellation could not be loaded.', onRetry: () => load({ force: true }) })); return; }
    if (local.loading && !local.data) { root.appendChild(renderLoadingLine('Loading the constellation…')); return; }
    const data = local.data;
    if (!data) return;
    root.classList.toggle('syn-frame', data.synthetic === true);
    if (data.synthetic) root.appendChild(h('p.meta', null, synBadge(), ' synthetic demonstration data'));
    local.measure ??= labelMeasure(root);
    const size = drawingSize();
    local.avail = Math.floor(root.getBoundingClientRect?.().width ?? 0);
    // a block wrapper: as a grid item of its own an SVG with height:auto gets a too-short row in Chrome (375 px)
    if (!b) root.appendChild(h('div.con-drawing', null, renderSvg(data, 'a', size)));
    else if (local.mode === 'split') root.appendChild(h('div.con-split', null, h('figure', null, h('figcaption', null, `A ${a[0]}–${a[1]}`), renderSvg(data, 'a', size)), h('figure', null, h('figcaption', null, `B ${b[0]}–${b[1]}`), renderSvg(data, 'b', size))));
    else root.appendChild(h('div.con-drawing', null, renderSvg(data, 'overlay', size)));
    const hidden = (data.nodes ?? []).length - root.querySelectorAll('.con-node[data-label="whole"], .con-node[data-label="truncated"]').length / (b && local.mode === 'split' ? 2 : 1);
    if (hidden > 0) root.appendChild(h('p.meta.con-hidden-labels', null, `${formatCount(hidden)} ${hidden === 1 ? 'label is' : 'labels are'} left out where they would overlap; every node names itself in its tooltip and when opened.`));
    // The legend is persistent and sits right under the drawing (it collapses to one line, never closes).
    root.appendChild(renderLegend(data));
    if ((data.truncated?.nodes ?? 0) > 0) root.appendChild(h('p.lin-truncated', { role: 'note' }, `+${formatCount(data.truncated.nodes)} more nodes not shown${data.truncated.reason ? ` (${data.truncated.reason})` : ''}`));
    if (b) {
      const d = diffList(data.nodes ?? []);
      root.appendChild(h('section.con-diff', { 'aria-label': 'Differences between A and B' },
        h('h4.section-title', null, 'Only in A / only in B / grew > 2×'),
        h('ul', { role: 'list' },
          h('li', null, `only in A (${d.onlyA.length}): ${d.onlyA.map((n) => n.label).join(', ') || 'none'}`),
          h('li', null, `only in B (${d.onlyB.length}): ${d.onlyB.map((n) => n.label).join(', ') || 'none'}`),
          h('li', null, `grew > 2× (${d.grew.length}): ${d.grew.map((n) => n.label).join(', ') || 'none'}`))));
    }
    if (local.detail) root.appendChild(h('div.con-detail', null, h('button.btn', { type: 'button', onClick: () => { local.detail = null; render(); } }, 'Close'), local.detail.el));
  }

  const unkeys = keys?.register?.('global', { k: { run: () => store.dispatch({ type: 'OPEN_PANEL', panel: 'constellation' }), label: 'Constellation' } }) ?? (() => {});
  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { load(); render(); }),
    store.subscribe((s) => s.view.constellation, () => load()),
    store.subscribe((s) => s.view.strands, () => load()),
  ];
  // Redraw at the new width when the panel is resized (labels are placed in real pixels).
  let raf = 0;
  const win = root.ownerDocument?.defaultView ?? null;
  const RO = win?.ResizeObserver;
  const ro = typeof RO === 'function' ? new RO(() => {
    const w = Math.floor(root.getBoundingClientRect().width);
    if (!local.data || !isOpen() || !w || Math.abs(w - (local.avail ?? 0)) < 12) return;
    win.cancelAnimationFrame?.(raf);
    raf = win.requestAnimationFrame?.(() => render()) ?? 0;
  }) : null;
  ro?.observe(root);
  if (isOpen()) load();
  render();
  return { unmount() { ro?.disconnect(); win?.cancelAnimationFrame?.(raf); unkeys(); for (const u of unsubs) u(); local.seq++; root.remove(); } };
}
