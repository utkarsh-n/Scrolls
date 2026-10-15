// OWNER: N1
// Port of server/ingest/txt.mjs, md.mjs and frontmatter.mjs (SPEC §5.1): one document per TXT or Markdown file.
// TXT: leading `Title:` / `Author:` / `Date:` / `Language:` lines (Gutenberg style) or a `---` front-matter block become
// metadata and stay in the original; the body starts after them (and, in a Project Gutenberg file, between the START and
// END markers, so the licence is never counted as text). Markdown: front matter as metadata, every ATX heading starts a
// passage (a segmentation region), the original keeps its markup. Front matter: a dependency-free YAML subset (scalars,
// inline and block lists, one level of nested keys, `|` and `>` blocks); anything else is kept as text with a warning.
// The reference's regular expressions are written out over UTF-16 code units with JavaScript's \s.

import Foundation
import ScrollsContracts
import ScrollsCore

/// A TXT or Markdown file as one record (`parseTxt` / `parseMd`).
public struct FileRecord: Sendable {
  public var data: JSObject
  public var document: FileDocument
  public var headerKind: String?
  public var issues: [Issue]
}

/// TXT, Markdown and front matter.
public enum TextFiles {
  static func isWS(_ u: UInt16) -> Bool { JSString.isWhitespace(u) }
  static func lower(_ u: UInt16) -> UInt16 { u >= 0x41 && u <= 0x5A ? u + 0x20 : u }

