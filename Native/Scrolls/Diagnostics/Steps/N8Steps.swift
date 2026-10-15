// OWNER: N8
// Package N8's device self-test steps (IOS-SPEC §2.7, §8.5 N8): the device acceptance rows as commands.
// - first-minute: the first-minute script timed, untouched (no taps): the demo's first frame (≤ 1.0 s), coach ① at ≈ 2 s,
//   Your turn by 60 s, and when Switch to Cipher became available (phase A ≤ 60 s). The tour is armed for the run
//   whatever the stored dismissal says (`-selftest first-minute`), and nothing is written to his notebook.
// - journey: state restoration's round trip in process (the hash and the UI snapshot); the kill-and-relaunch itself and
//   the layouts at accessibility sizes need a relaunch or a person, so they stay PENDING here with the command that runs
//   them (StateRestorationTests and AccessibilityAuditTests on the simulator; the device walk-through at the milestone).
// On the simulator every timing is a proxy, never a device measurement; a row that cannot be judged is PENDING, never PASS.

import Foundation

enum N8Steps: SelfTestSteps {
  /// The budgets of the first minute (§4.17, §8.5 N8 acceptance).
  static let firstFrameBudgetMs = 1000.0
  static let coachOneTarget = 2.0
  static let coachOneTolerance = 1.0
  static let yourTurnBudget = 60.0
  static let phaseABudget = 60.0

  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .firstMinute: [SelfTestStep("N8 first minute", run: firstMinute)]
    case .journey: [SelfTestStep("N8 state restoration", run: restoration)]
    default: []
    }
  }

  private static var onSimulator: Bool {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }

  /// A timing row: PASS/FAIL against its budget on the device; INFO (a proxy) on the simulator.
  private static func timing(_ name: String, _ value: Double, budget: Double, unit: String, detail: String) -> SelfTestRow {
    let text = "\(String(format: "%.2f", value)) \(unit) (budget \(String(format: "%.2f", budget)) \(unit)) · \(detail)"
    if onSimulator { return .info(name, "simulator proxy, not a device measurement: \(text)") }
    return value <= budget ? .pass(name, text) : .fail(name, text)
  }

  // MARK: first-minute

  static func firstMinute(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let model = ctx.model
    let tour = model.experience.tour
    var rows: [SelfTestRow] = []
    if let s = PerfLog.shared.snapshot.signposts["launch-to-first-frame"] {
      rows.append(timing("first frame", s.maxMs, budget: firstFrameBudgetMs, unit: "ms", detail: "process start → the root screen's first frame"))
    } else {
      rows.append(.pending("first frame", "no launch-to-first-frame sample was recorded in this run"))
    }
    // The script runs untouched: wait for each stage as it comes (≤ 75 s in all).
    let deadline = Date.now.addingTimeInterval(75)
    var cipherOpenAt: Double?
    while Date.now < deadline, tour.shownAt[.yourTurn] == nil {
      if cipherOpenAt == nil, CoachWords.cipherOpenable(model.jobs.health?.cipher) { cipherOpenAt = TourModel.now() }
      try? await Task.sleep(for: .milliseconds(250))
    }
    if cipherOpenAt == nil, CoachWords.cipherOpenable(model.jobs.health?.cipher) { cipherOpenAt = TourModel.now() }
    guard let ready = tour.readyAt else {
      rows.append(.fail("first minute", "the tour never started: the engine was not ready within the run"))
      return rows
    }
    if let one = tour.shownAt[.first] {
      let after = one - ready
      let ok = abs(after - coachOneTarget) <= coachOneTolerance
      let text = "coach ① \(String(format: "%.2f", after)) s after the Scroll was ready (target \(coachOneTarget) s ± \(coachOneTolerance))"
      rows.append(onSimulator ? .info("coach ①", "simulator proxy: \(text)") : ok ? .pass("coach ①", text) : .fail("coach ①", text))
    } else {
      rows.append(.fail("coach ①", "coach ① was not shown (the demo is not on screen, or the tour did not arm)"))
    }
    for stage in [CoachStage.second, .third] {
      if let t = tour.shownAt[stage] {
        rows.append(.info("coach \(stage.rawValue)", "shown \(String(format: "%.1f", t - ready)) s after ready"))
      }
    }
    if let your = tour.shownAt[.yourTurn] {
      rows.append(timing("Your turn", your - ready, budget: yourTurnBudget, unit: "s", detail: "untouched script, from the Scroll ready"))
    } else {
      rows.append(.fail("Your turn", "Your turn did not appear within 75 s"))
    }
    if model.engine.kind == .fixtures {
      rows.append(.pending("Switch to Cipher", "the engine ran on contract fixtures (canned Cipher status), so phase A's time is not measured here"))
    } else if cipherOpenAt == nil, let c = model.jobs.health?.cipher, c.status == "absent" {
      // A build without the Cipher packs cannot run phase A: that is not a measurement of phase A.
      rows.append(.pending("Switch to Cipher", "phase A cannot run in this build: \(c.message ?? c.status) (the device run bundles the packs)"))
    } else if let open = cipherOpenAt {
      rows.append(timing("Switch to Cipher", open - ready, budget: phaseABudget, unit: "s", detail: "Cipher phase A done (titles, relations, etymology)"))
    } else {
      rows.append(.fail("Switch to Cipher", "Cipher's phase A did not finish within the run: \(CoachWords.cipherLine(model.jobs.health?.cipher))"))
    }
    return rows
  }

  // MARK: journey

  static func restoration(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let model = ctx.model
    let e = model.experience
    var rows: [SelfTestRow] = []
    let hash = model.viewState.hash
    let back = StateRestoration.viewState(from: hash)
    if let back, back.hash == hash {
      rows.append(.pass("view hash round trip", "the stored hash restores the same canonical state (\(hash.count) characters)"))
    } else {
      rows.append(.fail("view hash round trip", "the hash did not restore the same state"))
    }
    let snapshot = UIStateSnapshot(detent: model.coordinator.inspectorDetent, mode: e.mode, path: model.coordinator.path, tab: e.tab,
                                   readerOpen: e.readerOpen)
    if StateRestoration.decode(StateRestoration.encode(snapshot)) == snapshot {
      rows.append(.pass("UI state round trip", "detent \(snapshot.detent.rawValue), mode \(snapshot.mode.name), \(snapshot.path.count) pushed"))
    } else {
      rows.append(.fail("UI state round trip", "the UI snapshot did not survive encoding"))
    }
    rows.append(.pending("state restored after a kill",
                         "needs a relaunch: ScrollsUITests/StateRestorationTests (simulator); on the device, background → devicectl process terminate → relaunch, compare the hash"))
    rows.append(.pending("layouts at accessibility sizes", "AccessibilityAuditTests at accessibility sizes (simulator) and the device walk-through at the milestone"))
    return rows
  }
}

extension SelfTestCatalog {
  static var n8: (any SelfTestSteps.Type)? { N8Steps.self }
}
