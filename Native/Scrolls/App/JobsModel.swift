// OWNER: N0
// The app's view of engine activity (IOS-SPEC §1.5 Events, §4.3 status chip, §4.18): it listens to
// `AtlasService.events` and keeps the latest health — jobs, the Cipher bootstrap, the data version — and the thermal
// throttle. Job progress arrives at most four times a second; this model coalesces it into one health read per
// quarter second rather than parsing job snapshots itself, so the chip always shows what the engine reports.

import Observation
import ScrollsContracts
import ScrollsJobs
import ScrollsService

nonisolated enum JobsCopy {
  static let opening = "Opening"
  static let ready = "Ready"
  static let fixtures = "Fixtures"
  static let cipher = "Cipher"
  static let cipherFailed = "Cipher failed"
  static let hot = "paused: phone is hot"
  static let noEngine = "No engine"

  /// "2 running" for jobs without a fraction: words, never a spinner.
  static func running(_ n: Int) -> String { "\(n) running" }
}

@MainActor @Observable
final class JobsModel {
  /// The latest `health()`; nil until the first read.
  private(set) var health: HealthResponse?
  /// The last failed read, shown as an error card where health would be.
  private(set) var lastError: ErrorCardModel?
  /// The compute throttle the engine last reported.
  private(set) var throttle: ComputeThrottle?
  /// The data version of the last `dataChanged` event or health read.
  private(set) var dataVersion: Int?
  /// What the TopBar's status chip says.
  private(set) var chip: StatusChipState = .idle(JobsCopy.opening)

  @ObservationIgnored private var atlas: (any AtlasService)?
  @ObservationIgnored private var fixtures = false
  @ObservationIgnored private var listener: Task<Void, Never>?
  @ObservationIgnored private var pendingRefresh: Task<Void, Never>?

  init() {}

  /// Starts following an engine: one health read now, then its event stream.
  func attach(_ atlas: any AtlasService, fixtures: Bool) async {
    detach()
    self.atlas = atlas
    self.fixtures = fixtures
    await refresh()
    let events = atlas.events
    listener = Task { [weak self] in
      for await event in events {
        guard let self, !Task.isCancelled else { return }
        self.handle(event)
      }
    }
  }

  /// No engine could be opened: the chip says so.
  func noEngine() {
    detach()
    chip = .failed(JobsCopy.noEngine)
  }

  func detach() {
    listener?.cancel()
    listener = nil
    pendingRefresh?.cancel()
    pendingRefresh = nil
    atlas = nil
  }

  /// Reads `health()` now.
  func refresh() async {
    guard let atlas else { return }
    do {
      let h = try await atlas.health()
      health = h
      dataVersion = h.dataVersion
      lastError = nil
    } catch {
      lastError = ErrorCardModel(any: error, what: "Health")
    }
    updateChip()
  }

  private func handle(_ event: AtlasEvent) {
    switch event {
    case .dataChanged(let version):
      dataVersion = version
      scheduleRefresh()
    case .bootstrap(let status):
      health?.cipher = status
      updateChip()
    case .thermal(let t):
      throttle = t
      updateChip()
    case .job, .adapter, .generation, .journal:
      scheduleRefresh()
    }
  }

  /// One health read per quarter second, however many events arrive.
  private func scheduleRefresh() {
    guard pendingRefresh == nil else { return }
    pendingRefresh = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard let self, !Task.isCancelled else { return }
      self.pendingRefresh = nil
      await self.refresh()
    }
  }

  private func updateChip() {
    if throttle == .critical {
      chip = .paused(JobsCopy.hot)
      return
    }
    guard let health else {
      chip = lastError == nil ? .idle(JobsCopy.opening) : .failed(JobsCopy.noEngine)
      return
    }
    // Fixture progress is canned, not work happening on this phone: the chip says "Fixtures" and nothing else.
    if fixtures || health.mock == true {
      chip = .idle(JobsCopy.fixtures)
      return
    }
    switch health.cipher.status {
    case "failed":
      chip = .failed(JobsCopy.cipherFailed)
    case "queued", "metadata", "fulltext":
      if let p = health.cipher.progress, p.isFinite {
        chip = .progress(JobsCopy.cipher, p)
      } else {
        chip = .idle(health.cipher.message ?? JobsCopy.cipher)
      }
    default:
      if health.jobs.running > 0 {
        chip = .idle(JobsCopy.running(health.jobs.running))
      } else {
        chip = .idle(JobsCopy.ready)
      }
    }
  }
}
