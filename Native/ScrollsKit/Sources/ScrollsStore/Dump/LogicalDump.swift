// OWNER: N0
// The LogicalDump, Swift side (IOS-SPEC §2.3). It implements the normative text in Native/Docs/DIFFERENTIAL.md
// ("The LogicalDump format"), as Native/Golden/dump.mjs does, and must write byte-identical files: one canonical JSON
// line per row, natural keys instead of ids, masked timestamps, digests of text bodies, floats at 12 significant
// digits, FTS through fts5vocab instance rows. Document text goes through `TextStore` and create revisions through
// `CompactRevisions`, so a device-profile atlas (chunked text, compact revisions) dumps exactly like a reference
// database — chunking and compaction are proven lossless by equal digests.
//
// One rule the JavaScript leaves to object key order is pinned here: when a key part names a table, exactly one id
// column may map to that table (`DumpSpec` rejects a spec where two do), so no lookup depends on JSON key order.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore

/// The rows and digest of one dumped table.
public struct TableDigest: Codable, Sendable, Equatable {
  public let rows: Int
  public let sha256: String
  public init(rows: Int, sha256: String) {
    self.rows = rows
    self.sha256 = sha256
  }
}

/// Dumps a database as natural-keyed JSONL per table.
public enum LogicalDump {
  /// The masked placeholder.
  public static let masked = "<masked>"
  /// The FTS rule string of the spec.
  public static let ftsRule = "rowid → passage key; fts5vocab instance (term, doc key, offset) → sha256"

  /// Dumps `c` into `dir` (`<table>.jsonl` + `digest.json`) per `Resources/dump-spec.json`. `tables` limits the
  /// dump (default: every non-shadow table). Skipped tables appear in digest.json only.
  public static func dump(_ c: Connection, text: any TextStore, to dir: URL, tables: [String]?) throws -> [String: TableDigest] {
    try dump(c, text: text, to: dir, tables: tables, spec: try DumpSpec.bundled(), fts: true)
  }

  /// `dump` with an explicit spec, and FTS dumping switchable (`--fts skip`).
  public static func dump(_ c: Connection, text: any TextStore, to dir: URL, tables: [String]?, spec: DumpSpec,
                          fts: Bool) throws -> [String: TableDigest] {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let names = try tableNames(c)
    let wanted = (tables ?? names).sorted(by: CanonicalJSON.codeUnitLess)
    let missing = wanted.filter { spec.tables[$0] == nil }
    if !missing.isEmpty {
      throw StoreError.misuse("dump-spec.json has no entry for: \(missing.joined(separator: ", "))")
    }
    var dumper = Dumper(c: c, spec: spec, text: text)
    var digests: [String: TableDigest] = [:]
    var digestFile: [(String, DigestEntry)] = []
    for t in wanted {
      let s = spec.tables[t]!
      if let reason = s.skip {
        digestFile.append((t, .skipped(reason)))
        continue
      }
      var lines: [(key: String, line: String)]
      if let rows = s.ftsRows {
        if !fts {
          digestFile.append((t, .skipped("--fts skip")))
          continue
        }
        lines = try dumper.fts(t, rule: rows)
      } else {
        lines = try dumper.rows(t)
      }
      lines.sort { a, b in
        if a.key != b.key { return CanonicalJSON.codeUnitLess(a.key, b.key) }
        return CanonicalJSON.codeUnitLess(a.line, b.line)
      }
      var body = lines.map(\.line).joined(separator: "\n")
      if !lines.isEmpty { body += "\n" }
      let data = Data(body.utf8)
      try data.write(to: dir.appendingPathComponent("\(t).jsonl"))
      let d = TableDigest(rows: lines.count, sha256: StoreResources.sha256Hex(data))
      digests[t] = d
      digestFile.append((t, .rows(d)))
    }
    try Data(digestJSON(digestFile).utf8).write(to: dir.appendingPathComponent("digest.json"))
    return digests
  }

