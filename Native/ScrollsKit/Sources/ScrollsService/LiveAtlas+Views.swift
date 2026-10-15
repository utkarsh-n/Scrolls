// OWNER: N6
// Views in process (server/routes/views.mjs): saved views — immutable, `slug~n`, as-saved through `ViewCutoffResolver`,
// portable cutoffs (IOS-SPEC §6.4); save and delete are journaled (`viewSave`, `viewDelete`). The logic is
// ScrollsProvenance's port (`Views`); its JSON bodies are decoded into the contract types here. `viewProvenance` gives
// the app what contract 1.3.0 has no field for: the generation banner and the runs being restored.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsProvenance
import ScrollsStore

/// What the app shows about where a saved view's numbers come from (IOS-SPEC §4.15).
public struct ViewProvenance: Sendable, Equatable {
  /// The view was saved in this generation.
  public var sameGeneration: Bool
  /// "Saved on generation …; opened on generation …: ids remapped, counts as saved".
  public var banner: String?
  /// "pinned analysis being restored (run #14)".
  public var restoring: [String]
  /// The generation it was saved in, and the journal act that saved it (nil for a view saved without a journal).
  public var savedGeneration: String?
  public var journalSeq: UInt64?
}

extension LiveAtlas {
  @concurrent
  public func saveView(_ r: SaveViewRequest) async throws -> ViewSavedResponse {
    let body = try ScrollsJSON.value(r)
    let text = self.text
    let seq = await journal.head + 1
    let op = try await dryRun("saved view") { w in
      let saved = try Views.save(w, body)
      return JournalOp.viewSave(r, portable: try ProvenanceJournal.portableCutoffs(w.c, text: text, saved: saved, seq: seq))
    }
    let out = try await journaledAct(op, actor: try ProvenanceJournal.actor(body["author"]))
    return try ScrollsJSON.decode(ViewSavedResponse.self, from: out)
  }

  @concurrent
  public func views(_ r: ViewsRequest) async throws -> ViewsResponse {
    let json = try await read { c in try Views.list(c, r) }
    return try ScrollsJSON.decode(ViewsResponse.self, from: json)
  }

  @concurrent
  public func view(_ slug: String, asSaved: Bool) async throws -> SavedViewResponse {
    let text = self.text
    let json = try await read { c in
      let v = try Views.row(c, slug: slug)
      let resolved = try ViewCutoffResolver.resolve(c, text: text, view: v)
      return try Views.json(c, v, cutoffs: resolved.cutoffs, asSaved: asSaved)
    }
    return try ScrollsJSON.decode(SavedViewResponse.self, from: json)
  }

  @concurrent
  public func deleteView(_ slug: String) async throws -> DeleteViewResponse {
    let op = try await dryRun("view deletion") { w in
      try Views.delete(w, slug: slug)
      return JournalOp.viewDelete(slug: slug)
    }
    _ = try await journaledAct(op, actor: Refs.humanActor("you"))
    return DeleteViewResponse()
  }

  /// Where a saved view's numbers come from in this generation (the banner the contract has no field for).
  @concurrent
  public func viewProvenance(_ slug: String) async throws -> ViewProvenance {
    let text = self.text
    return try await read { c in
      let v = try Views.row(c, slug: slug)
      let r = try ViewCutoffResolver.resolve(c, text: text, view: v)
      return ViewProvenance(sameGeneration: r.sameGeneration, banner: r.banner, restoring: r.restoring,
                            savedGeneration: r.portable?.generation, journalSeq: r.portable?.journalSeq)
    }
  }
}
