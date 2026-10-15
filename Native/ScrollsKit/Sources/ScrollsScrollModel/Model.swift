// OWNER: N7
// Port of src/ui/timeline/model.mjs (SPEC §1.2, §1.6, §1.7, §8.3): tiles → per-lane, per-strand typed columns, bars,
// caps, censoring, washes, coverage, unit scales and the occurrence override.
//
// Honesty rules this module enforces (SPEC §13 rules 3, 4, 18):
//  · a bin's state comes from its cell; a bin without a cell is uncovered (pending while the lane indexes); nothing is
//    ever inferred or interpolated;
//  · a bar is a maximal run of consecutive OBSERVED bins; it never bridges absent, low, uncovered or pending;
//  · washes come only from the server's wash list and are never added to bars or rates;
//  · a cap sits at the exact first/last observed date only when that date is known (marks, the server's per-strand
//    first/last, or the lane's when it draws one row); otherwise it sits on the bar edge and says "in 1910–1919".
// The model is independent of the vantage: the display list stores reveal days, so Play never rebuilds this.
// Share lanes (OpenAlex cells, C3) are M2: their cells are not drawn by this slice (see `ModelInput`).

import Foundation
import ScrollsContracts
import ScrollsCore
import Synchronization

// MARK: - Inputs

/// A pinned strand of the view (`view.strands[i]`): its type, its id as the reference writes it in keys, its glyph name.
public struct StrandPin: Sendable, Hashable {
  public var type: String
  public var id: String
  /// 'circle' | 'square' | 'triangle' | 'diamond'
  public var glyph: String

  public init(type: String, id: String, glyph: String) {
    self.type = type
    self.id = id
    self.glyph = glyph
  }
}

/// A loaded tile: its payload, or loaded with no data (every bin in it is uncovered, §7.2).
public enum TileSlot: Sendable, Equatable {
  case data(Tile)
  case empty
}

/// The individual marks loaded for the occurrence override (`data.marks`).
public struct MarksWindow: Sendable, Equatable {
  public var items: [Mark]
  public var fromDay: Int
  public var toDay: Int
  public var truncated: Bool

  public init(items: [Mark], fromDay: Int, toDay: Int, truncated: Bool) {
    self.items = items
    self.fromDay = fromDay
    self.toDay = toDay
    self.truncated = truncated
  }
}

/// How the view orders lanes (`view.lanes`).
public struct LanesView: Sendable, Equatable {
  public var facet: String
  public var order: String
  public var manual: [String]

  public init(facet: String, order: String, manual: [String] = []) {
    self.facet = facet
    self.order = order
    self.manual = manual
  }
}

/// `buildModel`'s input (`BuildInput`).
public struct ModelInput: Sendable {
  public var query: TimelineQueryResponse?
  public var tier: Tier
  /// Loaded tiles of this query and tier.
  public var tiles: [Int64: TileSlot]
  /// [loDay, hiDay] built (≈ 3 viewport widths).
  public var range: ClosedRange<Double>
  /// [loDay, hiDay] on screen (override counting).
  public var visible: ClosedRange<Double>
  public var strands: [StrandPin]
  public var marks: MarksWindow?
  /// Strand id → label ('carry the zero').
  public var strandLabels: [String: String]
  public var laneLimit: Int
  public var lanesView: LanesView?

  public init(query: TimelineQueryResponse?, tier: Tier, tiles: [Int64: TileSlot], range: ClosedRange<Double>,
              visible: ClosedRange<Double>? = nil, strands: [StrandPin], marks: MarksWindow? = nil,
              strandLabels: [String: String] = [:], laneLimit: Int = 10, lanesView: LanesView? = nil) {
    self.query = query
    self.tier = tier
    self.tiles = tiles
    self.range = range
    self.visible = visible ?? range
    self.strands = strands
    self.marks = marks
    self.strandLabels = strandLabels
    self.laneLimit = laneLimit
    self.lanesView = lanesView
  }
}

// MARK: - The model

/// A run of bins as days: `[loDay, hiDay, binLo, binHi]`.
public struct BinRun: Sendable, Equatable, Hashable {
  public var loDay: Int
  public var hiDay: Int
  public var binLo: Int64
  public var binHi: Int64

  public init(loDay: Int, hiDay: Int, binLo: Int64, binHi: Int64) {
    self.loDay = loDay
    self.hiDay = hiDay
    self.binLo = binLo
    self.binHi = binHi
  }

  public var interval: DayInterval { DayInterval(lo: Day(clamping: loDay), hi: Day(clamping: hiDay)) }
}

/// A bar's start or end cap.
public struct Cap: Sendable, Equatable {
  public var day: Int
  public var exact: Bool
  public var censored: Bool
  public var label: String
}

/// A maximal run of observed bins (`findBars` + caps).
public struct BarRun: Sendable, Equatable {
  /// Inclusive column indices.
  public var start: Int
  public var end: Int
  public var loDay: Int
  public var hiDay: Int
  public var n: Int
  public var bins: Int
  public var startCap: Cap
  public var endCap: Cap
}

