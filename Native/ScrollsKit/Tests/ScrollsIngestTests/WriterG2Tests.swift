// OWNER: N1
// G2 exact (IOS-SPEC §2.2, §8.5 N1): the same records written by the Swift DocumentWriter and by the reference's
// createDocumentWriter give the same LogicalDump, table by table, line by line — on a reference-profile database (ids
// max + 1, inline text) and on a device atlas (slot-0 ids, chunked text, compact create revisions; DV-11, DV-12).
// Inputs and Node's dump lines come from the families g2.mini and g2.demo (+ the private g2.demo-fts) of
// Golden/gen-pipeline.mjs.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsIngest
import ScrollsStore
import Testing

@Suite("G2 writer dumps", .serialized)
struct WriterG2Tests {
  /// The Node dump of a family: table → lines (rows of private families merged in), and the digests.
  static func nodeDump(_ cases: [JSONValue], extra: [JSONValue]) -> (lines: [String: [String]], digests: [String: (rows: Int, sha: String?)]) {
    var lines: [String: [String]] = [:]
    var digests: [String: (rows: Int, sha: String?)] = [:]
    for c in cases + extra {
      switch c["kind"]?.stringValue {
      case "row": lines[c["table"]!.stringValue!, default: []].append(c["line"]!.stringValue!)
      case "digest":
        let t = c["table"]!.stringValue!
        digests[t] = (c["rows"]?.safeInteger ?? 0, c["sha256"]?.stringValue)
      default: break
      }
    }
    return (lines, digests)
  }

  /// The Swift dump of an atlas: table → lines, and the table digests.
  static func swiftDump(_ path: String, _ profile: StoreProfile, label: String) throws -> (lines: [String: [String]], digests: [String: TableDigest]) {
    let c = try Connection(path: path, mode: .readOnly, profile: profile)
    defer { c.close() }
    let out = try IngestFixtures.tempDir("dump-\(label)")
    let digests = try LogicalDump.dump(c, text: profile == .device ? ChunkedTextStore() : InlineTextStore(), to: out, tables: nil)
    var lines: [String: [String]] = [:]
    for t in digests.keys {
      let url = out.appendingPathComponent("\(t).jsonl")
      guard let data = try? Data(contentsOf: url) else { continue }
      lines[t] = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }
    return (lines, digests)
  }

  /// Device-profile rows the reference has no counterpart for (the profile's own meta keys).
  static let deviceMetaKeys = ["profile", "journal_applied_seq", "base_max_ids", "generation", "generation_built_on",
                               "engine_version", "engine_code_hash", "starter_sha256"]

  /// Compares Swift with Node for every table Node dumped (rows when Node's lines are here, else the table digest);
  /// returns the mismatch descriptions.
  static func compare(swift: (lines: [String: [String]], digests: [String: TableDigest]),
                      node: (lines: [String: [String]], digests: [String: (rows: Int, sha: String?)]),
                      profile: StoreProfile) -> (tables: Int, rows: Int, diffs: [String]) {
    var diffs: [String] = []
    var rows = 0
    for table in node.digests.keys.sorted() {
      let expected = node.digests[table]!
      rows += expected.rows
      var mine = swift.lines[table] ?? []
      if profile == .device && table == "meta" {
        mine = mine.filter { line in !deviceMetaKeys.contains { line.hasPrefix("{\"$key\":[\"\($0)\"]") } }
      }
      guard let theirs = node.lines[table] else {
        // rows not committed (a private family that is absent here): compare the table digest
        let d = swift.digests[table]
        if expected.sha != nil && (d?.sha256 != expected.sha || d?.rows != expected.rows) {
          diffs.append("\(table): digest \(d?.rows ?? -1) rows \(d?.sha256.prefix(12) ?? "∅"), Node \(expected.rows) rows \(expected.sha?.prefix(12) ?? "∅")")
        }
        continue
      }
      if mine == theirs { continue }
      let a = Set(mine), b = Set(theirs)
      let onlySwift = mine.filter { !b.contains($0) }, onlyNode = theirs.filter { !a.contains($0) }
      diffs.append("\(table): \(mine.count) rows vs Node \(theirs.count); only Swift: \(onlySwift.prefix(2).map { String($0.prefix(700)) }); only Node: \(onlyNode.prefix(2).map { String($0.prefix(700)) })")
    }
    return (node.digests.count, rows, diffs)
  }

