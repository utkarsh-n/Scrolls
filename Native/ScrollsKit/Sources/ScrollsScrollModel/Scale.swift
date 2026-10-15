// OWNER: N7
// Port of src/ui/timeline/scale.mjs (D3: linear time everywhere) and the pure axis math of viewport.mjs (clampAxis,
// zoomAxis, panAxis, fitAxis): ruler ticks with historical labels ("1850", "500 BCE", "Apr 1931", "17 May 1994"), the
// footer caption ("Bins: decades · 1 cm ≈ 12.5 years") and the pan/zoom domain (10000 BCE – 2100 CE; 0.05 pt/yr –
// 40 pt/day). Geometry is in points (ΔS-8); the reference's px are points here. Everything runs in the reference's own
// unit, days per point, so tick positions and their inclusion tests are the reference's arithmetic, operation for
// operation (G5 compares them exactly).

import ScrollsCore

/// `createScale({centerDay, daysPerPx, width})`: the reference's scale, in days per point.
public struct AxisScale: Sendable, Equatable {
  public var centerDay: Double
  public var daysPerPoint: Double
  public var width: Double

  public init(centerDay: Double, daysPerPoint: Double, width: Double) {
    self.centerDay = centerDay
    self.daysPerPoint = daysPerPoint
    self.width = width
  }

  /// The day at x = 0.
  public var loDay: Double { centerDay - (width / 2) * daysPerPoint }
  /// The day at x = width.
  public var hiDay: Double { loDay + width * daysPerPoint }
  /// Points per year.
  public var pointsPerYear: Double { TimeScale.daysPerYear / daysPerPoint }
  /// `x(day)`.
  public func x(_ day: Double) -> Double { (day - loDay) / daysPerPoint }
  /// `day(x)`.
  public func day(_ x: Double) -> Double { loDay + x * daysPerPoint }
  /// The automatic tier (`tierForDaysPerPx`).
  public var tier: Tier { Tier(pointsPerYear: pointsPerYear) }
  /// The same window as the frozen `TimeScale`.
  public var timeScale: TimeScale { TimeScale(centerDay: centerDay, daysPerPoint: daysPerPoint, width: width) }
}

/// A labelled (major) ruler tick.
public struct RulerTick: Sendable, Equatable {
  public enum Unit: String, Sendable { case year, month, day }
  public var day: Int
  public var x: Double
  public var label: String
  public var unit: Unit
}

/// Ruler ticks, labels and captions (`scale.mjs`).
public enum RulerScale {
  /// One CSS centimetre in CSS pixels (96 px per inch); the reference's caption unit.
  public static let cssCentimetre = 96 / 2.54
  /// Minimum spacing of labelled ticks in points (`MIN_LABEL_PX`).
  public static let minLabelSpacing = 84.0

  struct Step {
    var unit: RulerTick.Unit
    var n: Int
    var days: Double
  }

