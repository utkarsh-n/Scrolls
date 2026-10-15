// OWNER: N7
// The Scroll's data-client policy (src/ui/timeline/tiles-client.mjs, the state half of viewport.mjs) and the vantage
// clock (playhead.mjs), as pure values the app's `ScrollModel` drives: the query body of a view state, the tile LRU
// (512 tiles; a tile asked for and not returned is loaded-empty, a tile never fetched is unknown — drawn as "loading",
// never as absence), which tiles a viewport needs (visible first, then ±1 viewport of prefetch), the marks window of the
// occurrence override, and the play loop's steps, gaps and seam pauses. Values change discretely by bin; nothing is
// tweened between bins.

import ScrollsContracts
import ScrollsCore

// MARK: - Query

/// `queryBody(view, {maxLanes, formatFilter})`: the TimelineQueryRequest of a view state.
public enum ScrollQuery {
  public static func body(_ view: ViewState, maxLanes: Int? = nil, cutoffs: ViewCutoffs? = nil) -> TimelineQueryRequest {
    let strands = view.strands.map { s -> StrandRequest in
      switch s.id {
      case .number(let n): StrandRequest(type: s.type, ref: .int(n))
      case .string(let t): StrandRequest(type: s.type, ref: .string(t))
      }
    }
    var lanes = LanesRequest(facet: view.lanes.facet, order: view.lanes.order, max: min(view.lanes.max, maxLanes ?? view.lanes.max))
    lanes.run = view.lanes.run.map { RunID(rawValue: Int64($0)) }
    var req = TimelineQueryRequest(strands: strands, corpus: view.corpus, lanes: lanes)
    req.f = ViewState.formatFilter(view.f, withDefaults: true)
    req.toggles = view.toggles
    req.timeBasis = view.timeBasis
    if !view.runs.materialize.isEmpty {
      var m: [String: Int] = [:]
      for (k, v) in view.runs.materialize { m[String(k)] = v }
      req.runs = PinnedRuns(materialize: m)
    }
    if let c = cutoffs, c.importBatch != nil || c.at != nil { req.cutoffs = ViewCutoffs(importBatch: c.importBatch, at: c.at) }
    return req
  }

  /// The pinned strands of a view as the model reads them.
  public static func pins(_ view: ViewState) -> [StrandPin] {
    view.strands.map { s in
      let id: String = switch s.id {
      case .number(let n): String(n)
      case .string(let t): t
      }
      return StrandPin(type: s.type, id: id, glyph: s.glyph)
    }
  }
}

// MARK: - Tiles

/// The tile LRU of one query and data version (`createTilesClient`'s cache).
public struct TileCache: Sendable {
  /// `LRU_MAX`.
  public static let capacity = 512
  /// `MAX_TILES_PER_REQUEST`.
  public static let perRequest = 16
  /// `DEBOUNCE_MS`.
  public static let debounceMilliseconds = 120

  public struct Key: Hashable, Sendable {
    public var tier: Tier
    public var tile: Int64
  }

  /// `${queryKey}|${dataVersion}`; a new base clears everything.
  public private(set) var base: String?
  private var entries: [Key: TileSlot] = [:]
  private var order: [Key] = []
  private var inflight = Set<Key>()
  /// Asked tier → the tier the server answered with (itself until it says otherwise).
  private var answered: [Tier: Tier] = [:]

  public init() {}

  /// `setQuery(queryKey, dataVersion)`: true when the base changed (everything is dropped).
  public mutating func setQuery(_ queryKey: String?, dataVersion: Int?) -> Bool {
    let next = queryKey.map { "\($0)|\(dataVersion ?? 0)" }
    guard next != base else { return false }
    base = next
    entries.removeAll()
    order.removeAll()
    inflight.removeAll()
    answered.removeAll()
    return true
  }

  /// `tierFor(tier)`.
  public func tierFor(_ tier: Tier) -> Tier { answered[tier] ?? tier }

  /// Loaded tiles of a tier for the current query (`tilesFor`).
  public func tiles(_ tier: Tier) -> [Int64: TileSlot] {
    var out: [Int64: TileSlot] = [:]
    for (k, v) in entries where k.tier == tier { out[k.tile] = v }
    return out
  }

  /// Whether a tile is loaded (with or without data).
  public func has(_ tier: Tier, _ tile: Int64) -> Bool { entries[Key(tier: tier, tile: tile)] != nil }

