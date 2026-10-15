// OWNER: N1
// Port of server/text/segment.mjs (`seg-1`, SPEC §4.3, IOS-SPEC §1.3, §1.7). Over the ORIGINAL text (offsets are UTF-16
// code units, D4):
//  · pages split on \f (page_no is 1-based when the document has page breaks, else null);
//  · regions (from adapters) and pages are hard boundaries; region boundaries snap outward to token ends;
//  · blocks split on blank lines; furniture blocks ([Illustration…], short all-caps or roman-numeral headings, digit-only
//    or ≤ 3-character blocks, blocks without tokens) are flagged, never dropped; in paged documents digit-only lines,
//    ≤ 3-character lines and lines repeated on > 30% of pages are split out as furniture too;
//  · verse: a block with ≥ 4 lines of which ≥ 60% are < 60 chars → stanzas of ≤ 16 lines;
//  · prose blocks over 200 tokens split at the sentence boundary nearest 120 tokens (NSString enclosing sentence ranges
//    = Intl.Segmenter, plus । ॥: ScrollsCore `SentenceBreaker`), hard max 200;
//  · blocks under 12 tokens merge forward until the group has ≥ 40 tokens, never across a heading, a stanza, furniture,
//    a region or a page, and never past 200 tokens.
// Every token of [start, end) lands in exactly one passage; passages never start or end with whitespace. The regular
// expressions of the reference are written out by hand over code units, with the reference's Unicode classes from the
// generated token-class table (so a Unicode update cannot move a boundary); golden g1.segment pins the output.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One passage of a segmented text (the reference's segment object).
public struct Segment: Sendable, Equatable {
  public var start: Int
  public var end: Int
  /// 'paragraph' | 'stanza' | 'sentence_group' | 'page_paragraph' | 'field'
  public var unit: String
  public var pageNo: Int?
  public var quality: String
  public var timeRole: String
  public var fieldClass: String
  public var tokenCount: Int

  public init(start: Int, end: Int, unit: String, pageNo: Int?, quality: String, timeRole: String, fieldClass: String,
              tokenCount: Int) {
    self.start = start
    self.end = end
    self.unit = unit
    self.pageNo = pageNo
    self.quality = quality
    self.timeRole = timeRole
    self.fieldClass = fieldClass
    self.tokenCount = tokenCount
  }
}

/// The `seg-1` segmenter.
public enum Segmenter {
  /// The segmenter version runs and `meta` record (`StoreVersions.segmenter`).
  public static var version: String { StoreVersions.segmenter }

  static let mergeBelow = 12
  static let mergeTarget = 40
  static let splitTarget = 120
  static let hardMax = 200
  static let verseMinLines = 4
  static let verseShortLine = 60
  static let verseShare = 0.6
  static let stanzaMaxLines = 16
  static let repeatShare = 0.3
  static let repeatMinPages = 5

  struct Attrs: Equatable {
    var quality: String
    var timeRole: String
    var fieldClass: String
    static let defaults = Attrs(quality: "ok", timeRole: "document", fieldClass: "text")
  }

  /// `segment(text, opts)` with the text as a String (tests, goldens).
  public static func segment(_ text: String, mode: String = "auto", lang: String? = nil, regions: [TextRegion] = [],
                             start: Int = 0, end: Int? = nil) -> [Segment] {
    let units = Array(text.utf16)
    let tok = Tokenizer.tokens(text)
    return segment(units: units, starts: tok.starts, ends: tok.ends, mode: mode, lang: lang, regions: regions, start: start,
                   end: end ?? units.count)
  }

