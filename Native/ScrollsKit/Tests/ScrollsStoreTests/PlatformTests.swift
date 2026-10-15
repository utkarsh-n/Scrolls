// OWNER: N0
// The memory and mapping registries (IOS-SPEC §3.8), the atlas locations (§3.9, §6.6, ΔS-3) and the probe (§1.4), on
// the Mac. The probe's device run is PENDING_DEVICE (Native/Reports/device-queue.json).

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("Memory, mappings, locations and the probe", .serialized)
struct PlatformTests {
  @Test("MappedFileRegistry maps read-only, accounts the bytes by purpose, and refuses a mapping past 2 GiB")
  func mappings() throws {
    let url = try Fixtures.tempDir("map").appendingPathComponent("f.bin")
    try Data((0..<4096).map { UInt8($0 & 0xFF) }).write(to: url)
    let m = try MappedFileRegistry.map(url, purpose: "mapping-test")
    #expect(m.bytes.count == 4096 && m.bytes[4095] == 0xFF)
    #expect(MappedFileRegistry.byPurpose["mapping-test"] == 4096)
    m.unmap()
    m.unmap()
    #expect(MappedFileRegistry.byPurpose["mapping-test"] == nil)
    let e = #expect(throws: MemoryBudgetError.self) {
      try MappedFileRegistry.reserve(bytes: MappedFileRegistry.budgetBytes + 1, purpose: "over")
    }
    if case .overBudget(let r, _, let b)? = e { #expect(r == MappedFileRegistry.budgetBytes + 1 && b == 2 << 30) }
    else { Issue.record("expected overBudget, got \(String(describing: e))") }
    #expect(MappedFileRegistry.byPurpose["over"] == nil)
  }

  @Test("a read pool whose mmap windows do not fit the budget runs without mmap (same results, pread)")
  func readersWithoutMmap() async throws {
    let pool = try ReadPool(path: try Fixtures.atlas(), profile: .device, mmapBytesPerReader: 1 << 30)
    #expect(pool.mmapBytesPerReader == 0)
    let mmap = try await pool.read { c in try c.prepared(dynamic: "PRAGMA mmap_size").first { $0.int(0) } }
    #expect(mmap == 0)
  }

  @Test("MemoryBudget admits a declared peak with 600 MB headroom and refuses what cannot fit")
  func memoryBudget() throws {
    let r = try MemoryBudget.reserve(bytes: 64 << 20)
    #expect(MemoryBudget.reservedBytes >= 64 << 20)
    r.release()
    r.release()
    #expect(throws: MemoryBudgetError.self) { try MemoryBudget.reserve(bytes: Int.max / 4) }
    #expect(MemoryBudget.physFootprint() > 0)
  }

