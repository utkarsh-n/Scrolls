// OWNER: N0
// ECMA-262 number ↔ string conversions, byte-equal with V8: Number::toString (the digits JSON.stringify writes),
// Number.prototype.toFixed and toPrecision (exact decimal rounding, ties away from zero), Math.round, ToInt32/ToUint32.
// JSONEncoder and String(format:) disagree with JavaScript on 6 of 9 probe doubles (IOS-SPEC §0.2), hence this file.

/// JavaScript number formatting and coercions.
public enum JSNumber {
  /// `Number::toString(x)` (radix 10): the shortest round-trip digits laid out by ECMA-262 §6.1.6.1.20.
  /// `-0` → `"0"`, `NaN` → `"NaN"`, `±Infinity` → `"Infinity"`/`"-Infinity"`.
  public static func format(_ x: Double) -> String {
    if x.isNaN { return "NaN" }
    if x == 0 { return "0" }
    if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
    if x < 0 { return "-" + format(-x) }
    let (digits, n) = shortestDigits(x)
    let k = digits.count
    var out = ""
    if k <= n && n <= 21 {
      out = String(decoding: digits, as: UTF8.self) + String(repeating: "0", count: n - k)
    } else if 0 < n && n <= 21 {
      out = String(decoding: digits[0..<n], as: UTF8.self) + "." + String(decoding: digits[n...], as: UTF8.self)
    } else if -6 < n && n <= 0 {
      out = "0." + String(repeating: "0", count: -n) + String(decoding: digits, as: UTF8.self)
    } else {
      let e = n - 1
      let exp = (e < 0 ? "e-" : "e+") + String(abs(e))
      if k == 1 {
        out = String(decoding: digits, as: UTF8.self) + exp
      } else {
        out = String(decoding: digits[0..<1], as: UTF8.self) + "." + String(decoding: digits[1...], as: UTF8.self) + exp
      }
    }
    return out
  }

  /// `Number.prototype.toFixed(digits)` for `digits` in 0…100: exact decimal rounding of the double, a tie going to
  /// the larger magnitude; values ≥ 1e21 fall back to `format`.
  public static func toFixed(_ value: Double, _ fractionDigits: Int) -> String {
    precondition((0...100).contains(fractionDigits), "toFixed: digits must be 0…100")
    if value.isNaN { return "NaN" }
    var x = value
    var sign = ""
    if x < 0 { sign = "-"; x = -x }
    if x >= 1e21 { return sign + format(x) }  // also covers +Infinity
    var n: [UInt8]  // ASCII digits of the integer n with n / 10^f closest to x
    if x == 0 {
      n = [0x30]
    } else {
      let d = ExactDecimal(x)
      n = d.roundedPrefix(length: d.pointPosition + fractionDigits).digits
      if n.isEmpty { n = [0x30] }
    }
    var m = n
    if fractionDigits != 0 {
      var k = m.count
      if k <= fractionDigits {
        m = [UInt8](repeating: 0x30, count: fractionDigits + 1 - k) + m
        k = fractionDigits + 1
      }
      m = Array(m[0..<(k - fractionDigits)]) + [0x2E] + Array(m[(k - fractionDigits)...])
    }
    return sign + String(decoding: m, as: UTF8.self)
  }

  /// `Number.prototype.toPrecision(precision)` for `precision` in 1…100.
  public static func toPrecision(_ value: Double, _ precision: Int) -> String {
    precondition((1...100).contains(precision), "toPrecision: precision must be 1…100")
    if value.isNaN { return "NaN" }
    var x = value
    var sign = ""
    if x < 0 { sign = "-"; x = -x }
    if x.isInfinite { return sign + "Infinity" }
    var m: [UInt8]
    var e: Int
    if x == 0 {
      m = [UInt8](repeating: 0x30, count: precision)
      e = 0
    } else {
      let d = ExactDecimal(x)
      let r = d.roundedPrefix(length: precision)
      m = r.digits
      e = d.pointPosition - 1 + (r.carriedIntoNewDigit ? 1 : 0)
      if m.count > precision { m.removeLast(m.count - precision) }  // 99.96 → "100" carries one digit too many
      if e < -6 || e >= precision {
        var out = [m[0]]
        if precision != 1 { out += [0x2E] + m[1...] }
        let exp = (e >= 0 ? "e+" : "e-") + String(abs(e))
        return sign + String(decoding: out, as: UTF8.self) + exp
      }
    }
    if e == precision - 1 { return sign + String(decoding: m, as: UTF8.self) }
    if e >= 0 {
      return sign + String(decoding: m[0...e], as: UTF8.self) + "." + String(decoding: m[(e + 1)...], as: UTF8.self)
    }
    return sign + "0." + String(repeating: "0", count: -(e + 1)) + String(decoding: m, as: UTF8.self)
  }

