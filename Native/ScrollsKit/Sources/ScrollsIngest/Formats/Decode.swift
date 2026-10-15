// OWNER: N1
// Port of server/ingest/decode.mjs (SPEC §4.2, §5.5, D4): file bytes → one string, the offset space of every passage.
// Order: refuse what is not text (ZIP/PDF containers, NUL bytes, UTF-16) → strip a UTF-8 byte-order mark → strict UTF-8 →
// Windows-1252 fallback with W_ENCODING_FALLBACK naming the first bad byte and its line. No newline or Unicode
// normalisation ever happens here: offsets index exactly what was decoded. The Windows-1252 table is the WHATWG one
// (TextDecoder('windows-1252')).

import Foundation
import ScrollsContracts
import ScrollsCore

/// A decoded file (`decodeBytes`).
public struct Decoded: Sendable {
  public var text: String
  /// 'utf-8' | 'windows-1252'
  public var decoder: String
  /// 'utf-8' | 'windows-1252' | 'unknown'
  public var encoding: String
  public var bom: Bool
  public var bomBytes: Int
  public var issues: [Issue]
  public var fatal: Issue?
}

/// Byte decoding of import files.
public enum Decode {
  /// Encodings a mapping may ask for ('auto' = UTF-8, falling back to Windows-1252).
  public static let encodings = ["auto", "utf-8", "windows-1252"]
  static let nulScanBytes = 8192

  static func hexByte(_ b: UInt8) -> String {
    let h = String(b, radix: 16, uppercase: true)
    return "0x" + (h.count < 2 ? "0" + h : h)
  }

  /// `groupInt(n)`: digits grouped by ',' (`String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')`).
  static func groupInt(_ n: Int) -> String {
    let s = String(n)
    let neg = s.hasPrefix("-")
    let digits = Array(neg ? s.dropFirst() : Substring(s))
    var out = ""
    for (i, c) in digits.enumerated() {
      if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
      out.append(c)
    }
    return (neg ? "-" : "") + out
  }

  /// 1-based line of byte `offset` (counts LF bytes before it).
  public static func lineOfByte(_ b: [UInt8], _ offset: Int) -> Int {
    var line = 1
    var i = 0
    while i < offset && i < b.count {
      if b[i] == 0x0A { line += 1 }
      i += 1
    }
    return line
  }

