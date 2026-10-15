// OWNER: N2
// `scrolls-cli convert-reference` (IOS-SPEC §2.2 G7, §3.2, DV-11, DV-12): a clone of a reference database becomes a
// device-profile atlas — the profile's tables and meta keys added (the §3 schema untouched), every document's text moved
// into passage-aligned chunks (`document_text.original = ''`, `text_chunk` + `text_storage`), and the create revisions
// of adapter and algorithm relationships compacted to `{"$row":1}` wherever the expansion reproduces them exactly
// (CompactRevisions.compacted: lossless by construction). `--check` dumps both and compares every table (LogicalDump
// with the inline store before, the chunked store after): equal dumps prove the conversion lossless.
// The reference's ids are kept (a converted clone is a test input for G7, not a slot-range generation). It never writes
// to the database it reads: the clone is copied first, and the output must not exist.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The statements of the conversion.
enum ConvertSQL: SQLCatalog {
  static let texts = SQL("convert.texts", "SELECT document_id FROM document_text WHERE original <> '' ORDER BY document_id",
                         scan: .scanOK(reason: "the conversion visits every document once"))
  static let original = SQL("convert.original", "SELECT original FROM document_text WHERE document_id = ?")
  static let bodyEnds = SQL("convert.bodyEnds", "SELECT end_off FROM passage WHERE document_id = ? AND field = 'body' ORDER BY end_off")
  static let blank = SQL("convert.blank", "UPDATE document_text SET original = '' WHERE document_id = ?")
  static let creates = SQL("convert.creates", """
    SELECT v.id, v.relationship_id, v.after_json FROM relationship_revision v JOIN relationship r ON r.id = v.relationship_id
    WHERE v.rev = 1 AND v.action = 'create' AND r.origin IN ('source_dataset', 'algorithm') AND v.after_json <> '{"$row":1}'
      AND v.id > ? ORDER BY v.id LIMIT 20000
    """, scan: .scanOK(reason: "the conversion visits every create revision once, in rowid ranges"))
  static let compact = SQL("convert.compact", "UPDATE relationship_revision SET after_json = ? WHERE id = ?")
  static let trigger = SQL("convert.trigger", "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'relrev_no_update'")
  static let all: [SQL] = [texts, original, bodyEnds, blank, creates, compact, trigger]
}

