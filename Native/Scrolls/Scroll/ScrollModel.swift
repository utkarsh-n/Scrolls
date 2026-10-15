// OWNER: N7
// The Scroll's view model (IOS-SPEC §4.5–§4.6, §4.23). It owns what one viewport needs: the axis (centre day and days
// per point; changed every frame by pan and pinch), the lane scroll, the query of the view state, the tile cache, the
// marks window and the current display build, and it decides what rebuilds what (§4.23's table):
//   · pan, pinch within a tier, lane scroll, scrub, Play, strict/context, selection → uniforms only (a frame);
//   · a tier crossing, a pan beyond the prefetched ±1 viewport, a zoom far from the build's → tiles → build off the main
//     actor → swap (the old tier stays drawn at 40% until then);
//   · a new query key (strands, lanes, filters, corpus) → query → tiles → build → swap.
// The frozen bus is `AppModel.viewState`: the axis is committed to it 180 ms after a gesture ends, the vantage and the
// selection are read from it and written through it, so the inspector (N8), state restoration and links follow.
// Everything the model draws comes from the engine through `AtlasService`; nothing is invented, and while the engine has
// no answer the Scroll says so in words (`ScrollCopy`).

import Observation
import QuartzCore
import ScrollsContracts
import ScrollsCore
import ScrollsRender
import ScrollsScrollModel
import ScrollsService
import SwiftUI
import UIKit

/// The Scroll's own words (states, pills). British English; no mental-state verbs.
nonisolated enum ScrollCopy {
  static let loading = "Loading the Scroll…"
  static let counting = "Counting matches: the Scroll draws them when the count is ready."
  static let noEngine = "The Scroll has no engine to ask."
  static let fixtures = "Contract fixtures (MockAtlas): canned tiles, not your atlas."
  static let empty = "No lanes for this query."
  static let simplifiedSuffix = "(too many marks for one screen)"
  static let widest = "Widest linear view: 0.05 pt per year"
  static let narrowest = "Closest view: 40 pt per day"
  static let domainEdge = "The Scroll ends here: 10000 BCE to 2100 CE"
  static let loadingTiles = "loading"
  static let table = "Table"
  static let tableHint = "The Scroll as a table: one row per bin, from the same numbers as the drawing."
  static let moreLanes = "more lanes"
  static let lanesSheet = "Lanes…"

  /// "Now showing yearly bins".
  static func tierPill(_ tier: Tier) -> String { "Now showing \(tier.binAdjective) bins" }
  /// "Simplified: decade bins (too many marks for one screen)".
  static func simplified(_ tier: Tier) -> String { "Simplified: \(tier.precisionWord) bins \(simplifiedSuffix)" }
  /// "+3 more lanes".
  static func moreLanes(_ n: Int) -> String { "+\(Format.int(n)) \(moreLanes)" }
  static func failed(_ message: String) -> String { "The Scroll could not load: \(message)" }
}

/// What the Scroll shows right now.
nonisolated enum ScrollStatus: Equatable, Sendable {
  case idle
  /// Before a strand is pinned: the corpus's collections and their dated spans (coverage only).
  case start
  case querying
  /// A materialise job is counting; the words come from the engine's job.
  case counting(String)
  case ready
  case failed(String)
}

/// A snapshot of what a build needs, taken on the main actor and built off it.
nonisolated struct ScrollBuildRequest: Sendable {
  var seq: Int
  var query: TimelineQueryResponse?
  var corpus: Corpus?
  var start: Bool
  var askedTier: Tier
  var answeredTier: Tier
  var lastDrawnTier: Tier?
  var tiles: [Tier: [Int64: TileSlot]]
  var range: ClosedRange<Double>
  var visible: ClosedRange<Double>
  var strands: [StrandPin]
  var labels: [String: String]
  var laneLimit: Int
  var lanesView: LanesView
  var marks: MarksWindow?
  var daysPerPoint: Double
  var fillHeight: Double
  var slot: Double
  var layers: [String: Int]
  var seams: [Seam]
  var seamCollapsed: Bool
  var rulerHeight: Double
  var coverageHeight: Double
  var cause: String
}

/// The result of one build.
nonisolated struct ScrollBuildResult: Sendable {
  var seq: Int
  var build: DisplayBuild
  var askedTier: Tier
  var drawTier: Tier
  var dimmed: Bool
  var simplified: SimplifiedReason?
  var range: ClosedRange<Double>
  var visible: ClosedRange<Double>
  var daysPerPoint: Double
  var milliseconds: Double
  var cause: String
  /// The model wants individual marks for this range (§1.6) and the loaded window does not cover it.
  var wantsMarks: Bool
}

