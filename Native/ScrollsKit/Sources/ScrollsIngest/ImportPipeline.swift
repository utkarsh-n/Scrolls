// OWNER: N1
// Port of ingest/pipeline.mjs (IOS-SPEC §1.3, §3.10; SPEC §5): stage → sniff and decode (UTF-8, Windows-1252) →
// preview and suggested mapping → validating dry run → journaled commit and revert jobs → summary and problems.csv.
// One driver (`ImportRun`) feeds records through the mapping into a sink: DocumentWriter at commit (a `WriterSession`
// inside the writer's lease batches), the projector in the dry run. Both therefore see the same rows, the same
// rejections and the same issue texts. This file: limits, records, the preview, mapping checks and reuse.
// M1 reads a file whole (up to 400 MB of text); the chunked reader for CSV, TSV and JSON Lines up to 2 GB is M2.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The import pipeline.
public enum ImportPipeline {
  /// The pipeline version import runs record (`ingest/pipeline.mjs` PIPELINE_VERSION).
  public static let version = "import@1.0.0"
  /// Largest upload (§5.1).
  public static let maxUploadBytes = 2 * 1024 * 1024 * 1024
  /// Largest file read whole.
  public static let maxParseBytes = 400 * 1024 * 1024
  /// Most rows per import (§5.1).
  public static let maxRows = 5_000_000
  /// CSV, TSV and JSON Lines files above this size are read in chunks by the reference (M2 here).
  public static let streamAboveBytes = 64 * 1024 * 1024
  static let previewRecords = 200
  static let sampleRows = 20
  static let sampleChars = 280
  static let bulkFTSChars = 20 * 1024 * 1024
  static let reuseScan = 200
  static let reuseOffered = 5

  // MARK: overrides

  /// The preview's overrides (GET …/preview?format=&delimiter=&header=&pointer=&encoding=&line_mode=).
  public struct Overrides: Sendable, Equatable {
    public var format: String?
    public var delimiter: String?
    public var header: Bool?
    public var pointer: String?
    public var encoding: String?
    public var lineMode: Bool?
    public init(format: String? = nil, delimiter: String? = nil, header: Bool? = nil, pointer: String? = nil, encoding: String? = nil,
                lineMode: Bool? = nil) {
      self.format = format
      self.delimiter = delimiter
      self.header = header
      self.pointer = pointer
      self.encoding = encoding
      self.lineMode = lineMode
    }
    public var isEmpty: Bool { self == Overrides() }
    /// As stored in options_json.overrides (only the keys given).
    public var json: JSValue {
      var o = JSObject()
      if let format { o["format"] = .string(format) }
      if let delimiter { o["delimiter"] = .string(delimiter) }
      if let header { o["header"] = .bool(header) }
      if let pointer { o["pointer"] = .string(pointer) }
      if let encoding { o["encoding"] = .string(encoding) }
      if let lineMode { o["line_mode"] = .bool(lineMode) }
      return .object(o)
    }
  }

  static let delimiterWords: [String: String] = ["comma": ",", "tab": "\t", "\\t": "\t", "semicolon": ";", "pipe": "|", ",": ",", "\t": "\t",
                                                 ";": ";", "|": "|"]

  /// `overridesOf(query)` of routes/imports.mjs: the request checked (400 E_BAD_FORMAT, E_BAD_DELIMITER, E_BAD_ENCODING).
  public static func overrides(_ r: ImportPreviewRequest) throws -> Overrides {
    var o = Overrides()
    if let f = r.format, !f.isEmpty {
      guard Sniff.fileFormats.contains(f) else {
        throw ScrollsError(code: ErrorCode(rawValue: "E_BAD_FORMAT"), message: "Unknown format '\(f)'.",
                           hint: "Use one of \(Sniff.fileFormats.joined(separator: ", ")).", status: 400)
      }
      o.format = f
    }
    if let d = r.delimiter, !d.isEmpty {
      let v = delimiterWords[d] ?? (d.utf16.count == 1 ? d : nil)
      guard let v, !v.utf16.contains(where: { $0 == 0x0D || $0 == 0x0A || $0 == 0x22 }) else {
        throw ScrollsError(code: ErrorCode(rawValue: "E_BAD_DELIMITER"), message: "'\(d)' cannot be a delimiter.",
                           hint: "Use comma, tab, semicolon or pipe.", status: 400)
      }
      o.delimiter = v
    }
    o.header = r.header
    o.pointer = r.pointer
    if let e = r.encoding, !e.isEmpty {
      guard Decode.encodings.contains(e) else {
        throw ScrollsError(code: ErrorCode(rawValue: "E_BAD_ENCODING"), message: "Unknown encoding '\(e)'.", hint: "Use utf-8 or windows-1252.",
                           status: 400)
      }
      o.encoding = e
    }
    o.lineMode = r.lineMode
    return o
  }

