// OWNER: N7
// Unit tests of the Scroll's pure model (IOS-SPEC §8.5 N7): tiers and ruler ticks, the vantage view and hit-grid vantage
// filtering, the table alternative's identity with the renderer's arrays, and the builder's independence from Reduce
// Motion. G5 (G5DisplayTests) compares the same code with display.mjs over real payloads.

import CoreGraphics
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import Testing

@Suite("Scroll model units")
struct ScrollModelUnitTests {
  @Test("tiers: bins, labels and vantage steps")
  func tiers() {
    #expect(Tier.decades.bin(ofDay: Double(DayMath.dayFromYMD(1915, 6, 1))) == 191)
    #expect(Tier.decades.label(ofBin: 191) == "1910–1919")
    #expect(Tier.centuries.label(ofBin: -5) == "501–402 BCE")
    #expect(Tier.millennia.label(ofBin: 0) == "1 BCE – 999 CE")
    #expect(Tier.months.label(ofBin: Int64(1931 * 12 + 3)) == "Apr 1931")
    #expect(Tier.days.label(ofBin: Int64(DayMath.dayFromYMD(1994, 5, 17))) == "17 May 1994")
    let end1919 = DayMath.dayFromYMD(1919, 12, 31)
    #expect(Tier.decades.stepBinEnd(from: Double(DayMath.dayFromYMD(1915, 1, 1)), steps: 1) == end1919)
    #expect(Tier.decades.stepBinEnd(from: Double(end1919), steps: 1) == DayMath.dayFromYMD(1929, 12, 31))
    #expect(Tier.decades.stepBinEnd(from: Double(DayMath.dayFromYMD(1915, 1, 1)), steps: -1) == DayMath.dayFromYMD(1909, 12, 31))
    #expect(Tiers.tileOf(-1) == (-1, 63))
  }

  @Test("folded overview: four fixed linear regimes, seams ×3.3 · ×8.9 · ×3.3, round trips inside a regime")
  func folded() {
    let f = FoldedScale(width: 430)
    #expect(f.regimes.map(\.key) == ["deep", "classical", "early-modern", "modern"])
    #expect(f.seams.map(\.label) == ["×3.3", "×8.9", "×3.3"])
    #expect(abs(f.regimes.last!.x1 - 430) < 1e-9)
    for year in [-5000.0, 0, 1499, 1650.5, 1928, 2020] {
      #expect(abs(f.year(x: f.x(year: year)) - year) < 1e-6)
    }
    #expect(f.x(year: -9000) == 0)
    #expect(f.x(year: 2100) == 430)
    let box = MinimapGeometry.bracket(x0: 428, x1: 429, width: 430)
    #expect(box.width == 4 && box.left == 426, "the bracket is at least 4 pt wide and never leaves the strip")
    #expect(MinimapGeometry.rows(lanes: 9, height: 24).rows == 4)
  }

  @Test("the load model draws every state with its denominators, and builds in budget order of magnitude")
  func perfLoad() {
    let m = PerfLoad.model(lanes: 4, strands: 2, bins: 120)
    #expect(m.lanes.allSatisfy { $0.label.contains(PerfLoad.label) }, "load lanes say they are not data")
    let states = Set(m.lanes.flatMap { $0.strands.flatMap(\.cols.state) })
    #expect(states == [.observed, .absent, .low])
    let b = DisplayBuilder.buildSync(PerfLoad.input(m, width: 1290, bins: 120))
    #expect(b.lanes.bars.count > 0 && b.lanes.ticks.count > 0)
  }

  @Test("ruler: historical labels, BCE ticks on round historical years")
  func ruler() {
    let s = AxisScale(centerDay: Double(DayMath.dayFromYMD(0, 1, 1)), daysPerPoint: 365.2425 * 10, width: 430)
    let labels = RulerScale.ticks(s).map(\.label)
    #expect(labels.contains("1000 BCE"))
    #expect(labels.contains("1000"))
    #expect(!labels.contains { $0.hasPrefix("-") })
    #expect(RulerScale.binCaption(.decades, daysPerPoint: 365.2425 / 3) == "Bins: decades · 1 cm ≈ 12.6 years")
  }