enum ConvertReferenceCommand: CLICommand {
  static let name = "convert-reference"
  static let summary = "turn a reference database clone into a device-profile atlas"
  static let usage = """
    usage: scrolls-cli convert-reference --db <reference clone> --out <atlas.sqlite> [--check] [--tables a,b,…]
      Copies the clone to <out> (which must not exist), adds the device profile, chunks every document's text and
      compacts the adapter and algorithm create revisions; prints {documents, chunks, compacted, kept} as canonical JSON.
      --check dumps the clone and the result (LogicalDump; --tables limits it) and fails unless every table is equal.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["check"])
    let db = URL(fileURLWithPath: try a.required("db")).standardizedFileURL
    let out = URL(fileURLWithPath: try a.required("out")).standardizedFileURL
    let fm = FileManager.default
    guard fm.fileExists(atPath: db.path) else { throw UsageError("no database at \(db.path)") }
    guard !fm.fileExists(atPath: out.path) else { throw UsageError("\(out.path) exists; choose a new path") }
    try AtlasLocation.refuseICloud(db)
    try AtlasLocation.refuseICloud(out)
    try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.copyItem(at: db, to: out)
    for suffix in ["-wal"] where fm.fileExists(atPath: db.path + suffix) {
      try fm.copyItem(atPath: db.path + suffix, toPath: out.path + suffix)
    }
    let report = try convert(out.path)
    var o = report
    if a.flag("check") {
      let tables = a.value("tables").map { $0.split(separator: ",").map(String.init) }
      let differ = try check(reference: out.path + ".reference-check", converted: out.path, source: db, tables: tables)
      o["check"] = differ.isEmpty ? "equal" : .array(differ.map(JSONValue.string))
      print(CanonicalJSON.string(.object(o)))
      return differ.isEmpty ? 0 : 1
    }
    print(CanonicalJSON.string(.object(o)))
    return 0
  }

  /// Converts the database at `path` in place (it is the copy).
  static func convert(_ path: String) throws -> JSONObject {
    let c = try Connection(path: path, mode: .readWrite, profile: .device)
    defer { c.close() }
    try Migrations.migrate(c)
    // texts: one transaction per 500 documents
    let ids = try c.prepared(ConvertSQL.texts).all { $0.int(0) }
    var chunks = 0
    var i = 0
    while i < ids.count {
      let batch = ids[i..<min(ids.count, i + 500)]
      i += batch.count
      try c.transaction(.immediate) {
        var writer = ChunkedTextStore.Writer()
        let orig = try c.prepared(ConvertSQL.original), ends = try c.prepared(ConvertSQL.bodyEnds), blank = try c.prepared(ConvertSQL.blank)
        for id in batch {
          try orig.bind(.int(id))
          guard let original = try orig.first({ $0.text(0) }) else { continue }
          try ends.bind(.int(id))
          let passageEnds = try ends.all { Int32($0.int(0)) }
          let row = try writer.append(document: DocumentID(rawValue: id), original: original, passageEnds: passageEnds, on: c)
          chunks += row.chunkCount
          try blank.bind(.int(id))
          try blank.run()
        }
      }
    }
    // create revisions: the append-only trigger is lifted for the conversion and recreated from its own DDL
    guard let ddl = try c.prepared(ConvertSQL.trigger).first({ $0.text(0) }) else {
      throw UsageError("the database has no relrev_no_update trigger: is it a Scrolls database?")
    }
    var compacted = 0, kept = 0
    try c.exec("DROP TRIGGER relrev_no_update")  // lint: sql-ok (conversion of a clone; recreated from sqlite_master below)
    do {
      var after: Int64 = 0
      while true {
        let rows = try c.prepared(ConvertSQL.creates).convertAll([.int(after)]) { (id: $0.int(0), rel: $0.int(1), json: $0.text(2)) }
        guard let last = rows.last else { break }
        after = last.id
        try c.transaction(.immediate) {
          let up = try c.prepared(ConvertSQL.compact)
          for r in rows {
            let stored = try CompactRevisions.compacted(afterJSON: r.json, relationship: r.rel, on: c)
            if stored == CompactRevisions.marker {
              try up.bind(.text(stored), .int(r.id))
              try up.run()
              compacted += 1
            } else {
              kept += 1
            }
          }
        }
      }
    } catch {
      try? c.exec(ddl)  // lint: sql-ok (the schema's own trigger DDL, read back from sqlite_master)
      throw error
    }
    try c.exec(ddl)  // lint: sql-ok (the schema's own trigger DDL, read back from sqlite_master)
    return ["documents": .number(Double(ids.count)), "chunks": .number(Double(chunks)), "compacted": .number(Double(compacted)),
            "kept": .number(Double(kept)), "path": .string(path)]
  }

  /// Dumps the source clone (inline text) and the converted atlas (chunked text); returns the tables that differ.
  static func check(reference scratch: String, converted: String, source: URL, tables: [String]?) throws -> [String] {
    let fm = FileManager.default
    let base = URL(fileURLWithPath: scratch)
    defer { try? fm.removeItem(at: base) }
    let ref = try Connection(path: source.path, mode: .readOnlyImmutable, profile: .reference)
    defer { ref.close() }
    let a = try LogicalDump.dump(ref, text: InlineTextStore(), to: base.appendingPathComponent("reference"), tables: tables)
    let conv = try Connection(path: converted, mode: .readOnly, profile: .device)
    defer { conv.close() }
    let b = try LogicalDump.dump(conv, text: ChunkedTextStore(), to: base.appendingPathComponent("converted"), tables: tables)
    // the device profile's own tables and meta keys exist only in the converted atlas
    let deviceOnly: Set<String> = ["text_storage", "text_chunk", "id_counter", "pack_install", "journal_applied", "saved_view_portable", "meta"]
    return Set(a.keys).union(b.keys).filter { !deviceOnly.contains($0) && a[$0] != b[$0] }.sorted()
  }
}

fileprivate extension Statement {
  /// Binds `values` and maps every row.
  func convertAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
