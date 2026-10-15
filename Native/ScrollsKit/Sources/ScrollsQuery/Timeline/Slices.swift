// OWNER: N3
// Shared reads of the timeline (query.mjs strandDocRows / countValue / fitsTier / laneGatesOf / pendingUnitClasses /
// provenanceOf / excludedCounts): per-document rows of a strand under the def's slice, the lane gates (§1.2, §4.6), the
// unit classes still indexing, the provenance block of every data response (§7), and the default exclusions counted
// (honesty rule 9).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One lane × document row of a strand (every chronology status).
public struct DocRow: Sendable, Equatable {
  public var lv: String?
  public var uc: String
  public var doc: Int64
  /// Counted matches (+ name-guard hits when nm = 1).
  public var v: Int
  public var names: Int
  public var passages: Int
  public var chronoStatus: String
  public var loDay: Int?
  public var hiDay: Int?
  public var yLo: Int?
  public var yHi: Int?
  public var precision: String
  public var basis: String
  public var dateLabel: String
  public var author: String?
  public var title: String?
  public var kind: String
  public var syn: Bool
  public var tr: Bool
}

/// The lane gates of a def.
public struct LaneGates: Sendable {
  let facet: String
  let byLane: [String: [CubeGateRow]]
  /// The strictest gate of each unit class among the lanes (`coverage_gate` of the rates gate).
  public let byUnit: [String: Int]
  let cellSampledKeys: Set<String>
  let endpointKeys: Set<String>

  /// The gate of a lane (cluster lanes share their unit class's slice).
  public func of(_ key: String, _ uc: String) -> Int {
    let k = facet == "cluster" ? "~\(uc)" : key
    return Rates.laneGate(uc, (byLane[k] ?? []).map { Rates.GateInput(unit: $0.unit, coverageGate: $0.coverageGate) })
  }
  /// A top-cited-per-cell lane (OpenAlex): counts, never a rate across calendar bins.
  public func cellSampled(_ key: String) -> Bool { cellSampledKeys.contains(key) }
  /// A lane that carries counts but never a rate (cell samples; relation endpoints on the Term trail).
  public func rateless(_ key: String) -> Bool { cellSampledKeys.contains(key) || endpointKeys.contains(key) }
}

/// Timeline reads shared by several endpoints.
public enum Slices {
  public static let tiers = ["L0", "L1", "L2", "L3", "L4", "L5"]

  /// `strandDocRows(db, def, strand, {where, params})`.
  public static func strandDocRows(_ c: Connection, _ def: QueryDef, _ strand: DefStrand, where extra: String = "1",
                                   params: [SQLValue] = []) throws -> [DocRow] {
    guard let part = SliceSQL.strandDocRows(def, strand, where: extra, params: params) else { return [] }
    return try SliceSQL.all(c, part) { r in
      DocRow(lv: r.textOrNil(0), uc: r.text(1), doc: r.int(2), v: Int(r.int(3)), names: Int(r.int(4)), passages: Int(r.int(5)),
             chronoStatus: r.text(6), loDay: r.intOrNil(7).map(Int.init), hiDay: r.intOrNil(8).map(Int.init),
             yLo: r.intOrNil(9).map(Int.init), yHi: r.intOrNil(10).map(Int.init), precision: r.text(11), basis: r.text(12),
             dateLabel: r.text(13), author: r.textOrNil(14), title: r.textOrNil(15), kind: r.text(16), syn: r.int(17) == 1,
             tr: r.int(18) == 1)
    }
  }

  /// `countValue(unitClass, rows)`: matches for text/abstracts, works with ≥ 1 match for titles and OpenAlex cells.
  public static func countValue(_ uc: String, _ rows: [DocRow]) -> Int {
    let works = uc == "titles" || uc == "cells"
    return rows.reduce(0) { $0 + (works ? ($1.v > 0 ? 1 : 0) : $1.v) }
  }

  /// `countValue` of one row.
  public static func countValue(_ uc: String, _ v: Int) -> Int { uc == "titles" || uc == "cells" ? (v > 0 ? 1 : 0) : v }

  /// `fitsTier(row, tier)`: L0–L3 by year, L4 month, L5 day.
  public static func fitsTier(yLo: Int?, yHi: Int?, loDay: Int?, hiDay: Int?, _ tier: String) -> Bool {
    let level = tiers.firstIndex(of: tier) ?? 2
    if level <= 3 {
      let w = [1000, 100, 10, 1][level]
      guard let yLo, let yHi else { return false }
      return DayMath.floorDiv(yLo, w) == DayMath.floorDiv(yHi, w)
    }
    guard let loDay, let hiDay else { return false }
    return (try? Bins.fitsDays(loDay, hiDay, level == 4 ? .month : .day)) ?? false
  }

