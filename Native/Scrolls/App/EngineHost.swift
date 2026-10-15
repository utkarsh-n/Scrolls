// OWNER: N0
// Opens the engine the shell talks to (IOS-SPEC §1.2 rule 3, §6.6, §8.4.9). The app reaches the engine only through
// `AtlasService` and `AtlasPlatform`. Which engine answers is always stated:
// - `-ui-testing` or `-engine fixtures`: MockAtlas, the 65 contract fixtures, labelled as fixtures wherever shown;
// - otherwise the live atlas on its root (`-atlasRoot <name>` for self-tests, isolated from his notebook). While a
//   part of the live engine is not built yet (`NOT_IMPLEMENTED`), the shell runs on the fixtures and says why; any
//   other failure leaves no engine and shows the error — fixtures never stand in for a broken atlas.
// Device conditions reach the engine as a `ComputeThrottle` (thermal, Low Power Mode; the engine never imports
// LabKit), and `-fakeThermal` / `-fakeLowPower` install LabKit's override in DEBUG builds.

import Foundation
import LabKitCore
import ScrollsContracts
import ScrollsJobs
import ScrollsService
import ScrollsStore

/// Which engine answers, and why.
nonisolated struct EngineDescription: Sendable, Equatable, CustomStringConvertible {
  enum Kind: Sendable, Equatable {
    /// MockAtlas: canned contract responses.
    case fixtures
    /// The live atlas; `root` is the self-test root name, nil for his atlas.
    case live(root: String?)
    /// No engine could be opened.
    case unavailable(String)
  }

  var kind: Kind
  /// Why this engine (a fixture fallback names the part that is not built).
  var note: String?

  static let opening = EngineDescription(kind: .unavailable(EngineCopy.opening), note: nil)

  /// One line: which engine answers.
  var summary: String {
    switch kind {
    case .fixtures: EngineCopy.fixtures
    case .live(let root): root.map { "\(EngineCopy.live) · \(EngineCopy.isolatedRoot) \($0)" } ?? EngineCopy.live
    case .unavailable(let why): "\(EngineCopy.none): \(why)"
    }
  }

  /// The summary and why (Diagnostics, self-test results).
  var description: String { note.map { "\(summary) \($0)" } ?? summary }
}

nonisolated enum EngineCopy {
  static let opening = "opening"
  static let fixtures = "Contract fixtures (MockAtlas): canned responses, not your atlas."
  static let live = "Live atlas"
  static let isolatedRoot = "isolated self-test root"
  static let none = "No engine"
  static let uiTesting = "(-ui-testing)"
  static let forced = "(-engine fixtures)"
  static func notBuilt(_ message: String) -> String { "Why: \(message)" }
  static let probeInProcess = "engine probe run in process (no live atlas open)"
}

/// LabKit's device conditions as the engine's compute throttle (§3.7 table).
nonisolated final class DeviceConditionsBridge: DeviceConditionsSource {
  init() {}

  var current: ComputeThrottle { Self.throttle(DeviceConditions.current) }

  /// critical and serious win over Low Power Mode (fewer workers); Low Power wins over fair and nominal.
  static func throttle(_ c: DeviceConditions) -> ComputeThrottle {
    switch c.thermal {
    case .critical: return .critical
    case .serious: return .serious
    default: break
    }
    if c.lowPower { return .lowPower }
    return c.thermal == .fair ? .fair : .nominal
  }

  /// "fair · 4 workers" (Diagnostics).
  var summary: String {
    let t = current
    return "\(t) · \(t.workers) workers" + (t.allowsAutomaticStarts ? "" : " · no automatic starts")
  }
}

@MainActor
final class EngineHost {
  private(set) var atlas: (any AtlasService)?
  private(set) var platform: (any AtlasPlatform)?
  /// Set when the live atlas was refused at launch (probe mismatch, integrity failure).
  private(set) var refusal: AppModel.Phase?
  let conditions = DeviceConditionsBridge()

  init() {}

  /// Installs `-fakeThermal` / `-fakeLowPower` (DEBUG builds only, LabKit's rule).
  func applyFakeConditions(_ launch: LaunchArgs) {
    #if DEBUG
      guard launch.fakeThermal != nil || launch.fakeLowPower else { return }
      DeviceConditions.setOverride(DeviceConditions(
        thermal: ProcessInfo.ThermalState(level: launch.fakeThermal ?? 0), lowPower: launch.fakeLowPower))
    #endif
  }

