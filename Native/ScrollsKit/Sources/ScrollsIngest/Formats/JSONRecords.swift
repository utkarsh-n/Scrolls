// OWNER: N1
// Port of server/ingest/json.mjs and jsonl.mjs (SPEC §5.1, §5.5): JSON import — an array of objects, or the array chosen
// by JSON Pointer (RFC 6901) — and JSON Lines (one object per line, blank lines skipped, a bad line rejects only that
// line). `JSON.parse` is `JSONParser` (V8's messages); a skipping scanner finds where each element of the chosen array
// starts and ends, so every record has a line number and offsets into the original text. E_JSON_PARSE issues name the
// line and column as the reference does (V8's position when its message has one, else the reference's own RFC 8259
// scan).

import Foundation
import ScrollsContracts
import ScrollsCore

/// JSON and JSON Lines records.
public enum JSONRecords {
  static let maxCandidates = 8

  /// `pointerTokens(pointer)`: '' → [], '/items' → ['items'], '/a~1b/0' → ['a/b', '0'].
  public static func pointerTokens(_ pointer: String?) throws -> [String] {
    guard let p = pointer, !p.isEmpty else { return [] }
    guard p.hasPrefix("/") else { throw PointerError(message: "A JSON Pointer starts with '/' (got '\(p)').") }
    return JSString.split(String(p.dropFirst()), "/").map {
      JSString.split(JSString.split($0, "~1").joined(separator: "/"), "~0").joined(separator: "~")
    }
  }

  struct PointerError: Error { let message: String }

  /// `pointerOf(tokens)`.
  public static func pointerOf(_ tokens: [String]) -> String {
    tokens.map { "/" + JSString.split(JSString.split($0, "~").joined(separator: "~0"), "/").joined(separator: "~1") }.joined()
  }