  /// Writes the records of a G2 family (setup, inputs) into a fresh atlas through DocumentWriter; returns its path.
  static func build(_ cases: [JSONValue], profile: StoreProfile, label: String) async throws -> String {
    let setup = try #require(cases.first { $0["kind"]?.stringValue == "setup" })
    let (path, writer) = try await IngestFixtures.atlas(profile, label: label)
    let scope = IDScope.slot(.base)
    let now = IngestFixtures.now
    let batch = try await writer.write("setup") { tx -> Int64 in
      let c = tx.connection
      if let a = setup["adapter"] {
        let s = try c.prepared(dynamic: """
          INSERT INTO source_adapter (id, version, label, access, enabled, license, attribution) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
          """)
        try s.bind(.text(a["id"]!.stringValue!), .text(a["version"]!.stringValue!), .text(a["label"]!.stringValue!),
                   .text(a["access"]!.stringValue!), .int(1), .string(a["license"]?.stringValue), .string(a["attribution"]?.stringValue))
        try s.run()
      }
      if let k = setup["corpus"] {
        let id = try tx.ids.next("corpus", scope)
        let s = try c.prepared(dynamic: """
          INSERT INTO corpus (id, slug, name, kind, is_synthetic, description, license, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO NOTHING
          """)
        try s.bind(.int(id), .text(k["slug"]!.stringValue!), .text(k["name"]!.stringValue!), .text(k["kind"]!.stringValue!),
                   .int(Int64(k["is_synthetic"]!.safeInteger!)), .string(k["description"]?.stringValue), .string(k["license"]?.stringValue),
                   .text(StoreClock.iso(now)))
        try s.run()
      }
      let cs = setup["collection"]!
      let coll = try Collections.ensureCollection(tx, CollectionSpec(
        slug: cs["slug"]!.stringValue!, name: cs["name"]!.stringValue!, corpus: cs["corpus"]!.stringValue!,
        adapterID: cs["adapter_id"]!.stringValue!, domain: cs["domain"]!.stringValue!, modality: cs["modality"]!.stringValue!,
        unit: cs["unit"]!.stringValue!, sampling: cs["sampling"]!.stringValue!, rateEligible: cs["rate_eligible"]?.boolValue,
        coverageGate: cs["coverage_gate"]?.safeInteger, exportTextAllowed: cs["export_text_allowed"]?.boolValue,
        license: cs["license"]?.stringValue, attribution: cs["attribution"]?.stringValue, selectionNote: cs["selection_note"]?.stringValue,
        caveats: cs["caveats"]?.arrayValue?.compactMap(\.stringValue) ?? []), scope: scope)
      let b = setup["batch"]!
      return try Collections.createBatch(tx, BatchSpec(collectionID: coll.id, adapterID: b["adapter_id"]?.stringValue,
                                                       adapterVersion: b["adapter_version"]?.stringValue,
                                                       format: b["format"]?.stringValue ?? "adapter", fileName: b["file_name"]?.stringValue), now: now)
    }
    let lease = await writer.lease(for: JobID(rawValue: 1))
    let dw = try await DocumentWriter.make(
      lease: lease, target: DocumentWriterTarget(batch: ImportBatchID(rawValue: batch), collection: setup["collection"]!["slug"]!.stringValue!,
                                                 corpus: setup["writer"]?["corpus"]?.stringValue, ids: scope),
      options: DocumentWriterOptions(), now: now)
    var records: [WriterRecord] = []
    for c in cases where c["kind"]?.stringValue == "input" {
      switch c["type"]?.stringValue {
      case "document": records.append(.document(try IngestFixtures.decode(CanonicalDocument.self, c["doc"]!), line: c["line"]?.safeInteger))
      case "relationship": _ = try await dw.add(try IngestFixtures.decode(CanonicalRelationship.self, c["rel"]!))
      case "annotation": _ = try await dw.add(try IngestFixtures.decode(CanonicalAnnotation.self, c["ann"]!))
      default: break
      }
    }
    _ = try await dw.add(records)
    _ = try await dw.finish()
    await lease.end()
    try await writer.close()
    return path
  }

  static func run(_ family: String, privateFamily: String? = nil, profile: StoreProfile) async throws {
    guard let cases = try IngestFixtures.cases(family) else {
      Testing.Issue.record("golden family \(family) is missing (Tools/golden.sh pipeline)")
      return
    }
    let extra = try privateFamily.flatMap { try IngestFixtures.cases($0) } ?? []
    let node = nodeDump(cases, extra: extra)
    let path = try await build(cases, profile: profile, label: "\(family)-\(profile.rawValue)")
    let swift = try swiftDump(path, profile, label: "\(family)-\(profile.rawValue)")
    let r = compare(swift: swift, node: node, profile: profile)
    IngestFixtures.report("\(family)\(profile == .device ? "-device" : "")", cases: r.rows, mismatches: r.diffs.count, diffs: r.diffs)
    for d in r.diffs { Testing.Issue.record("\(family) [\(profile.rawValue)] \(d)") }
    #expect(r.diffs.isEmpty, "\(family) [\(profile.rawValue)]: \(r.diffs.count) of \(r.tables) tables differ")
  }

  @Test("g2.mini: Swift dump = Node dump (reference profile)")
  func miniReference() async throws { try await Self.run("g2.mini", profile: .reference) }

  @Test("g2.mini: Swift dump = Node dump (device profile: slot-0 ids, chunked text, compact revisions)")
  func miniDevice() async throws { try await Self.run("g2.mini", profile: .device) }

  @Test("g2.demo: Swift dump = Node dump (reference profile)")
  func demoReference() async throws { try await Self.run("g2.demo", privateFamily: "g2.demo-fts", profile: .reference) }

  @Test("g2.demo: Swift dump = Node dump (device profile)")
  func demoDevice() async throws { try await Self.run("g2.demo", privateFamily: "g2.demo-fts", profile: .device) }
}
