// OWNER: N5
// Port of graph.mjs `edgeFilters`, `edgeWhere`, `asOfRows` and `edgeJson` (SPEC §2.C, §7.2), shared by the lineage
// graph, the chain of custody and the genealogy. Filters: relationship types, evidence statuses, pinned runs (rows of
// an analysis run are visible only when it succeeded or a saved view pins it), the saved view's relationship revision
// cutoff (as saved: the links that existed then, with the review status they had then), rejected links (hidden unless
// asked for) and the similarity pairs kindred/counterpart (hidden unless asked for or named in `types`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Parsed filters (`edgeFilters(args)`).
public struct EdgeFilters: Sendable, Equatable {
  public var types: [String]
  public var status: [String]
  public var runs: [Int64]
  public var relRevCutoff: Int64?
  public var rejected: Bool
  public var kindred: Bool

  /// Similarity pairs hidden from lineage by default (SPEC Appendix A: neither is transmission).
  public static let hiddenTypes = ["kindred", "counterpart"]

  /// `edgeFilters(args)`: E_VALIDATION for an unknown type or status, or a bad cutoff.
  public init(_ args: QueryArgs) throws {
    types = LineageJS.list(args["types"])
    for t in types where Vocab.relTypeByCode[t] == nil {
      throw ScrollsError.lineageInvalid("Unknown relationship type '\(t)'.", field: "types")
    }
    status = LineageJS.list(args["status"])
    for s in status where !JSString.includes(Vocab.evidenceStatus, s) {
      throw ScrollsError.lineageInvalid("Unknown evidence status '\(s)'.", field: "status")
    }
    runs = LineageJS.list(args["runs"]).map(JSNumber.parse).filter { JSNumber.isSafeInteger($0) && $0 > 0 }.map { Int64($0) }
    relRevCutoff = nil
    if let raw = args["rel_rev_cutoff"], !raw.isEmpty {
      let n = JSNumber.parse(raw)
      guard JSNumber.isSafeInteger(n), n >= 0 else {
        throw ScrollsError.lineageInvalid("rel_rev_cutoff must be a non-negative integer.", field: "rel_rev_cutoff")
      }
      relRevCutoff = Int64(n)
    }
    rejected = args["rejected"] == "1" || args["rejected"] == "true"
    kindred = args["kindred"] == "1" || args["kindred"] == "true" || types.contains { JSString.includes(Self.hiddenTypes, $0) }
  }

  /// `edgeWhere(f)`'s parameters ?3…?8 (see GraphSQL.swift).
  var params: [SQLValue] {
    [.text(LineageJS.jsonList(runs)),
     types.isEmpty ? .null : .text(LineageJS.jsonList(types)),
     status.isEmpty ? .null : .text(LineageJS.jsonList(status)),
     relRevCutoff.map { .int($0) } ?? .null,
     .int(rejected ? 1 : 0),
     .int(kindred ? 1 : 0)]
  }

  /// The `filters` member of a response for these filters.
  var typesJSON: JSONValue { .array(types.map(JSONValue.string)) }
  var statusJSON: JSONValue { .array(status.map(JSONValue.string)) }
}

/// A relationship row as the lineage readers select it (`LineageSQL.edgeColumns` + cue).
struct EdgeRow: Sendable {
  var id: Int64
  var relType: String
  var srcType: String
  var srcRef: String
  var dstType: String
  var dstRef: String
  var directed: Int64
  var evidenceStatus: String
  var origin: String
  var sourceDataset: String?
  var sourceLocator: String?
  var provenanceQuality: String
  var method: String?
  var runId: Int64?
  var createdBy: String
  var reviewStatus: String
  var score: Double?
  var scoreKind: String?
  var dateConflict: Int64
  var srcYear: Int64?
  var dstYear: Int64?
  var hypothesisGroupId: Int64?
  var isSynthetic: Int64
  var cue: Bool

  var src: String { "\(srcType):\(srcRef)" }
  var dst: String { "\(dstType):\(dstRef)" }

