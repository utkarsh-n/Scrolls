// OWNER: N4
// What both slices of a comparison read (slices.mjs `loadScope`): their collections' documents with denominators
// (doc_tokens) and the expressions' counts (expr_doc). As saved (RF-2) only the documents the saved view counted: imports
// ≤ its cutoff, soft-deleted ones still counted when they were deleted after its save time — the timeline's rule, so
// Compare equals the Scroll it was opened from. Documents keep the order SQLite returns them in (the reference's Map
// insertion order), because sums, strata and bootstrap blocks follow it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A collection row with its corpus slug.
public struct CollectionInfo: Sendable {
  public var id: Int
  public var corpusID: Int
  public var slug: String
  public var name: String
  public var domain: String
  public var modality: String
  public var unit: String
  public var sampling: String
  public var rateEligible: Bool
  public var coverageGate: Int?
  public var exportTextAllowed: Bool
  public var synthetic: Bool
  public var license: String?
  public var selectionNote: String?
  public var corpusSlug: String
}

/// A doc_tokens row.
struct DocTok {
  var plang: String
  var fc: String
  var tokens: Int
}

/// An expr_doc row.
struct DocHit {
  var plang: String
  var fc: String
  var n: Int
  var names: Int
  var expr: Int
}

/// A document of the scope.
final class ScopeDoc {
  let id: Int
  let coll: Int
  let kind: String
  let langText: String?
  let author: String?
  let yLo: Int?
  let yHi: Int?
  let chrono: String
  let basis: String
  let precision: String
  let tr: Bool
  let dup: Bool
  let prominence: Double?
  var tercile: Int?
  let syn: Bool
  let community: String?
  let culture: String?
  let field: String?
  let title: String?
  let dateLabel: String
  var tok: [DocTok] = []
  var hits: [DocHit] = []

  init(row r: Row) {
    id = r.i(0)
    coll = r.i(1)
    kind = r.text(2)
    langText = r.textOrNil(3)
    author = r.textOrNil(4)
    yLo = r.iOrNil(5)
    yHi = r.iOrNil(6)
    chrono = r.text(7)
    basis = r.text(8)
    precision = r.text(9)
    tr = r.i(10) == 1
    dup = !r.isNull(11)
    prominence = r.doubleOrNil(12)
    tercile = r.iOrNil(13)
    syn = r.i(14) == 1
    community = r.textOrNil(15)
    culture = r.textOrNil(16)
    field = r.textOrNil(17)
    title = r.textOrNil(18)
    dateLabel = r.text(19)
  }

  /// `doc[k] ?? ''` of the facet keys.
  func facet(_ key: String) -> String {
    switch key {
    case "kind": kind
    case "culture": culture ?? ""
    case "field": field ?? ""
    case "community": community ?? ""
    case "basis": basis
    default: ""
    }
  }

  /// JavaScript truthiness of the author (`if (doc.author)`).
  var hasAuthor: Bool { !(author ?? "").isEmpty }
}

/// Included and excluded values of one filter key (`splitFilter`).
struct FilterSplit {
  var inc: JSSet?
  var exc: JSSet

  init(_ values: [String]) {
    var inc: [String] = [], exc: [String] = []
    for v in values {
      if v.hasPrefix("-") { exc.append(String(v.dropFirst())) } else { inc.append(v) }
    }
    self.inc = inc.isEmpty ? nil : JSSet(inc)
    self.exc = JSSet(exc)
  }
}

/// One compiled slice (`compileSpec`).
public final class SliceSpec {
  let which: String
  let years: (Int, Int)
  let fStr: String
  let syn: Int
  let warnings: [String]
  /// Collection ids in scope, in collection order (a JS Set's insertion order).
  let collIds: [Int]
  let collSet: Set<Int>
  let notRateEligible: [String]
  let facets: [(key: String, split: FilterSplit)]
  let lang: FilterSplit
  let strandLangs: JSSet?

  init(which: String, years: (Int, Int), fStr: String, syn: Int, warnings: [String], collIds: [Int], notRateEligible: [String],
       facets: [(key: String, split: FilterSplit)], lang: FilterSplit, strandLangs: JSSet?) {
    self.which = which
    self.years = years
    self.fStr = fStr
    self.syn = syn
    self.warnings = warnings
    self.collIds = collIds
    collSet = Set(collIds)
    self.notRateEligible = notRateEligible
    self.facets = facets
    self.lang = lang
    self.strandLangs = strandLangs
  }

