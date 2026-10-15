// OWNER: N3
// Port of server/text/names.mjs: the proper-noun guard (SPEC §4.5). Name-shaped matches are excluded from counts by
// default and listed as "excluded as names (n)", each with its own override. Rules (a), (a'), (b), (c) here; rule (d),
// document consistency, is applied by the materializer over a whole document (`documentNameRule`). Phrases are never
// flagged; a possessive variant ("Gene's" = gene + s) is guarded like the word. G1 family g1.names.

import ScrollsCore

/// Folded tokens with their UTF-16 offsets (the reference's `tokenize(text)` result).
public struct TokenList: Sendable, Equatable {
  public var tokens: [String]
  public var starts: [Int32]
  public var ends: [Int32]
  public init(tokens: [String], starts: [Int32], ends: [Int32]) {
    self.tokens = tokens
    self.starts = starts
    self.ends = ends
  }
  public init(_ t: TokenizedText) { self.init(tokens: t.tokens, starts: t.starts, ends: t.ends) }
  /// `tokenize(text)`.
  public init(_ s: String) { self.init(Tokenizer.tokens(s)) }
  /// `tokenize` over code units.
  public init(units: [UInt16]) { self.init(String(decoding: units, as: UTF16.self)) }
}

/// The known maker names of a corpus for the title rule: folded token sequences joined by single spaces.
public struct NameIndex: Sendable, Codable, Equatable {
  public var names: [String]
  public var maxTokens: Int
  private var members: Set<[UInt16]>

  public init(names: [String], maxTokens: Int) {
    self.names = names
    self.maxTokens = maxTokens
    members = Set(names.map { Array($0.utf16) })
  }

  enum CodingKeys: String, CodingKey { case names, maxTokens }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(names: try c.decode([String].self, forKey: .names), maxTokens: try c.decode(Int.self, forKey: .maxTokens))
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(names, forKey: .names)
    try c.encode(maxTokens, forKey: .maxTokens)
  }

  public func contains(_ folded: String) -> Bool { members.contains(Array(folded.utf16)) }
  public var isEmpty: Bool { members.isEmpty }
}

/// The proper-noun guard.
public enum Names {
  /// Flagged occurrences a document needs before rule (d) treats the word as a name throughout it.
  public static let recurrenceMin = 3
  /// Longest maker name (in tokens) the title rule looks for.
  public static let maxNameTokens = 8

  /// Rule (d): whether every capitalized occurrence of the word in a document's body text is a name.
  public static func documentNameRule(flagged: Int, lower: Int, capitalized: Int) -> Bool {
    flagged >= recurrenceMin && lower == 0 && capitalized > 0
  }

  /// `isCapitalized(raw)`: the original token starts with an upper-case or title-case letter.
  public static func isCapitalized(_ raw: String) -> Bool { JSText.startsWithClass(raw, [.uppercase, .titlecase]) }

  /// `isCaseless(raw)`: a letter, and no upper-, lower- or title-case letter (Devanagari, Gujarati, …).
  public static func isCaseless(_ raw: String) -> Bool {
    JSText.any(raw, .letter) && !JSText.any(raw, [.uppercase, .lowercase, .titlecase])
  }

  /// `authorTokens(author)`: the folded words of an author/maker string.
  public static func authorTokens(_ author: String?) -> JSStringSet {
    guard let author, !author.isEmpty else { return JSStringSet() }
    return JSStringSet(Tokenizer.tokens(author).tokens)
  }

  /// `splitMakerNames(raw)`: the string without parenthetical notes, and the items of a list whose every item has ≥ 2
  /// words.
  public static func splitMakerNames(_ raw: String) -> [String] {
    let s = JSString.trim(JSText.collapseSpaces(removeParentheticals(raw)))
    if s.isEmpty { return [] }
    let parts = splitList(s).filter { !$0.isEmpty }
    if parts.count > 1 && parts.allSatisfy({ Tokenizer.tokens($0).tokens.count >= 2 }) { return [s] + parts }
    return [s]
  }

