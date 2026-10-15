// OWNER: N6
// Annotations in process (server/routes/annotations.mjs): annotations and their append-only revisions (D18 anchors);
// every write is journaled (`annotationCreate`, `annotationRevise`, `annotationReinterpret`, `annotationWithdraw`).
// The reference's logic is ScrollsProvenance's port (`Annotations`); its JSON bodies are decoded into the contract types
// here. Fields the reference returns that contract 1.3.0's Swift types do not hold yet (AnnotationRev.anchor/relocated,
// AnnotationReinterpreted.rev) are requested from N0 (status/N6.md) and pass through once added.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsProvenance
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func annotations(_ r: AnnotationsRequest) async throws -> AnnotationsResponse {
    let json = try await read { c in try Annotations.list(c, r) }
    return try ScrollsJSON.decode(AnnotationsResponse.self, from: json)
  }

  @concurrent
  public func createAnnotation(_ r: AnnotationCreateRequest) async throws -> AnnotationRevResponse {
    let body = try ScrollsJSON.value(r)
    let journal = r.target.type == "hypothesis_group" ? try await journalEntries() : []
    let op = try await dryRun("annotation") { w in
      let result = try Annotations.create(w, body)
      return JournalOp.annotationCreate(try ProvenanceJournal.annotationCreateOp(w, body: body, result: result, journal: journal))
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]), journal: journal)
    return try ScrollsJSON.decode(AnnotationRevResponse.self, from: out)
  }

  @concurrent
  public func reviseAnnotation(_ id: AnnotationID, _ r: AnnotationPatchRequest) async throws -> AnnotationRevResponse {
    let body = try ScrollsJSON.value(r)
    let (op, actor) = try await dryRun("annotation revision") { w -> (JournalOp, String) in
      _ = try Annotations.revise(w, id: String(id.rawValue), body)
      let actor = try annotationActor(w.c, id, body)
      return (.annotationRevise(try StableKeys.annotationKey(w.c, id.rawValue), r), actor)
    }
    return try ScrollsJSON.decode(AnnotationRevResponse.self, from: try await journaledAct(op, actor: actor))
  }

  @concurrent
  public func reinterpret(_ id: AnnotationID, _ r: AnnotationCreateRequest) async throws -> AnnotationReinterpretedResponse {
    let body = try ScrollsJSON.value(r)
    let journal = r.target.type == "hypothesis_group" ? try await journalEntries() : []
    let (op, actor) = try await dryRun("reinterpretation") { w -> (JournalOp, String) in
      let result = try Annotations.reinterpret(w, id: String(id.rawValue), body)
      let created = Int64(result["id"]?.numberValue ?? 0)
      let anchorJSON = try w.c.prepared(N6ServiceSQL.annotationAnchor).bindingFirst([.int(created)]) { $0.textOrNil(0) } ?? nil
      let anchor: JSONValue = anchorJSON.flatMap { try? JSONValue.parse($0) } ?? .null
      let createOp = try ProvenanceJournal.annotationCreateOp(w, body: body, result: ["anchor": anchor], journal: journal)
      let actor = Refs.humanActor(try Refs.authorName(body["author"].flatMap { $0.isNull ? nil : $0 }
        ?? (try w.c.prepared(N6ServiceSQL.annotationAuthor).bindingFirst([.int(id.rawValue)]) { JSONValue.string($0.text(0)) })))
      return (.annotationReinterpret(try StableKeys.annotationKey(w.c, id.rawValue), createOp), actor)
    }
    let out = try await journaledAct(op, actor: actor, journal: journal)
    return try ScrollsJSON.decode(AnnotationReinterpretedResponse.self, from: out)
  }

  @concurrent
  public func withdraw(_ id: AnnotationID, _ r: WithdrawRequest) async throws -> AnnotationRevResponse {
    let body = try ScrollsJSON.value(r)
    let (op, actor) = try await dryRun("withdrawal") { w -> (JournalOp, String) in
      _ = try Annotations.withdraw(w, id: String(id.rawValue), body)
      let actor = try annotationActor(w.c, id, body)
      return (.annotationWithdraw(try StableKeys.annotationKey(w.c, id.rawValue), reason: r.reason ?? ""), actor)
    }
    return try ScrollsJSON.decode(AnnotationRevResponse.self, from: try await journaledAct(op, actor: actor))
  }

  @concurrent
  public func annotationRevisions(_ id: AnnotationID) async throws -> AnnotationRevisionsResponse {
    let json = try await read { c in try Annotations.revisionsJSON(c, id: String(id.rawValue)) }
    return try ScrollsJSON.decode(AnnotationRevisionsResponse.self, from: json)
  }
}

extension LiveAtlas {
  /// Targets the device self-tests annotate (N6Steps): the first body passage with at least 40 UTF-16 units of
  /// text, and the first documented relationship, if the atlas has them. Self-tests run in an isolated root only.
  @concurrent
  public func notebookSelfTestTargets() async throws -> (passage: PassageID?, relationship: RelationshipID?) {
    try await read { c in
      (try c.prepared(N6ServiceSQL.samplePassage).first { PassageID(rawValue: $0.int(0)) },
       try c.prepared(N6ServiceSQL.sampleRelationship).first { RelationshipID(rawValue: $0.int(0)) })
    }
  }
}

/// `human:<author>` of an edit: the request's author, else the annotation's own (`body.author === undefined ? a.author`).
private func annotationActor(_ c: Connection, _ id: AnnotationID, _ body: JSONValue) throws -> String {
  if let a = body["author"], !a.isNull { return Refs.humanActor(try Refs.authorName(a)) }
  let own = try c.prepared(N6ServiceSQL.annotationAuthor).bindingFirst([.int(id.rawValue)]) { $0.text(0) } ?? "you"
  return Refs.humanActor(own)
}

/// The few statements N6's service files read directly.
enum N6ServiceSQL: SQLCatalog {
  static let annotationAnchor = SQL("n6.service.annotation-anchor", "SELECT anchor_json FROM annotation WHERE id = ?")
  static let annotationAuthor = SQL("n6.service.annotation-author", "SELECT author FROM annotation WHERE id = ?")
  static let journalAppliedSeq = SQL("n6.service.applied-seq", "SELECT value FROM meta WHERE key = 'journal_applied_seq'")
  static let samplePassage = SQL("n6.service.sample-passage",
    "SELECT p.id FROM passage p WHERE p.field = 'body' AND p.end_off - p.start_off >= 40 ORDER BY p.id LIMIT 1",
    scan: .scanOK(reason: "self-tests only; rowid order stops at the first body passage"))
  static let sampleRelationship = SQL("n6.service.sample-relationship",
    "SELECT id FROM relationship WHERE evidence_status = 'documented' ORDER BY id LIMIT 1",
    scan: .scanOK(reason: "self-tests only; rowid order stops at the first documented link"))
  static let all: [SQL] = [annotationAnchor, annotationAuthor, journalAppliedSeq, samplePassage, sampleRelationship]
}
