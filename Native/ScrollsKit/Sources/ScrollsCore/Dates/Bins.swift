// OWNER: N0
// Calendar bin levels and tiers of src/shared/dates.mjs (SPEC §1.6, §3 doc_bin; fit-or-wash, D2).

/// A calendar bin level: 0–3 bin by year, 4 (month) and 5 (day) by day number.
public enum Level: Int, Sendable, CaseIterable, Codable {
  case millennium = 0, century, decade, year, month, day

  /// `LEVELS[level].name`.
  public var name: String {
    switch self {
    case .millennium: "millennium"
    case .century: "century"
    case .decade: "decade"
    case .year: "year"
    case .month: "month"
    case .day: "day"
    }
  }

  /// `LEVELS[level].width` in years (nil for month and day, which bin by day number).
  public var yearWidth: Int? {
    switch self {
    case .millennium: 1000
    case .century: 100
    case .decade: 10
    case .year: 1
    case .month, .day: nil
    }
  }
}

/// Why a year-based bin function was called with month or day (the reference throws a RangeError).
public struct LevelError: Error, Sendable, Equatable {
  public let message: String
  public init(message: String) { self.message = message }
}

/// Bin arithmetic.
public enum Bins {
  /// `binOf(year, level)` for year-based levels: ⌊year / width⌋.
  public static func binOf(year: Int, level: Level) throws(LevelError) -> Int {
    try binOf(year: year, rawLevel: level.rawValue)
  }

  /// `binOf(year, level)` with the level as the reference's number (anything but 0–3 throws its RangeError).
  public static func binOf(year: Int, rawLevel: Int) throws(LevelError) -> Int {
    guard let w = Level(rawValue: rawLevel)?.yearWidth else {
      throw LevelError(message: "level \(rawLevel) has no year width; months and days bin by day number (fitsDays)")
    }
    return DayMath.floorDiv(year, w)
  }

  /// The bin of a day at any level: year-based levels bin its year, month bins count months since year 0
  /// (`monthBinOfDay`), day bins are the day number itself.
  public static func binOf(_ day: Day, level: Level) -> Int64 {
    switch level {
    case .month: return Int64(monthBinOfDay(Int(day)))
    case .day: return Int64(day)
    default: return Int64(DayMath.floorDiv(DayMath.ymdFromDay(Int(day)).y, level.yearWidth!))
    }
  }

  /// `fits(yLo, yHi, level)`: the interval lies inside one bin of a year-based level (false for month and day, where
  /// the reference throws; use `fitsDays`).
  public static func fits(_ yLo: Int32, _ yHi: Int32, _ level: Level) -> Bool {
    guard let w = level.yearWidth else { return false }
    return DayMath.floorDiv(Int(yLo), w) == DayMath.floorDiv(Int(yHi), w)
  }

  /// `fits` with the reference's RangeError for month and day levels.
  public static func fitsChecked(_ yLo: Int, _ yHi: Int, _ level: Level) throws(LevelError) -> Bool {
    try binOf(year: yLo, level: level) == binOf(year: yHi, level: level)
  }

  /// `fitsDays(loDay, hiDay, level)`: level 4 = same calendar month, level 5 = same day.
  public static func fitsDays(_ loDay: Int, _ hiDay: Int, _ level: Level) throws(LevelError) -> Bool {
    switch level {
    case .day: return loDay == hiDay
    case .month:
      let a = DayMath.ymdFromDay(loDay), b = DayMath.ymdFromDay(hiDay)
      return a.y == b.y && a.m == b.m
    default: throw LevelError(message: "fitsDays takes level 4 (month) or 5 (day)")
    }
  }

  /// `monthBinOfDay(day)`: months since year 0, y·12 + (m − 1).
  public static func monthBinOfDay(_ day: Int) -> Int {
    let (y, m, _) = DayMath.ymdFromDay(day)
    return y * 12 + (m - 1)
  }

  /// `tierForPpy(ppy)`: the level-of-detail tier for a zoom in pixels (points) per year.
  public static func tierForPpy(_ ppy: Double) -> String {
    if ppy < 0.08 { return "L0" }
    if ppy < 0.8 { return "L1" }
    if ppy < 8 { return "L2" }
    if ppy < 96 { return "L3" }
    if ppy < 2922 { return "L4" }
    return "L5"
  }
}
