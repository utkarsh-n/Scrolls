// OWNER: N7
// Port of src/ui/timeline/hit.mjs (SPEC §8.4; IOS-SPEC §4.23): a uniform 24 pt spatial grid in content coordinates at
// the build zoom (x = days from the list's origin × points per day), built after layout or a tier change and never on
// pan. Priority on overlap: mark > arc > cap > bin > wash > band > other. Bands, bins and washes are areas (a direct
// hit, 0.5 pt); marks, caps and arcs get the touch tolerance. Queries honour the vantage with the same predicate as the
// shader and VoiceOver: `.hide` primitives are never hit, `.ghost` ones are (the reference's ghosted primitives stay
// hit-testable). Among exact ties (same class, same distance) results keep emission order.

import CoreGraphics
import ScrollsContracts
import ScrollsCore

extension HitGrid {
  /// Very wide entries (more than this many columns) go into per-row lists (`cx1 - cx0 > 400`).
  static let wideColumns: Int32 = 400

  /// `hitClass(p)` from a primitive's metadata.
  static func hitClass(_ m: PrimMeta) -> HitClass {
    switch m.source {
    case .mark, .coarse: return .mark
    default: break
    }
    if m.style.name.hasPrefix("cap-") { return .cap }
    switch m.source {
    case .bar, .absent, .lowTick: return .bin
    case .wash: return .wash
    default: break
    }
    switch m.source {
    case .coverageCell, .coverageUncovered, .laneUncovered, .lanePending, .seamTick, .seamLine: return .band
    default: break
    }
    return m.kind == .band ? .band : .other
  }

  /// `buildHitGrid(prims)`: every primitive with a `ref` or a tooltip, except texts, is indexed by its box.
  static func build(list: DisplayList, meta: [PrimMeta]) -> HitGrid {
    let ppd = list.hit.pointsPerDay
    var grid = HitGrid(pointsPerDay: ppd)
    let cell = HitGrid.cellSize
    for (i, m) in meta.enumerated() where m.kind != .text {
      let id = PrimID(rawValue: UInt32(i))
      let hasRef = list.refs[id] != nil
      guard hasRef || hasTip(m) else { continue }
      guard let box = contentBox(list: list, meta: m) else { continue }
      let cls = hitClass(m)
      let entry = HitEntry(id: id, hitClass: cls, bounds: box, polyline: nil, revealDay: reveal(list: list, meta: m),
                           openable: m.openable)
      let index = Int32(grid.entries.count)
      grid.entries.append(entry)
      let cx0 = Int32((Double(box.minX) / cell).rounded(.down)), cx1 = Int32((Double(box.maxX) / cell).rounded(.down))
      let cy0 = Int32((Double(box.minY) / cell).rounded(.down)), cy1 = Int32((Double(box.maxY) / cell).rounded(.down))
      if cx1 - cx0 > wideColumns {
        for cy in cy0...cy1 { grid.rows[cy, default: []].append(index) }
        continue
      }
      for cx in cx0...cx1 {
        for cy in cy0...cy1 { grid.cells[HitCell(column: cx, row: cy), default: []].append(index) }
      }
    }
    return grid
  }

  /// Does a primitive have a tooltip (`p.tip`)? (Texts and decoration have none.)
  static func hasTip(_ m: PrimMeta) -> Bool {
    switch m.source {
    case .rulerTick, .rulerLabel, .rulerMinor, .laneBand, .laneUnloaded, .laneCoverage, .superscript, .lowHatch, .lowN, .washLabel,
         .coarseLabel, .seamLabel:
      return false
    default:
      return true
    }
  }

  /// `bboxOf(p)` in content points of the list (x = relative days × points per day): glyphs get a 12 × 14 square around
  /// their anchor; every other box is at least 1 pt wide and tall.
  static func contentBox(list: DisplayList, meta m: PrimMeta) -> CGRect? {
    let ppd = list.hit.pointsPerDay
    var x0 = 0.0, x1 = 0.0, y0 = 0.0, y1 = 0.0
    switch m.slot {
    case .band(let i):
      let p = list.bands[i]
      (x0, x1, y0, y1) = (Double(p.d0) * ppd, Double(p.d1) * ppd, Double(p.y0), Double(p.y1))
    case .wash(let i):
      let p = list.washes[i]
      (x0, x1, y0, y1) = (Double(p.d0) * ppd, Double(p.d1) * ppd, Double(p.y0), Double(p.y1))
    case .bar(let i):
      let p = list.bars[i]
      (x0, x1, y0, y1) = (Double(p.d0) * ppd, Double(p.d1) * ppd, Double(p.y0), Double(p.y1))
    case .tick(let i):
      let p = list.ticks[i]
      let cx = Double(p.d) * ppd
      (x0, x1, y0, y1) = (cx - Double(p.width) / 2, cx + Double(p.width) / 2, Double(p.y0), Double(p.y1))
    case .diamond(let i):
      let p = list.diamonds[i]
      let cx = Double(p.d) * ppd, r = Double(p.size)
      (x0, x1, y0, y1) = (cx - r, cx + r, Double(p.y) - r, Double(p.y) + r)
    case .glyph(let i):
      let p = list.glyphs[i]
      let cx = Double(p.d) * ppd
      return CGRect(x: cx - 6, y: Double(p.y) - 7, width: 12, height: 14)
    case .label:
      return nil
    }
    let a = min(x0, x1), b = max(x0, x1), c = min(y0, y1), d = max(y0, y1)
    return CGRect(x: a, y: c, width: max(b, a + 1) - a, height: max(d, c + 1) - c)
  }

