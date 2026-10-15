// OWNER: N5
// Port of server/lineage/classify.mjs (SPEC §4.7 table): from verified reuse candidates to relationships, and the
// writer for algorithm-made links. Every row written here has origin 'algorithm', a run id and a method; none is ever
// 'documented' (the §3 CHECKs refuse it anyway):
//
//  | situation                                          | rel_type                         | direction  | status                  |
//  | both dated and A.hi_day < B.lo_day                 | exact_quotation / near_quotation | B → A      | computed                |
//  | intervals overlap, or either undated               | shared_wording                   | undirected | computed                |
//  | an attribution cue in B names A's author (title)   | explicit_citation                | B → A      | proposed + citation_cue |
//
// The 'create' revision of a run's rows is written when the run succeeds (`writeCreateRevisions`), so the rows of a
// cancelled or failed run carry no revision and gc-runs can remove them. Ids come from the row-id allocator (the local
// range on the device, IOS-SPEC §3.3; max + 1 on a reference database, as SQLite's own rowids), and on the device
// profile the create revision is stored compact (`CompactRevisions.marker`, DV-12).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum Classify {
  /// Methods recorded on computed rows.
  public enum Methods {
    public static let exact = "winnow k=8 w=6 + seed-extend"
    public static let near = "minhash 128 / LSH 32×4 + Smith–Waterman (2/−1/−1)"
    public static let traceExact = "targeted trace: FTS phrase windows + seed-extend"
    public static let traceNear = "targeted trace: FTS 3-shingle candidates + Smith–Waterman (2/−1/−1)"
    public static let traceNearLsh = "targeted trace: LSH 32×4 lookup + Smith–Waterman (2/−1/−1)"
  }

  /// One side of a candidate: a passage and its document's dates.
  struct Side {
    var passage: Int64
    var doc: TraceQuery.Doc
  }

  struct Classified {
    var relType: String
    var src: Side
    var dst: Side
    var directed: Int64
    var score: (value: Double, kind: String)
  }

  static func dated(_ d: TraceQuery.Doc) -> Bool { d.loDay != nil && d.chronoStatus == "dated" }

  /// `classifyCandidate({a, b, kind, score})`: src is the later/dependent side.
  static func classify(a: Side, b: Side, exact: Bool, score: Double?) -> Classified {
    let s: (value: Double, kind: String) = exact ? (1, "match_ratio") : (TraceQuery.round3(score ?? 0), "alignment_score")
    if dated(a.doc) && dated(b.doc) {
      if let ah = a.doc.hiDay, let bl = b.doc.loDay, ah < bl {
        return Classified(relType: exact ? "exact_quotation" : "near_quotation", src: b, dst: a, directed: 1, score: s)
      }
      if let bh = b.doc.hiDay, let al = a.doc.loDay, bh < al {
        return Classified(relType: exact ? "exact_quotation" : "near_quotation", src: a, dst: b, directed: 1, score: s)
      }
    }
    // overlapping or missing dates: shared wording, direction unknown (canonical order: higher passage id first)
    let (src, dst) = a.passage > b.passage ? (a, b) : (b, a)
    return Classified(relType: "shared_wording", src: src, dst: dst, directed: 0, score: s)
  }

  /// `dateConflict(relType, srcDoc, dstDoc)`: the stated order is impossible by the dates.
  static func dateConflict(_ relType: String, _ src: TraceQuery.Doc, _ dst: TraceQuery.Doc) -> Int64 {
    guard (Vocab.relTypeByCode[relType]?.requiresPrecedence ?? 0) != 0, let sh = src.yHi, let dl = dst.yLo else { return 0 }
    return sh < dl ? 1 : 0
  }

  /// An evidence span to store with a link.
  struct Evidence {
    var role: String
    var passage: Int64?
    var docId: Int64
    var field: String
    var start: Int
    var end: Int
    var text: [UInt16]
    var sha: String?
    /// `JSON.stringify(detail)` in the reference's key order, or nil.
    var detail: String?
  }

  /// `insertAlgorithmRelationship(db, rel)`: one algorithm-made relationship with its anchored evidence spans; no
  /// revision yet. Returns the relationship id.
  static func insert(_ tx: WriteTx, relType: String, status: String, src: Side, dst: Side, directed: Int64,
                     score: (value: Double, kind: String)?, method: String, runId: Int64, groupId: Int64? = nil,
                     evidence: [Evidence], at: String) throws -> Int64 {
    let c = tx.connection
    let synthetic: Int64 = src.doc.isSynthetic != 0 || dst.doc.isSynthetic != 0 ? 1 : 0
    let id = try tx.ids.next("relationship", .local)
    let insRel = try c.prepared(LineageSQL.insertAlgorithmRelationship)
    try insRel.bind([
      .int(id), .text(relType), .text(String(src.passage)), .text(String(dst.passage)), .int(directed), .text(status),
      .text(method), .int(runId), .text("run:\(runId)"), score.map { .double($0.value) } ?? .null,
      score.map { .text($0.kind) } ?? .null, .int(dateConflict(relType, src.doc, dst.doc)),
      src.doc.yLo.map { .int($0) } ?? .null, dst.doc.yLo.map { .int($0) } ?? .null, groupId.map { .int($0) } ?? .null,
      .int(synthetic), .text(at),
    ])
    try insRel.run()
    let ins = try c.prepared(LineageSQL.insertEvidence)
    for ev in evidence {
      let anchor = try LineageRefs.makeAnchor(ev.text, field: ev.field, start: ev.start, end: ev.end, docId: ev.docId, sha: ev.sha)
      try ins.bind([.int(try tx.ids.next("relationship_evidence", .local)), .int(id), ev.passage.map { .int($0) } ?? .null,
                    .text(ev.role), .int(Int64(ev.start)), .int(Int64(ev.end)), .text(anchor), ev.detail.map { .text($0) } ?? .null,
                    .text("run:\(runId)"), .text(at)])
      try ins.run()
    }
    return id
  }

  /// `writeCreateRevisions(db, runId)`: the 'create' revision of every row of a run that has none yet (compact on the
  /// device profile). Returns the revisions written.
  @discardableResult
  static func writeCreateRevisions(_ tx: WriteTx, runId: Int64, at: String) throws -> Int {
    let c = tx.connection
    let rows = try c.prepared(LineageSQL.runRowsWithoutRevision).binding([.int(runId)]) { ($0.int(0), $0.text(1), $0.text(2)) }
    let ins = try c.prepared(LineageSQL.insertCreateRevision)
    for (id, createdBy, after) in rows {
      let stored = c.profile == .device ? try CompactRevisions.compacted(afterJSON: after, relationship: id, on: c) : after
      try ins.bind([.int(try tx.ids.nextLog("relationship_revision")), .int(id), .text(createdBy), .text(at), .text(stored)])
      try ins.run()
    }
    return rows.count
  }

  /// A hypothesis group "Which text does … refer to?" or "Source of …?" made by a run.
  static func insertGroup(_ tx: WriteTx, target passage: Int64, question: String, runId: Int64, synthetic: Int64, at: String) throws -> Int64 {
    let gid = try tx.ids.next("hypothesis_group", .local)
    let ins = try tx.connection.prepared(LineageSQL.insertHypothesisGroup)
    try ins.bind([.int(gid), .text(String(passage)), .text(question), .text("run:\(runId)"), .int(synthetic), .text(at)])
    try ins.run()
    return gid
  }

  static func setGroup(_ tx: WriteTx, _ rel: Int64, _ group: Int64) throws {
    let s = try tx.connection.prepared(LineageSQL.setGroup)
    try s.bind(.int(group), .int(rel))
    try s.run()
  }
}
