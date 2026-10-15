// OWNER: WP7
// panels/context-group.mjs — one context group (a clustering run's hypothesis about usage contexts, SPEC §4.8) as
// a block, shared by the inspector's NEXT column and Compare: the machine label with any reader's label beside it
// (the machine label stays visible after a rename, §13 rule 10), the group's share of the expression's grouped
// uses per window over time with the document-block 95% CIs (gaps stay gaps: an uncovered window is "no sources",
// a thin one "too few uses", never a bridged line), optional per-slice shares from Compare, and a rename control.
// A rename is a notebook annotation of kind 'label' on the cluster (POST /api/annotations), or a new revision of
// the reader's own label (PATCH /api/annotations/:id); GET /api/clusters then returns it as `human_label`.

import { h, clear } from '../core/dom.mjs';
import { formatCount, formatShare } from '../../shared/format.mjs';
import { yearLabel } from '../../shared/dates.mjs';
import { renderErrorCard } from './gate-card.mjs';

/** The prefix the server puts on machine labels ("machine label: lesson · write · tapped · digit"). */
export const MACHINE_PREFIX = 'machine label: ';
/** The longest reader's label accepted (characters). */
export const RENAME_MAX = 80;
/** Whose label a rename writes (the server's default author for this local, single-user app). */
export const DEFAULT_AUTHOR = 'you';
/** Under every block (§13 rule 11). */
export const GROUP_CAPTION = 'A context group is computed from usage contexts: context words, not meanings, and not a sense the writers declared.';
/** What the share-over-time chart shows (once per block, or once per list of blocks). */
export const SERIES_CAPTION = "Share of the expression's grouped uses per window (document-block bootstrap 95% CI, lighter; dashed box = no sources, dotted box = too few uses; nothing is drawn between windows)";
/** Geometry of the share-over-time chart (CSS px). */
export const CHART = Object.freeze({ w: 320, h: 48, pad: 2 });

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 'machine label: a · b' → 'a · b'. */
export function machineTerms(label) {
  const s = String(label ?? '');
  return s.startsWith(MACHINE_PREFIX) ? s.slice(MACHINE_PREFIX.length) : s;
}

/**
 * Labels of a group from GET /api/clusters (or a Compare share row): the machine label always, the reader's label
 * when one exists, with who wrote it and when.
 * @param {{machine_label?: string, label?: string, human_label?: string|null, human_label_by?: string|null,
 *   human_label_at?: string|null, ord?: number, id?: number, cluster?: number}} c
 * @returns {{machine: string, human: string|null, by: string|null, at: string|null}}
 */
export function groupLabels(c) {
  const raw = c?.machine_label ?? c?.label ?? null;
  const fallback = `context group ${c?.ord ?? c?.id ?? c?.cluster ?? '?'}`;
  const terms = raw ? machineTerms(raw) : '';
  return {
    machine: terms ? `${MACHINE_PREFIX}${terms}` : `${fallback} (no machine label)`,
    human: typeof c?.human_label === 'string' && c.human_label.trim() ? c.human_label.trim() : null,
    by: c?.human_label_by ?? null,
    at: c?.human_label_at ? String(c.human_label_at).slice(0, 10) : null,
  };
}

/**
 * The group's share per window, sorted by time. A share (with its CI and n) is given only for a measured window
 * that has a share row; uncovered and thin windows keep their state and carry no number.
 * @param {{windows?: object[], shares?: object[]}} data GET /api/clusters
 * @param {number} clusterId
 * @returns {Array<{id: number, label: string, lo: number|null, hi: number|null, state: string, n: number|null,
 *   share: number|null, ci: [number, number]|null}>}
 */