/// A precision wash of one strand.
public struct WashModel: Sendable, Equatable {
  public var loDay: Int
  public var hiDay: Int
  public var n: Int
  public var label: String
  public var precision: String
  public var circa: Bool
  public var synthetic: Bool
}

/// One drawn strand row in one lane.
public struct StrandModel: Sendable, Equatable {
  public var ref: String
  public var type: String
  public var id: String
  public var glyph: String?
  public var index: Int
  public var pin: Int
  /// Theme sub-strand provenance ('machine_tag', …), nil for expressions.
  public var sub: String?
  public var label: String
  /// The typed columns every reader shares.
  public var cols: StrandSeries
  public var bars: [BarRun]
  public var washes: [WashModel]
  /// The strand's marks when the override is usable.
  public var marks: [Mark]?
  public var totals: (binN: Int, washN: Int, observedBins: Int)

  public static func == (a: StrandModel, b: StrandModel) -> Bool {
    a.ref == b.ref && a.type == b.type && a.id == b.id && a.glyph == b.glyph && a.index == b.index && a.pin == b.pin
      && a.sub == b.sub && a.label == b.label && a.cols == b.cols && a.bars == b.bars && a.washes == b.washes
      && a.marks == b.marks && a.totals == b.totals
  }
}

/// A covered bin of a lane with its step class.
public struct CoverageCell: Sendable, Equatable {
  public var bin: Int64
  public var loDay: Int
  public var hiDay: Int
  public var tokens: Double
  public var works: Double
  public var docs: Double
  public var cls: Int
}

/// A coverage-only lane's dated span (before a strand is pinned).
public struct LaneSpan: Sendable, Equatable {
  public var loDay: Int
  public var hiDay: Int
  public var label: String
}

/// One lane of the model.
public struct LaneModel: Sendable, Equatable {
  public var key: String
  public var label: String
  public var machineLabel: String?
  public var humanLabel: String?
  public var unit: String
  public var modality: String
  public var header: String?
  public var note: String?
  public var selection: String?
  /// Still indexing: its bins without cells are pending, not "no sources".
  public var pending: Bool
  public var censor: LaneCensor
  public var first: LaneEndpoint?
  public var last: LaneEndpoint?
  public var n: Int
  public var docs: Int
  public var undated: Int
  public var scheduled: Int
  public var undatedShare: Double
  /// The query lane's `coverage` (tokens, works, docs, span), verbatim.
  public var laneCoverage: JSONValue?
  public var synthetic: Bool
  /// 'tokens' or 'works'.
  public var coverageUnit: String
  public var coverage: [CoverageCell]
  public var uncovered: [BinRun]
  public var pendingRuns: [BinRun]
  public var unloaded: [BinRun]
  public var strands: [StrandModel]
  /// Before a strand is pinned: only the corpus listing's span (`buildCoverageModel`).
  public var coverageOnly: Bool
  public var span: LaneSpan?
  /// '75.9k tokens' (coverage-only lanes).
  public var amount: String?
  public var isTrail: Bool
}

/// One height scale per unit (§1.2 item 6).
public struct UnitScale: Sendable, Equatable {
  public var unit: String
  public var max: Double
  public var lanes: [String]
}

/// Do the loaded marks reconcile with the bins they would replace (`reconcileMarks`)?
public struct MarksCheck: Sendable, Equatable {
  public var ok: Bool
  public var marks: Int
  public var bins: Int
  public var washes: Int
  public var reason: String?
}

/// A drawn strand row (`strandRows`).
public struct StrandRow: Sendable, Equatable {
  public var ref: String
  public var type: String
  public var id: String
  public var glyph: String?
  public var pin: Int
  public var sub: String?
  public var label: String
}

/// `buildModel`'s output.
public struct TimelineModel: Sendable, Equatable {
  public var tier: Tier
  public var range: ClosedRange<Double>?
  public var visible: ClosedRange<Double>?
  public var lanes: [LaneModel]
  public var hiddenLanes: Int
  public var hiddenN: Int
  /// Unit scales in first-seen order.
  public var units: [UnitScale]
  public var visibleN: Int
  public var rangeN: Int
  public var wantMarks: Bool
  /// Individual marks replace bars (§1.6).
  public var override: Bool
  public var marksCheck: MarksCheck?
  public var loadedTiles: [Int64]
  public var missingTiles: [Int64]
  public var complete: Bool
  public var coverageTrack: [CoverageScale.TrackRow]
  public var strands: [StrandRow]
  public var rowCount: Int
  public var coverageOnly: Bool

  /// The unit scale of a rate unit.
  public func unitMax(_ unit: String) -> Double { units.first { $0.unit == unit }?.max ?? 0 }
}

// MARK: - Building

