// OWNER: N7
// The playhead and Play (IOS-SPEC §4.6, §4.21; port of playhead.mjs and the vantage half of viewport.mjs).
//   · The vantage is the reading clock: a cyan line through every lane (drawn by the renderer's overlay) and a glass
//     handle on the ruler reading "as of 1997". Dragging the handle scrubs, discrete by bin, with a loupe 44 pt above
//     the finger; haptics: `.tick` per bin (≤ 30/s), `.soft` on entering a stretch no shown lane covers, `.boundary` at
//     the modality seam. Tapping the label opens the year picker.
//   · Play (▶; Magic Tap under VoiceOver) advances one bin every 400 ms at 1× (1.2 s under Reduce Motion), runs strict,
//     freezes the bin level, keeps the playhead at 70% of the width (a 120 ms ease; a jump under Reduce Motion), fades
//     newly revealed marks in over 150 ms through the fade uniform (none under Reduce Motion), pauses 600 ms before a
//     stretch every visible lane lacks ("No coverage 1940–1949 in these lanes — skipping. Nothing is inferred."), and
//     once at the modality seam with its caption. Pausing switches to context.
// Scrubbing and Play rebuild nothing: the vantage is a uniform (§4.23).

import LabKitCore
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import SwiftUI
import UIKit

extension ScrollModel: ScrollTransport {
  /// The play interval at the current speed (1.2 s under Reduce Motion, whatever the speed).
  var playInterval: Double {
    reduceMotion ? VantageClock.reducedPlayMilliseconds : VantageClock.playMilliseconds / max(0.25, speed)
  }

  /// The last day Play moves to: the end of the data (or today), never past the open end.
  var playEndDay: Int {
    let today = DayMath.today()
    let ext = extentDays()?.upperBound ?? today
    return min(ViewState.vantageOpenDay - 1, min(ext, today))
  }

  func togglePlay() {
    isPlaying ? pause() : play()
  }

  func step(_ direction: Int) {
    if isPlaying { pause() }
    let tier = build != nil ? drawTier : currentTier
    let v = app.viewState.vantage
    let from = v.day >= ViewState.vantageOpenDay ? Int(axis.centerDay.rounded()) : v.day
    let next = tier.stepBinEnd(from: Double(from), steps: direction)
    setVantage(day: next, strict: nil, fadeFrom: direction > 0 ? Int32(clamping: from) : nil)
    app.experience.haptics.play(.vantageStep)
    announceVantage(from: from, to: next)
  }

  func play() {
    guard !isPlaying else { return }
    guard status == .ready, build != nil else {
      showPill(PlayheadCopy.pinFirst)
      return
    }
    let tier = drawTier
    let end = playEndDay
    var day = app.viewState.vantage.day
    if day >= ViewState.vantageOpenDay || day >= end {
      let lo = max(axis.scale(width: timelineWidth).loDay, Double(extentDays()?.lowerBound ?? Int(axis.centerDay)))
      day = tier.snapToBinEnd(lo)
    }
    isPlaying = true
    playTier = tier
    pausedSeams = []
    setVantage(day: day, strict: true, fadeFrom: nil)
    app.experience.bridge.peekSentence = nil
    PerfLog.event("play")
    playTask?.cancel()
    playTask = Task { [weak self] in
      while let self, self.isPlaying, !Task.isCancelled {
        let wait = self.playOnce()
        if wait <= 0 { break }
        try? await Task.sleep(for: .milliseconds(Int(wait)))
      }
    }
  }

  func pause() {
    guard isPlaying else { return }
    isPlaying = false
    playTask?.cancel()
    playTask = nil
    playTier = nil
    // Pausing switches to context (§4.6).
    var v = app.viewState.vantage
    v.strict = false
    app.viewState.vantage = v
    needData(settled: true)
  }

