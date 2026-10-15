// OWNER: N0
// The app's root model (IOS-SPEC §8.4.9). It owns the presentation coordinator, the jobs model, the haptic engine,
// the lifecycle and the engine host, and runs the launch sequence: fake device conditions (DEBUG) → open the engine
// (the live atlas on its root, or the contract fixtures under `-ui-testing` / `-engine fixtures`, or when the live
// engine cannot open — always labelled) → follow its events → ready → the requested self-test, if any. Nothing in
// the launch path touches the database on the main actor: the engine's methods run off it.

import LabKitFeedback
import Observation
import ScrollsCore
import ScrollsService
import SwiftUI

@MainActor @Observable
final class AppModel {
  /// Where the launch sequence is.
  enum Phase: Equatable {
    case launching
    case ready
    /// The device's SQLite or tokenizer differs from the build's: the atlas is refused, nothing changed (§1.4).
    case probeFailed(String)
    /// The boot check found missing originals (§4.18).
    case integrityFailed(String)
    /// The notebook is being replayed into a new generation; the banner says how far (§6.5).
    case replaying(String)
  }

  let launch: LaunchArgs
  let coordinator = PresentationCoordinator()
  let jobs = JobsModel()
  /// LabKit's haptic engine; N8's `HapticsMap` maps Scrolls' events (§4.21) onto it.
  let hapticEngine: HapticEngine
  let engineHost: EngineHost
  let lifecycle: Lifecycle
  let selfTests = SelfTestRunner()

  private(set) var phase: Phase = .launching
  /// Which engine answers, and why.
  private(set) var engine: EngineDescription = .opening
  private(set) var atlas: (any AtlasService)?
  private(set) var platform: (any AtlasPlatform)?

  /// The view state of the Scroll (SPEC §8.2 grammar v1); N8 restores it from `@SceneStorage("view")`.
  var viewState: ViewState
  /// Whether the last timeline query's provenance says synthetic material is drawn (N7/N8 set it).
  var querySynthetic = false
  /// A one-line banner under the chrome (tier and gap pills, toasts, the self-test notice).
  var banner: String?

  @ObservationIgnored private var started = false

  init(launch: LaunchArgs) {
    self.launch = launch
    let haptics = HapticEngine(persistenceKey: "Scrolls")
    let host = EngineHost()
    hapticEngine = haptics
    engineHost = host
    lifecycle = Lifecycle(haptics: haptics, host: host)
    viewState = ViewState.defaultState(launch.corpus ?? "demo")
  }

  /// The SYNTHETIC ribbon shows while any demo material is in scope (`ribbon.mjs` `ribbonVisible`).
  var syntheticInScope: Bool { viewState.corpus == "demo" || querySynthetic }

  /// The launch sequence; runs once.
  func start() async {
    guard !started else { return }
    started = true
    LaunchTrail.note("launch", launch.summary.joined(separator: " "))
    PerfLog.shared.recording = launch.perf || launch.selfTest != nil
    engineHost.applyFakeConditions(launch)
    let description = await PerfLog.shared.measure("engine-open") { await engineHost.open(launch) }
    engine = description
    LaunchTrail.note("engine", description.description)
    atlas = engineHost.atlas
    platform = engineHost.platform
    if let atlas {
      await jobs.attach(atlas, fixtures: description.kind == .fixtures)
    } else {
      jobs.noEngine()
    }
    if let refusal = engineHost.refusal {
      phase = refusal
    } else {
      phase = .ready
    }
    LaunchTrail.note("phase", "\(phase)")
    if let suite = launch.selfTest {
      await selfTests.run(suite, model: self)
    }
  }

  /// Records launch → first frame of the root screen, from the process start time.
  func noteFirstFrame() {
    PerfLog.event("first-frame")
    if let start = PerfLog.processStart() {
      PerfLog.shared.record("launch-to-first-frame", ms: Date.now.timeIntervalSince(start) * 1000)
    }
  }
}

nonisolated enum SelfTestCopy {
  static let bannerIsolated = "Self-test running in an isolated copy"
  static let bannerFixtures = "Self-test running on contract fixtures: nothing is written"
}

extension SelfTestRunner {
  /// "Self-test probe: PASS (run 20261010T061006Z)" once a run has finished.
  var summaryLine: String? {
    switch state {
    case .finished(let r): "Self-test \(r.suite): \(r.status.rawValue) (run \(r.run))"
    case .failedToWrite(let message): message
    default: nil
    }
  }
}

/// The persistent notice of a launched self-test (§6.6): where it runs while it runs, then its result. Tapping it
/// opens Diagnostics with the rows.
struct SelfTestBanner: View {
  let model: AppModel

  var body: some View {
    if model.launch.selfTest != nil {
      Button {
        model.coordinator.present(.diagnostics)
      } label: {
        Label(text, systemImage: "checklist")
          .font(Typography.chrome)
          .foregroundStyle(Tokens.ink.color)
          .multilineTextAlignment(.leading)
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .chromeGlass(in: Capsule(), interactive: true)
      }
      .buttonStyle(.plain)
      .frame(minHeight: Tokens.Geometry.minHit)
      .chromeTypeCap()
      .accessibilityIdentifier("selfTestBanner")
    }
  }

  private var text: String {
    if let done = model.selfTests.summaryLine { return done }
    return model.engine.kind == .fixtures ? SelfTestCopy.bannerFixtures : SelfTestCopy.bannerIsolated
  }
}
