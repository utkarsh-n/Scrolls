// OWNER: N7
// VoiceOver for the Scroll (IOS-SPEC §4.19, N-18). The canvas is an accessibility container with, per lane:
//   · one element whose label is the lane's generated summary ("Lane Classroom · text: 'carry the zero' observed
//     1905–1939 and 1950–1960 in 2 bars; gap 1940–1949: no sources (archive gap, synthetic).") and which provides an
//     Audio Graph (`AXChart`): x = the bin's mid-year, y = the rate in the lane's unit, one series per strand with
//     `isContinuous: false` — only observed bins are data points, so the audio never bridges a gap; absent, low and
//     uncovered bins are described in the summary instead;
//   · child elements per bar and per gap, in time order, FILTERED BY THE VANTAGE PREDICATE (strict hides what the vantage
//     has not reached; context keeps it and says it is after the vantage), each with "Open bin drawer";
// and custom rotors for Bars · Gaps · Arcs · Marks · Seams. Magic Tap plays or pauses; Escape clears the selection or
// lowers the sheet (ScrollGestureHost). The playhead is the adjustable SwiftUI handle (Playhead.swift). Element frames
// are computed from days on every read, so they follow pan and zoom.

import Accessibility
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import UIKit

nonisolated enum AccessibilityCopy {
  static let bars = "Bars"
  static let gaps = "Gaps"
  static let arcs = "Arcs"
  static let marks = "Marks"
  static let seams = "Seams"
  static let openDrawer = "Open bin drawer"
  static let play = "Play"
  static let pause = "Pause"
  static let step = "Step"
  static let stepBack = "Step back"
  static let strictOrContext = "Strict or context"
  static let table = "Show as table"
  static let afterVantage = "after the vantage, shown faintly"
  static let xAxis = "Year"
  static let summaryNone = "Absent, low-coverage and uncovered bins are not plotted; the lane summary describes them."

  static func gap(_ label: String, synthetic: Bool) -> String { "gap \(label): no sources\(synthetic ? " (archive gap, synthetic)" : "")" }
  static func pending(_ label: String) -> String { "\(label): indexing — not yet looked" }
}

enum ScrollAccessibility {
  // MARK: Elements

  static func elements(for host: ScrollGestureHost, model: ScrollModel) -> [Any] {
    guard let build = model.build else { return [] }
    var out: [Any] = []
    let v = model.vantage
    for lane in build.model.lanes {
      guard let box = build.layout.lane(lane.key) else { continue }
      let laneEl = LaneElement(container: host, model: model, lane: lane, box: box, vantage: v)
      out.append(laneEl)
      out.append(contentsOf: children(host: host, model: model, lane: lane, box: box, vantage: v))
    }
    return out
  }

