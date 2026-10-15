// OWNER: WP6
// timeline/share-cells.mjs — OpenAlex lanes on the Scroll (SPEC D14, §10.4; contract 1.3.0 C3): one box per
// OpenAlex cell (its own 30 period bins, the same at every tier), spanning lo_year..hi_year, whose height is the
// share of the cell's top-cited sample that mentions the strand, with its Wilson 95% interval as a whisker.
// A cell with fewer than 20 sampled works is hollow and says "n < 20" (k and n, no share). Boxes never touch and
// nothing joins them: a cell is not comparable with its neighbours as a rate, so there is no line, no trend and
// no cross-cell number anywhere — the lane header says "share of the top-cited sample in each cell — not a trend".
//
// The painter, the hit grid and the table alternative all read the same typed columns (shareColumns).

import { dayFromYMD } from '../../shared/dates.mjs';
import { formatCount, formatShare } from '../../shared/format.mjs';
import * as vocab from '../../shared/vocab.mjs';

/** The rate unit of these lanes (vocab.RATE_UNITS). */
export const SHARE_UNIT = 'share_of_sampled_works';
/** Lane-header copy (C3). */
export const SHARE_NOTE = vocab.SHARE_LANE_NOTE ?? 'share of the top-cited sample in each cell — not a trend';
/** Sampled works a cell needs before a share is shown (§1.2: 20 sampled works). */
export const SHARE_GATE = 20;
/** Box states (strings in the contract; the columns keep them as small integers). */
export const SHARE_STATE = Object.freeze({ observed: 1, absent: 2, low: 3, uncovered: 4, pending: 5 });
const STATE_BY_NAME = { observed: 1, absent: 2, low: 3, uncovered: 4, pending: 5 };

/** Is this lane a within-cell share lane? */
export const isShareLane = (lane) => lane?.unit === SHARE_UNIT;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/**
 * A cell's state: the server's word (or number) when given; otherwise k/n decide (never inferred past that).
 * @param {{state?: string|number, k?: number, n?: number}} c
 * @returns {number}
 */
export function shareState(c) {
  if (typeof c.state === 'number' && c.state >= 1 && c.state <= 5) return c.state;
  if (typeof c.state === 'string' && STATE_BY_NAME[c.state]) return STATE_BY_NAME[c.state];
  if (!(c.n > 0)) return SHARE_STATE.uncovered;
  if (c.n < SHARE_GATE) return SHARE_STATE.low;
  return c.k > 0 ? SHARE_STATE.observed : SHARE_STATE.absent;
}

/**
 * The share cells of one tile, by lane and strand: `cells[lane][strand]` (contract 1.3.0), and also cells inside
 * `lanes[lane].strands[strand]` (objects with lo_year among the tuples) or `share_cells[lane][strand]`.
 * @param {object|null} tile
 * @returns {Map<string, Map<string, object[]>>} lane → strand → cells
 */
export function shareCellsOfTile(tile) {
  const out = new Map();
  const put = (lane, ref, cells) => {
    if (!Array.isArray(cells)) return;
    const objs = cells.filter((c) => isObj(c) && Number.isInteger(c.lo_year));
    if (!objs.length) return;
    if (!out.has(lane)) out.set(lane, new Map());
    const m = out.get(lane);
    m.set(String(ref), [...(m.get(String(ref)) ?? []), ...objs]);
  };
  if (!isObj(tile)) return out;
  for (const [lane, l] of Object.entries(tile.lanes ?? {})) {
    for (const [ref, cells] of Object.entries(l?.strands ?? {})) put(lane, ref, cells);
    for (const [ref, cells] of Object.entries(l?.share_cells ?? {})) put(lane, ref, cells);
  }
  for (const key of ['cells', 'share_cells']) {
    for (const [lane, byRef] of Object.entries(tile[key] ?? {})) for (const [ref, cells] of Object.entries(byRef ?? {})) put(lane, ref, cells);
  }
  return out;
}

/**
 * Typed columns of a strand's share cells, deduplicated by cell (a cell is listed in every tile it overlaps) and
 * sorted by its first year. Shares and intervals are the server's; nothing is computed across cells.
 * @param {object[]} cells
 * @returns {{length: number, loYear: Int32Array, hiYear: Int32Array, lo: Float64Array, hi: Float64Array, k: Int32Array,
 *            n: Int32Array, share: Float64Array, ciLo: Float64Array, ciHi: Float64Array, state: Uint8Array, cells: object[]}}
 */
