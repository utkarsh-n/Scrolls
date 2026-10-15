// OWNER: N1
// Port of store/document-writer.mjs (relationships part, run at finish()): endpoints resolved by ext_id (aliases
// included) or typed ref; links into the synthetic demo from real data refused (§13 rule 1); the repeat-load check
// (M5 gate); the date conflict ("later item certainly earlier"); hypothesis groups; evidence spans anchored to the text
// (D18); and the rev-1 create revision — compacted to `{"$row":1}` on a device atlas for adapter and algorithm links
// (IOS-SPEC §3.2 DP-6, through `CompactRevisions`, which keeps the full JSON unless the expansion reproduces it).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A resolved relationship end.
struct Endpoint {
  var type: String
  var ref: String
  var docID: Int64?
}

/// An anchored span: the passage that holds it and the D18 anchor object.
struct Anchored {
  var passageID: Int64?
  /// `{doc_id, sha256, field, start, end, quote, prefix, suffix}` in the reference's key order (annotation keys hold its
  /// text verbatim).
  var anchor: JSValue
  var quote: String
  var start: Int
  var end: Int
}

extension DocumentWriter {
  /// `extMap(slug)`: ext_id → document id of a collection, aliases included (documents win over aliases).
  func extMap(_ slug: String, _ c: Connection) throws -> [String: Int64] {
    if let m = extMaps[slug] { return m }
    var m: [String: Int64] = [:]
    if let coll = try Collections.collection(slug: slug, on: c) {
      let a = try c.prepared(IngestSQL.extMapAliases)
      try a.bind(.int(coll.id))
      while let r = try a.step() {
        let ext = r.text(0)
        if m[ext] == nil { m[ext] = r.int(1) }
      }
      let d = try c.prepared(IngestSQL.extMapDocuments)
      try d.bind(.int(coll.id))
      while let r = try d.step() { m[r.text(0)] = r.int(1) }
    }
    extMaps[slug] = m
    return m
  }

  func docYears(_ id: Int64, _ c: Connection) throws -> (yLo: Int64?, yHi: Int64?)? {
    try c.prepared(IngestSQL.docYears).bindingFirst([.int(id)]) { ($0.intOrNil(0), $0.intOrNil(1)) }
  }

  /// `resolveEndpoint(e)`.
  func resolveEndpoint(ref: String?, extID: String?, collection: String?, _ c: Connection) throws -> Endpoint? {
    if let ref, !ref.isEmpty {
      guard let r = try? IDs.parseRef(ref) else { return nil }
      guard Vocab.relEndpointTypes.contains(r.type) else { return nil }
      let idString: String
      var number: Int64?
      switch r.id {
      case .number(let n): idString = String(n); number = n
      case .string(let s): idString = s
      }
      if r.type == "document" {
        guard let n = number, try docYears(n, c) != nil else { return nil }
        return Endpoint(type: "document", ref: idString, docID: n)
      }
      if r.type == "passage" {
        guard let n = number, let doc = try c.prepared(IngestSQL.passageDocument).bindingFirst([.int(n)], { $0.int(0) }) else { return nil }
        return Endpoint(type: "passage", ref: idString, docID: doc)
      }
      return Endpoint(type: r.type, ref: idString, docID: nil)
    }
    guard let extID, !extID.isEmpty else { return nil }
    guard let id = try extMap(collection ?? self.collection.slug, c)[extID] else { return nil }
    return Endpoint(type: "document", ref: String(id), docID: id)
  }

  /// `anchorFor(docId, field, start, end)`: the D18 anchor of a span, or nil when the span is outside the text.
  func anchorFor(_ doc: Int64, field: String, start: Int, end: Int, _ c: Connection) throws -> Anchored? {
    var text: [UInt16]?, sha: String?
    if field == "body" {
      if let s = try c.prepared(IngestSQL.originalSHA).bindingFirst([.int(doc)], { $0.text(0) }) {
        sha = s
        text = Array(try ChunkedTextStore().fullText(DocumentID(rawValue: doc), on: c).utf16)
      }
    } else if let v = try c.prepared(IngestSQL.fieldValue).bindingFirst([.int(doc), .text(field)], { $0.text(0) }) {
      text = Array(v.utf16)
      sha = TextDigest.sha256Hex(utf8: v)
    }
    guard let t = text, start >= 0, start <= end, end <= t.count else { return nil }
    let passage = try c.prepared(IngestSQL.passageForSpan).bindingFirst(
      [.int(doc), .text(field), .int(Int64(start)), .int(Int64(end))]) { $0.int(0) }
    func s(_ a: Int, _ b: Int) -> String { String(decoding: t[max(0, a)..<min(t.count, max(a, b))], as: UTF16.self) }
    let quote = s(start, end)
    let anchor: JSValue = .object(JSObject([
      ("doc_id", .number(Double(doc))), ("sha256", .string(sha ?? "")), ("field", .string(field)), ("start", .number(Double(start))),
      ("end", .number(Double(end))), ("quote", .string(quote)),
      ("prefix", .string(s(max(0, start - DocumentWriter.anchorContext), start))),
      ("suffix", .string(s(end, end + DocumentWriter.anchorContext))),
    ]))
    return Anchored(passageID: passage, anchor: anchor, quote: quote, start: start, end: end)
  }

