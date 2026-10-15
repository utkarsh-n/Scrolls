// OWNER: N0
// IOS-SPEC §2.3, §8.4.10 item 2: "LogicalDump Swift = Node on the reference's mini fixture database". The fixture is
// the database tests/helpers/tmpdata.mjs builds from tests/fixtures/mini and Native/Golden/dump.mjs's dump of it
// (Fixtures/mini-dump/MANIFEST.json says how). The Swift dump must equal it byte for byte, table by table — and so
// must the dump of the same database converted to the device profile (chunked text), which proves chunking lossless.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("LogicalDump")
struct LogicalDumpTests {
  static let manifest: JSONValue = (try? JSONValue.parse(Data(contentsOf: Fixtures.miniDir.appendingPathComponent("MANIFEST.json")))) ?? .null

  /// Copies the fixture database into a temp directory (never opened in place).
  static func miniCopy() throws -> String {
    let dir = try Fixtures.tempDir("mini")
    let to = dir.appendingPathComponent("mini.sqlite")
    try FileManager.default.copyItem(at: Fixtures.miniDir.appendingPathComponent("mini.sqlite"), to: to)
    return to.path
  }

  static func nodeFiles() throws -> [String: Data] {
    let dir = Fixtures.miniDir.appendingPathComponent("node-dump")
    var out: [String: Data] = [:]
    for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name.hasSuffix(".jsonl") || name == "digest.json" {
      out[name] = try Data(contentsOf: dir.appendingPathComponent(name))
    }
    return out
  }

