// OWNER: N0
// JavaScript string semantics the ports need. Swift's String compares, searches and splits by grapheme cluster and
// canonical equivalence ("é" == "e\u{301}"); JavaScript works on UTF-16 code units. Every port that must agree with the
// reference on arbitrary input uses these helpers instead of the String API.

import Foundation

/// JavaScript `String.prototype` operations over UTF-16 code units.
public enum JSString {
  /// `a === b`: the same UTF-16 code units.
  @inline(__always)
  public static func equal(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

  /// `s.startsWith(prefix)` by code units.
  public static func hasPrefix(_ s: String, _ prefix: String) -> Bool { s.utf16.starts(with: prefix.utf16) }

  /// `s.endsWith(suffix)` by code units.
  public static func hasSuffix(_ s: String, _ suffix: String) -> Bool {
    s.utf16.count >= suffix.utf16.count && s.utf16.reversed().starts(with: suffix.utf16.reversed())
  }

  /// `list.includes(s)` by code units.
  public static func includes(_ list: [String], _ s: String) -> Bool { list.contains { equal($0, s) } }

  /// Whether a code unit is JavaScript whitespace (WhiteSpace or LineTerminator, `\s`).
  @inline(__always)
  public static func isWhitespace(_ u: UInt16) -> Bool {
    if u < 0x80 { return u == 0x20 || (u >= 0x09 && u <= 0x0D) }
    if u >= 0xD800 && u <= 0xDFFF { return false }
    return TokenClassTable.classes(UInt32(u)).contains(.whitespace)
  }

  /// `s.trim()`.
  public static func trim(_ s: String) -> String {
    let u = Array(s.utf16)
    var a = 0, b = u.count
    while a < b, isWhitespace(u[a]) { a += 1 }
    while b > a, isWhitespace(u[b - 1]) { b -= 1 }
    return a == 0 && b == u.count ? s : String(decoding: u[a..<b], as: UTF16.self)
  }

  /// `s.toLowerCase()`: V8's full, locale-independent mapping (ICU root). Every mapping but Σ's is context-free and
  /// comes from NSString (never Swift's own String lowercasing, which breaks Final_Sigma; DV-1). Σ (U+03A3) follows
  /// ICU's Final_Sigma rule exactly, which NSString does not: it becomes ς when it is preceded by a cased letter and not
  /// followed by one, skipping case-ignorable characters in both directions (a character that is both, such as U+0345,
  /// is skipped), with Cased and Case_Ignorable from the generated table (Node's ICU).
  public static func toLowerCase(_ s: String) -> String {
    if s.utf8.allSatisfy({ $0 < 0x80 }) { return Fold.asciiLowercased(s) }
    let u = Array(s.utf16)
    guard u.contains(0x03A3) else { return (s as NSString).lowercased }
    var out: [UInt16] = []
    out.reserveCapacity(u.count)
    func lower(_ r: Range<Int>) {
      guard !r.isEmpty else { return }
      out += ((String(decoding: u[r], as: UTF16.self) as NSString).lowercased).utf16
    }
    var start = 0
    for i in u.indices where u[i] == 0x03A3 {
      lower(start..<i)
      out.append(isFinalSigma(u, at: i) ? 0x03C2 : 0x03C3)
      start = i + 1
    }
    lower(start..<u.count)
    return String(decoding: out, as: UTF16.self)
  }

  /// ICU ucase_toFullLower's context test for U+03A3 at `i`.
  static func isFinalSigma(_ u: [UInt16], at i: Int) -> Bool {
    let table = TokenClassTable.lookup
    /// Whether the first character in `direction` that is not case-ignorable is cased.
    func casedLetter(_ direction: Int) -> Bool {
      var j = i
      while true {
        let cp: UInt32
        if direction > 0 {
          j += 1
          guard j < u.count else { return false }
          if u[j] >= 0xD800, u[j] <= 0xDBFF, j + 1 < u.count, u[j + 1] >= 0xDC00, u[j + 1] <= 0xDFFF {
            cp = 0x10000 + (UInt32(u[j] - 0xD800) << 10) + UInt32(u[j + 1] - 0xDC00)
            j += 1
          } else {
            cp = UInt32(u[j])
          }
        } else {
          j -= 1
          guard j >= 0 else { return false }
          if u[j] >= 0xDC00, u[j] <= 0xDFFF, j > 0, u[j - 1] >= 0xD800, u[j - 1] <= 0xDBFF {
            cp = 0x10000 + (UInt32(u[j - 1] - 0xD800) << 10) + UInt32(u[j] - 0xDC00)
            j -= 1
          } else {
            cp = UInt32(u[j])
          }
        }
        let c = table.classes(cp)
        if c.contains(.caseIgnorable) { continue }
        return c.contains(.cased)
      }
    }
    return !casedLetter(+1) && casedLetter(-1)
  }

  /// `s.slice(from, to)` by code units (negative indices count from the end, as JavaScript does).
  public static func slice(_ s: String, _ from: Int, _ to: Int? = nil) -> String {
    let u = Array(s.utf16)
    let n = u.count
    func clamp(_ i: Int) -> Int { i < 0 ? max(0, n + i) : min(i, n) }
    let a = clamp(from), b = clamp(to ?? n)
    return a < b ? String(decoding: u[a..<b], as: UTF16.self) : ""
  }

  /// `s.length`.
  @inline(__always)
  public static func length(_ s: String) -> Int { s.utf16.count }

  /// `s.split(sep)` for a non-empty separator, by code units.
  public static func split(_ s: String, _ sep: String) -> [String] {
    let u = Array(s.utf16), p = Array(sep.utf16)
    precondition(!p.isEmpty, "JSString.split needs a separator")
    var out: [String] = []
    var start = 0, i = 0
    while i + p.count <= u.count {
      if u[i..<(i + p.count)].elementsEqual(p) {
        out.append(String(decoding: u[start..<i], as: UTF16.self))
        i += p.count
        start = i
      } else {
        i += 1
      }
    }
    out.append(String(decoding: u[start...], as: UTF16.self))
    return out
  }

  /// `s.indexOf(sub)` by code units, or -1.
  public static func indexOf(_ s: String, _ sub: String, from: Int = 0) -> Int {
    let u = Array(s.utf16), p = Array(sub.utf16)
    var i = max(0, from)
    if p.isEmpty { return min(i, u.count) }
    while i + p.count <= u.count {
      if u[i..<(i + p.count)].elementsEqual(p) { return i }
      i += 1
    }
    return -1
  }
}
