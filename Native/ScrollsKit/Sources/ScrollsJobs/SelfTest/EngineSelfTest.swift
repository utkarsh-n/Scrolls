// OWNER: N0
// The Store and Jobs rows of IOS-SPEC §8.4.10 item 2 that only the device can time (the device rows N0b queued):
// a cancelled read and a cancelled job acknowledged within 500 ms, QUERY_TIMEOUT at a 300 ms deadline, the stall rule
// (§3.7: progress advances at least every 2 s while one SQL statement runs), and the decode cost of one 32,768-unit
// text chunk (§3.4). Each check runs in a scratch atlas of its own under a temporary directory, deleted afterwards, so a
// self-test never touches his atlas or notebook (§6.6). The app's N0 steps call these in `-selftest probe` (the fast
// rows) and `-selftest perf` (the stall rule); the Mac's unit tests measure the same things in ScrollsStoreTests and
// ScrollsJobsTests.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Device timings of the SQLite layer and the job system, as probe rows.
public enum EngineSelfTest {
  /// The acknowledgement bound of §1.5 and §1.4.
  public static let acknowledgementBound: Duration = .milliseconds(500)

  /// Read interrupt, read deadline, job cancellation (a compute loop and a running statement) and chunk decode cost.
  /// `sample` is real text for the chunk measurement (the app passes a bundled probe book); nil uses a fixed mix of
  /// Latin, Devanagari and Gujarati.
  @concurrent
  public static func acknowledgements(in directory: URL, sample: String?) async -> [ProbeCheck] {
    await withScratchAtlas(in: directory, name: "engine.acknowledgements") { reads, queue in
      [await readInterrupt(reads), await readDeadline(reads), await jobCancel(queue, task: SpinTask.type, name: "compute loop"),
       await jobCancel(queue, task: LongReadTask.type, name: "running statement"), chunkDecode(sample)]
    }
  }

  /// The stall rule: one job whose single SQL statement runs for `seconds` must advance its Progress at least
  /// `seconds / 2` times, never standing still for 2 s (the spec's test runs 30 s and wants ≥ 15).
  @concurrent
  public static func stallRule(in directory: URL, seconds: Int = 30) async -> [ProbeCheck] {
    await withScratchAtlas(in: directory, name: "engine.stall_rule") { _, queue in [await stall(queue, seconds: seconds)] }
  }

  // MARK: the scratch atlas