  @Test("axis: pinch keeps the day under the finger; the domain clamps")
  func axis() {
    let a = ScrollAxis(centerDay: 0, daysPerPoint: 10)
    let z = a.zoomed(width: 430, at: 100, factor: 2)
    let before = a.centerDay + (100 - 215) * a.daysPerPoint, after = z.centerDay + (100 - 215) * z.daysPerPoint
    #expect(abs(before - after) < 1e-9)
    let far = ScrollAxis(centerDay: 1e9, daysPerPoint: 1e6).clamped(width: 430)
    #expect(far.daysPerPoint <= ScrollAxis.maxDaysPerPoint)
    #expect(far.centerDay + 215 * far.daysPerPoint <= ScrollAxis.maxDay + 1e-6)
  }

  @Test("vantage: strict hides later primitives, context ghosts them; archive primitives always show; hits follow")
  func vantage() {
    let build = Fixture.build()
    let lastDay = build.model.lanes[0].strands[0].cols.hiDay.last!
    let early = Vantage(day: Int32(DayMath.dayFromYMD(1905, 12, 31)), mode: .strict)
    let strict = build.lanes.visible(at: early)
    let context = build.lanes.visible(at: Vantage(day: early.day, mode: .context))
    #expect(strict.bars.allSatisfy { $0.revealDay <= early.day })
    #expect(context.bars.count == build.lanes.bars.count)
    #expect(context.bars.filter { PrimFlags(rawValue: $0.flags).contains(.ghost) }.allSatisfy { $0.revealDay > early.day })
    #expect(strict.bands.count == build.lanes.bands.count)   // hatches, bands and absence describe the archive
    #expect(build.lanes.visible(at: Vantage(day: lastDay, mode: .strict)).bars.count == build.lanes.bars.count)
    // a later bar is not hit in strict mode and is hit (ghosted) in context mode
    let later = build.lanes.bars.first { $0.revealDay > early.day }!
    let p = CGPoint(x: Double((later.d0 + later.d1) / 2) * build.lanes.hit.pointsPerDay, y: Double((later.y0 + later.y1) / 2))
    let hitStrict = build.lanes.hit.hitIDs(p, tolerance: 12, vantage: early)
    let hitContext = build.lanes.hit.hitIDs(p, tolerance: 12, vantage: Vantage(day: early.day, mode: .context))
    #expect(!hitStrict.contains(later.id))
    #expect(hitContext.contains(later.id))
    #expect(strict.hit.hitIDs(p, tolerance: 12, vantage: nil) == hitStrict)
  }

