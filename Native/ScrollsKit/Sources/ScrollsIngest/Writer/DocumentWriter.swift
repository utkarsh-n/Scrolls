// OWNER: N1
// The port of `store/document-writer.mjs` behind `DocumentWriting` (IOS-SPEC §1.3, §8.5 N1): the same rows, checks,
// issues and counts. Ids come from `RowIDAllocator` in the target's `IDScope` (slot range for source loads, local
// range for imports, max + 1 on a reference database), text goes inline on a reference database and through
// `ChunkedTextStore.Writer` on a device atlas, create revisions are compacted through `CompactRevisions`.
//
// Transactions. The reference keeps one BEGIN IMMEDIATE open across calls and commits every 5,000 documents / 50,000
// rows / 500 ms. The Swift writer only writes inside `WriteLease.batch` closures, so it keeps an ordered queue of
// operations (issues the caller recorded, documents, aliases) and executes it in batches: each batch is one
// transaction closed at 5,000 documents, 50,000 rows or 2 s (IOS-SPEC §1.3), and the writer yields to interactive
// writes between batches. Every operation runs exactly as the reference's would, in the same order, with each document
// in its own SAVEPOINT; only the transaction boundaries differ, and nothing a reader or the LogicalDump sees depends on
// them. `add(_:line:)` and `addAlias` execute the queue at once (one transaction) because their result says whether the
// record was written; `add(_ records:)` and `addAliases` execute a whole batch with one result each (the pipelines'
// path: a transaction per record made Cipher's phase A write 46 GB on the Mac, bootstrap-writes 2026-10-14).
//
// Invariants (the reference's, tested in ScrollsIngestTests and by G2):
//  · passage text == original[start_off, end_off) (body) or document_field.value[…] (fields);
//  · passage_fts row i holds exactly the tokens of that slice (FTS token i = tokenizer token i);
//  · is_synthetic is copied from the corpus onto every row this writer creates;
//  · doc_bin only for chrono_status = 'dated'; doc_tokens = quality 'ok' passages only;
//  · rollback() leaves zero rows of the batch (its issues stay, as in the reference).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Errors the writer raises as the reference does (`err.code`).
public struct DocumentWriterError: Error, Sendable, Equatable, CustomStringConvertible {
  /// 'E_IMPORT_ABORTED' (on_bad_row = abort), 'E_WRITER_CLOSED', 'E_UNKNOWN_COLLECTION', …
  public let code: String
  public let message: String
  /// The issues of the record that aborted the batch.
  public let issues: [Issue]
  public init(code: String, message: String, issues: [Issue] = []) {
    self.code = code
    self.message = message
    self.issues = issues
  }
  public var description: String { "\(code): \(message)" }
}

/// One record of a batch handed to `DocumentWriter.add(_ records:)`.
public enum WriterRecord: Sendable {
  case document(CanonicalDocument, line: Int?)
  /// An issue the parser found before this point (kept in order with the documents).
  case issue(Issue)
}

/// The atlas's document writer. Not thread-safe: it belongs to the task that drains its records; its state is only
/// touched by that task, or inside a lease batch the task awaits (hence `@unchecked Sendable`).
public final class DocumentWriter: DocumentWriting, @unchecked Sendable {
  // ── limits (document-writer.mjs) ──
  public static let flushDocuments = 5_000
  public static let flushRows = 50_000
  /// IOS-SPEC §1.3: 2 s on the phone (the reference's 500 ms is a web-server latency budget).
  public static let maxTransaction: Duration = .seconds(2)
  public static let maxTextChars = 20 * 1024 * 1024
  public static let maxMetaJSON = 64 * 1024
  static let nearDupJaccard = 0.9
  static let anchorContext = 32
  static let chronoRoles = ["publication", "original_publication", "creation", "publication_unspecified", "release",
                            "recording", "performance"]
  static let scanLangClasses: Set<String> = ["text", "title", "abstract"]
  static let issuesKept = 20

  /// Default suggestion per issue code (every stored issue carries a non-empty suggestion).
  static let suggestions: [String: String] = [
    "E_DATE_UNPARSEABLE": "Write the date as YYYY, YYYY-MM-DD, \"c. YYYY\" or a range; the record was kept as undated.",
    "E_DATE_AMBIGUOUS": "Write the full year, or set \"two-digit years → 19xx\" in the date options; the record was kept as undated.",
    "E_DATE_INVALID": "Check the day and month; the record was kept as undated.",
    "W_DATE_FUTURE": "If this is a plan or an announcement, nothing to do (Scheduled shelf); otherwise correct the date.",
    "W_AMBIGUOUS_HUNDREDS": "Write e.g. 1800–1809 if the decade was meant.",
    "W_DATE_SEASON": "Give the month if it is known.",
    "W_LANG_MISMATCH": "Nothing to do if this is a translation (excluded from text-language chronology by default); otherwise correct the declared language.",
    "W_MIXED_LANGUAGE": "Nothing to do: lanes split by passage language.",
    "W_DUP_CONTENT": "Keep it flagged (excluded from counts by default), or revert one of the two imports.",
    "W_NEAR_DUP": "Choose \"keep both\" or \"mark as duplicate\" in the import summary.",
    "W_DUP_METADATA": "Check whether the two records describe the same work.",
    "E_DUP_ID": "Give every record a unique id, or revert the earlier import first.",
    "E_FIELD_TYPE": "Fix the field in the source file; the message names the expected shape.",
    "E_MISSING_TEXT": "Map a text column or a title, or allow metadata-only rows.",
    "E_ROW_TOO_LARGE": "Split the file, or import the text as TXT.",
    "W_UNRESOLVED_TARGET": "Check the target id: it must be an ext_id (or alias) in this collection, or name its collection.",
    "W_SYNTHETIC_TARGET": "Link real records to real records only: the demo is invented material and never part of your data.",
  ]

