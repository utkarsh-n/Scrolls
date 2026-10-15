// OWNER: N7
// Port of src/ui/timeline/display.mjs (IOS-SPEC §4.23, §8.4.7). `DisplayBuilder` turns the model into display lists
// once, without a vantage, storing `revealDay = hiDay` in every primitive the reference gates (observed bars, low ticks,
// caps, washes, marks, coarse bands; their labels inherit it) and `alwaysRevealed` in everything that describes the
// archive (absence, coverage, "no sources", the seam, lane bands), so the vantage is a uniform and Play rebuilds nothing.
//
// The reference's primitives become typed instances in content space (x in days relative to `DisplayList.originDay`, y
// in points), keeping the reference's box exactly: a style says how to draw inside it (an absent bin's box is ±3 pt
// around its dotted line, a low tick's box is 3 pt wide, a cap-end's 2 pt). Every primitive also gets a `PrimMeta` (its
// reference kind, layer, style and where it came from), from which its reference id, `ref` and tooltip lines are
// generated on demand: the app never pays for 20,000 id strings, and G5 compares every one of them.
// `visible(at:)` is the frozen view of a list at a vantage: equal to the reference's `buildDisplay(…, {vantage})` minus
// `simplified` (DV-7), which G5 checks across a vantage sweep.

import CoreGraphics
import ScrollsContracts
import ScrollsCore

// MARK: - Inputs and outputs

/// `buildDisplay`'s options.
public struct DisplayInput: Sendable {
  public var model: TimelineModel
  /// The reference's content origin (the built range's first day, fractional).
  public var originDay: Double
  public var daysPerPoint: Double
  /// The content width in points of the built range.
  public var width: Double
  public var layout: LaneLayout
  /// `view.layers` (washes, coverage, …): 0 turns a layer off.
  public var layers: [String: Int]
  public var seams: [Seam]
  public var seamCollapsed: Bool
  public var textBudget: Int
  public var xOffset: Double
  /// Height of the ruler strip of the top list (`GEOM.rulerH`; 28 pt on the phone).
  public var rulerHeight: Double
  /// Height of the coverage track under the ruler (`GEOM.coverageH`; 10 pt on the phone).
  public var coverageHeight: Double
  /// Fill `DisplayList.referenceIDs` while building (G5); the app asks `DisplayBuild.referenceID(_:)` lazily instead.
  public var referenceIDs: Bool

  public init(model: TimelineModel, originDay: Double, daysPerPoint: Double, width: Double, layout: LaneLayout,
              layers: [String: Int] = [:], seams: [Seam] = [], seamCollapsed: Bool = false,
              textBudget: Int = DisplayBuilder.budget.texts, xOffset: Double = 0, rulerHeight: Double = Geom.rulerH,
              coverageHeight: Double = Geom.coverageH, referenceIDs: Bool = false) {
    self.model = model
    self.originDay = originDay
    self.daysPerPoint = daysPerPoint
    self.width = width
    self.layout = layout
    self.layers = layers
    self.seams = seams
    self.seamCollapsed = seamCollapsed
    self.textBudget = textBudget
    self.xOffset = xOffset
    self.rulerHeight = rulerHeight
    self.coverageHeight = coverageHeight
    self.referenceIDs = referenceIDs
  }
}

/// Where a primitive came from: enough to regenerate its reference id, `ref` and tooltip.
public enum PrimSource: Sendable, Equatable {
  case rulerTick(day: Int)
  case rulerLabel(day: Int, label: String)
  case rulerMinor(bin: Int64)
  case coverageCell(row: Int, cell: Int)
  case coverageUncovered(BinRun)
  case laneBand(lane: Int)
  case span(lane: Int)
  case laneUncovered(lane: Int, run: Int)
  case lanePending(lane: Int, run: Int)
  case laneUnloaded(lane: Int, run: Int)
  case laneCoverage(lane: Int, cell: Int)
  case bar(lane: Int, strand: Int, col: Int)
  case superscript(lane: Int, strand: Int, col: Int)
  case absent(lane: Int, strand: Int, col: Int)
  case lowHatch(lane: Int, strand: Int, col: Int)
  case lowTick(lane: Int, strand: Int, col: Int)
  case lowN(lane: Int, strand: Int, col: Int)
  case capStart(lane: Int, strand: Int, bar: Int)
  case capEnd(lane: Int, strand: Int, bar: Int)
  case wash(lane: Int, strand: Int, wash: Int)
  case washLabel(lane: Int, strand: Int, wash: Int)
  case mark(lane: Int, strand: Int, mark: Int)
  case coarse(group: Int)
  case coarseLabel(group: Int)
  case seamTick(seam: Int)
  case seamLabel(seam: Int)
  case seamLine(seam: Int)
}

/// The reference identity of a primitive (kind, layer, style, openable) and its source.
public struct PrimMeta: Sendable, Equatable {
  public var kind: PrimKind
  public var layer: PrimLayer
  public var style: ScrollStyle
  public var openable: Bool
  public var source: PrimSource
  /// Which typed array holds it and at which index.
  public var slot: PrimSlot
}