  /// `spec.langOk(plang, fc, docLang)`: RF-1 language gate plus the slice's own language filter.
  func langOk(_ plang: String, _ fc: String, _ docLang: String?) -> Bool {
    Expressions.langAdmits(strandLangs, plang, fc, docLang) && (lang.inc == nil || lang.inc!.contains(plang)) && !lang.exc.contains(plang)
  }

  /// `facetsPass(doc, spec)`.
  func facetsPass(_ doc: ScopeDoc) -> Bool {
    if syn == 0 && doc.syn { return false }
    for (k, s) in facets {
      let v = doc.facet(k)
      if let inc = s.inc, !inc.contains(v) { return false }
      if s.exc.contains(v) { return false }
    }
    return true
  }
}

/// The loaded scope of a comparison.
public final class Scope {
  /// Collections in the order the reference's Map holds them.
  let collectionList: [CollectionInfo]
  let collections: [Int: CollectionInfo]
  let corpusID: Int?
  let exprs: [ResolvedExpression]
  let strandLangs: JSSet?
  let specs: [SliceSpec]
  let docs: [ScopeDoc]
  let docIndex: [Int: ScopeDoc]
  let toggles: Toggles
  let cutoffs: AsSavedCutoffs?

  init(collectionList: [CollectionInfo], corpusID: Int?, exprs: [ResolvedExpression], strandLangs: JSSet?, specs: [SliceSpec],
       docs: [ScopeDoc], toggles: Toggles, cutoffs: AsSavedCutoffs?) {
    self.collectionList = collectionList
    collections = Dictionary(uniqueKeysWithValues: collectionList.map { ($0.id, $0) })
    self.corpusID = corpusID
    self.exprs = exprs
    self.strandLangs = strandLangs
    self.specs = specs
    self.docs = docs
    docIndex = Dictionary(uniqueKeysWithValues: docs.map { ($0.id, $0) })
    self.toggles = toggles
    self.cutoffs = cutoffs
  }

  func collection(slug: String) -> CollectionInfo? { collectionList.first { jsEqual($0.slug, slug) } }
}

/// Loading the scope.
public enum Scopes {
  static let facetKeys = ["kind", "culture", "field", "community", "basis"]

  /// Every collection with its corpus slug (`loadCollections`).
  static func loadCollections(_ c: Connection) throws -> [CollectionInfo] {
    try c.rows(AnalysisSQL.collections) { r in
      CollectionInfo(id: r.i(0), corpusID: r.i(1), slug: r.text(2), name: r.text(3), domain: r.text(4), modality: r.text(5),
                     unit: r.text(6), sampling: r.text(7), rateEligible: r.i(8) == 1, coverageGate: r.iOrNil(9),
                     exportTextAllowed: r.i(10) == 1, synthetic: r.i(11) == 1, license: r.textOrNil(12),
                     selectionNote: r.textOrNil(13), corpusSlug: r.text(15))
    }
  }

  static func compileSpec(_ slice: SliceRequest, _ which: String, collections: [CollectionInfo], corpusID: Int?,
                          strandLangs: JSSet?) -> SliceSpec {
    var warnings: [String] = []
    let f = ViewState.parseFilter(slice.f, warnings: &warnings)
    let coll = FilterSplit(f.coll)
    let facets = facetKeys.map { k -> (key: String, split: FilterSplit) in
      let vals: [String] = switch k {
      case "kind": f.kind
      case "culture": f.culture
      case "field": f.field
      case "community": f.community
      default: f.basis
      }
      return (k, FilterSplit(vals))
    }
    let lang = FilterSplit(f.lang)
    for v in coll.inc ?? JSSet() where !collections.contains(where: { jsEqual($0.slug, v) }) {
      warnings.append("unknown collection '\(v)' in the filter")
    }
    var collIds: [Int] = []
    var notRateEligible: [String] = []
    for c in collections {
      if let corpusID, c.corpusID != corpusID { continue }
      if let inc = coll.inc, !inc.contains(c.slug) { continue }
      if coll.exc.contains(c.slug) { continue }
      if f.syn == 0 && c.synthetic { continue }
      if !c.rateEligible || c.unit == "none" {
        notRateEligible.append(c.slug)
        continue
      }
      if !collIds.contains(c.id) { collIds.append(c.id) }
    }
    return SliceSpec(which: which, years: slice.years, fStr: slice.f, syn: f.syn, warnings: warnings, collIds: collIds,
                     notRateEligible: notRateEligible, facets: facets, lang: lang, strandLangs: strandLangs)
  }

