// OWNER: WP6
// timeline/shelves.mjs — the UNDATED and SCHEDULED shelves (SPEC §1.4, §1.7): pinned columns beside the
// Scroll with per-lane counts; a click lists the items (virtualized, searchable — drawer.mjs). Undated
// items never enter bins, rates or denominators; scheduled items (dated after today, e.g. announced
// 2027–2038 works) never enter the chronology either. On narrow screens both become chips (⊘ 4).

import { formatCount } from '../../shared/format.mjs';
import { h, clear } from '../core/dom.mjs';
import { scrollHub } from './viewport.mjs';
import { LANES_TOP } from './display.mjs';

/** The shelves mount into both shelf regions; the region decides which shelf. */
export const region = ['shelf-undated', 'shelf-scheduled'];

export const SHELF = Object.freeze({
  undated: { title: 'UNDATED', sub: 'outside chronology', glyph: '⊘', field: 'undated', total: 'undated',
    note: 'Undated items never enter bins, rates or denominators.' },
  scheduled: { title: 'SCHEDULED', sub: 'after today', glyph: '◷', field: 'scheduled', total: 'scheduled',
    note: 'Dated after today (announced); outside the chronology until then.' },
});

/**
 * Per-lane shelf counts of a model.
 * @param {{lanes: Array<{key: string, label: string, undated: number, scheduled: number}>}|null} model
 * @param {'undated'|'scheduled'} which
 */
export function shelfCounts(model, which) {
  return (model?.lanes ?? []).map((l) => ({ key: l.key, label: l.label, n: l[SHELF[which].field] ?? 0 }));
}

function openList(store, which, lane = null, label = null) {
  store.dispatch({ type: 'UI_SET', key: 'drawer', value: { kind: 'shelf', which, lane, title: `${SHELF[which].title}${label ? ` · ${label}` : ''}` } });
}

/**
 * @param {HTMLElement} el this module's slot in #shelf-undated or #shelf-scheduled
 * @param {{store: object, regions: Record<string, HTMLElement>}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store } = ctx;
  const which = el.parentElement?.id === 'shelf-scheduled' ? 'scheduled' : 'undated';
  const def = SHELF[which];
  const total = h('button.shelf-total', { type: 'button', onClick: () => openList(store, which) });
  const head = h('div.shelf-head', { style: { height: `${LANES_TOP}px` } },
    h('span.shelf-title', null, def.title), h('span.shelf-sub', null, def.sub), total);
  const body = h('div.shelf-body', { role: 'list', 'aria-label': `${def.title} counts per lane` });
  const spine = h('span.shelf-spine', { 'aria-hidden': 'true' }, `${def.title} · ${def.sub}`);
  const col = h(`div.shelf.shelf-${which}`, { title: def.note }, head, body, spine);
  el.appendChild(col);

  // Narrow: one chip per shelf in the lanes column.
  const chip = h('button.chip.shelf-chip', { type: 'button', hidden: true, onClick: () => openList(store, which) });
  const chipHost = ctx.regions?.lanes;
  chipHost?.appendChild(chip);

  let lastKey = '';
  function render(st) {
    const model = st.model, lay = st.layout;
    const t = st.query?.totals?.[def.total] ?? 0;
    total.textContent = `${def.glyph} ${formatCount(t)}`;
    total.setAttribute('aria-label', `${def.title}: ${formatCount(t)} ${t === 1 ? 'item' : 'items'} — list them`);
    chip.textContent = `${def.glyph} ${formatCount(t)}`;
    chip.title = `${def.title} (${def.sub}): ${formatCount(t)}`;
    chip.hidden = !(t > 0);
    body.style.setProperty('--lanes-scroll', `${-st.scrollY}px`);
    const key = JSON.stringify([shelfCounts(model, which), lay?.lanes.map((l) => [l.y, l.h])]);
    if (key === lastKey) return;
    lastKey = key;
    clear(body);
    if (!model || !lay) return;
    model.lanes.forEach((lane, i) => {
      const l = lay.lanes[i];
      const n = lane[def.field] ?? 0;
      body.append(h('div.shelf-cell', { role: 'listitem', style: { top: `${l.y}px`, height: `${l.h}px` }, dataset: { alt: String(i % 2 === 1) } },
        n > 0 ? h('button.shelf-count', { type: 'button', title: `${lane.label}: ${formatCount(n)} ${def.title.toLowerCase()} — list them`, onClick: () => openList(store, which, lane.key, lane.label) },
          `${def.glyph} ${formatCount(n)}`) : h('span.shelf-zero', { 'aria-label': `${lane.label}: none` }, '·')));
    });
    body.style.height = `${lay.height}px`;
  }
  const unsub = scrollHub.subscribe(render, { immediate: true });
  const onWheel = (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); scrollHub.actions.scrollBy?.(e.deltaY); } };
  col.addEventListener('wheel', onWheel, { passive: false });
  return { unmount() { unsub(); col.removeEventListener('wheel', onWheel); col.remove(); chip.remove(); } };
}
