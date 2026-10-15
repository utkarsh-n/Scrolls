// OWNER: N0
// Every count names its denominator (IOS-SPEC §4.1 rule 6; SPEC §13 rule 2): "n = 37 in 1925–1945 · 6.1M tokens",
// never a bare 37. The line has no initialiser without a denominator argument; a count whose denominator was not
// counted says so in words. A rate appears only beside its count, its unit and its interval. The wording follows the
// reference's drawer and inspector lines (`drawer.mjs`, `inspector.mjs`), with `Format` byte-equal to format.mjs.

import ScrollsCore
import SwiftUI

/// The numbers of a denominator line.
nonisolated struct Denominator: Sendable, Equatable {
  /// Matches counted.
  let n: Int
  /// The time window ("1925–1945", "1910–1919"); nil for the whole view.
  let window: String?
  /// The denominator in `unit`; nil when it was not counted.
  let denominator: Double?
  /// The coverage unit: "tokens", "works", "entries".
  let unit: String
  /// Documents behind the count, when known.
  var documents: Int?
  /// The rate in `rateUnit` with its 95% interval: only for an observed, ungated bin.
  var rate: Double?
  var rateUnit: String?
  var ci: [Double?]?

  /// "n = 37 in 1925–1945 · 6.1M tokens · 12 documents · 367/M tokens [201, 616]".
  var text: String {
    var parts = [window.map { "n = \(Format.int(n)) in \($0)" } ?? "n = \(Format.int(n))"]
    parts.append(denominator.map { "\(Format.tokens($0)) \(unit)" } ?? DenominatorCopy.notCounted)
    if let documents { parts.append("\(Format.int(documents)) \(documents == 1 ? "document" : "documents")") }
    if let rate, let rateUnit { parts.append("\(Format.rate(rate, unit: rateUnit)) \(Format.ci(ci, unit: rateUnit))") }
    return parts.joined(separator: " · ")
  }
}

nonisolated enum DenominatorCopy {
  static let notCounted = "denominator not counted"
}

/// A denominator line in the count style (monospaced digits, secondary ink).
struct DenominatorLine: View {
  let denominator: Denominator

  init(_ denominator: Denominator) {
    self.denominator = denominator
  }

  /// "n = 37 in 1925–1945 · 6.1M tokens".
  init(n: Int, in window: String?, denominator: Double?, unit: String) {
    self.denominator = Denominator(n: n, window: window, denominator: denominator, unit: unit)
  }

  var body: some View {
    Text(denominator.text)
      .font(Typography.count)
      .foregroundStyle(Tokens.ink2.color)
      .fixedSize(horizontal: false, vertical: true)
  }
}
