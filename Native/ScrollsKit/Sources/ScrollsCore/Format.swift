// OWNER: N0
// Port of src/shared/format.mjs (SPEC §1.2, §7): number, rate and unit formatting shared by engine copy and UI.
// A missing or non-finite value always formats as '—', never as 0: a gated measure has no numeral (§13 rule 7).

/// Number formatting byte-equal with the reference.
public enum Format {
  /// The dash every missing or gated value prints as.
  public static let dash = "—"

  /// `formatCount(n)`: an integer count with thousands separators (94385 → '94,385').
  public static func int(_ n: Int) -> String { (n < 0 ? "-" : "") + group(String(n.magnitude)) }

  /// `formatCount(n)` for a JavaScript number (rounded with Math.round); nil or non-finite → '—'.
  public static func count(_ n: Double?) -> String {
    guard let n, n.isFinite else { return dash }
    let r = JSNumber.round(n)
    return (r < 0 ? "-" : "") + group(JSNumber.format(abs(r)))
  }

  /// `formatNumber(x, sig)`: at least `sig` significant digits (whole-number digits are never rounded away), no exponent,
  /// trailing zeros dropped, grouped thousands (2850.5 → '2,851'; 367.3 → '367'; 84.25 → '84.3'; 0.4123 → '0.412').
  public static func number(_ x: Double?, sig: Int = 3) -> String {
    guard let x, x.isFinite else { return dash }
    if x == 0 { return "0" }
    let a = abs(x)
    let digits = Int(JSMath.log10(a).rounded(.down)) + 1
    let decimals = max(0, min(6, sig - digits))
    var s = JSNumber.toFixed(a, decimals)
    if s.utf8.contains(UInt8(ascii: ".")) {
      while s.hasSuffix("0") { s.removeLast() }
      if s.hasSuffix(".") { s.removeLast() }
    }
    let parts = JSString.split(s, ".")
    let f = parts.count > 1 ? parts[1] : ""
    return (x < 0 ? "-" : "") + group(parts[0]) + (f.isEmpty ? "" : "." + f)
  }

  /// `formatTokens(n)` for an integer count: 812 → '812', 6200 → '6.2k', 18000 → '18k', 6100000 → '6.1M'.
  public static func tokens(_ n: Int) -> String { tokens(Double(n)) }

  /// `formatTokens(n)`; nil or non-finite → '—'.
  public static func tokens(_ n: Double?) -> String {
    guard let n, n.isFinite else { return dash }
    let a = abs(n), sign = n < 0 ? "-" : ""
    if a < 1000 { return sign + JSNumber.format(JSNumber.round(a)) }
    let units: [(String, Double)] = [("k", 1e3), ("M", 1e6), ("B", 1e9)]
    for (u, (suffix, size)) in units.enumerated() {
      let v = a / size
      let rounded = Double(JSNumber.toFixed(v, v < 100 ? 1 : 0))!
      if rounded >= 1000 && u < units.count - 1 { continue }
      return sign + JSNumber.format(rounded) + suffix
    }
    return sign + JSNumber.format(a)
  }

  /// `unitLabel(unit)`: the long label of a rate unit ('per million tokens') or of a collection unit ('tokens').
  public static func unitLabel(_ unit: String?) -> String {
    guard let unit else { return "" }
    if let u = Vocab.rateUnits[unit] { return u.label }
    switch unit {
    case "tokens": return "tokens"
    case "works": return "works"
    case "entries": return "entries"
    case "none": return ""
    default: return unit
    }
  }

  /// `formatShare(share)`: a percent with up to one decimal (0.315 → '31.5%').
  public static func share(_ s: Double?) -> String {
    guard let s, s.isFinite else { return dash }
    return JSNumber.format(Double(JSNumber.toFixed(s * 100, 1))!) + "%"
  }

  private static func rateValue(_ rate: Double, _ unit: String?) -> String {
    unit == "share_of_sampled_works" ? share(rate) : number(rate)
  }

  /// `formatRate(rate, unit)`: '367/M tokens', '12.5/1k works', '31.5% of sampled works'.
  public static func rate(_ x: Double?, unit: String?) -> String {
    guard let x, x.isFinite else { return dash }
    guard let unit, let u = Vocab.rateUnits[unit] else { return number(x) }
    return unit == "share_of_sampled_works" ? "\(share(x)) \(u.short)" : "\(number(x))\(u.short)"
  }

