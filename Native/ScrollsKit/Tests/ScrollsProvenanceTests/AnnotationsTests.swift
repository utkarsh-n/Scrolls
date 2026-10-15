// OWNER: N6
// Annotations (port of the "annotations: append-only, layers, as-of" part of tests/provenance.test.mjs): anchors
// checked and completed by the engine, machine kinds and machine authors refused, revisions append-only (by trigger),
// reinterpretation as a superseding layer, withdrawal as a last revision, as-of by time and by a view's cutoff.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

@Suite("Annotations")
struct AnnotationsTests {
  typealias Body = (passage: Int64, doc: Int64, text: [UInt16], sha: String)

  static func note(_ b: Body, quote: String, _ extra: [String: JSONValue] = [:]) -> JSONValue {
    var o: JSONObject = [
      "target": ["type": "passage", "ref": .string(String(b.passage))], "anchor": Mini.anchor(b, quote), "kind": "interpretation",
      "body_md": "Reads as a schoolroom rule repeated at work.", "author": "Reader A",
    ]
    for (k, v) in extra { o[k] = v }
    return .object(o)
  }

  @Test("create: the engine checks the anchor against the text and completes it")
  func create() async throws {
    let atlas = try TestAtlas.mini("ann-create")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:02") }
    let quote = Mini.words(b, from: 40, count: 24)
    let r = try await atlas.direct { w in
      try Annotations.create(w, Self.note(b, quote: quote, ["dimensions": ["perspective": "2026 reader"], "tags": ["irony", "irony", " work "]]))
    }
    #expect(r["rev"] == 1)
    #expect(r["anchor"]?["quote"]?.stringValue == quote)
    #expect(r["anchor"]?["sha256"]?.stringValue == b.sha)
    let id = Int64(r["id"]!.numberValue!)
    let rows = try await atlas.read { c in
      let tags = try c.prepared(dynamic: "SELECT tags_json FROM annotation_revision WHERE annotation_id = ?").bindingFirst([.int(id)]) { $0.text(0) }
      let syn = try c.prepared(dynamic: "SELECT is_synthetic FROM annotation WHERE id = ?").bindingFirst([.int(id)]) { $0.int(0) }
      return (tags, syn)
    }
    #expect(rows.0 == #"["irony","work"]"#)
    #expect(rows.1 == 1, "a note on a synthetic passage is synthetic")

    let bad: [(JSONValue, Int, String)] = [
      (Self.note(b, quote: quote, ["anchor": .null]), 400, "E_VALIDATION"),
      (Self.note(b, quote: quote, ["kind": "machine_tag"]), 400, "E_VALIDATION"),
      (Self.note(b, quote: quote, ["kind": "label"]), 400, "E_VALIDATION"),
      (Self.note(b, quote: quote, ["body_md": "   "]), 400, "E_VALIDATION"),
      (Self.note(b, quote: quote, ["target": ["type": "passage", "ref": "99999"]]), 404, "E_NOT_FOUND"),
      (Self.note(b, quote: quote, ["dimensions": ["pragmatic_function": "sarcastic"]]), 400, "E_VALIDATION"),
    ] + ["machine:tagger", "run:12", "Adapter: cipher", "model:gpt-x"].map { (Self.note(b, quote: quote, ["author": .string($0)]), 400, "E_VALIDATION") }
    for (body, status, code) in bad { expectRefused(await atlas.refusal { w in try Annotations.create(w, body) }, status, code) }
    // A missing anchor has its own sentence. The reference's test sends `anchor: undefined`, i.e. no member at all
    // (contracts.mjs skips an undefined optional member and `anchorRequired` answers); the app's
    // AnnotationCreateRequest omits a nil anchor the same way.
    var bare = Self.note(b, quote: quote).objectValue!
    bare["anchor"] = nil
    let noAnchor = bare
    let missing = await atlas.refusal { w in try Annotations.create(w, .object(noAnchor)) }
    #expect(missing?.message == "a passage target needs an anchor")
    #expect(missing?.hint == "Select the words the note is about.")
    #expect(missing?.detail["field"] == "anchor")
    // `anchor: null` is a shape error in the reference, not the missing-anchor sentence (contracts.mjs validates the
    // present member against @Anchor and the refinement never runs; checked with node: "$.anchor: expected object, got null").
    let nullAnchor = await atlas.refusal { w in try Annotations.create(w, Self.note(b, quote: quote, ["anchor": .null])) }
    #expect(nullAnchor?.message == "The request does not match AnnotationRequest: $.anchor: expected object, got null")
    #expect(nullAnchor?.detail["field"] == "anchor")

    // a stale offset with the right quote is re-located by the quote, and the answer says so
    var a = Mini.anchor(b, quote).objectValue!
    a["start"] = .number(a["start"]!.numberValue! + 1)
    a["end"] = .number(a["end"]!.numberValue! + 1)
    let stale = a
    let rel = try await atlas.direct { w in try Annotations.create(w, Self.note(b, quote: quote, ["anchor": .object(stale)])) }
    #expect(rel["relocated"] == "quote")
    // a custom dimension is defined on first use
    _ = try await atlas.direct { w in try Annotations.create(w, Self.note(b, quote: quote, ["dimensions": ["classroom_echo": "strong"]])) }
    let def = try await atlas.read { c in
      try c.prepared(dynamic: "SELECT type, created_by FROM dimension_def WHERE key = 'classroom_echo'").bindingFirst([]) { ($0.text(0), $0.text(1)) }
    }
    #expect(def?.0 == "text" && def?.1 == "human:Reader A")
  }

