// OWNER: WP0 — number, rate and unit formatting shared by server copy and UI (SPEC §1.2, §7)
//
// A missing or non-finite value always formats as '—', never as 0: a gated measure has no numeral (§13 rule 7).

import { RATE_UNITS } from './vocab.mjs';

const DASH = '—';
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Group thousands with ','. */
function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Integer count with thousands separators: 94385 → '94,385'.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatCount(n) {
  if (!isNum(n)) return DASH;
  const r = Math.round(n);
  return (r < 0 ? '-' : '') + group(String(Math.abs(r)));
}

/**
 * Readable number: at least three significant digits (whole-number digits are never rounded away), no
 * exponent, trailing zeros dropped, grouped thousands (2850.5 → '2,851'; 367.3 → '367'; 84.25 → '84.3';
 * 0.4123 → '0.412').
 * @param {number|null|undefined} x
 * @param {number} [sig=3]
 * @returns {string}
 */
export function formatNumber(x, sig = 3) {
  if (!isNum(x)) return DASH;
  if (x === 0) return '0';
  const abs = Math.abs(x);
  const digits = Math.floor(Math.log10(abs)) + 1;
  const decimals = Math.max(0, Math.min(6, sig - digits));
  let s = abs.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const [i, f] = s.split('.');
  return (x < 0 ? '-' : '') + group(i) + (f ? `.${f}` : '');
}

/**
 * Compact token count: 812 → '812', 6200 → '6.2k', 18000 → '18k', 41200 → '41.2k', 312000 → '312k',
 * 6100000 → '6.1M', 68000000 → '68M'.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (!isNum(n)) return DASH;
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs < 1000) return sign + String(Math.round(abs));
  const units = [['k', 1e3], ['M', 1e6], ['B', 1e9]];
  for (let u = 0; u < units.length; u++) {
    const [suffix, size] = units[u];
    const v = abs / size;
    const decimals = v < 100 ? 1 : 0;
    const rounded = Number(v.toFixed(decimals));
    if (rounded >= 1000 && u < units.length - 1) continue;
    return sign + String(rounded) + suffix;
  }
  return sign + String(abs);
}

/**
 * Long label of a rate unit ('per million tokens') or of a collection unit ('tokens').
 * @param {string} unit
 * @returns {string}
 */
export function unitLabel(unit) {
  if (RATE_UNITS[unit]) return RATE_UNITS[unit].label;
  return { tokens: 'tokens', works: 'works', entries: 'entries', none: '' }[unit] ?? String(unit ?? '');
}

/**
 * Percent with up to one decimal: 0.315 → '31.5%'.
 * @param {number|null|undefined} share 0–1
 * @returns {string}
 */
export function formatShare(share) {
  if (!isNum(share)) return DASH;
  return `${Number((share * 100).toFixed(1))}%`;
}

function rateValue(rate, unit) {
  return unit === 'share_of_sampled_works' ? formatShare(rate) : formatNumber(rate);
}

/**
 * A rate in its unit: '367/M tokens', '12.5/1k works', '31.5% of sampled works'.
 * @param {number|null|undefined} rate
 * @param {string} unit a RATE_UNITS key
 * @returns {string}
 */
export function formatRate(rate, unit) {
  if (!isNum(rate)) return DASH;
  const u = RATE_UNITS[unit];
  if (!u) return formatNumber(rate);
  return unit === 'share_of_sampled_works' ? `${formatShare(rate)} ${u.short}` : `${formatNumber(rate)}${u.short}`;
}

/**
 * A 95% confidence interval in the same number style as formatRate: '[201, 616]', '[12.5%, 30%]'.
 * @param {[number, number]|null|undefined} ci
 * @param {string} unit
 * @returns {string}
 */
export function formatCI(ci, unit) {
  if (!Array.isArray(ci) || ci.length !== 2 || !isNum(ci[0]) || !isNum(ci[1])) return DASH;
  return `[${rateValue(ci[0], unit)}, ${rateValue(ci[1], unit)}]`;
}

/**
 * The counted total of a timeline query in its units: "1,351 matches", or "562 matches · 789 works" when its lanes count
 * in different units (the Term trail: text matches beside titles and sampled works) — never one sum across units (C2).
 * @param {{n: number, by_unit?: {matches: number, works: number}, units_mixed?: boolean}|null|undefined} totals
 * @returns {string}
 */
export function totalsText(totals) {
  if (!totals) return '';
  const count = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;
  const u = totals.by_unit;
  if (u && totals.units_mixed) return `${count(u.matches, 'match', 'matches')} · ${count(u.works, 'work', 'works')}`;
  if (u && u.works > 0 && u.matches === 0) return count(u.works, 'work', 'works');
  return count(totals.n, 'match', 'matches');
}

/**
 * A reference in words ('passage:53' → 'passage 53', 'relationship:7' → 'link 7', 'cluster:3' → 'context group 3'), for
 * panel headings: the colon form is an internal id (fix pass: headings read 'root passage:53').
 * @param {string|null|undefined} ref
 * @returns {string}
 */
export function refWords(ref) {
  if (ref === null || ref === undefined || ref === '') return '';
  const m = /^([a-z_]+):(.+)$/.exec(String(ref));
  if (!m) return String(ref);
  const words = { relationship: 'link', cluster: 'context group', hypothesis_group: 'hypothesis group', time_window: 'window', saved_view: 'saved view' };
  return `${words[m[1]] ?? m[1].replace(/_/g, ' ')} ${m[2]}`;
}