  /// The bars and gaps of a lane in time order, filtered by the vantage.
  static func children(host: ScrollGestureHost, model: ScrollModel, lane: LaneModel, box: LaneBox, vantage v: Vantage?) -> [UIAccessibilityElement] {
    guard let build = model.build else { return [] }
    var items: [(lo: Int, el: UIAccessibilityElement)] = []
    let tier = build.model.tier
    for (si, s) in lane.strands.enumerated() {
      let slot = si < box.slots.count ? box.slots[si] : box.slots.first
      for bar in s.bars {
        // the bar as the vantage shows it: strict hides the bins after the vantage; context keeps them, said so
        var hi = bar.hiDay
        var after = false
        if let v {
          if bar.hiDay > Int(v.day) {
            if v.mode == .strict {
              guard let lastShown = (bar.start...bar.end).last(where: { Int(s.cols.hiDay[$0]) <= Int(v.day) }) else { continue }
              hi = Int(s.cols.hiDay[lastShown])
            } else {
              after = true
            }
          }
        }
        var n = 0
        for i in bar.start...bar.end where Int(s.cols.hiDay[i]) <= hi { n += Int(s.cols.n[i]) }
        let label = "\(s.label) · \(lane.label): observed \(RulerScale.dayLabel(Double(bar.loDay)))–\(RulerScale.dayLabel(Double(hi))), n = \(Format.int(n)); first \(bar.startCap.label)\(bar.startCap.censored ? " (may be older than our record)" : "")"
          + (after ? ", \(AccessibilityCopy.afterVantage)" : "")
        let el = SpanElement(container: host, model: model, kind: .bar, loDay: bar.loDay, hiDay: hi, y: slot?.y ?? box.y, h: slot?.h ?? box.h)
        el.accessibilityLabel = label
        let binRef = ScrollsScrollModel.BinRef(lane: LaneKey(rawValue: lane.key), strand: s.ref, tier: tier, bin: s.cols.bin[bar.start],
                                               index: Int32(bar.start))
        let id = ScrollModel.selectionID(binRef)
        el.accessibilityCustomActions = [UIAccessibilityCustomAction(name: AccessibilityCopy.openDrawer) { [weak model] _ in
          model?.app.experience.select(ViewState.Selection(type: "bin", id: .string(id)))
          return true
        }]
        items.append((bar.loDay, el))
      }
    }
    for r in lane.uncovered {
      let el = SpanElement(container: host, model: model, kind: .gap, loDay: r.loDay, hiDay: r.hiDay, y: box.y + box.header, h: box.h - box.header)
      el.accessibilityLabel = "\(lane.label): " + AccessibilityCopy.gap(ScrollWords.runLabel(tier, r), synthetic: lane.synthetic)
      items.append((r.loDay, el))
    }
    for r in lane.pendingRuns {
      let el = SpanElement(container: host, model: model, kind: .gap, loDay: r.loDay, hiDay: r.hiDay, y: box.y + box.header, h: box.h - box.header)
      el.accessibilityLabel = "\(lane.label): " + AccessibilityCopy.pending(ScrollWords.runLabel(tier, r))
      items.append((r.loDay, el))
    }
    return items.sorted { $0.lo < $1.lo }.map(\.el)
  }

  /// The lane's summary, as the vantage shows it (strict drops what it has not reached).
  static func summary(_ lane: LaneModel, vantage v: Vantage?) -> String {
    guard let v, v.mode == .strict else { return ScrollWords.describeLane(lane) }
    var l = lane
    l.strands = lane.strands.map { s in
      var s = s
      s.bars = s.bars.compactMap { b in
        guard b.loDay <= Int(v.day) else { return nil }
        var b = b
        if b.hiDay > Int(v.day), let last = (b.start...b.end).last(where: { Int(s.cols.hiDay[$0]) <= Int(v.day) }) {
          b.end = last
          b.hiDay = Int(s.cols.hiDay[last])
        } else if b.hiDay > Int(v.day) {
          return nil
        }
        return b
      }
      return s
    }
    return ScrollWords.describeLane(l)
  }

  // MARK: Rotors

  static func rotors(for host: ScrollGestureHost, model: ScrollModel) -> [UIAccessibilityCustomRotor] {
    func rotor(_ name: String, _ pick: @escaping (SpanElement) -> Bool) -> UIAccessibilityCustomRotor {
      UIAccessibilityCustomRotor(name: name) { [weak host, weak model] predicate in
        guard let host, let model else { return nil }
        let all = (elements(for: host, model: model).compactMap { $0 as? SpanElement }).filter(pick)
        guard !all.isEmpty else { return nil }
        let current = predicate.currentItem.targetElement as? SpanElement
        let idx = current.flatMap { c in all.firstIndex { $0.loDay == c.loDay && $0.kind == c.kind && $0.y == c.y } }
        let next: Int = switch predicate.searchDirection {
        case .next: idx.map { $0 + 1 } ?? 0
        case .previous: idx.map { $0 - 1 } ?? all.count - 1
        @unknown default: 0
        }
        guard all.indices.contains(next) else { return nil }
        return UIAccessibilityCustomRotorItemResult(targetElement: all[next], targetRange: nil)
      }
    }
    return [
      rotor(AccessibilityCopy.bars) { $0.kind == .bar },
      rotor(AccessibilityCopy.gaps) { $0.kind == .gap },
      rotor(AccessibilityCopy.arcs) { $0.kind == .arc },
      markRotor(host: host, model: model),
      seamRotor(host: host, model: model),
    ]
  }