/// Builds the model, the layout and the display lists of a request, off the main actor.
nonisolated enum ScrollBuildJob {
  static func run(_ r: ScrollBuildRequest) -> ScrollBuildResult {
    let t0 = CACurrentMediaTime()
    var drawTier = r.start ? r.askedTier : r.answeredTier
    var dimmed = false
    func tilesOf(_ t: Tier) -> [Int64: TileSlot] { r.tiles[t] ?? [:] }
    if !r.start, let last = r.lastDrawnTier, last != drawTier {
      // A level change keeps the previous tier (dimmed) until the new tier's visible tiles arrive (§8.3, §4.23).
      let vis = drawTier.tiles(loDay: r.visible.lowerBound, hiDay: r.visible.upperBound, max: 24)
      let now = tilesOf(drawTier)
      if !vis.contains(where: { now[$0] != nil }) {
        let prevVis = last.tiles(loDay: r.visible.lowerBound, hiDay: r.visible.upperBound, max: 24)
        let prev = tilesOf(last)
        if prevVis.contains(where: { prev[$0] != nil }) {
          drawTier = last
          dimmed = true
        }
      }
    }
    func model(_ tier: Tier, marks: MarksWindow?) -> TimelineModel {
      if r.start {
        return ScrollModelBuilder.coverageModel(collections: r.corpus?.collections ?? [], synthetic: r.corpus?.synthetic ?? false, tier: tier)
      }
      return ScrollModelBuilder.build(ModelInput(query: r.query, tier: tier, tiles: tilesOf(tier), range: r.range, visible: r.visible,
                                                 strands: r.strands, marks: marks, strandLabels: r.labels, laneLimit: r.laneLimit,
                                                 lanesView: r.lanesView))
    }
    func display(_ m: TimelineModel) -> DisplayBuild {
      let layout = LaneLayouts.phone(keys: m.lanes.map(\.key), strandCount: max(1, m.rowCount), slot: r.slot, header: 18, arcRoom: 10,
                                     moreRow: m.hiddenLanes > 0, fillHeight: r.fillHeight)
      return DisplayBuilder.buildSync(DisplayInput(model: m, originDay: r.range.lowerBound, daysPerPoint: r.daysPerPoint,
                                                   width: (r.range.upperBound - r.range.lowerBound) / r.daysPerPoint, layout: layout,
                                                   layers: r.layers, seams: r.seams, seamCollapsed: r.seamCollapsed,
                                                   rulerHeight: r.rulerHeight, coverageHeight: r.coverageHeight))
    }
    var m = model(drawTier, marks: r.marks)
    var b = display(m)
    var simplified: SimplifiedReason?
    // Over budget: step to a coarser tier and say so (§8.3; counted over ungated primitives, DV-7).
    var guardSteps = 0
    while b.overBudget && guardSteps < 5 && drawTier != .millennia {
      guardSteps += 1
      let wanted = b.stats.rects + b.stats.ticks
      drawTier = drawTier.coarser
      m = model(drawTier, marks: nil)
      b = display(m)
      simplified = SimplifiedReason(budget: b.stats.marks > DisplayBuilder.budget.marks ? .marks : .shapes, wanted: wanted, drawnTier: drawTier)
    }
    if var s = simplified { s.drawnTier = drawTier; simplified = s }
    let wantsMarks = !r.start && m.wantMarks && !m.override
    return ScrollBuildResult(seq: r.seq, build: b, askedTier: r.askedTier, drawTier: drawTier, dimmed: dimmed, simplified: simplified,
                             range: r.range, visible: r.visible, daysPerPoint: r.daysPerPoint,
                             milliseconds: (CACurrentMediaTime() - t0) * 1000, cause: r.cause, wantsMarks: wantsMarks)
  }
}

/// A short-lived axis animation (double tap, a selection pan, Play's auto-pan, a rubber band returning).
struct AxisAnimation {
  var from: ScrollAxis
  var to: ScrollAxis
  var start: CFTimeInterval
  var duration: CFTimeInterval
}

@MainActor @Observable
final class ScrollModel {
  @ObservationIgnored unowned let app: AppModel

  // MARK: Geometry (set by ScrollStage)

  /// The Metal view's size in points (ruler strip + lanes).
  var canvasSize: CGSize = .zero
  var displayScale: Double = 3
  var rulerHeight = 28.0
  var coverageHeight = 10.0
  var stripHeight: Double { rulerHeight + coverageHeight }
  /// Points at the bottom of the canvas the inspector covers.
  var occludedBottom = 0.0
  var landscape = false
  /// The lanes area the layout fills (the area at the peek detent: lanes keep their height when the sheet rises).
  var fillHeight = 0.0
  /// The canvas's origin in the window (coach-mark anchors are global rectangles).
  @ObservationIgnored var canvasOrigin: CGPoint = .zero

  // MARK: Per frame

  var axis: ScrollAxis
  var scrollY = 0.0

  // MARK: Data

  private(set) var status: ScrollStatus = .idle
  private(set) var query: TimelineQueryResponse?
  private(set) var corpus: Corpus?
  /// The installed build (what the renderer draws).
  private(set) var build: DisplayBuild?
  private(set) var buildSeq = 0
  private(set) var drawTier: Tier = .decades
  private(set) var dimmed = false
  private(set) var simplified: SimplifiedReason?
  /// A transient pill under the ruler (tier change, gap skip, seam, boundary).
  var pill: String?
  /// "+n more lanes" expands in place from 5 to 10 lanes (§4.3).
  var expandedLanes = false
  /// The table alternative is up (More → Table, `T`, the VoiceOver action).
  var showsTable = false
  /// The ambiguity chooser (≥ 2 marks within 6 pt of each other).
  var chooser: AmbiguityChoice?
  /// The ruler brush while it is drawn (days).
  var brush: ClosedRange<Double>?
  /// The keyboard or VoiceOver focus ring, in canvas points.
  var focusRect: CGRect?
  /// The selection of the view state as primitives of the lanes list.
  private(set) var selection: [PrimID] = []

