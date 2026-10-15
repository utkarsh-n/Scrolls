// OWNER: N2
// The reference's adapters use JavaScript regular expressions; this wraps ICU's (NSRegularExpression), which works on
// UTF-16 offsets exactly as JavaScript strings do. Patterns are written for ICU with JavaScript's meaning kept:
// JavaScript's `\b` and `\w` (without the `u` flag) are ASCII-only, so a pattern that needs them spells them
// `(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])` / `[A-Za-z0-9_]` (ICU's `\b` is Unicode-aware). `.` excludes line
// terminators in both. Each pattern is compiled once.

import Foundation

/// A compiled pattern with JavaScript's string operations.
public struct JSRegex: @unchecked Sendable {
  // NSRegularExpression is immutable and documented thread-safe for matching.
  private let re: NSRegularExpression

  /// `/pattern/flags` with flags among `i` (case-insensitive) and `m` (multiline anchors).
  public init(_ pattern: String, _ flags: String = "") {
    var options: NSRegularExpression.Options = []
    if flags.contains("i") { options.insert(.caseInsensitive) }
    if flags.contains("m") { options.insert(.anchorsMatchLines) }
    do {
      re = try NSRegularExpression(pattern: pattern, options: options)
    } catch {
      preconditionFailure("JSRegex: invalid pattern \(pattern): \(error)")
    }
  }

  /// A JavaScript (non-`u`) pattern, ported by `JSPattern.port`.
  public init(js pattern: String, _ flags: String = "") {
    self.init(JSPattern.port(pattern), flags)
  }

  /// A match: its UTF-16 range and its capture groups (nil when a group did not take part).
  public struct Match: Sendable {
    public let start: Int
    public let end: Int
    public let groups: [String?]
    public var length: Int { end - start }
  }

  /// `re.test(s)`.
  public func test(_ s: String) -> Bool {
    let ns = s as NSString
    return re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) != nil
  }

  /// `re.exec(s)` with `lastIndex = from` (a global regex): the search starts at `from` but `^`, `$`, lookbehind and
  /// lookahead see the whole string, as in JavaScript (not the anchoring bounds of a range).
  public func exec(_ s: String, from: Int = 0) -> Match? {
    let ns = s as NSString
    guard from <= ns.length,
      let m = re.firstMatch(in: s, options: from == 0 ? [] : [.withoutAnchoringBounds, .withTransparentBounds],
                            range: NSRange(location: from, length: ns.length - from))
    else { return nil }
    return match(m, ns)
  }

  /// Every non-overlapping match from `from` (`matchAll` / a global regex looping from `lastIndex = from`).
  public func all(_ s: String, from: Int = 0) -> [Match] {
    let ns = s as NSString
    guard from <= ns.length else { return [] }
    return re.matches(in: s, options: from == 0 ? [] : [.withoutAnchoringBounds, .withTransparentBounds],
                      range: NSRange(location: from, length: ns.length - from)).map { match($0, ns) }
  }

  /// `s.replace(/re/g, with)` with a literal replacement.
  public func replaceAll(_ s: String, with replacement: String) -> String {
    let ns = s as NSString
    return re.stringByReplacingMatches(in: s, options: [], range: NSRange(location: 0, length: ns.length),
                                       withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
  }

  /// `s.replace(/re/, with)`: the first match only.
  public func replaceFirst(_ s: String, with replacement: String) -> String {
    guard let m = exec(s) else { return s }
    let ns = s as NSString
    return ns.replacingCharacters(in: NSRange(location: m.start, length: m.length), with: replacement)
  }

  /// `s.split(re)` for a pattern without capture groups and without empty matches.
  public func split(_ s: String) -> [String] {
    let ns = s as NSString
    var out: [String] = []
    var last = 0
    for m in re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)) where m.range.length > 0 {
      out.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
      last = m.range.location + m.range.length
    }
    out.append(ns.substring(from: last))
    return out
  }

  private func match(_ m: NSTextCheckingResult, _ ns: NSString) -> Match {
    var groups: [String?] = []
    if m.numberOfRanges > 1 {
      for i in 1..<m.numberOfRanges {
        let r = m.range(at: i)
        groups.append(r.location == NSNotFound ? nil : ns.substring(with: r))
      }
    }
    return Match(start: m.range.location, end: m.range.location + m.range.length, groups: groups)
  }
}