  /// Opens the engine for this launch.
  func open(_ launch: LaunchArgs) async -> EngineDescription {
    switch launch.effectiveEngine {
    case .fixtures:
      useFixtures()
      return EngineDescription(kind: .fixtures, note: launch.uiTesting ? EngineCopy.uiTesting : EngineCopy.forced)
    case .live:
      do {
        let location = try launch.atlasRoot.map { try AtlasLocation.selfTest($0, cloneLive: $0 == "selftest") }
          ?? AtlasLocation.live()
        LaunchTrail.note("engine-open", "\(location.atlasPath) exists: \(FileManager.default.fileExists(atPath: location.atlasPath))")
        let live = try await LiveAtlas.open(location, conditions: conditions, launch: EngineLaunchOptions(launch))
        atlas = live
        platform = live
        return EngineDescription(kind: .live(root: launch.atlasRoot), note: nil)
      } catch let error as ScrollsError where error.code == .notImplemented {
        useFixtures()
        return EngineDescription(kind: .fixtures, note: EngineCopy.notBuilt(error.message))
      } catch let error as ScrollsError where error.code == .probeRefused {
        refusal = .probeFailed(error.message)
        return EngineDescription(kind: .unavailable(error.message), note: nil)
      } catch let error as ScrollsError where error.code == .integrityFailed {
        refusal = .integrityFailed(error.message)
        return EngineDescription(kind: .unavailable(error.message), note: nil)
      } catch {
        return EngineDescription(kind: .unavailable(String(describing: error)), note: nil)
      }
    }
  }

  private func useFixtures() {
    atlas = MockAtlas()
    platform = nil
  }

  // MARK: Platform operations

  /// The engine probe's checks as self-test rows. Through `AtlasPlatform.probe()` when a live atlas is open;
  /// otherwise the store's probe runs in process (it opens only an in-memory database and a temporary file).
  func probeRows() async -> [SelfTestRow] {
    let report: ProbeReport
    var rows: [SelfTestRow] = []
    if let platform {
      report = await platform.probe()
    } else {
      let samples = EngineLaunchOptions.bundledProbeSamples
      report = await Task.detached(priority: .userInitiated) { Probe.run(sampleTexts: samples, measureVM: true) }.value
      rows.append(.info("engine probe", EngineCopy.probeInProcess))
    }
    rows += report.checks.map(Self.row)
    rows.append(.info("sqlite", "\(report.sqliteVersion) · ICU \(report.icuVersion)"))
    let available = report.availableMemoryBytes > 0
      ? "available \(ByteCount.text(UInt64(report.availableMemoryBytes)))" : "available memory not reported here"
    rows.append(.info("memory", "\(available) · phys_footprint \(ByteCount.text(report.physFootprintBytes))"))
    return rows
  }

  /// The engine's steps of a non-probe suite, through `AtlasPlatform.runSelfTest`. Without a live atlas they cannot
  /// run, and the row says so (PENDING, never PASS).
  func engineSteps(_ suite: SelfTestSuite) async -> [SelfTestRow] {
    guard let platform else {
      return [.pending("engine steps", "no live atlas is open, so the engine's \(suite.rawValue) steps cannot run here")]
    }
    do {
      return try await platform.runSelfTest(suite.rawValue).map(Self.row)
    } catch {
      return [.fail("engine steps", ErrorCardModel(any: error).message)]
    }
  }

  /// A probe check as a self-test row: a warning is information (it never refuses the atlas), a skip stays a skip.
  static func row(_ check: ProbeCheck) -> SelfTestRow {
    switch check.status {
    case .pass: .pass(check.name, check.detail)
    case .fail: .fail(check.name, check.detail)
    case .warn: .info(check.name, "warning: \(check.detail)")
    case .skip: SelfTestRow(name: check.name, status: .skip, detail: check.detail)
    }
  }

  /// Commits the current chunk and pauses jobs (scene going to the background).
  func suspend(within limit: Duration) async {
    await platform?.suspendJobs(within: limit)
  }

  /// Resumes jobs paused by `suspend` (scene active again).
  func resume() async {
    await platform?.resumeJobs()
  }

  /// Drops the tile and memo LRUs and the chunk caches (memory warning).
  func trim() async {
    await platform?.trim()
  }
}

extension EngineLaunchOptions {
  /// The engine's view of this launch: the bundle's `Bundled/` folder (starter, Cipher packs) and `Probe/` folder (the
  /// probe's sample books, Native/Golden/probe-samples.mjs), no automatic bootstrap during UI tests or a self-test.
  init(_ launch: LaunchArgs) {
    self.init(perf: launch.perf, selfTest: launch.selfTest?.rawValue,
              bundledResources: Bundle.main.resourceURL?.appending(path: "Bundled", directoryHint: .isDirectory),
              probeSamples: Self.bundledProbeSamples,
              startBootstrap: !launch.uiTesting && launch.selfTest == nil && !launch.qwenDemo && !launch.qwenSelfTest)
  }

  /// The probe's three sample books in the app bundle (English, Hindi, Gujarati).
  nonisolated static var bundledProbeSamples: URL? {
    Bundle.main.resourceURL?.appending(path: "Probe", directoryHint: .isDirectory)
  }
}