export function shareColumns(cells) {
  const seen = new Map();
  for (const c of cells ?? []) {
    const k = `${c.lo_year}:${c.hi_year}`;
    if (!seen.has(k)) seen.set(k, c);
  }
  const list = [...seen.values()].sort((a, b) => a.lo_year - b.lo_year || a.hi_year - b.hi_year);
  const len = list.length;
  const cols = {
    length: len, loYear: new Int32Array(len), hiYear: new Int32Array(len), lo: new Float64Array(len), hi: new Float64Array(len),
    k: new Int32Array(len), n: new Int32Array(len), share: new Float64Array(len), ciLo: new Float64Array(len), ciHi: new Float64Array(len),
    state: new Uint8Array(len), cells: list,
  };
  list.forEach((c, i) => {
    cols.loYear[i] = c.lo_year;
    cols.hiYear[i] = Number.isInteger(c.hi_year) ? c.hi_year : c.lo_year;
    cols.lo[i] = dayFromYMD(c.lo_year, 1, 1);
    cols.hi[i] = dayFromYMD(cols.hiYear[i], 12, 31);
    cols.k[i] = c.k | 0;
    cols.n[i] = c.n | 0;
    const st = shareState(c);
    cols.state[i] = st;
    // A gated cell (n < 20) has no share, whatever the payload carries (§13 rule 7).
    const shown = st === SHARE_STATE.observed || st === SHARE_STATE.absent;
    cols.share[i] = shown ? num(c.share) : NaN;
    cols.ciLo[i] = shown && Array.isArray(c.ci) ? num(c.ci[0]) : NaN;
    cols.ciHi[i] = shown && Array.isArray(c.ci) ? num(c.ci[1]) : NaN;
  });
  return cols;
}

/** The height scale of the share lanes shown: the largest upper bound (or share) of any shown cell. */
export function shareScaleMax(columnsList) {
  let max = 0;
  for (const c of columnsList) for (let i = 0; i < c.length; i++) {
    const v = Number.isFinite(c.ciHi[i]) ? c.ciHi[i] : c.share[i];
    if (Number.isFinite(v)) max = Math.max(max, v);
  }
  return max;
}

const years = (c, i) => (c.loYear[i] === c.hiYear[i] ? String(c.loYear[i]) : `${c.loYear[i]}–${c.hiYear[i]}`);

/**
 * Tooltip lines of one cell (from the same numbers as the box).
 * @returns {string[]}
 */
export function shareTooltip(lane, strand, c, i) {
  const lines = [`${strand.label} · ${lane.label} · ${years(c, i)}`];
  const st = c.state[i];
  const kn = `${formatCount(c.k[i])} of ${formatCount(c.n[i])} sampled works mention it`;
  const nCell = c.cells?.[i]?.n_cell;
  if (Number.isInteger(nCell) && nCell !== c.n[i]) lines.push(`${formatCount(nCell)} works sampled in this cell; ${formatCount(c.n[i])} in the strand’s languages`);
  if (st === SHARE_STATE.observed) lines.push(`${kn} · ${formatShare(c.share[i])}${Number.isFinite(c.ciLo[i]) ? ` [${formatShare(c.ciLo[i])}, ${formatShare(c.ciHi[i])}] (Wilson 95%)` : ''}`);
  else if (st === SHARE_STATE.absent) lines.push(`0 of ${formatCount(c.n[i])} sampled works — looked, found none${Number.isFinite(c.ciHi[i]) ? ` (Wilson 95% up to ${formatShare(c.ciHi[i])})` : ''}`);
  else if (st === SHARE_STATE.low) lines.push(`${kn} · n < ${SHARE_GATE}: too few sampled works for a share`);
  else if (st === SHARE_STATE.pending) lines.push('indexing — not yet looked');
  else lines.push('no sampled works in this cell');
  lines.push('A share of the top-cited sample in this cell, not a trend: cells are not comparable as rates.');
  return lines;
}

/**
 * Display-list primitives of a strand's share boxes (layer 'data', lane coordinates).
 * @param {object} lane lane model (label, key, synthetic)
 * @param {object} strand strand model with `share` columns
 * @param {{slot: {y: number, h: number, mid: number}, X: (day: number) => number, max: number, tier: string,
 *          gate: (prim: object, hiDay: number) => object|null}} opts
 * @returns {object[]}
 */