  /// `getPointer(root, pointer)`: the value at a pointer, or nil.
  public static func getPointer(_ root: JSValue, _ tokens: [String]) -> JSValue? {
    var v = root
    for t in tokens {
      switch v {
      case .array(let a):
        let u = Array(t.utf16)
        guard !u.isEmpty, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), u.count == 1 || u[0] != 0x30, let k = Int(t), k < a.count else { return nil }
        v = a[k]
      case .object(let o):
        guard let x = o[t] else { return nil }
        v = x
      default: return nil
      }
    }
    return v
  }

  static func typeName(_ v: JSValue?) -> String {
    switch v {
    case nil: "undefined"
    case .null?: "null"
    case .array?: "an array"
    case .object?: "an object"
    case .string?: "a string"
    case .number?: "a number"
    case .bool?: "a boolean"
    }
  }

  /// `arrayCandidates(root)`: arrays of objects anywhere in the first three levels, largest first.
  public static func arrayCandidates(_ root: JSValue) -> [(pointer: String, count: Int)] {
    var out: [(pointer: String, count: Int, k: Int)] = []
    func walk(_ v: JSValue, _ tokens: [String], _ depth: Int) {
      if case .array(let a) = v {
        let objects = a.filter(\.isPlainObject).count
        if objects > 0 && Double(objects) >= Double(a.count) / 2 { out.append((pointerOf(tokens), a.count, out.count)) }
        return
      }
      guard case .object(let o) = v, depth < 3 else { return }
      for (k, x) in o.entries { walk(x, tokens + [k], depth + 1) }
    }
    walk(root, [], 0)
    return out.sorted { $0.count != $1.count ? $0.count > $1.count : $0.k < $1.k }.prefix(maxCandidates).map { ($0.pointer, $0.count) }
  }

  // MARK: offsets of the elements of one array (the text is valid JSON)

  static func skipWS(_ u: [UInt16], _ i0: Int) -> Int {
    var i = i0
    while i < u.count, u[i] == 32 || u[i] == 10 || u[i] == 13 || u[i] == 9 { i += 1 }
    return i
  }

  static func skipString(_ u: [UInt16], _ i: Int) -> Int {
    var j = i + 1
    while true {
      var k = j
      while k < u.count && u[k] != 0x22 { k += 1 }
      if k >= u.count { return u.count }
      var bs = 0, b = k - 1
      while b >= 0 && u[b] == 92 {
        bs += 1
        b -= 1
      }
      if bs % 2 == 0 { return k + 1 }
      j = k + 1
    }
  }

  static func skipValue(_ u: [UInt16], _ i: Int) -> Int {
    guard i < u.count else { return i }
    let c = u[i]
    if c == 34 { return skipString(u, i) }
    if c == 123 || c == 91 {
      var depth = 0
      var j = i
      while j < u.count {
        let d = u[j]
        if d == 34 {
          j = skipString(u, j)
          continue
        }
        if d == 123 || d == 91 { depth += 1 } else if d == 125 || d == 93 {
          depth -= 1
          if depth == 0 { return j + 1 }
        }
        j += 1
      }
      return u.count
    }
    var j = i
    while j < u.count {
      let d = u[j]
      if d == 44 || d == 93 || d == 125 || d == 32 || d == 10 || d == 13 || d == 9 { break }
      j += 1
    }
    return j
  }

  /// `elementSpans(text, tokens)`: [start, end) of every element of the array at `tokens`.
  public static func elementSpans(_ u: [UInt16], _ tokens: [String]) -> [(Int, Int)] {
    func at(_ k: Int) -> UInt16 { k < u.count ? u[k] : 0 }
    var i = skipWS(u, 0)
    for t in tokens {
      let c = at(i)
      if c == 123 {
        i = skipWS(u, i + 1)
        var found = false
        while at(i) == 34 {
          let kEnd = skipString(u, i)
          var keyParser = JSONParser(units: Array(u[i..<kEnd]))
          let key = (try? keyParser.document())?.stringValue
          i = skipWS(u, kEnd)
          i = skipWS(u, i + 1)  // ':'
          if let key, JSString.equal(key, t) {
            found = true
            break
          }
          i = skipWS(u, skipValue(u, i))
          if at(i) == 44 { i = skipWS(u, i + 1) }
        }
        if !found { return [] }
      } else if c == 91 {
        let want = Int(t) ?? -1
        i = skipWS(u, i + 1)
        var k = 0
        while k < want {
          if at(i) == 93 { return [] }
          i = skipWS(u, skipValue(u, i))
          if at(i) == 44 { i = skipWS(u, i + 1) }
          k += 1
        }
        if at(i) == 93 { return [] }
      } else {
        return []
      }
    }
    if at(i) != 91 { return [] }
    var spans: [(Int, Int)] = []
    i = skipWS(u, i + 1)
    while i < u.count && u[i] != 93 {
      let end = skipValue(u, i)
      spans.append((i, end))
      i = skipWS(u, end)
      if at(i) == 44 { i = skipWS(u, i + 1) }
    }
    return spans
  }

  /// `jsonErrorPosition(text)`: the index where `text` stops being valid JSON (its length when it ends too early), or nil.
  public static func jsonErrorPosition(_ u: [UInt16]) -> Int? {
    struct Fail: Error { let at: Int }
    let n = u.count
    var i = 0
    func isWS(_ c: UInt16) -> Bool { c == 32 || c == 9 || c == 10 || c == 13 }
    func ws() { while i < n && isWS(u[i]) { i += 1 } }
    func ch(_ k: Int) -> UInt16? { k < n ? u[k] : nil }
    func string() throws {
      i += 1
      while i < n {
        let c = u[i]
        if c == 34 { i += 1; return }
        if c < 0x20 { throw Fail(at: i) }
        if c == 92 {
          let e = ch(i + 1)
          if e == 0x75 {
            let hex = (2..<6).allSatisfy { k in ch(i + k).map { JSONParser.hex($0) != nil } ?? false }
            if !hex { i += 2; throw Fail(at: i) }
            i += 6
          } else if let e, [0x22, 0x5C, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74].contains(e) {
            i += 2
          } else {
            i += 1
            throw Fail(at: i)
          }
        } else {
          i += 1
        }
      }
      throw Fail(at: i)
    }
    func number() -> Bool {  // NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, matched at i
      var k = i
      func digit(_ p: Int) -> Bool { p < n && u[p] >= 0x30 && u[p] <= 0x39 }
      if ch(k) == 0x2D { k += 1 }
      if ch(k) == 0x30 { k += 1 } else if digit(k) && u[k] != 0x30 { while digit(k) { k += 1 } } else { return false }
      if ch(k) == 0x2E && digit(k + 1) {
        k += 1
        while digit(k) { k += 1 }
      }
      if ch(k) == 0x65 || ch(k) == 0x45 {
        var e = k + 1
        if ch(e) == 0x2B || ch(e) == 0x2D { e += 1 }
        if digit(e) {
          while digit(e) { e += 1 }
          k = e
        }
      }
      i = k
      return true
    }
    func value(_ depth: Int) throws {
      if depth > 512 { throw Fail(at: i) }
      ws()
      if i >= n { throw Fail(at: i) }
      let c = u[i]
      if c == 0x7B || c == 0x5B {
        let close: UInt16 = c == 0x7B ? 0x7D : 0x5D
        i += 1
        ws()
        if ch(i) == close { i += 1; return }
        while true {
          if c == 0x7B {
            ws()
            if ch(i) != 0x22 { throw Fail(at: i) }
            try string()
            ws()
            if ch(i) != 0x3A { throw Fail(at: i) }
            i += 1
          }
          try value(depth + 1)
          ws()
          if ch(i) == 0x2C { i += 1; continue }
          if ch(i) == close { i += 1; return }
          throw Fail(at: i)
        }
      }
      if c == 0x22 { return try string() }
      let save = i
      if number() && i > save && !(i == save + 1 && u[save] == 0x2D) { return }
      i = save
      for lit in ["true", "false", "null"] {
        let l = Array(lit.utf16)
        if i + l.count <= n && Array(u[i..<(i + l.count)]) == l { i += l.count; return }
        if l[0] == c {
          var k = 0
          while k < l.count && ch(i + k) == l[k] { k += 1 }
          i += k
          throw Fail(at: i)
        }
      }
      throw Fail(at: i)
    }
    do {
      try value(0)
      ws()
      if i < n { throw Fail(at: i) }
      return nil
    } catch let f as Fail {
      return f.at
    } catch {
      return nil
    }
  }

  /// `jsonParseIssue(err, text, {lineOffset, severity, wholeFile})`.
  public static func parseIssue(_ message: String, _ u: [UInt16], lineOffset: Int = 0, severity: String = "fatal",
                                wholeFile: Bool = true) -> Issue {
    var pos: Int?, line: Int?, col: Int?
    if let r = message.range(of: "at position ") {
      let rest = message[r.upperBound...]
      let digits = rest.prefix { $0.isASCII && $0.isNumber }
      pos = Int(digits)
      let after = rest.dropFirst(digits.count)
      if after.hasPrefix(" (line ") {
        let a = after.dropFirst(7)
        let l = a.prefix { $0.isASCII && $0.isNumber }
        let b = a.dropFirst(l.count)
        if b.hasPrefix(" column ") {
          let cc = b.dropFirst(8).prefix { $0.isASCII && $0.isNumber }
          if !l.isEmpty && !cc.isEmpty && b.dropFirst(8 + cc.count).hasPrefix(")") {
            line = Int(l)
            col = Int(cc)
          }
        }
      }
    }
    let lower = JSString.toLowerCase(message)
    let unexpectedEnd = lower.contains("unexpected end")
    if pos == nil && !unexpectedEnd, let at = jsonErrorPosition(u), at < u.count { pos = at }
    if let p = pos, line == nil {
      let before = u[0..<min(p, u.count)]
      line = before.filter { $0 == 0x0A }.count + 1
      col = p - (before.lastIndex(of: 0x0A) ?? -1)
    }
    if unexpectedEnd {
      let lines = JSString.split(String(decoding: u, as: UTF16.self), "\n")
      line = lines.count
      col = lines[lines.count - 1].utf16.count + 1
    }
    var du = Array(message.utf16)
    // .replace(/ in JSON at position \d+.*$/s, '')
    let marker = Array(" in JSON at position ".utf16)
    if du.count > marker.count {
      for k in 0...(du.count - marker.count) where Array(du[k..<(k + marker.count)]) == marker {
        let d = k + marker.count
        if d < du.count && du[d] >= 0x30 && du[d] <= 0x39 {
          du = Array(du[..<k])
          break
        }
      }
    }
    // .replace(/,\s.*\sis not valid JSON$/s, '')
    let tail = Array("is not valid JSON".utf16)
    if du.count >= tail.count + 1 && Array(du[(du.count - tail.count)...]) == tail {
      let m = du.count - tail.count
      if JSString.isWhitespace(du[m - 1]) {
        var k = 0
        while k + 2 <= m - 1 {
          if du[k] == 0x2C && JSString.isWhitespace(du[k + 1]) {
            du = Array(du[..<k])
            break
          }
          k += 1
        }
      }
    }
    var detail = String(decoding: du, as: UTF16.self)
    detail = JSString.trim(detail)
    let unexpectedToken = JSString.toLowerCase(detail).contains("unexpected token")
    let found: String
    if let p = pos, p < u.count, !unexpectedToken { found = " (found '\(String(decoding: [u[p]], as: UTF16.self))')" } else { found = "" }
    let absLine = line.map { $0 + lineOffset }
    let phrase = detail.isEmpty ? "not valid JSON" : JSString.toLowerCase(JSString.slice(detail, 0, 1)) + JSString.slice(detail, 1)
    let excerpt: String
    if let p = pos {
      excerpt = String(decoding: u[max(0, p - 40)..<min(u.count, p + 40)], as: UTF16.self)
    } else {
      excerpt = String(decoding: u[0..<min(u.count, 80)], as: UTF16.self)
    }
    return Issue(code: "E_JSON_PARSE", severity: severity, line: absLine, col: col, field: nil, valueExcerpt: excerpt,
      message: absLine.map { "Line \($0), column \(col!): \(phrase)\(found)." } ?? "The JSON could not be read: \(phrase).",
      suggestion: wholeFile
        ? "Fix the JSON at that position (one stray character makes the whole file unreadable), or export the records as JSON Lines, where a bad line only skips that line."
        : "Fix the JSON on this line (one complete object per line); the line was skipped, the other lines are imported.")
  }

  /// What `parseJson` gives.
  public struct Parsed: Sendable {
    public var records: [RawRecord]
    public var issues: [Issue]
    public var fatal: Issue?
    public var pointer: String?
    public var candidates: [(pointer: String, count: Int)]
  }

  /// `parseJson(text, {pointer})`: the records at `pointer` (nil = the root array, else the largest array of objects).
  public static func parse(_ text: [UInt16], pointer: String?) -> Parsed {
    let root: JSValue
    do {
      var p = JSONParser(units: text)
      root = try p.document()
    } catch {
      let fatal = parseIssue(error.message, text)
      return Parsed(records: [], issues: [fatal], fatal: fatal, pointer: pointer, candidates: [])
    }
    var issues: [Issue] = []
    let candidates = arrayCandidates(root)
    var chosen = pointer
    if chosen == nil {
      if case .array = root {
        chosen = ""
      } else if let first = candidates.first {
        chosen = first.pointer
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "info", line: 1, col: nil, field: nil, valueExcerpt: first.pointer,
          message: "The file is one object; its records were taken from the array at \(first.pointer) (\(first.count) items).",
          suggestion: candidates.count > 1
            ? "Other arrays: \(candidates.dropFirst().map { "\($0.pointer) (\($0.count))" }.joined(separator: ", ")). Choose one in the upload step if \(first.pointer) is not the right one."
            : "Nothing to do if these are the records."))
      } else {
        // a single object: one record
        return Parsed(records: [RawRecord(line: 1, start: 0, end: text.count, data: root.objectValue)], issues: issues, fatal: nil,
                      pointer: nil, candidates: candidates)
      }
    }
    let tokens: [String]
    do { tokens = try pointerTokens(chosen) } catch {
      let fatal = Issue(code: "E_FIELD_TYPE", severity: "fatal", line: nil, col: nil, field: nil, valueExcerpt: chosen ?? "",
        message: (error as? PointerError)?.message ?? "\(error)",
        suggestion: "Write the pointer as /key or /key/subkey (use '' for a top-level array).")
      return Parsed(records: [], issues: [fatal], fatal: fatal, pointer: chosen, candidates: candidates)
    }
    let found = getPointer(root, tokens)
    guard case .array(let arr)? = found else {
      let shown = (chosen ?? "").isEmpty ? "(top level)" : chosen!
      let fatal = Issue(code: "E_FIELD_TYPE", severity: "fatal", line: nil, col: nil, field: nil, valueExcerpt: chosen ?? "",
        message: "The JSON Pointer '\(shown)' leads to \(found == nil ? "nothing" : typeName(found)), not an array of records.",
        suggestion: candidates.isEmpty ? "The file has no array of objects to import."
          : "Arrays in this file: \(candidates.map { "\($0.pointer.isEmpty ? "(top level)" : $0.pointer) (\($0.count))" }.joined(separator: ", ")).")
      return Parsed(records: [], issues: [fatal], fatal: fatal, pointer: chosen, candidates: candidates)
    }
    let spans = elementSpans(text, tokens)
    var records: [RawRecord] = []
    var line = 1, at = 0
    for k in 0..<arr.count {
      let (start, end) = k < spans.count ? spans[k] : (0, text.count)
      var nl = at
      while nl < start && nl < text.count {
        if text[nl] == 0x0A { line += 1 }
        nl += 1
      }
      at = max(at, start)
      let v = arr[k]
      guard case .object(let o) = v else {
        var r = RawRecord(line: line, start: start, end: end, data: nil)
        r.issue = Issue(code: "E_FIELD_TYPE", severity: "rejected", line: line, col: nil, field: nil,
          valueExcerpt: JSString.slice(JSText.stringify(v), 0, 200),
          message: "Record \(k + 1) (line \(line)) is \(typeName(v)); expected an object.",
          suggestion: "Each record must be a JSON object such as {\"title\": \"…\", \"text\": \"…\"}; the record was skipped.")
        records.append(r)
        continue
      }
      records.append(RawRecord(line: line, start: start, end: end, data: o))
    }
    return Parsed(records: records, issues: issues, fatal: nil, pointer: chosen, candidates: candidates)
  }

  static func jsonlTypeName(_ v: JSValue) -> String {
    switch v {
    case .null: "null"
    case .array: "an array"
    case .string: "a string"
    case .number: "a number"
    case .bool: "boolean"
    case .object: "object"
    }
  }

  /// `jsonlRecords(text)`: one record per non-blank line; a line that is not a JSON object is rejected with its issue.
  public static func lines(_ text: [UInt16]) -> [RawRecord] {
    var out: [RawRecord] = []
    let n = text.count
    var start = 0, line = 1
    while start < n {
      var nl = start
      while nl < n && text[nl] != 0x0A { nl += 1 }
      var end = nl
      if end > start && text[end - 1] == 0x0D { end -= 1 }
      let raw = Array(text[start..<end])
      if !JSString.trim(String(decoding: raw, as: UTF16.self)).isEmpty {
        var issue: Issue?
        var data: JSValue?
        do {
          var p = JSONParser(units: raw)
          data = try p.document()
        } catch {
          issue = parseIssue(error.message, raw, lineOffset: line - 1, severity: "rejected", wholeFile: false)
        }
        if issue == nil, let d = data, !d.isPlainObject {
          issue = Issue(code: "E_FIELD_TYPE", severity: "rejected", line: line, col: 1, field: nil,
            valueExcerpt: JSString.slice(String(decoding: raw, as: UTF16.self), 0, 200),
            message: "Line \(line) is \(jsonlTypeName(d)); expected one JSON object per line.",
            suggestion: "Write each record as one object such as {\"title\": \"…\", \"text\": \"…\"} on its own line; the line was skipped.")
        }
        out.append(RawRecord(line: line, start: start, end: end, data: issue == nil ? data?.objectValue : nil, issue: issue))
      }
      start = nl + 1
      line += 1
    }
    return out
  }
}