  // ── configuration ──
  let lease: WriteLease
  public let options: DocumentWriterOptions
  public let batch: ImportBatchID
  public let collection: CollectionRow
  public let corpus: CorpusRow
  let scope: IDScope
  let synthetic: Int64
  let assertedIngestion: String
  let now: Date
  let nowISO: String
  let today: Int
  let todayYear: Int
  let dateContext: DateContext
  /// Called before every batch the writer runs (a job's checkpoint); throwing stops the writer.
  public var checkpoint: (@Sendable () async throws -> Void)?

  // ── state ──
  var closed = false
  var queue: [Op] = []
  var uncommittedIssues: [Issue] = []
  var pendingRels: [CanonicalRelationship] = []
  var pendingAnns: [CanonicalAnnotation] = []
  var extLines: [String: Int?] = [:]
  var addedAliases: [(Int64, String)] = []
  var dup: DupIndex?
  public private(set) var dupSource: String?
  var maxDocID: Int64 = 0
  var tally = Tally()
  var extMaps: [String: [String: Int64]] = [:]
  var groups: [String: Int64] = [:]
  var newGroupKey: String?
  var annKeys: [String: Int64] = [:]
  let interner = TokenInterner()
  var tokenHashes: [UInt32] = []
  /// Statement-level state of the batch being executed.
  var docsInTx = 0
  var rowsInTx = 0

  enum Op {
    case issue(Issue)
    case document(CanonicalDocument, line: Int?, slot: Int)
    case alias(DocKey, CanonicalAlias, slot: Int)
  }

  /// The result of one queued operation.
  enum Outcome {
    case document(DocumentWriteResult)
    case alias(Bool)
  }

  struct AbortSignal: Error {
    let error: DocumentWriterError
  }

  init(lease: WriteLease, options: DocumentWriterOptions, batch: ImportBatchID, collection: CollectionRow, corpus: CorpusRow,
       scope: IDScope, now: Date) {
    self.lease = lease
    self.options = options
    self.batch = batch
    self.collection = collection
    self.corpus = corpus
    self.scope = scope
    self.synthetic = corpus.isSynthetic ? 1 : 0
    self.assertedIngestion = "import:\(batch.rawValue)"
    self.now = now
    self.nowISO = StoreClock.iso(now)
    self.today = DayMath.day(of: now)
    self.todayYear = DayMath.ymdFromDay(DayMath.day(of: now)).y
    self.dateContext = DocumentWriter.dateContext(options.dateOptions, now: now)
  }

  // MARK: opening

  /// Opens a writer on a job's write lease (`JobContext.lease()`); matches `DocumentWriterFactory`.
  public static func open(lease: WriteLease, target: DocumentWriterTarget,
                          options: DocumentWriterOptions) async throws -> any DocumentWriting {
    try await make(lease: lease, target: target, options: options)
  }

  /// `createDocumentWriter(db, {batchId, collection, corpus, options})` with the concrete type.
  public static func make(lease: WriteLease, target: DocumentWriterTarget, options: DocumentWriterOptions,
                          now: Date? = nil) async throws -> DocumentWriter {
    let clock = now ?? DocumentWriter.now(from: options.dateOptions) ?? Date()
    let opened = try await lease.batch("writer.open \(target.collection)") { tx -> (CollectionRow, CorpusRow, Int64) in
      let c = tx.connection
      guard let coll = try Collections.collection(slug: target.collection, on: c) else {
        throw DocumentWriterError(code: "E_UNKNOWN_COLLECTION", message: "DocumentWriter: unknown collection '\(target.collection)'")
      }
      let corp: CorpusRow?
      if let slug = target.corpus { corp = try Collections.corpus(slug: slug, on: c) } else { corp = try Collections.corpus(id: coll.corpusID, on: c) }
      guard let corp else {
        throw DocumentWriterError(code: "E_UNKNOWN_CORPUS", message: "DocumentWriter: unknown corpus '\(target.corpus ?? "")'")
      }
      guard corp.id == coll.corpusID else {
        throw DocumentWriterError(code: "E_CORPUS_MISMATCH",
                                  message: "DocumentWriter: collection '\(coll.slug)' does not belong to corpus '\(corp.slug)'")
      }
      let batch: Int64
      if let b = target.batch {
        guard try Collections.batch(b.rawValue, on: c) != nil else {
          throw DocumentWriterError(code: "E_UNKNOWN_BATCH", message: "DocumentWriter: unknown import batch \(b.rawValue)")
        }
        batch = b.rawValue
      } else {
        batch = try Collections.createBatch(tx, BatchSpec(collectionID: coll.id), now: clock)
      }
      return (coll, corp, batch)
    }
    return DocumentWriter(lease: lease, options: options, batch: ImportBatchID(rawValue: opened.2), collection: opened.0,
                          corpus: opened.1, scope: target.ids, now: clock)
  }

