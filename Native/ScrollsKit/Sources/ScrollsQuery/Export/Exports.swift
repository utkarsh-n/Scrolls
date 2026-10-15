// OWNER: N3
// Ports of server/export/{manifest,csv,jsonl}.mjs (SPEC §7.3): the manifest that travels with every export (view, state,
// data version, runs with their params, filters, toggles, whether synthetic rows are included, licences and
// attributions) and the export itself — occurrences, passages, aggregates (Σ bins + Σ washes + undated + scheduled =
// total per lane), relationships and annotations — as JSON, JSONL (manifest first line) or CSV (manifest as `#` lines).
// Collections with export_text_allowed = 0 export ids, offsets and locators only: their text fields are null and
// `text_withheld` is 1, in every format. The portable HTML bundle is later (ΔS-14).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Exports.
public enum Exports {
  public static let exportVersion = "1"
  static let whats = ["occurrences", "aggregates", "passages", "relationships", "annotations", "bundle"]
  static let formats = ["json": "application/json; charset=utf-8", "jsonl": "application/x-ndjson; charset=utf-8",
                        "csv": "text/csv; charset=utf-8"]
  static let maxRows = 500_000
  static let syntheticWarning = "Contains SYNTHETIC demonstration data — invented people, texts, dates and links."
  /// Attributions that must travel with values of these sources (§7.3, honesty rule 15): case-insensitive needles.
  static let standardAttributions: [(needles: [String], text: String)] = [
    (["wiktionary", "kaikki"], "Wiktionary (via kaikki.org), CC BY-SA"),
    (["itwofs"], "ItwoFS, CC BY 2.5 (link back per row)"),
    (["ngram"], "Google Books Ngram Viewer (http://books.google.com/ngrams), CC BY 3.0"),
    (["openalex"], "OpenAlex, CC0"),
    (["gutenberg"], "Project Gutenberg texts: public domain in the USA"),
    (["wikisource"], "Wikisource, CC BY-SA"),
  ]
  static let errExportFormat = ErrorCode(rawValue: "E_EXPORT_FORMAT")

  // MARK: state

  /// `resolveState(db, {view, state})`: a saved view by slug, or a state as base64url JSON, base64url of a hash, or a hash.
  public static func resolveState(_ c: Connection, view: String?, state: String?) throws -> (state: ViewState, view: String?) {
    var w: [String] = []
    if let view, !view.isEmpty {
      guard let row = try c.prepared(ExportSQL.savedView).bindingFirst([.text(view)], { ($0.text(0), $0.text(1)) }) else {
        throw ScrollsError(code: .notFound, message: "No saved view '\(view)'.", status: 404)
      }
      return (ViewState.canonicalize((try? JSONValue.parse(row.1)) ?? .object([:]), warnings: &w), row.0)
    }
    guard let state, !state.isEmpty else {
      throw ScrollsErrorFactory.validation("An export needs view=<slug> or state=<…>.", field: "state",
                                           hint: "Export from a saved view, or pass the current state.")
    }
    let s = JSString.trim(state)
    if JSString.hasPrefix(s, "#") || JSString.hasPrefix(s, "v=") {
      return (ViewState.decodeHash(JSString.hasPrefix(s, "#") ? s : "#\(s)").state, nil)
    }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    let text = Data(base64Encoded: b64).map { String(decoding: $0, as: UTF8.self) } ?? ""
    if JSString.hasPrefix(JSString.trim(text), "{"), let v = try? JSONValue.parse(text) {
      return (ViewState.canonicalize(v, warnings: &w), nil)
    }
    if JSString.hasPrefix(text, "#") || JSString.hasPrefix(text, "v=") {
      return (ViewState.decodeHash(JSString.hasPrefix(text, "#") ? text : "#\(text)").state, nil)
    }
    throw ScrollsErrorFactory.validation("state is neither a view-state hash nor base64url JSON.", field: "state")
  }

  // MARK: manifest

  static func toggleJSON(_ def: QueryDef) -> OJ { .obj(def.toggles.map { ($0.key, .int($0.value)) }) }