  /// One step of Play: returns how long to wait before the next one (0 = stopped).
  private func playOnce() -> Double {
    guard let build else {
      pause()
      return 0
    }
    let day = app.viewState.vantage.day
    let tick = VantageClock.tick(day: day, tier: drawTier, model: build.model, seams: query?.seams ?? [], endDay: playEndDay,
                                 interval: playInterval, pausedSeams: pausedSeams, synthetic: build.model.lanes.contains(where: \.synthetic))
    switch tick {
    case .advance(let next, let wait):
      setVantage(day: next, strict: true, fadeFrom: Int32(clamping: day))
      app.experience.haptics.play(.vantageStep)
      autoPan(to: next)
      announceVantage(from: day, to: next)
      return wait
    case .skip(let next, let message, let wait):
      showPill(message)
      app.experience.haptics.play(.noCoverage)
      setVantage(day: next, strict: true, fadeFrom: Int32(clamping: day))
      autoPan(to: next)
      return wait
    case .seam(let next, let caption, let year, let wait):
      pausedSeams.insert(year)
      showPill(caption)
      app.experience.haptics.play(.boundary)
      setVantage(day: next, strict: true, fadeFrom: Int32(clamping: day))
      autoPan(to: next)
      return wait
    case .end(let last):
      setVantage(day: last, strict: true, fadeFrom: nil)
      pause()
      showPill(PlayheadCopy.reachedEnd)
      return 0
    }
  }

  /// Moves the vantage through the bus. `fadeFrom`: what was revealed after this day fades in (Play, Step).
  func setVantage(day: Int, strict: Bool?, fadeFrom from: Int32?) {
    var v = app.viewState.vantage
    v.day = max(ViewState.minDay, min(ViewState.maxDay, day))
    if let strict { v.strict = strict }
    if let from, !reduceMotion {
      fadeFrom = from
      fade = 0
      onAnimationNeeded?()
    } else {
      fadeFrom = nil
      fade = 1
    }
    app.viewState.vantage = v
    requestFrame()
  }

  /// Play keeps the playhead at 70% of the width (§4.6).
  private func autoPan(to day: Int) {
    let x = frame.x(day: Double(day) + 1)
    guard VantageClock.needsAutoPan(x: x, width: timelineWidth) else { return }
    let c = VantageClock.autoPanCenter(vantageDay: Double(day), width: timelineWidth, daysPerPoint: axis.daysPerPoint)
    animate(to: ScrollAxis(centerDay: c, daysPerPoint: axis.daysPerPoint), duration: 0.12)
  }

  /// "As of 1950: 2 new occurrences in Classroom", at most once a second (VoiceOver; §4.6 Reduce Motion).
  func announceVantage(from: Int, to: Int) {
    guard UIAccessibility.isVoiceOverRunning, Date.now.timeIntervalSince(lastAnnouncement) >= 1 else { return }
    lastAnnouncement = .now
    AccessibilityNotification.Announcement(PlayheadCopy.announcement(label: vantageLabel, revealed: revealed(from: from, to: to))).post()
  }

  /// Occurrences newly revealed between two vantage days, by lane (observed bins whose last day falls in (from, to]).
  func revealed(from: Int, to: Int) -> [(lane: String, n: Int)] {
    guard let build, to > from else { return [] }
    var out: [(lane: String, n: Int)] = []
    for lane in build.model.lanes {
      var n = 0
      for s in lane.strands {
        let c = s.cols
        for i in 0..<c.count where c.state[i] == .observed && Int(c.hiDay[i]) > from && Int(c.hiDay[i]) <= to { n += Int(c.n[i]) }
      }
      if n > 0 { out.append((lane: lane.label, n: n)) }
    }
    return out
  }

  /// The playhead's words: the vantage's year at year-based tiers ("1925"), its month or day finer; "open" at the open end.
  var vantageLabel: String {
    let day = app.viewState.vantage.day
    if day >= ViewState.vantageOpenDay { return PlayheadCopy.open }
    switch drawTier {
    case .days: return RulerScale.dayLabel(Double(day), precision: "day")
    case .months: return RulerScale.dayLabel(Double(day), precision: "month")
    default: return RulerScale.dayLabel(Double(day))
    }
  }

  // MARK: Scrubbing

  /// The day under a canvas x, snapped to its bin's end (scrubbing is discrete by bin, §4.6).
  func scrubDay(at x: Double) -> Int {
    let tier = build != nil ? drawTier : currentTier
    return tier.snapToBinEnd(frame.day(x: x))
  }