export function shareSeries(data, clusterId) {
  const rows = new Map((data?.shares ?? []).filter((s) => s.cluster === clusterId).map((s) => [s.window, s]));
  return (data?.windows ?? [])
    .filter((w) => w.state !== 'slice')
    .map((w) => {
      const r = rows.get(w.id);
      const measured = w.state === 'measured' && r && isNum(r.share);
      return {
        id: w.id, label: w.label ?? `${w.lo}–${w.hi}`, lo: Number.isInteger(w.lo) ? w.lo : null, hi: Number.isInteger(w.hi) ? w.hi : null,
        state: measured ? 'measured' : w.state === 'measured' ? 'no_share' : w.state ?? 'unknown',
        n: Number.isInteger(w.n) ? w.n : null,
        share: measured ? r.share : null,
        ci: measured && Array.isArray(r.ci) && r.ci.every(isNum) ? [r.ci[0], r.ci[1]] : null,
      };
    })
    .sort((a, b) => (a.lo ?? Infinity) - (b.lo ?? Infinity));
}

/** Words for one window of the series. */
export function windowWords(w) {
  if (w.state === 'measured') {
    return `${w.label}: ${formatShare(w.share)}${w.ci ? ` [${formatShare(w.ci[0])}, ${formatShare(w.ci[1])}]` : ''}`
      + `${Number.isInteger(w.n) ? ` of ${formatCount(w.n)} grouped uses` : ''}`;
  }
  if (w.state === 'uncovered') return `${w.label}: no sources`;
  if (w.state === 'thin') return `${w.label}: too few uses to measure${Number.isInteger(w.n) ? ` (${formatCount(w.n)})` : ''}`;
  return `${w.label}: no share`;
}

/**
 * The request a rename makes, or why there is none. The reader's own label gets a new revision; anyone else's
 * label (or none) gets a new label annotation, which the server reads as the newest.
 * @param {{id: number, human_label?: string|null, human_label_by?: string|null, label_annotation?: number|null}} cluster
 * @param {string} text
 * @param {{author?: string}} [opts]
 * @returns {{ok: true, method: 'post'|'patch', path: string, body: object} | {ok: false, reason: string}}
 */
export function renameRequest(cluster, text, { author = DEFAULT_AUTHOR } = {}) {
  const label = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(cluster?.id)) return { ok: false, reason: 'This group has no id to label.' };
  if (!label) return { ok: false, reason: 'Type a label first.' };
  if ([...label].length > RENAME_MAX) return { ok: false, reason: `A label has at most ${RENAME_MAX} characters.` };
  if (label === (cluster.human_label ?? '').trim()) return { ok: false, reason: 'That is already the label.' };
  if (Number.isInteger(cluster.label_annotation) && cluster.human_label_by === author) {
    return { ok: true, method: 'patch', path: `/annotations/${cluster.label_annotation}`, body: { body_md: label, reason: 'renamed the context group' } };
  }
  return { ok: true, method: 'post', path: '/annotations', body: { target: { type: 'cluster', ref: String(cluster.id) }, kind: 'label', body_md: label } };
}

/**
 * A step chart of the series on a linear time axis (D3): one bar per measured window spanning its years, its
 * CI as a lighter band, uncovered windows hatched, thin windows dotted; nothing is drawn between windows.
 * @param {ReturnType<typeof shareSeries>} series
 * @param {{w?: number, h?: number}} [size]
 * @returns {SVGElement|null}
 */
export function renderShareChart(series, { w = CHART.w, h: ht = CHART.h } = {}) {
  const dated = series.filter((s) => Number.isInteger(s.lo) && Number.isInteger(s.hi));
  if (!dated.length) return null;
  const lo = Math.min(...dated.map((s) => s.lo)), hi = Math.max(...dated.map((s) => s.hi)) + 1;
  const x = (y) => CHART.pad + ((y - lo) / Math.max(1, hi - lo)) * (w - 2 * CHART.pad);
  const y = (v) => ht - CHART.pad - v * (ht - 2 * CHART.pad);
  const parts = [h('svg:line', { x1: String(CHART.pad), x2: String(w - CHART.pad), y1: String(y(0)), y2: String(y(0)), class: 'cg-axis' })];
  for (const s of dated) {
    const x0 = x(s.lo), x1 = Math.max(x0 + 1, x(s.hi + 1) - 1);
    if (s.state === 'measured') {
      if (s.ci) parts.push(h('svg:rect', { x: x0.toFixed(1), y: y(s.ci[1]).toFixed(1), width: (x1 - x0).toFixed(1), height: Math.max(0.5, y(s.ci[0]) - y(s.ci[1])).toFixed(1), class: 'cg-ci' }));
      parts.push(h('svg:rect', { x: x0.toFixed(1), y: y(s.share).toFixed(1), width: (x1 - x0).toFixed(1), height: Math.max(1, y(0) - y(s.share)).toFixed(1), class: 'cg-bar' }));
    } else {
      parts.push(h('svg:rect', { x: x0.toFixed(1), y: String(CHART.pad), width: (x1 - x0).toFixed(1), height: String(ht - 2 * CHART.pad), class: `cg-gap is-${s.state}` }));
    }
  }
  const summary = series.map(windowWords).join('; ');
  return h('svg', { class: 'cg-chart', width: String(w), height: String(ht), viewBox: `0 0 ${w} ${ht}`, role: 'img',
    'aria-label': `Share of grouped uses per window, ${yearLabel(lo)}–${yearLabel(hi - 1)}, 0 to 100%: ${summary}` }, parts);
}