  /// `buildManifest(db, {view, state, what, format, def, rows})`.
  static func manifest(_ c: Connection, view: String?, state: ViewState?, what: String, format: String, def: QueryDef?,
                       rows: [OJ], rowCount: OJ? = nil) throws -> OJ {
    let prov = try def.map { try Slices.provenance(c, $0) }
    var materialize: [(String, OJ)] = []
    var sampled: [OJ] = []
    for s in def?.strands ?? [] where s.type == "expression" && s.run != nil {
      for m in s.memberRuns {
        let r = try c.prepared(ExportSQL.runInfo).bindingFirst([.int(m.run)]) { ($0.text(0), $0.text(1)) }
        materialize.removeAll { $0.0 == String(m.expr) }
        materialize.append((String(m.expr), .obj([("run", .int(m.run)), ("pipeline", .str(r?.1)),
                                                  ("params", r.flatMap { try? JSONValue.parse($0.0) }.map(OJ.init) ?? .null)])))
      }
      if s.sampled { sampled.append(OJ(s.ref.description == "" ? .null : .int(Int(s.ref.description) ?? 0))) }
    }
    var runIds: [(String, OJ)] = [("materialize", .obj(materialize))]
    if let cl = def?.cluster?.run { runIds.append(("cluster", .int(cl))) }
    var attributions: [String] = []
    if let def {
      let s = try c.prepared(ExportSQL.collections)
      try s.bind([.text(SQLJSON.ints(def.corpusIds))])
      let colls = try s.all { ($0.text(0), $0.textOrNil(1), $0.textOrNil(2), $0.text(3)) }
      for col in colls { if let a = col.2, !a.isEmpty, !attributions.contains(a) { attributions.append(a) } }
      for col in colls {
        let hay = JSString.toLowerCase("\(col.0) \(col.3)")
        for (needles, text) in standardAttributions where needles.contains(where: { JSText.includes(hay, $0) }) {
          if !attributions.contains(text) { attributions.append(text) }
        }
      }
    }
    let synthetic = rows.contains { $0["is_synthetic"] == .num(1) || $0["is_synthetic"] == .bool(true) }
      || (rows.isEmpty && (prov?.synthetic ?? false))
    var m: [(String, OJ)] = [
      ("export_version", .str(exportVersion)), ("generated_at", .str(StoreClock.isoNow())), ("view", .str(view)),
      ("state", state.map { .str(ViewState.encode($0)) } ?? .null), ("what", .str(what)), ("format", .str(format)),
      ("data_version", .int(try Slices.dataVersion(c))), ("run_ids", .obj(runIds)),
      ("filters", def.map { .str(ViewState.formatFilter($0.f)) } ?? .null), ("toggles", def.map(toggleJSON) ?? .null),
      ("synthetic_included", .bool(synthetic)), ("licenses", .arr((prov?.licenses ?? []).map(OJ.str))),
      ("attributions", .arr(attributions.map(OJ.str))), ("collections", .arr((prov?.collections ?? []).map(OJ.str))),
      ("tokenizer", "u61m-1"), ("segmenter", "seg-1"), ("rows", rowCount ?? .int(rows.count)),
      ("text_policy", "Collections with export_text_allowed = 0 export ids, offsets and locators only (text_withheld = true)."),
    ]
    if synthetic { m.append(("warning", .str(syntheticWarning))) }
    if def != nil && (what == "relationships" || what == "bundle") {
      m.append(("relationship_scope", "relationships with an end in a document where a pinned strand is observed (the arcs of this view)"))
    }
    if !sampled.isEmpty {
      m.append(("contexts_sampled", .arr(sampled)))
      m.append(("sampling_note", "Very frequent expressions: aggregate counts are complete; occurrence and passage rows are a stratified sample of ≤ 200 per language and decade."))
    }
    return .obj(m)
  }

  // MARK: rows

  static let occColumns = ["occ", "passage", "document", "title", "lane", "start", "end", "match", "date_label", "date_precision",
                           "date_basis", "date_role", "evidence_status", "review_status", "origin", "source_locator", "is_synthetic",
                           "expression", "variant", "collection", "field", "chrono_status", "name_flag", "context_left",
                           "context_right", "text_withheld"]