  // MARK: records

  /// A decoded file opened as records (`openRecords`).
  public struct Records: Sendable {
    public var columns: [String]?
    public var issues: [Issue]
    public var fatal: Issue?
    public var records: [RawRecord]
    public var pointer: String?
    public var candidates: [(pointer: String, count: Int)]
    public var delimiter: String?
  }

  /// `numbered(records)`: ordinals 1, 2, …; a fatal record ends the list.
  static func numbered(_ rs: [RawRecord]) -> [RawRecord] {
    var out: [RawRecord] = []
    out.reserveCapacity(rs.count)
    var k = 0
    for var r in rs {
      if r.fatal != nil {
        out.append(r)
        break
      }
      k += 1
      r.ordinal = k
      out.append(r)
    }
    return out
  }

  /// `openRecords(text, {format, delimiter, header, pointer, fileName, lineMode})`.
  public static func openRecords(_ text: [UInt16], format: String, delimiter: String?, header: Bool?, pointer: String?, fileName: String,
                                 lineMode: Bool) throws -> Records {
    switch format {
    case "csv", "tsv":
      let d = (delimiter?.isEmpty == false ? delimiter : nil) ?? (format == "tsv" ? "\t" : CSV.sniffDelimiter(text))
      let t = CSV.open(text, delimiter: d, header: header ?? true)
      return Records(columns: t.columns, issues: t.fatal != nil ? [] : t.issues, fatal: t.fatal, records: numbered(t.rows), pointer: nil,
                     candidates: [], delimiter: d)
    case "json":
      let j = JSONRecords.parse(text, pointer: pointer)
      return Records(columns: nil, issues: j.issues.filter { $0 != j.fatal }, fatal: j.fatal, records: numbered(j.records), pointer: j.pointer,
                     candidates: j.candidates, delimiter: nil)
    case "jsonl":
      return Records(columns: nil, issues: [], fatal: nil, records: numbered(JSONRecords.lines(text)), pointer: nil, candidates: [], delimiter: nil)
    case "txt", "md":
      let s = String(decoding: text, as: UTF16.self)
      let f = format == "md" ? TextFiles.parseMd(s, fileName: fileName, lineMode: lineMode) : TextFiles.parseTxt(s, fileName: fileName, lineMode: lineMode)
      var r = RawRecord(line: 1, start: 0, end: text.count, data: f.data)
      r.document = f.document
      r.headerKind = f.headerKind
      return Records(columns: f.data.keys, issues: f.issues, fatal: nil, records: numbered([r]), pointer: nil, candidates: [], delimiter: nil)
    default:
      throw ScrollsError(code: ErrorCode(rawValue: "E_FORMAT"), message: "Unknown import format '\(format)'.",
                         hint: "Use one of \(Sniff.fileFormats.joined(separator: ", ")).", status: 400)
    }
  }

  // MARK: the preview

  /// Columns of JSON records: top-level keys, plus '/key/sub' pointers one level into nested objects.
  static func jsonColumns(_ records: [RawRecord]) -> [String] {
    var names: [String] = []
    var seen = Set<UnitKey>()
    func add(_ n: String) { if seen.insert(UnitKey(n)).inserted { names.append(n) } }
    for r in records {
      for (k, v) in (r.data ?? JSObject()).entries {
        add(k)
        if case .object(let o) = v { for sub in o.keys { add(JSONRecords.pointerOf([k, sub])) } }
      }
    }
    return names
  }

  /// `clip(v)`: text longer than 280 units ends in '…'.
  static func clip(_ s: String) -> String { s.utf16.count > sampleChars ? JSString.slice(s, 0, sampleChars) + "…" : s }

  static func clipDeep(_ v: JSValue) -> JSValue {
    switch v {
    case .string(let s): .string(clip(s))
    case .array(let a): .array(a.prefix(20).map(clipDeep))
    case .object(let o): .object(JSObject(o.entries.prefix(40).map { ($0.key, clipDeep($0.value)) }))
    default: v
    }
  }

  /// `columnValue(data, name)`: a key, or a '/key/sub' pointer one level down.
  static func columnValue(_ data: JSObject?, _ name: String) -> JSValue? {
    guard let data else { return nil }
    if let v = data[name] { return v }
    if name.hasPrefix("/") {
      let parts = JSString.split(JSString.slice(name, 1), "/").map { JSString.split(JSString.split($0, "~1").joined(separator: "/"), "~0").joined(separator: "~") }
      let a = parts[0], b: String? = parts.count > 1 ? parts[1] : nil
      if case .object(let inner)? = data[a], let b { return inner[b] }
      return nil
    }
    return nil
  }

