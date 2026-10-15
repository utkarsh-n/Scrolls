// OWNER: N6
// A test atlas for ScrollsProvenanceTests: a copy of the reference's mini database (the committed fixture of
// ScrollsStoreTests) opened with the device profile, its notebook journal, and the write-ahead protocol of
// `UserWrites.perform` + `LiveAtlas.journaledAct` (dry run → append + fsync → apply + journal_applied in one
// transaction), with the six kill points of the crash-injection tests (IOS-SPEC §6.7). Everything lives in $TMPDIR.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

/// Where a write is "killed" (the process dies there; the test then reopens the atlas and runs the catch-up).
enum KillPoint: String, CaseIterable, Sendable {
  /// Before the journal line is written: the act never happened.
  case beforeAppend
  /// The journal line is half written (no newline, a torn tail): the act never happened.
  case tornAppend
  /// The line is durable, the transaction never began: the catch-up applies it.
  case afterAppend
  /// Inside the transaction, after the rows were written (rolled back): the catch-up applies it.
  case afterApply
  /// Inside the transaction, after `journal_applied` was written (rolled back): the catch-up applies it.
  case afterRecord
  /// After the commit, before the caller saw the answer: the act is done; the catch-up does nothing.
  case afterCommit
}

struct Killed: Error {}

final class TestAtlas: @unchecked Sendable {
  let dir: URL
  let path: String
  private(set) var writer: Writer
  private(set) var journal: JournalFile
  let text: any TextStore = ChunkedTextStore()

  static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("ScrollsStoreTests/Fixtures/mini-dump/mini.sqlite")

  static let root: URL = {
    let r = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n6-tests")
    let cutoff = Date().addingTimeInterval(-3600)
    for name in (try? FileManager.default.contentsOfDirectory(atPath: r.path)) ?? [] {
      let u = r.appendingPathComponent(name)
      if let d = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date, d < cutoff {
        try? FileManager.default.removeItem(at: u)
      }
    }
    return r
  }()

  /// A device-profile copy of the mini database with an empty journal. `generation` names meta.generation.
  static func mini(_ label: String = "mini", generation: String? = nil) throws -> TestAtlas {
    let dir = root.appendingPathComponent("\(label)-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("Notebook"), withIntermediateDirectories: true)
    let path = dir.appendingPathComponent("atlas.sqlite").path
    try FileManager.default.copyItem(at: fixture, to: URL(fileURLWithPath: path))
    let c = try Connection(path: path, mode: .readWrite, profile: .device)
    try Migrations.migrate(c)
    if let generation { try c.transaction(.immediate) { try Meta.set(c, "generation", generation) } }
    c.close()
    return try TestAtlas(dir: dir, path: path)
  }

  /// A copy of this atlas file with a fresh, empty journal (a generation built from the same base).
  ///
  /// The atlas is in WAL mode and its writer is open, so its latest commits (the device profile's tables from
  /// `mini()`'s migration among them) can still sit in `atlas.sqlite-wal`; copying `atlas.sqlite` alone dropped them
  /// ("no such table: text_storage / id_counter" in the copy, whenever the migration connection had not been the last
  /// to close). As `StarterBuild` does before it copies a generation, checkpoint everything into the main file first
  /// (TRUNCATE, through the writer), and refuse to copy unless the WAL is empty.
  func cloneBase(_ label: String, generation: String) async throws -> TestAtlas {
    let wal = try await writer.checkpoint(.truncate)
    guard !wal.busy, wal.walBytes == 0 else {
      throw ScrollsError(code: .internalError, message: "cloneBase: the WAL of \(path) did not checkpoint (busy \(wal.busy), "
                         + "\(wal.walBytes) bytes left, \(wal.checkpointedFrames)/\(wal.logFrames) frames)")
    }
    let dir = Self.root.appendingPathComponent("\(label)-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("Notebook"), withIntermediateDirectories: true)
    let to = dir.appendingPathComponent("atlas.sqlite").path
    try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: URL(fileURLWithPath: to))
    let c = try Connection(path: to, mode: .readWrite, profile: .device)
    try c.transaction(.immediate) { try Meta.set(c, "generation", generation) }
    c.close()
    return try TestAtlas(dir: dir, path: to)
  }

  init(dir: URL, path: String) throws {
    self.dir = dir
    self.path = path
    writer = try Writer(path: path, profile: .device)
    journal = try JournalFile(directory: dir.appendingPathComponent("Notebook"))
  }

  /// "Kill and relaunch": a new writer and a reopened journal (which truncates a torn last line).
  func relaunch() async throws {
    try await writer.close()
    writer = try Writer(path: path, profile: .device)
    journal = try JournalFile(directory: dir.appendingPathComponent("Notebook"))
  }

  /// A read in one transaction (the writer, so reads see every commit).
  func read<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await writer.write("read") { tx in try body(tx.connection) }
  }

  /// A write outside the journal (fixture surgery: re-segmentation, a starter row, a pack's documents).
  func raw(_ body: @Sendable (WriteTx) throws -> Void) async throws {
    try await writer.write("raw") { tx in try body(tx) }
  }

