// OWNER: N6
// D18 anchors (port of tests/anchors.test.mjs): resolution order, whitespace normalisation, context ties, and
// re-anchoring after re-segmentation (IOS-SPEC §6.7 "D18 re-anchoring after re-segmentation").

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

@Suite("Anchors (D18)")
struct AnchorsTests {
  let text = Array("The zero keeps the place. Carry the zero to the next column. The zero keeps the place.".utf16)

  @Test("makeAnchor keeps ≤ 32 units of context and refuses empty or outside spans")
  func make() throws {
    let a = try Anchors.make(text, field: "body", start: 26, end: 51, docId: 7, sha: nil)
    #expect(a.quote == "Carry the zero to the nex")
    #expect(a.prefix == "The zero keeps the place. ")
    #expect(a.suffix.utf16.count <= 32)
    #expect(a.sha256 == Anchors.sha256(text))
    #expect(a.jsonText.hasPrefix(#"{"doc_id":7,"sha256":""#))
    #expect(throws: ScrollsError.self) { try Anchors.make(text, field: "body", start: 5, end: 5, docId: nil, sha: nil) }
    #expect(throws: ScrollsError.self) { try Anchors.make(text, field: "body", start: 0, end: 999, docId: nil, sha: nil) }
  }

  @Test("resolution order: exact, offsets, quote, context, normalized, orphaned")
  func order() throws {
    let a = try Anchors.make(text, field: "body", start: 26, end: 51, docId: 7, sha: nil)
    #expect(Anchors.resolve(text, LooseAnchor(a))?.method == "exact")
    var other = LooseAnchor(a)
    other.sha256 = "different"
    #expect(Anchors.resolve(text, other)?.method == "offsets")
    var moved = LooseAnchor(a)
    moved.start = 0
    moved.end = 25
    let q = Anchors.resolve(text, moved)
    #expect(q?.method == "quote" && q?.start == 26)
    // "The zero keeps the place." occurs twice: context (prefix/suffix) decides; with none, the nearest old start wins
    let twice = try Anchors.make(text, field: "body", start: 61, end: 86, docId: 7, sha: nil)
    var shifted = LooseAnchor(twice)
    shifted.start = 60
    shifted.end = 85
    let c = Anchors.resolve(text, shifted)
    #expect(c?.method == "context" && c?.start == 61 && c?.ambiguous == false)
    var bare = LooseAnchor(twice)
    bare.prefix = ""
    bare.suffix = ""
    bare.start = nil
    bare.end = nil
    #expect(Anchors.resolve(text, bare)?.ambiguous == true)
    // whitespace and line endings may differ
    let wrapped = Array("The zero keeps\r\n the  place. Carry".utf16)
    let n = Anchors.resolve(wrapped, LooseAnchor(quote: "keeps the place"))
    #expect(n?.method == "normalized")
    #expect(String(decoding: Anchors.jsSlice(wrapped, n!.start, n!.end), as: UTF16.self) == "keeps\r\n the  place")
    #expect(Anchors.resolve(text, LooseAnchor(quote: "not in this text")) == nil)
    #expect(Anchors.resolve(text, LooseAnchor(quote: "")) == nil)
  }

  @Test("jsSlice follows String.prototype.slice")
  func slice() {
    let s = Array("abcdef".utf16)
    #expect(String(decoding: Anchors.jsSlice(s, -2), as: UTF16.self) == "ef")
    #expect(String(decoding: Anchors.jsSlice(s, 4, 99), as: UTF16.self) == "ef")
    #expect(Anchors.jsSlice(s, 4, 2).isEmpty)
    #expect(String(decoding: Anchors.jsSlice(s, -99, 2), as: UTF16.self) == "ab")
  }

