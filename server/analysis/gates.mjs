// OWNER: WP4
// gates.mjs — minimum-evidence gates and computed widening suggestions (SPEC I4, §4.11, §13 rule 7).
//
// A gate that fails yields {gate, needed, have, suggestion, value: null, ci: null} — never a numeral for
// the gated measure. `needed` and `have` name only the failing criterion. A suggestion is computed by
// widening the failing slice in 10-year steps (away from the other slice first, never into it, never
// beyond the collections' dated coverage) until the gate passes, and reports what the slice would have;
// when nothing passes, suggestion is null and the note says "no widening inside this corpus reaches the gate".

import { yearLabel } from '../../src/shared/dates.mjs';
import { formatCount } from '../../src/shared/format.mjs';
import { windowStats } from './slices.mjs';

/** Every threshold of §4.6, §4.8, §4.9, §4.10 in one place. */
export const THRESHOLDS = Object.freeze({
  collocates: Object.freeze({ occurrences: 20, f_xy: 5, f_y: 10, g2: 10.83, q: 0.05 }),
  clustering: Object.freeze({ occurrences: 60, documents: 5, silhouette: 0.10 }),
  sense_share_jsd: Object.freeze({ occurrences: 50, documents: 5, authors: 3, top_doc_share: 0.5 }),
  neighbor_overlap: Object.freeze({ occurrences: 50, tokens: 3_000_000, documents: 10, authors: 5 }),
  aligned_displacement: Object.freeze({ occurrences: 100, documents: 20, authors: 5, tokens: 3_000_000, anchors: 3000,
    anchor_cos: 0.5, composition_jsd: 0.4 }),
  tone: Object.freeze({ paragraphs: 30 }),
});

/** The note shown when no widening reaches a gate (§4.11). */
export const NO_WIDENING_NOTE = 'no widening inside this corpus reaches the gate';
/** §4.11 copy for OpenAlex cross-cell comparisons. */
export const SAMPLING_DESIGN_NOTE = 'OpenAlex is a top-cited sample per field × period; cells are not comparable as rates.';
/** §4.11 copy for tone without the adapter. */
export const TONE_ADAPTER_MISSING = 'Tone needs the optional on-device adapter (not installed)';
/** The years step of a widening (§4.11). */
export const WIDEN_STEP_YEARS = 10;

/**
 * A gated measure: no value, no interval, and what would have been needed.
 * @param {string} code vocab.GATE_CODES (not 'ok')
 * @param {{needed: object, have: object, suggestion?: object|null, note?: string|null}} detail extra keys are kept
 * @returns {object}
 */
export function gated(code, { needed, have, suggestion = null, note = null, ...extra }) {
  if (code === 'ok') throw new TypeError('gated(): a passing gate is not a gate card');
  return { ...extra, gate: code, value: null, ci: null, needed, have, suggestion, note };
}

/**
 * Evaluate thresholds: every key of `needed` must be met by `have` (a `max_` key is an upper bound).
 * @param {string} code the gate code reported when a criterion fails
 * @param {Record<string, number>} needed
 * @param {Record<string, number|null>} have
 * @returns {object|null} null when every criterion passes, else a gated object naming the failing criteria
 */
export function evaluateGate(code, needed, have) {
  const failNeeded = {}, failHave = {};
  for (const [k, want] of Object.entries(needed)) {
    const v = have[k];
    const ok = k.startsWith('max_') ? v !== null && v !== undefined && v <= want : v !== null && v !== undefined && v >= want;
    if (!ok) { failNeeded[k] = want; failHave[k] = v ?? null; }
  }
  return Object.keys(failNeeded).length ? gated(code, { needed: failNeeded, have: failHave }) : null;
}

/**
 * Whether window statistics meet per-slice criteria (keys of THRESHOLDS entries).
 * @param {object} stats windowStats() or slice stats in the same names
 * @param {{occurrences?: number, documents?: number, authors?: number, max_top_doc_share?: number, tokens?: number,
 *   tokensNoTr?: number, cover_docs?: number, cover_authors?: number, units?: number}} crit
 * @returns {boolean}
 */
export function meets(stats, crit) {
  if (crit.occurrences !== undefined && !(stats.n >= crit.occurrences)) return false;
  if (crit.documents !== undefined && !(stats.docs >= crit.documents)) return false;
  if (crit.authors !== undefined && !(stats.authors >= crit.authors)) return false;
  if (crit.max_top_doc_share !== undefined && !(stats.top_doc_share !== null && stats.top_doc_share <= crit.max_top_doc_share)) return false;
  if (crit.units !== undefined && !(stats.units >= crit.units)) return false;
  if (crit.tokensNoTr !== undefined && !(stats.unitsNoTr >= crit.tokensNoTr)) return false;
  if (crit.cover_docs !== undefined && !(stats.cover_docs >= crit.cover_docs)) return false;
  if (crit.cover_authors !== undefined && !(stats.cover_authors >= crit.cover_authors)) return false;
  return true;
}

