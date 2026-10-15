// OWNER: N6
// What a saved view needs of the query layer (server/aggregate/scope.mjs and the strand-resolving half of
// aggregate/query.mjs `defFromViewState` → `canonicalRequest` → `buildDef`, plus aggregate/clusterlanes.mjs
// `resolveClusterRun`): which corpora a view reads, which expression ids its strands stand for, and which runs a save
// pins. Only what `views.mjs` reads is ported here — the members' materialize runs, the clustering run of context-group
// lanes, and the error messages that become save warnings; N3's QueryDef owns the full timeline definition.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The corpora a corpus slug reads (`resolveCorpusScope`).
public struct CorpusScope: Sendable, Equatable {
  public struct Member: Sendable, Equatable {
    public let id: Int64
    public let slug: String
    public let name: String
  }
  public let slug: String
  public let name: String
  public let virtual: Bool
  public let members: [Member]
  public let synthetic: Bool
  public var ids: [Int64] { members.map(\.id) }
}

/// A view-state strand resolved as `buildDef` resolves it: each member corpus's expression and its counted run.
struct DefStrand {
  struct Member {
    var ref: Int64?
    var run: Int64?
    var sampled: Bool
  }
  var type: String
  var members: [Member]
  var run: Int64?
}

/// The part of a timeline definition a saved view pins.
struct ViewDef {
  var strands: [DefStrand]
  var virtual: Bool
  /// Context-group lanes: the clustering run on screen, when its state is 'ok'.
  var clusterRun: Int64?
  var clusterOK: Bool
}

public enum ViewScope {
  /// `resolveCorpusScope(db, slug)` (400 E_VALIDATION for an unknown slug or an empty virtual corpus).
  public static func resolve(_ c: Connection, slug: String) throws -> CorpusScope {
    if let v = Vocab.virtualCorpora[slug] {
      let members = try c.prepared(ProvenanceSQL.realMembers).all { CorpusScope.Member(id: $0.int(0), slug: $0.text(1), name: $0.text(2)) }
      if members.isEmpty {
        throw ScrollsError(code: .validation, message: "No real corpus holds documents yet, so '\(slug)' is empty.",
                           hint: "Load the Cipher corpus or a STEMM source first.", detail: ["field": "corpus"], status: 400)
      }
      return CorpusScope(slug: slug, name: v.name, virtual: true, members: members, synthetic: false)
    }
    guard let k = try c.prepared(ProvenanceSQL.corpusBySlug).bindingFirst([.text(slug)], {
      (id: $0.int(0), slug: $0.text(1), name: $0.text(2), synthetic: $0.int(3))
    }) else {
      throw ScrollsError(code: .validation, message: "Unknown corpus '\(slug)'.",
                         hint: "Use one of the corpora listed by GET /api/corpora, or real.", detail: ["field": "corpus"], status: 400)
    }
    return CorpusScope(slug: k.slug, name: k.name, virtual: false, members: [.init(id: k.id, slug: k.slug, name: k.name)],
                       synthetic: k.synthetic == 1)
  }

  /// `siblingExpressions`: the expression with the same kind, language and folded form in each member corpus (nil
  /// where it is not tracked).
  static func siblings(_ c: Connection, kind: String, lang: String?, norm: String, members: [CorpusScope.Member]) throws -> [Int64?] {
    try members.map { m in
      try c.prepared(ProvenanceSQL.siblingExpression).bindingFirst([.text(kind), .text(lang ?? ""), .text(norm), .int(m.id)]) { $0.int(0) }
    }
  }

  struct Expression {
    let id: Int64
    let corpusId: Int64?
    let kind: String
    let lang: String?
    let norm: String
    let surface: String
  }

  static func expression(_ c: Connection, _ id: Int64) throws -> Expression? {
    try c.prepared(ProvenanceSQL.expressionById).bindingFirst([.int(id)]) {
      Expression(id: $0.int(0), corpusId: $0.intOrNil(1), kind: $0.text(2), lang: $0.textOrNil(3), norm: $0.text(4), surface: $0.text(5))
    }
  }

  /// The materialize run an expression is counted by now (`freshness(db, id).runId`).
  static func countedRun(_ c: Connection, _ expr: Int64) throws -> Int64? {
    try c.prepared(ProvenanceSQL.countedRun).bindingFirst([.int(expr)]) { $0.int(0) }
  }

