// OWNER: N7
// A load model for the renderer and builder budgets (IOS-SPEC §4.23: "DisplayBuilder for 20k cells ≤ 12 ms p95", "GPU
// time at maximum load"): n lanes × s strands × b consecutive bins, with every state and flag the builder draws
// (observed runs broken by absent, low and uncovered bins, sparse, ¹, ≈ and synthetic flags, washes) at fixed,
// generated values. It is a test load for timings and render parity only: it is never shown as evidence, and every
// lane says so in its label ("load test · not data").

import ScrollsContracts
import ScrollsCore

public enum PerfLoad {
  /// The label every load lane carries.
  public static let label = "load test · not data"

  /// A model of `lanes × strands × bins` cells at `tier`, starting at `firstBin`.
  public static func model(lanes: Int, strands: Int, bins: Int, tier: Tier = .years, firstBin: Int64 = 1800) -> TimelineModel {
    var laneModels: [LaneModel] = []
    var unitMax = 0.0
    for l in 0..<lanes {
      var strandModels: [StrandModel] = []
      for s in 0..<strands {
        var cols = StrandSeries(ref: "load-\(s)", label: "\(label) \(s + 1)", glyph: ["●", "■", "▲", "◆"][s % 4])
        for i in 0..<bins {
          let bin = firstBin + Int64(i)
          // a fixed pattern: runs of 9 observed bins, then absent, low, observed, uncovered
          let k = (i + l * 3 + s * 5) % 13
          let state: BinState = k < 9 ? .observed : k == 9 ? .absent : k == 10 ? .low : k == 11 ? .observed : .uncovered
          guard state != .uncovered else { continue }
          let n = state == .observed ? Int32(3 + (i * 7 + l) % 40) : state == .low ? 2 : 0
          let denom = Double(20_000 + (i * 131 + l * 17) % 90_000)
          let rate = state == .observed ? Double(n) / denom * 1e6 : .nan
          var flags: UInt16 = 0
          if state == .observed && n < 5 { flags |= PrimFlags.sparse.rawValue }
          if i % 17 == 0 { flags |= PrimFlags.singleSource.rawValue }
          if i % 23 == 0 { flags |= PrimFlags.estimatedMajority.rawValue }
          if l % 3 == 2 { flags |= PrimFlags.synthetic.rawValue }
          cols.bin.append(bin)
          cols.loDay.append(Day(clamping: tier.startDay(ofBin: bin)))
          cols.hiDay.append(Day(clamping: tier.endDay(ofBin: bin)))
          cols.n.append(n)
          cols.docs.append(max(1, n / 3))
          cols.denom.append(denom)
          cols.rate.append(rate)
          cols.ciLo.append(rate.isFinite ? rate * 0.6 : .nan)
          cols.ciHi.append(rate.isFinite ? rate * 1.5 : .nan)
          cols.state.append(state)
          cols.flags.append(flags)
          if rate.isFinite { unitMax = max(unitMax, rate) }
        }
        var bars: [BarRun] = []
        for (a, b) in ScrollModelBuilder.findBars(cols) {
          var n = 0
          for i in a...b { n += Int(cols.n[i]) }
          let lo = Int(cols.loDay[a]), hi = Int(cols.hiDay[b])
          bars.append(BarRun(start: a, end: b, loDay: lo, hiDay: hi, n: n, bins: b - a + 1,
                             startCap: Cap(day: lo, exact: false, censored: false, label: "in \(tier.label(ofBin: cols.bin[a]))"),
                             endCap: Cap(day: hi, exact: false, censored: false, label: "in \(tier.label(ofBin: cols.bin[b]))")))
        }
        var binN = 0, observed = 0
        for i in 0..<cols.count {
          binN += Int(cols.n[i])
          if cols.state[i] == .observed { observed += 1 }
        }
        strandModels.append(StrandModel(ref: cols.ref, type: "expression", id: "\(s)", glyph: "circle", index: s, pin: s, sub: nil,
                                        label: cols.label, cols: cols, bars: bars, washes: [], marks: nil, totals: (binN, 0, observed)))
      }
      laneModels.append(LaneModel(
        key: "load:\(l)", label: "\(label) · lane \(l + 1)", machineLabel: nil, humanLabel: nil, unit: "per_million_tokens", modality: "text",
        header: nil, note: nil, selection: nil, pending: false, censor: LaneCensor(left: false, right: false), first: nil, last: nil, n: 0,
        docs: 0, undated: 0, scheduled: 0, undatedShare: 0, laneCoverage: nil, synthetic: l % 3 == 2, coverageUnit: "tokens", coverage: [],
        uncovered: [], pendingRuns: [], unloaded: [], strands: strandModels, coverageOnly: false, span: nil, amount: nil, isTrail: false))
    }
    return TimelineModel(
      tier: tier, range: nil, visible: nil, lanes: laneModels, hiddenLanes: 0, hiddenN: 0,
      units: [UnitScale(unit: "per_million_tokens", max: unitMax, lanes: laneModels.map(\.key))], visibleN: 0, rangeN: 0,
      wantMarks: false, override: false, marksCheck: nil, loadedTiles: [], missingTiles: [], complete: true, coverageTrack: [],
      strands: [], rowCount: strands, coverageOnly: false)
  }

  /// The display input that draws a load model across `width` points (one bin ≈ `width / bins` points).
  public static func input(_ model: TimelineModel, width: Double, firstBin: Int64 = 1800, bins: Int) -> DisplayInput {
    let tier = model.tier
    let lo = Double(tier.startDay(ofBin: firstBin)), hi = Double(tier.endDay(ofBin: firstBin + Int64(bins) - 1) + 1)
    let layout = LaneLayouts.phone(keys: model.lanes.map(\.key), strandCount: model.rowCount)
    return DisplayInput(model: model, originDay: lo, daysPerPoint: (hi - lo) / width, width: width, layout: layout)
  }
}
