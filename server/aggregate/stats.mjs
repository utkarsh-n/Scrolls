// OWNER: WP3
// stats.mjs — exact intervals and dispersion (SPEC §4.6): Garwood (exact Poisson) for token rates, Wilson for
// work shares, Gries' DP over documents. Pure functions; no database.

const LN_SQRT_2PI = 0.9189385332046728;
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return LN_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularized lower incomplete gamma P(a, x) (series below a + 1, Lentz continued fraction above).
 * @param {number} a shape > 0
 * @param {number} x ≥ 0
 * @returns {number}
 */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  const lnPre = a * Math.log(x) - x - logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 10000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * h);
}

/**
 * Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9).
 * @param {number} p in (0, 1)
 * @returns {number}
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Quantile of Gamma(shape a, scale 1): the x with P(a, x) = p (Wilson–Hilferty start, safeguarded Newton).
 * @param {number} p in (0, 1)
 * @param {number} a shape > 0
 * @returns {number}
 */
export function gammaQuantile(p, a) {
  if (!(p > 0 && p < 1)) throw new RangeError(`gammaQuantile: p must be in (0, 1), got ${p}`);
  const z = normalQuantile(p);
  let x = a * (1 - 1 / (9 * a) + z / (3 * Math.sqrt(a))) ** 3;
  if (!(x > 0)) x = Math.max(1e-8, a * 0.01);
  let lo = 0, hi = Math.max(1, x) * 4;
  while (gammaP(a, hi) < p) hi *= 2;
  const lnGa = logGamma(a);
  for (let i = 0; i < 200; i++) {
    const f = gammaP(a, x) - p;
    if (Math.abs(f) < 1e-13) break;
    if (f < 0) lo = Math.max(lo, x); else hi = Math.min(hi, x);
    const dens = Math.exp((a - 1) * Math.log(x) - x - lnGa);
    let next = dens > 0 ? x - f / dens : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - x) <= 1e-12 * Math.max(1, x)) { x = next; break; }
    x = next;
  }
  return x;
}

/**
 * Exact (Garwood) two-sided Poisson interval for an observed count n: the bounds of the mean count.
 * n = 0 → [0, −ln(α/2)] (3.689 at 95%).
 * Cross-package: Compare (WP4) prints frequency CIs.
 * @param {number} n observed count ≥ 0
 * @param {number} [level=0.95]
 * @returns {[number, number]}
 */
export function garwoodCI(n, level = 0.95) {
  if (!(Number.isInteger(n) && n >= 0)) throw new RangeError(`garwoodCI: n must be a non-negative integer, got ${n}`);
  const alpha = 1 - level;
  const lower = n === 0 ? 0 : gammaQuantile(alpha / 2, n);
  const upper = gammaQuantile(1 - alpha / 2, n + 1);
  return [lower, upper];
}

/**
 * Wilson score interval for a proportion k / n.
 * Cross-package: Compare (WP4) prints frequency CIs.
 * @param {number} k successes, 0 ≤ k ≤ n
 * @param {number} n trials > 0
 * @param {number} [level=0.95]
 * @returns {[number, number]}
 */
export function wilsonCI(k, n, level = 0.95) {
  if (!(n > 0) || !(k >= 0) || k > n) throw new RangeError(`wilsonCI: need 0 ≤ k ≤ n and n > 0 (k=${k}, n=${n})`);
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Gries' deviation of proportions (DP) over documents: 0.5 · Σ |v_i/V − s_i/S|, where v_i are the
 * occurrences in document i and s_i its share of the slice's tokens. Documents of the slice with no
 * occurrence must be represented (or folded into `restSize`, their total size). null when V = 0 or S = 0.
 * @param {number[]} counts occurrences per document
 * @param {number[]} sizes slice tokens per document (same order)
 * @param {number} [restSize=0] total size of slice documents not listed (they have 0 occurrences)
 * @returns {number|null} 0 (even) … 1 − min share (concentrated)
 */
export function griesDP(counts, sizes, restSize = 0) {
  if (counts.length !== sizes.length) throw new RangeError('griesDP: counts and sizes differ in length');
  let V = 0, S = restSize;
  for (let i = 0; i < counts.length; i++) { V += counts[i]; S += sizes[i]; }
  if (!(V > 0) || !(S > 0)) return null;
  let sum = restSize / S;
  for (let i = 0; i < counts.length; i++) sum += Math.abs(counts[i] / V - sizes[i] / S);
  return Math.round(0.5 * sum * 1000) / 1000;
}
