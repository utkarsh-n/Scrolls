// OWNER: WP4
// baseline-rho.mjs — "Does our sample track a larger corpus?" (SPEC §10.2, §2.E): Spearman ρ between the strand's
// per-decade rate in the compared running text and the Google Books Ngram rate per million over the same decades.
//
// Only an English single word has a baseline (the store holds English 1-grams), only running text is compared with
// it (Google Books is book text), and only decades up to 2019 (the store's last year). A decade counts when our
// slice text holds at least the rate gate's tokens there (50,000, or the collections' own gate) and Google's
// decade rests on at least 500 books; fewer than 8 such decades → gate card, no ρ (§13 rule 7). Counts include
// the strand's enabled English variants, and the baseline sums the same word forms over the same yearly totals.
// The interval is a moving-block bootstrap over the decade sequence (neighbouring decades are not independent).
// A high ρ says the two series rise and fall together; it is a check of our sample, never evidence of influence.

import { mulberry32 } from '../../src/shared/ids.mjs';
import { formatCount } from '../../src/shared/format.mjs';
import { series as ngramSeries } from '../adapters/stemm/ngram.mjs';
import { gated } from './gates.mjs';
import { windowStats } from './slices.mjs';

/** Rule of the baseline correlation. */
export const BASELINE_RHO = Object.freeze({ minBins: 8, maxYear: 2019, minVolumes: 500, block: 3, resamples: 1000, seed: 42 });
/** Printed with every value. */
export const BASELINE_RHO_NOTE = 'Different corpus, different composition: Google Books is a much larger library with its own selection; '
  + 'ρ only says whether the two decade series rise and fall together.';

/**
 * Average ranks (ties share the mean of their positions), 1-based.
 * @param {ArrayLike<number>} v
 * @returns {Float64Array}
 */
