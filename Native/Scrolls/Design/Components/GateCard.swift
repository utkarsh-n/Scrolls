// OWNER: N0
// The gate card (SPEC §2.E, §4.11, §13 rule 7; IOS-SPEC §4.10): why a measure is not shown. A gated measure has no
// value, so this card is built only from a `Gate` — the gate, what is needed, what the slice has and the computed
// suggestion — and it has no initialiser that accepts a number. Port of src/ui/panels/gate-card.mjs (words byte-equal;
// object keys are listed in code-unit order because a decoded JSON object keeps no insertion order). Opaque, never
// glass; no haptic when shown (§4.21: a refusal is information, not an error buzz).

import ScrollsContracts
import ScrollsCore
import SwiftUI

/// Copy of the gate card (`gate-card.mjs` GATE_WORDS and NO_WIDENING, byte-equal).
nonisolated enum GateCardCopy {
  static let defaultTitle = "Not estimated"
  static let needs = "Needs"
  static let has = "Has"
  static let suggestion = "Suggestion"
  static let gate = "Gate"
  static let apply = "Apply"
  static let noWidening = "No widening inside this corpus reaches the gate."
  static let gateWords: [String: String] = [
    "insufficient_occurrences": "too few occurrences",
    "insufficient_documents": "too few documents",
    "insufficient_authors": "too few authors",
    "insufficient_coverage": "too little coverage",
    "single_source": "one document dominates the slice",
    "unaligned": "the two spaces are not aligned",
    "slice_too_small": "a slice is too small",
    "composition_mismatch": "the slices differ too much in composition",
    "modality_mismatch": "the slices are different media",
    "sampling_design": "the sample design does not allow this comparison",
    "no_cluster_structure": "no stable context groups",
    "not_run": "not run",
  ]
  static let runStageWords: [String: String] = [
    "cluster": "a clustering run", "drift": "a drift run", "tokstream": "a token-stream run",
    "collocations": "a collocations run", "vectors": "a vector-space run", "tone": "a tone run", "layout": "a layout run",
  ]
}

