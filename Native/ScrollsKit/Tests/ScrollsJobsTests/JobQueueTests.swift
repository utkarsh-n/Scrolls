// OWNER: N0
// The job queue (IOS-SPEC §1.5, ΔS-2): priority order, `after:` dependencies, ≤ 1 exclusive and ≤ 2 read-mostly jobs,
// failures and their dependents, state written to job/job_event, cancellation acknowledged ≤ 500 ms (a compute loop, a
// read statement, a write statement), suspend/resume, boot recovery, the thermal pause, events, and journaled commits.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsJobs
@testable import ScrollsStore
import Testing

@Suite("Job queue")
struct JobQueueTests {
  @Test("priority orders the queue, and after: waits for its dependency")
  func priorityAndAfter() async throws {
    let f = try QueueFixture()
    let key = "prio-\(UUID().uuidString)"
    // an exclusive blocker holds the exclusive slot while the others queue up
    let blocker = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 300, "key": .string(key), "label": "blocker"]))
    let low = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 10, "key": .string(key), "label": "p9"], priority: 9))
    let dependency = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 10, "key": .string(key), "label": "p5"], priority: 5))
    let dependent = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 10, "key": .string(key), "label": "p1-after-p5"],
                                                      priority: 1, after: [dependency]))
    let high = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 10, "key": .string(key), "label": "p2"], priority: 2))
    for id in [blocker, low, dependency, dependent, high] { #expect(await f.queue.wait(for: id)?.status == .succeeded) }
    let starts = TaskLog.entries(key).filter { $0.hasPrefix("start") }.map { String($0.dropFirst(6)) }
    #expect(starts == ["blocker", "p2", "p5", "p1-after-p5", "p9"])
  }

  @Test("at most one exclusive and two read-mostly jobs run at once")
  func admission() async throws {
    let f = try QueueFixture()
    let ex = "ex-\(UUID().uuidString)", ro = "ro-\(UUID().uuidString)"
    var ids: [JobID] = []
    for _ in 0..<3 { ids.append(try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 150, "key": .string(ex)]))) }
    for _ in 0..<5 { ids.append(try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 150, "key": .string(ro)]))) }
    for id in ids { #expect(await f.queue.wait(for: id)?.status == .succeeded) }
    #expect(TaskLog.maxRunning(ex) == 1)
    #expect(TaskLog.maxRunning(ro) == 2)
  }

  @Test("a failed task: status failed with {code, message, hint}; its dependents fail with E_DEPENDENCY; unknown types are refused")
  func failures() async throws {
    let f = try QueueFixture()
    let failing = try await f.queue.enqueue(JobSpec(type: FailTask.type))
    let dependent = try await f.queue.enqueue(JobSpec(type: SleepTask.type, after: [failing]))
    let done = await f.queue.wait(for: failing)
    #expect(done?.status == .failed)
    #expect(done?.error == JobError(code: "E_TEST", message: "the slice is empty", hint: "widen it"))
    let dep = await f.queue.wait(for: dependent)
    #expect(dep?.status == .failed && dep?.error?.code == "E_DEPENDENCY")
    let e = await #expect(throws: ScrollsError.self) { try await f.queue.enqueue(JobSpec(type: JobType("no-such-type"))) }
    #expect(e?.code.rawValue == "E_JOB_TYPE")
    // the row as the API reads it
    let row = try await f.reads.read { c in
      try c.prepared(dynamic: "SELECT status, error_json, finished_at IS NOT NULL FROM job WHERE id = ?")
        .bindingFirst([.int(failing.rawValue)]) { ($0.text(0), $0.text(1), $0.int(2)) }
    }
    #expect(row?.0 == "failed" && row?.1 == #"{"code":"E_TEST","hint":"widen it","message":"the slice is empty"}"# && row?.2 == 1)
  }

  @Test("job and job_event rows record the life of a job; the snapshot merges live state over the table")
  func persistence() async throws {
    let f = try QueueFixture()
    let id = try await f.queue.enqueue(JobSpec(type: BulkWriteTask.type, params: ["batches": 4, "rows": 25]))
    let snap = await f.queue.wait(for: id)
    #expect(snap?.status == .succeeded && snap?.result == ["rows": 100] && snap?.progress == 1)
    let rows = try await f.reads.read { c in
      try c.prepared(dynamic: "SELECT status, progress, result_json, started_at IS NOT NULL, writes FROM job WHERE id = ?")
        .bindingFirst([.int(id.rawValue)]) { ($0.text(0), $0.double(1), $0.text(2), $0.int(3), $0.int(4)) }
    }
    #expect(rows?.0 == "succeeded" && rows?.1 == 1 && rows?.2 == #"{"rows":100}"# && rows?.3 == 1 && rows?.4 == 1)
    let events = try await f.reads.read { c in
      try c.prepared(dynamic: "SELECT message FROM job_event WHERE job_id = ? ORDER BY id").bindingFirstAll([.int(id.rawValue)]) { $0.text(0) }
    }
    #expect(events.first == "started" && events.last == "succeeded")
    let written = try await f.reads.read { c in try c.prepared(dynamic: "SELECT count(*) FROM meta WHERE key LIKE 'bulk.%'").first { $0.int(0) } }
    #expect(written == 100)
    let list = try await f.queue.snapshot(nil)
    #expect(list.first?.id == id)
    #expect(try await f.queue.snapshot(.failed).isEmpty)
  }

  @Test("cancel: a queued job at once; a running compute loop within 500 ms")
  func cancelCompute() async throws {
    let f = try QueueFixture()
    let running = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 60_000]))
    let queued = try await f.queue.enqueue(JobSpec(type: ExclusiveSleepTask.type, params: ["ms": 10]))
    await f.queue.cancel(queued)
    #expect(try await f.status(queued) == .cancelled)
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await f.status(running) == .running)
    let asked = ContinuousClock.now
    await f.queue.cancel(running)
    let done = await f.queue.wait(for: running)
    let elapsed = ContinuousClock.now - asked
    #expect(done?.status == .cancelled)
    #expect(elapsed <= .milliseconds(500), "cancellation acknowledged after \(elapsed)")
    try await recordTiming("job-cancel-compute-ms", elapsed)
  }

  @Test("cancel interrupts a running SQL statement: a job-lane read and a writer statement, each within 500 ms", arguments: ["read", "write"])
  func cancelSQL(_ lane: String) async throws {
    let f = try QueueFixture()
    let id = try await f.queue.enqueue(JobSpec(type: LongSQLTask.type, params: ["seconds": 120, "lane": .string(lane)]))
    try await Task.sleep(for: .milliseconds(400))
    #expect(try await f.status(id) == .running)
    let asked = ContinuousClock.now
    await f.queue.cancel(id)
    let done = await f.queue.wait(for: id)
    let elapsed = ContinuousClock.now - asked
    #expect(done?.status == .cancelled)
    #expect(elapsed <= .milliseconds(500), "cancellation of a \(lane) statement acknowledged after \(elapsed)")
    try await recordTiming("job-cancel-sql-\(lane)-ms", elapsed)
    // the connection is healthy afterwards
    #expect(try await f.writer.write("after") { tx in try Meta.dataVersion(tx.connection) } >= 0)
  }

  @Test("suspendAll stops running jobs at their next checkpoint (interrupted) and starts nothing; resumeAll re-queues them")
  func suspendResume() async throws {
    let f = try QueueFixture()
    let long = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 60_000]))
    try await Task.sleep(for: .milliseconds(200))
    let asked = ContinuousClock.now
    await f.queue.suspendAll(within: .seconds(5))
    #expect(ContinuousClock.now - asked < .seconds(1))
    #expect(try await f.status(long) == .interrupted)
    let later = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 10]))
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await f.status(later) == .queued)
    await f.queue.resumeAll()
    #expect(await f.queue.wait(for: later)?.status == .succeeded)
    try await Task.sleep(for: .milliseconds(100))
    #expect(try await f.status(long) == .running)
    await f.queue.cancel(long)
    #expect(await f.queue.wait(for: long)?.status == .cancelled)
  }

  @Test("boot recovery: running jobs become interrupted and their runs failed; resumable types are queued again and run")
  func recovery() async throws {
    let path = try QueueFixture.atlas()
    do {
      let c = try Connection(path: path, mode: .readWrite, profile: .device)
      try c.exec("""
        INSERT INTO job (id, type, params_json, writes, priority, status, created_at, started_at)
          VALUES (5, 'test-exclusive', '{"ms":10}', 1, 6, 'running', 't', 't'),
                 (6, 'test-sleep', '{"ms":10}', 0, 5, 'running', 't', 't'),
                 (7, 'test-sleep', '{"ms":10}', 0, 5, 'queued', 't', NULL);
        INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint,
          data_version, tokenizer_version, segmenter_version, icu_version, status, job_id, started_at)
          VALUES (1, 'cluster', 'cluster@1', 'c', '{}', 'h', '{}', 'f', 0, 'u61m-1', 'seg-1', 'i', 'running', 6, 't');
        """)
      c.close()
    }
    let f = try QueueFixture(path: path)
    try await f.queue.recoverInterrupted()
    #expect(await f.queue.wait(for: JobID(rawValue: 5))?.status == .succeeded)  // resumable: re-queued
    #expect(await f.queue.wait(for: JobID(rawValue: 7))?.status == .succeeded)  // queued before the crash
    #expect(try await f.status(JobID(rawValue: 6)) == .interrupted)
    let run = try await f.reads.read { c in try c.prepared(dynamic: "SELECT status FROM analysis_run WHERE id = 1").first { $0.text(0) } }
    #expect(run == "failed")
    let next = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 1]))
    #expect(next.rawValue == 8)
  }

  @Test("critical heat pauses running jobs and starts none; Low Power Mode starts only user-started jobs")
  func thermal() async throws {
    let f = try QueueFixture()
    let running = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 400]))
    try await Task.sleep(for: .milliseconds(100))
    f.conditions.set(.critical)
    try await Task.sleep(for: .milliseconds(400))
    let paused = try await f.queue.job(running)
    #expect(paused?.status == .running && paused?.message == "paused — the phone is hot")
    let waiting = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 10]))
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await f.status(waiting) == .queued)
    f.conditions.set(.lowPower)
    let automatic = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 10], userStarted: false))
    #expect(await f.queue.wait(for: running)?.status == .succeeded)
    #expect(await f.queue.wait(for: waiting, timeout: .seconds(5))?.status == .succeeded)
    try await Task.sleep(for: .milliseconds(300))
    #expect(try await f.status(automatic) == .queued)
    f.conditions.set(.nominal)
    #expect(await f.queue.wait(for: automatic, timeout: .seconds(10))?.status == .succeeded)
  }

  @Test("a bulk lease the task left open is ended with the job; the next exclusive job leases normally")
  func leakedLease() async throws {
    let f = try QueueFixture()
    let first = try await f.queue.enqueue(JobSpec(type: LeakyLeaseTask.type))
    #expect(await f.queue.wait(for: first)?.status == .succeeded)
    #expect(await f.writer.leaseHolder == nil)
    let second = try await f.queue.enqueue(JobSpec(type: BulkWriteTask.type, params: ["batches": 2, "rows": 3]))
    #expect(await f.queue.wait(for: second)?.status == .succeeded)
    #expect(await f.writer.leaseHolder == nil)
  }

  @Test("memory: only one job with a peak above 256 MB runs at a time")
  func largePeaks() async throws {
    let f = try QueueFixture()
    let key = "large-\(UUID().uuidString)"
    let ids = [try await f.queue.enqueue(JobSpec(type: LargePeakTask.type, params: ["ms": 150, "key": .string(key)])),
               try await f.queue.enqueue(JobSpec(type: LargePeakTask.type, params: ["ms": 150, "key": .string(key)]))]
    for id in ids { #expect(await f.queue.wait(for: id)?.status == .succeeded) }
    #expect(TaskLog.maxRunning(key) == 1)
    // The budget is process-wide and other suites' jobs hold reservations for moments; a leaked one never goes away.
    let settle = ContinuousClock.now + .seconds(5)
    while MemoryBudget.reservedBytes >= 300 << 20, ContinuousClock.now < settle { try await Task.sleep(for: .milliseconds(20)) }
    #expect(MemoryBudget.reservedBytes < 300 << 20, "a finished job's reservation was not released")
  }

  @Test("in the background only jobs that may start there start; the rest wait for the foreground")
  func background() async throws {
    let f = try QueueFixture()
    await f.queue.setForeground(false)
    let light = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 10]))
    let heavy = try await f.queue.enqueue(JobSpec(type: AnalysisTask.type, params: ["key": "bg"]))
    #expect(await f.queue.wait(for: light)?.status == .succeeded)
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await f.status(heavy) == .queued)
    await f.queue.setForeground(true)
    #expect(await f.queue.wait(for: heavy)?.status == .succeeded)
  }

  @Test("events: queued, started, throttled progress (≤ 4 per second plus phase changes), done")
  func events() async throws {
    let f = try QueueFixture()
    let stream = f.queue.events
    let id = try await f.queue.enqueue(JobSpec(type: SleepTask.type, params: ["ms": 1000]))
    var kinds: [JobEvent.Kind] = []
    for await e in stream where e.job.id == id {
      kinds.append(e.kind)
      if e.kind == .done { break }
    }
    #expect(kinds.first == .queued && kinds.dropFirst().first == .started && kinds.last == .done)
    let progress = kinds.filter { $0 == .progress }.count
    #expect(progress >= 2 && progress <= 7, "\(progress) progress events for a 1 s job")
  }

  @Test("journaledCommit appends the op (fsync) before the transaction that applies it and records journal_applied")
  func journaled() async throws {
    let f = try QueueFixture()
    let id = try await f.queue.enqueue(JobSpec(type: JournaledTask.type, journal: .viewDelete(slug: "v"), actor: "human:utkarsh"))
    let done = await f.queue.wait(for: id)
    #expect(done?.status == .succeeded && done?.result == ["seq": 1])
    #expect(await f.journal.head == 1)
    let applied = try await f.reads.read { c in
      (try c.prepared(dynamic: "SELECT seq, op FROM journal_applied").first { ($0.int(0), $0.text(1)) },
       try Meta.get(c, "journal_applied_seq"), try Meta.get(c, "journaled.act"))
    }
    #expect(applied.0?.0 == 1 && applied.0?.1 == "viewDelete" && applied.1 == "1" && applied.2 == "done")
  }

  @Test("the Jobs catalogue prepares on a device atlas without scanning big tables")
  func catalogue() throws {
    let c = try Connection(path: try QueueFixture.atlas(), mode: .readOnly, profile: .device)
    #expect(Set(JobsSQL.all.map(\.id)).count == JobsSQL.all.count)
    for sql in JobsSQL.all {
      _ = try c.prepared(sql)
      guard sql.scan == .indexOnly else { continue }
      let plan = try c.prepared(dynamic: "EXPLAIN QUERY PLAN " + sql.text).all { $0.text(3) }
      for line in plan where ["passage", "document", "relationship", "doc_tag", "occurrence"].contains(where: { line.hasPrefix("SCAN \($0)") }) {
        Issue.record("\(sql.id) scans: \(line)")
      }
    }
  }
}

extension Statement {
  func bindingFirstAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}

/// Records a measured timing (ms) in Reports/jobs-timings.json when SCROLLS_REPORTS_DIR is set.
func recordTiming(_ name: String, _ d: Duration) async throws {
  let ms = Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
  try await recordValue(name, (ms * 10).rounded() / 10)
}

/// Records a measured value in Reports/jobs-timings.json (`{name: {value, at}}`) when SCROLLS_REPORTS_DIR is set.
func recordValue(_ name: String, _ value: Double) async throws {
  guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
  let text = Timings.jobs.withLock { t -> String in
    t[name] = .object(["value": .number(value), "at": .string(StoreClock.isoNow())])
    return CanonicalJSON.string(.object(t))
  }
  try Data(text.utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("jobs-timings.json"))
}

enum Timings {
  static let jobs = Locked(JSONObject())
}
