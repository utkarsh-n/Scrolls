// OWNER: N4
// Port of server/analysis/keyness.mjs (SPEC §2.E item 4): keyness of context words between two slices — Hardie's log
// ratio with Dunning's G² and Benjamini–Hochberg q < .05. Context words, not meanings.

import Foundation

/// Keyness of context-window counts between two slices.
public enum Keyness {
  /// Minimum combined frequency for a term to be tested.
  public static let minF = 5.0
  /// FDR level.
  public static let qLevel = 0.05

  public struct Row: Sendable, Equatable {
    public var term: String
    public var fA: Double
    public var fB: Double
    public var logRatio: Double
    public var g2: Double
    public var p: Double
    public var q: Double
    /// "a" | "b"
    public var side: String
  }

  /// Rows with q < .05 sorted by |log ratio| (then G², then term), at most `limit`. Totals default to the counts' sums.
  public static func keyness(_ countsA: JSMap<Double>, _ countsB: JSMap<Double>, totalA: Double? = nil, totalB: Double? = nil,
                             minF: Double = minF, q qMax: Double = qLevel, limit: Int = 50) -> [Row] {
    func sum(_ m: JSMap<Double>) -> Double { m.values.reduce(0, +) }
    let ta = totalA ?? sum(countsA), tb = totalB ?? sum(countsB)
    if !(ta > 0) || !(tb > 0) { return [] }
    var terms = JSSet(countsA.keys)
    for k in countsB.keys { terms.insert(k) }
    var rows: [Row] = []
    for term in terms {
      let fa = countsA[term] ?? 0, fb = countsB[term] ?? 0
      if fa + fb < minF { continue }
      let g = Intervals.g2(fa, ta - fa, fb, tb - fb)
      let lr = jsLog2(((fb != 0 ? fb : 0.5) / tb) / ((fa != 0 ? fa : 0.5) / ta))
      rows.append(Row(term: term, fA: fa, fB: fb, logRatio: lr, g2: g, p: Intervals.chi2Sf(g, 1), q: 0, side: ""))
    }
    let qs = Intervals.benjaminiHochberg(rows.map(\.p))
    for i in rows.indices {
      rows[i].q = qs[i]
      rows[i].side = rows[i].logRatio > 0 ? "b" : "a"
    }
    let kept = rows.filter { $0.q < qMax && $0.logRatio != 0 }
      .jsSorted { x, y in
        let d = abs(y.logRatio) - abs(x.logRatio)
        if d != 0 { return d }
        let g = y.g2 - x.g2
        if g != 0 { return g }
        return jsLess(x.term, y.term) ? -1 : 1
      }
    return Array(kept.prefix(limit))
  }
}
