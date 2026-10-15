// OWNER: N6
// Persistence of user state (IOS-SPEC §6.7): crash injection between the journal append and the commit at 6 kill
// points; a torn last line; 30 scripted notebook acts replayed into a rebuilt generation giving identical user-visible
// answers; D17 across generations with shifted ids (portable cutoffs: as-saved counts and cutoffs identical, the banner
// shown); the resolver recomputing the stored numbers in the generation of the save; idempotent replay by seq.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

@Suite("Journal: write-ahead, crash recovery, replay, portable cutoffs", .serialized)
struct JournalTests {
  static func noteOp(_ b: (passage: Int64, doc: Int64, text: [UInt16], sha: String), quote: String, body: String) -> @Sendable (WriteContext) throws -> JournalOp {
    { w in
      let req: JSONValue = ["target": ["type": "passage", "ref": .string(String(b.passage))], "anchor": Mini.anchor(b, quote),
                            "kind": "interpretation", "body_md": .string(body), "tags": ["journal"]]
      let r = try Annotations.create(w, req)
      return .annotationCreate(try ProvenanceJournal.annotationCreateOp(w, body: req, result: r, journal: []))
    }
  }

  @Test("crash injection at 6 kill points: after relaunch the act is applied exactly once, or not at all", arguments: KillPoint.allCases)
  func crash(_ kill: KillPoint) async throws {
    let atlas = try TestAtlas.mini("crash-\(kill.rawValue)")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:01") }
    let quote = Mini.words(b, from: 30, count: 25)
    _ = try await atlas.act("first", Self.noteOp(b, quote: quote, body: "A first reading before the crash."))
    await #expect(throws: Killed.self) {
      _ = try await atlas.act("killed", kill: kill, Self.noteOp(b, quote: quote, body: "The act the crash interrupts."))
    }
    try await atlas.relaunch()
    let outcome = try await atlas.catchUp()
    let notes = try await atlas.count("annotation")
    let head = await atlas.journal.head
    let applied = try await atlas.appliedSeq()
    switch kill {
    case .beforeAppend, .tornAppend:
      #expect(notes == 1)
      #expect(head == 1, "the torn line is truncated at reopen")
      #expect(outcome.resolved == 0)
    case .afterAppend, .afterApply, .afterRecord:
      #expect(notes == 2)
      #expect(head == 2)
      #expect(outcome.resolved == 1 && outcome.waiting == nil)
    case .afterCommit:
      #expect(notes == 2)
      #expect(head == 2)
      #expect(outcome.resolved == 0, "already applied: the catch-up does nothing")
    }
    #expect(applied == head, "the atlas never holds acts the journal lacks, and applies every act it holds")
    // replay is idempotent by seq
    #expect(try await atlas.catchUp().resolved == 0)
    #expect(try await atlas.count("annotation") == notes)
    // the next act takes the next seq
    _ = try await atlas.act("after", Self.noteOp(b, quote: quote, body: "A reading after the relaunch."))
    #expect(await atlas.journal.head == head + 1)
  }

  @Test("a torn last line is truncated at reopen; damage before the end is reported, never dropped")
  func torn() async throws {
    let atlas = try TestAtlas.mini("torn")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:01") }
    _ = try await atlas.act("one", Self.noteOp(b, quote: Mini.words(b, from: 30, count: 25), body: "One reading of the ledger."))
    let file = try atlas.journalFiles().last!
    let before = try Data(contentsOf: file)
    let h = try FileHandle(forWritingTo: file)
    try h.seekToEnd()
    try h.write(contentsOf: Data(#"{"actor":"human:you","at":"2026"#.utf8))
    try h.close()
    try await atlas.relaunch()
    #expect(atlas.journal.truncatedBytes > 0)
    #expect(try Data(contentsOf: file) == before)
    #expect(try await atlas.catchUp().resolved == 0)
  }

  /// 30 scripted acts: notes, revisions, a reinterpretation, a withdrawal, proposals, reviews, evidence, a group, views.
  static func script(_ atlas: TestAtlas) async throws -> [String: JSONValue] {
    let (b1, b2, b3) = try await atlas.read { c in
      (try Mini.body(c, ext: "mini:01"), try Mini.body(c, ext: "mini:02"), try Mini.body(c, ext: "mini:03"))
    }
    var ids: [String: JSONValue] = [:]
    var notes: [Int64] = []
    for i in 0..<8 {
      let b = [b1, b2, b3][i % 3]
      let r = try await atlas.act("note \(i)", actor: "human:Reader \(i % 2 == 0 ? "A" : "B")",
                                  Self.noteOp(b, quote: Mini.words(b, from: 20 + i, count: 18), body: "Reading \(i) of the counting rule."))
      notes.append(Int64(r["id"]!.numberValue!))
    }
    for (i, id) in notes.enumerated() {
      _ = try await atlas.act("revise \(i)") { w in
        let patch = AnnotationPatchRequest(bodyMd: "Revised reading \(i).", reason: "second look", tags: ["revised"])
        _ = try Annotations.revise(w, id: String(id), try ScrollsJSON.value(patch))
        return .annotationRevise(try StableKeys.annotationKey(w.c, id), patch)
      }
    }
    let first = notes[0], last = notes[7]
    let re = try await atlas.act("reinterpret") { w in
      let req: JSONValue = ["target": ["type": "passage", "ref": .string(String(b1.passage))], "kind": "hypothesis",
                            "body_md": "A competing reading.", "author": "Reader C"]
      let r = try Annotations.reinterpret(w, id: String(first), req)
      let created = Int64(r["id"]!.numberValue!)
      let anchor = try w.c.prepared(dynamic: "SELECT anchor_json FROM annotation WHERE id = ?").bindingFirst([.int(created)]) { $0.text(0) }!
      let op = try ProvenanceJournal.annotationCreateOp(w, body: req, result: ["anchor": try JSONValue.parse(anchor)], journal: [])
      return .annotationReinterpret(try StableKeys.annotationKey(w.c, first), op)
    }
    ids["reinterpreted"] = re["id"]
    _ = try await atlas.act("withdraw") { w in
      _ = try Annotations.withdraw(w, id: String(last), ["reason": "not what the memo says"])
      return .annotationWithdraw(try StableKeys.annotationKey(w.c, last), reason: "not what the memo says")
    }
    let span: JSONValue = ["passage": .number(Double(b3.passage)), "start": 22, "end": 92, "role": "source_span"]
    var rels: [Int64] = []
    for (i, dst) in [b2, b1].enumerated() {
      let r = try await atlas.act("propose \(i)") { w in
        let req: JSONValue = ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(dst.passage)"),
                              "rel_type": i == 0 ? "near_quotation" : "proposed_allusion", "evidence": [span],
                              "note": "The bulletin repeats the earlier words."]
        let out = try Relationships.propose(w, req)
        return .relationshipPropose(try ProvenanceJournal.relationshipProposeOp(w, body: req, result: out, journal: []))
      }
      rels.append(Int64(r["id"]!.numberValue!))
    }
    for (i, action) in ["confirm", "reject", "dispute", "confirm"].enumerated() {
      _ = try await atlas.act("review \(i)", actor: "human:Reader \(i)") { [rels] w in
        let review = ReviewRequest(action: action, note: "Checked the spans by hand (\(i)).", author: "Reader \(i)")
        _ = try Relationships.review(w, id: String(rels[i % 2]), try ScrollsJSON.value(review))
        return .relationshipReview(try StableKeys.relKey(w.c, text: w.text, rels[i % 2]), review)
      }
    }
    _ = try await atlas.act("evidence") { [rels] w in
      let ev = EvidenceRequest(role: "external_record", note: "Liner notes name the memo.", locator: "demo-records:liner")
      _ = try Relationships.attachEvidence(w, id: String(rels[0]), try ScrollsJSON.value(ev))
      return .relationshipEvidence(try StableKeys.relKey(w.c, text: w.text, rels[0]), ev)
    }
    let g = try await atlas.act("group") { w in
      let req: JSONValue = ["target": .string("passage:\(b3.passage)"), "question": "Where does the bulletin's line come from?"]
      _ = try Hypotheses.create(w, req)
      return .hypothesisGroupCreate(try ProvenanceJournal.hypothesisGroupCreateOp(w, body: req))
    }
    ids["group"] = g["id"]
    for i in 0..<3 {
      let r = try await atlas.act("view \(i)") { w in
        let req = SaveViewRequest(name: "ledger view \(i)", state: Seed.state(), comparisonsTried: i)
        let saved = try Views.save(w, try ScrollsJSON.value(req))
        return .viewSave(req, portable: try ProvenanceJournal.portableCutoffs(w.c, text: w.text, saved: saved, seq: 0))
      }
      ids["view\(i)"] = r["slug"]
    }
    _ = try await atlas.act("delete view") { w in
      let slug = try Views.list(w.c, ViewsRequest(q: "ledger view 1"))["items"]![0]!["slug"]!.stringValue!
      try Views.delete(w, slug: slug)
      return .viewDelete(slug: slug)
    }
    ids["acts"] = .number(Double(await atlas.journal.head))
    return ids
  }

  /// Everything a person sees of the notebook, by its own ids.
  static func visible(_ atlas: TestAtlas, _ ids: [String: JSONValue]) async throws -> JSONValue {
    try await atlas.read { c in
      var out = JSONObject()
      out["annotations"] = try Annotations.list(c, AnnotationsRequest(include: "all", limit: 200))
      var revs: [JSONValue] = []
      for id in try c.prepared(dynamic: "SELECT id FROM annotation ORDER BY id").all({ $0.int(0) }) {
        revs.append(try Annotations.revisionsJSON(c, id: String(id)))
      }
      out["revisions"] = .array(revs)
      var cards: [JSONValue] = []
      for id in try c.prepared(dynamic: "SELECT id FROM relationship ORDER BY id").all({ $0.int(0) }) {
        cards.append(try Relationships.card(c, id: String(id)))
      }
      out["relationships"] = .array(cards)
      out["group"] = try Hypotheses.group(c, id: String(ids["group"]!.int!))
      out["views"] = try Views.list(c, ViewsRequest())
      var views: [JSONValue] = []
      for k in ["view0", "view2"] {
        let v = try Views.row(c, slug: ids[k]!.stringValue!)
        let r = try PortableResolver.resolve(c, text: ChunkedTextStore(), view: v)
        views.append(try Views.json(c, v, cutoffs: r.cutoffs, asSaved: true))
      }
      out["asSaved"] = .array(views)
      return .object(out)
    }
  }

  @Test("30 scripted acts replayed into a rebuilt generation give identical answers; replay is deterministic")
  func rebuild() async throws {
    let live = try TestAtlas.mini("gen-live", generation: "gen-one")
    let base = try await live.cloneBase("gen-base", generation: "unused")
    let ids = try await Self.script(live)
    #expect(ids["acts"] == 30)
    let rebuilt = try await base.cloneBase("gen-two", generation: "gen-two")
    let journal = try await ProvenanceJournal.entries(live.journal)
    let outcome = try await ProvenanceJournal.replay(journal, writer: rebuilt.writer, text: rebuilt.text)
    #expect(outcome.resolved == 30 && outcome.waiting == nil && outcome.orphaned == 0 && outcome.refused == 0)
    let a = try await Self.visible(live, ids), b = try await Self.visible(rebuilt, ids)
    #expect(CanonicalJSON.string(a) == CanonicalJSON.string(b))
    // the rebuilt generation opens the views through their portable cutoffs, with the banner
    let banner = try await rebuilt.read { c in
      try PortableResolver.resolve(c, text: ChunkedTextStore(), view: try Views.row(c, slug: ids["view0"]!.stringValue!)).banner
    }
    #expect(banner == "Saved on generation gen-one; opened on generation gen-two: ids remapped, counts as saved")
  }

  @Test("D17 across generations: with shifted ids, as-saved cutoffs select exactly the rows before the view")
  func shiftedGeneration() async throws {
    let live = try TestAtlas.mini("d17-live", generation: "gen-one")
    let base = try await live.cloneBase("d17-base", generation: "unused")
    let ids = try await Self.script(live)
    // another starter: one more base annotation (its own revision row), recorded as the starter's in base_max_ids
    let shifted = try await base.cloneBase("d17-two", generation: "gen-two")
    try await shifted.raw { tx in
      try tx.connection.exec("""
        INSERT INTO annotation (id, target_type, target_ref, kind, author, is_machine, status, is_synthetic, current_rev, created_at)
          VALUES (1500000001, 'document', '1', 'question', 'starter', 0, 'active', 1, 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO annotation_revision (id, annotation_id, rev, body_md, author, at) VALUES (1, 1500000001, 1, 'a starter note', 'starter', '2026-01-01T00:00:00.000Z');
        INSERT INTO id_counter (tbl, slot, next) VALUES ('annotation', 15, 1500000002);
        UPDATE meta SET value = '{"annotation_revision":1}' WHERE key = 'base_max_ids';
        """)  // lint: sql-ok (a different starter)
    }
    let outcome = try await ProvenanceJournal.replay(try await ProvenanceJournal.entries(live.journal), writer: shifted.writer, text: shifted.text)
    #expect(outcome.resolved == 30)
    for k in ["view0", "view2"] {
      let slug = ids[k]!.stringValue!
      let (one, two) = (try await live.read { c in try PortableResolver.resolve(c, text: ChunkedTextStore(), view: try Views.row(c, slug: slug)) },
                        try await shifted.read { c in try PortableResolver.resolve(c, text: ChunkedTextStore(), view: try Views.row(c, slug: slug)) })
      #expect(one.sameGeneration && !two.sameGeneration)
      #expect(two.cutoffs.annotationRev == one.cutoffs.annotationRev + 1, "every revision id moved by the starter's one")
      #expect(two.cutoffs.relationshipRev == one.cutoffs.relationshipRev)
      // the rows before the view are the same rows: compare them by content
      let rowsOne = try await live.read { c in
        try c.prepared(dynamic: "SELECT body_md, at FROM annotation_revision WHERE id <= ? ORDER BY id").bindingFirstAll([.int(one.cutoffs.annotationRev)]) { "\($0.text(0))|\($0.text(1))" }
      }
      let rowsTwo = try await shifted.read { c in
        try c.prepared(dynamic: "SELECT body_md, at FROM annotation_revision WHERE id <= ? AND id > 1 ORDER BY id").bindingFirstAll([.int(two.cutoffs.annotationRev)]) { "\($0.text(0))|\($0.text(1))" }
      }
      #expect(rowsOne == rowsTwo)
      let countsOne = try await live.read { c in try Views.counts(c, view: try Views.row(c, slug: slug), cutoffs: one.cutoffs, asSaved: true, scope: nil) }
      let countsTwo = try await shifted.read { c in try Views.counts(c, view: try Views.row(c, slug: slug), cutoffs: two.cutoffs, asSaved: true, scope: nil) }
      #expect(countsOne == countsTwo)
    }
  }

  @Test("in the generation of the save, the resolver recomputes exactly the stored numbers")
  func recomputeSameGeneration() async throws {
    let live = try TestAtlas.mini("d17-same", generation: "gen-one")
    let ids = try await Self.script(live)
    for k in ["view0", "view2"] {
      let (stored, recomputed) = try await live.read { c -> ((Int64, Int64, Int64), (Int64, Int64, Int64)) in
        let v = try Views.row(c, slug: ids[k]!.stringValue!)
        let p = try PortableResolver.portable(c, viewId: v.id)!
        let r = try PortableResolver.recompute(c, journalSeq: p.journalSeq)
        return ((v.maxImportBatch, v.annotationRevCutoff, v.relationshipRevCutoff), (r.importBatch, r.annotationRev, r.relationshipRev))
      }
      #expect(stored.1 == recomputed.1 && stored.2 == recomputed.2)
      #expect(stored.0 == recomputed.0)
    }
  }

  @Test("an act of another package stops the replay with its reason; nothing after it is applied")
  func waits() async throws {
    let live = try TestAtlas.mini("wait-live")
    let b = try await live.read { c in try Mini.body(c, ext: "mini:01") }
    _ = try await live.act("note", Self.noteOp(b, quote: Mini.words(b, from: 30, count: 25), body: "Before the import."))
    _ = try await live.journal.append(.importRevert(BatchKey(collection: "mini", fileSha256: nil, adapterId: "csv", ordinal: 0)), actor: "human:you")
    _ = try await live.act("note 2", Self.noteOp(b, quote: Mini.words(b, from: 60, count: 25), body: "After the import."))
    let fresh = try TestAtlas.mini("wait-fresh")
    let outcome = try await ProvenanceJournal.replay(try await ProvenanceJournal.entries(live.journal), writer: fresh.writer, text: fresh.text)
    #expect(outcome.resolved == 1)
    #expect(outcome.waiting?.seq == 2 && outcome.waiting?.remaining == 1)
    #expect(outcome.waiting?.reason.contains("importRevert") == true)
    #expect(try await fresh.count("annotation") == 1)
  }
}