  /// The dry run (rolled back), then the journaled act — with an optional kill point.
  func act(_ label: String, actor: String = "human:you", kill: KillPoint? = nil,
           _ build: @escaping @Sendable (WriteContext) throws -> JournalOp) async throws -> JSONValue {
    struct Rollback: Error { let op: JournalOp }
    let text = self.text
    var op: JournalOp?
    do {
      _ = try await writer.write("dry \(label)") { tx -> Int in
        throw Rollback(op: try build(WriteContext(tx: tx, text: text, at: StoreClock.isoNow())))
      }
    } catch let r as Rollback {
      op = r.op
    }
    guard let op else { throw Killed() }
    if kill == .beforeAppend { throw Killed() }
    if kill == .tornAppend {
      let head = await journal.head
      let entry = try JournalEntry(seq: head + 1, at: StoreClock.isoNow(), actor: actor, op: op)
      let line = Array(try entry.line().utf8)
      let file = try journalFiles().last!
      let h = try FileHandle(forWritingTo: file)
      try h.seekToEnd()
      try h.write(contentsOf: Data(line.prefix(line.count / 2)))
      try h.close()
      throw Killed()
    }
    let entry = try await journal.append(op, actor: actor)
    if kill == .afterAppend { throw Killed() }
    let out = try await writer.write("journal \(entry.seq)") { tx -> JSONValue in
      let r = try ProvenanceJournal.apply(entry, WriteContext(tx: tx, text: text, at: entry.at), journal: [])
      if kill == .afterApply { throw Killed() }
      try tx.recordJournalApplied(entry)
      if kill == .afterRecord { throw Killed() }
      return r.response
    }
    if kill == .afterCommit { throw Killed() }
    return out
  }

  /// The launch catch-up (`JournalReplayer.catchUp`).
  func catchUp() async throws -> ProvenanceJournal.ReplayOutcome {
    try await ProvenanceJournal.replay(try await ProvenanceJournal.entries(journal), writer: writer, text: text)
  }

  func journalFiles() throws -> [URL] {
    let d = dir.appendingPathComponent("Notebook")
    return try FileManager.default.contentsOfDirectory(atPath: d.path).filter { $0.hasPrefix("journal-") }.sorted()
      .map { d.appendingPathComponent($0) }
  }

  func appliedSeq() async throws -> UInt64 {
    try await read { c in UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0 }
  }

  func count(_ table: String) async throws -> Int {
    try await read { c in Int(try c.prepared(dynamic: "SELECT count(*) FROM \"\(table)\"").first { $0.int(0) } ?? 0) }  // lint: sql-ok (test helper)
  }
}

// MARK: - request builders (the reference's test fixtures, provenance.test.mjs)

enum Mini {
  /// The body passage of a mini document: (passage id, document id, text).
  static func body(_ c: Connection, ext: String) throws -> (passage: Int64, doc: Int64, text: [UInt16], sha: String) {
    let doc = try c.prepared(dynamic: "SELECT id FROM document WHERE ext_id = ?").bindingFirst([.text(ext)]) { $0.int(0) }!  // lint: sql-ok (test helper)
    let p = try c.prepared(dynamic: "SELECT id FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off LIMIT 1")  // lint: sql-ok (test helper)
      .bindingFirst([.int(doc)]) { $0.int(0) }!
    let t = try Anchors.loadFieldText(c, text: ChunkedTextStore(), doc: doc, field: "body")!
    return (p, doc, t.units, t.sha)
  }

  static func anchor(_ b: (passage: Int64, doc: Int64, text: [UInt16], sha: String), _ quote: String) -> JSONValue {
    let q = Array(quote.utf16)
    let start = Anchors.allIndexes(b.text, q).first!
    return ["doc_id": .number(Double(b.doc)), "sha256": .string(b.sha), "field": "body", "start": .number(Double(start)),
            "end": .number(Double(start + q.count)), "quote": .string(quote)]
  }

  /// A few words of a document's body (a stable quote for anchors).
  static func words(_ b: (passage: Int64, doc: Int64, text: [UInt16], sha: String), from: Int, count: Int) -> String {
    String(decoding: Anchors.jsSlice(b.text, from, from + count), as: UTF16.self)
  }
}

extension JSONValue {
  /// `obj.a.b` for tests.
  func at(_ path: String...) -> JSONValue? {
    var v: JSONValue? = self
    for p in path { v = Int(p).map { v?[$0] } ?? v?[p] }
    return v
  }

  var int: Int? { integer }
}

extension TestAtlas {
  /// The reference logic in one committed transaction, without the journal (the port's unit tests).
  func direct<T: Sendable>(_ body: @escaping @Sendable (WriteContext) throws -> T) async throws -> T {
    let text = self.text
    return try await writer.write("direct") { tx in try body(WriteContext(tx: tx, text: text, at: StoreClock.isoNow())) }
  }

  /// The error a direct call answers, or nil (the transaction rolls back).
  func refusal(_ body: @escaping @Sendable (WriteContext) throws -> JSONValue) async -> ScrollsError? {
    do {
      _ = try await direct(body)
      return nil
    } catch let e as ScrollsError {
      return e
    } catch {
      return ScrollsError(code: .internalError, message: "\(error)")
    }
  }
}

/// `throwsHttp(fn, status, code)`.
func expectRefused(_ e: ScrollsError?, _ status: Int, _ code: String, sourceLocation: SourceLocation = #_sourceLocation) {
  #expect(e?.status == status, "expected \(status) \(code), got \(String(describing: e))", sourceLocation: sourceLocation)
  #expect(e?.code.rawValue == code, "expected \(code), got \(String(describing: e))", sourceLocation: sourceLocation)
}