  /// `hypothesisGroup(spec, target, createdBy)`: a group's target is the item whose source is asked about (the src).
  func hypothesisGroup(_ spec: CanonicalHypothesisGroup?, target: Endpoint, createdBy: String, _ tx: WriteTx) throws -> Int64? {
    guard let spec else { return nil }
    if let id = groups[spec.key] { return id }
    newGroupKey = spec.key
    let c = tx.connection
    let id: Int64
    if let existing = try c.prepared(IngestSQL.hypothesisGroup).bindingFirst([.text(target.type), .text(target.ref), .text(spec.question)], { $0.int(0) }) {
      id = existing
    } else {
      id = try tx.ids.next("hypothesis_group", scope)
      let ins = try c.prepared(IngestSQL.insertHypothesisGroup)
      try ins.bind(.int(id), .text(target.type), .text(target.ref), .text(spec.question), .text(createdBy), .int(synthetic),
                   .text(StoreClock.isoNow()))
      try ins.run()
    }
    groups[spec.key] = id
    return id
  }

  /// Whether a resolved endpoint lies in a synthetic document (the demo).
  func syntheticEnd(_ e: Endpoint, _ c: Connection) throws -> Bool {
    var doc = e.docID
    if doc == nil && e.type == "occurrence", let n = Int64(e.ref) {
      doc = try c.prepared(IngestSQL.occurrenceDocument).bindingFirst([.int(n)]) { $0.int(0) }
    }
    guard let doc else { return false }
    return try c.prepared(IngestSQL.docSynthetic).bindingFirst([.int(doc)]) { $0.int(0) } == 1
  }

