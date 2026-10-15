// OWNER: N0
// The linear time scale of the Scroll (SPEC D3: linear time everywhere; IOS-SPEC §4.3–§4.5, §8.4.7) and the
// level-of-detail tiers L0–L5 (SPEC §1.6, src/ui/timeline/{scale,tiers}.mjs). Geometry is in points (ΔS-8): the
// reference's `daysPerPx` is `1 / pointsPerDay` here, and the view-state hash keeps carrying days per point.

import ScrollsCore

/// A level-of-detail tier: which calendar bin a zoom shows (`L0`…`L5`, SPEC §1.6).
public enum Tier: Int, Sendable, CaseIterable, Codable {
  case millennia, centuries, decades, years, months, days

  /// The reference's tier code, "L0"…"L5" (`vocab.TIERS`).
  public var code: String { "L\(rawValue)" }

  /// The tier for a reference tier code ("L0"…"L5"); nil for anything else.
  public init?(code: String) {
    guard code.count == 2, code.first == "L", let n = Int(code.dropFirst()), let t = Tier(rawValue: n) else { return nil }
    self = t
  }

  /// The tier the reference picks for a zoom in points per year (`dates.tierForPpy`).
  public init(pointsPerYear: Double) {
    self = Tier(code: Bins.tierForPpy(pointsPerYear)) ?? .millennia
  }

  /// The calendar bin level of this tier (`dates.LEVELS`).
  public var level: Level { Level(rawValue: rawValue) ?? .millennium }

  /// Points per year at which the tier starts (`tiers.TIER_PPY`); L0 starts at the zoom floor.
  public var startPointsPerYear: Double {
    switch self {
    case .millennia: 0.05
    case .centuries: 0.08
    case .decades: 0.8
    case .years: 8
    case .months: 96
    case .days: 2922
    }
  }

  /// Points per year at which the tier ends: the next tier's start, or 40 pt per day for L5.
  public var endPointsPerYear: Double {
    finer == self ? 40 * TimeScale.daysPerYear : finer.startPointsPerYear
  }

  /// A zoom in the middle of the tier (geometric mean of its bounds, `tiers.daysPerPxForTier`), for tier jumps.
  public var midPointsPerDay: Double {
    (startPointsPerYear * endPointsPerYear).squareRoot() / TimeScale.daysPerYear
  }

  /// One tier coarser (L0 stays L0).
  public var coarser: Tier { Tier(rawValue: max(0, rawValue - 1)) ?? self }

  /// One tier finer (L5 stays L5).
  public var finer: Tier { Tier(rawValue: min(Tier.days.rawValue, rawValue + 1)) ?? self }

  /// Plural bin name for the ruler caption, "Bins: decades" (`tiers.BIN_PLURAL`).
  public var binPlural: String {
    switch self {
    case .millennia: "millennia"
    case .centuries: "centuries"
    case .decades: "decades"
    case .years: "years"
    case .months: "months"
    case .days: "days"
    }
  }

  /// Adjective for the level-change pill, "Now showing yearly bins" (`tiers.BIN_ADJECTIVE`).
  public var binAdjective: String {
    switch self {
    case .millennia: "millennium"
    case .centuries: "century"
    case .decades: "decade"
    case .years: "yearly"
    case .months: "monthly"
    case .days: "daily"
    }
  }
}

/// A linear time scale over a strip `width` points wide, centred on `centerDay` (`scale.createScale`).
///
/// Days are counted from 1970-01-01, proleptic Gregorian, astronomical years (SPEC D5). Pinch changes only
/// `pointsPerDay` (x-only zoom, §4.5); the renderer applies the scale as a uniform, so no display list is rebuilt.
public struct TimeScale: Sendable, Equatable {
  /// Mean Gregorian year in days (`tiers.DAYS_PER_YEAR`).
  public static let daysPerYear = 365.2425
  /// The zoom floor, 0.05 pt per year; below it the folded overview takes over (§4.5).
  public static let minPointsPerDay = 0.05 / daysPerYear
  /// The zoom ceiling, 40 pt per day.
  public static let maxPointsPerDay = 40.0
  /// The pannable domain, 10000 BCE (astronomical −9999) to the end of 2100 CE (`viewstate.AXIS_LIMITS`).
  public static let domain: ClosedRange<Double> = Double(ViewState.minDay)...Double(ViewState.maxDay)

  /// The day under the centre of the strip (fractional while panning).
  public var centerDay: Double
  /// Zoom: points per day.
  public var pointsPerDay: Double
  /// Width of the strip in points.
  public var width: Double

  public init(centerDay: Double, pointsPerDay: Double, width: Double) {
    self.centerDay = centerDay
    self.pointsPerDay = pointsPerDay
    self.width = width
  }

  /// The scale of a view-state axis (`days per point`, as the hash stores it).
  public init(centerDay: Double, daysPerPoint: Double, width: Double) {
    self.init(centerDay: centerDay, pointsPerDay: 1 / daysPerPoint, width: width)
  }

  /// Days per point, the view-state hash's zoom unit.
  public var daysPerPoint: Double { 1 / pointsPerDay }

  /// The day at the leading edge (x = 0).
  public var loDay: Double { centerDay - (width / 2) / pointsPerDay }

  /// The day at the trailing edge (x = width).
  public var hiDay: Double { loDay + width / pointsPerDay }

  /// The x position of a day, in points from the leading edge.
  public func x(day: Double) -> Double { (day - loDay) * pointsPerDay }

  /// The day at an x position, in points from the leading edge.
  public func day(x: Double) -> Double { loDay + x / pointsPerDay }

  /// Zoom in points per year.
  public var pointsPerYear: Double { pointsPerDay * Self.daysPerYear }

  /// The automatic tier for this zoom (`tiers.tierForDaysPerPx`).
  public var tier: Tier { Tier(pointsPerYear: pointsPerYear) }

  /// The scale zoomed by `factor` around the point `anchorX`: the day under the anchor stays under it, and the
  /// zoom is clamped to [0.05 pt/yr, 40 pt/day] (§4.5 pinch).
  public func zoomed(by factor: Double, around anchorX: Double) -> TimeScale {
    guard factor.isFinite, factor > 0 else { return self }
    let anchorDay = day(x: anchorX)
    let ppd = min(Self.maxPointsPerDay, max(Self.minPointsPerDay, pointsPerDay * factor))
    let lo = anchorDay - anchorX / ppd
    return TimeScale(centerDay: lo + (width / 2) / ppd, pointsPerDay: ppd, width: width)
  }

  /// The scale panned by `dx` points (positive moves the content towards the trailing edge, i.e. earlier days
  /// come into view), with the centre clamped to the domain.
  public func panned(by dx: Double) -> TimeScale {
    var s = self
    s.centerDay = min(Self.domain.upperBound, max(Self.domain.lowerBound, centerDay - dx / pointsPerDay))
    return s
  }

  /// The same time window at a new width (rotation keeps `centerDay` and `pointsPerDay`, §4.4).
  public func resized(to newWidth: Double) -> TimeScale {
    TimeScale(centerDay: centerDay, pointsPerDay: pointsPerDay, width: newWidth)
  }
}
