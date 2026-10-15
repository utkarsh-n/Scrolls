// OWNER: WP4
// composition.mjs — composition JSD between slices and directly standardized rates (SPEC §2.E item 1, §4.9).
//
// A slice's composition is its mix of kind × passage language × collection, weighted by the rate
// denominator (tokens, or one per work). JSD > 0.15 fires the composition caveat and the standardized
// rates; JSD > 0.4 suppresses aligned displacement (composition_mismatch).

/** JSD above which the composition caveat fires and standardized rates are shown. */
export const COMPOSITION_CAVEAT_JSD = 0.15;
/** JSD above which aligned displacement is not reported. */
export const COMPOSITION_MISMATCH_JSD = 0.4;

/**
 * Normalize non-negative weights to shares (empty or all-zero → {}).
 * @param {Record<string, number>|Map<string, number>} weights
 * @returns {Record<string, number>}
 */
export function normalize(weights) {
  const entries = weights instanceof Map ? [...weights] : Object.entries(weights ?? {});
  let total = 0;
  for (const [, v] of entries) if (v > 0) total += v;
  const out = {};
  if (!(total > 0)) return out;
  for (const [k, v] of entries) if (v > 0) out[k] = v / total;
  return out;
}

const plogp = (p) => (p > 0 ? p * Math.log2(p) : 0);

/**
 * Jensen–Shannon divergence (base 2, in [0, 1]) of two composition distributions given as weights or
 * shares; both are normalized first. Null when either side is empty.
 * @param {Record<string, number>|Map<string, number>} a
 * @param {Record<string, number>|Map<string, number>} b
 * @returns {number|null}
 */
export function compositionJsd(a, b) {
  const p = normalize(a), q = normalize(b);
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  if (!Object.keys(p).length || !Object.keys(q).length) return null;
  let hm = 0, hp = 0, hq = 0;
  for (const k of keys) {
    const pk = p[k] ?? 0, qk = q[k] ?? 0;
    hm -= plogp((pk + qk) / 2);
    hp -= plogp(pk);
    hq -= plogp(qk);
  }
  const v = hm - (hp + hq) / 2;
  return Math.min(1, Math.max(0, v));
}

/**
 * Directly standardized rates: each slice's stratum rates weighted by the pooled (A + B) denominator
 * shares, over the strata that both slices cover (a stratum missing from one slice has no rate there).
 * @param {Map<string, {a: {n: number, denom: number}, b: {n: number, denom: number}}>} strata
 * @param {{scale?: number}} [opts] 1e6 for per million tokens, 1e3 for per thousand works
 * @returns {{a: number, b: number, strata: number, weight_covered: number}|null} null when no stratum is
 *   covered by both slices
 */
export function standardizedRates(strata, { scale = 1e6 } = {}) {
  let pooled = 0, covered = 0, ra = 0, rb = 0, used = 0, nA = 0, nB = 0, sharedA = 0, sharedB = 0;
  for (const s of strata.values()) { pooled += s.a.denom + s.b.denom; nA += s.a.n; nB += s.b.n; }
  if (!(pooled > 0)) return null;
  for (const s of strata.values()) {
    if (!(s.a.denom > 0 && s.b.denom > 0)) continue;
    const w = (s.a.denom + s.b.denom) / pooled;
    covered += w;
    ra += w * s.a.n / s.a.denom;
    rb += w * s.b.n / s.b.denom;
    sharedA += s.a.n; sharedB += s.b.n;
    used++;
  }
  if (!used) return null;
  // the shares of each slice's matches that lie in the shared strata: a standardized rate speaks only for those
  return { a: ra / covered * scale, b: rb / covered * scale, strata: used, weight_covered: covered,
    matches_covered: { a: nA > 0 ? sharedA / nA : null, b: nB > 0 ? sharedB / nB : null } };
}

/** Below this share of the pooled mix, or of either slice's matches, in the shared strata, no standardized rate is given. */
export const STANDARDIZE_MIN_COVER = 0.5;

/**
 * The share of the largest key, with its key: {key: 'song', share: 0.62}.
 * @param {Record<string, number>} shares
 * @returns {{key: string, share: number}|null}
 */
export function topShare(shares) {
  let best = null;
  for (const [key, share] of Object.entries(shares ?? {})) if (!best || share > best.share) best = { key, share };
  return best;
}