  private static func withScratchAtlas(in directory: URL, name: String,
                                       _ body: (ReadPool, JobQueue) async -> [ProbeCheck]) async -> [ProbeCheck] {
    let dir = directory.appendingPathComponent("scrolls-engine-selftest-\(UUID().uuidString.prefix(8))")
    defer { try? FileManager.default.removeItem(at: dir) }
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let path = dir.appendingPathComponent("atlas.sqlite").path
      let c = try Connection(path: path, mode: .readWrite, profile: .device)
      try Migrations.migrate(c)
      c.close()
      let writer = try Writer(path: path, profile: .device)
      // small mmap windows: the mapping budget is process-wide and the self-test must not take the live atlas's share
      let reads = try ReadPool(path: path, profile: .device, mmapBytesPerReader: 8 << 20)
      let queue = JobQueue(reads: reads, writer: writer, text: ChunkedTextStore(), registry: [SpinTask.self, LongReadTask.self],
                           conditions: Unthrottled(), journal: nil)
      let checks = await body(reads, queue)
      await queue.suspendAll(within: .seconds(1))
      await reads.close()
      try? await writer.close()
      return checks
    } catch {
      return [ProbeCheck(name: name, status: .fail, detail: "the scratch atlas could not be made: \(error)")]
    }
  }

  // MARK: the checks

  /// An interactive read running a long statement, cancelled after 200 ms: the time until the read returns.
  static func readInterrupt(_ reads: ReadPool) async -> ProbeCheck {
    let name = "store.read_interrupt"
    let read = Task {
      try await reads.read(.interactive, deadline: .seconds(60)) { c in try c.prepared(dynamic: SelfTestSQL.longCount).first { $0.int(0) } }
    }
    try? await Task.sleep(for: .milliseconds(200))
    let t0 = ContinuousClock.now
    read.cancel()
    let result = await read.result
    let ack = ContinuousClock.now - t0
    guard case .failure = result else { return ProbeCheck(name: name, status: .fail, detail: "the statement finished instead of stopping") }
    return ProbeCheck(name: name, status: ack <= acknowledgementBound ? .pass : .fail,
                      detail: "cancelled read acknowledged in \(ms(ack)) (bound \(ms(acknowledgementBound)))")
  }

  /// A read with a 300 ms deadline: QUERY_TIMEOUT, and how long after the deadline it came.
  static func readDeadline(_ reads: ReadPool) async -> ProbeCheck {
    let name = "store.deadline"
    let deadline: Duration = .milliseconds(300)
    let t0 = ContinuousClock.now
    do {
      _ = try await reads.read(.interactive, deadline: deadline) { c in try c.prepared(dynamic: SelfTestSQL.longCount).first { $0.int(0) } }
      return ProbeCheck(name: name, status: .fail, detail: "the statement finished before its deadline")
    } catch let e as ScrollsError where e.code == .queryTimeout {
      let took = ContinuousClock.now - t0
      return ProbeCheck(name: name, status: took <= deadline + acknowledgementBound ? .pass : .fail,
                        detail: "QUERY_TIMEOUT after \(ms(took)) (deadline \(ms(deadline)))")
    } catch {
      return ProbeCheck(name: name, status: .fail, detail: "\(error) instead of QUERY_TIMEOUT")
    }
  }

  /// A running job of type `task`, cancelled: the time until the queue reports it cancelled.
  static func jobCancel(_ queue: JobQueue, task: JobType, name label: String) async -> ProbeCheck {
    let name = "jobs.cancel.\(label.replacingOccurrences(of: " ", with: "_"))"
    do {
      let id = try await queue.enqueue(JobSpec(type: task, params: ["seconds": 60]))
      let started = ContinuousClock.now
      while try await queue.job(id)?.status != .running {
        guard ContinuousClock.now - started < .seconds(10) else {
          return ProbeCheck(name: name, status: .fail, detail: "the job did not start within 10 s")
        }
        try await Task.sleep(for: .milliseconds(10))
      }
      try await Task.sleep(for: .milliseconds(200))
      let t0 = ContinuousClock.now
      await queue.cancel(id)
      let done = await queue.wait(for: id, timeout: .seconds(10))
      let ack = ContinuousClock.now - t0
      guard done?.status == .cancelled else {
        return ProbeCheck(name: name, status: .fail, detail: "ended \(done?.status.rawValue ?? "not at all") instead of cancelled")
      }
      return ProbeCheck(name: name, status: ack <= acknowledgementBound ? .pass : .fail,
                        detail: "\(label) cancelled in \(ms(ack)) (bound \(ms(acknowledgementBound)))")
    } catch {
      return ProbeCheck(name: name, status: .fail, detail: "\(error)")
    }
  }

  /// Samples the Progress of a job running one long statement every 50 ms.
  static func stall(_ queue: JobQueue, seconds: Int) async -> ProbeCheck {
    let name = "jobs.stall_rule"
    do {
      let id = try await queue.enqueue(JobSpec(type: LongReadTask.type, params: ["seconds": .number(Double(seconds))]))
      var progress: Progress?
      let begun = ContinuousClock.now
      while progress == nil {
        guard ContinuousClock.now - begun < .seconds(10) else {
          return ProbeCheck(name: name, status: .fail, detail: "the job did not start within 10 s")
        }
        progress = await queue.progress(of: id)
        if progress == nil { try await Task.sleep(for: .milliseconds(5)) }
      }
      let start = ContinuousClock.now
      var last = progress!.completedUnitCount, lastChange = start, increments = 0, maxGap: Duration = .zero
      while try await queue.job(id)?.status == .running {
        try await Task.sleep(for: .milliseconds(50))
        let now = ContinuousClock.now, value = progress!.completedUnitCount
        maxGap = max(maxGap, now - lastChange)
        if value > last {
          increments += 1
          last = value
          lastChange = now
        }
      }
      let total = ContinuousClock.now - start
      let wanted = max(1, seconds / 2)
      let ok = increments >= wanted && maxGap < .seconds(2)
      return ProbeCheck(name: name, status: ok ? .pass : .fail,
                        detail: "a \(seconds) s statement: \(increments) progress increments in \(ms(total)) (want ≥ \(wanted)), longest stand-still \(ms(maxGap)) (want < 2 s)")
    } catch {
      return ProbeCheck(name: name, status: .fail, detail: "\(error)")
    }
  }

  /// Encodes one 32,768-unit chunk the way ChunkedTextStore does and decodes it 200 times: round-trip equality and
  /// the median decode time.
  static func chunkDecode(_ sample: String?) -> ProbeCheck {
    let name = "store.chunk_decode"
    let unit = 32_768
    let mix = "The machine was set to work. शून्य का अर्थ। શૂન્યનો અર્થ. "
    var units = Array((sample ?? mix).utf16.prefix(unit))
    while units.count < unit { units += Array(mix.utf16) }
    units = Array(units.prefix(unit))
    if UTF16.isLeadSurrogate(units[unit - 1]) { units[unit - 1] = 0x20 }  // never end a chunk inside a surrogate pair
    do {
      let (codec, bytes, utf8Count) = try ChunkCodec.encode(units[...])
      var times: [Duration] = []
      for _ in 0..<200 {
        let t0 = ContinuousClock.now
        let back = try ChunkCodec.decode(codec: codec, bytes, units: unit)
        times.append(ContinuousClock.now - t0)
        guard back == units else { return ProbeCheck(name: name, status: .fail, detail: "a decoded chunk differs from its text") }
      }
      times.sort()
      let ratio = Double(utf8Count) / Double(max(bytes.count, 1))
      return ProbeCheck(name: name, status: .pass,
                        detail: "\(codec), \(Format.number(ratio))× over UTF-8; median decode \(us(times[times.count / 2])), p95 \(us(times[times.count * 95 / 100])) per \(Format.int(unit))-unit chunk")
    } catch {
      return ProbeCheck(name: name, status: .fail, detail: "\(error)")
    }
  }

  static func ms(_ d: Duration) -> String { "\(Format.number(Double(d.components.attoseconds) / 1e15 + Double(d.components.seconds) * 1000)) ms" }
  static func us(_ d: Duration) -> String { "\(Format.number(Double(d.components.attoseconds) / 1e12 + Double(d.components.seconds) * 1e6)) µs" }
}