/// The Scroll's model (`model.mjs`).
public enum ScrollModelBuilder {
  /// Override threshold: at most this many dated matches in view → individual marks (§1.6).
  public static let maxMarks = 4000
  /// The Term trail's etymology lane (C2): periods only, never counted bins.
  public static let trailEtymology = "trail:etymology"
  /// Term trail lanes that always stay on screen within the lane limit (§10.5).
  public static let trailAnchorLanes = ["trail:literature-text", "trail:culture-titles", "trail:music-relations"]

  /// Theme sub-strands by tag provenance, in drawing order (`SUBSTRANDS`).
  public static let substrands: [String: (order: Int, label: String)] = [
    "documented_category": (0, "documented category"),
    "machine_tag": (1, "machine tag — fallible"),
    "genre_heuristic": (2, "genre heuristic"),
  ]

  /// `trailShownLanes(lanes, limit)`.
  static func trailShownLanes(_ lanes: [Lane], limit: Int) -> [Lane] {
    guard lanes.count > limit else { return lanes }
    var keep = Set<String>()
    var keepOrder: [String] = []
    for l in lanes where trailAnchorLanes.contains(l.key) && keepOrder.count < limit && !keep.contains(l.key) {
      keep.insert(l.key)
      keepOrder.append(l.key)
    }
    let rest = lanes.enumerated().filter { !keep.contains($0.element.key) }
    let sorted = stableSorted(rest) { a, b in
      a.element.n != b.element.n ? a.element.n > b.element.n : a.offset < b.offset
    }
    for (_, l) in sorted {
      if keep.count >= limit { break }
      keep.insert(l.key)
    }
    return lanes.filter { keep.contains($0.key) }
  }

  /// `strandRows(query, strands, labels)`: an expression is one row keyed by its id; a theme splits into up to three
  /// sub-strands keyed `theme:<value>@<provenance>`.
  public static func strandRows(query: TimelineQueryResponse?, strands: [StrandPin], labels: [String: String]) -> [StrandRow] {
    var keysInQuery: [String] = []
    var seen = Set<String>()
    for lane in query?.lanes ?? [] {
      for k in (lane.strands ?? [:]).keys.sorted() where !seen.contains(k) {
        seen.insert(k)
        keysInQuery.append(k)
      }
    }
    var rows: [StrandRow] = []
    for (pin, s) in strands.enumerated() {
      let id = s.id
      let base = labels[id] ?? (s.type == "expression" ? "expression \(s.id)" : id)
      var keys = keysInQuery.filter { $0 == id || $0 == "\(s.type):\(id)" || $0.hasPrefix("\(s.type):\(id)@") }
      if keys.isEmpty { keys.append(id) }
      func subOf(_ k: String) -> String? {
        guard let at = k.lastIndex(of: "@") else { return nil }
        return String(k[k.index(after: at)...])
      }
      keys = stableSorted(keys) { a, b in
        let oa = subOf(a).flatMap { substrands[$0]?.order } ?? 9, ob = subOf(b).flatMap { substrands[$0]?.order } ?? 9
        if oa != ob { return oa < ob }
        return ReferenceCollation.compare(a, b) == .orderedAscending
      }
      for ref in keys {
        let sub = subOf(ref)
        let label = sub.map { "\(base) · \(substrands[$0]?.label ?? $0)" } ?? base
        rows.append(StrandRow(ref: ref, type: s.type, id: s.id, glyph: s.glyph, pin: pin, sub: sub, label: label))
      }
    }
    return rows
  }

  /// `buildColumns(cells, tier)`: typed columns of one strand's cells, sorted by bin.
  static func columns(_ cells: [(bin: Int64, cell: TileCell)], tier: Tier, ref: String, label: String, glyph: String) -> StrandSeries {
    var s = StrandSeries(ref: ref, label: label, glyph: glyph)
    let n = cells.count
    s.bin.reserveCapacity(n); s.loDay.reserveCapacity(n); s.hiDay.reserveCapacity(n); s.n.reserveCapacity(n)
    s.docs.reserveCapacity(n); s.denom.reserveCapacity(n); s.rate.reserveCapacity(n); s.ciLo.reserveCapacity(n)
    s.ciHi.reserveCapacity(n); s.state.reserveCapacity(n); s.flags.reserveCapacity(n)
    for (bin, c) in cells {
      s.bin.append(bin)
      s.loDay.append(Day(clamping: tier.startDay(ofBin: bin)))
      s.hiDay.append(Day(clamping: tier.endDay(ofBin: bin)))
      s.n.append(Int32(truncatingIfNeeded: c.n))
      s.docs.append(Int32(truncatingIfNeeded: c.docs))
      s.denom.append(c.denom.isFinite ? c.denom : .nan)
      s.rate.append(c.rate.flatMap { $0.isFinite ? $0 : nil } ?? .nan)
      s.ciLo.append(c.ciLo.flatMap { $0.isFinite ? $0 : nil } ?? .nan)
      s.ciHi.append(c.ciHi.flatMap { $0.isFinite ? $0 : nil } ?? .nan)
      s.state.append(BinState(rawValue: UInt8(clamping: c.state)) ?? .uncovered)
      s.flags.append(UInt16(truncatingIfNeeded: c.flags))
    }
    return s
  }