  /// The first line where two dumps differ (for the failure message).
  static func firstDifference(_ a: Data, _ b: Data) -> String {
    let la = String(decoding: a, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
    let lb = String(decoding: b, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
    for i in 0..<max(la.count, lb.count) where (i < la.count ? la[i] : "∅") != (i < lb.count ? lb[i] : "∅") {
      return "line \(i + 1):\n  swift \(i < la.count ? String(la[i].prefix(400)) : "∅")\n  node  \(i < lb.count ? String(lb[i].prefix(400)) : "∅")"
    }
    return "equal"
  }

  @Test("the fixture is current: its files match MANIFEST.json, made with this dump-spec.json")
  func fixtureCurrent() throws {
    let spec = StoreResources.sha256Hex(try StoreResources.data("dump-spec.json"))
    #expect(Self.manifest["dump_spec_sha256"]?.stringValue == spec,
            "dump-spec.json changed since the Node dump was made: regenerate Fixtures/mini-dump (MANIFEST.json commands)")
    let files = try #require(Self.manifest["files"]?.objectValue)
    #expect(files.count >= 50)
    for (name, sha) in files {
      let data = try Data(contentsOf: Fixtures.miniDir.appendingPathComponent(name))
      #expect(StoreResources.sha256Hex(data) == sha.stringValue, "\(name) does not match its manifest sha256")
    }
  }

  @Test("Swift = Node: every table file and digest.json byte-equal on the reference's mini database (InlineTextStore)")
  func swiftEqualsNode() throws {
    let node = try Self.nodeFiles()
    let c = try Connection(path: try Self.miniCopy(), mode: .readOnlyImmutable, profile: .reference)
    let out = try Fixtures.tempDir("dump-swift")
    let digests = try LogicalDump.dump(c, text: InlineTextStore(), to: out, tables: nil)
    var mismatched: [String] = []
    for (name, expected) in node.sorted(by: { $0.key < $1.key }) {
      let mine = (try? Data(contentsOf: out.appendingPathComponent(name))) ?? Data()
      if mine != expected {
        mismatched.append(name)
        Issue.record("\(name) differs — \(Self.firstDifference(mine, expected))")
      }
    }
    let swiftFiles = try FileManager.default.contentsOfDirectory(atPath: out.path).filter { $0.hasSuffix(".jsonl") }
    #expect(Set(swiftFiles) == Set(node.keys.filter { $0.hasSuffix(".jsonl") }), "the two dumps wrote different table files")
    #expect(mismatched.isEmpty)
    let populated = digests.filter { $0.value.rows > 0 }
    #expect(populated["passage_fts"]?.rows == 404 && populated["document"]?.rows == 12 && populated["passage"]?.rows == 15)
    try Self.writeReport(name: "logicaldump-mini", tables: digests.count, mismatched: mismatched,
                         rows: digests.values.reduce(0) { $0 + $1.rows })
  }

  @Test("the same database converted to the device profile (chunked text) dumps identically (DV-11)")
  func chunkedEqualsInline() throws {
    let node = try Self.nodeFiles()
    let path = try Self.miniCopy()
    let c = try Connection(path: path, mode: .readWrite, profile: .device)
    try Migrations.migrate(c)  // adds the profile tables to the reference database
    var chunked = 0
    try c.transaction(.immediate) {
      let docs = try c.prepared(dynamic: "SELECT document_id, original FROM document_text ORDER BY document_id").all { ($0.int(0), $0.text(1)) }
      var writer = ChunkedTextStore.Writer()
      for (doc, original) in docs {
        let ends = try c.prepared(dynamic: "SELECT end_off FROM passage WHERE document_id = ? AND field = 'body' ORDER BY end_off")
          .bindingFirstAll([.int(doc)]) { Int32($0.int(0)) }
        let row = try writer.append(document: DocumentID(rawValue: doc), original: original, passageEnds: ends, on: c)
        #expect(row.utf16Len == original.utf16.count)
        let blank = try c.prepared(dynamic: "UPDATE document_text SET original = '' WHERE document_id = ?")
        try blank.bind(.int(doc))
        try blank.run()
        chunked += 1
      }
    }
    #expect(chunked == 10)
    #expect(try c.prepared(dynamic: "SELECT count(*) FROM document_text WHERE original <> ''").first { $0.int(0) } == 0)
    let out = try Fixtures.tempDir("dump-chunked")
    let tables = node.keys.filter { $0.hasSuffix(".jsonl") && $0 != "meta.jsonl" }.map { String($0.dropLast(6)) }
    _ = try LogicalDump.dump(c, text: ChunkedTextStore(), to: out, tables: tables)
    for t in tables {
      let mine = (try? Data(contentsOf: out.appendingPathComponent("\(t).jsonl"))) ?? Data()
      #expect(mine == node["\(t).jsonl"], "\(t) differs after chunking — \(Self.firstDifference(mine, node["\(t).jsonl"] ?? Data()))")
    }
  }

  @Test("dump-spec.json covers every table of both profiles and names only real columns")
  func specCoversSchema() throws {
    let spec = try DumpSpec.bundled()
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readOnly, profile: .device)
    let names = try LogicalDump.tableNames(c)
    #expect(names.count == 64)
    #expect(Set(names) == Set(spec.tables.keys), "spec tables ≠ schema tables: \(Set(names).symmetricDifference(spec.tables.keys).sorted())")
    for (table, e) in spec.tables where e.skip == nil && e.ftsRows == nil {
      let cols = Set(try c.prepared(dynamic: "PRAGMA table_info(\"\(table)\")").all { $0.text(1) })
      var named = Set(e.mask).union(e.json).union(e.text).union(e.virtual.keys).union(e.ids.keys)
      if let m = e.maskIf { named.formUnion([m.column]); named.formUnion(m.mask) }
      #expect(named.isSubset(of: cols), "\(table): \(named.subtracting(cols).sorted()) are not columns")
      for p in e.key {
        let head = p.split(separator: ".").first.map(String.init) ?? p
        let viaTable = e.ids.values.contains(.table(head))
        #expect(cols.contains(p) || viaTable, "\(table): key part \(p) is neither a column nor a referenced table")
      }
      for target in e.ids.values {
        if case .table(let t) = target {
          #expect(spec.tables[t]?.selfColumn != nil, "\(table) points to \(t), which has no self id column")
        }
      }
    }
  }

