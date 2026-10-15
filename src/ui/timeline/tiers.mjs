// OWNER: WP6
// timeline/tiers.mjs — level-of-detail tiers L0–L5 (SPEC §1.6): which calendar bin a zoom shows, bin ↔ day
// arithmetic for every tier, tile numbering (64 bins per tile, §7.2) and bin labels.
//
// L0–L3 bin by astronomical year (millennium, century, decade, year: bin = floor(year / width)); L4 bins by
// month (bin = year * 12 + month - 1, as dates.monthBinOfDay); L5 bins by day (bin = day number). A bin is
// never drawn at a finer precision than its own: these are the only functions that turn bins into days.

import { dayFromYMD, ymdFromDay, tierForPpy, yearLabel, MONTH_ABBR, monthBinOfDay } from '../../shared/dates.mjs';
import { TIERS } from '../../shared/vocab.mjs';

export const DAYS_PER_YEAR = 365.2425;
/** Bins per tile (§7.2: tile = floor(bin / 64)). */
export const TILE_BINS = 64;
/** Year width of the year-based tiers. */
export const TIER_YEARS = Object.freeze({ L0: 1000, L1: 100, L2: 10, L3: 1 });
/** Level number of each tier (dates.LEVELS). */
export const TIER_LEVEL = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 });
/** Pixels per year at which each tier starts (§1.6 table); L5 ends at 40 px/day. */
export const TIER_PPY = Object.freeze({ L0: 0.05, L1: 0.08, L2: 0.8, L3: 8, L4: 96, L5: 2922, end: 40 * DAYS_PER_YEAR });
/** Plural bin names for the ruler caption ("Bins: decades"). */
export const BIN_PLURAL = Object.freeze({ L0: 'millennia', L1: 'centuries', L2: 'decades', L3: 'years', L4: 'months', L5: 'days' });
/** Adjective for the level-change pill ("Now showing yearly bins"). */
export const BIN_ADJECTIVE = Object.freeze({ L0: 'millennium', L1: 'century', L2: 'decade', L3: 'yearly', L4: 'monthly', L5: 'daily' });
/** The precision that fits one bin of each tier: an item of a coarser precision is a wash at that tier. */
export const TIER_PRECISION = Object.freeze({ L0: 'millennium', L1: 'century', L2: 'decade', L3: 'year', L4: 'month', L5: 'day' });

/** @param {string} tier @returns {boolean} */
export const isTier = (tier) => TIERS.includes(tier);

/**
 * Automatic tier for a zoom in days per pixel (the smallest calendar unit whose bin is ≥ 8 px wide).
 * @param {number} daysPerPx
 * @returns {'L0'|'L1'|'L2'|'L3'|'L4'|'L5'}
 */
export function tierForDaysPerPx(daysPerPx) {
  return tierForPpy(DAYS_PER_YEAR / daysPerPx);
}

/**
 * The tier actually drawn: users can force a coarser tier, never a finer one (§1.6).
 * @param {string} autoTier
 * @param {string} forced 'auto' or a tier
 * @returns {string}
 */
export function effectiveTier(autoTier, forced) {
  if (!isTier(forced)) return autoTier;
  return TIER_LEVEL[forced] < TIER_LEVEL[autoTier] ? forced : autoTier;
}

/** One tier coarser (L0 stays L0). @param {string} tier @returns {string} */
export function coarserTier(tier) {
  return TIERS[Math.max(0, TIER_LEVEL[tier] - 1)];
}

/** One tier finer (L5 stays L5). @param {string} tier @returns {string} */
export function finerTier(tier) {
  return TIERS[Math.min(TIERS.length - 1, TIER_LEVEL[tier] + 1)];
}

/**
 * A zoom (days per pixel) in the middle of a tier's range (geometric mean of its px/year bounds), used by
 * the 1–6 keys ("jump to tier") and double-tap.
 * @param {string} tier
 * @returns {number}
 */
export function daysPerPxForTier(tier) {
  const i = TIER_LEVEL[tier];
  const lo = TIER_PPY[tier];
  const hi = i === 5 ? TIER_PPY.end : TIER_PPY[TIERS[i + 1]];
  return DAYS_PER_YEAR / Math.sqrt(lo * hi);
}

/**
 * Bin index of a day at a tier.
 * @param {string} tier
 * @param {number} day
 * @returns {number}
 */
export function binOfDay(tier, day) {
  if (tier === 'L5') return Math.floor(day);
  if (tier === 'L4') return monthBinOfDay(Math.floor(day));
  return Math.floor(ymdFromDay(Math.floor(day)).y / TIER_YEARS[tier]);
}

/**
 * First day of a bin.
 * @param {string} tier
 * @param {number} bin
 * @returns {number}
 */
