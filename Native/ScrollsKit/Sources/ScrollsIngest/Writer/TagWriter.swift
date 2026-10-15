// OWNER: N1
// Port of store/document-writer.mjs (aliases, tags and labels part): document_alias and doc_tag rows (ON CONFLICT DO
// NOTHING, as the reference) with their scheme, provenance and method, and the label_tri typeahead rows of a document
// (title, a differing native title, the author as 'maker'; ref 'document:<id>').

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

extension DocumentWriter {
  /// Writes aliases, tags and labels; returns the rows the reference counts.
  func writeAliasesTagsLabels(document id: Int64, _ doc: CanonicalDocument, _ tx: WriteTx) throws -> Int {
    let c = tx.connection
    var rows = 0
    let insAlias = try c.prepared(IngestSQL.insertAlias)
    for a in doc.aliases ?? [] {
      try insAlias.bind(.int(id), .text(a.extId), .string(a.title), .string(a.note))
      try insAlias.run()
      rows += 1
    }
    let insTag = try c.prepared(IngestSQL.insertTag)
    for t in doc.tags ?? [] {
      try insTag.bind(.int(id), .text(t.scheme), .text(t.value), .real(t.weight), .text(t.provenance), .text(t.method))
      try insTag.run()
      rows += 1
    }
    let insLabel = try c.prepared(IngestSQL.insertLabel)
    let ref = "document:\(id)"
    func label(_ text: String, _ kind: String) throws {
      try insLabel.bind(.text(text), .text(kind), .text(ref))
      try insLabel.run()
      rows += 1
    }
    if let t = doc.title, !t.isEmpty { try label(t, "title") }
    if let n = doc.nativeTitle, !n.isEmpty, !JSString.equal(n, doc.title ?? "") || doc.title == nil { try label(n, "title") }
    if let a = doc.author, !a.isEmpty { try label(a, "maker") }
    return rows
  }
}