  /// A device atlas with one adapter relationship and one algorithm relationship (and its run).
  static func relationshipsAtlas() throws -> Connection {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readWrite, profile: .device)
    try c.exec("""
      INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint,
        data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
        VALUES (7, 'reuse-index', 'reuse-index@1', 'c', '{}', 'h', '{}', 'f', 0, 'u61m-1', 'seg-1', 'i', 'succeeded', 't');
      INSERT INTO relationship (id, rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
        source_dataset, source_locator, provenance_quality, method, run_id, created_by, score, score_kind, created_at)
        VALUES (100000001, 'exact_quotation', 'document', '12', 'document', '7', 1, 'documented', 'source_dataset', 'wikipedia',
          'https://en.wikipedia.org/wiki/X#refs', 'complete', NULL, NULL, 'adapter:cipher.relations@1.0.0', 0.75, 'heuristic_strength', 't'),
        (1500000001, 'exact_quotation', 'passage', '31', 'passage', '9', 1, 'computed', 'algorithm', NULL, NULL, 'complete', 'winnow@1', 7,
          'run:7', 0.123456789012345678, 'match_ratio', 't');
      """)
    return c
  }

  @Test("compact create revisions expand to the reference's after_json, in both writer shapes; others stay full (DV-12)")
  func compactRevisions() throws {
    let c = try Self.relationshipsAtlas()
    // the reference's two create shapes (document-writer.mjs: canonicalJson; classify.mjs: SQLite json_object)
    let adapterAfter = CanonicalJSON.string([
      "rel_type": "exact_quotation", "src": "document:12", "dst": "document:7", "evidence_status": "documented", "origin": "source_dataset",
      "source_dataset": "wikipedia", "source_locator": "https://en.wikipedia.org/wiki/X#refs", "method": nil, "run_id": nil,
      "score": ["value": 0.75, "kind": "heuristic_strength"],
    ])
    let classifyAfter = try #require(try c.prepared(dynamic: """
      SELECT json_object('rel_type', r.rel_type, 'src', r.src_type || ':' || r.src_ref, 'dst', r.dst_type || ':' || r.dst_ref,
        'evidence_status', r.evidence_status, 'origin', r.origin, 'method', r.method, 'run_id', r.run_id,
        'score', CASE WHEN r.score IS NULL THEN NULL ELSE json_object('value', r.score, 'kind', r.score_kind) END)
      FROM relationship r WHERE r.id = 1500000001
      """).first { $0.text(0) })
    #expect(try CompactRevisions.compacted(afterJSON: adapterAfter, relationship: 100000001, on: c) == CompactRevisions.marker)
    #expect(try CompactRevisions.compacted(afterJSON: classifyAfter, relationship: 1500000001, on: c) == CompactRevisions.marker)
    let other = #"{"rel_type":"exact_quotation","note":"not a writer shape"}"#
    #expect(try CompactRevisions.compacted(afterJSON: other, relationship: 100000001, on: c) == other)

    // a full and a compact atlas dump relationship_revision identically
    func dumpRevisions(compact: Bool) throws -> Data {
      let a = try Self.relationshipsAtlas()
      let ins = try a.prepared(dynamic: "INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, after_json) VALUES (?, ?, 1, 'a', 't', 'create', ?)")
      for (id, rel, after) in [(1, 100000001, adapterAfter), (2, 1500000001, classifyAfter)] {
        try ins.bind(.int(Int64(id)), .int(Int64(rel)), .text(compact ? CompactRevisions.marker : after))
        try ins.run()
      }
      let out = try Fixtures.tempDir("rev")
      _ = try LogicalDump.dump(a, text: ChunkedTextStore(), to: out, tables: ["relationship_revision"])
      return try Data(contentsOf: out.appendingPathComponent("relationship_revision.jsonl"))
    }
    let full = try dumpRevisions(compact: false)
    let compact = try dumpRevisions(compact: true)
    #expect(full == compact, Comment(rawValue: Self.firstDifference(compact, full)))
    #expect(String(decoding: full, as: UTF8.self).split(separator: "\n").count == 2)
  }

  @Test("float12 is Number(x.toPrecision(12)); non-finite → null")
  func float12() {
    #expect(LogicalDump.float12(0.1 + 0.2) == .number(0.3))
    #expect(LogicalDump.float12(1.0) == .number(1))
    #expect(LogicalDump.float12(-0.0) == .number(-0.0))
    #expect(LogicalDump.float12(123456.7890123456) == .number(123456.789012))
    #expect(LogicalDump.float12(.infinity) == .null)
  }

  static func writeReport(name: String, tables: Int, mismatched: [String], rows: Int) throws {
    guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
    let report: JSONValue = ["family": .string(name), "tables": .number(Double(tables)), "rows": .number(Double(rows)),
                             "mismatches": .number(Double(mismatched.count)), "mismatched": .array(mismatched.map(JSONValue.string)),
                             "passed": .bool(mismatched.isEmpty)]
    try Data(CanonicalJSON.string(report).utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(name).json"))
  }
}

extension Statement {
  /// Binds `values` and maps every row.
  fileprivate func bindingFirstAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
