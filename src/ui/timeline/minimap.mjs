// OWNER: WP6
// timeline/minimap.mjs — the always-visible minimap (SPEC §1.5): the folded overview (four fixed linear
// regimes, labelled zig-zag seams ×3.3 · ×8.9 · ×3.3) with one 3 px row per lane — coverage span, the
// observed span (first → last observation) and the observed bins of the loaded tiles — the modality seam,
// and the current viewport as a draggable cyan bracket. 28 px tall (20 px on narrow screens).

import { dayFromYMD } from '../../shared/dates.mjs';
import { formatNumber } from '../../shared/format.mjs';
import { h } from '../core/dom.mjs';
import { createFolded, seamZigzag } from './folded.mjs';
import { createLayer, readPalette, withAlpha } from './paint.mjs';
import { parseLabel, STATE } from './model.mjs';
import { scrollHub } from './viewport.mjs';
import { capturePointer } from './input.mjs';

/**
 * Lane rows of the minimap for a height: one 3 px row per lane, folded into the last row when they do not fit.
 * @param {number} lanes
 * @param {number} height
 * @returns {{rows: number, rowH: number, top: number}}
 */
export function minimapRows(lanes, height) {
  const top = 9;
  const usable = Math.max(3, height - top - 2);
  const rows = Math.max(1, Math.min(lanes, Math.floor(usable / 3)));
  return { rows, rowH: 3, top };
}

/** Shorter names for narrow minimaps, longest first. */
export const REGIME_SHORT = Object.freeze({ deep: ['Deep time', 'Deep'], classical: ['Classical–medieval', 'Classical', 'Class.'],
  'early-modern': ['Early modern', 'Early mod.', 'E. mod.'], modern: ['Modern'] });

/**
 * The longest regime name that fits `room` px (measure: text → px), or '' when none does.
 * @param {string} key
 * @param {number} room
 * @param {(text: string) => number} measure
 */
export function regimeName(key, room, measure) {
  return (REGIME_SHORT[key] ?? []).find((t) => measure(t) <= room) ?? '';
}

/** Describe a regime for a tooltip (never a distance across a seam). */
export function regimeTitle(r) {
  const unit = r.yearsPerPx >= 1 ? `1 px ≈ ${formatNumber(r.yearsPerPx, 2)} years` : `1 px ≈ ${formatNumber(r.yearsPerPx * 12, 2)} months`;
  return `${r.label}: ${r.key === 'deep' ? '7000 BCE – 500 BCE' : r.key === 'classical' ? '500 BCE – 1500' : r.key === 'early-modern' ? '1500 – 1800' : '1800 – 2030'} · ${unit} · ${r.bin} bins`;
}

/**
 * The bracket of the visible range inside the minimap (§1.5: the minimap always shows it): at least 4 px wide and never
 * outside the strip, even when the view is past the overview's last regime (fix pass: panned to 2062–2100 it sat at
 * x = 1440 of a 1440 px strip, out of sight).
 * @param {number} x0 left edge of the visible range in the strip
 * @param {number} x1 right edge
 * @param {number} width the strip's width
 * @returns {{left: number, width: number}}
 */
export function bracketBox(x0, x1, width) {
  const w = Math.min(Math.max(4, x1 - x0), Math.max(4, width));
  return { left: Math.max(0, Math.min(x0, width - w)), width: w };
}