  // MARK: Vantage and Play

  /// Set by Play and pause (Playhead.swift, an extension in another file).
  var isPlaying = false
  var speed = 1.0
  @ObservationIgnored var fadeFrom: Int32?
  @ObservationIgnored var fade: Float = 1
  @ObservationIgnored var firstPaint: Float = 1
  @ObservationIgnored var playTier: Tier?
  @ObservationIgnored var playTask: Task<Void, Never>?
  @ObservationIgnored var pausedSeams = Set<Int>()
  @ObservationIgnored var lastAnnouncement = Date.distantPast

  // MARK: Renderer statistics (PerfHUD)

  private(set) var lastBuildMilliseconds = 0.0
  private(set) var rebuildCause = "launch"
  @ObservationIgnored var mainFrameMilliseconds: [Double] = []
  /// The renderer's statistics (PerfHUD, self-tests), written by the gesture host after each frame.
  @ObservationIgnored let renderStatsBox = RenderStatsBox()
  /// Frames drawn since launch (zero at rest is a budget row).
  @ObservationIgnored var framesDrawn = 0
  /// Process start → the first install with data (the cold-launch budget row).
  @ObservationIgnored private(set) var launchToDataMilliseconds: Double?

  // MARK: Internals

  /// The view (Metal or Canvas) asks to draw a frame through this; set by the gesture host.
  @ObservationIgnored var onFrameNeeded: (() -> Void)?
  /// The host starts its display link through this (gesture, momentum, Play, fades, axis animations).
  @ObservationIgnored var onAnimationNeeded: (() -> Void)?
  @ObservationIgnored private var tiles = TileCache()
  @ObservationIgnored private var marks: MarksWindow?
  @ObservationIgnored private var marksKey: String?
  @ObservationIgnored private var lastBody: TimelineQueryRequest?
  @ObservationIgnored private var startCorpus: String?
  @ObservationIgnored private var queryTask: Task<Void, Never>?
  @ObservationIgnored private var tileTasks: [Task<Void, Never>] = []
  @ObservationIgnored private var buildTask: Task<Void, Never>?
  @ObservationIgnored private var buildPending = false
  @ObservationIgnored private var nextSeq = 0
  @ObservationIgnored private var built: (askedTier: Tier, drawTier: Tier, range: ClosedRange<Double>, dpp: Double)?
  @ObservationIgnored private var lastDrawnTier: Tier?
  @ObservationIgnored private var prevDrawTier: Tier?
  @ObservationIgnored private var dataDirty = true
  @ObservationIgnored private var committedAxis: ScrollAxis?
  @ObservationIgnored private var commitTask: Task<Void, Never>?
  @ObservationIgnored private var pillTask: Task<Void, Never>?
  @ObservationIgnored private var autoFitted = false
  @ObservationIgnored private var labels: [String: String] = [:]
  @ObservationIgnored var gesturing = false
  @ObservationIgnored var pinching = false
  @ObservationIgnored var axisAnimation: AxisAnimation?
  @ObservationIgnored private var lastView: ViewState?
  @ObservationIgnored private var seenFirstData = false
  @ObservationIgnored var launchStrandDone = false
  /// A new query or corpus opens on its data's extent once its first build is in (if the axis is still the default).
  @ObservationIgnored private var fitPending = false

  init(app: AppModel) {
    self.app = app
    let v = app.viewState
    if case .linear(let c, let dpp, _) = v.axis {
      axis = ScrollAxis(centerDay: Double(c), daysPerPoint: dpp)
    } else {
      axis = ScrollAxis(centerDay: Double(DayMath.dayFromYMD(1960, 1, 1)), daysPerPoint: TimeScale.daysPerYear / 3)
    }
    committedAxis = axis
  }

  // MARK: Derived

  /// The width of the timeline in points.
  var timelineWidth: Double { max(1, Double(canvasSize.width)) }

  /// The lanes' visible height in points (above the inspector).
  var lanesViewportHeight: Double { max(0, Double(canvasSize.height) - stripHeight - occludedBottom) }

  /// The vantage of the view state; nil at the open end (no limit).
  var vantage: Vantage? {
    let v = app.viewState.vantage
    return v.day >= ViewState.vantageOpenDay ? nil : Vantage(day: Int32(clamping: v.day), mode: v.strict ? .strict : .context)
  }

  var reduceMotion: Bool {
    switch app.viewState.reducedMotion {
    case "on": true
    case "off": false
    default: UIAccessibility.isReduceMotionEnabled
    }
  }

  /// The bin tier the Scroll asks for: the forced tier if coarser, else the zoom's; frozen while Play runs (§4.6).
  var currentTier: Tier {
    if let playTier { return playTier }
    return Tier.effective(auto: axis.tier, forced: Tier(code: app.viewState.tier))
  }

  /// Everything a frame needs besides the installed lists.
  var frame: ScrollFrame {
    ScrollFrame(centerDay: axis.centerDay, daysPerPoint: axis.daysPerPoint, viewSize: canvasSize, scale: displayScale,
                stripHeight: stripHeight, scrollY: scrollY, occludedBottom: occludedBottom, vantage: vantage, fadeFrom: fadeFrom,
                fade: fade, dim: (dimmed ? 0.4 : 1) * firstPaint, highContrast: UIAccessibility.isDarkerSystemColorsEnabled,
                differentiateWithoutColour: UIAccessibility.shouldDifferentiateWithoutColor, selection: selection,
                brush: brush ?? committedRange, focus: focusRect, veil: true)
  }

