// OWNER: N3
// Ports of server/aggregate/marks.mjs, shelf.mjs and bin.mjs: individual matches (§1.6 occurrence override; Σ tile n per
// lane = marks total over the whole range), the UNDATED / SCHEDULED shelves and the washes list (§1.7), and the bin
// drawer (§1.6 aggregate click: the denominator line on top, then KWIC rows by date; the cell is computed by the same code
// as the tile, so the drawer can never disagree with the bar it was opened from).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A row of a strand's occurrence statement (`occurrenceSql` columns).
public struct OccRow: Sendable, Equatable {
  public var occ: Int64?
  public var passage: Int64
  public var doc: Int64
  public var startOff: Int
  public var endOff: Int
  public var nameFlag: Bool
  public var variantId: Int64?
  public var field: String
  public var pStart: Int
  public var pEnd: Int
  public var plang: String
  public var fieldClass: String
  public var lv: String?
  public var uc: String
  public var chronoStatus: String
  public var loDay: Int?
  public var hiDay: Int?
  public var yLo: Int?
  public var yHi: Int?
  public var precision: String
  public var basis: String
  public var dateLabel: String
  public var dateRole: String?
  public var title: String?
  public var author: String?
  public var kind: String
  public var syn: Bool
  public var collection: String
  public var license: String?
  public var exportTextAllowed: Bool
  public var sourceURL: String?

  static func read(_ r: Row) -> OccRow {
    OccRow(occ: r.intOrNil(0), passage: r.int(1), doc: r.int(2), startOff: Int(r.int(3)), endOff: Int(r.int(4)), nameFlag: r.int(5) == 1,
           variantId: r.intOrNil(6), field: r.text(7), pStart: Int(r.int(8)), pEnd: Int(r.int(9)), plang: r.text(10),
           fieldClass: r.text(11), lv: r.textOrNil(12), uc: r.text(13), chronoStatus: r.text(14), loDay: r.intOrNil(15).map(Int.init),
           hiDay: r.intOrNil(16).map(Int.init), yLo: r.intOrNil(17).map(Int.init), yHi: r.intOrNil(18).map(Int.init),
           precision: r.text(19), basis: r.text(20), dateLabel: r.text(21), dateRole: r.textOrNil(22), title: r.textOrNil(23),
           author: r.textOrNil(24), kind: r.text(25), syn: r.int(26) == 1, collection: r.text(27), license: r.textOrNil(28),
           exportTextAllowed: r.int(29) == 1, sourceURL: r.count > 31 ? r.textOrNil(31) : nil)
  }
}

/// Marks, shelves and the bin drawer.
public enum TimelineLists {
  public static let maxMarks = 4000

  static func runOcc(_ c: Connection, _ q: SQLPart, order: String, limit: Int?, offset: Int? = nil, extra: String = "") throws -> [OccRow] {
    var params = q.params
    if let limit { params.append(.int(Int64(limit))) }
    if let offset { params.append(.int(Int64(offset))) }
    return try SliceSQL.all(c, SQLPart(OccSQL.rows(q.sql, extra: extra, order: order, limit: limit != nil, offset: offset != nil), params),
                            OccRow.read)
  }

  static func countOcc(_ c: Connection, _ q: SQLPart, extra: String = "") throws -> Int {
    Int(try SliceSQL.first(c, SQLPart(OccSQL.count(q.sql, extra: extra), q.params)) { $0.int(0) } ?? 0)
  }

  static let kindOfUc = ["text": "text", "titles": "title", "abstracts": "abstract"]