/// The typed array and index of a primitive.
public enum PrimSlot: Sendable, Equatable {
  case band(Int), wash(Int), bar(Int), tick(Int), diamond(Int), glyph(Int), label(Int)
}

/// Marks grouped by a date coarser than the tier (`coarse` bands of the occurrence override).
public struct CoarseGroup: Sendable, Equatable {
  public var lane: Int
  public var strand: Int
  public var loDay: Int
  public var hiDay: Int
  public var items: [Mark]
  public var label: String
  public var precision: String
}

/// Shapes and marks counted while building (`stats`).
public struct DisplayStats: Sendable, Equatable {
  public var rects = 0, ticks = 0, texts = 0, marks = 0
}

/// One build of the Scroll: the top list (ruler, coverage track, seam tick and caption) and the lanes list, each with its
/// metadata, plus everything they were built from.
public struct DisplayBuild: Sendable {
  public var top: DisplayList
  public var lanes: DisplayList
  public var topMeta: [PrimMeta]
  public var laneMeta: [PrimMeta]
  public var model: TimelineModel
  public var layout: LaneLayout
  public var input: DisplayInputSummary
  public var coarseGroups: [CoarseGroup]
  public var stats: DisplayStats
  /// The reference's `overBudget`, counted over ungated primitives (DV-7).
  public var overBudget: Bool
  public var tier: Tier
}

/// The geometry a build was made with (kept so ids, tips and reference coordinates can be regenerated).
public struct DisplayInputSummary: Sendable, Equatable {
  public var originDay: Double
  public var daysPerPoint: Double
  public var width: Double
  public var xOffset: Double
  public var rulerHeight: Double
  public var coverageHeight: Double
  public var seams: [Seam]
  public var seamCollapsed: Bool
}

// MARK: - The builder

/// Builds display lists (`buildDisplay`).
public enum DisplayBuilder {
  /// Per-frame budgets of §8.3 (`BUDGET`).
  public static let budget = (shapes: 20000, marks: 4000, texts: 150)
  /// Opacity of a ghosted primitive (`GHOST_ALPHA`).
  public static let ghostAlpha = Visibility.ghostOpacity

  /// Width of the seam caption at its 10.5 pt semibold size (`seamLabelWidth`).
  public static func seamLabelWidth(_ words: String) -> Double { (Double(words.utf16.count) * 6.4).rounded(.up) + 4 }
  /// Width of a ruler label at 11.5 pt in the numeral font (`rulerLabelWidth`).
  public static func rulerLabelWidth(_ words: String) -> Double { (Double(words.utf16.count) * 7.2).rounded(.up) + 2 }
  /// Width of a wash label at 10 pt (`washLabelWidth`).
  public static func washLabelWidth(_ words: String) -> Double { (Double(words.utf16.count) * 5.8).rounded(.up) + 4 }

  /// `PRECISION_RANK`.
  static let precisionRank: [String: Int] = ["millennium": 0, "century": 1, "decade": 2, "year": 3, "month": 4, "day": 5]

  /// Builds the display lists of a model. `@concurrent`: runs off the caller's actor (≤ 12 ms p95 for 20k cells).
  @concurrent
  public static func build(_ input: DisplayInput) async -> DisplayBuild {
    EngineAssert.offMain()
    return buildSync(input)
  }

  /// The same build on the calling thread (tests, the CLI, snapshots).
  public static func buildSync(_ input: DisplayInput) -> DisplayBuild {
    var b = Builder(input)
    b.run()
    return b.finish()
  }
}

/// The mutable state of one build.
struct Builder {
  let input: DisplayInput
  let model: TimelineModel
  let dpp: Double
  let tier: Tier
  /// The integer origin every `d` is relative to (the built range's centre).
  let originInt: Int
  /// `originDay(reference) − originInt`.
  let originFrac: Double
  var top = ListBuilder()
  var lanes = ListBuilder()
  var stats = DisplayStats()
  var texts = 0
  var coarseGroups: [CoarseGroup] = []

  init(_ input: DisplayInput) {
    self.input = input
    model = input.model
    dpp = input.daysPerPoint
    tier = input.model.tier
    let centre = input.originDay + (input.width / 2) * input.daysPerPoint
    originInt = Int(centre.rounded(.down))
    originFrac = input.originDay - Double(originInt)
  }

  /// `X(day)`: content x of a day.
  @inline(__always) func X(_ day: Double) -> Double { (day - input.originDay) / dpp + input.xOffset }
  /// Days relative to `originInt` of a content x.
  @inline(__always) func D(_ x: Double) -> Float { Float((x - input.xOffset) * dpp + originFrac) }

  mutating func countShape(_ kind: PrimKind) {
    if kind == .tick || kind == .diamond { stats.ticks += 1 } else if kind != .text && kind != .glyph { stats.rects += 1 }
  }

  /// `text(list, prim)`: false once the text budget is spent.
  mutating func takeText() -> Bool {
    guard texts < input.textBudget else { return false }
    texts += 1
    return true
  }

  // MARK: run