  /// The view state's range (a brushed stretch, `view.range`), in days.
  var committedRange: ClosedRange<Double>? {
    guard let r = app.viewState.range, r.count == 2 else { return nil }
    return Double(min(r[0], r[1]))...Double(max(r[0], r[1]))
  }

  /// The lanes of the installed build (headers, shelves, VoiceOver, the table).
  var lanes: [LaneModel] { build?.model.lanes ?? [] }

  /// The maximum lane scroll.
  var maxScrollY: Double { max(0, (build?.layout.height ?? 0) - lanesViewportHeight + 8) }

  // MARK: The bus

  /// The view state changed (from the Scroll itself, the inspector, a link, a restore or the tour).
  func viewStateDidChange(_ v: ViewState) {
    let prev = lastView
    lastView = v
    // An axis set from outside (a link, a restore, the tour, the year picker) is adopted.
    if case .linear(let c, let dpp, _) = v.axis, !gesturing, axisAnimation == nil {
      let ext = ScrollAxis(centerDay: Double(c), daysPerPoint: dpp)
      let mine = committedAxis.map { Int($0.centerDay.rounded()) == c && abs($0.daysPerPoint - dpp) <= 1e-6 * dpp } ?? false
      if !mine, prev != nil {
        setAxis(ext.clamped(width: timelineWidth), commit: false)
        committedAxis = axis
        autoFitted = false
      }
    }
    // The query.
    if v.strands.isEmpty {
      if status != .start || startCorpus != v.corpus { enterStart(v.corpus) }
    } else {
      let body = ScrollQuery.body(v, maxLanes: Tokens.Geometry.maxLanes)
      if body != lastBody { requery(body) }
    }
    // Layers, lanes order and limits change the display, not the query.
    if let prev, prev.layers != v.layers || prev.lanes.max != v.lanes.max { invalidateData("layers") }
    if prev?.vantage != v.vantage {
      if prev?.vantage.day != v.vantage.day, !isPlaying { fadeFrom = nil; fade = 1 }
      requestFrame()
    }
    if prev?.selection != v.selection { resolveSelection() }
  }

  // MARK: Axis

  /// Sets the axis (clamped to the domain). `commit` writes it to the view state 180 ms later.
  func setAxis(_ next: ScrollAxis, commit: Bool = true) {
    let a = next.clamped(width: timelineWidth)
    guard a != axis else { return }
    axis = a
    requestFrame()
    needData()
    if commit { scheduleCommit() }
  }

