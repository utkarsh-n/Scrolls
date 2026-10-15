// OWNER: N0
// Background time (IOS-SPEC §3.7, N-14). Long work the user starts runs under `BGContinuedProcessingTask`
// (com.utkarsh.scrolls.job.<jobID>, strategy .queue), submitted only from a foreground action, with the task's
// progress bound to the job's so iOS never sees it stall. `BGProcessingTask` (com.utkarsh.scrolls.maintenance, on
// external power) is opportunistic only: nothing relies on it, heavy analysis never starts in it, and every grant is
// appended to Documents/Diagnostics/bgtasks.jsonl {identifier, granted_at, duration, outcome} so M2–M4 can record
// how often iOS actually grants it.
//
// The engine side is installed by whoever owns it: `maintenance` (what a maintenance grant runs) and `jobProgress`
// / `cancelJob` (the continued-processing binding). Until they are installed a grant does nothing and says so in
// the log.

import BackgroundTasks
import ScrollsStore
import UIKit

/// The state of a job that a continued-processing task follows.
nonisolated enum ContinuedJobState: Sendable, Equatable {
  /// Running: fraction done in [0, 1] and the subtitle to show ("312 of 1,516").
  case running(fraction: Double, subtitle: String)
  case finished(success: Bool)
}

/// One background grant, as logged.
nonisolated struct BackgroundGrant: Codable, Sendable {
  let identifier: String
  let grantedAt: String
  let duration: Double
  let outcome: String

  enum CodingKeys: String, CodingKey {
    case identifier, grantedAt = "granted_at", duration, outcome
  }
}

enum BackgroundTasks {
  static let maintenanceIdentifier = "com.utkarsh.scrolls.maintenance"
  /// The permitted wildcard for continued-processing jobs.
  static let jobIdentifierPattern = "com.utkarsh.scrolls.job.*"

  /// The continued-processing identifier of a job.
  static func jobIdentifier(_ job: JobID) -> String { "com.utkarsh.scrolls.job.\(job.rawValue)" }

  /// True once the maintenance handler was registered at launch (the probe checks it).
  private(set) static var maintenanceRegistered = false

  /// What a maintenance grant runs (incremental FTS merges, quick_check, gc-runs, …); returns the outcome in words.
  /// Installed by the engine host; nil = nothing to do in this build.
  static var maintenance: (@MainActor () async -> String)?
  /// Called when iOS expires a maintenance grant: stop at the next checkpoint.
  static var maintenanceExpired: (@MainActor () -> Void)?
  /// The state of a job a continued-processing task follows; nil = the job is unknown.
  static var jobProgress: (@MainActor (JobID) -> ContinuedJobState?)?
  /// Cancels a job at its next checkpoint (continued-processing expiry; the job becomes interrupted and re-queues).
  static var cancelJob: (@MainActor (JobID) -> Void)?

  static var log: URL { DiagnosticsFiles.diagnostics.appending(path: "bgtasks.jsonl") }

  // MARK: Maintenance

