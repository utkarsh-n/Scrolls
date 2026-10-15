// OWNER: N3
// The queryKey registry and the tile cache (routes/timeline.mjs `defs`, `tiles`, `persistDef`, `resolveDef`). A queryKey
// names a resolved def; defs live in a process-wide LRU (per atlas file) and, best effort, in `query_def`, so a key keeps
// resolving after a relaunch. A key unknown to both answers 404 E_QUERY_UNKNOWN and the app registers the query again.
// Tiles are cached by (atlas, queryKey, tier, tile, data_version): a data change makes every cached tile unreachable.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// A small LRU (insertion order refreshed on hit), safe to share across tasks.
final class LRU<Value: Sendable>: Sendable {
  private struct State {
    var map: [String: Value] = [:]
    var order: [String] = []
  }
  private let state = Mutex(State())
  let capacity: Int

  init(capacity: Int) { self.capacity = capacity }

  func get(_ key: String) -> Value? {
    state.withLock { s in
      guard let v = s.map[key] else { return nil }
      if let i = s.order.lastIndex(of: key) { s.order.remove(at: i) }
      s.order.append(key)
      return v
    }
  }

  func set(_ key: String, _ value: Value) {
    state.withLock { s in
      if s.map[key] != nil, let i = s.order.lastIndex(of: key) { s.order.remove(at: i) }
      s.map[key] = value
      s.order.append(key)
      while s.order.count > capacity {
        let old = s.order.removeFirst()
        s.map[old] = nil
      }
    }
  }

  func removeAll() { state.withLock { $0 = State() } }
}

/// The registered queries of every open atlas.
public enum QueryRegistry {
  static let defs = LRU<QueryDef>(capacity: 2000)
  static let tiles = LRU<Tile>(capacity: 4096)

  /// Registers a def under its queryKey (memory only; `persistStatement` writes the table row).
  public static func register(atlas path: String, _ def: QueryDef) -> String {
    let key = def.queryKey
    defs.set("\(path)|\(key)", def)
    return key
  }

  /// The row `persistDef` writes (or refreshes): key, def JSON, now.
  public static func persistRow(_ def: QueryDef) -> (key: String, json: String) {
    (def.queryKey, CanonicalJSON.string(def.json))
  }

  /// Writes a def into `query_def` (or refreshes its `last_used`) inside a write transaction.
  public static func persist(_ tx: WriteTx, key: String, json: String) throws {
    let now = StoreClock.isoNow()
    let s = try tx.connection.prepared(TimelineSQL.queryDefPut)
    try s.bind([.text(key), .text(json), .text(now), .text(now)])
    try s.run()
  }

  /// `resolveDef(ctx, q)`: memory, then `query_def`; 400 without q, 404 E_QUERY_UNKNOWN when neither holds it.
  public static func resolve(_ c: Connection, _ q: String?) throws -> QueryDef {
    guard let q, !q.isEmpty else {
      throw ScrollsError.badRequest(.validation, "q (the queryKey) is required.",
                                    hint: "Register the query with POST /api/timeline/query first.",
                                    detail: .object(["field": .string("q")]))
    }
    let memo = "\(c.path)|\(q)"
    if let d = defs.get(memo) { return d }
    if let text = try c.prepared(TimelineSQL.queryDefGet).bindingFirst([.text(q)], { $0.text(0) }),
      let json = try? JSONValue.parse(text), let def = try? QueryDef(json: json)
    {
      defs.set(memo, def)
      return def
    }
    throw ScrollsError(code: .queryUnknown, message: "No query \(q) is registered.",
                       hint: "POST /api/timeline/query again; queries are re-registered after a restart.", status: 404)
  }

  /// A cached tile.
  public static func tile(atlas path: String, q: String, tier: String, tile: Int, dataVersion: Int) -> Tile? {
    tiles.get("\(path)|\(q)|\(tier)|\(tile)|\(dataVersion)")
  }

  /// Caches a tile.
  public static func store(atlas path: String, q: String, tier: String, tile t: Tile, dataVersion: Int) {
    tiles.set("\(path)|\(q)|\(tier)|\(t.tile)|\(dataVersion)", t)
  }

  /// Drops every cached def and tile (memory pressure; the table still holds the defs).
  public static func trim() {
    defs.removeAll()
    tiles.removeAll()
  }
}

// MARK: - decoding a def (the inverse of `QueryDef.json`)

extension QueryDef {
  struct DecodeError: Error, CustomStringConvertible {
    let description: String
  }

