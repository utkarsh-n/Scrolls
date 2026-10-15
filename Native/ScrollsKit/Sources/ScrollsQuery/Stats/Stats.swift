// OWNER: N3
// Port of server/aggregate/stats.mjs (SPEC §4.6): exact intervals and dispersion — Garwood (exact Poisson) for token
// rates, Wilson for work shares, Gries' DP over documents. Pure f64 functions in the reference's operation order
// (IOS-SPEC §2.4 exact float paths); `log` is V8's (JSMath), `exp`/`sin` are Darwin libm (DV-5: last-ulp tolerance).
// Compare (N4) reuses these.

import Foundation
import ScrollsCore

/// Exact intervals and dispersion.
public enum Stats {
  static let lnSqrt2Pi = 0.9189385332046728
  static let lanczos: [Double] = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
                                  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
                                  1.5056327351493116e-7]

  /// ln Γ(x) for x > 0 (Lanczos, g = 7).
  public static func logGamma(_ x: Double) -> Double {
    if x < 0.5 { return JSMath.log(Double.pi / sin(Double.pi * x)) - logGamma(1 - x) }
    let z = x - 1
    var a = lanczos[0]
    let t = z + 7.5
    for i in 1..<9 { a += lanczos[i] / (z + Double(i)) }
    return lnSqrt2Pi + (z + 0.5) * JSMath.log(t) - t + JSMath.log(a)
  }

  /// Regularized lower incomplete gamma P(a, x).
  public static func gammaP(_ a: Double, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    let lnPre = a * JSMath.log(x) - x - logGamma(a)
    if x < a + 1 {
      var sum = 1 / a, term = sum
      for n in 1..<10000 {
        term *= x / (a + Double(n))
        sum += term
        if abs(term) < abs(sum) * 1e-15 { break }
      }
      return min(1, sum * exp(lnPre))
    }
    let tiny = 1e-300
    var b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d
    for i in 1..<10000 {
      let an = -Double(i) * (Double(i) - a)
      b += 2
      d = an * d + b
      if abs(d) < tiny { d = tiny }
      c = b + an / c
      if abs(c) < tiny { c = tiny }
      d = 1 / d
      let delta = d * c
      h *= delta
      if abs(delta - 1) < 1e-15 { break }
    }
    return max(0, 1 - exp(lnPre) * h)
  }

  /// Standard normal quantile (Acklam).
  public static func normalQuantile(_ p: Double) -> Double {
    precondition(p > 0 && p < 1, "normalQuantile: p must be in (0, 1), got \(p)")
    let a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02,
             -3.066479806614716e+01, 2.506628277459239e+00]
    let b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01,
             -1.328068155288572e+01]
    let c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00,
             4.374664141464968e+00, 2.938163982698783e+00]
    let d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    let lo = 0.02425
    if p < lo {
      let q = sqrt(-2 * JSMath.log(p))
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
        / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    }
    if p > 1 - lo { return -normalQuantile(1 - p) }
    let q = p - 0.5, r = q * q
    let num = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    let den = (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    return num / den
  }

  /// Quantile of Gamma(shape a, scale 1) (Wilson–Hilferty start, safeguarded Newton).
  public static func gammaQuantile(_ p: Double, _ a: Double) -> Double {
    precondition(p > 0 && p < 1, "gammaQuantile: p must be in (0, 1), got \(p)")
    let z = normalQuantile(p)
    var x = a * pow(1 - 1 / (9 * a) + z / (3 * sqrt(a)), 3)
    if !(x > 0) { x = max(1e-8, a * 0.01) }
    var lo = 0.0, hi = max(1, x) * 4
    while gammaP(a, hi) < p { hi *= 2 }
    let lnGa = logGamma(a)
    for _ in 0..<200 {
      let f = gammaP(a, x) - p
      if abs(f) < 1e-13 { break }
      if f < 0 { lo = max(lo, x) } else { hi = min(hi, x) }
      let dens = exp((a - 1) * JSMath.log(x) - x - lnGa)
      var next = dens > 0 ? x - f / dens : Double.nan
      if !(next > lo && next < hi) { next = (lo + hi) / 2 }
      if abs(next - x) <= 1e-12 * max(1, x) {
        x = next
        break
      }
      x = next
    }
    return x
  }

  /// Exact (Garwood) two-sided Poisson interval for an observed count n.
  public static func garwoodCI(_ n: Int, level: Double = 0.95) -> (Double, Double) {
    precondition(n >= 0, "garwoodCI: n must be a non-negative integer, got \(n)")
    let alpha = 1 - level
    let lower = n == 0 ? 0 : gammaQuantile(alpha / 2, Double(n))
    let upper = gammaQuantile(1 - alpha / 2, Double(n + 1))
    return (lower, upper)
  }

  /// Wilson score interval for a proportion k / n.
  public static func wilsonCI(_ k: Double, _ n: Double, level: Double = 0.95) -> (Double, Double) {
    precondition(n > 0 && k >= 0 && k <= n, "wilsonCI: need 0 ≤ k ≤ n and n > 0 (k=\(k), n=\(n))")
    let z = normalQuantile(1 - (1 - level) / 2)
    let p = k / n, z2 = z * z
    let denom = 1 + z2 / n
    let center = (p + z2 / (2 * n)) / denom
    let half = (z * sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
    return (max(0, center - half), min(1, center + half))
  }

  /// Gries' DP over documents: 0.5 · Σ |v_i/V − s_i/S| (rest size folded in), rounded to 3 decimals; nil when V = 0 or S = 0.
  public static func griesDP(_ counts: [Double], _ sizes: [Double], restSize: Double = 0) -> Double? {
    precondition(counts.count == sizes.count, "griesDP: counts and sizes differ in length")
    var V = 0.0, S = restSize
    for i in counts.indices {
      V += counts[i]
      S += sizes[i]
    }
    if !(V > 0) || !(S > 0) { return nil }
    var sum = restSize / S
    for i in counts.indices { sum += abs(counts[i] / V - sizes[i] / S) }
    return JSNumber.round(0.5 * sum * 1000) / 1000
  }

  /// `Number(x.toPrecision(6))`, null for a non-finite value (rates.mjs round6).
  public static func round6(_ x: Double?) -> Double? {
    guard let x, x.isFinite else { return nil }
    return JSNumber.parse(JSNumber.toPrecision(x, 6))
  }
}
