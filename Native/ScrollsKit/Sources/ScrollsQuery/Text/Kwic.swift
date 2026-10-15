// OWNER: N3
// Port of server/text/kwic.mjs (SPEC §4.4, D4): KWIC lines computed at request time from the ORIGINAL — ±12 tokens,
// clipped at passage bounds — and the concordance (GET /api/kwic): a strand's counted occurrences, by date (undated last)
// or spread (one per document in turn), with the denominator of what the concordance looked at (the same slice and
// languages as the rows). Offsets in a row are relative to the passage text; `abs_start`/`abs_end` index the document.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// KWIC lines and the concordance.
public enum Kwic {
  /// One KWIC line.
  public struct Line: Sendable, Equatable {
    public var left: [UInt16]
    public var match: [UInt16]
    public var right: [UInt16]
  }

  /// `kwic(original, start, end, {window, clipStart, clipEnd})`.
  public static func line(_ original: [UInt16], start: Int, end: Int, window: Int = 12, clipStart: Int = 0, clipEnd: Int? = nil) -> Line {
    let clipEnd = clipEnd ?? original.count
    let lo = max(0, min(clipStart, start))
    let hi = min(original.count, max(clipEnd, end))
    let region = JSText.slice(original, lo, hi)
    let t = TokenList(units: region)
    let s = start - lo, e = end - lo
    var first = 0
    while first < t.starts.count && Int(t.ends[first]) <= s { first += 1 }
    var last = t.starts.count - 1
    while last >= 0 && Int(t.starts[last]) >= e { last -= 1 }
    let leftIdx = max(0, first - window)
    let rightIdx = min(t.starts.count - 1, last + window)
    let leftStart = first - window >= 0 && first > 0 ? Int(t.starts[leftIdx]) : 0
    let rightEnd = last + window <= t.starts.count - 1 && last >= 0 ? Int(t.ends[rightIdx]) : region.count
    return Line(left: JSText.slice(region, min(leftStart, s), s), match: JSText.slice(region, s, e),
                right: JSText.slice(region, e, max(e, rightEnd)))
  }

  /// What a KWIC row is cut from.
  public struct Source: Sendable {
    public var occ: Int64??
    public var passage: Int64
    public var doc: Int64
    public var field: String
    public var pStart: Int
    public var pEnd: Int
    public var startOff: Int
    public var endOff: Int
    public var title: String?
    public var loDay: Int?
    public var hiDay: Int?
    public var precision: String?
    public var dateLabel: String?
    public var lane: String?
    public var synthetic: Bool
    public var exportTextAllowed: Bool

    public init(occ: Int64??, passage: Int64, doc: Int64, field: String, pStart: Int, pEnd: Int, startOff: Int, endOff: Int,
                title: String?, loDay: Int?, hiDay: Int?, precision: String?, dateLabel: String?, lane: String?, synthetic: Bool,
                exportTextAllowed: Bool = true) {
      self.occ = occ
      self.passage = passage
      self.doc = doc
      self.field = field
      self.pStart = pStart
      self.pEnd = pEnd
      self.startOff = startOff
      self.endOff = endOff
      self.title = title
      self.loDay = loDay
      self.hiDay = hiDay
      self.precision = precision
      self.dateLabel = dateLabel
      self.lane = lane
      self.synthetic = synthetic
      self.exportTextAllowed = exportTextAllowed
    }

    /// An occurrence row (it carries its occurrence id).
    public init(_ r: OccRow, lane: String?) {
      self.init(occ: .some(r.occ), passage: r.passage, doc: r.doc, field: r.field, pStart: r.pStart, pEnd: r.pEnd, startOff: r.startOff,
                endOff: r.endOff, title: r.title, loDay: r.loDay, hiDay: r.hiDay, precision: r.precision, dateLabel: r.dateLabel,
                lane: lane, synthetic: r.syn, exportTextAllowed: r.exportTextAllowed)
    }
  }

  /// `kwicRows(db, rows, {window, respectExport})`.
  public static func rows(_ c: Connection, text: TextAccess, _ rows: [Source], window: Int = 12, respectExport: Bool = false) throws -> [KwicRow] {
    try rows.map { r in
      let withheld = respectExport && !r.exportTextAllowed
      var k = Line(left: [], match: [], right: [])
      if !withheld {
        let t = try text.passage(c, doc: r.doc, field: r.field, start: r.pStart, end: r.pEnd)
        k = line(t, start: r.startOff - r.pStart, end: r.endOff - r.pStart, window: window)
      }
      let label: String
      if let l = r.dateLabel { label = l } else if let lo = r.loDay {
        label = DateLabels.formatDateLabel(DateParse(loDay: Day(lo), hiDay: Day(r.hiDay ?? lo), yLo: nil, yHi: nil,
                                                     precision: r.precision ?? "unknown", basis: "stated", approx: false, rule: "", raw: nil,
                                                     label: "", warnings: [], issue: nil))
      } else {
        label = "undated"
      }
      var row = KwicRow(passage: PassageID(rawValue: r.passage), doc: DocumentID(rawValue: r.doc), start: r.startOff - r.pStart,
                        end: r.endOff - r.pStart, left: JSText.string(k.left), match: JSText.string(k.match),
                        right: JSText.string(k.right), synthetic: r.synthetic, title: r.title,
                        date: DateLabel(label: label, precision: r.precision ?? "unknown"), lane: r.lane, absStart: r.startOff,
                        absEnd: r.endOff)
      row.$title = r.title.map { .value($0) } ?? .null
      row.$lane = r.lane.map { .value($0) } ?? .null
      if let occ = r.occ { row.$occ = occ.map { .value(OccurrenceID(rawValue: $0)) } ?? .null }
      if withheld { row.textWithheld = true }
      return row
    }
  }

