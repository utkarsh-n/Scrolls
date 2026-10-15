// OWNER: N7
// The words of the Scroll, generated from the same numbers as the drawing (SPEC §1.2 item 9, §8.4, §8.6; IOS-SPEC §4.1
// rule 5 "tap replaces hover"): the tooltip lines of display.mjs (which are the phone's tap sentences, byte-equal with the
// reference), `describeModel` (the VoiceOver summary), `strandSummary` and the table alternative's rows and segments
// (a11y-table.mjs). Every count names its denominator; a low bin never prints a rate; gated values print "—", never 0.

import ScrollsContracts
import ScrollsCore

/// Tooltips, summaries and table rows.
public enum ScrollWords {
  /// `binTooltip(lane, strand, i, tier)`: the lines of a bin, from its columns.
  public static func binTooltip(lane: LaneModel, strand: StrandModel, index i: Int, tier: Tier) -> [String] {
    let c = strand.cols
    let n = Double(c.n[i]), denom = c.denom[i], docs = Int(c.docs[i])
    let unitWord = lane.coverageUnit
    var lines = ["\(strand.label) · \(lane.label) · \(tier.label(ofBin: c.bin[i]))"]
    let flags = Int(c.flags[i])
    switch c.state[i] {
    case .observed:
      if c.rate[i].isFinite {
        lines.append("n = \(Format.count(n)) · \(Format.rate(c.rate[i], unit: lane.unit)) \(Format.ci([c.ciLo[i], c.ciHi[i]], unit: lane.unit)) (95% CI)")
      } else if flags & 8 != 0 {
        lines.append("n = \(Format.count(n)) · no rate: a top-cited sample per field × period (within-cell shares in Compare)")
      } else {
        lines.append("n = \(Format.count(n)) · present: no rate is drawn for this lane")
      }
      lines.append("\(Format.tokens(denom)) \(unitWord) · \(Format.count(Double(docs))) \(docs == 1 ? "document" : "documents")")
      var notes: [String] = []
      if flags & 1 != 0 { notes.append("sparse: 1–4 matches") }
      if flags & 2 != 0 { notes.append("¹ single-source burst (≥ 60% from one document)") }
      if flags & 4 != 0 { notes.append("≈ mostly estimated dates") }
      if flags & 8 != 0 { notes.append("sampled") }
      if !notes.isEmpty { lines.append(notes.joined(separator: " · ")) }
    case .absent:
      lines.append("0 occurrences in \(Format.tokens(denom)) \(unitWord) — looked, found none")
    case .low:
      lines.append("low coverage: n = \(Format.count(n)) in \(Format.tokens(denom)) \(unitWord) — rate not shown")
    case .pending:
      lines.append("indexing — not yet looked")
    case .uncovered:
      lines.append("no sources")
    }
    if flags & 16 != 0 { lines.append("SYNTHETIC") }
    return lines
  }

  /// Share of undated matches from which a lane header warns (§1.7, `lanes-menu.mjs` UNDATED_WARN).
  public static let undatedWarn = 0.2