  init(_ r: Row) {
    id = r.int(0)
    relType = r.text(1)
    srcType = r.text(2)
    srcRef = r.text(3)
    dstType = r.text(4)
    dstRef = r.text(5)
    directed = r.int(6)
    evidenceStatus = r.text(7)
    origin = r.text(8)
    sourceDataset = r.textOrNil(9)
    sourceLocator = r.textOrNil(10)
    provenanceQuality = r.text(11)
    method = r.textOrNil(12)
    runId = r.intOrNil(13)
    createdBy = r.text(14)
    reviewStatus = r.text(15)
    score = r.doubleOrNil(16)
    scoreKind = r.textOrNil(17)
    dateConflict = r.int(18)
    srcYear = r.intOrNil(19)
    dstYear = r.intOrNil(20)
    hypothesisGroupId = r.intOrNil(21)
    isSynthetic = r.int(22)
    cue = r.int(23) != 0
  }
}

enum Edges {
  /// The rows of `sql` (edgesFrom, edgesTo, undirectedTo, groupMembers) for one endpoint (or group id) under `f`.
  static func rows(_ c: Connection, _ sql: SQL, _ a: SQLValue, _ b: SQLValue, _ f: EdgeFilters) throws -> [EdgeRow] {
    let s = try c.prepared(sql)
    try s.bind([a, b] + f.params)
    return try s.all(EdgeRow.init)
  }

  /// `asOfRows(db, f, rows)`: with a cutoff, each link's review status as of the cutoff, and rejected-then links
  /// dropped unless asked for. Without a cutoff, as is.
  static func asOf(_ c: Connection, _ f: EdgeFilters, _ rows: [EdgeRow]) throws -> [EdgeRow] {
    guard let cutoff = f.relRevCutoff else { return rows }
    let s = try c.prepared(LineageSQL.revisionsUpTo)
    return try rows.map { r -> EdgeRow in
      var r = r
      try s.bind(.int(r.id), .int(cutoff))
      r.reviewStatus = LineageRefs.reviewStatus(try s.all { ($0.text(0), $0.text(1)) }.map { (actor: $0.0, action: $0.1) })
      return r
    }.filter { f.rejected || $0.reviewStatus != "rejected" }
  }

  /// `edgeJson(r)`: the JSON form of a relationship row as an edge (lineage, path).
  static func json(_ r: EdgeRow) -> JSONObject {
    let t = Vocab.relTypeByCode[r.relType]
    var out: JSONObject = [
      "rel_id": .number(Double(r.id)),
      "src": .string(r.src),
      "dst": .string(r.dst),
      "rel_type": .string(r.relType),
      "family": .string(t?.family ?? "similarity"),
      "glyph": t.map { .string($0.glyph) } ?? .null,
      "label": .string(t?.label ?? r.relType),
      "directed": .bool(r.directed == 1),
      "evidence_status": .string(r.evidenceStatus),
      "provenance_quality": .string(r.provenanceQuality),
      "review_status": .string(r.reviewStatus),
      "origin": .string(r.origin),
      "score": r.score.map { ["value": .number($0), "kind": r.scoreKind.map(JSONValue.string) ?? .null] } ?? .null,
      "method": r.method.map(JSONValue.string) ?? .null,
      "run_id": r.runId.map { .number(Double($0)) } ?? .null,
      "hypothesis_group": r.hypothesisGroupId.map { .number(Double($0)) } ?? .null,
      "date_conflict": .bool(r.dateConflict == 1),
      "source_dataset": r.sourceDataset.map(JSONValue.string) ?? .null,
      "locator": r.sourceLocator.map(JSONValue.string) ?? .null,
      "created_by": .string(r.createdBy),
      // a later item changing how an earlier one is read: feedback-capable types only, never computed similarity
      "feedback": .bool((t?.feedbackCapable ?? 0) != 0 && r.evidenceStatus != "computed" && r.dateConflict != 1),
      "synthetic": .bool(r.isSynthetic == 1),
    ]
    if r.cue { out["cue"] = true }
    return out
  }
}