/**
 * A persistent context-group block: the caller passes fresh data with update(); an open rename form survives it.
 * @param {{api: object, cluster: object, data?: object|null, slices?: {a?: object, b?: object, names?: {a: string, b: string}, flag?: string}|null,
 *   author?: string, announce?: Function, onRenamed?: (label: string) => void, compact?: boolean}} opts
 *   `cluster` is a GET /api/clusters cluster (or a Compare share row with `cluster` as its id)
 * @returns {{el: HTMLElement, update(next: {cluster?: object, data?: object|null, slices?: object|null}): void}}
 */
export function createGroupBlock({ api, cluster, data = null, slices = null, author = DEFAULT_AUTHOR, announce = () => {}, onRenamed = null, compact = false,
  caption = true }) {
  const st = { cluster: normalise(cluster), data, slices, editing: false, draft: '', saving: false, status: null, error: null, showWindows: !compact };
  const el = h('section.cg-block', { 'aria-label': 'Context group' });

  async function save() {
    const req = renameRequest(st.cluster, st.draft, { author });
    if (!req.ok) { st.status = req.reason; st.error = null; render(); return; }
    st.saving = true; st.status = 'Saving…'; st.error = null;
    render();
    try {
      await api[req.method](req.path, req.body, { key: `cg-rename-${st.cluster.id}` });
      const label = req.body.body_md;
      st.cluster = { ...st.cluster, human_label: label, human_label_by: author };
      st.editing = false; st.saving = false; st.status = `Renamed to "${label}". The machine label stays visible.`;
      announce(`Context group renamed to ${label}`);
      render();
      onRenamed?.(label);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      st.saving = false; st.status = null; st.error = err;
      render();
    }
  }

  function renderRename() {
    if (!st.editing) {
      return h('div.cg-actions', null,
        h('button.btn.cg-rename', { type: 'button', onClick: () => { st.editing = true; st.draft = st.cluster.human_label ?? ''; st.status = null; st.error = null; render(); el.querySelector('.cg-input')?.focus?.(); } },
          st.cluster.human_label ? 'Rename again' : 'Rename'),
        st.status ? h('span.meta', { role: 'status' }, st.status) : null);
    }
    const input = h('input.cg-input', { type: 'text', value: st.draft, maxlength: String(RENAME_MAX), disabled: st.saving,
      'aria-label': 'A reader\'s label for this context group (the machine label stays visible)', placeholder: 'a reader\'s label',
      onInput: (e) => { st.draft = e.target.value; },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); st.draft = e.target.value; save(); } if (e.key === 'Escape') { e.preventDefault(); st.editing = false; render(); } } });
    // Enter in the field and the Save button both save; the form itself never submits (no double save)
    return h('form.cg-form', { onSubmit: (e) => e.preventDefault() },
      input,
      h('button.btn.btn-primary', { type: 'button', disabled: st.saving, onClick: () => { st.draft = input.value; save(); } }, 'Save label'),
      h('button.btn', { type: 'button', disabled: st.saving, onClick: () => { st.editing = false; st.status = null; render(); } }, 'Cancel'),
      h('p.meta.cg-form-note', null, `Writes a notebook annotation of kind 'label' by ${author}; the machine label is kept and stays visible.`),
      st.status ? h('p.meta', { role: 'status' }, st.status) : null,
      st.error ? renderErrorCard(st.error, { what: 'The label could not be saved.' }) : null);
  }

  function renderSlices() {
    const s = st.slices;
    if (!isObj(s)) return null;
    // a row's n is the group's own count in the slice; the denominator is the slice's grouped uses (`totals`)
    const one = (k) => {
      const x = s[k], name = s.names?.[k] ?? k.toUpperCase(), total = s.totals?.[k];
      if (!isObj(x) || !isNum(x.share)) return `${name}: no grouped uses`;
      const count = Number.isInteger(x.n) && Number.isInteger(total) ? ` (${formatCount(x.n)} of ${formatCount(total)} grouped uses)`
        : Number.isInteger(x.n) ? ` (${formatCount(x.n)} uses in this group)` : '';
      return `${name}: ${formatShare(x.share)}${Array.isArray(x.ci) ? ` [${formatShare(x.ci[0])}, ${formatShare(x.ci[1])}]` : ''}${count}`;
    };
    return h('p.cg-slices.num', null, `${one('a')} · ${one('b')}`, s.flag ? h('span.cg-flag', null, ` · ${s.flag}`) : null);
  }

  function renderSeries() {
    if (!st.data) return null;
    const series = shareSeries(st.data, st.cluster.id);
    if (!series.length) return h('p.meta', null, 'This run lists no time windows, so no shares over time are shown.');
    const chart = renderShareChart(series);
    const range = series.filter((x) => Number.isInteger(x.lo));
    return h('div.cg-series', null,
      caption ? h('p.meta', null, `${SERIES_CAPTION}${range.length ? ` — ${range[0].label} to ${range[range.length - 1].label}` : ''}`) : null,
      chart,
      compact ? h('button.btn.cg-windows', { type: 'button', 'aria-expanded': String(st.showWindows), onClick: () => { st.showWindows = !st.showWindows; render(); } },
        st.showWindows ? 'Hide the windows' : 'Show the windows as a list') : null,
      st.showWindows ? h('ul.cg-windows-list', { role: 'list' }, series.map((w) => h('li', { class: { meta: w.state !== 'measured' } }, windowWords(w)))) : null);
  }

  function render() {
    const c = st.cluster;
    const l = groupLabels(c);
    const meta = [Number.isInteger(c.n) ? `n = ${formatCount(c.n)}` : null, Number.isInteger(c.docs) ? `${formatCount(c.docs)} documents` : null,
      isNum(c.stability) ? `stability ${c.stability.toFixed(2)}${c.tentative ? ' (tentative)' : ''}` : null, c.residual ? 'other contexts (residual)' : null]
      .filter(Boolean).join(' · ');
    el.dataset.cluster = String(c.id ?? '');
    el.classList.toggle('is-tentative', c.tentative === true);
    clear(el).append(...[
      h('header.cg-head', null,
        l.human ? h('p.cg-human', null, h('span.cg-human-label', null, `“${l.human}”`), h('span.meta', null, ` — a reader's label${l.by ? ` by ${l.by}` : ''}${l.at ? `, ${l.at}` : ''}`)) : null,
        h('p.cg-machine', { class: { 'is-primary': !l.human } }, l.machine, h('span.meta', null, l.human ? ' (kept)' : ' (editable)'))),
      meta ? h('p.meta.num', null, meta) : null,
      renderSlices(),
      renderSeries(),
      renderRename(),
    ].filter(Boolean));
  }

  render();
  return {
    el,
    update(next = {}) {
      if (next.cluster) st.cluster = { ...normalise(next.cluster) };
      if ('data' in next) st.data = next.data;
      if ('slices' in next) st.slices = next.slices;
      render();
    },
  };
}

/** A Compare share row carries its id as `cluster`; a GET /api/clusters group as `id`. */
function normalise(c) {
  if (!isObj(c)) return { id: null };
  return Number.isInteger(c.id) ? c : { ...c, id: Number.isInteger(c.cluster) ? c.cluster : null };
}

/**
 * Library module: nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