/**
 * Widen a slice in 10-year steps until `crit` passes over the widening index. Candidates at each step: the
 * end away from the other slice, the end toward it, then both ends; the slice never grows into the other
 * slice (when they are disjoint) nor beyond the index's dated coverage.
 * @param {{evidence: object[], cover: object[], bounds: [number, number]|null}} index slices.wideningIndex()
 * @param {[number, number]} years the failing slice
 * @param {object} crit criteria for meets()
 * @param {{other?: [number, number]|null, step?: number}} [opts]
 * @returns {{years: [number, number], stats: object}|null}
 */
export function widenSuggestion(index, years, crit, { other = null, step = WIDEN_STEP_YEARS } = {}) {
  if (!index?.bounds) return null;
  const [lo, hi] = years;
  let floor = Math.min(index.bounds[0], lo), ceil = Math.max(index.bounds[1], hi);
  let awayIsDown = true;
  if (other) {
    if (other[0] > hi) { ceil = Math.min(ceil, other[0] - 1); awayIsDown = true; }
    else if (other[1] < lo) { floor = Math.max(floor, other[1] + 1); awayIsDown = false; }
  }
  const statsOpts = { authorsNeeded: crit.authors ?? 0, coverAuthorsNeeded: crit.cover_authors ?? 0 };
  const seen = new Set([`${lo}|${hi}`]);
  for (let k = 1; ; k++) {
    const d = k * step;
    const down = [Math.max(floor, lo - d), hi];
    const up = [lo, Math.min(ceil, hi + d)];
    const half = Math.floor(k / 2) * step;
    const both = [Math.max(floor, lo - (d - half)), Math.min(ceil, hi + half)];
    let fresh = false;
    for (const [L, H] of awayIsDown ? [down, up, both] : [up, down, both]) {
      const key = `${L}|${H}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh = true;
      const stats = windowStats(index, L, H, statsOpts);
      if (meets(stats, crit)) return { years: [L, H], stats };
    }
    if (!fresh && lo - d <= floor && hi + d >= ceil) return null;
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * '1840–1899', '1911', '500 BCE–1 BCE'.
 * @param {[number, number]} years
 * @returns {string}
 */
export function rangeLabel([lo, hi]) {
  return lo === hi ? yearLabel(lo) : `${yearLabel(lo)}–${yearLabel(hi)}`;
}

/**
 * A token count that never rounds up to a threshold it misses: 2,950,000 → '2.95M', 2,999,999 → '2.99M',
 * 21,400 → '21.4k' (the shared formatter would print 2,950,000 as '3M').
 * @param {number} n
 * @returns {string}
 */
export function tokensHave(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${Math.floor(n / 1e4) / 100}M`;
  if (n >= 1e3) return `${Math.floor(n / 100) / 10}k`;
  return String(Math.floor(n));
}

/**
 * The denominator in words: '18k tokens', '41 works'.
 * @param {number} units
 * @param {'tokens'|'works'} unit
 * @returns {string}
 */
export function unitsLabel(units, unit) {
  return unit === 'tokens' ? `${tokensHave(units)} tokens` : `${formatCount(units)} works`;
}

/**
 * §4.11 rate copy: "low coverage: n = 3 in 18k tokens".
 * @param {number} n
 * @param {number} units
 * @param {'tokens'|'works'} unit
 * @returns {string}
 */
export function lowCoverageNote(n, units, unit) {
  return `low coverage: n = ${formatCount(n)} in ${unitsLabel(units, unit)}`;
}

/**
 * §4.11 collocates copy: "Too few occurrences (12; needs 20). Showing KWIC." (both slices: "(7 and 15; …)";
 * one of two: "Too few occurrences in A (12; needs 20). Showing KWIC.").
 * @param {{a?: number|null, b?: number|null}} have occurrences of failing slices (null/undefined = passing)
 * @param {number} needed
 * @returns {string}
 */
export function collocatesNote(have, needed) {
  const fa = have.a !== undefined && have.a !== null && have.a < needed;
  const fb = have.b !== undefined && have.b !== null && have.b < needed;
  if (fa && fb) return `Too few occurrences (${formatCount(have.a)} and ${formatCount(have.b)}; needs ${needed}). Showing KWIC.`;
  if (fa && have.b !== undefined) return `Too few occurrences in A (${formatCount(have.a)}; needs ${needed}). Showing KWIC.`;
  if (fb && have.a !== undefined) return `Too few occurrences in B (${formatCount(have.b)}; needs ${needed}). Showing KWIC.`;
  return `Too few occurrences (${formatCount(fa ? have.a : have.b)}; needs ${needed}). Showing KWIC.`;
}

/**
 * The label of a widening suggestion: "Widen A to 1840–1899 (61 occurrences in 9 documents)".
 * @param {'a'|'b'|null} which null for a single-slice endpoint
 * @param {[number, number]} years
 * @param {string} what e.g. '61 occurrences in 9 documents'
 * @returns {string}
 */
export function widenLabel(which, years, what) {
  return `Widen ${which ? `${which.toUpperCase()} ` : ''}to ${rangeLabel(years)} (${what})`;
}