  /// `segment(text, {mode, lang, regions, start, end, tokens})` over code units, with the tokens of the whole text.
  public static func segment(units text: [UInt16], starts: [Int32], ends: [Int32], mode: String = "auto", lang: String? = nil,
                             regions: [TextRegion] = [], start rawStart: Int = 0, end rawEnd: Int? = nil) -> [Segment] {
    let tok = TokenIndex(starts: starts, ends: ends)
    let start = max(0, rawStart)
    let end = min(text.count, rawEnd ?? text.count)
    if start >= end { return [] }
    if mode == "field" {
      let attrs = regions.isEmpty ? Attrs.defaults : regionAttrs(regions[0])
      return [Segment(start: start, end: end, unit: "field", pageNo: nil, quality: attrs.quality, timeRole: attrs.timeRole,
                      fieldClass: attrs.fieldClass, tokenCount: tok.count(start, end))]
    }
    let pageSep: UInt16 = 0x0C
    let paged = text.contains(pageSep)
    var breaksBefore = 0, breaksPos = 0
    func pageAt(_ x: Int) -> Int {  // 1 + page separators before x (monotone calls)
      var i = indexOf(text, pageSep, from: breaksPos)
      while i != -1 && i < x {
        breaksBefore += 1
        breaksPos = i + 1
        i = indexOf(text, pageSep, from: i + 1)
      }
      return breaksBefore + 1
    }
    let repeated = paged ? repeatedLines(text, pageSep, start, end) : []
    let lineFurniture: (([UInt16]) -> Bool)? = paged
      ? { s in s.count <= 3 || (digitsOnly(s) && containsNumber(s)) || repeated.contains(normLine(s)) }
      : nil

    var out: [Segment] = []
    func emit(_ a: Int, _ b: Int, _ unit: String, _ page: Int?, _ attrs: Attrs, _ n: Int) {
      out.append(Segment(start: a, end: b, unit: unit, pageNo: page, quality: attrs.quality, timeRole: attrs.timeRole,
                         fieldClass: attrs.fieldClass, tokenCount: n))
    }

    struct Group {
      var start: Int
      var end: Int
      var n: Int
      var items: Int
      var split: Bool
      var open: Bool
    }

    for span in regionSpans(regions, start, end, tok) {
      for piece in pagePieces(text, span.a, span.b, pageSep, paged, pageAt) {
        let paraUnit = piece.page == nil ? "paragraph" : "page_paragraph"
        var group: Group?
        func flush() {
          guard let g = group else { return }
          emit(g.start, g.end, g.items == 1 && g.split ? "sentence_group" : paraUnit, piece.page, span.attrs, g.n)
          group = nil
        }
        var furnitureAttrs = span.attrs
        if span.attrs.quality == "ok" { furnitureAttrs.quality = "furniture" }

        for block in blocksOf(text, piece.a, piece.b, lineFurniture) {
          let c = classify(text, block, tok)
          if c.furniture {
            flush()
            emit(block.start, block.end, paraUnit, piece.page, furnitureAttrs, c.n)
            continue
          }
          if block.lines.count > 1 && isVerse(block, mode) {
            flush()
            for st in stanzas(block, tok) {
              emit(st.start, st.end, "stanza", piece.page, span.attrs, tok.count(st.start, st.end))
            }
            continue
          }
          let items: [(start: Int, end: Int, n: Int, split: Bool)] = c.n > hardMax
            ? splitLong(text, block, tok, lang).map { ($0.start, $0.end, $0.n, true) }
            : [(block.start, block.end, c.n, false)]
          for item in items {
            if var g = group, g.open, !c.heading, g.n + item.n <= hardMax {
              g.end = item.end
              g.n += item.n
              g.items += 1
              g.open = g.n < mergeTarget
              group = g
              continue
            }
            flush()
            group = Group(start: item.start, end: item.end, n: item.n, items: 1, split: item.split,
                          open: (c.heading || item.n < mergeBelow) && item.n < mergeTarget)
          }
        }
        flush()
      }
    }
    return out
  }

  // MARK: token index helpers

  struct TokenIndex {
    let starts: [Int32]
    let ends: [Int32]

    /// Index of the first token whose start is ≥ x.
    func lowerBound(_ x: Int) -> Int {
      var lo = 0, hi = starts.count
      let v = Int32(clamping: x)
      while lo < hi {
        let mid = (lo + hi) >> 1
        if starts[mid] < v { lo = mid + 1 } else { hi = mid }
      }
      return lo
    }

    /// Moves x forward to the end of a token it falls inside, so no boundary splits a token.
    func snap(_ x: Int) -> Int {
      let i = lowerBound(x) - 1
      return i >= 0 && Int(ends[i]) > x ? Int(ends[i]) : x
    }

    func count(_ a: Int, _ b: Int) -> Int { lowerBound(b) - lowerBound(a) }
  }

