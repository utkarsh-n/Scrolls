// OWNER: N0
// Day arithmetic of src/shared/dates.mjs (D5, SPEC §13 rule 18). Time is an integer number of days since 1970-01-01,
// proleptic Gregorian, astronomical years (1 BCE = 0). The reference builds `new Date(0)` and calls
// `setUTCFullYear(y, m - 1, d)`, so months and days roll over as JavaScript's MakeDay does; this is the same
// arithmetic in integers (Hinnant's days-from-civil). Never `Calendar`: it maps years 0–99 and BCE differently.

import Foundation

/// Days since 1970-01-01 (proleptic Gregorian), D5.
public typealias Day = Int32

/// An inclusive day interval [lo, hi].
public struct DayInterval: Sendable, Hashable, Codable {
  public var lo: Day
  public var hi: Day
  public init(lo: Day, hi: Day) {
    self.lo = lo
    self.hi = hi
  }
}

/// Calendar arithmetic on day numbers, bit-equal with the reference.
public enum DayMath {
  /// `MONTH_ABBR`.
  public static let monthAbbr = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  /// `dayFromYMD(y, m, d)`: out-of-range months and days roll over as `Date.prototype.setUTCFullYear` does.
  public static func dayFromYMD(_ y: Int, _ m: Int = 1, _ d: Int = 1) -> Int {
    let m0 = m - 1
    let ym = y + floorDiv(m0, 12)
    let mn = m0 - floorDiv(m0, 12) * 12  // 0…11
    return daysFromCivil(ym, mn + 1, 1) + d - 1
  }

  /// `ymdFromDay(day)`.
  public static func ymdFromDay(_ day: Int) -> (y: Int, m: Int, d: Int) {
    let z = day + 719_468
    let era = floorDiv(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    return (yoe + era * 400 + (m <= 2 ? 1 : 0), m, d)
  }

  /// `isLeapYear(y)` (astronomical year).
  public static func isLeapYear(_ y: Int) -> Bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

  /// `daysInMonth(y, m)`.
  public static func daysInMonth(_ y: Int, _ m: Int) -> Int { dayFromYMD(y, m + 1, 1) - dayFromYMD(y, m, 1) }

  /// `todayDay(now)`: the UTC day number of an instant.
  public static func day(of instant: Date) -> Int { Int((instant.timeIntervalSince1970 * 1000 / 86_400_000).rounded(.down)) }

  /// Today's UTC day number from the system clock (`todayDay()`).
  public static func today() -> Int { day(of: Date()) }

  /// Days from civil date (y, m 1–12, d) to 1970-01-01.
  static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = y0 - (m <= 2 ? 1 : 0)
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  /// ⌊a / b⌋ for b > 0 (JavaScript `Math.floor(a / b)` on integers).
  @inline(__always)
  public static func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
  }
}