export function ranks(v) {
  const idx = Array.from(v, (_, i) => i).sort((a, b) => v[a] - v[b]);
  const out = new Float64Array(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) out[idx[t]] = r;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman's ρ: Pearson correlation of the average ranks; null when either series is constant.
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @returns {number|null}
 */
export function spearman(x, y) {
  const n = x.length;
  if (n !== y.length) throw new RangeError('spearman: series differ in length');
  if (n < 2) return null;
  const rx = ranks(x), ry = ranks(y);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * Moving-block bootstrap 95% percentile interval of ρ over an ordered series (Künsch 1989): each resample
 * concatenates randomly chosen runs of `block` consecutive bins until it has n bins. Resamples whose ranks are
 * constant (no ρ) are skipped and counted.
 * @param {number[]} x
 * @param {number[]} y
 * @param {{block?: number, resamples?: number, seed?: number}} [opts]
 * @returns {{ci: [number, number]|null, used: number, skipped: number}}
 */
export function blockBootstrapRho(x, y, { block = BASELINE_RHO.block, resamples = BASELINE_RHO.resamples, seed = BASELINE_RHO.seed } = {}) {
  const n = x.length;
  const L = Math.max(1, Math.min(block, n));
  const starts = n - L + 1;
  const rng = mulberry32(seed);
  const vals = [];
  let skipped = 0;
  const bx = new Array(n), by = new Array(n);
  for (let r = 0; r < resamples; r++) {
    let at = 0;
    while (at < n) {
      const s = Math.floor(rng() * starts);
      for (let t = 0; t < L && at < n; t++, at++) { bx[at] = x[s + t]; by[at] = y[s + t]; }
    }
    const rho = spearman(bx, by);
    if (rho === null) { skipped++; continue; }
    vals.push(rho);
  }
  if (vals.length < resamples / 2) return { ci: null, used: vals.length, skipped };
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return { ci: [q(0.025), q(0.975)], used: vals.length, skipped };
}

const r2 = (v) => (v === null ? null : Number(v.toFixed(2)));
/** No comparison is possible (not a gate: nothing about the evidence could change it); `note` is the sentence shown. */
const unavailable = (reason) => ({ available: false, reason, note: reason });

/**
 * The baseline correlation of a comparison (compare.mjs compareContext()).
 * @param {object} cx compareContext()
 * @param {{lookup?: (word: string, range: object) => object}} [opts] the Ngram lookup (tests pass a stub)
 * @returns {object} {available: false, reason, note} | gate card (no value) | {available: true, gate: 'ok', value, ci, n_bins, series, …}
 */
export function baselineRho(cx, { lookup = ngramSeries } = {}) {
  const { exprs, req, statsA, statsB } = cx;
  const expr = exprs.length === 1 ? exprs[0] : null;
  if (!expr) return unavailable('The external baseline is compared for one expression at a time.');
  if (!expr.lang || !/^en\b/.test(expr.lang)) return unavailable('No external baseline: the Ngram store holds English words only.');
  if (expr.norm.includes(' ')) return unavailable('No external baseline: the Ngram store holds single words only.');
  if (cx.sampled) return unavailable('Not compared: OpenAlex cells are top-cited samples, not a series of rates.');
  if (statsA.modality !== 'text' || statsB.modality !== 'text') {
    return unavailable(`Not compared: Google Books is book text and these slices compare ${statsA.modality}.`);
  }
  const forms = [...new Set(expr.variants.filter((v) => v.tokens.length === 1 && (!v.lang || /^en\b/.test(v.lang))).map((v) => v.norm))];
  const lo = Math.min(req.a.years[0], req.b.years[0]);
  const hi = Math.min(BASELINE_RHO.maxYear, Math.max(req.a.years[1], req.b.years[1]));
  const base = lookup(expr.norm, { from: lo, to: hi, lang: 'en' });
  if (!base?.available) return unavailable(`No external baseline for '${expr.norm}': ${base?.reason ?? 'the Ngram store is not staged'}.`);
  // Our counts pool the enabled variants, so the baseline sums the same forms over the same yearly totals.
  const byDecade = new Map(base.decades.map((d) => [d.decade, { ...d }]));
  const missing = [];
  for (const f of forms) {
    if (f === expr.norm) continue;
    const s = lookup(f, { from: lo, to: hi, lang: 'en' });
    if (!s?.available) { missing.push(f); continue; }
    for (const d of s.decades) {
      const e = byDecade.get(d.decade);
      if (e) e.matches += d.matches;
    }
  }
  const sameFilter = req.a.f === req.b.f;
  const inside = (d, years) => d >= years[0] && d + 9 <= years[1];
  const rows = [];
  for (let d = Math.ceil(lo / 10) * 10; d + 9 <= hi; d += 10) {
    const which = sameFilter ? 'a' : inside(d, req.a.years) ? 'a' : inside(d, req.b.years) ? 'b' : null;
    if (!which) continue;
    const st = which === 'a' ? statsA : statsB;
    const w = windowStats(cx.indexOf(which), d, d + 9);
    const g = byDecade.get(d);
    const ours = { n: w.n, tokens: w.units, rate: w.units > 0 ? (w.n / w.units) * 1e6 : null, adequate: w.units >= st.gateUnits };
    const theirs = g ? { per_million: g.tokens > 0 ? (g.matches / g.tokens) * 1e6 : null, volumes: g.volumes, adequate: g.volumes >= BASELINE_RHO.minVolumes }
      : { per_million: null, volumes: 0, adequate: false };
    rows.push({ decade: d, slice: which, ours, baseline: theirs, shared: ours.adequate && theirs.adequate && theirs.per_million !== null });
  }
  const shared = rows.filter((r) => r.shared);
  const meta = { available: true, unit: 'per million tokens', years: [lo, hi], forms: [expr.norm, ...forms.filter((f) => f !== expr.norm && !missing.includes(f))],
    forms_missing: missing, label: base.label, attribution: base.attribution, license: base.license ?? 'CC BY 3.0',
    caveats: base.caveats ?? [], rule: `≥ ${BASELINE_RHO.minBins} decades up to ${BASELINE_RHO.maxYear}, each with our rate gate met and ≥ ${BASELINE_RHO.minVolumes} books in Google's decade`,
    // a decade below our rate gate shows its count and tokens, never a rate (§4.6 'low coverage')
    series: rows.map((r) => ({ decade: r.decade, slice: r.slice, n: r.ours.n, tokens: r.ours.tokens,
      rate: r.ours.rate === null || !r.ours.adequate ? null : Number(r.ours.rate.toPrecision(4)), low_coverage: !r.ours.adequate,
      baseline_per_million: r.baseline.per_million === null ? null : Number(r.baseline.per_million.toPrecision(4)), volumes: r.baseline.volumes,
      thin: r.baseline.volumes < BASELINE_RHO.minVolumes, shared: r.shared })) };
  if (shared.length < BASELINE_RHO.minBins) {
    return { ...meta, n_bins: shared.length, ...gated('insufficient_coverage', { needed: { decades: BASELINE_RHO.minBins }, have: { decades: shared.length },
      note: `Not compared: ${formatCount(shared.length)} decade${shared.length === 1 ? '' : 's'} between ${lo} and ${hi} have enough text here and in Google Books (needs ${BASELINE_RHO.minBins}). Widen the slices to span more decades.` }) };
  }
  const x = shared.map((r) => r.ours.rate), y = shared.map((r) => r.baseline.per_million);
  const rho = spearman(x, y);
  if (rho === null) {
    return { ...meta, n_bins: shared.length, ...gated('insufficient_occurrences', { needed: { varying_rates: true }, have: { decades: shared.length },
      note: `Not compared: the rate is the same in every shared decade${x.every((v) => v === 0) ? ' (no occurrence in any)' : ''}, so ρ is undefined.` }) };
  }
  const boot = blockBootstrapRho(x, y);
  const ci = boot.ci ? boot.ci.map(r2) : null;
  const first = shared[0].decade, last = shared[shared.length - 1].decade + 9;
  return { ...meta, gate: 'ok', value: r2(rho), ci, n_bins: shared.length, span: [first, last],
    method: `Spearman ρ over decades; moving-block bootstrap 95% CI (blocks of ${BASELINE_RHO.block} decades, ${boot.used} resamples, seed ${BASELINE_RHO.seed})`,
    note: BASELINE_RHO_NOTE,
    text: `Does our sample track a larger corpus? ρ = ${r2(rho)}${ci ? ` [${ci[0]}, ${ci[1]}]` : ''} (${shared.length} decades, ${first}–${last}). ${BASELINE_RHO_NOTE}` };
}