  /// `findBars(cols)`: maximal runs of consecutive observed bins (inclusive column indices).
  public static func findBars(_ c: StrandSeries) -> [(start: Int, end: Int)] {
    var bars: [(Int, Int)] = []
    var start = -1
    for i in 0..<c.count {
      let obs = c.state[i] == .observed
      let contiguous = i > 0 && c.bin[i] == c.bin[i - 1] + 1
      if obs && start >= 0 && contiguous && c.state[i - 1] == .observed { continue }
      if start >= 0 { bars.append((start, i - 1)) }
      start = obs ? i : -1
    }
    if start >= 0 { bars.append((start, c.count - 1)) }
    return bars
  }

  /// `runsOf(bins, tier)`: sorted bins merged into day runs.
  static func runs(_ bins: [Int64], tier: Tier) -> [BinRun] {
    var out: [BinRun] = []
    for b in bins {
      if var last = out.last, last.binHi == b - 1 {
        last.binHi = b
        last.hiDay = tier.endDay(ofBin: b)
        out[out.count - 1] = last
      } else {
        out.append(BinRun(loDay: tier.startDay(ofBin: b), hiDay: tier.endDay(ofBin: b), binLo: b, binHi: b))
      }
    }
    return out
  }

  /// `laneLabelOf(label, fallback)`.
  static func laneLabel(_ label: LaneLabel, fallback: String) -> (text: String, machine: String?, human: String?) {
    switch label {
    case .text(let s): return (s.isEmpty ? fallback : s, nil, nil)
    case .group(let machine, let human):
      let m = machine.trimmingJSWhitespace().isEmpty ? nil : stripMachine(machine)
      let h = human.flatMap { $0.trimmingJSWhitespace().isEmpty ? nil : $0.trimmingJSWhitespace() }
      return (h ?? m ?? fallback, m, h)
    }
  }

  /// `stripMachine(s)`: 'machine label: hold · mic · verse' → 'hold · mic · verse' (`/^\s*machine label:\s*/i`; without
  /// the u flag JavaScript folds case for ASCII letters only).
  static func stripMachine(_ s: String) -> String {
    var t = Substring(s)
    let ws: (Unicode.Scalar) -> Bool = { $0.properties.isWhitespace || $0 == "\u{FEFF}" }
    while let f = t.unicodeScalars.first, ws(f) { t = Substring(t.unicodeScalars.dropFirst()) }
    let prefix = Array("machine label:".utf8)
    let head = Array(t.utf8.prefix(prefix.count))
    let folded = head.map { (0x41...0x5A).contains($0) ? $0 + 0x20 : $0 }
    if folded == prefix {
      t = Substring(t.unicodeScalars.dropFirst(prefix.count))
      while let f = t.unicodeScalars.first, ws(f) { t = Substring(t.unicodeScalars.dropFirst()) }
    }
    return String(t).trimmingJSWhitespace()
  }

  /// `markLabel(m)`: a mark's date at its own precision: '17 May 1994', 'Feb 1995', '1994', '1990–1999'.
  public static func markLabel(loDay: Int, hiDay: Int, precision: String) -> String {
    if precision == "day" || precision == "month" || precision == "year" { return RulerScale.dayLabel(Double(loDay), precision: precision) }
    let a = RulerScale.dayLabel(Double(loDay)), b = RulerScale.dayLabel(Double(hiDay))
    return a == b ? a : "\(a)–\(b)"
  }

  public static func markLabel(_ m: Mark) -> String { markLabel(loDay: m.loDay, hiDay: m.hiDay, precision: m.precision) }