  /// Marks of the occurrence override (one element per mark the vantage shows).
  static func markRotor(host: ScrollGestureHost, model: ScrollModel) -> UIAccessibilityCustomRotor {
    UIAccessibilityCustomRotor(name: AccessibilityCopy.marks) { [weak host, weak model] predicate in
      guard let host, let model, let build = model.build else { return nil }
      var marks: [SpanElement] = []
      for lane in build.model.lanes {
        guard let box = build.layout.lane(lane.key) else { continue }
        for (si, s) in lane.strands.enumerated() {
          for mk in s.marks ?? [] where visibility(revealDay: Int32(clamping: mk.hiDay), at: model.vantage) != .hide {
            let slot = si < box.slots.count ? box.slots[si] : box.slots.first
            let el = SpanElement(container: host, model: model, kind: .mark, loDay: mk.loDay, hiDay: mk.hiDay, y: slot?.y ?? box.y, h: slot?.h ?? 24)
            el.accessibilityLabel = "\(s.label) · \(lane.label) · \(ScrollModelBuilder.markLabel(mk)) · \(mk.kind)\(mk.synthetic ? " · synthetic" : "")"
            let sel = mk.occ.map { ViewState.Selection(type: "occurrence", id: .number(Int($0.rawValue))) }
              ?? ViewState.Selection(type: "passage", id: .number(Int(mk.passage.rawValue)))
            el.activate = { [weak model] in model?.app.experience.select(sel) }
            marks.append(el)
          }
        }
      }
      marks.sort { $0.loDay < $1.loDay }
      return step(marks, predicate)
    }
  }

  static func seamRotor(host: ScrollGestureHost, model: ScrollModel) -> UIAccessibilityCustomRotor {
    UIAccessibilityCustomRotor(name: AccessibilityCopy.seams) { [weak host, weak model] predicate in
      guard let host, let model else { return nil }
      let seams: [SpanElement] = (model.query?.seams ?? []).map { s in
        let d = Seams.day(s)
        let el = SpanElement(container: host, model: model, kind: .seam, loDay: d, hiDay: d, y: 0, h: model.build?.layout.height ?? 0)
        el.accessibilityLabel = s.label
        return el
      }
      return step(seams, predicate)
    }
  }

  private static func step(_ all: [SpanElement], _ predicate: UIAccessibilityCustomRotorSearchPredicate) -> UIAccessibilityCustomRotorItemResult? {
    guard !all.isEmpty else { return nil }
    let current = predicate.currentItem.targetElement as? SpanElement
    let idx = current.flatMap { c in all.firstIndex { $0.loDay == c.loDay && $0.kind == c.kind } }
    let next: Int = predicate.searchDirection == .next ? (idx.map { $0 + 1 } ?? 0) : (idx.map { $0 - 1 } ?? all.count - 1)
    guard all.indices.contains(next) else { return nil }
    return UIAccessibilityCustomRotorItemResult(targetElement: all[next], targetRange: nil)
  }

  // MARK: Actions

  static func actions(model: ScrollModel) -> [UIAccessibilityCustomAction] {
    [
      UIAccessibilityCustomAction(name: model.isPlaying ? AccessibilityCopy.pause : AccessibilityCopy.play) { [weak model] _ in
        model?.togglePlay()
        return true
      },
      UIAccessibilityCustomAction(name: AccessibilityCopy.step) { [weak model] _ in
        model?.step(1)
        return true
      },
      UIAccessibilityCustomAction(name: AccessibilityCopy.stepBack) { [weak model] _ in
        model?.step(-1)
        return true
      },
      UIAccessibilityCustomAction(name: AccessibilityCopy.strictOrContext) { [weak model] _ in
        model?.app.viewState.vantage.strict.toggle()
        return true
      },
      UIAccessibilityCustomAction(name: AccessibilityCopy.table) { [weak model] _ in
        guard let model, model.app.coordinator.modal == nil else { return false }
        model.showsTable = true
        return true
      },
    ]
  }

  // MARK: Audio Graphs

