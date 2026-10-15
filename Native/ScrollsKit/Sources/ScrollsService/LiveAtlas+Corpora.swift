// OWNER: N2
// Corpora in process (server/routes/corpora.mjs + aggregate/collstats.mjs): corpora with their collections, coverage,
// selection notes, caveats, licences and load status, then the virtual corpus `real`; and the facet counts of a
// corpus under the `f` filter grammar.
// Collection status: the bootstrap writes meta `collection_status:<slug>` ('pending' before phase B reaches the
// collection, 'indexing' while it loads, 'ready' after); without that key a collection is 'ready' when it has documents
// and 'empty' otherwise. Per-collection statistics are memoised by what they read (the collection's import batches by
// status and the passage-quality version), so a materialisation or a review keeps them and a load rescans only the
// collections it touched — one rowid-range pass over that collection's documents.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore
import Synchronization

/// The statements of corpora and facets.
public enum CorporaSQL: SQLCatalog {
  static let corpora = SQL("corpora.corpora", "SELECT id, slug, name, kind, is_synthetic FROM corpus ORDER BY id",
                           scan: .scanOK(reason: "four corpora"))
  static let collections = SQL("corpora.collections", """
    SELECT id, slug, name, domain, modality, unit, sampling, rate_eligible, coverage_gate, selection_note, caveats_json, license,
      is_synthetic FROM collection WHERE corpus_id = ? ORDER BY id
    """, scan: .scanOK(reason: "a corpus holds a handful of collections"))
  static let statuses = SQL("corpora.statuses", "SELECT key, value FROM meta WHERE key LIKE 'collection_status:%' ORDER BY key",
                            scan: .scanOK(reason: "meta is small"))
  static let batchKey = SQL("corpora.batchKey", """
    SELECT status, count(*), max(id) FROM import_batch WHERE collection_id = ? GROUP BY status ORDER BY status
    """, scan: .scanOK(reason: "a collection's batches"))
  static let idRange = SQL("corpora.idRange", "SELECT min(id), max(id) FROM document WHERE collection_id = ?")
  static let docs = SQL("corpora.docs", """
    SELECT chrono_status, basis, y_lo, lo_day, hi_day, date_label FROM document
    WHERE id BETWEEN ? AND ? AND +collection_id = ? AND deleted_at IS NULL
    """, scan: .scanOK(reason: "one collection's rowid range, memoised per batch state"))
  static let tokens = SQL("corpora.tokens", """
    SELECT IFNULL(SUM(t.tokens), 0) FROM doc_tokens t WHERE t.document_id BETWEEN ? AND ? AND t.field_class IN ('text','abstract')
      AND t.document_id IN (SELECT id FROM document WHERE id BETWEEN ? AND ? AND +collection_id = ? AND deleted_at IS NULL)
    """, scan: .scanOK(reason: "one collection's rowid range, memoised per batch state"))
  static let collectionNames = SQL("corpora.collectionNames", "SELECT slug, name FROM collection",
                                   scan: .scanOK(reason: "a few dozen collections"))

  /// The facet columns (`FACET_COLUMNS`), in the reference's order.
  static let facetColumns: [(facet: String, column: String)] = [
    ("community", "d.community"), ("kind", "d.kind"), ("lang", "d.lang_text"), ("basis", "d.basis"), ("coll", "c.slug"),
    ("culture", "d.culture"), ("field", "d.field"),
  ]
  /// The filter WHERE of `filterSql` with every clause present: ?1 corpus, then per facet column an include list and an
  /// exclude list (JSON arrays or NULL), then ?16 = 1 keeps synthetic documents.
  static let filterWhere: String = {
    var w = ["d.deleted_at IS NULL", "(?1 IS NULL OR k.slug = ?1)"]
    for (i, f) in facetColumns.enumerated() {
      let inc = 2 + 2 * i, exc = 3 + 2 * i
      w.append("(?\(inc) IS NULL OR \(f.column) IN (SELECT value FROM json_each(?\(inc))))")
      w.append("(?\(exc) IS NULL OR \(f.column) IS NULL OR \(f.column) NOT IN (SELECT value FROM json_each(?\(exc))))")
    }
    w.append("(?16 = 1 OR d.is_synthetic = 0)")
    return w.joined(separator: " AND ")
  }()
  static let from = "FROM document d JOIN collection c ON c.id = d.collection_id JOIN corpus k ON k.id = c.corpus_id"
  static let facets: [SQL] = facetColumns.map { f in
    SQL("corpora.facet.\(f.facet)", """
      SELECT \(f.column), count(*) AS n \(from) WHERE \(filterWhere) AND \(f.column) IS NOT NULL AND \(f.column) <> ''
      GROUP BY \(f.column) ORDER BY n DESC, \(f.column)
      """, scan: .scanOK(reason: "facet counts read every document of the corpus, as the reference does"))
  }
  static let scope = SQL("corpora.facetScope", """
    SELECT c.slug, c.license, MAX(d.is_synthetic) \(from) WHERE \(filterWhere) GROUP BY c.slug ORDER BY c.slug
    """, scan: .scanOK(reason: "facet counts read every document of the corpus, as the reference does"))