  static func sampled(_ c: Connection, run: Int64) throws -> Bool {
    guard let m = try c.prepared(ProvenanceSQL.runMetrics).bindingFirst([.int(run)], { $0.textOrNil(0) }) ?? nil,
      let v = try? JSONValue.parse(m)
    else { return false }
    return v["sampled"] == .bool(true)
  }

  static func bad(_ message: String) -> ScrollsError { ScrollsError(code: .validation, message: message, status: 400) }

  /// `defFromViewState(db, state)` reduced to what a save pins. Throws the reference's 400 with its message.
  static func def(_ c: Connection, state: JSONValue, scopeOverride: CorpusScope? = nil) throws -> ViewDef {
    // canonicalRequest
    guard let corpus = state["corpus"]?.stringValue, !corpus.isEmpty else { throw bad("corpus is required.") }
    guard let strands = state["strands"]?.arrayValue, !strands.isEmpty else { throw bad("At least one strand is required.") }
    if strands.count > 4 { throw bad("At most 4 strands can be pinned.") }
    var refs: [(type: String, num: Int64?, text: String)] = []
    for (i, s) in strands.enumerated() {
      guard let type = s["type"]?.stringValue, Vocab.strandTypes.contains(type) else {
        throw bad("strands[\(i)].type must be one of \(Vocab.strandTypes.joined(separator: ", ")).")
      }
      let raw = s["ref"].nonNull ?? s["id"].nonNull
      if type == "expression" || type == "work" {
        let n = raw.map(Annotations.jsNumber) ?? .nan
        guard n.isFinite, n == n.rounded(.towardZero), n > 0 else { throw bad("strands[\(i)].ref is missing or invalid.") }
        refs.append((type, Int64(n), JSNumber.format(n)))
      } else {
        let t = raw.map(Anchors.jsString) ?? ""
        if t.isEmpty { throw bad("strands[\(i)].ref is missing or invalid.") }
        refs.append((type, nil, t))
      }
    }
    let lanes = state["lanes"]?.objectValue ?? JSONObject()
    let facet = lanes["facet"].nonNull?.stringValue ?? "domain"
    guard Vocab.laneFacets.contains(facet) else { throw bad("lanes.facet must be one of \(Vocab.laneFacets.joined(separator: ", ")).") }
    let order = lanes["order"].nonNull?.stringValue ?? "first_observed"
    guard Vocab.laneOrders.contains(order) else { throw bad("lanes.order must be one of \(Vocab.laneOrders.joined(separator: ", ")).") }
    var lanesRun: Int64?
    if facet == "cluster", let r = lanes["run"].nonNull ?? state["runs"]?["cluster"].nonNull {
      let n = Annotations.jsNumber(r)
      guard n.isFinite, n == n.rounded(.towardZero), n > 0 else { throw bad("lanes.run must be a clustering run id.") }
      lanesRun = Int64(n)
    }
    let timeBasis = state["timeBasis"].nonNull?.stringValue ?? "publication"
    guard Vocab.timeBases.contains(timeBasis) else { throw bad("timeBasis must be one of \(Vocab.timeBases.joined(separator: ", ")).") }
    let pinnedMaterialize = state["runs"]?["materialize"]?.objectValue ?? JSONObject()

    // buildDef
    let scope = try scopeOverride ?? resolve(c, slug: corpus)
    var out: [DefStrand] = []
    for s in refs {
      switch s.type {
      case "expression":
        let ref = s.num!
        guard let expr = try expression(c, ref) else { throw bad("No expression \(ref).") }
        if !scope.ids.contains(where: { $0 == expr.corpusId }) {
          if !scope.virtual { throw bad("Expression \(ref) was tracked in another corpus.") }
          throw bad("Expression \(ref) belongs to a corpus outside '\(corpus)' (the synthetic demo is never part of it).")
        }
        let sibs: [Int64?] = scope.virtual
          ? try siblings(c, kind: expr.kind, lang: expr.lang, norm: expr.norm, members: scope.members) : [expr.id]
        var members: [DefStrand.Member] = []
        for sib in sibs {
          guard let sib else {
            members.append(.init(ref: nil, run: nil, sampled: false))
            continue
          }
          var run = try countedRun(c, sib)
          if let p = pinnedMaterialize[String(sib)] {
            let n = Annotations.jsNumber(p)
            if n.isFinite, n == n.rounded(.towardZero), n > 0 {
              let ok = try c.prepared(ProvenanceSQL.pinnedMaterialize).bindingFirst([.int(Int64(n)), .int(sib)]) { _ in true } ?? false
              if !ok { throw bad("Run \(JSNumber.format(n)) is not a succeeded materialization of expression \(sib).") }
              run = Int64(n)
            }
          }
          members.append(.init(ref: sib, run: run, sampled: try run.map { try sampled(c, run: $0) } ?? false))
        }
        out.append(DefStrand(type: "expression", members: members,
                             run: members.allSatisfy { $0.run != nil } ? members.first?.run : nil))
      case "theme":
        out.append(DefStrand(type: "theme", members: [], run: nil))
      case "work":
        let found = try c.prepared(ProvenanceSQL.workInScope).bindingFirst([.int(s.num!), .text(idsJSON(scope.ids))]) { _ in true } ?? false
        if !found { throw bad("No work \(s.text) in corpus \(corpus).") }
        out.append(DefStrand(type: "work", members: [], run: nil))
      case "maker":
        var any = false
        for id in scope.ids where !any {
          let names = try c.prepared(ProvenanceSQL.makerNames).bindingFirstAll([.int(id), .int(id)]) { $0.text(0) }
          any = names.contains { JSString.equal($0, s.text) || JSString.equal(IDs.slug($0), s.text) }
        }
        if !any { throw bad("No maker '\(s.text)' in corpus \(corpus).") }
        out.append(DefStrand(type: "maker", members: [], run: nil))
      default:
        throw bad("Strand type '\(s.type)' is not available on the timeline yet.")
      }
    }
    var def = ViewDef(strands: out, virtual: scope.virtual, clusterRun: nil, clusterOK: false)
    if facet == "cluster" { try clusterScope(c, &def, pinned: lanesRun) }
    return def
  }

