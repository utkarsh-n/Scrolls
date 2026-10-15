// OWNER: N8
// The transport row's logic (IOS-SPEC §4.6): ▶ Play · Step ▸ · "as of 1925" · the strict/context eye. The Scroll owns
// Play (auto-pan, gap and seam pauses, fades, their haptics) and registers it on the bridge; until it does, this model
// steps the vantage itself through the frozen bus (`AppModel.viewState.vantage`), port of `playhead.mjs` createPlayer
// and `tiers.mjs` stepBinEnd: one bin every 400 ms at 1× (1.2 s under Reduce Motion), strict while playing, context
// once paused, a `.tick` per bin. It cannot see coverage, so it never claims a gap: it only advances the clock.

import Observation
import ScrollsCore
import ScrollsScrollModel
import SwiftUI
import UIKit

nonisolated enum TransportCopy {
  static let play = "Play"
  static let pause = "Pause"
  static let step = "Step"
  static let stepBack = "Step back"
  static let playHint = "Moves the vantage forward one bin at a time; later evidence appears as the clock reaches it."
  static let stepHint = "Moves the vantage one bin forward."
  static let strict = "strict"
  static let context = "context"
  static let strictHint = "Strict hides evidence dated after the vantage; context shows it faintly."
  static let modeLabel = "Vantage mode"
  static let speed = "Play speed"
  static let speedHint = "How many bins a second Play steps through: 0.25× to 4×."
  static let reachedEnd = "Reached the end of the record."
  static let open = "open"
  /// "as of 1925": the playhead's label (the vantage is the reading clock, §1.9).
  static func asOf(_ label: String) -> String { "as of \(label)" }
  /// VoiceOver: "As of 1950", at most once a second.
  static func announce(_ label: String) -> String { "As of \(label)" }
}

/// The play speeds of the knob (`playhead.mjs` SPEEDS).
nonisolated enum PlaySpeed {
  static let all: [Double] = [0.25, 0.5, 1, 2, 4]
  static let labels = ["0.25×", "0.5×", "1×", "2×", "4×"]
}

/// Bin arithmetic of the transport (`tiers.mjs` binOfDay, binStartDay, binEndDay, stepBinEnd).
nonisolated enum VantageSteps {
  static func binOfDay(_ tier: Tier, _ day: Int) -> Int {
    switch tier {
    case .days: return day
    case .months: return Bins.monthBinOfDay(day)
    default: return DayMath.floorDiv(DayMath.ymdFromDay(day).y, tier.level.yearWidth ?? 1)
    }
  }

  static func binStartDay(_ tier: Tier, _ bin: Int) -> Int {
    switch tier {
    case .days: return bin
    case .months:
      let y = DayMath.floorDiv(bin, 12)
      return DayMath.dayFromYMD(y, bin - y * 12 + 1, 1)
    default: return DayMath.dayFromYMD(bin * (tier.level.yearWidth ?? 1), 1, 1)
    }
  }

  static func binEndDay(_ tier: Tier, _ bin: Int) -> Int { binStartDay(tier, bin + 1) - 1 }

  /// From inside a bin one step back lands on the end of the previous bin and one step forward on this bin's end.
  static func stepBinEnd(_ tier: Tier, _ day: Int, _ steps: Int) -> Int {
    let here = binOfDay(tier, day)
    let atEnd = binEndDay(tier, here) == day
    let target = steps > 0 ? here + steps - (atEnd ? 0 : 1) : here + steps
    return binEndDay(tier, target)
  }

  /// The tier the Scroll draws: the view's forced tier, else the tier of its zoom (§1.6).
  static func tier(of state: ViewState) -> Tier {
    if let forced = Tier(code: state.tier) { return forced }
    if case .linear(_, let daysPerPx, _) = state.axis, daysPerPx > 0 {
      return Tier(pointsPerYear: TimeScale.daysPerYear / daysPerPx)
    }
    return .centuries
  }

  /// The playhead's words: the vantage's year at year-based tiers ("1925"), its month or day finer; "open" when
  /// the vantage is the open end (no limit).
  static func label(_ state: ViewState) -> String {
    let day = state.vantage.day
    if day >= ViewState.vantageOpenDay { return TransportCopy.open }
    let (y, m, d) = DayMath.ymdFromDay(day)
    switch tier(of: state) {
    case .days: return "\(d) \(monthName(m)) \(DateLabels.yearLabel(y))"
    case .months: return "\(monthName(m)) \(DateLabels.yearLabel(y))"
    default: return DateLabels.yearLabel(y)
    }
  }

  private static func monthName(_ m: Int) -> String {
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][max(0, min(11, m - 1))]
  }
}