  /// `formatRate` with the frozen IOS-SPEC §8.4.5 signature.
  public static func rate(_ x: Double, unit: String) -> String { rate(Optional(x), unit: Optional(unit)) }

  /// `formatCI(ci, unit)`: a 95% interval in the rate's style ('[201, 616]', '[12.5%, 30%]'); '—' unless both ends
  /// are finite.
  public static func ci(_ ci: [Double?]?, unit: String?) -> String {
    guard let ci, ci.count == 2, let lo = ci[0], let hi = ci[1], lo.isFinite, hi.isFinite else { return dash }
    return "[\(rateValue(lo, unit)), \(rateValue(hi, unit))]"
  }

  /// The counted total of a timeline query (`totalsText`): "1,351 matches", or "562 matches · 789 works" when its lanes
  /// count in different units — never one sum across units (C2).
  public struct Totals: Sendable, Equatable {
    public var n: Double
    public var byUnit: (matches: Double, works: Double)?
    public var unitsMixed: Bool
    public init(n: Double, byUnit: (matches: Double, works: Double)? = nil, unitsMixed: Bool = false) {
      self.n = n
      self.byUnit = byUnit
      self.unitsMixed = unitsMixed
    }
    public static func == (a: Totals, b: Totals) -> Bool {
      a.n == b.n && a.unitsMixed == b.unitsMixed && a.byUnit?.matches == b.byUnit?.matches && a.byUnit?.works == b.byUnit?.works
    }
  }

  /// `totalsText(totals)`; nil → ''.
  public static func totalsText(_ totals: Totals?) -> String {
    guard let totals else { return "" }
    func counted(_ n: Double, _ one: String, _ many: String) -> String { "\(count(n)) \(n == 1 ? one : many)" }
    if let u = totals.byUnit, totals.unitsMixed { return "\(counted(u.matches, "match", "matches")) · \(counted(u.works, "work", "works"))" }
    if let u = totals.byUnit, u.works > 0, u.matches == 0 { return counted(u.works, "work", "works") }
    return counted(totals.n, "match", "matches")
  }

  /// `refWords(ref)`: a reference in words for panel headings ('passage:53' → 'passage 53', 'relationship:7' → 'link 7').
  public static func refWords(_ ref: String?) -> String {
    guard let ref, !ref.isEmpty else { return "" }
    let u = Array(ref.utf16)
    var i = 0
    while i < u.count, (u[i] >= 0x61 && u[i] <= 0x7A) || u[i] == 0x5F { i += 1 }
    // /^([a-z_]+):(.+)$/: a type, a colon, then at least one character and no line terminator to the end
    let lineTerminators: Set<UInt16> = [0x0A, 0x0D, 0x2028, 0x2029]
    guard i > 0, i < u.count, u[i] == 0x3A, i + 1 < u.count, !u[(i + 1)...].contains(where: lineTerminators.contains) else {
      return ref
    }
    let type = String(decoding: u[..<i], as: UTF16.self)
    let rest = String(decoding: u[(i + 1)...], as: UTF16.self)
    let words = ["relationship": "link", "cluster": "context group", "hypothesis_group": "hypothesis group",
                 "time_window": "window", "saved_view": "saved view"]
    return "\(words[type] ?? type.replacingOccurrences(of: "_", with: " ")) \(rest)"
  }

  /// Groups thousands with ',' as `/\B(?=(\d{3})+(?!\d))/g`: before every position inside a word whose following digit
  /// run has a length that is a positive multiple of three.
  static func group(_ s: String) -> String {
    let u = Array(s.utf16)
    func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
    func isWord(_ c: UInt16) -> Bool { isDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F }
    var run = [Int](repeating: 0, count: u.count + 1)  // length of the digit run starting at each index
    for i in stride(from: u.count - 1, through: 0, by: -1) { run[i] = isDigit(u[i]) ? run[i + 1] + 1 : 0 }
    var out: [UInt16] = []
    out.reserveCapacity(u.count + u.count / 3)
    for i in u.indices {
      if i > 0, isWord(u[i - 1]), run[i] > 0, run[i] % 3 == 0 { out.append(0x2C) }
      out.append(u[i])
    }
    return String(decoding: out, as: UTF16.self)
  }
}
