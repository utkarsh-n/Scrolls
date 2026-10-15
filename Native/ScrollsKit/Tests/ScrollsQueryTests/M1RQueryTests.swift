// OWNER: N3
// The read path on a clone of the m1r snapshot (IOS-SPEC §8.5 N3 tests; mac proxies of the §5 rows):
//  · conservation at every tier for 50 deterministic filter combinations: Σ bin n + Σ wash n + undated + scheduled = n,
//    per lane and strand, with the tiles covering the whole dated extent (SPEC §1.7);
//  · offsets 100% exact: every occurrence's [start, end) cuts, from the original, exactly a counted variant form, and a
//    passage's highlights sit at the same offsets relative to its text;
//  · cube = SQL denominators on 1,000 slices: the slice cube's denominators equal the §3.2 SQL over doc_tokens/doc_bin
//    (L0–L3) and the per-document day rows (L4, L5), lane by lane and bin by bin, tokens and documents;
//  · export_text_allowed = 0 respected in every format (JSON, JSONL, CSV): no text, `text_withheld` set;
//  · the statement catalogue: EXPLAIN QUERY PLAN of every ScrollsQuery statement on m1r finds no unindexed scan of a
//    large table unless the statement says why.
// Runs when SCROLLS_QUERY_M1R=1 and ~/Developer/scrolls-snapshots/m1r exists (check.sh read).

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsQuery
import ScrollsStore
import Testing

@Suite("m1r read path", .enabled(if: M1R.enabled, "needs SCROLLS_QUERY_M1R=1 and the m1r snapshot"), .serialized)
struct M1RQueryTests {
  static let facets = ["community", "language", "kind", "domain", "date_basis", "collection", "modality"]
  static let filterChoices = ["", "syn:1", "lang:en", "lang:-en", "basis:-estimated", "kind:song", "kind:-song",
                              "community:classroom", "community:hiphop,classroom", "kind:memo,bulletin;lang:en"]
  static let toggleKeys = ["tr", "ds", "ap", "dup", "nm", "est", "bp"]

  /// The deterministic filter combinations (the reference's own mulberry32).
  static func combinations(_ n: Int, seed: UInt32) -> [(expr: Int, facet: String, f: String, toggles: [String: Int], order: String)] {
    var rng = Mulberry32(seed: seed)
    func pick<T>(_ xs: [T]) -> T { xs[Int(rng.next() * Double(xs.count)) % xs.count] }
    return (0..<n).map { _ in
      var t: [String: Int] = [:]
      for k in toggleKeys where rng.next() < 0.3 { t[k] = (Vocab.toggleDefaults[k] ?? 0) == 1 ? 0 : 1 }
      return (pick([1, 2, 3, 4]), pick(facets), pick(filterChoices), t, pick(["first_observed", "total_n", "alphabetical"]))
    }
  }

  static func def(_ c: Connection, expr: Int, facet: String, f: String, toggles: [String: Int], order: String = "first_observed") throws -> QueryDef {
    let req = try CanonicalRequest.make(TimelineQueryRequest(
      strands: [StrandRequest(type: "expression", ref: .int(expr))], corpus: "demo",
      lanes: LanesRequest(facet: facet, order: order, max: 48), f: f, toggles: toggles))
    return try QueryDefs.build(c, req).def
  }

  /// Tile indices covering the corpus's dated extent at a tier.
  static func tileList(_ c: Connection, _ def: QueryDef, _ tier: String) throws -> [Int] {
    guard let ext = try c.prepared(TimelineSQL.datedExtent).bindingFirst([.text(SQLJSON.ints(def.corpusIds))], { r in
      (r.intOrNil(0).map(Int.init), r.intOrNil(1).map(Int.init), r.intOrNil(2).map(Int.init), r.intOrNil(3).map(Int.init))
    }), let yLo = ext.0, let yHi = ext.1, let dLo = ext.2, let dHi = ext.3 else { return [] }
    let level = Slices.tiers.firstIndex(of: tier)!
    let b0 = SliceCube.binOfDay(dLo, yLo, level), b1 = SliceCube.binOfDay(dHi, yHi, level)
    return Array(DayMath.floorDiv(b0, 64)...DayMath.floorDiv(b1, 64))
  }

