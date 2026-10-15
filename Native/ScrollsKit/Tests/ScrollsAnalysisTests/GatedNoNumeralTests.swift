// OWNER: N4
// SPEC §13 rule 7 (IOS-SPEC §4.10, §8.5 N4 tests): a gated measure carries no numeral. By type: `Gated<T>` decodes a
// failed gate into `.gated(Gate)`, which has no field that can hold an estimate, and encodes null where the numeral
// would be — even when the incoming JSON smuggled one in. By scan: every object of an engine payload whose `gate` is not
// 'ok' holds no number under an estimate key (the reference's `contracts.check` rule, widened to every estimate key the
// Compare payload uses).

import Foundation
@testable import ScrollsAnalysis
import ScrollsContracts
import ScrollsCore
import Testing

/// The scan of a payload for numerals inside gated objects.
enum GatedScan {
  /// Keys that hold an estimate when a gate passes; a gated object must not carry a number under any of them. (`dp` and
  /// `top_doc_share` describe the slice and stay, as the reference sends them; the UI shows no dispersion for a gated rate.)
  static let estimateKeys: Set<String> = [
    "value", "ci", "rate", "ratio", "rate_ratio", "mean", "sd", "median", "share", "jaccard", "percentile", "logDice", "ppmi", "log_ratio",
    "rho", "standardized", "verdict", "threshold_percentile",
  ]

  static func containsNumber(_ v: JSONValue) -> Bool {
    switch v {
    case .number: true
    case .array(let a): a.contains(where: containsNumber)
    case .object(let o): o.values.contains(where: containsNumber)
    default: false
    }
  }

  /// Paths of gated objects that carry a number under an estimate key.
  static func violations(_ v: JSONValue, path: String = "$") -> [String] {
    switch v {
    case .array(let a):
      return a.enumerated().flatMap { violations($0.element, path: "\(path)[\($0.offset)]") }
    case .object(let o):
      var out: [String] = []
      if let g = o["gate"]?.stringValue, g != "ok" {
        for k in o.keys where estimateKeys.contains(k) && containsNumber(o[k]!) { out.append("\(path).\(k) (gate \(g))") }
      }
      for (k, x) in o where !(o["gate"]?.stringValue.map { $0 != "ok" } ?? false) || !estimateKeys.contains(k) {
        out += violations(x, path: "\(path).\(k)")
      }
      return out
    default:
      return []
    }
  }
}

@Suite("Gated measures carry no numeral")
struct GatedNoNumeralTests {
  @Test("by type: a failed gate decodes to .gated and re-encodes null where the value was, even when JSON smuggled a number")
  func byType() throws {
    let smuggled: JSONValue = [
      "metric": "aligned_displacement", "gate": "insufficient_documents", "value": 0.66, "ci": [0.5, 0.8],
      "needed": ["documents_per_slice": 20], "have": ["a": 9, "b": 31], "suggestion": .null, "n": [120, 400], "docs": [9, 31],
    ]
    let m = try ScrollsJSON.decode(Measure.self, from: smuggled)
    guard case .gated(let gate) = m.result else {
      Issue.record("a failed gate decoded as a value")
      return
    }
    #expect(gate.code == .insufficientDocuments)
    let back = try ScrollsJSON.value(m)
    // the smuggled numerals are gone: absent (they were not null in the input) or null, never a number
    #expect((back["value"] ?? .null) == .null && (back["ci"] ?? .null) == .null, "re-encoded: \(CanonicalJSON.string(back))")
    #expect(GatedScan.violations(back).isEmpty)
    // the evidence counts stay: they describe the slice, not an estimate
    #expect(back["n"] == [120, 400])
  }

  @Test("by type: every gate code of vocab decodes to .gated with no numeral, 'ok' to a value")
  func everyCode() throws {
    for code in GateCode.all {
      let body: JSONValue = ["metric": "neighbor_overlap", "gate": .string(code.rawValue), "value": code == .ok ? 0.4 : .null,
                             "ci": .null, "needed": [:], "have": [:], "suggestion": .null]
      let m = try ScrollsJSON.decode(Measure.self, from: body)
      #expect(m.result.isOK == (code == .ok), "\(code)")
      #expect(GatedScan.violations(try ScrollsJSON.value(m)).isEmpty, "\(code)")
    }
  }

  @Test("by construction: Gates.gated writes value and ci as null and no estimate key")
  func gatedObjects() {
    let g = Gates.gated("insufficient_coverage", needed: ["tokens": 50000], have: ["tokens": 21400], note: "low coverage: n = 3 in 21.4k tokens")
    #expect(g["value"] == .null && g["ci"] == .null)
    #expect(GatedScan.violations(.object(g)).isEmpty)
  }

  @Test("the scan finds a numeral smuggled into a gated object")
  func scanFinds() {
    let bad: JSONValue = ["freq": ["a": ["gate": "insufficient_coverage", "rate": 12.5, "ci": .null]]]
    #expect(GatedScan.violations(bad) == ["$.freq.a.rate (gate insufficient_coverage)"])
  }

  @Test("every gated object of the reference's own Compare goldens carries no numeral")
  func goldens() throws {
    var bad: [String] = []
    for family in ["g3.compare", "g3.collocations"] where AnalysisGolden.available(family) {
      for c in try AnalysisGolden.load(family) { bad += GatedScan.violations(c["body"] ?? .null).map { "\(c["id"]?.stringValue ?? "?") \($0)" } }
    }
    #expect(bad.isEmpty, "\(bad.prefix(10))")
  }
}
