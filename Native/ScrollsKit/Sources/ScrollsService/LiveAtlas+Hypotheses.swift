// OWNER: N6
// Hypotheses in process (server/routes/hypotheses.mjs, logic in lineage/hypotheses.mjs): competing hypothesis groups;
// creating one is journaled (`hypothesisGroupCreate`). Confirming one hypothesis never rejects the others.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsProvenance
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func hypothesisGroup(_ id: HypothesisGroupID) async throws -> HypothesisGroupResponse {
    let json = try await read { c in try Hypotheses.group(c, id: String(id.rawValue)) }
    return try ScrollsJSON.decode(HypothesisGroupResponse.self, from: json)
  }

  @concurrent
  public func createHypothesisGroup(_ r: HypothesisGroupCreateRequest) async throws -> CreatedResponse {
    let body = try ScrollsJSON.value(r)
    let op = try await dryRun("hypothesis group") { w in
      _ = try Hypotheses.create(w, body)
      return JournalOp.hypothesisGroupCreate(try ProvenanceJournal.hypothesisGroupCreateOp(w, body: body))
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]))
    return try ScrollsJSON.decode(CreatedResponse.self, from: out)
  }
}