  @Test("conservation at every tier for 50 filter combinations")
  func conservation() throws {
    let c = try M1R.open()
    defer { c.close() }
    var checked = 0
    var failures: [String] = []
    for (i, combo) in Self.combinations(50, seed: 1994).enumerated() {
      let def = try Self.def(c, expr: combo.expr, facet: combo.facet, f: combo.f, toggles: combo.toggles, order: combo.order)
      let q = try TimelineQuery.run(c, def)
      // every lane, visible or folded: the conservation law holds per lane and strand
      var strands: [String: [String: LaneStrandCounts]] = [:]
      for l in q.lanes { strands[l.key] = l.strands ?? [:] }
      #expect(q.other.lanes == 0, "combination \(i): lanes folded although max = 48")
      for l in q.lanes {
        for (k, s) in l.strands ?? [:] where s.dated + s.undated + s.scheduled != s.n {
          failures.append("combo \(i) \(l.key)/\(k): dated \(s.dated) + undated \(s.undated) + scheduled \(s.scheduled) ≠ n \(s.n)")
        }
      }
      for tier in Slices.tiers {
        let list = try Self.tileList(c, def, tier)
        var bins: [String: Int] = [:], washes: [String: Int] = [:]
        for chunk in stride(from: 0, to: list.count, by: 64) {
          let t = try Tiles.compute(c, def, tier, Array(list[chunk..<min(list.count, chunk + 64)]))
          for tile in t.tiles {
            for (lane, tl) in tile.lanes { for (s, cells) in tl.strands { bins["\(lane)|\(s)", default: 0] += cells.reduce(0) { $0 + $1.n } } }
            for w in tile.washes where w.owner != false { washes["\(w.lane)|\(w.strand.description)", default: 0] += w.n }
          }
        }
        for (lane, ss) in strands {
          for (s, counts) in ss {
            let key = "\(lane)|\(s)"
            let b = bins[key] ?? 0, w = washes[key] ?? 0
            checked += 1
            if b + w != counts.dated {
              failures.append("combo \(i) \(tier) \(key): Σ bins \(b) + Σ washes \(w) ≠ dated \(counts.dated) (n \(counts.n))")
            }
            if w != (counts.washesByTier[tier] ?? 0) {
              failures.append("combo \(i) \(tier) \(key): Σ washes \(w) ≠ washes_by_tier \(counts.washesByTier[tier] ?? 0)")
            }
          }
        }
      }
    }
    #expect(checked > 0)
    #expect(failures.isEmpty, "\(failures.count) conservation failures; first: \(failures.prefix(5).joined(separator: " | "))")
    report("conservation", ["combinations": 50, "lane_strand_tier_checks": .number(Double(checked)), "failures": .number(Double(failures.count))])
  }

