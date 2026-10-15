// OWNER: N0
// Three readers (IOS-SPEC §1.5): reader 0 is reserved for interactive reads, readers 1…n-1 are shared, and job reads
// together hold at most `maxJobReaders` of them, so a long analysis read never takes the last reader an interactive
// request could use. Waiting is FIFO with interactive reads served first; a cancelled waiter leaves the queue at once,
// and a cancelled read interrupts only its own statement (the request token of `InterruptGate`).

import Dispatch
import Foundation
import Synchronization

/// The pool of read-only connections of one atlas.
public final class ReadPool: Sendable {
  private struct Waiter {
    let id: UInt64
    let lane: ReadLane
    let continuation: CheckedContinuation<Int, any Error>
  }

  private struct State {
    var readers: [ReadConnection]
    var busy: [ReadLane?]
    var waiters: [Waiter] = []
    var draining = false
    var closed = false
    var drainWaiters: [CheckedContinuation<Void, Never>] = []
    var path: String

    var inFlight: Int { busy.lazy.filter { $0 != nil }.count }
    var jobReads: Int { busy.lazy.filter { $0 == .job }.count }

    func freeIndex(for lane: ReadLane, maxJobReaders: Int) -> Int? {
      switch lane {
      case .interactive:
        return busy.indices.first { busy[$0] == nil }
      case .job:
        guard jobReads < maxJobReaders else { return nil }
        return busy.indices.dropFirst().first { busy[$0] == nil }
      }
    }
  }

  private static let requestIDs = Atomic<UInt64>(0)
  /// A process-wide unique request id (the interrupt token of one read).
  static func nextRequestID() -> UInt64 { requestIDs.add(1, ordering: .relaxed).newValue }

  private let state: Mutex<State>
  private let waiterIDs = Atomic<UInt64>(0)
  public let profile: StoreProfile
  public let size: Int
  public let maxJobReaders: Int
  public let mmapBytesPerReader: Int
  private let immutable: Bool
  private let reservation: MappingReservation?

  /// Opens `size` readers on `path`. Their mmap windows are accounted in `MappedFileRegistry`; when the 2 GiB budget
  /// cannot hold them the readers run without mmap (slower, same results).
  public init(path: String, profile: StoreProfile, size: Int = 3, mmapBytesPerReader: Int = 256 << 20,
              maxJobReaders: Int = 1, immutable: Bool = false) throws {
    precondition(size >= 2, "ReadPool needs the interactive reader and at least one shared reader")
    let reservation = try? MappedFileRegistry.reserve(bytes: size * mmapBytesPerReader, purpose: "sqlite readers \(path)")
    let mmap = reservation == nil ? 0 : mmapBytesPerReader
    self.reservation = reservation
    self.profile = profile
    self.size = size
    self.maxJobReaders = max(1, min(maxJobReaders, size - 1))
    self.mmapBytesPerReader = mmap
    self.immutable = immutable
    let readers = try ReadPool.openReaders(path: path, profile: profile, size: size, mmap: mmap, immutable: immutable)
    state = Mutex(State(readers: readers, busy: Array(repeating: nil, count: size), path: path))
  }

  deinit { reservation?.release() }

  private static func openReaders(path: String, profile: StoreProfile, size: Int, mmap: Int, immutable: Bool) throws
    -> [ReadConnection]
  {
    try (0..<size).map { i in
      try ReadConnection(path: path, profile: profile, mmapBytes: mmap, qos: i == 0 ? .userInitiated : .utility,
                         label: "scrolls.reader.\(i)", immutable: immutable)
    }
  }

  /// Runs `body` on a reader in one read transaction. Interactive reads may use any reader (reader 0 first); job reads
  /// use the shared readers only. Throws QUERY_TIMEOUT after `deadline`, CancellationError when the task is cancelled
  /// (the running statement is interrupted), E_ATLAS_SWAPPING while the pool is drained. `heartbeat` is called every
  /// 10,000 VM steps while the request runs (a job's stall rule, §3.7).
  public func read<T: Sendable>(_ lane: ReadLane = .interactive, deadline: Duration = .seconds(5),
                                heartbeat: (@Sendable () -> Void)? = nil,
                                _ body: @Sendable (Connection) throws -> T) async throws -> T {
    let (index, reader) = try await acquire(lane)
    defer { release(index) }
    let request = ReadPool.nextRequestID()
    return try await withTaskCancellationHandler {
      try await reader.run(request: request, deadline: deadline, heartbeat: heartbeat, body)
    } onCancel: {
      reader.gate.interrupt(token: request)
    }
  }

