// OWNER: N7
// Port of src/ui/timeline/folded.mjs (SPEC §1.5, D3): the folded overview's geometry — four FIXED linear regimes, each
// with a fixed share of the width, joined by labelled zig-zag seams whose ratio (×3.3, ×8.9, ×3.3) is computed from the
// neighbouring scales. The minimap is drawn in this geometry (IOS-SPEC §4.3); a tooltip never reports a distance across a
// seam. There is no log scale anywhere. The minimap's helpers of minimap.mjs (rows, regime names, the bracket) are here
// too, so the app's minimap is a drawing of these numbers.

import ScrollsCore

/// One regime of the folded overview.
public struct FoldedRegime: Sendable, Equatable {
  public var key: String
  public var label: String
  /// Astronomical years (7000 BCE = −6999, 500 BCE = −499).
  public var from: Double
  public var to: Double
  /// Share of the width.
  public var share: Double
  /// The bin drawn in the regime ('millennium', 'century', 'decade').
  public var bin: String
  public var x0: Double = 0
  public var x1: Double = 0
  /// Years per point inside the regime.
  public var yearsPerPoint: Double = 0
}

/// A zig-zag seam between two regimes, labelled with the ratio of their scales.
public struct FoldedSeam: Sendable, Equatable {
  public var x: Double
  public var ratio: Double
  /// "×3.3".
  public var label: String
}

/// The folded geometry for a width (`createFolded`).
public struct FoldedScale: Sendable, Equatable {
  /// The regimes of §1.5 (`REGIMES`).
  public static let regimeTable: [FoldedRegime] = [
    FoldedRegime(key: "deep", label: "Deep time", from: -6999, to: -499, share: 0.15, bin: "millennium"),
    FoldedRegime(key: "classical", label: "Classical–medieval", from: -499, to: 1500, share: 0.15, bin: "century"),
    FoldedRegime(key: "early-modern", label: "Early modern", from: 1500, to: 1800, share: 0.20, bin: "decade"),
    FoldedRegime(key: "modern", label: "Modern", from: 1800, to: 2030, share: 0.50, bin: "decade"),
  ]
  /// Width of a zig-zag seam in points (`SEAM_PX`).
  public static let seamWidth = 10.0
  /// Shorter regime names for narrow minimaps, longest first (`REGIME_SHORT`).
  public static let shortNames: [String: [String]] = [
    "deep": ["Deep time", "Deep"], "classical": ["Classical–medieval", "Classical", "Class."],
    "early-modern": ["Early modern", "Early mod.", "E. mod."], "modern": ["Modern"],
  ]

  public let width: Double
  public let regimes: [FoldedRegime]
  public let seams: [FoldedSeam]

  public init(width: Double) {
    self.width = width
    var x = 0.0
    var rs: [FoldedRegime] = []
    for var r in Self.regimeTable {
      let w = r.share * width
      r.x0 = x
      r.x1 = x + w
      r.yearsPerPoint = (r.to - r.from) / w
      x += w
      rs.append(r)
    }
    regimes = rs
    var ss: [FoldedSeam] = []
    for i in 1..<rs.count {
      let prev = rs[i - 1], r = rs[i]
      let ratio = max(prev.yearsPerPoint, r.yearsPerPoint) / min(prev.yearsPerPoint, r.yearsPerPoint)
      ss.append(FoldedSeam(x: r.x0, ratio: ratio, label: "×\(Format.number(ratio, sig: 2))"))
    }
    seams = ss
  }

  /// `xOfYear(year)`.
  public func x(year: Double) -> Double {
    guard let first = regimes.first, let last = regimes.last else { return 0 }
    if year <= first.from { return first.x0 }
    if year >= last.to { return last.x1 }
    let r = regimes.first { year < $0.to } ?? last
    return r.x0 + (year - r.from) / r.yearsPerPoint
  }

  /// `yearOfX(x)`.
  public func year(x px: Double) -> Double {
    guard let first = regimes.first, let last = regimes.last else { return 0 }
    if px <= 0 { return first.from }
    if px >= width { return last.to }
    let r = regimes.first { px < $0.x1 } ?? last
    return r.from + (px - r.x0) * r.yearsPerPoint
  }

  /// `xOfDay(day)`.
  public func x(day: Double) -> Double { x(year: Self.yearOfDay(day)) }

  /// `dayOfX(x)`.
  public func day(x px: Double) -> Double { Self.dayOfYear(year(x: px)) }

  /// `regimeAt(x)`.
  public func regime(at px: Double) -> FoldedRegime { regimes.first { px < $0.x1 } ?? regimes[regimes.count - 1] }

  /// `yearOfDay(day)`: the fractional astronomical year of a day number.
  public static func yearOfDay(_ day: Double) -> Double {
    let y = DayMath.ymdFromDay(Int(day.rounded(.down))).y
    let start = Double(DayMath.dayFromYMD(y, 1, 1))
    return Double(y) + (day - start) / (Double(DayMath.dayFromYMD(y + 1, 1, 1)) - start)
  }

  /// `dayOfYear(year)`: the day number of a fractional astronomical year.
  public static func dayOfYear(_ year: Double) -> Double {
    let y = Int(year.rounded(.down))
    let start = Double(DayMath.dayFromYMD(y, 1, 1))
    let len = Double(DayMath.dayFromYMD(y + 1, 1, 1)) - start
    return start + (year - Double(y)) * len
  }

  /// `seamZigzag(x, y0, y1, amp)`: the points of a seam centred on x.
  public static func zigzag(x: Double, y0: Double, y1: Double, amplitude: Double = seamWidth / 2) -> [(x: Double, y: Double)] {
    var pts: [(Double, Double)] = []
    var left = true
    var y = y0
    while y <= y1 {
      pts.append((x + (left ? -amplitude / 2 : amplitude / 2), y))
      left.toggle()
      y += 4
    }
    return pts
  }

  /// `regimeName(key, room, measure)`: the longest name of a regime that fits `room` points.
  public static func regimeName(_ key: String, room: Double, measure: (String) -> Double) -> String {
    (shortNames[key] ?? []).first { measure($0) <= room } ?? ""
  }

  /// `regimeTitle(r)`: a regime described without any distance across a seam.
  public static func regimeTitle(_ r: FoldedRegime) -> String {
    let unit = r.yearsPerPoint >= 1 ? "1 pt ≈ \(Format.number(r.yearsPerPoint, sig: 2)) years"
      : "1 pt ≈ \(Format.number(r.yearsPerPoint * 12, sig: 2)) months"
    let span = switch r.key {
    case "deep": "7000 BCE – 500 BCE"
    case "classical": "500 BCE – 1500"
    case "early-modern": "1500 – 1800"
    default: "1800 – 2030"
    }
    return "\(r.label): \(span) · \(unit) · \(r.bin) bins"
  }
}

/// The minimap's pure helpers (`minimap.mjs`).
public enum MinimapGeometry {
  /// `minimapRows(lanes, height)`: one 3 pt row per lane, folded into the last row when they do not fit.
  public static func rows(lanes: Int, height: Double, top: Double = 9) -> (rows: Int, rowHeight: Double, top: Double) {
    let usable = max(3, height - top - 2)
    let rows = max(1, min(lanes, Int((usable / 3).rounded(.down))))
    return (rows, 3, top)
  }

  /// `bracketBox(x0, x1, width)`: the visible range's bracket, at least 4 pt wide and never outside the strip.
  public static func bracket(x0: Double, x1: Double, width: Double) -> (left: Double, width: Double) {
    let w = min(max(4, x1 - x0), max(4, width))
    return (max(0, min(x0, width - w)), w)
  }
}