  /// `laneGatesOf(db, def)`.
  public static func laneGates(_ c: Connection, _ def: QueryDef) throws -> LaneGates {
    var byLane: [String: [CubeGateRow]] = [:]
    var order: [String] = []
    for r in try CubeSlice.gateRows(c, def) {
      let key = def.lanes.facet == "cluster" ? "~\(r.uc)" : Lanes.key(def.lanes.facet, r.lv, r.uc)
      if byLane[key] == nil { order.append(key) }
      byLane[key, default: []].append(r)
    }
    var byUnit: [String: Int] = [:]
    for key in order {
      let list = byLane[key]!
      let uc = list[0].uc
      guard ["text", "titles", "abstracts"].contains(uc) else { continue }
      let g = Rates.laneGate(uc, list.map { Rates.GateInput(unit: $0.unit, coverageGate: $0.coverageGate) })
      byUnit[uc] = max(byUnit[uc] ?? 0, g)
    }
    return LaneGates(facet: def.lanes.facet, byLane: byLane, byUnit: byUnit,
                     cellSampledKeys: Set(byLane.filter { $0.value.contains { $0.sampling == "top_cited_per_cell" } }.keys),
                     endpointKeys: Set(byLane.filter { $0.value.contains { $0.sampling == "relation_endpoints" } }.keys))
  }

  /// `pendingUnitClasses(db, def)`: unit classes whose collections are still indexing.
  public static func pendingUnitClasses(_ c: Connection, _ def: QueryDef) throws -> Set<String> {
    let s = try c.prepared(TimelineSQL.pendingModalities)
    try s.bind([.text(SQLJSON.ints(def.corpusIds))])
    var out = Set(try s.all { $0.text(0) })
    if out.contains("abstracts") { out.insert("cells") }
    return out
  }

  /// `dataVersion(db)`.
  public static func dataVersion(_ c: Connection) throws -> Int { try Meta.dataVersion(c) }

  /// `provenanceOf(db, def)`: the provenance block of every data response.
  public static func provenance(_ c: Connection, corpus: String, corpusIds: [Int64], virtual: Bool, synthetic: Bool,
                                strands: [DefStrand], cluster: Int64? = nil, readsEndpoints: Bool = false) throws -> Provenance {
    let s = try c.prepared(readsEndpoints ? TimelineSQL.provenanceTrail : TimelineSQL.provenanceRate)
    try s.bind([.text(SQLJSON.ints(corpusIds))])
    let colls = try s.all { ($0.text(0), $0.textOrNil(1), $0.int(2) == 1) }
    var materialize = OrderedDict<String, Int64>()
    for st in strands where st.type == "expression" {
      for m in st.memberRuns { materialize[String(m.expr)] = m.run }
    }
    var runIds = JSONObject()
    if !materialize.isEmpty { runIds["materialize"] = .object(JSONObject(materialize.pairs.map { ($0.key, JSONValue.int($0.value)) })) }
    if let cluster { runIds["cluster"] = .int(cluster) }
    var licenses: [String] = []
    for (_, lic, _) in colls { if let lic, !lic.isEmpty, !licenses.contains(lic) { licenses.append(lic) } }
    var out = Provenance(dataVersion: try dataVersion(c), runIds: .object(runIds), synthetic: synthetic || colls.contains { $0.2 },
                         collections: colls.map(\.0), licenses: licenses)
    if virtual {
      out.corpus = corpus
      let k = try c.prepared(TimelineSQL.corporaSlugs)
      try k.bind([.text(SQLJSON.ints(corpusIds))])
      out.corpora = try k.all { $0.text(0) }
    }
    return out
  }

  /// `provenanceOf(db, def)` of a def.
  public static func provenance(_ c: Connection, _ def: QueryDef) throws -> Provenance {
    try provenance(c, corpus: def.corpus, corpusIds: def.corpusIds, virtual: def.virtual, synthetic: def.synthetic,
                   strands: def.strands, cluster: def.cluster?.run, readsEndpoints: def.readsEndpoints)
  }

