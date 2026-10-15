// OWNER: WP6
// timeline/drawer.mjs — the bin drawer and the shelf lists (SPEC §1.6 "aggregate click", §1.7): the
// denominator line on top, then KWIC rows sorted by date, 50 per page, virtualized; every row opens its
// passage, so every quantity on the Scroll is ≤ 2 clicks from text. Shelf lists (undated, scheduled,
// washes) use the same drawer with a filter box.

import { formatCount, formatRate, formatCI, formatTokens } from '../../shared/format.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { binLabel } from './tiers.mjs';
import { parseBinId, scrollHub } from './viewport.mjs';

/** Row height of the virtualized list (px) and the overscan (rows). */
export const ROW_H = 58;
const OVERSCAN = 8;

/**
 * The denominator line of a bin page (the server's `text` when given, else built from its numbers).
 * @param {object} d BinDrawer.denominator
 * @returns {string}
 */
export function denominatorLine(d) {
  if (!d) return '';
  if (d.text) return d.text;
  const parts = [`n = ${formatCount(d.n)} in ${d.label}`, `${formatTokens(d.tokens)} tokens`, `${formatCount(d.docs)} documents`];
  if (Number.isFinite(d.rate)) parts.push(`${formatRate(d.rate, d.unit)} ${formatCI(d.ci, d.unit)}`);
  return parts.join(' · ');
}

/**
 * The line on top of an OpenAlex cell's list: its k of n, and what the share is not.
 * @param {{k?: number, n?: number, from: number, to: number}} spec
 * @returns {string}
 */
export function cellLine(spec) {
  const kn = Number.isInteger(spec.k) && Number.isInteger(spec.n) ? `${formatCount(spec.k)} of ${formatCount(spec.n)} sampled works in ${spec.from}–${spec.to} mention it` : `${spec.from}–${spec.to}`;
  return `${kn} · top-cited sample of this cell: a within-cell share, not a trend`;
}

/**
 * Rows a filter string keeps (case-insensitive over title, author, match and date label).
 * @param {object[]} rows
 * @param {string} q
 */
export function filterRows(rows, q) {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => [r.title, r.author, r.match, r.left, r.right, r.date?.label, r.label].some((x) => typeof x === 'string' && x.toLowerCase().includes(s)));
}

