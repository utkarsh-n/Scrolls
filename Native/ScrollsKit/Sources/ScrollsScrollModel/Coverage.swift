// OWNER: N7
// Ports of src/ui/timeline/coverage.mjs and seams.mjs (SPEC §1.7, §1.10, D15).
// Coverage: the grey 5-class STEP scale (0 · <10k · <100k · <1M · ≥1M tokens; works 0 · <10 · <100 · <1,000 · ≥1,000), a
// stated step scale and never a log axis, and the global coverage track summed per bin over the shown lanes, one row per
// collection unit so tokens and works never mix.
// Seams: where full text ends and the evidence continues as titles and abstracts, a permanent line across every lane
// with the caption "Full text ends 1928 →". It can be collapsed to a ruler tick, never hidden.

import ScrollsContracts
import ScrollsCore

/// Coverage classes and the coverage track (`coverage.mjs`).
public enum CoverageScale {
  /// `stepClass(amount, unit)`: 0 for nothing, then 1…4 by the unit's steps.
  public static func stepClass(_ amount: Double, unit: String = "tokens") -> Int {
    let steps = Vocab.coverageSteps[unit == "works" ? "works" : "tokens"] ?? []
    guard amount > 0 else { return 0 }
    for (i, s) in steps.enumerated() where amount < Double(s) { return i + 1 }
    return steps.count + 1
  }

  /// `coverageUnitOf(rateUnit)`: 'tokens' or 'works'.
  public static func unit(ofRateUnit rateUnit: String) -> String {
    Vocab.rateUnits[rateUnit]?.collectionUnit == "works" ? "works" : "tokens"
  }

  /// One cell of the global coverage track.
  public struct TrackCell: Sendable, Equatable {
    public var bin: Int64
    public var loDay: Int
    public var hiDay: Int
    public var amount: Double
    public var cls: Int
  }

  /// One row of the track: the cells of one collection unit.
  public struct TrackRow: Sendable, Equatable {
    public var unit: String
    public var cells: [TrackCell]
  }

  /// `coverageTrack(lanes)`: per bin and per collection unit, the summed coverage of the shown lanes and its step class.
  public static func track(_ lanes: [LaneModel]) -> [TrackRow] {
    var order: [String] = []
    var byUnit: [String: (order: [Int64], cells: [Int64: TrackCell])] = [:]
    for l in lanes {
      if byUnit[l.coverageUnit] == nil {
        byUnit[l.coverageUnit] = ([], [:])
        order.append(l.coverageUnit)
      }
      for c in l.coverage {
        let amount = l.coverageUnit == "works" ? c.works : c.tokens
        if var prev = byUnit[l.coverageUnit]!.cells[c.bin] {
          prev.amount += amount
          byUnit[l.coverageUnit]!.cells[c.bin] = prev
        } else {
          byUnit[l.coverageUnit]!.cells[c.bin] = TrackCell(bin: c.bin, loDay: c.loDay, hiDay: c.hiDay, amount: amount, cls: 0)
          byUnit[l.coverageUnit]!.order.append(c.bin)
        }
      }
    }
    return order.map { unit in
      let m = byUnit[unit]!
      let cells = stableSorted(m.order.map { m.cells[$0]! }) { $0.bin < $1.bin }.map { c -> TrackCell in
        var c = c
        c.cls = stepClass(c.amount, unit: unit)
        return c
      }
      return TrackRow(unit: unit, cells: cells)
    }
  }
}

/// The modality seam (`seams.mjs`).
public enum Seams {
  /// `seamDay(seam)`: the first day of the seam year (the line sits at `last_covered_year + 1`).
  public static func day(_ seam: Seam) -> Int { DayMath.dayFromYMD(seam.year, 1, 1) }

  /// `shortSeamLabel(seam)`: "Full text ends 1928 →", the ruler form of the caption (`/^([^→]+→)/`).
  public static func shortLabel(_ seam: Seam) -> String {
    if let arrow = seam.label.firstIndex(of: "→"), arrow != seam.label.startIndex {
      return String(seam.label[...arrow]).trimmingJSWhitespace()
    }
    return "seam \(seam.year)"
  }

  /// `drawableSeams(seams)`: every seam with a year (they are never removable, only collapsible).
  public static func drawable(_ seams: [Seam]) -> [Seam] { seams }

  /// Where a seam caption goes in the visible part [vis.x0, vis.x1] of the content (`seamCaptionPlace`): right of its
  /// line when it fits, else left of it (right-aligned).
  public static func captionPlace(seamX: Double, width w: Double, visible: (x0: Double, x1: Double)?) -> (x: Double, alignEnd: Bool, x0: Double, x1: Double) {
    let right = visible.map { seamX + 4 + w <= $0.x1 - 4 || seamX - 4 - w < $0.x0 + 4 } ?? true
    return right ? (seamX + 4, false, seamX + 4, seamX + 4 + w) : (seamX - 4, true, seamX - 4 - w, seamX - 4)
  }
}

extension String {
  /// `String.prototype.trim()`: strips JavaScript white space and line terminators from both ends.
  func trimmingJSWhitespace() -> String {
    let ws: Set<Unicode.Scalar> = [" ", "\t", "\n", "\r", "\u{0B}", "\u{0C}", "\u{A0}", "\u{FEFF}", "\u{1680}", "\u{2028}", "\u{2029}",
                                   "\u{202F}", "\u{205F}", "\u{3000}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}",
                                   "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}"]
    var scalars = Substring(self).unicodeScalars
    while let f = scalars.first, ws.contains(f) { scalars.removeFirst() }
    while let l = scalars.last, ws.contains(l) { scalars.removeLast() }
    return String(String.UnicodeScalarView(scalars))
  }
}
