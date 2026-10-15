// OWNER: N7
// A display build seen as the reference sees it: every primitive's display.mjs id, `ref` object, tooltip lines and
// geometry in content pixels, regenerated on demand from its `PrimMeta` and the typed instance. The app uses the tips
// (tap sentences) and refs; G5 uses all of it to compare `visible(at:)` with Node's `buildDisplay(…, {vantage})`.

import ScrollsContracts
import ScrollsCore

/// One primitive as display.mjs writes it.
public struct ReferencePrim: Sendable, Equatable {
  public var id: String
  public var kind: PrimKind
  public var layer: PrimLayer
  public var style: String
  public var x0: Double, y0: Double, x1: Double, y1: Double
  public var openable: Bool
  public var ghost: Bool
  public var text: String?
  public var size: Double?
  public var feather: Double?
  public var pattern: String?
  public var round: String?
  public var glyph: String?
  /// A theme sub-strand's provenance on its bars ('machine_tag', …).
  public var sub: String?
  public var w: Double?
  public var seamX: Double?
  public var synthetic: Bool?
  public var points: [[Double]]?
  /// The reference's `ref` object (nil = null).
  public var ref: JSONValue?
  public var tip: [String]?
  /// The day the primitive is gated by (`t`, or the vantage day it was gated with); nil when never gated.
  public var revealDay: Int32?
}

extension DisplayBuild {
  /// The content x of a stored relative day (`X(day)` of the build).
  public func referenceX(_ d: Float) -> Double {
    let originInt = Double(lanes.originDay)
    return (Double(d) + originInt - input.originDay) / input.daysPerPoint + input.xOffset
  }

  /// This build's content x (the hit grid's coordinates: relative days × points per day) of a reference content x.
  public func contentX(referenceX x: Double) -> Double {
    (x - input.xOffset) + (input.originDay - Double(lanes.originDay)) / input.daysPerPoint
  }

