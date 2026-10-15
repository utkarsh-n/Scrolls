// OWNER: N0
// Date labels of src/shared/dates.mjs (SPEC §13 rule 18: years are labelled historically, never as negative numbers).

/// Human labels of years, ranges and parsed dates, byte-equal with the reference.
public enum DateLabels {
  /// `yearLabel(astroYear)`: −499 → '500 BCE', 0 → '1 BCE', 600 → '600 CE', 1931 → '1931'.
  public static func yearLabel(_ y: Int) -> String {
    if y <= 0 { return "\(1 - y) BCE" }
    if y < 1000 { return "\(y) CE" }
    return String(y)
  }

  /// `yearRangeLabel(lo, hi)`: '1955–1985', '500–2 BCE', '44–79 CE'; an unknown (nil) end reads '?'.
  public static func yearRangeLabel(_ lo: Int?, _ hi: Int?) -> String {
    guard let lo, let hi else { return "\(lo.map(yearLabel) ?? "?")–\(hi.map(yearLabel) ?? "?")" }
    if lo == hi { return yearLabel(lo) }
    if hi <= 0 { return "\(1 - lo)–\(1 - hi) BCE" }
    if lo > 0 && hi < 1000 { return "\(lo)–\(hi) CE" }
    return "\(yearLabel(lo))–\(yearLabel(hi))"
  }

  /// `formatDateLabel(p)`: 'c. 1894', '1990s', 'Apr 1931', '17 May 1994', '500 BCE', 'early 20th century',
  /// '1930–1931 (VS 1987)', 'undated'.
  public static func formatDateLabel(_ p: DateParse?) -> String {
    guard let p, let loDay = p.loDay, let hiDay = p.hiDay, p.precision != "unknown" else { return "undated" }
    return formatLabel(loDay: Int(loDay), hiDay: Int(hiDay), precision: p.precision, approx: p.approx, rule: p.rule, raw: p.raw)
  }

  static func formatLabel(loDay: Int, hiDay: Int, precision: String, approx: Bool, rule rawRule: String, raw: String?) -> String {
    let lo = DayMath.ymdFromDay(loDay), hi = DayMath.ymdFromDay(hiDay)
    let rule = JSString.hasSuffix(rawRule, "+future") ? JSString.slice(rawRule, 0, -7) : rawRule
    let circa = approx ? "c. " : ""
    switch precision {
    case "day":
      return circa + (loDay == hiDay ? dayLabel(lo) : dayRangeLabel(lo, hi))
    case "month":
      return circa + intervalLabel(loDay, hiDay)
    case "year":
      return circa + yearRangeLabel(lo.y, hi.y)
    case "decade":
      if lo.y >= 0 && lo.y % 10 == 0 && hi.y == lo.y + 9 { return "\(circa)\(lo.y)s" }
      return circa + yearRangeLabel(lo.y, hi.y)
    case "century":
      if rule == "hundreds" && lo.y % 100 == 0 && hi.y == lo.y + 99 { return "\(circa)\(lo.y)s" }
      return circa + (centuryLabel(lo.y, hi.y) ?? yearRangeLabel(lo.y, hi.y))
    case "millennium":
      return circa + (millenniumLabel(lo.y, hi.y) ?? yearRangeLabel(lo.y, hi.y))
    case "period":
      return "\(yearRangeLabel(lo.y, hi.y)) (period)"
    default:
      break
    }
    // precision 'range'
    if rule == "circa" && (hi.y - lo.y) % 2 == 0 && lo.m == 1 && lo.d == 1 && hi.m == 12 && hi.d == 31 {
      return "c. \(yearLabel((lo.y + hi.y) / 2))"  // the span is even, so the midpoint is a whole year
    }
    if rule == "century_part", let part = centuryPartLabel(lo.y, hi.y) { return part }
    if rule == "vikram_samvat" { return "\(yearRangeLabel(lo.y, hi.y)) (VS \(lo.y + 57))" }
    if rule == "shaka_samvat" { return "\(yearRangeLabel(lo.y, hi.y)) (Saka \(lo.y - 78))" }
    if rule == "open_range", let raw {
      return isBefore(JSString.trim(raw)) ? "before \(yearLabel(hi.y + 1))" : "after \(yearLabel(lo.y - 1))"
    }
    return circa + intervalLabel(loDay, hiDay)
  }