  /// `Math.round(x)`: the nearest integer, a tie going toward +∞; keeps the sign of zero as JavaScript does.
  public static func round(_ x: Double) -> Double {
    if !x.isFinite || x == 0 { return x }
    let f = x.rounded(.down)
    let r = (x - f) >= 0.5 ? f + 1 : f
    return r == 0 && x < 0 ? -0.0 : r
  }

  /// ECMA-262 ToUint32 (`x >>> 0`).
  public static func toUint32(_ x: Double) -> UInt32 {
    guard x.isFinite else { return 0 }
    var m = x.rounded(.towardZero).truncatingRemainder(dividingBy: 4_294_967_296)
    if m < 0 { m += 4_294_967_296 }
    return UInt32(m)
  }

  /// ECMA-262 ToInt32 (`x | 0`).
  public static func toInt32(_ x: Double) -> Int32 { Int32(bitPattern: toUint32(x)) }

  /// `Number(s)` (ECMA-262 StringToNumber): surrounding whitespace is ignored, '' is 0, 'Infinity' with an optional
  /// sign, 0x/0o/0b integers, decimal literals with an optional sign, fraction and exponent; anything else is NaN.
  public static func parse(_ s: String) -> Double {
    let t = Array(JSString.trim(s).utf8)
    if t.isEmpty { return 0 }
    func digits(_ b: ArraySlice<UInt8>, radix: Int) -> Double {
      guard !b.isEmpty else { return .nan }
      var v = 0.0
      for c in b {
        let d: Int
        switch c {
        case 0x30...0x39: d = Int(c - 0x30)
        case 0x61...0x7A: d = Int(c - 0x61) + 10
        case 0x41...0x5A: d = Int(c - 0x41) + 10
        default: return .nan
        }
        guard d < radix else { return .nan }
        v = v * Double(radix) + Double(d)  // exact below 2^53; larger values round as V8's radix parser does per digit
      }
      return v
    }
    if t.count > 2, t[0] == 0x30 {
      switch t[1] {
      case 0x78, 0x58: return digits(t[2...], radix: 16)
      case 0x6F, 0x4F: return digits(t[2...], radix: 8)
      case 0x62, 0x42: return digits(t[2...], radix: 2)
      default: break
      }
    }
    var i = 0
    var negative = false
    if t[i] == 0x2B || t[i] == 0x2D { negative = t[i] == 0x2D; i += 1 }
    let body = String(decoding: t[i...], as: UTF8.self)
    if body == "Infinity" { return negative ? -.infinity : .infinity }
    // StrUnsignedDecimalLiteral: digits [. digits] | . digits, then an optional exponent
    var j = i, intDigits = 0, fracDigits = 0
    while j < t.count, t[j] >= 0x30 && t[j] <= 0x39 { j += 1; intDigits += 1 }
    if j < t.count, t[j] == 0x2E {
      j += 1
      while j < t.count, t[j] >= 0x30 && t[j] <= 0x39 { j += 1; fracDigits += 1 }
    }
    guard intDigits + fracDigits > 0 else { return .nan }
    if j < t.count, t[j] == 0x65 || t[j] == 0x45 {
      j += 1
      if j < t.count, t[j] == 0x2B || t[j] == 0x2D { j += 1 }
      var expDigits = 0
      while j < t.count, t[j] >= 0x30 && t[j] <= 0x39 { j += 1; expDigits += 1 }
      guard expDigits > 0 else { return .nan }
    }
    guard j == t.count else { return .nan }
    let v = Double(String(decoding: t[i...], as: UTF8.self)) ?? .nan  // correctly rounded (strtod)
    return negative ? -v : v
  }

  /// Whether `x` is a safe integer (`Number.isSafeInteger`).
  public static func isSafeInteger(_ x: Double) -> Bool {
    x.isFinite && x.rounded(.towardZero) == x && abs(x) <= 9_007_199_254_740_991
  }

  /// The shortest digits that round-trip to `x` (> 0, finite) and the decimal point position `n`:
  /// x = 0.d₁d₂…dₖ × 10ⁿ. Swift's `description` yields the shortest, closest digits, as V8 does.
  static func shortestDigits(_ x: Double) -> (digits: [UInt8], n: Int) {
    let text = Array(x.description.utf8)  // e.g. "123.0", "0.0001", "1e-07", "1.2345e+20"
    var mantissa = text[...]
    var exponent = 0
    if let e = text.firstIndex(of: UInt8(ascii: "e")) {
      mantissa = text[..<e]
      exponent = Int(String(decoding: text[(e + 1)...], as: UTF8.self))!
    }
    var digits: [UInt8] = []
    var point = 0
    var seenPoint = false
    for c in mantissa {
      if c == UInt8(ascii: ".") { seenPoint = true; continue }
      if !seenPoint { point += 1 }
      digits.append(c)
    }
    point += exponent
    while let first = digits.first, first == UInt8(ascii: "0") { digits.removeFirst(); point -= 1 }
    while let last = digits.last, last == UInt8(ascii: "0") { digits.removeLast() }
    return (digits, point)
  }
}