  /// The reference id of a primitive (`b:community:classroom:12:191`, `rt:-25567`, …).
  public func referenceID(_ part: Part, _ id: PrimID) -> String {
    let m = meta(part)[Int(id.rawValue)]
    func lane(_ i: Int) -> LaneModel { model.lanes[i] }
    func strand(_ l: Int, _ s: Int) -> StrandModel { model.lanes[l].strands[s] }
    switch m.source {
    case .rulerTick(let day): return "rt:\(day)"
    case .rulerLabel(let day, _): return "rl:\(day)"
    case .rulerMinor(let bin): return "rm:\(bin)"
    case .coverageCell(let r, let c):
      let row = model.coverageTrack[r]
      return "ct:\(row.unit):\(row.cells[c].bin)"
    case .coverageUncovered(let run): return "ctu:\(run.binLo)"
    case .laneBand(let l): return "lb:\(lane(l).key)"
    case .span(let l): return "span:\(lane(l).key)"
    case .laneUncovered(let l, let r): return "lu:\(lane(l).key):\(lane(l).uncovered[r].binLo)"
    case .lanePending(let l, let r): return "lp:\(lane(l).key):\(lane(l).pendingRuns[r].binLo)"
    case .laneUnloaded(let l, let r): return "ll:\(lane(l).key):\(lane(l).unloaded[r].binLo)"
    case .laneCoverage(let l, let c): return "lc:\(lane(l).key):\(lane(l).coverage[c].bin)"
    case .bar(let l, let s, let i): return "b:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .superscript(let l, let s, let i): return "bs:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .absent(let l, let s, let i): return "a:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .lowHatch(let l, let s, let i): return "lowu:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .lowTick(let l, let s, let i): return "lt:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .lowN(let l, let s, let i): return "ln:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).cols.bin[i])"
    case .capStart(let l, let s, let b): return "cs:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).bars[b].loDay)"
    case .capEnd(let l, let s, let b): return "ce:\(lane(l).key):\(strand(l, s).ref):\(strand(l, s).bars[b].hiDay)"
    case .wash(let l, let s, let w):
      let x = strand(l, s).washes[w]
      return "w:\(lane(l).key):\(strand(l, s).ref):\(x.loDay):\(x.hiDay):\(x.label)"
    case .washLabel(let l, let s, let w):
      let x = strand(l, s).washes[w]
      return "wl:w:\(lane(l).key):\(strand(l, s).ref):\(x.loDay):\(x.hiDay):\(x.label)"
    case .mark(let l, let s, let mi):
      let mk = strand(l, s).marks![mi]
      return "m:\(mk.occ.map { String($0.rawValue) } ?? "p\(mk.passage.rawValue)"):\(lane(l).key)"
    case .coarse(let g):
      let x = coarseGroups[g]
      return "cb:\(lane(x.lane).key):\(strand(x.lane, x.strand).ref):\(x.loDay):\(x.hiDay)"
    case .coarseLabel(let g):
      let x = coarseGroups[g]
      return "cbl:cb:\(lane(x.lane).key):\(strand(x.lane, x.strand).ref):\(x.loDay):\(x.hiDay)"
    case .seamTick(let s): return "sm:\(input.seams[s].year)"
    case .seamLabel(let s): return "sml:\(input.seams[s].year)"
    case .seamLine(let s): return "sml2:\(input.seams[s].year)"
    }
  }

  /// The reference `ref` object of a primitive (nil when it is `null`).
  public func referenceRef(_ part: Part, _ id: PrimID) -> JSONValue? {
    let m = meta(part)[Int(id.rawValue)]
    func obj(_ pairs: [(String, JSONValue)]) -> JSONValue {
      var o = JSONObject()
      for (k, v) in pairs { o[k] = v }
      return .object(o)
    }
    func binRef(_ l: Int, _ s: Int, _ i: Int) -> JSONValue {
      let lane = model.lanes[l], st = lane.strands[s]
      return obj([("type", .string("bin")), ("lane", .string(lane.key)), ("strand", .string(st.ref)), ("tier", .string(model.tier.code)),
                  ("bin", .number(Double(st.cols.bin[i]))), ("i", .number(Double(i)))])
    }
    func occ(_ mk: Mark, lane: String, group: Int?) -> JSONValue {
      var pairs: [(String, JSONValue)] = [("type", .string("occurrence")), ("id", mk.occ.map { .number(Double($0.rawValue)) } ?? .null),
                                          ("passage", .number(Double(mk.passage.rawValue))), ("doc", .number(Double(mk.doc.rawValue))),
                                          ("lane", .string(lane))]
      if let group { pairs.append(("group", .number(Double(group)))) }
      return obj(pairs)
    }
    switch m.source {
    case .rulerTick, .rulerLabel, .rulerMinor, .laneBand, .laneUnloaded, .laneCoverage, .superscript, .lowHatch, .lowN, .washLabel,
         .coarseLabel, .seamLabel:
      return nil
    case .coverageCell(let r, let c):
      let row = model.coverageTrack[r]
      return obj([("type", .string("coverage")), ("unit", .string(row.unit)), ("bin", .number(Double(row.cells[c].bin)))])
    case .coverageUncovered: return obj([("type", .string("uncovered"))])
    case .span(let l): return obj([("type", .string("span")), ("lane", .string(model.lanes[l].key))])
    case .laneUncovered(let l, _): return obj([("type", .string("uncovered")), ("lane", .string(model.lanes[l].key))])
    case .lanePending(let l, _): return obj([("type", .string("pending")), ("lane", .string(model.lanes[l].key))])
    case .bar(let l, let s, let i), .absent(let l, let s, let i), .lowTick(let l, let s, let i): return binRef(l, s, i)
    case .capStart(let l, let s, let b): return binRef(l, s, model.lanes[l].strands[s].bars[b].start)
    case .capEnd(let l, let s, let b): return binRef(l, s, model.lanes[l].strands[s].bars[b].end)
    case .wash(let l, let s, let w):
      let lane = model.lanes[l], st = lane.strands[s], x = st.washes[w]
      return obj([("type", .string("wash")), ("lane", .string(lane.key)), ("strand", .string(st.ref)), ("lo", .number(Double(x.loDay))),
                  ("hi", .number(Double(x.hiDay))), ("label", .string(x.label))])
    case .mark(let l, let s, let mi):
      return occ(model.lanes[l].strands[s].marks![mi], lane: model.lanes[l].key, group: nil)
    case .coarse(let g):
      let x = coarseGroups[g]
      return occ(x.items[0], lane: model.lanes[x.lane].key, group: x.items.count)
    case .seamTick, .seamLine: return obj([("type", .string("seam"))])
    }
  }

  /// The tooltip lines of a primitive (the tap sentence on the phone); nil when it has none.
  public func tip(_ part: Part, _ id: PrimID) -> [String]? {
    let m = meta(part)[Int(id.rawValue)]
    let tier = model.tier
    switch m.source {
    case .rulerTick, .rulerLabel, .rulerMinor, .laneBand, .laneUnloaded, .laneCoverage, .superscript, .lowHatch, .lowN, .washLabel,
         .coarseLabel, .seamLabel:
      return nil
    case .coverageCell(let r, let c):
      let row = model.coverageTrack[r], cell = row.cells[c]
      return ["coverage \(tier.label(ofBin: cell.bin)): \(Format.tokens(cell.amount)) \(row.unit) (step class \(cell.cls) of 4)"]
    case .coverageUncovered: return ["no sources in any shown lane"]
    case .span(let l):
      let lane = model.lanes[l]
      return ["\(lane.label) · dated documents \(lane.span?.label ?? "")",
              "\(lane.amount ?? "") · \(lane.docs) documents\(lane.undated != 0 ? " · \(lane.undated) undated" : "")",
              "coverage only: pin a strand to count occurrences"]
    case .laneUncovered(let l, let r):
      let lane = model.lanes[l]
      return ["\(lane.label) · \(ScrollWords.runLabel(tier, lane.uncovered[r]))", "no sources"]
    case .lanePending(let l, let r):
      let lane = model.lanes[l]
      return ["\(lane.label) · \(ScrollWords.runLabel(tier, lane.pendingRuns[r]))", "indexing — not yet looked"]
    case .bar(let l, let s, let i), .absent(let l, let s, let i), .lowTick(let l, let s, let i):
      return ScrollWords.binTooltip(lane: model.lanes[l], strand: model.lanes[l].strands[s], index: i, tier: tier)
    case .capStart(let l, let s, let b):
      let sc = model.lanes[l].strands[s].bars[b].startCap
      return [sc.censored ? "first observed \(sc.label) — may be older than our record"
              : "first observed \(sc.label)\(sc.exact ? "" : " (bin precision)")"]
    case .capEnd(let l, let s, let b):
      let ec = model.lanes[l].strands[s].bars[b].endCap
      return [ec.censored ? "last observed \(ec.label) — may continue past our record"
              : "last observed \(ec.label)\(ec.exact ? "" : " (bin precision)")"]
    case .wash(let l, let s, let w):
      let x = model.lanes[l].strands[s].washes[w]
      return ["\(x.n) \(x.n == 1 ? "match" : "matches") dated \(x.label) — does not fit one \(tier.word); not counted in bars or rates"]
    case .mark(let l, let s, let mi):
      let lane = model.lanes[l], st = lane.strands[s], mk = st.marks![mi]
      return ["\(st.label) · \(lane.label) · \(ScrollModelBuilder.markLabel(mk)) · \(mk.precision) · \(mk.basis)",
              mk.synthetic ? "SYNTHETIC · click to read the passage" : "click to read the passage"]
    case .coarse(let g):
      let x = coarseGroups[g]
      return ["\(x.items.count) \(x.items.count == 1 ? "item" : "items") dated only to \(x.label) — not drawn at a finer date"]
    case .seamTick(let s), .seamLine(let s):
      return [input.seams[s].label]
    }
  }

  /// The text of a label or glyph primitive.
  public func text(_ part: Part, _ id: PrimID) -> String? {
    let list = self.list(part)
    switch meta(part)[Int(id.rawValue)].slot {
    case .label(let i): return list.labelRuns[list.labels[i].key]?.text
    case .glyph(let i): return list.labelRuns[list.glyphs[i].glyph]?.text
    default: return nil
    }
  }

  /// A primitive as display.mjs writes it, from its typed instance in `list` (which may be a `visible(at:)` view).
  public func referencePrim(_ part: Part, _ id: PrimID, in list: DisplayList) -> ReferencePrim? {
    let m = meta(part)[Int(id.rawValue)]
    let X = { (d: Float) in self.referenceX(d) }
    var x0 = 0.0, x1 = 0.0, y0 = 0.0, y1 = 0.0
    var flags: UInt16 = 0
    var reveal: Int32 = alwaysRevealed
    var size: Double?, feather: Double?, text: String?
    func find<T>(_ a: [T], _ idOf: (T) -> PrimID) -> T? {
      // Instances keep emission order, so a binary search by id finds one in a filtered view.
      var lo = 0, hi = a.count - 1
      while lo <= hi {
        let mid = (lo + hi) / 2
        let v = idOf(a[mid]).rawValue
        if v == id.rawValue { return a[mid] }
        if v < id.rawValue { lo = mid + 1 } else { hi = mid - 1 }
      }
      return nil
    }
    switch m.slot {
    case .band:
      guard let p = find(list.bands, \.id) else { return nil }
      (x0, x1, y0, y1, flags, reveal) = (X(p.d0), X(p.d1), Double(p.y0), Double(p.y1), p.flags, p.revealDay)
    case .wash:
      guard let p = find(list.washes, \.id) else { return nil }
      (x0, x1, y0, y1, flags, reveal) = (X(p.d0), X(p.d1), Double(p.y0), Double(p.y1), p.flags, p.revealDay)
      feather = Double(p.featherLo)
    case .bar:
      guard let p = find(list.bars, \.id) else { return nil }
      (x0, x1, y0, y1, flags, reveal) = (X(p.d0), X(p.d1), Double(p.y0), Double(p.y1), p.flags, p.revealDay)
    case .tick:
      guard let p = find(list.ticks, \.id) else { return nil }
      let cx = X(p.d)
      (x0, x1, y0, y1, flags, reveal) = (cx - Double(p.width) / 2, cx + Double(p.width) / 2, Double(p.y0), Double(p.y1), p.flags, p.revealDay)
    case .diamond:
      guard let p = find(list.diamonds, \.id) else { return nil }
      let cx = X(p.d), r = Double(p.size)
      (x0, x1, y0, y1, flags, reveal) = (cx - r, cx + r, Double(p.y) - r, Double(p.y) + r, p.flags, p.revealDay)
    case .glyph:
      guard let p = find(list.glyphs, \.id) else { return nil }
      let cx = X(p.d)
      (x0, x1, y0, y1, flags, reveal) = (cx, cx, Double(p.y), Double(p.y), p.flags, p.revealDay)
      size = Double(p.size)
      text = list.labelRuns[p.glyph]?.text
    case .label:
      guard let p = find(list.labels, \.id) else { return nil }
      let cx = X(p.d)
      (x0, x1, y0, y1, flags, reveal) = (cx, cx, Double(p.y), Double(p.y), p.flags, p.revealDay)
      text = list.labelRuns[p.key]?.text
    }
    let f = PrimFlags(rawValue: flags)
    var r = ReferencePrim(id: referenceID(part, id), kind: m.kind, layer: m.layer, style: m.style.name, x0: x0, y0: y0, x1: x1, y1: y1,
                          openable: m.openable, ghost: f.contains(.ghost), text: text, size: size, feather: feather, pattern: nil,
                          round: nil, glyph: nil, sub: nil, w: nil, seamX: nil, synthetic: nil, points: nil, ref: referenceRef(part, id),
                          tip: tip(part, id), revealDay: reveal == alwaysRevealed ? nil : reveal)
    switch m.style {
    case .bar, .barSparse, .barBackdrop:
      r.pattern = m.style == .barBackdrop ? nil : barPattern(flags: flags).name
      r.round = (f.contains(.roundLeading) ? "l" : "") + (f.contains(.roundTrailing) ? "r" : "")
      if case .bar(let l, let s, _) = m.source { r.sub = model.lanes[l].strands[s].sub }
    case .absent:
      let mid = (y0 + y1) / 2
      r.points = [[x0 + 1, mid], [x1 - 1, mid]]
    case .bracketStated, .bracketEst, .bracketDerived, .bracketPeriod:
      let mid = (y0 + y1) / 2, top = y0
      r.points = [[x0 + 0.5, top], [x0 + 0.5, mid], [x1 - 0.5, mid], [x1 - 0.5, top]]
      r.glyph = m.style == .bracketEst ? "≈" : m.style == .bracketDerived ? "⇄" : nil
    case .seam:
      let cx = (x0 + x1) / 2
      r.points = [[cx, 0], [cx, y1]]
    case .rulerLabel:
      r.w = DisplayBuilder.rulerLabelWidth(text ?? "")
    case .seamLabel:
      let w = DisplayBuilder.seamLabelWidth(text ?? "")
      r.seamX = x0
      r.w = w
      r.x0 = x0 - 4 - w
      r.x1 = x0 + 4 + w
    case .covSpan:
      r.synthetic = f.contains(.synthetic)
    default: break
    }
    return r
  }

  /// Every primitive of a list (or of its `visible(at:)` view) as the reference writes it, in emission order.
  public func referencePrims(_ part: Part, in list: DisplayList) -> [ReferencePrim] {
    list.allPrims.map(\.id).sorted { $0.rawValue < $1.rawValue }.compactMap { referencePrim(part, $0, in: list) }
  }
}