  /// `BEFORE_RE` (/…/i): the reference's case-insensitive match folds ASCII letters only (no Unicode flag).
  private static let beforePrefixes = ["before", "pre", "antes", "avant", "prior", "से पहले", "के पहले", "से पूर्व", "પહેલ", "પૂર્વે"]
  private static let beforeSuffixes = ["से पहले", "के पहले", "से पूर्व", "પહેલાં", "પહેલા", "પૂર્વે"]
  private static func isBefore(_ s: String) -> Bool {
    let t = asciiFolded(s)
    return beforePrefixes.contains { JSString.hasPrefix(t, $0) } || beforeSuffixes.contains { JSString.hasSuffix(t, $0) }
  }

  private static func asciiFolded(_ s: String) -> String {
    String(decoding: s.utf16.map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 }, as: UTF16.self)
  }

  static func ordinal(_ n: Int) -> String {
    let t = n % 100
    if t >= 11 && t <= 13 { return "\(n)th" }
    let r = n % 10
    return "\(n)\((0...3).contains(r) ? ["th", "st", "nd", "rd"][r] : "th")"
  }

  /// The century [lo, hi] (astronomical) whose label covers year y: CE 1800–1899; 500–401 BCE = −499…−400.
  static func centuryOf(_ y: Int) -> (Int, Int) {
    if y >= 0 { return (DayMath.floorDiv(y, 100) * 100, DayMath.floorDiv(y, 100) * 100 + 99) }
    let n = -DayMath.floorDiv(-(1 - y), 100)  // Math.ceil((1 - y) / 100)
    return (1 - n * 100, 1 - n * 100 + 99)
  }

  static func centuryLabel(_ lo: Int, _ hi: Int) -> String? {
    if lo == 1 && hi == 99 { return "1st century" }
    if lo >= 0 && lo % 100 == 0 && hi == lo + 99 { return "\(ordinal(lo / 100 + 1)) century" }
    if hi <= 0 && (1 - lo) % 100 == 0 && hi == lo + 99 { return "\(ordinal((1 - lo) / 100)) century BCE" }
    return nil
  }

  static func millenniumLabel(_ lo: Int, _ hi: Int) -> String? {
    if lo >= 0 && lo % 1000 == 0 && hi == lo + 999 { return "\(ordinal(lo / 1000 + 1)) millennium" }
    if hi <= 0 && (1 - lo) % 1000 == 0 && hi == lo + 999 { return "\(ordinal((1 - lo) / 1000)) millennium BCE" }
    return nil
  }

  static func centuryPartLabel(_ lo: Int, _ hi: Int) -> String? {
    let (cLo, cHi) = centuryOf(lo)
    guard let base = centuryLabel(cLo, cHi), hi <= cHi else { return nil }
    let off = lo - cLo
    if off == 0 && hi - lo == 33 { return "early \(base)" }
    if off == 33 && hi - lo == 33 { return "mid \(base)" }
    if off == 66 && hi == cHi { return "late \(base)" }
    return nil
  }

  static func dayLabel(_ a: (y: Int, m: Int, d: Int)) -> String { "\(a.d) \(DayMath.monthAbbr[a.m - 1]) \(yearLabel(a.y))" }

  static func dayRangeLabel(_ a: (y: Int, m: Int, d: Int), _ b: (y: Int, m: Int, d: Int)) -> String {
    let ma = DayMath.monthAbbr[a.m - 1], mb = DayMath.monthAbbr[b.m - 1]
    if a.y == b.y && a.m == b.m { return "\(a.d)–\(b.d) \(ma) \(yearLabel(a.y))" }
    if a.y == b.y { return "\(a.d) \(ma) – \(b.d) \(mb) \(yearLabel(a.y))" }
    return "\(dayLabel(a)) – \(dayLabel(b))"
  }

  /// The generic label of any inclusive day interval, at the coarsest calendar alignment it has.
  static func intervalLabel(_ loDay: Int, _ hiDay: Int) -> String {
    let a = DayMath.ymdFromDay(loDay), b = DayMath.ymdFromDay(hiDay)
    if a.m == 1 && a.d == 1 && b.m == 12 && b.d == 31 { return yearRangeLabel(a.y, b.y) }
    let ma = DayMath.monthAbbr[a.m - 1], mb = DayMath.monthAbbr[b.m - 1]
    if a.d == 1 && b.d == DayMath.daysInMonth(b.y, b.m) {
      if a.y == b.y && a.m == b.m { return "\(ma) \(yearLabel(a.y))" }
      if a.y == b.y { return "\(ma)–\(mb) \(yearLabel(a.y))" }
      return "\(ma) \(yearLabel(a.y)) – \(mb) \(yearLabel(b.y))"
    }
    if loDay == hiDay { return dayLabel(a) }
    return dayRangeLabel(a, b)
  }
}