  /// `marksQuery(db, {def, from, to, lane, strand, limit})`: from/to are years; a document counts when its interval
  /// overlaps [from, to].
  public static func marks(_ c: Connection, _ def: QueryDef, from: Int?, to: Int?, lane: String?, strand: String?, limit: Int?) throws -> MarksResponse {
    let lim = max(1, min(maxMarks, limit ?? maxMarks))
    if def.lanes.facet == "cluster" && def.cluster?.state != "ok" { return MarksResponse(marks: [], truncated: false, total: 0) }
    var w = ["d.chrono_status = 'dated'"]
    var params: [SQLValue] = []
    if let from {
      w.append("d.y_hi >= ?")
      params.append(.int(Int64(from)))
    }
    if let to {
      w.append("d.y_lo <= ?")
      params.append(.int(Int64(to)))
    }
    let strands = def.strands.filter { s in strand == nil || (s.type == "expression" ? s.ref.description : s.key) == strand }
    if strand != nil && strands.isEmpty {
      throw ScrollsErrorFactory.validation("No strand '\(strand!)' in this query.", field: "strand")
    }
    var total = 0
    var sampled = false
    var marks: [(mark: Mark, occ: Int64?)] = []
    for s in strands {
      let key: IntOrString = s.type == "expression" ? s.ref : .string(s.key)
      if s.type == "expression" {
        if s.run == nil { continue }
        let q = try SliceSQL.occurrences(def, s, where: w.joined(separator: " AND "), params: params, lane: lane)
        if s.sampled {
          let lw = try lane.map { try SliceSQL.laneWhere(def, $0, SliceSQL.srcCols(def)) } ?? SQLPart("1")
          let rows = try Slices.strandDocRows(c, def, s, where: "\(w.joined(separator: " AND ")) AND \(lw.sql)", params: params + lw.params)
          total += rows.reduce(0) { $0 + Slices.countValue($1.uc, $1.v) }
          sampled = true
        } else {
          total += try countOcc(c, q)
        }
        for r in try runOcc(c, q, order: "lo_day, occ", limit: lim) {
          let kind = kindOfUc[r.uc] ?? (r.fieldClass == "title" ? "title" : r.fieldClass == "abstract" ? "abstract" : "text")
          marks.append((Mark(occ: r.occ.map { OccurrenceID(rawValue: $0) }, passage: PassageID(rawValue: r.passage),
                             doc: DocumentID(rawValue: r.doc), lane: Lanes.key(def.lanes.facet, r.lv, r.uc), strand: key,
                             loDay: r.loDay ?? 0, hiDay: r.hiDay ?? 0, precision: r.precision, basis: r.basis, kind: kind,
                             nameFlag: r.nameFlag, synthetic: r.syn), r.occ))
        }
      } else {
        let rows = try workMarks(c, def, s, where: w.joined(separator: " AND "), params: params, lane: lane)
        total += rows.count
        marks += rows.map { ($0, nil) }
      }
    }
    let sorted = stableSorted(marks) { a, b in
      if a.mark.loDay != b.mark.loDay { return a.mark.loDay < b.mark.loDay }
      return (a.occ ?? 0) < (b.occ ?? 0)
    }.map(\.mark)
    let out = Array(sorted.prefix(lim))
    return MarksResponse(marks: out, truncated: total > out.count, total: total, sampled: sampled ? true : nil)
  }

  static func workMarks(_ c: Connection, _ def: QueryDef, _ s: DefStrand, where extra: String, params: [SQLValue],
                        lane: String?) throws -> [Mark] {
    let cols = RowCols("p", passage: true)
    let slice = SliceSQL.sliceWhere(def, cols, .any)
    let lw = try lane.map { try SliceSQL.laneWhere(def, $0, cols) } ?? SQLPart("1")
    let pick: String
    let pickParams: [SQLValue]
    switch s.type {
    case "theme":
      pick = OccSQL.pickTheme
      pickParams = [.text(s.ref.description), .string(s.provenance)]
    case "work":
      pick = OccSQL.pickWork
      pickParams = [.int(Int64(s.ref.description) ?? 0)]
    default:
      pick = OccSQL.pickMaker
      let names = SQLJSON.strings(s.names ?? [s.ref.description])
      pickParams = [.text(names), .text(names)]
    }
    let sql = OccSQL.workMarks(pick: pick, lv: SliceSQL.facet(def.lanes.facet, cols), uc: SliceSQL.unitClass(def.lanes.facet, cols),
                               slice: slice.sql, lane: lw.sql, extra: extra)
    return try SliceSQL.all(c, SQLPart(sql, pickParams + slice.params + lw.params + params)) { r in
      Mark(occ: nil, passage: PassageID(rawValue: r.int(1)), doc: DocumentID(rawValue: r.int(2)),
           lane: Lanes.key(def.lanes.facet, r.textOrNil(3), r.text(4)), strand: .string(s.key), loDay: Int(r.int(5)),
           hiDay: Int(r.int(6)), precision: r.text(7), basis: r.text(8), kind: "work", nameFlag: false, synthetic: r.int(9) == 1)
    }
  }