export function binStartDay(tier, bin) {
  if (tier === 'L5') return bin;
  if (tier === 'L4') {
    const y = Math.floor(bin / 12);
    return dayFromYMD(y, bin - y * 12 + 1, 1);
  }
  return dayFromYMD(bin * TIER_YEARS[tier], 1, 1);
}

/**
 * Last day of a bin (inclusive).
 * @param {string} tier
 * @param {number} bin
 * @returns {number}
 */
export function binEndDay(tier, bin) {
  return binStartDay(tier, bin + 1) - 1;
}

/** Year interval [lo, hi] of a year-based bin. */
function binYears(tier, bin) {
  const w = TIER_YEARS[tier];
  return [bin * w, bin * w + w - 1];
}

/**
 * Historical label of a year range: '1910–1919', '500–401 BCE', '99 BCE – 900 CE'.
 * @param {number} lo astronomical
 * @param {number} hi astronomical
 * @returns {string}
 */
export function yearRangeLabel(lo, hi) {
  if (lo === hi) return yearLabel(lo);
  if (hi <= 0) return `${1 - lo}–${1 - hi} BCE`;
  if (lo > 0 && hi < 1000) return `${lo}–${hi} CE`;
  if (lo > 0) return `${lo}–${hi}`;
  return `${yearLabel(lo)} – ${yearLabel(hi)}`;
}

/**
 * Label of a bin: '1000–1999', '1800–1899', '1910–1919', '1911', 'Apr 1931', '17 May 1994'.
 * @param {string} tier
 * @param {number} bin
 * @returns {string}
 */
export function binLabel(tier, bin) {
  if (tier === 'L5') {
    const { y, m, d } = ymdFromDay(bin);
    return `${d} ${MONTH_ABBR[m - 1]} ${yearLabel(y)}`;
  }
  if (tier === 'L4') {
    const y = Math.floor(bin / 12);
    return `${MONTH_ABBR[bin - y * 12]} ${yearLabel(y)}`;
  }
  const [lo, hi] = binYears(tier, bin);
  return yearRangeLabel(lo, hi);
}

/**
 * Tile of a bin and the bin's index inside it.
 * @param {number} bin
 * @returns {{tile: number, idx: number}}
 */
export function tileOf(bin) {
  const tile = Math.floor(bin / TILE_BINS);
  return { tile, idx: bin - tile * TILE_BINS };
}

/**
 * Tile numbers covering the days [loDay, hiDay] at a tier.
 * @param {string} tier
 * @param {number} loDay
 * @param {number} hiDay
 * @param {number} [max=64] refuse to list more tiles than this (the caller coarsens instead)
 * @returns {number[]}
 */
export function tilesForDays(tier, loDay, hiDay, max = 64) {
  const a = tileOf(binOfDay(tier, loDay)).tile;
  const b = tileOf(binOfDay(tier, hiDay)).tile;
  const out = [];
  for (let t = a; t <= b && out.length < max; t++) out.push(t);
  return out;
}

/**
 * Bins [first, last] whose days intersect [loDay, hiDay].
 * @param {string} tier
 * @param {number} loDay
 * @param {number} hiDay
 * @returns {[number, number]}
 */
export function binsForDays(tier, loDay, hiDay) {
  return [binOfDay(tier, loDay), binOfDay(tier, hiDay)];
}

/**
 * Does an interval of days fit inside one bin of a tier (fit-or-wash, D2)?
 * @param {string} tier
 * @param {number} loDay
 * @param {number} hiDay
 * @returns {boolean}
 */
export function fitsTier(tier, loDay, hiDay) {
  return binOfDay(tier, loDay) === binOfDay(tier, hiDay);
}

/**
 * The bin after the one containing `day` ends on this day: the vantage steps from bin end to bin end, so
 * "as of" always means a whole bin (§1.9: values change discretely by bin).
 * @param {string} tier
 * @param {number} day
 * @param {number} steps positive = later, negative = earlier
 * @returns {number} the last day of the target bin
 */
export function stepBinEnd(tier, day, steps) {
  const here = binOfDay(tier, day);
  const atEnd = binEndDay(tier, here) === Math.floor(day);
  // From inside a bin, one step back lands on the end of the previous bin; one step forward on this bin's end.
  let target;
  if (steps > 0) target = here + steps - (atEnd ? 0 : 1);
  else target = here + steps;
  return binEndDay(tier, target);
}

/**
 * Snap a day to the end of its bin (scrubbing is discrete by bin).
 * @param {string} tier
 * @param {number} day
 * @returns {number}
 */
export function snapToBinEnd(tier, day) {
  return binEndDay(tier, binOfDay(tier, day));
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