  /// Every non-shadow table of `sqlite_master`, by name.
  static func tableNames(_ c: Connection) throws -> [String] {
    let master = try c.prepared(StoreSQL.masterTables).all { (name: $0.text(0), sql: $0.textOrNil(1) ?? "") }
    let virtual = master.filter { $0.sql.range(of: "^CREATE VIRTUAL TABLE", options: [.regularExpression, .caseInsensitive]) != nil }
      .map(\.name)
    return master.map(\.name).filter { !RowIDPolicy.isShadow($0, virtualTables: virtual) }
  }

  enum DigestEntry {
    case rows(TableDigest)
    case skipped(String)
  }

  /// `JSON.stringify(digest, null, 2) + "\n"`, keys in dump order.
  static func digestJSON(_ entries: [(String, DigestEntry)]) -> String {
    if entries.isEmpty { return "{}\n" }
    var out = "{\n"
    for (k, (name, e)) in entries.enumerated() {
      out += "  \(CanonicalJSON.quote(name)): {\n"
      switch e {
      case .rows(let d):
        out += "    \"rows\": \(d.rows),\n    \"sha256\": \(CanonicalJSON.quote(d.sha256))\n"
      case .skipped(let reason):
        out += "    \"skipped\": \(CanonicalJSON.quote(reason))\n"
      }
      out += k == entries.count - 1 ? "  }\n" : "  },\n"
    }
    return out + "}\n"
  }

  /// A float as the dump writes it: `Number(x.toPrecision(12))`; non-finite → null (IOS-SPEC §2.3).
  public static func float12(_ x: Double) -> JSONValue {
    guard x.isFinite else { return .null }
    if x == x.rounded(.towardZero) { return .number(x) }
    return .number(JSNumber.parse(JSNumber.toPrecision(x, 12)))
  }
}

/// A parsed dump-spec.json.
public struct DumpSpec: Sendable {
  /// How an id column finds the table it points to.
  public enum IDTarget: Sendable, Equatable {
    case `self`
    case table(String)
    /// Polymorphic: the table is named by another column (`by`), optionally through `map`.
    case by(column: String, map: [String: String])
  }

  public struct MaskIf: Sendable {
    public let column: String
    public let values: [String]
    public let mask: Set<String>
  }

  public struct Entry: Sendable {
    public var key: [String] = []
    public var ids: [String: IDTarget] = [:]
    public var mask: Set<String> = []
    public var maskIf: MaskIf?
    public var json: Set<String> = []
    public var text: Set<String> = []
    public var virtual: [String: String] = [:]
    /// `virtual.rows`: the FTS rule (`ftsRule`) or `{fts5vocab, doc}`.
    public var ftsRows: FTSRows?
    public var skip: String?

    /// The "self" id column.
    var selfColumn: String? { ids.first { $0.value == .self }?.key }
  }

  public enum FTSRows: Sendable, Equatable {
    case standard
    case vocab(table: String, doc: String)
  }

  public let tables: [String: Entry]

  /// The bundled `Resources/dump-spec.json`.
  public static func bundled() throws -> DumpSpec { try DumpSpec(json: StoreResources.data("dump-spec.json")) }