  /// Writes the axis to the view state once it has settled (the reference's `scheduleCommit`).
  func scheduleCommit(after ms: Int = 180) {
    commitTask?.cancel()
    commitTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(ms))
      guard let self, !Task.isCancelled, !self.gesturing else { return }
      self.commitAxis()
    }
  }

  private func commitAxis() {
    let c = Int(axis.centerDay.rounded())
    let dpp = Double(String(format: "%.6g", axis.daysPerPoint)) ?? axis.daysPerPoint
    if case .linear(let cc, let cd, let keep) = app.viewState.axis {
      if cc == c && cd == dpp { return }
      committedAxis = axis
      app.viewState.axis = .linear(centerDay: c, daysPerPx: dpp, keepLinear: keep)
    } else {
      committedAxis = axis
      app.viewState.axis = .linear(centerDay: c, daysPerPx: dpp, keepLinear: false)
    }
  }

  /// Fit the data's extent (Fit, double tap on the minimap). `bulk` skips a lone estimated outlier (viewport.mjs).
  func fit(bulk: Bool = false) {
    guard let ext = extentDays(bulk: bulk) else { return }
    animate(to: ScrollAxis.fit(loDay: Double(ext.lowerBound), hiDay: Double(ext.upperBound), width: timelineWidth))
    autoFitted = true
  }

  /// The days of the data: the query's extent, or the coverage spans before a strand is pinned.
  func extentDays(bulk: Bool = false) -> ClosedRange<Int>? {
    if let q = query, let from = LabelParse.parse(q.extent.from)?.loDay, let to = LabelParse.parse(q.extent.to)?.hiDay {
      var lo = Int(from)
      let hi = Int(to)
      if bulk {
        // An estimated first observation centuries before every other lane's does not stretch the opening frame.
        let firsts = q.lanes.compactMap { l -> (Int, Bool)? in
          guard let f = l.first, let d = f.loDay else { return nil }
          return (d, f.basis == "estimated")
        }.sorted { $0.0 < $1.0 }
        var i = 0
        while i < firsts.count - 1, firsts[i].1, Double(firsts[i + 1].0 - firsts[i].0) > 200 * 365.25 { i += 1 }
        if firsts.count >= 2 { lo = max(lo, firsts[i].0) }
      }
      return lo...max(lo, hi)
    }
    let spans = lanes.compactMap(\.span)
    guard let lo = spans.map(\.loDay).min(), let hi = spans.map(\.hiDay).max() else { return nil }
    return lo...hi
  }

  /// An untouched view (the corpus's default axis) opens on the data's extent.
  private func fitIfDefaultAxis() {
    let v = app.viewState
    let d = ViewState.defaultState(v.corpus).axis
    guard case .linear = v.axis, canvasSize.width > 0 else { return }
    guard v.axis == d || autoFitted else { return }
    guard let ext = extentDays(bulk: true) else { return }
    setAxis(ScrollAxis.fit(loDay: Double(ext.lowerBound), hiDay: Double(ext.upperBound), width: timelineWidth))
    autoFitted = true
  }

  /// Animates the axis (250 ms ease; a jump under Reduce Motion).
  func animate(to target: ScrollAxis, duration: CFTimeInterval = 0.25) {
    let t = target.clamped(width: timelineWidth)
    if reduceMotion || duration <= 0 {
      axisAnimation = nil
      setAxis(t)
      return
    }
    axisAnimation = AxisAnimation(from: axis, to: t, start: CACurrentMediaTime(), duration: duration)
    onAnimationNeeded?()
  }

  /// Zoom by one tier around a view x (double tap: in; two-finger tap: out).
  func zoomTier(_ direction: Int, at x: Double) {
    let tier = axis.tier
    let target = direction > 0 ? tier.finer : tier.coarser
    guard target != tier else {
      boundary(direction > 0 ? ScrollCopy.narrowest : ScrollCopy.widest)
      return
    }
    let factor = axis.daysPerPoint / (1 / target.midPointsPerDay)
    animate(to: axis.zoomed(width: timelineWidth, at: x, factor: factor))
  }

  /// Centre the Scroll on a day (minimap drag).
  func center(on day: Double) {
    setAxis(ScrollAxis(centerDay: day, daysPerPoint: axis.daysPerPoint))
  }

  /// Scroll the lanes (uniform offset; headers follow).
  func scrollLanes(by dy: Double) {
    let next = max(0, min(maxScrollY, scrollY + dy))
    guard next != scrollY else { return }
    scrollY = next
    requestFrame()
  }

  /// A pan or pinch hit the zoom floor or ceiling, or the domain edge: `.boundary` and a pill.
  func boundary(_ words: String) {
    app.experience.haptics.play(.boundary)
    showPill(words)
  }

  // MARK: Frames

  func requestFrame() { onFrameNeeded?() }

  /// One display-link tick: axis animations, fades. Returns whether anything is still moving.
  func tick(now: CFTimeInterval) -> Bool {
    var moving = false
    if let a = axisAnimation {
      let t = min(1, (now - a.start) / a.duration)
      let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      // Interpolate the zoom geometrically and the centre linearly.
      let dpp = exp(log(a.from.daysPerPoint) + (log(a.to.daysPerPoint) - log(a.from.daysPerPoint)) * e)
      let c = a.from.centerDay + (a.to.centerDay - a.from.centerDay) * e
      axis = ScrollAxis(centerDay: c, daysPerPoint: dpp).clamped(width: timelineWidth)
      if t >= 1 {
        axisAnimation = nil
        axis = a.to
        scheduleCommit()
        needData(settled: true)
      } else {
        needData()
        moving = true
      }
    }
    if fadeFrom != nil, fade < 1 {
      fade = min(1, fade + Float(1 / 60.0 / Tokens.Motion.markFade))
      if fade >= 1 { fadeFrom = nil } else { moving = true }
    }
    if firstPaint < 1 {
      firstPaint = min(1, firstPaint + Float(1 / 60.0 / Tokens.Motion.firstPaintFade))
      if firstPaint < 1 { moving = true }
    }
    return moving
  }

  // MARK: The query

  /// No atlas yet: still loading while the launch sequence opens it, a failure once it has given up.
  private var noEngineStatus: ScrollStatus { app.phase == .launching ? .querying : .failed(ScrollCopy.noEngine) }

  /// The launch settled after the Scroll first asked (the Scroll is built under the launch cover): ask again, so an
  /// opened atlas answers and a failed open says "no engine" instead of loading for ever.
  func engineDidOpen() {
    guard let v = lastView else { return }
    startCorpus = nil
    lastBody = nil
    status = .idle
    viewStateDidChange(v)
  }

  private func enterStart(_ corpusSlug: String) {
    queryTask?.cancel()
    query = nil
    lastBody = nil
    startCorpus = corpusSlug
    status = .start
    app.experience.bridge.queryKey = nil
    guard let atlas = app.atlas else {
      status = noEngineStatus
      return
    }
    queryTask = Task { [weak self] in
      do {
        let all = try await atlas.corpora()
        guard let self, !Task.isCancelled else { return }
        self.corpus = all.first { $0.slug == corpusSlug }
        self.app.querySynthetic = self.corpus?.synthetic ?? false
        self.fitPending = true
        self.invalidateData("corpus")
      } catch is CancellationError {
      } catch {
        self?.status = .failed(ScrollCopy.failed(Self.words(error)))
      }
    }
  }

  private func requery(_ body: TimelineQueryRequest) {
    queryTask?.cancel()
    lastBody = body
    status = .querying
    pause()
    guard let atlas = app.atlas else {
      status = noEngineStatus
      return
    }
    queryTask = Task { [weak self] in
      do {
        var r = try await atlas.timelineQuery(body)
        var attempts = 0
        while r.status != "ready", attempts < 600 {
          guard let self, !Task.isCancelled else { return }
          self.status = .counting(ScrollCopy.counting)
          try await Task.sleep(for: .seconds(1))
          r = try await atlas.timelineQuery(body)
          attempts += 1
        }
        guard let self, !Task.isCancelled else { return }
        self.queryArrived(r)
      } catch is CancellationError {
      } catch {
        self?.status = .failed(ScrollCopy.failed(Self.words(error)))
      }
    }
    loadLabels()
  }

  private func queryArrived(_ r: TimelineQueryResponse) {
    query = r
    _ = tiles.setQuery(r.queryKey, dataVersion: r.dataVersion)
    for t in tileTasks { t.cancel() }
    tileTasks.removeAll()
    marks = nil
    marksKey = nil
    app.querySynthetic = r.provenance.synthetic
    app.experience.bridge.queryKey = r.queryKey
    status = .ready
    fitPending = true
    invalidateData("query")
  }

  /// Strand labels ("carry the zero") from the expressions.
  private func loadLabels() {
    guard let atlas = app.atlas else { return }
    let v = app.viewState
    let ids: [Int] = v.strands.compactMap { s in
      guard s.type == "expression", case .number(let n) = s.id else { return nil }
      return n
    }
    let corpusSlug = v.corpus
    Task { [weak self] in
      for id in ids {
        guard let self, self.labels[String(id)] == nil else { continue }
        if let e = try? await atlas.expression(ExpressionID(rawValue: Int64(id)), corpus: corpusSlug) {
          self.labels[String(id)] = e.expression.surface
          self.app.experience.bridge.strandLabels[String(id)] = e.expression.surface
          self.invalidateData("labels")
        }
      }
    }
  }

  // MARK: Tiles and marks

  /// Data changed: rebuild on the next look.
  func invalidateData(_ cause: String) {
    dataDirty = true
    rebuildCause = cause
    needData(settled: true)
  }

  /// What the viewport needs: tiles of the visible part first, then ±1 viewport, then a rebuild when the build no longer
  /// covers the view. `settled`: a gesture has ended (a zoom that drifted from the build's rebuilds now).
  func needData(settled: Bool = false) {
    guard canvasSize.width > 0 else { return }
    let tier = currentTier
    let plan = ViewportPlan(axis: axis, width: timelineWidth, tier: tier)
    if status == .ready, let q = query {
      let answered = tiles.tierFor(tier)
      let ask = tiles.take(answered, visible: answered.tiles(loDay: plan.visible.lowerBound, hiDay: plan.visible.upperBound, max: 24),
                           prefetch: answered.tiles(loDay: plan.range.lowerBound, hiDay: plan.range.upperBound, max: 48))
      if !ask.isEmpty { fetchTiles(answered, ask, key: q.queryKey) }
    }
    guard status == .ready || status == .start else { return }
    var need = dataDirty || build == nil
    if let b = built {
      if b.askedTier != tier { need = true }
      if plan.visible.lowerBound < b.range.lowerBound || plan.visible.upperBound > b.range.upperBound { need = true }
      let drift = abs(log(axis.daysPerPoint / b.dpp))
      if drift > log(1.6) || (settled && drift > 1e-9) { need = true }
    }
    if need { rebuild(plan: plan) }
  }

  private func fetchTiles(_ tier: Tier, _ ask: [Int64], key: String) {
    guard let atlas = app.atlas else { return }
    let task = Task { [weak self] in
      do {
        let res = try await atlas.tiles(TilesRequest(q: key, tier: tier.code, tiles: ask.map(String.init).joined(separator: ",")))
        guard let self, !Task.isCancelled, self.query?.queryKey == key else { return }
        self.tiles.store(asked: tier, tiles: ask, response: res)
        self.invalidateData("tiles")
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.tiles.release(tier, ask)
      }
    }
    tileTasks.append(task)
    if tileTasks.count > 32 { tileTasks.removeFirst(tileTasks.count - 32) }
  }

  private func fetchMarks(range: ClosedRange<Double>, visible: ClosedRange<Double>, rangeN: Int) {
    guard let atlas = app.atlas, let q = query else { return }
    let r = rangeN <= ScrollModelBuilder.maxMarks ? range : visible
    let fromYear = DayMath.ymdFromDay(Int(r.lowerBound.rounded(.down))).y - 1
    let toYear = DayMath.ymdFromDay(Int(r.upperBound.rounded(.down))).y + 1
    let k = "\(q.queryKey)|\(fromYear)|\(toYear)"
    guard marksKey != k else { return }
    marksKey = k
    Task { [weak self] in
      do {
        let res = try await atlas.marks(MarksRequest(q: q.queryKey, from: fromYear, to: toYear, limit: ScrollModelBuilder.maxMarks))
        guard let self, self.marksKey == k else { return }
        self.marks = MarksWindow(items: res.marks, fromDay: DayMath.dayFromYMD(fromYear, 1, 1), toDay: DayMath.dayFromYMD(toYear, 12, 31),
                                 truncated: res.truncated)
        self.invalidateData("marks")
      } catch {
        self?.marksKey = nil
      }
    }
  }

  // MARK: Builds

  private func rebuild(plan: ViewportPlan) {
    guard buildTask == nil else {
      buildPending = true
      return
    }
    dataDirty = false
    nextSeq += 1
    let v = app.viewState
    let start = status == .start
    var tierTiles: [Tier: [Int64: TileSlot]] = [:]
    let answered = tiles.tierFor(plan.tier)
    tierTiles[answered] = tiles.tiles(answered)
    if let last = lastDrawnTier, last != answered { tierTiles[last] = tiles.tiles(last) }
    for t in Tier.allCases where tierTiles[t] == nil {
      let m = tiles.tiles(t)
      if !m.isEmpty { tierTiles[t] = m }
    }
    var labelsNow = labels
    for (k, s) in app.experience.bridge.strandLabels where labelsNow[k] == nil { labelsNow[k] = s }
    let request = ScrollBuildRequest(
      seq: nextSeq, query: query, corpus: corpus, start: start, askedTier: plan.tier, answeredTier: answered, lastDrawnTier: lastDrawnTier,
      tiles: tierTiles, range: plan.range, visible: plan.visible, strands: ScrollQuery.pins(v), labels: labelsNow,
      laneLimit: expandedLanes ? Tokens.Geometry.maxLanes : Tokens.Geometry.defaultLanes,
      lanesView: LanesView(facet: v.lanes.facet, order: v.lanes.order, manual: v.lanes.manual), marks: marks,
      daysPerPoint: axis.daysPerPoint, fillHeight: fillHeight, slot: Double(Tokens.Geometry.slot), layers: v.layers,
      seams: query?.seams ?? [], seamCollapsed: false, rulerHeight: rulerHeight, coverageHeight: coverageHeight, cause: rebuildCause)
    buildTask = Task { [weak self] in
      let result = await Task.detached(priority: .userInitiated) { ScrollBuildJob.run(request) }.value
      guard let self else { return }
      self.buildTask = nil
      self.install(result)
      if self.buildPending {
        self.buildPending = false
        self.needData(settled: !self.gesturing)
      }
    }
  }

  private func install(_ r: ScrollBuildResult) {
    let m = r.build.model
    // A new query has no tiles yet: keep the last picture, dimmed, rather than a blank Scroll (QA finding 8).
    if status == .ready, !m.coverageOnly, m.loadedTiles.isEmpty, let old = build, abs(log(r.daysPerPoint / (built?.dpp ?? r.daysPerPoint))) < 1e-9 {
      _ = old
      dimmed = true
      requestFrame()
      return
    }
    build = r.build
    buildSeq += 1
    built = (r.askedTier, r.drawTier, r.range, r.daysPerPoint)
    drawTier = r.drawTier
    dimmed = r.dimmed
    simplified = r.simplified
    lastBuildMilliseconds = r.milliseconds
    rebuildCause = r.cause
    PerfLog.shared.record("display-build", ms: r.milliseconds)
    if !r.dimmed && !m.loadedTiles.isEmpty { lastDrawnTier = r.drawTier }
    if let prev = prevDrawTier, prev != r.drawTier, !r.dimmed, status == .ready {
      showPill(r.simplified.map { ScrollCopy.simplified($0.drawnTier) } ?? ScrollCopy.tierPill(r.drawTier))
      if pinching || gesturing { app.experience.haptics.play(.tierChange) }
    } else if let s = r.simplified, !r.dimmed {
      showPill(ScrollCopy.simplified(s.drawnTier))
    }
    if !r.dimmed { prevDrawTier = r.drawTier }
    if r.wantsMarks { fetchMarks(range: r.range, visible: r.visible, rangeN: m.rangeN) }
    // The first paint with data is one 200 ms fade of the whole data plane (ΔS-8), none under Reduce Motion.
    if !seenFirstData && (!m.loadedTiles.isEmpty || m.coverageOnly) {
      seenFirstData = true
      if !reduceMotion {
        firstPaint = 0
        onAnimationNeeded?()
      }
      PerfLog.event("scroll-first-data")
      if let start = PerfLog.processStart() {
        PerfLog.shared.record("launch-to-scroll-data", ms: Date.now.timeIntervalSince(start) * 1000)
        launchToDataMilliseconds = Date.now.timeIntervalSince(start) * 1000
      }
    }
    scrollY = min(scrollY, maxScrollY)
    if fitPending, !r.dimmed {
      fitPending = false
      fitIfDefaultAxis()
    }
    resolveSelection()
    publishAnchors()
    requestFrame()
  }

  // MARK: Selection

  /// The view state's selection as primitives of the lanes list (bars of a bin, marks of an occurrence or passage).
  func resolveSelection() {
    guard let build, let sel = app.viewState.selection else {
      if !selection.isEmpty { selection = [] }
      requestFrame()
      return
    }
    var ids: [PrimID] = []
    for (id, ref) in build.lanes.refs {
      switch (ref, sel.type, sel.id) {
      case (.occurrence(let o), "occurrence", .number(let n)) where o.rawValue == Int64(n): ids.append(id)
      case (.passage(let p), "passage", .number(let n)) where p.rawValue == Int64(n): ids.append(id)
      case (.bin(let b), "bin", .string(let s)) where Self.selectionID(b) == s:
        if case .bar = build.laneMeta[Int(id.rawValue)].slot { ids.append(id) }
      default: break
      }
    }
    ids.sort { $0.rawValue < $1.rawValue }
    if ids != selection { selection = ids }
    requestFrame()
  }

  /// `binId(ref)`: 'community:classroom~12~L2~191'.
  nonisolated static func selectionID(_ b: ScrollsScrollModel.BinRef) -> String { "\(b.lane.rawValue)~\(b.strand)~\(b.tier.code)~\(b.bin)" }

  // MARK: Pills

  func showPill(_ text: String) {
    pill = text
    if UIAccessibility.isVoiceOverRunning { AccessibilityNotification.Announcement(text).post() }
    pillTask?.cancel()
    pillTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(1500))
      guard let self, !Task.isCancelled else { return }
      if self.pill == text { self.pill = nil }
    }
  }

  // MARK: Coach anchors

  /// Screen rectangles of what the coach marks point at (the bridge's anchors): the first lane's earliest bar.
  func publishAnchors() {
    guard let build else { return }
    var first: (x: Double, rect: CGRect)?
    if let lane = build.model.lanes.first, let box = build.layout.lane(lane.key) {
      for (si, s) in lane.strands.enumerated() {
        guard let bar = s.bars.first else { continue }
        let slot = si < box.slots.count ? box.slots[si] : box.slots.first
        let x0 = frame.x(day: Double(bar.loDay)), x1 = frame.x(day: Double(bar.hiDay + 1))
        let y = stripHeight + (slot?.y ?? box.y) - scrollY
        let rect = CGRect(x: canvasOrigin.x + x0, y: canvasOrigin.y + y, width: max(8, x1 - x0), height: slot?.h ?? 24)
        if first == nil || x0 < first!.x { first = (x0, rect) }
      }
    }
    if let first { app.experience.bridge.anchors[.firstBar] = first.rect }
  }

  // MARK: Helpers

  static func words(_ error: Error) -> String {
    if let e = error as? ScrollsError { return e.message }
    return error.localizedDescription
  }
}

