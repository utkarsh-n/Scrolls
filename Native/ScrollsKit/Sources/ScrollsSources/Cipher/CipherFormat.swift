// OWNER: N2
// Port of `server/adapters/cipher/source.mjs`: decoding with BOM / Windows-1252 fallback (WHATWG table), line byte
// ranges (every record points at its own bytes, §4.2), title folding, the shared unknown-date value and the
// `adapter:<id>@<version>` creator. Plus the Cipher packs' member paths: the members keep Cipher's own relative paths
// (`culture-works.tsv`, `songs/relations_mb.json`, `texts/gutenberg/12.txt`, …) so a pack member is the staged file.

import Foundation
import ScrollsContracts
import ScrollsCore

/// The Cipher packs and their member paths (Tools/packs.sh writes them; IOS-SPEC §3.5).
public enum CipherPacks {
  public static let meta = "cipher-meta"
  public static let text = "cipher-text"
  public static let cultureWorks = "culture-works.tsv"
  public static let cultureThemes = "culture-themes.tsv"
  public static let roots = "roots.tsv"
  public static let tagsDir = "tags/"
  public static let relationsDir = "songs/"
  public static let gutenbergJSON = "texts/gutenberg.json"
  public static let pgCatalog = "pg_catalog.csv"
  public static let gutenbergDir = "texts/gutenberg/"
  public static func wikisource(_ lang: String) -> String { "texts/wikisource-\(lang).jsonl" }
  public static func gutenbergText(_ id: Int) -> String { "\(gutenbergDir)\(id).txt" }

  /// Where a pack's members come from in Cipher's folder: a directory relative to the Cipher root and the member
  /// patterns under it (one `*` in the last component). The same lists as Tools/packs.sh's specs.
  public struct Source: Sendable, Equatable {
    public let root: String
    public let include: [String]
  }

  /// The members of each Cipher pack (Cipher/Resources and Tools/data/culture, Cipher's own relative paths).
  public static let sources: [String: [Source]] = [
    meta: [Source(root: "Cipher/Resources", include: [cultureWorks, cultureThemes, roots]),
           Source(root: "Tools/data/culture", include: ["tags/*.jsonl", "songs/relations_mb.json", "songs/relations_wiki.json",
                                                         "songs/relations_itwofs.json", gutenbergJSON, pgCatalog])],
    text: [Source(root: "Tools/data/culture", include: ["texts/gutenberg/*.txt", wikisource("hi"), wikisource("gu")])],
  ]

  /// The files of `pack` under a Cipher root: (member path, file), members sorted by code units within each pattern.
  public static func files(of pack: String, cipherRoot: URL) throws -> [(member: String, file: URL)] {
    var out: [(String, URL)] = []
    let fm = FileManager.default
    for s in sources[pack] ?? [] {
      let base = cipherRoot.appendingPathComponent(s.root)
      for pattern in s.include {
        guard let star = pattern.firstIndex(of: "*") else {
          if fm.fileExists(atPath: base.appendingPathComponent(pattern).path) { out.append((pattern, base.appendingPathComponent(pattern))) }
          continue
        }
        let dir = pattern[..<star].split(separator: "/").map(String.init)
        let (folder, head) = pattern[..<star].hasSuffix("/") ? (dir.joined(separator: "/"), "") : (dir.dropLast().joined(separator: "/"), dir.last ?? "")
        let tail = String(pattern[pattern.index(after: star)...])
        let names = (try? fm.contentsOfDirectory(atPath: base.appendingPathComponent(folder).path)) ?? []
        for n in names.filter({ $0.hasPrefix(head) && $0.hasSuffix(tail) && !$0.hasPrefix(".") })
          .sorted(by: { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }) {
          let member = folder.isEmpty ? n : "\(folder)/\(n)"
          out.append((member, base.appendingPathComponent(member)))
        }
      }
    }
    return out
  }
}

/// Helpers shared by the Cipher adapters (`source.mjs`).
public enum CipherFormat {
  /// Wording used for every machine-made Cipher tag and gloss (data-inventory.md §2).
  public static let taggingMethod = "Cipher tagging pass (Claude sub-agent, Oct 2026)"

  /// `adapter:<id>@<version>`: the created_by / asserted_by of everything an adapter states (§6.1).
  public static func assertedBy(_ id: String, _ version: String) -> String { "adapter:\(id)@\(version)" }

  /// Folded tokens joined by spaces: how titles and names are compared across files.
  public static func fold(_ s: String?) -> String {
    guard let s, !s.isEmpty else { return "" }
    return Tokenizer.normString(s)
  }

  /// An explicit "no date" chronology value (`unknownDate(rule, raw)`).
  public static func unknownDate(_ rule: String, raw: String? = nil) -> DateParse {
    DateParse(loDay: nil, hiDay: nil, yLo: nil, yHi: nil, precision: "unknown", basis: "unknown", approx: false, rule: rule,
              raw: raw, label: "undated", warnings: [])
  }

  // MARK: decoding