  /// `buildModel(input)`.
  public static func build(_ input: ModelInput) -> TimelineModel {
    let tier = input.tier
    let rLo = input.range.lowerBound, rHi = input.range.upperBound
    let binLo = tier.bin(ofDay: rLo), binHi = tier.bin(ofDay: rHi)
    let vLo = input.visible.lowerBound, vHi = input.visible.upperBound
    let query = input.query
    let rows = strandRows(query: query, strands: input.strands, labels: input.strandLabels)
    let refs = rows.map(\.ref)
    var lanes = (query?.lanes ?? []).filter { $0.key != trailEtymology }
    if let lv = input.lanesView, lv.order == "manual", !lv.manual.isEmpty {
      var rank: [String: Int] = [:]
      for (i, k) in lv.manual.enumerated() where rank[k] == nil { rank[k] = i }
      lanes = stableSorted(lanes.enumerated().map { ($0.element, rank[$0.element.key].map(Double.init) ?? 1e6 + Double($0.offset)) }) {
        $0.1 < $1.1
      }.map(\.0)
    }
    let limit = max(1, input.laneLimit)
    let trail = input.lanesView?.facet == "trail" && input.lanesView?.order != "manual"
    let shown = trail ? trailShownLanes(lanes, limit: limit) : Array(lanes.prefix(limit))
    let shownKeys = Set(shown.map(\.key))
    let folded = lanes.filter { !shownKeys.contains($0.key) }
    let shareKeys = Set(shown.filter(isShareLane).map(\.key))
    let hiddenLanes = folded.count + (query?.other.lanes ?? 0)
    let hiddenN = folded.reduce(0) { $0 + $1.n } + (query?.other.n ?? 0)

    var loadedTiles: [Int64] = [], missingTiles: [Int64] = []
    let t0 = Tiers.floorDiv(binLo, Tier.tileBins), t1 = Tiers.floorDiv(binHi, Tier.tileBins)
    if t0 <= t1 {
      for t in t0...t1 {
        if input.tiles[t] != nil { loadedTiles.append(t) } else { missingTiles.append(t) }
      }
    }
    func isLoaded(_ bin: Int64) -> Bool { input.tiles[Tiers.floorDiv(bin, Tier.tileBins)] != nil }
    func inRange(_ bin: Int64) -> Bool { bin >= binLo && bin <= binHi }

    // Gather cells per lane and strand, coverage per lane, and washes (deduplicated across tiles).
    var cellsBy: [String: [(bin: Int64, cell: TileCell)]] = [:]
    var covBy: [String: [Int64: (works: Double, docs: Double, tokens: Double, cls: Int?)]] = [:]
    var washKeys = Set<String>()
    var washesBy: [String: [Wash]] = [:]
    for t in loadedTiles {
      guard case .data(let tile)? = input.tiles[t] else { continue }
      let bin0 = Int64(tile.bin0)
      for (laneKey, lane) in tile.lanes {
        for (ref, cells) in lane.strands {
          let key = "\(laneKey)\u{0}\(ref)"
          var list = cellsBy[key] ?? []
          for c in cells {
            let bin = bin0 + Int64(c.bin)
            if inRange(bin) { list.append((bin, c)) }
          }
          cellsBy[key] = list
        }
      }
      for (laneKey, rowsOfCov) in tile.coverage {
        var m = covBy[laneKey] ?? [:]
        for r in rowsOfCov where r.count >= 4 {
          let bin = bin0 + Int64(r[0])
          if inRange(bin) { m[bin] = (Double(r[1]), Double(r[2]), Double(r[3]), r.count > 4 ? r[4] : nil) }
        }
        covBy[laneKey] = m
      }
      for w in tile.washes {
        let k: String
        if let key = w.key, !key.isEmpty {
          k = "k\u{0}\(key)"
        } else {
          k = "\(w.lane)\u{0}\(w.strand)\u{0}\(w.lo)\u{0}\(w.hi)\u{0}\(w.label)"
        }
        if washKeys.contains(k) { continue }
        washKeys.insert(k)
        washesBy["\(w.lane)\u{0}\(w.strand)", default: []].append(w)
      }
    }

    // Marks are used (override, exact caps) only when they reconcile with the bins they would replace.
    let marksForCheck = input.marks.map { m in
      MarksWindow(items: m.items.filter { !shareKeys.contains($0.lane) }, fromDay: m.fromDay, toDay: m.toDay, truncated: m.truncated)
    }
    let marksCheck = reconcileMarks(marks: marksForCheck, lanes: shown.filter { !isShareLane($0) }.map(\.key), refs: refs,
                                    cellsBy: cellsBy, washesBy: washesBy, tier: tier)
    let usable = marksCheck.ok ? input.marks : nil

    var unitOrder: [String] = []
    var units: [String: (max: Double, lanes: [String])] = [:]
    func noteUnit(_ unit: String, _ rate: Double, _ lane: String) {
      if units[unit] == nil {
        units[unit] = (0, [])
        unitOrder.append(unit)
      }
      units[unit]!.max = max(units[unit]!.max, rate)
      if !units[unit]!.lanes.contains(lane) { units[unit]!.lanes.append(lane) }
    }

    var laneModels: [LaneModel] = []
    for lane in shown {
      let unit = lane.unit
      let name = laneLabel(lane.label, fallback: lane.key)
      let cov = covBy[lane.key] ?? [:]
      let pendingLane = lane.state == "pending" || lane.status == "pending"
      let covUnit = CoverageScale.unit(ofRateUnit: unit)
      let span = lane.coverage["span"]?.arrayValue
      let spanFirstBin: Int64? = span?.first?.safeInteger.map { tier.bin(ofDay: DayMath.dayFromYMD($0, 1, 1)) }
      let spanLastBin: Int64? = (span.flatMap { $0.count > 1 ? $0[1] : nil })?.safeInteger.map { tier.bin(ofDay: DayMath.dayFromYMD($0, 12, 31)) }
      let laneFirst = LabelParse.parse(lane.first?.label)
      let laneLast = LabelParse.parse(lane.last?.label)

      var strandModels: [StrandModel] = []
      for (index, row) in rows.enumerated() {
        let ref = row.ref
        let raw = stableSorted(cellsBy["\(lane.key)\u{0}\(ref)"] ?? []) { $0.bin < $1.bin }
        let glyph = Vocab.strandGlyphChars[row.glyph ?? ""] ?? "●"
        let cols = columns(raw, tier: tier, ref: ref, label: row.label, glyph: glyph)
        let strandMarks = usable.map { u in u.items.filter { $0.lane == lane.key && $0.strand.description == ref } }
        let own = lane.strands?[ref]
        let first = LabelParse.parse(own?.first?.label) ?? (rows.count == 1 ? laneFirst : nil)
        let last = LabelParse.parse(own?.last?.label) ?? (rows.count == 1 ? laneLast : nil)
        var bars: [BarRun] = []
        for (start, end) in findBars(cols) {
          let loDay = Int(cols.loDay[start]), hiDay = Int(cols.hiDay[end])
          var n = 0
          for i in start...end { n += Int(cols.n[i]) }
          let inBar = strandMarks?.filter { $0.loDay >= loDay && $0.hiDay <= hiDay } ?? []
          var startCap = Cap(day: loDay, exact: false, censored: false, label: "in \(tier.label(ofBin: cols.bin[start]))")
          var endCap = Cap(day: hiDay, exact: false, censored: false, label: "in \(tier.label(ofBin: cols.bin[end]))")
          if !inBar.isEmpty {
            let a = inBar.reduce(inBar[0]) { $1.loDay < $0.loDay ? $1 : $0 }
            let b = inBar.reduce(inBar[0]) { $1.hiDay > $0.hiDay ? $1 : $0 }
            startCap.day = a.loDay; startCap.exact = true; startCap.label = markLabel(a)
            endCap.day = b.hiDay; endCap.exact = true; endCap.label = markLabel(b)
          } else {
            if let first, let fl = first.loDay, Int(fl) >= loDay, Int(fl) <= hiDay {
              startCap.day = Int(fl); startCap.exact = true; startCap.label = first.label
            }
            if let last, let lh = last.hiDay, Int(lh) >= loDay, Int(lh) <= hiDay {
              endCap.day = Int(lh); endCap.exact = true; endCap.label = last.label
            }
          }
          // Censoring (§1.2 item 5): the run touches the lane's first/last covered bin.
          let firstInBar = first.flatMap { $0.loDay }.map { Int($0) >= loDay && Int($0) <= hiDay } ?? false
          let lastInBar = last.flatMap { $0.hiDay }.map { Int($0) >= loDay && Int($0) <= hiDay } ?? false
          startCap.censored = (spanFirstBin != nil && cols.bin[start] == spanFirstBin!) || (rows.count == 1 && firstInBar && lane.censor.left)
          endCap.censored = (spanLastBin != nil && cols.bin[end] == spanLastBin!) || (rows.count == 1 && lastInBar && lane.censor.right)
          bars.append(BarRun(start: start, end: end, loDay: loDay, hiDay: hiDay, n: n, bins: end - start + 1, startCap: startCap, endCap: endCap))
        }
        for i in 0..<cols.count where cols.state[i] == .observed && cols.rate[i].isFinite {
          noteUnit(unit, cols.rate[i], lane.key)
        }
        var washes: [WashModel] = []
        for w in washesBy["\(lane.key)\u{0}\(ref)"] ?? [] {
          guard let a = LabelParse.parse(w.lo), let b = LabelParse.parse(w.hi), let al = a.loDay, let bh = b.hiDay else { continue }
          let lp = LabelParse.parse(w.label)
          let circa = lp?.rule == "circa" || w.label.hasPrefix("c.") && w.label.dropFirst(2).first.map { $0.isWhitespace } == true
          let wm = WashModel(loDay: Int(al), hiDay: Int(bh), n: w.n, label: w.label, precision: w.precision, circa: circa,
                             synthetic: w.synthetic ?? lane.synthetic)
          if Double(wm.hiDay) >= rLo && Double(wm.loDay) <= rHi { washes.append(wm) }
        }
        var binN = 0, observedBins = 0
        for i in 0..<cols.count {
          binN += Int(cols.n[i])
          if cols.state[i] == .observed { observedBins += 1 }
        }
        strandModels.append(StrandModel(
          ref: ref, type: row.type, id: row.id, glyph: row.glyph, index: index, pin: row.pin, sub: row.sub, label: row.label,
          cols: cols, bars: bars, washes: washes, marks: strandMarks, totals: (binN, washes.reduce(0) { $0 + $1.n }, observedBins)))
      }

      // Lane underlay: covered bins, uncovered runs, pending runs, unloaded runs.
      var coveredBins = Set<Int64>()
      for (bin, c) in cov where (covUnit == "works" ? c.works : c.tokens) > 0 { coveredBins.insert(bin) }
      var pendingBins = Set<Int64>()
      for sm in strandModels {
        for i in 0..<sm.cols.count {
          if sm.cols.state[i] == .pending { pendingBins.insert(sm.cols.bin[i]) }
          else if sm.cols.denom[i] > 0 || sm.cols.n[i] > 0 { coveredBins.insert(sm.cols.bin[i]) }
        }
      }
      let indexing = pendingLane || !pendingBins.isEmpty
      var uncovered: [Int64] = [], pending: [Int64] = [], unloaded: [Int64] = []
      if binLo <= binHi {
        for b in binLo...binHi {
          if !isLoaded(b) { unloaded.append(b) }
          else if pendingBins.contains(b) { pending.append(b) }
          else if coveredBins.contains(b) { continue }
          else if indexing { pending.append(b) }
          else { uncovered.append(b) }
        }
      }
      let coverage = cov.filter { coveredBins.contains($0.key) }.sorted { $0.key < $1.key }.map { bin, c in
        CoverageCell(bin: bin, loDay: tier.startDay(ofBin: bin), hiDay: tier.endDay(ofBin: bin), tokens: c.tokens, works: c.works,
                     docs: c.docs, cls: c.cls ?? CoverageScale.stepClass(covUnit == "works" ? c.works : c.tokens, unit: covUnit))
      }
      laneModels.append(LaneModel(
        key: lane.key, label: name.text, machineLabel: name.machine, humanLabel: name.human, unit: unit, modality: lane.modality,
        header: lane.header, note: lane.note ?? lane.rateNote, selection: lane.selection, pending: indexing, censor: lane.censor,
        first: lane.first, last: lane.last, n: lane.n, docs: lane.docs, undated: lane.undated, scheduled: lane.scheduled,
        undatedShare: lane.undatedShare, laneCoverage: lane.coverage, synthetic: lane.synthetic, coverageUnit: covUnit,
        coverage: coverage, uncovered: runs(uncovered, tier: tier), pendingRuns: runs(pending, tier: tier),
        unloaded: runs(unloaded, tier: tier), strands: strandModels, coverageOnly: false, span: nil, amount: nil,
        isTrail: lane.key.hasPrefix("trail:")))
    }

    // Dated matches in view (bins + washes) decide the occurrence override (§1.6).
    var visibleN = 0, rangeN = 0
    for lm in laneModels {
      for sm in lm.strands {
        for i in 0..<sm.cols.count {
          rangeN += Int(sm.cols.n[i])
          if Double(sm.cols.hiDay[i]) >= vLo && Double(sm.cols.loDay[i]) <= vHi { visibleN += Int(sm.cols.n[i]) }
        }
        for w in sm.washes {
          rangeN += w.n
          if Double(w.hiDay) >= vLo && Double(w.loDay) <= vHi { visibleN += w.n }
        }
      }
    }
    let wantMarks = !input.strands.isEmpty && visibleN > 0 && visibleN <= maxMarks && missingTiles.isEmpty
    let marksCover = usable.map { Double($0.fromDay) <= vLo && Double($0.toDay) >= vHi } ?? false
    let override = wantMarks && marksCover

    return TimelineModel(
      tier: tier, range: input.range, visible: input.visible, lanes: laneModels, hiddenLanes: hiddenLanes, hiddenN: hiddenN,
      units: unitOrder.map { UnitScale(unit: $0, max: units[$0]!.max, lanes: units[$0]!.lanes) }, visibleN: visibleN,
      rangeN: rangeN, wantMarks: wantMarks, override: override, marksCheck: marksCheck, loadedTiles: loadedTiles,
      missingTiles: missingTiles, complete: missingTiles.isEmpty, coverageTrack: CoverageScale.track(laneModels),
      strands: rows, rowCount: rows.count, coverageOnly: false)
  }

