// OWNER: N3
// Ports of server/aggregate/tiles.mjs, washes.mjs and coverage.mjs (SPEC §1.2, §1.6, §1.7, §3.2, §7.2 tiles): binned
// cells, precision washes and the coverage track per lane and strand. Cell = [binIndexInTile, n, docs, authors, denom,
// rate, ci_lo, ci_hi, state, flags, dp]; a tile is 64 bins. Cells are sent only for bins with n > 0 or denom > 0; the
// client takes absent / low / uncovered / pending from the cell state and never infers them. A wash is drawn across its
// whole interval and is never added to bars or rates: Σ bin n + Σ wash n + undated + scheduled = total at every tier.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One computed cell.
public struct CellValue: Sendable, Equatable {
  public var n: Int
  public var docs: Int
  public var authors: Int
  public var denom: Double
  public var rate: Double?
  public var ciLo: Double?
  public var ciHi: Double?
  public var state: Int
  public var flags: Int
  public var dp: Double?
  public var first: Int?
  public var last: Int?
}

/// One wash (a record whose interval does not fit the bin).
public struct WashValue: Sendable, Equatable {
  public var key: String
  public var lane: String
  public var strand: IntOrString
  public var lo: String
  public var hi: String
  public var loDay: Int
  public var hiDay: Int
  public var precision: String
  public var label: String
  public var n: Int
  public var docs: Int
  public var binLo: Int
  public var binHi: Int
  public var synthetic: Bool
}

/// Tiles, washes and coverage.
public enum Tiles {
  public static let tileBins = 64
  public static let maxTiles = 64
  static let levelWidths = [1000, 100, 10, 1]

  static func level(_ tier: String) -> Int { Slices.tiers.firstIndex(of: tier) ?? 2 }

  /// `parseTiles(spec)`: "3", "2,3", "-3..5" or a mix; sorted and distinct.
  public static func parse(_ spec: String) throws -> [Int] {
    var out = Set<Int>()
    for raw in JSString.split(spec, ",") {
      let p = JSString.trim(raw)
      if p.isEmpty { continue }
      let parts = JSString.split(p, "..")
      if parts.count == 2, let a = intLiteral(parts[0]), let b = intLiteral(parts[1]) {
        if b < a || b - a >= 100_000 {
          throw ScrollsError.badRequest(.validation, "Bad tile range '\(p)'.", hint: "Use from..to with from ≤ to.")
        }
        for t in a...b { out.insert(t) }
      } else if let v = intLiteral(p) {
        out.insert(v)
      } else {
        throw ScrollsError.badRequest(.validation, "Bad tile '\(p)'.", hint: "Tiles are integers: tiles=2,3 or tiles=2..5.")
      }
    }
    if out.isEmpty { throw ScrollsError.badRequest(.validation, "tiles is required.", hint: "Ask for tiles=2,3 or tiles=2..5.") }
    return out.sorted()
  }