  public static let all: [SQL] = [corpora, collections, statuses, batchKey, idRange, docs, tokens, collectionNames, scope] + facets
}

/// One collection's statistics (collstats.mjs `buildCollectionStats`).
struct CollectionStats: Sendable, Equatable {
  var docs = 0, undated = 0, scheduled = 0, stated = 0, estimated = 0, derived = 0, period = 0, after1928 = 0, tokens = 0
  var loDay: Int64?, loLabel: String?, hiDay: Int64?, hiLabel: String?
}

enum CorporaMemo {
  /// collection id → (key, stats); corpora body → (key, body). Process-wide, keyed by the atlas path.
  static let stats = Mutex<[String: (key: String, stats: CollectionStats)]>([:])
  static let corpora = Mutex<[String: (key: String, body: CorporaResponse)]>([:])
}

/// Labels of facet values (routes/corpora.mjs).
public enum FacetLabels {
  public static let lang = ["en": "English", "fr": "French", "es": "Spanish", "de": "German", "it": "Italian", "pt": "Portuguese",
                            "la": "Latin", "hi": "Hindi", "gu": "Gujarati", "sa": "Sanskrit", "mr": "Marathi", "und": "undetermined",
                            "und-Latn": "undetermined (Latin script)"]
  public static let basis = ["stated": "stated", "estimated": "estimated", "derived": "derived (calendar conversion)",
                             "announced": "announced", "period": "period", "unknown": "undated"]
  public static let culture = ["us": "United States", "in": "India", "fr": "France", "es": "Spain", "gb": "United Kingdom",
                               "mx": "Mexico", "ar": "Argentina", "xx": "not recorded"]
  /// The demo's communities (data/demo/generator.mjs COMMUNITIES).
  public static let communities = ["classroom": "Classroom", "office-lab": "Office & Lab", "hiphop": "Hip-hop", "criticism": "Criticism",
                                   "software": "Software", "gujarati": "Gujarati verse & school", "hindi": "Hindi verse",
                                   "hospital": "Hospital", "literature": "Literature", "workshop-radio": "Workshop & Radio"]

  static func label(_ facet: String, _ value: String, collections: [String: String]) -> String {
    switch facet {
    case "community": return communities[value] ?? value
    case "kind":
      // `value.charAt(0).toUpperCase() + value.slice(1)`; kinds are ASCII (vocab.DOC_KINDS)
      var u = Array(value.utf16)
      if let f = u.first, f >= 0x61 && f <= 0x7A { u[0] = f - 0x20 }
      return String(decoding: u, as: UTF16.self)
    case "lang": return lang[value] ?? value
    case "basis": return basis[value] ?? value
    case "coll": return collections[value] ?? value
    case "culture": return culture[value].map { "\($0) (\(value))" } ?? value
    case "field": return Vocab.stemmLanes.first { $0.key == value }?.label ?? value
    default: return value
    }
  }
}

extension LiveAtlas {
  @concurrent
  public func corpora() async throws -> CorporaResponse {
    let path = location.atlasPath
    return try await reads.read(.interactive, deadline: .seconds(20)) { c in try LiveAtlas.corporaQuery(c, path: path) }
  }

