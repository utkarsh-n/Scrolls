// OWNER: N0
// IOS-SPEC §8.4.10 item 2: "every CHECK rejects and every trigger fires". The CHECKs are read from sqlite_master (119
// across schema.sql and the device profile); each has a case that inserts a valid row with one change and must fail
// with exactly that CHECK (SQLite names the failing expression). A CHECK without a passing case fails the coverage
// test, so a new CHECK in the DDL cannot go untested. Triggers likewise: each fires, and the allowed paths pass.

import Foundation
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("CHECK constraints and triggers")
struct ConstraintTests {
  typealias Values = [String: SQLValue]

  /// A valid row of every table that has a CHECK (foreign keys are off in the CHECK test).
  static let baseline: [String: Values] = [
    "corpus": ["slug": .text("s"), "name": .text("n"), "kind": .text("real"), "is_synthetic": .int(0), "created_at": .text("t")],
    "source_adapter": ["id": .text("a"), "version": .text("1"), "label": .text("l"), "access": .text("local-file"),
                       "enabled": .int(1), "config_json": .text("{}")],
    "collection": ["corpus_id": .int(1), "adapter_id": .text("a"), "slug": .text("s"), "name": .text("n"), "domain": .text("demo"),
                   "modality": .text("text"), "unit": .text("tokens"), "sampling": .text("complete"), "rate_eligible": .int(1),
                   "export_text_allowed": .int(1), "is_synthetic": .int(0), "caveats_json": .text("[]"), "created_at": .text("t")],
    "import_batch": ["adapter_id": .text("a"), "adapter_version": .text("1"), "format": .text("csv"), "mapping_json": .text("{}"),
                     "options_json": .text("{}"), "status": .text("uploaded"), "created_at": .text("t")],
    "import_issue": ["batch_id": .int(1), "severity": .text("info"), "code": .text("c"), "message": .text("m"), "suggestion": .text("s")],
    "document": ["collection_id": .int(1), "import_batch_id": .int(1), "ext_id": .text("e"), "kind": .text("book"),
                 "is_translation": .int(0), "has_full_text": .int(0), "chrono_status": .text("dated"), "lo_day": .int(1),
                 "hi_day": .int(2), "date_label": .text("x"), "original_meta_json": .text("{}"), "is_synthetic": .int(0),
                 "created_at": .text("t")],
    "document_field": ["document_id": .int(1), "field": .text("title"), "value": .text("v")],
    "doc_tag": ["document_id": .int(1), "scheme": .text("theme"), "value": .text("v"), "provenance": .text("catalog"), "method": .text("m")],
    "date_assertion": ["subject_type": .text("document"), "subject_id": .int(1), "role": .text("publication"), "lo_day": .int(1),
                       "hi_day": .int(2), "precision": .text("year"), "basis": .text("stated"), "approx": .int(0),
                       "asserted_by": .text("x"), "is_chronology": .int(0)],
    "doc_bin": ["level": .int(0), "bin": .int(1), "document_id": .int(1)],
    "doc_tokens": ["document_id": .int(1), "plang": .text("en"), "field_class": .text("text"), "tokens": .int(1), "passages": .int(1)],
    "passage": ["document_id": .int(1), "ord": .int(0), "field": .text("body"), "field_class": .text("text"),
                "time_role": .text("document"), "unit": .text("paragraph"), "quality": .text("ok"), "start_off": .int(0),
                "end_off": .int(5), "lang": .text("en"), "token_count": .int(1), "is_synthetic": .int(0)],
    "expression": ["kind": .text("word"), "surface": .text("s"), "norm": .text("n"), "origin": .text("demo"), "is_synthetic": .int(0),
                   "created_by": .text("x"), "created_at": .text("t"), "meta_json": .text("{}")],
    "expression_variant": ["expression_id": .int(1), "form": .text("f"), "norm": .text("n"), "variant_type": .text("identity"),
                           "rule": .text("identity"), "evidence_status": .text("computed"), "enabled": .int(1)],
    "expression_state": ["expression_id": .int(1), "variants_hash": .text("h"), "status": .text("none"), "sampled": .int(0),
                         "names_excluded": .int(0), "updated_at": .text("t")],
    "occurrence": ["expression_id": .int(1), "passage_id": .int(1), "document_id": .int(1), "start_off": .int(0), "end_off": .int(1),
                   "tok_index": .int(0), "name_flag": .int(0), "sampled": .int(0), "run_id": .int(1)],
    "etymon": ["key": .text("k"), "kind": .text("etymon"), "lang": .text("en"), "form": .text("f"), "parent_semantics": .text("none")],
    "analysis_run": ["stage": .text("s"), "pipeline_version": .text("p"), "code_hash": .text("c"), "params_json": .text("{}"),
                     "params_hash": .text("h"), "scope_json": .text("{}"), "input_fingerprint": .text("f"), "data_version": .int(0),
                     "upstream_run_ids": .text("[]"), "tokenizer_version": .text("t"), "segmenter_version": .text("s"),
                     "icu_version": .text("i"), "status": .text("running"), "gate_json": .text("{}"), "started_at": .text("t")],
    "time_window": ["run_id": .int(1), "label": .text("l"), "lo_year": .int(1), "hi_year": .int(2), "scheme": .text("fixed")],
    "vector_space": ["run_id": .int(1), "lang": .text("en"), "pooled": .int(1), "collections_json": .text("[]"), "tokens": .int(1),
                     "docs": .int(1), "authors": .int(1), "vocab_size": .int(1), "dim": .int(1), "rel_path": .text("p")],
    "space_alignment": ["run_id": .int(1), "from_space": .int(1), "to_space": .int(1), "method": .text("orthogonal_procrustes"),
                        "anchors": .int(1), "mean_anchor_cos": .double(0.5), "rel_path": .text("p")],
    "sense_cluster": ["run_id": .int(1), "expression_id": .int(1), "ord": .int(0), "label_auto": .text("l"),
                      "distinctive_json": .text("[]"), "size": .int(1), "n_docs": .int(1), "top_doc_share": .double(0.5),
                      "status": .text("hypothesis")],
    "cluster_transition": ["run_id": .int(1), "kind": .text("emerge"), "window_id": .int(1)],
    "drift_result": ["run_id": .int(1), "expression_id": .int(1), "slice_a_json": .text("{}"), "slice_b_json": .text("{}"),
                     "metric": .text("rate_ratio"), "value": .double(1), "gate": .text("ok"), "gate_detail_json": .text("{}"),
                     "caveats_json": .text("[]")],
    "rel_type": ["code": .text("c"), "family": .text("quotation"), "label": .text("l"), "inverse_label": .text("i"), "directed": .int(1),
                 "requires_precedence": .int(0), "implies_transmission": .int(0), "feedback_capable": .int(0), "glyph": .text("g"),
                 "description": .text("d")],
    "relationship": ["rel_type": .text("c"), "src_type": .text("document"), "src_ref": .text("1"), "dst_type": .text("document"),
                     "dst_ref": .text("2"), "directed": .int(1), "evidence_status": .text("proposed"), "origin": .text("human"),
                     "provenance_quality": .text("complete"), "created_by": .text("human:u"), "review_status": .text("unreviewed"),
                     "date_conflict": .int(0), "is_synthetic": .int(0), "current_rev": .int(1), "created_at": .text("t")],
    "relationship_evidence": ["relationship_id": .int(1), "role": .text("supporting"), "added_by": .text("x"), "added_at": .text("t")],
    "relationship_revision": ["relationship_id": .int(1), "rev": .int(1), "actor": .text("a"), "at": .text("t"),
                              "action": .text("create"), "after_json": .text("{}")],
    "dimension_def": ["key": .text("k"), "label": .text("l"), "type": .text("text"), "builtin": .int(0), "created_by": .text("x")],
    "annotation": ["target_type": .text("document"), "target_ref": .text("1"), "kind": .text("interpretation"), "author": .text("a"),
                   "is_machine": .int(0), "status": .text("active"), "is_synthetic": .int(0), "current_rev": .int(1), "created_at": .text("t")],
    "annotation_revision": ["annotation_id": .int(1), "rev": .int(1), "body_md": .text("b"), "stance": .text("neutral"),
                            "dimensions_json": .text("{}"), "tags_json": .text("[]"), "evidence_refs_json": .text("[]"),
                            "author": .text("a"), "at": .text("t")],
    "saved_view": ["slug": .text("s"), "name": .text("n"), "state_json": .text("{}"), "state_version": .int(1), "state_hash": .text("h"),
                   "data_version": .int(0), "max_import_batch": .int(0), "run_ids_json": .text("[]"), "annotation_rev_cutoff": .int(0),
                   "relationship_rev_cutoff": .int(0), "created_by": .text("x"), "created_at": .text("t")],
    "job": ["type": .text("x"), "params_json": .text("{}"), "writes": .int(0), "priority": .int(5), "status": .text("queued"),
            "created_at": .text("t")],
    "job_event": ["job_id": .int(1), "at": .text("t"), "level": .text("info")],
    "text_storage": ["document_id": .int(1), "layout": .text("chunked-1"), "utf16_len": .int(1), "utf8_len": .int(1), "chunk_count": .int(1)],
    "text_chunk": ["document_id": .int(1), "ord": .int(0), "start_off": .int(0), "end_off": .int(1), "codec": .text("utf8"),
                   "z": .blob([0x61])],
    "journal_applied": ["seq": .int(1), "op": .text("o"), "applied_at": .text("t"), "max_ids_json": .text("{}")],
    "saved_view_portable": ["view_id": .int(1), "portable_json": .text("{}"), "created_at": .text("t")],
  ]