  /// Parses and validates a spec.
  public init(json data: Data) throws {
    let root = try JSONValue.parse(data)
    guard let tables = root["tables"]?.objectValue else { throw StoreError.misuse("dump spec has no \"tables\" object") }
    var out: [String: Entry] = [:]
    for (name, v) in tables {
      guard let o = v.objectValue else { throw StoreError.misuse("dump spec: \(name) is not an object") }
      var e = Entry()
      e.skip = o["skip"]?.stringValue
      e.key = o["key"]?.arrayValue?.compactMap(\.stringValue) ?? []
      for (col, target) in o["ids"]?.objectValue ?? JSONObject() {
        if let s = target.stringValue {
          e.ids[col] = s == "self" ? .self : .table(s)
        } else if let t = target.objectValue, let by = t["by"]?.stringValue {
          var map: [String: String] = [:]
          for (k, x) in t["map"]?.objectValue ?? JSONObject() { map[k] = x.stringValue }
          e.ids[col] = .by(column: by, map: map)
        } else {
          throw StoreError.misuse("dump spec: \(name).\(col): unknown id rule")
        }
      }
      e.mask = Set(o["mask"]?.arrayValue?.compactMap(\.stringValue) ?? [])
      e.json = Set(o["json"]?.arrayValue?.compactMap(\.stringValue) ?? [])
      e.text = Set(o["text"]?.arrayValue?.compactMap(\.stringValue) ?? [])
      if let m = o["maskIf"]?.objectValue, let col = m["column"]?.stringValue {
        e.maskIf = MaskIf(column: col, values: m["in"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                          mask: Set(m["mask"]?.arrayValue?.compactMap(\.stringValue) ?? []))
      }
      for (col, rule) in o["virtual"]?.objectValue ?? JSONObject() {
        if col == "rows" {
          if rule.stringValue == LogicalDump.ftsRule {
            e.ftsRows = .standard
          } else if let r = rule.objectValue, let vocab = r["fts5vocab"]?.stringValue {
            e.ftsRows = .vocab(table: vocab, doc: r["doc"]?.stringValue ?? "passage")
          } else {
            throw StoreError.misuse("dump spec: \(name): unknown rows rule")
          }
        } else if let s = rule.stringValue {
          e.virtual[col] = s
        }
      }
      // the one order-independence rule (see the file header)
      for p in e.key where !p.contains(".") && e.ids[p] == nil {
        let via = e.ids.filter { $0.value == .table(p) }
        if via.count > 1 { throw StoreError.misuse("dump spec: \(name): key part '\(p)' maps through \(via.count) id columns") }
      }
      for p in e.key where p.contains(".") {
        let table = String(p[..<p.firstIndex(of: ".")!])
        let via = e.ids.filter { $0.value == .table(table) }
        if via.count > 1 { throw StoreError.misuse("dump spec: \(name): key part '\(p)' maps through \(via.count) id columns") }
      }
      out[name] = e
    }
    self.tables = out
  }
}

/// The dump of one connection: row fetches, natural keys and their memo.
private struct Dumper {
  let c: Connection
  let spec: DumpSpec
  let text: any TextStore
  var keyMemo: [String: JSONValue] = [:]
  var columns: [String: [(name: String, type: String)]] = [:]

  init(c: Connection, spec: DumpSpec, text: any TextStore) {
    self.c = c
    self.spec = spec
    self.text = text
  }

  typealias RowValues = [String: SQLValue]

  mutating func colsOf(_ t: String) throws -> [(name: String, type: String)] {
    if let cols = columns[t] { return cols }
    let cols = try c.prepared(dynamic: "PRAGMA table_info(\(CanonicalJSON.quote(t)))").all { (name: $0.text(1), type: $0.text(2)) }  // lint: sql-ok (table name read from sqlite_master)
    columns[t] = cols
    return cols
  }

  static func rowValues(_ r: Row) -> RowValues {
    var out: RowValues = [:]
    for i in 0..<r.count { out[r.name(i)] = r.value(i) }
    return out
  }

  func fetchRow(_ t: String, _ id: SQLValue) throws -> RowValues? {
    guard let col = spec.tables[t]?.selfColumn else {
      throw StoreError.misuse("dump-spec: \(t) is referenced by id but has no \"self\" id column")
    }
    let s = try c.prepared(dynamic: "SELECT * FROM \(CanonicalJSON.quote(t)) WHERE \(CanonicalJSON.quote(col)) = ?")  // lint: sql-ok (table and column names read from sqlite_master)
    return try s.bindingFirst([id]) { Dumper.rowValues($0) }
  }

  /// The table an id column of `t` points to for `row`.
  func target(_ t: String, _ col: String, _ row: RowValues) throws -> String? {
    guard let to = spec.tables[t]?.ids[col] else { return nil }
    switch to {
    case .self: return t
    case .table(let x): return x
    case .by(let by, let map):
      guard let v = row[by], let key = Dumper.jsString(v) else { return nil }
      return map[key] ?? key
    }
  }

