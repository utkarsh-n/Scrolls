// OWNER: N7
// The vertical layout of the lanes: an exact port of display.mjs `layoutLanes` and its GEOM constants (SPEC §1.4; used by
// G5, whose cases carry the reference's layout), plus the phone's own layout (IOS-SPEC §4.3: an 18 pt header strip,
// n × 24 pt strand slots and 10 pt of arc room per lane; a one-strand lane is 52 pt). Every lane with the same number of
// rows has the same height (§1.3: no vertical scale of meaning). The display builder takes either layout.

import ScrollsCore

/// Geometry of SPEC §1.4 (`display.GEOM`), in points.
public enum Geom {
  public static let rulerH = 32.0
  public static let coverageH = 24.0
  public static let laneMinH = 40.0
  public static let slotH = 24.0
  public static let slotCompact = 16.0
  public static let slotComfortable = 36.0
  public static let pad = 8.0
  public static let moreRowH = 28.0
  public static let underlayH = 3.0
  public static let markH = 8.0
  public static let diamond = 5.0
  public static let bracketH = 6.0
  public static let coarseH = 4.0
  public static let maxStrandsVisible = 48
  /// `SLOT_RANGE`: strand slot range when lanes fill the Scroll.
  public static let slotRange = (min: 24.0, max: 56.0)
  /// `FILL_MAX`: a filled lane grows to at most this multiple of its slots + padding.
  public static let fillMax = 2.5
  /// `LABEL_ROOM`: free room before chips and inline labels are drawn at rest.
  public static let labelRoom = 120.0
  /// `REGIME_LABEL_Y`.
  public static let regimeLabelY = 9.0
}

/// One strand slot of a lane.
public struct LaneSlot: Sendable, Equatable {
  public var y: Double
  public var h: Double
  public var mid: Double

  public init(y: Double, h: Double, mid: Double) {
    self.y = y
    self.h = h
    self.mid = mid
  }
}

/// One lane's box in lane-stack points.
public struct LaneBox: Sendable, Equatable {
  public var key: String
  public var index: Int
  public var y: Double
  public var h: Double
  public var slots: [LaneSlot]
  /// The phone layout's header strip height at the top of the lane (0 in the reference layout).
  public var header: Double

  public init(key: String, index: Int, y: Double, h: Double, slots: [LaneSlot], header: Double = 0) {
    self.key = key
    self.index = index
    self.y = y
    self.h = h
    self.slots = slots
    self.header = header
  }
}

/// `layoutLanes`'s output.
public struct LaneLayout: Sendable, Equatable {
  public var lanes: [LaneBox]
  public var height: Double
  public var more: (y: Double, h: Double)?
  public var slotH: Double
  public var extra: [String: (y: Double, h: Double)]

  public init(lanes: [LaneBox], height: Double, more: (y: Double, h: Double)?, slotH: Double, extra: [String: (y: Double, h: Double)] = [:]) {
    self.lanes = lanes
    self.height = height
    self.more = more
    self.slotH = slotH
    self.extra = extra
  }

  public static func == (a: LaneLayout, b: LaneLayout) -> Bool {
    a.lanes == b.lanes && a.height == b.height && a.more?.y == b.more?.y && a.more?.h == b.more?.h && a.slotH == b.slotH
      && a.extra.keys.sorted() == b.extra.keys.sorted() && a.extra.allSatisfy { k, v in b.extra[k]?.y == v.y && b.extra[k]?.h == v.h }
  }

  /// The box of a lane key.
  public func lane(_ key: String) -> LaneBox? { lanes.first { $0.key == key } }

  /// An empty layout.
  public static let empty = LaneLayout(lanes: [], height: 0, more: nil, slotH: Geom.slotH)
}

