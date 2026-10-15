// OWNER: N3
// Port of query.mjs `buildDef` / `queryKeyOf` / `defFromViewState` (SPEC §7.1 POST /api/timeline/query): a canonical
// request becomes a resolved `def` — the corpora it reads, each strand's pinned (or current) materialize runs and
// languages, maker names, and for cluster lanes the clustering run — whose hash is the queryKey. Every tile, mark, shelf,
// bin and export of that key reads the SAME slice (SliceSQL), so numerators and denominators can never drift apart.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One member of an expression strand: the sibling expression in one corpus with its run and languages.
public struct StrandMember: Sendable, Equatable {
  public var corpusId: Int64
  public var corpus: String
  public var ref: Int64?
  public var run: Int64?
  /// The languages it is counted in (nil = any language).
  public var langs: [String]?
  public var sampled: Bool
  public var accentInsensitive: Bool

  var json: JSONValue {
    var o: JSONObject = ["corpusId": .int(corpusId), "corpus": .string(corpus), "ref": .int(ref), "run": .int(run),
                         "langs": langs.map { .array($0.map(JSONValue.string)) } ?? .null, "sampled": .bool(sampled)]
    if accentInsensitive { o["accentInsensitive"] = .bool(true) }
    return .object(o)
  }
}

/// A resolved strand of a def.
public struct DefStrand: Sendable, Equatable {
  public var type: String
  /// Expression and work ids are numbers; theme and maker refs are strings.
  public var ref: IntOrString
  /// The strand's key in lanes and tiles: the expression id, `theme:<v>@<prov>`, `work:<id>`, `maker:<slug>`.
  public var key: String
  public var surface: String?
  public var kind: String?
  public var lang: String?
  public var run: Int64?
  public var members: [StrandMember]?
  public var langs: [String]?
  /// Present when the members of a virtual corpus count in different languages: corpus id → languages (nil = any).
  public var langsByCorpus: [(corpusId: Int64, langs: [String]?)]?
  public var synthetic: Bool
  public var sampled: Bool
  public var accentInsensitive: Bool
  public var provenance: String?
  public var names: [String]?

  public static func == (a: DefStrand, b: DefStrand) -> Bool { a.json == b.json }

  /// The expression id of an expression strand.
  public var exprId: Int64? { if case .int(let i) = ref, type == "expression" { return Int64(i) } else { return nil } }

  /// `strandLangSpec(strand)`.
  public var langSpec: LangSpec {
    if let by = langsByCorpus { return .byCorpus(by) }
    return langs.map { .list($0) } ?? .any
  }

  /// `[expression id, run id]` of every counted member (`memberRuns`).
  public var memberRuns: [(expr: Int64, run: Int64)] {
    (members ?? [StrandMember(corpusId: 0, corpus: "", ref: exprId, run: run, langs: langs, sampled: sampled, accentInsensitive: false)])
      .compactMap { m in m.ref.flatMap { r in m.run.map { (r, $0) } } }
  }

  var json: JSONValue {
    var o: JSONObject = ["type": .string(type), "key": .string(key), "synthetic": .bool(synthetic)]
    switch ref {
    case .int(let i): o["ref"] = .int(i)
    case .string(let s): o["ref"] = .string(s)
    }
    switch type {
    case "expression":
      o["surface"] = .str(surface)
      o["kind"] = .str(kind)
      o["lang"] = .str(lang)
      o["run"] = .int(run)
      o["members"] = .array((members ?? []).map(\.json))
      o["langs"] = langs.map { .array($0.map(JSONValue.string)) } ?? .null
      if let by = langsByCorpus {
        o["langsByCorpus"] = .object(JSONObject(by.map { (String($0.corpusId), $0.langs.map { .array($0.map(JSONValue.string)) } ?? .null) }))
      }
      o["sampled"] = .bool(sampled)
      if accentInsensitive { o["accentInsensitive"] = .bool(true) }
    case "theme":
      o["provenance"] = .str(provenance)
      o["run"] = .null
      o["langs"] = .null
    case "maker":
      o["names"] = .array((names ?? []).map(JSONValue.string))
      o["run"] = .null
      o["langs"] = .null
    default:
      o["run"] = .null
      o["langs"] = .null
    }
    return .object(o)
  }
}