  static func isWS(_ u: UInt16) -> Bool { JSString.isWhitespace(u) }

  static func trimRange(_ text: [UInt16], _ a0: Int, _ b0: Int) -> (Int, Int) {
    var a = a0, b = b0
    while a < b && isWS(text[a]) { a += 1 }
    while b > a && isWS(text[b - 1]) { b -= 1 }
    return (a, b)
  }

  static func indexOf(_ text: [UInt16], _ u: UInt16, from: Int) -> Int {
    var i = max(0, from)
    while i < text.count {
      if text[i] == u { return i }
      i += 1
    }
    return -1
  }

  // MARK: spans: region × page pieces

  static func regionAttrs(_ r: TextRegion) -> Attrs {
    let timeRole = r.timeRole ?? (r.fieldClass == "apparatus" ? "apparatus" : r.fieldClass == "describes" ? "describes" : "document")
    let fieldClass = r.fieldClass ?? (timeRole == "apparatus" ? "apparatus" : timeRole == "describes" ? "describes" : "text")
    return Attrs(quality: r.quality ?? "ok", timeRole: timeRole, fieldClass: fieldClass)
  }

  /// Consecutive [a, b) intervals covering [start, end), each with its region attributes.
  static func regionSpans(_ regions: [TextRegion], _ start: Int, _ end: Int, _ tok: TokenIndex) -> [(a: Int, b: Int, attrs: Attrs)] {
    // a stable sort by start, as Array.prototype.sort
    struct Snapped {
      let k: Int
      let a: Int
      let b: Int
      let attrs: Attrs
    }
    var snapped: [Snapped] = []
    for (k, r) in regions.enumerated() {
      let a = max(start, tok.snap(r.start)), b = min(end, tok.snap(r.end))
      if a < b { snapped.append(Snapped(k: k, a: a, b: b, attrs: regionAttrs(r))) }
    }
    let rs = snapped.sorted { x, y in x.a != y.a ? x.a < y.a : x.k < y.k }
    var spans: [(a: Int, b: Int, attrs: Attrs)] = []
    var cur = start
    for r in rs {
      let a = max(r.a, cur)
      if a >= r.b { continue }  // overlaps an earlier region: the earlier one wins
      if a > cur { spans.append((cur, a, .defaults)) }
      spans.append((a, r.b, r.attrs))
      cur = r.b
    }
    if cur < end { spans.append((cur, end, .defaults)) }
    return spans
  }

  /// Page pieces of [a, b): 1-based page numbers (nil when the text has no page breaks).
  static func pagePieces(_ text: [UInt16], _ a: Int, _ b: Int, _ sep: UInt16, _ paged: Bool,
                         _ pageAt: (Int) -> Int) -> [(a: Int, b: Int, page: Int?)] {
    if !paged { return [(a, b, nil)] }
    var out: [(a: Int, b: Int, page: Int?)] = []
    var page = pageAt(a), cur = a
    var i = indexOf(text, sep, from: a)
    while i != -1 && i < b {
      if i > cur { out.append((cur, i, page)) }
      cur = i + 1
      page += 1
      i = indexOf(text, sep, from: i + 1)
    }
    if cur < b { out.append((cur, b, page)) }
    return out
  }

  // MARK: lines and blocks

  struct Line {
    let start: Int
    let end: Int
  }

  struct Block {
    var start: Int
    var end: Int
    var lines: [Line]
    var forcedFurniture: Bool
  }

  /// Trimmed lines of [a, b); nil = a blank line.
  static func linesOf(_ text: [UInt16], _ a: Int, _ b: Int) -> [Line?] {
    var out: [Line?] = []
    var ls = a
    while ls < b {
      var le = indexOf(text, 0x0A, from: ls)
      if le == -1 || le > b { le = b }
      let (s, e) = trimRange(text, ls, le)
      out.append(s < e ? Line(start: s, end: e) : nil)
      ls = le + 1
    }
    return out
  }

