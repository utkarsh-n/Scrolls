// OWNER: I — stub written by N0
// Package I's device self-test steps (IOS-SPEC §2.7, §8.5): one step per acceptance row that needs the phone, so the
// device rows are commands. Until I writes them, each suite it has rows in answers one PENDING row naming them (never
// PASS); the probe suite is N0's and gets nothing from here.

import Foundation

/// I's steps, registered in `SelfTestCatalog.integrator`.
enum ISteps: SelfTestSteps {
  /// The suites with device rows of this package, and those rows in words (IOS-SPEC §8.5).
  static let pendingRows: [SelfTestSuite: String] = [
    .journey: "the M1 journey end to end (JourneyTests on the device)",
  ]

  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    guard let rows = pendingRows[suite] else { return [] }
    return [SelfTestStep("I \(suite.rawValue)") { _ in
      [.pending("I \(suite.rawValue) steps", "not written yet (package I; stub written by N0): \(rows)")]
    }]
  }
}

extension SelfTestCatalog {
  static var integrator: (any SelfTestSteps.Type)? { ISteps.self }
}
