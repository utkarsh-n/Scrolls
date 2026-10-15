// OWNER: N0
// Port of tokenizer u61m-1 (src/shared/tokenize.mjs, SPEC §4.3, D4), the single source of truth for counts.
//
// A token is a single \p{So} character (U+166D excepted) with its following combining marks, or a maximal run of
// [\p{L}\p{M}\p{N}\p{Co}] in which runs of U+200C/U+200D/U+00AD between word characters do not split it. Offsets are
// UTF-16 code units into the ORIGINAL text; norms are folded (Fold). The classes come from the generated
// TokenClassTable, so a Unicode update on the phone cannot move a boundary.

import Foundation

/// One token: [start, end) in UTF-16 units and its interned norm.
public struct TokenSpan: Sendable, Equatable {
  public var start: Int32
  public var end: Int32
  public var norm: TokenID
  public init(start: Int32, end: Int32, norm: TokenID) {
    self.start = start
    self.end = end
    self.norm = norm
  }
}

/// The reference's `tokenize(text)` result: folded tokens with their UTF-16 offsets.
public struct TokenizedText: Sendable, Equatable {
  public var tokens: [String]
  public var starts: [Int32]
  public var ends: [Int32]
}

/// Why `Tokenizer.ftsPhrase` refused its input (the reference throws a RangeError).
public struct EmptyTokenSequence: Error, Sendable, Equatable {
  public init() {}
}

/// Tokenizer u61m-1.
public enum Tokenizer {
  /// `TOKENIZER_VERSION`.
  public static let version = "u61m-1"
  /// `FTS_TOKENIZE`: the FTS5 tokenizer whose token i equals this tokenizer's token i.
  public static let ftsTokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co M* So'"

  /// Appends the token spans of `utf16` to `out`, interning each norm.
  public static func spans(_ utf16: UnsafeBufferPointer<UInt16>, interner: TokenInterner, into out: inout [TokenSpan]) {
    scan(utf16) { a, b in
      let norm = interner.intern(raw: UnsafeBufferPointer(rebasing: utf16[a..<b]))
      out.append(TokenSpan(start: Int32(a), end: Int32(b), norm: norm))
    }
  }

  /// Convenience for tests and goldens: every token with its offsets and folded norm.
  public static func tokenize(_ s: String) -> [(start: Int, end: Int, norm: String)] {
    var out: [(start: Int, end: Int, norm: String)] = []
    let units = Array(s.utf16)
    units.withUnsafeBufferPointer { u in
      scan(u) { a, b in out.append((a, b, Fold.fold(units: UnsafeBufferPointer(rebasing: u[a..<b])))) }
    }
    return out
  }

  /// The reference's `tokenize(text)`: `{tokens, starts, ends}`.
  public static func tokens(_ s: String) -> TokenizedText {
    var r = TokenizedText(tokens: [], starts: [], ends: [])
    for t in tokenize(s) {
      r.tokens.append(t.norm)
      r.starts.append(Int32(t.start))
      r.ends.append(Int32(t.end))
    }
    return r
  }

  /// `normString(text)`: folded tokens joined by single spaces (what FTS indexes and expression norms are stored as).
  public static func normString(_ s: String) -> String { tokenize(s).map(\.norm).joined(separator: " ") }

  /// `findSequence(tokens, seq, from)`: index of the first exact occurrence of `seq` at or after `from`, or -1.
  /// An empty sequence never matches. Tokens compare by code units, as JavaScript's `===`.
  public static func findSequence(_ tokens: [String], _ seq: [String], from: Int = 0) -> Int {
    let n = seq.count
    guard n > 0, tokens.count >= n else { return -1 }
    var i = max(0, from)
    while i <= tokens.count - n {
      var k = 0
      while k < n, tokens[i + k].utf16.elementsEqual(seq[k].utf16) { k += 1 }
      if k == n { return i }
      i += 1
    }
    return -1
  }

  /// `ftsPhrase(seq)`: an FTS5 phrase query (`"carry the zero"`) with `"` doubled.
  public static func ftsPhrase(_ seq: [String]) throws(EmptyTokenSequence) -> String {
    guard !seq.isEmpty else { throw EmptyTokenSequence() }
    var out: [UInt16] = [0x22]
    for u in seq.joined(separator: " ").utf16 {
      out.append(u)
      if u == 0x22 { out.append(0x22) }  // code-unit replace, as /"/g (no canonical-equivalence matching)
    }
    out.append(0x22)
    return String(decoding: out, as: UTF16.self)
  }

  /// `ftsPhrase(text)`: tokenizes `text` first.
  public static func ftsPhrase(_ text: String) throws(EmptyTokenSequence) -> String {
    try ftsPhrase(tokenize(text).map(\.norm))
  }

  // MARK: Scanning

  /// Calls `body(start, end)` for every token of `u`, in order (TOKEN_RE semantics, code-point steps).
  static func scan(_ u: UnsafeBufferPointer<UInt16>, _ body: (Int, Int) -> Void) {
    let table = TokenClassTable.lookup
    let n = u.count
    var i = 0
    while i < n {
      let (cp, len) = codePoint(u, i)
      let cls = classesOf(cp, table)
      if cls.contains(.otherSymbol) && cp != 0x166D {
        // (?:(?!᙭)\p{So})\p{M}*
        let start = i
        i += len
        while i < n {
          let (c2, l2) = codePoint(u, i)
          guard classesOf(c2, table).contains(.mark) else { break }
          i += l2
        }
        body(start, i)
      } else if !cls.isDisjoint(with: .word) {
        // [\p{L}\p{M}\p{N}\p{Co}]+(?:[‌‍­]+[\p{L}\p{M}\p{N}\p{Co}]+)*
        let start = i
        i += len
        while true {
          while i < n {
            let (c2, l2) = codePoint(u, i)
            guard !classesOf(c2, table).isDisjoint(with: .word) else { break }
            i += l2
          }
          var j = i
          while j < n, u[j] == 0x200C || u[j] == 0x200D || u[j] == 0x00AD { j += 1 }
          guard j > i, j < n, !classesOf(codePoint(u, j).cp, table).isDisjoint(with: .word) else { break }
          i = j
        }
        body(start, i)
      } else {
        i += len
      }
    }
  }

