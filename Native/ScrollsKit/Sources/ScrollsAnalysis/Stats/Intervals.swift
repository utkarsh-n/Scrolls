// OWNER: N4
// Port of server/analysis/intervals.mjs (SPEC §4.6, §2.E; IOS-SPEC §2.4 exact float path): Garwood (exact Poisson) and
// Wilson intervals, the exact conditional rate ratio, Dunning's G², Benjamini–Hochberg and Gries' DP, with the
// distribution functions behind them (log-gamma, regularized incomplete gamma and beta and their inverses: Numerical
// Recipes 3rd ed. §6.1–6.4 with a bisection polish). f64 scalar loops in the reference's order of operations; no BLAS.

import Foundation

/// The reference's interval and test functions.
public enum Intervals {
  private static let lanczos: [Double] = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
                                          -176.61502916214059, 12.507343278686905, -0.13857109526572012,
                                          9.9843695780195716e-6, 1.5056327351493116e-7]
  private static let fpmin = 1e-300
  private static let eps = 1e-15

  /// ln Γ(x) for x > 0 (Lanczos, g = 7).
  public static func lnGamma(_ x: Double) -> Double {
    if x < 0.5 { return jsLog(Double.pi / abs(sin(Double.pi * x))) - lnGamma(1 - x) }
    let z = x - 1
    var a = lanczos[0]
    let t = z + 7.5
    for i in 1..<9 { a += lanczos[i] / (z + Double(i)) }
    return 0.5 * jsLog(2 * Double.pi) + (z + 0.5) * jsLog(t) - t + jsLog(a)
  }

  private static func gammaSeries(_ a: Double, _ x: Double) -> Double {
    var ap = a, sum = 1 / a, del = sum
    for _ in 0..<10000 {
      ap += 1
      del *= x / ap
      sum += del
      if abs(del) < abs(sum) * eps { break }
    }
    return sum * jsExp(-x + a * jsLog(x) - lnGamma(a))
  }

  private static func gammaContinuedFraction(_ a: Double, _ x: Double) -> Double {
    var b = x + 1 - a, c = 1 / fpmin, d = 1 / b, h = d
    for i in 1..<10000 {
      let an = -Double(i) * (Double(i) - a)
      b += 2
      d = an * d + b
      if abs(d) < fpmin { d = fpmin }
      c = b + an / c
      if abs(c) < fpmin { c = fpmin }
      d = 1 / d
      let del = d * c
      h *= del
      if abs(del - 1) < eps { break }
    }
    return jsExp(-x + a * jsLog(x) - lnGamma(a)) * h
  }

  /// Regularized lower incomplete gamma P(a, x).
  public static func gammaP(_ a: Double, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    if !x.isFinite { return 1 }
    return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x)
  }

  /// Regularized upper incomplete gamma Q(a, x), computed directly in the tail.
  public static func gammaQ(_ a: Double, _ x: Double) -> Double {
    if x <= 0 { return 1 }
    if !x.isFinite { return 0 }
    return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x)
  }

  /// Bisection on a monotone increasing f over [lo, hi] for f(x) = p.
  private static func bisect(_ f: (Double) -> Double, _ p: Double, _ lo0: Double, _ hi0: Double,
                             iterations: Int = 200) -> Double {
    var lo = lo0, hi = hi0
    for _ in 0..<iterations {
      let mid = 0.5 * (lo + hi)
      if f(mid) < p { lo = mid } else { hi = mid }
      if hi - lo <= 1e-14 * max(1, abs(mid)) { break }
    }
    return 0.5 * (lo + hi)
  }

  /// Inverse of P(a, ·).
  public static func gammaPInv(_ a: Double, _ p: Double) -> Double {
    if p <= 0 { return 0 }
    if p >= 1 { return .infinity }
    let a1 = a - 1, gln = lnGamma(a)
    var x: Double
    var lna1 = 0.0, afac = 0.0
    if a > 1 {
      lna1 = jsLog(a1)
      afac = jsExp(a1 * (lna1 - 1) - gln)
      let pp = p < 0.5 ? p : 1 - p
      let t = (-2 * jsLog(pp)).squareRoot()
      x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
      if p < 0.5 { x = -x }
      x = max(1e-3, jsPow(a * (1 - 1 / (9 * a) - x / (3 * a.squareRoot())), 3))
    } else {
      let t = 1 - a * (0.253 + a * 0.12)
      x = p < t ? jsPow(p / t, 1 / a) : 1 - jsLog(1 - (p - t) / (1 - t))
    }
    for _ in 0..<100 {
      if x <= 0 {
        x = 0
        break
      }
      let err = gammaP(a, x) - p
      var t = a > 1 ? afac * jsExp(-(x - a1) + a1 * (jsLog(x) - lna1)) : jsExp(-x + a1 * jsLog(x) - gln)
      let u = err / t
      t = u / (1 - 0.5 * min(1, u * ((a - 1) / x - 1)))
      x -= t
      if x <= 0 { x = 0.5 * (x + t) }
      if abs(t) < 1e-12 * x { break }
    }
    if !(abs(gammaP(a, x) - p) <= 1e-12 * max(p, 1e-300)) || !x.isFinite {
      var hi = max(1, a)
      while gammaP(a, hi) < p { hi *= 2 }
      x = bisect({ gammaP(a, $0) }, p, 0, hi)
    }
    return x
  }

  /// Chi-square quantile: the x with P(χ²_df ≤ x) = p.
  public static func chi2Quantile(_ p: Double, _ df: Double) -> Double { 2 * gammaPInv(df / 2, p) }

  /// Chi-square survival function P(χ²_df ≥ x).
  public static func chi2Sf(_ x: Double, _ df: Double) -> Double {
    if !(x > 0) { return 1 }
    return gammaQ(df / 2, x / 2)
  }

  private static func betaContinuedFraction(_ a: Double, _ b: Double, _ x: Double) -> Double {
    let qab = a + b, qap = a + 1, qam = a - 1
    var c = 1.0, d = 1 - qab * x / qap
    if abs(d) < fpmin { d = fpmin }
    d = 1 / d
    var h = d
    for mi in 1..<10000 {
      let m = Double(mi)
      let m2 = 2 * m
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2))
      d = 1 + aa * d
      if abs(d) < fpmin { d = fpmin }
      c = 1 + aa / c
      if abs(c) < fpmin { c = fpmin }
      d = 1 / d
      h *= d * c
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
      d = 1 + aa * d
      if abs(d) < fpmin { d = fpmin }
      c = 1 + aa / c
      if abs(c) < fpmin { c = fpmin }
      d = 1 / d
      let del = d * c
      h *= del
      if abs(del - 1) < eps { break }
    }
    return h
  }

  /// Regularized incomplete beta I_x(a, b).
  public static func betaI(_ a: Double, _ b: Double, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    let bt = jsExp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * jsLog(x) + b * jsLog(1 - x))
    return x < (a + 1) / (a + b + 2) ? bt * betaContinuedFraction(a, b, x) / a
      : 1 - bt * betaContinuedFraction(b, a, 1 - x) / b
  }

  /// Inverse of I_·(a, b).
  public static func betaIInv(_ a: Double, _ b: Double, _ p: Double) -> Double {
    if p <= 0 { return 0 }
    if p >= 1 { return 1 }
    let a1 = a - 1, b1 = b - 1
    var x: Double, t: Double, u: Double
    if a >= 1 && b >= 1 {
      let pp = p < 0.5 ? p : 1 - p
      t = (-2 * jsLog(pp)).squareRoot()
      x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
      if p < 0.5 { x = -x }
      let al = (x * x - 3) / 6
      let h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1))
      let w = (x * (al + h).squareRoot() / h) - (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h))
      x = a / (a + b * jsExp(2 * w))
    } else {
      let lna = jsLog(a / (a + b)), lnb = jsLog(b / (a + b))
      t = jsExp(a * lna) / a
      u = jsExp(b * lnb) / b
      let w = t + u
      x = p < t / w ? jsPow(a * w * p, 1 / a) : 1 - jsPow(b * w * (1 - p), 1 / b)
    }
    let afac = -lnGamma(a) - lnGamma(b) + lnGamma(a + b)
    for j in 0..<100 {
      if x <= 0 || x >= 1 { break }
      let err = betaI(a, b, x) - p
      t = jsExp(a1 * jsLog(x) + b1 * jsLog(1 - x) + afac)
      u = err / t
      t = u / (1 - 0.5 * min(1, u * (a1 / x - b1 / (1 - x))))
      x -= t
      if x <= 0 { x = 0.5 * (x + t) }
      if x >= 1 { x = 0.5 * (x + t + 1) }
      if abs(t) < 1e-12 * x && j > 0 { break }
    }
    if !(x > 0 && x < 1) || !(abs(betaI(a, b, x) - p) <= 1e-12 * max(p, 1e-300)) {
      x = bisect({ betaI(a, b, $0) }, p, 0, 1)
    }
    return x
  }

  /// Standard normal quantile (Acklam's rational approximation, refined by one Halley step).
  public static func normalQuantile(_ p: Double) -> Double {
    if p <= 0 { return -.infinity }
    if p >= 1 { return .infinity }
    let a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1,
             2.506628277459239]
    let b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
    let c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
             2.938163982698783]
    let d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
    let pl = 0.02425
    var x: Double
    if p < pl {
      let q = (-2 * jsLog(p)).squareRoot()
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    } else if p <= 1 - pl {
      let q = p - 0.5, r = q * q
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    } else {
      let q = (-2 * jsLog(1 - p)).squareRoot()
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    }
    let cdf = x < 0 ? 0.5 * gammaQ(0.5, x * x / 2) : 1 - 0.5 * gammaQ(0.5, x * x / 2)
    let e = cdf - p
    let u = e * (2 * Double.pi).squareRoot() * jsExp(x * x / 2)
    return x - u / (1 + x * u / 2)
  }

  /// z for a two-sided 95% interval.
  public static let z95 = normalQuantile(0.975)

  // ── Intervals ──

  /// Exact (Garwood) confidence interval for a Poisson mean given an observed count.
  public static func garwoodCI(_ n: Double, level: Double = 0.95) -> (Double, Double) {
    let alpha = 1 - level
    let lo = n == 0 ? 0 : chi2Quantile(alpha / 2, 2 * n) / 2
    let hi = chi2Quantile(1 - alpha / 2, 2 * n + 2) / 2
    return (lo, hi)
  }

  /// Wilson score interval for a binomial proportion.
  public static func wilsonCI(_ k: Double, _ n: Double, level: Double = 0.95) -> (Double, Double) {
    if !(n > 0) { return (0, 1) }
    let z = level == 0.95 ? z95 : normalQuantile(1 - (1 - level) / 2)
    let p = k / n, z2 = z * z
    let denom = 1 + z2 / n
    let center = (p + z2 / (2 * n)) / denom
    let half = z * (p * (1 - p) / n + z2 / (4 * n * n)).squareRoot() / denom
    return (jsMax(0, center - half), jsMin(1, center + half))
  }

  /// Clopper–Pearson (exact) interval for a binomial proportion.
  public static func clopperPearsonCI(_ k: Double, _ n: Double, level: Double = 0.95) -> (Double, Double) {
    let alpha = 1 - level
    if !(n > 0) { return (0, 1) }
    let lo = k == 0 ? 0 : betaIInv(k, n - k + 1, alpha / 2)
    let hi = k == n ? 1 : betaIInv(k + 1, n - k, 1 - alpha / 2)
    return (lo, hi)
  }

  /// A Poisson rate with its exact 95% interval, scaled.
  public static func poissonRate(_ n: Double, _ exposure: Double, scale: Double = 1e6) -> (rate: Double, ci: (Double, Double)) {
    let (lo, hi) = garwoodCI(n)
    return (n / exposure * scale, (lo / exposure * scale, hi / exposure * scale))
  }

  /// A proportion k of n with its Wilson 95% interval, scaled.
  public static func proportionRate(_ k: Double, _ n: Double, scale: Double = 1e3) -> (rate: Double, ci: (Double, Double)) {
    let (lo, hi) = wilsonCI(k, n)
    return (k / n * scale, (lo * scale, hi * scale))
  }

  /// The ratio of two Poisson rates (B over A) with the exact conditional interval.
  public struct RateRatio: Sendable, Equatable {
    /// nil when A has no occurrence.
    public var value: Double?
    /// nil when neither slice has an occurrence; an infinite upper bound is nil.
    public var ci: (Double?, Double?)?
    public var unbounded: Bool

    public static func == (x: RateRatio, y: RateRatio) -> Bool {
      x.value == y.value && x.unbounded == y.unbounded && x.ci?.0 == y.ci?.0 && x.ci?.1 == y.ci?.1
    }
  }

  public static func poissonRateRatio(_ nA: Double, _ tA: Double, _ nB: Double, _ tB: Double) -> RateRatio {
    let total = nA + nB
    if total == 0 { return RateRatio(value: nil, ci: nil, unbounded: false) }
    let (pLo, pHi) = clopperPearsonCI(nB, total)
    let scale = tA / tB
    func toRatio(_ p: Double) -> Double? { p >= 1 ? nil : p / (1 - p) * scale }
    return RateRatio(value: nA == 0 ? nil : (nB / tB) / (nA / tA), ci: (toRatio(pLo), toRatio(pHi)), unbounded: nA == 0)
  }

  // ── Tests and corrections ──

  /// Dunning's log-likelihood ratio G² for a 2×2 table.
  public static func g2(_ o11: Double, _ o12: Double, _ o21: Double, _ o22: Double) -> Double {
    let n = o11 + o12 + o21 + o22
    if !(n > 0) { return 0 }
    let r1 = o11 + o12, r2 = o21 + o22, c1 = o11 + o21, c2 = o12 + o22
    func term(_ o: Double, _ e: Double) -> Double { o > 0 && e > 0 ? o * jsLog(o / e) : 0 }
    let v = 2 * (term(o11, r1 * c1 / n) + term(o12, r1 * c2 / n) + term(o21, r2 * c1 / n) + term(o22, r2 * c2 / n))
    return v > 0 ? v : 0
  }

  /// Benjamini–Hochberg adjusted p-values (q-values), in the input order.
  public static func benjaminiHochberg(_ pvalues: [Double]) -> [Double] {
    let m = pvalues.count
    let order = Array(0..<m).jsSorted { pvalues[$0] - pvalues[$1] }
    var q = [Double](repeating: 0, count: m)
    var lowest = 1.0
    for r in stride(from: m - 1, through: 0, by: -1) {
      let i = order[r]
      lowest = jsMin(lowest, pvalues[i] * Double(m) / Double(r + 1))
      q[i] = lowest
    }
    return q
  }

  /// Gries' DP over parts {n, size}; nil when there is nothing to disperse.
  public static func griesDP(_ parts: [(n: Double, size: Double)]) -> Double? {
    var n = 0.0, s = 0.0
    for p in parts {
      n += p.n
      s += p.size
    }
    if !(n > 0) || !(s > 0) { return nil }
    var d = 0.0
    for p in parts { d += abs(p.n / n - p.size / s) }
    return d / 2
  }
}
