// OWNER: N4
// Port of server/analysis/multiplicity.mjs (SPEC §2.E item 0, §4.9, compare_log): the notable threshold is the
// (100 − 5/k)th percentile after k comparisons of one expression in one session. A comparison is counted once per
// distinct request (same expressions, slices, filters, toggles and measures); reshuffling passages does not raise k.
// The log itself is read and written by LiveAtlas+Compare (session = the per-launch SessionID, ΔS-1).

import CryptoKit
import Foundation
import ScrollsCore

/// The repeated-comparison disclosure.
public enum Multiplicity {
  /// Percentile a measure must reach to be called notable after k comparisons: 100 − 5/k (k = 1 → 95).
  public static func notableThreshold(_ k: Int) -> Double {
    let kk = max(1, k)
    return 100 - 5 / Double(kk)
  }

  /// '95th', '97.5th', '99.3rd' (one decimal at most).
  public static func ordinal(_ x: Double) -> String {
    let s = JSNumber.format(JSRound.fixed(x, 1))
    let u = Array(s.utf8)
    let last = Int(u.last! - 0x30)
    let digits = u.filter { $0 != 0x2E }
    let lastTwo = Int(String(decoding: digits.suffix(2), as: UTF8.self)) ?? 0
    if !s.contains(".") && lastTwo >= 11 && lastTwo <= 13 { return "\(s)th" }
    return s + (last == 1 ? "st" : last == 2 ? "nd" : last == 3 ? "rd" : "th")
  }

  /// The multiplicity block of a Compare payload with its disclosure sentence.
  public static func block(k: Int, notableSoFar: Int = 0, label: String) -> JSONValue {
    let kk = max(1, k)
    let threshold = notableThreshold(kk)
    let expected = JSRound.fixed(Double(kk) * 0.05, 2)
    let text = kk == 1
      ? "Comparison #1 for '\(label)' in this session; the notable threshold is the 95th percentile."
      : "Comparison #\(kk) for '\(label)' in this session; \(notableSoFar) of \(kk) crossed the notable threshold; "
        + "with \(kk) comparisons, ~\(JSNumber.format(expected)) are expected by chance at the 95th percentile. "
        + "Notable threshold is adjusted to the \(ordinal(threshold)) percentile."
    return ["k": .number(Double(kk)), "notable_so_far": .number(Double(notableSoFar)),
            "threshold_percentile": .number(JSRound.fixed(threshold, 4)), "expected_by_chance": .number(expected),
            "text": .string(text)]
  }

  /// The key a comparison is logged under: its expressions, sorted.
  public static func expressionKey(_ exprIds: [Int]) -> String {
    "expr:" + Array(Set(exprIds)).sorted().map(String.init).joined(separator: "+")
  }

  /// Hash of what makes two comparisons the same comparison (the passage seed and lane facet do not).
  public static func comparisonHash(_ r: NormalizedCompareRequest) -> String {
    let body: JSONValue = [
      "expr": .array(r.expr.sorted().map { .number(Double($0)) }), "a": r.a.json, "b": r.b.json,
      "measures": .array(r.measures.map(JSONValue.string)), "toggles": r.toggles.json,
      "corpus": r.corpus.map(JSONValue.string) ?? .null, "override": r.override.map(JSONValue.string) ?? .null,
    ]
    let hex = SHA256.hash(data: Data(CanonicalJSON.string(body).utf8)).map { String(format: "%02x", $0) }.joined()
    return String(hex.prefix(32))
  }
}
