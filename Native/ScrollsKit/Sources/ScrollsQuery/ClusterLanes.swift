// OWNER: N3
// Port of server/aggregate/clusterlanes.mjs (contract 1.3.0, C1): lanes = context groups of one expression (SPEC §1.3
// `cluster`, §4.8). With a succeeded clustering run of the pinned expression, every non-residual group is a lane
// `cluster:<run>:<ord>` and everything else the strand counts is the lane `cluster:<run>:residual`, so the lanes
// partition the strand's counted occurrences and the conservation law holds per lane. Groups are computed hypotheses over
// context words; their labels are machine labels with any human rename beside them. Without a run the lanes are empty with
// lane_state 'not_run' and the run to start; a gated run answers 'gated' with its gate (never a group, §13 rule 7).

import ScrollsCore
import ScrollsStore

/// `def.cluster`: the clustering run behind cluster lanes and the lane state.
public struct ClusterScope: Sendable, Equatable {
  public struct Group: Sendable, Equatable {
    public var id: Int64
    public var ord: Int
    public var status: String
  }
  public var state: String
  public var run: Int64?
  public var materialize: Int64?
  public var groups: [Group]
  public var residual: [Int64]
  public var note: String?
  public var suggestion: JSONValue?
  public var gate: JSONValue?
  public var pinned: Bool?
  public var sameCounts: Bool?

  /// The JSON form inside a def (key order of the reference's object; canonical JSON sorts it).
  public var json: JSONValue {
    var o: JSONObject = ["state": .string(state), "run": .int(run), "groups": .array(groups.map {
      .object(["id": .int($0.id), "ord": .int($0.ord), "status": .string($0.status)])
    }), "residual": .array(residual.map { .int($0) }), "note": .str(note)]
    if state != "unavailable" { o["materialize"] = .int(materialize) }
    if let suggestion { o["suggestion"] = suggestion } else { o["suggestion"] = .null }
    if let gate { o["gate"] = gate }
    if let pinned { o["pinned"] = .bool(pinned) }
    if let sameCounts { o["sameCounts"] = .bool(sameCounts) }
    return .object(o)
  }
}

/// A context-group lane of a run.
public struct GroupLane: Sendable, Equatable {
  public var value: String
  public var clusterId: Int64?
  public var ord: Int?
  public var machine: String
  public var human: String?
  public var text: String
  public var status: String
  public var tentative: Bool
  public var stability: Double?
  public var size: Int?
}

/// Context-group lanes.
public enum ClusterLanes {
  public static let machineLabelPrefix = "machine label: "

  public static func groupValue(_ run: Int64, _ ord: Int) -> String { "\(run):\(ord)" }
  public static func residualValue(_ run: Int64) -> String { "\(run):residual" }