  /// `metaKey(k)`: 'Release Date' → 'release_date'.
  public static func metaKey(_ k: String) -> String {
    let t = Array(JSString.toLowerCase(JSString.trim(k)).utf16)
    var out: [UInt16] = []
    var i = 0
    while i < t.count {
      if isWS(t[i]) {
        while i < t.count && isWS(t[i]) { i += 1 }
        out.append(0x5F)
      } else {
        out.append(t[i])
        i += 1
      }
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// `fileStem(fileName)`: the file name without directory and extension.
  public static func fileStem(_ fileName: String?) -> String {
    let s = fileName ?? ""
    let parts = s.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }
    var base = String(parts.last ?? "")
    if base.isEmpty { base = "untitled" }
    let u = Array(base.utf16)
    if let dot = u.lastIndex(of: 0x2E), dot > 0 { base = String(decoding: u[..<dot], as: UTF16.self) }
    return base.isEmpty ? "untitled" : base
  }

  /// `/[\p{L}\p{N}]/u.test(s)`
  static func hasLetterOrNumber(_ u: ArraySlice<UInt16>) -> Bool {
    let table = TokenClassTable.lookup
    var i = u.startIndex
    while i < u.endIndex {
      var cp = UInt32(u[i]), len = 1
      if u[i] >= 0xD800, u[i] <= 0xDBFF, i + 1 < u.endIndex, u[i + 1] >= 0xDC00, u[i + 1] <= 0xDFFF {
        cp = 0x10000 + (UInt32(u[i] - 0xD800) << 10) + UInt32(u[i + 1] - 0xDC00)
        len = 2
      }
      if !table.classes(cp).isDisjoint(with: [.letter, .number]) { return true }
      i += len
    }
    return false
  }

  // MARK: TXT

  static let headerKeys: [[String]] = [
    ["title"], ["author"], ["authors"], ["date"], ["year"], ["language"], ["lang"], ["translator"], ["editor"], ["release", "date"],
    ["source"], ["url"], ["license"], ["licence"], ["genre"], ["kind"], ["community"], ["published"], ["publication", "date"],
    ["original", "publication"], ["credits"],
  ]

  /// `HEADER_LINE.exec(line)`: (key as written, value) of a `Key: value` line.
  static func headerLine(_ line: [UInt16]) -> (key: String, value: String)? {
    if line.contains(where: { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
    for words in headerKeys {
      var i = 0
      var ok = true
      for (w, word) in words.enumerated() {
        if w > 0 {  // \s+ between words
          let s = i
          while i < line.count && isWS(line[i]) { i += 1 }
          if i == s { ok = false; break }
        }
        for c in word.utf16 {
          guard i < line.count, lower(line[i]) == c else { ok = false; break }
          i += 1
        }
        if !ok { break }
      }
      guard ok else { continue }
      let keyEnd = i
      while i < line.count && isWS(line[i]) { i += 1 }
      guard i < line.count, line[i] == 0x3A else { continue }
      i += 1
      while i < line.count && isWS(line[i]) { i += 1 }
      var e = line.count
      while e > i && isWS(line[e - 1]) { e -= 1 }
      return (String(decoding: line[..<keyEnd], as: UTF16.self), String(decoding: line[i..<e], as: UTF16.self))
    }
    return nil
  }

  static func lineEnd(_ u: [UInt16], _ pos: Int, _ to: Int) -> Int {
    var nl = pos
    while nl < u.count && u[nl] != 0x0A { nl += 1 }
    return nl >= u.count || nl > to ? to : nl
  }

  /// `headerLines(text, from, to, {contiguous})`.
  static func headerLines(_ u: [UInt16], _ from: Int, _ to: Int, contiguous: Bool) -> (meta: JSObject, end: Int, seen: Int) {
    var meta = JSObject()
    var pos = from, end = from, seen = 0, lines = 0
    while pos < to && lines < 120 {
      let nl = lineEnd(u, pos, to)
      var line = Array(u[pos..<nl])
      if line.last == 0x0D { line.removeLast() }
      lines += 1
      if let m = headerLine(line) {
        let k = metaKey(m.key)
        if !meta.has(k) && !m.value.isEmpty { meta[k] = .string(m.value) }
        seen += 1
        end = min(nl + 1, to)
      } else if contiguous {
        if JSString.trim(String(decoding: line, as: UTF16.self)).isEmpty && seen == 0 {
          pos = nl + 1
          end = pos
          continue
        }
        break
      }
      pos = nl + 1
    }
    return (meta, end, seen)
  }

  /// Line-start positions of a text (0 and after every JavaScript line terminator), for /…/m patterns.
  static func lineStarts(_ u: [UInt16], from: Int = 0) -> [Int] {
    var out = [from]
    var i = from
    while i < u.count {
      let c = u[i]
      if c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029 { out.append(i + 1) }
      i += 1
    }
    return out
  }

  /// `^[ \t]*\*\*\*\s*(START|END) OF (?:THE |THIS )?PROJECT GUTENBERG E-?BOOK` at a line start (case-insensitive);
  /// returns (index, end of the matched prefix).
  static func gutenbergMarker(_ u: [UInt16], from: Int, word: String) -> (index: Int, end: Int)? {
    func lit(_ i: inout Int, _ s: String) -> Bool {
      for c in s.utf16 {
        guard i < u.count, lower(u[i]) == (c >= 0x41 && c <= 0x5A ? c + 0x20 : c) else { return false }
        i += 1
      }
      return true
    }
    for p in lineStarts(u, from: from) where p <= u.count {
      var i = p
      while i < u.count && (u[i] == 0x20 || u[i] == 0x09) { i += 1 }
      guard lit(&i, "***") else { continue }
      while i < u.count && isWS(u[i]) { i += 1 }
      guard lit(&i, word + " of ") else { continue }
      var j = i
      if lit(&j, "the ") || { j = i; return lit(&j, "this ") }() { i = j }
      guard lit(&i, "project gutenberg e") else { continue }
      if i < u.count && u[i] == 0x2D { i += 1 }
      guard lit(&i, "book") else { continue }
      return (p, i)
    }
    return nil
  }

  /// `parseTxt(text, {fileName, lineMode})`.
  public static func parseTxt(_ text: String, fileName: String?, lineMode: Bool) -> FileRecord {
    let u = Array(text.utf16)
    var issues: [Issue] = []
    var meta = JSObject(), bodyStart = 0, bodyEnd = u.count
    var kind: String?
    let fm = parseFrontMatter(u)
    issues += fm.issues
    if fm.present {
      for (k, v) in fm.data.entries { meta[metaKey(k)] = v }
      bodyStart = fm.bodyStart
      kind = "front_matter"
    } else if let start = gutenbergMarker(u, from: 0, word: "start") {
      // PG_START ends with [^\n]*$: the match runs to the end of its line
      var afterStart = start.end
      while afterStart < u.count && u[afterStart] != 0x0A { afterStart += 1 }
      let endM = gutenbergMarker(u, from: afterStart, word: "end")
      meta = headerLines(u, 0, start.index, contiguous: false).meta
      var nl = afterStart
      while nl < u.count && u[nl] != 0x0A { nl += 1 }
      bodyStart = min(u.count, nl >= u.count ? u.count : nl + 1)
      bodyEnd = endM?.index ?? u.count
      kind = "gutenberg"
    } else {
      let h = headerLines(u, 0, u.count, contiguous: true)
      var nl = h.end
      while nl < u.count && u[nl] != 0x0A { nl += 1 }
      let next = String(decoding: u[h.end..<nl], as: UTF16.self)
      if h.seen > 0 && JSString.trim(next).isEmpty {
        meta = h.meta
        bodyStart = h.end
        kind = "header_lines"
      }
    }
    // the body starts at its first non-blank line (blank lines after a header are not body)
    if kind != nil {
      while true {
        var nl = bodyStart
        while nl < u.count && u[nl] != 0x0A { nl += 1 }
        guard nl < u.count, nl < bodyEnd, JSString.trim(String(decoding: u[bodyStart..<nl], as: UTF16.self)).isEmpty else { break }
        bodyStart = nl + 1
      }
    }
    if bodyEnd < bodyStart { bodyEnd = bodyStart }
    if !hasLetterOrNumber(u[bodyStart..<bodyEnd]) {
      issues.append(Issue(code: "E_MISSING_TEXT", severity: "warning", line: nil, col: nil, field: "text", valueExcerpt: nil,
        message: "\(fileName ?? "The file") has no words after its metadata; it will be imported as a title only.",
        suggestion: "Check that this is the right file; a text file needs body text to be searchable."))
    }
    var data = meta
    if data["title"] == nil || data["title"]?.isNull == true || data["title"]?.stringValue == "" { data["title"] = .string(fileStem(fileName)) }
    data["file_name"] = .string(fileName ?? "")
    data["text"] = .string(String(decoding: u[bodyStart..<bodyEnd], as: UTF16.self))
    return FileRecord(data: data, document: FileDocument(original: text, bodyStart: bodyStart, bodyEnd: bodyEnd, regions: [],
                                                         mode: lineMode ? "verse" : "auto"), headerKind: kind, issues: issues)
  }

  // MARK: Markdown

  /// `ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/`: (level, text) of a heading line.
  static func atx(_ line: [UInt16]) -> (level: Int, text: String)? {
    if line.contains(where: { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
    var i = 0
    while i < 3 && i < line.count && line[i] == 0x20 { i += 1 }
    let h0 = i
    while i < line.count && line[i] == 0x23 && i - h0 < 6 { i += 1 }
    let level = i - h0
    guard level >= 1, i < line.count, line[i] == 0x20 || line[i] == 0x09 else { return nil }
    while i < line.count && (line[i] == 0x20 || line[i] == 0x09) { i += 1 }
    // the shortest capture: drop the longest suffix of the form [ \t]*#*[ \t]*
    var e = line.count
    while e > i && (line[e - 1] == 0x20 || line[e - 1] == 0x09) { e -= 1 }
    while e > i && line[e - 1] == 0x23 { e -= 1 }
    while e > i && (line[e - 1] == 0x20 || line[e - 1] == 0x09) { e -= 1 }
    return (level, String(decoding: line[i..<e], as: UTF16.self))
  }

  /// `FENCE = /^ {0,3}(`{3,}|~{3,})/`: the fence character, or nil.
  static func fence(_ line: [UInt16]) -> UInt16? {
    var i = 0
    while i < 3 && i < line.count && line[i] == 0x20 { i += 1 }
    guard i < line.count, line[i] == 0x60 || line[i] == 0x7E else { return nil }
    let c = line[i]
    var n = 0
    while i < line.count && line[i] == c { i += 1; n += 1 }
    return n >= 3 ? c : nil
  }

  /// `headingStarts(text, from, to)`: ATX heading lines in [from, to), ignoring fenced code blocks.
  static func headingStarts(_ u: [UInt16], _ from: Int, _ to: Int) -> [(start: Int, level: Int, text: String)] {
    var out: [(start: Int, level: Int, text: String)] = []
    var pos = from
    var open: UInt16?
    while pos < to {
      let nl = lineEnd(u, pos, to)
      var line = Array(u[pos..<nl])
      if line.last == 0x0D { line.removeLast() }
      if let f = fence(line) {
        if open == nil { open = f } else if f == open { open = nil }
      } else if open == nil, let h = atx(line) {
        out.append((pos, h.level, h.text))
      }
      pos = nl + 1
    }
    return out
  }

  /// `parseMd(text, {fileName, lineMode})`.
  public static func parseMd(_ text: String, fileName: String?, lineMode: Bool) -> FileRecord {
    let u = Array(text.utf16)
    let fm = parseFrontMatter(u)
    var issues = fm.issues
    var meta = JSObject()
    if fm.present { for (k, v) in fm.data.entries { meta[metaKey(k)] = v } }
    let bodyStart = fm.present ? fm.bodyStart : 0
    let bodyEnd = u.count
    let heads = headingStarts(u, bodyStart, bodyEnd)
    var regions: [TextRegion] = []
    if let first = heads.first {
      if first.start > bodyStart && u[bodyStart..<first.start].contains(where: { !isWS($0) }) {
        regions.append(TextRegion(start: bodyStart, end: first.start))
      }
      for (k, h) in heads.enumerated() { regions.append(TextRegion(start: h.start, end: k + 1 < heads.count ? heads[k + 1].start : bodyEnd)) }
    }
    var data = meta
    if data["title"] == nil || data["title"]?.isNull == true || data["title"]?.stringValue == "" {
      if let h1 = heads.first(where: { $0.level == 1 }) {
        let stripped = String(decoding: Array(h1.text.utf16).filter { $0 != 0x2A && $0 != 0x5F && $0 != 0x60 }, as: UTF16.self)
        let t = JSString.trim(stripped)
        data["title"] = .string(t.isEmpty ? fileStem(fileName) : t)
      } else {
        data["title"] = .string(fileStem(fileName))
      }
    }
    data["file_name"] = .string(fileName ?? "")
    data["text"] = .string(String(decoding: u[bodyStart..<bodyEnd], as: UTF16.self))
    if !hasLetterOrNumber(u[bodyStart..<bodyEnd]) {
      issues.append(Issue(code: "E_MISSING_TEXT", severity: "warning", line: nil, col: nil, field: "text", valueExcerpt: nil,
        message: "\(fileName ?? "The file") has no words after its front matter; it will be imported as a title only.",
        suggestion: "Check that this is the right file; a Markdown file needs body text to be searchable."))
    }
    return FileRecord(data: data, document: FileDocument(original: text, bodyStart: bodyStart, bodyEnd: bodyEnd, regions: regions,
                                                         mode: lineMode ? "verse" : "auto"),
                      headerKind: fm.present ? "front_matter" : nil, issues: issues)
  }

  // MARK: front matter

  /// What `parseFrontMatter` gives.
  public struct FrontMatter: Sendable {
    public var present: Bool
    public var data: JSObject
    public var bodyStart: Int
    public var endLine: Int
    public var issues: [Issue]
  }

  /// `---[ \t]*\r?$` / `(---|...)[ \t]*\r?$` on a whole line.
  static func dashLine(_ line: ArraySlice<UInt16>, close: Bool) -> Bool {
    var l = Array(line)
    if l.last == 0x0D { l.removeLast() }
    while let last = l.last, last == 0x20 || last == 0x09 { l.removeLast() }
    return l == Array("---".utf16) || (close && l == Array("...".utf16))
  }

  static func unquote(_ s: String) -> String {
    let t = JSString.trim(s)
    let u = Array(t.utf16)
    if u.count >= 2 && u.first == 0x22 && u.last == 0x22 {
      if let v = try? JSONParser.parse(t), let str = v.stringValue { return str }
      return String(decoding: u[1..<(u.count - 1)], as: UTF16.self)
    }
    if u.count >= 2 && u.first == 0x27 && u.last == 0x27 {
      return JSString.split(String(decoding: u[1..<(u.count - 1)], as: UTF16.self), "''").joined(separator: "'")
    }
    return t
  }

  /// Strips a trailing ` # comment` outside quotes.
  static func stripComment(_ s: String) -> String {
    let u = Array(s.utf16)
    var q: UInt16?
    for i in u.indices {
      let c = u[i]
      if let open = q {
        if c == open { q = nil }
        continue
      }
      if c == 0x22 || c == 0x27 { q = c } else if c == 0x23 && (i == 0 || isWS(u[i - 1])) {
        return String(decoding: u[..<i], as: UTF16.self)
      }
    }
    return s
  }

  /// `[a, "b, c", 'd']` → ['a', 'b, c', 'd']
  static func inlineList(_ s: String) -> [String] {
    let t = Array(JSString.trim(s).utf16)
    let inner = t.count >= 2 ? Array(t[1..<(t.count - 1)]) : []
    var out: [[UInt16]] = []
    var cur: [UInt16] = []
    var q: UInt16?
    for c in inner {
      if let open = q {
        cur.append(c)
        if c == open { q = nil }
        continue
      }
      if c == 0x22 || c == 0x27 {
        q = c
        cur.append(c)
        continue
      }
      if c == 0x2C {
        out.append(cur)
        cur = []
        continue
      }
      cur.append(c)
    }
    if !JSString.trim(String(decoding: cur, as: UTF16.self)).isEmpty || !out.isEmpty { out.append(cur) }
    return out.map { unquote(String(decoding: $0, as: UTF16.self)) }.filter { !$0.isEmpty }
  }

  static func scalar(_ raw: String) -> JSValue {
    let s = JSString.trim(stripComment(raw))
    if s.isEmpty || s == "~" || s == "null" { return .null }
    if s.hasPrefix("[") && s.hasSuffix("]") { return .array(inlineList(s).map(JSValue.string)) }
    return .string(unquote(s))
  }

  /// `^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$` (with `indented` the line must start with \s+ first).
  static func keyValue(_ l: [UInt16], indented: Bool) -> (key: String, rest: String?)? {
    if l.contains(where: { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
    var i = 0
    if indented {
      while i < l.count && isWS(l[i]) { i += 1 }
      if i == 0 { return nil }
    }
    guard i < l.count, !isWS(l[i]), l[i] != 0x3A, l[i] != 0x23 else { return nil }
    let k0 = i
    while i < l.count && l[i] != 0x3A { i += 1 }
    guard i < l.count else { return nil }
    let key = String(decoding: l[k0..<i], as: UTF16.self)
    i += 1
    if i == l.count { return (key, nil) }
    guard isWS(l[i]) else { return nil }
    let s = i
    while i < l.count && isWS(l[i]) { i += 1 }
    if i == l.count { return (key, s == i ? nil : "") }
    return (key, String(decoding: l[i...], as: UTF16.self))
  }

  /// `parseFrontMatter(text)`: a leading `---` block.
  public static func parseFrontMatter(_ u: [UInt16]) -> FrontMatter {
    var issues: [Issue] = []
    let none = { (i: [Issue]) in FrontMatter(present: false, data: JSObject(), bodyStart: 0, endLine: 0, issues: i) }
    let firstNl = u.firstIndex(of: 0x0A)
    let firstLine = firstNl.map { u[..<$0] } ?? u[...]
    guard dashLine(firstLine, close: false) else { return none([]) }
    var lines: [(ln: Int, text: [UInt16])] = []
    var pos = firstNl.map { $0 + 1 } ?? u.count
    var closeAt = -1, closeLine = 0
    var ln = 2
    while pos <= u.count && ln <= 501 {
      let nl = u[pos...].firstIndex(of: 0x0A)
      let lineText = u[pos..<(nl ?? u.count)]
      if dashLine(lineText, close: true) {
        closeAt = nl.map { $0 + 1 } ?? u.count
        closeLine = ln
        break
      }
      var t = Array(lineText)
      if t.last == 0x0D { t.removeLast() }
      lines.append((ln, t))
      guard let n = nl else { break }
      pos = n + 1
      ln += 1
    }
    if closeAt < 0 {
      issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: 1, col: 1, field: "front matter", valueExcerpt: "---",
        message: "The file opens a front-matter block (---) on line 1 that is never closed; it was read as ordinary text.",
        suggestion: "Add a closing --- line after the metadata, or remove the opening ---."))
      return none(issues)
    }
    var data = JSObject()
    var i = 0
    func str(_ t: [UInt16]) -> String { String(decoding: t, as: UTF16.self) }
    while i < lines.count {
      let (ln, l) = lines[i]
      let trimmed = JSString.trim(str(l))
      if trimmed.isEmpty || trimmed.hasPrefix("#") {
        i += 1
        continue
      }
      let m = keyValue(l, indented: false)
      if m == nil || isWS(l[0]) {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: ln, col: 1, field: "front matter",
          valueExcerpt: JSString.slice(str(l), 0, 200),
          message: "Front-matter line \(ln) is not a 'key: value' pair; it was kept in the text but not read as metadata.",
          suggestion: "Use one key: value per line, lists as [a, b] or \"- item\" lines."))
        i += 1
        continue
      }
      let key = JSString.trim(m!.key)
      let rest = JSString.trim(m!.rest ?? "")
      i += 1
      if rest == "|" || rest == ">" || rest == "|-" || rest == ">-" {
        var block: [String] = []
        while i < lines.count && (JSString.trim(str(lines[i].text)).isEmpty || isWS(lines[i].text.first ?? 0x41)) {
          block.append(JSString.trim(str(lines[i].text)))
          i += 1
        }
        while block.last == "" { block.removeLast() }
        if rest.hasPrefix("|") {
          data[key] = .string(block.joined(separator: "\n"))
        } else {
          data[key] = .string(JSString.trim(collapse(block.joined(separator: " "))))
        }
        continue
      }
      if !rest.isEmpty {
        data[key] = scalar(rest)
        continue
      }
      // empty value: a block list, a nested map, or null
      var items: [JSValue] = []
      var nested = JSObject()
      var kind: String?
      while i < lines.count && isListOrIndented(lines[i].text) {
        let t = lines[i].text
        if let item = listItem(t), kind != "map" {
          kind = "list"
          items.append(scalar(item))
          i += 1
          continue
        }
        if let kv = keyValue(t, indented: true), kind != "list" {
          kind = "map"
          nested[JSString.trim(kv.key)] = scalar(kv.rest ?? "")
          i += 1
          continue
        }
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: lines[i].ln, col: 1, field: key,
          valueExcerpt: JSString.slice(str(t), 0, 200),
          message: "Front-matter line \(lines[i].ln) under '\(key)' mixes list items and keys; it was not read.",
          suggestion: "Write '\(key)' either as a list (\"- item\" lines) or as indented key: value pairs."))
        i += 1
      }
      data[key] = kind == "list" ? .array(items.filter { !$0.isNull }) : kind == "map" ? .object(nested) : .null
    }
    return FrontMatter(present: true, data: data, bodyStart: closeAt, endLine: closeLine, issues: issues)
  }

  /// `/\s+/g → ' '`
  static func collapse(_ s: String) -> String {
    var out: [UInt16] = []
    var inWS = false
    for c in s.utf16 {
      if isWS(c) {
        if !inWS { out.append(0x20) }
        inWS = true
      } else {
        out.append(c)
        inWS = false
      }
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// `/^\s*-\s+|^\s+\S/`
  static func isListOrIndented(_ t: [UInt16]) -> Bool {
    var i = 0
    while i < t.count && isWS(t[i]) { i += 1 }
    if i < t.count && t[i] == 0x2D && i + 1 < t.count && isWS(t[i + 1]) { return true }
    return i > 0 && i < t.count
  }

  /// `/^\s*-\s+(.*)$/`: the item text.
  static func listItem(_ t: [UInt16]) -> String? {
    if t.contains(where: { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
    var i = 0
    while i < t.count && isWS(t[i]) { i += 1 }
    guard i < t.count, t[i] == 0x2D, i + 1 < t.count, isWS(t[i + 1]) else { return nil }
    i += 1
    while i < t.count && isWS(t[i]) { i += 1 }
    return String(decoding: t[i...], as: UTF16.self)
  }
}