  /// `writeRelationship(rel)`.
  func writeRelationship(_ rel: CanonicalRelationship, _ tx: WriteTx) throws {
    let c = tx.connection
    let src = try resolveEndpoint(ref: rel.src.ref, extID: rel.src.extId, collection: rel.src.collection, c)
    let dst = try resolveEndpoint(ref: rel.dst.ref, extID: rel.dst.extId, collection: rel.dst.collection, c)
    guard let src, let dst else {
      tally.relationships["unresolved_targets", default: 0] += 1
      let which = src == nil ? rel.src : rel.dst
      let shown = which.extId ?? which.ref
      try recordIssue(IssueSpec(code: "W_UNRESOLVED_TARGET", severity: "warning", field: src == nil ? "src" : "dst", valueExcerpt: shown,
        message: "Relationship \(rel.relType): \(src == nil ? "source" : "target") '\(shown ?? "?")' was not found; the link was not created."), tx)
      return
    }
    // §13 rule 1: invented material exists only in the demo; a link from real data into it is refused and reported
    if synthetic == 0 {
      let srcSynthetic = try syntheticEnd(src, c)
      if try srcSynthetic || syntheticEnd(dst, c) {
        tally.relationships["unresolved_targets", default: 0] += 1
        let end = srcSynthetic ? "source" : "target"
        let which = srcSynthetic ? rel.src : rel.dst
        let shown = which.extId ?? which.ref
        try recordIssue(IssueSpec(code: "W_SYNTHETIC_TARGET", severity: "warning", field: srcSynthetic ? "src" : "dst", valueExcerpt: shown,
          message: "Relationship \(rel.relType): \(end) '\(shown ?? "?")' is in the synthetic demo (invented material); the link was not created."), tx)
        return
      }
    }
    // M5 gate: the same relationship — type, ends, status, origin, author, dataset, locator and run — is written once
    let duplicate = try c.prepared(IngestSQL.duplicateRelationship).bindingFirst([
      .text(src.type), .text(src.ref), .text(dst.type), .text(dst.ref), .text(rel.relType), .text(rel.evidenceStatus),
      .text(rel.origin), .text(rel.createdBy), .text(rel.sourceDataset ?? ""), .text(rel.sourceLocator ?? ""),
      .int(rel.runId?.rawValue ?? -1),
    ]) { _ in true } ?? false
    if duplicate {
      tally.relationships["duplicates", default: 0] += 1
      return
    }
    let type = Vocab.relTypeByCode[rel.relType]
    let sy = try src.docID.flatMap { try docYears($0, c) }, dy = try dst.docID.flatMap { try docYears($0, c) }
    var conflict: Int64 = 0
    if (type?.requiresPrecedence ?? 0) != 0, let hi = sy?.yHi, let lo = dy?.yLo, hi < lo { conflict = 1 }
    let createdAt = StoreClock.isoNow()
    newGroupKey = nil
    do {
      try c.transaction {
        let groupID = try hypothesisGroup(rel.hypothesisGroup, target: src, createdBy: rel.createdBy, tx)
        let relID = try tx.ids.next("relationship", scope)
        let ins = try c.prepared(IngestSQL.insertRelationship)
        try ins.bind([
          .int(relID), .text(rel.relType), .text(src.type), .text(src.ref), .text(dst.type), .text(dst.ref),
          .int(Int64(type?.directed ?? 1)), .text(rel.evidenceStatus), .text(rel.origin), .string(rel.sourceDataset),
          .string(rel.sourceLocator), .text(rel.provenanceQuality ?? "complete"), .string(rel.method), .integer(rel.runId?.rawValue),
          .text(rel.createdBy), .real(rel.score?.value), .string(rel.score?.kind), .int(conflict), .integer(sy?.yLo ?? nil),
          .integer(dy?.yLo ?? nil), .integer(groupID), .string(rel.license), .string(rel.attribution), .string(rel.provenanceNote),
          .int(synthetic), .text(createdAt),
        ])
        try ins.run()
        let insEv = try c.prepared(IngestSQL.insertEvidence)
        for ev in rel.evidence ?? [] {
          var doc: Int64?, passage: Int64?
          if let p = ev.passage, case .number(let n) = p, n == n.rounded(.towardZero), abs(n) < 9.0e15 {
            if let row = try c.prepared(IngestSQL.passageRow).bindingFirst([.int(Int64(n))], { ($0.int(0), $0.int(1)) }) {
              passage = row.0
              doc = row.1
            }
          } else if let ext = ev.extId {
            doc = try extMap(collection.slug, c)[ext]
          }
          var anchored: Anchored?
          if let doc, let start = ev.start, let end = ev.end {
            let a = try anchorFor(doc, field: "body", start: start, end: end, c)
            if a == nil || (ev.quote.map { !$0.isEmpty } ?? false && !JSString.equal(a!.quote, ev.quote!)) {
              try recordIssue(IssueSpec(code: "E_FIELD_TYPE", severity: "warning", field: "evidence", valueExcerpt: ev.quote,
                message: "Relationship \(rel.relType): evidence span \(start)–\(end) does not match the text; the span was not attached."), tx)
              continue
            }
            anchored = a
            passage = passage ?? a!.passageID
          }
          let eid = try tx.ids.next("relationship_evidence", scope)
          try insEv.bind([.int(eid), .int(relID), .integer(passage), .text(ev.role), .integer(anchored?.start), .integer(anchored?.end),
                          .string(anchored.map { JSText.stringify($0.anchor) }), .null, .text(rel.createdBy), .text(createdAt)])
          try insEv.run()
        }
        let score: JSONValue = rel.score.map { .object(["value": .number($0.value), "kind": .string($0.kind)]) } ?? .null
        let after = CanonicalJSON.string(.object([
          "rel_type": .string(rel.relType), "src": .string("\(src.type):\(src.ref)"), "dst": .string("\(dst.type):\(dst.ref)"),
          "evidence_status": .string(rel.evidenceStatus), "origin": .string(rel.origin),
          "source_dataset": rel.sourceDataset.map(JSONValue.string) ?? .null, "source_locator": rel.sourceLocator.map(JSONValue.string) ?? .null,
          "method": rel.method.map(JSONValue.string) ?? .null, "run_id": rel.runId.map { .number(Double($0.rawValue)) } ?? .null,
          "score": score,
        ]))
        let stored = c.profile == .device && (rel.origin == "source_dataset" || rel.origin == "algorithm")
          ? try CompactRevisions.compacted(afterJSON: after, relationship: relID, on: c) : after
        let revID = try tx.ids.nextLog("relationship_revision")
        let rev = try c.prepared(IngestSQL.insertRevision)
        try rev.bind(.int(revID), .int(relID), .text(rel.createdBy), .text(createdAt), .text(stored))
        try rev.run()
      }
    } catch let e as StoreError where e.isConstraint {
      if let k = newGroupKey { groups[k] = nil }
      tally.relationships["rejected", default: 0] += 1
      try recordIssue(IssueSpec(code: "E_FIELD_TYPE", severity: "rejected", field: "relationship", valueExcerpt: rel.relType,
        message: "Relationship \(rel.relType) \(src.type):\(src.ref) → \(dst.type):\(dst.ref) was refused: \(e.message)",
        suggestion: "Documented links need a source dataset and a locator (or source_unrecorded); computed links need a run and a method."), tx)
      return
    } catch {
      if let k = newGroupKey { groups[k] = nil }
      throw error
    }
    tally.relationships[rel.evidenceStatus, default: 0] += 1
  }
}