  /// `resolveClusterRun(db, strand, pinned)`.
  public static func resolve(_ c: Connection, exprId: Int64, strandRun: Int64?, pinned: Int64?) throws -> ClusterScope {
    let runRow: (id: Int64, params: String, gate: String)?
    if let pinned {
      runRow = try c.prepared(ClusterSQL.pinnedRun).bindingFirst([.int(pinned), .int(exprId)]) { ($0.int(0), $0.text(1), $0.text(2)) }
    } else {
      runRow = try c.prepared(ClusterSQL.latestRun).bindingFirst([.int(exprId)]) { ($0.int(0), $0.text(1), $0.text(2)) }
    }
    let suggestion: JSONValue = .object(["run": .object(["stage": "cluster", "params": .object(["expressionId": .int(exprId)])])])
    guard let run = runRow else {
      return ClusterScope(state: "not_run", run: nil, materialize: nil, groups: [], residual: [],
                          note: pinned.map { "Run \($0) is not a succeeded clustering run of this expression." }
                            ?? "No clustering run exists for this expression yet.",
                          suggestion: suggestion, gate: nil, pinned: pinned != nil, sameCounts: nil)
    }
    let params = (try? JSONValue.parse(run.params))?.objectValue ?? JSONObject()
    let gate = (try? JSONValue.parse(run.gate))?["cluster"]?.objectValue ?? ["gate": "ok"]
    if gate["gate"]?.stringValue != "ok" {
      return ClusterScope(state: "gated", run: run.id, materialize: nil, groups: [], residual: [],
                          note: gate["note"]?.stringValue, suggestion: nil,
                          gate: .object(["gate": gate["gate"] ?? .null, "value": .null, "needed": gate["needed"] ?? .null,
                                         "have": gate["have"] ?? .null, "suggestion": gate["suggestion"] ?? .null]),
                          pinned: pinned != nil, sameCounts: nil)
    }
    let materialize = params["materialize"]?.safeInteger.map(Int64.init)
    var sameCounts = false
    if pinned == nil, let materialize, let strandRun, materialize != strandRun {
      if !(try sameCount(c, exprId, materialize, strandRun)) {
        return ClusterScope(state: "not_run", run: run.id, materialize: nil, groups: [], residual: [],
                            note: "Clustering run #\(run.id) grouped an earlier count of this expression (materialization #\(materialize)); run it again.",
                            suggestion: suggestion, gate: nil, pinned: false, sameCounts: nil)
      }
      sameCounts = true
    }
    let s = try c.prepared(ClusterSQL.clusters)
    try s.bind([.int(run.id)])
    let clusters = try s.all { ($0.int(0), Int($0.int(1)), $0.text(2)) }
    return ClusterScope(state: "ok", run: run.id, materialize: materialize,
                        groups: clusters.filter { $0.2 != "residual" }.map { ClusterScope.Group(id: $0.0, ord: $0.1, status: $0.2) },
                        residual: clusters.filter { $0.2 == "residual" }.map(\.0), note: nil, suggestion: nil, gate: nil,
                        pinned: pinned != nil, sameCounts: sameCounts)
  }

  /// `sameCount(db, exprId, a, b)`: whether two materializations counted exactly the same per-document rows.
  public static func sameCount(_ c: Connection, _ exprId: Int64, _ a: Int64, _ b: Int64) throws -> Bool {
    func rows(_ run: Int64) throws -> [String] {
      let s = try c.prepared(ClusterSQL.exprDocRows)
      try s.bind([.int(exprId), .int(run)])
      return try s.all { "\($0.int(0))|\($0.text(1))|\($0.text(2))|\($0.int(3))|\($0.int(4))|\($0.int(5))" }
    }
    return try rows(a) == rows(b)
  }

  /// `groupCaseSql(cl, idCol)`: an occurrence's lane value from its membership (NULL → residual).
  public static func groupCaseSQL(_ cl: ClusterScope, _ idCol: String) -> String {
    let run = cl.run ?? 0
    let whens = cl.groups.map { "WHEN \($0.id) THEN '\(groupValue(run, $0.ord))'" }.joined(separator: " ")
    return "(CASE \(whens.isEmpty ? "" : "\(idCol) \(whens) ")ELSE '\(residualValue(run))' END)"
  }

  /// `memberJoinSql(cl)`: the join attaching a run's membership to occurrence alias `o` (alias `m`).
  public static func memberJoinSQL(_ cl: ClusterScope) -> String {
    let ids = cl.groups.map(\.id) + cl.residual
    return "LEFT JOIN cluster_member m ON m.occurrence_id = o.id AND m.cluster_id IN (\(ids.isEmpty ? "NULL" : ids.map(String.init).joined(separator: ", ")))"
  }

  /// `humanLabels(db, clusterIds, {revCutoff})` (analysis/labels.mjs): the newest human rename of each group.
  public static func humanLabels(_ c: Connection, _ clusterIds: [Int64], revCutoff: Int64?) throws -> [Int64: String] {
    var out: [Int64: String] = [:]
    if clusterIds.isEmpty { return out }
    let s = try c.prepared(ClusterSQL.humanLabels)
    try s.bind([.text(SQLJSON.ints(clusterIds)), .integer(revCutoff), .integer(revCutoff)])
    for r in try s.all({ ($0.text(0), $0.text(1)) }) {
      let label = JSString.trim(r.1)
      if label.isEmpty { continue }
      if let id = Int64(r.0) { out[id] = label }
    }
    return out
  }

