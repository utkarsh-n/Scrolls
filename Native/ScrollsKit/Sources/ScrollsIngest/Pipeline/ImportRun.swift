// OWNER: N1
// `runImport` of ingest/pipeline.mjs: every record of a decoded file through the mapping into a sink (DocumentWriter at
// commit, the projector in the dry run). Pre-checks shared by both: the row's own parse issues, size, missing text and
// title, repeated or existing ids. Relationships are handed over at the end, once every id of the file is known.
//
// The loop is resumable: `step` processes records until the caller's batch is full (the commit runs it inside the
// writer's lease batches, one transaction each), and `finishLinks` hands the relationships over. The dry run runs it in
// one go inside a read.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One run of the import loop over a decoded file.
public final class ImportRun: @unchecked Sendable {
  public let mapping: Mapping
  let records: [RawRecord]
  let text: [UInt16]
  let decoder: String
  let bomBytes: Int
  let fileName: String
  let sha256: String
  let format: String
  let now: Date
  let batchID: Int64?
  let abort: Bool

  public private(set) var rows = RowTally()
  public private(set) var dateStats: [String: DateStat] = [:]
  public private(set) var fatal: Issue?
  public private(set) var aborted: Issue?
  var cursor = 0
  var ids: Dedupe.IdTracker?
  var fileIDs = Set<UnitKey>()
  var rels: [CanonicalRelationship] = []
  var lastChar = 0
  var lastByte: Int
  var started = false
  /// Called with (fraction, line, rows) at most every 200 ms.
  public var onProgress: ((Double, Int?, RowTally) -> Void)?
  /// Called before every record (a job's `checkStop`): throwing stops the run.
  public var checkStop: (() throws -> Void)?
  var lastTick = ContinuousClock.now

  /// The run over `records` (from `ImportPipeline.openRecords`) of the decoded `text`.
  public init(records: ImportPipeline.Records, text: [UInt16], decoder: String, bomBytes: Int, mapping: Mapping, fileName: String,
              sha256: String, format: String, batchID: Int64?, now: Date) {
    self.mapping = mapping
    self.records = records.records
    self.text = text
    self.decoder = decoder
    self.bomBytes = bomBytes
    self.fileName = fileName
    self.sha256 = sha256
    self.format = format
    self.batchID = batchID
    self.now = now
    self.abort = mapping.onBadRow == "abort"
    self.lastByte = bomBytes
    for t in ["date", "referenced_date"] where mapping.field(t) != nil { dateStats[t] = DateStat() }
    self.fatal = records.fatal
    self.sourceIssues = records.fatal == nil ? records.issues : []
  }

  /// The source's own issues (header problems), handed to the sink first.
  let sourceIssues: [Issue]

  public var isFinished: Bool { fatal != nil || aborted != nil || cursor >= records.count }

  /// UTF-8 byte offset of code unit `c` (incremental over increasing offsets).
  func byteAt(_ c: Int) -> Int {
    if decoder == "windows-1252" { return bomBytes + c }
    if c < lastChar {
      lastChar = 0
      lastByte = bomBytes
    }
    lastByte += Decode.utf8Length(text, lastChar, c)
    lastChar = c
    return lastByte
  }

  func reject(_ sink: ImportSink, _ issue: Issue) throws {
    try sink.addIssue(issue)
    rows.rejected += 1
    if abort { aborted = issue }
  }