  @Test("offsets exact: every occurrence cuts a counted variant form from the original")
  func offsetsExact() throws {
    let c = try M1R.open()
    defer { c.close() }
    let text = TextAccess(store: InlineTextStore())
    let rows = try c.prepared(dynamic: """
      SELECT o.id, o.expression_id, o.passage_id, o.document_id, o.start_off, o.end_off, p.field, p.start_off, p.end_off, v.norm
        FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN expression_variant v ON v.id = o.variant_id
        JOIN expression_state s ON s.expression_id = o.expression_id AND s.run_id = o.run_id ORDER BY o.id
      """).all { r in
      (occ: r.int(0), expr: r.int(1), passage: r.int(2), doc: r.int(3), start: Int(r.int(4)), end: Int(r.int(5)), field: r.text(6),
       pStart: Int(r.int(7)), pEnd: Int(r.int(8)), norm: r.text(9))
    }
    #expect(rows.count >= 585, "the demo's current runs hold 585 occurrences (got \(rows.count))")
    var bad: [String] = []
    for o in rows {
      guard let base = try text.base(c, doc: o.doc, field: o.field) else { bad.append("occ \(o.occ): no text"); continue }
      guard o.start >= o.pStart, o.end <= o.pEnd, o.end <= base.count else { bad.append("occ \(o.occ): outside its passage"); continue }
      let cut = String(decoding: base[o.start..<o.end], as: UTF16.self)
      let folded = Tokenizer.tokens(cut).tokens.joined(separator: " ")
      if !folded.utf16.elementsEqual(o.norm.utf16) { bad.append("occ \(o.occ): '\(cut)' folds to '\(folded)', not '\(o.norm)'") }
    }
    // the passage endpoint puts each highlight at the occurrence's offsets, relative to the passage text
    for o in rows.enumerated().filter({ $0.offset % 5 == 0 }).map(\.element) {
      let p = try Reading.passage(c, text: text, id: o.passage, context: false, expr: [o.expr], occ: o.occ)
      let h = p.highlights.first { $0.occ?.rawValue == o.occ }
      if h?.start != o.start - o.pStart || h?.end != o.end - o.pStart {
        bad.append("passage \(o.passage): highlight of occ \(o.occ) at \(h.map { "[\($0.start), \($0.end))" } ?? "none"), want [\(o.start - o.pStart), \(o.end - o.pStart))")
      }
      let units = Array(p.text.utf16)
      if o.end - o.pStart <= units.count {
        let cut = String(decoding: units[(o.start - o.pStart)..<(o.end - o.pStart)], as: UTF16.self)
        if !Tokenizer.tokens(cut).tokens.joined(separator: " ").utf16.elementsEqual(o.norm.utf16) {
          bad.append("passage \(o.passage): the highlight text '\(cut)' is not '\(o.norm)'")
        }
      }
    }
    #expect(bad.isEmpty, "\(bad.count) offset failures; first: \(bad.prefix(5).joined(separator: " | "))")
    report("offsets", ["occurrences": .number(Double(rows.count)), "failures": .number(Double(bad.count))])
  }

  /// The §3.2 SQL denominator of a def: lane × bin → (tokens, docs), over documents that fit the bin.
  static func sqlDenominators(_ c: Connection, _ def: QueryDef, _ langs: LangSpec, _ tier: String) throws -> [String: (Double, Int)] {
    let level = Slices.tiers.firstIndex(of: tier)!
    let cols = RowCols("t")
    let slice = SliceSQL.sliceWhere(def, cols, langs)
    let lane = def.lanes.facet == "cluster" ? "NULL" : SliceSQL.facet(def.lanes.facet, cols)
    let uc = SliceSQL.unitClass(def.lanes.facet, cols)
    func key(_ lv: String?, _ ucv: String) -> String { def.lanes.facet == "cluster" ? "~\(ucv)" : Lanes.key(def.lanes.facet, lv, ucv) }
    var out: [String: (Double, Int)] = [:]
    if level <= 3 {
      let s = try c.prepared(dynamic: """
        SELECT \(lane) AS lv, \(uc) AS uc, b.bin, SUM(t.tokens), COUNT(DISTINCT t.document_id)
          FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
          JOIN doc_bin b ON b.document_id = d.id AND b.level = ? WHERE \(slice.sql) GROUP BY lv, uc, b.bin
        """)
      try s.bind([.int(Int64(level))] + slice.params)
      for r in try s.all({ ($0.textOrNil(0), $0.text(1), Int($0.int(2)), $0.double(3), Int($0.int(4))) }) {
        out["\(key(r.0, r.1))|\(r.2)"] = (r.3, r.4)
      }
      return out
    }
    let s = try c.prepared(dynamic: """
      SELECT \(lane) AS lv, \(uc) AS uc, t.document_id, SUM(t.tokens), d.lo_day, d.hi_day, d.y_lo, d.y_hi
        FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
        WHERE \(slice.sql) AND d.chrono_status = 'dated' AND d.hi_day - d.lo_day <= 30 GROUP BY lv, uc, t.document_id
      """)
    try s.bind(slice.params)
    for r in try s.all({ ($0.textOrNil(0), $0.text(1), $0.int(2), $0.double(3), Int($0.int(4)), Int($0.int(5)), $0.intOrNil(6).map(Int.init), $0.intOrNil(7).map(Int.init)) }) {
      guard Slices.fitsTier(yLo: r.6, yHi: r.7, loDay: r.4, hiDay: r.5, tier) else { continue }
      let k = "\(key(r.0, r.1))|\(SliceCube.binOfDay(r.4, r.6 ?? 0, level))"
      let prev = out[k] ?? (0, 0)
      out[k] = (prev.0 + r.3, prev.1 + 1)
    }
    return out
  }

