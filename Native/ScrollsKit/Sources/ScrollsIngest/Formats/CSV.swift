// OWNER: N1
// Port of server/ingest/csv.mjs (SPEC §5.1, §5.5): an RFC 4180 CSV/TSV state machine with delimiter sniffing. Quoted
// fields, embedded newlines, "" escapes; CRLF, LF and lone CR line ends. Offsets are UTF-16 code units into the decoded
// text (the BOM was already stripped). A record's `line` is the physical line it starts on, so "Row 57" in a message is
// the record that starts on line 57 of the file. Lenient where RFC 4180 is strict and nothing is lost: a quote inside an
// unquoted field and characters after a closing quote are kept as written.

import Foundation
import ScrollsContracts
import ScrollsCore

/// One raw CSV record (`{fields, line, start, end}`) or the unclosed quote that ended the file.
public enum CSVRecord: Sendable {
  case record(fields: [String], line: Int, start: Int, end: Int)
  case error(line: Int, col: Int, fieldIndex: Int, start: Int, recStart: Int, recLine: Int)
}

/// A record of an import file (`RawRecord` of pipeline.mjs).
public struct RawRecord: Sendable {
  public var line: Int?
  public var start: Int
  public var end: Int
  public var ordinal: Int = 0
  public var data: JSObject?
  public var issue: Issue?
  public var warnings: [Issue] = []
  public var document: FileDocument?
  public var headerKind: String?
  public var byteStart: Int?
  public var byteEnd: Int?
  /// A problem that ends the file (an unclosed quote, a mid-file encoding error).
  public var fatal: Issue?

  public init(line: Int?, start: Int, end: Int, data: JSObject?, issue: Issue? = nil, warnings: [Issue] = []) {
    self.line = line
    self.start = start
    self.end = end
    self.data = data
    self.issue = issue
    self.warnings = warnings
  }

  static func fatal(_ i: Issue) -> RawRecord {
    var r = RawRecord(line: nil, start: 0, end: 0, data: nil)
    r.fatal = i
    return r
  }
}

/// The body of a TXT or Markdown file record (`document` of txt.mjs / md.mjs).
public struct FileDocument: Sendable {
  public var original: String
  public var bodyStart: Int
  public var bodyEnd: Int
  public var regions: [TextRegion]
  public var mode: String
}

/// CSV and TSV parsing.
public enum CSV {
  /// Delimiters the sniffer tries, in tie-break order.
  public static let delimiters: [UInt16] = [0x2C, 0x09, 0x3B, 0x7C]
  /// Human names for messages.
  public static func delimiterName(_ d: String) -> String? {
    switch d {
    case ",": "comma"
    case "\t": "tab"
    case ";": "semicolon"
    case "|": "pipe"
    default: nil
    }
  }

  static let sniffRecords = 50
  static let sniffChars = 65536

  /// `csvRecords(text, {delimiter})`: blank lines are skipped; an unclosed quote ends the iteration with `.error`.
  public static func records(_ text: ArraySlice<UInt16>, delimiter: UInt16, limit: Int = .max) -> [CSVRecord] {
    var out: [CSVRecord] = []
    let base = text.startIndex
    let n = text.count
    func ch(_ k: Int) -> UInt16 { text[base + k] }
    func str(_ a: Int, _ b: Int) -> String { String(decoding: text[(base + a)..<(base + b)], as: UTF16.self) }
    var i = 0, line = 1, lineStart = 0
    while i < n && out.count < limit {
      let recStart = i, recLine = line
      var fields: [String] = []
      var quotedAny = false, end = i
      while true {
        var value: String
        if i < n && ch(i) == 0x22 {
          quotedAny = true
          let qStart = i, qLine = line, qCol = i - lineStart + 1
          var j = i + 1
          var parts: [UInt16] = []
          while true {
            var k = j
            while k < n && ch(k) != 0x22 { k += 1 }
            if k >= n {
              out.append(.error(line: qLine, col: qCol, fieldIndex: fields.count, start: qStart, recStart: recStart, recLine: recLine))
              return out
            }
            // line bookkeeping for newlines inside the quoted run
            var nl = j
            while nl < k {
              if ch(nl) == 0x0A {
                line += 1
                lineStart = nl + 1
              }
              nl += 1
            }
            parts += text[(base + j)..<(base + k)]
            if k + 1 < n && ch(k + 1) == 0x22 {
              parts.append(0x22)
              j = k + 2
              continue
            }
            i = k + 1
            break
          }
          // characters between the closing quote and the delimiter are kept (lenient)
          var j2 = i
          while j2 < n {
            let c = ch(j2)
            if c == delimiter || c == 0x0A || c == 0x0D { break }
            j2 += 1
          }
          if j2 > i {
            parts += text[(base + i)..<(base + j2)]
            i = j2
          }
          value = String(decoding: parts, as: UTF16.self)
        } else {
          var j = i
          while j < n {
            let c = ch(j)
            if c == delimiter || c == 0x0A || c == 0x0D { break }
            j += 1
          }
          value = str(i, j)
          i = j
        }
        fields.append(value)
        end = i
        if i < n && ch(i) == delimiter {
          i += 1
          continue
        }
        if i < n {  // line break
          if ch(i) == 0x0D { i += 1 }
          if i < n && ch(i) == 0x0A { i += 1 }
          line += 1
          lineStart = i
        }
        break
      }
      if fields.count == 1 && fields[0].isEmpty && !quotedAny { continue }  // blank line
      out.append(.record(fields: fields, line: recLine, start: recStart, end: end))
    }
    return out
  }