  /// `displayValue(v)`.
  static func displayValue(_ v: JSValue?) -> String {
    switch v {
    case nil, .null?: ""
    case .string(let s)?: clip(s)
    case .number?, .bool?: JSText.string(v!)
    case let x?: clip(JSText.stringify(x))
    }
  }

  /// What `buildPreview` gives: the preview object (contract `ImportPreview` plus the reference's members) and the sniff
  /// facts kept in options_json.
  public struct Preview: Sendable {
    public var preview: JSValue
    public var sniff: JSValue
    public var columns: [String]
    public var encoding: String
    public var bom: Bool
    public var format: String
  }

  /// `buildPreview({bytes, fileName, collection, overrides, now})` (§5.2 step 1).
  public static func buildPreview(bytes: [UInt8], fileName: String, collection: Suggest.CollectionHint?, overrides: Overrides = Overrides(),
                                  now: Date) throws -> Preview {
    let sniff = Sniff.sniffFormat(bytes, fileName: fileName)
    let dec = Decode.decode(bytes, encoding: overrides.encoding ?? "auto")
    var issues = dec.issues
    let format = overrides.format.flatMap { Sniff.fileFormats.contains($0) ? $0 : nil } ?? sniff.format
    let isTable = format == "csv" || format == "tsv"
    func base(_ o: inout JSObject) {
      o["format"] = .string(format)
      o["encoding"] = .string(dec.encoding)
      o["delimiter"] = .null
      o["header"] = .null
    }
    if let fatal = dec.fatal {
      var p = JSObject()
      base(&p)
      p["columns"] = .array([])
      p["sample_rows"] = .array([])
      p["issues"] = .array(issues.map(issueValue))
      p["fatal"] = issueValue(fatal)
      p["suggested_mapping"] = .object(Suggest.suggestMapping([], format: format, fileName: fileName, collection: collection, now: now))
      p["records_sampled"] = .number(0)
      var s = JSObject([("format", .string(sniff.format)), ("encoding", .string(sniff.encoding)),
                        ("delimiter", sniff.delimiter.map(JSValue.string) ?? .null), ("header", sniff.header.map(JSValue.bool) ?? .null),
                        ("issues", .array(sniff.issues.map(issueValue)))])
      base(&s)
      s["bom"] = .bool(dec.bom)
      s["columns"] = .array([])
      return Preview(preview: .object(p), sniff: .object(s), columns: [], encoding: dec.encoding, bom: dec.bom, format: format)
    }
    let text = Array(dec.text.utf16)
    let delimiter: String? = isTable
      ? (overrides.delimiter ?? (format == "tsv" ? "\t" : sniff.format == format ? sniff.delimiter : nil) ?? CSV.sniffDelimiter(text)) : nil
    let header: Bool? = isTable ? (overrides.header ?? (sniff.format == format ? sniff.header : nil) ?? true) : nil
    var src = try openRecords(text, format: format, delimiter: delimiter, header: header, pointer: overrides.pointer, fileName: fileName,
                              lineMode: overrides.lineMode ?? false)
    issues += src.issues
    if let f = src.fatal { issues.append(f) }
    if (format == "txt" || format == "md") && text.count > 20 * 1024 * 1024 {
      let mbs = JSNumber.toFixed(Double(text.count) / 1_048_576, 0)
      let tooBig = Issue(code: "E_ROW_TOO_LARGE", severity: "fatal", line: nil, col: nil, field: "text", valueExcerpt: nil,
        message: "This \(format.uppercased()) file holds \(mbs) M characters of text: it would be one document, and a document holds at most 20 MB.",
        suggestion: "Split it into one file per chapter or part, each under 20 MB, and import them into one collection.")
      issues.append(tooBig)
      src.fatal = src.fatal ?? tooBig
    }
    var sampled: [RawRecord] = []
    var rejectedSeen = 0
    var midFatal: Issue?
    for r in src.records {
      if let f = r.fatal {
        issues.append(f)
        midFatal = f
        break
      }
      if let i = r.issue {
        if rejectedSeen < sampleRows { issues.append(i) }
        rejectedSeen += 1
        continue
      }
      for w in r.warnings {
        if rejectedSeen < sampleRows { issues.append(w) }
        rejectedSeen += 1
      }
      sampled.append(r)
      if sampled.count >= previewRecords { break }
    }
    let names = src.columns ?? jsonColumns(sampled)
    struct Col {
      var name: String
      var samples: [String]
      var values: [JSValue?]
      var inferred: String
      var inf: ColumnInference
    }
    let cols = names.map { name -> Col in
      let values = sampled.map { columnValue($0.data, name) }
      let inf = Suggest.inferColumn(name, values, now: now)
      let objects = values.filter { if case .object? = $0 { true } else { false } }.count
      return Col(name: name, samples: values.prefix(5).map(displayValue), values: values,
                 inferred: Double(objects) > Double(values.count) / 2 ? "object" : inf.inferred, inf: inf)
    }
    var suggested = Suggest.suggestMapping(
      cols.filter { $0.inferred != "object" }.map { SuggestColumn(name: $0.name, samples: $0.samples.map { .string($0) }, values: $0.values) },
      format: format, delimiter: src.delimiter ?? delimiter, header: header, encoding: dec.encoding, pointer: src.pointer, fileName: fileName,
      collection: collection, now: now)
    if format == "json", let ptr = src.pointer { suggested["pointer"] = .string(ptr) }
    if overrides.lineMode == true, case .object(var o)? = suggested["options"] {
      o["line_mode"] = .bool(true)
      suggested["options"] = .object(o)
    }
    var p = JSObject()
    base(&p)
    p["delimiter"] = (src.delimiter ?? delimiter).map(JSValue.string) ?? .null
    p["header"] = header.map(JSValue.bool) ?? .null
    if format == "json" {
      p["pointer"] = src.pointer.map(JSValue.string) ?? .null
      p["pointer_candidates"] = .array(src.candidates.map { .object(JSObject([("pointer", .string($0.pointer)), ("count", .number(Double($0.count)))])) })
    }
    p["columns"] = .array(cols.map { c in
      .object(JSObject([("name", .string(c.name)), ("samples", .array(c.samples.map(JSValue.string))), ("inferred", .string(c.inferred)),
                        ("filled", .number(Double(c.inf.filled))), ("avg_length", .number(JSNumber.round(c.inf.avgLength))),
                        ("date_share", .number(JSNumber.round(c.inf.dateShare * 1000) / 1000))]))
    })
    p["sample_rows"] = .array(sampled.prefix(sampleRows).map { r in
      var o = clipDeep(.object(r.data ?? JSObject())).objectValue ?? JSObject()
      o["$line"] = r.line.map { .number(Double($0)) } ?? .null
      return .object(o)
    })
    p["suggested_mapping"] = .object(suggested)
    p["issues"] = .array(issues.map(issueValue))
    p["records_sampled"] = .number(Double(sampled.count))
    p["fatal"] = (src.fatal ?? midFatal).map(issueValue) ?? .null
    let sniffOut = JSObject([("format", .string(format)), ("encoding", .string(dec.encoding)), ("delimiter", p["delimiter"]!),
                             ("header", header.map(JSValue.bool) ?? .null), ("pointer", src.pointer.map(JSValue.string) ?? .null),
                             ("bom", .bool(dec.bom)), ("columns", .array(names.map(JSValue.string))), ("sniffed", .string(sniff.format))])
    return Preview(preview: .object(p), sniff: .object(sniffOut), columns: names, encoding: dec.encoding, bom: dec.bom, format: format)
  }