  /// `excludedCounts(db, def)`: per strand key, each default exclusion counted under the first rule that removes it.
  public static func excludedCounts(_ c: Connection, _ def: QueryDef) throws -> JSONValue {
    var out = JSONObject()
    let corpora = Set(def.corpusIds)
    let endpointsCount = def.readsEndpoints
    for strand in def.strands where strand.type == "expression" && strand.run != nil {
      var e: [String: Int] = ["other_language": 0, "not_rate_eligible": 0, "describes": 0, "apparatus": 0, "translations": 0,
                              "duplicates": 0, "estimated": 0, "names": 0]
      var quality = OrderedDict<String, Int>()
      func listOK(_ key: String, _ value: String?) -> Bool {
        let (inc, exc) = SliceSQL.includeExclude(def.f[listKey: key])
        return (inc.isEmpty || (value.map { inc.contains($0) } ?? false)) && !(value.map { exc.contains($0) } ?? false)
      }
      let members = strand.members ?? [StrandMember(corpusId: def.corpusId, corpus: def.corpus, ref: strand.exprId, run: strand.run,
                                                    langs: strand.langs, sampled: strand.sampled, accentInsensitive: false)]
      for m in members {
        guard let ref = m.ref, let run = m.run else { continue }
        let langs = strand.langsByCorpus != nil ? m.langs : strand.langs
        let s = try c.prepared(TimelineSQL.excludedRows)
        try s.bind([.int(ref), .int(run)])
        while let r = try s.step() {
          let plang = r.text(0), fc = r.text(1), n = Int(r.int(2)), nNames = Int(r.int(3))
          let isTranslation = r.int(4) == 1, dupOf = r.intOrNil(5), basis = r.text(6), deletedAt = r.textOrNil(7)
          let batch = r.intOrNil(8), syn = r.int(9) == 1, rateEligible = r.int(10) == 1, sampling = r.textOrNil(11)
          let corpusId = r.int(12), kind = r.textOrNil(13), slug = r.textOrNil(14), culture = r.textOrNil(15)
          let field = r.textOrNil(16), community = r.textOrNil(17), langText = r.textOrNil(18)
          let gone = deletedAt != nil && !(def.cutoffs?.at.map { deletedAt! > $0 } ?? false)
          if gone || !corpora.contains(corpusId) || (def.f.syn == 0 && syn) { continue }
          if let cut = def.cutoffs?.importBatch, let batch, batch > cut { continue }
          if !listOK("kind", kind) || !listOK("coll", slug) || !listOK("culture", culture) || !listOK("field", field)
            || !listOK("community", community) || !listOK("basis", basis) || !listOK("lang", plang)
          { continue }
          var bucket: String?
          if !LangGate.admits(langs, plang: plang, fieldClass: fc, docLang: langText) { bucket = "other_language" }
          else if !rateEligible && !(endpointsCount && sampling == "relation_endpoints") { bucket = "not_rate_eligible" }
          else if fc == "describes" && def.toggle("ds") == 0 { bucket = "describes" }
          else if fc == "apparatus" && def.toggle("ap") == 0 { bucket = "apparatus" }
          else if isTranslation && def.toggle("tr") == 0 { bucket = "translations" }
          else if dupOf != nil && def.toggle("dup") == 0 { bucket = "duplicates" }
          else if basis == "estimated" && def.toggle("est") == 0 { bucket = "estimated" }
          if let bucket { e[bucket]! += n + nNames } else if def.toggle("nm") == 0 { e["names"]! += nNames }
        }
        let mj = try c.prepared(MatchSQL.runMetrics).bindingFirst([.int(run)]) { $0.textOrNil(0) } ?? nil
        if let q = mj.flatMap({ try? JSONValue.parse($0) })?["excluded_quality"]?.objectValue {
          for k in q.keys.sorted(by: CanonicalJSON.codeUnitLess) { quality[k] = (quality[k] ?? 0) + (q[k]?.safeInteger ?? 0) }
        }
      }
      var o = JSONObject(e.map { ($0.key, JSONValue.int($0.value)) })
      o["passage_quality"] = .object(JSONObject(quality.pairs.map { ($0.key, JSONValue.int($0.value)) }))
      out[strand.key] = .object(o)
    }
    return .object(out)
  }

  /// A JSON object of `L0…L5` counts.
  static func tierCounts(_ d: [String: Int]) -> [String: Int] {
    var out: [String: Int] = [:]
    for t in tiers { out[t] = d[t] ?? 0 }
    return out
  }
}
