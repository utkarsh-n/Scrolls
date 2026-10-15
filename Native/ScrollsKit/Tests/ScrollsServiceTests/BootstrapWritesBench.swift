// OWNER: N2 (task bootstrap-writes, 2026-10-14)
// The write volume of Cipher's bootstrap, measured on the Mac. His iPhone filed a diskwrites_resource report during the
// first Cipher import (1.07 GB of file-backed memory dirtied; the heaviest stack ended in Writer.checkpoint under
// DocumentWriter.drain). This runs the real phases (A, then A2) from the starter and packs of SCROLLS_PACKS_DIR (default
// ~/Developer/scrolls-packs/current) in a fresh root under SCROLLS_BENCH_ROOTS (default ~/Developer/scrolls-build/
// bench-roots; never ~/Documents) and reports, per phase, the process's proc_pid_rusage(RUSAGE_INFO_V4) deltas —
// ri_logical_writes is what iOS's diskwrites limit counts, ri_diskio_byteswritten what reached the disk — with the
// writer's transactions, explicit checkpoints and WAL pages, the atlas size and the pack size; then the §6.8
// reconciliation counts and the LogicalDump fingerprints of the result (equal fingerprints = same rows, same FTS
// contents). Slow, so it runs only with SCROLLS_BENCH=1 (run it alone: `--filter BootstrapWritesBench`, since the
// counters are the whole process's). SCROLLS_BENCH_THROUGH = A | A2 (default A2; phase B needs cipher-text),
// SCROLLS_BENCH_OUT = a file for the JSON report (printed otherwise), SCROLLS_BENCH_CHUNK_SECONDS and SCROLLS_BENCH_DUMP
// (below), SCROLLS_BENCH_KEEP=1 keeps the root.

import Darwin
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsSources
@testable import ScrollsService
import ScrollsStore
import Testing

private let env = ProcessInfo.processInfo.environment

/// This process's I/O counters.
struct IOCounters {
  /// `ri_logical_writes`: bytes of file-backed memory the process dirtied (what the iOS diskwrites limit counts).
  var logicalWrites: UInt64
  /// `ri_diskio_byteswritten`: bytes the process's I/O wrote to disk.
  var diskBytesWritten: UInt64

  static func now() -> IOCounters {
    var info = rusage_info_v4()
    let rc = withUnsafeMutablePointer(to: &info) { p in
      p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
    }
    precondition(rc == 0, "proc_pid_rusage failed: \(errno)")
    return IOCounters(logicalWrites: info.ri_logical_writes, diskBytesWritten: info.ri_diskio_byteswritten)
  }
}

