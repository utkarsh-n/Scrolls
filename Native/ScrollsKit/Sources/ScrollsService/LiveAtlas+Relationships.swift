// OWNER: N6
// Relationships in process (server/routes/relationships.mjs): the relationship card, proposals (always proposed,
// origin human), reviews (the evidence status never changes) and evidence. Writes are journaled
// (`relationshipPropose`, `relationshipReview`, `relationshipEvidence`). The logic is ScrollsProvenance's port
// (`Relationships`); its JSON bodies are decoded into the contract types here.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsProvenance
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func relationship(_ id: RelationshipID) async throws -> RelationshipResponse {
    let json = try await read { c in try Relationships.card(c, id: String(id.rawValue)) }
    return try ScrollsJSON.decode(RelationshipResponse.self, from: json)
  }

  @concurrent
  public func proposeRelationship(_ r: ProposeRelationshipRequest) async throws -> CreatedResponse {
    let body = try ScrollsJSON.value(r)
    let journal = r.group != nil ? try await journalEntries() : []
    let op = try await dryRun("proposal") { w in
      let result = try Relationships.propose(w, body)
      return JournalOp.relationshipPropose(try ProvenanceJournal.relationshipProposeOp(w, body: body, result: result, journal: journal))
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]), journal: journal)
    return try ScrollsJSON.decode(CreatedResponse.self, from: out)
  }

  @concurrent
  public func review(_ id: RelationshipID, _ r: ReviewRequest) async throws -> ReviewResponse {
    let body = try ScrollsJSON.value(r)
    let text = self.text
    let op = try await dryRun("review") { w in
      _ = try Relationships.review(w, id: String(id.rawValue), body)
      return JournalOp.relationshipReview(try StableKeys.relKey(w.c, text: text, id.rawValue), r)
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]))
    return try ScrollsJSON.decode(ReviewResponse.self, from: out)
  }

  @concurrent
  public func addEvidence(_ id: RelationshipID, _ r: EvidenceRequest) async throws -> CreatedResponse {
    let body = try ScrollsJSON.value(r)
    let text = self.text
    let op = try await dryRun("evidence") { w in
      _ = try Relationships.attachEvidence(w, id: String(id.rawValue), body)
      return JournalOp.relationshipEvidence(try StableKeys.relKey(w.c, text: text, id.rawValue), r)
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]))
    return try ScrollsJSON.decode(CreatedResponse.self, from: out)
  }
}