  /// Waits for in-flight reads to finish and refuses new ones (a generation swap). Queued reads wait for `reopen`.
  public func drain() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      let resumeNow = state.withLock { s -> Bool in
        s.draining = true
        if s.inFlight == 0 { return true }
        s.drainWaiters.append(c)
        return false
      }
      if resumeNow { c.resume() }
    }
  }

  /// Closes the readers and opens new ones on `path` (after a swap), then serves the queued reads.
  public func reopen(path: String) async throws {
    let old = state.withLock { $0.readers }
    for r in old { await r.close() }
    let readers = try ReadPool.openReaders(path: path, profile: profile, size: size, mmap: mmapBytesPerReader,
                                           immutable: immutable)
    let grants = state.withLock { s -> [(CheckedContinuation<Int, any Error>, Int)] in
      s.readers = readers
      s.path = path
      s.draining = false
      return assignWaiters(&s)
    }
    for (c, i) in grants { c.resume(returning: i) }
  }

  /// Closes the pool: queued reads fail, and readers close once their running reads finish.
  public func close() async {
    let (readers, waiters) = state.withLock { s -> ([ReadConnection], [Waiter]) in
      s.closed = true
      let w = s.waiters
      s.waiters = []
      return (s.readers, w)
    }
    for w in waiters { w.continuation.resume(throwing: StoreError.misuse("the read pool is closed")) }
    for r in readers { await r.close() }
  }

  /// Drops every reader's decoded-chunk cache (`AtlasPlatform.trim()` on a memory warning, §3.8).
  public func trim() async {
    for r in state.withLock({ $0.readers }) { await r.trim() }
  }

  /// The database file the readers are open on.
  public var path: String { state.withLock { $0.path } }

  /// Reads in flight and reads waiting (for diagnostics and tests).
  public var load: (inFlight: Int, waiting: Int) { state.withLock { ($0.inFlight, $0.waiters.count) } }

  // ── reader allocation ──

  private func acquire(_ lane: ReadLane) async throws -> (Int, ReadConnection) {
    let id = waiterIDs.add(1, ordering: .relaxed).newValue
    let index: Int = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Int, any Error>) in
        enum Outcome { case granted(Int), queued, failed(any Error) }
        let outcome = state.withLock { s -> Outcome in
          if s.closed { return .failed(StoreError.misuse("the read pool is closed")) }
          if s.draining { return .failed(StoreFailures.swapping()) }
          if Task.isCancelled { return .failed(CancellationError()) }
          if s.waiters.isEmpty || lane == .interactive, let i = s.freeIndex(for: lane, maxJobReaders: maxJobReaders) {
            s.busy[i] = lane
            return .granted(i)
          }
          s.waiters.append(Waiter(id: id, lane: lane, continuation: c))
          return .queued
        }
        switch outcome {
        case .granted(let i): c.resume(returning: i)
        case .failed(let e): c.resume(throwing: e)
        case .queued: break
        }
      }
    } onCancel: {
      let w = state.withLock { s -> Waiter? in
        guard let k = s.waiters.firstIndex(where: { $0.id == id }) else { return nil }
        return s.waiters.remove(at: k)
      }
      w?.continuation.resume(throwing: CancellationError())
    }
    return (index, state.withLock { $0.readers[index] })
  }

  private func release(_ index: Int) {
    let (grants, drained) = state.withLock { s -> ([(CheckedContinuation<Int, any Error>, Int)], [CheckedContinuation<Void, Never>]) in
      s.busy[index] = nil
      var drained: [CheckedContinuation<Void, Never>] = []
      if s.draining {
        if s.inFlight == 0 {
          drained = s.drainWaiters
          s.drainWaiters = []
        }
        return ([], drained)
      }
      return (assignWaiters(&s), drained)
    }
    for (c, i) in grants { c.resume(returning: i) }
    for c in drained { c.resume() }
  }

  /// Hands free readers to waiters: interactive waiters first, each class in arrival order.
  private func assignWaiters(_ s: inout State) -> [(CheckedContinuation<Int, any Error>, Int)] {
    var grants: [(CheckedContinuation<Int, any Error>, Int)] = []
    for lane in [ReadLane.interactive, .job] {
      var k = 0
      while k < s.waiters.count {
        let w = s.waiters[k]
        guard w.lane == lane else { k += 1; continue }
        guard let i = s.freeIndex(for: lane, maxJobReaders: maxJobReaders) else { break }
        s.busy[i] = lane
        s.waiters.remove(at: k)
        grants.append((w.continuation, i))
      }
    }
    return grants
  }
}