/// Bytes of the files under `dir` (the atlas and its -wal/-shm, the notebook).
private func bytes(under dir: URL) -> Int {
  guard let walk = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
  var n = 0
  for case let u as URL in walk { n += (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
  return n
}

private func fileBytes(_ path: String) -> Int {
  ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? 0
}

private func mb(_ n: some BinaryInteger) -> JSONValue { .number((Double(n) / 1_048_576 * 100).rounded() / 100) }

@Suite("Bootstrap writes (SCROLLS_BENCH=1)", .serialized)
struct BootstrapWritesBench {
  @Test("Cipher phases A and A2 from the starter: bytes dirtied, transactions, checkpoints, result fingerprints",
        .enabled(if: env["SCROLLS_BENCH"] == "1"), .timeLimit(.minutes(180)))
  func bootstrapWrites() async throws {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let packs = URL(fileURLWithPath: env["SCROLLS_PACKS_DIR"] ?? home.appendingPathComponent("Developer/scrolls-packs/current").path)
    let roots = URL(fileURLWithPath: env["SCROLLS_BENCH_ROOTS"] ?? home.appendingPathComponent("Developer/scrolls-build/bench-roots").path)
    #expect(!roots.path.hasPrefix(home.appendingPathComponent("Documents").path), "SQLite never runs inside iCloud")
    let through = try #require(BootstrapCipher.Phase(rawValue: env["SCROLLS_BENCH_THROUGH"] ?? "A2"))
    try #require(through != .b, "phase B needs the cipher-text pack; this bench measures A and A2")
    let starter = packs.appendingPathComponent("starter.atlas")
    PackLibrary.addSearchDirectory(packs)
    // SCROLLS_BENCH_CHUNK_SECONDS: the long loads' chunk (default 20 s, the phone's). A chunk longer than the load makes
    // the import batches the same in every run, so two runs' fingerprints can be compared table by table.
    let savedPipelines = SourcePipelines.configuration
    if let s = env["SCROLLS_BENCH_CHUNK_SECONDS"].flatMap(Int.init) {
      var c = savedPipelines
      c.chunk = .seconds(s)
      SourcePipelines.configure(c)
    }
    defer { SourcePipelines.configure(savedPipelines) }
    let pack = try #require(PackLibrary.url(of: CipherPacks.meta, atlasPath: nil), "no cipher-meta pack in \(packs.path)")

    let root = roots.appendingPathComponent("run-\(StoreClock.isoNow().replacingOccurrences(of: ":", with: ""))-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { if env["SCROLLS_BENCH_KEEP"] != "1" { try? FileManager.default.removeItem(at: root) } }
    let location = try AtlasLocation.at(root: root)
    // The bundled starter carries journal_applied rows 1…4 (the tour's trackExpression acts) while a fresh notebook's
    // journal starts at 1, so the first journaled commit (phase A's last) fails "UNIQUE constraint failed:
    // journal_applied.seq" (measured here; LiveAtlas.cloneStarter also copies only atlas.sqlite, so the app's notebook
    // starts at 1 too — reported in Docs/status/I.md, bootstrap-writes). The bench pads its own notebook past them.
    let applied = try {
      let c = try Connection(path: starter.appendingPathComponent("atlas.sqlite").path, mode: .readOnly, profile: .reference)
      defer { c.close() }
      return UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0
    }()
    do {
      let journal = try JournalFile(directory: location.notebookDir)
      while await journal.head < applied { _ = try await journal.append(.viewDelete(slug: "bench-pad"), actor: "bench") }
    }
    let engine = try await AtlasEngine.open(location, origin: .starter(starter))
    let startBytes = bytes(under: location.atlasDir)

    var phases: [JSONValue] = []
    var totals = (logical: UInt64(0), disk: UInt64(0))
    for phase in BootstrapCipher.Phase.allCases {
      let files = try await PackLibrary.files(phase.packs, atlasPath: location.atlasPath)
      let io0 = IOCounters.now(), w0 = await engine.writer.stats, t0 = ContinuousClock.now, before = bytes(under: location.atlasDir)
      let snap = try await engine.run(JobSpec(type: BootstrapCipher.type, params: ["phase": .string(phase.rawValue)],
                                              priority: phase.priority, journal: BootstrapCipher.journalOp(phase, files: files)))
      let io1 = IOCounters.now(), w1 = await engine.writer.stats, took = SourceSelfTest.seconds(ContinuousClock.now - t0)
      #expect(snap.status == .succeeded, "phase \(phase.rawValue): \(snap.error?.message ?? snap.message ?? "")")
      let after = bytes(under: location.atlasDir)
      let logical = io1.logicalWrites - io0.logicalWrites, disk = io1.diskBytesWritten - io0.diskBytesWritten
      totals.logical += logical
      totals.disk += disk
      phases.append(.object([
        "phase": .string(phase.rawValue), "seconds": .number((took * 10).rounded() / 10),
        "logical_writes_mb": mb(logical), "disk_bytes_written_mb": mb(disk),
        "transactions": .number(Double(w1.transactions - w0.transactions)),
        "explicit_checkpoints": .number(Double(w1.checkpoints - w0.checkpoints)),
        "wal_pages_written": .number(Double(w1.pagesWritten - w0.pagesWritten)),
        "atlas_dir_mb_before": mb(before), "atlas_dir_mb_after": mb(after),
        "wal_mb_after": mb(fileBytes(location.atlasPath + "-wal")),
        "logical_writes_per_atlas_mb_added": .number((Double(logical) / Double(max(1, after - before)) * 100).rounded() / 100),
      ]))
      if phase == through { break }
    }
    let io0 = IOCounters.now()
    await engine.close()  // the TRUNCATE checkpoint of the rest of the WAL
    let io1 = IOCounters.now()
    let closeLogical = io1.logicalWrites - io0.logicalWrites
    totals.logical += closeLogical
    totals.disk += io1.diskBytesWritten - io0.diskBytesWritten
    let atlasFile = fileBytes(location.atlasPath), packBytes = fileBytes(pack.path)

    // the result: the §6.8 counts, and the LogicalDump fingerprints (masked timestamps, natural keys)
    let c = try Connection(path: location.atlasPath, mode: .readOnly, profile: .device)
    defer { c.close() }
    let rows = SourceSelfTest.reconciliation(try BootstrapPhases.reconcile(c, expected: nil), through: through)
    for r in rows { #expect(r.status != .fail, "\(r.name): \(r.detail)") }
    let fingerprints = try GenerationManifest.fingerprints(c, text: ChunkedTextStore(), scratch: root.appendingPathComponent("dump"))
    if let dir = env["SCROLLS_BENCH_DUMP"] {  // the tables that differ between runs, kept for a diff
      _ = try LogicalDump.dump(c, text: ChunkedTextStore(), to: URL(fileURLWithPath: dir), tables: ["meta", "analysis_run", "import_batch", "date_assertion"])
    }

    let report: JSONValue = .object([
      "pack": .string(pack.lastPathComponent), "pack_mb": mb(packBytes), "starter_atlas_mb": mb(startBytes),
      "phases": .array(phases), "close_logical_writes_mb": mb(closeLogical),
      "total_logical_writes_mb": mb(totals.logical), "total_disk_bytes_written_mb": mb(totals.disk),
      "atlas_file_mb": mb(atlasFile),
      "logical_writes_per_pack_mb": .number((Double(totals.logical) / Double(max(1, packBytes)) * 100).rounded() / 100),
      "logical_writes_per_atlas_mb_added": .number((Double(totals.logical) / Double(max(1, atlasFile - startBytes)) * 100).rounded() / 100),
      "reconciliation": .array(rows.map { .string("\($0.status.rawValue) \($0.name): \($0.detail)") }),
      "fingerprints": .object(JSONObject(fingerprints.map {
        ($0.key, JSONValue.object(["rows": .number(Double($0.value.rows)), "sha256": .string($0.value.sha256)]))
      })),
    ])
    let text = CanonicalJSON.string(report)
    if let out = env["SCROLLS_BENCH_OUT"] {
      try Data(text.utf8).write(to: URL(fileURLWithPath: out))
    } else {
      print(text)
    }
  }
}