  /// `sniffDelimiterDetail(text)`: each candidate scored by how consistently it splits the first records.
  public static func sniffDelimiterDetail(_ text: [UInt16]) -> (delimiter: String, consistency: Double, fields: Int, records: Int) {
    let sample = text.count > sniffChars ? text[0..<sniffChars] : text[...]
    let truncated = sample.count < text.count
    var best: (delimiter: String, consistency: Double, fields: Int, records: Int) = (",", 0, 1, 0)
    for d in delimiters {
      var counts: [Int] = []
      for r in records(sample, delimiter: d, limit: sniffRecords + 1) {
        guard case .record(let fields, _, _, _) = r else { break }
        counts.append(fields.count)
        if counts.count > sniffRecords { break }
      }
      if truncated && counts.count > 1 { counts.removeLast() }  // the last record may be cut at 64 KB
      if counts.isEmpty { continue }
      var order: [Int] = []
      var freq: [Int: Int] = [:]
      for c in counts {
        if freq[c] == nil { order.append(c) }
        freq[c, default: 0] += 1
      }
      var mode = 1, modeN = 0
      for c in order {
        let k = freq[c]!
        if k > modeN || (k == modeN && c > mode) {
          mode = c
          modeN = k
        }
      }
      let consistency = Double(modeN) / Double(counts.count)
      if mode < 2 { continue }
      if consistency > best.consistency + 1e-9 || (abs(consistency - best.consistency) < 1e-9 && mode > best.fields) {
        best = (String(decoding: [d], as: UTF16.self), consistency, mode, counts.count)
      }
    }
    return best
  }

  /// `sniffDelimiter(text)`.
  public static func sniffDelimiter(_ text: [UInt16]) -> String { sniffDelimiterDetail(text).delimiter }

  /// `/^[-+]?(\d+([.,]\d+)?|\d{1,3}([,.]\d{3})+([.,]\d+)?)%?$/` on the trimmed value.
  static func isNumeric(_ s: String) -> Bool {
    let u = Array(JSString.trim(s).utf16)
    var i = 0
    if i < u.count && (u[i] == 0x2D || u[i] == 0x2B) { i += 1 }
    func digits(_ from: Int) -> Int { var k = from; while k < u.count && u[k] >= 0x30 && u[k] <= 0x39 { k += 1 }; return k }
    func tail(_ from: Int) -> Bool {  // ([.,]\d+)?%?$
      var k = from
      if k < u.count && (u[k] == 0x2E || u[k] == 0x2C) {
        let e = digits(k + 1)
        if e > k + 1 { k = e } else { return false }
      }
      if k < u.count && u[k] == 0x25 { k += 1 }
      return k == u.count
    }
    // alternative 1: \d+([.,]\d+)?%?$  (with backtracking on the optional fraction)
    let d1 = digits(i)
    if d1 > i {
      if tail(d1) { return true }
      if d1 < u.count && u[d1] == 0x25 && d1 + 1 == u.count { return true }
      if d1 == u.count { return true }
    }
    // alternative 2: \d{1,3}([,.]\d{3})+([.,]\d+)?%?$
    for lead in 1...3 {
      guard i + lead <= u.count, digits(i) >= i + lead else { break }
      var k = i + lead
      var groups = 0
      // greedy groups with backtracking to any group count ≥ 1
      var ends: [Int] = []
      while k + 4 <= u.count && (u[k] == 0x2C || u[k] == 0x2E) && digits(k + 1) >= k + 4 {
        k += 4
        groups += 1
        ends.append(k)
      }
      for e in ends.reversed() where tail(e) { return true }
    }
    return false
  }

