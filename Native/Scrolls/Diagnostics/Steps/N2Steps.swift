// OWNER: N2
// Package N2's device self-test steps (IOS-SPEC §2.7, §8.5 N2 acceptance): the device rows as commands. Every step builds
// in an isolated root of its own under Application Support/SelfTest (never his atlas or notebook, §6.6) from the starter
// and the Cipher packs bundled with this build; the engine half is `SourceSelfTest` (ScrollsService), which the Mac tests
// run too.
//   perf        phase A ≤ 60 s and A2 ≤ 90 s from the start, plus the SPEC §6.8 reconciliation counts of A and A2
//   background  phase B ≤ 20 min (and its counts); a kill mid-way and continued processing need a person: PENDING
//   generation  the starter rebuilt on this phone = the bundled one (G6, slot 0); the CLI-built swap is M2
//   packs       the STEMM pack (M2): PENDING
// On the simulator every timing is INFO (a proxy), never a device measurement; exact counts are judged anywhere.

import Foundation
import ScrollsService
import ScrollsStore

enum N2Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .perf: [SelfTestStep("N2 Cipher phases A and A2", run: phasesA)]
    case .background: [SelfTestStep("N2 Cipher phase B", run: phaseB)]
    case .generation: [SelfTestStep("N2 starter parity", run: starter)]
    case .packs:
      [SelfTestStep("N2 STEMM pack") { _ in
        [.pending("STEMM pack pushed and loaded ≤ 40 min", "M2 (package N2): the STEMM adapters and the pack install are not built yet"),
         .pending("transfer MB/s", "Tools/atlas.sh transfer-bench (M2); the integrator runs it with the phone on its cable")]
      }]
    default: []
    }
  }

  private static var onDevice: Bool {
    #if targetEnvironment(simulator)
      false
    #else
      true
    #endif
  }

  private static var bundled: URL? { Bundle.main.resourceURL?.appending(path: "Bundled", directoryHint: .isDirectory) }

  /// A fresh isolated root for one step.
  private static func root(_ name: String) throws -> URL {
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let stamp = SelfTestRunner.runName(.now)
    return support.appending(path: "SelfTest/\(name)-\(stamp)", directoryHint: .isDirectory)
  }

  private static func rows(_ checks: [SourceCheck]) -> [SelfTestRow] {
    checks.map { c in
      switch c.status {
      case .pass: .pass(c.name, c.detail)
      case .fail: .fail(c.name, c.detail)
      case .info: .info(c.name, c.detail)
      case .pending: .pending(c.name, c.detail)
      }
    }
  }

  /// The bundled starter and Cipher packs, or the row saying what is missing.
  private static func inputs(needText: Bool) -> (starter: URL, missing: SelfTestRow?) {
    let dir = bundled ?? URL(fileURLWithPath: "/nonexistent")
    let starter = dir.appending(path: "starter.atlas")
    var missing: [String] = []
    if !FileManager.default.fileExists(atPath: starter.path) { missing.append("starter.atlas") }
    if !FileManager.default.fileExists(atPath: dir.appending(path: "cipher-meta.scrollspack").path) { missing.append("cipher-meta.scrollspack") }
    if needText && !FileManager.default.fileExists(atPath: dir.appending(path: "cipher-text.scrollspack").path) {
      missing.append("cipher-text.scrollspack")
    }
    guard missing.isEmpty else {
      return (starter, .pending("bundled inputs", "not in this build: \(missing.joined(separator: ", ")) (Tools/packs.sh, then rebuild the app)"))
    }
    return (starter, nil)
  }

  private static func run(_ name: String, through phase: BootstrapCipher.Phase, needText: Bool) async -> [SelfTestRow] {
    let (starter, missing) = inputs(needText: needText)
    if let missing { return [missing] }
    do {
      let dir = try root(name)
      let judge = onDevice
      let checks = await Task.detached(priority: .userInitiated) {
        await SourceSelfTest.bootstrap(root: dir, starter: starter, through: phase, judgeTimings: judge)
      }.value
      try? FileManager.default.removeItem(at: dir)
      return rows(checks)
    } catch {
      return [.fail(name, "\(error)")]
    }
  }

  static func phasesA(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    await run("n2-phase-a", through: .a2, needText: false)
  }

  static func phaseB(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    var out = await run("n2-phase-b", through: .b, needText: true)
    out.append(.pending("phase B survives a kill", "needs a relaunch: kill the app during phase B, relaunch, and the job resumes from its committed chunks (Mac proxy: DifferentialTests 'phase B resumes')"))
    out.append(.pending("phase B under continued processing", "needs a person: Sources → Keep building when I leave Scrolls, then leave the app"))
    return out
  }

  static func starter(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let (starter, missing) = inputs(needText: false)
    if let missing { return [missing] }
    do {
      let dir = try root("n2-starter")
      let checks = await Task.detached(priority: .userInitiated) {
        await SourceSelfTest.starterParity(root: dir, bundled: starter)
      }.value
      try? FileManager.default.removeItem(at: dir)
      return rows(checks) + [.pending("a CLI-built generation swapped in", "M2 (package N2): generations, swap and rollback are not built yet")]
    } catch {
      return [.fail("starter parity", "\(error)")]
    }
  }
}

extension SelfTestCatalog {
  static var n2: (any SelfTestSteps.Type)? { N2Steps.self }
}
