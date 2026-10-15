// OWNER: N7
// The Scroll's app logic over MockAtlas (IOS-SPEC §4.5–§4.7, §4.19, §4.23): the start state draws only what the corpus
// listing states (coverage only); a pinned strand queries, loads tiles and builds off the main actor; the table
// alternative reads the renderer's own arrays (identity); a tap on a bar selects its bin and an absent bin answers in
// words with its denominator; the vantage hides later primitives from hits; Play steps whole bins in strict mode and
// pausing switches to context. Fixtures are canned: nothing here is the atlas.

import CoreGraphics
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import Testing

@testable import Scrolls

@MainActor
@Suite("N7 Scroll over MockAtlas")
struct ScrollTests {
  /// An app on the fixtures with a laid-out Scroll.
  private func scroll(strand: Int? = nil) async -> (AppModel, ScrollModel) {
    let app = AppModel(launch: LaunchArgs.parse(["app", "-ui-testing"]))
    await app.start()
    let s = app.scroll
    s.canvasSize = CGSize(width: 430, height: 640)
    s.fillHeight = 560
    if let strand {
      var v = app.viewState
      v.strands = [ViewState.Strand(type: "expression", id: .number(strand), variants: .default, glyph: "")]
      app.viewState = v.canonicalized()
    }
    s.viewStateDidChange(app.viewState)
    return (app, s)
  }

  private func waitFor(_ s: ScrollModel, timeout: Double = 15, _ ok: () -> Bool) async -> Bool {
    let deadline = Date.now.addingTimeInterval(timeout)
    while Date.now < deadline {
      if ok() { return true }
      try? await Task.sleep(for: .milliseconds(50))
    }
    return ok()
  }

  @Test("the start state draws the corpus's collections, coverage only (nothing counted, nothing inferred)")
  func startState() async throws {
    let (_, s) = await scroll()
    #expect(await waitFor(s) { s.build != nil })
    let build = try #require(s.build)
    #expect(build.model.coverageOnly)
    #expect(!build.model.lanes.isEmpty)
    #expect(build.lanes.bars.allSatisfy { $0.style != ScrollStyle.bar.rawValue }, "no observed bar before a strand is pinned")
  }

  @Test("a pinned strand queries, loads tiles and builds; the table reads the renderer's arrays")
  func pinnedStrand() async throws {
    let (_, s) = await scroll(strand: 12)
    #expect(await waitFor(s) { s.status == .ready && !(s.build?.model.loadedTiles.isEmpty ?? true) })
    let build = try #require(s.build)
    #expect(!build.model.coverageOnly)
    #expect(build.lanes.bars.contains { $0.style == ScrollStyle.bar.rawValue || $0.style == ScrollStyle.barSparse.rawValue })
    // the table alternative: the same StrandSeries the display list's LaneSeries carry
    let tables = ScrollWords.tables(build.model)
    #expect(!tables.isEmpty)
    for t in tables {
      let lane = try #require(build.lanes.lanes.first { $0.key.rawValue == t.laneKey })
      #expect(lane.strands.contains(t.source), "\(t.lane): the table's columns are not the renderer's")
    }
  }

  @Test("a tap on a bar selects its bin; an absent bin answers in words, with its denominator and no rate")
  func taps() async throws {
    let (app, s) = await scroll(strand: 12)
    #expect(await waitFor(s) { s.status == .ready && !(s.build?.model.loadedTiles.isEmpty ?? true) })
    let build = try #require(s.build)
    // centre the view on the build so the bars are on screen
    func point(_ p: BarPrim) -> CGPoint {
      let day = Double(build.lanes.originDay) + Double(p.d0 + p.d1) / 2
      return CGPoint(x: s.frame.x(day: day), y: s.stripHeight + Double(p.y0 + p.y1) / 2 - s.scrollY)
    }
    if let bar = build.lanes.bars.first(where: { $0.style == ScrollStyle.bar.rawValue }) {
      s.setAxis(ScrollAxis(centerDay: Double(build.lanes.originDay) + Double(bar.d0 + bar.d1) / 2, daysPerPoint: s.axis.daysPerPoint), commit: false)
      s.tap(at: point(bar))
      s.viewStateDidChange(app.viewState)
      #expect(app.viewState.selection?.type == "bin")
      #expect(!s.selection.isEmpty, "the selected bin is drawn")
    } else {
      Issue.record("the fixture build has no observed bar")
    }
    app.experience.clearSelection()
    if let absent = build.lanes.bars.first(where: { $0.style == ScrollStyle.absent.rawValue }) {
      s.setAxis(ScrollAxis(centerDay: Double(build.lanes.originDay) + Double(absent.d0 + absent.d1) / 2, daysPerPoint: s.axis.daysPerPoint), commit: false)
      app.viewState.vantage.day = ViewState.vantageOpenDay
      s.tap(at: point(absent))
      let sentence = try #require(app.experience.bridge.peekSentence)
      #expect(sentence.contains("looked, found none"))
      #expect(sentence.contains("tokens"), "an empty bin names its denominator")
      #expect(app.viewState.selection == nil, "an empty bin answers in words, it opens nothing")
    }
  }

  @Test("strict vantage: a later bar is not hit; context keeps it hittable (ghosted)")
  func vantageHits() async throws {
    let (app, s) = await scroll(strand: 12)
    #expect(await waitFor(s) { s.status == .ready && !(s.build?.model.loadedTiles.isEmpty ?? true) })
    let build = try #require(s.build)
    let bars = build.lanes.bars.filter { $0.style == ScrollStyle.bar.rawValue }
    let late = try #require(bars.max { $0.revealDay < $1.revealDay })
    let entry = try #require(build.lanes.hit.entries.first { $0.id == late.id })
    let p = CGPoint(x: entry.bounds.midX, y: entry.bounds.midY)
    let before = Vantage(day: late.revealDay - 4000, mode: .strict)
    #expect(!build.lanes.hit.hitIDs(p, tolerance: 12, vantage: before).contains(late.id))
    #expect(build.lanes.hit.hitIDs(p, tolerance: 12, vantage: Vantage(day: before.day, mode: .context)).contains(late.id))
    #expect(build.lanes.hit.hitIDs(p, tolerance: 12, vantage: nil).contains(late.id))
    // the same predicate in the summary VoiceOver reads
    let lane = try #require(build.model.lanes.first)
    _ = app
    #expect(ScrollAccessibility.summary(lane, vantage: Vantage(day: Int32(ViewState.minDay), mode: .strict)).contains("no observed bins"))
  }

  @Test("Play steps whole bins in strict mode; pausing switches to context")
  func play() async throws {
    let (app, s) = await scroll(strand: 12)
    #expect(await waitFor(s) { s.status == .ready && s.build != nil })
    let start = app.viewState.vantage.day
    s.speed = 4
    s.play()
    #expect(s.isPlaying)
    #expect(app.viewState.vantage.strict)
    #expect(await waitFor(s, timeout: 5) { app.viewState.vantage.day > start })
    let tier = s.drawTier
    #expect(tier.snapToBinEnd(Double(app.viewState.vantage.day)) == app.viewState.vantage.day, "the vantage sits on a bin end")
    s.pause()
    #expect(!s.isPlaying)
    #expect(!app.viewState.vantage.strict)
  }
}
