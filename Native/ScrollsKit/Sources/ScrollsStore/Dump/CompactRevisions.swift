// OWNER: N0
// Compact create revisions (IOS-SPEC §3.2, DP-6): the rev-1 'create' row of an adapter or algorithm relationship keeps
// its id, rev and `at`, and stores `after_json = '{"$row":1}'`; the full JSON is rebuilt from the relationship row,
// whose evidence fields are immutable by trigger. The reference writes two shapes, and the expansion reproduces each:
//   • `relationship.created_by` 'run:<id>' — lineage/classify.mjs writeCreateRevisions: SQLite json_object(…) over
//     the row, re-run here with the identical expression so its number rendering is SQLite's own;
//   • any other creator — store/document-writer.mjs: canonicalJson({rel_type, src, dst, evidence_status, origin,
//     source_dataset, source_locator, method, run_id, score}).
// A writer compacts only through `compacted(afterJSON:relationship:on:)`, which keeps the full text unless the
// expansion is equal to it in canonical form — so compaction is lossless by construction, and LogicalDump (which
// compares the expanded form) proves it on every G2 run. Human relationships keep their full revisions.

import Foundation
import ScrollsCore

/// Expansion and lossless compaction of create revisions.
public enum CompactRevisions: SQLCatalog {
  /// The stored marker of a compact create revision.
  public static let marker = #"{"$row":1}"#

  static let classifyForm = SQL("store.revisions.classify", """
    SELECT json_object('rel_type', r.rel_type, 'src', r.src_type || ':' || r.src_ref, 'dst', r.dst_type || ':' || r.dst_ref,
        'evidence_status', r.evidence_status, 'origin', r.origin, 'method', r.method, 'run_id', r.run_id,
        'score', CASE WHEN r.score IS NULL THEN NULL ELSE json_object('value', r.score, 'kind', r.score_kind) END)
    FROM relationship r WHERE r.id = ?
    """)
  static let row = SQL("store.revisions.row", """
    SELECT rel_type, src_type, src_ref, dst_type, dst_ref, evidence_status, origin, source_dataset, source_locator,
      method, run_id, score, score_kind, created_by FROM relationship WHERE id = ?
    """)

  /// The expansion statements (`SQLCatalogTests` explain them like every catalogue).
  public static let all: [SQL] = [classifyForm, row]

  /// The full `after_json` (as JSON text) of the create revision of relationship `id`.
  public static func expand(relationship id: Int64, on c: Connection) throws -> String {
    let r = try c.prepared(row).bindingFirst([.int(id)]) { r in
      (relType: r.text(0), src: r.text(1) + ":" + r.text(2), dst: r.text(3) + ":" + r.text(4), status: r.text(5),
       origin: r.text(6), dataset: r.textOrNil(7), locator: r.textOrNil(8), method: r.textOrNil(9), run: r.intOrNil(10),
       score: r.doubleOrNil(11), scoreKind: r.textOrNil(12), createdBy: r.text(13))
    }
    guard let r else { throw StoreError.misuse("no relationship \(id) to expand a compact revision from") }
    if r.createdBy.hasPrefix("run:") {
      return try c.prepared(classifyForm).bindingFirst([.int(id)]) { $0.text(0) } ?? "{}"
    }
    let score: JSONValue = r.score.map { .object(["value": .number($0), "kind": r.scoreKind.map(JSONValue.string) ?? .null]) } ?? .null
    let o: JSONObject = [
      "rel_type": .string(r.relType), "src": .string(r.src), "dst": .string(r.dst), "evidence_status": .string(r.status),
      "origin": .string(r.origin), "source_dataset": r.dataset.map(JSONValue.string) ?? .null,
      "source_locator": r.locator.map(JSONValue.string) ?? .null, "method": r.method.map(JSONValue.string) ?? .null,
      "run_id": r.run.map { .number(Double($0)) } ?? .null, "score": score,
    ]
    return CanonicalJSON.string(.object(o))
  }

  /// `after_json` as stored → its full JSON value (a compact row is expanded first).
  public static func expanded(_ stored: String, relationship id: Int64, on c: Connection) throws -> JSONValue {
    try JSONValue.parse(stored == marker ? try expand(relationship: id, on: c) : stored)
  }

  /// What a writer stores for the create revision of relationship `id` (already inserted): the marker when the
  /// expansion reproduces `afterJSON` exactly (canonical form), else `afterJSON` itself.
  public static func compacted(afterJSON: String, relationship id: Int64, on c: Connection) throws -> String {
    guard let original = try? JSONValue.parse(afterJSON) else { return afterJSON }
    let rebuilt = try JSONValue.parse(try expand(relationship: id, on: c))
    return CanonicalJSON.string(rebuilt) == CanonicalJSON.string(original) ? marker : afterJSON
  }
}
