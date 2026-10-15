// OWNER: N4
// Port of server/analysis/gates.mjs (SPEC I4, §4.11, §13 rule 7): minimum-evidence gates and computed widening
// suggestions. A gate that fails yields {gate, needed, have, suggestion, value: null, ci: null} — never a numeral for the
// gated measure. A suggestion widens the failing slice in 10-year steps (away from the other slice first, never into it,
// never beyond the collections' dated coverage) until the gate passes and reports what the slice would have; when
// nothing passes the suggestion is null and the note says "no widening inside this corpus reaches the gate".

import Foundation
import ScrollsCore

/// Every threshold of §4.6, §4.8, §4.9, §4.10 in one place (gates.mjs THRESHOLDS).
public enum Thresholds {
  public enum Collocates {
    public static let occurrences = 20, fXY = 5, fY = 10
    public static let g2 = 10.83, q = 0.05
  }
  public enum Clustering {
    public static let occurrences = 60, documents = 5
    public static let silhouette = 0.10
  }
  public enum SenseShareJSD {
    public static let occurrences = 50, documents = 5, authors = 3
    public static let topDocShare = 0.5
  }
  public enum NeighborOverlap {
    public static let occurrences = 50, tokens = 3_000_000, documents = 10, authors = 5
  }
  public enum AlignedDisplacement {
    public static let occurrences = 100, documents = 20, authors = 5, tokens = 3_000_000, anchors = 3000
    public static let anchorCos = 0.5, compositionJSD = 0.4
  }
  public enum Tone {
    public static let paragraphs = 30
  }
}

/// Criteria a widening must meet (gates.mjs `meets`); nil members are not checked.
public struct WidenCriteria: Sendable {
  public var occurrences: Int?
  public var documents: Int?
  public var authors: Int?
  public var maxTopDocShare: Double?
  public var units: Int?
  public var tokensNoTr: Int?
  public var coverDocs: Int?
  public var coverAuthors: Int?
  public init(occurrences: Int? = nil, documents: Int? = nil, authors: Int? = nil, maxTopDocShare: Double? = nil,
              units: Int? = nil, tokensNoTr: Int? = nil, coverDocs: Int? = nil, coverAuthors: Int? = nil) {
    self.occurrences = occurrences
    self.documents = documents
    self.authors = authors
    self.maxTopDocShare = maxTopDocShare
    self.units = units
    self.tokensNoTr = tokensNoTr
    self.coverDocs = coverDocs
    self.coverAuthors = coverAuthors
  }
}

/// Gates, widening and the gate copy.
public enum Gates {
  /// The note shown when no widening reaches a gate (§4.11).
  public static let noWideningNote = "no widening inside this corpus reaches the gate"
  /// §4.11 copy for OpenAlex cross-cell comparisons.
  public static let samplingDesignNote = "OpenAlex is a top-cited sample per field × period; cells are not comparable as rates."
  /// §4.11 copy for tone without the adapter (the reference's wording).
  public static let toneAdapterMissing = "Tone needs the optional on-device adapter (not installed)"
  /// The years step of a widening.
  public static let widenStepYears = 10

  /// A gated measure: no value, no interval, what would have been needed (`gated(code, {...})`). `extra` keys are
  /// written first, so the gate's own keys win, as the spread in the reference does.
  public static func gated(_ code: String, needed: JSONValue, have: JSONValue, suggestion: JSONValue = .null,
                           note: JSONValue = .null, extra: JSONObject = [:]) -> JSONObject {
    precondition(code != "ok", "gated(): a passing gate is not a gate card")
    var o = extra
    o["gate"] = .string(code)
    o["value"] = .null
    o["ci"] = .null
    o["needed"] = needed
    o["have"] = have
    o["suggestion"] = suggestion
    o["note"] = note
    return o
  }

  /// Whether window statistics meet the criteria.
  public static func meets(_ s: WindowStats, _ c: WidenCriteria) -> Bool {
    if let v = c.occurrences, !(s.n >= v) { return false }
    if let v = c.documents, !(s.docs >= v) { return false }
    if let v = c.authors, !(s.authors >= v) { return false }
    if let v = c.maxTopDocShare, !(s.topDocShare != nil && s.topDocShare! <= v) { return false }
    if let v = c.units, !(s.units >= v) { return false }
    if let v = c.tokensNoTr, !(s.unitsNoTr >= v) { return false }
    if let v = c.coverDocs, !(s.coverDocs >= v) { return false }
    if let v = c.coverAuthors, !(s.coverAuthors >= v) { return false }
    return true
  }