  /// Processes records until the run ends or `full()` says the caller's batch is full; returns whether the loop ended.
  public func step(_ sink: ImportSink, on c: Connection?, full: () -> Bool = { false }) throws -> Bool {
    if !started {
      started = true
      if fatal != nil { return true }
      for i in sourceIssues { try sink.addIssue(i) }
      ids = Dedupe.IdTracker(collection: mapping.collectionSlug)
    }
    let ctx = MappingContext(fileName: fileName, sha256: sha256, decoder: decoder, batchID: batchID, format: format, now: now)
    var worked = false
    while cursor < records.count && fatal == nil && aborted == nil {
      if worked && full() { break }
      worked = true
      let rec = records[cursor]
      cursor += 1
      try checkStop?()
      if let f = rec.fatal {
        fatal = f
        break
      }
      rows.seen += 1
      if rows.seen > ImportPipeline.maxRows {
        fatal = Issue(code: "E_ROW_TOO_LARGE", severity: "fatal", line: rec.line, col: nil, field: nil, valueExcerpt: nil,
          message: "The file has more than \(Format.int(ImportPipeline.maxRows)) records (the limit per import).",
          suggestion: "Split the file and import the parts into one collection.")
        break
      }
      if let i = rec.issue {
        try reject(sink, i)
        if aborted != nil { break }
        continue
      }
      var rctx = ctx
      rctx.byteRange = (rec.byteStart ?? byteAt(rec.start), rec.byteEnd ?? byteAt(rec.end))
      let res = MappingRules.apply(rec, mapping, rctx)
      if let e = res.extID { fileIDs.insert(UnitKey(e)) }
      for t in ["date", "referenced_date"] {
        guard dateStats[t] != nil, let st = res.stats[t], let s = st else { continue }
        dateStats[t]!.nonEmpty += 1
        if s == "parsed" { dateStats[t]!.parsed += 1 }
      }
      let pre = rec.warnings + res.issues
      for i in pre { try sink.addIssue(i) }
      if let r = res.reject {
        try reject(sink, r)
        if aborted != nil { break }
        continue
      }
      let doc = res.doc!
      if let dup = try ids!.check(doc.extId, line: rec.line, on: c) {
        try reject(sink, dup)
        if aborted != nil { break }
        continue
      }
      let out = try sink.addDocument(doc, line: rec.line)
      if out.document == nil {
        rows.rejected += 1
        if abort {
          aborted = out.issues.last
          break
        }
        continue
      }
      ids!.accept(doc.extId, line: rec.line)
      rows.accepted += 1
      if pre.contains(where: { $0.severity == "warning" }) || out.issues.contains(where: { $0.severity == "warning" }) {
        rows.acceptedWithWarnings += 1
      }
      rels += res.rels
      let t = ContinuousClock.now
      if t - lastTick >= .milliseconds(200) {
        lastTick = t
        let fraction = text.isEmpty ? 1 : Double(rec.end) / Double(text.count)
        onProgress?(fraction, rec.line, rows)
      }
    }
    return isFinished
  }

  /// After the loop: W_NO_RECORDS for a file with nothing to import, then the relationships (namespaced ids that are
  /// neither in this file nor in the collection may name one document elsewhere in Scrolls).
  public func finishLinks(_ sink: ImportSink, on c: Connection?) throws {
    if fatal == nil && aborted == nil && rows.seen == 0 {
      let tabular = (format == "csv" || format == "tsv") && (mapping.header ?? true)
      try sink.addIssue(Issue(code: "W_NO_RECORDS", severity: "warning", line: tabular ? 1 : nil, col: nil, field: nil, valueExcerpt: nil,
        message: tabular ? "The file has a header row but no records: nothing will be imported." : "The file holds no records: nothing will be imported.",
        suggestion: tabular ? "Check that this is the right file and that its records follow the header row."
          : "Check that this is the right file and that the mapping points at the array that holds the records."))
    }
    if fatal != nil || aborted != nil { return }
    let slug = mapping.collectionSlug
    for var rel in rels {
      let d = rel.dst
      if let c, let ext = d.extId, !ext.isEmpty, (d.collection ?? "").isEmpty, ImportRun.isNamespaced(ext), !fileIDs.contains(UnitKey(ext)),
         try c.prepared(ImportSQL.liveExtInCollectionSlug).bindingFirst([.text(slug), .text(ext)], { _ in true }) == nil,
         let id = try Collections.resolveExt(collection: nil, extID: ext, on: c) {
        rel.dst = CanonicalEndpoint(ref: "document:\(id)")
      }
      try sink.addRelationship(rel)
    }
  }

  /// `/^[\p{L}\p{N}_.-]+:\S/u`: a namespaced id ('pg:1342', 'cw:4948').
  static func isNamespaced(_ s: String) -> Bool {
    let scalars = Array(s.unicodeScalars)
    var i = 0
    while i < scalars.count {
      let v = scalars[i].value
      if v == 0x5F || v == 0x2E || v == 0x2D || !TokenClassTable.classes(v).isDisjoint(with: [.letter, .number]) { i += 1 } else { break }
    }
    guard i > 0, i + 1 < scalars.count, scalars[i] == ":" else { return false }
    let next = String(scalars[i + 1])
    return !next.utf16.allSatisfy(JSString.isWhitespace)
  }
}