  /// A def from its JSON form (a `query_def` row written by this engine or by the reference).
  public init(json v: JSONValue) throws {
    func need<T>(_ x: T?, _ what: String) throws -> T {
      guard let x else { throw DecodeError(description: "query_def: \(what) is missing") }
      return x
    }
    guard v["v"]?.safeInteger == QueryDef.version else { throw DecodeError(description: "query_def: unknown def version") }
    let lanesJ = try need(v["lanes"]?.objectValue, "lanes")
    let lanes = CanonicalRequest.LaneSpec(
      facet: try need(lanesJ["facet"]?.stringValue, "lanes.facet"), order: try need(lanesJ["order"]?.stringValue, "lanes.order"),
      max: try need(lanesJ["max"]?.safeInteger, "lanes.max"), manual: lanesJ["manual"]?.arrayValue?.compactMap(\.stringValue) ?? [],
      run: lanesJ["run"]?.safeInteger.map(Int64.init))
    var f = ViewState.Filters()
    if let fj = v["f"]?.objectValue {
      func list(_ k: String) -> [String] { fj[k]?.arrayValue?.compactMap(\.stringValue) ?? [] }
      f.lang = list("lang")
      f.kind = list("kind")
      f.coll = list("coll")
      f.culture = list("culture")
      f.field = list("field")
      f.community = list("community")
      f.basis = list("basis")
      f.syn = fj["syn"]?.safeInteger ?? 1
    }
    let tj = v["toggles"]?.objectValue ?? JSONObject()
    let toggles = zip(Vocab.toggleDefaults.keys, Vocab.toggleDefaults.values).map { k, d in (key: k, value: tj[k]?.safeInteger ?? d) }
    var cutoffs: CanonicalRequest.Cutoffs?
    if let cj = v["cutoffs"]?.objectValue {
      cutoffs = CanonicalRequest.Cutoffs(importBatch: cj["import_batch"]?.safeInteger.map(Int64.init), at: cj["at"]?.stringValue)
    }
    self.init(corpus: try need(v["corpus"]?.stringValue, "corpus"), corpusId: Int64(try need(v["corpusId"]?.safeInteger, "corpusId")),
              corpusIds: (v["corpusIds"]?.arrayValue ?? []).compactMap { $0.safeInteger.map(Int64.init) },
              virtual: v["virtual"]?.boolValue ?? false, synthetic: v["synthetic"]?.boolValue ?? false,
              strands: try (v["strands"]?.arrayValue ?? []).map(DefStrand.init(json:)), lanes: lanes, f: f, toggles: toggles,
              timeBasis: v["timeBasis"]?.stringValue ?? "publication", cutoffs: cutoffs,
              cluster: try v["cluster"].map(ClusterScope.init(json:)))
  }
}

extension DefStrand {
  init(json v: JSONValue) throws {
    guard let type = v["type"]?.stringValue, let key = v["key"]?.stringValue else {
      throw QueryDef.DecodeError(description: "query_def: a strand without type or key")
    }
    let ref: IntOrString
    switch v["ref"] {
    case .number(let n)?: ref = .int(Int(n))
    case .string(let s)?: ref = .string(s)
    default: throw QueryDef.DecodeError(description: "query_def: strand \(key) has no ref")
    }
    let langs = v["langs"]?.arrayValue?.compactMap(\.stringValue)
    var byCorpus: [(corpusId: Int64, langs: [String]?)]?
    if let o = v["langsByCorpus"]?.objectValue {
      byCorpus = o.keys.compactMap { k in Int64(k).map { ($0, o[k]?.arrayValue?.compactMap(\.stringValue)) } }
    }
    let members = try v["members"]?.arrayValue.map { try $0.map(StrandMember.init(json:)) }
    self.init(type: type, ref: ref, key: key, surface: v["surface"]?.stringValue, kind: v["kind"]?.stringValue,
              lang: v["lang"]?.stringValue, run: v["run"]?.safeInteger.map(Int64.init),
              members: members, langs: langs,
              langsByCorpus: byCorpus, synthetic: v["synthetic"]?.boolValue ?? false, sampled: v["sampled"]?.boolValue ?? false,
              accentInsensitive: v["accentInsensitive"]?.boolValue ?? false, provenance: v["provenance"]?.stringValue,
              names: v["names"]?.arrayValue?.compactMap(\.stringValue))
  }
}

extension StrandMember {
  init(json v: JSONValue) throws {
    guard let corpusId = v["corpusId"]?.safeInteger, let corpus = v["corpus"]?.stringValue else {
      throw QueryDef.DecodeError(description: "query_def: a strand member without its corpus")
    }
    self.init(corpusId: Int64(corpusId), corpus: corpus, ref: v["ref"]?.safeInteger.map(Int64.init),
              run: v["run"]?.safeInteger.map(Int64.init), langs: v["langs"]?.arrayValue?.compactMap(\.stringValue),
              sampled: v["sampled"]?.boolValue ?? false, accentInsensitive: v["accentInsensitive"]?.boolValue ?? false)
  }
}

extension ClusterScope {
  init(json v: JSONValue) throws {
    guard let state = v["state"]?.stringValue else { throw QueryDef.DecodeError(description: "query_def: cluster without state") }
    self.init(state: state, run: v["run"]?.safeInteger.map(Int64.init), materialize: v["materialize"]?.safeInteger.map(Int64.init),
              groups: (v["groups"]?.arrayValue ?? []).compactMap { g in
                guard let id = g["id"]?.safeInteger, let ord = g["ord"]?.safeInteger, let st = g["status"]?.stringValue else { return nil }
                return ClusterScope.Group(id: Int64(id), ord: ord, status: st)
              },
              residual: (v["residual"]?.arrayValue ?? []).compactMap { $0.safeInteger.map(Int64.init) },
              note: v["note"]?.stringValue, suggestion: v["suggestion"].flatMap { $0.isNull ? nil : $0 },
              gate: v["gate"], pinned: v["pinned"]?.boolValue, sameCounts: v["sameCounts"]?.boolValue)
  }
}
