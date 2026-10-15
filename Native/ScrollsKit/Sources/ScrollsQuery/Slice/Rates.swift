// OWNER: N3
// Ports of server/aggregate/langgate.mjs (RF-1) and rates.mjs (SPEC §1.2, §4.6, §4.11).
//
// Language gate: a strand counts — and is divided by — the passages of its own languages plus the unidentified buckets of
// its script; an unidentified row of a document's own running text (text, abstract, apparatus) counts only in its
// document's text language (RF-1). Rates: a bin has exactly one state — observed · absent · low (rate suppressed) ·
// uncovered · pending; only observed and absent carry a rate and a CI (honesty rules 3, 7).

import ScrollsCore

/// RF-1's language rule.
public enum LangGate {
  /// Field classes of a document's own running text.
  public static let docTextClasses: Set<String> = ["text", "abstract", "apparatus"]

  /// `isUnidentified(lang)`: 'und', 'und-…', or none.
  public static func isUnidentified(_ lang: String?) -> Bool {
    guard let lang, !lang.isEmpty else { return true }
    return lang == "und" || JSString.hasPrefix(lang, "und-")
  }

  /// `langAdmits(langs, plang, fieldClass, docLang)`.
  public static func admits(_ langs: [String]?, plang: String, fieldClass: String, docLang: String?) -> Bool {
    guard let langs else { return true }
    if !langs.contains(plang) { return false }
    if !isUnidentified(plang) || !docTextClasses.contains(fieldClass) { return true }
    return isUnidentified(docLang) || (docLang.map { langs.contains($0) } ?? false)
  }
}

/// A cell's state, rate and 95% CI.
public struct RateCell: Sendable, Equatable {
  public var state: Int
  public var rate: Double?
  public var ciLo: Double?
  public var ciHi: Double?
}

/// Units, gates, rate cells and coverage step classes.
public enum Rates {
  /// Unit class of a passage field class.
  public static let unitClassOfField: [String: String] = ["text": "text", "describes": "text", "apparatus": "text",
                                                          "title": "titles", "abstract": "abstracts"]
  /// Rate unit of each unit class.
  public static let rateUnitOfClass: [String: String] = ["text": "per_million_tokens", "titles": "per_thousand_works",
                                                         "abstracts": "per_million_tokens"]
  /// The collection.unit a unit class's denominator is counted in.
  public static let denomUnitOfClass: [String: String] = ["text": "tokens", "titles": "works", "abstracts": "tokens"]

  /// `unitOf(unitClass)`.
  public static func unitOf(_ uc: String) -> String { rateUnitOfClass[uc] ?? "per_million_tokens" }

  /// One collection behind a lane (unit and its own gate).
  public struct GateInput: Sendable {
    public var unit: String
    public var coverageGate: Int?
    public init(unit: String, coverageGate: Int?) {
      self.unit = unit
      self.coverageGate = coverageGate
    }
  }

  /// `laneGate(unitClass, collections)`: the strictest gate among the lane's collections.
  public static func laneGate(_ unitClass: String, _ collections: [GateInput]) -> Int {
    let denomUnit = denomUnitOfClass[unitClass]
    let dflt = denomUnit == "works" ? Vocab.coverageGates["works"]! : Vocab.coverageGates["tokens"]!
    var gate: Int?
    for c in collections {
      let g = c.coverageGate != nil && c.unit == denomUnit ? c.coverageGate! : dflt
      gate = gate.map { max($0, g) } ?? g
    }
    return gate ?? dflt
  }

  /// `rateCell({n, denom, unit, gate, pending})`.
  public static func rateCell(n: Int, denom: Double, unit: String, gate: Int, pending: Bool = false) -> RateCell {
    let codes = Vocab.cellStateCodes
    func none(_ s: String) -> RateCell { RateCell(state: codes[s]!, rate: nil, ciLo: nil, ciHi: nil) }
    if !(denom > 0) { return none(n > 0 ? "low" : pending ? "pending" : "uncovered") }
    if denom < Double(gate) { return none("low") }
    if n == 0 && pending { return none("pending") }
    let scale = Vocab.rateUnits[unit].map { Double($0.scale) } ?? 1e6
    var lo: Double, hi: Double
    if unit == "per_million_tokens" || unit == "per_million_baseline" {
      (lo, hi) = Stats.garwoodCI(n)
      lo = (lo / denom) * scale
      hi = (hi / denom) * scale
    } else {
      (lo, hi) = Stats.wilsonCI(min(Double(n), denom), denom)
      lo *= scale
      hi *= scale
    }
    return RateCell(state: n >= 1 ? codes["observed"]! : codes["absent"]!, rate: Stats.round6((Double(n) / denom) * scale),
                    ciLo: Stats.round6(lo), ciHi: Stats.round6(hi))
  }

  /// `stepClass(amount, unit)`: 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000).
  public static func stepClass(_ amount: Double, _ unit: String) -> Int {
    if !(amount > 0) { return 0 }
    let steps = Vocab.coverageSteps[unit == "works" ? "works" : "tokens"]!
    for (i, s) in steps.enumerated() where amount < Double(s) { return i + 1 }
    return 4
  }
}