  /// The writer's clock from the date options (`now`: an ISO date or epoch milliseconds), as the reference passes
  /// `options.now` to both the ingestion assertion and the date grammar.
  static func now(from dateOptions: JSONValue) -> Date? {
    guard let v = dateOptions["now"] else { return nil }
    if let ms = v.numberValue { return Date(timeIntervalSince1970: ms / 1000) }
    if let s = v.stringValue {
      let f = Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .gmt)
      return (try? f.parse(s)) ?? (try? Date.ISO8601FormatStyle(timeZone: .gmt).parse(s))
    }
    return nil
  }

  /// The date grammar's options from the writer's `dateOptions` (the reference's parseDate option names).
  static func dateContext(_ o: JSONValue, now: Date) -> DateContext {
    var c = DateContext(now: DayMath.day(of: now))
    if let v = o["circaRadius"]?.safeInteger { c.circaRadius = v }
    if let v = o["openRangeYears"]?.safeInteger { c.openRangeYears = v }
    if let v = o["twoDigitCentury"]?.safeInteger { c.twoDigitCentury = v }
    if let v = o["zeroIsUnknown"]?.boolValue { c.zeroIsUnknown = v }
    if let v = o["negativeYearConvention"]?.stringValue, let n = NegativeYearConvention(rawValue: v) { c.negativeYearConvention = n }
    return c
  }

  // MARK: DocumentWriting

  public var counts: JSONValue { tally.json }

  /// Writes one document (one transaction; the pipelines use `add(_ records:)`).
  public func add(_ document: CanonicalDocument, line: Int?) async throws -> DocumentWriteResult {
    try await add([.document(document, line: line)])[0]
  }

  /// Writes a batch of records in order, as many `addDocument` / `addIssue` calls would; one result per document.
  /// Records are executed in transactions of ≤ 5,000 documents / 50,000 rows / 2 s.
  public func add(_ records: [WriterRecord]) async throws -> [DocumentWriteResult] {
    try checkOpen()
    var slots = 0
    for r in records {
      switch r {
      case .issue(let i): enqueueIssue(i)
      case .document(let d, let line):
        queue.append(.document(d, line: line, slot: slots))
        slots += 1
      }
    }
    let outcomes = try await drain(slots: slots)
    return outcomes.map { if case .document(let r) = $0 { r } else { DocumentWriteResult(document: nil, issues: []) } }
  }

  public func addAlias(to target: DocKey, _ alias: CanonicalAlias) async throws -> Bool {
    try checkOpen()
    queue.append(.alias(target, alias, slot: 0))
    let out = try await drain(slots: 1)
    if case .alias(let ok) = out[0] { return ok }
    return false
  }

  /// Adds aliases in order, in transactions of ≤ 50,000 rows / 2 s (as `add(_ records:)`); one result per alias.
  public func addAliases(_ aliases: [(target: DocKey, alias: CanonicalAlias)]) async throws -> [Bool] {
    try checkOpen()
    for (slot, a) in aliases.enumerated() { queue.append(.alias(a.target, a.alias, slot: slot)) }
    return try await drain(slots: aliases.count).map { if case .alias(let ok) = $0 { ok } else { false } }
  }

  public func add(_ relationship: CanonicalRelationship) async throws -> [Issue] {
    try checkOpen()
    return queueRelationship(relationship)
  }

  /// `addRelationship(rel)`: checked against the contract now, written at `finish()`.
  func queueRelationship(_ relationship: CanonicalRelationship) -> [Issue] {
    let errs = CanonicalCheck.relationship(relationship)
    if !errs.isEmpty {
      tally.relationships["rejected", default: 0] += 1
      let issue = recordIssueQueued(IssueSpec(code: "E_FIELD_TYPE", severity: "rejected", field: "relationship",
        valueExcerpt: relationship.relType,
        message: "Relationship does not match the contract: \(errs.prefix(3).joined(separator: "; "))"))
      return [issue]
    }
    pendingRels.append(relationship)
    return []
  }

  public func add(_ annotation: CanonicalAnnotation) async throws -> [Issue] {
    try checkOpen()
    let errs = CanonicalCheck.annotation(annotation)
    if !errs.isEmpty {
      tally.annotations["rejected", default: 0] += 1
      let issue = recordIssueQueued(IssueSpec(code: "E_FIELD_TYPE", severity: "rejected", field: "annotation",
        valueExcerpt: annotation.kind,
        message: "Annotation does not match the contract: \(errs.prefix(3).joined(separator: "; "))"))
      return [issue]
    }
    pendingAnns.append(annotation)
    return []
  }

  public func addIssue(_ issue: Issue) async throws {
    try checkOpen()
    enqueueIssue(issue)
    if queue.count >= DocumentWriter.flushRows { _ = try await drain(slots: 0) }
  }

  public func flush() async throws {
    try checkOpen()
    _ = try await drain(slots: 0)
  }

  /// Resolves the queued relationships and annotations, marks the batch committed and bumps the data version, in one
  /// transaction; then keeps the duplicate index for the next writer of the collection.
  public func finish() async throws -> DocumentWriterSummary {
    try await finish { [lease] label, body in try await lease.batch(label, body) }
  }

  /// `finish()` whose final transaction runs through `commit` (a job's journaled commit: the journal entry is appended
  /// before the transaction and recorded inside it, §6.2).
  public func finish(committing commit: (String, @escaping @Sendable (WriteTx) throws -> Int) async throws -> Int) async throws
    -> DocumentWriterSummary {
    try checkOpen()
    _ = try await drain(slots: 0)
    try await checkpoint?()
    let version = try await commit("writer.finish \(batch.rawValue)") { [self] tx in try finishBody(tx) }
    closed = true
    if let d = dup {
      dup = nil
      let maxDoc = maxDocID, b = batch.rawValue
      _ = try? await lease.batch("writer.dup-index") { tx in try d.save(tx.connection, batch: b, maxDocumentID: maxDoc) }
    }
    return DocumentWriterSummary(batch: batch, collection: collection.slug, counts: tally.json, dataVersion: version)
  }

  /// The body of `finish()`'s transaction: queued relationships and annotations, the batch committed, the data
  /// version bumped.
  func finishBody(_ tx: WriteTx) throws -> Int {
    let c = tx.connection
    for rel in pendingRels { try writeRelationship(rel, tx) }
    for ann in pendingAnns { try writeAnnotation(ann, tx) }
    let up = try c.prepared(IngestSQL.batchCommitted)
    try up.bind(.text(StoreClock.isoNow()), .int(batch.rawValue))
    try up.run()
    uncommittedIssues = []
    return try tx.bumpDataVersion()
  }

  /// Removes everything this batch wrote (documents and their rows; aliases added to other documents). The batch's
  /// issues are kept (those of an unfinished transaction are written again), and the batch is marked failed.
  public func rollback() async throws {
    try await rollback(status: "failed")
  }

  /// `rollback()` with the status the batch is left in ('failed' or 'cancelled').
  public func rollback(status: String) async throws {
    let keep = uncommittedIssues + queue.compactMap { if case .issue(let i) = $0 { i } else { nil } }
    queue = []
    uncommittedIssues = []
    closed = true
    dup = nil  // it holds this batch's documents: never handed on
    let b = batch.rawValue, aliases = addedAliases, scope = self.scope
    try await lease.batch("writer.rollback \(b)") { tx in
      _ = try Collections.rollbackBatch(tx, batch: b, status: status)
      let del = try tx.connection.prepared(IngestSQL.deleteAlias)
      for (id, ext) in aliases {
        try del.bind(.int(id), .text(ext))
        try del.run()
      }
      for i in keep { try DocumentWriter.insertIssue(tx, batch: b, scope: scope, i) }
    }
  }

  // MARK: the queue

  func checkOpen() throws {
    if closed { throw DocumentWriterError(code: "E_WRITER_CLOSED", message: "DocumentWriter: already finished or rolled back") }
  }

  /// Executes the queue in batches; returns the outcomes of the queued documents and aliases by slot.
  func drain(slots: Int) async throws -> [Outcome] {
    var outcomes = [Outcome?](repeating: nil, count: slots)
    while !queue.isEmpty {
      try await checkpoint?()
      let ops = queue
      do {
        let (done, results) = try await lease.batch("writer.batch \(batch.rawValue)") { [self] tx -> (Int, [(Int, Outcome)]) in
          try execute(ops, tx)
        }
        for (slot, o) in results where slot < outcomes.count { outcomes[slot] = o }
        queue.removeFirst(done)
        uncommittedIssues = []
      } catch let a as AbortSignal {
        // on_bad_row = abort: the transaction rolled back; the reference then rolls the whole batch back
        queue = []
        try await rollback(status: "failed")
        throw a.error
      }
    }
    return outcomes.map { $0 ?? .document(DocumentWriteResult(document: nil, issues: [])) }
  }

  /// Runs queued operations in one transaction until a limit is reached; returns how many ran and their outcomes.
  func execute(_ ops: [Op], _ tx: WriteTx) throws -> (Int, [(Int, Outcome)]) {
    let started = ContinuousClock.now
    docsInTx = 0
    rowsInTx = 0
    uncommittedIssues = []
    if options.dedupe != .off && dup == nil { try openIndex(tx.connection) }
    var results: [(Int, Outcome)] = []
    var n = 0
    for op in ops {
      switch op {
      case .issue(let i):
        try DocumentWriter.insertIssue(tx, batch: batch.rawValue, scope: scope, i)
        uncommittedIssues.append(i)
        rowsInTx += 1
      case .document(let d, let line, let slot):
        results.append((slot, .document(try addOne(d, line: line, tx))))
      case .alias(let target, let alias, let slot):
        results.append((slot, .alias(try addAliasNow(target, alias, tx))))
      }
      n += 1
      if docsInTx >= DocumentWriter.flushDocuments || rowsInTx >= DocumentWriter.flushRows
        || ContinuousClock.now - started >= DocumentWriter.maxTransaction {
        break
      }
    }
    return (n, results)
  }

  func addAliasNow(_ target: DocKey, _ alias: CanonicalAlias, _ tx: WriteTx) throws -> Bool {
    let c = tx.connection
    guard let id = try Collections.resolveExt(collection: target.collection, extID: target.extId, on: c) else { return false }
    let before = try c.prepared(IngestSQL.totalChanges).first { $0.int(0) } ?? 0
    let ins = try c.prepared(IngestSQL.insertAlias)
    try ins.bind(.int(id), .text(alias.extId), .string(alias.title), .string(alias.note))
    try ins.run()
    let after = try c.prepared(IngestSQL.totalChanges).first { $0.int(0) } ?? 0
    if after > before { addedAliases.append((id, alias.extId)) }
    extMaps[target.collection]?[alias.extId] = id
    rowsInTx += 1
    return true
  }

  // MARK: issues

  /// An issue as the caller describes it; `recordIssue` fills the reference's defaults.
  struct IssueSpec {
    var code: String
    var severity: String?
    var line: Int?
    var col: Int?
    var field: String?
    var valueExcerpt: String?
    var message: String?
    var suggestion: String?
    var vars: JSONObject = [:]
  }

  /// `excerpt(v)`: the first 200 UTF-16 units.
  static func excerpt(_ v: String?) -> String? { v.map { JSString.slice($0, 0, 200) } }

  /// The full issue (severity, message and suggestion defaults of `recordIssue`).
  func full(_ s: IssueSpec) -> Issue {
    let def = Vocab.issueCodes[s.code]
    let message = (s.message?.isEmpty == false) ? s.message! : def.map { Vocab.fillTemplate($0.template, s.vars) } ?? s.code
    let suggestion = (s.suggestion?.isEmpty == false) ? s.suggestion! : DocumentWriter.suggestions[s.code] ?? "See the message for what to change."
    return Issue(code: s.code, severity: s.severity ?? def?.severity ?? "warning", line: s.line, col: s.col, field: s.field,
                 valueExcerpt: DocumentWriter.excerpt(s.valueExcerpt), message: message, suggestion: suggestion)
  }

  /// The counts of an issue (`counts.issues`).
  func count(_ i: Issue) {
    tally.issuesTotal += 1
    tally.issuesByCode.add(i.code)
    if tally.issuesFirst.count < DocumentWriter.issuesKept { tally.issuesFirst.append(i) }
  }

  /// `recordIssue` inside a transaction: counted and written now.
  @discardableResult
  func recordIssue(_ s: IssueSpec, _ tx: WriteTx) throws -> Issue {
    let i = full(s)
    try DocumentWriter.insertIssue(tx, batch: batch.rawValue, scope: scope, i)
    rowsInTx += 1
    uncommittedIssues.append(i)
    count(i)
    return i
  }

  /// `recordIssue` outside a transaction: counted now, written with the next batch (in order).
  @discardableResult
  func recordIssueQueued(_ s: IssueSpec) -> Issue {
    let i = full(s)
    count(i)
    queue.append(.issue(i))
    return i
  }

  /// An issue from the caller (`addIssue`): the reference fills an empty message or suggestion the same way.
  func enqueueIssue(_ issue: Issue) {
    recordIssueQueued(IssueSpec(code: issue.code, severity: issue.severity, line: issue.line, col: issue.col, field: issue.field,
                                valueExcerpt: issue.valueExcerpt, message: issue.message, suggestion: issue.suggestion))
  }

  static func insertIssue(_ tx: WriteTx, batch: Int64, scope: IDScope, _ i: Issue) throws {
    let id = try tx.ids.next("import_issue", scope)
    let s = try tx.connection.prepared(IngestSQL.insertIssue)
    try s.bind(.int(id), .int(batch), .text(i.severity), .text(i.code), .integer(i.line), .integer(i.col), .string(i.field),
               .string(i.valueExcerpt), .text(i.message), .text(i.suggestion))
    try s.run()
  }

  /// `reject(issues, issue)`: records a rejection; with on_bad_row = abort the whole batch is rolled back.
  func reject(_ issues: inout [Issue], _ s: IssueSpec, _ tx: WriteTx) throws -> DocumentWriteResult {
    var spec = s
    spec.severity = "rejected"
    issues.append(try recordIssue(spec, tx))
    tally.documents["rejected", default: 0] += 1
    if options.onBadRow == .abort {
      throw AbortSignal(error: DocumentWriterError(code: "E_IMPORT_ABORTED",
                                                   message: "Import aborted: \(spec.message ?? spec.code)", issues: issues))
    }
    return DocumentWriteResult(document: nil, issues: issues)
  }

  // MARK: one document

  /// Validates and writes one document (`addOne`).
  func addOne(_ doc: CanonicalDocument, line: Int?, _ tx: WriteTx) throws -> DocumentWriteResult {
    var issues: [Issue] = []
    let errs = CanonicalCheck.document(doc)
    if !errs.isEmpty {
      return try reject(&issues, IssueSpec(code: "E_FIELD_TYPE", line: line, valueExcerpt: doc.extId,
        message: "Record \(doc.extId) does not match the document contract: \(errs.prefix(3).joined(separator: "; "))"), tx)
    }
    if let t = doc.text, t.original.utf16.count > DocumentWriter.maxTextChars {
      let size = JSNumber.toFixed(Double(t.original.utf16.count) / 1_048_576, 1) + " M characters"
      return try reject(&issues, IssueSpec(code: "E_ROW_TOO_LARGE", line: line, field: "text", valueExcerpt: doc.extId,
        vars: ["line": line.map { .number(Double($0)) } ?? .string(doc.extId), "field": "text", "size": .string(size)]), tx)
    }
    let hasText = doc.text != nil || fieldValues(doc).contains { !$0.1.isEmpty } || (doc.title.map { !$0.isEmpty } ?? false)
    if !hasText {
      return try reject(&issues, IssueSpec(code: "E_MISSING_TEXT", line: line, valueExcerpt: doc.extId,
        vars: ["line": line.map { .number(Double($0)) } ?? .string(doc.extId)]), tx)
    }
    if let first = extLines[doc.extId] {
      return try reject(&issues, IssueSpec(code: "E_DUP_ID", line: line, field: "ext_id", valueExcerpt: doc.extId,
        vars: ["line": line.map { .number(Double($0)) } ?? "?", "value": .string(doc.extId),
               "first_line": first.map { .number(Double($0)) } ?? "?"]), tx)
    }
    let c = tx.connection
    if try c.prepared(IngestSQL.docInCollection).bindingFirst([.int(collection.id), .text(doc.extId)], { _ in true }) ?? false {
      return try reject(&issues, IssueSpec(code: "E_DUP_ID", line: line, field: "ext_id", valueExcerpt: doc.extId,
        message: "\(doc.extId) already exists in collection '\(collection.slug)' (an earlier import)."), tx)
    }
    extLines[doc.extId] = .some(line)

    let rowsBefore = rowsInTx, docsBefore = docsInTx
    let issueMark = uncommittedIssues.count
    do {
      return try c.transaction { try insertDocument(doc, line: line, &issues, tx) }
    } catch let e as StoreError where e.isConstraint {
      // the savepoint rolled the document back; its issues stay counted, as in the reference
      rowsInTx = rowsBefore
      docsInTx = docsBefore
      uncommittedIssues.removeSubrange(issueMark...)
      return try reject(&issues, IssueSpec(code: "E_FIELD_TYPE", line: line, valueExcerpt: doc.extId,
        message: "\(doc.extId) was refused by the database: \(e.message)"), tx)
    }
  }

  /// The metadata fields of a document in `DOC_FIELDS` order (non-nil values).
  func fieldValues(_ doc: CanonicalDocument) -> [(String, String)] {
    guard let f = doc.fields else { return [] }
    return [("title", f.title), ("native_title", f.nativeTitle), ("summary", f.summary), ("abstract", f.abstract),
            ("gloss", f.gloss), ("entry", f.entry)].compactMap { k, v in v.map { (k, $0) } }
  }

  /// `insertDocument(doc, line, issues)`: every row of one document, inside the caller's savepoint.
  func insertDocument(_ doc: CanonicalDocument, line: Int?, _ issues: inout [Issue], _ tx: WriteTx) throws -> DocumentWriteResult {
    let c = tx.connection
    var assertions = try parseAssertions(doc, line: line, &issues, tx)
    let chronoIndex = chronologyIndex(&assertions)
    let cp: DateParse? = chronoIndex.flatMap { assertions[$0].parsed }.flatMap { $0.loDay != nil ? $0 : nil }
    let chronoStatus = cp == nil ? "undated" : cp!.basis == "announced" ? "scheduled" : "dated"

    var fields = fieldValues(doc)
    if doc.text == nil && !fields.contains(where: { !$0.1.isEmpty }), let t = doc.title, !t.isEmpty {
      if let k = fields.firstIndex(where: { $0.0 == "title" }) { fields[k].1 = t } else { fields.insert(("title", t), at: 0) }
    }
    let body = doc.text.map { bodyPassages(doc, $0) } ?? Body(passages: [], bodyTokens: [], units: [])
    let passages = body.passages + fieldPassages(doc, fields)

    let langPassages = passages.filter { DocumentWriter.scanLangClasses.contains($0.fieldClass) && $0.quality == "ok" }
      .map { (lang: $0.lang, tokens: $0.tokenCount, confidence: Optional($0.confidence)) }
    let dl = options.detectLanguage
      ? LangID.documentLang(langPassages, declared: doc.langDeclared)
      : DocumentLanguage(langText: doc.langDeclared ?? "und", confidence: doc.langDeclared != nil ? 1 : 0, isTranslation: false,
                         share: 0, byLang: [])
    if dl.isTranslation {
      issues.append(try recordIssue(IssueSpec(code: "W_LANG_MISMATCH", line: line, field: "lang_declared", valueExcerpt: doc.langDeclared,
        vars: ["declared": .string(doc.langDeclared ?? ""), "detected": .string(dl.langText),
               "scores": .string(dl.byLang.map { "\($0.lang) \(JSNumber.toFixed($0.share, 2))" }.joined(separator: " / "))]), tx))
      if let k = chronoIndex, assertions[k].role == "publication" {
        assertions[k].role = "original_publication"
        assertions[k].note = [assertions[k].note, "role set to original_publication: the text reads as \(dl.langText), not the declared \(doc.langDeclared ?? "")"]
          .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "; ")
      }
    }
    // An adapter can know what language identification cannot (a credited translator): CanonicalDocument has no
    // `translation` member yet (contract request in status/N1.md), so no credited translation is recorded here.
    let isTranslation = dl.isTranslation
    let detected = dl.byLang.filter { !$0.lang.hasPrefix("und") }
    if detected.count > 1 && detected[1].share >= 0.15 {
      issues.append(try recordIssue(IssueSpec(code: "W_MIXED_LANGUAGE", line: line,
        vars: ["title": .string(doc.title ?? doc.extId),
               "mix": .string(detected.map { "\($0.lang) (\(JSNumber.format(JSNumber.round($0.share * 100)))%)" }.joined(separator: " and "))]), tx))
    }

    // exact and near duplicates of the normalized body
    let textSha: String? = body.bodyTokens.isEmpty ? nil : TextDigest.sha256Hex(utf8: body.bodyTokens.joined(separator: " "))
    var dupOf: Int64?
    if let textSha, options.dedupe != .off {
      if let d = try c.prepared(IngestSQL.textShaDup).bindingFirst([.text(textSha)], { $0.int(0) }) {
        if options.dedupe == .skip {
          return try reject(&issues, IssueSpec(code: "W_DUP_CONTENT", line: line, valueExcerpt: doc.extId,
            message: "\(doc.extId): same text as document \(d); skipped (dedupe = skip).", vars: ["other": .number(Double(d))]), tx)
        }
        dupOf = d
        issues.append(try recordIssue(IssueSpec(code: "W_DUP_CONTENT", line: line, valueExcerpt: doc.extId,
                                                vars: ["other": .number(Double(d))]), tx))
        tally.documents["duplicates_flagged", default: 0] += 1
      }
    }
    let sig: [UInt32]? = doc.text != nil && dupOf == nil ? minhash(body.bodyTokens) : nil
    if let sig, options.dedupe != .off {
      if let near = try nearDuplicate(sig, c) {
        issues.append(try recordIssue(IssueSpec(code: "W_NEAR_DUP", line: line, valueExcerpt: doc.extId,
          vars: ["other": .number(Double(near.id)), "jaccard": .string(JSNumber.toFixed(near.j, 2))]), tx))
        tally.documents["near_duplicates", default: 0] += 1
      }
    }
    let metaKey = DupIndex.metaKey(title: doc.title, author: doc.author, yLo: cp?.yLo.map(Int.init))
    if doc.text == nil && options.dedupe != .off, let t = doc.title, !t.isEmpty {
      if let other = try metadataDuplicate(metaKey, c) {
        issues.append(try recordIssue(IssueSpec(code: "W_DUP_METADATA", line: line, valueExcerpt: doc.title,
                                                vars: ["other": .number(Double(other))]), tx))
      }
    }

    var sourceSha: String?
    if let sf = doc.sourceFile {
      if try c.prepared(IngestSQL.originalFile).bindingFirst([.text(sf.sha256)], { _ in true }) == nil {
        return try reject(&issues, IssueSpec(code: "E_FIELD_TYPE", line: line, field: "source_file",
          message: "\(doc.extId): source_file.sha256 is not a stored original.",
          suggestion: "Store the source file with storeOriginal() before writing its documents."), tx)
      }
      sourceSha = sf.sha256
    }
    var metaJSON = JSText.stringify(doc.originalMeta)
    if metaJSON.utf16.count > DocumentWriter.maxMetaJSON, let sf = doc.sourceFile {
      metaJSON = JSText.stringify(.object([
        "$source": .object(["sha256": .string(sf.sha256), "byte_start": .number(Double(sf.byteStart)), "byte_end": .number(Double(sf.byteEnd))]),
        "note": "record larger than 64 KB: read it from the original bytes",
      ]))
    }

    let tokenTotal = passages.reduce(0) { $0 + $1.tokenCount }
    let id = try tx.ids.next("document", scope)
    let chrono = chronoIndex.map { assertions[$0] }
    let ins = try c.prepared(IngestSQL.insertDocument)
    try ins.bind([
      .int(id), .int(collection.id), .int(batch.rawValue), .text(doc.extId), .text(doc.kind), .string(doc.title),
      .string(doc.nativeTitle), .string(doc.author), .string(doc.genre), .string(doc.community), .string(doc.culture),
      .string(doc.field), .string(doc.langDeclared), .text(dl.langText), .double(dl.confidence), .int(isTranslation ? 1 : 0),
      .string(dl.isTranslation ? doc.langDeclared : nil), .int(doc.text != nil ? 1 : 0),
      .integer(cp?.loDay.map(Int.init)), .integer(cp?.hiDay.map(Int.init)), .integer(cp?.yLo.map(Int.init)),
      .integer(cp?.yHi.map(Int.init)), .text(cp?.precision ?? "unknown"), .text(cp?.basis ?? "unknown"), .string(chrono?.role),
      .text(chronoStatus), .text(cp?.label ?? "undated"), .string(doc.sourceUrl), .string(doc.license), .string(sourceSha),
      .integer(doc.sourceFile?.byteStart), .integer(doc.sourceFile?.byteEnd), .text(metaJSON), .string(textSha),
      .integer(dupOf), .int(Int64(tokenTotal)), .int(Int64(passages.count)), .real(doc.prominence), .int(synthetic),
      .text(StoreClock.isoNow()),
    ])
    try ins.run()
    var rows = 1

    if let t = doc.text {
      try writeText(document: id, t, body: body, tx)
      rows += 1
    }
    let insField = try c.prepared(IngestSQL.insertField)
    for (field, value) in fields where !value.isEmpty {
      try insField.bind(.int(id), .text(field), .text(value))
      try insField.run()
      rows += 1
    }
    rows += try writePassages(document: id, passages, yLo: cp?.yLo.map(Int.init), yHi: cp?.yHi.map(Int.init), tx)
    rows += try writeAssertions(document: id, assertions, chronoIndex: chronoIndex, tx)
    if chronoStatus == "dated" { _ = try DocBins.write(c, document: id, cp!.yLo.map(Int.init), cp!.yHi.map(Int.init)) }
    rows += try writeAliasesTagsLabels(document: id, doc, tx)

    if let sig {
      let s = try c.prepared(IngestSQL.insertMinhash)
      try s.bind(.int(id), .blob(MinHash.bytes(sig)))
      try s.run()
      dup?.add(id, sig)
      rows += 1
    }
    if let d = dup, doc.text == nil, let t = doc.title, !t.isEmpty { d.metaKeys[metaKey] = id }
    if id > maxDocID { maxDocID = id }

    // counts
    tally.documents["created", default: 0] += 1
    if doc.text == nil { tally.documents["metadata_only", default: 0] += 1 }
    if isTranslation { tally.documents["translations", default: 0] += 1 }
    tally.passages += passages.count
    tally.tokens += tokenTotal
    tally.languages.add(dl.langText)
    let dk = chronoStatus == "undated" ? "unknown" : chronoStatus == "scheduled" ? "scheduled" : cp!.approx ? "circa" : cp!.precision
    tally.dates.add(dk)
    if chronoStatus == "dated", let cp, let lo = cp.loDay, let hi = cp.hiDay {
      if tally.spanLo == nil || Int(lo) < tally.spanLo!.day { tally.spanLo = (Int(lo), cp.label) }
      if tally.spanHi == nil || Int(hi) > tally.spanHi!.day { tally.spanHi = (Int(hi), cp.label) }
    }
    docsInTx += 1
    rowsInTx += rows
    return DocumentWriteResult(document: DocumentID(rawValue: id), issues: issues)
  }

  // MARK: duplicates

  func openIndex(_ c: Connection) throws {
    let r = try DupIndex.open(c, collection: collection.id)
    dup = r.index
    dupSource = r.source
  }

  /// A candidate from the index, confirmed against the live row (an index entry is never trusted alone).
  func liveSignature(_ id: Int64, _ c: Connection) throws -> [UInt32]? {
    try c.prepared(IngestSQL.liveSignature).bindingFirst([.int(id), .int(collection.id)]) { MinHash.signature(bytes: $0.blob(0)) }
  }

  func nearDuplicate(_ sig: [UInt32], _ c: Connection) throws -> (id: Int64, j: Double)? {
    if dup == nil { try openIndex(c) }
    var best: (id: Int64, j: Double)?
    for (id, indexed) in dup!.candidates(sig) {
      let j = indexed.map { MinHash.jaccard(sig, $0) } ?? 0
      if j < DocumentWriter.nearDupJaccard || (best != nil && j <= best!.j) { continue }
      let jl = try liveSignature(id, c).map { MinHash.jaccard(sig, $0) } ?? 0
      if jl >= DocumentWriter.nearDupJaccard && (best == nil || jl > best!.j) { best = (id, jl) }
    }
    return best
  }

  func metadataDuplicate(_ key: String, _ c: Connection) throws -> Int64? {
    if dup == nil { try openIndex(c) }
    guard let id = dup!.metaKeys[key] else { return nil }
    let row = try c.prepared(IngestSQL.metaDupRow).bindingFirst([.int(id), .int(collection.id)]) {
      (title: $0.textOrNil(0), author: $0.textOrNil(1), yLo: $0.intOrNil(2).map(Int.init))
    }
    if let r = row, DupIndex.metaKey(title: r.title, author: r.author, yLo: r.yLo) == key { return id }
    dup!.metaKeys[key] = nil
    return nil
  }

  /// MinHash of folded body tokens (each distinct token hashed once per writer).
  func minhash(_ tokens: [String]) -> [UInt32]? { MinHash.signature(tokens) }
}

