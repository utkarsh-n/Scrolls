// OWNER: N4
// Port of server/analysis/composition.mjs (SPEC §2.E item 1, §4.9): composition JSD between slices and directly
// standardized rates. A slice's composition is its mix of kind × passage language × collection, weighted by the rate
// denominator. JSD > 0.15 fires the composition caveat and the standardized rates; JSD > 0.4 suppresses aligned
// displacement (composition_mismatch). Sums run in the reference's key order (insertion order of the strata).

import Foundation

/// Composition divergence and standardization.
public enum Composition {
  /// JSD above which the composition caveat fires and standardized rates are shown.
  public static let caveatJSD = 0.15
  /// JSD above which aligned displacement is not reported.
  public static let mismatchJSD = 0.4
  /// Below this share of the pooled mix, or of either slice's matches, in the shared strata, no standardized rate.
  public static let standardizeMinCover = 0.5

  /// Normalizes non-negative weights to shares (empty or all-zero → empty), keeping the key order.
  public static func normalize(_ weights: JSMap<Double>) -> JSMap<Double> {
    var total = 0.0
    for (_, v) in weights where v > 0 { total += v }
    var out = JSMap<Double>(objectOrder: true)
    if !(total > 0) { return out }
    for (k, v) in weights where v > 0 { out[k] = v / total }
    return out
  }

  private static func plogp(_ p: Double) -> Double { p > 0 ? p * jsLog2(p) : 0 }

  /// Jensen–Shannon divergence (base 2, in [0, 1]); nil when either side is empty.
  public static func jsd(_ a: JSMap<Double>, _ b: JSMap<Double>) -> Double? {
    let p = normalize(a), q = normalize(b)
    var keys = JSSet(p.keys)
    for k in q.keys { keys.insert(k) }
    if p.isEmpty || q.isEmpty { return nil }
    var hm = 0.0, hp = 0.0, hq = 0.0
    for k in keys {
      let pk = p[k] ?? 0, qk = q[k] ?? 0
      hm -= plogp((pk + qk) / 2)
      hp -= plogp(pk)
      hq -= plogp(qk)
    }
    let v = hm - (hp + hq) / 2
    return jsMin(1, jsMax(0, v))
  }

  /// One stratum of a standardization: matches and denominator in A and in B.
  public struct Stratum: Sendable {
    public var a: (n: Double, denom: Double) = (0, 0)
    public var b: (n: Double, denom: Double) = (0, 0)
    public init() {}
  }

  /// Directly standardized rates.
  public struct Standardized: Sendable {
    public var a: Double
    public var b: Double
    public var strata: Int
    public var weightCovered: Double
    /// The shares of each slice's matches in the shared strata (nil for a slice without matches).
    public var matchesCoveredA: Double?
    public var matchesCoveredB: Double?
  }

  /// Each slice's stratum rates weighted by the pooled denominator shares, over the strata both slices cover.
  public static func standardizedRates(_ strata: JSMap<Stratum>, scale: Double = 1e6) -> Standardized? {
    var pooled = 0.0, covered = 0.0, ra = 0.0, rb = 0.0, nA = 0.0, nB = 0.0, sharedA = 0.0, sharedB = 0.0
    var used = 0
    for (_, s) in strata {
      pooled += s.a.denom + s.b.denom
      nA += s.a.n
      nB += s.b.n
    }
    if !(pooled > 0) { return nil }
    for (_, s) in strata {
      if !(s.a.denom > 0 && s.b.denom > 0) { continue }
      let w = (s.a.denom + s.b.denom) / pooled
      covered += w
      ra += w * s.a.n / s.a.denom
      rb += w * s.b.n / s.b.denom
      sharedA += s.a.n
      sharedB += s.b.n
      used += 1
    }
    if used == 0 { return nil }
    return Standardized(a: ra / covered * scale, b: rb / covered * scale, strata: used, weightCovered: covered,
                        matchesCoveredA: nA > 0 ? sharedA / nA : nil, matchesCoveredB: nB > 0 ? sharedB / nB : nil)
  }

  /// The largest share with its key (the first in key order on a tie).
  public static func topShare(_ shares: JSMap<Double>) -> (key: String, share: Double)? {
    var best: (key: String, share: Double)?
    for (k, s) in shares where best == nil || s > best!.share { best = (k, s) }
    return best
  }
}