  /// Changes that break one CHECK each, where a generated change would not (cross-column CHECKs).
  static let specialCases: [(table: String, change: Values)] = [
    ("corpus", ["kind": .text("synthetic"), "is_synthetic": .int(0)]),
    ("source_adapter", ["access": .text("network"), "enabled": .int(1), "approved_at": .null]),
    ("document", ["chrono_status": .text("undated")]),
    ("document", ["lo_day": .int(5), "hi_day": .int(2)]),
    ("document", ["prominence_tercile": .int(4)]),
    ("date_assertion", ["precision": .text("unknown")]),
    ("date_assertion", ["lo_day": .int(5), "hi_day": .int(2)]),
    ("passage", ["start_off": .int(5), "end_off": .int(1)]),
    ("drift_result", ["gate": .text("not_run")]),
    ("relationship", ["evidence_status": .text("documented"), "origin": .text("source_dataset"), "source_dataset": .text("x")]),
    ("relationship", ["origin": .text("source_dataset"), "source_dataset": .text("x")]),
    ("relationship", ["evidence_status": .text("computed")]),  // computed ⇒ algorithm comes before human ⇒ proposed
    ("relationship", ["evidence_status": .text("computed"), "origin": .text("algorithm"), "method": .text("m")]),
    ("relationship", ["origin": .text("machine_tagger")]),
    ("relationship", ["created_by": .text("adapter:x")]),
    ("relationship", ["score": .double(0.5)]),
    ("relationship", ["score": .double(0.5), "score_kind": .text("zz_invalid")]),
    ("annotation", ["is_machine": .int(1)]),
    ("annotation", ["target_type": .text("passage")]),
    ("import_batch", ["summary_json": .text("{bad")]),
    ("doc_bin", ["level": .int(4)]),
    ("space_alignment", ["method": .text("svd")]),
    ("text_chunk", ["start_off": .int(1), "end_off": .int(1)]),
  ]