/// The strings of a gate card, computed from the gate alone (`gateCardModel`).
nonisolated struct GateCardModel: Sendable, Equatable {
  let title: String
  let gate: String
  let gateWords: String
  let needed: String
  let have: String
  let suggestion: String
  /// True when the suggestion names slices that [Apply] can widen to.
  let applicable: Bool
  let note: String?

  init(gate: String, needed: JSONValue?, have: JSONValue?, suggestion: JSONValue?, note: String?,
       title: String = GateCardCopy.defaultTitle) {
    self.title = title
    self.gate = gate
    gateWords = GateCardCopy.gateWords[gate] ?? Self.humanKey(gate)
    self.needed = Self.describeNeeded(needed)
    self.have = Self.describeHave(have, needed: needed)
    let s = Self.describeSuggestion(suggestion)
    self.suggestion = s.text
    applicable = s.applicable
    self.note = note
  }

  /// 'tokens_per_slice' → 'tokens per slice'.
  static func humanKey(_ key: String) -> String {
    key.replacing("_", with: " ").trimmingCharacters(in: .whitespaces)
  }

  private static func isInteger(_ x: Double) -> Bool { x.isFinite && x.rounded(.towardZero) == x }

  /// A count or a measure in the house number style.
  private static func num(_ x: Double) -> String { isInteger(x) ? Format.count(x) : Format.number(x) }

  private static func sortedEntries(_ o: JSONObject) -> [(key: String, value: JSONValue)] {
    o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.compactMap { k in o[k].map { (k, $0) } }
  }

  /// Values in [0, 1] summing to 1: a mix of shares.
  private static func isShareMap(_ o: JSONObject) -> Bool {
    let values = o.values.compactMap(\.numberValue)
    guard !values.isEmpty, values.count == o.count, values.allSatisfy({ $0 >= 0 && $0 <= 1 }) else { return false }
    let sum = values.reduce(0, +)
    return sum > 0.98 && sum < 1.02
  }

  /// The unit a one-key `needed` implies for bare numbers in `have` ('tokens_per_slice' → 'tokens').
  static func impliedUnit(_ needed: JSONValue?) -> String {
    guard let o = needed?.objectValue, o.count == 1, let key = o.keys.first else { return "" }
    let stem = key.hasSuffix("_per_slice") ? String(key.dropLast("_per_slice".count)) : key
    return humanKey(stem)
  }

  /// {tokens_per_slice: 3000000} → '≥ 3,000,000 tokens per slice'; a string is returned as is.
  static func describeNeeded(_ needed: JSONValue?) -> String {
    guard let needed, !needed.isNull else { return "" }
    switch needed {
    case .string(let s): return s
    case .number(let x): return "≥ \(num(x))"
    case .object(let o):
      return sortedEntries(o).map { k, v in
        switch v {
        case .number(let x): return "≥ \(num(x)) \(humanKey(k))"
        case .string(let s): return k == "modality" ? s : "\(humanKey(k)): \(s)"
        case .null: return "\(humanKey(k)): none"
        default: return "\(humanKey(k)): \(describeNeeded(v))"
        }
      }.joined(separator: ", ")
    default: return CanonicalJSON.string(needed)
    }
  }

  private static func describeSide(_ v: JSONValue?, unit: String) -> String {
    guard let v, !v.isNull else { return "none" }
    switch v {
    case .number(let x): return unit.isEmpty ? num(x) : "\(num(x)) \(unit)"
    case .string(let s): return s
    case .object(let o):
      if isShareMap(o) { return sortedEntries(o).map { "\(humanKey($0.key)) \(Format.share($0.value.numberValue))" }.joined(separator: ", ") }
      return sortedEntries(o).map { k, x in
        if let n = x.numberValue { return "\(num(n)) \(humanKey(k))" }
        return "\(humanKey(k)): \(describeSide(x, unit: ""))"
      }.joined(separator: ", ")
    default: return CanonicalJSON.string(v)
    }
  }

  /// Slices a/b are named A and B: 'A 21,400 tokens · B 30,100 tokens'.
  static func describeHave(_ have: JSONValue?, needed: JSONValue?) -> String {
    let unit = impliedUnit(needed)
    guard let have, !have.isNull else { return "none" }
    guard let o = have.objectValue else { return describeSide(have, unit: unit) }
    let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    if !keys.isEmpty, keys.allSatisfy({ $0 == "a" || $0 == "b" }) {
      return keys.map { "\($0.uppercased()) \(describeSide(o[$0], unit: unit))" }.joined(separator: " · ")
    }
    return describeSide(have, unit: unit)
  }

  /// 'A 1840–1899 · B 1990–2026' from a suggestion's slices.
  private static func slicesText(_ s: JSONObject) -> String {
    func part(_ k: String) -> String? {
      guard let years = s[k]?.objectValue?["years"]?.arrayValue, years.count == 2,
            let lo = years[0].numberValue, let hi = years[1].numberValue else { return nil }
      return "\(k.uppercased()) \(DateLabels.yearRangeLabel(Int(lo), Int(hi)))"
    }
    return [part("a"), part("b")].compactMap { $0 }.joined(separator: " · ")
  }

  /// The stage of an analysis run a suggestion names (`runs.runRequestOf`), if any.
  static func runStage(_ suggestion: JSONValue?) -> String? {
    guard let s = suggestion?.objectValue else { return nil }
    if let stage = s["run"]?.objectValue?["stage"]?.stringValue { return stage }
    if let r = s["request"]?.objectValue, (r["method"]?.stringValue ?? "POST").uppercased() == "POST",
       r["path"]?.stringValue == "/api/analysis/runs", let stage = r["body"]?.objectValue?["stage"]?.stringValue {
      return stage
    }
    return nil
  }

  /// The suggestion line: its label, or the widened slices and what they would have; null → NO_WIDENING.
  static func describeSuggestion(_ suggestion: JSONValue?) -> (text: String, applicable: Bool) {
    guard let suggestion, !suggestion.isNull else { return (GateCardCopy.noWidening, false) }
    guard let o = suggestion.objectValue else {
      return (suggestion.stringValue ?? CanonicalJSON.string(suggestion), false)
    }
    let slices = slicesText(o)
    let would = o["would_have"] ?? o["have"]
    var parts: [String] = []
    if let label = o["label"]?.stringValue {
      parts.append(label)
      if !slices.isEmpty { parts.append("(\(slices))") }
    } else if !slices.isEmpty {
      parts.append("Widen to \(slices)")
    }
    if let would, !would.isNull { parts.append("would give \(describeHave(would, needed: nil))") }
    if parts.isEmpty, let stage = runStage(suggestion) {
      parts.append("Run \(GateCardCopy.runStageWords[stage] ?? "a \(humanKey(stage)) run") first")
    }
    return (parts.isEmpty ? "A wider slice" : parts.joined(separator: " "), !slices.isEmpty)
  }
}

/// An opaque card that says why a measure is not shown. Built from a `Gate` only: there is no way to hand it a value.
struct GateCard: View {
  private let model: GateCardModel
  private let suggestion: JSONValue?
  private let onApply: ((JSONValue) -> Void)?

  /// - Parameters:
  ///   - gate: the gate object of a gated measure.
  ///   - title: what was not estimated ("Rate ratio", "Context groups").
  ///   - note: the enclosing object's sentence about the gate (`note` or `reason`), shown under the rows.
  ///   - onApply: offered only when the suggestion names slices to widen to; receives the suggestion.
  init(_ gate: Gate, title: String = GateCardCopy.defaultTitle, note: String? = nil,
       onApply: ((JSONValue) -> Void)? = nil) {
    model = GateCardModel(gate: gate.code.rawValue, needed: gate.needed, have: gate.have, suggestion: gate.suggestion,
                          note: note, title: title)
    suggestion = gate.suggestion.isNull ? nil : gate.suggestion
    self.onApply = onApply
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(verbatim: "⊘").foregroundStyle(Tokens.ink2.color).accessibilityHidden(true)
        Text(model.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Text(model.gateWords).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
      }
      Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
        if !model.needed.isEmpty { row(GateCardCopy.needs, model.needed) }
        row(GateCardCopy.has, model.have)
        row(GateCardCopy.suggestion, model.suggestion)
        GridRow {
          Text(GateCardCopy.gate).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          Text(verbatim: model.gate).font(Typography.code).foregroundStyle(Tokens.ink3.color)
        }
      }
      if let note = model.note {
        Text(note).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      if model.applicable, let onApply, let suggestion {
        Button(suggestion.objectValue?["label"]?.stringValue ?? GateCardCopy.apply) { onApply(suggestion) }
          .buttonStyle(.bordered)
          .tint(Tokens.cyan.color)
          .frame(minHeight: Tokens.Geometry.minHit)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(model.title): \(model.gateWords)")
  }

  private func row(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      Text(value).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}
