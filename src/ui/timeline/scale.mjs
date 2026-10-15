// OWNER: WP6
// timeline/scale.mjs — the linear TimeScale (D3: linear time everywhere), ruler ticks with historical labels
// ("1850", "500 BCE", "Apr 1931", "17 May 1994") and the footer caption ("Bins: decades · 1 cm ≈ 12.5 years").
//
// Days are integers since 1970-01-01, proleptic Gregorian, astronomical years (D5). Tick dates are built
// with dates.dayFromYMD (never Date.UTC), so years 0–99 and BCE years are exact.

import { dayFromYMD, ymdFromDay, yearLabel, MONTH_ABBR } from '../../shared/dates.mjs';
import { formatNumber } from '../../shared/format.mjs';
import { BIN_PLURAL, DAYS_PER_YEAR } from './tiers.mjs';

export { DAYS_PER_YEAR };
/** One CSS centimetre in CSS pixels (96 px per inch). */
export const CSS_CM_PX = 96 / 2.54;
/** Minimum spacing of labelled (major) ticks in px. */
export const MIN_LABEL_PX = 84;

/**
 * @typedef {{centerDay: number, daysPerPx: number, width: number, loDay: number, hiDay: number, ppy: number,
 *            x(day: number): number, day(x: number): number}} TimeScale
 */

/**
 * A linear time scale over a canvas `width` px wide, centred on `centerDay`.
 * @param {{centerDay: number, daysPerPx: number, width: number}} axis
 * @returns {TimeScale}
 */
export function createScale({ centerDay, daysPerPx, width }) {
  const loDay = centerDay - (width / 2) * daysPerPx;
  return Object.freeze({
    centerDay, daysPerPx, width, loDay, hiDay: loDay + width * daysPerPx, ppy: DAYS_PER_YEAR / daysPerPx,
    x: (day) => (day - loDay) / daysPerPx,
    day: (x) => loDay + x * daysPerPx,
  });
}

/** Candidate major-tick steps, coarse to fine. */
const STEPS = Object.freeze([
  ...[5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map((n) => ({ unit: 'year', n, days: n * DAYS_PER_YEAR })),
  ...[6, 3, 1].map((n) => ({ unit: 'month', n, days: n * 30.44 })),
  ...[10, 5, 2, 1].map((n) => ({ unit: 'day', n, days: n })),
]);

/**
 * The finest step whose labels stay at least `minPx` apart.
 * @param {number} daysPerPx
 * @param {number} [minPx]
 * @returns {{unit: 'year'|'month'|'day', n: number, days: number}}
 */
export function majorStep(daysPerPx, minPx = MIN_LABEL_PX) {
  let pick = STEPS[0];
  for (const s of STEPS) {
    if (s.days / daysPerPx >= minPx) pick = s;
    else break;
  }
  return pick;
}

/**
 * Year ticks every n years. BCE ticks sit on round historical years (500 BCE = astronomical −499), CE ticks
 * on round astronomical years, so labels read "1000 BCE · 500 BCE · 500 CE · 1000".
 */
function yearTicks(loYear, hiYear, n) {
  const out = [];
  // BCE side: historical year H (multiple of n) ↔ astronomical 1 − H.
  const hLo = Math.max(n, Math.ceil((1 - hiYear) / n) * n);
  const hHi = Math.floor((1 - loYear) / n) * n;
  for (let h = hHi; h >= hLo; h -= n) out.push(1 - h);
  for (let y = Math.max(n, Math.ceil(loYear / n) * n); y <= hiYear; y += n) out.push(y);
  return out;
}

/**
 * Major ticks with labels for the visible days. Labels never repeat a coarser unit needlessly ("Apr 1931";
 * day ticks "17 May 1994").
 * @param {TimeScale} scale
 * @param {{minPx?: number}} [opts]
 * @returns {Array<{day: number, x: number, label: string, unit: string}>}
 */
export function ticks(scale, { minPx = MIN_LABEL_PX } = {}) {
  const step = majorStep(scale.daysPerPx, minPx);
  const lo = ymdFromDay(Math.floor(scale.loDay));
  const hi = ymdFromDay(Math.ceil(scale.hiDay));
  const out = [];
  const push = (day, label) => {
    const x = scale.x(day);
    if (x >= -1 && x <= scale.width + 1) out.push({ day, x, label, unit: step.unit });
  };
  if (step.unit === 'year') {
    for (const y of yearTicks(lo.y - step.n, hi.y + step.n, step.n)) push(dayFromYMD(y, 1, 1), yearLabel(y));
  } else if (step.unit === 'month') {
    for (let y = lo.y; y <= hi.y; y++) {
      for (let m = 1; m <= 12; m += step.n) push(dayFromYMD(y, m, 1), `${MONTH_ABBR[m - 1]} ${yearLabel(y)}`);
    }
  } else {
    // Day ticks restart at the 1st of every month so labels stay on round days (1, 11, 21 …).
    for (let y = lo.y; y <= hi.y; y++) {
      for (let m = (y === lo.y ? lo.m : 1); m <= (y === hi.y ? hi.m : 12); m++) {
        const first = dayFromYMD(y, m, 1);
        const len = dayFromYMD(y, m + 1, 1) - first;
        for (let d = 0; d < len; d += step.n) {
          if (step.n > 1 && len - d < step.n / 2 && d > 0) break;
          const { d: dd } = ymdFromDay(first + d);
          push(first + d, `${dd} ${MONTH_ABBR[m - 1]} ${yearLabel(y)}`);
        }
      }
    }
  }
  return out.sort((a, b) => a.day - b.day);
}

/**
 * Length of one CSS centimetre in words: '12.5 years', '3.2 months', '4 days', '6 hours'.
 * @param {number} daysPerPx
 * @returns {string}
 */
export function cmLabel(daysPerPx) {
  const days = CSS_CM_PX * daysPerPx;
  const years = days / DAYS_PER_YEAR;
  if (years >= 1.5) return `${formatNumber(years)} years`;
  if (years >= 0.95) return '1 year';
  if (days >= 45) return `${formatNumber(days / 30.44)} months`;
  if (days >= 1.5) return `${formatNumber(days)} days`;
  if (days >= 0.95) return '1 day';
  return `${formatNumber(days * 24)} hours`;
}

/**
 * The footer caption (§1.5): "Bins: decades · 1 cm ≈ 12.5 years".
 * @param {string} tier
 * @param {number} daysPerPx
 * @returns {string}
 */
export function binCaption(tier, daysPerPx) {
  return `Bins: ${BIN_PLURAL[tier]} · 1 cm ≈ ${cmLabel(daysPerPx)}`;
}

/**
 * A short label for a day at the precision a tier can show (tooltips, the vantage label "as of 1997").
 * @param {number} day
 * @param {'year'|'month'|'day'} [precision='year']
 * @returns {string}
 */
export function dayLabel(day, precision = 'year') {
  const { y, m, d } = ymdFromDay(Math.floor(day));
  if (precision === 'day') return `${d} ${MONTH_ABBR[m - 1]} ${yearLabel(y)}`;
  if (precision === 'month') return `${MONTH_ABBR[m - 1]} ${yearLabel(y)}`;
  return yearLabel(y);
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