  /// The tiles of `visible` then `prefetch` still to ask for, at most `perRequest`, marked in flight.
  public mutating func take(_ tier: Tier, visible: [Int64], prefetch: [Int64]) -> [Int64] {
    var out: [Int64] = []
    for t in visible + prefetch.filter({ !visible.contains($0) }) {
      let k = Key(tier: tier, tile: t)
      guard entries[k] == nil, !inflight.contains(k), out.count < Self.perRequest else { continue }
      inflight.insert(k)
      out.append(t)
    }
    return out
  }

  /// Records an answer: the tiles returned (at the answered tier) and, when the server answered the asked tier, the
  /// asked tiles it did not return as loaded-empty.
  public mutating func store(asked tier: Tier, tiles asked: [Int64], response: TilesResponse) {
    let got = Tier(code: response.tier) ?? tier
    if got != tier { answered[tier] = got }
    for t in response.tiles { put(Key(tier: got, tile: Int64(t.tile)), .data(t)) }
    if got == tier {
      for t in asked where entries[Key(tier: tier, tile: t)] == nil { put(Key(tier: tier, tile: t), .empty) }
    }
    for t in asked { inflight.remove(Key(tier: tier, tile: t)) }
  }

  /// A request failed: its tiles may be asked again.
  public mutating func release(_ tier: Tier, _ asked: [Int64]) {
    for t in asked { inflight.remove(Key(tier: tier, tile: t)) }
  }

  private mutating func put(_ k: Key, _ v: TileSlot) {
    if entries[k] != nil { order.removeAll { $0 == k } }
    entries[k] = v
    order.append(k)
    while order.count > Self.capacity { entries[order.removeFirst()] = nil }
  }
}

/// What one viewport needs: its visible range, the built range (±1 viewport), the tiles of both.
public struct ViewportPlan: Sendable, Equatable {
  public var tier: Tier
  public var visible: ClosedRange<Double>
  public var range: ClosedRange<Double>
  public var visibleTiles: [Int64]
  public var prefetchTiles: [Int64]

  /// `frameLinear`: visible = the scale's days; range = visible ± one span; tiles of the visible part (≤ 24) first, then
  /// of the range (≤ 48).
  public init(axis: ScrollAxis, width: Double, tier: Tier) {
    let sc = axis.scale(width: width)
    self.tier = tier
    visible = sc.loDay...sc.hiDay
    let span = sc.hiDay - sc.loDay
    range = (sc.loDay - span)...(sc.hiDay + span)
    visibleTiles = tier.tiles(loDay: sc.loDay, hiDay: sc.hiDay, max: 24)
    let vis = visibleTiles
    prefetchTiles = tier.tiles(loDay: range.lowerBound, hiDay: range.upperBound, max: 48).filter { !vis.contains($0) }
  }

  /// `requestMarksFor(model, range, visible)`: the years of the marks window (the range when it holds ≤ 4,000 matches).
  public func marksWindow(rangeN: Int) -> (fromYear: Int, toYear: Int, fromDay: Int, toDay: Int) {
    let r = rangeN <= ScrollModelBuilder.maxMarks ? range : visible
    let fromYear = DayMath.ymdFromDay(Int(r.lowerBound.rounded(.down))).y - 1
    let toYear = DayMath.ymdFromDay(Int(r.upperBound.rounded(.down))).y + 1
    return (fromYear, toYear, DayMath.dayFromYMD(fromYear, 1, 1), DayMath.dayFromYMD(toYear, 12, 31))
  }
}

// MARK: - The vantage clock

/// `playhead.mjs`: stepping by whole bins, the play cadence, auto-pan, gap skipping and the seam pause.
public enum VantageClock {
  /// One bin every 400 ms at 1× (`PLAY_MS`).
  public static let playMilliseconds = 400.0
  /// 1.2 s per step under Reduce Motion (`REDUCED_PLAY_MS`).
  public static let reducedPlayMilliseconds = 1200.0
  /// The pause before skipping a gap (`GAP_PAUSE_MS`).
  public static let gapPauseMilliseconds = 600.0
  /// The pause at the modality seam (`SEAM_PAUSE_MS`).
  public static let seamPauseMilliseconds = 2400.0
  /// The play-speed knob's detents (`SPEEDS`).
  public static let speeds: [Double] = [0.25, 0.5, 1, 2, 4]
  /// Where auto-pan keeps the playhead (share of the width, `PLAYHEAD_AT`).
  public static let playheadAt = 0.7