  /// `pinnedMaterializeRun(db, runs, expr)` (RF-2, D17): the expression's counting run among a saved view's pinned runs
  /// (comma-separated run ids), or nil when none of them counts it. A run id that is not an integer answers 400.
  public static func pinnedMaterializeRun(_ c: Connection, runs: String?, expr: Int64) throws -> Int64? {
    guard let runs, !runs.isEmpty else { return nil }
    var ids: [Int64] = []
    for raw in JSString.split(runs, ",") {
      let t = JSString.trim(raw)
      if t.isEmpty { continue }
      let x = JSNumber.parse(t)
      guard x.isFinite, x == x.rounded(), abs(x) < 9_007_199_254_740_992 else {
        throw ScrollsErrorFactory.validation("runs must be an integer (got '\(t)').", field: "runs")
      }
      ids.append(Int64(x))
    }
    return try c.prepared(MatchSQL.pinnedAmong).bindingFirst([.text(SQLJSON.ints(ids)), .int(expr)]) { $0.int(0) }
  }

  /// `kwicQuery(db, {def, expr, from, to, lane, sort, cursor, limit})`.
  public static func query(_ c: Connection, text: TextAccess, _ def: QueryDef, expr: Int64?, from: Int?, to: Int?, lane: String?,
                           sort: String, cursor: String?, limit: Int?) throws -> KwicResponse {
    guard let strand = def.strands.first(where: { $0.type == "expression" && (expr == nil || $0.exprId == expr) }) else {
      throw ScrollsErrorFactory.validation("No expression strand matches this request.", field: "expr", hint: "Pass expr=<expression id>.")
    }
    guard sort == "date" || sort == "spread" else { throw ScrollsErrorFactory.validation("sort must be 'date' or 'spread'.", field: "sort") }
    if strand.run == nil {
      var r = KwicResponse(rows: [], total: 0)
      r.$cursor = .null
      return r
    }
    let lim = max(1, min(200, limit ?? 50))
    var w: [String] = []
    var params: [SQLValue] = []
    if from != nil || to != nil { w.append("d.chrono_status = 'dated'") }
    if let from {
      w.append("d.y_hi >= ?")
      params.append(.int(Int64(from)))
    }
    if let to {
      w.append("d.y_lo <= ?")
      params.append(.int(Int64(to)))
    }
    let q = try SliceSQL.occurrences(def, strand, where: w.isEmpty ? "1" : w.joined(separator: " AND "), params: params, lane: lane)
    let total = try TimelineLists.countOcc(c, q)
    let cur = try Cursors.decode(cursor)
    let offset = cur?["o"]?.safeInteger.flatMap { $0 >= 0 ? $0 : nil } ?? 0
    let order = sort == "spread" ? "ROW_NUMBER() OVER (PARTITION BY doc ORDER BY occ), lo_day IS NULL, lo_day, occ" : "lo_day IS NULL, lo_day, occ"
    let rows = try TimelineLists.runOcc(c, q, order: order, limit: lim, offset: offset)
    let cubes = try Cubes.of(c, def)
    let denLane: String? = lane.map { l in def.lanes.facet == "cluster" ? def.denomKey(l, Tiles.clusterUc(l)) : l }
    let den = CubeSlice.rangeTotals(cubes, def, strand.langSpec, from: from, to: to, lane: denLane)
    var d = KwicDenominator(tokens: Int(den.tokens), works: den.works, docs: den.docs, from: from, to: to, lane: lane,
                            note: from != nil || to != nil ? "documents dated within or overlapping the range, same slice and languages as the rows"
                              : "every document of the slice in the strand's languages, dated or not")
    if from == nil { d.$from = .null }
    if to == nil { d.$to = .null }
    if lane == nil { d.$lane = .null }
    var out = KwicResponse(rows: try Kwic.rows(c, text: text, rows.map { Source($0, lane: Lanes.key(def.lanes.facet, $0.lv, $0.uc)) }),
                           total: total, denominator: d)
    out.$cursor = offset + lim < total ? .value(Cursors.encode(["o": .int(offset + lim)])) : .null
    return out
  }
}
