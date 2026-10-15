// OWNER: N7
// Port of src/ui/timeline/tiers.mjs (SPEC §1.6): bin ↔ day arithmetic for every tier, tile numbering (64 bins per tile,
// §7.2), bin labels and the vantage's bin stepping. L0–L3 bin by astronomical year (bin = ⌊year / width⌋), L4 by month
// (bin = year·12 + month − 1), L5 by day (bin = day number). These are the only functions that turn bins into days, so a
// bin is never drawn at a finer precision than its own. Days are Doubles where the reference passes fractional days
// (it floors them); bins are Int64.

import ScrollsCore

extension Tier {
  /// Bins per tile (§7.2: tile = ⌊bin / 64⌋).
  public static let tileBins: Int64 = 64

  /// Year width of a year-based tier (`TIER_YEARS`); nil for months and days.
  public var yearWidth: Int? { level.yearWidth }

  /// The precision that fits one bin of this tier (`TIER_PRECISION`); an item of a coarser precision is a wash here.
  public var precisionWord: String {
    switch self {
    case .millennia: "millennium"
    case .centuries: "century"
    case .decades: "decade"
    case .years: "year"
    case .months: "month"
    case .days: "day"
    }
  }

  /// The tier word of the wash tooltip ("does not fit one decade") (`display.tierWord`); equals `precisionWord`.
  public var word: String { precisionWord }

  /// `effectiveTier(auto, forced)`: a forced tier may be coarser than the automatic one, never finer (§1.6).
  public static func effective(auto: Tier, forced: Tier?) -> Tier {
    guard let forced else { return auto }
    return forced.rawValue < auto.rawValue ? forced : auto
  }

  /// `binOfDay(tier, day)` for a fractional day (floored).
  public func bin(ofDay day: Double) -> Int64 {
    let d = Int(day.rounded(.down))
    switch self {
    case .days: return Int64(d)
    case .months: return Int64(Bins.monthBinOfDay(d))
    default: return Int64(DayMath.floorDiv(DayMath.ymdFromDay(d).y, yearWidth!))
    }
  }

  /// `binOfDay` for an integer day.
  public func bin(ofDay day: Int) -> Int64 { bin(ofDay: Double(day)) }

  /// `binStartDay(tier, bin)`: the first day of a bin.
  public func startDay(ofBin bin: Int64) -> Int {
    switch self {
    case .days: return Int(bin)
    case .months:
      let y = DayMath.floorDiv(Int(bin), 12)
      return DayMath.dayFromYMD(y, Int(bin) - y * 12 + 1, 1)
    default: return DayMath.dayFromYMD(Int(bin) * yearWidth!, 1, 1)
    }
  }

  /// `binEndDay(tier, bin)`: the last day of a bin (inclusive).
  public func endDay(ofBin bin: Int64) -> Int { startDay(ofBin: bin + 1) - 1 }

  /// `binLabel(tier, bin)`: '1000–1999', '1800–1899', '1910–1919', '1911', 'Apr 1931', '17 May 1994'.
  public func label(ofBin bin: Int64) -> String {
    switch self {
    case .days:
      let (y, m, d) = DayMath.ymdFromDay(Int(bin))
      return "\(d) \(DayMath.monthAbbr[m - 1]) \(DateLabels.yearLabel(y))"
    case .months:
      let y = DayMath.floorDiv(Int(bin), 12)
      return "\(DayMath.monthAbbr[Int(bin) - y * 12]) \(DateLabels.yearLabel(y))"
    default:
      let w = yearWidth!
      return Tiers.yearRangeLabel(Int(bin) * w, Int(bin) * w + w - 1)
    }
  }

  /// `fitsTier(tier, loDay, hiDay)`: does an interval fit inside one bin (fit-or-wash, D2)?
  public func fits(loDay: Double, hiDay: Double) -> Bool { bin(ofDay: loDay) == bin(ofDay: hiDay) }

  /// `binsForDays(tier, loDay, hiDay)`: the bins whose days intersect [loDay, hiDay].
  public func bins(loDay: Double, hiDay: Double) -> ClosedRange<Int64> { bin(ofDay: loDay)...max(bin(ofDay: loDay), bin(ofDay: hiDay)) }

  /// `tilesForDays(tier, loDay, hiDay, max)`: the tiles covering the days, at most `max` of them (the caller coarsens).
  public func tiles(loDay: Double, hiDay: Double, max: Int = 64) -> [Int64] {
    let a = Tiers.tileOf(bin(ofDay: loDay)).tile, b = Tiers.tileOf(bin(ofDay: hiDay)).tile
    var out: [Int64] = []
    var t = a
    while t <= b && out.count < max {
      out.append(t)
      t += 1
    }
    return out
  }

  /// `stepBinEnd(tier, day, steps)`: the vantage steps from bin end to bin end, so "as of" always means a whole bin
  /// (§1.9). From inside a bin one step back lands on the previous bin's end, one step forward on this bin's end.
  public func stepBinEnd(from day: Double, steps: Int) -> Int {
    let here = bin(ofDay: day)
    let atEnd = endDay(ofBin: here) == Int(day.rounded(.down))
    let target = steps > 0 ? here + Int64(steps) - (atEnd ? 0 : 1) : here + Int64(steps)
    return endDay(ofBin: target)
  }

  /// `snapToBinEnd(tier, day)`: scrubbing is discrete by bin.
  public func snapToBinEnd(_ day: Double) -> Int { endDay(ofBin: bin(ofDay: day)) }

  /// `daysPerPxForTier(tier)` as points per day: the geometric mean of the tier's zoom bounds (1–6 keys, double tap).
  public var jumpPointsPerDay: Double { midPointsPerDay }
}

/// Tier helpers without a receiver.
public enum Tiers {
  /// `tileOf(bin)`: the tile of a bin and the bin's index inside it.
  public static func tileOf(_ bin: Int64) -> (tile: Int64, idx: Int64) {
    let tile = floorDiv(bin, Tier.tileBins)
    return (tile, bin - tile * Tier.tileBins)
  }

  /// `yearRangeLabel(lo, hi)` of tiers.mjs: '1910–1919', '500–401 BCE', '99 BCE – 900 CE' (spaced en dash when the
  /// range crosses the era; ScrollsCore's `DateLabels.yearRangeLabel` is dates.mjs's, which does not space it).
  public static func yearRangeLabel(_ lo: Int, _ hi: Int) -> String {
    if lo == hi { return DateLabels.yearLabel(lo) }
    if hi <= 0 { return "\(1 - lo)–\(1 - hi) BCE" }
    if lo > 0 && hi < 1000 { return "\(lo)–\(hi) CE" }
    if lo > 0 { return "\(lo)–\(hi)" }
    return "\(DateLabels.yearLabel(lo)) – \(DateLabels.yearLabel(hi))"
  }

  /// ⌊a / b⌋ on Int64 for b > 0.
  @inline(__always)
  public static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
  }
}
