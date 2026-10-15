// OWNER: N2
// A scratch device atlas for the Sources tests: schema + device profile + seeded vocabulary in a temporary directory,
// with its writer, readers and a job lease, plus a fake DocumentWriting that records what an adapter load hands it
// (the frozen protocol, IOS-SPEC §8.5: N2 develops against a fake until N1's writer lands; both are exercised here).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsSources
import ScrollsStore
import Synchronization

/// A temporary device atlas.
final class ScratchAtlas: Sendable {
  let dir: URL
  let path: String
  let writer: Writer
  let reads: ReadPool

  init() async throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("n2-atlas-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    path = dir.appendingPathComponent("atlas.sqlite").path
    do {
      let c = try Connection(path: path, mode: .readWrite, profile: .device)
      try Migrations.migrate(c)
      c.close()
    }
    writer = try Writer(path: path, profile: .device)
    reads = try ReadPool(path: path, profile: .device, size: 2)
    try await writer.write("seed") { tx in try SeedVocab.seed(tx) }
  }

  func lease(_ job: Int64 = 1) async -> WriteLease { await writer.lease(for: JobID(rawValue: job)) }

  func read<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await reads.read(.interactive, deadline: .seconds(60), body)
  }

  func scalar(_ sql: SQL, _ values: [SQLValue] = []) async throws -> Int64 {
    try await read { c in
      let s = try c.prepared(sql)
      try s.bind(values)
      return try s.first { $0.int(0) } ?? 0
    }
  }

  func close() async {
    await reads.close()
    try? await writer.close()
    try? FileManager.default.removeItem(at: dir)
  }

  /// The load environment of a lease (no job row; the checkpoint only checks cancellation).
  func environment(_ lease: WriteLease, factory: @escaping DocumentWriterFactory) -> LoadEnvironment {
    LoadEnvironment(lease: lease, writerFactory: factory, jobID: nil, checkpoint: { try Task.checkCancellation() })
  }
}

/// Statements the tests read.
enum TestSQL: SQLCatalog {
  static let documents = SQL("test.n2.documents", "SELECT count(*) FROM document WHERE collection_id = (SELECT id FROM collection WHERE slug = ?)",
                             scan: .scanOK(reason: "test"))
  static let synthetic = SQL("test.n2.synthetic", "SELECT count(*) FROM document WHERE is_synthetic = 1", scan: .scanOK(reason: "test"))
  static let idRange = SQL("test.n2.idRange", "SELECT max(id) FROM document", scan: .scanOK(reason: "test"))
  static let collectionID = SQL("test.n2.collectionID", "SELECT id FROM collection WHERE slug = ?", scan: .scanOK(reason: "test"))
  static let originals = SQL("test.n2.originals", "SELECT count(*) FROM original_file WHERE rel_path LIKE ?", scan: .scanOK(reason: "test"))
  static let relationships = SQL("test.n2.relationships", "SELECT count(*) FROM relationship", scan: .scanOK(reason: "test"))
  static let annotations = SQL("test.n2.annotations", "SELECT count(*) FROM annotation", scan: .scanOK(reason: "test"))
  static let batches = SQL("test.n2.batches", "SELECT count(*) FROM import_batch WHERE status = ?", scan: .scanOK(reason: "test"))
  static let adapters = SQL("test.n2.adapters", "SELECT count(*) FROM source_adapter", scan: .scanOK(reason: "test"))
  static let sourceFiles = SQL("test.n2.sourceFiles", "SELECT count(*) FROM document WHERE source_file_sha256 IS NOT NULL",
                               scan: .scanOK(reason: "test"))
  static let all: [SQL] = [documents, synthetic, idRange, collectionID, originals, relationships, annotations, batches, adapters,
                           sourceFiles]
}

/// A value behind a lock that escaping closures may capture (Mutex itself is noncopyable).
final class Locked<T: Sendable>: Sendable {
  private let m: Mutex<T>
  init(_ value: T) { m = Mutex(value) }
  func withLock<R>(_ body: (inout T) -> R) -> R { m.withLock { body(&$0) } }
}

/// A DocumentWriting that records what it is given and writes nothing (rows other than the batch's are not needed).
final class RecordingWriter: DocumentWriting {
  struct Log: Sendable {
    var documents: [String] = []
    var lines: [Int?] = []
    var relationships = 0
    var annotations = 0
    var aliases = 0
    var issues: [Issue] = []
    var finished = false
    var rolledBack = false
  }

  /// The shared log (Mutex is noncopyable, so it lives in a box the test keeps).
  final class Box: Sendable {
    let m = Mutex(Log())
    func withLock<T>(_ body: (inout Log) -> T) -> T { m.withLock { body(&$0) } }
  }

  let target: DocumentWriterTarget
  let log: Box
  /// ext_ids the fake refuses (as a writer refuses a bad record).
  let refuse: Set<String>

  init(target: DocumentWriterTarget, log: Box, refuse: Set<String> = []) {
    self.target = target
    self.log = log
    self.refuse = refuse
  }

  func add(_ document: CanonicalDocument, line: Int?) async throws -> DocumentWriteResult {
    if refuse.contains(document.extId) {
      let i = Issue(code: "E_TEST_REFUSED", severity: "error", line: line, col: nil, field: nil, valueExcerpt: document.extId,
                    message: "refused by the test", suggestion: "none")
      log.withLock { $0.issues.append(i) }
      return DocumentWriteResult(document: nil, issues: [i])
    }
    log.withLock {
      $0.documents.append(document.extId)
      $0.lines.append(line)
    }
    return DocumentWriteResult(document: DocumentID(rawValue: Int64(log.withLock { $0.documents.count })), issues: [])
  }

  func addAlias(to target: DocKey, _ alias: CanonicalAlias) async throws -> Bool {
    log.withLock { $0.aliases += 1 }
    return true
  }

  func add(_ relationship: CanonicalRelationship) async throws -> [Issue] {
    log.withLock { $0.relationships += 1 }
    return []
  }

  func add(_ annotation: CanonicalAnnotation) async throws -> [Issue] {
    log.withLock { $0.annotations += 1 }
    return []
  }

  func addIssue(_ issue: Issue) async throws { log.withLock { $0.issues.append(issue) } }
  func flush() async throws {}
  var counts: JSONValue { ["documents": ["created": .number(Double(log.withLock { $0.documents.count }))]] }

  func finish() async throws -> DocumentWriterSummary {
    log.withLock { $0.finished = true }
    return DocumentWriterSummary(batch: target.batch ?? ImportBatchID(rawValue: 0), collection: target.collection, counts: counts,
                                 dataVersion: 0)
  }

  func rollback() async throws { log.withLock { $0.rolledBack = true } }
}
