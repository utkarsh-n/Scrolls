// OWNER: WP6
// shell/layout.mjs — desktop vs narrow regions (SPEC §8.6), the inspector split and floating popovers.
//
// Narrow (< 720 px): the timeline takes the top 55vh with ≤ 5 lanes, shelves become chips, the minimap stays
// (20 px), the inspector is a bottom sheet (panels/inspector.mjs draws it), the toolbar becomes a bottom bar
// (Search · Play · Lanes · Filters · More) and the legend a chip. layoutFor() is the pure rule; mount()
// publishes it as ui.layout and html[data-layout].
//
// The region grid puts the legend directly under the Scroll and the inspector after it (shell.css); where the
// inspector docks on desktop (slim line, bottom split, right column ≥ 1280 px) is panels/inspector.mjs's
// (#inspector[data-dock]). On narrow screens this module gives the inspector its bottom sheet (snap 30% / 60% /
// 92%) with a drag handle.
//
// Popovers (search suggestions, filters, the More menu) are portalled to <body> and positioned `fixed` from
// their anchor, so no toolbar overflow or canvas stacking context can clip or cover them.

import { h } from '../core/dom.mjs';
import { capturePointer } from '../timeline/input.mjs';

export const NARROW_MAX = 719.98;
/** From this width the inspector becomes a right-hand column (QA: the Scroll keeps its height). */
export const WIDE_MIN = 1280;
/** Snap points of the narrow bottom sheet, as shares of the viewport height. */
export const SHEET_SNAPS = Object.freeze([0.3, 0.6, 0.92]);
/** This module mounts twice: once for the whole app, once inside the inspector (the narrow sheet handle). */
export const region = ['app', 'inspector'];

/**
 * The layout rule for a viewport.
 * @param {number} width CSS px
 * @param {number} [height=800]
 * @returns {{mode: 'narrow'|'desktop', maxLanes: number, minimapH: number, headerW: number, shelves: 'columns'|'chips',
 *            toolbar: 'top'|'bottom', inspector: 'docked'|'sheet', legend: 'strip'|'chip', timelineH: number|null,
 *            slotH: number, coarsePointer: boolean, inspectorSide: 'right'|'bottom'|'sheet'}}
 */
export function layoutFor(width, height = 800, { coarsePointer = false } = {}) {
  const narrow = width <= NARROW_MAX;
  return {
    mode: narrow ? 'narrow' : 'desktop',
    maxLanes: narrow ? 5 : 10,
    minimapH: narrow ? 20 : 28,
    headerW: narrow ? 84 : 168,
    shelves: narrow ? 'chips' : 'columns',
    toolbar: narrow ? 'bottom' : 'top',
    inspector: narrow ? 'sheet' : 'docked',
    legend: narrow ? 'chip' : 'strip',
    timelineH: narrow ? Math.round(height * 0.55) : null,
    slotH: 24,
    coarsePointer: Boolean(coarsePointer),
    inspectorSide: narrow ? 'sheet' : width >= WIDE_MIN ? 'right' : 'bottom',
  };
}

/**
 * The snap point nearest to a height share.
 * @param {number} share 0–1
 * @returns {number}
 */
export function nearestSnap(share) {
  return SHEET_SNAPS.reduce((best, s) => (Math.abs(s - share) < Math.abs(best - share) ? s : best), SHEET_SNAPS[0]);
}

/**
 * Where a floating popover goes: below (or above) its anchor, aligned to its start or end, kept on screen.
 * @param {{left: number, top: number, right: number, bottom: number, width: number}} anchor bounding rect
 * @param {{width: number, height: number}} pop size of the popover
 * @param {{width: number, height: number}} vp viewport
 * @param {{align?: 'start'|'end', place?: 'below'|'above', gap?: number}} [opts]
 * @returns {{left: number, top: number, maxHeight: number}}
 */
export function popoverPosition(anchor, pop, vp, { align = 'start', place = 'below', gap = 6 } = {}) {
  const margin = 8;
  let left = align === 'end' ? anchor.right - pop.width : anchor.left;
  left = Math.max(margin, Math.min(left, vp.width - pop.width - margin));
  const below = vp.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const goBelow = place === 'below' ? below >= Math.min(pop.height, 240) || below >= above : above < Math.min(pop.height, 240) && below > above;
  if (goBelow) return { left, top: anchor.bottom + gap, maxHeight: Math.max(120, below) };
  const maxHeight = Math.max(120, above);
  return { left, top: Math.max(margin, anchor.top - gap - Math.min(pop.height, maxHeight)), maxHeight };
}

/**
 * The priority+ fit (toolbar, legend strip): hide the lowest-priority items one at a time until `overflows()` is
 * false, after showing them all.
 * @param {Array<{prio: number, hide(): void, show(): void}>} items
 * @param {() => boolean} overflows
 * @returns {number} how many were hidden (the first n of the items sorted by prio)
 */
export function fitPriority(items, overflows) {
  const sorted = [...items].sort((a, b) => a.prio - b.prio);
  for (const it of sorted) it.show();
  let n = 0;
  while (n < sorted.length && overflows()) sorted[n++].hide();
  return n;
}

