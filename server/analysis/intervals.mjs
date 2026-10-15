// OWNER: WP4
// intervals.mjs — exact intervals and the distribution functions behind them (SPEC §4.6, §2.E): Garwood
// (exact Poisson) and Wilson intervals, the exact conditional rate ratio, Dunning's G², Benjamini–Hochberg,
// Gries' DP. Pure functions on numbers; nothing here touches the database.
//
// The numerical cores (log-gamma, regularized incomplete gamma and beta and their inverses) follow the
// standard continued-fraction / series formulations (Numerical Recipes 3rd ed. §6.1–6.4) with a bisection
// polish, so quantiles are accurate to ~1e-10 relative error over the ranges the app uses.

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const FPMIN = 1e-300;
const EPS = 1e-15;

/**
 * ln Γ(x) for x > 0 (Lanczos, g = 7).
 * @param {number} x
 * @returns {number}
 */
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaSeries(a, x) {
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 0; n < 10000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

function gammaContinuedFraction(a, x) {
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/**
 * Regularized lower incomplete gamma P(a, x).
 * @param {number} a > 0
 * @param {number} x ≥ 0
 * @returns {number}
 */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (!Number.isFinite(x)) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

/**
 * Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x), computed directly in the tail (no cancellation).
 * @param {number} a > 0
 * @param {number} x ≥ 0
 * @returns {number}
 */
export function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (!Number.isFinite(x)) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/** Bisection on a monotone increasing f over [lo, hi] for f(x) = p. */
function bisect(f, p, lo, hi, iterations = 200) {
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < p) lo = mid; else hi = mid;
    if (hi - lo <= 1e-14 * Math.max(1, Math.abs(mid))) break;
  }
  return 0.5 * (lo + hi);
}

/**
 * Inverse of P(a, ·): the x with P(a, x) = p.
 * @param {number} a > 0
 * @param {number} p in [0, 1]
 * @returns {number}
 */
export function gammaPInv(a, p) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  const a1 = a - 1, gln = lnGamma(a);
  let x, lna1 = 0, afac = 0;
  if (a > 1) {
    lna1 = Math.log(a1);
    afac = Math.exp(a1 * (lna1 - 1) - gln);
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) x = -x;
    x = Math.max(1e-3, a * (1 - 1 / (9 * a) - x / (3 * Math.sqrt(a))) ** 3);
  } else {
    const t = 1 - a * (0.253 + a * 0.12);
    x = p < t ? (p / t) ** (1 / a) : 1 - Math.log(1 - (p - t) / (1 - t));
  }
  for (let j = 0; j < 100; j++) {
    if (x <= 0) { x = 0; break; }
    const err = gammaP(a, x) - p;
    let t = a > 1 ? afac * Math.exp(-(x - a1) + a1 * (Math.log(x) - lna1)) : Math.exp(-x + a1 * Math.log(x) - gln);
    const u = err / t;
    t = u / (1 - 0.5 * Math.min(1, u * ((a - 1) / x - 1)));
    x -= t;
    if (x <= 0) x = 0.5 * (x + t);
    if (Math.abs(t) < 1e-12 * x) break;
  }
  if (!(Math.abs(gammaP(a, x) - p) <= 1e-12 * Math.max(p, 1e-300)) || !Number.isFinite(x)) {
    let hi = Math.max(1, a);
    while (gammaP(a, hi) < p) hi *= 2;
    x = bisect((v) => gammaP(a, v), p, 0, hi);
  }
  return x;
}

/**
 * Chi-square quantile: the x with P(χ²_df ≤ x) = p.
 * @param {number} p
 * @param {number} df
 * @returns {number}
 */
export function chi2Quantile(p, df) {
  return 2 * gammaPInv(df / 2, p);
}

/**
 * Chi-square survival function P(χ²_df ≥ x).
 * @param {number} x
 * @param {number} df
 * @returns {number}
 */
export function chi2Sf(x, df) {
  if (!(x > 0)) return 1;
  return gammaQ(df / 2, x / 2);
}

function betaContinuedFraction(a, b, x) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 10000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta I_x(a, b).
 * @param {number} a > 0
 * @param {number} b > 0
 * @param {number} x in [0, 1]
 * @returns {number}
 */