  /// The lane's chart: one series per strand, observed bins only (`isContinuous: false`).
  static func chart(_ lane: LaneModel, vantage v: Vantage?) -> AXChartDescriptor {
    var series: [AXDataSeriesDescriptor] = []
    var minYear = Double.infinity, maxYear = -Double.infinity, maxRate = 0.0
    for s in lane.strands {
      let c = s.cols
      var points: [AXDataPoint] = []
      for i in 0..<c.count where c.state[i] == .observed && c.rate[i].isFinite {
        if let v, v.mode == .strict, c.hiDay[i] > v.day { continue }
        let mid = (FoldedScale.yearOfDay(Double(c.loDay[i])) + FoldedScale.yearOfDay(Double(c.hiDay[i]) + 1)) / 2
        points.append(AXDataPoint(x: mid, y: c.rate[i], additionalValues: [], label: "n = \(c.n[i])"))
        minYear = min(minYear, mid)
        maxYear = max(maxYear, mid)
        maxRate = max(maxRate, c.rate[i])
      }
      series.append(AXDataSeriesDescriptor(name: s.label, isContinuous: false, dataPoints: points))
    }
    if !minYear.isFinite { minYear = 0; maxYear = 1 }
    let x = AXNumericDataAxisDescriptor(title: AccessibilityCopy.xAxis, range: minYear...max(minYear + 1, maxYear), gridlinePositions: []) {
      "\(Int($0.rounded()))"
    }
    let y = AXNumericDataAxisDescriptor(title: Format.unitLabel(lane.unit), range: 0...max(1, maxRate), gridlinePositions: []) {
      Format.number($0)
    }
    return AXChartDescriptor(title: "\(lane.label) · \(lane.modality)", summary: AccessibilityCopy.summaryNone, xAxis: x, yAxis: y,
                             additionalAxes: [], series: series)
  }
}

/// One lane: its summary and its Audio Graph.
final class LaneElement: UIAccessibilityElement, AXChart {
  private weak var model: ScrollModel?
  let lane: LaneModel
  let box: LaneBox
  let vantage: Vantage?

  init(container: Any, model: ScrollModel, lane: LaneModel, box: LaneBox, vantage: Vantage?) {
    self.model = model
    self.lane = lane
    self.box = box
    self.vantage = vantage
    super.init(accessibilityContainer: container)
    accessibilityLabel = ScrollAccessibility.summary(lane, vantage: vantage)
    accessibilityTraits = .summaryElement
    accessibilityIdentifier = "lane-\(lane.key)"
  }

  var accessibilityChartDescriptor: AXChartDescriptor? {
    get { ScrollAccessibility.chart(lane, vantage: vantage) }
    set {}
  }

  override var accessibilityFrameInContainerSpace: CGRect {
    get {
      guard let model else { return .zero }
      return CGRect(x: 0, y: model.stripHeight + box.y - model.scrollY, width: model.timelineWidth, height: box.h)
    }
    set {}
  }
}

/// A bar, gap, mark, arc or seam: a stretch of days in one row; its frame follows pan and zoom.
final class SpanElement: UIAccessibilityElement {
  enum Kind { case bar, gap, mark, arc, seam }
  private weak var model: ScrollModel?
  let kind: Kind
  let loDay: Int
  let hiDay: Int
  let y: Double
  let h: Double
  var activate: (() -> Void)?

  init(container: Any, model: ScrollModel, kind: Kind, loDay: Int, hiDay: Int, y: Double, h: Double) {
    self.model = model
    self.kind = kind
    self.loDay = loDay
    self.hiDay = hiDay
    self.y = y
    self.h = h
    super.init(accessibilityContainer: container)
  }

  override var accessibilityFrameInContainerSpace: CGRect {
    get {
      guard let model else { return .zero }
      let x0 = model.frame.x(day: Double(loDay)), x1 = model.frame.x(day: Double(hiDay) + 1)
      let top = kind == .seam ? 0 : model.stripHeight + y - model.scrollY
      return CGRect(x: x0, y: top, width: max(8, x1 - x0), height: max(8, h))
    }
    set {}
  }

  override func accessibilityActivate() -> Bool {
    if let activate {
      activate()
      return true
    }
    return accessibilityCustomActions?.first.map { a in
      if let handler = a.actionHandler { return handler(a) }
      return false
    } ?? false
  }
}