  /// `clusterScope` / `resolveClusterRun`: the clustering run of context-group lanes, and the count it grouped.
  static func clusterScope(_ c: Connection, _ def: inout ViewDef, pinned: Int64?) throws {
    let exprs = def.strands.filter { $0.type == "expression" }
    guard exprs.count == 1, def.strands.count == 1, !def.virtual, let exprId = exprs[0].members.first?.ref else { return }
    let run: (id: Int64, params: String, gate: String)?
    if let pinned {
      run = try c.prepared(ProvenanceSQL.pinnedClusterRun).bindingFirst([.int(pinned), .int(exprId)]) { ($0.int(0), $0.text(1), $0.text(2)) }
    } else {
      run = try c.prepared(ProvenanceSQL.latestClusterRun).bindingFirst([.int(exprId)]) { ($0.int(0), $0.text(1), $0.text(2)) }
    }
    guard let run else { return }
    let gate = (try? JSONValue.parse(run.gate))?["cluster"]?["gate"]?.stringValue ?? "ok"
    if gate != "ok" { return }
    let materialize = (try? JSONValue.parse(run.params))?["materialize"]?.integer.map(Int64.init)
    var sameCounts = false
    var strand = def.strands[0]
    if pinned == nil, let m = materialize, let current = strand.run, m != current {
      guard try sameCount(c, expr: exprId, m, current) else { return }
      sameCounts = true
    }
    if (pinned != nil || sameCounts), let m = materialize, strand.run != m {
      strand.members[0].run = m
      strand.run = m
      def.strands[0] = strand
    }
    if strand.members.contains(where: \.sampled) { return }  // gated: a sampled count has no complete groups
    def.clusterRun = run.id
    def.clusterOK = true
  }

  /// `sameCount`: two materialization runs of an expression counted exactly the same rows.
  static func sameCount(_ c: Connection, expr: Int64, _ a: Int64, _ b: Int64) throws -> Bool {
    func rows(_ run: Int64) throws -> [String] {
      try c.prepared(ProvenanceSQL.exprDocRows).bindingFirstAll([.int(expr), .int(run)]) {
        "\($0.int(0))|\($0.textOrNil(1) ?? "∅")|\($0.text(2))|\($0.int(3))|\($0.int(4))|\($0.int(5))"
      }
    }
    return try rows(a) == rows(b)
  }

  static func idsJSON(_ ids: [Int64]) -> String { "[" + ids.map(String.init).joined(separator: ",") + "]" }
}