/// A strand's language condition.
public enum LangSpec: Sendable, Equatable {
  case any
  case list([String])
  /// Members of a virtual corpus counting in different languages: per corpus id (nil = any).
  case byCorpus([(corpusId: Int64, langs: [String]?)])

  public static func == (a: LangSpec, b: LangSpec) -> Bool {
    switch (a, b) {
    case (.any, .any): true
    case (.list(let x), .list(let y)): x == y
    case (.byCorpus(let x), .byCorpus(let y)): x.map(\.corpusId) == y.map(\.corpusId) && x.map(\.langs) == y.map(\.langs)
    default: false
    }
  }

  /// `langsForCorpus(spec, corpusId)`.
  public func forCorpus(_ id: Int64) -> [String]? {
    switch self {
    case .any: nil
    case .list(let l): l
    case .byCorpus(let by): by.first { $0.corpusId == id }?.langs ?? nil
    }
  }

  /// A JSON key part (memo keys).
  var key: String {
    switch self {
    case .any: "null"
    case .list(let l): CanonicalJSON.string(.array(l.map(JSONValue.string)))
    case .byCorpus(let by): CanonicalJSON.string(.object(JSONObject(by.map { (String($0.corpusId), $0.langs.map { .array($0.map(JSONValue.string)) } ?? .null) })))
    }
  }
}

/// A resolved query definition.
public struct QueryDef: Sendable, Equatable {
  public static let version = 2

  public var corpus: String
  public var corpusId: Int64
  public var corpusIds: [Int64]
  public var virtual: Bool
  public var synthetic: Bool
  public var strands: [DefStrand]
  public var lanes: CanonicalRequest.LaneSpec
  public var f: ViewState.Filters
  public var toggles: [(key: String, value: Int)]
  public var timeBasis: String
  public var cutoffs: CanonicalRequest.Cutoffs?
  public var cluster: ClusterScope?

  public static func == (a: QueryDef, b: QueryDef) -> Bool { a.json == b.json }

  /// A toggle's value.
  public func toggle(_ k: String) -> Int { toggles.first { $0.key == k }?.value ?? (Vocab.toggleDefaults[k] ?? 0) }
  public var facet: String { lanes.facet }

  /// The def as the reference holds it (`queryKeyOf` hashes its canonical JSON).
  public var json: JSONValue {
    var lanesO: JSONObject = ["facet": .string(lanes.facet), "order": .string(lanes.order), "max": .int(lanes.max),
                              "manual": .array(lanes.manual.map(JSONValue.string))]
    if let r = lanes.run { lanesO["run"] = .int(r) }
    var o: JSONObject = [
      "v": .int(QueryDef.version), "corpus": .string(corpus), "corpusId": .int(corpusId),
      "corpusIds": .array(corpusIds.map { .int($0) }), "virtual": .bool(virtual), "synthetic": .bool(synthetic),
      "strands": .array(strands.map(\.json)), "lanes": .object(lanesO), "f": QueryDef.filtersJSON(f),
      "toggles": .object(JSONObject(toggles.map { ($0.key, JSONValue.int($0.value)) })), "timeBasis": .string(timeBasis),
    ]
    if let cutoffs {
      var c = JSONObject()
      if let b = cutoffs.importBatch { c["import_batch"] = .int(b) }
      if let at = cutoffs.at { c["at"] = .string(at) }
      o["cutoffs"] = .object(c)
    }
    if let cluster { o["cluster"] = cluster.json }
    return .object(o)
  }

  /// ViewState.f as the reference's object.
  public static func filtersJSON(_ f: ViewState.Filters) -> JSONValue {
    .object(["lang": .array(f.lang.map(JSONValue.string)), "kind": .array(f.kind.map(JSONValue.string)),
             "coll": .array(f.coll.map(JSONValue.string)), "culture": .array(f.culture.map(JSONValue.string)),
             "field": .array(f.field.map(JSONValue.string)), "community": .array(f.community.map(JSONValue.string)),
             "basis": .array(f.basis.map(JSONValue.string)), "syn": .int(f.syn)])
  }

  /// `queryKeyOf(def)`: 16 hex characters of sha256 over its canonical JSON.
  public var queryKey: String { String(IDs.sha256Hex(CanonicalJSON.string(json)).prefix(16)) }