  mutating func run() {
    let showWashes = input.layers["washes"] != 0
    let showCoverage = input.layers["coverage"] != 0
    let rulerH = input.rulerHeight, covH = input.coverageHeight

    // ── Top: ruler ticks and labels (labels first in the text budget), coverage track ──
    let scale = AxisScale(centerDay: input.originDay + (input.width / 2) * dpp, daysPerPoint: dpp, width: input.width)
    for t in RulerScale.ticks(scale) {
      let tx = t.x + input.xOffset
      top.tick(d: D(tx), y0: rulerH - 10, y1: rulerH, width: 0, style: .rulerMajor, flags: [], reveal: alwaysRevealed,
               meta: meta(.tick, .bg, .rulerMajor, false, .rulerTick(day: t.day)), ref: nil)
      countShape(.tick)
      if takeText() {
        top.label(d: D(tx + 5), y: rulerH - 12, text: t.label, role: .rulerLabel, align: 0, flags: [], reveal: alwaysRevealed,
                  meta: meta(.text, .bg, .rulerLabel, false, .rulerLabel(day: t.day, label: t.label)))
      }
    }
    // Minor ticks at bin edges.
    let rLo = input.originDay, rHi = input.originDay + input.width * dpp
    let b0 = tier.bin(ofDay: rLo), b1 = tier.bin(ofDay: rHi)
    if b1 - b0 <= 2000 {
      var b = b0
      while b <= b1 + 1 {
        let x = X(Double(tier.startDay(ofBin: b)))
        top.tick(d: D(x), y0: rulerH - 4, y1: rulerH, width: 0, style: .rulerMinor, flags: [], reveal: alwaysRevealed,
                 meta: meta(.tick, .bg, .rulerMinor, false, .rulerMinor(bin: b)), ref: nil)
        countShape(.tick)
        b += 1
      }
    }
    let ty = rulerH
    if showCoverage {
      let rows = max(1, model.coverageTrack.count)
      let rowH = ((covH - 4) / Double(rows)).rounded(.down)
      for (r, row) in model.coverageTrack.enumerated() {
        for (ci, c) in row.cells.enumerated() {
          let style = ScrollStyle.coverage(c.cls)
          top.bar(d0: D(X(Double(c.loDay))), d1: D(X(Double(c.hiDay + 1))), y0: ty + 2 + Double(r) * rowH,
                  y1: ty + 2 + Double(r + 1) * rowH - 1, style: style, flags: [], reveal: alwaysRevealed,
                  meta: meta(.rect, .bg, style, false, .coverageCell(row: r, cell: ci)),
                  ref: .band(LaneKey(rawValue: "coverage:\(row.unit)")))
          countShape(.rect)
        }
      }
      for run in commonRuns(model.lanes.map(\.uncovered)) {
        top.band(d0: D(X(Double(run.loDay))), d1: D(X(Double(run.hiDay + 1))), y0: ty + 2, y1: ty + covH - 2, style: .hatch,
                 pattern: .hatch, flags: [], reveal: alwaysRevealed,
                 meta: meta(.band, .bg, .hatch, false, .coverageUncovered(run)), ref: .band(LaneKey(rawValue: "")))
        countShape(.band)
      }
    }

    // ── Lanes ──
    let model = self.model
    let presence = tier == .millennia
    let slotH = input.layout.slotH
    let k = min(1.6, max(1, slotH / Geom.slotH))
    let markH = max(Geom.markH, min(28, slotH * 0.5))
    let diamond = max(Geom.diamond, min(9, slotH * 0.16))
    let bracketH = Geom.bracketH * k
    let ghostBars = model.override

    for (li, lane) in model.lanes.enumerated() {
      guard let lay = input.layout.lane(lane.key) else { continue }
      let ly0 = lay.y, ly1 = lay.y + lay.h
      let laneStyle: ScrollStyle = lay.index % 2 == 1 ? .laneOdd : .laneEven
      lanes.band(d0: D(input.xOffset), d1: D(input.xOffset + input.width), y0: ly0, y1: ly1, style: laneStyle, pattern: .none,
                 flags: [], reveal: alwaysRevealed, meta: meta(.band, .bg, laneStyle, false, .laneBand(lane: li)), ref: nil)
      countShape(.band)
      if lane.coverageOnly {
        if let span = lane.span {
          let mid = (ly0 + ly1) / 2, hh = min(10, (ly1 - ly0) / 4)
          lanes.band(d0: D(X(Double(span.loDay))), d1: D(X(Double(span.hiDay + 1))), y0: mid - hh, y1: mid + hh, style: .covSpan,
                     pattern: .none, flags: lane.synthetic ? .synthetic : [], reveal: alwaysRevealed,
                     meta: meta(.band, .data, .covSpan, false, .span(lane: li)), ref: .band(LaneKey(rawValue: lane.key)))
          countShape(.band)
        }
        continue
      }
      for (ri, r) in lane.uncovered.enumerated() {
        lanes.band(d0: D(X(Double(r.loDay))), d1: D(X(Double(r.hiDay + 1))), y0: ly0, y1: ly1, style: .hatch, pattern: .hatch,
                   flags: [], reveal: alwaysRevealed, meta: meta(.band, .bg, .hatch, false, .laneUncovered(lane: li, run: ri)),
                   ref: .band(LaneKey(rawValue: lane.key)))
        countShape(.band)
      }
      for (ri, r) in lane.pendingRuns.enumerated() {
        lanes.band(d0: D(X(Double(r.loDay))), d1: D(X(Double(r.hiDay + 1))), y0: ly0, y1: ly1, style: .dots, pattern: .dots,
                   flags: [], reveal: alwaysRevealed, meta: meta(.band, .bg, .dots, false, .lanePending(lane: li, run: ri)),
                   ref: .band(LaneKey(rawValue: lane.key)))
        countShape(.band)
      }
      for (ri, r) in lane.unloaded.enumerated() {
        lanes.band(d0: D(X(Double(r.loDay))), d1: D(X(Double(r.hiDay + 1))), y0: ly0, y1: ly1, style: .loading, pattern: .none,
                   flags: [], reveal: alwaysRevealed, meta: meta(.band, .bg, .loading, false, .laneUnloaded(lane: li, run: ri)), ref: nil)
        countShape(.band)
      }
      if showCoverage {
        for (ci, c) in lane.coverage.enumerated() {
          let style = ScrollStyle.coverage(c.cls)
          lanes.bar(d0: D(X(Double(c.loDay))), d1: D(X(Double(c.hiDay + 1))), y0: ly1 - Geom.underlayH, y1: ly1, style: style,
                    flags: [], reveal: alwaysRevealed, meta: meta(.rect, .bg, style, false, .laneCoverage(lane: li, cell: ci)), ref: nil)
          countShape(.rect)
        }
      }

      for (si, s) in lane.strands.enumerated() {
        let slot = si < lay.slots.count ? lay.slots[si] : lay.slots[0]
        let c = s.cols
        let mx = model.unitMax(lane.unit)
        let laneKey = LaneKey(rawValue: lane.key)
        for i in 0..<c.count {
          let x0 = X(Double(c.loDay[i])), x1 = X(Double(c.hiDay[i]) + 1)
          let st = c.state[i]
          let flags = c.flags[i]
          let ref = PrimRef.bin(BinRef(lane: laneKey, strand: s.ref, tier: tier, bin: c.bin[i], index: Int32(i)))
          let hi = Int32(c.hiDay[i])
          switch st {
          case .observed:
            let rate = c.rate[i]
            var h = presence || !rate.isFinite ? slot.h * 0.4 : (mx > 0 ? (rate / mx) * 0.7 * slot.h : 2)
            h = max(2, h)
            let first = i == 0 || c.bin[i - 1] != c.bin[i] - 1 || c.state[i - 1] != .observed
            let last = i == c.count - 1 || c.bin[i + 1] != c.bin[i] + 1 || c.state[i + 1] != .observed
            let style: ScrollStyle = ghostBars ? .barBackdrop : (c.n[i] < 5 ? .barSparse : .bar)
            var f = PrimFlags(rawValue: flags).union(.openable)
            if first { f.insert(.roundLeading) }
            if last { f.insert(.roundTrailing) }
            lanes.bar(d0: D(x0), d1: D(x1), y0: slot.mid - h / 2, y1: slot.mid + h / 2, style: style, flags: f, reveal: hi,
                      meta: meta(.rect, .data, style, true, .bar(lane: li, strand: si, col: i)), ref: ref)
            countShape(.rect)
            let single = PrimFlags(rawValue: flags).contains(.singleSource), est = PrimFlags(rawValue: flags).contains(.estimatedMajority)
            if !ghostBars && (single || est) && x1 - x0 >= 10, takeText() {
              lanes.label(d: D(x1 - 2), y: slot.mid - h / 2 - 2, text: (est ? "≈" : "") + (single ? "¹" : ""), role: .superscript,
                          align: 2, flags: [], reveal: hi, meta: meta(.text, .data, .superscript, false, .superscript(lane: li, strand: si, col: i)))
            }
          case .absent:
            lanes.bar(d0: D(x0), d1: D(x1), y0: slot.mid - 3, y1: slot.mid + 3, style: .absent, flags: PrimFlags(rawValue: flags).union(.openable),
                      reveal: alwaysRevealed, meta: meta(.path, .data, .absent, true, .absent(lane: li, strand: si, col: i)), ref: ref)
            countShape(.path)
          case .low:
            lanes.band(d0: D(x0), d1: D(x1), y0: slot.y, y1: slot.y + slot.h, style: .hatchLow, pattern: .hatchLow, flags: [],
                       reveal: alwaysRevealed, meta: meta(.band, .bg, .hatchLow, false, .lowHatch(lane: li, strand: si, col: i)), ref: nil)
            countShape(.band)
            if c.n[i] > 0 {
              let cx = (x0 + x1) / 2
              lanes.tick(d: D(cx), y0: slot.mid - 4, y1: slot.mid + 4, width: 3, style: .lowTick,
                         flags: PrimFlags(rawValue: flags).union(.openable), reveal: hi,
                         meta: meta(.tick, .data, .lowTick, true, .lowTick(lane: li, strand: si, col: i)), ref: ref)
              countShape(.tick)
              if x1 - x0 >= 18, takeText() {
                lanes.label(d: D(cx + 4), y: slot.mid + 4, text: String(c.n[i]), role: .lowN, align: 0, flags: [], reveal: hi,
                            meta: meta(.text, .data, .lowN, false, .lowN(lane: li, strand: si, col: i)))
              }
            } else {
              lanes.band(d0: D(x0), d1: D(x1), y0: slot.mid - 4, y1: slot.mid + 4, style: .none, pattern: .none, flags: .openable,
                         reveal: alwaysRevealed, meta: meta(.band, .data, .none, true, .lowTick(lane: li, strand: si, col: i)), ref: ref)
              countShape(.band)
            }
          case .uncovered, .pending:
            break
          }
        }

        // Caps: the strand glyph at the first observed date (◁ when censored), a 2 pt tick at the last (▷).
        if !model.override {
          let glyph = s.cols.glyph
          for (bi, bar) in s.bars.enumerated() {
            let sc = bar.startCap, ec = bar.endCap
            let startRef = PrimRef.bin(BinRef(lane: laneKey, strand: s.ref, tier: tier, bin: c.bin[bar.start], index: Int32(bar.start)))
            let startStyle: ScrollStyle = sc.censored ? .capChevron : .capStart
            lanes.glyph(d: D(X(Double(sc.day))), y: slot.mid, text: sc.censored ? "◁" : glyph,
                        size: JSNumber.round((sc.censored ? 12 : 10) * k), style: startStyle, flags: .openable,
                        reveal: Int32(c.hiDay[bar.start]), meta: meta(.glyph, .data, startStyle, true, .capStart(lane: li, strand: si, bar: bi)),
                        ref: startRef)
            countShape(.glyph)
            let ex = X(Double(ec.day + 1))
            let endRef = PrimRef.bin(BinRef(lane: laneKey, strand: s.ref, tier: tier, bin: c.bin[bar.end], index: Int32(bar.end)))
            if ec.censored {
              lanes.glyph(d: D(ex), y: slot.mid, text: "▷", size: JSNumber.round(12 * k), style: .capChevron, flags: .openable,
                          reveal: Int32(bar.hiDay), meta: meta(.glyph, .data, .capChevron, true, .capEnd(lane: li, strand: si, bar: bi)),
                          ref: endRef)
              countShape(.glyph)
            } else {
              lanes.tick(d: D(ex), y0: slot.mid - slot.h * 0.35, y1: slot.mid + slot.h * 0.35, width: 2, style: .capEnd,
                         flags: .openable, reveal: Int32(bar.hiDay),
                         meta: meta(.rect, .data, .capEnd, true, .capEnd(lane: li, strand: si, bar: bi)), ref: endRef)
              countShape(.rect)
            }
          }
        }

        // Precision washes: translucent bands across [lo, hi] with a count label; never added to bars or rates. A label is
        // written only where it fits inside its band and clears every label already written in this slot.
        if showWashes && !model.override {
          var washLabels: [(Double, Double)] = []
          for (wi, w) in s.washes.enumerated() {
            let x0 = X(Double(w.loDay)), x1 = X(Double(w.hiDay + 1))
            let style: ScrollStyle = w.synthetic ? .washSyn : .wash
            let feather: Float = w.circa ? 0.1 : 0
            lanes.wash(d0: D(x0), d1: D(x1), y0: slot.y + 2, y1: slot.y + slot.h - 2, style: style,
                       flags: w.synthetic ? [.openable, .synthetic] : .openable, feather: feather, reveal: Int32(clamping: w.hiDay),
                       meta: meta(.wash, .data, style, true, .wash(lane: li, strand: si, wash: wi)),
                       ref: .wash(WashRef(lane: laneKey, strand: s.ref, loDay: Day(clamping: w.loDay), hiDay: Day(clamping: w.hiDay), label: w.label)))
            countShape(.wash)
            let words = "\(w.n) · \(w.label)"
            let lw = DisplayBuilder.washLabelWidth(words)
            let lx = x0 + 4
            if x1 - x0 >= max(48, lw + 8) && !washLabels.contains(where: { lx < $0.1 && lx + lw > $0.0 }) {
              washLabels.append((lx - 4, lx + lw + 4))
              if takeText() {
                lanes.label(d: D(lx), y: slot.y + slot.h - 4, text: words, role: .washLabel, align: 0, flags: [],
                            reveal: Int32(clamping: w.hiDay), meta: meta(.text, .data, .washLabel, false, .washLabel(lane: li, strand: si, wash: wi)))
              }
            }
          }
        }

        // Individual marks (occurrence override, §1.6): ticks, diamonds, uncertainty brackets, coarse-dated bands.
        if model.override, let marks = s.marks {
          let tierRank = tier.rawValue
          var coarseOrder: [String] = []
          var coarse: [String: CoarseGroup] = [:]
          for (mi, m) in marks.enumerated() {
            let rank = DisplayBuilder.precisionRank[m.precision] ?? -1
            if tierRank >= 4 && rank < tierRank {
              let key = "\(m.loDay):\(m.hiDay)"
              if coarse[key] == nil {
                coarse[key] = CoarseGroup(lane: li, strand: si, loDay: m.loDay, hiDay: m.hiDay, items: [],
                                          label: ScrollModelBuilder.markLabel(m), precision: m.precision)
                coarseOrder.append(key)
              }
              coarse[key]!.items.append(m)
              continue
            }
            let x0 = X(Double(m.loDay)), x1 = X(Double(m.hiDay + 1))
            let ref: PrimRef = m.occ.map { .occurrence($0) } ?? .passage(m.passage)
            let src = PrimSource.mark(lane: li, strand: si, mark: mi)
            let reveal = Int32(clamping: m.hiDay)
            let f: PrimFlags = m.synthetic ? [.openable, .synthetic] : .openable
            if x1 - x0 < 12 {
              let cx = (x0 + x1) / 2
              if m.kind == "title" {
                lanes.diamond(d: D(cx), y: slot.mid, size: Float(diamond / 2), style: .markTitle, flags: f, reveal: reveal,
                              meta: meta(.diamond, .data, .markTitle, true, src), ref: ref)
                countShape(.diamond)
              } else {
                let style: ScrollStyle = m.basis == "estimated" ? .markEst : .markText
                lanes.tick(d: D(cx), y0: slot.mid - markH / 2, y1: slot.mid + markH / 2, width: 1, style: style, flags: f,
                           reveal: reveal, meta: meta(.tick, .data, style, true, src), ref: ref)
                countShape(.tick)
              }
            } else {
              let style: ScrollStyle = switch m.basis {
              case "estimated": .bracketEst
              case "derived": .bracketDerived
              case "period": .bracketPeriod
              default: .bracketStated
              }
              lanes.bar(d0: D(x0), d1: D(x1), y0: slot.mid - bracketH / 2, y1: slot.mid + bracketH / 2, style: style, flags: f,
                        reveal: reveal, meta: meta(.path, .data, style, true, src), ref: ref)
              countShape(.path)
            }
            stats.marks += 1
          }
          for key in coarseOrder {
            let g = coarse[key]!
            let gi = coarseGroups.count
            coarseGroups.append(g)
            let x0 = X(Double(g.loDay)), x1 = X(Double(g.hiDay + 1))
            let first = g.items[0]
            let ref: PrimRef = first.occ.map { .occurrence($0) } ?? .passage(first.passage)
            lanes.band(d0: D(x0), d1: D(x1), y0: slot.y + 1, y1: slot.y + 1 + Geom.coarseH, style: .coarse, pattern: .none,
                       flags: .openable, reveal: Int32(clamping: g.hiDay), meta: meta(.band, .data, .coarse, true, .coarse(group: gi)), ref: ref)
            countShape(.band)
            if x1 - x0 >= Geom.labelRoom, takeText() {
              lanes.label(d: D(x0 + 4), y: slot.y + 1 + Geom.coarseH + 9, text: "\(g.items.count) dated only to \(g.label)",
                          role: .coarseLabel, align: 0, flags: [], reveal: Int32(clamping: g.hiDay),
                          meta: meta(.text, .data, .coarseLabel, false, .coarseLabel(group: gi)))
            }
          }
        }
      }
    }

    // ── The modality seam (§1.10): a permanent line across all lanes; collapsible to a ruler tick, never hidden ──
    for (si, seam) in Seams.drawable(input.seams).enumerated() {
      let x = X(Double(Seams.day(seam)))
      top.tick(d: D(x), y0: 0, y1: rulerH, width: 0, style: .seamTick, flags: [], reveal: alwaysRevealed,
               meta: meta(.tick, .bg, .seamTick, false, .seamTick(seam: si)), ref: .seam(Day(clamping: Seams.day(seam))))
      countShape(.tick)
      if !input.seamCollapsed {
        let words = Seams.shortLabel(seam)
        if takeText() {
          top.label(d: D(x), y: 11, text: words, role: .seamLabel, align: 0, flags: [], reveal: alwaysRevealed,
                    meta: meta(.text, .bg, .seamLabel, false, .seamLabel(seam: si)))
        }
        lanes.tick(d: D(x), y0: 0, y1: input.layout.height, width: 6, style: .seam, flags: [], reveal: alwaysRevealed,
                   meta: meta(.path, .bg, .seam, false, .seamLine(seam: si)), ref: .seam(Day(clamping: Seams.day(seam))))
        countShape(.path)
      }
    }
    stats.texts = texts
  }