  /// `normLine`: digits runs → '#', whitespace runs → ' ', trimmed, lower-cased (JavaScript semantics).
  static func normLine(_ s: [UInt16]) -> String {
    var out: [UInt16] = []
    out.reserveCapacity(s.count)
    var i = 0
    let table = TokenClassTable.lookup
    while i < s.count {
      let (cp, len) = codePoint(s, i)
      if table.classes(cp).contains(.number) {
        var j = i + len
        while j < s.count {
          let (c2, l2) = codePoint(s, j)
          guard table.classes(c2).contains(.number) else { break }
          j += l2
        }
        out.append(0x23)
        i = j
      } else {
        out.append(contentsOf: s[i..<(i + len)])
        i += len
      }
    }
    var collapsed: [UInt16] = []
    collapsed.reserveCapacity(out.count)
    var k = 0
    while k < out.count {
      if isWS(out[k]) {
        while k < out.count && isWS(out[k]) { k += 1 }
        collapsed.append(0x20)
      } else {
        collapsed.append(out[k])
        k += 1
      }
    }
    let trimmed = JSString.trim(String(decoding: collapsed, as: UTF16.self))
    return JSString.toLowerCase(trimmed)
  }

  @inline(__always)
  static func codePoint(_ u: [UInt16], _ i: Int) -> (UInt32, Int) {
    let c = u[i]
    if c >= 0xD800, c <= 0xDBFF, i + 1 < u.count {
      let d = u[i + 1]
      if d >= 0xDC00, d <= 0xDFFF { return (0x10000 + (UInt32(c - 0xD800) << 10) + UInt32(d - 0xDC00), 2) }
    }
    return (UInt32(c), 1)
  }

  /// Lines repeated on more than REPEAT_SHARE of the pages (running heads), as normalized strings.
  static func repeatedLines(_ text: [UInt16], _ sep: UInt16, _ start: Int, _ end: Int) -> Set<String> {
    let slice = Array(text[start..<end])
    let pages = slice.split(separator: sep, omittingEmptySubsequences: false)
    if pages.count < repeatMinPages { return [] }
    var counts: [String: Int] = [:]
    for p in pages {
      var seen = Set<String>()
      for line in p.split(separator: 0x0A, omittingEmptySubsequences: false) {
        let l = normLine(Array(line))
        if !l.isEmpty { seen.insert(l) }
      }
      for l in seen { counts[l, default: 0] += 1 }
    }
    var out = Set<String>()
    for (l, n) in counts where Double(n) > repeatShare * Double(pages.count) && n > 1 { out.insert(l) }
    return out
  }

  /// Blocks of consecutive non-blank lines; in paged mode furniture lines become one-line blocks of their own.
  static func blocksOf(_ text: [UInt16], _ a: Int, _ b: Int, _ lineFurniture: (([UInt16]) -> Bool)?) -> [Block] {
    var blocks: [Block] = []
    var cur: Block?
    func close() {
      if let c = cur { blocks.append(c) }
      cur = nil
    }
    for line in linesOf(text, a, b) {
      guard let line else {
        close()
        continue
      }
      if let lf = lineFurniture, lf(Array(text[line.start..<line.end])) {
        close()
        blocks.append(Block(start: line.start, end: line.end, lines: [line], forcedFurniture: true))
        continue
      }
      if cur == nil { cur = Block(start: line.start, end: line.end, lines: [], forcedFurniture: false) }
      cur!.lines.append(line)
      cur!.end = line.end
    }
    close()
    return blocks
  }

  // MARK: classification

  /// `isAllCapsHeading(s, n)`: ≥ 2 letters, ≤ 10 tokens, every letter differs from its lower case and equals its upper.
  static func isAllCapsHeading(_ s: [UInt16], _ n: Int) -> Bool {
    if n > 10 { return false }
    let table = TokenClassTable.lookup
    var letters: [(UInt32, Int, Int)] = []
    var i = 0
    while i < s.count {
      let (cp, len) = codePoint(s, i)
      if table.classes(cp).contains(.letter) { letters.append((cp, i, len)) }
      i += len
    }
    if letters.count < 2 { return false }
    for (cp, at, len) in letters {
      if cp < 0x80 {
        if !(cp >= 0x41 && cp <= 0x5A) { return false }
        continue
      }
      let c = String(decoding: s[at..<(at + len)], as: UTF16.self)
      let lower = JSString.toLowerCase(c)
      let upper = (c as NSString).uppercased
      if JSString.equal(lower, c) || !JSString.equal(upper, c) { return false }
    }
    return true
  }

