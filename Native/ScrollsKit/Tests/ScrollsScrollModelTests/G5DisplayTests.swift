// OWNER: N7
// G5 (IOS-SPEC §2.2, §2.4): `ScrollsScrollModel` against display.mjs over the reference server's own payloads. For every
// case (query × width × tier [× variant]) the Swift model, layout and display build are compared with Node's: model
// summary exact, layout exact, every primitive's id, kind, layer, style, openable, text, size, feather, pattern, round,
// glyph, sub, ref, tooltip and gate day exact and its geometry within ±0.01 pt; then, across the vantage sweep (12 days
// × strict/context), `DisplayList.visible(at:)` must hide and ghost exactly the primitives Node's
// `buildDisplay(…, {vantage})` leaves out and ghosts, and the hit grid must answer every probe as hit.mjs does (exact
// order; only exact ties — same class, same distance — may come in another order).
//
// The one accepted difference (DV-20, requested from N0 for DIVERGENCES.json; the same family as DV-7): the phone lays
// texts out once over ungated primitives, so where Node's vantage build drops a hidden wash's label (freeing room for a
// later one) or spends less of the 150-text budget, Node may draw a text the phone does not. Only texts, and only in
// that direction, are accepted, and each is counted in the report.

import CoreGraphics
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import Testing

@Suite("G5 display list = display.mjs")
struct G5DisplayTests {
  @Test("g5.display (committed: the demo at 430 pt, every tier, the vantage sweep, hit probes)",
        .enabled(if: G5Golden.available("g5.display") && G5Golden.available("g5.inputs")))
  func committed() throws {
    let report = try G5Runner.run(family: "g5.display", inputs: ["g5.inputs"])
    print("G5 \(report.summary)")
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g5.display-wide (private: 932 and 1440 pt, and Cipher machine on m5r with its seam)",
        .enabled(if: G5Golden.available("g5.display-wide") && G5Golden.available("g5.inputs") && G5Golden.available("g5.inputs-m5r")))
  func wide() throws {
    let report = try G5Runner.run(family: "g5.display-wide", inputs: ["g5.inputs", "g5.inputs-m5r"])
    print("G5 \(report.summary)")
    #expect(report.passed, "\(report.summary)")
  }
}

/// One query's payloads (`g5.inputs`).
struct G5Input {
  var query: TimelineQueryResponse?
  var corpus: Corpus?
  var strands: [StrandPin]
  var labels: [String: String]
  var facet: String
  /// tier → (answered tier, tiles)
  var tiles: [String: (answered: String, tiles: [Int64: TileSlot])]
  var marks: [String: MarksWindow]

  init(_ v: JSONValue) throws {
    if let q = v["query"], !q.isNull {
      query = try ScrollsJSON.decode(TimelineQueryResponse.self, from: q)
    } else {
      query = nil
    }
    corpus = try v["corpus_entry"].flatMap { $0.isNull ? nil : $0 }.map { try ScrollsJSON.decode(Corpus.self, from: $0) }
    strands = (v["strands"]?.arrayValue ?? []).map {
      StrandPin(type: $0["type"]?.stringValue ?? "", id: $0["id"]?.stringValue ?? "", glyph: $0["glyph"]?.stringValue ?? "circle")
    }
    var labels: [String: String] = [:]
    for (k, x) in v["strandLabels"]?.objectValue ?? JSONObject() { labels[k] = x.stringValue }
    self.labels = labels
    facet = v["request"]?["lanes"]?["facet"]?.stringValue ?? "community"
    var tiles: [String: (String, [Int64: TileSlot])] = [:]
    for (tier, slot) in v["tiles"]?.objectValue ?? JSONObject() {
      var m: [Int64: TileSlot] = [:]
      for (k, t) in slot["tiles"]?.objectValue ?? JSONObject() {
        m[Int64(k)!] = t.isNull ? .empty : .data(try ScrollsJSON.decode(Tile.self, from: t))
      }
      tiles[tier] = (slot["answered"]?.stringValue ?? tier, m)
    }
    self.tiles = tiles
    var marks: [String: MarksWindow] = [:]
    for (k, m) in v["marks"]?.objectValue ?? JSONObject() {
      let items = try (m["items"]?.arrayValue ?? []).map { try ScrollsJSON.decode(Mark.self, from: $0) }
      marks[k] = MarksWindow(items: items, fromDay: m["fromDay"]?.safeInteger ?? 0, toDay: m["toDay"]?.safeInteger ?? 0,
                             truncated: m["truncated"]?.boolValue ?? false)
    }
    self.marks = marks
  }
}