  /// `/^-?\d+$/`.
  static func intLiteral(_ s: String) -> Int? {
    var u = Array(s.utf8)
    var neg = false
    if u.first == 0x2D {
      neg = true
      u.removeFirst()
    }
    guard !u.isEmpty, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), u.count < 16 else { return nil }
    let v = Int(String(decoding: u, as: UTF8.self))!
    return neg ? -v : v
  }

  /// Inclusive day range of bins [b0, b1] at L4 (months since year 0) or L5 (days).
  public static func dayRange(_ tier: String, _ b0: Int, _ b1: Int) -> (Int, Int) {
    if tier == "L5" { return (b0, b1) }
    func startOfMonth(_ mb: Int) -> Int {
      let y = DayMath.floorDiv(mb, 12), m = mb - y * 12 + 1
      return DayMath.dayFromYMD(y, m, 1)
    }
    return (startOfMonth(b0), startOfMonth(b1 + 1) - 1)
  }

  /// A row of `overlappingDocRows` (or the numerator rows at L0–L3, with `bin`).
  struct NumRow: Sendable {
    var lv: String?
    var uc: String
    var bin: Int
    var doc: Int64
    var v: Int
    var names: Int
    var author: String?
    var basis: String
    var syn: Bool
    var tr: Bool
    var loDay: Int?
    var hiDay: Int?
    var yLo: Int?
    var yHi: Int?
    var precision: String
    var dateLabel: String
  }

  /// `overlappingDocRows(db, def, strand, tier, range, {onlyUnbinned})`.
  static func overlappingDocRows(_ c: Connection, _ def: QueryDef, _ strand: DefStrand, _ tier: String, b0: Int, b1: Int,
                                 onlyUnbinned: Bool = false) throws -> [NumRow] {
    guard let src = SliceSQL.strandSource(strand, def) else { return [] }
    let lv = level(tier)
    let cols = SliceSQL.srcCols(def)
    let slice = SliceSQL.sliceWhere(def, cols, strand.langSpec)
    let nm = def.toggle("nm") == 1 ? 1 : 0
    var range: String
    var rangeParams: [SQLValue]
    if lv <= 3 {
      let w = levelWidths[lv]
      range = "d.y_hi >= ? AND d.y_lo <= ?"
      rangeParams = [.int(Int64(b0 * w)), .int(Int64(b1 * w + w - 1))]
      if onlyUnbinned {
        range += " AND NOT EXISTS (SELECT 1 FROM doc_bin b WHERE b.document_id = d.id AND b.level = ?)"
        rangeParams.append(.int(Int64(lv)))
      }
    } else {
      let (d0, d1) = dayRange(tier, b0, b1)
      range = "d.hi_day >= ? AND d.lo_day <= ?"
      rangeParams = [.int(Int64(d0)), .int(Int64(d1))]
    }
    let part = SQLPart(TilesSQL.overlapping(src: src.sql, lv: SliceSQL.facet(def.lanes.facet, cols),
                                            uc: SliceSQL.unitClass(def.lanes.facet, cols), nm: nm, slice: slice.sql, range: range),
                       src.params + slice.params + rangeParams)
    return try SliceSQL.all(c, part) { r in
      NumRow(lv: r.textOrNil(0), uc: r.text(1), bin: 0, doc: r.int(2), v: Int(r.int(3)), names: Int(r.int(4)),
             author: r.textOrNil(12), basis: r.text(11), syn: r.int(13) == 1, tr: r.int(14) == 1, loDay: r.intOrNil(5).map(Int.init),
             hiDay: r.intOrNil(6).map(Int.init), yLo: r.intOrNil(7).map(Int.init), yHi: r.intOrNil(8).map(Int.init),
             precision: r.text(9), dateLabel: r.text(10))
    }
  }

  /// Numerator rows per lane × bin × document (doc_bin at L0–L3, binned here at L4/L5).
  static func numeratorRows(_ c: Connection, _ def: QueryDef, _ strand: DefStrand, _ tier: String, b0: Int, b1: Int) throws -> [NumRow] {
    let lv = level(tier)
    if lv >= 4 {
      var out: [NumRow] = []
      for var r in try overlappingDocRows(c, def, strand, tier, b0: b0, b1: b1) {
        guard Slices.fitsTier(yLo: r.yLo, yHi: r.yHi, loDay: r.loDay, hiDay: r.hiDay, tier), let lo = r.loDay else { continue }
        let bin = SliceCube.binOfDay(lo, r.yLo ?? 0, lv)
        if bin >= b0 && bin <= b1 {
          r.bin = bin
          out.append(r)
        }
      }
      return out
    }
    guard let src = SliceSQL.strandSource(strand, def) else { return [] }
    let cols = SliceSQL.srcCols(def)
    let slice = SliceSQL.sliceWhere(def, cols, strand.langSpec)
    let part = SQLPart(TilesSQL.numerators(src: src.sql, lv: SliceSQL.facet(def.lanes.facet, cols),
                                           uc: SliceSQL.unitClass(def.lanes.facet, cols), nm: def.toggle("nm") == 1 ? 1 : 0,
                                           slice: slice.sql),
                       src.params + [.int(Int64(lv))] + slice.params + [.int(Int64(b0)), .int(Int64(b1))])
    return try SliceSQL.all(c, part) { r in
      NumRow(lv: r.textOrNil(0), uc: r.text(1), bin: Int(r.int(2)), doc: r.int(3), v: Int(r.int(4)), names: Int(r.int(5)),
             author: r.textOrNil(6), basis: r.text(7), syn: r.int(8) == 1, tr: r.int(9) == 1, loDay: r.intOrNil(10).map(Int.init),
             hiDay: r.intOrNil(11).map(Int.init), yLo: nil, yHi: nil, precision: "", dateLabel: "")
    }
  }

  /// The cluster lane keys of a unit class: every group lane and the residual lane.
  static func clusterLaneKeys(_ def: QueryDef, _ uc: String) -> [String] {
    guard let cl = def.cluster, cl.state == "ok", let run = cl.run else { return [] }
    return (cl.groups.map { "\(run):\($0.ord)" } + ["\(run):residual"]).map { Lanes.key("cluster", $0, uc) }
  }

  static func clusterUc(_ key: String) -> String {
    let u = Array(key.utf16)
    if let t = u.lastIndex(of: 0x7E), t > 0 { return JSText.string(u[(t + 1)...]) }
    return "text"
  }

  /// `denominators(db, def, langs, tier, range)`: the slice cube's denominators of the bins in range.
  static func denominators(_ c: Connection, _ def: QueryDef, _ langs: LangSpec, _ tier: String, b0: Int, b1: Int) throws
    -> OrderedDict<String, CubeDenominator>
  {
    var out = OrderedDict<String, CubeDenominator>()
    for (k, d) in try CubeSlice.denominators(c, def, langs, tier).pairs where d.bin >= b0 && d.bin <= b1 { out[k] = d }
    return out
  }

  /// `docSizes`: slice tokens of each matched document per lane × bin (the sizes of Gries' DP).
  static func docSizes(_ c: Connection, _ def: QueryDef, _ langs: LangSpec, _ tier: String, b0: Int, b1: Int,
                       _ docIds: [Int64]) throws -> [String: Double] {
    var out: [String: Double] = [:]
    if docIds.isEmpty { return out }
    let lv = level(tier)
    let cols = RowCols("t")
    let slice = SliceSQL.sliceWhere(def, cols, langs)
    let denomLane = def.lanes.facet == "cluster" ? "NULL" : SliceSQL.facet(def.lanes.facet, cols)
    let uc = SliceSQL.unitClass(def.lanes.facet, cols)
    func key(_ lv: String?, _ ucv: String) -> String { def.lanes.facet == "cluster" ? "~\(ucv)" : Lanes.key(def.lanes.facet, lv, ucv) }
    if lv <= 3 {
      let part = SQLPart(TilesSQL.docSizes(lane: denomLane, uc: uc, slice: slice.sql),
                         [.int(Int64(lv))] + slice.params + [.int(Int64(b0)), .int(Int64(b1)), .text(SQLJSON.ints(docIds))])
      for r in try SliceSQL.all(c, part, { ($0.textOrNil(0), $0.text(1), Int($0.int(2)), $0.int(3), $0.double(4)) }) {
        out["\(key(r.0, r.1))|\(r.2)|\(r.3)"] = r.4
      }
    } else {
      let (d0, d1) = dayRange(tier, b0, b1)
      let part = SQLPart(TilesSQL.dayDocRows(lane: denomLane, uc: uc, slice: slice.sql, docFilter: true),
                         slice.params + [.int(Int64(d0)), .int(Int64(d1)), .text(SQLJSON.ints(docIds))])
      for r in try SliceSQL.all(c, part, { r in
        (r.textOrNil(0), r.text(1), r.int(2), r.double(3), r.intOrNil(4).map(Int.init), r.intOrNil(5).map(Int.init),
         r.intOrNil(6).map(Int.init), r.intOrNil(7).map(Int.init))
      }) {
        guard Slices.fitsTier(yLo: r.6, yHi: r.7, loDay: r.4, hiDay: r.5, tier), let lo = r.4 else { continue }
        let bin = SliceCube.binOfDay(lo, r.6 ?? 0, lv)
        if bin < b0 || bin > b1 { continue }
        out["\(key(r.0, r.1))|\(bin)|\(r.2)"] = r.3
      }
    }
    return out
  }

  /// `strandCells(db, def, strand, tier, range, env)`: lane → bin → cell.
  public static func strandCells(_ c: Connection, _ def: QueryDef, _ strand: DefStrand, _ tier: String, b0: Int, b1: Int,
                                 gates: LaneGates, pending: Set<String>) throws -> OrderedDict<String, OrderedDict<Int, CellValue>> {
    let facet = def.lanes.facet
    var num = OrderedDict<String, (lane: String, uc: String, bin: Int, rows: [NumRow])>()
    for r in try numeratorRows(c, def, strand, tier, b0: b0, b1: b1) where r.uc != "cells" {
      let lane = Lanes.key(facet, r.lv, r.uc)
      let k = "\(lane)|\(r.bin)"
      var g = num[k] ?? (lane, r.uc, r.bin, [])
      g.rows.append(r)
      num[k] = g
    }
    let langs = strand.langSpec
    let den = try denominators(c, def, langs, tier, b0: b0, b1: b1)
    var matched: [Int64] = []
    var seenDocs = Set<Int64>()
    for g in num.values { for r in g.rows where r.v > 0 && seenDocs.insert(r.doc).inserted { matched.append(r.doc) } }
    let sizes = try docSizes(c, def, langs, tier, b0: b0, b1: b1, matched)
    var out = OrderedDict<String, OrderedDict<Int, CellValue>>()
    var keys = OrderedDict<String, Bool>()
    for k in num.keys { keys[k] = true }
    if facet == "cluster" {
      for d in den.values { for lane in clusterLaneKeys(def, d.uc) { keys["\(lane)|\(d.bin)"] = true } }
    } else {
      for k in den.keys where !JSString.hasPrefix(k, "trail:stemm-abstracts:") { keys[k] = true }
    }
    for k in keys.keys {
      let g = num[k]
      let u = Array(k.utf16)
      let sep = u.lastIndex(of: 0x7C)!
      let lane = g?.lane ?? JSText.string(u[..<sep])
      let bin = g?.bin ?? Int(JSText.string(u[(sep + 1)...]))!
      let uc = g?.uc ?? (facet == "cluster" ? clusterUc(lane) : den[k]?.uc ?? "text")
      let d = den["\(def.denomKey(lane, uc))|\(bin)"]
      let rows = g?.rows ?? []
      let counted = rows.filter { $0.v > 0 }
      let n = rows.reduce(0) { $0 + Slices.countValue(uc, $1.v) }
      let denom = d.map { uc == "titles" ? Double($0.docs) : $0.tokens } ?? 0
      if n == 0 && denom == 0 { continue }
      let unit = Rates.unitOf(uc)
      var rc = Rates.rateCell(n: n, denom: denom, unit: unit, gate: gates.of(lane, uc), pending: pending.contains(uc))
      let cellSample = gates.rateless(def.denomKey(lane, uc)) && rc.rate != nil
      if cellSample {
        rc.rate = nil
        rc.ciLo = nil
        rc.ciHi = nil
      }
      var flags = 0
      let w = { (r: NumRow) -> Int in uc == "titles" ? 1 : r.v }
      let vSum = counted.reduce(0) { $0 + w($1) }
      if n >= 1 && n <= 4 { flags |= Vocab.cellFlags["sparse"]! }
      if vSum > 0 {
        let top = counted.map(w).max()!
        if Double(top) / Double(vSum) >= 0.6 { flags |= Vocab.cellFlags["single_source"]! }
        let est = counted.filter { $0.basis == "estimated" }.reduce(0) { $0 + w($1) }
        if Double(est) / Double(vSum) > 0.5 { flags |= Vocab.cellFlags["estimated_majority"]! }
      }
      if d?.syn == true || rows.contains(where: \.syn) || strand.synthetic { flags |= Vocab.cellFlags["synthetic"]! }
      if (strand.sampled && n > 0) || cellSample { flags |= Vocab.cellFlags["sampled"]! }
      if def.toggle("nm") == 0 && rows.contains(where: { $0.names > 0 }) { flags |= Vocab.cellFlags["names_excluded"]! }
      if def.toggle("tr") == 1 && (d?.tr == true || rows.contains(where: \.tr)) { flags |= Vocab.cellFlags["translations_included"]! }
      var dp: Double?
      if rc.state == Vocab.cellStateCodes["observed"]! {
        let counts = counted.map { Double(w($0)) }
        let sz = counted.map { r in uc == "titles" ? 1 : sizes["\(def.denomKey(lane, uc))|\(bin)|\(r.doc)"] ?? 0 }
        let listed = sz.reduce(0, +)
        dp = Stats.griesDP(counts, sz, restSize: max(0, denom - listed))
      }
      var authors = Set<String>()
      for r in counted { if let a = r.author { authors.insert(a) } }
      var first: Int?, last: Int?
      for r in counted {
        if let lo = r.loDay, first == nil || lo < first! { first = lo }
        if let hi = r.hiDay, last == nil || hi > last! { last = hi }
      }
      var lanes = out[lane] ?? OrderedDict()
      lanes[bin] = CellValue(n: n, docs: counted.count, authors: authors.count, denom: denom, rate: rc.rate, ciLo: rc.ciLo,
                             ciHi: rc.ciHi, state: rc.state, flags: flags, dp: dp, first: first, last: last)
      out[lane] = lanes
    }
    return out
  }

  /// `groupWashes(def, strand, tier, rows)`: non-fitting rows grouped into washes, sorted by interval then lane.
  static func groupWashes(_ def: QueryDef, _ strand: DefStrand, _ tier: String, _ rows: [NumRow]) -> [WashValue] {
    let lv = level(tier)
    var groups = OrderedDict<String, (wash: WashValue, uc: String, rows: [NumRow])>()
    for r in rows {
      if Slices.fitsTier(yLo: r.yLo, yHi: r.yHi, loDay: r.loDay, hiDay: r.hiDay, tier) { continue }
      guard let loDay = r.loDay, let hiDay = r.hiDay, let yLo = r.yLo, let yHi = r.yHi else { continue }
      let lane = Lanes.key(def.lanes.facet, r.lv, r.uc)
      let key = "\(lane)|\(strand.key)|\(loDay)|\(hiDay)|\(r.dateLabel)"
      var g = groups[key] ?? (WashValue(key: key, lane: lane, strand: strand.type == "expression" ? strand.ref : .string(strand.key),
                                        lo: DateLabels.yearLabel(yLo), hi: DateLabels.yearLabel(yHi), loDay: loDay, hiDay: hiDay,
                                        precision: r.precision, label: r.dateLabel, n: 0, docs: 0,
                                        binLo: SliceCube.binOfDay(loDay, yLo, lv), binHi: SliceCube.binOfDay(hiDay, yHi, lv),
                                        synthetic: false), r.uc, [])
      g.rows.append(r)
      if r.syn { g.wash.synthetic = true }
      groups[key] = g
    }
    var out: [WashValue] = []
    for g in groups.values {
      let n = g.rows.reduce(0) { $0 + Slices.countValue(g.uc, $1.v) }
      if n == 0 { continue }
      var w = g.wash
      w.n = n
      w.docs = g.rows.filter { $0.v > 0 }.count
      out.append(w)
    }
    return stableSorted(out) { a, b in
      if a.loDay != b.loDay { return a.loDay < b.loDay }
      if a.hiDay != b.hiDay { return a.hiDay < b.hiDay }
      return JSText.localeCompare(a.lane, b.lane) < 0
    }
  }

  /// `washesFor(db, def, tier, range)`: washes of every rate-able strand over a bin range.
  public static func washes(_ c: Connection, _ def: QueryDef, _ tier: String, b0: Int, b1: Int) throws -> [WashValue] {
    let lv = level(tier)
    var out: [WashValue] = []
    for strand in def.strands where SliceSQL.strandSource(strand, def) != nil {
      let rows = try overlappingDocRows(c, def, strand, tier, b0: b0, b1: b1, onlyUnbinned: lv <= 3).filter { $0.uc != "cells" }
      out += groupWashes(def, strand, tier, rows)
    }
    return out
  }

  /// `coverageTuple(d, binIndex)`: [bin, works, docs, tokens, stepClass].
  static func coverageTuple(_ d: CubeDenominator, _ binIndex: Int) -> [Int] {
    let isWorks = d.uc == "titles" || d.uc == "cells"
    let works = isWorks ? d.docs : 0
    return [binIndex, works, d.docs, Int(d.tokens), isWorks ? Rates.stepClass(Double(works), "works") : Rates.stepClass(d.tokens, "tokens")]
  }

  /// `computeTiles(db, def, tier, list)`: tiles without the per-request limit.
  public static func compute(_ c: Connection, _ def: QueryDef, _ tier: String, _ list: [Int]) throws -> TilesResponse {
    try computeWithOrder(c, def, tier, list).0
  }

  /// JavaScript's own-key order of an object: integer-like keys ascending, then the others in insertion order.
  static func objectKeyOrder(_ keys: [String]) -> [String] {
    func index(_ k: String) -> Int? {
      guard !k.isEmpty, k.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), k == "0" || !k.hasPrefix("0"), k.utf8.count < 10 else { return nil }
      return Int(k)
    }
    let ints = keys.compactMap { k in index(k).map { (k, $0) } }.sorted { $0.1 < $1.1 }.map(\.0)
    return ints + keys.filter { index($0) == nil }
  }

  /// Tiles with the insertion order of their lanes and strands (exports write rows in the reference's object order).
  static func computeWithOrder(_ c: Connection, _ def: QueryDef, _ tier: String, _ list: [Int]) throws
    -> (TilesResponse, [Int: OrderedDict<String, [String]>])
  {
    var order: [Int: OrderedDict<String, [String]>] = [:]
    let lv = level(tier)
    guard let firstTile = list.min(), let lastTile = list.max() else {
      return (TilesResponse(queryKey: "", tier: tier, binWidth: lv <= 3 ? Double(levelWidths[lv]) : nil, dataVersion: 0, tiles: []), [:])
    }
    let b0 = firstTile * tileBins, b1 = lastTile * tileBins + tileBins - 1
    let wanted = Set(list)
    let gates = try Slices.laneGates(c, def)
    let pending = try Slices.pendingUnitClasses(c, def)
    func tileOf(_ bin: Int) -> Int { DayMath.floorDiv(bin, tileBins) }
    var tiles = OrderedDict<Int, Tile>()
    for t in list {
      tiles[t] = Tile(tile: t, bin0: t * tileBins, lanes: [:], coverage: [:], washes: [], days: [:],
                      cells: def.lanes.facet == "trail" ? [:] : nil)
    }
    for strand in def.strands where SliceSQL.strandSource(strand, def) != nil {
      let skey = strand.type == "expression" ? strand.ref.description : strand.key
      for (lane, bins) in try strandCells(c, def, strand, tier, b0: b0, b1: b1, gates: gates, pending: pending).pairs {
        for (bin, cv) in bins.pairs.sorted(by: { $0.key < $1.key }) {
          let t = tileOf(bin)
          guard wanted.contains(t), var tile = tiles[t] else { continue }
          var o = order[t] ?? OrderedDict()
          var sk = o[lane] ?? []
          if !sk.contains(skey) { sk.append(skey) }
          o[lane] = sk
          order[t] = o
          var tl = tile.lanes[lane] ?? TileLane(strands: [:])
          tl.strands[skey, default: []].append(TileCell(bin: bin - t * tileBins, n: cv.n, docs: cv.docs, authors: cv.authors,
                                                         denom: cv.denom, rate: cv.rate, ciLo: cv.ciLo, ciHi: cv.ciHi,
                                                         state: cv.state, flags: cv.flags, dp: cv.dp))
          tile.lanes[lane] = tl
          if let f = cv.first, let l = cv.last {
            var days = tile.days ?? [:]
            days[lane, default: [:]][skey, default: []].append([bin - t * tileBins, f, l])
            tile.days = days
          }
          tiles[t] = tile
        }
      }
      let rows = try overlappingDocRows(c, def, strand, tier, b0: b0, b1: b1, onlyUnbinned: lv <= 3).filter { $0.uc != "cells" }
      for w in groupWashes(def, strand, tier, rows) {
        let owner = tileOf(w.binLo)
        var t = max(owner, list[0])
        while t <= min(tileOf(w.binHi), list[list.count - 1]) {
          if wanted.contains(t), var tile = tiles[t] {
            tile.washes.append(Wash(lane: w.lane, strand: w.strand, lo: w.lo, hi: w.hi, precision: w.precision, label: w.label, n: w.n,
                                    key: w.key, owner: t == owner, loDay: w.loDay, hiDay: w.hiDay, synthetic: w.synthetic))
            tiles[t] = tile
          }
          t += 1
        }
      }
    }
    for d in try denominators(c, def, def.coverageLangs, tier, b0: b0, b1: b1).values {
      let t = tileOf(d.bin)
      guard wanted.contains(t), d.uc != "cells", var tile = tiles[t] else { continue }
      let lanesOfD = def.lanes.facet == "cluster" ? clusterLaneKeys(def, d.uc) : [d.lane]
      for lane in lanesOfD { tile.coverage[lane, default: []].append(coverageTuple(d, d.bin - t * tileBins)) }
      tiles[t] = tile
    }
    for t in tiles.keys {
      var tile = tiles[t]!
      for (k, v) in tile.coverage { tile.coverage[k] = stableSorted(v) { $0[0] < $1[0] } }
      tiles[t] = tile
    }
    return (TilesResponse(queryKey: "", tier: tier, binWidth: lv <= 3 ? Double(levelWidths[lv]) : nil, dataVersion: 0,
                          tiles: tiles.values), order)
  }
}