  /// The simple case folding the reference's /iu patterns see, for the letters those patterns contain.
  @inline(__always)
  static func fold(_ u: UInt16) -> UInt16 {
    if u >= 0x41 && u <= 0x5A { return u + 0x20 }
    switch u {
    case 0x017F: return 0x73  // ſ → s
    case 0x212A: return 0x6B  // K (Kelvin) → k
    case 0x00D3: return 0x00F3  // Ó → ó
    case 0x00CD: return 0x00ED  // Í → í
    case 0x00C8: return 0x00E8  // È → è
    default: return u
    }
  }

  /// `\w` of a /iu pattern: [A-Za-z0-9_] and the two characters that fold into it (ſ, K).
  @inline(__always)
  static func isWordUnit(_ u: UInt16) -> Bool {
    (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || u == 0x5F || u == 0x017F || u == 0x212A
  }

  /// Whether `s[at...]` starts with `word` under /iu folding (each pattern character may be one of `alts`).
  static func matchesFolded(_ s: [UInt16], _ at: Int, _ pattern: [[UInt16]]) -> Int? {
    var i = at
    for alts in pattern {
      guard i < s.count, alts.contains(fold(s[i])) else { return nil }
      i += 1
    }
    return i
  }

  static func word(_ w: String) -> [[UInt16]] { w.utf16.map { [$0] } }

  static let illustrationWords: [[[UInt16]]] = [
    word("illustration"), word("ilustraci") + [[0x6F, 0xF3]] + word("n"), word("gravure"), word("figure"), word("fig."),
    word("image"), word("plate"),
  ]

  /// `ILLUSTRATION = /^\[\s*(?:illustration|ilustraci[oó]n|gravure|figure|fig\.|image|plate)\b/iu`
  static func isIllustration(_ s: [UInt16]) -> Bool {
    guard s.first == 0x5B else { return false }
    var i = 1
    while i < s.count && isWS(s[i]) { i += 1 }
    for w in illustrationWords {
      guard let j = matchesFolded(s, i, w) else { continue }
      let before = isWordUnit(s[j - 1])
      let after = j < s.count && isWordUnit(s[j])
      if before != after { return true }
    }
    return false
  }

  static let headingWords: [[[UInt16]]] = [
    word("chapter"), word("chapitre"), word("cap") + [[0x69, 0xED]] + word("tulo"), word("book"), word("livre"),
    word("libro"), word("part"), word("partie"), word("parte"), word("canto"), word("act"), word("acte"), word("scene"),
    word("sc") + [[0x65, 0xE8]] + word("ne"), word("section"),
  ]

  /// `[ivxlcdm]+\.?$` from `at`.
  static func romanTail(_ s: [UInt16], _ at: Int) -> Bool {
    let roman: Set<UInt16> = [0x69, 0x76, 0x78, 0x6C, 0x63, 0x64, 0x6D]
    var i = at
    while i < s.count && roman.contains(fold(s[i])) { i += 1 }
    guard i > at else { return false }
    if i < s.count && s[i] == 0x2E { i += 1 }
    return i == s.count
  }

  /// `ROMAN_HEADING = /^(?:(?:chapter|…|section)\s+)?[ivxlcdm]+\.?$/iu`
  static func isRomanHeading(_ s: [UInt16]) -> Bool {
    for w in headingWords {
      guard let j = matchesFolded(s, 0, w), j < s.count, isWS(s[j]) else { continue }
      var k = j
      while k < s.count && isWS(s[k]) { k += 1 }
      if romanTail(s, k) { return true }
    }
    return romanTail(s, 0)
  }

  /// `DIGITS_ONLY = /^[\p{N}\p{P}\p{Z}\s]+$/u`
  static func digitsOnly(_ s: [UInt16]) -> Bool {
    guard !s.isEmpty else { return false }
    let table = TokenClassTable.lookup
    var i = 0
    while i < s.count {
      let (cp, len) = codePoint(s, i)
      let c = table.classes(cp)
      if !(c.contains(.number) || c.contains(.punctuation) || c.contains(.separator) || c.contains(.whitespace)) { return false }
      i += len
    }
    return true
  }

  /// `/\p{N}/u.test(s)`
  static func containsNumber(_ s: [UInt16]) -> Bool {
    let table = TokenClassTable.lookup
    var i = 0
    while i < s.count {
      let (cp, len) = codePoint(s, i)
      if table.classes(cp).contains(.number) { return true }
      i += len
    }
    return false
  }

  static let sentenceEnders: Set<UInt16> = [0x2E, 0x21, 0x3F, 0x2026, 0x3B, 0x3A, 0x2C, 0x0964, 0x0965]
  static let closers: Set<UInt16> = [0x22, 0x27, 0x201D, 0x2019, 0x00BB, 0x29, 0x5D]

  /// `SENTENCE_END = /[.!?…;:,।॥]["'”’»)\]]*$/u`
  static func endsSentence(_ s: [UInt16]) -> Bool {
    var i = s.count - 1
    while i >= 0 && closers.contains(s[i]) { i -= 1 }
    return i >= 0 && sentenceEnders.contains(s[i])
  }

  static func classify(_ text: [UInt16], _ block: Block, _ tok: TokenIndex) -> (n: Int, furniture: Bool, heading: Bool) {
    let s = Array(text[block.start..<block.end])
    let n = tok.count(block.start, block.end)
    let oneLine = block.lines.count == 1
    let furniture = block.forcedFurniture || n == 0 || s.count <= 3 || isIllustration(s) || (digitsOnly(s) && n <= 3)
      || (oneLine && (isAllCapsHeading(s, n) || isRomanHeading(s)))
    let heading = !furniture && oneLine && n <= 10 && s.count <= 80 && !endsSentence(s)
    return (n, furniture, heading)
  }

  static func isVerse(_ block: Block, _ mode: String) -> Bool {
    if mode == "prose" { return false }
    if mode == "verse" { return true }
    let lines = block.lines
    if lines.count < verseMinLines { return false }
    let short = lines.filter { $0.end - $0.start < verseShortLine }.count
    return Double(short) >= verseShare * Double(lines.count)
  }

  /// Stanzas of ≤ 16 lines (and, where lines allow, ≤ 200 tokens).
  static func stanzas(_ block: Block, _ tok: TokenIndex) -> [(start: Int, end: Int)] {
    var out: [(start: Int, end: Int)] = []
    var first = 0
    while first < block.lines.count {
      var last = first
      while last + 1 < block.lines.count && last + 1 - first < stanzaMaxLines
        && tok.count(block.lines[first].start, block.lines[last + 1].end) <= hardMax {
        last += 1
      }
      out.append((block.lines[first].start, block.lines[last].end))
      first = last + 1
    }
    return out
  }

  static func sentenceBoundaries(_ text: [UInt16], _ a: Int, _ b: Int) -> [Int] {
    let s = String(decoding: text[a..<b], as: UTF16.self)
    return SentenceBreaker.starts(s).map { a + $0 }.filter { $0 > a && $0 < b }
  }

  /// Splits a long prose block into pieces at the sentence boundaries nearest SPLIT_TARGET tokens (hard max 200).
  static func splitLong(_ text: [UInt16], _ block: Block, _ tok: TokenIndex, _ lang: String?) -> [(start: Int, end: Int, n: Int)] {
    let t0 = tok.lowerBound(block.start)
    let t1 = tok.lowerBound(block.end)
    let cuts = sentenceBoundaries(text, block.start, block.end)
      .map { (o: $0, k: tok.lowerBound($0)) }
      .filter { $0.k > t0 && $0.k < t1 }
    var pieces: [(start: Int, end: Int, n: Int)] = []
    var cur = t0, pieceStart = block.start
    while t1 - cur > hardMax {
      var best: (o: Int, k: Int)?
      for c in cuts {
        if c.k <= cur || c.k > cur + hardMax { continue }
        if best == nil || abs(c.k - cur - splitTarget) < abs(best!.k - cur - splitTarget) { best = c }
      }
      let k = best?.k ?? cur + hardMax
      let cutAt = best?.o ?? Int(tok.ends[k - 1])
      let (ps, pe) = trimRange(text, pieceStart, cutAt)
      pieces.append((ps, pe, k - cur))
      cur = k
      pieceStart = trimRange(text, cutAt, block.end).0
    }
    pieces.append((pieceStart, block.end, t1 - cur))
    return pieces
  }
}