enum G5Runner {
  static let geometry = 0.01

  static func run(family: String, inputs: [String]) throws -> G5Golden.Report {
    var byKey: [String: G5Input] = [:]
    for f in inputs {
      let inputReport = G5Golden.Report(f)
      for v in try G5Golden.load(f) {
        guard let key = v["key"]?.stringValue else { continue }
        do {
          byKey[key] = try G5Input(v)
          inputReport.check(true, key)
        } catch {
          inputReport.check(false, "\(f) \(key): the contract types do not decode it (\(error))")
        }
      }
      inputReport.write()
      if !inputReport.passed { print("G5 \(inputReport.summary)") }
    }
    let report = G5Golden.Report(family)
    for c in try G5Golden.load(family) {
      try checkCase(c, inputs: byKey, report: report)
    }
    report.write()
    return report
  }

  static func caseName(_ c: JSONValue) -> String {
    "\(c["input"]?.stringValue ?? "?") w\(c["width"]?.safeInteger ?? 0) \(c["tier"]?.stringValue ?? "?")"
      + (c["variant"]?.stringValue.map { " \($0)" } ?? "")
  }

  // swiftlint:disable:next function_body_length
  static func checkCase(_ c: JSONValue, inputs: [String: G5Input], report: G5Golden.Report) throws {
    let name = caseName(c)
    guard let key = c["input"]?.stringValue, let input = inputs[key], let tierCode = c["tier"]?.stringValue,
      let tier = Tier(code: tierCode), let out = c["out"]
    else {
      report.check(false, "\(name): unreadable case")
      return
    }
    let range = (c["range"]?.arrayValue ?? []).compactMap(\.numberValue)
    let visible = (c["visible"]?.arrayValue ?? []).compactMap(\.numberValue)
    let dpp = c["axis"]?["daysPerPx"]?.numberValue ?? 1
    var layers: [String: Int] = [:]
    for (k, v) in c["layers"]?.objectValue ?? JSONObject() { layers[k] = v.safeInteger }
    let seamCollapsed = c["seamCollapsed"]?.boolValue ?? false

    // ── the model ──
    var model: TimelineModel
    if let query = input.query {
      let answered = input.tiles[tierCode]?.answered ?? tierCode
      let drawTier = Tier(code: answered) ?? tier
      let tiles = input.tiles[answered]?.tiles ?? [:]
      func mk(_ marks: MarksWindow?) -> TimelineModel {
        ScrollModelBuilder.build(ModelInput(query: query, tier: drawTier, tiles: tiles, range: range[0]...range[1], visible: visible[0]...visible[1],
                                            strands: input.strands, marks: marks, strandLabels: input.labels, laneLimit: 10,
                                            lanesView: LanesView(facet: input.facet, order: "first_observed")))
      }
      model = mk(nil)
      if model.wantMarks, let mkKey = c["marks"]?.stringValue, let marks = input.marks[mkKey] { model = mk(marks) }
    } else {
      model = ScrollModelBuilder.coverageModel(collections: input.corpus?.collections ?? [], synthetic: input.corpus?.synthetic ?? false, tier: tier)
    }
    if let m = out["model"] { compareModel(model, m, name, report) }

    // ── the layout ──
    let lp = c["layoutParams"]
    let layout = LaneLayouts.reference(keys: model.lanes.map(\.key), strandCount: lp?["strandCount"]?.safeInteger ?? 1,
                                       slotH: lp?["slotH"]?.numberValue ?? Geom.slotH, moreRow: lp?["moreRow"]?.boolValue ?? false,
                                       fillHeight: lp?["fillH"]?.numberValue)
    if let l = out["layout"] { compareLayout(layout, l, name, report) }

    // ── the display build (no vantage) ──
    let build = DisplayBuilder.buildSync(DisplayInput(model: model, originDay: range[0], daysPerPoint: dpp, width: (range[1] - range[0]) / dpp,
                                                     layout: layout, layers: layers, seams: input.query?.seams ?? [],
                                                     seamCollapsed: seamCollapsed))
    let st = out["stats"]
    report.check(st?["rects"]?.safeInteger == build.stats.rects && st?["ticks"]?.safeInteger == build.stats.ticks
                   && st?["texts"]?.safeInteger == build.stats.texts && st?["marks"]?.safeInteger == build.stats.marks,
                 "\(name): stats", expected: st ?? .null,
                 actual: ["rects": .number(Double(build.stats.rects)), "ticks": .number(Double(build.stats.ticks)),
                          "texts": .number(Double(build.stats.texts)), "marks": .number(Double(build.stats.marks))])
    report.check(out["overBudget"]?.boolValue == build.overBudget, "\(name): overBudget")
    let simplified = (out["overBudget"]?.boolValue ?? false) || build.overBudget

    var nodeIndex: [DisplayBuild.Part: [String: Int]] = [:]
    var nodePrims: [DisplayBuild.Part: [JSONValue]] = [:]
    var swiftIndex: [DisplayBuild.Part: [String: PrimID]] = [:]
    for part in [DisplayBuild.Part.top, .lanes] {
      let list = (out[part == .top ? "top" : "lanes"]?.arrayValue) ?? []
      nodePrims[part] = list
      var idx: [String: Int] = [:]
      for (i, p) in list.enumerated() { idx[p[0]?.stringValue ?? ""] = i }
      nodeIndex[part] = idx
      let swift = build.referencePrims(part, in: build.list(part))
      var sidx: [String: PrimID] = [:]
      for (i, _) in build.meta(part).enumerated() { sidx[build.referenceID(part, PrimID(rawValue: UInt32(i)))] = PrimID(rawValue: UInt32(i)) }
      swiftIndex[part] = sidx
      report.check(swift.count == list.count, "\(name) \(part): primitive count", expected: .number(Double(list.count)), actual: .number(Double(swift.count)))
      for (i, n) in list.enumerated() {
        guard i < swift.count else { break }
        comparePrim(swift[i], n, "\(name) \(part) #\(i)", report)
      }
    }

    // ── hit probes (no vantage) ──
    let hits = out["hits"]
    for part in [DisplayBuild.Part.top, .lanes] {
      for (pi, probe) in (hits?[part == .top ? "top" : "lanes"]?.arrayValue ?? []).enumerated() {
        let x = probe[0]?.numberValue ?? 0, y = probe[1]?.numberValue ?? 0
        let expected = probe[2]?.arrayValue ?? []
        compareHits(build: build, part: part, x: x, y: y, vantage: nil, expected: expected, nodeIndex: nodeIndex[part]!,
                    name: "\(name) \(part) probe \(pi)", report: report)
      }
    }

    // ── the vantage sweep ──
    guard !simplified else { return }  // DV-7: visible sets are compared only where neither side simplified
    for sw in out["sweep"]?.arrayValue ?? [] {
      guard let day = sw["day"]?.safeInteger, let strict = sw["strict"]?.boolValue else { continue }
      let v = Vantage(day: Int32(day), mode: strict ? .strict : .context)
      let vis = build.visible(at: v)
      let vname = "\(name) vantage \(day)\(strict ? " strict" : " context")"
      for part in [DisplayBuild.Part.top, .lanes] {
        let enc = sw[part == .top ? "top" : "lanes"]
        let list = vis.list(part)
        var shown = Set<Int>(), ghost = Set<Int>()
        for p in list.allPrims {
          let rid = build.referenceID(part, p.id)
          guard let ni = nodeIndex[part]![rid] else { continue }
          shown.insert(ni)
          if PrimFlags(rawValue: p.flags).contains(.ghost) { ghost.insert(ni) }
        }
        let count = nodePrims[part]!.count
        let hiddenSwift = Set(0..<count).subtracting(shown)
        let hiddenNode = Set((enc?["hidden"]?.arrayValue ?? []).compactMap(\.safeInteger))
        let ghostNode = Set((enc?["ghost"]?.arrayValue ?? []).compactMap(\.safeInteger))
        report.check(hiddenSwift == hiddenNode, "\(vname) \(part): hidden set",
                     expected: .array(hiddenNode.sorted().map { .string(nodePrims[part]![$0][0]?.stringValue ?? "") }),
                     actual: .array(hiddenSwift.sorted().map { .string(nodePrims[part]![$0][0]?.stringValue ?? "") }))
        report.check(ghost == ghostNode, "\(vname) \(part): ghost set",
                     expected: .array(ghostNode.sorted().map { .number(Double($0)) }), actual: .array(ghost.sorted().map { .number(Double($0)) }))
        for extra in enc?["extra"]?.arrayValue ?? [] {
          // DV-20: only texts, and only ones Node draws and the phone does not
          let kind = extra[1]?.stringValue
          let rid = extra[0]?.stringValue ?? ""
          if kind == "text", swiftIndex[part]![rid] == nil || hiddenSwift.contains(nodeIndex[part]![rid] ?? -1) {
            report.accept("DV-20")
          } else {
            report.check(false, "\(vname) \(part): Node draws \(rid) that the plain build lacks", expected: extra)
          }
        }
        // hits at the vantage: the probes whose answer changed, else the plain answer filtered by the vantage
        let changed = enc.flatMap { _ in sw["hits"]?[part == .top ? "top" : "lanes"]?.objectValue } ?? JSONObject()
        for (pi, probe) in (hits?[part == .top ? "top" : "lanes"]?.arrayValue ?? []).enumerated() {
          let expected = changed[String(pi)]?.arrayValue ?? probe[2]?.arrayValue ?? []
          compareHits(build: build, part: part, x: probe[0]?.numberValue ?? 0, y: probe[1]?.numberValue ?? 0, vantage: v,
                      expected: expected, nodeIndex: nodeIndex[part]!, name: "\(vname) \(part) probe \(pi)", report: report)
        }
      }
    }
  }