  static func occurrenceRows(_ c: Connection, text: TextAccess, _ def: QueryDef) throws -> [OJ] {
    var out: [OJ] = []
    for s in def.strands where s.type == "expression" && s.run != nil {
      let fs = try c.prepared(ExportSQL.variantForms)
      try fs.bind([.int(s.exprId ?? 0)])
      var forms: [Int64: String] = [:]
      for (id, form) in try fs.all({ ($0.int(0), $0.text(1)) }) { forms[id] = form }
      let q = try SliceSQL.occurrences(def, s)
      let rows = try SliceSQL.all(c, SQLPart(OccSQL.exportOccurrences(q.sql), q.params + [.int(Int64(maxRows))]), OccRow.read)
      for r in rows {
        let withheld = !r.exportTextAllowed
        var k: Kwic.Line?
        if !withheld {
          let base = try text.base(c, doc: r.doc, field: r.field) ?? []
          k = Kwic.line(base, start: r.startOff, end: r.endOff, clipStart: r.pStart, clipEnd: r.pEnd)
        }
        out.append(.obj([
          ("occ", .int(r.occ)), ("passage", .int(r.passage)), ("document", .int(r.doc)), ("title", .str(r.title)),
          ("lane", .str(Lanes.key(def.lanes.facet, r.lv, r.uc))), ("start", .int(r.startOff)), ("end", .int(r.endOff)),
          ("match", k.map { .str(JSText.string($0.match)) } ?? .null), ("date_label", .str(r.dateLabel)),
          ("date_precision", .str(r.precision)), ("date_basis", .str(r.basis)), ("date_role", .str(r.dateRole)),
          ("evidence_status", .null), ("review_status", .null), ("origin", .null), ("source_locator", .str(r.sourceURL)),
          ("is_synthetic", .int(r.syn ? 1 : 0)), ("expression", .int(s.exprId ?? 0)),
          ("variant", r.variantId.flatMap { forms[$0] }.map(OJ.str) ?? .null), ("collection", .str(r.collection)),
          ("field", .str(r.field)), ("chrono_status", .str(r.chronoStatus)), ("name_flag", .int(r.nameFlag ? 1 : 0)),
          ("context_left", k.map { .str(JSText.string($0.left)) } ?? .null),
          ("context_right", k.map { .str(JSText.string($0.right)) } ?? .null), ("text_withheld", .int(withheld ? 1 : 0)),
        ]))
      }
    }
    return out
  }

  static let passageColumns = ["passage", "document", "title", "lane", "field", "start", "end", "n", "text", "lang", "date_label",
                               "date_precision", "date_basis", "date_role", "evidence_status", "review_status", "origin",
                               "source_locator", "is_synthetic", "expression", "collection", "text_withheld"]

  static func passageRows(_ c: Connection, text: TextAccess, _ def: QueryDef) throws -> [OJ] {
    var out: [OJ] = []
    for s in def.strands where s.type == "expression" && s.run != nil {
      let q = try SliceSQL.occurrences(def, s)
      let rows = try SliceSQL.all(c, SQLPart(OccSQL.passageGroups(q.sql), q.params + [.int(Int64(maxRows))])) { r in
        (passage: r.int(0), doc: r.int(1), field: r.text(2), pStart: Int(r.int(3)), pEnd: Int(r.int(4)), plang: r.text(5),
         lv: r.textOrNil(6), uc: r.text(7), title: r.textOrNil(8), dateLabel: r.text(9), precision: r.text(10), basis: r.text(11),
         dateRole: r.textOrNil(12), syn: r.int(13), collection: r.text(14), allowed: r.int(15) == 1, n: Int(r.int(16)),
         source: r.textOrNil(17))
      }
      for r in rows {
        let withheld = !r.allowed
        out.append(.obj([
          ("passage", .int(r.passage)), ("document", .int(r.doc)), ("title", .str(r.title)),
          ("lane", .str(Lanes.key(def.lanes.facet, r.lv, r.uc))), ("field", .str(r.field)), ("start", .int(r.pStart)),
          ("end", .int(r.pEnd)), ("n", .int(r.n)),
          ("text", withheld ? .null : .str(JSText.string(JSText.slice(try text.base(c, doc: r.doc, field: r.field) ?? [], r.pStart, r.pEnd)))),
          ("lang", .str(r.plang)), ("date_label", .str(r.dateLabel)), ("date_precision", .str(r.precision)),
          ("date_basis", .str(r.basis)), ("date_role", .str(r.dateRole)), ("evidence_status", .null), ("review_status", .null),
          ("origin", .null), ("source_locator", .str(r.source)), ("is_synthetic", .int(r.syn)), ("expression", .int(s.exprId ?? 0)),
          ("collection", .str(r.collection)), ("text_withheld", .int(withheld ? 1 : 0)),
        ]))
      }
    }
    return out
  }

  static let aggColumns = ["kind", "lane", "strand", "tier", "bin", "date_label", "date_precision", "date_basis", "date_role", "n",
                           "docs", "authors", "denom", "unit", "rate", "ci_lo", "ci_hi", "state", "flags", "dp", "evidence_status",
                           "review_status", "origin", "source_locator", "is_synthetic", "field"]
  static let tierPrecision = ["L0": "millennium", "L1": "century", "L2": "decade", "L3": "year"]

