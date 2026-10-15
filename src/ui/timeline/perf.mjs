// OWNER: WP6
// timeline/perf.mjs — the `?perf=1` HUD (SPEC §8.3 budgets): p50/p95 of the Scroll's layer repaints (bg + data +
// arcs, budget ≤ 8 ms p95 during pan/zoom) and of the overlay (≤ 2 ms), the shape counts of the display list,
// main-thread long tasks, and a synthetic benchmark that pans a 20,000-rect display list built by the real
// model → display → paint pipeline. `?perf=bench` runs the benchmark on load.

import { dayFromYMD } from '../../shared/dates.mjs';
import { h, clear } from '../core/dom.mjs';
import { buildDisplay, layoutLanes } from './display.mjs';
import { buildModel } from './model.mjs';
import { createLayer, paintList, readPalette } from './paint.mjs';

/** Budgets of §8.3 (ms). */
export const PERF_BUDGET = Object.freeze({ paint: 8, overlay: 2 });
const KEEP = 240;

/**
 * The q-quantile (0–1) of a list of numbers (nearest rank).
 * @param {number[]} values
 * @param {number} q
 * @returns {number}
 */
export function percentile(values, q) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function createPerf() {
  const buf = { paint: [], overlay: [] };
  let last = null;
  return {
    /** Record one repaint ('paint' = layers, 'overlay'). Cheap enough to run always. */
    record(kind, ms, extra = null) {
      const b = buf[kind];
      if (!b || !Number.isFinite(ms)) return;
      b.push(ms);
      if (b.length > KEEP) b.shift();
      if (extra) last = extra;
    },
    stats(kind) {
      const b = buf[kind] ?? [];
      return { n: b.length, p50: percentile(b, 0.5), p95: percentile(b, 0.95), max: b.length ? Math.max(...b) : NaN };
    },
    get last() { return last; },
    reset() { buf.paint.length = 0; buf.overlay.length = 0; },
  };
}

/** The recorder the Scroll writes to. */
export const perf = createPerf();

/**
 * Synthetic tiles: `lanes` lanes × `strands` strands × `bins` consecutive observed year bins with varying rates —
 * a stress test of the real pipeline (every cell is a rect).
 * @returns {{query: object, tiles: Map<number, object>, strands: object[], range: [number, number], tier: string}}
 */
export function syntheticTiles({ lanes = 10, strands = 2, bins = 1000, fromYear = 1000 } = {}) {
  const laneKeys = Array.from({ length: lanes }, (_, i) => `bench:${i}`);
  const strandIds = Array.from({ length: strands }, (_, i) => String(9000 + i));
  const tiles = new Map();
  const b0 = fromYear, b1 = fromYear + bins - 1;
  for (let t = Math.floor(b0 / 64); t <= Math.floor(b1 / 64); t++) {
    const lanesObj = {};
    for (const [li, lk] of laneKeys.entries()) {
      const st = {};
      for (const [si, sid] of strandIds.entries()) {
        const cells = [];
        for (let idx = 0; idx < 64; idx++) {
          const bin = t * 64 + idx;
          if (bin < b0 || bin > b1) continue;
          const rate = 10 + ((bin * 37 + li * 11 + si * 5) % 90);
          cells.push([idx, 9, 3, 2, 60000, rate, rate * 0.6, rate * 1.4, 1, 0, 0.3]);
        }
        st[sid] = cells;
      }
      lanesObj[lk] = { strands: st };
    }
    tiles.set(t, { tile: t, bin0: t * 64, lanes: lanesObj, coverage: {}, washes: [] });
  }
  const query = { queryKey: 'bench', lanes: laneKeys.map((key, i) => ({ key, label: `Bench ${i}`, unit: 'per_million_tokens', modality: 'text', coverage: { tokens: 1e6, span: [b0, b1] }, n: 1 })) };
  return { query, tiles, strands: strandIds.map((id, i) => ({ type: 'expression', id: Number(id), glyph: ['circle', 'square', 'triangle', 'diamond'][i % 4] })),
    range: [dayFromYMD(b0, 1, 1), dayFromYMD(b1, 12, 31)], tier: 'L3' };
}

/**
 * Pan a synthetic display list of ≥ `rects` shapes across a `width` × `height` layer (DPR ≤ 2) and time every
 * repaint of the bg + data layers. `p50`/`p95` are main-thread repaint times — the §8.3 budget (≤ 8 ms p95), as
 * the live HUD measures them; `flushed` repeats the run forcing the GPU to finish each frame (a 1-pixel readback),
 * which also counts rasterisation and depends on the GPU's load.
 * @param {{rects?: number, frames?: number, width?: number, height?: number, doc?: Document}} [opts]
 * @returns {{rects: number, frames: number, p50: number, p95: number, max: number, pass: boolean, flushed: {p50: number, p95: number}}}
 */
