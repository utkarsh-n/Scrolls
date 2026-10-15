// OWNER: N2
// Port of `server/adapters/stemm/field-map.mjs`: source field labels → STEMM lanes of `field-taxonomy.json` (SPEC
// §10.3; the engine resource is a byte copy of the reference's data/field-taxonomy.json). One shared taxonomy for LoCC
// classes (Gutenberg), gutenberg-stemm fields, OpenAlex field ids and Wiktionary fields.

import Foundation
import ScrollsCore

public enum FieldMap {
  struct Taxonomy: Sendable {
    var locc: [(prefix: String, lane: String)]
    var computingSubjects: [String]
    var stemmFields: [String: String]
    var openalexFields: [String: String]
    var wiktionaryFields: [String: String]
  }

  static let taxonomy: Taxonomy = {
    guard let url = Bundle.module.url(forResource: "field-taxonomy", withExtension: "json"),
          let data = try? Data(contentsOf: url), let v = try? JSONValue.parse(data)
    else { preconditionFailure("ScrollsSources: Resources/field-taxonomy.json is missing from the bundle") }
    func map(_ k: String) -> [String: String] {
      var out: [String: String] = [:]
      for (key, value) in v[k]?.objectValue ?? [:] { if let s = value.stringValue { out[key] = s } }
      return out
    }
    return Taxonomy(
      locc: (v["locc"]?.arrayValue ?? []).compactMap { r in
        guard let p = r["prefix"]?.stringValue, let l = r["lane"]?.stringValue else { return nil }
        return (p, l)
      },
      computingSubjects: (v["computing_subjects"]?.arrayValue ?? []).compactMap(\.stringValue),
      stemmFields: map("stemm_fields"), openalexFields: map("openalex_fields"), wiktionaryFields: map("wiktionary_fields"))
  }()

  static let laneKeys = Set(Vocab.stemmLanes.map(\.key))

  /// The source of a field label.
  public enum Source: Sendable { case locc, stemm, openalex, wiktionary }

  /// `laneForField({source, value, subjects})`: the STEMM lane key, or nil when the label is not a STEMM field.
  public static func lane(source: Source, value: String?, subjects: [String] = []) -> String? {
    guard let value, !value.isEmpty else { return nil }
    let t = taxonomy
    var lane: String?
    switch source {
    case .locc:
      let v = asciiUppercased(JSString.trim(value))
      // the longest matching prefix; the first of equal length (the reference's stable sort)
      var rule: (prefix: String, lane: String)?
      for r in t.locc where JSString.hasPrefix(v, r.prefix) {
        if rule == nil || r.prefix.utf16.count > rule!.prefix.utf16.count { rule = r }
      }
      lane = rule?.lane
      if lane != nil, JSString.hasPrefix(v, "TK"),
         subjects.contains(where: { s in t.computingSubjects.contains { JSString.indexOf(JSString.toLowerCase(s), $0) >= 0 } }) {
        lane = "computing"
      }
    case .stemm: lane = t.stemmFields[value]
    case .openalex: lane = t.openalexFields[JSNumber.format(JSNumber.parse(value))]
    case .wiktionary: lane = t.wiktionaryFields[value]
    }
    guard let lane, laneKeys.contains(lane) else { return nil }
    return lane
  }

  private static let loccSplit = JSRegex(js: #"[;,]\s*"#)

  /// `laneForLocc(loccField, subjects)`: the first STEMM lane among several LoCC classes ("PR; QA"), or nil.
  public static func laneForLocc(_ loccField: String?, subjects: [String] = []) -> String? {
    for c in loccSplit.split(loccField ?? "") {
      let t = JSString.trim(c)
      guard let f = t.utf16.first, [0x51, 0x52, 0x54, 0x71, 0x72, 0x74].contains(f) else { continue }  // /^[QRT]/i
      if let lane = lane(source: .locc, value: c, subjects: subjects) { return lane }
    }
    return nil
  }
}

extension FieldMap {
  /// ASCII uppercase (`toUpperCase` of a LoCC class, which is ASCII).
  static func asciiUppercased(_ s: String) -> String {
    String(decoding: s.utf16.map { ($0 >= 0x61 && $0 <= 0x7A) ? $0 - 0x20 : $0 }, as: UTF16.self)
  }
}