  @Test("AtlasLocation: the root's folders exist, the atlas is excluded from backup, iCloud roots are refused")
  func locations() throws {
    let root = try Fixtures.tempDir("root")
    let loc = try AtlasLocation.at(root: root)
    for d in [loc.atlasDir, loc.notebookDir, loc.derivedDir, loc.cachesDir, loc.importDir, loc.inboxDir, loc.diagnosticsDir] {
      #expect(FileManager.default.fileExists(atPath: d.path))
    }
    #expect(loc.importDir.path.hasSuffix("/Documents/Import") && loc.inboxDir.path.hasSuffix("/Documents/Inbox"))
    #expect(loc.atlasPath.hasSuffix("/Atlas/atlas.sqlite"))
    #expect(try loc.atlasDir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    #expect(try loc.notebookDir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup != true)
    for bad in ["Documents/scrolls", "Library/Mobile Documents/com~apple~CloudDocs/x", "Desktop/a"] {
      let e = #expect(throws: ScrollsError.self) { try AtlasLocation.refuseICloud(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(bad)) }
      #expect(e?.code.rawValue == "E_DB_IN_ICLOUD")
    }
    try AtlasLocation.refuseICloud(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Developer/scrolls-atlas"))
  }

  @Test("a Documents/Inbox the app may not create (513, as iOS answers on his iPhone) does not stop prepare; Import is made")
  func inboxNotCreatable() throws {
    let root = try Fixtures.tempDir("root-no-inbox")
    let fm = FileManager.default
    let documents = root.appendingPathComponent("Documents")
    // Documents exists with Import and Diagnostics already in it, then becomes read-only: creating Inbox is refused
    // with NSFileWriteNoPermissionError (513), the error iOS gives for its reserved Inbox
    for d in ["Import", "Diagnostics"] {
      try fm.createDirectory(at: documents.appendingPathComponent(d), withIntermediateDirectories: true)
    }
    try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: documents.path)
    defer { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: documents.path) }
    let refused = #expect(throws: CocoaError.self) {
      try fm.createDirectory(at: documents.appendingPathComponent("Inbox"), withIntermediateDirectories: true)
    }
    #expect(refused?.code == .fileWriteNoPermission && refused?.code.rawValue == 513)
    let loc = try AtlasLocation.at(root: root)
    var isDir: ObjCBool = false
    #expect(fm.fileExists(atPath: loc.importDir.path, isDirectory: &isDir) && isDir.boolValue)
    #expect(!fm.fileExists(atPath: loc.inboxDir.path), "the Inbox stays missing; the scan reads that as empty")
    #expect(fm.fileExists(atPath: loc.atlasDir.path) && fm.fileExists(atPath: loc.notebookDir.path))
  }

  @Test("prepare creates Documents/Import when it is missing (it is the app's own drop folder) and keeps what is in it")
  func importCreated() throws {
    let root = try Fixtures.tempDir("root-import")
    let fm = FileManager.default
    let first = try AtlasLocation.at(root: root)
    #expect(fm.fileExists(atPath: first.importDir.path))
    try Data("a,b\n".utf8).write(to: first.importDir.appendingPathComponent("letters.csv"))
    let again = try AtlasLocation.at(root: root)
    #expect(fm.fileExists(atPath: again.importDir.appendingPathComponent("letters.csv").path), "prepare never empties Import")
    try fm.removeItem(at: first.importDir)
    _ = try AtlasLocation.at(root: root)
    #expect(fm.fileExists(atPath: first.importDir.path))
  }

  @Test("a file sitting at Documents/Import does not stop prepare: the drop folders are best effort, the engine's are not")
  func importNotCreatable() throws {
    let root = try Fixtures.tempDir("root-import-file")
    let fm = FileManager.default
    let documents = root.appendingPathComponent("Documents")
    try fm.createDirectory(at: documents, withIntermediateDirectories: true)
    try Data("a file he put there".utf8).write(to: documents.appendingPathComponent("Import"))
    #expect(throws: CocoaError.self) {
      try fm.createDirectory(at: documents.appendingPathComponent("Import"), withIntermediateDirectories: true)
    }
    let loc = try AtlasLocation.at(root: root)
    var isDir: ObjCBool = true
    #expect(fm.fileExists(atPath: loc.importDir.path, isDirectory: &isDir) && !isDir.boolValue, "left as it was")
    for d in [loc.atlasDir, loc.notebookDir, loc.derivedDir, loc.cachesDir, loc.inboxDir, loc.diagnosticsDir] {
      #expect(fm.fileExists(atPath: d.path))
    }
  }

  @Test("the probe passes on this Mac: SQLite ≥ 3.46, FTS5 token parity with the generated tokenizer, rtree_i32 BCE, JSON1, contentless_delete, Final_Sigma, sentence boundaries")
  func probe() throws {
    let samples = try Fixtures.tempDir("samples")
    let text = "The first sentence. And a second one! शून्य की कथा। Dr. Watson arrived?\n\nA new paragraph"
    try Data(text.utf8).write(to: samples.appendingPathComponent("sample.txt"))
    try Data((Probe.sentenceDigest(SentenceBreaker.starts(text)) + "\n").utf8).write(to: samples.appendingPathComponent("sample.sentences.sha256"))
    let report = Probe.run(sampleTexts: samples, measureVM: true)
    for check in report.checks where check.status == .fail { Issue.record("\(check.name): \(check.detail)") }
    #expect(report.passed)
    let names = Set(report.checks.map(\.name))
    #expect(names.isSuperset(of: ["sqlite.version", "sqlite.compile_options", "fts5.tokenizer_parity", "sqlite.rtree_i32", "sqlite.json1",
                                  "sqlite.fts5_contentless_delete", "fold.final_sigma", "sentences.sample", "vm.largest_mapping"]))
    #expect(report.sqliteVersionNumber >= 3_046_000)
    #expect((report.largestMappingBytes ?? 0) > 0)
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      let enc = JSONEncoder()
      enc.outputFormatting = [.prettyPrinted, .sortedKeys]
      try enc.encode(report).write(to: URL(fileURLWithPath: dir).appendingPathComponent("probe-mac.json"))
    }
    // a wrong boundary hash fails the probe
    try Data("0000\n".utf8).write(to: samples.appendingPathComponent("sample.sentences.sha256"))
    #expect(!Probe.run(sampleTexts: samples).passed)
  }

  @Test("Integrity.quickCheck reports ok on a fresh atlas")
  func integrity() throws {
    let c = try Connection(path: try Fixtures.atlas(), mode: .readOnly, profile: .device)
    let r = try Integrity.quickCheck(c)
    #expect(r.ok && r.messages == ["ok"])
  }

  @Test("the Store catalogue: every statement prepares on a device atlas, ids are unique, index-only ones do not scan big tables")
  func catalogue() throws {
    let c = try Connection(path: try Fixtures.atlas(), mode: .readOnly, profile: .device)
    let all = StoreSQL.all + [CompactRevisions.classifyForm, CompactRevisions.row]
    #expect(Set(all.map(\.id)).count == all.count)
    let big = ["passage", "document", "relationship", "doc_tag", "expr_doc", "occurrence", "date_assertion"]
    for sql in all {
      _ = try c.prepared(sql)
      guard sql.scan == .indexOnly, !sql.text.hasPrefix("PRAGMA") else { continue }
      let plan = try c.prepared(dynamic: "EXPLAIN QUERY PLAN " + sql.text).all { $0.text(3) }
      for line in plan where big.contains(where: { line.hasPrefix("SCAN \($0)") && !line.contains("USING") }) {
        Issue.record("\(sql.id) scans: \(line)")
      }
    }
  }
}