  /// The code point at `i` and its UTF-16 length; a lone surrogate is its own (classless) code point.
  @inline(__always)
  static func codePoint(_ u: UnsafeBufferPointer<UInt16>, _ i: Int) -> (cp: UInt32, len: Int) {
    let c = u[i]
    if c >= 0xD800, c <= 0xDBFF, i + 1 < u.count {
      let d = u[i + 1]
      if d >= 0xDC00, d <= 0xDFFF { return (0x10000 + (UInt32(c - 0xD800) << 10) + UInt32(d - 0xDC00), 2) }
    }
    return (UInt32(c), 1)
  }

  @inline(__always)
  static func classesOf(_ cp: UInt32, _ table: TokenClassTable.Lookup) -> UnicodeClass {
    if cp < 0x80 {  // ASCII fast path: [A-Za-z] letters, [0-9] numbers, nothing else is a token character
      if cp >= 0x61 && cp <= 0x7A { return [.letter, .lowercase, .latin] }
      if cp >= 0x41 && cp <= 0x5A { return [.letter, .uppercase, .latin] }
      if cp >= 0x30 && cp <= 0x39 { return .number }
      return table.classes(cp)
    }
    return table.classes(cp)
  }
}

// MARK: - Sentence-initial test (the proper-noun guard, SPEC §4.5)

extension Tokenizer {
  private static let terminators: Set<UInt16> = [0x2E, 0x21, 0x3F, 0x2026, 0x0964, 0x0965, 0x061F, 0x3002, 0xFF01, 0xFF1F]
  /// `[\s"'“”‘’«»„‚‹›()[\]{}¿¡*_—–-]` (minus \s, tested through the class table).
  private static let skippablePunctuation: Set<UInt16> = [
    0x22, 0x27, 0x201C, 0x201D, 0x2018, 0x2019, 0x00AB, 0x00BB, 0x201E, 0x201A, 0x2039, 0x203A, 0x28, 0x29, 0x5B, 0x5D,
    0x7B, 0x7D, 0x00BF, 0x00A1, 0x2A, 0x5F, 0x2014, 0x2013, 0x2D,
  ]
  private static let abbreviations: Set<[UInt16]> = Set(
    ["mr", "mrs", "ms", "dr", "st", "jr", "sr", "sra", "srta", "prof", "rev", "gen", "capt", "col", "lt", "sgt", "mt", "vs",
     "cf", "vol", "fig", "mme", "mlle", "dña", "sta"].map { Array($0.utf16) })

  /// `isSentenceInitial(text, start)`: whether the token at UTF-16 offset `start` begins a sentence — start of text,
  /// after a blank line or a page break, or after a terminator (skipping quotes, brackets and spaces). A '.' after an
  /// initial ("J. R.") or a listed abbreviation ("Mr.") does not end a sentence.
  public static func isSentenceInitial(_ text: String, _ start: Int) -> Bool {
    Array(text.utf16).withUnsafeBufferPointer { isSentenceInitial($0, start) }
  }

  /// `isSentenceInitial` over UTF-16 code units (call this one in loops over one text).
  public static func isSentenceInitial(_ u: UnsafeBufferPointer<UInt16>, _ start: Int) -> Bool {
    let table = TokenClassTable.lookup
    // JavaScript reads text[i] past the end as undefined, which no test matches; clamp to the same effect.
    var i = min(start, u.count + 1) - 1
    var newlines = 0
    while i >= 0 {
      guard i < u.count else { break }  // text[i] === undefined: not skippable
      let c = u[i]
      if c == 0x0A {
        newlines += 1
        if newlines >= 2 { return true }
        i -= 1
        continue
      }
      if c == 0x0C { return true }
      let skippable = skippablePunctuation.contains(c) || (!isSurrogate(c) && table.classes(UInt32(c)).contains(.whitespace))
      if !skippable { break }
      i -= 1
    }
    if i < 0 { return true }
    guard i < u.count else { return false }
    let c = u[i]
    if !terminators.contains(c) { return false }
    if c != 0x2E { return true }
    var j = i - 1
    while j >= 0, !isSurrogate(u[j]), !table.classes(UInt32(u[j])).isDisjoint(with: [.letter, .mark]) { j -= 1 }
    let wordUnits = UnsafeBufferPointer(rebasing: u[(j + 1)..<i])
    let lowered = Array(JSString.toLowerCase(String(decoding: wordUnits, as: UTF16.self)).utf16)
    if lowered.count == 1, !isSurrogate(u[j + 1]), table.classes(UInt32(u[j + 1])).contains(.uppercase) { return false }
    return !abbreviations.contains(lowered)
  }

  @inline(__always)
  private static func isSurrogate(_ c: UInt16) -> Bool { c >= 0xD800 && c <= 0xDFFF }
}
