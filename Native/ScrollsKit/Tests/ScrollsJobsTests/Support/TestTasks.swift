// OWNER: N0
// Tasks and fixtures for ScrollsJobsTests: a fresh device atlas with its writer, readers and journal, and small tasks
// that sleep, fail, write in batches, run analysis runs, run a long SQL statement, and record what ran when.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsJobs
@testable import ScrollsStore
import Synchronization

/// A statement that runs for a long time (≈ 10⁹ VM steps) unless interrupted.
let longQuery = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT count(*) FROM n"

/// What tasks observed (each test uses its own keys).
enum TaskLog {
  static let log = Mutex<[String: [String]]>([:])
  static let running = Mutex<[String: (now: Int, max: Int)]>([:])

  static func append(_ key: String, _ value: String) { log.withLock { $0[key, default: []].append(value) } }
  static func entries(_ key: String) -> [String] { log.withLock { $0[key] ?? [] } }

  static func enter(_ key: String) {
    running.withLock { r in
      var v = r[key] ?? (0, 0)
      v.now += 1
      v.max = max(v.max, v.now)
      r[key] = v
    }
  }
  static func leave(_ key: String) { running.withLock { $0[key]?.now -= 1 } }
  static func maxRunning(_ key: String) -> Int { running.withLock { $0[key]?.max ?? 0 } }
}

/// A settable throttle.
final class TestConditions: DeviceConditionsSource {
  let state = Mutex<ComputeThrottle>(.nominal)
  var current: ComputeThrottle { state.withLock { $0 } }
  func set(_ t: ComputeThrottle) { state.withLock { $0 = t } }
}

/// Params: {ms, key?, label?, step?}. Works in checkpointed slices; records start/end under `key`.
struct SleepTask: JobTask {
  static let type = JobType("test-sleep")
  static let writes = WriteNeed.none
  static let resumable = false
  static let budget = ResourceBudget.light
  let ms: Int, key: String?, label: String?
  init(params: JSONValue) throws {
    ms = params["ms"]?.safeInteger ?? 50
    key = params["key"]?.stringValue
    label = params["label"]?.stringValue
  }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    if let key { TaskLog.enter(key); TaskLog.append(key, "start \(label ?? "")") }
    defer { if let key { TaskLog.leave(key); TaskLog.append(key, "end \(label ?? "")") } }
    let until = ContinuousClock.now + .milliseconds(ms)
    var k = 0
    while ContinuousClock.now < until {
      let slice = ContinuousClock.now + .milliseconds(2)
      while ContinuousClock.now < slice {}  // busy work, as a kernel would do
      k += 1
      ctx.progress(min(1, Double(k * 2) / Double(max(ms, 1))), phase: "working", message: "slice \(k)")
      try await ctx.checkpoint()
    }
    return ["slept": .number(Double(ms))]
  }
}

/// The same work as an exclusive (bulk-writing) job; records under `key`.
struct ExclusiveSleepTask: JobTask {
  static let type = JobType("test-exclusive")
  static let writes = WriteNeed.exclusive
  static let resumable = true
  static let budget = ResourceBudget.light
  let inner: SleepTask
  init(params: JSONValue) throws { inner = try SleepTask(params: params) }
  func run(_ ctx: JobContext) async throws -> JSONValue { try await inner.run(ctx) }
}

/// A job that declares a 300 MB peak (only one such job runs at a time; none starts in the background).
struct LargePeakTask: JobTask {
  static let type = JobType("test-large")
  static let writes = WriteNeed.none
  static let resumable = false
  static let budget = ResourceBudget(peakBytes: 300 << 20, maxThreads: 1, mayStartInBackground: true)
  let inner: SleepTask
  init(params: JSONValue) throws { inner = try SleepTask(params: params) }
  func run(_ ctx: JobContext) async throws -> JSONValue { try await inner.run(ctx) }
}