  static func compareModel(_ model: TimelineModel, _ m: JSONValue, _ name: String, _ report: G5Golden.Report) {
    report.check(m["visibleN"]?.safeInteger == model.visibleN && m["rangeN"]?.safeInteger == model.rangeN
                   && m["wantMarks"]?.boolValue == model.wantMarks && m["override"]?.boolValue == model.override
                   && m["hiddenLanes"]?.safeInteger == model.hiddenLanes && m["hiddenN"]?.safeInteger == model.hiddenN
                   && m["rowCount"]?.safeInteger == model.rowCount,
                 "\(name): model counts", expected: m["visibleN"] ?? .null, actual: .number(Double(model.visibleN)))
    report.check((m["loadedTiles"]?.arrayValue ?? []).compactMap(\.safeInteger) == model.loadedTiles.map(Int.init)
                   && (m["missingTiles"]?.arrayValue ?? []).compactMap(\.safeInteger) == model.missingTiles.map(Int.init),
                 "\(name): tiles")
    report.check(m["summary"]?.stringValue == ScrollWords.describe(model), "\(name): describeModel",
                 expected: m["summary"] ?? .null, actual: .string(ScrollWords.describe(model)))
    let units = (m["units"]?.arrayValue ?? []).map { "\($0["unit"]?.stringValue ?? ""):\(JSNumber.format($0["max"]?.numberValue ?? 0))" }
    report.check(units == model.units.map { "\($0.unit):\(JSNumber.format($0.max))" }, "\(name): units")
    let track = (m["coverageTrack"]?.arrayValue ?? []).map { CanonicalJSON.string($0) }
    let mine = model.coverageTrack.map { r in
      CanonicalJSON.string(["unit": .string(r.unit), "cells": .array(r.cells.map { .array([.number(Double($0.bin)), .number(Double($0.loDay)),
                                                                                        .number(Double($0.hiDay)), .number($0.amount), .number(Double($0.cls))]) })])
    }
    report.check(track == mine, "\(name): coverage track")
    let lanes = m["lanes"]?.arrayValue ?? []
    report.check(lanes.count == model.lanes.count, "\(name): lane count")
    for (l, lj) in zip(model.lanes, lanes) {
      let ln = "\(name) lane \(l.key)"
      report.check(lj["key"]?.stringValue == l.key && lj["label"]?.stringValue == l.label && lj["unit"]?.stringValue == l.unit
                     && lj["covUnit"]?.stringValue == l.coverageUnit && lj["pending"]?.boolValue == l.pending
                     && lj["synthetic"]?.boolValue == l.synthetic, "\(ln): identity", expected: lj["label"] ?? .null, actual: .string(l.label))
      func runs(_ r: [BinRun]) -> String {
        CanonicalJSON.string(.array(r.map { .array([.number(Double($0.loDay)), .number(Double($0.hiDay)), .number(Double($0.binLo)), .number(Double($0.binHi))]) }))
      }
      report.check(CanonicalJSON.string(lj["uncovered"] ?? .null) == runs(l.uncovered)
                     && CanonicalJSON.string(lj["pendingRuns"] ?? .null) == runs(l.pendingRuns)
                     && CanonicalJSON.string(lj["unloaded"] ?? .null) == runs(l.unloaded), "\(ln): runs",
                   expected: lj["uncovered"] ?? .null, actual: .string(runs(l.uncovered)))
      let cov = CanonicalJSON.string(.array(l.coverage.map { .array([.number(Double($0.bin)), .number(Double($0.cls))]) }))
      report.check(CanonicalJSON.string(lj["coverage"] ?? .null) == cov, "\(ln): coverage")
      let strands = lj["strands"]?.arrayValue ?? []
      report.check(strands.count == l.strands.count, "\(ln): strand count")
      for (s, sj) in zip(l.strands, strands) {
        let sn = "\(ln) strand \(s.ref)"
        report.check(sj["ref"]?.stringValue == s.ref && sj["label"]?.stringValue == s.label, "\(sn): identity")
        report.check((sj["bins"]?.arrayValue ?? []).compactMap(\.safeInteger) == s.cols.bin.map(Int.init)
                       && (sj["state"]?.arrayValue ?? []).compactMap(\.safeInteger) == s.cols.state.map { Int($0.rawValue) }
                       && (sj["n"]?.arrayValue ?? []).compactMap(\.safeInteger) == s.cols.n.map(Int.init)
                       && (sj["flags"]?.arrayValue ?? []).compactMap(\.safeInteger) == s.cols.flags.map(Int.init), "\(sn): columns")
        let bars = sj["bars"]?.arrayValue ?? []
        report.check(bars.count == s.bars.count, "\(sn): bar count")
        for (b, bj) in zip(s.bars, bars) {
          func cap(_ c: Cap, _ j: JSONValue?) -> Bool {
            j?["day"]?.safeInteger == c.day && j?["exact"]?.boolValue == c.exact && j?["censored"]?.boolValue == c.censored
              && j?["label"]?.stringValue == c.label
          }
          report.check(bj["start"]?.safeInteger == b.start && bj["end"]?.safeInteger == b.end && bj["loDay"]?.safeInteger == b.loDay
                         && bj["hiDay"]?.safeInteger == b.hiDay && bj["n"]?.safeInteger == b.n && cap(b.startCap, bj["start_cap"])
                         && cap(b.endCap, bj["end_cap"]), "\(sn): bar \(b.loDay)", expected: bj,
                       actual: .string("\(b.startCap.label) … \(b.endCap.label) censored \(b.startCap.censored)/\(b.endCap.censored)"))
        }
        let washes = (sj["washes"]?.arrayValue ?? []).map(CanonicalJSON.string)
        let mine = s.washes.map {
          CanonicalJSON.string(.array([.number(Double($0.loDay)), .number(Double($0.hiDay)), .number(Double($0.n)), .string($0.label),
                                       .bool($0.circa), .bool($0.synthetic)]))
        }
        report.check(washes == mine, "\(sn): washes")
        if let summary = sj["strandSummary"]?.stringValue {
          let mineSummary = ScrollWords.strandSummary(lane: l, strand: s, tier: model.tier)
          report.check(summary == mineSummary, "\(sn): strandSummary", expected: .string(summary), actual: .string(mineSummary))
        }
      }
    }
  }

