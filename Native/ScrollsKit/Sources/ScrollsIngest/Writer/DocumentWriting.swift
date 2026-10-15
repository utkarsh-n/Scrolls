// OWNER: N1 — stub written by N0 (frozen at M0: IOS-SPEC §8.5 "DocumentWriting"; changes go through N0, additively)
// The one way canonical records reach the atlas (SPEC §12.3, `store/document-writer.mjs`). Adapters and the import
// pipeline never write SQL: they hand CanonicalDocument / Relationship / Annotation records to a writer, which writes
// every row of the reference's writer (document, document_text and its chunks, passages and FTS, fields, aliases, tags,
// date assertions and their R-tree, doc_bin, doc_tokens, minhash, the dup index, relationships with compact create
// revisions) and commits every 5,000 documents, 50,000 rows or 2 s, whichever comes first, yielding to interactive
// writes between batches. N2's pipelines develop against a fake conforming to this protocol until N1's DocumentWriter
// lands.
//
// For implementers (from the Store, N0b): ids come from `WriteTx.ids` (`RowIDAllocator`) in the target's `IDScope`;
// chunked text is written by inserting `document_text` first (original '' and `original_sha256 =
// TextDigest.sha256Hex(utf8:)`) and then `ChunkedTextStore.Writer.append`; create revisions go through
// `CompactRevisions.compacted(afterJSON:relationship:on:)`; segmentation reports `StoreVersions.segmenter`.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Where a writer writes.
public struct DocumentWriterTarget: Sendable, Equatable {
  /// The import batch the rows belong to; nil creates one for the collection (the reference's default).
  public var batch: ImportBatchID?
  /// The collection's slug (it must exist).
  public var collection: String
  /// The corpus's slug; nil is the collection's own corpus.
  public var corpus: String?
  /// The id range of the new entity rows: a source slot for pack loads, `.local` for his imports (§3.3).
  public var ids: IDScope

  public init(batch: ImportBatchID? = nil, collection: String, corpus: String? = nil, ids: IDScope) {
    self.batch = batch
    self.collection = collection
    self.corpus = corpus
    self.ids = ids
  }
}

/// The writer's options (`createDocumentWriter(…, {options})`).
public struct DocumentWriterOptions: Sendable, Equatable {
  /// Exact duplicates: flag them (`dup_of`), skip them, or do not look.
  public enum Dedupe: String, Sendable, Codable { case flag, skip, off }
  /// A record that fails validation: skip it and report it, or abort the whole batch.
  public enum OnBadRow: String, Sendable, Codable { case skipAndReport = "skip_and_report", abort }

  public var dedupe: Dedupe
  public var detectLanguage: Bool
  public var onBadRow: OnBadRow
  /// Options of the date grammar (`dates.mjs` parse options), verbatim.
  public var dateOptions: JSONValue

  public init(dedupe: Dedupe = .flag, detectLanguage: Bool = true, onBadRow: OnBadRow = .skipAndReport,
              dateOptions: JSONValue = .object([:])) {
    self.dedupe = dedupe
    self.detectLanguage = detectLanguage
    self.onBadRow = onBadRow
    self.dateOptions = dateOptions
  }
}

/// What writing one document did: its id when it was written (nil when the record was rejected) and its issues.
public struct DocumentWriteResult: Sendable, Equatable {
  public var document: DocumentID?
  public var issues: [Issue]

  public init(document: DocumentID?, issues: [Issue]) {
    self.document = document
    self.issues = issues
  }
}

/// What a finished writer reports (`finish()` of the reference: `{batch_id, collection, …counts, data_version}`).
public struct DocumentWriterSummary: Sendable, Equatable {
  public var batch: ImportBatchID
  public var collection: String
  /// The reference's counts object verbatim: documents, passages, tokens, dates, languages, relationships, annotations,
  /// issues.
  public var counts: JSONValue
  /// `meta.data_version` after the finishing transaction.
  public var dataVersion: Int

  public init(batch: ImportBatchID, collection: String, counts: JSONValue, dataVersion: Int) {
    self.batch = batch
    self.collection = collection
    self.counts = counts
    self.dataVersion = dataVersion
  }
}

/// Writes canonical records of one batch. Confined to the task that drains the adapter's `BoundedChannel` (not
/// Sendable); every call may commit a batch through the job's write lease.
public protocol DocumentWriting: AnyObject {
  /// Writes one document atomically. A rejected record returns `document == nil` with its issues; `line` is the
  /// source line issues refer to.
  func add(_ document: CanonicalDocument, line: Int?) async throws -> DocumentWriteResult
  /// Adds an alias to a document that already exists (a relation endpoint that is a known work); false when the
  /// target does not exist.
  func addAlias(to target: DocKey, _ alias: CanonicalAlias) async throws -> Bool
  /// Writes records in order, exactly as `add(_:line:)` and `addIssue` would one by one, with one result per document;
  /// a writer may commit them in fewer transactions (N0, additive: the default below makes the one-by-one calls).
  func add(_ records: [WriterRecord]) async throws -> [DocumentWriteResult]
  /// Adds aliases in order, exactly as `addAlias` would one by one; one result per alias (N0, additive).
  func addAliases(_ aliases: [(target: DocKey, alias: CanonicalAlias)]) async throws -> [Bool]
  /// Queues a relationship; its endpoints are resolved by ext_id at `finish()`. Returns the issues of a record
  /// rejected now (empty when it was queued).
  func add(_ relationship: CanonicalRelationship) async throws -> [Issue]
  /// Queues an annotation; its target and anchor are resolved at `finish()`. Returns the issues of a record rejected
  /// now (empty when it was queued).
  func add(_ annotation: CanonicalAnnotation) async throws -> [Issue]
  /// Records an issue the parser or adapter found.
  func addIssue(_ issue: Issue) async throws
  /// Commits what has been written so far.
  func flush() async throws
  /// The counts so far (the object `finish()` reports, without the data version).
  var counts: JSONValue { get }
  /// Resolves the queued relationships and annotations, marks the batch committed and bumps the data version, in one
  /// transaction.
  func finish() async throws -> DocumentWriterSummary
  /// Removes everything this batch wrote (its documents and their rows, and aliases added to other documents).
  func rollback() async throws
}

/// How a pipeline obtains a writer for a job's write lease: N1's `DocumentWriter.open`, or a fake in tests.
public typealias DocumentWriterFactory =
  @Sendable (WriteLease, DocumentWriterTarget, DocumentWriterOptions) async throws -> any DocumentWriting

extension DocumentWriting {
  /// One `add(_:line:)` or `addIssue` call per record.
  public func add(_ records: [WriterRecord]) async throws -> [DocumentWriteResult] {
    var out: [DocumentWriteResult] = []
    for r in records {
      switch r {
      case .document(let d, let line): out.append(try await add(d, line: line))
      case .issue(let i): try await addIssue(i)
      }
    }
    return out
  }

  /// One `addAlias` call per alias.
  public func addAliases(_ aliases: [(target: DocKey, alias: CanonicalAlias)]) async throws -> [Bool] {
    var out: [Bool] = []
    for a in aliases { out.append(try await addAlias(to: a.target, a.alias)) }
    return out
  }
}