@MainActor @Observable
final class TransportModel {
  @ObservationIgnored private unowned let app: AppModel
  @ObservationIgnored private let bridge: ScrollBridge
  @ObservationIgnored private let haptics: HapticsMap
  /// The stepper's own state, used while the Scroll has registered no transport.
  private(set) var stepperPlaying = false
  private var stepperSpeed = 1.0
  /// The last line announced to VoiceOver, and when.
  @ObservationIgnored private var lastAnnouncement = Date.distantPast
  @ObservationIgnored private var timer: Task<Void, Never>?
  /// Steps taken by the current Play (tests, the first-minute self-test).
  private(set) var stepsPlayed = 0
  /// Every Play that ran to its end or was paused, newest last (the tour waits for one).
  private(set) var playsFinished = 0

  init(app: AppModel, bridge: ScrollBridge, haptics: HapticsMap) {
    self.app = app
    self.bridge = bridge
    self.haptics = haptics
  }

  private var scroll: (any ScrollTransport)? {
    _ = bridge.transportGeneration
    return bridge.transport
  }

  var isPlaying: Bool { scroll?.isPlaying ?? stepperPlaying }

  var speed: Double {
    get { scroll?.speed ?? stepperSpeed }
    set {
      let s = PlaySpeed.all.min(by: { abs($0 - newValue) < abs($1 - newValue) }) ?? 1
      if let scroll { scroll.speed = s } else { stepperSpeed = s }
    }
  }

  /// "as of 1925".
  var asOfText: String { TransportCopy.asOf(VantageSteps.label(app.viewState)) }

  var isStrict: Bool { app.viewState.vantage.strict }

  func togglePlay() {
    if let scroll {
      let wasPlaying = scroll.isPlaying
      scroll.togglePlay()
      if wasPlaying { playsFinished += 1 }
      return
    }
    stepperPlaying ? stop(nil) : play()
  }

  func step(_ direction: Int) {
    if let scroll {
      scroll.step(direction)
      return
    }
    if stepperPlaying { stop(nil) }
    let tier = VantageSteps.tier(of: app.viewState)
    setVantage(VantageSteps.stepBinEnd(tier, app.viewState.vantage.day, direction), strict: nil)
    haptics.play(.vantageStep)
  }

  /// The eye: strict ↔ context (`V`).
  func toggleMode() {
    app.viewState.vantage.strict.toggle()
  }

  // MARK: The stepper (no Scroll transport registered)

  private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled || app.viewState.reducedMotion == "on" }

  private var interval: Duration {
    reduceMotion ? .milliseconds(Int(Tokens.Motion.playStepReduced * 1000)) : .milliseconds(Int(Tokens.Motion.playStep * 1000 / stepperSpeed))
  }

  /// The end of the record: today (the stepper knows no extent; the Scroll's transport stops at the data's end).
  private var endDay: Int { min(DayMath.today(), ViewState.vantageOpenDay) }

  private func play() {
    guard !stepperPlaying else { return }
    if app.viewState.vantage.day >= endDay {
      // From the open end, Play starts again from the view's opening vantage (the demo's 1925).
      app.viewState.vantage.day = ViewState.defaultState(app.viewState.corpus).vantage.day
      if app.viewState.vantage.day >= endDay { return }
    }
    stepperPlaying = true
    stepsPlayed = 0
    setVantage(app.viewState.vantage.day, strict: true)   // Play runs strict (§4.6)
    schedule()
  }

  private func schedule() {
    timer?.cancel()
    let wait = interval
    timer = Task { [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled else { return }
      self?.tick()
    }
  }

  private func tick() {
    guard stepperPlaying else { return }
    let day = app.viewState.vantage.day
    if day >= endDay {
      stop(TransportCopy.reachedEnd)
      return
    }
    let tier = VantageSteps.tier(of: app.viewState)
    let next = min(VantageSteps.stepBinEnd(tier, day, 1), max(endDay, day))
    setVantage(next, strict: true)
    stepsPlayed += 1
    haptics.play(.vantageStep)
    if next >= endDay {
      stop(TransportCopy.reachedEnd)
      return
    }
    schedule()
  }

  /// Pausing switches to context (§4.6).
  private func stop(_ message: String?) {
    timer?.cancel()
    timer = nil
    guard stepperPlaying else { return }
    stepperPlaying = false
    playsFinished += 1
    setVantage(app.viewState.vantage.day, strict: false)
    if let message { app.banner = message }
  }

  private func setVantage(_ day: Int, strict: Bool?) {
    var v = app.viewState.vantage
    v.day = max(ViewState.minDay, min(ViewState.maxDay, day))
    if let strict { v.strict = strict }
    app.viewState.vantage = v
    announceStep()
  }

  /// "As of 1950", at most once a second (§4.6 Reduce Motion; VoiceOver).
  private func announceStep() {
    guard UIAccessibility.isVoiceOverRunning, Date.now.timeIntervalSince(lastAnnouncement) >= 1 else { return }
    lastAnnouncement = .now
    AccessibilityNotification.Announcement(TransportCopy.announce(VantageSteps.label(app.viewState))).post()
  }
}