  /// Is this lane a within-cell share lane (`isShareLane`)? Share lanes are drawn from M2 on.
  public static func isShareLane(_ lane: Lane) -> Bool { lane.unit == "share_of_sampled_works" }

  /// `reconcileMarks`: marks inside [fromDay, toDay] must number at least the bins' n inside that range and at most that
  /// plus the washes touching it; a truncated or non-reconciling list is never drawn in place of bars.
  static func reconcileMarks(marks: MarksWindow?, lanes: [String], refs: [String],
                             cellsBy: [String: [(bin: Int64, cell: TileCell)]], washesBy: [String: [Wash]], tier: Tier) -> MarksCheck {
    guard let marks else { return MarksCheck(ok: false, marks: 0, bins: 0, washes: 0, reason: "no marks loaded") }
    let fromDay = marks.fromDay, toDay = marks.toDay
    let laneKeys = Set(lanes), refSet = Set(refs)
    var bins = 0, washes = 0
    for l in lanes {
      for ref in refs {
        for c in cellsBy["\(l)\u{0}\(ref)"] ?? [] where tier.startDay(ofBin: c.bin) >= fromDay && tier.endDay(ofBin: c.bin) <= toDay {
          bins += c.cell.n
        }
        for w in washesBy["\(l)\u{0}\(ref)"] ?? [] {
          if let a = LabelParse.parse(w.lo), let b = LabelParse.parse(w.hi), let bh = b.hiDay, let al = a.loDay, Int(bh) >= fromDay, Int(al) <= toDay {
            washes += w.n
          }
        }
      }
    }
    let count = marks.items.filter { laneKeys.contains($0.lane) && refSet.contains($0.strand.description) && $0.hiDay >= fromDay && $0.loDay <= toDay }.count
    if marks.truncated { return MarksCheck(ok: false, marks: count, bins: bins, washes: washes, reason: "marks truncated") }
    let ok = count >= bins && count <= bins + washes
    return MarksCheck(ok: ok, marks: count, bins: bins, washes: washes,
                      reason: ok ? nil : "marks (\(count)) do not reconcile with bins (\(bins)) and washes (\(washes))")
  }

