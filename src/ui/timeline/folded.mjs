// OWNER: WP6
// timeline/folded.mjs — the folded overview's geometry (SPEC §1.5, D3): four FIXED linear regimes, each with
// a fixed share of the width, joined by labelled zig-zag seams whose ratio (×3.3, ×8.9, ×3.3) is computed
// from the neighbouring scales. The 28 px minimap is drawn in this geometry; tooltips never report a
// distance across a seam. There is no log scale anywhere.

import { dayFromYMD, ymdFromDay } from '../../shared/dates.mjs';
import { formatNumber } from '../../shared/format.mjs';

/** The regimes of §1.5 (astronomical years; 7000 BCE = −6999, 500 BCE = −499). */
export const REGIMES = Object.freeze([
  Object.freeze({ key: 'deep', label: 'Deep time', from: -6999, to: -499, share: 0.15, bin: 'millennium' }),
  Object.freeze({ key: 'classical', label: 'Classical–medieval', from: -499, to: 1500, share: 0.15, bin: 'century' }),
  Object.freeze({ key: 'early-modern', label: 'Early modern', from: 1500, to: 1800, share: 0.20, bin: 'decade' }),
  Object.freeze({ key: 'modern', label: 'Modern', from: 1800, to: 2030, share: 0.50, bin: 'decade' }),
]);
/** Width of a zig-zag seam in px. */
export const SEAM_PX = 10;

/** Fractional astronomical year of a day number. */
export function yearOfDay(day) {
  const { y } = ymdFromDay(Math.floor(day));
  const start = dayFromYMD(y, 1, 1);
  return y + (day - start) / (dayFromYMD(y + 1, 1, 1) - start);
}

/** Day number of a fractional astronomical year. */
export function dayOfYear(year) {
  const y = Math.floor(year);
  const start = dayFromYMD(y, 1, 1);
  const len = dayFromYMD(y + 1, 1, 1) - start;
  return start + (year - y) * len;
}

/**
 * Folded geometry for a width W: every regime keeps its share of W whatever W is.
 * @param {number} width
 * @returns {{width: number, regimes: Array<{key: string, label: string, from: number, to: number, x0: number, x1: number,
 *   yearsPerPx: number, bin: string}>, seams: Array<{x: number, ratio: number, label: string}>,
 *   xOfYear(year: number): number, yearOfX(x: number): number, xOfDay(day: number): number, dayOfX(x: number): number,
 *   regimeAt(x: number): object}}
 */
export function createFolded(width) {
  let x = 0;
  const regimes = REGIMES.map((r) => {
    const w = r.share * width;
    const out = { ...r, x0: x, x1: x + w, yearsPerPx: (r.to - r.from) / w };
    x += w;
    return Object.freeze(out);
  });
  const seams = regimes.slice(1).map((r, i) => {
    const prev = regimes[i];
    const ratio = Math.max(prev.yearsPerPx, r.yearsPerPx) / Math.min(prev.yearsPerPx, r.yearsPerPx);
    return Object.freeze({ x: r.x0, ratio, label: `×${formatNumber(ratio, 2)}` });
  });
  const first = regimes[0], last = regimes[regimes.length - 1];

  function xOfYear(year) {
    if (year <= first.from) return first.x0;
    if (year >= last.to) return last.x1;
    const r = regimes.find((g) => year < g.to) ?? last;
    return r.x0 + (year - r.from) / r.yearsPerPx;
  }
  function yearOfX(px) {
    if (px <= 0) return first.from;
    if (px >= width) return last.to;
    const r = regimes.find((g) => px < g.x1) ?? last;
    return r.from + (px - r.x0) * r.yearsPerPx;
  }
  return Object.freeze({
    width, regimes, seams, xOfYear, yearOfX,
    xOfDay: (day) => xOfYear(yearOfDay(day)),
    dayOfX: (px) => dayOfYear(yearOfX(px)),
    regimeAt: (px) => regimes.find((g) => px < g.x1) ?? last,
  });
}

/**
 * Zig-zag points of a seam centred on x, from y0 to y1 (drawn as a polyline).
 * @param {number} x
 * @param {number} y0
 * @param {number} y1
 * @param {number} [amp]
 * @returns {Array<[number, number]>}
 */
export function seamZigzag(x, y0, y1, amp = SEAM_PX / 2) {
  const pts = [];
  const step = 4;
  let left = true;
  for (let y = y0; y <= y1; y += step) {
    pts.push([x + (left ? -amp / 2 : amp / 2), y]);
    left = !left;
  }
  return pts;
}

/** Bin tier drawn in each regime (§1.5 table: millennium · century · decade · decade). */
export const REGIME_TIER = Object.freeze({ deep: 'L0', classical: 'L1', 'early-modern': 'L2', modern: 'L2' });

/**
 * The folded overview as four linear parts the Scroll draws side by side: each part is an ordinary linear
 * axis (originDay, daysPerPx) placed at [x0, x1] and clipped there, so bins never cross a seam.
 * @param {number} width
 */
export function foldedParts(width) {
  const folded = createFolded(width);
  const parts = folded.regimes.map((r) => {
    const lo = dayFromYMD(r.from, 1, 1), hi = dayFromYMD(r.to, 1, 1);
    return { regime: r, tier: REGIME_TIER[r.key], originDay: lo, endDay: hi - 1, daysPerPx: (hi - lo) / Math.max(1, r.x1 - r.x0), x0: r.x0, x1: r.x1 };
  });
  return { folded, parts };
}

/** "1 px ≈ 31 years" / "1 px ≈ 4 months" for a regime's own scale bar. */
export function regimeScale(r) {
  return r.yearsPerPx >= 1 ? `1 px ≈ ${formatNumber(r.yearsPerPx, 2)} years` : `1 px ≈ ${formatNumber(r.yearsPerPx * 12, 2)} months`;
}

/** UI module contract (§8): a library (the minimap and the folded mode of the Scroll use it). */
export function mount() { return { unmount() {} }; }