  // MARK: shelves

  static func page<T>(_ items: [T], cursor: String?, limit: Int) throws -> (items: [T], cursor: String?) {
    let c = try Cursors.decode(cursor)
    let offset = c?["o"]?.safeInteger.flatMap { $0 >= 0 ? $0 : nil } ?? 0
    let slice = Array(items.dropFirst(offset).prefix(limit))
    return (slice, offset + limit < items.count ? Cursors.encode(["o": .int(offset + limit)]) : nil)
  }

  /// `shelfQuery(db, {def, which, lane, tier, cursor, limit})`.
  public static func shelf(_ c: Connection, _ def: QueryDef, which: String, lane: String?, tier: String, cursor: String?,
                           limit: Int?) throws -> ShelfResponse {
    guard ["undated", "scheduled", "washes"].contains(which) else {
      throw ScrollsErrorFactory.validation("which must be one of undated, scheduled, washes.", field: "which")
    }
    let lim = max(1, min(200, limit ?? 50))
    if which == "washes" {
      guard let level = Slices.tiers.firstIndex(of: tier) else {
        throw ScrollsErrorFactory.validation("tier must be one of \(Slices.tiers.joined(separator: ", ")).", field: "tier")
      }
      let ext = try c.prepared(TimelineSQL.datedExtent).bindingFirst([.text(SQLJSON.ints(def.corpusIds))]) { r in
        (r.intOrNil(0).map(Int.init), r.intOrNil(1).map(Int.init), r.intOrNil(2).map(Int.init), r.intOrNil(3).map(Int.init))
      }
      var items: [WashValue] = []
      if let ext, let lo = ext.0, let hi = ext.1 {
        let (b0, b1): (Int, Int)
        if level <= 3 {
          let w = [1000, 100, 10, 1][level]
          (b0, b1) = (DayMath.floorDiv(lo, w), DayMath.floorDiv(hi, w))
        } else if level == 5 {
          (b0, b1) = (ext.2 ?? 0, ext.3 ?? 0)
        } else {
          (b0, b1) = (lo * 12, hi * 12 + 11)
        }
        items = try Tiles.washes(c, def, tier, b0: b0, b1: b1).filter { lane == nil || $0.lane == lane }
      }
      let p = try page(items, cursor: cursor, limit: lim)
      let rows: [JSONValue] = p.items.map { w in
        .object(["key": .string(w.key), "lane": .string(w.lane), "strand": strandJSON(w.strand), "lo": .string(w.lo),
                 "hi": .string(w.hi), "lo_day": .int(w.loDay), "hi_day": .int(w.hiDay), "precision": .string(w.precision),
                 "label": .string(w.label), "synthetic": .bool(w.synthetic), "n": .int(w.n), "docs": .int(w.docs),
                 "tier": .string(tier)])
      }
      var out = ShelfResponse(which: which, total: items.count, items: .array(rows))
      out.$cursor = p.cursor.map { .value($0) } ?? .null
      return out
    }
    var items: [(json: JSONValue, title: String, doc: Int64, loDay: Int?)] = []
    for strand in def.strands {
      let extra = try lane.map { try SliceSQL.laneWhere(def, $0, SliceSQL.srcCols(def)) } ?? SQLPart("1")
      let rows = try Slices.strandDocRows(c, def, strand, where: "d.chrono_status = ? AND \(extra.sql)", params: [.text(which)] + extra.params)
        .filter { $0.v > 0 }
      var docs: [Int64] = []
      var seen = Set<Int64>()
      for r in rows where seen.insert(r.doc).inserted { docs.append(r.doc) }
      let first = try firstPassages(c, strand, docs)
      let raws = try chronologyRaws(c, rows.map(\.doc))
      for r in rows {
        var date: JSONObject = ["label": .string(r.dateLabel), "precision": .string(r.precision), "basis": .string(r.basis),
                                "raw": .str(raws[r.doc] ?? nil)]
        if which == "scheduled" {
          date["lo"] = .string(DateLabels.yearLabel(r.yLo ?? 0))
          date["lo_day"] = .int(r.loDay)
          date["hi_day"] = .int(r.hiDay)
        }
        let j: JSONValue = .object([
          "document_id": .int(r.doc), "passage": .int(first[r.doc]), "title": .str(r.title), "author": .str(r.author),
          "kind": .string(r.kind), "lane": .string(Lanes.key(def.lanes.facet, r.lv, r.uc)),
          "strand": strand.type == "expression" ? strandJSON(strand.ref) : .string(strand.key),
          "n": .int(Slices.countValue(r.uc, r.v)), "date": .object(date), "synthetic": .bool(r.syn),
        ])
        items.append((j, r.title ?? "", r.doc, r.loDay))
      }
    }
    if which == "scheduled" {
      items = stableSorted(items) { a, b in (a.loDay ?? 0) != (b.loDay ?? 0) ? (a.loDay ?? 0) < (b.loDay ?? 0) : a.doc < b.doc }
    } else {
      items = stableSorted(items) { a, b in
        let c = JSText.localeCompare(a.title, b.title)
        return c != 0 ? c < 0 : a.doc < b.doc
      }
    }
    let p = try page(items, cursor: cursor, limit: lim)
    var out = ShelfResponse(which: which, total: items.count, items: .array(p.items.map(\.json)))
    out.$cursor = p.cursor.map { .value($0) } ?? .null
    return out
  }