  /// `/^\d{4}([-/.]\d{1,2}){0,2}$/` on the trimmed value.
  static func isIsoish(_ s: String) -> Bool {
    let u = Array(JSString.trim(s).utf16)
    func isDigit(_ k: Int) -> Bool { k < u.count && u[k] >= 0x30 && u[k] <= 0x39 }
    guard u.count >= 4, (0..<4).allSatisfy(isDigit) else { return false }
    // any split of the rest into ≤ 2 groups of [-/.] + 1–2 digits
    func rest(_ k: Int, _ groups: Int) -> Bool {
      if k == u.count { return true }
      guard groups < 2, k < u.count, u[k] == 0x2D || u[k] == 0x2F || u[k] == 0x2E else { return false }
      if isDigit(k + 1) {
        if rest(k + 2, groups + 1) { return true }
        if isDigit(k + 2) && rest(k + 3, groups + 1) { return true }
      }
      return false
    }
    return rest(4, 0)
  }

  /// `sniffHeader(firstRecords)`: whether the first record looks like a header.
  public static func sniffHeader(_ firstRecords: [[String]]) -> Bool {
    guard let head = firstRecords.first else { return true }
    let rest = firstRecords.dropFirst()
    if head.contains(where: { JSString.trim($0).isEmpty }) { return rest.isEmpty }
    if Set(head.map { UnitKey(JSString.toLowerCase(JSString.trim($0))) }).count != head.count { return false }
    let typed = head.map { isNumeric($0) || isIsoish($0) }
    if !typed.contains(true) { return true }
    // a numeric "header" cell under a numeric column means the first row is data
    return !head.indices.contains { i in
      typed[i] && !rest.isEmpty && rest.allSatisfy { r in i >= r.count || isNumeric(r[i]) || isIsoish(r[i]) }
    }
  }

  /// `columnNames(headerFields)`: trimmed, blanks named by position, duplicates suffixed " (2)".
  public static func columnNames(_ headerFields: [String]) -> [String] {
    var used = Set<UnitKey>()
    return headerFields.enumerated().map { i, raw in
      let t = JSString.trim(raw)
      let base = t.isEmpty ? "column \(i + 1)" : t
      var name = base, k = 1
      while used.contains(UnitKey(name)) {
        k += 1
        name = "\(base) (\(k))"
      }
      used.insert(UnitKey(name))
      return name
    }
  }

  /// Positional column names for header-less files: col1, col2, …
  public static func positionalName(_ i: Int) -> String { "col\(i + 1)" }

  /// A table opened from CSV text (`openCsv`).
  public struct Table: Sendable {
    public var columns: [String]
    public var issues: [Issue]
    public var rows: [RawRecord]
    public var fatal: Issue?
  }