  /// `groupLanes(db, cl, {revCutoff})`: one per group in `ord` order, then the residual lane.
  public static func groupLanes(_ c: Connection, _ cl: ClusterScope, revCutoff: Int64?) throws -> [GroupLane] {
    let run = cl.run ?? 0
    let s = try c.prepared(ClusterSQL.groupRows)
    try s.bind([.int(run)])
    let rows = try s.all { r in
      (id: r.int(0), ord: Int(r.int(1)), label: r.text(2), size: Int(r.int(3)), stability: r.doubleOrNil(5), status: r.text(6))
    }
    let human = try humanLabels(c, rows.map(\.id), revCutoff: revCutoff)
    func strip(_ l: String) -> String { JSString.hasPrefix(l, machineLabelPrefix) ? JSText.slice(l, machineLabelPrefix.utf16.count) : l }
    var out = rows.filter { $0.status != "residual" }.map { r in
      GroupLane(value: groupValue(run, r.ord), clusterId: r.id, ord: r.ord, machine: r.label, human: human[r.id],
                text: "Context group \(r.ord): \(strip(r.label))\(human[r.id].map { " (\u{201C}\($0)\u{201D})" } ?? "")",
                status: r.status, tentative: r.status == "unstable", stability: r.stability, size: r.size)
    }
    let residualSize = rows.filter { $0.status == "residual" }.reduce(0) { $0 + $1.size }
    out.append(GroupLane(value: residualValue(run), clusterId: nil, ord: nil, machine: "other contexts", human: nil,
                         text: "Other contexts (residual groups and occurrences the run did not group)", status: "residual",
                         tentative: false, stability: nil, size: residualSize))
    return out
  }
}

/// Statements of context-group lanes.
public enum ClusterSQL: SQLCatalog {
  static let pinnedRun = SQL("q.cluster.pinned-run", """
    SELECT id, params_json, gate_json FROM analysis_run WHERE id = ? AND stage = 'cluster' AND status = 'succeeded'
      AND json_extract(scope_json, '$.expression') = ?
    """)
  static let latestRun = SQL("q.cluster.latest-run", """
    SELECT id, params_json, gate_json FROM analysis_run WHERE stage = 'cluster' AND status = 'succeeded'
      AND json_extract(scope_json, '$.expression') = ? ORDER BY id DESC LIMIT 1
    """)
  static let clusters = SQL("q.cluster.clusters", "SELECT id, ord, status FROM sense_cluster WHERE run_id = ? ORDER BY ord",
    scan: .scanOK(reason: "sense_cluster is small (groups of runs)"))
  static let groupRows = SQL("q.cluster.group-rows",
    "SELECT id, ord, label_auto, size, n_docs, stability, status FROM sense_cluster WHERE run_id = ? ORDER BY ord",
    scan: .scanOK(reason: "sense_cluster is small (groups of runs)"))
  static let exprDocRows = SQL("q.cluster.exprdoc-rows", """
    SELECT document_id, plang, field_class, n, n_names, n_passages FROM expr_doc
      WHERE expression_id = ? AND run_id = ? ORDER BY document_id, plang, field_class
    """)
  static let humanLabels = SQL("q.cluster.human-labels", """
    SELECT a.target_ref, r.body_md FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id
      WHERE a.target_type = 'cluster' AND a.kind = 'label' AND a.status = 'active'
        AND a.target_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND r.rev = (SELECT MAX(r2.rev) FROM annotation_revision r2 WHERE r2.annotation_id = a.id AND (? IS NULL OR r2.id <= ?))
      ORDER BY a.id
    """)

  public static let all: [SQL] = [pinnedRun, latestRun, clusters, groupRows, exprDocRows, humanLabels]
}