  /// Widens a slice in 10-year steps until `crit` passes over the widening index; nil when nothing does.
  public static func widenSuggestion(_ index: WideningIndex?, years: (Int, Int), crit: WidenCriteria,
                                     other: (Int, Int)? = nil, step: Int = widenStepYears) -> (years: (Int, Int), stats: WindowStats)? {
    guard let index, let bounds = index.bounds else { return nil }
    let (lo, hi) = years
    var floor = min(bounds.0, lo), ceil = max(bounds.1, hi)
    var awayIsDown = true
    if let other {
      if other.0 > hi {
        ceil = min(ceil, other.0 - 1)
        awayIsDown = true
      } else if other.1 < lo {
        floor = max(floor, other.1 + 1)
        awayIsDown = false
      }
    }
    let authorsNeeded = crit.authors ?? 0, coverAuthorsNeeded = crit.coverAuthors ?? 0
    var seen: Set<[Int]> = [[lo, hi]]
    var k = 1
    while true {
      let d = k * step
      let down = (max(floor, lo - d), hi)
      let up = (lo, min(ceil, hi + d))
      let half = (k / 2) * step
      let both = (max(floor, lo - (d - half)), min(ceil, hi + half))
      var fresh = false
      for (L, H) in awayIsDown ? [down, up, both] : [up, down, both] {
        if !seen.insert([L, H]).inserted { continue }
        fresh = true
        let stats = index.windowStats(L, H, authorsNeeded: authorsNeeded, coverAuthorsNeeded: coverAuthorsNeeded)
        if meets(stats, crit) { return ((L, H), stats) }
      }
      if !fresh && lo - d <= floor && hi + d >= ceil { return nil }
      k += 1
    }
  }

  // ── Copy ──

  /// '1840–1899', '1911', '500 BCE–1 BCE'.
  public static func rangeLabel(_ years: (Int, Int)) -> String {
    years.0 == years.1 ? DateLabels.yearLabel(years.0) : "\(DateLabels.yearLabel(years.0))–\(DateLabels.yearLabel(years.1))"
  }

  /// A token count that never rounds up to a threshold it misses: 2,950,000 → '2.95M', 21,400 → '21.4k'.
  public static func tokensHave(_ n: Double) -> String {
    if !n.isFinite { return "—" }
    if n >= 1e6 { return JSNumber.format((n / 1e4).rounded(.down) / 100) + "M" }
    if n >= 1e3 { return JSNumber.format((n / 100).rounded(.down) / 10) + "k" }
    return JSNumber.format(n.rounded(.down))
  }

  /// The denominator in words: '18k tokens', '41 works'.
  public static func unitsLabel(_ units: Double, _ unit: String) -> String {
    unit == "tokens" ? "\(tokensHave(units)) tokens" : "\(Format.count(units)) works"
  }

  /// "low coverage: n = 3 in 18k tokens".
  public static func lowCoverageNote(_ n: Double, _ units: Double, _ unit: String) -> String {
    "low coverage: n = \(Format.count(n)) in \(unitsLabel(units, unit))"
  }

  /// "Too few occurrences (12; needs 20). Showing KWIC." and its one- and two-slice forms. A side passed as `.absent`
  /// was not given (single-slice endpoint); `.value(nil)` was given as null (passing).
  public enum Side { case absent, value(Double?) }

  public static func collocatesNote(a: Side, b: Side, needed: Int) -> String {
    func failing(_ s: Side) -> Bool { if case .value(let v?) = s { return v < Double(needed) } else { return false } }
    func val(_ s: Side) -> Double? { if case .value(let v) = s { return v } else { return nil } }
    func given(_ s: Side) -> Bool { if case .absent = s { return false } else { return true } }
    let fa = failing(a), fb = failing(b)
    if fa && fb { return "Too few occurrences (\(Format.count(val(a))) and \(Format.count(val(b))); needs \(needed)). Showing KWIC." }
    if fa && given(b) { return "Too few occurrences in A (\(Format.count(val(a))); needs \(needed)). Showing KWIC." }
    if fb && given(a) { return "Too few occurrences in B (\(Format.count(val(b))); needs \(needed)). Showing KWIC." }
    return "Too few occurrences (\(Format.count(fa ? val(a) : val(b))); needs \(needed)). Showing KWIC."
  }

  /// "Widen A to 1840–1899 (61 occurrences in 9 documents)".
  public static func widenLabel(_ which: String?, _ years: (Int, Int), _ what: String) -> String {
    "Widen \(which.map { "\($0.uppercased()) " } ?? "")to \(rangeLabel(years)) (\(what))"
  }
}
