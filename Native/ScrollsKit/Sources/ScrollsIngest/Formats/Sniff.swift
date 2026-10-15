// OWNER: N1
// Port of server/ingest/sniff.mjs (SPEC §5.1, §5.2 step 1): format, encoding and delimiter sniffing for uploads. A known
// file extension decides the format (he named the file); the content decides otherwise. The encoding guess here looks at
// the first 64 KB only; Decode validates the whole file.

import Foundation
import ScrollsContracts
import ScrollsCore

/// What sniffing found.
public struct Sniffed: Sendable {
  public var format: String
  public var encoding: String
  public var delimiter: String?
  public var header: Bool?
  public var issues: [Issue]
}

/// Format sniffing.
public enum Sniff {
  static let headBytes = 65536

  /// File extension → format.
  public static let extensions: [String: String] = [
    "txt": "txt", "text": "txt", "md": "md", "markdown": "md", "mdown": "md", "mkd": "md", "csv": "csv", "tsv": "tsv", "tab": "tsv",
    "json": "json", "jsonl": "jsonl", "ndjson": "jsonl", "jsonlines": "jsonl",
  ]

  /// Formats the importer reads (import_batch.format minus 'adapter').
  public static let fileFormats = ["txt", "md", "csv", "tsv", "json", "jsonl"]

  /// `formatFromName(fileName)`: the format named by a file's extension (`/\.([A-Za-z0-9]+)$/`), or nil.
  public static func formatFromName(_ fileName: String?) -> String? {
    let u = Array((fileName ?? "").utf16)
    var i = u.count
    while i > 0 {
      let c = u[i - 1]
      if (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) { i -= 1 } else { break }
    }
    guard i < u.count, i > 0, u[i - 1] == 0x2E else { return nil }
    return extensions[Fold.asciiLowercased(String(decoding: u[i...], as: UTF16.self))]
  }

  static func looksLikeJSONL(_ text: [UInt16]) -> Bool {
    let lines = text.split(separator: 0x0A, omittingEmptySubsequences: false)
      .map { JSString.trim(String(decoding: $0, as: UTF16.self)) }.filter { !$0.isEmpty }.prefix(5)
    if lines.count < 2 { return false }
    var ok = 0
    for l in lines {
      if let v = try? JSONParser.parse(l), v.isPlainObject { ok += 1 }
    }
    return ok >= min(2, lines.count)
  }

  static func isWS(_ u: UInt16) -> Bool { JSString.isWhitespace(u) }

  static func looksLikeMarkdown(_ u: [UInt16]) -> Bool {
    let starts = TextFiles.lineStarts(u)
    // /^ {0,3}#{1,6}[ \t]+\S/m
    for p in starts {
      var i = p
      while i < u.count && i - p < 3 && u[i] == 0x20 { i += 1 }
      let h = i
      while i < u.count && u[i] == 0x23 && i - h < 6 { i += 1 }
      guard i > h, i < u.count, u[i] == 0x20 || u[i] == 0x09 else { continue }
      while i < u.count && (u[i] == 0x20 || u[i] == 0x09) { i += 1 }
      if i < u.count && !isWS(u[i]) { return true }
    }
    // /^\s*[-*+][ \t]+\S/m && /\[[^\]]+\]\([^)]+\)/
    var bullet = false
    for p in starts {
      var i = p
      while i < u.count && isWS(u[i]) { i += 1 }
      guard i < u.count, u[i] == 0x2D || u[i] == 0x2A || u[i] == 0x2B else { continue }
      i += 1
      let s = i
      while i < u.count && (u[i] == 0x20 || u[i] == 0x09) { i += 1 }
      if i > s && i < u.count && !isWS(u[i]) {
        bullet = true
        break
      }
    }
    if bullet && hasLink(u) { return true }
    // /^```/m
    for p in starts where p + 3 <= u.count && u[p] == 0x60 && u[p + 1] == 0x60 && u[p + 2] == 0x60 { return true }
    return false
  }

  /// `/\[[^\]]+\]\([^)]+\)/`
  static func hasLink(_ u: [UInt16]) -> Bool {
    var i = 0
    while i < u.count {
      if u[i] == 0x5B {
        var j = i + 1
        while j < u.count && u[j] != 0x5D { j += 1 }
        if j < u.count && j > i + 1 && j + 1 < u.count && u[j + 1] == 0x28 {
          var k = j + 2
          while k < u.count && u[k] != 0x29 { k += 1 }
          if k < u.count && k > j + 2 { return true }
        }
      }
      i += 1
    }
    return false
  }

  /// `sniffText(head, {fileName})`: format, delimiter and header of a decoded text.
  public static func sniffText(_ head: [UInt16], fileName: String?) -> (format: String, delimiter: String?, header: Bool?, by: String) {
    let byName = formatFromName(fileName)
    func tableInfo(_ fmt: String, _ preferTab: Bool) -> (format: String, delimiter: String?, header: Bool?) {
      let d = preferTab ? "\t" : CSV.sniffDelimiterDetail(head).delimiter
      var firsts: [[String]] = []
      for r in CSV.records(head[...], delimiter: d.utf16.first!, limit: 21) {
        guard case .record(let f, _, _, _) = r, firsts.count < 20 else { break }
        firsts.append(f)
      }
      return (fmt, d, CSV.sniffHeader(firsts))
    }
    if byName == "csv" { let t = tableInfo("csv", false); return (t.format, t.delimiter, t.header, "extension") }
    if byName == "tsv" { let t = tableInfo("tsv", true); return (t.format, t.delimiter, t.header, "extension") }
    if let byName { return (byName, nil, nil, "extension") }
    var s = 0
    while s < head.count && isWS(head[s]) { s += 1 }
    let t = Array(head[s...])
    if t.first == 0x5B { return ("json", nil, nil, "content") }
    if t.first == 0x7B { return (looksLikeJSONL(t) ? "jsonl" : "json", nil, nil, "content") }
    let d = CSV.sniffDelimiterDetail(head)
    if d.fields >= 2 && d.records >= 2 && d.consistency >= 0.8 {
      let ti = tableInfo(d.delimiter == "\t" ? "tsv" : "csv", d.delimiter == "\t")
      return (ti.format, ti.delimiter, ti.header, "content")
    }
    return (looksLikeMarkdown(head) ? "md" : "txt", nil, nil, "content")
  }

  /// `sniffFormat(bytes, {fileName})`: format, encoding and delimiter from the first 64 KB.
  public static func sniffFormat(_ bytes: [UInt8], fileName: String?) -> Sniffed {
    let head = bytes.prefix(headBytes)
    // a multi-byte character cut at 64 KB is not an encoding error
    var cut = head.count
    if bytes.count > headBytes {
      while cut > head.count - 4 && cut > 0 && (head[cut - 1] & 0xC0) == 0x80 { cut -= 1 }
      if cut > 0 && head[cut - 1] >= 0xC0 { cut -= 1 }
    }
    let dec = Decode.decode(Array(head[0..<cut]))
    if dec.fatal != nil {
      return Sniffed(format: formatFromName(fileName) ?? "txt", encoding: dec.encoding, delimiter: nil, header: nil, issues: dec.issues)
    }
    let s = sniffText(Array(dec.text.utf16), fileName: fileName)
    return Sniffed(format: s.format, encoding: dec.encoding, delimiter: s.delimiter, header: s.header, issues: dec.issues)
  }
}