/// A compute loop that only stops when cancelled (or after `seconds`): checkpoints every ≈ 2 ms like a kernel.
struct SpinTask: JobTask {
  static let type = JobType("selftest-spin")
  static let writes = WriteNeed.none
  static let resumable = false
  static let budget = ResourceBudget.light
  let seconds: Int
  init(params: JSONValue) throws { seconds = params["seconds"]?.safeInteger ?? 60 }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    let until = ContinuousClock.now + .seconds(seconds)
    while ContinuousClock.now < until {
      let slice = ContinuousClock.now + .milliseconds(2)
      while ContinuousClock.now < slice {}
      try await ctx.checkpoint()
    }
    return .null
  }
}

/// One long statement on the job lane, stopped by its deadline after `seconds` (or by cancellation).
struct LongReadTask: JobTask {
  static let type = JobType("selftest-long-read")
  static let writes = WriteNeed.none
  static let resumable = false
  static let budget = ResourceBudget.light
  let seconds: Int
  init(params: JSONValue) throws { seconds = params["seconds"]?.safeInteger ?? 60 }
  func run(_ ctx: JobContext) async throws -> JSONValue {
    ctx.progress(0.1, phase: "counting")
    do {
      _ = try await ctx.read(deadline: .seconds(Int64(seconds))) { c in try c.prepared(dynamic: SelfTestSQL.longCount).first { $0.int(0) } }
    } catch let e as ScrollsError where e.code == .queryTimeout {
      return ["timed_out": true]
    }
    return ["timed_out": false]
  }
}