  static func strandJSON(_ s: IntOrString) -> JSONValue {
    switch s {
    case .int(let i): .int(i)
    case .string(let t): .string(t)
    }
  }

  /// `firstPassages(db, strand, docIds)`: the first counted passage of each document (or a work's title passage).
  static func firstPassages(_ c: Connection, _ strand: DefStrand, _ docIds: [Int64]) throws -> [Int64: Int64] {
    var out: [Int64: Int64] = [:]
    if docIds.isEmpty { return out }
    if strand.type == "expression" {
      for (expr, run) in strand.memberRuns {
        let s = try c.prepared(TimelineSQL.firstPassages)
        try s.bind([.int(expr), .int(run), .text(SQLJSON.ints(docIds))])
        for (d, p) in try s.all({ ($0.int(0), $0.int(1)) }) { out[d] = p }
      }
    } else {
      let s = try c.prepared(TimelineSQL.firstTitlePassages)
      try s.bind([.text(SQLJSON.ints(docIds))])
      for (d, p) in try s.all({ ($0.int(0), $0.int(1)) }) { out[d] = p }
    }
    return out
  }

  static func chronologyRaws(_ c: Connection, _ docs: [Int64]) throws -> [Int64: String?] {
    let s = try c.prepared(TimelineSQL.chronologyRaws)
    try s.bind([.text(SQLJSON.ints(docs))])
    var out: [Int64: String?] = [:]
    for (d, raw) in try s.all({ ($0.int(0), $0.textOrNil(1)) }) { out[d] = raw }
    return out
  }