// MARK: - counts

/// The reference's counts object, with its key order.
struct Tally {
  var documents = OrderedCounts(["created", "rejected", "duplicates_flagged", "near_duplicates", "metadata_only", "translations"])
  var passages = 0
  var tokens = 0
  var dates = OrderedCounts(["day", "month", "year", "decade", "century", "millennium", "range", "period", "circa", "unknown", "scheduled"])
  var spanLo: (day: Int, label: String)?
  var spanHi: (day: Int, label: String)?
  var languages = OrderedCounts([])
  var relationships = OrderedCounts(["documented", "computed", "proposed", "unresolved_targets", "rejected"])
  var annotations = OrderedCounts(["created", "rejected"])
  var issuesTotal = 0
  var issuesByCode = OrderedCounts([])
  var issuesFirst: [Issue] = []

  var json: JSONValue {
    var dateObj = dates.object
    dateObj["span"] = .object(["from": spanLo.map { .string($0.label) } ?? .null, "to": spanHi.map { .string($0.label) } ?? .null])
    return .object([
      "documents": .object(documents.object), "passages": .number(Double(passages)), "tokens": .number(Double(tokens)),
      "dates": .object(dateObj), "languages": .object(languages.object), "relationships": .object(relationships.object),
      "annotations": .object(annotations.object),
      "issues": .object(["total": .number(Double(issuesTotal)), "by_code": .object(issuesByCode.object),
                         "first": .array(issuesFirst.map(Tally.issueJSON))]),
    ])
  }