  mutating func naturalKey(_ t: String, _ row: RowValues) throws -> JSONValue {
    guard let parts = spec.tables[t]?.key, !parts.isEmpty else { throw StoreError.misuse("dump-spec: \(t) has no key") }
    return .array(try parts.map { try part(t, row, $0) })
  }

  mutating func keyOfID(_ t: String?, _ id: SQLValue?) throws -> JSONValue {
    guard let id, id != .null else { return .null }
    guard let t else { throw StoreError.misuse("dump-spec: an id points to a table named by a NULL type column") }
    let memo = t + "\u{0}" + (Dumper.jsString(id) ?? "")
    if let k = keyMemo[memo] { return k }
    let k: JSONValue
    if let row = try fetchRow(t, id) {
      k = try naturalKey(t, row)
    } else {
      k = .object(["$dangling": .string(t), "id": Dumper.jsNumber(id)])
    }
    keyMemo[memo] = k
    return k
  }

  mutating func part(_ t: String, _ row: RowValues, _ p: String) throws -> JSONValue {
    let ids = spec.tables[t]?.ids ?? [:]
    if let to = ids[p], to != .self { return try keyOfID(try target(t, p, row), row[p]) }
    let dot = p.firstIndex(of: ".")
    let refTable = dot.map { String(p[..<$0]) } ?? p
    let via = ids.first { $0.value == .table(refTable) }?.key
    if let via, dot == nil { return try keyOfID(refTable, row[via]) }
    if let via, let dot {
      guard let id = row[via], id != .null, let ref = try fetchRow(refTable, id) else { return .null }
      return Dumper.value(ref[String(p[p.index(after: dot)...])] ?? .null)
    }
    guard let v = row[p] else { throw StoreError.misuse("dump-spec: \(t): key part '\(p)' is neither a column nor a referenced table") }
    return Dumper.value(v)
  }

  /// A column value (IOS-SPEC §2.3): integers as is, floats at 12 significant digits, blobs as digests.
  static func value(_ v: SQLValue) -> JSONValue {
    switch v {
    case .null: .null
    case .int(let n): .number(Double(n))
    case .double(let d): LogicalDump.float12(d)
    case .text(let s): .string(s)
    case .blob(let b): .object(["$blob": .string(StoreResources.sha256Hex(Data(b))), "len": .number(Double(b.count))])
    }
  }

  /// `String(v)` in JavaScript, for memo keys and type columns.
  static func jsString(_ v: SQLValue) -> String? {
    switch v {
    case .null: nil
    case .int(let n): String(n)
    case .double(let d): JSNumber.format(d)
    case .text(let s): s
    case .blob: nil
    }
  }

  /// `Number(v)` in JavaScript (NaN → null in canonical JSON).
  static func jsNumber(_ v: SQLValue) -> JSONValue {
    switch v {
    case .int(let n): return .number(Double(n))
    case .double(let d): return d.isFinite ? .number(d) : .null
    case .text(let s):
      let n = JSNumber.parse(s)
      return n.isFinite ? .number(n) : .null
    default: return .null
    }
  }

  static func digest(_ s: String) -> JSONValue {
    .object(["$sha256": .string(TextDigest.sha256Hex(utf8: s)), "len": .number(Double(s.utf16.count))])
  }