export function runBench({ rects = 20000, frames = 120, width = 1440, height = 760, doc = globalThis.document } = {}) {
  const strands = 2, lanes = 10;
  const bins = Math.ceil(rects / (lanes * strands));
  const syn = syntheticTiles({ lanes, strands, bins });
  const model = buildModel({ query: syn.query, tier: syn.tier, tiles: syn.tiles, range: syn.range, strands: syn.strands });
  const layout = layoutLanes(model.lanes, model.rowCount, { fillH: height - 56 });
  const dpp = (syn.range[1] - syn.range[0]) / width;
  const display = buildDisplay(model, { originDay: syn.range[0], daysPerPx: dpp, width, layout });
  const n = display.stats.rects + display.stats.ticks;
  const palette = readPalette(doc.documentElement);
  const bg = createLayer(doc.createElement('canvas')), data = createLayer(doc.createElement('canvas'));
  bg.resize(width, height); data.resize(width, height);
  const run = (flush) => {
    const times = [];
    for (let f = 0; f < frames; f++) {
      const tx = -(f % 40) * 3;
      const t0 = performance.now();
      bg.begin(palette); data.begin(palette);
      paintList(bg, display.lanes, { tx, ty: 56, clip: [0, 56, width, height - 56], palette, layerName: 'bg' });
      paintList(data, display.lanes, { tx, ty: 56, clip: [0, 56, width, height - 56], palette, layerName: 'data' });
      if (flush) data.ctx.getImageData(0, 0, 1, 1);
      times.push(performance.now() - t0);
    }
    return times;
  };
  const times = run(false);
  const flushed = run(true);
  const p95 = percentile(times, 0.95);
  return { rects: n, frames, p50: percentile(times, 0.5), p95, max: Math.max(...times), pass: p95 <= PERF_BUDGET.paint,
    flushed: { p50: percentile(flushed, 0.5), p95: percentile(flushed, 0.95) } };
}

const ms = (x) => (Number.isFinite(x) ? `${x.toFixed(2)} ms` : '—');

/**
 * @param {HTMLElement} el this module's slot in #app
 * @returns {{unmount(): void}}
 */
export function mount(el) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const mode = new URLSearchParams(win.location.search).get('perf');
  if (!mode) return { unmount() {} };
  let longTasks = 0;
  let po = null;
  try {
    po = new win.PerformanceObserver((list) => { longTasks += list.getEntries().filter((e) => e.duration > 50).length; });
    po.observe({ type: 'longtask', buffered: true });
  } catch { po = null; }
  const body = h('div.perf-body');
  const benchOut = h('p.perf-bench', { role: 'status' });
  const hud = h('aside.perf-hud', { 'aria-label': 'Performance (perf=1)' }, h('strong', null, 'perf'), body,
    h('button.btn', { type: 'button', onClick: () => bench() }, 'Bench 20k rects'), benchOut);
  el.appendChild(hud);
  function render() {
    const p = perf.stats('paint'), o = perf.stats('overlay');
    const s = perf.last?.shapes;
    clear(body);
    body.append(
      h('p', null, `layers p50 ${ms(p.p50)} · p95 ${ms(p.p95)} ${p.p95 <= PERF_BUDGET.paint ? '✓' : p.n ? '✕' : ''} (≤ 8 ms) · n ${p.n}`),
      h('p', null, `overlay p50 ${ms(o.p50)} · p95 ${ms(o.p95)} ${o.p95 <= PERF_BUDGET.overlay ? '✓' : o.n ? '✕' : ''} (≤ 2 ms)`),
      h('p', null, `shapes ${s ? s.rects + s.ticks : '—'} · texts ${s?.texts ?? '—'} · build ${ms(perf.last?.build)} · long tasks ${po ? longTasks : 'n/a'}`));
  }
  function bench() {
    benchOut.textContent = 'running…';
    setTimeout(() => {
      const r = runBench({ doc });
      benchOut.textContent = `${r.rects.toLocaleString('en')} rects × ${r.frames} pans: main thread p50 ${ms(r.p50)} · p95 ${ms(r.p95)} ${r.pass ? '✓ within 8 ms' : '✕ over 8 ms'} · with GPU flush p95 ${ms(r.flushed.p95)}`;
      win.__SCROLLS_BENCH__ = r;
    }, 30);
  }
  const t = win.setInterval(render, 500);
  render();
  if (mode === 'bench') bench();
  return { unmount() { win.clearInterval(t); po?.disconnect(); hud.remove(); } };
}
