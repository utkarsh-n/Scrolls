// OWNER: WP3
// rates.mjs — rates per bin with their unit, denominator and gate (SPEC §1.2, §4.6, §4.11).
//
// A bin has exactly one state: observed (n ≥ 1, denom ≥ gate) · absent (n = 0, denom ≥ gate) · low
// (0 < denom < gate: rate suppressed) · uncovered (denom = 0) · pending (still indexing: "not yet looked").
// Only observed and absent carry a rate and a CI; low, uncovered and pending never do (honesty rules 3, 7).

import { CELL_STATE_CODES, COVERAGE_GATES, COVERAGE_STEPS, RATE_UNITS } from '../../src/shared/vocab.mjs';
import { garwoodCI, wilsonCI } from './stats.mjs';

/** Unit class of a passage field class: what the lane counts and divides by (§1.2 item 8). */
export const UNIT_CLASS_OF_FIELD = Object.freeze({
  text: 'text', describes: 'text', apparatus: 'text', title: 'titles', abstract: 'abstracts',
});
/** Rate unit of each unit class. */
export const RATE_UNIT_OF_CLASS = Object.freeze({
  text: 'per_million_tokens', titles: 'per_thousand_works', abstracts: 'per_million_tokens',
});
/** The collection.unit a unit class's denominator is counted in. */
export const DENOM_UNIT_OF_CLASS = Object.freeze({ text: 'tokens', titles: 'works', abstracts: 'tokens' });

/**
 * The coverage gate of a lane: the strictest gate among its collections. collection.coverage_gate overrides
 * the unit default only when the collection counts in the same unit as the lane (a token gate never gates
 * works).
 * @param {'text'|'titles'|'abstracts'} unitClass
 * @param {Array<{unit: string, coverage_gate: number|null}>} collections
 * @returns {number}
 */
export function laneGate(unitClass, collections = []) {
  const denomUnit = DENOM_UNIT_OF_CLASS[unitClass];
  const dflt = denomUnit === 'works' ? COVERAGE_GATES.works : COVERAGE_GATES.tokens;
  let gate = null;
  for (const c of collections) {
    const g = c.coverage_gate !== null && c.coverage_gate !== undefined && c.unit === denomUnit ? c.coverage_gate : dflt;
    gate = gate === null ? g : Math.max(gate, g);
  }
  return gate ?? dflt;
}

const round6 = (x) => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(6)));

/**
 * One cell's state, rate and 95% CI. Rates: n / denom × 10⁶ (tokens, Garwood) or × 10³ (works, Wilson).
 * @param {{n: number, denom: number, unit: string, gate: number, pending?: boolean}} cell
 * @returns {{state: number, rate: number|null, ci_lo: number|null, ci_hi: number|null}}
 */
export function rateCell({ n, denom, unit, gate, pending = false }) {
  const none = (state) => ({ state, rate: null, ci_lo: null, ci_hi: null });
  if (!(denom > 0)) return none(n > 0 ? CELL_STATE_CODES.low : pending ? CELL_STATE_CODES.pending : CELL_STATE_CODES.uncovered);
  if (denom < gate) return none(CELL_STATE_CODES.low);
  // looked at a complete slice and found none — unless the collection is still indexing (not yet looked)
  if (n === 0 && pending) return none(CELL_STATE_CODES.pending);
  const scale = RATE_UNITS[unit]?.scale ?? 1e6;
  let lo, hi;
  if (unit === 'per_million_tokens' || unit === 'per_million_baseline') {
    [lo, hi] = garwoodCI(n);
    lo = (lo / denom) * scale;
    hi = (hi / denom) * scale;
  } else {
    [lo, hi] = wilsonCI(Math.min(n, denom), denom);
    lo *= scale;
    hi *= scale;
  }
  return {
    state: n >= 1 ? CELL_STATE_CODES.observed : CELL_STATE_CODES.absent,
    rate: round6((n / denom) * scale),
    ci_lo: round6(lo),
    ci_hi: round6(hi),
  };
}

/**
 * Coverage step class 0–4 (§1.7): 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000).
 * @param {number} amount tokens or works
 * @param {'tokens'|'works'} unit
 * @returns {0|1|2|3|4}
 */
export function stepClass(amount, unit) {
  if (!(amount > 0)) return 0;
  const steps = COVERAGE_STEPS[unit === 'works' ? 'works' : 'tokens'];
  for (let i = 0; i < steps.length; i++) if (amount < steps[i]) return i + 1;
  return 4;
}