// MARK: - The PNG snapshot (Exports, N3, call this)

extension ScrollModel {
  /// The Scroll as it is on screen as a PNG (`snapshot.mjs`): the Canvas painter's drawing of the installed build, the
  /// lane labels, the SYNTHETIC stamp whenever demo material is in it, the legend line and the caption. nil before the
  /// first build.
  func snapshotPNG(scale: Double = 2) -> Data? {
    guard let build else { return nil }
    let v = app.viewState
    let synthetic = app.syntheticInScope || build.model.lanes.contains(where: \.synthetic)
    let totals = query.map { q in
      Format.Totals(n: Double(q.totals.n), byUnit: q.totals.byUnit.map { (Double($0.matches), Double($0.works)) },
                    unitsMixed: q.totals.unitsMixed ?? false)
    }
    let labels = build.model.strands.map(\.label)
    let caption = ScrollSnapshot.caption(view: v, dataVersion: query?.dataVersion, totals: totals, synthetic: synthetic, labels: labels)
    var f = frame
    f.selection = []
    f.focus = nil
    return ScrollSnapshot.png(build: build, frame: f, synthetic: synthetic, caption: caption, scale: scale)
  }
}

// MARK: - The hardware keyboard (SPEC §8.5, the Scroll's part of the map)

extension ScrollModel {
  /// Handles one key of a hardware keyboard; false when the key is not the Scroll's.
  func handleKey(_ key: String, shift: Bool) -> Bool {
    let w = timelineWidth
    switch key {
    case " ": togglePlay()
    case "[": step(-1)
    case "]": step(1)
    case "{":
      for _ in 0..<10 { step(-1) }
    case "}":
      for _ in 0..<10 { step(1) }
    case UIKeyCommand.inputLeftArrow: setAxis(ScrollAxis(centerDay: axis.centerDay - (shift ? 0.5 : 0.1) * w * axis.daysPerPoint, daysPerPoint: axis.daysPerPoint))
    case UIKeyCommand.inputRightArrow: setAxis(ScrollAxis(centerDay: axis.centerDay + (shift ? 0.5 : 0.1) * w * axis.daysPerPoint, daysPerPoint: axis.daysPerPoint))
    case UIKeyCommand.inputUpArrow: scrollLanes(by: -40)
    case UIKeyCommand.inputDownArrow: scrollLanes(by: 40)
    case "+", "=": setAxis(axis.zoomed(width: w, at: w / 2, factor: 1.5))
    case "-": setAxis(axis.zoomed(width: w, at: w / 2, factor: 1 / 1.5))
    case "0": fit()
    case "1", "2", "3", "4", "5", "6":
      guard let n = Int(key), let t = Tier(rawValue: n - 1) else { return false }
      animate(to: axis.zoomed(width: w, at: w / 2, factor: axis.daysPerPoint * t.midPointsPerDay))
    case "v", "V": app.viewState.vantage.strict.toggle()
    case "t", "T":
      if app.coordinator.modal == nil { showsTable = true }
    default: return false
    }
    return true
  }
}

/// The marks a tap could mean (≥ 2 within 6 pt of each other): up to 6 rows to choose from (§4.5).
struct AmbiguityChoice: Identifiable, Equatable {
  struct Row: Identifiable, Equatable {
    var id: PrimID
    var ref: PrimRef
    var date: String
    var lane: String
    var kind: String
    var doc: DocumentID?
    var synthetic: Bool
  }
  var id = UUID()
  /// Where the popover points, in canvas points.
  var anchor: CGPoint
  var rows: [Row]
}
