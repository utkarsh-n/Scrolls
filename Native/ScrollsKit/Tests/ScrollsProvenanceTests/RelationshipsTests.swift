// OWNER: N6
// Relationships, reviews and hypothesis groups (port of tests/provenance.test.mjs "relationships: a person can only
// propose (D7)"): a person's link is always proposed + human; the database refuses inferred documented lineage and any
// edit of evidence fields; reviews change only review_status and append a revision and an annotation.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

@Suite("Relationships")
struct RelationshipsTests {
  static let run13 = "it holds the place where nothing is, so that something can be counted"

  static func span(_ b: (passage: Int64, doc: Int64, text: [UInt16], sha: String), _ quote: String) -> JSONValue {
    let a = Mini.anchor(b, quote)
    return ["passage": .number(Double(b.passage)), "start": a["start"]!, "end": a["end"]!, "role": "source_span"]
  }

  @Test("a human link is forced to proposed + origin human, whatever the request asks")
  func forcedProposed() async throws {
    let atlas = try TestAtlas.mini("rel-forced")
    let (b2, b3) = try await atlas.read { c in (try Mini.body(c, ext: "mini:02"), try Mini.body(c, ext: "mini:03")) }
    let out = try await atlas.direct { w in
      try Relationships.propose(w, ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(b2.passage)"),
                                    "rel_type": "explicit_citation", "evidence": [Self.span(b3, Self.run13)],
                                    "note": "The bulletin repeats the memo wording verbatim.", "evidence_status": "documented",
                                    "origin": "source_dataset", "author": "Tester"])
    }
    #expect(out["evidence_status"] == "proposed" && out["origin"] == "human" && out["hypothesis_group"] == .null)
    #expect(out["note"]?.stringValue?.contains("always proposed") == true)
    #expect(out["date_conflict"] == false)
    let id = String(Int64(out["id"]!.numberValue!))
    let card = try await atlas.read { c in try Relationships.card(c, id: id) }
    #expect(card["caution"]?.stringValue == Relationships.caution)
    #expect(card["status_words"]?.stringValue?.hasPrefix("proposed") == true)
    #expect(card["created_by"] == "human:Tester")
    #expect(card["synthetic"] == true)
    #expect(card["evidence"]?[0]?["quote"]?.stringValue == Self.run13)
    #expect(card["evidence"]?[0]?["anchor"]?["sha256"]?.stringValue == b3.sha)
    #expect(card["revisions"]?.arrayValue?.map { $0["action"] } == ["create"])
    #expect(card["revisions"]?[0]?["reason"] == "The bulletin repeats the memo wording verbatim.")
    #expect(card["src"]?["doc"] == "Bench Bulletin No. 7")
    #expect(card["dst"]?["y"] == 1958)
  }

  @Test("requests that cannot become a proposal are refused with actionable errors")
  func refusals() async throws {
    let atlas = try TestAtlas.mini("rel-refuse")
    let (b2, b3) = try await atlas.read { c in (try Mini.body(c, ext: "mini:02"), try Mini.body(c, ext: "mini:03")) }
    let base: JSONObject = ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(b2.passage)"), "rel_type": "proposed_allusion",
                            "evidence": [["passage": .number(Double(b3.passage)), "start": 0, "end": 5]], "note": "A note long enough to keep."]
    @Sendable func with(_ k: String, _ v: JSONValue) -> JSONValue { var o = base; o[k] = v; return .object(o) }
    let cases: [(JSONValue, Int, String)] = [
      (with("evidence", []), 400, "E_VALIDATION"), (with("note", "short"), 400, "E_VALIDATION"),
      (with("rel_type", "influenced"), 400, "E_VALIDATION"), (with("dst", "passage:99999"), 404, "E_NOT_FOUND"),
      (with("dst", base["src"]!), 400, "E_VALIDATION"),
      (with("evidence", [["passage": .number(Double(b3.passage)), "start": 0, "end": 999]]), 400, "E_VALIDATION"),
      (with("evidence", [["passage": .number(Double(b3.passage)), "start": 0, "end": 5, "role": "citation_cue"]]), 400, "E_VALIDATION"),
      (with("evidence", [["passage": .number(Double(b3.passage)), "start": 0, "end": 5, "quote": "nope!"]]), 400, "E_VALIDATION"),
    ]
    for (body, status, code) in cases { expectRefused(await atlas.refusal { w in try Relationships.propose(w, body) }, status, code) }
    let ok = try await atlas.direct { w in
      try Relationships.propose(w, with("evidence", [["passage": .number(Double(b3.passage)), "start": 0, "end": 5, "relative": true]]))
    }
    let card = try await atlas.read { c in try Relationships.card(c, id: String(Int64(ok["id"]!.numberValue!))) }
    #expect(card["evidence"]?[0]?["quote"] == "Bench")
  }

  @Test("the database refuses edits of evidence fields and deletions; reviews follow each reviewer's latest decision")
  func reviews() async throws {
    let atlas = try TestAtlas.mini("rel-review")
    let (b2, b3) = try await atlas.read { c in (try Mini.body(c, ext: "mini:02"), try Mini.body(c, ext: "mini:03")) }
    let out = try await atlas.direct { w in
      try Relationships.propose(w, ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(b2.passage)"),
                                    "rel_type": "near_quotation", "evidence": [Self.span(b3, Self.run13)], "note": "Same 13 tokens as the memo."])
    }
    let id = Int64(out["id"]!.numberValue!)
    for set in ["evidence_status = 'documented'", "origin = 'source_dataset'", "src_ref = '1'", "method = 'x'"] {
      await #expect(throws: StoreError.self) { try await atlas.raw { tx in try tx.connection.exec("UPDATE relationship SET \(set) WHERE id = \(id)") } }
    }
    await #expect(throws: StoreError.self) { try await atlas.raw { tx in try tx.connection.exec("DELETE FROM relationship WHERE id = \(id)") } }
    expectRefused(await atlas.refusal { w in try Relationships.review(w, id: String(id), ["action": "confirm", "note": "too short"]) }, 400, "E_VALIDATION")
    expectRefused(await atlas.refusal { w in try Relationships.review(w, id: String(id), ["action": "approve", "note": "A long enough note."]) }, 400, "E_VALIDATION")
    expectRefused(await atlas.refusal { w in try Relationships.review(w, id: "99999", ["action": "confirm", "note": "A long enough note."]) }, 404, "E_NOT_FOUND")
    let steps: [(String, String, String)] = [("Reader A", "confirm", "confirmed"), ("Reader B", "reject", "disputed"),
                                              ("Reader A", "reject", "rejected"), ("Reader C", "dispute", "disputed")]
    for (i, (author, action, expected)) in steps.enumerated() {
      let r = try await atlas.direct { w in
        try Relationships.review(w, id: String(id), ["action": .string(action), "note": .string("\(action): checked the 13-token run by hand."),
                                                     "author": .string(author)])
      }
      #expect(r["review_status"]?.stringValue == expected, "\(author) \(action)")
      #expect(r["evidence_status"] == "proposed")
      #expect(r["revision"]?.int == i + 2)
    }
    let card = try await atlas.read { c in try Relationships.card(c, id: String(id)) }
    #expect(card["revisions"]?.arrayValue?.map { $0["action"]?.stringValue } == ["create", "confirm", "reject", "reject", "dispute"])
    #expect(card["annotations"]?.arrayValue?.count == 4)
    #expect(Relationships.reviewStatusOf([]) == "unreviewed")
    #expect(Relationships.reviewStatusOf([("b", "dispute"), ("b", "retract")]) == "unreviewed")
    #expect(Relationships.reviewStatusOf([("b", "confirm"), ("b", "reject")]) == "rejected")
  }

  @Test("evidence attaches with a revision, never a status; hypothesis groups keep competing parents side by side")
  func evidenceAndGroups() async throws {
    let atlas = try TestAtlas.mini("rel-groups")
    let (b1, b2, b3) = try await atlas.read { c in
      (try Mini.body(c, ext: "mini:01"), try Mini.body(c, ext: "mini:02"), try Mini.body(c, ext: "mini:03"))
    }
    let g = try await atlas.direct { w in
      try Hypotheses.create(w, ["target": .string("passage:\(b3.passage)"), "question": "Where does the bulletin's line come from?", "author": "Reader A"])
    }
    #expect(g["existing"] == false)
    let again = try await atlas.direct { w in
      try Hypotheses.create(w, ["target": .string("passage:\(b3.passage)"), "question": "Where does the bulletin's line come from?"])
    }
    #expect(again["id"] == g["id"] && again["existing"] == true)
    expectRefused(await atlas.refusal { w in try Hypotheses.create(w, ["target": .string("passage:\(b3.passage)"), "question": ""]) }, 400, "E_VALIDATION")
    expectRefused(await atlas.refusal { w in try Hypotheses.create(w, ["target": "passage:99999", "question": "Where from, then?"]) }, 404, "E_NOT_FOUND")
    let h1 = try await atlas.direct { w in
      try Relationships.propose(w, ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(b2.passage)"), "rel_type": "near_quotation",
                                    "evidence": [Self.span(b3, Self.run13)], "note": "Same 13 tokens as the 1958 memo.", "group": g["id"]!,
                                    "author": "Reader A"])
    }
    _ = try await atlas.direct { w in
      try Relationships.propose(w, ["src": .string("passage:\(b3.passage)"), "dst": .string("passage:\(b1.passage)"), "rel_type": "proposed_allusion",
                                    "evidence": [Self.span(b3, Self.run13)], "note": "The counting-house novel says it first?", "group": g["id"]!,
                                    "author": "Reader B"])
    }
    _ = try await atlas.direct { w in
      try Relationships.review(w, id: String(Int64(h1["id"]!.numberValue!)), ["action": "confirm", "note": "The memo is the earlier dated source.",
                                                                            "author": "Reader C"])
    }
    let group = try await atlas.read { c in try Hypotheses.group(c, id: String(Int64(g["id"]!.numberValue!))) }
    #expect(group["text"] == "⚖ 2 competing")
    #expect(group["hypotheses"]?.arrayValue?.map { $0["review_status"]?.stringValue } == ["confirmed", "unreviewed"])
    #expect(group["hypotheses"]?[0]?["label"] == "from Ledger Memo (14 Mar 1958)")
    let ev = try await atlas.direct { w in
      try Relationships.attachEvidence(w, id: String(Int64(h1["id"]!.numberValue!)),
                                       ["role": "external_record", "locator": "demo-records:liner-notes", "quote": "for the bench",
                                        "note": "Liner notes name it."])
    }
    let card = try await atlas.read { c in try Relationships.card(c, id: String(Int64(h1["id"]!.numberValue!))) }
    #expect(card["evidence"]?.arrayValue?.last?["quote"] == "for the bench")
    #expect(card["evidence"]?.arrayValue?.last?["id"] == ev["id"])
    #expect(card["revisions"]?.arrayValue?.map { $0["action"]?.stringValue } == ["create", "confirm", "add_evidence"])
    #expect(card["evidence_status"] == "proposed")
  }
}
