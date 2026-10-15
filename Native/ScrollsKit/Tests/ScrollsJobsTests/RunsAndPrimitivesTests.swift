// OWNER: N0
// Runs (port of context.mjs: input fingerprint equal to Node's, reuse on stage/params/inputs/code hash, the guarded
// commit's E_INPUTS_CHANGED), work-stealing `concurrentMap` (order kept, workers used, cancellation), and
// `BoundedChannel` (backpressure, FIFO, finish, a cancelled sender).

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsJobs
@testable import ScrollsStore
import Synchronization
import Testing

@Suite("Runs")
struct RunsTests {
  /// Node's `inputFingerprint` (server/jobs/context.mjs) on the committed mini database, computed by the reference.
  static let nodeFingerprints: [(scope: JSONValue, upstream: [Int64], fp: String)] = [
    ([:], [], "564f444f0cc8423c40b1460014bb22a7f49ecb913e62d639f4ccd00cd4224aa1"),
    (["collections": ["mini"]], [3, 1], "961862cd8802294f1b77fa0c4dc8c0f6dad4c775bae3987327682f1e38cd3633"),
    (["collections": ["nope"], "lang": "en"], [], "cf8a31bfa281560cd481925a4026558bde70643f9f6ee04b7b9aafdb8472750b"),
    (["collections": [1]], [2], "2d77c342c9dbef0ae7b61b2f5742bdbf82acacbdab13e1ac1dff06db85db5361"),
  ]

  @Test("the input fingerprint equals the reference's on the mini database")
  func fingerprintParity() throws {
    let mini = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("ScrollsStoreTests/Fixtures/mini-dump/mini.sqlite")
    let c = try Connection(path: mini.path, mode: .readOnlyImmutable, profile: .reference)
    for (scope, upstream, fp) in Self.nodeFingerprints {
      #expect(try Runs.inputFingerprint(c, scope: scope, upstream: upstream.map { RunID(rawValue: $0) }) == fp, "scope \(scope)")
    }
  }

  @Test("startRun opens a run with the reference's columns; a succeeded run with the same key is reused")
  func startAndReuse() async throws {
    let f = try QueueFixture()
    let first = try await f.queue.enqueue(JobSpec(type: AnalysisTask.type, params: ["key": "reuse"]))
    let a = await f.queue.wait(for: first)
    #expect(a?.status == .succeeded && a?.result?["reused"] == false)
    let row = try await f.reads.read { c in
      try c.prepared(dynamic: """
        SELECT stage, pipeline_version, code_hash, params_json, params_hash, scope_json, status, seed, job_id, metrics_json,
          tokenizer_version, segmenter_version, upstream_run_ids FROM analysis_run
        """).first { r in (0..<r.count).map { r.value($0) } }
    }
    #expect(row?[0] == .text("cluster") && row?[1] == .text("cluster@\(BuildInfo.engineVersion)"))
    #expect(row?[2] == .text(BuildInfo.codeHash(stage: "cluster")))
    #expect(row?[3] == .text(#"{"k":3}"#) && row?[4] == .text(Runs.sha256(#"{"k":3}"#)) && row?[5] == .text(#"{"collections":["c"]}"#))
    #expect(row?[6] == .text("succeeded") && row?[7] == .int(7) && row?[8] == .int(first.rawValue) && row?[9] == .text(#"{"k":3}"#))
    #expect(row?[10] == .text("u61m-1") && row?[11] == .text("seg-1") && row?[12] == .text("[]"))
    let second = try await f.queue.enqueue(JobSpec(type: AnalysisTask.type, params: ["key": "reuse"]))
    let b = await f.queue.wait(for: second)
    #expect(b?.status == .succeeded && b?.result?["reused"] == true && b?.result?["run"] == a?.result?["run"])
  }