  @Test("edits append revisions, which triggers keep append-only; reinterpretation supersedes; withdrawal is a last revision")
  func lifecycle() async throws {
    let atlas = try TestAtlas.mini("ann-life")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:02") }
    let quote = Mini.words(b, from: 40, count: 24)
    let first = try await atlas.direct { w in try Annotations.create(w, Self.note(b, quote: quote, ["tags": ["mockery"]])) }
    let id = String(Int64(first["id"]!.numberValue!))
    let rev2 = try await atlas.direct { w in
      try Annotations.revise(w, id: id, ["body_md": "Not mockery: ironic distance.", "reason": "reread the memo"])
    }
    #expect(rev2 == ["id": first["id"]!, "rev": 2])
    let revs = try await atlas.read { c in try Annotations.revisionsJSON(c, id: id) }
    #expect(revs.arrayValue?.map { $0["rev"] } == [1, 2])
    #expect(revs[1]?["tags"] == ["mockery"], "omitted tags carry over")
    #expect(revs[1]?["reason"] == "reread the memo")
    for sql in ["UPDATE annotation_revision SET body_md = 'x'", "DELETE FROM annotation_revision"] {
      await #expect(throws: StoreError.self) { try await atlas.raw { tx in try tx.connection.exec(sql) } }
    }
    let re = try await atlas.direct { w in
      try Annotations.reinterpret(w, id: id, ["target": ["type": "passage", "ref": .string(String(b.passage))], "kind": "interpretation",
                                               "body_md": "A second reading: the rule is a joke.", "author": "Reader B"])
    }
    #expect(re["supersedes"] == first["id"])
    let newId = String(Int64(re["id"]!.numberValue!))
    expectRefused(await atlas.refusal { w in try Annotations.revise(w, id: id, ["body_md": "edit the old one"]) }, 409, "E_ANNOTATION_SUPERSEDED")
    let listed = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)", include: "superseded")) }
    #expect(listed["items"]?.arrayValue?.map { $0["status"]?.stringValue } == ["superseded", "active"])
    #expect(listed["items"]?[1]?["layer"]?.stringValue?.hasPrefix("Reader B, ") == true)
    #expect(listed["items"]?[0]?["superseded_by"] == re["id"])
    let w = try await atlas.direct { w in try Annotations.withdraw(w, id: newId, ["reason": "changed my mind"]) }
    #expect(w["status"] == "withdrawn" && w["rev"] == 2)
    expectRefused(await atlas.refusal { w in try Annotations.withdraw(w, id: newId, [:]) }, 409, "E_ANNOTATION_WITHDRAWN")
    let active = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)")) }
    #expect(active["items"]?.arrayValue?.isEmpty == true)
    let all = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)", include: "all")) }
    #expect(all["items"]?.arrayValue?.count == 2)
    let revsNew = try await atlas.read { c in try Annotations.revisionsJSON(c, id: newId) }
    #expect(revsNew[1]?["reason"] == "withdrawn: changed my mind")
  }

  @Test("as-of shows what existed then, with the text of then; rev_cutoff does the same for a view")
  func asOf() async throws {
    let atlas = try TestAtlas.mini("ann-asof")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:02") }
    let quote = Mini.words(b, from: 40, count: 24)
    let first = try await atlas.direct { w in try Annotations.create(w, Self.note(b, quote: quote)) }
    let id = String(Int64(first["id"]!.numberValue!))
    let cut = try await atlas.read { c in try c.prepared(dynamic: "SELECT MAX(id) FROM annotation_revision").first { $0.int(0) }! }
    try await Task.sleep(for: .milliseconds(5))
    let between = StoreClock.isoNow()
    try await Task.sleep(for: .milliseconds(5))
    _ = try await atlas.direct { w in try Annotations.revise(w, id: id, ["body_md": "A later reading."]) }
    let then = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)", asOf: between)) }
    #expect(then["items"]?[0]?["body_md"] == "Reads as a schoolroom rule repeated at work.")
    #expect(then["items"]?[0]?["revisions"] == 1)
    let byCut = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)", revCutoff: Int(cut))) }
    #expect(byCut["items"]?[0]?["rev"] == 1)
    let now = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)")) }
    #expect(now["items"]?[0]?["rev"] == 2)
    let before = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(target: "passage:\(b.passage)", asOf: "2001-01-01")) }
    #expect(before["items"]?.arrayValue?.isEmpty == true)
    expectRefused(await atlas.refusal { w in try Annotations.list(w.c, AnnotationsRequest(asOf: "yesterday")) }, 400, "E_VALIDATION")
    #expect(try Annotations.parseAsOf("2026-10-10") == "2026-10-10T23:59:59.999Z")
    #expect(try Annotations.parseAsOf("2026-10-10T05:32Z") == "2026-10-10T05:32:00.000Z")
    #expect(try Annotations.parseAsOf("2026-02-30T05:32:44.9Z") == "2026-03-02T05:32:44.900Z")
    #expect(try Annotations.parseAsOf("2026-10-10T24:00Z") == "2026-10-11T00:00:00.000Z")
  }

  @Test("list facets: kind, author, tag, dimension, contradicted, full-text search, paging")
  func facets() async throws {
    let atlas = try TestAtlas.mini("ann-facets")
    let b = try await atlas.read { c in try Mini.body(c, ext: "mini:02") }
    let quote = Mini.words(b, from: 40, count: 24)
    for i in 0..<5 {
      _ = try await atlas.direct { w in
        try Annotations.create(w, Self.note(b, quote: quote, ["kind": i == 0 ? "question" : "interpretation", "author": .string(i < 3 ? "Reader A" : "Reader B"),
                                                              "tags": i == 1 ? ["counting"] : [], "body_md": .string("Reading number \(i) of the ledger memo."),
                                                              "dimensions": i == 2 ? ["perspective": "clerk"] : [:]]))
      }
    }
    func list(_ q: AnnotationsRequest) async throws -> [JSONValue] {
      try await atlas.read { c in try Annotations.list(c, q) }["items"]?.arrayValue ?? []
    }
    #expect(try await list(AnnotationsRequest(kind: "question")).count == 1)
    #expect(try await list(AnnotationsRequest(author: "Reader B")).count == 2)
    #expect(try await list(AnnotationsRequest(tag: "counting")).count == 1)
    #expect(try await list(AnnotationsRequest(dimension: "perspective:clerk")).count == 1)
    #expect(try await list(AnnotationsRequest(q: "number 3")).count == 1)
    #expect(try await list(AnnotationsRequest(doc: DocumentID(rawValue: b.doc))).count == 5)
    let page = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(limit: 2)) }
    #expect(page["items"]?.arrayValue?.count == 2 && page["cursor"]?.stringValue != nil)
    let next = try await atlas.read { c in try Annotations.list(c, AnnotationsRequest(cursor: page["cursor"]?.stringValue, limit: 10)) }
    #expect(next["items"]?.arrayValue?.count == 3 && next["cursor"] == .null)
    expectRefused(await atlas.refusal { w in try Annotations.list(w.c, AnnotationsRequest(kind: "nope")) }, 400, "E_VALIDATION")
    expectRefused(await atlas.refusal { w in try Annotations.list(w.c, AnnotationsRequest(target: "passage")) }, 400, "E_VALIDATION")
  }
}
