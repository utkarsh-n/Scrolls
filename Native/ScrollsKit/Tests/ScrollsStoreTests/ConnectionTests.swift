// OWNER: N0
// The SQLite layer (IOS-SPEC §1.4, §1.5): PRAGMAs by role, binds and reads (the UTF-16 fast path included), the
// statement LRU, savepoint nesting, WAL readers on one snapshot, interruption acknowledged ≤ 500 ms, the deadline
// producing QUERY_TIMEOUT, the reader lanes, drain/reopen, and the writer's transactions, data version and lease.

import Dispatch
import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Synchronization
import Testing

/// A statement that runs for a long time (≈ 10⁹ VM steps) unless interrupted.
let longQuery = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT count(*) FROM n"

@Suite("SQLite connections")
struct ConnectionTests {
  @Test("PRAGMAs: writer WAL/NORMAL/64 MB/no mmap; readers query_only/32 MB/mmap; all foreign keys, busy 5 s, temp in memory")
  func pragmas() throws {
    let path = try Fixtures.atlas()
    let w = try Connection(path: path, mode: .readWrite, profile: .device)
    let r = try Connection(path: path, mode: .readOnly, profile: .device, mmapBytes: 256 << 20)
    func pragma(_ c: Connection, _ p: String) throws -> String { try c.prepared(dynamic: "PRAGMA \(p)").first { $0.text(0) } ?? "" }
    #expect(try pragma(w, "journal_mode") == "wal")
    #expect(try pragma(w, "synchronous") == "1")
    #expect(try pragma(w, "cache_size") == "-65536")
    #expect(try pragma(w, "mmap_size") == "0")
    #expect(try pragma(w, "wal_autocheckpoint") == "1000")
    #expect(try pragma(r, "query_only") == "1")
    #expect(try pragma(r, "cache_size") == "-32768")
    #expect(try pragma(r, "mmap_size") == String(256 << 20))
    for c in [w, r] {
      #expect(try pragma(c, "foreign_keys") == "1")
      #expect(try pragma(c, "busy_timeout") == "5000")
      #expect(try pragma(c, "temp_store") == "2")
    }
    #expect(throws: StoreError.self) { try r.exec("INSERT INTO meta(key, value) VALUES ('x', 'y')") }
  }

  @Test("binds and reads: integers, doubles, text with NUL/emoji/empty, blobs, NULL; utf16 is the D4 offset space")
  func bindAndRead() throws {
    let c = try Connection(path: ":memory:", mode: .readWrite, profile: .reference)
    try c.exec("CREATE TABLE t (a, b, c, d, e)")
    let text = "a\u{0}b é 😀 शून्य"
    let ins = try c.prepared(dynamic: "INSERT INTO t VALUES (?, ?, ?, ?, ?)")
    try ins.bind(.int(Int64(Int32.max) + 5), .double(-0.1), .text(text), .blob([0, 1, 255]), .null)
    try ins.run()
    try ins.bind(.int(0), .double(0), .text(""), .blob([]), .text("x"))
    try ins.run()
    let rows = try c.prepared(dynamic: "SELECT a, b, c, d, e FROM t ORDER BY rowid").all { r in
      (r.int(0), r.double(1), r.text(2), r.blob(3), r.isNull(4), Array(r.utf16(2)), r.value(3))
    }
    #expect(rows[0].0 == Int64(Int32.max) + 5 && rows[0].1 == -0.1 && rows[0].2 == text && rows[0].3 == [0, 1, 255] && rows[0].4)
    #expect(rows[0].5 == Array(text.utf16))
    #expect(rows[1].2 == "" && rows[1].3.isEmpty && !rows[1].4 && rows[1].6 == .blob([]))
    #expect(throws: StoreError.self) { try ins.bind(.int(1)) }
  }