  @Test("commitRun refuses with E_INPUTS_CHANGED when an import commits while the analysis runs; the run is failed")
  func inputsChanged() async throws {
    let f = try QueueFixture()
    let key = "inputs-\(UUID().uuidString)"
    let id = try await f.queue.enqueue(JobSpec(type: AnalysisTask.type, params: ["key": .string(key), "wait": true]))
    while TaskLog.entries(key).isEmpty { try await Task.sleep(for: .milliseconds(10)) }
    try await f.writer.write("an import commits") { tx in
      try tx.connection.exec("INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, format, status, created_at) VALUES (1, 1, 'file.csv', '1', 'csv', 'committed', 't')")
    }
    AnalysisTask.gate.withLock { $0[key] = true }
    let done = await f.queue.wait(for: id)
    #expect(done?.status == .failed && done?.error?.code == "E_INPUTS_CHANGED")
    let runs = try await f.reads.read { c in try c.prepared(dynamic: "SELECT status FROM analysis_run").all { $0.text(0) } }
    #expect(runs == ["failed"])
    let windows = try await f.reads.read { c in try c.prepared(dynamic: "SELECT count(*) FROM time_window").first { $0.int(0) } }
    #expect(windows == 0)
  }
}

@Suite("Fan-out and channels")
struct PrimitivesTests {
  static func context(_ conditions: any DeviceConditionsSource = Unthrottled()) throws -> JobContext {
    let f = try QueueFixture()
    return JobContext(id: JobID(rawValue: 1), type: SleepTask.type, reads: f.reads, writer: f.writer, text: ChunkedTextStore(),
                      journal: nil, journalOp: nil, actor: "scrolls", writes: .none, priority: 5, conditions: conditions,
                      onEvent: { _, _ in })
  }

  @Test("concurrentMap keeps input order and uses several workers")
  func orderAndWorkers() async throws {
    let ctx = try Self.context()
    let threads = Locked<Set<UInt64>>([])
    // ~50 µs of work per item: enough that the other workers claim chunks before the first one is done
    let out = try await ctx.concurrentMap(Array(0..<4_000)) { (i: Int) -> Int in
      var tid: UInt64 = 0
      pthread_threadid_np(nil, &tid)
      _ = threads.withLock { $0.insert(tid) }
      let until = ContinuousClock.now + .microseconds(50)
      while ContinuousClock.now < until {}
      return i * 2
    }
    #expect(out == (0..<4_000).map { $0 * 2 })
    #expect(threads.value.count >= 2, "one worker thread did all the work")
    #expect(ctx.parallelism == 6)
    #expect(try await ctx.concurrentMap([Int]()) { $0 }.isEmpty)
  }

  @Test("concurrentMap stops at a checkpoint when the job is cancelled, and rethrows a worker's error")
  func cancelAndErrors() async throws {
    let ctx = try Self.context()
    ctx.requestCancel()
    await #expect(throws: CancellationError.self) {
      _ = try await ctx.concurrentMap(Array(0..<1000)) { $0 }
    }
    let ok = try Self.context()
    await #expect(throws: StoreError.self) {
      _ = try await ok.concurrentMap(Array(0..<1000)) { i in
        if i == 777 { throw StoreError.misuse("boom") }
        return i
      }
    }
    let serious = TestConditions()
    serious.set(.serious)
    #expect(try Self.context(serious).parallelism == 1)
  }

  @Test("BoundedChannel: send suspends while full, elements arrive in order, finish drains then ends")
  func backpressure() async throws {
    let ch = BoundedChannel<Int>(capacity: 4)
    let sent = Locked(0)
    let producer = Task {
      for i in 0..<100 {
        try await ch.send(i)
        sent.withLock { $0 += 1 }
      }
      await ch.finish()
    }
    try await Task.sleep(for: .milliseconds(200))
    #expect(sent.value == 4, "the producer ran ahead of a full channel")
    var got: [Int] = []
    while let x = await ch.next() { got.append(x) }
    try await producer.value
    #expect(got == Array(0..<100))
    await #expect(throws: ChannelClosed.self) { try await ch.send(1) }
  }

  @Test("BoundedChannel: a cancelled sender leaves the queue with CancellationError; the next sender is served")
  func cancelledSender() async throws {
    let ch = BoundedChannel<String>(capacity: 1)
    try await ch.send("a")
    let blocked = Task { try await ch.send("b") }
    try await Task.sleep(for: .milliseconds(100))
    blocked.cancel()
    let r = await blocked.result
    #expect(throws: CancellationError.self) { try r.get() }
    let next = Task { try await ch.send("c") }
    #expect(await ch.next() == "a")
    try await next.value
    #expect(await ch.next() == "c")
    await ch.finish()
    #expect(await ch.next() == nil)
  }
}