/// Takes the bulk lease, writes one batch and returns without ending the lease (the queue must end it).
struct LeakyLeaseTask: JobTask {
  static let type = JobType("test-leaky-lease")
  static let writes = WriteNeed.exclusive
  static let resumable = false
  static let budget = ResourceBudget.light
  init(params: JSONValue) throws {}
  func run(_ ctx: JobContext) async throws -> JSONValue {
    let lease = await ctx.lease()
    let id = ctx.id.rawValue
    try await lease.batch("leaky") { tx in try Meta.set(tx.connection, "leaky.\(id)", "x") }
    return .null
  }
}

/// Always fails with E_TEST.
struct FailTask: JobTask {
  static let type = JobType("test-fail")
  static let writes = WriteNeed.none
  static let resumable = false
  static let budget = ResourceBudget.light
  init(params: JSONValue) throws {}
  func run(_ ctx: JobContext) async throws -> JSONValue {
    throw ScrollsError(code: ErrorCode(rawValue: "E_TEST"), message: "the slice is empty", hint: "widen it")
  }
}

/// Params: {batches, rows}: writes rows into meta through the bulk lease, one batch at a time.
struct BulkWriteTask: JobTask {
  static let type = JobType("test-bulk")
  static let writes = WriteNeed.exclusive
  static let resumable = true
  static let budget = ResourceBudget.light
  let batches: Int, rows: Int
  init(params: JSONValue) throws {
    batches = params["batches"]?.safeInteger ?? 3
    rows = params["rows"]?.safeInteger ?? 10
  }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    let lease = await ctx.lease()
    let id = ctx.id.rawValue
    do {
      for b in 0..<batches {
        try await lease.batch("bulk \(b)") { [rows] tx in
          for r in 0..<rows { try Meta.set(tx.connection, "bulk.\(id).\(b).\(r)", "x") }
        }
        ctx.progress(Double(b + 1) / Double(batches), phase: "writing")
        try await ctx.checkpoint()
      }
    } catch {
      await lease.end()
      throw error
    }
    await lease.end()
    return ["rows": .number(Double(batches * rows))]
  }
}

/// Params: {seconds, lane}: one long SQL statement on the job lane (or in the writer with lane "write").
struct LongSQLTask: JobTask {
  static let type = JobType("test-long-sql")
  static let writes = WriteNeed.commitsOnly
  static let resumable = false
  static let budget = ResourceBudget.light
  let seconds: Int, inWriter: Bool
  init(params: JSONValue) throws {
    seconds = params["seconds"]?.safeInteger ?? 60
    inWriter = params["lane"]?.stringValue == "write"
  }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    ctx.progress(0.1, phase: "counting")
    do {
      if inWriter {
        _ = try await ctx.write("long write") { tx in try tx.connection.prepared(dynamic: longQuery).first { $0.int(0) } }
      } else {
        _ = try await ctx.read(deadline: .seconds(Int64(seconds))) { c in try c.prepared(dynamic: longQuery).first { $0.int(0) } }
      }
    } catch let e as ScrollsError where e.code.rawValue == "QUERY_TIMEOUT" {
      return ["timed_out": true]
    }
    return ["timed_out": false]
  }
}

/// Opens a run, optionally waits on a gate while the test changes the inputs, then commits through commitRun.
struct AnalysisTask: JobTask {
  static let type = JobType("test-analysis")
  static let writes = WriteNeed.commitsOnly
  static let resumable = false
  static let budget = ResourceBudget(peakBytes: 16 << 20)
  static let gate = Mutex<[String: Bool]>([:])
  let key: String, wait: Bool
  init(params: JSONValue) throws {
    key = params["key"]?.stringValue ?? "a"
    wait = params["wait"]?.boolValue ?? false
  }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    let run = try await ctx.startRun(Stage(rawValue: "cluster"), params: ["k": 3], scope: ["collections": ["c"]], upstream: [],
                                     representation: nil, seed: 7)
    if wait {
      TaskLog.append(key, "started run \(run.id.rawValue)")
      while AnalysisTask.gate.withLock({ $0[key] }) != true { try await Task.sleep(for: .milliseconds(10)) }
    }
    try await ctx.commitRun(run, metrics: ["k": 3]) { [id = run.id] tx in
      try tx.connection.prepared(dynamic: "INSERT INTO time_window (run_id, label, lo_year, hi_year, scheme) VALUES (?, '1900s', 1900, 1909, 'fixed')")
        .bindRun([.int(id.rawValue)])
    }
    return ["run": .number(Double(run.id.rawValue)), "reused": .bool(run.reused)]
  }
}