  mutating func rows(_ t: String) throws -> [(key: String, line: String)] {
    let s = spec.tables[t]!
    let cols = try colsOf(t)
    // rows are read one at a time (key lookups run other statements meanwhile), so only the output lines are held
    let scan = try c.prepared(dynamic: "SELECT * FROM \(CanonicalJSON.quote(t))")  // lint: sql-ok (table name read from sqlite_master)
    defer { _ = try? scan.reset() }
    var lines: [(key: String, line: String)] = []
    while let r = try scan.step() {
      let row = Dumper.rowValues(r)
      let key = try naturalKey(t, row)
      var out: JSONObject = ["$key": key]
      var rowMasked: Set<String> = []
      if let m = s.maskIf, case .text(let v)? = row[m.column], m.values.contains(where: { JSString.equal($0, v) }) {
        rowMasked = m.mask
      }
      for (name, _) in cols {
        let to = s.ids[name]
        if to == .self { continue }
        let raw = row[name] ?? .null
        let v: JSONValue
        if raw != .null, s.mask.contains(name) || rowMasked.contains(name) {
          v = .string(LogicalDump.masked)
        } else if to != nil {
          v = try keyOfID(try target(t, name, row), raw)
        } else if let rule = s.virtual[name] {
          v = try virtualValue(rule, t, name, raw, row)
        } else if s.json.contains(name) {
          v = try Dumper.json(raw, t, name)
        } else if s.text.contains(name) {
          v = raw == .null ? .null : Dumper.digest(Dumper.jsString(raw) ?? "")
        } else {
          v = Dumper.value(raw)
        }
        out[name] = v
      }
      lines.append((CanonicalJSON.string(key), CanonicalJSON.string(.object(out))))
    }
    return lines
  }

  static func json(_ raw: SQLValue, _ t: String, _ col: String) throws -> JSONValue {
    switch raw {
    case .null: return .null
    case .text(let x):
      do { return try JSONValue.parse(x) } catch { throw StoreError.misuse("\(t).\(col) is not JSON: \(error)") }
    case .int(let n): return .number(Double(n))  // JSON.parse(String(n)) is the number itself
    case .double(let d): return d.isFinite ? .number(d) : .null
    case .blob: throw StoreError.misuse("\(t).\(col) is a blob, not JSON")
    }
  }

  func virtualValue(_ rule: String, _ t: String, _ col: String, _ raw: SQLValue, _ row: RowValues) throws -> JSONValue {
    switch rule {
    case "TextStore.fullText → sha256":
      if raw == .null { return .null }
      guard case .int(let doc)? = row["document_id"] else { throw StoreError.misuse("\(t).\(col): no document_id") }
      return Dumper.digest(try text.fullText(DocumentID(rawValue: doc), on: c))
    case "Revisions.expanded":
      guard case .text(let stored) = raw else { return raw == .null ? .null : Dumper.value(raw) }
      guard case .int(let rel)? = row["relationship_id"] else { throw StoreError.misuse("\(t).\(col): no relationship_id") }
      return try CompactRevisions.expanded(stored, relationship: rel, on: c)
    default:
      throw StoreError.misuse("dump-spec: \(t).\(col): unknown virtual rule '\(rule)'")
    }
  }

  mutating func fts(_ t: String, rule: DumpSpec.FTSRows) throws -> [(key: String, line: String)] {
    let vocab: String, docTable: String
    switch rule {
    case .standard:
      guard t == "passage_fts" else { throw StoreError.misuse("dump-spec: \(t): unknown rows rule") }
      (vocab, docTable) = ("passage_vocab_inst", "passage")
    case .vocab(let v, let d): (vocab, docTable) = (v, d)
    }
    let rows = try c.prepared(dynamic: "SELECT term, doc, col, offset FROM \(CanonicalJSON.quote(vocab))").all {  // lint: sql-ok (fts5vocab table named by dump-spec.json)
      (term: $0.value(0), doc: $0.value(1), col: $0.value(2), offset: $0.value(3))
    }
    var lines: [(key: String, line: String)] = []
    lines.reserveCapacity(rows.count)
    for r in rows {
      let docKey = try keyOfID(docTable, r.doc)
      let tail: [JSONValue] = [docKey, Dumper.value(r.col), Dumper.value(r.offset)]
      lines.append((CanonicalJSON.string(.array(tail)), CanonicalJSON.string(.array([Dumper.value(r.term)] + tail))))
    }
    return lines
  }
}