  /// `fieldClassesOf(def)`: the counted field classes under the toggles.
  public var fieldClasses: [String] {
    ["text", "title", "abstract"] + (toggle("ds") == 1 ? ["describes"] : []) + (toggle("ap") == 1 ? ["apparatus"] : [])
  }

  /// `readsEndpoints(def)`: the Term trail also reads relation-endpoint collections (works mode).
  public var readsEndpoints: Bool { lanes.facet == "trail" }

  /// `clusterLanesOk(def)`.
  public var clusterLanesOK: Bool { lanes.facet == "cluster" && cluster?.state == "ok" }

  /// `denomKeyOf(def, laneKey, uc)`: cluster lanes share their unit class's slice denominators.
  public func denomKey(_ laneKey: String, _ uc: String) -> String { lanes.facet == "cluster" ? "~\(uc)" : laneKey }

  /// `unionLanguages(strands)`: nil when any expression strand counts every language.
  public var unionLanguages: [String]? {
    var out = Set<String>()
    for s in strands where s.type == "expression" {
      guard let l = s.langs else { return nil }
      out.formUnion(l)
    }
    return out.isEmpty ? nil : out.sorted(by: CanonicalJSON.codeUnitLess)
  }

  /// The language spec of the coverage track: the single strand's own, or the union.
  public var coverageLangs: LangSpec {
    strands.count == 1 ? strands[0].langSpec : (unionLanguages.map { .list($0) } ?? .any)
  }

  /// A copy with another facet (trail's outside count reads the modality slice).
  func withFacet(_ facet: String) -> QueryDef {
    var d = self
    d.lanes.facet = facet
    return d
  }
}

/// What resolving a request found: the def, expressions whose counts are missing or stale, and siblings to track.
public struct ResolvedQuery: Sendable {
  public var def: QueryDef
  public var materialize: [(expressionId: Int64, hasRun: Bool)]
  public var track: [(corpus: String, surface: String, lang: String?, kind: String, forExpression: Int64)]
}