  /// Aggregates at a tier: every cell, every wash (once), and the undated / scheduled amounts per lane.
  static func aggregateRows(_ c: Connection, _ def: QueryDef, tier: String) throws -> [OJ] {
    guard let precision = tierPrecision[tier] else {
      throw ScrollsErrorFactory.validation("Aggregates export at L0–L3 (millennia to years).", field: "tier")
    }
    let ext = try c.prepared(TimelineSQL.datedExtent).bindingFirst([.text(SQLJSON.ints(def.corpusIds))]) { r in
      (r.intOrNil(0).map(Int.init), r.intOrNil(1).map(Int.init))
    }
    var out: [OJ] = []
    let level = ["L0", "L1", "L2", "L3"].firstIndex(of: tier)!
    func tail(_ syn: Int) -> [(String, OJ)] {
      [("evidence_status", .null), ("review_status", .null), ("origin", .null), ("source_locator", .null), ("date_basis", .null),
       ("date_role", .null), ("field", .null), ("is_synthetic", .int(syn))]
    }
    func ordered(_ head: [(String, OJ)], _ syn: Int) -> OJ {
      // the reference's object: its own keys, then `...base` (fields already present keep their place), then is_synthetic
      var keys = head
      for (k, v) in tail(syn) where !keys.contains(where: { $0.0 == k }) { keys.append((k, v)) }
      return .obj(keys)
    }
    if let ext, let lo = ext.0, let hi = ext.1 {
      let w = [1000, 100, 10, 1][level]
      let t0 = DayMath.floorDiv(DayMath.floorDiv(lo, w), 64), t1 = DayMath.floorDiv(DayMath.floorDiv(hi, w), 64)
      let (res, order) = try Tiles.computeWithOrder(c, def, tier, Array(t0...t1))
      for tile in res.tiles {
        for (lane, strandKeys) in (order[tile.tile] ?? OrderedDict()).pairs {
          for strand in Tiles.objectKeyOrder(strandKeys) {
            for cell in tile.lanes[lane]?.strands[strand] ?? [] {
              let bin = tile.bin0 + cell.bin
              out.append(ordered([
                ("kind", "bin"), ("lane", .str(lane)), ("strand", .str(strand)), ("tier", .str(tier)), ("bin", .int(bin)),
                ("date_label", .str(TimelineLists.binLabel(tier, bin))), ("date_precision", .str(precision)), ("n", .int(cell.n)),
                ("docs", .int(cell.docs)), ("authors", .int(cell.authors)), ("denom", .num(cell.denom)), ("unit", .null),
                ("rate", .num(cell.rate)), ("ci_lo", .num(cell.ciLo)), ("ci_hi", .num(cell.ciHi)),
                ("state", .str(Vocab.cellStates[String(cell.state)])), ("flags", .int(cell.flags)), ("dp", .num(cell.dp)),
                ("evidence_status", .null), ("review_status", .null), ("origin", .null), ("source_locator", .null),
                ("date_basis", .null), ("date_role", .null), ("field", .null),
              ], cell.flags & 16 != 0 ? 1 : 0))
            }
          }
        }
        for w in tile.washes where w.owner == true {
          out.append(ordered([
            ("kind", "wash"), ("lane", .str(w.lane)), ("strand", .str(w.strand.description)), ("tier", .str(tier)), ("bin", .null),
            ("date_label", .str(w.label)), ("date_precision", .str(w.precision)), ("n", .int(w.n)), ("docs", .int(WashDocs.current[w.key ?? ""] ?? 0)),
            ("authors", .null), ("denom", .null), ("unit", .null), ("rate", .null), ("ci_lo", .null), ("ci_hi", .null), ("state", .null),
            ("flags", .null), ("dp", .null), ("evidence_status", .null), ("review_status", .null), ("origin", .null),
            ("source_locator", .null), ("date_basis", .null), ("date_role", .null), ("field", .null),
          ], w.synthetic == true ? 1 : 0))
        }
      }
    }
    for s in def.strands {
      var per = OrderedDict<String, (lane: String, which: String, uc: String, rows: [DocRow], syn: Int)>()
      for r in try Slices.strandDocRows(c, def, s) where r.chronoStatus != "dated" {
        let lane = Lanes.key(def.lanes.facet, r.lv, r.uc)
        let k = "\(lane)|\(r.chronoStatus)"
        var g = per[k] ?? (lane, r.chronoStatus, r.uc, [], 0)
        g.rows.append(r)
        if r.syn { g.syn = 1 }
        per[k] = g
      }
      for g in per.values {
        let n = Slices.countValue(g.uc, g.rows)
        if n == 0 { continue }
        out.append(ordered([
          ("kind", .str(g.which)), ("lane", .str(g.lane)), ("strand", .str(s.type == "expression" ? s.ref.description : s.key)),
          ("tier", .str(tier)), ("bin", .null), ("date_label", .str(g.which == "undated" ? "undated" : "scheduled")),
          ("date_precision", .null), ("n", .int(n)), ("docs", .int(g.rows.filter { $0.v > 0 }.count)), ("authors", .null),
          ("denom", .null), ("unit", .null), ("rate", .null), ("ci_lo", .null), ("ci_hi", .null), ("state", .null), ("flags", .null),
          ("dp", .null), ("evidence_status", .null), ("review_status", .null), ("origin", .null), ("source_locator", .null),
          ("date_basis", .null), ("date_role", .null), ("field", .null),
        ], g.syn))
      }
    }
    return out
  }

