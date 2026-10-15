// OWNER: N1
// The writer's synchronous face for the import pipeline. The reference's runImport hands each record to the writer as it
// goes (addIssue, addDocument, …) and the writer keeps one transaction open across calls; here the pipeline runs its loop
// inside the writer's lease batches instead (one batch = one transaction of ≤ 5,000 documents, 50,000 rows or 2 s), and a
// session is the writer bound to the batch's transaction. Every call does exactly what the reference's call does, in the
// same order: only the transaction boundaries differ, and nothing a reader or the LogicalDump sees depends on them.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// DocumentWriter inside one write transaction (`ImportSink`).
public final class WriterSession: ImportSink, @unchecked Sendable {
  public let writer: DocumentWriter
  var tx: WriteTx?
  var started = ContinuousClock.now

  public init(_ writer: DocumentWriter) { self.writer = writer }

  /// Binds the session to a batch's transaction (the writer's per-transaction counters start again).
  public func begin(_ tx: WriteTx) throws {
    try writer.checkOpen()
    self.tx = tx
    started = ContinuousClock.now
    writer.docsInTx = 0
    writer.rowsInTx = 0
    writer.uncommittedIssues = []
    if writer.options.dedupe != .off && writer.dup == nil { try writer.openIndex(tx.connection) }
  }

  /// After the batch's transaction committed: its issues are durable.
  public func committed() {
    tx = nil
    writer.uncommittedIssues = []
  }

  /// Whether the transaction reached the writer's limits (5,000 documents, 50,000 rows or 2 s).
  public var isFull: Bool {
    writer.docsInTx >= DocumentWriter.flushDocuments || writer.rowsInTx >= DocumentWriter.flushRows
      || ContinuousClock.now - started >= DocumentWriter.maxTransaction
  }

  func current() throws -> WriteTx {
    guard let tx else { throw DocumentWriterError(code: "E_WRITER_CLOSED", message: "WriterSession: no open transaction") }
    return tx
  }

  public func addIssue(_ issue: Issue) throws {
    try writer.recordIssue(DocumentWriter.IssueSpec(code: issue.code, severity: issue.severity, line: issue.line, col: issue.col,
                                                field: issue.field, valueExcerpt: issue.valueExcerpt, message: issue.message,
                                                suggestion: issue.suggestion), try current())
  }

  /// `addDocument(doc, {line})`. With on_bad_row = abort a rejection throws (the batch is then rolled back).
  public func addDocument(_ doc: CanonicalDocument, line: Int?) throws -> DocumentWriteResult {
    do {
      return try writer.addOne(doc, line: line, try current())
    } catch let a as DocumentWriter.AbortSignal {
      throw a.error
    }
  }

  public func addRelationship(_ rel: CanonicalRelationship) throws { _ = writer.queueRelationship(rel) }
}
