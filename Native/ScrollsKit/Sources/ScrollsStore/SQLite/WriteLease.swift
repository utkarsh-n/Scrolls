// OWNER: N0
// A bulk writer's lease on the single writer (IOS-SPEC §1.5, ΔS-19).

import Foundation
import Synchronization

/// A bulk writer's handle: each `batch` is one transaction, then the writer is free for queued interactive writes.
public final class WriteLease: Sendable {
  public let job: JobID
  private let writer: Writer
  private let heartbeat: (@Sendable () -> Void)?
  private let ended = Atomic<Bool>(false)

  init(writer: Writer, job: JobID, heartbeat: (@Sendable () -> Void)?) {
    self.writer = writer
    self.job = job
    self.heartbeat = heartbeat
  }

  /// One transaction, a PASSIVE checkpoint, a pause while the WAL is over `Writer.walPauseBytes`, then a yield.
  public func batch<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx) throws -> T) async throws -> T {
    guard !ended.load(ordering: .relaxed) else { throw StoreError.misuse("the write lease of job \(job.rawValue) has ended") }
    let out = try await writer.write(label, heartbeat: heartbeat, body)
    var status = try await writer.checkpoint(.passive)
    let until = ContinuousClock.now + .seconds(60)
    while status.walBytes > Writer.walPauseBytes, ContinuousClock.now < until {
      heartbeat?()
      try await Task.sleep(for: .milliseconds(100))
      status = try await writer.checkpoint(.truncate)
    }
    await Task.yield()
    return out
  }

  /// Ends the lease (idempotent).
  public func end() async {
    guard !ended.exchange(true, ordering: .relaxed) else { return }
    _ = try? await writer.checkpoint(.passive)
    await writer.endLease(job)
  }
}