  /// `decodeBytes`: BOM → UTF-8 (fatal) → on failure Windows-1252, naming the first bad byte. The one BOM is stripped
  /// (a second U+FEFF is text and stays, so offsets equal a standard UTF-8 decode of the file).
  public static func decode(_ bytes: Data) -> (text: String, decoder: String, hadBOM: Bool, badByte: Int?) {
    let hadBOM = bytes.count >= 3 && bytes[bytes.startIndex] == 0xEF && bytes[bytes.startIndex + 1] == 0xBB
      && bytes[bytes.startIndex + 2] == 0xBF
    let body = hadBOM ? bytes.dropFirst(3) : bytes[...]
    if let s = String(validating: body, as: UTF8.self) { return (s, "utf-8", hadBOM, nil) }
    return (windows1252(body), "windows-1252", hadBOM, firstBadUTF8(body))
  }

  /// WHATWG windows-1252 (bytes 0x80–0x9F through the table; undefined slots pass through as C1 controls).
  public static func windows1252<C: Collection>(_ bytes: C) -> String where C.Element == UInt8 {
    var units: [UInt16] = []
    units.reserveCapacity(bytes.count)
    for b in bytes {
      if b >= 0x80 && b <= 0x9F { units.append(cp1252High[Int(b - 0x80)]) } else { units.append(UInt16(b)) }
    }
    return String(decoding: units, as: UTF16.self)
  }

  private static let cp1252High: [UInt16] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
  ]

  /// Offset of the first byte that breaks UTF-8 (for W_ENCODING_FALLBACK messages), as source.mjs computes it.
  public static func firstBadUTF8<C: Collection>(_ bytes: C) -> Int? where C.Element == UInt8, C.Index == Int {
    let b = Array(bytes)
    var i = 0
    while i < b.count {
      let c = b[i]
      let n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0
      if n == 0 { return i }
      for k in 1..<n where i + k >= b.count || (b[i + k] & 0xC0) != 0x80 { return i }
      i += n
    }
    return nil
  }

  // MARK: lines

  /// One line of a file with its byte range (`[byteStart, byteEnd)` excludes the newline and a trailing CR).
  public struct Line: Sendable {
    public var index: Int
    public var byteStart: Int
    public var byteEnd: Int
  }

  /// `lineRecords(bytes)`: lines with their byte ranges; trailing empty lines dropped.
  public static func lines(_ bytes: Data) -> [Line] {
    var out: [Line] = []
    bytes.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
      let u = p.bindMemory(to: UInt8.self)
      var start = 0, index = 0
      var i = 0
      while i <= u.count {
        if i == u.count || u[i] == 0x0A {
          var end = i
          if end > start && u[end - 1] == 0x0D { end -= 1 }
          if end > start || i < u.count { out.append(Line(index: index, byteStart: start, byteEnd: end)); index += 1 }
          start = i + 1
        }
        i += 1
      }
    }
    while let last = out.last, last.byteEnd == last.byteStart { out.removeLast() }
    return out
  }

  /// The UTF-8 text of a byte range (lossy, as Node's `toString('utf8')`).
  public static func text(_ bytes: Data, _ start: Int, _ end: Int) -> String {
    let base = bytes.startIndex
    return String(decoding: bytes[(base + start)..<(base + end)], as: UTF8.self)
  }

  /// Tab-separated fields of a line, split on the bytes (so a combining mark after a tab never hides the tab).
  public static func tabFields(_ bytes: Data, _ line: Line) -> [String] {
    var out: [String] = []
    let base = bytes.startIndex
    var a = line.byteStart
    for i in line.byteStart..<line.byteEnd where bytes[base + i] == 0x09 {
      out.append(text(bytes, a, i))
      a = i + 1
    }
    out.append(text(bytes, a, line.byteEnd))
    return out
  }

  // MARK: JavaScript value semantics

  /// `/^-?\d+$/.test(s)` (ASCII digits).
  public static func isIntegerLiteral(_ s: String) -> Bool {
    let u = Array(s.utf8)
    var i = 0
    if i < u.count && u[i] == 0x2D { i += 1 }
    guard i < u.count else { return false }
    return u[i...].allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  /// `Number(s)` when finite, else nil.
  public static func finiteNumber(_ s: String) -> Double? {
    let v = JSNumber.parse(s)
    return v.isFinite ? v : nil
  }

  /// A JSON number that is an integer (`Number.isInteger`).
  public static func integer(_ v: JSONValue?) -> Int? {
    guard let n = v?.numberValue, n.isFinite, n.rounded(.towardZero) == n, abs(n) < 9.0e15 else { return nil }
    return Int(n)
  }

  /// `String(v ?? '')` of a JSON value (null and absent are '').
  public static func string(_ v: JSONValue?) -> String {
    switch v {
    case .string(let s)?: return s
    case .number(let n)?: return JSNumber.format(n)
    case .bool(let b)?: return b ? "true" : "false"
    default: return ""
    }
  }
}

/// A string compared by its UTF-16 code units, as JavaScript's `===`, `Set` and `Map` do (Swift's String equality
/// identifies canonically equivalent strings).
public struct CodeUnits: Hashable, Sendable {
  public let units: [UInt16]
  public init(_ s: String) { units = Array(s.utf16) }
}

/// A JSON array of records parsed once (relations, gutenberg.json, Wikisource lines). `JSONValue.parse` keeps every
/// key and string exactly as JavaScript's JSON.parse does.
public enum CipherJSON {
  public static func parse(_ data: Data, what: String) throws -> JSONValue {
    do { return try JSONValue.parse(data) } catch {
      throw ScrollsError(code: ErrorCode(rawValue: "E_JSON_PARSE"), message: "\(what) is not valid JSON: \(error.message)",
                         hint: "Build the pack again from the staged files.", status: 422)
    }
  }
}