export function betaI(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betaContinuedFraction(a, b, x) / a : 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
}

/**
 * Inverse of I_·(a, b): the x with I_x(a, b) = p.
 * @param {number} a > 0
 * @param {number} b > 0
 * @param {number} p in [0, 1]
 * @returns {number}
 */
export function betaIInv(a, b, p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const a1 = a - 1, b1 = b - 1;
  let x, t, u;
  if (a >= 1 && b >= 1) {
    const pp = p < 0.5 ? p : 1 - p;
    t = Math.sqrt(-2 * Math.log(pp));
    x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) x = -x;
    const al = (x * x - 3) / 6;
    const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
    const w = (x * Math.sqrt(al + h) / h) - (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h));
    x = a / (a + b * Math.exp(2 * w));
  } else {
    const lna = Math.log(a / (a + b)), lnb = Math.log(b / (a + b));
    t = Math.exp(a * lna) / a;
    u = Math.exp(b * lnb) / b;
    const w = t + u;
    x = p < t / w ? (a * w * p) ** (1 / a) : 1 - (b * w * (1 - p)) ** (1 / b);
  }
  const afac = -lnGamma(a) - lnGamma(b) + lnGamma(a + b);
  for (let j = 0; j < 100; j++) {
    if (x <= 0 || x >= 1) break;
    const err = betaI(a, b, x) - p;
    t = Math.exp(a1 * Math.log(x) + b1 * Math.log(1 - x) + afac);
    u = err / t;
    t = u / (1 - 0.5 * Math.min(1, u * (a1 / x - b1 / (1 - x))));
    x -= t;
    if (x <= 0) x = 0.5 * (x + t);
    if (x >= 1) x = 0.5 * (x + t + 1);
    if (Math.abs(t) < 1e-12 * x && j > 0) break;
  }
  if (!(x > 0 && x < 1) || !(Math.abs(betaI(a, b, x) - p) <= 1e-12 * Math.max(p, 1e-300))) {
    x = bisect((v) => betaI(a, b, v), p, 0, 1);
  }
  return x;
}

/**
 * Standard normal quantile (Acklam's rational approximation, refined by one Halley step).
 * @param {number} p in (0, 1)
 * @returns {number}
 */
export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // one Halley refinement against the exact normal CDF (via the incomplete gamma)
  const cdf = x < 0 ? 0.5 * gammaQ(0.5, x * x / 2) : 1 - 0.5 * gammaQ(0.5, x * x / 2);
  const e = cdf - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/** z for a two-sided 95% interval. */
export const Z95 = normalQuantile(0.975);

// ── Intervals ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Exact (Garwood) confidence interval for a Poisson mean given an observed count.
 * @param {number} n observed count (integer ≥ 0)
 * @param {{level?: number}} [opts]
 * @returns {[number, number]}
 */
export function garwoodCI(n, { level = 0.95 } = {}) {
  const alpha = 1 - level;
  const lo = n === 0 ? 0 : chi2Quantile(alpha / 2, 2 * n) / 2;
  const hi = chi2Quantile(1 - alpha / 2, 2 * n + 2) / 2;
  return [lo, hi];
}

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} k successes
 * @param {number} n trials (> 0)
 * @param {{level?: number}} [opts]
 * @returns {[number, number]}
 */