  @Test("cube = SQL denominators on 1,000 slices")
  func cubeEqualsSQL() throws {
    let c = try M1R.open()
    defer { c.close() }
    var rng = Mulberry32(seed: 1928)
    func pick<T>(_ xs: [T]) -> T { xs[Int(rng.next() * Double(xs.count)) % xs.count] }
    let corpora: [(slug: String, id: Int64)] = [("demo", 1), ("cipher", 2)]
    let cipherFilters = ["", "lang:en", "lang:hi", "lang:gu", "lang:en,fr", "coll:cipher-gutenberg", "coll:-cipher-gutenberg",
                         "kind:book", "kind:-book", "basis:-estimated", "culture:in", "lang:es;kind:book"]
    let langSets: [LangSpec] = [.any, .list(["en", "und", "und-Latn"]), .list(["hi"]), .list(["gu"]), .list(["fr", "und", "und-Latn"]),
                                .list(["en", "es", "fr", "und", "und-Latn"])]
    var slices = 0, keys = 0
    var bad: [String] = []
    for i in 0..<1000 {
      let corpus = i % 4 == 3 ? corpora[1] : corpora[0]
      let facet = pick(Self.facets)
      let f = corpus.slug == "demo" ? pick(Self.filterChoices) : pick(cipherFilters)
      var toggles: [String: Int] = [:]
      for k in Self.toggleKeys where rng.next() < 0.25 { toggles[k] = (Vocab.toggleDefaults[k] ?? 0) == 1 ? 0 : 1 }
      let req = try CanonicalRequest.simple(corpus: corpus.slug, strands: [], facet: facet, f: f, toggles: toggles)
      let def = QueryDef(corpus: corpus.slug, corpusId: corpus.id, corpusIds: [corpus.id], virtual: false, synthetic: corpus.slug == "demo",
                         strands: [], lanes: req.lanes, f: req.f, toggles: req.toggles, timeBasis: "publication", cutoffs: nil, cluster: nil)
      let langs = pick(langSets)
      let tier = pick(Slices.tiers)
      let cube = try CubeSlice.denominators(c, def, langs, tier)
      let sql = try Self.sqlDenominators(c, def, langs, tier)
      slices += 1
      let cubeKeys = Set(cube.pairs.filter { $0.value.tokens > 0 || $0.value.docs > 0 }.map(\.key))
      let sqlKeys = Set(sql.filter { $0.value.0 > 0 || $0.value.1 > 0 }.map(\.key))
      if cubeKeys != sqlKeys {
        bad.append("slice \(i) \(corpus.slug) \(facet) f='\(f)' \(tier): keys differ (cube only \(cubeKeys.subtracting(sqlKeys).sorted().prefix(3)), sql only \(sqlKeys.subtracting(cubeKeys).sorted().prefix(3)))")
        continue
      }
      for k in cubeKeys {
        keys += 1
        let a = cube[k]!, b = sql[k]!
        if a.tokens != b.0 || a.docs != b.1 {
          bad.append("slice \(i) \(corpus.slug) \(facet) f='\(f)' \(tier) \(k): cube \(a.tokens)/\(a.docs) ≠ SQL \(b.0)/\(b.1)")
          break
        }
      }
    }
    #expect(slices == 1000 && keys > 0)
    #expect(bad.isEmpty, "\(bad.count) of 1,000 slices differ; first: \(bad.prefix(4).joined(separator: " | "))")
    report("cube-vs-sql", ["slices": .number(Double(slices)), "lane_bin_keys": .number(Double(keys)), "failures": .number(Double(bad.count))])
  }

