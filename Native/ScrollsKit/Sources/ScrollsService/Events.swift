// OWNER: N0
// The engine's event stream (IOS-SPEC §1.5 Events; ΔS-1: SSE becomes AsyncStream<AtlasEvent>). The `job`, `data`,
// `bootstrap` and `adapter` channels of GET /api/events carry the contract's payloads; the phone adds generation,
// journal and thermal events. Job progress is sent at most four times a second per job; phase changes and job ends
// go out at once.

import Foundation
import ScrollsContracts
import ScrollsJobs
import Synchronization

/// One event of `AtlasService.events`.
public enum AtlasEvent: Sendable {
  /// A job's progress or end (the `job` channel: `JobProgressEvent` / `JobDoneEvent`).
  case job(JobEventPayload)
  /// A committed write bumped `meta.data_version` (the `data` channel).
  case dataChanged(Int)
  /// An adapter's load state (the `adapter` channel).
  case adapter(AdapterStatus)
  /// The Cipher bootstrap's status, as `health.cipher` reports it (the `bootstrap` channel).
  case bootstrap(BootstrapStatus)
  /// An atlas generation was built, installed, swapped or rolled back (phone only, §3.5).
  case generation(GenerationEvent)
  /// The journal's head after an append (phone only, §6.2).
  case journal(UInt64)
  /// The compute throttle changed (thermal state or Low Power Mode).
  case thermal(ComputeThrottle)
}

/// What happened to an atlas generation (P1; built, installed and swapped by N2's generation jobs).
public struct GenerationEvent: Sendable, Equatable {
  /// What happened.
  public enum Kind: String, Sendable, Equatable {
    case building, ready, installing, swapped, rolledBack = "rolled_back", failed
  }

  public var kind: Kind
  /// The generation's name (`meta.generation`).
  public var generation: String?
  public var progress: Double?
  public var message: String?

  public init(kind: Kind, generation: String? = nil, progress: Double? = nil, message: String? = nil) {
    self.kind = kind
    self.generation = generation
    self.progress = progress
    self.message = message
  }
}

/// Fans events out to every subscriber. Each `stream()` gets its own buffered `AsyncStream` (newest 256 events kept,
/// so a stalled reader never blocks the engine) that starts with the current throttle, if one was sent; progress of
/// one job is throttled to four events a second.
public final class AtlasEventHub: Sendable {
  private struct State {
    var next = 0
    var subscribers: [Int: AsyncStream<AtlasEvent>.Continuation] = [:]
    /// Last progress event sent per job: when, and in which phase.
    var lastProgress: [Int: (at: ContinuousClock.Instant, phase: String?)] = [:]
    /// The latest throttle, replayed to new subscribers (a hot phone is a state, not only a change).
    var thermal: ComputeThrottle?
  }

  private let state = Mutex(State())
  private let minProgressInterval: Duration
  private let clock = ContinuousClock()

  /// - Parameter minProgressInterval: the shortest gap between two progress events of one job in the same phase.
  public init(minProgressInterval: Duration = .milliseconds(250)) {
    self.minProgressInterval = minProgressInterval
  }

  /// A new subscription. It ends when the hub finishes or the consumer stops iterating.
  public func stream() -> AsyncStream<AtlasEvent> {
    let (stream, continuation) = AsyncStream.makeStream(of: AtlasEvent.self, bufferingPolicy: .bufferingNewest(256))
    let id = state.withLock { s in
      defer { s.next += 1 }
      s.subscribers[s.next] = continuation
      if let t = s.thermal { continuation.yield(.thermal(t)) }
      return s.next
    }
    continuation.onTermination = { [weak self] _ in
      self?.state.withLock { s in _ = s.subscribers.removeValue(forKey: id) }
    }
    return stream
  }

  /// Sends an event to every subscriber, dropping a progress event that comes too soon after the previous one of the
  /// same job and phase. Returns whether it was sent.
  @discardableResult
  public func send(_ event: AtlasEvent) -> Bool {
    let now = clock.now
    let targets: [AsyncStream<AtlasEvent>.Continuation]? = state.withLock { s in
      if case .thermal(let t) = event { s.thermal = t }
      if case .job(let payload) = event {
        switch payload {
        case .progress(let p):
          if let last = s.lastProgress[p.job], last.phase == p.phase, now - last.at < minProgressInterval { return nil }
          s.lastProgress[p.job] = (now, p.phase)
        case .done(let d):
          s.lastProgress.removeValue(forKey: d.job)
        }
      }
      return Array(s.subscribers.values)
    }
    guard let targets else { return false }
    for c in targets { c.yield(event) }
    return true
  }

  /// Ends every subscription (the atlas is closing).
  public func finish() {
    let all = state.withLock { s in
      defer { s.subscribers.removeAll() }
      return Array(s.subscribers.values)
    }
    for c in all { c.finish() }
  }

  /// How many subscribers are listening.
  public var subscriberCount: Int { state.withLock { $0.subscribers.count } }
}