export function wilsonCI(k, n, { level = 0.95 } = {}) {
  if (!(n > 0)) return [0, 1];
  const z = level === 0.95 ? Z95 : normalQuantile(1 - (1 - level) / 2);
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Clopper–Pearson (exact) interval for a binomial proportion.
 * @param {number} k
 * @param {number} n
 * @param {{level?: number}} [opts]
 * @returns {[number, number]}
 */
export function clopperPearsonCI(k, n, { level = 0.95 } = {}) {
  const alpha = 1 - level;
  if (!(n > 0)) return [0, 1];
  const lo = k === 0 ? 0 : betaIInv(k, n - k + 1, alpha / 2);
  const hi = k === n ? 1 : betaIInv(k + 1, n - k, 1 - alpha / 2);
  return [lo, hi];
}

/**
 * A Poisson rate with its exact 95% interval: n per `exposure`, scaled (1e6 for per million tokens).
 * @param {number} n
 * @param {number} exposure > 0
 * @param {number} [scale]
 * @returns {{rate: number, ci: [number, number]}}
 */
export function poissonRate(n, exposure, scale = 1e6) {
  const [lo, hi] = garwoodCI(n);
  return { rate: n / exposure * scale, ci: [lo / exposure * scale, hi / exposure * scale] };
}

/**
 * A proportion k of n works with its Wilson 95% interval, scaled (1e3 for per thousand works, 1 for a share).
 * @param {number} k
 * @param {number} n > 0
 * @param {number} [scale]
 * @returns {{rate: number, ci: [number, number]}}
 */
export function proportionRate(k, n, scale = 1e3) {
  const [lo, hi] = wilsonCI(k, n);
  return { rate: k / n * scale, ci: [lo * scale, hi * scale] };
}

/**
 * Ratio of two Poisson rates (B over A) with the exact conditional interval: given n_A + n_B, n_B is
 * binomial with p = λ_B·t_B / (λ_A·t_A + λ_B·t_B); a Clopper–Pearson interval on p maps to the ratio.
 * An infinite bound (n_A = 0) is reported as null with `unbounded: true`.
 * @param {number} nA
 * @param {number} tA exposure of A (> 0)
 * @param {number} nB
 * @param {number} tB exposure of B (> 0)
 * @returns {{value: number|null, ci: [number, number|null]|null, unbounded: boolean}}
 */
export function poissonRateRatio(nA, tA, nB, tB) {
  const total = nA + nB;
  if (total === 0) return { value: null, ci: null, unbounded: false };
  const [pLo, pHi] = clopperPearsonCI(nB, total);
  const scale = tA / tB;
  const toRatio = (p) => (p >= 1 ? null : p / (1 - p) * scale);
  return {
    value: nA === 0 ? null : (nB / tB) / (nA / tA),
    ci: [toRatio(pLo), toRatio(pHi)],
    unbounded: nA === 0,
  };
}

// ── Tests and corrections ────────────────────────────────────────────────────────────────────────────

/**
 * Dunning's log-likelihood ratio G² for a 2×2 table [[o11, o12], [o21, o22]].
 * @param {number} o11
 * @param {number} o12
 * @param {number} o21
 * @param {number} o22
 * @returns {number} ≥ 0
 */
export function g2(o11, o12, o21, o22) {
  const n = o11 + o12 + o21 + o22;
  if (!(n > 0)) return 0;
  const r1 = o11 + o12, r2 = o21 + o22, c1 = o11 + o21, c2 = o12 + o22;
  const term = (o, e) => (o > 0 && e > 0 ? o * Math.log(o / e) : 0);
  const v = 2 * (term(o11, r1 * c1 / n) + term(o12, r1 * c2 / n) + term(o21, r2 * c1 / n) + term(o22, r2 * c2 / n));
  return v > 0 ? v : 0;
}

/**
 * Benjamini–Hochberg adjusted p-values (q-values), in the input order.
 * @param {number[]} pvalues
 * @returns {number[]}
 */
export function benjaminiHochberg(pvalues) {
  const m = pvalues.length;
  const order = pvalues.map((_, i) => i).sort((i, j) => pvalues[i] - pvalues[j]);
  const q = new Array(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    const i = order[r];
    min = Math.min(min, pvalues[i] * m / (r + 1));
    q[i] = min;
  }
  return q;
}

/**
 * Gries' DP (deviation of proportions): 0.5 · Σ |observed share − expected share| over parts, where the
 * expected share of a part is its share of the slice's size (tokens, or 1 per work).
 * @param {Array<{n: number, size: number}>} parts
 * @returns {number|null} null when there is nothing to disperse
 */
export function griesDP(parts) {
  let n = 0, s = 0;
  for (const p of parts) { n += p.n; s += p.size; }
  if (!(n > 0) || !(s > 0)) return null;
  let d = 0;
  for (const p of parts) d += Math.abs(p.n / n - p.size / s);
  return d / 2;
}