/// Lane layouts.
public enum LaneLayouts {
  /// `layoutLanes(lanes, strandCount, opts)` verbatim: a one-strand lane is 40 pt; each strand row gets a 24 pt slot; with
  /// `fillHeight` the lanes share that height (the slot grows up to `slotMax`, the rest is equal padding).
  public static func reference(keys: [String], strandCount: Int, slotH: Double = Geom.slotH, moreRow: Bool = false,
                               fillHeight: Double? = nil, slotMax: Double = Geom.slotRange.max,
                               top: [(key: String, h: Double)] = [], bottom: [(key: String, h: Double)] = []) -> LaneLayout {
    let k = Double(max(1, strandCount))
    var slot = slotH
    var h = max(Geom.laneMinH, k * slotH + 2 * Geom.pad)
    if let fillH = fillHeight, fillH.isFinite, fillH > 0, !keys.isEmpty {
      let extraH = (top + bottom).reduce(0) { $0 + $1.h } + (moreRow ? Geom.moreRowH : 0)
      let perLane = ((fillH - extraH) / Double(keys.count)).rounded(.down)
      slot = max(slotH, min(slotMax, ((perLane - 2 * Geom.pad) / k).rounded(.down)))
      h = max(Geom.laneMinH, k * slot + 2 * Geom.pad, min(perLane, jsRound((k * slot + 2 * Geom.pad) * Geom.fillMax)))
    }
    let pad = (h - k * slot) / 2
    var y = 0.0
    var extra: [String: (y: Double, h: Double)] = [:]
    for r in top {
      extra[r.key] = (y, r.h)
      y += r.h
    }
    var out: [LaneBox] = []
    for (index, key) in keys.enumerated() {
      var slots: [LaneSlot] = []
      for i in 0..<Int(k) {
        let sy = y + pad + Double(i) * slot
        slots.append(LaneSlot(y: sy, h: slot, mid: sy + slot / 2))
      }
      out.append(LaneBox(key: key, index: index, y: y, h: h, slots: slots))
      y += h
    }
    let more: (y: Double, h: Double)? = moreRow ? (y, Geom.moreRowH) : nil
    if let more { y += more.h }
    for r in bottom {
      extra[r.key] = (y, r.h)
      y += r.h
    }
    return LaneLayout(lanes: out, height: y, more: more, slotH: slot, extra: extra)
  }

  /// The phone's lane geometry (IOS-SPEC §4.3): an 18 pt header strip on top of each lane (the sticky label and shelf
  /// chips sit there, never over bars), n strand slots of `slot` points, then 10 pt of arc room. When the lanes would
  /// leave the viewport half empty they share `fillHeight`, growing the slot up to 40 pt and keeping the rest as equal
  /// padding, so every lane with the same number of rows keeps the same height.
  public static func phone(keys: [String], strandCount: Int, slot: Double = 24, header: Double = 18, arcRoom: Double = 10,
                           moreRow: Bool = false, fillHeight: Double? = nil, maxSlot: Double = 40) -> LaneLayout {
    let k = Double(max(1, strandCount))
    var s = slot
    var h = header + k * slot + arcRoom
    if let fillH = fillHeight, fillH > 0, !keys.isEmpty {
      let perLane = ((fillH - (moreRow ? Geom.moreRowH : 0)) / Double(keys.count)).rounded(.down)
      s = max(slot, min(maxSlot, ((perLane - header - arcRoom) / k).rounded(.down)))
      h = max(header + k * s + arcRoom, min(perLane, (header + k * s + arcRoom) * 1.6).rounded(.down))
    }
    let pad = (h - header - k * s) / 2
    var y = 0.0
    var out: [LaneBox] = []
    for (index, key) in keys.enumerated() {
      var slots: [LaneSlot] = []
      for i in 0..<Int(k) {
        let sy = y + header + max(0, pad - arcRoom / 2) + Double(i) * s
        slots.append(LaneSlot(y: sy, h: s, mid: sy + s / 2))
      }
      out.append(LaneBox(key: key, index: index, y: y, h: h, slots: slots, header: header))
      y += h
    }
    let more: (y: Double, h: Double)? = moreRow ? (y, Geom.moreRowH) : nil
    if let more { y += more.h }
    return LaneLayout(lanes: out, height: y, more: more, slotH: s)
  }

  /// `Math.round` (ties towards +∞), bit-equal with V8.
  @inline(__always)
  static func jsRound(_ x: Double) -> Double { JSNumber.round(x) }
}