/**
 * @param {HTMLElement} el this module's slot in #sheet
 * @param {{store: object, api: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys, announce } = ctx;
  const cleanups = [];
  let spec = null;          // ui.drawer
  let rows = [];
  let cursor = null;
  let total = 0;
  let denominator = null;
  let loading = false;
  let error = null;
  let filter = '';
  let unkeys = null;
  let waiting = false;

  const title = h('h2.drawer-title');
  const denom = h('p.drawer-denom');
  const filterBox = h('input.drawer-filter', { type: 'search', placeholder: 'Filter this list', 'aria-label': 'Filter this list', hidden: true,
    onInput: (e) => { filter = e.target.value; renderRows(); } });
  const list = h('div.drawer-list', { role: 'list' });
  const spacer = h('div.drawer-spacer');
  const viewport = h('div.drawer-scroll', { onScroll: () => renderRows() }, spacer, list);
  const more = h('button.btn.drawer-more', { type: 'button', hidden: true, onClick: () => load(true) }, 'Load 50 more');
  const status = h('p.drawer-status.meta', { role: 'status' });
  const closeBtn = h('button.btn.drawer-close', { type: 'button', 'aria-label': 'Close the list', onClick: () => close() }, '×');
  const panel = h('section.drawer', { role: 'dialog', 'aria-labelledby': 'drawer-title', hidden: true },
    h('div.drawer-head', null, title, closeBtn), denom, filterBox, viewport, h('div.drawer-foot', null, status, more));
  title.id = 'drawer-title';
  el.appendChild(panel);

  function close() {
    store.dispatch({ type: 'UI_SET', key: 'drawer', value: null });
    const sel = store.get().view.selection;
    if (sel?.type === 'bin') store.dispatch({ type: 'SELECT', selection: null });
  }

  async function load(next = false) {
    if (!spec) return;
    const q = scrollHub.get().query?.queryKey;
    if (!q) { waiting = true; loading = true; renderMeta(); return; }
    waiting = false;
    loading = true;
    error = null;
    renderMeta();
    const mySpec = spec;
    try {
      let res;
      if (spec.kind === 'bin') {
        res = await api.get('/timeline/bin', { q, lane: spec.lane, strand: spec.strand, tier: spec.tier, bin: spec.bin, cursor: next ? cursor : null }, { key: 'drawer' });
        denominator = res.denominator ?? null;
      } else if (spec.kind === 'cell') {
        // An OpenAlex cell (C3): the concordance of this lane over the cell's years.
        res = await api.get('/kwic', { q, expr: spec.expr ?? null, lane: spec.lane, from: spec.from, to: spec.to, sort: 'date', cursor: next ? cursor : null, limit: 50 }, { key: 'drawer' });
      } else {
        res = await api.get('/timeline/shelf', { q, which: spec.which, lane: spec.lane ?? null, cursor: next ? cursor : null }, { key: 'drawer' });
      }
      if (mySpec !== spec) return;
      const got = res.rows ?? res.items ?? [];
      rows = next ? [...rows, ...got] : got;
      cursor = res.cursor ?? null;
      total = res.total ?? rows.length;
      announce(`${formatCount(rows.length)} of ${formatCount(total)} rows loaded.`);
    } catch (err) {
      if (isAbort(err)) return;
      error = { message: err.message, hint: err.hint ?? null };
    } finally {
      loading = false;
    }
    renderMeta();
    renderRows();
  }

  function renderMeta() {
    title.textContent = spec?.title ?? '';
    denom.textContent = spec?.kind === 'bin' ? denominatorLine(denominator) : spec?.kind === 'cell' ? cellLine(spec) : spec?.which === 'undated'
      ? 'Undated items never enter bins, rates or denominators.' : spec?.which === 'scheduled'
        ? 'Dated after today (announced); outside the chronology.' : spec?.which === 'washes'
          ? 'Records whose dates do not fit one bin at this level: shown as washes, never added to bars or rates.' : '';
    denom.classList.toggle('is-syn', Boolean(spec?.kind === 'bin' && denominator?.text?.includes('SYNTHETIC')));
    filterBox.hidden = spec?.kind !== 'shelf';
    more.hidden = !cursor || loading;
    status.textContent = error ? `${error.message}${error.hint ? ` ${error.hint}` : ''}` : loading ? 'loading…' : `${formatCount(rows.length)} of ${formatCount(total)}`;
    status.dataset.kind = error ? 'error' : '';
  }

  function rowNode(r, i) {
    const open = r.passage ? () => { store.dispatch({ type: 'SELECT', selection: { type: 'passage', id: r.passage } }); store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' }); }
      : r.document_id ? () => { store.dispatch({ type: 'SELECT', selection: { type: 'document', id: r.document_id } }); store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' }); } : null;
    const syn = r.synthetic ? h('span.badge.badge-syn', null, 'SYN') : null;
    let content;
    if (r.match !== undefined) {
      content = [h('span.row-date.num', null, r.date?.label ?? ''), h('span.row-title', null, r.title ?? ''), syn,
        h('span.row-kwic', null, h('span.kwic-l', null, r.left ?? ''), h('mark', null, r.match), h('span.kwic-r', null, r.right ?? ''))];
    } else if (r.label !== undefined && r.lo !== undefined) {
      content = [h('span.row-date.num', null, r.label), h('span.row-title', null, `${formatCount(r.n)} ${r.n === 1 ? 'match' : 'matches'} · ${r.lane}`), syn,
        h('span.row-kwic.meta', null, `dated ${r.lo}–${r.hi} (${r.precision})`)];
    } else {
      content = [h('span.row-date.num', null, r.date?.label ?? 'undated'), h('span.row-title', null, r.title ?? `document ${r.document_id}`), syn,
        h('span.row-kwic.meta', null, [r.author, r.kind, r.date?.raw ? `as given: “${r.date.raw}”` : null, r.date?.basis].filter(Boolean).join(' · '))];
    }
    const node = open ? h('button.drawer-row', { type: 'button', role: 'listitem', onClick: open, style: { top: `${i * ROW_H}px` } }, content)
      : h('div.drawer-row', { role: 'listitem', style: { top: `${i * ROW_H}px` } }, content);
    return node;
  }

  function renderRows() {
    const shown = filterRows(rows, filter);
    spacer.style.height = `${shown.length * ROW_H}px`;
    const top = viewport.scrollTop, hgt = viewport.clientHeight || 400;
    const a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN), b = Math.min(shown.length, Math.ceil((top + hgt) / ROW_H) + OVERSCAN);
    clear(list);
    for (let i = a; i < b; i++) list.append(rowNode(shown[i], i));
    if (!shown.length && !loading && !error) list.append(h('p.meta.drawer-empty', null, spec?.kind === 'bin' ? 'No passages in this bin (see the denominator line).'
      : spec?.kind === 'cell' ? 'No passages listed for this cell (see the line above).' : 'Nothing on this shelf for this lane.'));
  }

  function openSpec(next) {
    spec = next;
    rows = []; cursor = null; total = 0; denominator = null; error = null; filter = ''; filterBox.value = '';
    panel.hidden = !spec;
    panel.classList.toggle('syn-frame', Boolean(scrollHub.get().query?.provenance?.synthetic));
    if (!spec) { unkeys?.(); unkeys = null; return; }
    unkeys?.();
    unkeys = keys.register('global', { Escape: { run: () => { close(); return true; }, label: 'close the list' } });
    renderMeta();
    renderRows();
    load(false);
  }

  cleanups.push(store.subscribe((s) => s.ui.drawer, (d) => openSpec(d ?? null)));
  cleanups.push(scrollHub.subscribe((st) => { if (waiting && spec && st.query?.queryKey) load(false); }));
  cleanups.push(store.subscribe((s) => s.view.selection, (sel) => {
    if (sel?.type !== 'bin') return;
    const b = parseBinId(sel.id);
    if (!b) return;
    const st = scrollHub.get();
    const lane = st.model?.lanes.find((l) => l.key === b.lane);
    const strand = lane?.strands.find((x) => x.ref === b.strand);
    const t = `${binLabel(b.tier, b.bin)} · ${lane?.label ?? b.lane}${strand ? ` · ${strand.label}` : ''}`;
    store.dispatch({ type: 'UI_SET', key: 'drawer', value: { kind: 'bin', lane: b.lane, strand: b.strand, tier: b.tier, bin: b.bin, title: t } });
  }, { immediate: true }));

  return { unmount() { unkeys?.(); for (const fn of cleanups.splice(0)) fn(); panel.remove(); } };
}