  /// A generated change for the single-column CHECK forms: `col IN (…)`, `col IN (0,1)`, `json_valid(col)`.
  static func generatedChange(_ expr: String) -> Values? {
    if let m = expr.wholeMatch(of: /(\w+) IN \(0,1\)/) { return [String(m.1): .int(2)] }
    if let m = expr.wholeMatch(of: /(\w+) IN \('.*'\)/) { return [String(m.1): .text("zz_invalid")] }
    if let m = expr.wholeMatch(of: /json_valid\((\w+)\)/) { return [String(m.1): .text("{bad")] }
    return nil
  }

  static func insert(_ c: Connection, _ table: String, _ values: Values) throws {
    let cols = values.keys.sorted()
    let sql = "INSERT INTO \(table) (\(cols.joined(separator: ", "))) VALUES (\(cols.map { _ in "?" }.joined(separator: ", ")))"
    let s = try c.prepared(dynamic: sql)
    try s.bind(cols.map { values[$0]! })
    try s.run()
  }

  /// The CHECK a failed insert names ("CHECK constraint failed: <expr>"), whitespace-normalised.
  static func failedCheck(_ c: Connection, _ table: String, _ values: Values) -> String? {
    do {
      try insert(c, table, values)
      return nil
    } catch let e as StoreError where e.isCheck {
      guard let r = e.message.range(of: "CHECK constraint failed: ") else { return "?" + e.message }
      return Fixtures.normalize(String(e.message[r.upperBound...]))
    } catch {
      return "error: \(error)"
    }
  }

