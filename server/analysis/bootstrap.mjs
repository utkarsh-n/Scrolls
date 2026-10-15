// OWNER: WP4
// bootstrap.mjs — document-block bootstrap intervals and control percentiles (SPEC §4.8, §4.9, §4.10).
//
// Occurrences from one document are not independent, so intervals resample whole documents ("blocks")
// with replacement; the statistic is recomputed on each resample and the 2.5th and 97.5th percentiles of
// those values form the 95% interval. Seeded (mulberry32), so a payload is reproducible.

import { mulberry32 } from '../../src/shared/ids.mjs';

/** Resamples per interval (§4.8: 1,000). */
export const RESAMPLES = 1000;
/** Default seed of every bootstrap (§4.8 "seed 42" convention). */
export const SEED = 42;

/**
 * Quantile of an ascending-sorted array by linear interpolation (type 7).
 * @param {ArrayLike<number>} sorted
 * @param {number} p 0–1
 * @returns {number|null}
 */
export function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * 95% CI of a statistic by resampling documents (blocks) with replacement.
 * @template B
 * @param {B[]} blocks one entry per document (whatever the statistic needs)
 * @param {(sample: B[]) => number|null} statistic NaN/null results are dropped
 * @param {{resamples?: number, seed?: number, level?: number}} [opts]
 * @returns {[number, number]|null} null with fewer than 2 blocks or no finite resample
 */
export function blockBootstrap(blocks, statistic, { resamples = RESAMPLES, seed = SEED, level = 0.95 } = {}) {
  const n = blocks.length;
  if (n < 2) return null;
  const rng = mulberry32(seed);
  const sample = new Array(n);
  const values = [];
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) sample[i] = blocks[Math.floor(rng() * n)];
    const v = statistic(sample);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const a = (1 - level) / 2;
  return [quantile(values, a), quantile(values, 1 - a)];
}

/**
 * Bootstrap of a statistic over two independent sets of blocks (slice A and slice B are resampled
 * separately, each by document), e.g. the JSD between two slices' context-group shares.
 * @template B
 * @param {B[]} blocksA
 * @param {B[]} blocksB
 * @param {(a: B[], b: B[]) => number|null} statistic
 * @param {{resamples?: number, seed?: number, level?: number}} [opts]
 * @returns {[number, number]|null}
 */
export function twoSampleBootstrap(blocksA, blocksB, statistic, { resamples = RESAMPLES, seed = SEED, level = 0.95 } = {}) {
  if (blocksA.length < 2 || blocksB.length < 2) return null;
  const rng = mulberry32(seed);
  const sa = new Array(blocksA.length), sb = new Array(blocksB.length);
  const values = [];
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < sa.length; i++) sa[i] = blocksA[Math.floor(rng() * blocksA.length)];
    for (let i = 0; i < sb.length; i++) sb[i] = blocksB[Math.floor(rng() * blocksB.length)];
    const v = statistic(sa, sb);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  values.sort((x, y) => x - y);
  const a = (1 - level) / 2;
  return [quantile(values, a), quantile(values, 1 - a)];
}

/**
 * Percentile of a value within a control distribution: the share of controls strictly below it plus half
 * the ties, × 100 (so a value equal to every control sits at the 50th percentile).
 * @param {number} value
 * @param {ArrayLike<number>} controls
 * @returns {number|null}
 */
export function percentileOf(value, controls) {
  const n = controls.length;
  if (!n || !Number.isFinite(value)) return null;
  let below = 0, ties = 0;
  for (let i = 0; i < n; i++) {
    if (controls[i] < value) below++;
    else if (controls[i] === value) ties++;
  }
  return (100 * (below + ties / 2)) / n;
}

/**
 * 95% CIs of every category's share at once, resampling documents: each block is one document's counts
 * per category; a resample's share of category j is Σ counts_j / Σ counts.
 * @param {Array<ArrayLike<number>>} blocks
 * @param {number} k categories
 * @param {{resamples?: number, seed?: number, level?: number}} [opts]
 * @returns {Array<[number, number]|null>} null for every category with fewer than 2 blocks
 */
export function shareIntervals(blocks, k, { resamples = RESAMPLES, seed = SEED, level = 0.95 } = {}) {
  const n = blocks.length;
  if (n < 2) return Array.from({ length: k }, () => null);
  const rng = mulberry32(seed);
  const draws = Array.from({ length: k }, () => []);
  const tot = new Float64Array(k);
  for (let r = 0; r < resamples; r++) {
    tot.fill(0);
    let all = 0;
    for (let i = 0; i < n; i++) {
      const b = blocks[Math.floor(rng() * n)];
      for (let j = 0; j < k; j++) { tot[j] += b[j]; all += b[j]; }
    }
    if (!(all > 0)) continue;
    for (let j = 0; j < k; j++) draws[j].push(tot[j] / all);
  }
  const a = (1 - level) / 2;
  return draws.map((d) => {
    if (!d.length) return null;
    d.sort((x, y) => x - y);
    return [quantile(d, a), quantile(d, 1 - a)];
  });
}