  /// `buildCoverageModel(collections, {synthetic, tier})`: the Scroll before any strand is pinned — one lane per collection
  /// with only what the corpus listing states (span, size, selection note). Nothing is counted, so nothing is drawn as
  /// observed, absent or uncovered inside the span (§1.7, §8.8).
  public static func coverageModel(collections: [CorpusCollection], synthetic: Bool = false, tier: Tier = .decades) -> TimelineModel {
    let lanes = collections.map { c -> LaneModel in
      let spanArr = c.span.arrayValue
      let loText = spanArr.flatMap { $0.first?.stringValue }, hiText = spanArr.flatMap { $0.count > 1 ? $0[1].stringValue : nil }
      let lo = LabelParse.parse(loText), hi = LabelParse.parse(hiText)
      let works = c.unit == "works"
      let amount = works ? "\(Format.tokens(Double(c.works))) works" : "\(Format.tokens(Double(c.tokens))) tokens"
      let spanText = spanArr != nil ? "\(spanDisplay(spanArr?.first))–\(spanDisplay(spanArr.flatMap { $0.count > 1 ? $0[1] : nil }))" : "no dated documents"
      var cov = JSONObject()
      cov["tokens"] = .number(Double(c.tokens))
      cov["works"] = .number(Double(c.works))
      cov["docs"] = .number(Double(c.docs))
      cov["span"] = .array([lo?.yLo.map { .number(Double($0)) } ?? .null, hi?.yHi.map { .number(Double($0)) } ?? .null])
      var span: LaneSpan?
      if let lo, let hi, let l = lo.loDay, let h = hi.hiDay { span = LaneSpan(loDay: Int(l), hiDay: Int(h), label: spanText) }
      return LaneModel(
        key: "coll:\(c.slug)", label: c.name, machineLabel: nil, humanLabel: nil,
        unit: works ? "per_thousand_works" : "per_million_tokens", modality: c.modality,
        header: "\(c.name) · \(c.modality) · \(amount), \(spanText)", note: nil, selection: c.selectionNote,
        pending: c.status == "pending" || c.status == "indexing", censor: LaneCensor(left: false, right: false), first: nil, last: nil,
        n: 0, docs: c.docs, undated: c.undated, scheduled: c.scheduled, undatedShare: 0, laneCoverage: .object(cov),
        synthetic: synthetic, coverageUnit: works ? "works" : "tokens", coverage: [], uncovered: [], pendingRuns: [], unloaded: [],
        strands: [], coverageOnly: true, span: span, amount: amount, isTrail: false)
    }
    return TimelineModel(
      tier: tier, range: nil, visible: nil, lanes: lanes, hiddenLanes: 0, hiddenN: 0, units: [], visibleN: 0, rangeN: 0,
      wantMarks: false, override: false, marksCheck: nil, loadedTiles: [], missingTiles: [], complete: true, coverageTrack: [],
      strands: [], rowCount: 0, coverageOnly: true)
  }

  /// A span end as JavaScript's template literal writes it (`${c.span[0]}`).
  static func spanDisplay(_ v: JSONValue?) -> String {
    switch v {
    case .string(let s)?: s
    case .number(let n)?: JSNumber.format(n)
    case .null?: "null"
    case .bool(let b)?: b ? "true" : "false"
    default: "undefined"
    }
  }
}

/// Cached `dates.parseDate` of a server label ('1905', '17 May 1994', 'c. 1960'); nil when undatable (`parseLabel`).
public enum LabelParse {
  private static let cache = Mutex<[String: DateParse?]>([:])

  public static func parse(_ label: String?) -> DateParse? {
    guard let label, !label.isEmpty else { return nil }
    if let hit = cache.withLock({ $0[label] }) { return hit }
    let p = DateGrammar.parse(label, context: DateContext())
    let v: DateParse? = (p.issue == nil && p.loDay != nil) ? p : nil
    cache.withLock { c in
      if c.count > 4000 { c.removeAll(keepingCapacity: true) }
      c[label] = v
    }
    return v
  }
}
