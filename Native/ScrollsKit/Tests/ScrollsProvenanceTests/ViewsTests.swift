// OWNER: N6
// Saved views (port of the views parts of tests/provenance.test.mjs and tests/views.as-saved.test.mjs): immutable
// (trigger), `slug~n` re-saves, pinned runs, the drift report, and as-saved counts that do not move when the corpus does
// (D17): a later import and a reverted one leave "as saved" exactly as it was.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsProvenance
import ScrollsStore
import Testing

/// Fixture surgery shared by the view and journal tests.
enum Seed {
  /// A succeeded analysis run.
  static func run(_ c: Connection, id: Int64, stage: String, params: String = "{}", scope: String = "{}") throws {
    try c.exec("""
      INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint,
        data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES (\(id), '\(stage)', 'test@1', 'code-\(stage)', '\(params)', 'p\(id)', '\(scope)', 'in\(id)', 0, 'u61m-1', 'seg-1', 'icu',
        'succeeded', '2026-10-10T00:00:00.000Z')
      """)  // lint: sql-ok (test fixture)
  }

  /// An expression of corpus `test` counted by materialize run `run` in documents 1–3 (n = 2, 1, 1).
  static func expression(_ c: Connection, id: Int64, run: Int64) throws {
    try c.exec("""
      INSERT INTO expression (id, corpus_id, kind, surface, norm, lang, origin, created_by, created_at)
        VALUES (\(id), 5, 'word', 'zero', 'zero', 'en', 'user_query', 'user', '2026-10-10T00:00:00.000Z');
      INSERT INTO expression_state (expression_id, run_id, variants_hash, status, updated_at)
        VALUES (\(id), \(run), 'v', 'ready', '2026-10-10T00:00:00.000Z');
      INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_passages, run_id) VALUES
        (\(id), 1, 'en', 'text', 2, 1, \(run)), (\(id), 2, 'en', 'text', 1, 1, \(run)), (\(id), 3, 'en', 'text', 1, 1, \(run));
      """)  // lint: sql-ok (test fixture)
  }

  /// A later committed import with one document in the mini collection (a pack or an import after the save).
  static func laterImport(_ c: Connection, batch: Int64, doc: Int64) throws {
    try c.exec("""
      INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, format, status, created_at, committed_at)
        SELECT \(batch), 1, adapter_id, adapter_version, 'adapter', 'committed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
        FROM import_batch WHERE id = 1;
      INSERT INTO document (id, collection_id, import_batch_id, ext_id, kind, chrono_status, original_meta_json, passage_count,
        token_count, created_at) VALUES (\(doc), 1, \(batch), 'mini:later-\(doc)', 'book', 'undated', '{}', 1, 9, '2030-01-01T00:00:00.000Z');
      INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages) VALUES (\(doc), 'en', 'text', 9, 1);
      """)  // lint: sql-ok (test fixture)
  }

  static func state(_ corpus: String = "test", strands: [JSONValue] = []) -> JSONValue {
    ["v": 1, "corpus": .string(corpus), "strands": .array(strands)]
  }
}