  func meta(_ kind: PrimKind, _ layer: PrimLayer, _ style: ScrollStyle, _ openable: Bool, _ source: PrimSource) -> PrimMeta {
    PrimMeta(kind: kind, layer: layer, style: style, openable: openable, source: source, slot: .band(0))
  }

  /// `commonRuns(lists, tier)`: bin runs every list contains (bins that no shown lane covers).
  func commonRuns(_ lists: [[BinRun]]) -> [BinRun] {
    guard !lists.isEmpty else { return [] }
    var bins: Set<Int64>?
    for runs in lists {
      var set = Set<Int64>()
      for r in runs { for b in r.binLo...r.binHi { set.insert(b) } }
      bins = bins.map { $0.intersection(set) } ?? set
    }
    var out: [BinRun] = []
    for b in (bins ?? []).sorted() {
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

  // MARK: finish

  mutating func finish() -> DisplayBuild {
    let ppd = 1 / dpp
    let summary = DisplayInputSummary(originDay: input.originDay, daysPerPoint: dpp, width: input.width, xOffset: input.xOffset,
                                      rulerHeight: input.rulerHeight, coverageHeight: input.coverageHeight, seams: input.seams,
                                      seamCollapsed: input.seamCollapsed)
    var topList = top.list(originDay: Day(clamping: originInt), pointsPerDay: ppd)
    var laneList = lanes.list(originDay: Day(clamping: originInt), pointsPerDay: ppd)
    laneList.lanes = model.lanes.map { l in
      let box = input.layout.lane(l.key)
      return LaneSeries(key: LaneKey(rawValue: l.key), label: l.label, unit: l.unit, coverageUnit: l.coverageUnit, modality: l.modality,
                        synthetic: l.synthetic, y0: Float(box?.y ?? 0), y1: Float((box?.y ?? 0) + (box?.h ?? 0)), tier: tier,
                        strands: l.strands.map(\.cols), uncovered: l.uncovered.map(\.interval), pending: l.pendingRuns.map(\.interval))
    }
    var build = DisplayBuild(
      top: topList, lanes: laneList, topMeta: top.meta, laneMeta: lanes.meta, model: model, layout: input.layout, input: summary,
      coarseGroups: coarseGroups, stats: stats,
      overBudget: stats.rects + stats.ticks > DisplayBuilder.budget.shapes || stats.marks > DisplayBuilder.budget.marks, tier: tier)
    topList.hit = HitGrid.build(list: topList, meta: build.topMeta)
    laneList.hit = HitGrid.build(list: laneList, meta: build.laneMeta)
    build.top = topList
    build.lanes = laneList
    if input.referenceIDs {
      for (i, _) in build.topMeta.enumerated() { build.top.referenceIDs[PrimID(rawValue: UInt32(i))] = build.referenceID(.top, PrimID(rawValue: UInt32(i))) }
      for (i, _) in build.laneMeta.enumerated() { build.lanes.referenceIDs[PrimID(rawValue: UInt32(i))] = build.referenceID(.lanes, PrimID(rawValue: UInt32(i))) }
    }
    return build
  }
}

/// Collects one display list's typed instances and metadata in emission order (PrimID = emission index).
struct ListBuilder {
  var bands: [BandPrim] = [], washes: [WashPrim] = [], bars: [BarPrim] = [], ticks: [TickPrim] = []
  var diamonds: [DiamondPrim] = [], glyphs: [GlyphPrim] = [], labels: [LabelPrim] = []
  var labelRuns: [LabelKey: LabelRun] = [:]
  var labelKeys: [LabelRun: LabelKey] = [:]
  var refs: [PrimID: PrimRef] = [:]
  var meta: [PrimMeta] = []

  var nextID: PrimID { PrimID(rawValue: UInt32(meta.count)) }

  mutating func record(_ m: PrimMeta, slot: PrimSlot, ref: PrimRef?) {
    var m = m
    m.slot = slot
    if let ref { refs[nextID] = ref }
    meta.append(m)
  }

  mutating func key(_ text: String, role: ScrollStyle) -> LabelKey {
    let run = LabelRun(text: text, role: role.rawValue)
    if let k = labelKeys[run] { return k }
    let k = LabelKey(rawValue: UInt32(labelKeys.count))
    labelKeys[run] = k
    labelRuns[k] = run
    return k
  }

  mutating func band(d0: Float, d1: Float, y0: Double, y1: Double, style: ScrollStyle, pattern: PatternID, flags: PrimFlags,
                     reveal: Int32, meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    bands.append(BandPrim(d0: d0, d1: d1, y0: Float(y0), y1: Float(y1), style: style.rawValue, pattern: pattern.rawValue,
                          flags: flags.rawValue, revealDay: reveal, id: id))
    record(m, slot: .band(bands.count - 1), ref: ref)
  }

  mutating func bar(d0: Float, d1: Float, y0: Double, y1: Double, style: ScrollStyle, flags: PrimFlags, reveal: Int32,
                    meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    bars.append(BarPrim(d0: d0, d1: d1, y0: Float(y0), y1: Float(y1), style: style.rawValue, flags: flags.rawValue, revealDay: reveal, id: id))
    record(m, slot: .bar(bars.count - 1), ref: ref)
  }

  mutating func wash(d0: Float, d1: Float, y0: Double, y1: Double, style: ScrollStyle, flags: PrimFlags, feather: Float,
                     reveal: Int32, meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    washes.append(WashPrim(d0: d0, d1: d1, y0: Float(y0), y1: Float(y1), style: style.rawValue, flags: flags.rawValue,
                           featherLo: feather, featherHi: feather, revealDay: reveal, id: id))
    record(m, slot: .wash(washes.count - 1), ref: ref)
  }

  mutating func tick(d: Float, y0: Double, y1: Double, width: Float, style: ScrollStyle, flags: PrimFlags, reveal: Int32,
                     meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    ticks.append(TickPrim(d: d, y0: Float(y0), y1: Float(y1), width: width, style: style.rawValue, flags: flags.rawValue,
                          revealDay: reveal, id: id))
    record(m, slot: .tick(ticks.count - 1), ref: ref)
  }

  mutating func diamond(d: Float, y: Double, size: Float, style: ScrollStyle, flags: PrimFlags, reveal: Int32, meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    diamonds.append(DiamondPrim(d: d, y: Float(y), size: size, style: style.rawValue, flags: flags.rawValue, revealDay: reveal, id: id))
    record(m, slot: .diamond(diamonds.count - 1), ref: ref)
  }

  mutating func glyph(d: Float, y: Double, text: String, size: Double, style: ScrollStyle, flags: PrimFlags, reveal: Int32,
                      meta m: PrimMeta, ref: PrimRef?) {
    let id = nextID
    let k = key(text, role: style)
    glyphs.append(GlyphPrim(d: d, y: Float(y), glyph: k, size: Float(size), style: style.rawValue, flags: flags.rawValue,
                            revealDay: reveal, id: id))
    record(m, slot: .glyph(glyphs.count - 1), ref: ref)
  }

  mutating func label(d: Float, y: Double, text: String, role: ScrollStyle, align: UInt8, flags: PrimFlags, reveal: Int32, meta m: PrimMeta) {
    let id = nextID
    let k = key(text, role: role)
    labels.append(LabelPrim(d: d, y: Float(y), key: k, align: align, style: role.rawValue, flags: flags.rawValue, revealDay: reveal, id: id))
    record(m, slot: .label(labels.count - 1), ref: nil)
  }

  func list(originDay: Day, pointsPerDay: Double) -> DisplayList {
    DisplayList(originDay: originDay, bands: bands, washes: washes, bars: bars, ticks: ticks, diamonds: diamonds, arcs: [],
                glyphs: glyphs, labels: labels, labelRuns: labelRuns, refs: refs, referenceIDs: [:], lanes: [], simplified: nil,
                hit: HitGrid(pointsPerDay: pointsPerDay))
  }
}

// MARK: - The vantage view

extension DisplayList {
  /// The list as drawn at vantage `v`: primitives whose `visibility(revealDay:at:)` is `.hide` removed, `.ghost` ones kept
  /// and flagged ghosted, refs and the hit grid filtered alike; nil is no vantage (everything shown). Equal to the
  /// reference's `buildDisplay(…, {vantage})` minus `simplified` (DV-7).
  public func visible(at v: Vantage?) -> DisplayList {
    guard let v else { return self }
    var out = self
    var hidden = Set<PrimID>()
    func filter<T>(_ a: [T], reveal: (T) -> Int32, id: (T) -> PrimID, ghost: (inout T) -> Void) -> [T] {
      var r: [T] = []
      r.reserveCapacity(a.count)
      for var p in a {
        switch visibility(revealDay: reveal(p), at: v) {
        case .show: r.append(p)
        case .ghost:
          ghost(&p)
          r.append(p)
        case .hide: hidden.insert(id(p))
        }
      }
      return r
    }
    let g = PrimFlags.ghost.rawValue
    out.bands = filter(bands, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.washes = filter(washes, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.bars = filter(bars, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.ticks = filter(ticks, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.diamonds = filter(diamonds, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.arcs = filter(arcs, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.glyphs = filter(glyphs, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    out.labels = filter(labels, reveal: \.revealDay, id: \.id) { $0.flags |= g }
    if !hidden.isEmpty {
      out.refs = refs.filter { !hidden.contains($0.key) }
      out.referenceIDs = referenceIDs.filter { !hidden.contains($0.key) }
      out.hit = hit.removing(hidden)
    }
    return out
  }

  /// Every primitive id of the list with its reveal day, in no particular order.
  public var allPrims: [(id: PrimID, revealDay: Int32, flags: UInt16)] {
    var out: [(PrimID, Int32, UInt16)] = []
    out.reserveCapacity(instanceCount)
    for p in bands { out.append((p.id, p.revealDay, p.flags)) }
    for p in washes { out.append((p.id, p.revealDay, p.flags)) }
    for p in bars { out.append((p.id, p.revealDay, p.flags)) }
    for p in ticks { out.append((p.id, p.revealDay, p.flags)) }
    for p in diamonds { out.append((p.id, p.revealDay, p.flags)) }
    for p in arcs { out.append((p.id, p.revealDay, p.flags)) }
    for p in glyphs { out.append((p.id, p.revealDay, p.flags)) }
    for p in labels { out.append((p.id, p.revealDay, p.flags)) }
    return out
  }
}

extension DisplayBuild {
  /// Which of the two lists.
  public enum Part: Sendable { case top, lanes }

  public func list(_ part: Part) -> DisplayList { part == .top ? top : lanes }
  public func meta(_ part: Part) -> [PrimMeta] { part == .top ? topMeta : laneMeta }

  /// The vantage view of both lists.
  public func visible(at v: Vantage?) -> DisplayBuild {
    var b = self
    b.top = top.visible(at: v)
    b.lanes = lanes.visible(at: v)
    return b
  }
}
