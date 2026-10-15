// OWNER: WP4
// keyness.mjs — keyness of context words between two slices: Hardie's log ratio with Dunning's G² and
// Benjamini–Hochberg q < .05 (SPEC §2.E item 4). Context words, not meanings.

import { benjaminiHochberg, chi2Sf, g2 } from './intervals.mjs';

/** Minimum combined frequency for a term to be tested. */
export const KEYNESS_MIN_F = 5;
/** FDR level. */
export const KEYNESS_Q = 0.05;

/**
 * Keyness rows for two frequency profiles (context-window counts of the target in slice A and in slice
 * B). log_ratio = log2 of B's relative frequency over A's (a zero count is replaced by 0.5, Hardie 2014);
 * positive → key in B. Only rows with q < .05 are returned, sorted by |log_ratio| (then G²).
 * @param {Map<string, number>} countsA
 * @param {Map<string, number>} countsB
 * @param {{totalA?: number, totalB?: number, minF?: number, q?: number, limit?: number}} [opts] totals default to the
 *   sums of the counts
 * @returns {Array<{term: string, f_a: number, f_b: number, log_ratio: number, g2: number, p: number, q: number, side: 'a'|'b'}>}
 */
export function keyness(countsA, countsB, { totalA, totalB, minF = KEYNESS_MIN_F, q = KEYNESS_Q, limit = 50 } = {}) {
  const sum = (m) => { let s = 0; for (const v of m.values()) s += v; return s; };
  const ta = totalA ?? sum(countsA), tb = totalB ?? sum(countsB);
  if (!(ta > 0) || !(tb > 0)) return [];
  const terms = new Set([...countsA.keys(), ...countsB.keys()]);
  const rows = [];
  for (const term of terms) {
    const fa = countsA.get(term) ?? 0, fb = countsB.get(term) ?? 0;
    if (fa + fb < minF) continue;
    const g = g2(fa, ta - fa, fb, tb - fb);
    const lr = Math.log2(((fb || 0.5) / tb) / ((fa || 0.5) / ta));
    rows.push({ term, f_a: fa, f_b: fb, log_ratio: lr, g2: g, p: chi2Sf(g, 1) });
  }
  const qs = benjaminiHochberg(rows.map((r) => r.p));
  return rows.map((r, i) => ({ ...r, q: qs[i], side: r.log_ratio > 0 ? 'b' : 'a' }))
    .filter((r) => r.q < q && r.log_ratio !== 0)
    .sort((x, y) => Math.abs(y.log_ratio) - Math.abs(x.log_ratio) || y.g2 - x.g2 || (x.term < y.term ? -1 : 1))
    .slice(0, limit);
}
