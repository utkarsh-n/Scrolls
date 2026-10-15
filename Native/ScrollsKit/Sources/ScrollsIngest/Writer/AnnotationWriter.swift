// OWNER: N1
// Port of store/document-writer.mjs (annotations part, run at finish()): the target resolved by ext_id or typed ref,
// the anchor checked against the text (the quote must equal the original between start and end, UTF-16 offsets),
// annotations on the synthetic demo from real data refused (§13 rule 1), the repeat-load check (same target, kind,
// author, layer and first text: written once), supersession by key, the rev-1 revision and its FTS row.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

extension DocumentWriter {
  enum AnnotationTarget {
    case resolved(targetRef: String, anchor: Anchored?)
    case anchorMismatch
  }

  /// `annotationTarget(t, anchorSpec)`: target_ref and anchor, `.anchorMismatch`, or nil when unresolved.
  func annotationTarget(_ t: CanonicalAnnotationTarget, _ spec: CanonicalAnchor?, _ c: Connection) throws -> AnnotationTarget? {
    var doc: Int64?, passage: Int64?
    if let ext = t.extId, !ext.isEmpty {
      doc = try extMap(collection.slug, c)[ext]
    } else if let ref = t.ref, !ref.isEmpty {
      guard let r = try resolveEndpoint(ref: ref, extID: nil, collection: nil, c) else {
        if ["passage", "occurrence", "document"].contains(t.type) { return nil }
        guard let parsed = try? IDs.parseRef(ref) else { return nil }
        return .resolved(targetRef: DocumentWriter.refString(parsed.id), anchor: nil)
      }
      doc = r.docID
      if r.type == "passage" { passage = Int64(r.ref) }
    }
    guard ["passage", "occurrence", "document"].contains(t.type), let doc else { return nil }
    var anchored: Anchored?
    if let spec {
      guard let a = try anchorFor(doc, field: spec.field, start: spec.start, end: spec.end, c), JSString.equal(a.quote, spec.quote) else {
        return .anchorMismatch
      }
      anchored = a
      passage = passage ?? a.passageID
    }
    switch t.type {
    case "document": return .resolved(targetRef: String(doc), anchor: anchored)
    case "occurrence":
      guard let ref = t.ref, let parsed = try? IDs.parseRef(ref) else { return nil }
      return .resolved(targetRef: DocumentWriter.refString(parsed.id), anchor: anchored)
    default:
      return passage.map { .resolved(targetRef: String($0), anchor: anchored) }
    }
  }

  static func refString(_ id: IDs.RefID) -> String {
    switch id {
    case .number(let n): String(n)
    case .string(let s): s
    }
  }

  /// `writeAnnotation(ann)`.
  func writeAnnotation(_ ann: CanonicalAnnotation, _ tx: WriteTx) throws {
    let c = tx.connection
    let t = ann.target
    let resolved = try annotationTarget(t, ann.anchor, c)
    guard case .resolved(let targetRef, let anchored)? = resolved else {
      tally.annotations["rejected", default: 0] += 1
      if case .anchorMismatch? = resolved, let a = ann.anchor {
        try recordIssue(IssueSpec(code: "E_FIELD_TYPE", severity: "rejected", field: "anchor", valueExcerpt: a.quote,
          message: "Annotation anchor \(a.start)–\(a.end) does not match the quoted text.",
          suggestion: "The quote must equal the original text between start and end (UTF-16 offsets)."), tx)
      } else {
        let shown = t.extId ?? t.ref
        try recordIssue(IssueSpec(code: "W_UNRESOLVED_TARGET", severity: "warning", field: "target", valueExcerpt: shown,
          message: "Annotation target '\(shown ?? t.type)' was not found; the annotation was not created."), tx)
      }
      return
    }
    var targetDoc: Int64?
    switch t.type {
    case "document": targetDoc = Int64(targetRef)
    case "passage": targetDoc = try Int64(targetRef).flatMap { try c.prepared(IngestSQL.passageDocument).bindingFirst([.int($0)]) { $0.int(0) } }
    case "occurrence": targetDoc = try Int64(targetRef).flatMap { try c.prepared(IngestSQL.occurrenceDocument).bindingFirst([.int($0)]) { $0.int(0) } }
    default: targetDoc = nil
    }
    if synthetic == 0, let d = targetDoc, try c.prepared(IngestSQL.docSynthetic).bindingFirst([.int(d)], { $0.int(0) }) == 1 {
      tally.annotations["rejected", default: 0] += 1
      let shown = t.extId ?? t.ref
      try recordIssue(IssueSpec(code: "W_SYNTHETIC_TARGET", severity: "warning", field: "target", valueExcerpt: shown,
        message: "Annotation target '\(shown ?? t.type)' is in the synthetic demo (invented material); the annotation was not created."), tx)
      return
    }
    // M5 gate: the same annotation loaded again (same target, kind, author, layer and first text) is written once
    if let existing = try c.prepared(IngestSQL.duplicateAnnotation).bindingFirst(
      [.text(t.type), .text(targetRef), .text(ann.kind), .text(ann.author), .text(ann.layer ?? ""), .text(ann.bodyMd)], { $0.int(0) }) {
      _ = existing
      tally.annotations["duplicates", default: 0] += 1
      return
    }
    let at = StoreClock.isoNow()
    do {
      try c.transaction {
        let supersedes = ann.supersedesKey.flatMap { annKeys[$0] }
        let annID = try tx.ids.next("annotation", scope)
        let ins = try c.prepared(IngestSQL.insertAnnotation)
        try ins.bind([
          .int(annID), .text(t.type), .text(targetRef), .string(anchored.map { JSText.stringify($0.anchor) }), .text(ann.kind),
          .text(ann.author), .int(ann.isMachine ? 1 : 0), .string(ann.method), .integer(ann.runId?.rawValue), .string(ann.layer),
          .integer(supersedes), .int(synthetic), .text(at),
        ])
        try ins.run()
        if let s = supersedes {
          let up = try c.prepared(IngestSQL.supersede)
          try up.bind(.int(s))
          try up.run()
        }
        let tags = ann.tags ?? []
        let revID = try tx.ids.nextLog("annotation_revision")
        let rev = try c.prepared(IngestSQL.insertAnnotationRevision)
        try rev.bind([
          .int(revID), .int(annID), .text(ann.bodyMd), .string(ann.stance), .text(JSText.stringify(ann.dimensions ?? .object([:]))),
          .text(JSText.stringify(.array(tags.map(JSONValue.string)))), .text(JSText.stringify(ann.evidenceRefs ?? .array([]))),
          .text(ann.author), .text(at),
        ])
        try rev.run()
        let fts = try c.prepared(IngestSQL.insertAnnotationFTS)
        try fts.bind(.int(revID), .text(Tokenizer.normString(ann.bodyMd)), .text(Tokenizer.normString(tags.joined(separator: " "))))
        try fts.run()
      }
      tally.annotations["created", default: 0] += 1
    } catch let e as StoreError where e.isConstraint {
      tally.annotations["rejected", default: 0] += 1
      try recordIssue(IssueSpec(code: "E_FIELD_TYPE", severity: "rejected", field: "annotation", valueExcerpt: ann.kind,
        message: "Annotation was refused: \(e.message)"), tx)
    }
  }
}
