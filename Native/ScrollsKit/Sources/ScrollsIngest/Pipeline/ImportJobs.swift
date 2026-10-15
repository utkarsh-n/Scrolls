// OWNER: N1
// The heavy steps of ingest/pipeline.mjs: the validating dry run (a read: nothing is written to the atlas; every issue
// goes to the batch's dry-run problems.csv), the commit ('import' job: every record into DocumentWriter; on a fatal
// problem, an abort or a cancel the batch is rolled back — zero documents — and the summary says why) and the revert
// ('revert' job: soft delete, then data_version bumps). Commit and revert end in the job's journaled commit (§6.2), so
// a journal replay re-runs them.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

extension ImportPipeline {
  // MARK: batches and files

  /// `getBatch(db, id)`: the import_batch row of a file import, or 404.
  public static func batch(_ id: Int64, on c: Connection) throws -> BatchRow {
    guard id > 0, let b = try Collections.batch(id, on: c) else { throw ScrollsError(code: .notFound, message: "No import batch \(id).", status: 404) }
    guard b.adapterID.hasPrefix("file.") else {
      throw ScrollsError(code: .notFound, message: "Import batch \(id) is not a file import (adapter \(b.adapterID)).", status: 404)
    }
    return b
  }

  /// The stored original of a batch (`originalPath`): 409 when the batch has none.
  public static func originalURL(_ b: BatchRow, root: URL, on c: Connection) throws -> URL {
    guard let sha = b.fileSha256,
          let rel = try c.prepared(IngestSQL.originalFile).bindingFirst([.text(sha)], { $0.text(0) }) else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_IMPORT_STATE"), message: "Import batch \(b.id) has no stored file.",
                         hint: "Upload the file again.", status: 409)
    }
    return root.appendingPathComponent(rel)
  }

  /// A stored file opened for a dry run or a commit: decoded whole (`openForRun`).
  public struct Opened: Sendable {
    public var dec: Decoded
    public var size: Int
    public var text: [UInt16]
    public var textChars: Int
  }

  public static func openForRun(_ url: URL, _ m: Mapping) throws -> Opened {
    let bytes = try readForParse(url)
    let dec = Decode.decode(bytes, encoding: m.encoding ?? "auto")
    let text = Array(dec.text.utf16)
    return Opened(dec: dec, size: bytes.count, text: text, textChars: text.count)
  }

  /// `fileInfo(db, batch, decoded, mapping)`.
  static func fileFacts(_ b: BatchRow, _ dec: Decoded?, _ m: Mapping, on c: Connection) throws -> ImportFileFacts {
    let bytes = try b.fileSha256.flatMap { try c.prepared(IngestSQL.originalFile).bindingFirst([.text($0)], { Int($0.int(1)) }) } ?? 0
    return ImportFileFacts(name: b.fileName ?? "upload", sha256: b.fileSha256, bytes: bytes, encoding: dec?.encoding ?? "unknown", format: b.format,
                           delimiter: b.format == "csv" || b.format == "tsv" ? m.delimiter : nil)
  }

  /// `stripMapping(m)` as JSON text (mapping_json).
  static func storedMapping(_ m: Mapping) -> String { JSText.stringify(m.stored) }

  static func iso(_ d: Date) -> String { StoreClock.iso(d) }

  // MARK: the dry run

  /// `validateImport(db, batchId, mapping)`: the dry run over every row → the projected ImportSummary (§5.2 step 3).
  /// Writes nothing to the atlas; every issue goes to `problemsURL` (rewritten by every dry run).
  public static func validate(_ c: Connection, batch id: Int64, mapping raw: JSValue?, originalsRoot: URL, problemsURL: URL?,
                              now: Date = Date(), checkStop: (() throws -> Void)? = nil,
                              onProgress: ((Double, Int?, RowTally) -> Void)? = nil) throws -> JSONValue {
    let t0 = ContinuousClock.now
    let startedAt = iso(Date())
    let b = try batch(id, on: c)
    let v = try checkMapping(b, raw)
    let m = v.mapping
    let opened = try openForRun(try originalURL(b, root: originalsRoot, on: c), m)
    let dec = opened.dec
    var csv = ImportSummaries.problemsHeader
    let projector = try Projector(c, collection: m.collectionSlug, dedupe: m.dedupe, detectLanguage: m.detectLanguage,
                                  textChars: opened.textChars, onIssue: { csv += ImportSummaries.problemLine($0) })
    defer {
      if let problemsURL {
        try? FileManager.default.createDirectory(at: problemsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(csv.utf8).write(to: problemsURL, options: .atomic)
      }
    }
    var rows = RowTally(), dateStats: [String: DateStat] = [:]
    var fatal: Issue?, aborted: Issue?
    let existing = try b.fileSha256.flatMap { try Dedupe.committedBatchForFile(c, collection: m.collectionSlug, sha256: $0, exceptBatch: b.id) }
    if let f = dec.fatal {
      fatal = f
    } else if let existing {
      fatal = Dedupe.dupFileIssue(existing, collection: m.collectionSlug)
    } else {
      for w in dec.issues + v.warnings { try projector.addIssue(w) }
      let records = try openRecords(opened.text, format: m.format, delimiter: m.delimiter, header: m.header, pointer: m.pointer,
                                    fileName: b.fileName ?? "upload", lineMode: m.lineMode)
      let run = ImportRun(records: records, text: opened.text, decoder: dec.decoder, bomBytes: dec.bomBytes, mapping: m,
                          fileName: b.fileName ?? "upload", sha256: b.fileSha256 ?? "", format: m.format, batchID: b.id, now: now)
      run.checkStop = checkStop
      run.onProgress = onProgress
      _ = try run.step(projector, on: c)
      try run.finishLinks(projector, on: c)
      rows = run.rows
      dateStats = run.dateStats
      fatal = run.fatal
      aborted = run.aborted
    }
    if let fatal { try projector.addIssue(fatal) }
    let counts = try projector.finish()
    let ms = ContinuousClock.now - t0
    var info = ImportSummaries.Info(batchID: b.id, collection: m.collectionSlug, file: try fileFacts(b, dec, m, on: c), rows: rows, mapping: m)
    info.dateStats = dateStats
    info.projected = true
    info.fatal = fatal.map { ImportPipeline.issueValue($0).json } ?? .null
    info.aborted = aborted.map { ImportPipeline.issueValue($0).json } ?? .null
    info.notes = projector.notes
    info.startedAt = startedAt
    info.finishedAt = iso(Date())
    info.durationMs = Int(ms.components.seconds * 1000 + ms.components.attoseconds / 1_000_000_000_000_000)
    info.status = "validated"
    return ImportSummaries.build(counts, info)
  }

  // MARK: collections

  /// `ensureUserCollection(db, c, {format, hasText, fileName})`: the user collection an import goes into, created on first
  /// use; 409 when the slug belongs to another corpus (Cipher, STEMM, the demo).
  public static func ensureUserCollection(_ tx: WriteTx, _ c: JSObject, format: String, hasText: Bool, fileName: String) throws -> CollectionRow {
    let slug = c["slug"].map(JSText.string) ?? ""
    if let corpus = try tx.connection.prepared(ImportSQL.collectionWithCorpus).bindingFirst([.text(slug)], { $0.text(1) }), corpus != "user" {
      throw ScrollsError(code: ErrorCode(rawValue: "E_COLLECTION_NOT_USER"),
                         message: "Collection '\(slug)' belongs to the \(corpus) corpus; imports go into your own collections.",
                         hint: "Choose another collection name.", detail: ["collection": .string(slug), "corpus": .string(corpus)], status: 409)
    }
    if let existing = try Collections.collection(slug: slug, on: tx.connection) { return existing }
    let name = c["name"].flatMap { MappingRules.isTruthy($0) ? JSText.string($0) : nil } ?? slug
    let unitGiven = c["unit"]?.stringValue
    let unit = unitGiven == "works" || unitGiven == "tokens" ? unitGiven! : hasText ? "tokens" : "works"
    return try Collections.ensureCollection(tx, CollectionSpec(
      slug: slug, name: name, corpus: "user", adapterID: "file.\(format)", domain: "imported", modality: hasText ? "text" : "titles", unit: unit,
      sampling: "user", license: c["license"]?.stringValue, selectionNote: "your import (\(fileName))", caveats: []), scope: .local)
  }

  /// `assertUserCollection(db, slug)` of routes/imports.mjs.
  public static func assertUserCollection(_ slug: String, on c: Connection) throws {
    if let corpus = try c.prepared(ImportSQL.collectionWithCorpus).bindingFirst([.text(slug)], { $0.text(1) }), corpus != "user" {
      throw ScrollsError(code: ErrorCode(rawValue: "E_COLLECTION_NOT_USER"),
                         message: "Collection '\(slug)' belongs to the \(corpus) corpus; imports go into your own collections.",
                         hint: "Choose another collection name.", detail: ["collection": .string(slug), "corpus": .string(corpus)], status: 409)
    }
  }

  // MARK: the commit

  /// A failed commit's error: the issue's code and words (`jobError(issue, code)`).
  static func jobError(_ i: Issue, code: String? = nil) -> ScrollsError {
    ScrollsError(code: ErrorCode(rawValue: code ?? i.code), message: i.message, hint: i.suggestion.isEmpty ? nil : i.suggestion)
  }

  /// `commitImport(ctx, {batchId, mapping})`: the 'import' job body. Returns the ImportSummary.
  public static func commit(_ ctx: JobContext, batch id: Int64, mapping raw: JSValue?, originalsRoot: URL, now nowGiven: Date? = nil) async throws
    -> JSONValue {
    let t0 = ContinuousClock.now
    let now = nowGiven ?? Date()
    let startedAt = iso(Date())
    let jobID = ctx.id.rawValue
    let lease = await ctx.lease()
    let b = try await lease.batch("import.batch \(id)") { tx in try batch(id, on: tx.connection) }
    if b.status == "committed" || b.status == "reverted" {
      throw ScrollsError(code: ErrorCode(rawValue: "E_IMPORT_STATE"),
                         message: "Batch \(b.id) was already committed\(b.jobID.map { " (job \($0))" } ?? "").", hint: "Open the import summary instead.")
    }
    let v = try checkMapping(b, raw)
    let m = v.mapping
    let fileName = b.fileName ?? "upload"
    ctx.progress(0, phase: "read", message: "reading \(fileName)")
    let url = try await lease.batch("import.original \(id)") { tx in try originalURL(b, root: originalsRoot, on: tx.connection) }
    let opened = try openForRun(url, m)
    let dec = opened.dec
    let collObject = m.collection ?? JSObject()
    let hasText = m.field("text") != nil
    let coll = try await lease.batch("import.committing \(id)") { tx -> CollectionRow in
      let c = try ensureUserCollection(tx, collObject, format: m.format, hasText: hasText, fileName: fileName)
      let up = try tx.connection.prepared(ImportSQL.batchCommitting)
      try up.bind(.int(c.id), .text(m.format), .text("file.\(m.format)"), .text(storedMapping(m)), .int(jobID), .int(b.id))
      try up.run()
      let del = try tx.connection.prepared(ImportSQL.deleteIssues)
      try del.bind(.int(b.id))
      try del.run()
      return c
    }
    let run = try await ctx.startRun(Stage(rawValue: "import"), params: ["batch": .number(Double(b.id)), "mapping": m.stored.json],
                                     scope: ["collections": [.string(coll.slug)]], upstream: [], representation: nil, seed: nil,
                                     pipelineVersion: version)
    let writer = try await DocumentWriter.make(
      lease: lease, target: DocumentWriterTarget(batch: ImportBatchID(rawValue: b.id), collection: coll.slug, corpus: "user", ids: .local),
      options: DocumentWriterOptions(dedupe: DocumentWriterOptions.Dedupe(rawValue: m.dedupe) ?? .flag, detectLanguage: m.detectLanguage,
                                     onBadRow: m.onBadRow == "abort" ? .abort : .skipAndReport),
      now: now)
    let bulk = opened.textChars > bulkFTSChars
    var finished = false
    var loop: ImportRun?
    var loopDone = false
    let facts = try await lease.batch("import.facts \(id)") { tx in try fileFacts(b, dec, m, on: tx.connection) }
    func fail(_ i: Issue, code: String? = nil) async throws -> ScrollsError {
      try await writer.addIssue(i)
      return jobError(i, code: code)
    }
    do {
      if bulk { try await lease.batch("import.fts-bulk") { tx in try FTSWriter.beginBulkLoad(tx.connection) } }
      if let f = dec.fatal { throw try await fail(f) }
      if let sha = b.fileSha256,
         let existing = try await lease.batch("import.dup-file", { tx in
           try Dedupe.committedBatchForFile(tx.connection, collection: coll.slug, sha256: sha, exceptBatch: b.id)
         }) {
        throw try await fail(Dedupe.dupFileIssue(existing, collection: coll.slug))
      }
      for w in dec.issues + v.warnings { try await writer.addIssue(w) }
      try await writer.flush()
      ctx.progress(0.01, phase: "write", message: "writing \(fileName)")
      let records = try openRecords(opened.text, format: m.format, delimiter: m.delimiter, header: m.header, pointer: m.pointer,
                                    fileName: fileName, lineMode: m.lineMode)
      let r = ImportRun(records: records, text: opened.text, decoder: dec.decoder, bomBytes: dec.bomBytes, mapping: m, fileName: fileName,
                        sha256: b.fileSha256 ?? "", format: m.format, batchID: b.id, now: now)
      r.checkStop = { try ctx.checkStop() }
      r.onProgress = { fraction, line, rows in
        ctx.progress(min(0.95, 0.01 + fraction * 0.94), phase: "write",
                     message: "line \(Format.int(line ?? 0)) · \(Format.int(rows.accepted)) accepted · \(Format.int(rows.rejected)) rejected",
                     counts: ["rows": rows.seen, "accepted": rows.accepted, "rejected": rows.rejected])
      }
      let session = WriterSession(writer)
      var done = false
      while !done {
        try await ctx.checkpoint()
        done = try await lease.batch("import.rows \(id)") { tx in
          try session.begin(tx)
          return try r.step(session, on: tx.connection) { session.isFull }
        }
        session.committed()
      }
      try await lease.batch("import.links \(id)") { tx in
        try session.begin(tx)
        try r.finishLinks(session, on: tx.connection)
      }
      session.committed()
      loop = r
      loopDone = true
      if let f = r.fatal { throw try await fail(f) }
      if let a = r.aborted {
        throw ScrollsError(code: ErrorCode(rawValue: "E_IMPORT_ABORTED"), message: "Import aborted at line \(a.line.map(String.init) ?? "?"): \(a.message)",
                           hint: "\(a.suggestion) (on_bad_row is 'abort': no rows were kept).")
      }
      try await ctx.checkpoint()
      ctx.progress(0.96, phase: "links", message: "resolving links and committing")
      let result = try await writer.finish { label, body in try await ctx.journaledCommit(label) { tx, _ in try body(tx) } }
      finished = true
      let ms = ContinuousClock.now - t0
      var info = ImportSummaries.Info(batchID: b.id, collection: coll.slug, file: facts, rows: r.rows, mapping: m)
      info.dateStats = r.dateStats
      info.dataVersion = result.dataVersion
      info.runID = run.id.rawValue
      info.startedAt = startedAt
      info.finishedAt = iso(Date())
      info.durationMs = Int(ms.components.seconds * 1000 + ms.components.attoseconds / 1_000_000_000_000_000)
      info.status = "committed"
      let summary = ImportSummaries.build(result.counts, info)
      try await lease.batch("import.summary \(id)") { tx in
        let up = try tx.connection.prepared(ImportSQL.batchSummary)
        try up.bind(.text(JSText.stringify(summary)), .int(b.id))
        try up.run()
      }
      let created = result.counts["documents"]?["created"]?.safeInteger ?? 0
      try await ctx.finishRun(run, .succeeded, metrics: ["rows": r.rows.json, "documents": .number(Double(created)),
                                                       "passages": result.counts["passages"] ?? .number(0), "tokens": result.counts["tokens"] ?? .number(0)])
      if bulk { try? await lease.batch("import.fts-merge") { tx in try FTSWriter.endBulkLoad(tx.connection) } }
      ctx.progress(1, phase: "done", message: "\(Format.int(created)) documents imported")
      await lease.end()
      return summary
    } catch {
      let cancelled = error is CancellationError || (error as? ScrollsError)?.code.rawValue == "E_CANCELLED"
      if !finished {
        // the cleanup must not inherit the job's cancellation (SQLite statements of a cancelled task are interrupted)
        let rows = loopDone ? loop!.rows : RowTally()
        let dateStats = loopDone ? loop!.dateStats : [:]
        var fatal: JSONValue = .null
        if loopDone, let f = loop?.fatal {
          fatal = ImportPipeline.issueValue(f).json
        } else if !cancelled {
          let e = error as? ScrollsError
          let w = error as? DocumentWriterError
          fatal = ["code": .string(e?.code.rawValue ?? w?.code ?? "E_IMPORT_FAILED"), "message": .string(e?.message ?? w?.message ?? "\(error)"),
                   "suggestion": e?.hint.map(JSONValue.string) ?? .null]
        }
        let status = cancelled ? "cancelled" : "failed"
        let ms = ContinuousClock.now - t0
        try? await Task {
          try await writer.rollback(status: status)
          var info = ImportSummaries.Info(batchID: b.id, collection: coll.slug, file: facts, rows: rows, mapping: m)
          info.dateStats = dateStats
          info.startedAt = startedAt
          info.finishedAt = StoreClock.isoNow()
          info.durationMs = Int(ms.components.seconds * 1000 + ms.components.attoseconds / 1_000_000_000_000_000)
          info.status = status
          info.fatal = fatal
          var summary = ImportSummaries.build(writer.counts, info)
          if case .object(var o) = summary, case .object(var d)? = o["documents"] {
            d["created"] = .number(0)
            o["documents"] = .object(d)
            summary = .object(o)
          }
          let text = JSText.stringify(summary)
          try await lease.batch("import.failed \(id)") { tx in
            let up = try tx.connection.prepared(ImportSQL.batchStatusSummary)
            try up.bind(.text(status), .text(text), .int(b.id))
            try up.run()
          }
          try await ctx.finishRun(run, cancelled ? .cancelled : .failed, metrics: nil)
          if bulk { try? await lease.batch("import.fts-merge") { tx in try FTSWriter.endBulkLoad(tx.connection) } }
        }.value
      }
      await lease.end()
      throw error
    }
  }

  // MARK: the revert

  /// `revertImport(ctx, {batchId})`: the 'revert' job body — soft-deletes the batch's documents (D17: saved views pinned to
  /// an earlier data version keep resolving) and bumps data_version.
  public static func revert(_ ctx: JobContext, batch id: Int64) async throws -> JSONValue {
    let b = try await ctx.read { c in try batch(id, on: c) }
    guard b.status == "committed" else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_IMPORT_STATE"), message: "Batch \(b.id) is \(b.status); only a committed import can be reverted.",
                         hint: "Nothing to revert.")
    }
    ctx.progress(0.1, phase: "revert", message: "reverting batch \(b.id)")
    let at = StoreClock.isoNow()
    let (n, version) = try await ctx.journaledCommit("revert \(b.id)") { tx, _ -> (Int, Int) in
      let c = tx.connection
      let up = try c.prepared(ImportSQL.revertDocuments)
      try up.bind(.text(at), .int(b.id))
      try up.run()
      let n = c.changes
      // live documents flagged as duplicates of a reverted one: the earliest live copy becomes the original
      let orphans = try c.prepared(ImportSQL.revertOrphans).bindingAll([.int(b.id)]) { ($0.int(0), $0.int(1)) }
      var head: [Int64: Int64] = [:]
      let set = try c.prepared(ImportSQL.setDupOf)
      for (doc, old) in orphans {
        if let h = head[old] {
          try set.bind(.int(h), .int(doc))
        } else {
          head[old] = doc
          try set.bind(.null, .int(doc))
        }
        try set.run()
      }
      let st = try c.prepared(ImportSQL.batchReverted)
      try st.bind(.int(b.id))
      try st.run()
      return (n, try tx.bumpDataVersion())
    }
    ctx.progress(1, phase: "done", message: "\(Format.int(n)) documents reverted")
    return ["import_batch_id": .number(Double(b.id)), "documents": .number(Double(n)), "data_version": .number(Double(version)),
            "reverted_at": .string(at)]
  }
}