  static let relColumns = ["rel_id", "rel_type", "family", "src_type", "src_ref", "dst_type", "dst_ref", "evidence_status",
                           "review_status", "origin", "source_dataset", "source_locator", "provenance_quality", "method", "run_id",
                           "score", "score_kind", "date_conflict", "src_year", "dst_year", "date_label", "date_precision",
                           "date_basis", "date_role", "license", "attribution", "is_synthetic"]

  /// `strandDocIds(db, def)`: documents where a pinned strand is observed.
  static func strandDocIds(_ c: Connection, _ def: QueryDef) throws -> [Int64] {
    var out: [Int64] = []
    var seen = Set<Int64>()
    func add(_ d: Int64) { if seen.insert(d).inserted { out.append(d) } }
    for s in def.strands {
      if s.type == "expression" || s.type == "theme" {
        for r in try Slices.strandDocRows(c, def, s) where r.v > 0 { add(r.doc) }
      } else if s.type == "work" {
        add(Int64(s.ref.description) ?? 0)
      } else if s.type == "maker" {
        let dw = SliceSQL.docWhere(def)
        let names = SQLJSON.strings(s.names ?? [s.ref.description])
        for id in try SliceSQL.all(c, SQLPart(ExportSQL.makerDocs(dw.sql), [.text(names), .text(names)] + dw.params), { $0.int(0) }) { add(id) }
      }
    }
    return out
  }

  static func relationshipRows(_ c: Connection, _ def: QueryDef, evidence: [String: Int]) throws -> [OJ] {
    let statuses = ["documented", "computed", "proposed"].filter { evidence[$0] != 0 }
    let docs = try strandDocIds(c, def)
    if docs.isEmpty { return [] }
    let ids = SQLJSON.strings(docs.map(String.init)), nums = SQLJSON.ints(docs)
    let s = try c.prepared(ExportSQL.relationships)
    try s.bind([.text(ids), .text(ids), .text(nums), .text(nums), .text(nums), .text(nums), .text("[]")])
    var out: [OJ] = []
    while let r = try s.step() {
      let status = r.text(6), review = r.text(7), relType = r.text(1)
      guard statuses.contains(status), evidence["rejected"] == 1 || review != "rejected",
        evidence["kindred"] == 1 || !["kindred", "counterpart"].contains(relType)
      else { continue }
      if out.count >= maxRows { break }
      out.append(.obj([
        ("rel_id", .int(r.int(0))), ("rel_type", .str(relType)), ("family", .str(Vocab.relTypeByCode[relType]?.family)),
        ("src_type", .str(r.text(2))), ("src_ref", .str(r.text(3))), ("dst_type", .str(r.text(4))), ("dst_ref", .str(r.text(5))),
        ("evidence_status", .str(status)), ("review_status", .str(review)), ("origin", .str(r.text(8))),
        ("source_dataset", .str(r.textOrNil(9))), ("source_locator", .str(r.textOrNil(10))), ("provenance_quality", .str(r.text(11))),
        ("method", .str(r.textOrNil(12))), ("run_id", .int(r.intOrNil(13))), ("score", .num(r.doubleOrNil(14))),
        ("score_kind", .str(r.textOrNil(15))), ("date_conflict", .int(r.int(16))), ("src_year", .int(r.intOrNil(17))),
        ("dst_year", .int(r.intOrNil(18))), ("date_label", .null), ("date_precision", .null), ("date_basis", .null),
        ("date_role", .null), ("license", .str(r.textOrNil(19))), ("attribution", .str(r.textOrNil(20))),
        ("is_synthetic", .int(r.int(21))),
      ]))
    }
    return out
  }