  /// An issue as a JavaScript value, in the reference's key order.
  public static func issueValue(_ i: Issue) -> JSValue {
    .object(JSObject([("code", .string(i.code)), ("severity", .string(i.severity)), ("line", i.line.map { .number(Double($0)) } ?? .null),
                      ("col", i.col.map { .number(Double($0)) } ?? .null), ("field", i.field.map(JSValue.string) ?? .null),
                      ("value_excerpt", i.valueExcerpt.map(JSValue.string) ?? .null), ("message", .string(i.message)),
                      ("suggestion", .string(i.suggestion))]))
  }

  /// `readForParse(file)`: the bytes of a file read whole (413 E_FILE_TOO_LARGE above 400 MB).
  public static func readForParse(_ url: URL) throws -> [UInt8] {
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    if size > maxParseBytes {
      throw ScrollsError(code: ErrorCode(rawValue: "E_FILE_TOO_LARGE"),
                         message: "The file is \(JSNumber.toFixed(Double(size) / 1_048_576, 0)) MB; JSON, TXT and Markdown files are read whole, up to \(maxParseBytes / 1_048_576) MB.",
                         hint: "Save JSON records as JSON Lines (read in chunks, up to 2 GB), or split the file into parts.",
                         detail: ["bytes": .number(Double(size))], status: 413)
    }
    return [UInt8](try Data(contentsOf: url, options: .mappedIfSafe))
  }

