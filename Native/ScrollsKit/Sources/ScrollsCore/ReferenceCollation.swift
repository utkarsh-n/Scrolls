// OWNER: N0
// The reference sorts labels, titles and shelves with `a.localeCompare(b, 'en')` (ICU root collation, tertiary
// strength). Foundation's locale-aware compare agrees on every unequal pair; where it reports a tie, ICU still orders
// tertiary differences ("fi" < "ﬁ"), which `.forcedOrdering` reproduces, but calls canonically equivalent strings
// ("é", "e\u{301}") equal, which `.forcedOrdering` would split. Parity is measured by golden g1.collation (DV-4); the
// fallback, if a mismatch ever appears, is an explicit collation table exported from Node.

import Foundation

/// `localeCompare(…, 'en')` for Swift strings.
public enum ReferenceCollation {
  private static let en = Locale(identifier: "en")

  /// The order of `a` and `b` as `a.localeCompare(b, 'en')` gives it.
  public static func compare(_ a: String, _ b: String) -> ComparisonResult {
    let r = a.compare(b, options: [], range: nil, locale: en)
    if r != .orderedSame || a == b { return r }  // String == is canonical equivalence: ICU's equal
    return a.compare(b, options: [.forcedOrdering], range: nil, locale: en)
  }

  /// `a` sorts before `b`.
  public static func less(_ a: String, _ b: String) -> Bool { compare(a, b) == .orderedAscending }
}