export function sharePrims(lane, strand, { slot, X, max, tier, gate }) {
  const out = [];
  const c = strand.share;
  if (!c?.length) return out;
  const base = slot.y + slot.h - 3;
  const full = slot.h * 0.78;
  const Y = (v) => base - (max > 0 ? Math.max(0, Math.min(1, v / max)) * full : 0);
  for (let i = 0; i < c.length; i++) {
    const st = c.state[i];
    if (st === SHARE_STATE.uncovered) continue;
    // A clear gap between neighbouring cells (2–4 px), so boxes never read as one bar or a line across time.
    const cx0 = X(c.lo[i]), cx1 = X(c.hi[i] + 1);
    const inset = Math.min(4, Math.max(2, (cx1 - cx0) * 0.06));
    const x0 = cx0 + inset, x1 = cx1 - inset;
    if (x1 - x0 < 1) continue;
    const ref = { type: 'cell', lane: lane.key, strand: strand.ref, lo: c.loYear[i], hi: c.hiYear[i], tier, i, k: c.k[i], n: c.n[i] };
    const tip = shareTooltip(lane, strand, c, i);
    const id = `sc:${lane.key}:${strand.ref}:${c.loYear[i]}`;
    let prim;
    if (st === SHARE_STATE.observed) {
      const top = Math.min(base - 2, Y(c.share[i]));
      prim = { id, kind: 'rect', layer: 'data', style: 'share-box', x0, x1, y0: top, y1: base, openable: true, ref, tip, synthetic: lane.synthetic,
        whisker: Number.isFinite(c.ciLo[i]) ? [Y(c.ciLo[i]), Y(c.ciHi[i])] : null, base };
    } else if (st === SHARE_STATE.absent) {
      prim = { id, kind: 'rect', layer: 'data', style: 'share-absent', x0, x1, y0: base - 3, y1: base + 1, openable: true, ref, tip,
        whisker: Number.isFinite(c.ciHi[i]) ? [base, Y(c.ciHi[i])] : null, base };
    } else if (st === SHARE_STATE.low) {
      prim = { id, kind: 'rect', layer: 'data', style: 'share-low', x0, x1, y0: base - full * 0.45, y1: base, openable: true, ref, tip,
        label: x1 - x0 >= 40 ? 'n < 20' : null };
    } else {
      prim = { id, kind: 'band', layer: 'bg', style: 'dots', x0, x1, y0: slot.y, y1: slot.y + slot.h, openable: false, ref: null, tip };
    }
    const g = gate(prim, c.hi[i]);
    if (g) out.push(g);
  }
  return out;
}

/**
 * The days a share lane covers (cells with sampled works), as [loDay, hiDay] runs — so the lane underlay hatches
 * only what no cell covers.
 * @param {Array<ReturnType<typeof shareColumns>>} columnsList
 * @returns {Array<[number, number]>}
 */
export function shareCoveredDays(columnsList) {
  const runs = [];
  for (const c of columnsList) for (let i = 0; i < c.length; i++) if (c.n[i] > 0 || c.state[i] === SHARE_STATE.pending) runs.push([c.lo[i], c.hi[i]]);
  runs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

/** Table rows of a share strand (the `T` alternative), read straight from its columns. */
export function shareTableRows(strand) {
  const c = strand.share;
  const out = [];
  for (let i = 0; i < (c?.length ?? 0); i++) {
    const st = c.state[i];
    const shown = st === SHARE_STATE.observed || st === SHARE_STATE.absent;
    out.push({
      bin: years(c, i), n: `${formatCount(c.k[i])} of ${formatCount(c.n[i])}`, rate: shown ? formatShare(c.share[i]) : '—',
      ci: shown && Number.isFinite(c.ciLo[i]) ? `[${formatShare(c.ciLo[i])}, ${formatShare(c.ciHi[i])}]` : '—',
      coverage: `${formatCount(c.n[i])} sampled works`,
      state: { 1: 'observed', 2: 'looked, found none', 3: `n < ${SHARE_GATE}: no share`, 4: 'no sampled works', 5: 'indexing — not yet looked' }[st] ?? String(st),
      flags: 'within-cell share, not a trend',
    });
  }
  return out;
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