@Suite("Saved views")
struct ViewsTests {
  @Test("save: slug from name and state hash, cutoffs and pins, warnings; re-save is slug~n; the row is immutable")
  func save() async throws {
    let atlas = try TestAtlas.mini("views-save")
    let first = try await atlas.direct { w in try Views.save(w, ["name": "Zero in the ledger", "state": Seed.state()]).response }
    let slug = first["slug"]!.stringValue!
    #expect(slug.hasPrefix("zero-in-the-ledger-") && slug.utf16.count == "zero-in-the-ledger-".utf16.count + 4)
    #expect(first["url"]?.stringValue == "/#view=\(slug)")
    #expect(first["cutoffs"] == ["import_batch": 1, "annotation_rev": 0, "relationship_rev": 0])
    #expect(first["warnings"] == ["the view's query could not be resolved: At least one strand is required."])
    #expect(first["counts"]?["documents"] == 12 && first["counts"]?["passages"] == 15)
    #expect(first["synthetic"] == true)
    let again = try await atlas.direct { w in try Views.save(w, ["name": "Zero in the ledger", "state": Seed.state()]).response }
    #expect(again["slug"]?.stringValue == "\(slug)~2" && again["parent_slug"]?.stringValue == slug)
    let third = try await atlas.direct { w in
      try Views.save(w, ["name": "Another name", "state": Seed.state(), "parent_slug": .string("\(slug)~2")]).response
    }
    #expect(third["slug"]?.stringValue == "\(slug)~3")
    expectRefused(await atlas.refusal { w in try Views.save(w, ["name": "x", "state": Seed.state(), "parent_slug": "nope"]).response }, 404, "E_NOT_FOUND")
    expectRefused(await atlas.refusal { w in try Views.save(w, ["name": "  ", "state": Seed.state()]).response }, 400, "E_VALIDATION")
    expectRefused(await atlas.refusal { w in try Views.save(w, ["name": "x", "state": [1]]).response }, 400, "E_VALIDATION")
    await #expect(throws: StoreError.self) {
      try await atlas.raw { tx in try tx.connection.exec("UPDATE saved_view SET state_json = '{}' WHERE slug = '\(slug)'") }
    }
    let list = try await atlas.read { c in try Views.list(c, ViewsRequest()) }
    #expect(list["items"]?.arrayValue?.map { $0["slug"]?.stringValue } == ["\(slug)~3", "\(slug)~2", slug])
    try await atlas.direct { w in try Views.delete(w, slug: "\(slug)~2") }
    expectRefused(await atlas.refusal { w in try Views.json(w.c, try Views.row(w.c, slug: "\(slug)~2"), cutoffs: .init(importBatch: 0, annotationRev: 0, relationshipRev: 0, runIds: [:], state: [:]), asSaved: false) }, 404, "E_NOT_FOUND")
    // q matches the name or the slug, case-folded (views.mjs `lower(v.name) LIKE ? OR lower(v.slug) LIKE ?`): "ZERO"
    // finds the first save by its name and slug~3 ("Another name") by its slug; the deleted slug~2 is not listed.
    let after = try await atlas.read { c in try Views.list(c, ViewsRequest(q: "ZERO")) }
    #expect(after["items"]?.arrayValue?.map { $0["slug"]?.stringValue } == ["\(slug)~3", slug])
    let byName = try await atlas.read { c in try Views.list(c, ViewsRequest(q: " another ")) }
    #expect(byName["items"]?.arrayValue?.map { $0["slug"]?.stringValue } == ["\(slug)~3"])
    let none = try await atlas.read { c in try Views.list(c, ViewsRequest(q: "nothing")) }
    #expect(none["items"] == [])
  }

  @Test("pins: the strand's materialize run, quotes and boilerplate; a newer run is reported, never followed")
  func pins() async throws {
    let atlas = try TestAtlas.mini("views-pins")
    try await atlas.raw { tx in
      try Seed.run(tx.connection, id: 11, stage: "materialize", params: #"{"expression":21}"#)
      try Seed.run(tx.connection, id: 12, stage: "reuse-index")
      try Seed.run(tx.connection, id: 13, stage: "boilerplate")
      try Seed.expression(tx.connection, id: 21, run: 11)
    }
    let state = Seed.state(strands: [["type": "expression", "id": 21]])
    let saved = try await atlas.direct { w in try Views.save(w, ["name": "zero strand", "state": state]).response }
    #expect(saved["runIds"] == ["materialize": ["21": 11], "quotes": 12, "boilerplate": 13])
    #expect(saved["warnings"] == [])
    #expect(saved["counts"]?["strands"] == ["21": ["n": 4, "docs": 3, "run": 11]])
    // a recount (run 14) and a later import: current follows them, as saved does not
    try await atlas.raw { tx in
      try Seed.run(tx.connection, id: 14, stage: "materialize", params: #"{"expression":21}"#)
      try tx.connection.exec("""
        UPDATE expression_state SET run_id = 14 WHERE expression_id = 21;
        INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_passages, run_id) VALUES (21, 1, 'en', 'text', 5, 1, 14);
        """)  // lint: sql-ok (test fixture)
      try Seed.laterImport(tx.connection, batch: 2, doc: 500)
      try tx.connection.exec("UPDATE document SET deleted_at = '2031-01-01T00:00:00.000Z' WHERE id = 2")  // lint: sql-ok (a revert after the save)
    }
    let slug = saved["slug"]!.stringValue!
    let view = try await atlas.read { c in
      let v = try Views.row(c, slug: slug)
      return try Views.json(c, v, cutoffs: v.savedCutoffs, asSaved: true)
    }
    #expect(view["state"]?["asSaved"] == true)
    #expect(view["counts"]?["asSaved"] == saved["counts"])
    #expect(view["counts"]?["current"]?["documents"] == 12)  // +1 later import, −1 reverted
    #expect(view["counts"]?["current"]?["strands"] == ["21": ["n": 5, "docs": 1, "run": 14]])
    #expect(view["drift"]?["dataChanged"] == true)
    #expect(view["drift"]?["importsSince"]?.arrayValue?.count == 1)
    #expect(view["drift"]?["newerRuns"] == [["stage": "materialize", "run": 14, "pinned": 11, "expression": 21]])
    #expect(view["drift"]?["message"]?.stringValue == Views.driftMessage(1))
  }
}