  static func issueJSON(_ i: Issue) -> JSONValue {
    .object(["code": .string(i.code), "severity": .string(i.severity), "line": i.line.map { .number(Double($0)) } ?? .null,
             "col": i.col.map { .number(Double($0)) } ?? .null, "field": i.field.map(JSONValue.string) ?? .null,
             "value_excerpt": i.valueExcerpt.map(JSONValue.string) ?? .null, "message": .string(i.message),
             "suggestion": .string(i.suggestion)])
  }
}

/// Counters keyed by name, keeping the reference object's key order (fixed keys first, then first-seen order).
struct OrderedCounts {
  private(set) var keys: [String]
  private var values: [String: Int]

  init(_ fixed: [String]) {
    keys = fixed
    values = Dictionary(uniqueKeysWithValues: fixed.map { ($0, 0) })
  }

  subscript(key: String, default d: Int) -> Int {
    get { values[key] ?? d }
    set {
      if values[key] == nil { keys.append(key) }
      values[key] = newValue
    }
  }

  subscript(key: String) -> Int? { values[key] }

  mutating func add(_ key: String) { self[key, default: 0] += 1 }

  var object: JSONObject { JSONObject(keys.map { ($0, JSONValue.number(Double(values[$0]!))) }) }
  var pairs: [(String, Int)] { keys.map { ($0, values[$0]!) } }
}
