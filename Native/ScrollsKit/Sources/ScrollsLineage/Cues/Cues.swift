// OWNER: N5
// Port of server/lineage/cues.mjs (SPEC §4.7): attribution cues in en, fr, es, hi and gu within ±30 tokens of a span.
// A cue is evidence that a text *names* a source; which document that name refers to is inferred. So a cue never makes
// a link documented: it yields an explicit_citation that is 'proposed', with a 'citation_cue' evidence row (CUE), and
// only a person can confirm it (D7, §13 rule 6).
//
// The patterns are the reference's regular expressions, translated to ICU (NSRegularExpression) with JavaScript's
// semantics kept: `\b` is JavaScript's ASCII word boundary (ICU's is Unicode-aware), and `\s` is JavaScript's
// whitespace set (ICU's lacks U+000B and U+FEFF). Offsets are UTF-16 code units, as in the reference (G1 `g1.cues`).

import Foundation
import ScrollsCore

public enum Cues {
  /// Cue window around a span, in tokens.
  public static let window = 30

  /// JavaScript `\s`.
  static let ws = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
  /// JavaScript `\b` before / after an ASCII word character of the pattern.
  static let bBefore = "(?<![A-Za-z0-9_])"
  static let bAfter = "(?![A-Za-z0-9_])"

  static let name = "(\\p{Lu}[\\p{L}\\p{M}'’.\\-]*(?:\(ws)+(?:(?:de|del|la|le|van|von|da|di)\(ws)+)?\\p{Lu}[\\p{L}\\p{M}'’.\\-]*){0,2})"
  static let devaName = "((?:[\\p{Script=Devanagari}\\p{M}]+\(ws)+){0,2}[\\p{Script=Devanagari}\\p{M}]+)"
  static let gujrName = "((?:[\\p{Script=Gujarati}\\p{M}]+\(ws)+){0,2}[\\p{Script=Gujarati}\\p{M}]+)"

  /// One cue pattern: `label` names it on the card ("as <Name> put it").
  public struct Pattern: Sendable {
    public let label: String
    let regex: NSRegularExpression
  }

  static func re(_ s: String) -> NSRegularExpression {
    // the patterns are constants; a failure here is a programming error caught by the unit tests
    try! NSRegularExpression(pattern: s, options: [])
  }

  /// `CUE_PATTERNS`, in the reference's language and pattern order.
  public static let patterns: [(lang: String, patterns: [Pattern])] = [
    ("en", [
      Pattern(label: "as <Name> said/wrote/put it/observed",
              regex: re("\(bBefore)[Aa]s\(ws)+\(name)\(ws)+(?:said|wrote|put it|observed)\(bAfter)")),
      Pattern(label: "in <Name>'s words", regex: re("\(bBefore)[Ii]n\(ws)+\(name)['’]s\(ws)+words\(bAfter)")),
      Pattern(label: "<Name>'s phrase/line", regex: re("\(name)['’]s\(ws)+(?:phrase|line)\(bAfter)")),
    ]),
    ("fr", [
      Pattern(label: "comme (l'a) dit/écrit <Nom>", regex: re("\(bBefore)[Cc]omme\(ws)+(?:l['’]a\(ws)+)?(?:dit|écrit)\(ws)+\(name)")),
      Pattern(label: "selon <Nom>", regex: re("\(bBefore)[Ss]elon\(ws)+\(name)")),
    ]),
    ("es", [
      Pattern(label: "como dijo/escribió <Nombre>", regex: re("\(bBefore)[Cc]omo\(ws)+(?:dijo|escribió)\(ws)+\(name)")),
      Pattern(label: "según <Nombre>", regex: re("(?<![\\p{L}\\p{M}])[Ss]egún\(ws)+\(name)")),
    ]),
    ("hi", [
      Pattern(label: "<नाम> ने कहा", regex: re("\(devaName)\(ws)+ने\(ws)+कहा")),
      Pattern(label: "<नाम> के शब्दों में", regex: re("\(devaName)\(ws)+के\(ws)+शब्दों\(ws)+में")),
    ]),
    ("gu", [
      Pattern(label: "<નામ> એ કહ્યું", regex: re("\(gujrName)\(ws)*એ\(ws)+કહ્યું")),
      Pattern(label: "<નામ> ના શબ્દોમાં", regex: re("\(gujrName)\(ws)+ના\(ws)+શબ્દોમાં")),
    ]),
  ]