  /// Scrubs to a canvas x: the vantage moves bin by bin, with the haptics of §4.21.
  func scrub(to x: Double) {
    if isPlaying { pause() }
    let day = scrubDay(at: min(timelineWidth, max(0, x)))
    let old = app.viewState.vantage.day
    guard day != old else { return }
    setVantage(day: day, strict: nil, fadeFrom: nil)
    let tier = drawTier
    if let gap = VantageClock.gapAhead(build?.model, day: tier.stepBinEnd(from: Double(day), steps: -1), tier: tier),
       gap.loDay <= day, !(gap.loDay <= old && old <= gap.hiDay) {
      app.experience.haptics.play(.noCoverage)
    } else if VantageClock.seamCrossed(query?.seams ?? [], from: min(old, day), to: max(old, day)) != nil {
      app.experience.haptics.play(.boundary)
    } else {
      app.experience.haptics.play(.vantageStep)
    }
  }
}

/// The playhead's words.
nonisolated enum PlayheadCopy {
  static let open = "open"
  static let pinFirst = "Pin a strand first: Play moves the vantage over what has been counted."
  static let reachedEnd = "Reached the end of the record."
  static let handleHint = "Swipe up or down to move the vantage one bin; double-tap to pick a year."
  static let label = "Vantage"
  /// "as of 1925".
  static func asOf(_ label: String) -> String { "as of \(label)" }

  /// "As of 1950: 2 new occurrences in Classroom".
  static func announcement(label: String, revealed: [(lane: String, n: Int)]) -> String {
    guard let top = revealed.max(by: { $0.n < $1.n }) else { return "As of \(label)" }
    return "As of \(label): \(Format.int(top.n)) new \(top.n == 1 ? "occurrence" : "occurrences") in \(top.lane)"
  }
}

/// The glass handle on the ruler ("as of 1997"), its 44 × 44 pt target, the scrub drag and the loupe.
struct Playhead: View {
  let model: ScrollModel
  @State private var scrubbing = false
  @State private var loupeX: CGFloat = 0

  var body: some View {
    let v = model.app.viewState.vantage
    if v.day < ViewState.vantageOpenDay, model.canvasSize.width > 0 {
      let x = model.frame.x(day: Double(v.day) + 1)
      if x >= -22, x <= model.timelineWidth + 22 {
        handle(x: x, strict: v.strict)
      }
    }
  }

  private func handle(x: Double, strict: Bool) -> some View {
    let label = PlayheadCopy.asOf(model.vantageLabel)
    let w = max(Tokens.Geometry.minHit, CGFloat(label.count) * 6.6 + 18)
    return ZStack {
      Text(label)
        .font(.system(size: 11, weight: .semibold).monospacedDigit())
        .foregroundStyle(Tokens.ink.color)
        .lineLimit(1)
        .padding(.horizontal, 9)
        .frame(height: 22)
        .chromeGlass(in: Capsule(), interactive: true)
        .overlay(Capsule().strokeBorder(Tokens.cyan.opacity(scrubbing ? 0.9 : 0.55), lineWidth: 1))
    }
    .frame(width: w, height: Tokens.Geometry.minHit)
    .contentShape(Rectangle())
    .overlay(alignment: .top) {
      if scrubbing {
        Text(model.vantageLabel)
          .font(.system(size: 17, weight: .semibold).monospacedDigit())
          .foregroundStyle(Tokens.ink.color)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .chromeGlass(in: Capsule())
          .fixedSize()
          .offset(y: -44)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .position(x: x, y: model.rulerHeight / 2)
    .gesture(
      DragGesture(minimumDistance: 2, coordinateSpace: .named(ScrollStage.space))
        .onChanged { g in
          scrubbing = true
          model.scrub(to: Double(g.location.x))
        }
        .onEnded { _ in
          scrubbing = false
          model.needData(settled: true)
        }
    )
    .onTapGesture {
      if model.app.coordinator.canShowPopover || model.app.coordinator.modal == nil { model.app.coordinator.present(.yearPicker) }
    }
    .chromeTypeCap()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(PlayheadCopy.label)
    .accessibilityValue(label + (strict ? ", strict" : ", context"))
    .accessibilityHint(PlayheadCopy.handleHint)
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: model.step(1)
      case .decrement: model.step(-1)
      @unknown default: break
      }
    }
    .accessibilityIdentifier("playheadHandle")
  }
}