  /// `openCsv(text, {delimiter, header})`: the header (or positional names) and the RawRecords; a rejected row carries
  /// `issue` (E_ROW_RAGGED) and no data; an unclosed quote ends the rows with a `fatal` record.
  public static func open(_ text: [UInt16], delimiter: String, header: Bool) -> Table {
    let d = delimiter.utf16.first ?? 0x2C
    let raws = records(text[...], delimiter: d)
    var issues: [Issue] = []
    guard let first = raws.first else { return Table(columns: [], issues: [], rows: [], fatal: nil) }
    guard case .record(let firstFields, let firstLine, _, _) = first else {
      let fatal = quoteIssue(first, [])
      return Table(columns: [], issues: [fatal], rows: [], fatal: fatal)
    }
    let columns = header ? columnNames(firstFields) : firstFields.indices.map(positionalName)
    if header {
      for (i, c) in columns.enumerated() {
        let raw = JSString.trim(firstFields[i])
        if JSString.equal(c, raw) { continue }
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: firstLine, col: nil, field: c,
          valueExcerpt: raw.isEmpty ? nil : raw,
          message: raw.isEmpty ? "Column \(i + 1) has no name in the header; it is shown as '\(c)'." : "Two columns are named '\(raw)'; the later one is shown as '\(c)'.",
          suggestion: raw.isEmpty ? "Give the column a name in the header row, or leave it unmapped." : "Rename one of the columns in the file if they hold different things."))
      }
    }
    var lengths = [Double](repeating: 0, count: columns.count)
    var statRows = 0
    func suspectColumn(_ fields: [String]) -> String {
      // the column whose values are longest so far is where a stray delimiter most likely hides
      if statRows > 0 {
        var best = 0
        for k in 1..<max(1, columns.count) where lengths[k] > lengths[best] { best = k }
        return columns[best]
      }
      var best = 0
      for k in 1..<max(1, min(fields.count, columns.count)) where fields[k].utf16.count > fields[best].utf16.count { best = k }
      return columns[best]
    }
    func toRow(_ fields: [String], _ line: Int, _ start: Int, _ end: Int) -> RawRecord {
      if fields.count > columns.count {
        let at = suspectColumn(fields)
        let what = delimiterName(delimiter) ?? "'\(delimiter)'"
        let issue = Issue(code: "E_ROW_RAGGED", severity: "rejected", line: line, col: nil, field: at,
          valueExcerpt: JSString.slice(fields.joined(separator: delimiter), 0, 200),
          message: "Row \(line) has \(fields.count) fields, the header has \(columns.count).",
          suggestion: "Check for an unquoted \(what) in '\(at)' (quote that value in the file); the row was skipped.")
        return RawRecord(line: line, start: start, end: end, data: nil, issue: issue)
      }
      var warnings: [Issue] = []
      if fields.count < columns.count {
        warnings.append(Issue(code: "W_TRUNCATED_ROW", severity: "warning", line: line, col: nil, field: columns[fields.count],
          valueExcerpt: nil, message: "Row \(line) has \(fields.count) fields, the header has \(columns.count); missing fields are empty.",
          suggestion: "Check row \(line) for a missing \(delimiterName(delimiter) ?? "delimiter") or a line break inside an unquoted value."))
      }
      var data = JSObject()
      for k in 0..<columns.count {
        let v = k < fields.count ? fields[k] : ""
        data[columns[k]] = .string(v)
        if statRows < 200 { lengths[k] += Double(v.utf16.count) }
      }
      statRows += 1
      return RawRecord(line: line, start: start, end: end, data: data, warnings: warnings)
    }
    var rows: [RawRecord] = []
    if !header { rows.append(toRow(firstFields, firstLine, startOf(first), endOf(first))) }
    for r in raws.dropFirst() {
      switch r {
      case .error:
        rows.append(.fatal(quoteIssue(r, columns)))
        return Table(columns: columns, issues: issues, rows: rows, fatal: nil)
      case .record(let f, let l, let s, let e): rows.append(toRow(f, l, s, e))
      }
    }
    return Table(columns: columns, issues: issues, rows: rows, fatal: nil)
  }

  static func startOf(_ r: CSVRecord) -> Int { if case .record(_, _, let s, _) = r { s } else { 0 } }
  static func endOf(_ r: CSVRecord) -> Int { if case .record(_, _, _, let e) = r { e } else { 0 } }

  static func quoteIssue(_ r: CSVRecord, _ columns: [String]) -> Issue {
    guard case .error(let line, let col, let fieldIndex, _, _, _) = r else {
      return Issue(code: "E_CSV_QUOTE", severity: "fatal", message: "?", suggestion: "?")
    }
    let c = fieldIndex < columns.count ? columns[fieldIndex] : nil
    return Issue(code: "E_CSV_QUOTE", severity: "fatal", line: line, col: col, field: c, valueExcerpt: nil,
      message: "An unclosed quote starts on line \(line), column \(col) and runs to the end of the file.",
      suggestion: c.map { "Check for a stray \" in '\($0)' (a quote inside a value must be doubled: \"\")." }
        ?? "Check for a stray \" (a quote inside a value must be doubled: \"\").")
  }
}