/// The exact decimal expansion of a positive finite double: value = 0.d₁d₂…dₖ × 10^pointPosition, d₁ ≠ 0.
/// Every double is a dyadic rational, so its decimal expansion terminates (at most 767 significant digits).
struct ExactDecimal {
  /// ASCII digits, no leading zero, no trailing zeros.
  let digits: [UInt8]
  let pointPosition: Int

  init(_ x: Double) {
    precondition(x > 0 && x.isFinite)
    let bits = x.bitPattern
    let exponentBits = Int((bits >> 52) & 0x7FF)
    let fraction = bits & ((1 << 52) - 1)
    let mantissa = exponentBits == 0 ? fraction : fraction | (1 << 52)
    let e2 = exponentBits == 0 ? -1074 : exponentBits - 1075
    var n = BigDecimalInt(mantissa)
    var scale = 0
    if e2 >= 0 {
      n.multiplyByPowerOfTwo(e2)
    } else {
      n.multiplyByPowerOfFive(-e2)  // x = mantissa · 5^(-e2) / 10^(-e2)
      scale = -e2
    }
    var d = n.decimalDigits()
    let point = d.count - scale
    while let last = d.last, last == UInt8(ascii: "0") { d.removeLast() }
    digits = d
    pointPosition = point
  }

  /// The integer formed by the first `length` digits (zero-padded when `length` exceeds the digit count),
  /// rounded half away from zero on the exact remainder. `length ≤ 0` keeps no digit and rounds up to "1" only when
  /// `length == 0` and the first digit is ≥ 5. `carriedIntoNewDigit` reports a carry that lengthened the result.
  func roundedPrefix(length: Int) -> (digits: [UInt8], carriedIntoNewDigit: Bool) {
    if length < 0 { return ([], false) }
    if length == 0 { return digits[0] >= UInt8(ascii: "5") ? ([UInt8(ascii: "1")], true) : ([], false) }
    var kept = Array(digits.prefix(length))
    if kept.count < length { kept += [UInt8](repeating: UInt8(ascii: "0"), count: length - kept.count) }
    guard length < digits.count, digits[length] >= UInt8(ascii: "5") else { return (kept, false) }
    var i = kept.count - 1
    while i >= 0 {
      if kept[i] == UInt8(ascii: "9") {
        kept[i] = UInt8(ascii: "0")
        i -= 1
      } else {
        kept[i] += 1
        return (kept, false)
      }
    }
    return ([UInt8(ascii: "1")] + kept, true)
  }
}

/// A non-negative big integer in base 10⁹ (little-endian limbs), just enough for `ExactDecimal`.
struct BigDecimalInt {
  private var limbs: [UInt64]
  private static let base: UInt64 = 1_000_000_000

  init(_ v: UInt64) {
    limbs = []
    var x = v
    repeat {
      limbs.append(x % Self.base)
      x /= Self.base
    } while x > 0
  }

  private mutating func multiply(by m: UInt64) {
    var carry: UInt64 = 0
    for i in limbs.indices {
      let p = limbs[i] * m + carry  // < 10⁹ · 2³¹ + carry: fits UInt64
      limbs[i] = p % Self.base
      carry = p / Self.base
    }
    while carry > 0 {
      limbs.append(carry % Self.base)
      carry /= Self.base
    }
  }

  mutating func multiplyByPowerOfTwo(_ k: Int) {
    var k = k
    while k >= 30 { multiply(by: 1 << 30); k -= 30 }
    if k > 0 { multiply(by: 1 << UInt64(k)) }
  }

  mutating func multiplyByPowerOfFive(_ k: Int) {
    var k = k
    while k >= 13 { multiply(by: 1_220_703_125); k -= 13 }  // 5¹³
    var r: UInt64 = 1
    for _ in 0..<k { r *= 5 }
    if r > 1 { multiply(by: r) }
  }

  func decimalDigits() -> [UInt8] {
    var out = Array(String(limbs.last!).utf8)
    for limb in limbs.dropLast().reversed() {
      let s = Array(String(limb).utf8)
      out += [UInt8](repeating: UInt8(ascii: "0"), count: 9 - s.count) + s
    }
    return out
  }
}