  /// Registers the maintenance handler. Must run before the app finishes launching (`ScrollsApp.init`).
  static func registerMaintenance() {
    guard !maintenanceRegistered else { return }
    maintenanceRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: maintenanceIdentifier, using: .main) { task in
      MainActor.assumeIsolated { runMaintenance(task) }
    }
  }

  /// Asks for an opportunistic maintenance window on external power. Never relied upon.
  static func scheduleMaintenance() {
    let request = BGProcessingTaskRequest(identifier: maintenanceIdentifier)
    request.requiresExternalPower = true
    request.requiresNetworkConnectivity = false
    Task {
      do {
        try await BGTaskScheduler.shared.submitTaskRequest(request)
      } catch {
        record(BackgroundGrant(identifier: maintenanceIdentifier, grantedAt: Date.now.ISO8601Format(), duration: 0,
                               outcome: "not scheduled: \(error.localizedDescription)"))
      }
    }
  }

  private static func runMaintenance(_ task: BGTask) {
    let started = Date.now
    let box = GrantedTask(task)
    let work = Task { @MainActor in
      let outcome = await (maintenance?() ?? "nothing to do: no maintenance installed in this build")
      finish(box, started: started, outcome: outcome, success: true)
    }
    // iOS does not say on which queue it calls the expiration handler, so it hops to the main actor itself.
    task.expirationHandler = { @Sendable in
      Task { @MainActor in
        maintenanceExpired?()
        work.cancel()
        finish(box, started: started, outcome: "expired by iOS", success: false)
      }
    }
  }

  // MARK: Continued processing

  /// Submits a continued-processing task for a job the user started in the foreground (Load, Build, Rebuild, or
  /// *Keep building when I leave Scrolls*). Its progress follows `jobProgress`; on expiry the job is cancelled at
  /// its next checkpoint, keeps its committed chunks, and re-queues when the app is active. Throws when iOS refuses
  /// the request (iOS 27 reports every refusal asynchronously, so this is `async`).
  static func submitContinued(job: JobID, title: String, subtitle: String) async throws {
    let identifier = jobIdentifier(job)
    _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
      MainActor.assumeIsolated {
        guard let task = task as? BGContinuedProcessingTask else {
          task.setTaskCompleted(success: false)
          return
        }
        follow(task, job: job)
      }
    }
    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
    request.strategy = .queue
    try await BGTaskScheduler.shared.submitTaskRequest(request)
  }

  /// Binds the task's progress to the job's until it finishes; the stall rule (§3.7) keeps the job's own progress
  /// moving at least every 2 s, so a quarter-second poll always has something to report.
  private static func follow(_ task: BGContinuedProcessingTask, job: JobID) {
    let started = Date.now
    let box = GrantedTask(task)
    task.progress.totalUnitCount = 1_000
    let poll = Task { @MainActor in
      guard let task = box.task as? BGContinuedProcessingTask else { return }
      while !Task.isCancelled {
        switch jobProgress?(job) {
        case .running(let fraction, let subtitle):
          task.progress.completedUnitCount = Int64((min(1, max(0, fraction)) * 1_000).rounded())
          task.updateTitle(task.title, subtitle: subtitle)
        case .finished(let success):
          task.progress.completedUnitCount = task.progress.totalUnitCount
          finish(box, started: started, outcome: success ? "job finished" : "job failed", success: success)
          return
        case nil:
          finish(box, started: started, outcome: "job unknown to this build", success: false)
          return
        }
        try? await Task.sleep(for: .milliseconds(250))
      }
    }
    task.expirationHandler = { @Sendable in
      Task { @MainActor in
        poll.cancel()
        cancelJob?(job)
        finish(box, started: started, outcome: "expired by iOS: job cancelled at its next checkpoint", success: false)
      }
    }
  }

  // MARK: Log

  /// Completes a grant once (a finished job and an expiry can race) and logs it.
  private static func finish(_ box: GrantedTask, started: Date, outcome: String, success: Bool) {
    guard !box.completed else { return }
    box.completed = true
    box.task.setTaskCompleted(success: success)
    record(BackgroundGrant(identifier: box.task.identifier, grantedAt: started.ISO8601Format(),
                           duration: Date.now.timeIntervalSince(started), outcome: outcome))
  }

  private static func record(_ grant: BackgroundGrant) {
    try? DiagnosticsFiles.appendLine(grant, to: log)
  }

  /// The last `limit` log lines, newest first (Diagnostics).
  static func recentGrants(limit: Int) -> [String] {
    guard let text = try? String(contentsOf: log, encoding: .utf8) else { return [] }
    return Array(text.split(separator: "\n").suffix(limit).reversed().map(String.init))
  }
}

/// A granted task carried across the hop to the main actor. Only the main actor touches `completed`; `BGTask`'s own
/// methods are documented as callable from any thread.
nonisolated private final class GrantedTask: @unchecked Sendable {
  let task: BGTask
  var completed = false
  init(_ task: BGTask) { self.task = task }
}
