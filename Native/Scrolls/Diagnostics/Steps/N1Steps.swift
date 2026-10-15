// OWNER: N1 — stub written by N0
// Package N1's device self-test steps (IOS-SPEC §2.7, §8.5): one step per acceptance row that needs the phone, so the
// device rows are commands. Until N1 writes them, each suite it has rows in answers one PENDING row naming them (never
// PASS); the probe suite is N0's and gets nothing from here.

import Foundation

/// N1's steps, registered in `SelfTestCatalog.n1`.
enum N1Steps: SelfTestSteps {
  /// The suites with device rows of this package, and those rows in words (IOS-SPEC §8.5).
  static let pendingRows: [SelfTestSuite: String] = [
    .journey: "a CSV pushed to Documents/Import → wizard → summary → Open in timeline → Revert; the import replays from the journal",
    .perf: "a 50 MB CSV dry run ≤ 20 s",
  ]

  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    guard let rows = pendingRows[suite] else { return [] }
    return [SelfTestStep("N1 \(suite.rawValue)") { _ in
      [.pending("N1 \(suite.rawValue) steps", "not written yet (package N1; stub written by N0): \(rows)")]
    }]
  }
}

extension SelfTestCatalog {
  static var n1: (any SelfTestSteps.Type)? { N1Steps.self }
}