/// Building defs.
public enum QueryDefs {
  static func bad(_ message: String, field: String, hint: String? = nil) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, hint: hint, detail: .object(["field": .string(field)]))
  }

  /// `buildDef(db, req, {scope})`. Reads only.
  public static func build(_ c: Connection, _ req: CanonicalRequest, scope override: CorpusScope? = nil) throws -> ResolvedQuery {
    let scope = try override ?? Scopes.resolve(c, req.corpus)
    var strands: [DefStrand] = []
    var materialize: [(expressionId: Int64, hasRun: Bool)] = []
    var track: [(corpus: String, surface: String, lang: String?, kind: String, forExpression: Int64)] = []
    for s in req.strands {
      switch s.type {
      case "expression":
        guard case .int(let id) = s.ref, let expr = try Expressions.get(c, Int64(id)) else {
          throw bad("No expression \(s.ref).", field: "strands", hint: "Track it first with POST /api/expressions.")
        }
        guard let ec = expr.corpusId, scope.ids.contains(ec) else {
          if !scope.virtual {
            throw bad("Expression \(s.ref) was tracked in another corpus.", field: "strands", hint: "Track '\(expr.surface)' in \(req.corpus).")
          }
          throw bad("Expression \(s.ref) belongs to a corpus outside '\(req.corpus)' (the synthetic demo is never part of it).",
                    field: "strands", hint: "Track '\(expr.surface)' in \(req.corpus).")
        }
        let sibs: [(corpusId: Int64, corpus: String, expr: ExpressionRow?)] = scope.virtual
          ? try Scopes.siblings(c, expr, scope.members) : [(ec, scope.slug, expr)]
        var members: [StrandMember] = []
        for sb in sibs {
          guard let e = sb.expr else {
            track.append((sb.corpus, expr.surface, expr.lang, expr.kind, expr.id))
            members.append(StrandMember(corpusId: sb.corpusId, corpus: sb.corpus, ref: nil, run: nil, langs: nil, sampled: false,
                                        accentInsensitive: false))
            continue
          }
          members.append(try member(c, e, corpusId: sb.corpusId, corpus: sb.corpus, pinned: req.runs, materialize: &materialize))
        }
        let counted = members.allSatisfy { $0.run != nil }
        let langSets = members.filter { $0.ref != nil }.map(\.langs)
        let anyLang = langSets.contains { $0 == nil }
        let union: [String]? = anyLang ? nil : Array(Set(langSets.flatMap { $0! })).sorted(by: CanonicalJSON.codeUnitLess)
        let differ = langSets.contains { $0 != langSets.first ?? nil }
        strands.append(DefStrand(type: "expression", ref: .int(Int(expr.id)), key: String(expr.id), surface: expr.surface,
                                 kind: expr.kind, lang: expr.lang, run: counted ? members.first?.run : nil, members: members,
                                 langs: union, langsByCorpus: differ ? members.map { ($0.corpusId, $0.langs) } : nil,
                                 synthetic: expr.isSynthetic, sampled: members.contains(where: \.sampled),
                                 accentInsensitive: members.contains(where: \.accentInsensitive), provenance: nil, names: nil))
      case "theme":
        let ref = s.ref.description
        let q = try c.prepared(QueryDefSQL.themeProvenances)
        try q.bind([.text(ref), .text(SQLJSON.ints(scope.ids))])
        let provs = try q.all { $0.text(0) }
        for p in provs.isEmpty ? ["documented_category"] : provs {
          strands.append(DefStrand(type: "theme", ref: .string(ref), key: "theme:\(ref)@\(p)", synthetic: scope.synthetic,
                                   sampled: false, accentInsensitive: false, provenance: p))
        }
      case "work":
        guard case .int(let id) = s.ref,
          try c.prepared(QueryDefSQL.workInScope).bindingFirst([.int(Int64(id)), .text(SQLJSON.ints(scope.ids))], { _ in true }) == true
        else { throw bad("No work \(s.ref) in corpus \(req.corpus).", field: "strands") }
        strands.append(DefStrand(type: "work", ref: .int(id), key: "work:\(id)", synthetic: scope.synthetic, sampled: false,
                                 accentInsensitive: false))
      case "maker":
        let ref = s.ref.description
        var names = JSStringSet()
        var list: [String] = []
        for id in scope.ids {
          let index = try TagIndex.index(c, corpusId: id, scheme: "maker")
          for n in TagIndex.labelsForRef(index, ref) where names.insert(n) { list.append(n) }
        }
        if list.isEmpty { throw bad("No maker '\(ref)' in corpus \(req.corpus).", field: "strands") }
        strands.append(DefStrand(type: "maker", ref: .string(ref), key: "maker:\(ref)", synthetic: scope.synthetic, sampled: false,
                                 accentInsensitive: false, names: list.sorted(by: JSText.less)))
      default:
        throw bad("Strand type '\(s.type)' is not available on the timeline yet.", field: "strands",
                  hint: s.type == "cluster" ? "Context groups are lanes: ask for lanes {facet: \"cluster\"} with one expression strand." : nil)
      }
    }
    var def = QueryDef(corpus: scope.slug, corpusId: scope.ids[0], corpusIds: scope.ids, virtual: scope.virtual,
                       synthetic: scope.synthetic, strands: strands, lanes: req.lanes, f: req.f, toggles: req.toggles,
                       timeBasis: req.timeBasis, cutoffs: req.cutoffs, cluster: nil)
    if req.lanes.facet == "cluster" { def.cluster = try clusterScope(c, &def, pinned: req.lanes.run) }
    return ResolvedQuery(def: def, materialize: materialize, track: track)
  }

  /// `strandMember`: the expression's pinned (or current) run, its languages and sampling.
  static func member(_ c: Connection, _ expr: ExpressionRow, corpusId: Int64, corpus: String, pinned: [String: Int64],
                     materialize: inout [(expressionId: Int64, hasRun: Bool)]) throws -> StrandMember {
    let fr = try Expressions.freshness(c, expr.id)
    var run = fr.runId
    if let p = pinned[String(expr.id)], p > 0 {
      guard try c.prepared(MatchSQL.pinnedMaterializeRun).bindingFirst([.int(p), .int(expr.id)], { _ in true }) == true else {
        throw bad("Run \(p) is not a succeeded materialization of expression \(expr.id).", field: "runs")
      }
      run = p
    } else if !fr.fresh {
      materialize.append((expr.id, fr.runId != nil))
    }
    var metrics = JSONObject()
    if let run, let mj = try c.prepared(MatchSQL.runMetrics).bindingFirst([.int(run)], { $0.textOrNil(0) }) ?? nil {
      metrics = (try? JSONValue.parse(mj))?.objectValue ?? JSONObject()
    }
    return StrandMember(corpusId: corpusId, corpus: corpus, ref: expr.id, run: run,
                        langs: Expressions.strandLanguages(expr, try Expressions.variants(c, expr.id)),
                        sampled: metrics["sampled"] == .bool(true), accentInsensitive: metrics["mode"] == .string("fts-index"))
  }

  /// `clusterScope(db, def, pinned)`.
  static func clusterScope(_ c: Connection, _ def: inout QueryDef, pinned: Int64?) throws -> ClusterScope {
    let exprs = def.strands.indices.filter { def.strands[$0].type == "expression" }
    if exprs.count != 1 || def.strands.count != 1 || def.virtual {
      return ClusterScope(state: "unavailable", run: nil, materialize: nil, groups: [], residual: [],
                          note: def.virtual ? "Context groups are computed per corpus: open the expression in one corpus to see its groups as lanes."
                            : "Context-group lanes need exactly one pinned expression.", suggestion: nil, gate: nil, pinned: nil,
                          sameCounts: nil)
    }
    let i = exprs[0]
    let strand = def.strands[i]
    var cl = try ClusterLanes.resolve(c, exprId: strand.members![0].ref!, strandRun: strand.run, pinned: pinned)
    if cl.state == "ok" && (cl.pinned == true || cl.sameCounts == true), let mat = cl.materialize, strand.run != mat {
      def.strands[i].members![0].run = mat
      def.strands[i].run = mat
    }
    if cl.state == "ok" && def.strands[i].sampled {
      cl.state = "gated"
      cl.groups = []
      cl.residual = []
      cl.suggestion = nil
      cl.gate = .object(["gate": "insufficient_occurrences", "value": .null, "needed": .object(["complete_occurrences": .bool(true)]),
                         "have": .object(["sampled": .bool(true)]), "suggestion": .null])
      cl.note = "This expression is very frequent: its occurrence rows are a stratified sample, so counts per context group would not be complete."
    }
    return cl
  }

  /// `defFromViewState(db, state)`: a def from a saved ViewState (exports, saved views); missing counts are reported.
  public static func fromViewState(_ c: Connection, _ state: ViewState) throws -> (def: QueryDef, missing: [Int64]) {
    let strands: [CanonicalRequest.StrandRef] = state.strands.map { s in
      switch s.id {
      case .number(let i): CanonicalRequest.StrandRef(type: s.type, ref: .int(i))
      case .string(let t): CanonicalRequest.StrandRef(type: s.type, ref: .string(t))
      }
    }
    var runs: [String: Int64] = [:]
    for (k, v) in state.runs.materialize { runs[String(k)] = Int64(v) }
    let toggles = state.toggles
    let req = try CanonicalRequest.simple(
      corpus: state.corpus, strands: strands, facet: state.lanes.facet, f: ViewState.formatFilter(state.f, withDefaults: true),
      order: state.lanes.order, max: state.lanes.max, manual: state.lanes.manual,
      run: state.lanes.facet == "cluster" ? (state.lanes.run ?? state.runs.cluster).map(Int64.init) : nil, toggles: toggles,
      timeBasis: state.timeBasis, runs: runs)
    let r = try build(c, req)
    return (r.def, r.materialize.filter { !$0.hasRun }.map(\.expressionId) + r.track.map(\.forExpression))
  }
}

/// Statements of def resolution.
public enum QueryDefSQL: SQLCatalog {
  static let themeProvenances = SQL("q.def.theme-provenances", """
    SELECT DISTINCT t.provenance FROM doc_tag t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'theme' AND t.value = ? AND c.corpus_id IN (SELECT value FROM json_each(?))
      ORDER BY CASE t.provenance WHEN 'documented_category' THEN 0 WHEN 'machine_tag' THEN 1 WHEN 'genre_heuristic' THEN 2 ELSE 3 END
    """)
  static let workInScope = SQL("q.def.work-in-scope", """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
      AND c.corpus_id IN (SELECT value FROM json_each(?))
    """)

  public static let all: [SQL] = [themeProvenances, workInScope]
}