  @Test("export_text_allowed = 0: no text in JSON, JSONL or CSV, text_withheld set")
  func exportTextWithheld() throws {
    let path = try M1R.freshClone("withheld")
    defer { try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path) }
    do {
      let w = try Connection(path: path, mode: .readWrite, profile: .reference)
      defer { w.close() }
      try w.prepared(dynamic: "UPDATE collection SET export_text_allowed = 0 WHERE slug = 'demo-world'").run()
    }
    let c = try Connection(path: path, mode: .readOnly, profile: .reference)
    defer { c.close() }
    let text = TextAccess(store: InlineTextStore())
    // the passage texts of the expression's occurrences: none of them may appear in any export
    let passages = try c.prepared(dynamic: """
      SELECT DISTINCT p.document_id, p.field, p.start_off, p.end_off FROM occurrence o JOIN passage p ON p.id = o.passage_id
        JOIN expression_state s ON s.expression_id = o.expression_id AND s.run_id = o.run_id WHERE o.expression_id = 1
      """).all { ($0.int(0), $0.text(1), Int($0.int(2)), Int($0.int(3))) }
    let samples = try passages.prefix(40).map { p in String(decoding: try text.passage(c, doc: p.0, field: p.1, start: p.2, end: p.3), as: UTF16.self) }
      .filter { $0.utf16.count >= 40 }
    #expect(!samples.isEmpty)
    let state = "#v=1&c=demo&s=e1"
    var checked = 0
    for what in ["occurrences", "passages"] {
      for format in ["json", "jsonl", "csv"] {
        let file = try Exports.export(c, text: text, view: nil, state: state, what: what, format: format, tier: "L2")
        checked += 1
        #expect(file.rows > 0, "\(what).\(format): no rows")
        for s in samples { #expect(!file.body.contains(s), "\(what).\(format) carries the text of a withheld passage") }
        #expect(file.body.contains("text_withheld"), "\(what).\(format) does not say text_withheld")
      }
    }
    report("export-text-withheld", ["formats_checked": .number(Double(checked)), "passages_sampled": .number(Double(samples.count))])
  }

  @Test("the statement catalogue on m1r: no unindexed scan of a large table without a reason")
  func catalogPlans() throws {
    let c = try M1R.open()
    defer { c.close() }
    let all: [SQL] = QueryDefSQL.all + ClusterSQL.all + SearchSQL.all + TagIndexSQL.all + ExportSQL.all + InputsKeySQL.all + MatchSQL.all
      + ScopeSQL.all + CubeSQL.all + ReadSQL.all + TimelineSQL.all
    #expect(Set(all.map(\.id)).count == all.count, "duplicate statement ids")
    let big = ["passage", "document", "relationship", "doc_tag", "expr_doc", "occurrence", "date_assertion"]
    var scans: [String] = []
    for sql in all {
      _ = try c.prepared(sql)
      guard sql.scan == .indexOnly, !sql.text.hasPrefix("PRAGMA") else { continue }
      let plan = try c.prepared(dynamic: "EXPLAIN QUERY PLAN " + sql.text).all { $0.text(3) }
      for line in plan where big.contains(where: { line.hasPrefix("SCAN \($0)") && !line.contains("USING") }) {
        scans.append("\(sql.id): \(line)")
      }
    }
    #expect(scans.isEmpty, "\(scans.joined(separator: " | "))")
    report("sql-catalog", ["statements": .number(Double(all.count)), "unindexed_scans": .number(Double(scans.count))])
  }

  /// Reports/query-m1r-<name>.json (check.sh read lists them).
  func report(_ name: String, _ body: JSONObject) {
    guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
    try? Data((CanonicalJSON.string(.object(body)) + "\n").utf8)
      .write(to: URL(fileURLWithPath: dir).appendingPathComponent("query-m1r-\(name).json"))
  }
}