  /// `corporaQuery(db)`.
  static func corporaQuery(_ c: Connection, path: String) throws -> CorporaResponse {
    let version = try Meta.dataVersion(c)
    let statusRows = try c.prepared(CorporaSQL.statuses).all { ($0.text(0), $0.text(1)) }
    let key = "\(version)|" + statusRows.map { "\($0.0)=\($0.1)" }.joined(separator: "|")
    if let hit = CorporaMemo.corpora.withLock({ $0[path] }), hit.key == key { return hit.body }
    var status: [String: String] = [:]
    for (k, v) in statusRows { status[String(k.dropFirst("collection_status:".count))] = v }
    let order = Vocab.corpora.map(\.slug)
    var corpora = try c.prepared(CorporaSQL.corpora).all {
      (id: $0.int(0), slug: $0.text(1), name: $0.text(2), kind: $0.text(3), synthetic: $0.int(4) == 1)
    }
    corpora.sort { (order.firstIndex(of: $0.slug).map { $0 + 1 } ?? 99) < (order.firstIndex(of: $1.slug).map { $0 + 1 } ?? 99) }
    var body: CorporaResponse = []
    for k in corpora {
      let rows = try c.prepared(CorporaSQL.collections).bindingAll([.int(k.id)]) { r in
        (id: r.int(0), slug: r.text(1), name: r.text(2), domain: r.text(3), modality: r.text(4), unit: r.text(5), sampling: r.text(6),
         rateEligible: r.int(7) == 1, coverageGate: r.intOrNil(8), selectionNote: r.textOrNil(9), caveats: r.text(10),
         license: r.textOrNil(11), synthetic: r.int(12) == 1)
      }
      var collections: [CorpusCollection] = []
      for row in rows {
        let s = try collectionStats(c, id: row.id, path: path)
        let caveats = (try? JSONValue.parse(row.caveats)) ?? .array([])
        let span: JSONValue = s.loDay != nil && s.hiDay != nil && s.loLabel != nil && s.hiLabel != nil
          ? .array([.string(s.loLabel!), .string(s.hiLabel!)]) : .null
        collections.append(CorpusCollection(
          slug: row.slug, name: row.name, domain: row.domain, modality: row.modality, unit: row.unit, sampling: row.sampling,
          rateEligible: row.rateEligible, docs: s.docs, tokens: s.tokens, works: row.unit == "works" ? s.docs : 0,
          undated: s.undated, scheduled: s.scheduled, span: span, selectionNote: row.selectionNote,
          caveats: caveats.arrayValue != nil ? caveats : .array([]), license: row.license,
          status: status[row.slug] ?? (s.docs > 0 ? "ready" : "empty"), synthetic: row.synthetic,
          dating: CollectionDating(stated: s.stated, estimated: s.estimated, derived: s.derived, period: s.period,
                                   announced: s.scheduled, undated: s.undated, after1928: s.after1928),
          samplingLabel: Copy.samplingLabels[row.sampling] ?? row.sampling, coverageGate: row.coverageGate.map { Int($0) }))
      }
      body.append(Corpus(slug: k.slug, name: k.name, kind: k.kind, synthetic: k.synthetic, collections: collections))
    }
    // the virtual corpus: every non-synthetic corpus that holds documents (never the demo)
    let members = body.filter { !$0.synthetic && $0.slug != "demo" && $0.collections.contains { $0.docs > 0 } }.map(\.slug)
    if let v = Vocab.virtualCorpora["real"] {
      body.append(Corpus(slug: v.slug, name: v.name, kind: v.kind, synthetic: false, collections: [], virtual: true,
                         members: members, available: !members.isEmpty, description: v.description))
    }
    let result = body
    CorporaMemo.corpora.withLock { $0[path] = (key, result) }
    return body
  }

  /// `collectionStats(db, c)`: memoised by the collection's batches by status and the quality version.
  static func collectionStats(_ c: Connection, id: Int64, path: String) throws -> CollectionStats {
    let batches = try c.prepared(CorporaSQL.batchKey).bindingAll([.int(id)]) { "\($0.text(0)):\($0.int(1)):\($0.int(2))" }
    let key = "\(path)#\(id)|\(batches.joined(separator: ","))|\(try Meta.get(c, "quality_version") ?? "0")"
    if let hit = CorporaMemo.stats.withLock({ $0["\(path)#\(id)"] }), hit.key == key { return hit.stats }
    var s = CollectionStats()
    let range = try c.prepared(CorporaSQL.idRange).bindingFirst([.int(id)]) { ($0.intOrNil(0), $0.intOrNil(1)) }
    if let lo = range?.0, let hi = range?.1 {
      let rows = try c.prepared(CorporaSQL.docs)
      try rows.bind(.int(lo), .int(hi), .int(id))
      while let r = try rows.step() {
        s.docs += 1
        let cs = r.text(0)
        if cs == "undated" { s.undated += 1; continue }
        if cs == "scheduled" { s.scheduled += 1; continue }
        switch r.text(1) {
        case "stated": s.stated += 1
        case "estimated": s.estimated += 1
        case "derived": s.derived += 1
        case "period": s.period += 1
        default: break
        }
        if let y = r.intOrNil(2), y > 1928 { s.after1928 += 1 }
        let loDay = r.int(3), hiDay = r.int(4)
        if s.loDay == nil || loDay < s.loDay! { s.loDay = loDay; s.loLabel = r.text(5) }
        if s.hiDay == nil || hiDay > s.hiDay! { s.hiDay = hiDay; s.hiLabel = r.text(5) }
      }
      s.tokens = Int(try c.prepared(CorporaSQL.tokens).bindingFirst([.int(lo), .int(hi), .int(lo), .int(hi), .int(id)]) { $0.int(0) } ?? 0)
    }
    let result = s
    CorporaMemo.stats.withLock { $0["\(path)#\(id)"] = (key, result) }
    return s
  }

