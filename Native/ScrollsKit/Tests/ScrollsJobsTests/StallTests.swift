// OWNER: N0
// The stall rule (IOS-SPEC §3.7, N-14): a running job's progress must advance at least every 2 s of wall time, even
// while one SQL statement runs for 30 s — SQLite's progress handler calls the job's heartbeat every 10,000 VM steps.
// "StallTests injects a 30 s statement and asserts ≥ 15 progress increments."

import Foundation
import ScrollsCore
@testable import ScrollsJobs
@testable import ScrollsStore
import Synchronization
import Testing

@Suite("Stall rule", .serialized)
struct StallTests {
  /// Samples a job's Progress every 50 ms until it finishes: the increments and the longest gap between them.
  static func watch(_ f: QueueFixture, _ id: JobID) async throws -> (increments: Int, maxGap: Duration, total: Duration) {
    var found: Progress?
    while found == nil {
      found = await f.queue.progress(of: id)
      if found == nil { try await Task.sleep(for: .milliseconds(5)) }
    }
    let progress = found!
    let start = ContinuousClock.now
    var last = progress.completedUnitCount
    var lastChange = start
    var increments = 0
    var maxGap: Duration = .zero
    while try await f.status(id) == .running {
      try await Task.sleep(for: .milliseconds(50))
      let now = ContinuousClock.now
      let v = progress.completedUnitCount
      if v > last {
        increments += 1
        maxGap = max(maxGap, now - lastChange)
        last = v
        lastChange = now
      } else {
        maxGap = max(maxGap, now - lastChange)
      }
    }
    return (increments, maxGap, ContinuousClock.now - start)
  }

  @Test("a 30 s SQL statement on the job lane: ≥ 15 progress increments, none more than 2 s apart")
  func longReadStatement() async throws {
    let f = try QueueFixture()
    let id = try await f.queue.enqueue(JobSpec(type: LongSQLTask.type, params: ["seconds": 30, "lane": "read"]))
    let w = try await Self.watch(f, id)
    let done = await f.queue.wait(for: id, timeout: .seconds(60))
    #expect(done?.status == .succeeded && done?.result == ["timed_out": true])
    #expect(w.total >= .seconds(29))
    #expect(w.increments >= 15, "\(w.increments) increments in \(w.total)")
    #expect(w.maxGap < .seconds(2), "the progress stood still for \(w.maxGap)")
    try await recordValue("stall-30s-increments", Double(w.increments))
    try await recordTiming("stall-30s-max-gap-ms", w.maxGap)
  }

  @Test("a long statement inside a write transaction also keeps the progress moving")
  func longWriteStatement() async throws {
    let f = try QueueFixture()
    let id = try await f.queue.enqueue(JobSpec(type: LongSQLTask.type, params: ["lane": "write"]))
    let watcher = Task { try await Self.watch(f, id) }
    try await Task.sleep(for: .seconds(5))
    await f.queue.cancel(id)
    let w = try await watcher.value
    #expect(w.increments >= 8, "\(w.increments) increments in \(w.total)")
    #expect(w.maxGap < .seconds(2), "the progress stood still for \(w.maxGap)")
  }

  @Test("heartbeat never reaches the next 1 % nor completion, and reported progress moves the Progress forward")
  func heartbeatBounds() async throws {
    let f = try QueueFixture()
    let ctx = JobContext(id: JobID(rawValue: 1), type: SleepTask.type, reads: f.reads, writer: f.writer, text: ChunkedTextStore(),
                         journal: nil, journalOp: nil, actor: "scrolls", writes: .none, priority: 5, conditions: Unthrottled(),
                         onEvent: { _, _ in })
    ctx.progress(0.5, phase: "half")
    #expect(ctx.progressObject.completedUnitCount == 500_000)
    for _ in 0..<20 {
      ctx.heartbeat()
      try await Task.sleep(for: .milliseconds(260))
    }
    let crept = ctx.progressObject.completedUnitCount
    #expect(crept > 500_000 && crept < 510_000)
    ctx.progress(0.25)
    #expect(ctx.progressObject.completedUnitCount == crept, "the Progress never moves backwards")
    ctx.progress(1)
    #expect(ctx.progressObject.completedUnitCount == 1_000_000)
  }
}