  static let quotePairs: [(String, String)] = [("“", "”"), ("\"", "\""), ("«", "»"), ("‘", "’"), ("„", "“"), ("'", "'")]

  /// A cue found in a text.
  public struct Cue: Sendable, Equatable {
    public var start: Int
    public var end: Int
    public var quote: String
    /// nil for the 'quotation marks around the span' cue.
    public var name: String?
    public var pattern: String
    public var lang: String?
    /// Tokens between the cue and the span (findCues only).
    public var distance: Int?

    /// The reference's object (`{start, end, quote, name, pattern, lang[, distance]}`).
    public var json: JSONValue {
      var o: JSONObject = ["start": .number(Double(start)), "end": .number(Double(end)), "quote": .string(quote),
                           "name": name.map(JSONValue.string) ?? .null, "pattern": .string(pattern),
                           "lang": lang.map(JSONValue.string) ?? .null]
      if let distance { o["distance"] = .number(Double(distance)) }
      return .object(o)
    }
  }

  /// `allCues(text, {lang})`: every attribution cue; a language code limits the patterns, nil tries all five. Sorted
  /// by start (a stable sort: language and pattern order for equal starts).
  public static func allCues(_ text: String, lang: String? = nil) -> [Cue] {
    let ns = text as NSString
    let langs = patterns.filter { lang == nil || !patterns.contains { $0.lang == lang } || $0.lang == lang }
    var out: [Cue] = []
    for (l, list) in langs {
      for p in list {
        for m in p.regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
          let g = m.range(at: 1)
          let captured = g.location == NSNotFound ? "" : ns.substring(with: g)
          out.append(Cue(start: m.range.location, end: m.range.location + m.range.length, quote: ns.substring(with: m.range),
                         name: JSString.trim(captured), pattern: p.label, lang: l, distance: nil))
        }
      }
    }
    return out.enumerated().sorted { a, b in
      a.element.start != b.element.start ? a.element.start < b.element.start : a.offset < b.offset
    }.map(\.element)
  }

  /// `findCues(text, start, end, {lang, window})`: attribution cues whose words lie within ±30 tokens of the span, plus
  /// a 'quotation marks around the span' cue (name nil) when the span is enclosed in quotation marks.
  public static func findCues(_ text: String, start: Int, end: Int, lang: String? = nil, window: Int = Cues.window) -> [Cue] {
    let tok = Tokenizer.tokens(text)
    func tokenAt(_ off: Int) -> Int {
      var lo = 0, hi = tok.starts.count
      while lo < hi {
        let mid = (lo + hi) >> 1
        if Int(tok.starts[mid]) < off { lo = mid + 1 } else { hi = mid }
      }
      return lo
    }
    let s0 = tokenAt(start), s1 = tokenAt(end)
    var out: [Cue] = []
    for var c in allCues(text, lang: lang) {
      let c0 = tokenAt(c.start), c1 = tokenAt(c.end)
      let distance = c1 <= s0 ? s0 - c1 : c0 >= s1 ? c0 - s1 : 0
      if distance <= window {
        c.distance = distance
        out.append(c)
      }
    }
    // quotation marks may sit outside trailing punctuation: “Carry the zero,” …
    let u = Array(text.utf16)
    let before = trimEnd(Array(u[Swift.max(0, Swift.min(u.count, start - 3))..<Swift.min(u.count, Swift.max(0, start))]))
    let after = trimStartPunct(Array(u[Swift.min(u.count, end)..<Swift.min(u.count, end + 4)]))
    for (open, close) in quotePairs {
      let o = Array(open.utf16), cl = Array(close.utf16)
      if before.count >= o.count && Array(before.suffix(o.count)) == o && after.starts(with: cl) {
        let qs = lastIndexOf(u, o, from: start)
        let qe = indexOf(u, cl, from: end) + cl.count
        let quote = qs >= 0 && qe >= qs ? String(decoding: u[qs..<Swift.min(u.count, qe)], as: UTF16.self) : ""
        out.append(Cue(start: qs, end: qe, quote: quote, name: nil, pattern: "quotation marks around the span", lang: nil,
                       distance: 0))
        break
      }
    }
    return out
  }

  /// `.replace(/\s+$/u, '')`.
  static func trimEnd(_ u: [UInt16]) -> [UInt16] {
    var b = u.count
    while b > 0, JSString.isWhitespace(u[b - 1]) { b -= 1 }
    return Array(u[..<b])
  }

  /// `.replace(/^[\s,.;:!?…]+/u, '')`.
  static func trimStartPunct(_ u: [UInt16]) -> [UInt16] {
    var a = 0
    while a < u.count, JSString.isWhitespace(u[a]) || [0x2C, 0x2E, 0x3B, 0x3A, 0x21, 0x3F, 0x2026].contains(u[a]) { a += 1 }
    return Array(u[a...])
  }

  /// `s.lastIndexOf(needle, from)` over code units.
  static func lastIndexOf(_ s: [UInt16], _ needle: [UInt16], from: Int) -> Int {
    var i = Swift.min(from, s.count - needle.count)
    while i >= 0 {
      if Array(s[i..<(i + needle.count)]) == needle { return i }
      i -= 1
    }
    return -1
  }

  /// `s.indexOf(needle, from)` over code units.
  static func indexOf(_ s: [UInt16], _ needle: [UInt16], from: Int) -> Int {
    var i = Swift.max(0, from)
    while i + needle.count <= s.count {
      if Array(s[i..<(i + needle.count)]) == needle { return i }
      i += 1
    }
    return -1
  }

  static let nameStop: Set<String> = ["the", "a", "an", "of", "and", "mr", "mrs", "ms", "dr", "miss", "sir", "old", "de", "la", "le",
                                      "el", "del", "van", "von", "s"]
  /// Pronouns and other words a cue pattern can capture that never name a source ("as I said", "as He wrote").
  static let notAName: Set<String> = ["i", "he", "she", "it", "we", "they", "you", "one", "someone", "somebody", "everybody",
                                      "everyone", "nobody", "god", "lord", "je", "il", "elle", "on", "nous", "vous", "ils", "elles",
                                      "yo", "él", "ella", "usted", "nosotros", "ellos", "ellas"]
  /// Share of a title's significant words a name must give to refer to it by title.
  public static let titleCover = 2.0 / 3.0

  /// `nameWords(name)`: the significant folded words of a cue's name; [] when it is a pronoun or another word that never
  /// names a source.
  public static func nameWords(_ name: String?) -> [String] {
    let words = Tokenizer.tokens(name ?? "").tokens
    if words.isEmpty || words.allSatisfy({ notAName.contains($0) || nameStop.contains($0) }) { return [] }
    return words.filter { !nameStop.contains($0) && !notAName.contains($0) }
  }

  /// `.replace(/\([^)]*\)/g, ' ')`.
  static func dropParentheticals(_ s: String) -> String {
    var out: [UInt16] = []
    let u = Array(s.utf16)
    var i = 0
    while i < u.count {
      if u[i] == 0x28, let close = u[(i + 1)...].firstIndex(of: 0x29) {
        out.append(0x20)
        i = close + 1
        continue
      }
      out.append(u[i])
      i += 1
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// `nameMatches(name, {author, title})`: the author's surname is among the name's words, or the name gives the
  /// title (every word of it in the title, covering ≥ 2/3 of the title's significant words).
  public static func nameMatches(_ name: String?, author: String?, title: String?) -> Bool {
    let words = nameWords(name)
    if words.isEmpty { return false }
    let authorWords = Tokenizer.tokens(dropParentheticals(author ?? "")).tokens
    if let surname = authorWords.last, surname.utf16.count >= 2, !nameStop.contains(surname), words.contains(surname) { return true }
    var seen = Set<String>()
    let titleWords = Tokenizer.tokens(dropParentheticals(title ?? "")).tokens.filter { !nameStop.contains($0) && seen.insert($0).inserted }
    if titleWords.isEmpty || !words.allSatisfy({ titleWords.contains($0) }) { return false }
    return Double(words.count) >= titleCover * Double(titleWords.count)
  }
}
