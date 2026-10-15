// OWNER: N6
// D17 across generations (IOS-SPEC §6.4): the cutoffs a saved view is opened with. In the generation where the view was
// saved, the `saved_view` numbers are used exactly as in the reference. In any other generation every numeric cutoff is
// recomputed from the journal: for each cutoff table T, cutoff′(T) = the largest `journal_applied.max_ids_json[T]` of
// the acts before the view's own act (seq < journalSeq), together with `meta.base_max_ids[T]` (the starter). Every
// generation replays the same journal in seq order and only journaled acts create rows in these tables, so the rows
// "before the view" are a prefix of each table's id order and `id <= cutoff′` selects exactly them. Pinned runs are found
// by RunKey; strand, selection and run ids in the stored state are remapped through the portable keys. Nothing is
// silently re-pinned, and "as saved unavailable" is never shown: a pinned run that is not here yet is named.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// How a view's cutoffs were resolved in this generation.
public struct PortableResolution: Sendable, Equatable {
  public var cutoffs: ViewCutoffs
  /// The view was saved in this generation (the stored numbers are used as they are).
  public var sameGeneration: Bool
  /// The portable cutoffs stored with the view (nil for a view saved where there is no journal, e.g. the reference).
  public var portable: PortableCutoffs?
  /// "Saved on generation …; opened on generation …: ids remapped, counts as saved" (nil in the same generation).
  public var banner: String?
  /// Pinned runs not found in this generation ("pinned analysis being restored (run #14)").
  public var restoring: [String]
}

public enum PortableResolver {
  public static func portable(_ c: Connection, viewId: Int64) throws -> PortableCutoffs? {
    guard c.profile == .device,
      let text = try c.prepared(ProvenanceSQL.portableOf).bindingFirst([.int(viewId)], { $0.text(0) })
    else { return nil }
    return try ScrollsJSON.decode(PortableCutoffs.self, from: Data(text.utf8))
  }

  /// The short name of a generation in a banner (its first 8 characters).
  static func short(_ g: String) -> String { String(g.prefix(8)) }

  /// The cutoffs of `view` in this generation.
  public static func resolve(_ c: Connection, text: any TextStore, view: SavedViewRow) throws -> PortableResolution {
    let saved = view.savedCutoffs
    guard let p = try portable(c, viewId: view.id) else {
      return PortableResolution(cutoffs: saved, sameGeneration: true, portable: nil, banner: nil, restoring: [])
    }
    let generation = try Meta.get(c, "generation") ?? "reference"
    if p.generation == generation {
      return PortableResolution(cutoffs: saved, sameGeneration: true, portable: p, banner: nil, restoring: [])
    }
    let numbers = try recompute(c, journalSeq: p.journalSeq)
    var restoring: [String] = []
    var runMap: [Int64: Int64] = [:]
    func remapRun(_ v: JSONValue) throws -> JSONValue {
      guard let old = v.integer.map(Int64.init) else { return v }
      if let key = p.runKeys[String(old)] {
        if let new = try StableKeys.runId(c, key) {
          runMap[old] = new
          return .number(Double(new))
        }
        restoring.append("pinned analysis being restored (run #\(old))")
      }
      return v
    }
    var runIds = JSONObject()
    for (k, v) in saved.runIds.objectValue ?? JSONObject() {
      if case .object(let o) = v {
        var m = JSONObject()
        for (ek, ev) in o { m[try remapExprKey(c, ek, p)] = try remapRun(ev) }
        runIds[k] = .object(m)
      } else {
        runIds[k] = try remapRun(v)
      }
    }
    let state = try remapState(c, text: text, saved.state, p, runMap: runMap)
    let cutoffs = ViewCutoffs(importBatch: numbers.importBatch, annotationRev: numbers.annotationRev,
                              relationshipRev: numbers.relationshipRev, runIds: .object(runIds), state: state)
    return PortableResolution(
      cutoffs: cutoffs, sameGeneration: false, portable: p,
      banner: "Saved on generation \(short(p.generation)); opened on generation \(short(generation)): ids remapped, counts as saved",
      restoring: restoring.sorted())
  }

  /// cutoff′(T) for the cutoff tables: the largest id of T created by the acts before `journalSeq` (or the starter's).
  public static func recompute(_ c: Connection, journalSeq: UInt64) throws -> (importBatch: Int64, annotationRev: Int64, relationshipRev: Int64) {
    func cut(_ table: String) throws -> Int64 {
      let journal = try c.prepared(ProvenanceSQL.appliedMaxBefore).bindingFirst([.text(table), .int(Int64(journalSeq))]) {
        $0.intOrNil(0)
      } ?? nil
      return max(journal ?? 0, try StableKeys.baseMax(c, table))
    }
    return (try cut("import_batch"), try cut("annotation_revision"), try cut("relationship_revision"))
  }

  static func remapExprKey(_ c: Connection, _ key: String, _ p: PortableCutoffs) throws -> String {
    guard let ek = p.strands["e\(key)"], let id = try StableKeys.exprId(c, ek) else { return key }
    return String(id)
  }

  /// The stored state with strand, selection and run ids of this generation.
  static func remapState(_ c: Connection, text: any TextStore, _ state: JSONValue, _ p: PortableCutoffs, runMap: [Int64: Int64]) throws -> JSONValue {
    guard var o = state.objectValue else { return state }
    if let strands = o["strands"]?.arrayValue {
      o["strands"] = .array(try strands.map { s in
        guard var so = s.objectValue, so["type"]?.stringValue == "expression", let id = so["id"]?.integer,
          let k = p.strands["e\(id)"], let new = try StableKeys.exprId(c, k)
        else { return s }
        so["id"] = .number(Double(new))
        return .object(so)
      })
    }
    if var runs = o["runs"]?.objectValue {
      if let mat = runs["materialize"]?.objectValue {
        var m = JSONObject()
        for (k, v) in mat {
          let run = v.integer.map(Int64.init).flatMap { runMap[$0] }.map { JSONValue.number(Double($0)) } ?? v
          m[try remapExprKey(c, k, p)] = run
        }
        runs["materialize"] = .object(m)
      }
      for k in ["cluster", "quotes", "vectors"] {
        if let old = runs[k]?.integer.map(Int64.init), let new = runMap[old] { runs[k] = .number(Double(new)) }
      }
      o["runs"] = .object(runs)
    }
    if var sel = o["selection"]?.objectValue, let ps = p.selection, let id = try selectionId(c, text: text, ps) {
      sel["id"] = .number(Double(id))
      o["selection"] = .object(sel)
    }
    return .object(o)
  }

  static func selectionId(_ c: Connection, text: any TextStore, _ s: PortableSelection) throws -> Int64? {
    let key: EndpointKey
    switch s {
    case .occurrence(let e, let a): key = .occurrence(expr: e, anchor: a)
    case .passage(let a): key = .passage(anchor: a)
    case .cluster(let k): return try StableKeys.clusterId(c, k)
    case .document(let d): return try StableKeys.docId(c, d)
    case .relationship(let r): return try StableKeys.relId(c, text: text, r)
    }
    guard case .success(let r) = try StableKeys.resolveEndpoint(c, text: text, key) else { return nil }
    return Int64(r.1)
  }
}