/**
 * @param {HTMLElement} el this module's slot in #minimap
 * @param {{store: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const canvas = h('canvas.minimap-canvas', { role: 'img', 'aria-label': 'Overview of all time, folded into four fixed linear regimes; the cyan bracket is the visible range' });
  const bracket = h('div.minimap-bracket', { role: 'slider', tabindex: '0', 'aria-label': 'Visible range: drag, or use the arrow keys, to move the Scroll' });
  const wrap = h('div.minimap', null, canvas, bracket);
  el.appendChild(wrap);
  const layer = createLayer(canvas);
  let width = 0, height = 0;
  let folded = createFolded(1);
  let palette = readPalette(doc.documentElement);
  let raf = 0;

  function draw() {
    raf = 0;
    if (!width) return;
    const st = scrollHub.get();
    const c = layer.begin(palette);
    c.fillStyle = palette['bg-0'];
    c.fillRect(0, 0, width, height);
    // Regime grounds alternate faintly; seams are zig-zags with their computed ratio.
    c.font = `${height < 24 ? 8 : 9}px ${palette['font-ui']}`;
    folded.regimes.forEach((r, i) => {
      c.fillStyle = i % 2 ? palette['bg-1'] : palette['bg-0'];
      c.fillRect(r.x0, 0, r.x1 - r.x0, height);
      c.fillStyle = palette['ink-3'];
      const name = regimeName(r.key, r.x1 - r.x0 - 10, (t) => c.measureText(t).width);
      if (name) c.fillText(name, r.x0 + 5, height < 24 ? 7.5 : 8.5);
    });
    c.strokeStyle = palette['ink-3'];
    c.lineWidth = 1;
    for (const s of folded.seams) {
      const pts = seamZigzag(s.x, 0, height);
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
      c.fillStyle = palette['ink-2'];
      c.font = `8.5px ${palette['font-num']}`;
      c.fillText(s.label, s.x + 6, height - 3);
    }
    // Before a strand is pinned the rows are the corpus's collections (their dated spans).
    const lanes = st.query?.lanes ?? (st.corpusCollections ?? []).map((cl) => ({ coverage: { span: [parseLabel(cl.span?.[0])?.lo_year, parseLabel(cl.span?.[1])?.hi_year] } }));
    const { rows, rowH, top } = minimapRows(lanes.length || 1, height);
    lanes.forEach((lane, i) => {
      const y = top + Math.min(i, rows - 1) * rowH;
      const span = lane.coverage?.span;
      if (Array.isArray(span) && Number.isFinite(span[0])) {
        const x0 = folded.xOfYear(span[0]), x1 = folded.xOfYear(span[1] + 1);
        c.fillStyle = withAlpha(palette.ink, 0.16);
        c.fillRect(x0, y, Math.max(1, x1 - x0), rowH - 1);
      }
      const a = parseLabel(lane.first?.label), b = parseLabel(lane.last?.label);
      if (a && b) {
        const x0 = folded.xOfDay(a.lo_day), x1 = folded.xOfDay(b.hi_day + 1);
        c.fillStyle = withAlpha(palette.ink, 0.42);
        c.fillRect(x0, y, Math.max(1, x1 - x0), rowH - 1);
      }
    });
    // Observed bins of the loaded tiles, brighter.
    const model = st.model;
    if (model) {
      model.lanes.forEach((lane, i) => {
        const y = top + Math.min(i, rows - 1) * rowH;
        c.fillStyle = withAlpha(palette.ink, 0.9);
        for (const s of lane.strands) for (let k = 0; k < s.cols.length; k++) {
          if (s.cols.state[k] !== STATE.observed) continue;
          const x0 = folded.xOfDay(s.cols.lo[k]), x1 = folded.xOfDay(s.cols.hi[k] + 1);
          c.fillRect(x0, y, Math.max(1, x1 - x0), rowH - 1);
        }
      });
    }
    for (const seam of st.query?.seams ?? []) {
      const x = Math.round(folded.xOfYear(seam.year)) + 0.5;
      c.strokeStyle = palette['ink-2'];
      c.setLineDash([2, 2]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, height); c.stroke();
      c.setLineDash([]);
    }
    // The viewport bracket.
    if (st.scale) {
      const x0 = folded.xOfDay(st.scale.loDay), x1 = folded.xOfDay(st.scale.hiDay);
      const box = bracketBox(x0, x1, width);
      bracket.style.transform = `translateX(${Math.round(box.left)}px)`;
      bracket.style.width = `${Math.round(box.width)}px`;
      bracket.setAttribute('aria-valuetext', `${Math.round(folded.yearOfX(x0))} to ${Math.round(folded.yearOfX(x1))}`);
    }
  }
  const schedule = () => { if (!raf) raf = win.requestAnimationFrame(draw); };

  const ro = new win.ResizeObserver(() => {
    const r = wrap.getBoundingClientRect();
    width = Math.floor(r.width);
    height = Math.floor(r.height);
    layer.resize(width, height);
    folded = createFolded(width);
    palette = readPalette(doc.documentElement);
    schedule();
  });
  ro.observe(wrap);
  const unsub = scrollHub.subscribe(schedule);

  // Click: centre there; drag the bracket: follow.
  let drag = null;
  const dayAt = (clientX) => folded.dayOfX(Math.max(0, Math.min(width, clientX - wrap.getBoundingClientRect().left)));
  const onDown = (e) => {
    drag = { id: e.pointerId };
    capturePointer(wrap, e.pointerId);
    // In the folded overview a click on the minimap unfolds the Scroll there.
    if (scrollHub.get().folded) scrollHub.actions.toggleFolded?.(false);
    scrollHub.actions.centerOn?.(dayAt(e.clientX));
    e.preventDefault();
  };
  const onMove = (e) => { if (drag) scrollHub.actions.centerOn?.(dayAt(e.clientX)); else wrap.title = regimeTitle(folded.regimeAt(e.clientX - wrap.getBoundingClientRect().left)); };
  const onUp = () => { drag = null; };
  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);
  bracket.addEventListener('keydown', (e) => {
    const st = scrollHub.get();
    if (!st.scale) return;
    const span = st.scale.hiDay - st.scale.loDay;
    const k = { ArrowLeft: -0.25, ArrowRight: 0.25, PageUp: -1, PageDown: 1 }[e.key];
    if (k) { e.preventDefault(); scrollHub.actions.centerOn?.(st.scale.centerDay + k * span); }
    if (e.key === 'Home') { e.preventDefault(); scrollHub.actions.centerOn?.(dayFromYMD(-6999, 1, 1) + span / 2); }
    if (e.key === 'End') { e.preventDefault(); scrollHub.actions.centerOn?.(dayFromYMD(2030, 12, 31) - span / 2); }
  });

  return {
    unmount() {
      win.cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
      wrap.remove();
    },
  };
}