  /// Candidate major-tick steps, coarse to fine (`STEPS`).
  static let steps: [Step] =
    [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map { Step(unit: .year, n: $0, days: Double($0) * TimeScale.daysPerYear) }
    + [6, 3, 1].map { Step(unit: .month, n: $0, days: Double($0) * 30.44) }
    + [10, 5, 2, 1].map { Step(unit: .day, n: $0, days: Double($0)) }

  /// `majorStep(daysPerPx, minPx)`: the finest step whose labels stay at least `minSpacing` apart.
  static func majorStep(_ daysPerPoint: Double, minSpacing: Double = minLabelSpacing) -> Step {
    var pick = steps[0]
    for s in steps {
      if s.days / daysPerPoint >= minSpacing { pick = s } else { break }
    }
    return pick
  }

  /// `yearTicks(loYear, hiYear, n)`: BCE ticks on round historical years (500 BCE = astronomical −499), CE ticks on round
  /// astronomical years.
  static func yearTicks(_ loYear: Int, _ hiYear: Int, _ n: Int) -> [Int] {
    var out: [Int] = []
    let hLo = max(n, ceilDiv(1 - hiYear, n) * n)
    let hHi = DayMath.floorDiv(1 - loYear, n) * n
    var h = hHi
    while h >= hLo {
      out.append(1 - h)
      h -= n
    }
    var y = max(n, ceilDiv(loYear, n) * n)
    while y <= hiYear {
      out.append(y)
      y += n
    }
    return out
  }

  /// `ticks(scale, {minPx})`: major ticks with labels for the visible days, sorted by day.
  public static func ticks(_ scale: AxisScale, minSpacing: Double = minLabelSpacing) -> [RulerTick] {
    let step = majorStep(scale.daysPerPoint, minSpacing: minSpacing)
    let lo = DayMath.ymdFromDay(Int(scale.loDay.rounded(.down)))
    let hi = DayMath.ymdFromDay(Int(scale.hiDay.rounded(.up)))
    var out: [RulerTick] = []
    func push(_ day: Int, _ label: String) {
      let x = scale.x(Double(day))
      if x >= -1 && x <= scale.width + 1 { out.append(RulerTick(day: day, x: x, label: label, unit: step.unit)) }
    }
    switch step.unit {
    case .year:
      for y in yearTicks(lo.y - step.n, hi.y + step.n, step.n) { push(DayMath.dayFromYMD(y, 1, 1), DateLabels.yearLabel(y)) }
    case .month:
      if lo.y <= hi.y {
        for y in lo.y...hi.y {
          for m in stride(from: 1, through: 12, by: step.n) {
            push(DayMath.dayFromYMD(y, m, 1), "\(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))")
          }
        }
      }
    case .day:
      if lo.y <= hi.y {
        for y in lo.y...hi.y {
          let m0 = y == lo.y ? lo.m : 1, m1 = y == hi.y ? hi.m : 12
          guard m0 <= m1 else { continue }
          for m in m0...m1 {
            let first = DayMath.dayFromYMD(y, m, 1)
            let len = DayMath.dayFromYMD(y, m + 1, 1) - first
            var d = 0
            while d < len {
              if step.n > 1 && Double(len - d) < Double(step.n) / 2 && d > 0 { break }
              let dd = DayMath.ymdFromDay(first + d).d
              push(first + d, "\(dd) \(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))")
              d += step.n
            }
          }
        }
      }
    }
    return stableSorted(out) { $0.day < $1.day }
  }

  /// `cmLabel(daysPerPx)`: the length of one centimetre in words: '12.5 years', '3.2 months', '4 days', '6 hours'.
  /// `pointsPerCentimetre` defaults to the reference's CSS centimetre; the phone passes its physical one.
  public static func cmLabel(_ daysPerPoint: Double, pointsPerCentimetre: Double = cssCentimetre) -> String {
    let days = pointsPerCentimetre * daysPerPoint
    let years = days / TimeScale.daysPerYear
    if years >= 1.5 { return "\(Format.number(years)) years" }
    if years >= 0.95 { return "1 year" }
    if days >= 45 { return "\(Format.number(days / 30.44)) months" }
    if days >= 1.5 { return "\(Format.number(days)) days" }
    if days >= 0.95 { return "1 day" }
    return "\(Format.number(days * 24)) hours"
  }

  /// `binCaption(tier, daysPerPx)`: "Bins: decades · 1 cm ≈ 12.5 years".
  public static func binCaption(_ tier: Tier, daysPerPoint: Double, pointsPerCentimetre: Double = cssCentimetre) -> String {
    "Bins: \(tier.binPlural) · 1 cm ≈ \(cmLabel(daysPerPoint, pointsPerCentimetre: pointsPerCentimetre))"
  }

  /// `dayLabel(day, precision)`: a short label at a tier's precision ("1997", "Apr 1931", "17 May 1994").
  public static func dayLabel(_ day: Double, precision: String = "year") -> String {
    let (y, m, d) = DayMath.ymdFromDay(Int(day.rounded(.down)))
    if precision == "day" { return "\(d) \(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))" }
    if precision == "month" { return "\(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))" }
    return DateLabels.yearLabel(y)
  }

  /// ⌈a / b⌉ for b > 0 (JavaScript `Math.ceil(a / b)` on integers).
  static func ceilDiv(_ a: Int, _ b: Int) -> Int { -DayMath.floorDiv(-a, b) }
}

/// The pan and zoom domain of the Scroll and its pure axis math (viewport.mjs), in days per point.
public struct ScrollAxis: Sendable, Equatable, Hashable {
  public var centerDay: Double
  public var daysPerPoint: Double