  // MARK: the bin drawer

  /// `binLabel(tier, bin)`: '1910–1919', '1911', 'Apr 1931', '7 Apr 1931'.
  public static func binLabel(_ tier: String, _ bin: Int) -> String {
    let level = Slices.tiers.firstIndex(of: tier) ?? 2
    if level <= 3 {
      let w = [1000, 100, 10, 1][level]
      return w == 1 ? DateLabels.yearLabel(bin) : "\(DateLabels.yearLabel(bin * w))–\(DateLabels.yearLabel(bin * w + w - 1))"
    }
    if level == 4 {
      let y = DayMath.floorDiv(bin, 12), m = bin - y * 12
      return "\(DayMath.monthAbbr[m]) \(DateLabels.yearLabel(y))"
    }
    let (y, m, d) = DayMath.ymdFromDay(bin)
    return "\(d) \(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))"
  }

  static func denominatorText(state: String, n: Int, denom: Double, unit: String, uc: String, gate: Int, label: String, docs: Int,
                              rate: Double?, synthetic: Bool) -> String {
    let amount = uc == "titles" ? "\(Format.count(denom)) works" : "\(Format.tokens(denom)) tokens"
    let gateText = uc == "titles" ? "\(Format.count(Double(gate))) works" : Format.count(Double(gate))
    let syn = synthetic ? " · SYNTHETIC" : ""
    switch state {
    case "observed": return "n = \(Format.count(Double(n))) in \(label) · \(amount) · \(Format.count(Double(docs))) documents · \(Format.rate(rate, unit: unit))\(syn)"
    case "absent": return "0 occurrences in \(amount) — looked, found none\(syn)"
    case "low": return "low coverage: n = \(Format.count(Double(n))) in \(amount) (gate \(gateText)) — rate not shown\(syn)"
    case "pending": return "indexing — not yet looked\(syn)"
    default: return "no sources in \(label)\(syn)"
    }
  }