  static func compareLayout(_ layout: LaneLayout, _ l: JSONValue, _ name: String, _ report: G5Golden.Report) {
    var ok = l["height"]?.numberValue == layout.height && l["slotH"]?.numberValue == layout.slotH
    let lanes = l["lanes"]?.arrayValue ?? []
    ok = ok && lanes.count == layout.lanes.count
    for (b, j) in zip(layout.lanes, lanes) {
      ok = ok && j["key"]?.stringValue == b.key && j["y"]?.numberValue == b.y && j["h"]?.numberValue == b.h
      let slots = (j["slots"]?.arrayValue ?? []).map { ($0[0]?.numberValue ?? -1, $0[1]?.numberValue ?? -1, $0[2]?.numberValue ?? -1) }
      ok = ok && slots.count == b.slots.count && zip(slots, b.slots).allSatisfy { $0.0 == $1.y && $0.1 == $1.h && $0.2 == $1.mid }
    }
    report.check(ok, "\(name): layout", expected: l, actual: .number(layout.height))
  }

  static func near(_ a: Double?, _ b: Double?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    return abs(a - b) <= geometry
  }

  static func comparePrim(_ s: ReferencePrim, _ n: JSONValue, _ name: String, _ report: G5Golden.Report) {
    let extra = n[9]?.objectValue ?? JSONObject()
    var problems: [String] = []
    if s.id != n[0]?.stringValue { problems.append("id") }
    if s.kind.rawValue != n[1]?.stringValue { problems.append("kind") }
    if s.layer.rawValue != n[2]?.stringValue { problems.append("layer") }
    if s.style != n[3]?.stringValue { problems.append("style") }
    if !near(s.x0, n[4]?.numberValue) || !near(s.y0, n[5]?.numberValue) || !near(s.x1, n[6]?.numberValue) || !near(s.y1, n[7]?.numberValue) {
      problems.append("geometry")
    }
    if s.openable != (n[8]?.safeInteger == 1) { problems.append("openable") }
    if s.ghost != (extra["ghost"]?.boolValue ?? false) { problems.append("ghost") }
    if s.text != extra["text"]?.stringValue { problems.append("text") }
    if s.pattern != extra["pattern"]?.stringValue { problems.append("pattern") }
    if s.round != extra["round"]?.stringValue { problems.append("round") }
    if s.glyph != extra["glyph"]?.stringValue { problems.append("glyph") }
    if s.sub != extra["sub"]?.stringValue { problems.append("sub") }
    if !near(s.size, extra["size"]?.numberValue) { problems.append("size") }
    if !near(s.feather, extra["feather"]?.numberValue) && !(s.feather == 0 && extra["feather"] == nil) { problems.append("feather") }
    if !near(s.w, extra["w"]?.numberValue) { problems.append("w") }
    if !near(s.seamX, extra["seamX"]?.numberValue) { problems.append("seamX") }
    if s.synthetic != extra["synthetic"]?.boolValue { problems.append("synthetic") }
    if let pts = extra["points"]?.arrayValue {
      let mine = s.points ?? []
      if mine.count != pts.count || !zip(mine, pts).allSatisfy({ near($0[0], $1[0]?.numberValue) && near($0[1], $1[1]?.numberValue) }) {
        problems.append("points")
      }
    } else if s.points != nil {
      problems.append("points")
    }
    let nref = extra["ref"].map(CanonicalJSON.string), sref = s.ref.map(CanonicalJSON.string)
    if nref != sref { problems.append("ref") }
    let ntip = extra["tip"]?.arrayValue?.compactMap(\.stringValue)
    if ntip.map({ $0.map { Array($0.utf16) } }) != s.tip.map({ $0.map { Array($0.utf16) } }) { problems.append("tip") }
    if let t = extra["t"]?.safeInteger, Int(s.revealDay ?? .min) != t { problems.append("t") }
    var actual = JSONObject()
    actual["id"] = .string(s.id)
    actual["geometry"] = .array([s.x0, s.y0, s.x1, s.y1].map { .number($0) })
    actual["ref"] = s.ref ?? .null
    actual["tip"] = s.tip.map { .array($0.map(JSONValue.string)) } ?? .null
    actual["text"] = s.text.map(JSONValue.string) ?? .null
    report.check(problems.isEmpty, "\(name) \(n[0]?.stringValue ?? ""): \(problems.joined(separator: ","))", expected: n, actual: .object(actual))
  }