  @Test("every CHECK of schema.sql and the device profile rejects a row that breaks it (and only that CHECK)")
  func everyCheckRejects() throws {
    let c = try Connection(path: try Fixtures.atlas(.device, seed: false), mode: .readWrite, profile: .device)
    try c.exec("PRAGMA foreign_keys = OFF")
    let checks = try Fixtures.checkConstraints(c)
    #expect(checks.count == 119, "the DDL has \(checks.count) CHECKs; update this count when the DDL changes")
    // every baseline row is valid
    for (table, values) in Self.baseline {
      try c.exec("SAVEPOINT baseline")
      do { try Self.insert(c, table, values) } catch { Issue.record("baseline \(table) is invalid: \(error)") }
      try c.exec("ROLLBACK TO baseline; RELEASE baseline")
    }
    var covered: Set<String> = []
    var cases: [(String, Values)] = Self.specialCases
    for (table, expr) in checks {
      if let change = Self.generatedChange(expr) { cases.append((table, change)) }
    }
    for (table, change) in cases {
      guard let base = Self.baseline[table] else {
        Issue.record("no baseline row for \(table)")
        continue
      }
      let row = base.merging(change) { $1 }
      guard let named = Self.failedCheck(c, table, row) else {
        Issue.record("\(table) \(change) was accepted")
        continue
      }
      guard checks.contains(where: { $0.table == table && $0.expr == named }) else {
        Issue.record("\(table) \(change) failed with something else: \(named)")
        continue
      }
      covered.insert("\(table): \(named)")
    }
    let all = Set(checks.map { "\($0.table): \($0.expr)" })
    let missing = all.subtracting(covered).sorted()
    #expect(missing.isEmpty, "CHECKs without a rejecting case: \(missing)")
    #expect(covered.count == 119)
  }