  @concurrent
  public func facets(_ r: FacetsRequest) async throws -> FacetsResponse {
    if let corpus = r.corpus, !LiveAtlas.isCorpusSlug(corpus) {
      throw ScrollsError.badRequest(.validation, "'\(corpus)' is not a corpus slug.", hint: "Use demo, cipher, stemm or user.")
    }
    return try await reads.read(.interactive, deadline: .seconds(15)) { c in try LiveAtlas.facetsQuery(c, f: r.f ?? "", corpus: r.corpus) }
  }

  /// The values of one facet of a parsed filter.
  static func filterValues(_ f: ViewState.Filters, _ facet: String) -> [String] {
    switch facet {
    case "lang": f.lang
    case "kind": f.kind
    case "coll": f.coll
    case "culture": f.culture
    case "field": f.field
    case "community": f.community
    case "basis": f.basis
    default: []
    }
  }

  /// `/^[a-z][a-z0-9-]{0,31}$/`.
  static func isCorpusSlug(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard let f = u.first, f >= 0x61 && f <= 0x7A, u.count <= 32 else { return false }
    return u.dropFirst().allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }
  }

  /// `facetsQuery(db, {f, corpus})`.
  static func facetsQuery(_ c: Connection, f: String, corpus: String?) throws -> FacetsResponse {
    var warnings: [String] = []
    let filter = ViewState.parseFilter(f, warnings: &warnings)
    var binds: [SQLValue] = [.string(corpus)]
    for (facet, _) in CorporaSQL.facetColumns {
      let values = LiveAtlas.filterValues(filter, facet)
      let inc = values.filter { !$0.hasPrefix("-") }, exc = values.filter { $0.hasPrefix("-") }.map { String($0.dropFirst()) }
      binds.append(inc.isEmpty ? .null : .text(CanonicalJSON.string(.array(inc.map(JSONValue.string)))))
      binds.append(exc.isEmpty ? .null : .text(CanonicalJSON.string(.array(exc.map(JSONValue.string)))))
    }
    binds.append(.int(filter.syn == 0 ? 0 : 1))
    var names: [String: String] = [:]
    for (slug, name) in try c.prepared(CorporaSQL.collectionNames).all({ ($0.text(0), $0.text(1)) }) { names[slug] = name }
    var facets: [String: [FacetValue]] = [:]
    for (i, f) in CorporaSQL.facetColumns.enumerated() {
      let s = try c.prepared(CorporaSQL.facets[i])
      try s.bind(binds)
      let rows = try s.all { r -> FacetValue in
        let value = r.text(0)
        return FacetValue(value: value, label: FacetLabels.label(f.facet, value, collections: names), count: Int(r.int(1)))
      }
      if !rows.isEmpty { facets[f.facet] = rows }
    }
    let scope = try c.prepared(CorporaSQL.scope)
    try scope.bind(binds)
    let rows = try scope.all { (slug: $0.text(0), license: $0.textOrNil(1), syn: $0.int(2)) }
    var licenses: [String] = []
    for l in rows.compactMap(\.license) where !licenses.contains(l) { licenses.append(l) }
    let provenance = Provenance(dataVersion: try Meta.dataVersion(c), runIds: [:], tokenizer: StoreVersions.tokenizer,
                                segmenter: StoreVersions.segmenter, synthetic: rows.contains { $0.syn == 1 },
                                collections: rows.map(\.slug), licenses: licenses)
    return FacetsResponse(facets: facets, provenance: provenance)
  }
}

extension Statement {
  /// Binds `values` and maps every row.
  func bindingAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