  @Test("checkAnchor refuses missing, foreign, ambiguous and outside anchors with the reference's reasons")
  func check() async throws {
    let atlas = try TestAtlas.mini("anchors")
    try await atlas.read { c in
      let b = try Mini.body(c, ext: "mini:01")
      let quote = Mini.words(b, from: 10, count: 20)
      let ok = try Anchors.check(c, text: ChunkedTextStore(), input: Mini.anchor(b, quote), docId: b.doc, passage: nil)
      #expect(ok.relocated == nil && ok.anchor.quote == quote)
      #expect(ok.anchor.prefix == Mini.words(b, from: 0, count: 10))
      func reason(_ input: JSONValue?, doc: Int64? = b.doc) -> String? {
        do { _ = try Anchors.check(c, text: ChunkedTextStore(), input: input, docId: doc, passage: nil); return nil } catch let e as ScrollsError {
          #expect(e.status == 400 && e.code == .validation && e.detail["field"]?.stringValue == "anchor")
          return e.detail["reason"]?.stringValue ?? e.message
        } catch { return "\(error)" }
      }
      #expect(reason(nil) == "An anchor is required.")
      #expect(reason(["doc_id": .number(Double(b.doc)), "quote": "zzz not here zzz"]) == "not_found")
      #expect(reason(["doc_id": 999, "quote": "x"]) == "doc_mismatch")
      #expect(reason(["doc_id": .number(Double(b.doc)), "quote": ""]) == "The anchor needs the quoted words (quote).")
      #expect(reason(["doc_id": .number(Double(b.doc)), "field": "nope", "quote": "x"])?.hasPrefix("Anchor field 'nope'") == true)
    }
  }

  @Test("re-segmentation moves an annotation to the passage that now holds its words; a changed text re-locates by quote")
  func reanchor() async throws {
    let atlas = try TestAtlas.mini("reanchor")
    let (b, quote) = try await atlas.read { c in
      let b = try Mini.body(c, ext: "mini:01")
      return (b, Mini.words(b, from: 200, count: 30))
    }
    let created = try await atlas.act("note") { w in
      let body: JSONValue = ["target": ["type": "passage", "ref": .string(String(b.passage))], "kind": "interpretation",
                             "body_md": "the counting house keeps a column", "anchor": Mini.anchor(b, quote)]
      let r = try Annotations.create(w, body)
      return .annotationCreate(try ProvenanceJournal.annotationCreateOp(w, body: body, result: r, journal: []))
    }
    let annId = Int64(created["id"]!.numberValue!)
    // re-segment: the body passage is cut at 150 and a second passage takes the rest
    let newPassage: Int64 = 9_001
    try await atlas.raw { tx in
      try tx.connection.exec("UPDATE passage SET end_off = 150 WHERE id = \(b.passage)")  // lint: sql-ok (fixture surgery)
      try tx.connection.exec("""
        INSERT INTO passage (id, document_id, ord, field, field_class, time_role, unit, quality, start_off, end_off, lang,
          token_count, y_lo, y_hi, is_synthetic)
        SELECT \(newPassage), document_id, 1, field, field_class, time_role, unit, quality, 150, \(b.text.count - 1), lang, 10,
          y_lo, y_hi, is_synthetic FROM passage WHERE id = \(b.passage)
        """)  // lint: sql-ok (fixture surgery)
    }
    let report = try await atlas.writer.write("reanchor") { tx in
      try Anchors.reanchorDocument(tx.connection, text: ChunkedTextStore(), document: b.doc)
    }
    #expect(report.annotationsChecked == 1)
    #expect(report.annotationsReanchored.map(\.to) == [String(newPassage)])
    #expect(report.annotationsReanchored.first?.method == "exact")
    #expect(report.annotationsOrphaned.isEmpty)
    let target = try await atlas.read { c in
      try c.prepared(dynamic: "SELECT target_ref FROM annotation WHERE id = ?").bindingFirst([.int(annId)]) { $0.text(0) }  // lint: sql-ok (test)
    }
    #expect(target == String(newPassage))
    // a second pass changes nothing
    let again = try await atlas.writer.write("reanchor") { tx in
      try Anchors.reanchorDocument(tx.connection, text: ChunkedTextStore(), document: b.doc)
    }
    #expect(again.annotationsUnchanged == 1 && again.annotationsReanchored.isEmpty)
  }
}