  static func reveal(list: DisplayList, meta m: PrimMeta) -> Int32 {
    switch m.slot {
    case .band(let i): list.bands[i].revealDay
    case .wash(let i): list.washes[i].revealDay
    case .bar(let i): list.bars[i].revealDay
    case .tick(let i): list.ticks[i].revealDay
    case .diamond(let i): list.diamonds[i].revealDay
    case .glyph(let i): list.glyphs[i].revealDay
    case .label(let i): list.labels[i].revealDay
    }
  }

  /// The hits under `p` within `tolerance` (areas need a direct hit), best first, with their distances.
  public func hits(_ p: CGPoint, tolerance: CGFloat, vantage: Vantage?) -> [(entry: HitEntry, distance: Double)] {
    let cell = HitGrid.cellSize
    let x = Double(p.x), y = Double(p.y), tol = Double(tolerance)
    var seen = Set<Int32>()
    var order: [Int32] = []
    let cxa = Int32(((x - tol) / cell).rounded(.down)), cxb = Int32(((x + tol) / cell).rounded(.down))
    let cya = Int32(((y - tol) / cell).rounded(.down)), cyb = Int32(((y + tol) / cell).rounded(.down))
    for cx in cxa...cxb {
      for cy in cya...cyb {
        for e in cells[HitCell(column: cx, row: cy)] ?? [] where seen.insert(e).inserted { order.append(e) }
      }
    }
    for cy in cya...cyb {
      for e in rows[cy] ?? [] where seen.insert(e).inserted { order.append(e) }
    }
    var out: [(HitEntry, Double, Int)] = []
    for (rank, e) in order.enumerated() {
      let entry = entries[Int(e)]
      if visibility(revealDay: entry.revealDay, at: vantage) == .hide { continue }
      let d = HitGrid.distance(entry, x, y)
      let allowed = entry.hitClass == .band || entry.hitClass == .bin || entry.hitClass == .wash ? 0.5 : tol
      if d <= allowed { out.append((entry, d, rank)) }
    }
    out.sort { a, b in
      if a.0.hitClass != b.0.hitClass { return a.0.hitClass > b.0.hitClass }
      if a.1 != b.1 { return a.1 < b.1 }
      return a.2 < b.2
    }
    return out.map { ($0.0, $0.1) }
  }

  /// The primitive ids under `p`, best first, at vantage `v`.
  public func hitIDs(_ p: CGPoint, tolerance: CGFloat, vantage: Vantage?) -> [PrimID] {
    hits(p, tolerance: tolerance, vantage: vantage).map(\.entry.id)
  }

  /// The primitives under `p` within `tolerance` points (areas need a direct hit), best first, at vantage `v`.
  /// The frozen `HitEntry` carries no ref, so the grid alone cannot say what a hit answers: every hit is `.none` here
  /// (one per hit, in order) until N0 adds `HitEntry.ref` (requested in status/N7.md). Callers use
  /// `DisplayList.hit(_:tolerance:vantage:)`, which resolves ids through the list's `refs`.
  public func hit(_ p: CGPoint, tolerance: CGFloat, vantage: Vantage?) -> [PrimRef] {
    hitIDs(p, tolerance: tolerance, vantage: vantage).map { _ in PrimRef.none }
  }

  /// `distance(e, x, y)`: to the box (or along an arc's polyline).
  static func distance(_ e: HitEntry, _ x: Double, _ y: Double) -> Double {
    if let poly = e.polyline, poly.count > 1 {
      var best = Double.infinity
      for i in 1..<poly.count { best = min(best, segDistance(x, y, poly[i - 1], poly[i])) }
      return best
    }
    let b = e.bounds
    let x0 = Double(b.minX), x1 = Double(b.maxX), y0 = Double(b.minY), y1 = Double(b.maxY)
    let dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
    let dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
    return (dx * dx + dy * dy).squareRoot()
  }

  /// Distance from (x, y) to the segment a–b.
  static func segDistance(_ x: Double, _ y: Double, _ a: CGPoint, _ b: CGPoint) -> Double {
    let ax = Double(a.x), ay = Double(a.y), dx = Double(b.x) - ax, dy = Double(b.y) - ay
    let len2 = dx * dx + dy * dy
    let t = len2 > 0 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
    let px = x - (ax + t * dx), py = y - (ay + t * dy)
    return (px * px + py * py).squareRoot()
  }

  /// The grid without some entries (the `visible(at:)` view drops hidden primitives).
  func removing(_ ids: Set<PrimID>) -> HitGrid {
    var keep: [Int32] = Array(repeating: -1, count: entries.count)
    var out = HitGrid(pointsPerDay: pointsPerDay)
    for (i, e) in entries.enumerated() where !ids.contains(e.id) {
      keep[i] = Int32(out.entries.count)
      out.entries.append(e)
    }
    for (c, list) in cells {
      let l = list.compactMap { keep[Int($0)] >= 0 ? keep[Int($0)] : nil }
      if !l.isEmpty { out.cells[c] = l }
    }
    for (r, list) in rows {
      let l = list.compactMap { keep[Int($0)] >= 0 ? keep[Int($0)] : nil }
      if !l.isEmpty { out.rows[r] = l }
    }
    return out
  }
}

extension DisplayList {
  /// What a tap at `p` (content coordinates of this list) answers, best first, at vantage `v` (§4.5: priority mark > arc >
  /// cap > bin > wash > band; tolerance 12 pt for marks, caps and arcs).
  public func hit(_ p: CGPoint, tolerance: CGFloat = CGFloat(HitGrid.touchTolerance), vantage: Vantage?) -> [(id: PrimID, ref: PrimRef)] {
    hit.hitIDs(p, tolerance: tolerance, vantage: vantage).map { ($0, refs[$0] ?? .none) }
  }

  /// Content coordinates of a day at this list's build zoom.
  public func contentX(day: Double) -> Double { (day - Double(originDay)) * hit.pointsPerDay }
}