/// A journaled act: writes a meta row and its journal_applied in the final commit.
struct JournaledTask: JobTask {
  static let type = JobType("test-journaled")
  static let writes = WriteNeed.exclusive
  static let resumable = false
  static let budget = ResourceBudget.light
  init(params: JSONValue) throws {}
  func run(_ ctx: JobContext) async throws -> JSONValue {
    let seq = try await ctx.journaledCommit("journaled") { tx, entry in
      try Meta.set(tx.connection, "journaled.act", "done")
      return entry?.seq ?? 0
    }
    return ["seq": .number(Double(seq))]
  }
}

extension Statement {
  func bindRun(_ values: [SQLValue]) throws {
    try bind(values)
    try run()
  }
}

/// A queue on a fresh device atlas.
struct QueueFixture {
  let path: String
  let writer: Writer
  let reads: ReadPool
  let journal: JournalFile
  let conditions: TestConditions
  let queue: JobQueue

  static let registry: [any JobTask.Type] = [SleepTask.self, ExclusiveSleepTask.self, FailTask.self, BulkWriteTask.self,
                                             LongSQLTask.self, AnalysisTask.self, JournaledTask.self, LargePeakTask.self,
                                             LeakyLeaseTask.self]

  init(path existing: String? = nil) throws {
    path = try existing ?? QueueFixture.atlas()
    writer = try Writer(path: path, profile: .device)
    reads = try ReadPool(path: path, profile: .device, mmapBytesPerReader: 8 << 20)  // the mapping budget is process-wide
    journal = try JournalFile(directory: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("Notebook"))
    conditions = TestConditions()
    queue = JobQueue(reads: reads, writer: writer, text: ChunkedTextStore(), registry: QueueFixture.registry,
                     conditions: conditions, journal: journal)
  }

  /// $TMPDIR/scrolls-n0b-tests, pruned of directories older than an hour (earlier runs; no run takes that long).
  static let root: URL = {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n0b-tests")
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-3600)
    for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where name.hasPrefix("jobs-") {
      let url = root.appendingPathComponent(name)
      if let made = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date, made < cutoff {
        try? fm.removeItem(at: url)
      }
    }
    return root
  }()

  static func atlas() throws -> String {
    let dir = root.appendingPathComponent("jobs-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let path = dir.appendingPathComponent("atlas.sqlite").path
    let c = try Connection(path: path, mode: .readWrite, profile: .device)
    try Migrations.migrate(c)
    try c.exec("""
      INSERT INTO corpus (id, slug, name, kind, created_at) VALUES (1, 'user', 'User', 'user', 't');
      INSERT INTO source_adapter (id, version, label, access) VALUES ('file.csv', '1', 'CSV', 'local-file');
      INSERT INTO collection (id, corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, created_at)
        VALUES (1, 1, 'file.csv', 'c', 'C', 'imported', 'text', 'tokens', 'user', 't');
      """)
    c.close()
    return path
  }

  func status(_ id: JobID) async throws -> JobStatus? { try await queue.job(id)?.status }
}

/// A lock-protected value that closures can share (Mutex itself cannot be captured by escaping closures).
final class Locked<Value: Sendable>: Sendable {
  private let m: Mutex<Value>
  init(_ v: Value) { m = Mutex(v) }
  func withLock<R>(_ body: (inout Value) -> R) -> R { m.withLock { body(&$0) } }
  var value: Value { m.withLock { $0 } }
}