  static let annColumns = ["annotation", "target_type", "target_ref", "kind", "author", "is_machine", "method", "layer", "status", "rev",
                           "current_rev", "supersedes", "body_md", "stance", "dimensions", "tags", "reason", "revision_author",
                           "revision_at", "anchor_start", "anchor_end", "anchor_quote", "created_at", "evidence_status",
                           "review_status", "origin", "date_label", "date_precision", "date_basis", "date_role", "source_locator",
                           "is_synthetic", "text_withheld"]

  struct Ann {
    var id: Int64
    var targetType: String
    var targetRef: String
    var anchor: String?
    var kind: String
    var author: String
    var isMachine: Int
    var method: String?
    var layer: String?
    var supersedes: Int64?
    var status: String
    var isSynthetic: Int
    var currentRev: Int
    var createdAt: String
  }

  /// Annotations of a view's corpora, every revision of every layer, quoted text withheld where the licence says so.
  static func annotationRows(_ c: Connection, _ def: QueryDef) throws -> [OJ] {
    let anns = try c.prepared(ExportSQL.annotations).all { r in
      Ann(id: r.int(0), targetType: r.text(1), targetRef: r.text(2), anchor: r.textOrNil(3), kind: r.text(4), author: r.text(5),
          isMachine: Int(r.int(6)), method: r.textOrNil(7), layer: r.textOrNil(8), supersedes: r.intOrNil(9), status: r.text(10),
          isSynthetic: Int(r.int(11)), currentRev: Int(r.int(12)), createdAt: r.text(13))
    }
    let corpora = Set(def.corpusIds)
    let ks = try c.prepared(ExportSQL.corpusSlugs)
    try ks.bind([.text(SQLJSON.ints(def.corpusIds))])
    var slugs = Set(try ks.all { $0.text(0) })
    slugs.insert(def.corpus)
    let byId = Dictionary(uniqueKeysWithValues: anns.map { ($0.id, $0) })
    var memo: [Int64: (doc: Int64?, allowed: Bool)?] = [:]
    func one(_ sql: SQL, _ v: [SQLValue]) throws -> Int64? { try c.prepared(sql).bindingFirst(v) { $0.intOrNil(0) } ?? nil }
    func endDoc(_ type: String, _ ref: String) throws -> Int64? {
      guard let id = Int64(JSString.split(ref, ":").last ?? "") else { return nil }
      if type == "document" { return id }
      if type == "passage" { return try one(ExportSQL.passageDoc, [.int(id)]) }
      if type == "occurrence" { return try one(ExportSQL.occurrenceDoc, [.int(id)]) }
      return nil
    }
    func inDocs(_ docs: [Int64?]) throws -> (doc: Int64?, allowed: Bool)? {
      for d in docs {
        guard let d else { continue }
        if let r = try c.prepared(ExportSQL.docCorpus).bindingFirst([.int(d)], { ($0.int(0), $0.int(1) == 1) }), corpora.contains(r.0) {
          return (d, r.1)
        }
      }
      return nil
    }
    func exprIn(_ id: Int64?) throws -> Bool { try id.flatMap { try one(ExportSQL.exprCorpus, [.int($0)]) }.map { corpora.contains($0) } ?? false }
    func scopeOf(_ a: Ann, _ depth: Int = 0) throws -> (doc: Int64?, allowed: Bool)? {
      if let m = memo[a.id] { return m }
      var out: (doc: Int64?, allowed: Bool)?
      let ref = a.targetRef
      switch a.targetType {
      case "document", "passage", "occurrence": out = try inDocs([try endDoc(a.targetType, ref)])
      case "relationship":
        if let id = Int64(ref), let e = try c.prepared(ExportSQL.relationshipEnds).bindingFirst([.int(id)], { ($0.text(0), $0.text(1), $0.text(2), $0.text(3)) }) {
          out = try inDocs([try endDoc(e.0, e.1), try endDoc(e.2, e.3)])
        }
      case "hypothesis_group":
        if let id = Int64(ref), let g = try c.prepared(ExportSQL.groupTarget).bindingFirst([.int(id)], { ($0.text(0), $0.text(1)) }) {
          out = try inDocs([try endDoc(g.0, g.1)])
        }
      case "expression": out = try exprIn(Int64(ref)) ? (nil, true) : nil
      case "cluster":
        let k = try Int64(ref).flatMap { try one(ExportSQL.clusterCorpus, [.int($0)]) }
        out = k.map { corpora.contains($0) } == true ? (nil, true) : nil
      case "time_window":
        let scope = try Int64(ref).flatMap { id in try c.prepared(ExportSQL.windowScope).bindingFirst([.int(id)]) { $0.textOrNil(0) } ?? nil }
        let e = scope.flatMap { try? JSONValue.parse($0) }?["expression"]?.safeInteger.map(Int64.init)
        out = try exprIn(e) ? (nil, true) : nil
      case "saved_view":
        let cslug = try c.prepared(ExportSQL.viewCorpus).bindingFirst([.text(ref), .text(ref)]) { $0.textOrNil(0) } ?? nil
        out = cslug.map { slugs.contains($0) } == true ? (nil, true) : nil
      case "annotation":
        if let id = Int64(ref), let t = byId[id], depth < 8 { out = try scopeOf(t, depth + 1) }
      default: out = nil
      }
      memo[a.id] = .some(out)
      return out
    }
    var out: [OJ] = []
    for a in anns {
      guard let scope = try scopeOf(a) else { continue }
      let withheld = !scope.allowed
      let anchor = a.anchor.flatMap { try? JSONValue.parse($0) }
      let revs = try c.prepared(ExportSQL.revisions)
      try revs.bind([.int(a.id)])
      for rv in try revs.all({ r in
        (rev: Int(r.int(0)), body: r.text(1), stance: r.textOrNil(2), dims: r.text(3), tags: r.text(4), reason: r.textOrNil(5),
         author: r.text(6), at: r.text(7))
      }) {
        out.append(.obj([
          ("annotation", .int(a.id)), ("target_type", .str(a.targetType)), ("target_ref", .str(a.targetRef)), ("kind", .str(a.kind)),
          ("author", .str(a.author)), ("is_machine", .int(a.isMachine)), ("method", .str(a.method)), ("layer", .str(a.layer)),
          ("status", .str(a.status)), ("rev", .int(rv.rev)), ("current_rev", .int(a.currentRev)), ("supersedes", .int(a.supersedes)),
          ("body_md", .str(rv.body)), ("stance", .str(rv.stance)), ("dimensions", .str(rv.dims)), ("tags", .str(rv.tags)),
          ("reason", .str(rv.reason)), ("revision_author", .str(rv.author)), ("revision_at", .str(rv.at)),
          ("anchor_start", anchor?["start"].map(OJ.init) ?? .null), ("anchor_end", anchor?["end"].map(OJ.init) ?? .null),
          ("anchor_quote", withheld ? .null : anchor?["quote"].map(OJ.init) ?? .null), ("created_at", .str(a.createdAt)),
          ("evidence_status", .null), ("review_status", .null), ("origin", .str(a.isMachine == 1 ? "machine_tagger" : "human")),
          ("date_label", .null), ("date_precision", .null), ("date_basis", .null), ("date_role", .null), ("source_locator", .null),
          ("is_synthetic", .int(a.isSynthetic)), ("text_withheld", .int(withheld ? 1 : 0)),
        ]))
        if out.count >= maxRows { return out }
      }
    }
    return out
  }

