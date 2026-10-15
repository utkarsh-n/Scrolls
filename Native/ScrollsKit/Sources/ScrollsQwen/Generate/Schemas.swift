// OWNER: Q (created by the bring-up, B2)
// Output schemas and their validator (IOS-SPEC-QWEN §2.4, Q-08). The schema constrains decoding (XGrammar); the
// validator re-checks every field after decoding regardless, so a schema feature XGrammar ignores or rejects never
// lets anything through. `variants` lists the schema in decreasing strictness: the runtime uses the first one
// XGrammar compiles and records which (S5).

import Foundation

public struct LabelOutput: Codable, Sendable, Equatable {
  public var label: String
  public var gloss: String
  public var cites: [String]

  public init(label: String, gloss: String, cites: [String]) {
    self.label = label
    self.gloss = gloss
    self.cites = cites
  }
}

public enum LabelSchema {
  public enum Variant: String, Codable, Sendable, CaseIterable {
    /// `\p{Nd}` patterns, as the spec writes them.
    case unicodeDigitClass = "pattern \\p{Nd}"
    /// The decimal digits of the scripts Scrolls reads (Latin, Arabic-Indic, Extended Arabic-Indic, Devanagari,
    /// Gujarati) spelled out as ranges.
    case explicitDigitRanges = "pattern explicit ranges"
    /// No patterns: lengths, enums and required keys only; the validator alone bans digits.
    case noPatterns = "no patterns"
  }

  static let explicitDigits = "0-9\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u0AE6-\\u0AEF"

  /// The JSON Schema for one call, with the `cites` enum generated from the passage ids actually given.
  public static func json(ids: [String], variant: Variant = .unicodeDigitClass) -> String {
    let enumList = ids.map { "\"\($0)\"" }.joined(separator: ",")
    let (labelPattern, glossPattern): (String?, String?) = switch variant {
    case .unicodeDigitClass: (#"^[^\\p{Nd}\\s]+( [^\\p{Nd}\\s]+){0,4}$"#, #"^[^\\p{Nd}]*$"#)
    case .explicitDigitRanges: ("^[^\(explicitDigits)\\\\s]+( [^\(explicitDigits)\\\\s]+){0,4}$", "^[^\(explicitDigits)]*$")
    case .noPatterns: (nil, nil)
    }
    let lp = labelPattern.map { ",\"pattern\":\"\($0)\"" } ?? ""
    let gp = glossPattern.map { ",\"pattern\":\"\($0)\"" } ?? ""
    return """
    {"type":"object","additionalProperties":false,"required":["label","gloss","cites"],"properties":{\
    "label":{"type":"string","minLength":1,"maxLength":40\(lp)},\
    "gloss":{"type":"string","minLength":1,"maxLength":200\(gp)},\
    "cites":{"type":"array","minItems":2,"maxItems":4,"uniqueItems":true,"items":{"enum":[\(enumList)]}}}}
    """
  }

  /// The output cap (§2.4: ≥ 2 × the measured maximum of 77 tokens).
  public static let outputCap = 160
}

public enum TextChecks {
  /// Any Unicode decimal digit (general category Nd).
  public static func hasDigit(_ s: String) -> Bool {
    s.unicodeScalars.contains { $0.properties.generalCategory == .decimalNumber }
  }

  public static func words(_ s: String) -> [String] {
    s.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
  }
}

public struct LabelRejection: Error, Codable, Sendable, Equatable {
  public var reasons: [String]
}

public enum LabelValidator {
  /// Parses the model's raw bytes strictly: one JSON object with exactly label, gloss and cites.
  public static func validate(raw: String, ids: [String]) -> Result<LabelOutput, LabelRejection> {
    guard let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return .failure(LabelRejection(reasons: ["not a JSON object"]))
    }
    var reasons: [String] = []
    let keys = Set(obj.keys)
    if keys != ["label", "gloss", "cites"] { reasons.append("keys \(keys.sorted()) ≠ [cites, gloss, label]") }
    let label = (obj["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let gloss = (obj["gloss"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let cites = (obj["cites"] as? [Any])?.compactMap { $0 as? String } ?? []
    if label.isEmpty { reasons.append("label empty") }
    if label.count > 40 { reasons.append("label longer than 40 characters") }
    if TextChecks.words(label).count > 5 { reasons.append("label longer than 5 words") }
    if TextChecks.hasDigit(label) { reasons.append("label has a digit") }
    if gloss.isEmpty { reasons.append("gloss empty") }
    if gloss.count > 200 { reasons.append("gloss longer than 200 characters") }
    if TextChecks.hasDigit(gloss) { reasons.append("gloss has a digit") }
    if (obj["cites"] as? [Any])?.count != cites.count { reasons.append("cites holds a non-string") }
    if cites.count < 2 || cites.count > 4 { reasons.append("cites has \(cites.count) ids (needs 2–4)") }
    if Set(cites).count != cites.count { reasons.append("cites repeats an id") }
    let unknown = cites.filter { !ids.contains($0) }
    if !unknown.isEmpty { reasons.append("cites names passages that were not given: \(unknown.joined(separator: ", "))") }
    return reasons.isEmpty ? .success(LabelOutput(label: label, gloss: gloss, cites: cites)) : .failure(LabelRejection(reasons: reasons))
  }

  /// Canonical bytes of a validated label (sorted keys): the S5 round trip compares these.
  public static func canonical(_ o: LabelOutput) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? enc.encode(o)) ?? Data(), as: UTF8.self)
  }
}