  /// `binQuery(db, {def, lane, strand, tier, bin, cell, cursor, limit})` (OpenAlex share cells are M2).
  public static func bin(_ c: Connection, _ def: QueryDef, text: TextAccess, lane: String, strand: String?, tier: String, bin: Int?,
                         cell: String?, cursor: String?, limit: Int?) throws -> BinResponse {
    let uc: String
    do { uc = try Lanes.parse(lane).unitClass } catch { throw ScrollsErrorFactory.validation(error.message, field: "lane") }
    guard let s = def.strands.first(where: { x in
      strand == nil ? SliceSQL.strandSource(x, def) != nil : (x.type == "expression" ? x.ref.description : x.key) == strand
    }), SliceSQL.strandSource(s, def) != nil else {
      throw ScrollsErrorFactory.validation("No counted strand matches this request.", field: "strand", hint: "Pass strand=<expression id>.")
    }
    let lim = max(1, min(200, limit ?? 50))
    if uc == "cells" { throw ScrollsError.notImplemented(area: "OpenAlex share-cell drawers (contract 1.3.0 C3; package N3, milestone M2)") }
    guard let level = Slices.tiers.firstIndex(of: tier) else {
      throw ScrollsErrorFactory.validation("tier must be one of \(Slices.tiers.joined(separator: ", ")).", field: "tier")
    }
    guard let bin else { throw ScrollsErrorFactory.validation("bin must be an integer.", field: "bin") }
    let gates = try Slices.laneGates(c, def)
    let cv = try Tiles.strandCells(c, def, s, tier, b0: bin, b1: bin, gates: gates, pending: try Slices.pendingUnitClasses(c, def))[lane]?[bin]
    let label = binLabel(tier, bin)
    let unit = Rates.unitOf(uc)
    let state = cv.map { Vocab.cellStates[String($0.state)] ?? "uncovered" } ?? "uncovered"
    let gate = gates.of(lane, uc)
    var den: JSONObject = [
      "lane": .string(lane), "strand": s.type == "expression" ? strandJSON(s.ref) : .string(s.key), "tier": .string(tier),
      "bin": .int(bin), "label": .string(label), "state": .string(state), "n": .int(cv?.n ?? 0), "docs": .int(cv?.docs ?? 0),
      (uc == "titles" ? "works" : "tokens"): .number(cv?.denom ?? 0), "unit": .string(unit), "rate": .num(cv?.rate),
      "ci": cv.flatMap { v in v.rate != nil ? JSONValue.array([.num(v.ciLo), .num(v.ciHi)]) : nil } ?? .null, "gate": .int(gate),
    ]
    var textLine = denominatorText(state: state, n: cv?.n ?? 0, denom: cv?.denom ?? 0, unit: unit, uc: uc, gate: gate, label: label,
                                   docs: cv?.docs ?? 0, rate: cv?.rate,
                                   synthetic: (cv.map { $0.flags & 16 != 0 } ?? false) || s.synthetic)
    if s.type != "expression" {
      den["text"] = .string(textLine)
      return BinResponse(denominator: .object(den), rows: [], cursor: nil, total: cv?.n ?? 0).withNullCursor()
    }
    var w: String
    var params: [SQLValue]
    if level <= 3 {
      w = "d.chrono_status = 'dated' AND EXISTS (SELECT 1 FROM doc_bin b WHERE b.document_id = d.id AND b.level = ? AND b.bin = ?)"
      params = [.int(Int64(level)), .int(Int64(bin))]
    } else {
      let (d0, d1) = Tiles.dayRange(tier, bin, bin)
      w = "d.chrono_status = 'dated' AND d.lo_day >= ? AND d.hi_day <= ?"
      params = [.int(Int64(d0)), .int(Int64(d1))]
    }
    let q = try SliceSQL.occurrences(def, s, where: w, params: params, lane: lane)
    var rows = try runOcc(c, q, order: "lo_day, occ", limit: nil)
    if level >= 4 {
      rows = rows.filter { r in
        Slices.fitsTier(yLo: r.yLo, yHi: r.yHi, loDay: r.loDay, hiDay: r.hiDay, tier)
          && SliceCube.binOfDay(r.loDay ?? 0, r.yLo ?? 0, level) == bin
      }
    }
    let p = try page(rows, cursor: cursor, limit: lim)
    if s.sampled {
      den["sampled"] = .object(["contexts": .int(rows.count), "of": den["n"]!])
      textLine += " · contexts sampled: \(rows.count) of \(cv?.n ?? 0) in this bin"
    }
    den["text"] = .string(textLine)
    let kw = try Kwic.rows(c, text: text, p.items.map { Kwic.Source($0, lane: Lanes.key(def.lanes.facet, $0.lv, $0.uc)) })
    var out = BinResponse(denominator: .object(den), rows: kw, total: rows.count)
    out.$cursor = p.cursor.map { .value($0) } ?? .null
    return out
  }
}

extension BinResponse {
  func withNullCursor() -> BinResponse {
    var b = self
    b.$cursor = .null
    return b
  }
}

/// The opaque list cursor (router.mjs encodeCursor / decodeCursor): base64url of the cursor object's JSON.
public enum Cursors {
  public static func encode(_ o: JSONObject) -> String {
    let json = OJ.obj(o.keys.sorted(by: CanonicalJSON.codeUnitLess).map { ($0, OJ(o[$0]!)) }).stringify()
    return Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  public static func decode(_ s: String?) throws -> JSONObject? {
    guard let s, !s.isEmpty else { return nil }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    if let data = Data(base64Encoded: b64), case .object(let o)? = try? JSONValue.parse(data) { return o }
    throw ScrollsError.badRequest(.badCursor, "The cursor is not one this server issued.", hint: "Restart the list without a cursor.")
  }
}