  @Test("statement LRU: 128 catalogued statements stay prepared; an evicted one stays usable by its holder")
  func statementCache() throws {
    let c = try Connection(path: ":memory:", mode: .readWrite, profile: .reference)
    let held = try c.prepared(SQL("held", "SELECT 41 + 1"))
    for i in 0..<200 { _ = try c.prepared(SQL("q\(i)", "SELECT \(i)")) }
    #expect(try held.first { $0.int(0) } == 42)
    let again = try c.prepared(SQL("q199", "SELECT 199"))
    #expect(try again.first { $0.int(0) } == 199)
  }

  @Test("nested transactions become savepoints: an inner failure rolls back only the inner work")
  func savepoints() throws {
    let c = try Connection(path: ":memory:", mode: .readWrite, profile: .reference)
    try c.exec("CREATE TABLE t (x INTEGER)")
    try c.transaction(.immediate) {
      try c.exec("INSERT INTO t VALUES (1)")
      _ = try? c.transaction { () throws -> Void in
        try c.exec("INSERT INTO t VALUES (2)")
        throw StoreError.misuse("inner")
      }
      try c.exec("INSERT INTO t VALUES (3)")
    }
    #expect(try c.prepared(dynamic: "SELECT group_concat(x) FROM t").first { $0.text(0) } == "1,3")
    #expect(!c.isInTransaction)
  }

  @Test("InterruptHandle stops a running statement from another thread within 500 ms")
  func interruptHandle() async throws {
    let c = try Connection(path: ":memory:", mode: .readWrite, profile: .reference)
    let handle = c.interruptHandle
    let interruptedAt = Locked<ContinuousClock.Instant?>(nil)
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(200)) {
      interruptedAt.withLock { $0 = ContinuousClock.now }
      handle.interrupt()
    }
    let e = #expect(throws: StoreError.self) { try c.prepared(dynamic: longQuery).first { $0.int(0) } }
    let stopped = ContinuousClock.now
    #expect(e?.isInterrupt == true)
    let asked = try #require(interruptedAt.value)
    #expect(stopped - asked <= .milliseconds(500), "acknowledged after \(stopped - asked)")
  }
}

