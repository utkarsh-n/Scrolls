// OWNER: N2
// Port of `server/adapters/cipher/gutenberg-text.mjs`: Gutenberg body bounds and regions (SPEC §4.3, §6.3): the three
// marker variants, the licence paragraphs left inside the body, editorial apparatus and transcriber residue. Furniture
// is flagged by the segmenter; this only says where the book is and which parts of it are someone else's later text.
// Nothing is deleted: regions are flagged, offsets stay in the original (UTF-16, D4). Every regex keeps JavaScript's
// meaning (JSPattern: ASCII `\b`, JavaScript `\s`); searches that the reference runs from `lastIndex` see the whole
// string, and searches on a `slice` see only the slice.

import Foundation
import ScrollsContracts
import ScrollsCore

/// A flagged region of a Gutenberg original.
public struct GutenbergRegion: Sendable, Equatable {
  public var start: Int
  public var end: Int
  /// 'boilerplate' for licence and producer-credit paragraphs.
  public var quality: String?
  /// 'apparatus' for editorial apparatus and transcriber residue (time_role and field_class).
  public var apparatus: Bool

  public var textRegion: TextRegion {
    TextRegion(start: start, end: end, quality: quality, timeRole: apparatus ? "apparatus" : nil,
               fieldClass: apparatus ? "apparatus" : nil)
  }
}