  /// `previewQuery(db, {path, fileName, collection, overrides, batchId})`: the preview of a stored file, with its size and
  /// the mappings of earlier imports of a file with the same columns.
  public static func previewFile(_ url: URL, fileName: String, collection: Suggest.CollectionHint?, overrides: Overrides, batch: Int64?,
                                 on c: Connection?, now: Date = Date()) throws -> Preview {
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    var out = try buildPreview(bytes: try readForParse(url), fileName: fileName, collection: collection, overrides: overrides, now: now)
    guard case .object(var p) = out.preview else { return out }
    p["file"] = .object(JSObject([("name", .string(fileName)), ("bytes", .number(Double(size)))]))
    if let c {
      p["previous_mappings"] = .array(try previousMappings(c, columns: out.columns, format: out.format, exceptBatch: batch))
    }
    out.preview = .object(p)
    return out
  }

  /// `previousMappings(db, {columns, format, exceptBatch})` (§5.2 mapping reuse): the newest validated or committed file
  /// imports whose columns are this file's.
  public static func previousMappings(_ c: Connection, columns: [String], format: String, exceptBatch: Int64?) throws -> [JSValue] {
    if columns.isEmpty { return [] }
    func key(_ cols: [String]) -> String { cols.sorted(by: CanonicalJSON.codeUnitLess).joined(separator: "\u{0}") }
    let want = key(columns)
    var out: [JSValue] = []
    let rows = try c.prepared(ImportSQL.previousMappings).bindingAll([.integer(exceptBatch.map(Int.init)), .int(Int64(reuseScan))]) { r in
      (id: r.int(0), fileName: r.textOrNil(1), status: r.text(2), createdAt: r.text(3), committedAt: r.textOrNil(4), format: r.text(5),
       mapping: r.text(6), options: r.text(7))
    }
    for r in rows {
      let opts = (try? JSONParser.parse(r.options)) ?? .object(JSObject())
      guard case .array(let cols)? = opts["columns"], key(cols.map(JSText.string)) == want else { continue }
      guard case .object(var mapping)? = try? JSONParser.parse(r.mapping), let f = mapping["fields"]?.objectValue, !f.isEmpty else { continue }
      let coll = mapping["collection"]
      mapping["collection"] = nil
      mapping["collection"] = coll ?? .null
      let slug: JSValue = coll?["slug"] ?? .null
      out.append(.object(JSObject([("batch", .number(Double(r.id))), ("file_name", r.fileName.map(JSValue.string) ?? .null),
                                   ("status", .string(r.status)), ("at", .string(r.committedAt ?? r.createdAt)),
                                   ("collection", slug), ("same_format", .bool(r.format == format)), ("mapping", .object(mapping))])))
      if out.count >= reuseOffered { break }
    }
    return out
  }

  // MARK: mappings

  /// `batchOptions(batch)`: the options stored with a batch at upload (sniff results, preview, collection).
  public static func batchOptions(_ b: BatchRow) -> JSObject { ((try? JSONParser.parse(b.optionsJSON)) ?? .null).objectValue ?? JSObject() }

  /// `checkMapping(batch, rawMapping)`: normalized and checked against the batch; 400 E_MAPPING_INVALID lists every problem.
  public static func checkMapping(_ b: BatchRow, _ rawMapping: JSValue?) throws -> MappingValidation {
    let opts = batchOptions(b)
    var raw = rawMapping?.objectValue ?? JSObject()
    let given = raw["format"]?.stringValue
    raw["format"] = .string(given.flatMap { Sniff.fileFormats.contains($0) ? $0 : nil } ?? b.format)
    let columns = opts["columns"]?.arrayValue?.map(JSText.string)
    var v = Validate.validateMapping(.object(raw), columns: columns, format: raw["format"]?.stringValue)
    if let e = v.errors.first {
      let errors: [JSONValue] = v.errors.map {
        ["target": $0.target.map(JSONValue.string) ?? .null, "message": .string($0.message), "hint": .string($0.hint),
         "from": $0.from?.json ?? .null]
      }
      throw ScrollsError(code: ErrorCode(rawValue: "E_MAPPING_INVALID"), message: e.message, hint: e.hint,
                         detail: ["target": e.target.map(JSONValue.string) ?? .null, "from": e.from?.json ?? .null, "errors": .array(errors)],
                         status: 400)
    }
    if var c = v.mapping.collection {
      c["slug"] = .string(IDs.slug(c["slug"].map(JSText.string) ?? ""))
      v.mapping.object["collection"] = .object(c)
    }
    return v
  }
}