  /// `stepVantage(day, tier, steps)`.
  public static func step(_ day: Double, tier: Tier, steps: Int) -> Int { tier.stepBinEnd(from: day, steps: steps) }

  /// `autoPanCenter(vantageDay, width, daysPerPx)`: the centre that puts the vantage at 70% of the width.
  public static func autoPanCenter(vantageDay: Double, width: Double, daysPerPoint: Double) -> Double {
    vantageDay - (playheadAt - 0.5) * width * daysPerPoint
  }

  /// `needsAutoPan(x, width)`: the playhead is left of 10% or right of 85%.
  public static func needsAutoPan(x: Double, width: Double) -> Bool { x < width * 0.1 || x > width * 0.85 }

  /// A stretch every shown lane has no sources for.
  public struct Gap: Sendable, Equatable {
    public var loDay: Int
    public var hiDay: Int
    public var label: String
  }

  /// `gapAhead(model, day, tier)`: the bins right after `day` that EVERY shown lane has no sources for, or nil.
  public static func gapAhead(_ model: TimelineModel?, day: Int, tier: Tier) -> Gap? {
    guard let model, !model.lanes.isEmpty else { return nil }
    let nextBin = tier.bin(ofDay: Double(day + 1))
    var lo: Int?
    var hi = Int.max
    for lane in model.lanes {
      guard let run = lane.uncovered.first(where: { $0.binLo <= nextBin && $0.binHi >= nextBin }) else { return nil }
      lo = lo.map { max($0, run.loDay) } ?? run.loDay
      hi = min(hi, run.hiDay)
    }
    let from = max(lo ?? day + 1, day + 1)
    guard hi >= from else { return nil }
    return Gap(loDay: from, hiDay: hi, label: "\(RulerScale.dayLabel(Double(from)))–\(RulerScale.dayLabel(Double(hi)))")
  }

  /// `gapMessage(gap, synthetic)`: "No coverage 1940–1949 in these lanes — skipping. Nothing is inferred."
  public static func gapMessage(_ gap: Gap, synthetic: Bool) -> String {
    "No coverage \(gap.label) in these lanes\(synthetic ? " (synthetic)" : "") — skipping. Nothing is inferred."
  }

  /// `seamCrossed(seams, fromDay, toDay)`: the first seam crossed moving the vantage forward.
  public static func seamCrossed(_ seams: [Seam], from: Int, to: Int) -> Seam? {
    seams.first { s in
      let d = DayMath.dayFromYMD(s.year, 1, 1)
      return from < d && to >= d
    }
  }

  /// What one tick of Play does (`createPlayer` → `tick`).
  public enum Tick: Sendable, Equatable {
    /// Move to `day` (strict) and wait `ms`.
    case advance(day: Int, waitMilliseconds: Double)
    /// Skip a gap: say `message`, jump to `day`, wait the gap pause plus a step.
    case skip(day: Int, message: String, waitMilliseconds: Double)
    /// Pause once at the seam with its caption.
    case seam(day: Int, caption: String, year: Int, waitMilliseconds: Double)
    /// The end of the record: stop.
    case end(day: Int)
  }

  /// One play tick from `day`: the gap skip, the seam pause (once per seam per play), the step, or the end.
  public static func tick(day: Int, tier: Tier, model: TimelineModel?, seams: [Seam], endDay: Int, interval: Double,
                          pausedSeams: Set<Int>, synthetic: Bool) -> Tick {
    if day >= endDay { return .end(day: day) }
    if let gap = gapAhead(model, day: day, tier: tier), gap.hiDay < endDay {
      return .skip(day: gap.hiDay, message: gapMessage(gap, synthetic: synthetic), waitMilliseconds: gapPauseMilliseconds + interval)
    }
    let next = min(step(Double(day), tier: tier, steps: 1), max(endDay, day))
    if let seam = seamCrossed(seams, from: day, to: next), !pausedSeams.contains(seam.year) {
      return .seam(day: next, caption: seam.label, year: seam.year, waitMilliseconds: seamPauseMilliseconds)
    }
    if next >= endDay { return .end(day: next) }
    return .advance(day: next, waitMilliseconds: interval)
  }
}