public enum GutenbergText {
  static let startRE = JSRegex(js: #"^[^\S\n]*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*(?:\n|$)"#, "im")
  static let endRE = JSRegex(js: #"^[^\S\n]*\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG"#, "im")
  static let noSpaceRE = JSRegex(js: #"\*{3}START"#, "i")
  static let smallPrintStartRE = JSRegex(js: #"\*{3}\s*START\*{2}\s*(?:THE\s+)?SMALL PRINT"#, "i")
  static let smallPrintEndRE = JSRegex(js: #"^[^\n]*(?:\*END\*\s*THE SMALL PRINT|SMALL PRINT![^\n]*\*END\*)[^\n]*(?:\n|$)"#, "im")
  static let oldFooterRE = JSRegex(js: #"^[^\S\n]*End of (?:the |this )?(?:is COPYRIGHTED )?Project Gutenberg(?:'s)? E-?text\b"#, "im")

  /// §4.3 licence lexicon for paragraphs inside the body, plus the old "Etext" licence wording.
  public static let licenceParagraphRE = JSRegex(
    js: #"project gutenberg|gutenberg-tm|small print|this ebook is for the use of|\betexts?\b|computer virus, or computer codes"#, "i")
  static let creditsRE = JSRegex(js: "^[\\[(]?\\s*(?:produced by|e-?text prepared by|this e-?(?:text|book) was (?:prepared|produced|created|made|transcribed)"
    + "|this file was (?:produced|prepared|created|made)|transcribed (?:from|by)|prepared by|scanned (?:and proofed )?by|html version by"
    + "|e-?book (?:prepared|produced) by)\\b", "i")
  static let dpCreditRE = JSRegex(js: #"distributed proofread(?:ers|ing)|pgdp\.net|online distributed"#, "i")
  static let apparatusHeadingRE = JSRegex(js: #"^(?:PREFACE|INTRODUCTION|EDITOR'?S NOTE|TRANSCRIBER['’]?S NOTES?|NOTES|BIOGRAPHICAL (?:NOTE|SKETCH)|PRÉFACE|AVANT-PROPOS|INTRODUCCIÓN|PRÓLOGO|NOTA DEL EDITOR)\b"#, "i")
  static let transcriberRE = JSRegex(js: #"^TRANSCRIBER['’]?S NOTES?\b"#, "i")
  static let bracketNoteRE = JSRegex(js: #"\[\s*\**\s*Transcribers?['’`]?s?\s+Notes?\b"#, "i")
  static let bracketNoteLeadRE = JSRegex(js: #"^\s*\**\s*Transcribers?['’`]?s?\s+Notes?\b[\s:.*]*"#, "i")
  static let noteHeadingRE = JSRegex(js: #"^[\s|*[(+]*(?:<b>)?Transcribers?['’`]?s?\s+Notes?\b[\s:.\])*|]*"#, "i")
  static let endNoteRE = JSRegex(js: #"\[?\s*End(?: of(?: the)?)? Transcribers?['’`]?s?\s+Notes?\.?\s*\]?"#, "i")
  static let boxEdgeRE = JSRegex(js: #"^[^\S\n]*(?:\+[-—─=]{5,}|\*{10,})"#)
  static let boxBottomRE = JSRegex(js: #"^[^\S\n]*(?:\+[-—─=]{5,}|\*{10,})[^\n]*$"#, "m")
  static let boxTopicRE = JSRegex(js: #"transcriber|e-?text|e-?book|unicode|utf-8|character set|this file"#, "i")
  static let conventionRE = JSRegex(js: [
    #"^(?:note:\s*)?images of the original pages are available"#,
    #"\b(?:texts?|words?|passages?) (?:printed )?in (?:italics?|bold)[^.]{0,80}\b(?:transcribed|represented|denoted|indicated|shown|rendered)\b"#,
    #"\bitali[cs]\w*(?: text| texts)? (?:is|are|has been|have been|were) (?:denoted|transcribed|represented|indicated|shown|rendered)\b"#,
    #"^(?:the )?(?:texts?|words?) (?:transcribed )?between _?underscores"#,
    #"\bsmall capitals (?:in the original(?: text)? )?(?:have been|are|were|has been) (?:transcribed|replaced|represented|rendered)"#,
    #"^(?:this|the) e-?(?:text|book) (?:includes|contains|comes in|is based on|uses|was produced)"#,
    #"^some characters (?:might|may) not display"#,
  ].joined(separator: "|"), "i")
  static let footnoteRE = JSRegex(js: #"^\s*\[(?:Footnote\b[^\]]*|\d{1,3})\]"#, "i")
  static let yearRE = JSRegex(js: #"\b(1[0-9]{3}|20[0-9]{2})\b"#)
  /// With the `u` flag in the reference: `\p{L}`; `\b` and `\s` keep their JavaScript meaning.
  static let byNameRE = JSRegex(js: #"\b(?:by|par|por|edited by|translated by|introduction by)\s+((?:[A-Z][\p{L}'’.-]*\.?\s+){0,3}[A-Z][\p{L}'’-]+)"#)
  static let nonLetters = JSRegex(js: #"[^\p{L}]+"#)
  static let nextSectionRE = JSRegex(js: #"^(?:CHAPTER|CHAPITRE|CAP[IÍ]TULO|BOOK|LIVRE|LIBRO|PART|PARTIE|PARTE|ACT|ACTE|CANTO|[IVXLC]+\.?)\b"#, "i")
  static let noteLikeRE = JSRegex(js: #"\b(?:original|typo\w*|errors?|errata|corrected|corrections?|amended|misprints?|normali[sz]ed|regulari[sz]ed|standardi[sz]ed|spelling|punctuation|italics?|bold|underscores?|transcri\w+|e-?text|e-?book|printer\w*|footnotes?|illustrations?|pages?|inconsisten\w*|hyphenat\w*|retained|preserved|silently|chang\w*|moved|archaic|variant|unicode|utf-8|display|symbols?|characters?)\b"#, "i")
  static let transcriRE = JSRegex(js: "transcri", "i")
  static let spaces = JSRegex(js: #"\s+"#)

  static let residueFront = 0.08
  static let residueFrontMin = 3000
  static let noteMaxChars = 30000
  static let headingNoteBlocks = 12
  static let headingNoteChars = 6000
  static let apparatusFront = 0.15
  static let apparatusBack = 0.10

  /// The original as JavaScript sees it: a string and its UTF-16 code units.
  struct Text {
    let s: String
    let u: [UInt16]
    init(_ s: String) {
      self.s = s
      u = Array(s.utf16)
    }
    var count: Int { u.count }
    func slice(_ a: Int, _ b: Int) -> String { JSText.slice(u, a, b) }
    func trim(_ s0: Int, _ e0: Int) -> (Int, Int) {
      var s = s0, e = e0
      while s < e, JSText.isSpace(u[s]) { s += 1 }
      while e > s, JSText.isSpace(u[e - 1]) { e -= 1 }
      return (s, e)
    }
    /// `[start, end)` of blank-line separated blocks of `[a, b)` (`/\n[^\S\n]*\n/g` from `lastIndex = a`), trimmed.
    func blocks(_ a: Int, _ b: Int) -> [(Int, Int)] {
      var out: [(Int, Int)] = []
      var cur = a, i = a
      while i < u.count, i < b {
        guard u[i] == 0x0A else { i += 1; continue }
        var j = i + 1
        while j < u.count, u[j] != 0x0A, JSText.isSpace(u[j]) { j += 1 }
        if j < u.count, u[j] == 0x0A {
          if i > cur { out.append((cur, i)) }
          cur = j + 1
          i = j + 1
        } else {
          i += 1
        }
      }
      if cur < b { out.append((cur, b)) }
      return out.map { trim($0.0, $0.1) }.filter { $0.1 > $0.0 }
    }
    func firstLine(_ a: Int, _ b: Int) -> String {
      var e = a
      while e < b, u[e] != 0x0A { e += 1 }
      return slice(a, e)
    }
    func lineEnd(_ i: Int) -> Int {
      var j = max(0, i)
      while j < u.count, u[j] != 0x0A { j += 1 }
      return j
    }
  }

  /// Body bounds of a Gutenberg file (UTF-16 offsets into the decoded original).
  public static func bounds(_ text: String) -> (bodyStart: Int, bodyEnd: Int, marker: String) {
    let n = text.utf16.count
    if let s = startRE.exec(text) {
      let bodyStart = s.end
      let rest = JSText.slice(Array(text.utf16), bodyStart, n)
      let e = endRE.exec(rest)
      let marker = noSpaceRE.test(JSText.slice(Array(text.utf16), s.start, s.end)) ? "nospace" : "exact"
      return (bodyStart, e.map { bodyStart + $0.start } ?? n, marker)
    }
    if let sp = smallPrintStartRE.exec(text) {
      let after = JSText.slice(Array(text.utf16), sp.start, n)
      let end = smallPrintEndRE.exec(after)
      let bodyStart = end.map { sp.start + $0.end } ?? sp.start
      var bodyEnd = n
      for m in oldFooterRE.all(text, from: bodyStart) { bodyEnd = m.start }  // the last one
      return (bodyStart, max(bodyStart, bodyEnd), "small_print")
    }
    return (0, n, "none")
  }

  /// `gutenbergRegions(text, {yHi, author})`: body bounds, regions, and W_NO_GUTENBERG_MARKERS when no marker matches.
  public static func regions(_ text: String, yHi: Int?, author: String?)
    -> (bodyStart: Int, bodyEnd: Int, marker: String, regions: [GutenbergRegion], issues: [RecordIssue])
  {
    let b = bounds(text)
    var issues: [RecordIssue] = []
    if b.marker == "none" {
      issues.append(RecordIssue(code: "W_NO_GUTENBERG_MARKERS", message: "No Project Gutenberg START/END markers; the whole file is the body.",
                                suggestion: "Check the file: licence text may be counted as book text until the boilerplate pass flags it."))
    }
    let r = bodyRegions(text, b.bodyStart, b.bodyEnd, yHi: yHi, author: author)
    return (b.bodyStart, b.bodyEnd, b.marker, r, issues)
  }

  /// Regions inside known body bounds: licence and producer-credit paragraphs → quality 'boilerplate'; editorial
  /// apparatus and transcriber residue → time_role/field_class 'apparatus'; sorted by start (stable).
  public static func bodyRegions(_ text: String, _ bodyStart: Int, _ bodyEnd: Int, yHi: Int?, author: String?) -> [GutenbergRegion] {
    let t = Text(text)
    var regions: [GutenbergRegion] = []
    let creditsUntil = bodyStart + max(2000, Int((Double(bodyEnd - bodyStart) * 0.05).rounded(.down)))
    for (s, e) in t.blocks(bodyStart, bodyEnd) {
      let block = t.slice(s, e)
      if licenceParagraphRE.test(block) || (s < creditsUntil && (creditsRE.test(block) || dpCreditRE.test(block))) {
        regions.append(GutenbergRegion(start: s, end: e, quality: "boilerplate", apparatus: false))
      }
    }
    regions += apparatusRegions(t, bodyStart, bodyEnd, yHi: yHi, author: author)
    regions += residueRegions(t, bodyStart, bodyEnd)
    return regions.enumerated().sorted { $0.element.start != $1.element.start ? $0.element.start < $1.element.start : $0.offset < $1.offset }
      .map(\.element)
  }

  static func namesOtherPerson(_ lines: [String], _ author: String?) -> Bool {
    let authorTokens = Set(nonLetters.split(JSString.toLowerCase(author ?? "")).filter { $0.utf16.count > 2 }.map(CodeUnits.init))
    for line in lines {
      guard let m = byNameRE.exec(line), let name = m.groups[0] else { continue }
      let words = nonLetters.split(JSString.toLowerCase(name)).filter { $0.utf16.count > 2 }
      if !words.isEmpty && !words.contains(where: { authorTokens.contains(CodeUnits($0)) }) { return true }
    }
    return false
  }

  static func hasLateYear(_ s: String, _ yHi: Int?) -> Bool {
    guard let yHi else { return false }
    return yearRE.all(s).contains { m in m.groups[0].map { Int($0) ?? 0 } ?? 0 > yHi + 5 }
  }

  /// Editorial apparatus (§4.3): a section headed PREFACE/INTRODUCTION/… in the first 15% or last 10% of the body
  /// that names another person in its first lines, carries a year > y_hi + 5, or is a transcriber's note; footnote
  /// blocks with such a year.
  static func apparatusRegions(_ t: Text, _ bodyStart: Int, _ bodyEnd: Int, yHi: Int?, author: String?) -> [GutenbergRegion] {
    var regions: [GutenbergRegion] = []
    let len = bodyEnd - bodyStart
    guard len > 0 else { return regions }
    let bl = t.blocks(bodyStart, bodyEnd)
    var i = 0
    while i < bl.count {
      let (s, e) = bl[i]
      let firstLine = JSString.trim(t.firstLine(s, e))
      let pos = Double(s - bodyStart) / Double(len)
      if firstLine.utf16.count <= 60 && apparatusHeadingRE.test(firstLine) && (pos <= apparatusFront || pos >= 1 - apparatusBack) {
        var j = i + 1
        let cap = s + max(2000, Int((Double(len) * apparatusFront).rounded(.down)))
        while j < bl.count && bl[j].0 < cap {
          let block = t.slice(bl[j].0, bl[j].1)
          let head = JSString.trim(t.firstLine(bl[j].0, bl[j].1))
          let isHeading = !block.utf16.contains(0x0A) && head.utf16.count <= 60
            && (nextSectionRE.test(head) || apparatusHeadingRE.test(head))
          if isHeading { break }
          j += 1
        }
        let end = j > i + 1 ? bl[j - 1].1 : e
        let body = t.slice(s, end)
        let firstLines = JSString.split(body, "\n").map { JSString.trim($0) }.filter { !$0.isEmpty }.prefix(4)
        if transcriberRE.test(firstLine) || namesOtherPerson(Array(firstLines), author) || hasLateYear(body, yHi) {
          regions.append(GutenbergRegion(start: s, end: end, quality: nil, apparatus: true))
        }
        i = j
        continue
      }
      let block = t.slice(s, e)
      if footnoteRE.test(t.slice(s, min(e, s + 40))) && hasLateYear(block, yHi) {
        regions.append(GutenbergRegion(start: s, end: e, quality: nil, apparatus: true))
      }
      i += 1
    }
    return regions
  }

  /// The `]` closing the `[` at `open` (nested brackets counted), or -1 within `limit` characters.
  static func closingBracket(_ t: Text, _ open: Int, _ limit: Int) -> Int {
    var depth = 0
    let stop = min(t.count, open + limit)
    var i = open
    while i < stop {
      let c = t.u[i]
      if c == 91 { depth += 1 } else if c == 93 {
        depth -= 1
        if depth == 0 { return i }
      }
      i += 1
    }
    return -1
  }

  /// Where a note that starts with a bare heading ends: an explicit "[End of Transcriber's Notes]", or the run of
  /// following blocks that read as notes (no cap in the last 10% of the body).
  static func headingNoteEnd(_ t: Text, _ bl: [(Int, Int)], _ i: Int, _ bodyStart: Int, _ bodyEnd: Int) -> Int {
    let from = bl[i].1
    let tail = t.slice(from, min(bodyEnd, from + noteMaxChars))
    if let mark = endNoteRE.exec(tail) { return from + mark.end }
    let back = Double(bl[i].0 - bodyStart) / Double(max(1, bodyEnd - bodyStart)) >= 1 - apparatusBack
    let maxBlocks = back ? Int.max : headingNoteBlocks, maxChars = back ? Int.max : headingNoteChars
    var end = bl[i].1
    var j = i + 1
    while j < bl.count && j - i <= maxBlocks && bl[j].0 - bl[i].0 < maxChars {
      let block = t.slice(bl[j].0, bl[j].1)
      let head = JSString.trim(t.firstLine(bl[j].0, bl[j].1))
      if nextSectionRE.test(head) || (apparatusHeadingRE.test(head) && !transcriberRE.test(head)) || !noteLikeRE.test(block) { break }
      end = bl[j].1
      j += 1
    }
    return end
  }

  /// Transcriber residue inside a body: bracketed transcriber's notes anywhere; a "Transcriber's Note(s)" heading and
  /// the note under it; an ASCII box around a note about the e-text; near the start or end of the body, the e-text's
  /// notes on its own transcription conventions. All of it is later editorial text: apparatus.
  static func residueRegions(_ t: Text, _ bodyStart: Int, _ bodyEnd: Int) -> [GutenbergRegion] {
    var out: [GutenbergRegion] = []
    func add(_ start: Int, _ end: Int) {
      let (s, e) = t.trim(max(bodyStart, start), min(bodyEnd, end))
      if e > s && !out.contains(where: { s >= $0.start && e <= $0.end }) {
        out.append(GutenbergRegion(start: s, end: e, quality: nil, apparatus: true))
      }
    }
    let len = max(1, bodyEnd - bodyStart)
    let frontUntil = bodyStart + max(residueFrontMin, Int((Double(len) * residueFront).rounded(.down)))
    let backFrom = bodyStart + Int((Double(len) * (1 - apparatusBack)).rounded(.down))
    let bl = t.blocks(bodyStart, bodyEnd)
    func blockAt(_ pos: Int) -> Int {
      var lo = 0, hi = bl.count - 1, best = -1
      while lo <= hi {
        let mid = (lo + hi) >> 1
        if bl[mid].0 <= pos { best = mid; lo = mid + 1 } else { hi = mid - 1 }
      }
      return best
    }

    // 1. "[Transcriber's Note: …]" anywhere; a bracket holding only the heading opens a note that runs on under it
    var from = bodyStart
    while let m = bracketNoteRE.exec(t.s, from: from), m.start < bodyEnd {
      let close = closingBracket(t, m.start, noteMaxChars)
      if close < 0 { from = max(m.end, m.start + 1); continue }
      let inside = JSString.trim(bracketNoteLeadRE.replaceFirst(t.slice(m.start + 1, close), with: ""))
      if inside.isEmpty {
        let i = blockAt(m.start)
        if i >= 0 { add(bl[i].0, headingNoteEnd(t, bl, i, bodyStart, bodyEnd)) }
      } else {
        add(m.start, close + 1)
      }
      from = close + 1
    }

    var i = 0
    while i < bl.count {
      let (s, e) = bl[i]
      let block = t.slice(s, e)
      let firstLine = t.firstLine(s, e)
      // 2. an ASCII box about the e-text
      if boxEdgeRE.test(firstLine) {
        let after = t.lineEnd(s) + 1
        let rest = t.slice(after, min(bodyEnd, after + noteMaxChars))
        if let bottom = boxBottomRE.exec(rest), boxTopicRE.test(JSText.slice(Array(rest.utf16), 0, bottom.start)) {
          add(s, t.lineEnd(after + bottom.start))
          while i + 1 < bl.count && bl[i + 1].0 < after + bottom.start { i += 1 }
          i += 1
          continue
        }
      }
      // 3. "Transcriber's Note(s)" as a heading, or a block that opens with it
      if !trimStart(firstLine).hasPrefix("[") && noteHeadingRE.test(firstLine) && transcriRE.test(firstLine) {
        let headingOnly = JSString.trim(noteHeadingRE.replaceFirst(block, with: "")).isEmpty
        add(s, headingOnly ? headingNoteEnd(t, bl, i, bodyStart, bodyEnd) : e)
        i += 1
        continue
      }
      // 4. the e-text's notes on its own transcription conventions, near the start or the end of the body
      if (s < frontUntil || s >= backFrom) && conventionRE.test(spaces.replaceAll(block, with: " ")) { add(s, e) }
      i += 1
    }
    return out.enumerated().sorted { $0.element.start != $1.element.start ? $0.element.start < $1.element.start : $0.offset < $1.offset }
      .map(\.element)
  }

  static func trimStart(_ s: String) -> String {
    let u = Array(s.utf16)
    var a = 0
    while a < u.count, JSText.isSpace(u[a]) { a += 1 }
    return String(decoding: u[a...], as: UTF16.self)
  }
}