  @Test("STRICT tables refuse a value of the wrong type")
  func strictTypes() throws {
    let c = try Connection(path: try Fixtures.atlas(.device, seed: false), mode: .readWrite, profile: .device)
    try c.exec("PRAGMA foreign_keys = OFF")
    let e = #expect(throws: StoreError.self) {
      try Self.insert(c, "passage", Self.baseline["passage"]!.merging(["token_count": .text("many")]) { $1 })
    }
    #expect(e?.isConstraint == true)
  }

  // ── triggers ──

  /// An atlas with one row in each table a trigger guards (foreign keys on).
  static func triggerAtlas() throws -> Connection {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readWrite, profile: .device)
    try c.exec("""
      INSERT INTO source_adapter (id, version, label, access) VALUES ('file.csv', '1', 'CSV', 'local-file');
      INSERT INTO collection (id, corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, created_at)
        VALUES (1, 1, 'file.csv', 'c', 'C', 'imported', 'text', 'tokens', 'user', 't');
      INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, format, status, created_at)
        VALUES (1, 1, 'file.csv', '1', 'csv', 'committed', 't');
      INSERT INTO document (id, collection_id, import_batch_id, ext_id, kind, chrono_status, original_meta_json, created_at)
        VALUES (1, 1, 1, 'e1', 'letter', 'undated', '{}', 't');
      INSERT INTO document_text (document_id, original, body_start, body_end, original_sha256, decoder)
        VALUES (1, '', 0, 1, 'x', 'utf-8');
      INSERT INTO text_chunk (document_id, ord, start_off, end_off, codec, z) VALUES (1, 0, 0, 1, 'utf8', X'61');
      INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint,
        data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
        VALUES (1, 'trace', 'trace@1', 'c', '{}', 'h', '{}', 'f', 0, 'u61m-1', 'seg-1', 'i', 'succeeded', 't'),
               (2, 'trace', 'trace@1', 'c', '{}', 'h2', '{}', 'f', 0, 'u61m-1', 'seg-1', 'i', 'cancelled', 't');
      INSERT INTO relationship (id, rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin, method, run_id,
        created_by, created_at)
        VALUES (1, 'exact_quotation', 'document', '1', 'document', '1', 1, 'computed', 'algorithm', 'm', 1, 'run:1', 't'),
               (2, 'exact_quotation', 'document', '1', 'document', '1', 1, 'computed', 'algorithm', 'm', 2, 'run:2', 't');
      INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, after_json) VALUES (1, 1, 1, 'a', 't', 'create', '{}');
      INSERT INTO annotation (id, target_type, target_ref, kind, author, is_machine, created_at)
        VALUES (1, 'document', '1', 'interpretation', 'human:utkarsh', 0, 't');
      INSERT INTO annotation_revision (id, annotation_id, rev, body_md, author, at) VALUES (1, 1, 1, 'b', 'human:utkarsh', 't');
      INSERT INTO saved_view (id, slug, name, state_json, state_version, state_hash, data_version, max_import_batch, run_ids_json,
        annotation_rev_cutoff, relationship_rev_cutoff, created_by, created_at)
        VALUES (1, 'v', 'V', '{}', 1, 'h', 0, 1, '[]', 1, 1, 'human:utkarsh', 't');
      INSERT INTO saved_view_portable (view_id, portable_json, created_at) VALUES (1, '{}', 't');
      INSERT INTO journal_applied (seq, op, applied_at, max_ids_json) VALUES (1, 'viewSave', 't', '{}');
      """)
    return c
  }

  /// (trigger, statement that must abort with the trigger's message)
  static let firing: [(trigger: String, sql: String, message: String)] = [
    ("rel_evidence_immutable", "UPDATE relationship SET method = 'other' WHERE id = 1", "relationship evidence fields are immutable"),
    ("rel_no_delete", "DELETE FROM relationship WHERE id = 1", "relationships are never deleted"),
    ("relrev_no_update", "UPDATE relationship_revision SET reason = 'x' WHERE id = 1", "relationship revisions are append-only"),
    ("relrev_no_delete", "DELETE FROM relationship_revision WHERE id = 1", "relationship revisions are append-only"),
    ("annrev_no_update", "UPDATE annotation_revision SET body_md = 'x' WHERE id = 1", "annotation revisions are append-only"),
    ("annrev_no_delete", "DELETE FROM annotation_revision WHERE id = 1", "annotation revisions are append-only"),
    ("view_immutable", "UPDATE saved_view SET state_json = '{\"v\":2}' WHERE id = 1", "saved views are immutable"),
    ("text_chunk_no_update", "UPDATE text_chunk SET z = X'62' WHERE document_id = 1", "text chunks are immutable"),
    ("journal_applied_no_update", "UPDATE journal_applied SET op = 'x' WHERE seq = 1", "journal_applied is append-only"),
    ("journal_applied_no_delete", "DELETE FROM journal_applied WHERE seq = 1", "journal_applied is append-only"),
    ("svp_no_update", "UPDATE saved_view_portable SET portable_json = '[]' WHERE view_id = 1", "saved views are immutable"),
    ("svp_no_delete", "DELETE FROM saved_view_portable WHERE view_id = 1", "saved views are immutable"),
  ]

  @Test("every trigger fires: append-only revisions, immutable evidence, views, chunks and journal bookkeeping")
  func everyTriggerFires() throws {
    let c = try Self.triggerAtlas()
    let all = try Fixtures.triggers(c)
    #expect(Set(all) == Set(Self.firing.map(\.trigger)), "triggers without a case: \(Set(all).subtracting(Self.firing.map(\.trigger)).sorted())")
    for (trigger, sql, message) in Self.firing {
      let e = #expect(throws: StoreError.self, "\(trigger)") { try c.exec(sql) }
      #expect(e?.isTriggerAbort == true && e?.message.hasPrefix(message) == true, "\(trigger): \(String(describing: e))")
    }
  }

  @Test("the allowed paths stay open: review status changes, soft-deleting a view, deleting a cancelled run's relationship")
  func allowedPaths() throws {
    let c = try Self.triggerAtlas()
    try c.exec("UPDATE relationship SET review_status = 'confirmed', current_rev = 2 WHERE id = 1")
    try c.exec("UPDATE saved_view SET deleted_at = 't2', name = 'renamed' WHERE id = 1")
    try c.exec("DELETE FROM relationship WHERE id = 2")  // run 2 was cancelled: its rows are garbage (gc-runs)
    #expect(try c.prepared(dynamic: "SELECT count(*) FROM relationship").first { $0.int(0) } == 1)
  }
}