  // MARK: the export

  /// The bytes of an export and how to save them.
  public struct File: Sendable {
    public var contentType: String
    public var fileName: String
    public var body: String
    public var rows: Int
    public var manifest: OJ
  }

  /// `csvField(v)`.
  static func csvField(_ v: OJ?) -> String {
    let s: String
    switch v ?? .null {
    case .null: return ""
    case .bool(let b): s = b ? "true" : "false"
    case .num(let x): s = JSNumber.format(x)
    case .str(let t): s = t
    case let o: s = o.stringify()
    }
    if s.utf16.contains(where: { $0 == 0x22 || $0 == 0x2C || $0 == 0x0D || $0 == 0x0A }) {
      return "\"\(JSString.split(s, "\"").joined(separator: "\"\""))\""
    }
    return s
  }

  /// `toCsv(rows, columns)`.
  static func toCSV(_ rows: [OJ], _ columns: [String]) -> String {
    var lines = [columns.map { csvField(.str($0)) }.joined(separator: ",")]
    for r in rows { lines.append(columns.map { csvField(r[$0]) }.joined(separator: ",")) }
    return lines.joined(separator: "\n") + "\n"
  }

  /// `csvManifest(manifest)`: the manifest as `#` comment lines.
  static func csvManifest(_ m: OJ) -> String {
    JSString.split(m.stringify(indent: 1), "\n").map { "# \($0)" }.joined(separator: "\n") + "\n"
  }

  /// `exportQuery(db, {view, state, what, format, tier})`.
  public static func export(_ c: Connection, text: TextAccess, view: String?, state: String?, what: String = "occurrences",
                            format: String = "json", tier: String = "L2") throws -> File {
    guard whats.contains(what) else {
      throw ScrollsErrorFactory.validation("what must be one of \(whats.joined(separator: ", ")).", field: "what")
    }
    if (what == "bundle") != (format == "html") {
      throw ScrollsError(code: errExportFormat, message: "Format '\(format)' with what=\(what) is not supported.",
                         hint: "Use json, jsonl or csv; html with what=bundle.",
                         detail: .object(["format": .string(format), "what": .string(what)]), status: 400)
    }
    if what == "bundle" { throw ScrollsError.notImplemented(area: "The portable HTML bundle export (ΔS-14: later on the phone)") }
    guard let contentType = formats[format] else {
      throw ScrollsError(code: errExportFormat, message: "Format '\(format)' is not supported.",
                         hint: "Use json, jsonl or csv; html with what=bundle.", detail: .object(["format": .string(format)]), status: 400)
    }
    let resolved = try resolveState(c, view: view, state: state)
    if resolved.state.strands.isEmpty && ["occurrences", "aggregates", "passages"].contains(what) {
      throw ScrollsErrorFactory.validation("The view pins no strand to export.", field: "state", hint: "Pin an expression first.")
    }
    let (def, missing) = try QueryDefs.fromViewState(c, resolved.state)
    if !missing.isEmpty && what != "relationships" && what != "annotations" {
      throw ScrollsError(code: .notMaterialized, message: "Counting has not finished for expression \(missing.map(String.init).joined(separator: ",")).",
                         hint: "Wait for \"counting…\" to finish, then export.",
                         detail: .object(["expressions": .array(missing.map { .int($0) })]), status: 409)
    }
    let rows: [OJ], columns: [String]
    switch what {
    case "occurrences": (rows, columns) = (try occurrenceRows(c, text: text, def), occColumns)
    case "passages": (rows, columns) = (try passageRows(c, text: text, def), passageColumns)
    case "aggregates": (rows, columns) = (try aggregateRowsWithDocs(c, def, tier: tier), aggColumns)
    case "relationships": (rows, columns) = (try relationshipRows(c, def, evidence: resolved.state.evidence), relColumns)
    default: (rows, columns) = (try annotationRows(c, def), annColumns)
    }
    let m = try manifest(c, view: resolved.view, state: resolved.state, what: what, format: format, def: def, rows: rows)
    let body: String
    switch format {
    case "json": body = OJ.obj([("manifest", m), ("rows", .arr(rows))]).stringify()
    case "jsonl": body = ([OJ.obj([("manifest", m)])] + rows).map { $0.stringify() + "\n" }.joined()
    default: body = csvManifest(m) + toCSV(rows, columns)
    }
    let dv = m["data_version"].map { $0.value.numberValue.map(JSNumber.format) ?? "0" } ?? "0"
    return File(contentType: contentType, fileName: "scrolls-\(def.corpus)-v\(dv)-\(what).\(format)", body: body, rows: rows.count,
                manifest: m)
  }

  /// Aggregates with each wash's document count (the tile payload's wash carries no `docs`).
  static func aggregateRowsWithDocs(_ c: Connection, _ def: QueryDef, tier: String) throws -> [OJ] {
    var docs: [String: Int] = [:]
    if let level = ["L0", "L1", "L2", "L3"].firstIndex(of: tier) {
      let ext = try c.prepared(TimelineSQL.datedExtent).bindingFirst([.text(SQLJSON.ints(def.corpusIds))]) { r in
        (r.intOrNil(0).map(Int.init), r.intOrNil(1).map(Int.init))
      }
      if let ext, let lo = ext.0, let hi = ext.1 {
        let w = [1000, 100, 10, 1][level]
        let t0 = DayMath.floorDiv(DayMath.floorDiv(lo, w), 64), t1 = DayMath.floorDiv(DayMath.floorDiv(hi, w), 64)
        for wv in try Tiles.washes(c, def, tier, b0: t0 * 64, b1: t1 * 64 + 63) { docs[wv.key] = wv.docs }
      }
    }
    return try WashDocs.$current.withValue(docs) { try aggregateRows(c, def, tier: tier) }
  }
}

/// The wash document counts of the aggregate export being built (a task-local, so concurrent exports never share it).
enum WashDocs {
  @TaskLocal static var current: [String: Int] = [:]
}