  public init(centerDay: Double, daysPerPoint: Double) {
    self.centerDay = centerDay
    self.daysPerPoint = daysPerPoint
  }

  /// `AXIS_LIMITS.minDaysPerPx`: 40 pt per day.
  public static let minDaysPerPoint = ViewState.minDaysPerPx
  /// `AXIS_LIMITS.maxDaysPerPx`: 0.05 pt per year.
  public static let maxDaysPerPoint = ViewState.maxDaysPerPx
  public static let minDay = Double(ViewState.minDay)
  public static let maxDay = Double(ViewState.maxDay)

  /// `clampAxis(axis, width)`: with a known width the whole visible range stays inside [10000 BCE, 2100 CE].
  public func clamped(width: Double = 0) -> ScrollAxis {
    var dpp = min(Self.maxDaysPerPoint, max(Self.minDaysPerPoint, daysPerPoint))
    guard width > 0 else {
      return ScrollAxis(centerDay: min(Self.maxDay, max(Self.minDay, centerDay)), daysPerPoint: dpp)
    }
    let domain = Self.maxDay - Self.minDay
    dpp = min(dpp, domain / width)
    let half = (width / 2) * dpp
    return ScrollAxis(centerDay: min(Self.maxDay - half, max(Self.minDay + half, centerDay)), daysPerPoint: dpp)
  }

  /// `zoomAxis(axis, width, x, factor)`: zoom by `factor` (> 1 zooms in) keeping the day under `x` fixed.
  public func zoomed(width: Double, at x: Double, factor: Double) -> ScrollAxis {
    let dpp = min(Self.maxDaysPerPoint, max(Self.minDaysPerPoint, daysPerPoint / factor))
    let anchor = centerDay + (x - width / 2) * daysPerPoint
    return ScrollAxis(centerDay: anchor - (x - width / 2) * dpp, daysPerPoint: dpp).clamped(width: width)
  }

  /// `panAxis(axis, dxPx)`: content follows the finger (dragging right shows earlier time).
  public func panned(by dx: Double) -> ScrollAxis {
    ScrollAxis(centerDay: centerDay - dx * daysPerPoint, daysPerPoint: daysPerPoint).clamped()
  }

  /// `fitAxis(loDay, hiDay, width, pad)`: the axis that shows [loDay, hiDay] with a margin.
  public static func fit(loDay: Double, hiDay: Double, width: Double, pad: Double = 0.06) -> ScrollAxis {
    let span = max(1, hiDay - loDay + 1)
    return ScrollAxis(centerDay: (loDay + hiDay + 1) / 2, daysPerPoint: span / max(1, width * (1 - 2 * pad))).clamped(width: width)
  }

  /// The reference scale of this axis over a strip `width` points wide.
  public func scale(width: Double) -> AxisScale { AxisScale(centerDay: centerDay, daysPerPoint: daysPerPoint, width: width) }

  /// The automatic tier of this zoom.
  public var tier: Tier { Tier(pointsPerYear: TimeScale.daysPerYear / daysPerPoint) }
}

/// A stable sort (JavaScript's `Array.prototype.sort` is stable; Swift's `sort` does not promise it).
@inlinable
public func stableSorted<T>(_ a: [T], by less: (T, T) -> Bool) -> [T] {
  a.enumerated().sorted { x, y in
    if less(x.element, y.element) { return true }
    if less(y.element, x.element) { return false }
    return x.offset < y.offset
  }.map(\.element)
}