@Suite("Read pool and writer")
struct ReadPoolTests {
  @Test("WAL readers see one snapshot for the whole request; the next request sees the commit")
  func oneSnapshot() async throws {
    let (_, writer, reads) = try Fixtures.store()
    let inside = DispatchSemaphore(value: 0), committed = DispatchSemaphore(value: 0)
    async let counts: (Int64, Int64) = reads.read { c in
      let a = try c.prepared(dynamic: "SELECT count(*) FROM corpus").first { $0.int(0) } ?? -1
      inside.signal()
      committed.wait()
      let b = try c.prepared(dynamic: "SELECT count(*) FROM corpus").first { $0.int(0) } ?? -1
      return (a, b)
    }
    await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
      DispatchQueue.global().async { inside.wait(); k.resume() }
    }
    try await writer.write("insert") { tx in
      try tx.connection.exec("INSERT INTO corpus (id, slug, name, kind, created_at) VALUES (99, 'x', 'X', 'user', 't')")
    }
    committed.signal()
    let (a, b) = try await counts
    #expect(a == b, "a reader saw a commit in the middle of its request")
    let after = try await reads.read { c in try c.prepared(dynamic: "SELECT count(*) FROM corpus").first { $0.int(0) } }
    #expect(after == a + 1)
  }

  @Test("cancelling a read interrupts its statement: acknowledged within 500 ms (CancellationError)")
  func cancelRead() async throws {
    let (_, _, reads) = try Fixtures.store()
    let task = Task { try await reads.read(deadline: .seconds(60)) { c in try c.prepared(dynamic: longQuery).first { $0.int(0) } } }
    try await Task.sleep(for: .milliseconds(300))
    let cancelled = ContinuousClock.now
    task.cancel()
    let result = await task.result
    let elapsed = ContinuousClock.now - cancelled
    #expect(throws: CancellationError.self) { try result.get() }
    #expect(elapsed <= .milliseconds(500), "acknowledged after \(elapsed)")
    try await recordTiming("interrupt-ack-ms", elapsed)
    // the reader is healthy afterwards
    #expect(try await reads.read { c in try c.prepared(dynamic: "SELECT 1").first { $0.int(0) } } == 1)
  }

  @Test("the deadline stops a long read with QUERY_TIMEOUT (the reference's message and hint)")
  func deadline() async throws {
    let (_, _, reads) = try Fixtures.store()
    let started = ContinuousClock.now
    let e = await #expect(throws: ScrollsError.self) {
      try await reads.read(deadline: .milliseconds(300)) { c in try c.prepared(dynamic: longQuery).first { $0.int(0) } }
    }
    let elapsed = ContinuousClock.now - started
    #expect(e?.code.rawValue == "QUERY_TIMEOUT")
    #expect(e?.message == "The query took longer than 300 ms and was stopped.")
    #expect(elapsed < .milliseconds(1300), "stopped after \(elapsed)")
    try await recordTiming("deadline-300ms-stop-ms", elapsed)
  }

  @Test("lanes: job reads never take reader 0 nor more than one shared reader; interactive reads still run")
  func lanes() async throws {
    let (_, _, reads) = try Fixtures.store()
    let release = DispatchSemaphore(value: 0)
    let running = Locked(0)
    let jobs = (0..<3).map { _ in
      Task {
        try await reads.read(.job, deadline: .seconds(30)) { _ in
          running.withLock { $0 += 1 }
          release.wait()
          return 0
        }
      }
    }
    try await Task.sleep(for: .milliseconds(300))
    #expect(running.value == 1, "job reads running at once: \(running.value)")
    #expect(reads.load.waiting == 2)
    // two interactive reads still find readers (0 and the other shared one)
    async let a = reads.read { c in try c.prepared(dynamic: "SELECT 1").first { $0.int(0) } }
    async let b = reads.read { c in try c.prepared(dynamic: "SELECT 2").first { $0.int(0) } }
    #expect(try await [a, b] == [1, 2])
    for _ in 0..<3 { release.signal() }
    for j in jobs { _ = try await j.value }
    #expect(reads.load.inFlight == 0)
  }

  @Test("a cancelled waiter leaves the queue at once")
  func cancelledWaiter() async throws {
    let (_, _, reads) = try Fixtures.store(readers: 2)
    let release = DispatchSemaphore(value: 0)
    let holders = (0..<2).map { _ in Task { try await reads.read { _ in release.wait(); return 0 } } }
    try await Task.sleep(for: .milliseconds(200))
    let waiter = Task { try await reads.read { _ in 1 } }
    try await Task.sleep(for: .milliseconds(100))
    #expect(reads.load.waiting == 1)
    waiter.cancel()
    let outcome = await waiter.result
    #expect(throws: CancellationError.self) { try outcome.get() }
    #expect(reads.load.waiting == 0)
    release.signal()
    release.signal()
    for h in holders { _ = try await h.value }
  }

  @Test("drain waits for in-flight reads and refuses new ones; reopen serves again")
  func drainAndReopen() async throws {
    let (path, _, reads) = try Fixtures.store()
    let release = DispatchSemaphore(value: 0)
    let slow = Task { try await reads.read { _ in release.wait(); return 7 } }
    try await Task.sleep(for: .milliseconds(150))
    let drained = Task { await reads.drain() }
    try await Task.sleep(for: .milliseconds(150))
    let refused = await #expect(throws: ScrollsError.self) { try await reads.read { _ in 1 } }
    #expect(refused?.code.rawValue == "E_ATLAS_SWAPPING")
    release.signal()
    #expect(try await slow.value == 7)
    await drained.value
    try await reads.reopen(path: path)
    #expect(try await reads.read { c in try c.prepared(dynamic: "SELECT 3").first { $0.int(0) } } == 3)
  }

  @Test("the writer: one IMMEDIATE transaction, rollback on error, data_version bumps announced after commit")
  func writer() async throws {
    let (_, writer, reads) = try Fixtures.store()
    let seen = Locked<[Int]>([])
    await writer.setCommitObserver { v in seen.withLock { $0.append(v) } }
    let v = try await writer.write("bump") { tx in try tx.bumpDataVersion() }
    #expect(v == 1)
    await #expect(throws: StoreError.self) {
      try await writer.write("fails") { tx in
        try tx.bumpDataVersion()
        try tx.connection.exec("INSERT INTO nowhere VALUES (1)")
      }
    }
    #expect(seen.value == [1])
    #expect(try await reads.read { c in try Meta.dataVersion(c) } == 1)
    let status = try await writer.checkpoint(.passive)
    #expect(!status.busy)
    _ = try await writer.checkpoint(.truncate)
    #expect(await writer.walBytes == 0)
  }

  @Test("a bulk lease yields between batches: an interactive write waits at most one batch")
  func leaseYields() async throws {
    let (_, writer, _) = try Fixtures.store()
    let lease = await writer.lease(for: JobID(rawValue: 1))
    let bulk = Task {
      for i in 0..<20 {
        _ = try await lease.batch("bulk \(i)") { tx in
          let until = ContinuousClock.now + .milliseconds(50)
          while ContinuousClock.now < until {}  // a 50 ms batch
          try tx.connection.exec("INSERT INTO meta(key, value) VALUES ('bulk\(i)', 'x')")
        }
      }
    }
    try await Task.sleep(for: .milliseconds(120))
    let asked = ContinuousClock.now
    try await writer.write("interactive") { tx in try Meta.set(tx.connection, "interactive", "1") }
    let waited = ContinuousClock.now - asked
    try await bulk.value
    await lease.end()
    #expect(waited < .milliseconds(400), "the interactive write waited \(waited)")
  }

  @Test("recordJournalApplied writes journal_applied (max ids of the cutoff tables) and meta.journal_applied_seq")
  func journalApplied() async throws {
    let (_, writer, reads) = try Fixtures.store()
    let entry = try JournalEntry(seq: 1, at: "t", actor: "human:utkarsh", op: .viewDelete(slug: "v"))
    try await writer.write("apply") { tx in
      try tx.connection.exec("""
        INSERT INTO source_adapter (id, version, label, access) VALUES ('file.csv', '1', 'CSV', 'local-file');
        INSERT INTO import_batch (id, adapter_id, adapter_version, format, status, created_at) VALUES (12, 'file.csv', '1', 'csv', 'committed', 't');
        """)
      try tx.recordJournalApplied(entry)
    }
    let row = try await reads.read { c in
      try c.prepared(dynamic: "SELECT seq, op, max_ids_json FROM journal_applied").first { ($0.int(0), $0.text(1), $0.text(2)) }
    }
    #expect(row?.0 == 1 && row?.1 == "viewDelete")
    #expect(row?.2 == #"{"annotation_revision":0,"import_batch":12,"relationship_revision":0}"#)
    #expect(try await reads.read { c in try Meta.get(c, "journal_applied_seq") } == "1")
  }
}

/// Records a measured timing in Reports/store-timings.json (`{name: {ms, at}}`) when SCROLLS_REPORTS_DIR is set.
func recordTiming(_ name: String, _ d: Duration) async throws {
  guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
  let ms = Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
  let text = Timings.store.withLock { t -> String in
    t[name] = .object(["ms": .number((ms * 10).rounded() / 10), "at": .string(StoreClock.isoNow())])
    return CanonicalJSON.string(.object(t))
  }
  try Data(text.utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("store-timings.json"))
}

enum Timings {
  static let store = Locked(JSONObject())
}