/// Pieces of JavaScript regex syntax spelled for ICU (non-`u` JavaScript semantics).
public enum JSPattern {
  /// `\b`: a boundary between an ASCII word character and anything else.
  public static let b = "(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"
  /// `\w`.
  public static let w = "[A-Za-z0-9_]"
  /// `\d`.
  public static let d = "[0-9]"
  /// The members of JavaScript's `\s` (WhiteSpace and LineTerminator), for use inside a character class.
  public static let spaceMembers = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"
  /// `\s`.
  public static let s = "[\(spaceMembers)]"
  /// `\S`.
  public static let S = "[^\(spaceMembers)]"
  /// `[^\S\n]`: whitespace other than a line feed.
  public static let hs = "[\\t\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]"

  /// A JavaScript pattern (non-`u`) for ICU: `\b`, `\s`, `\S`, `\w`, `\d` get their JavaScript meaning (inside a
  /// character class too, where `\s`, `\w`, `\d` expand to their members and `[^\S\n]` becomes `hs`), and a `[`
  /// inside a class is escaped (ICU would read it as a nested set).
  public static func port(_ js: String) -> String {
    let src = Array(js.replacingOccurrences(of: "[^\\S\\n]", with: "\u{1}"))
    var out = ""
    var i = 0
    var inClass = false
    while i < src.count {
      let c = src[i]
      if c == "\u{1}" { out += hs; i += 1; continue }
      if c == "\\", i + 1 < src.count {
        let n = src[i + 1]
        switch (inClass, n) {
        case (false, "b"): out += b
        case (false, "s"): out += s
        case (false, "S"): out += S
        case (false, "w"): out += w
        case (false, "d"): out += d
        case (true, "s"): out += spaceMembers
        case (true, "w"): out += "A-Za-z0-9_"
        case (true, "d"): out += "0-9"
        default: out.append(c); out.append(n)
        }
        i += 2
        continue
      }
      if c == "[" {
        if inClass {
          out += "\\["
          i += 1
          continue
        }
        inClass = true
        out.append(c)
        // a ']' right after '[' or '[^' is literal in JavaScript only as an empty class; none of our patterns has one
        i += 1
        continue
      }
      if c == "]" && inClass { inClass = false }
      out.append(c)
      i += 1
    }
    return out
  }
}

/// JavaScript string and URI helpers the adapters need.
public enum JSText {
  /// `encodeURIComponent(s)`: UTF-8 percent-encoding of everything but A–Z a–z 0–9 - _ . ! ~ * ' ( ).
  public static func encodeURIComponent(_ s: String) -> String {
    var out = ""
    for b in s.utf8 {
      switch b {
      case 0x41...0x5A, 0x61...0x7A, 0x30...0x39, 0x2D, 0x5F, 0x2E, 0x21, 0x7E, 0x2A, 0x27, 0x28, 0x29:
        out.unicodeScalars.append(Unicode.Scalar(b))
      default:
        out += String(format: "%%%02X", b)
      }
    }
    return out
  }

  /// UTF-16 slice `s.slice(a, b)` (clamped).
  public static func slice(_ u: [UInt16], _ a: Int, _ b: Int) -> String {
    let lo = max(0, min(a, u.count)), hi = max(lo, min(b, u.count))
    return String(decoding: u[lo..<hi], as: UTF16.self)
  }

  /// `/\s/.test(ch)` for one UTF-16 code unit (JavaScript whitespace and line terminators).
  public static func isSpace(_ u: UInt16) -> Bool {
    switch u {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }
}