  @Test("table alternative reads the renderer's own arrays (identity)")
  func tableIdentity() {
    let build = Fixture.build()
    let tables = ScrollWords.tables(build.model)
    #expect(!tables.isEmpty)
    for t in tables {
      guard let lane = build.lanes.lanes.first(where: { $0.key.rawValue == t.laneKey }),
        let series = lane.strands.first(where: { $0.ref == t.strandRef })
      else {
        Issue.record("no LaneSeries for \(t.laneKey)")
        continue
      }
      #expect(series == t.source)
      t.source.rate.withUnsafeBufferPointer { a in
        series.rate.withUnsafeBufferPointer { b in #expect(a.baseAddress == b.baseAddress) }
      }
      t.source.state.withUnsafeBufferPointer { a in
        series.state.withUnsafeBufferPointer { b in #expect(a.baseAddress == b.baseAddress) }
      }
      #expect(t.rows.count == series.count)
      for (i, r) in t.rows.enumerated() where series.state[i] == .low { #expect(r.rate == "—") }
    }
  }

  @Test("a low bin's sentence states n and its denominator and never a rate")
  func lowSentence() {
    let build = Fixture.build()
    let lane = build.model.lanes[0], strand = lane.strands[0]
    guard let i = strand.cols.state.firstIndex(of: .low) else { Issue.record("fixture has no low bin"); return }
    let lines = ScrollWords.binTooltip(lane: lane, strand: strand, index: i, tier: build.model.tier)
    #expect(lines.contains { $0.hasPrefix("low coverage: n = ") && $0.hasSuffix("— rate not shown") })
    #expect(!lines.contains { $0.contains("/M tokens") })
  }

  @Test("the builder takes no Reduce Motion input: the same list either way")
  func reduceMotion() {
    let a = Fixture.build(), b = Fixture.build()
    #expect(a.lanes.bars == b.lanes.bars && a.lanes.bands == b.lanes.bands && a.top.ticks == b.top.ticks)
  }

  @Test("builder budget: 20k cells build in time (Mac proxy of the 12 ms device budget)")
  func buildBudget() {
    let input = Fixture.big(cells: 20_000)
    let clock = ContinuousClock()
    var times: [Double] = []
    for _ in 0..<5 {
      let t = clock.measure { _ = DisplayBuilder.buildSync(input) }
      times.append(Double(t.components.attoseconds) / 1e15 + Double(t.components.seconds) * 1000)
    }
    times.sort()
    let median = times[2]
    print("DisplayBuilder 20k cells: median \(median) ms, all \(times)")
    #expect(median < 200, "Mac proxy only; the device budget (≤ 12 ms p95) is a PENDING_DEVICE row")
  }
}

/// A small synthetic model: one lane, one strand of decades 1880–1950 with every bin state.
enum Fixture {
  static func tile(cells: [TileCell], bin0: Int = 128) -> Tile {
    Tile(tile: bin0 / 64, bin0: bin0, lanes: ["community:classroom": TileLane(strands: ["1": cells])],
         coverage: ["community:classroom": cells.map { [$0.bin, 0, 5, Int($0.denom), 1] }], washes: [])
  }

  static func query() -> TimelineQueryResponse {
    let lane = Lane(key: "community:classroom", label: .text("Classroom"), unit: "per_million_tokens", modality: "text",
                    orderRule: "first_observed", coverage: .object(["tokens": 40000, "docs": 30, "works": 0]), n: 60, docs: 20,
                    first: LaneEndpoint(label: "1885", precision: "year"), last: LaneEndpoint(label: "1947", precision: "year"),
                    undated: 1, scheduled: 0, undatedShare: 0.02, censor: LaneCensor(left: false, right: false), synthetic: true)
    return try! ScrollsJSON.decode(TimelineQueryResponse.self, from: .object([
      "query_key": "k", "data_version": 1, "status": "ready", "job": .null, "units": .array([]),
      "lanes": .array([try! ScrollsJSON.value(lane)]), "other": ["lanes": 0, "n": 0], "extent": ["from": "1885", "to": "1947"],
      "totals": ["n": 60, "dated": 59, "undated": 1, "scheduled": 0, "names_excluded": 0, "sampled": false, "washes_by_tier": .object([:])],
      "seams": .array([]), "gates": .object([:]),
      "provenance": ["data_version": 1, "run_ids": .array([]), "tokenizer": "u61m-1", "segmenter": "seg-1", "synthetic": true,
                     "collections": .array([]), "licenses": .array([])],
    ]))
  }

  static func build() -> DisplayBuild {
    // decades 188…195 relative to tile 2 (bin0 128): idx 60 = 1880s
    let cells = [
      TileCell(bin: 60, n: 14, docs: 5, authors: 4, denom: 2100, rate: 6666.7, ciLo: 3600, ciHi: 11000, state: 1, flags: 16, dp: nil),
      TileCell(bin: 61, n: 22, docs: 6, authors: 5, denom: 2700, rate: 8148.1, ciLo: 5100, ciHi: 12300, state: 1, flags: 18, dp: nil),
      TileCell(bin: 62, n: 0, docs: 0, authors: 0, denom: 2400, rate: 0, ciLo: 0, ciHi: 1537, state: 2, flags: 16, dp: nil),
      TileCell(bin: 63, n: 3, docs: 2, authors: 2, denom: 600, rate: nil, ciLo: nil, ciHi: nil, state: 3, flags: 17, dp: nil),
    ]
    let cells2 = [
      TileCell(bin: 1, n: 19, docs: 5, authors: 4, denom: 2300, rate: 8260.9, ciLo: 4900, ciHi: 12900, state: 1, flags: 16, dp: nil),
      TileCell(bin: 3, n: 17, docs: 6, authors: 5, denom: 2200, rate: 7727.3, ciLo: 4500, ciHi: 12300, state: 1, flags: 20, dp: nil),
    ]
    let tiles: [Int64: TileSlot] = [2: .data(tile(cells: cells)), 3: .data(tile(cells: cells2, bin0: 192))]
    let lo = Double(DayMath.dayFromYMD(1860, 1, 1)), hi = Double(DayMath.dayFromYMD(1960, 1, 1))
    let model = ScrollModelBuilder.build(ModelInput(query: query(), tier: .decades, tiles: tiles, range: lo...hi,
                                                     strands: [StrandPin(type: "expression", id: "1", glyph: "circle")],
                                                     strandLabels: ["1": "carry the zero"]))
    let dpp = (hi - lo) / 1290
    let layout = LaneLayouts.reference(keys: model.lanes.map(\.key), strandCount: 1, fillHeight: 300)
    return DisplayBuilder.buildSync(DisplayInput(model: model, originDay: lo, daysPerPoint: dpp, width: 1290, layout: layout))
  }

  /// `cells` observed L3 bins spread over 10 lanes.
  static func big(cells: Int) -> DisplayInput {
    let lanes = 10, perLane = cells / lanes
    var tiles: [Int64: TileSlot] = [:]
    var laneList: [Lane] = []
    let y0 = 1000
    for l in 0..<lanes {
      laneList.append(Lane(key: "lane:\(l)", label: .text("Lane \(l)"), unit: "per_million_tokens", modality: "text", orderRule: "first_observed",
                           coverage: .object(["tokens": 1e6]), n: perLane, docs: perLane, first: nil, last: nil, undated: 0, scheduled: 0,
                           undatedShare: 0, censor: LaneCensor(left: false, right: false), synthetic: false))
    }
    for t in Int64(y0 / 64)...Int64((y0 + perLane) / 64) {
      var tl: [String: TileLane] = [:]
      var cov: [String: [[Int]]] = [:]
      for l in 0..<lanes {
        var cs: [TileCell] = []
        for i in 0..<64 {
          let year = Int(t) * 64 + i
          guard year >= y0 && year < y0 + perLane else { continue }
          let state = (year + l) % 7 == 0 ? 2 : 1
          cs.append(TileCell(bin: i, n: 5 + year % 9, docs: 3, authors: 2, denom: 5000, rate: state == 1 ? Double(100 + year % 50) : 0,
                             ciLo: 50, ciHi: 300, state: state, flags: year % 11 == 0 ? 2 : 0, dp: nil))
        }
        tl["lane:\(l)"] = TileLane(strands: ["1": cs])
        cov["lane:\(l)"] = cs.map { [$0.bin, 0, 3, 5000, 1] }
      }
      tiles[t] = .data(Tile(tile: Int(t), bin0: Int(t) * 64, lanes: tl, coverage: cov, washes: []))
    }
    var q = query()
    q.lanes = laneList
    let lo = Double(DayMath.dayFromYMD(y0, 1, 1)), hi = Double(DayMath.dayFromYMD(y0 + perLane, 1, 1))
    let model = ScrollModelBuilder.build(ModelInput(query: q, tier: .years, tiles: tiles, range: lo...hi,
                                                     strands: [StrandPin(type: "expression", id: "1", glyph: "circle")]))
    let layout = LaneLayouts.reference(keys: model.lanes.map(\.key), strandCount: 1)
    return DisplayInput(model: model, originDay: lo, daysPerPoint: (hi - lo) / (Double(perLane) * 8), width: Double(perLane) * 8, layout: layout)
  }
}