  static func compareHits(build: DisplayBuild, part: DisplayBuild.Part, x: Double, y: Double, vantage: Vantage?, expected: [JSONValue],
                          nodeIndex: [String: Int], name: String, report: G5Golden.Report) {
    let p = CGPoint(x: build.contentX(referenceX: x), y: y)
    let mine = build.list(part).hit.hits(p, tolerance: 12, vantage: vantage).map { h in
      (nodeIndex[build.referenceID(part, h.entry.id)] ?? -1, h.distance)
    }
    var want: [(Int, Double)] = []
    var i = 0
    while i + 1 < expected.count {
      want.append((expected[i].safeInteger ?? -2, expected[i + 1].numberValue ?? -1))
      i += 2
    }
    // equal lists, allowing permutations only inside runs of equal distance (exact ties of one class)
    var ok = mine.count == want.count
    if ok {
      var k = 0
      while k < want.count {
        var e = k
        while e + 1 < want.count && abs(want[e + 1].1 - want[k].1) < 1e-3 { e += 1 }
        let a = Set(want[k...e].map(\.0)), b = Set(mine[k...e].map(\.0))
        if a != b || !zip(mine[k...e], want[k...e]).allSatisfy({ abs($0.1 - $1.1) < 0.01 }) { ok = false; break }
        k = e + 1
      }
    }
    report.check(ok, "\(name)", expected: .array(want.map { .number(Double($0.0)) }), actual: .array(mine.map { .number(Double($0.0)) }))
  }
}