/**
 * A popover portalled to <body> and positioned `fixed` from an anchor element.
 * @param {HTMLElement} el the popover element (moved to <body>)
 * @param {() => HTMLElement|null} anchor
 * @param {{align?: 'start'|'end', place?: 'below'|'above', matchWidth?: boolean, minWidth?: number}} [opts]
 * @returns {{position(): void, destroy(): void}}
 */
export function floatPopover(el, anchor, { align = 'start', place = 'below', matchWidth = false, minWidth = 0 } = {}) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  el.classList.add('floating');
  doc.body.appendChild(el);
  function position() {
    if (el.hidden) return;
    const a = anchor();
    if (!a) return;
    const r = a.getBoundingClientRect();
    if (matchWidth) el.style.width = `${Math.max(minWidth, Math.min(r.width, win.innerWidth - 16))}px`;
    const pos = popoverPosition(r, { width: el.offsetWidth, height: el.scrollHeight }, { width: win.innerWidth, height: win.innerHeight }, { align, place });
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.style.maxHeight = `${Math.round(Math.min(pos.maxHeight, win.innerHeight * 0.8))}px`;
  }
  const onWin = () => position();
  win.addEventListener('resize', onWin);
  win.addEventListener('scroll', onWin, true);
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (!el.hidden) position(); }) : null;
  mo?.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  return {
    position,
    destroy() { win.removeEventListener('resize', onWin); win.removeEventListener('scroll', onWin, true); mo?.disconnect(); el.remove(); },
  };
}

function mountApp(el, ctx) {
  const win = el.ownerDocument.defaultView;
  const root = el.ownerDocument.documentElement;
  const coarse = win.matchMedia?.('(pointer: coarse)');
  const apply = () => {
    const l = layoutFor(win.innerWidth, win.innerHeight, { coarsePointer: Boolean(coarse?.matches) });
    root.dataset.layout = l.mode;
    const prev = ctx.store.get().ui.layout;
    if (!prev || prev.mode !== l.mode || prev.timelineH !== l.timelineH || prev.coarsePointer !== l.coarsePointer || prev.inspectorSide !== l.inspectorSide) {
      ctx.store.dispatch({ type: 'UI_SET', key: 'layout', value: l });
    }
  };

  let raf = 0;
  const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); };
  apply();
  win.addEventListener('resize', onResize);
  coarse?.addEventListener?.('change', onResize);
  return {
    unmount() {
      cancelAnimationFrame(raf);
      win.removeEventListener('resize', onResize);
      coarse?.removeEventListener?.('change', onResize);
    },
  };
}

/** The bottom-sheet handle of the narrow inspector (CSS hides it on desktop): tap cycles, drag or arrows snap. */
function mountSheetHandle(el) {
  const insp = el.parentElement;
  const doc = el.ownerDocument;
  let snap = SHEET_SNAPS[0];
  const label = () => `Inspector height: ${Math.round(snap * 100)}% of the screen. Drag or press to resize.`;
  const setSnap = (s) => {
    snap = s;
    insp.style.setProperty('--sheet-h', `${Math.round(s * 100)}vh`);
    insp.dataset.sheet = String(Math.round(s * 100));
    handle.setAttribute('aria-label', label());
    handle.setAttribute('aria-valuenow', String(Math.round(s * 100)));
  };
  const handle = h('button.sheet-handle', {
    type: 'button', role: 'slider', 'aria-valuemin': '30', 'aria-valuemax': '92', 'aria-label': label(),
    onClick: () => { if (moved) return; const i = SHEET_SNAPS.indexOf(snap); setSnap(SHEET_SNAPS[(i + 1) % SHEET_SNAPS.length]); },
    onKeyDown: (e) => {
      const i = SHEET_SNAPS.indexOf(snap);
      if (e.key === 'ArrowUp') { e.preventDefault(); setSnap(SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, i + 1)]); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSnap(SHEET_SNAPS[Math.max(0, i - 1)]); }
    },
  }, h('span.sheet-grip', { 'aria-hidden': 'true' }));
  let drag = null;
  let moved = false;
  handle.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, h: insp.getBoundingClientRect().height }; moved = false; capturePointer(handle, e.pointerId); });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 6) moved = true;
    const vh = doc.defaultView.innerHeight;
    insp.style.setProperty('--sheet-h', `${Math.max(20, Math.min(95, ((drag.h + drag.y - e.clientY) / vh) * 100))}vh`);
    if (moved) insp.dataset.sheet = 'drag';
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (moved) setSnap(nearestSnap(insp.getBoundingClientRect().height / doc.defaultView.innerHeight));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  setSnap(snap);
  el.appendChild(handle);
  return { unmount() { handle.remove(); } };
}

/**
 * @param {HTMLElement} el this module's slot (in #app, or in #inspector for the split handle)
 * @param {{store: object, regions: Record<string, HTMLElement>}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return el.parentElement?.id === 'inspector' ? mountSheetHandle(el, ctx) : mountApp(el, ctx);
}