  /// `laneSubtitle(lane)`: the second line of a lane header, "text · 14k tokens, 1906–1960 · curated selection" (the
  /// server's header after the label when it has one; else modality and coverage).
  public static func laneSubtitle(_ lane: LaneModel) -> String {
    if let header = lane.header, header.hasPrefix("\(lane.label) · ") {
      return String(header.dropFirst(lane.label.count + 3))
    }
    let cov = lane.laneCoverage
    let amount = cov?[lane.coverageUnit == "works" ? "works" : "tokens"]?.numberValue
    var span = ""
    if let s = cov?["span"]?.arrayValue, s.count == 2, let a = s[0].numberValue, let b = s[1].numberValue, a.isFinite, b.isFinite {
      span = ", \(JSNumber.format(a))–\(JSNumber.format(b))"
    }
    return [lane.modality, "\(Format.tokens(amount)) \(lane.coverageUnit)\(span)"].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  /// One note under a lane header (`laneNotes`).
  public struct LaneNote: Sendable, Equatable {
    /// 'pending' · 'selection' · 'warn' · 'machine'
    public var kind: String
    public var text: String
  }

  /// `laneNotes(lane, facet)`: indexing, the selection note (never twice), the undated warning, the machine label.
  public static func laneNotes(_ lane: LaneModel, facet: String) -> [LaneNote] {
    var out: [LaneNote] = []
    if lane.pending { out.append(LaneNote(kind: "pending", text: lane.note ?? "indexing — not yet looked")) }
    if let sel = lane.selection, !(lane.header ?? "").contains(sel) { out.append(LaneNote(kind: "selection", text: sel)) }
    if lane.undatedShare >= undatedWarn { out.append(LaneNote(kind: "warn", text: "⚠ \(Format.share(lane.undatedShare)) of matches undated")) }
    if facet == "cluster" {
      out.append(LaneNote(kind: "machine", text: lane.machineLabel.map { "machine label: \($0) (editable)" } ?? "machine label (editable)"))
    }
    return out
  }

  /// `runLabel(tier, run)`: '1940–1949', '1730–1949', 'Apr 1931 – Jun 1931'.
  public static func runLabel(_ tier: Tier, _ run: BinRun) -> String {
    if run.binLo == run.binHi { return tier.label(ofBin: run.binLo) }
    if tier.rawValue <= 3 { return "\(RulerScale.dayLabel(Double(run.loDay)))–\(RulerScale.dayLabel(Double(run.hiDay)))" }
    return "\(tier.label(ofBin: run.binLo)) – \(tier.label(ofBin: run.binHi))"
  }

  /// `describeModel(model)`: a plain-text summary of the Scroll per lane and strand (observed runs, gaps and their kind).
  public static func describe(_ model: TimelineModel?) -> String {
    guard let model, !model.lanes.isEmpty else { return "The Scroll is empty: no lanes for this query." }
    var out: [String] = []
    for lane in model.lanes {
      for s in lane.strands {
        let runs = s.bars.map { "\(RulerScale.dayLabel(Double($0.loDay)))–\(RulerScale.dayLabel(Double($0.hiDay)))" }
        var parts = ["Lane \(lane.label) · \(lane.modality): '\(s.label)'"]
        parts.append(runs.isEmpty ? "no observed bins in this range"
                     : "observed \(runs.joined(separator: " and ")) in \(runs.count) \(runs.count == 1 ? "bar" : "bars")")
        let gaps = lane.uncovered.filter { r in s.bars.contains { $0.hiDay < r.loDay } && s.bars.contains { $0.loDay > r.hiDay } }
        for g in gaps {
          parts.append("gap \(RulerScale.dayLabel(Double(g.loDay)))–\(RulerScale.dayLabel(Double(g.hiDay))): no sources\(lane.synthetic ? " (synthetic)" : "")")
        }
        out.append("\(parts[0]) \(parts.dropFirst().joined(separator: "; ")).")
      }
      if lane.strands.isEmpty { out.append("Lane \(lane.label): coverage only (no strand pinned).") }
    }
    return out.joined(separator: " ")
  }

  /// The VoiceOver summary of one lane (IOS-SPEC §4.19): `describeModel`'s sentences for this lane only.
  public static func describeLane(_ lane: LaneModel) -> String {
    var m = TimelineModel(tier: .decades, range: nil, visible: nil, lanes: [lane], hiddenLanes: 0, hiddenN: 0, units: [], visibleN: 0,
                          rangeN: 0, wantMarks: false, override: false, marksCheck: nil, loadedTiles: [], missingTiles: [],
                          complete: true, coverageTrack: [], strands: [], rowCount: 0, coverageOnly: false)
    m.lanes = [lane]
    return describe(m)
  }

  /// `strandSummary(lane, strand, {tier})`: "carry the zero · Hip-hop · first observed 1994 · last observed 2024 · observed
  /// in 4 of 5 covered decades · 1 gap · 110 matches in range (2 in washes, 1 undated) · per million tokens over 18.4k
  /// tokens · SYNTHETIC".
  public static func strandSummary(lane: LaneModel, strand s: StrandModel, tier: Tier) -> String {
    let c = s.cols
    var covered = 0
    for i in 0..<c.count where c.state[i] != .pending && (c.denom[i] > 0 || c.n[i] > 0) { covered += 1 }
    var parts = [s.label, lane.label]
    if !s.ref.isEmpty, let a = s.bars.first?.startCap, let b = s.bars.last?.endCap {
      parts.append("first observed \(a.label)")
      parts.append("last observed \(b.label)")
    } else {
      parts.append("no observed bins in this range")
    }
    parts.append("observed in \(s.totals.observedBins) of \(covered) covered \(tier.binPlural)")
    let gaps = max(0, s.bars.count - 1)
    parts.append("\(gaps) \(gaps == 1 ? "gap" : "gaps")")
    let washN = s.washes.reduce(0) { $0 + $1.n }
    var extra = ["\(washN) in washes"]
    if lane.undated != 0 { extra.append("\(lane.undated) undated") }
    parts.append("\(s.totals.binN + washN) matches in range (\(extra.joined(separator: ", ")))")
    let amount = lane.laneCoverage?[lane.coverageUnit == "works" ? "works" : "tokens"]?.numberValue
    parts.append("\(Format.unitLabel(lane.unit)) over \(Format.tokens(amount)) \(lane.coverageUnit)")
    if lane.synthetic { parts.append("SYNTHETIC") }
    return parts.joined(separator: " · ")
  }

  // MARK: The table alternative (a11y-table.mjs)

  /// One row of a strand's table, read straight from its columns.
  public struct TableRow: Sendable, Equatable, Identifiable {
    public var id: Int
    public var bin: String
    public var n: String
    public var rate: String
    public var ci: String
    public var coverage: String
    public var state: String
    public var flags: String
  }

  static let flagWordList: [(Int, String)] = [(1, "sparse"), (2, "single source ¹"), (4, "mostly estimated ≈"), (8, "sampled"),
                                              (16, "synthetic"), (32, "names excluded"), (64, "translations included")]

  /// `flagWords(flags)`.
  public static func flagWords(_ flags: Int) -> String {
    flagWordList.filter { flags & $0.0 != 0 }.map(\.1).joined(separator: ", ")
  }

  /// `strandRows(strand, lane, tier)`: the table rows of one strand. Gated or suppressed numbers print "—", never 0.
  public static func tableRows(strand: StrandModel, lane: LaneModel, tier: Tier) -> [TableRow] {
    let c = strand.cols
    return (0..<c.count).map { i in
      let st = c.state[i]
      let observed = st == .observed || st == .absent
      let state: String = switch st {
      case .observed: "observed"
      case .absent: "looked, found none"
      case .low: "low coverage (rate not shown)"
      case .uncovered: "no sources"
      case .pending: "indexing — not yet looked"
      }
      return TableRow(
        id: i, bin: tier.label(ofBin: c.bin[i]), n: st == .pending ? "—" : Format.count(Double(c.n[i])),
        rate: observed ? Format.rate(c.rate[i], unit: lane.unit) : "—",
        ci: observed ? Format.ci([c.ciLo[i], c.ciHi[i]], unit: lane.unit) : "—",
        coverage: c.denom[i].isFinite ? "\(Format.tokens(c.denom[i])) \(lane.coverageUnit)" : "—", state: state,
        flags: flagWords(Int(c.flags[i])))
    }
  }

  /// `segmentList(strand, lane, tier)`: bars, absences, low-coverage bins, gaps and washes in time order.
  public static func segments(strand s: StrandModel, lane: LaneModel, tier: Tier) -> [String] {
    var segs: [(lo: Int, text: String)] = []
    for b in s.bars {
      segs.append((b.loDay, "observed \(RulerScale.dayLabel(Double(b.loDay)))–\(RulerScale.dayLabel(Double(b.hiDay))): \(b.bins) \(b.bins == 1 ? "bin" : "bins"), n = \(Format.count(Double(b.n))); first \(b.startCap.label)\(b.startCap.censored ? " (may be older than our record)" : ""), last \(b.endCap.label)\(b.endCap.censored ? " (may continue past our record)" : "")"))
    }
    let c = s.cols
    for i in 0..<c.count {
      if c.state[i] == .absent {
        segs.append((Int(c.loDay[i]), "\(tier.label(ofBin: c.bin[i])): looked, found none (0 in \(Format.tokens(c.denom[i])) \(lane.coverageUnit))"))
      }
      if c.state[i] == .low {
        segs.append((Int(c.loDay[i]), "\(tier.label(ofBin: c.bin[i])): low coverage, n = \(Format.count(Double(c.n[i]))) in \(Format.tokens(c.denom[i])) \(lane.coverageUnit)"))
      }
    }
    for r in lane.uncovered { segs.append((r.loDay, "\(RulerScale.dayLabel(Double(r.loDay)))–\(RulerScale.dayLabel(Double(r.hiDay))): no sources")) }
    for r in lane.pendingRuns { segs.append((r.loDay, "\(RulerScale.dayLabel(Double(r.loDay)))–\(RulerScale.dayLabel(Double(r.hiDay))): indexing — not yet looked")) }
    for w in s.washes { segs.append((w.loDay, "wash \(w.label): \(Format.count(Double(w.n))) \(w.n == 1 ? "match" : "matches") not counted in bars or rates")) }
    return stableSorted(segs) { $0.lo < $1.lo }.map(\.text)
  }

  /// One table of the alternative: a lane and strand with the painter's own columns (`tableModel`).
  public struct StrandTable: Sendable, Identifiable {
    public var id: String { "\(laneKey)\u{0}\(strandRef)" }
    public var lane: String
    public var laneKey: String
    public var strand: String
    public var strandRef: String
    public var unit: String
    /// The painter's columns (identity-tested against the display list's `LaneSeries`).
    public var source: StrandSeries
    public var rows: [TableRow]
    public var segments: [String]
    public var synthetic: Bool
  }

  /// `tableModel(model)`.
  public static func tables(_ model: TimelineModel) -> [StrandTable] {
    var out: [StrandTable] = []
    for lane in model.lanes {
      for s in lane.strands {
        out.append(StrandTable(lane: lane.label, laneKey: lane.key, strand: s.label, strandRef: s.ref, unit: Format.unitLabel(lane.unit),
                               source: s.cols, rows: tableRows(strand: s, lane: lane, tier: model.tier),
                               segments: segments(strand: s, lane: lane, tier: model.tier), synthetic: lane.synthetic))
      }
    }
    return out
  }
}