  /// `assignTerciles(docs)`: prominence terciles within a collection for documents that have none.
  static func assignTerciles(_ docs: [ScopeDoc]) {
    var byColl: [Int: [ScopeDoc]] = [:]
    var order: [Int] = []
    for d in docs where d.tercile == nil && d.prominence != nil {
      if byColl[d.coll] == nil { order.append(d.coll) }
      byColl[d.coll, default: []].append(d)
    }
    for coll in order {
      let list = byColl[coll]!.jsSorted { x, y in
        let p = x.prominence! - y.prominence!
        return p != 0 ? p : Double(x.id - y.id)
      }
      let n = list.count
      for (i, d) in list.enumerated() { d.tercile = 1 + min(2, (3 * i) / n) }
    }
  }

  /// `loadScope(db, {exprs, slices, toggles, corpus, cutoffs})`.
  public static func load(_ c: Connection, exprs: [ResolvedExpression], slices: [SliceRequest], toggles: Toggles,
                          corpus: String?, cutoffs: AsSavedCutoffs?) throws -> Scope {
    let collections = try loadCollections(c)
    var corpusID: Int?
    if let corpus, !corpus.isEmpty {
      corpusID = try c.first(AnalysisSQL.corpusBySlug, [.text(corpus)]) { $0.i(0) }
      if corpusID == nil && Vocab.virtualCorpora.contains(key: corpus) {
        throw ScrollsError.badRequest(
          .validation,
          "Compare reads one corpus at a time; '\(corpus)' spans \(corpus == "real" ? "every real corpus" : "several corpora").",
          hint: "Compare the expression in one member corpus (its id is in the strand's members), e.g. cipher or stemm.",
          detail: ["field": "corpus"])
      }
      if corpusID == nil {
        throw ScrollsError.badRequest(.validation, "Unknown corpus '\(corpus)'.", hint: "Use demo, cipher, stemm or user.",
                                      detail: ["field": "corpus"])
      }
    } else {
      var ids: [Int?] = []
      for e in exprs where !ids.contains(where: { $0 == e.corpusID }) { ids.append(e.corpusID) }
      if ids.count == 1, let only = ids[0] { corpusID = only }
    }
    var strandLangs: JSSet?
    var anyLanguage = false
    for e in exprs {
      guard let langs = e.langs else {
        anyLanguage = true
        break
      }
      var s = strandLangs ?? JSSet()
      for l in langs { s.insert(l) }
      strandLangs = s
    }
    if anyLanguage { strandLangs = nil }
    let specs = slices.enumerated().map { i, s in
      compileSpec(s, i == 0 ? "a" : "b", collections: collections, corpusID: corpusID, strandLangs: strandLangs)
    }
    var union: [Int] = []
    for s in specs { for id in s.collIds where !union.contains(id) { union.append(id) } }
    let idsJSON = jsonArray(union)

    let filter = SliceRequests.ScopeFilter(cutoffs)
    let liveArgs: [SQLValue] = switch filter {
    case .live: []
    case .at(let at): [.text(at)]
    case .batch(let b): [.int(Int64(b))]
    case .atBatch(let at, let b): [.text(at), .int(Int64(b))]
    }
    let docs = try c.rows(AnalysisSQL.scopeDocs(filter), liveArgs + [.text(idsJSON)]) { ScopeDoc(row: $0) }
    var index: [Int: ScopeDoc] = [:]
    for d in docs { index[d.id] = d }
    let s = try c.prepared(AnalysisSQL.scopeTokens(filter))
    try s.bind(liveArgs + [.text(idsJSON)])
    while let r = try s.step() {
      index[r.i(0)]?.tok.append(DocTok(plang: r.text(1), fc: r.text(2), tokens: r.i(3)))
    }
    for e in exprs {
      let h = try c.prepared(AnalysisSQL.scopeHits)
      try h.bind(.int(Int64(e.id)), .int(Int64(e.run)))
      while let r = try h.step() {
        index[r.i(0)]?.hits.append(DocHit(plang: r.text(1), fc: r.text(2), n: r.i(3), names: r.i(4), expr: e.id))
      }
    }
    assignTerciles(docs)
    return Scope(collectionList: collections, corpusID: corpusID, exprs: exprs, strandLangs: strandLangs, specs: specs,
                 docs: docs, toggles: toggles, cutoffs: cutoffs)
  }
}
