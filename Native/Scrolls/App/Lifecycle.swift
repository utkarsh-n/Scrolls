// OWNER: N0
// Scene phases and memory warnings (IOS-SPEC §3.7–§3.8, §4.21). Haptics play only while the app is active (LabKit's
// rule). Going to the background, a `beginBackgroundTask` covers the engine's suspension — the current chunk commits,
// then jobs stop and a PASSIVE checkpoint runs — so no lock or transaction is held across suspension, and an
// opportunistic maintenance window is requested. Becoming active resumes jobs and runs `inboxScan` when one is
// installed (none is yet: the drop folders, Import and the system Inbox, are listed when the Sources page opens or
// refreshes). A memory warning drops the engine's caches (`AtlasPlatform.trim()`).

import LabKitFeedback
import SwiftUI
import UIKit

@MainActor
final class Lifecycle {
  private let haptics: HapticEngine
  private let host: EngineHost
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var memoryObserver: NSObjectProtocol?

  /// Scans the drop folders, `Documents/Import/` then the system's `Documents/Inbox/`, for packs, atlases and import
  /// files (`AtlasPlatform.inbox()`). Nothing assigns it yet (IOS-SPEC §3.5 step 1, M2 with installing generations).
  var inboxScan: (@MainActor () async -> Void)?
  /// The last phase seen (Diagnostics and tests read it).
  private(set) var phase: ScenePhase?

  init(haptics: HapticEngine, host: EngineHost) {
    self.haptics = haptics
    self.host = host
    memoryObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.memoryWarning() }
    }
  }

  isolated deinit {
    if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
  }

  /// Called on every scene-phase change.
  func scenePhase(_ newPhase: ScenePhase) {
    LaunchTrail.note("scene", "\(newPhase)")
    guard newPhase != phase else { return }
    phase = newPhase
    switch newPhase {
    case .active:
      endBackgroundTask()
      haptics.start()
      Task {
        await host.resume()
        await inboxScan?()
      }
    case .inactive:
      haptics.stop()
    case .background:
      haptics.stop()
      suspendEngine()
      BackgroundTasks.scheduleMaintenance()
    @unknown default:
      haptics.stop()
    }
  }

  /// Drops the tile and memo LRUs and the chunk caches.
  func memoryWarning() {
    Task { await host.trim() }
  }

  /// Lets the engine finish its current chunk and stop (≤ 5 s) under a background-task assertion.
  private func suspendEngine() {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Scrolls: commit and pause jobs") { [weak self] in
      MainActor.assumeIsolated { self?.endBackgroundTask() }
    }
    Task {
      await host.suspend(within: .seconds(5))
      endBackgroundTask()
    }
  }

  private func endBackgroundTask() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }
}
