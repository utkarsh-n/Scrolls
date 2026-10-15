// OWNER: N0
// "counting… 41%" (SPEC §8.8, IOS-SPEC §4.18): never a spinner without a number. The label states what is being
// done and, when the engine reports one, the fraction done. Without a fraction it shows its words only; it has no
// indeterminate spinner to fall back on.

import SwiftUI

nonisolated enum CountingCopy {
  static let counting = "counting…"
}

/// "<words> 41%", in the count style.
struct CountingLabel: View {
  let words: String
  let fraction: Double?

  init(_ words: String = CountingCopy.counting, fraction: Double?) {
    self.words = words
    self.fraction = fraction
  }

  /// The label's text (`renderLoadingLine`): the percentage is rounded, as the reference does.
  nonisolated static func text(_ words: String, fraction: Double?) -> String {
    guard let fraction, fraction.isFinite else { return words }
    let pct = Int((min(1, max(0, fraction)) * 100).rounded())
    return "\(words) \(pct)%"
  }

  var body: some View {
    Text(Self.text(words, fraction: fraction))
      .font(Typography.count)
      .foregroundStyle(Tokens.ink2.color)
      .contentTransition(.numericText())
      .accessibilityAddTraits(.updatesFrequently)
  }
}