// MARK: - the job tasks

/// Job 'import': commit an import batch through DocumentWriter (SPEC §5.2 step 4). Params: `batch_id`, `mapping`, and for
/// a journal replay or a test the import's clock `now` (ISO 8601) and `originals_root` (the folder holding `originals/`).
public struct ImportTask: JobTask {
  public static let type = JobType("import")
  public static let writes = WriteNeed.exclusive
  public static let resumable = false
  public static let budget = ResourceBudget(peakBytes: 512 << 20)
  let batch: Int64
  let mapping: JSValue?
  let now: Date?
  let root: URL

  public init(params: JSONValue) throws {
    guard let b = params["batch_id"]?.safeInteger, b > 0 else {
      throw ScrollsError(code: .validation, message: "import: batch_id must be a positive integer.", status: 400)
    }
    guard let root = params["originals_root"]?.stringValue else {
      throw ScrollsError(code: .validation, message: "import: originals_root is required.", status: 400)
    }
    batch = Int64(b)
    mapping = params["mapping"].map(JSValue.init)
    now = params["now"]?.stringValue.flatMap { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0) }
    self.root = URL(fileURLWithPath: root)
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    try await ImportPipeline.commit(ctx, batch: batch, mapping: mapping, originalsRoot: root, now: now)
  }
}

/// Job 'revert': soft-delete an import batch's documents and bump data_version (SPEC §5.2).
public struct RevertTask: JobTask {
  public static let type = JobType("revert")
  public static let writes = WriteNeed.commitsOnly
  public static let resumable = false
  public static let budget = ResourceBudget(peakBytes: 64 << 20)
  let batch: Int64

  public init(params: JSONValue) throws {
    guard let b = params["batch_id"]?.safeInteger, b > 0 else {
      throw ScrollsError(code: .validation, message: "revert: batch_id must be a positive integer.", status: 400)
    }
    batch = Int64(b)
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue { try await ImportPipeline.revert(ctx, batch: batch) }
}