  /// `s.replace(/\s*\([^()]*\)/g, ' ')`.
  static func removeParentheticals(_ raw: String) -> String {
    let u = Array(raw.utf16)
    var out: [UInt16] = []
    var i = 0
    while i < u.count {
      // try a match starting at i: \s* then '(' [^()]* ')'
      var j = i
      while j < u.count, JSString.isWhitespace(u[j]) { j += 1 }
      if j < u.count, u[j] == 0x28 {
        var k = j + 1
        while k < u.count, u[k] != 0x28, u[k] != 0x29 { k += 1 }
        if k < u.count, u[k] == 0x29 {
          out.append(0x20)
          i = k + 1
          continue
        }
      }
      out.append(u[i])
      i += 1
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// `s.split(/\s*[;,]\s*/)`.
  static func splitList(_ s: String) -> [String] {
    let u = Array(s.utf16)
    var out: [String] = []
    var start = 0, i = 0
    while i < u.count {
      // a separator match starts at i: \s*[;,]\s*
      var j = i
      while j < u.count, JSString.isWhitespace(u[j]) { j += 1 }
      if j < u.count, u[j] == 0x3B || u[j] == 0x2C {
        var k = j + 1
        while k < u.count, JSString.isWhitespace(u[k]) { k += 1 }
        out.append(String(decoding: u[start..<i], as: UTF16.self))
        start = k
        i = k
        continue
      }
      i += 1
    }
    out.append(String(decoding: u[start...], as: UTF16.self))
    return out
  }

  /// `nameIndex(names)`: folded maker names of ≥ 1 token with a letter and ≤ 8 tokens.
  public static func nameIndex<S: Sequence>(_ names: S) -> NameIndex where S.Element == String {
    var set = JSStringSet()
    var list: [String] = []
    var maxTokens = 1
    for raw in names {
      for name in splitMakerNames(raw) {
        let toks = Tokenizer.tokens(name).tokens
        if toks.isEmpty || toks.count > maxNameTokens || !toks.contains(where: { JSText.any($0, .letter) }) { continue }
        let joined = toks.joined(separator: " ")
        if set.insert(joined) { list.append(joined) }
        if toks.count > maxTokens { maxTokens = toks.count }
      }
    }
    return NameIndex(names: list, maxTokens: maxTokens)
  }

  /// Every stop-word of every language (the neighbour test of rule (a)).
  static let stops = JSStringSet(NameStopwords.all)

  private static func slice(_ u: [UInt16], _ a: Int32, _ b: Int32) -> String {
    String(decoding: u[Int(a)..<Int(b)], as: UTF16.self)
  }

  /// Title rule (c).
  static func titleNameFlag(_ t: TokenList, _ i: Int, _ original: [UInt16], _ names: NameIndex?, _ lo: Int, _ hi: Int,
                            _ authors: JSStringSet) -> Bool {
    func asName(_ k: Int) -> Bool {
      let raw = slice(original, t.starts[k], t.ends[k])
      return isCapitalized(raw) || isCaseless(raw) || !JSText.any(raw, .letter)
    }
    let whole = Array(t.tokens[lo...hi])
    if !authors.isEmpty && whole.allSatisfy({ authors.contains($0) }) && asName(lo) && asName(hi) { return true }
    guard let names, !names.isEmpty else { return false }
    let longest = min(names.maxTokens, hi - lo)
    if longest >= 2 {
      for len in 2...longest {
        var a = max(lo, i - len + 1)
        while a <= min(i, hi - len + 1) {
          if names.contains(t.tokens[a..<(a + len)].joined(separator: " ")) && asName(a) && asName(a + len - 1) { return true }
          a += 1
        }
      }
    }
    return false
  }

  private static let elision: Set<UInt16> = [0x27, 0x2019, 0x02BC]

  /// Whether the token at [start, end) begins with an elision apostrophe rather than a quotation.
  static func elided(_ u: [UInt16], _ start: Int, _ end: Int) -> Bool {
    guard start - 1 >= 0, start - 1 < u.count, elision.contains(u[start - 1]) else { return false }
    if start - 2 >= 0 {
      let before = u[start - 2]
      if !isSurrogate(before) && !JSText.classes(UInt32(before)).isDisjoint(with: [.letter, .number]) { return false }
    }
    var k = end
    while k < u.count, [0x2E, 0x2C, 0x3B, 0x3A, 0x21, 0x3F].contains(u[k]) { k += 1 }
    let closes = k < u.count && elision.contains(u[k])
    let nextIsLetter: Bool = {
      guard k + 1 < u.count else { return false }
      let c = u[k + 1]
      return !isSurrogate(c) && JSText.classes(UInt32(c)).contains(.letter)
    }()
    return !(closes && !nextIsLetter)
  }

  @inline(__always) private static func isSurrogate(_ c: UInt16) -> Bool { c >= 0xD800 && c <= 0xDFFF }

  /// `nameFlag(original, start, end, opts)`: whether the single-token match at [start, end) is name-shaped.
  public static func nameFlag(_ original: [UInt16], start: Int, end: Int, author: String? = nil, authorSet: JSStringSet? = nil,
                              fieldClass: String = "text", clipStart: Int = 0, clipEnd: Int? = nil, names: NameIndex? = nil,
                              tok: TokenList? = nil) -> Bool {
    let clipEnd = clipEnd ?? original.count
    let t = tok ?? TokenList(units: original)
    guard let i = t.starts.firstIndex(of: Int32(start)) else { return false }
    if t.ends[i] != Int32(end) { return false }
    let authors = authorSet ?? authorTokens(author)
    if fieldClass == "title" {
      var lo = i, hi = i
      while lo > 0 && Int(t.starts[lo - 1]) >= clipStart { lo -= 1 }
      while hi < t.tokens.count - 1 && Int(t.ends[hi + 1]) <= clipEnd { hi += 1 }
      return titleNameFlag(t, i, original, names, lo, hi, authors)
    }
    let raw = slice(original, Int32(start), Int32(end))
    let folded = t.tokens[i]
    let caseless = isCaseless(raw)
    let cap = isCapitalized(raw)
    if (cap || caseless) && authors.contains(folded) { return true }
    if caseless || !cap { return false }
    let isInitial: (Int) -> Bool = { pos in original.withUnsafeBufferPointer { Tokenizer.isSentenceInitial($0, pos) } }
    if elided(original, start, end) && !isInitial(start - 1) { return true }
    func neighbour(_ k: Int) -> (raw: String, folded: String, start: Int)? {
      if k < 0 || k >= t.tokens.count || Int(t.starts[k]) < clipStart || Int(t.ends[k]) > clipEnd { return nil }
      return (slice(original, t.starts[k], t.ends[k]), t.tokens[k], Int(t.starts[k]))
    }
    let prev = neighbour(i - 1), next = neighbour(i + 1)
    if isInitial(start) { return false }
    func capWord(_ n: (raw: String, folded: String, start: Int)?) -> Bool {
      guard let n else { return false }
      return isCapitalized(n.raw) && !stops.contains(n.folded)
    }
    return capWord(prev) || (capWord(next) && !isInitial(next!.start))
  }
}