  /// Offset of the first byte that does not start or continue a valid UTF-8 sequence (overlongs, surrogates and code
  /// points above U+10FFFF are invalid), or -1.
  public static func firstInvalidUTF8(_ b: ArraySlice<UInt8>, from: Int = 0) -> Int {
    let base = b.startIndex
    let n = b.count
    var i = from
    while i < n {
      let c = b[base + i]
      if c < 0x80 { i += 1; continue }
      var need = 0, minimum: UInt32 = 0
      if c >= 0xC2 && c <= 0xDF { need = 1; minimum = 0x80 }
      else if c >= 0xE0 && c <= 0xEF { need = 2; minimum = 0x800 }
      else if c >= 0xF0 && c <= 0xF4 { need = 3; minimum = 0x10000 }
      else { return i }
      var cp = UInt32(c & (need == 1 ? 0x1F : need == 2 ? 0x0F : 0x07))
      for k in 1...need {
        guard i + k < n else { return i }
        let d = b[base + i + k]
        if d & 0xC0 != 0x80 { return i }
        cp = (cp << 6) | UInt32(d & 0x3F)
      }
      if cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) { return i }
      i += need + 1
    }
    return -1
  }

  /// What kind of non-text file the first bytes reveal, or nil.
  static func binaryKind(_ b: ArraySlice<UInt8>) -> (what: String, advice: String)? {
    let s = b.startIndex
    func at(_ i: Int) -> UInt8? { i < b.count ? b[s + i] : nil }
    if b.count >= 4, at(0) == 0x50, at(1) == 0x4B, at(2) == 0x03 || at(2) == 0x05, at(3) == 0x04 || at(3) == 0x06 {
      return ("a ZIP container (for example .xlsx, .docx or .epub)", "Export it as CSV, TXT, Markdown or JSON first.")
    }
    if b.count >= 5, at(0) == 0x25, at(1) == 0x50, at(2) == 0x44, at(3) == 0x46, at(4) == 0x2D {
      return ("a PDF", "PDF import is not part of this version; save the text as TXT first.")
    }
    if (at(0) == 0xFF && at(1) == 0xFE) || (at(0) == 0xFE && at(1) == 0xFF) {
      return ("UTF-16 text (byte-order mark \(hexByte(at(0)!)) \(hexByte(at(1)!)))",
              "Re-save it as UTF-8 (most editors offer \"UTF-8\" under Save As or Encoding).")
    }
    let scan = min(b.count, nulScanBytes)
    for i in 0..<scan where b[s + i] == 0 {
      return ("binary data (a NUL byte at byte \(groupInt(i)))", "Import text files only: export the data as CSV, TXT, Markdown or JSON.")
    }
    return nil
  }

  /// `TextDecoder('windows-1252')` (the WHATWG index: 0x80–0x9F map to their CP1252 characters, five of them to C1).
  public static func windows1252(_ b: ArraySlice<UInt8>) -> String {
    var out: [UInt16] = []
    out.reserveCapacity(b.count)
    for c in b {
      if c < 0x80 || c >= 0xA0 { out.append(UInt16(c)) } else { out.append(cp1252[Int(c - 0x80)]) }
    }
    return String(decoding: out, as: UTF16.self)
  }

  static let cp1252: [UInt16] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
  ]

  static func issue(_ code: String, _ severity: String, line: Int?, col: Int? = nil, field: String? = nil, excerpt: String? = nil,
                    _ message: String, _ suggestion: String) -> Issue {
    Issue(code: code, severity: severity, line: line, col: col, field: field, valueExcerpt: excerpt, message: message,
          suggestion: suggestion)
  }

  /// `decodeBytes(bytes, {encoding})`.
  public static func decode(_ bytes: [UInt8], encoding: String = "auto") -> Decoded {
    let b = bytes[...]
    let bom = b.count >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF
    let bomBytes = bom ? 3 : 0
    func fail(_ i: Issue) -> Decoded {
      Decoded(text: "", decoder: "utf-8", encoding: "unknown", bom: bom, bomBytes: bomBytes, issues: [i], fatal: i)
    }
    if !bom, let bin = binaryKind(b) {
      return fail(issue("E_ENCODING", "fatal", line: 1, "This file is \(bin.what), not plain text.", bin.advice))
    }
    let body = b[bomBytes...]
    if encoding == "windows-1252" {
      return Decoded(text: windows1252(body), decoder: "windows-1252", encoding: "windows-1252", bom: bom, bomBytes: bomBytes,
                     issues: [], fatal: nil)
    }
    let bad = firstInvalidUTF8(body)
    if bad < 0 {
      return Decoded(text: String(decoding: body, as: UTF8.self), decoder: "utf-8", encoding: "utf-8", bom: bom, bomBytes: bomBytes,
                     issues: [], fatal: nil)
    }
    let offset = bad + bomBytes
    let line = lineOfByte(bytes, offset)
    let at = offset < bytes.count ? bytes[offset] : 0
    let whereText = "\(hexByte(at)) at byte \(groupInt(offset))"
    if encoding == "utf-8" {
      return fail(issue("E_ENCODING", "fatal", line: line, "Line \(line): bytes are not valid UTF-8 (\(whereText)).",
                        "Re-save the file as UTF-8, or choose the Windows-1252 reading in the upload step."))
    }
    let text = windows1252(body)
    let i = issue("W_ENCODING_FALLBACK", "warning", line: line, excerpt: excerptLine(text, line),
                  "Line \(line): bytes are not valid UTF-8 (\(whereText)); read as Windows-1252.",
                  "Re-save as UTF-8, or accept the Windows-1252 reading shown.")
    return Decoded(text: text, decoder: "windows-1252", encoding: "windows-1252", bom: bom, bomBytes: bomBytes, issues: [i], fatal: nil)
  }

  /// The text of 1-based line `line` (≤ 120 characters), for showing the fallback reading.
  static func excerptLine(_ text: String, _ line: Int) -> String? {
    let u = Array(text.utf16)
    var start = 0
    var l = 1
    while l < line {
      guard let i = u[start...].firstIndex(of: 0x0A) else { return nil }
      start = i + 1
      l += 1
    }
    var end = u[start...].firstIndex(of: 0x0A) ?? u.count
    if end > start && u[end - 1] == 0x0D { end -= 1 }
    return JSString.slice(String(decoding: u[start..<end], as: UTF16.self), 0, 120)
  }

  /// `utf8Length(s, start, end)`: UTF-8 bytes of the code units [start, end) (a lone surrogate counts 3, as V8 writes it).
  public static func utf8Length(_ u: [UInt16], _ start: Int = 0, _ end: Int? = nil) -> Int {
    let e = end ?? u.count
    var n = 0
    var i = start
    while i < e {
      let c = u[i]
      if c < 0x80 { n += 1 }
      else if c < 0x800 { n += 2 }
      else if c >= 0xD800 && c <= 0xDBFF && i + 1 < e && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF {
        n += 4
        i += 1
      } else { n += 3 }
      i += 1
    }
    return n
  }
}
