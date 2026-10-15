// OWNER: N2
// Port of `server/adapters/cipher/wikisource.mjs`: source adapter 'cipher.wikisource': texts/wikisource-{hi,gu}.jsonl
// → 450 hi + 375 gu documents, pages joined with \f (decoder 'pages-joined-ff'; the page boundary is an offset)
// (SPEC §6.4). The year is the Wikisource index year, which may be an edition year; null → undated. The first two pages
// are front matter when they average < 30 tokens per non-blank line (§4.3) — flagged, never deleted.
// The files are 50–63 MB each: lines are parsed one at a time, and only their keys are kept between uses.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// Source adapter 'cipher.wikisource'.
public struct CipherWikisourceAdapter: PackBoundAdapter, CollectionCaveats, SourceLines {
  public static let adapterID = "cipher.wikisource"
  public static let langs = ["hi", "gu"]
  public static let packNames = [CipherPacks.text]
  static let pageSeparator = "\u{0C}"
  static let frontPages = 2
  static let frontTokensPerLine = 30.0

  public let id = CipherWikisourceAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher Wikisource books (hi, gu)"
  public let access = AdapterAccess.localDataset
  public let license = "CC BY-SA (Wikisource)"
  public let attribution = "Wikisource"
  public let collections = CipherWikisourceAdapter.langs.map { lang in
    CollectionSpec(slug: "cipher-wikisource-\(lang)", name: lang == "hi" ? "Wikisource (Hindi)" : "Wikisource (Gujarati)",
                   domain: "literature", modality: "text", unit: "tokens", sampling: "curated", rateEligible: true,
                   exportTextAllowed: true, coverageGate: nil, selectionNote: "Wikisource index books with transcribed pages")
  }
  public let collectionCaveats = Dictionary(uniqueKeysWithValues: CipherWikisourceAdapter.langs.map {
    ("cipher-wikisource-\($0)", ["The year is the Wikisource index year and may be an edition year.",
                                 "Page text is OCR/transcription and can be noisy."])
  })
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherWikisourceAdapter { CipherWikisourceAdapter(files: files) }

  /// One line of a Wikisource file: its key facts (the full record is parsed again when its document is built).
  public struct Line: Sendable {
    public var line: Int
    public var byteStart: Int
    public var byteEnd: Int
    /// `String(rec.index)`, or nil when the line is not JSON.
    public var index: String?
    public var year: Int?
    public var error: String?
  }

  /// The lines of `wikisource-<lang>.jsonl` with their keys.
  public func lines(_ lang: String) throws -> (lines: [Line], data: Data, sha256: String) {
    let member = CipherPacks.wikisource(lang)
    let data = try files.data(member)
    var out: [Line] = []
    for l in CipherFormat.lines(data) {
      let base = data.startIndex
      do {
        let rec = try JSONValue.parse(data[(base + l.byteStart)..<(base + l.byteEnd)])
        out.append(Line(line: l.index + 1, byteStart: l.byteStart, byteEnd: l.byteEnd, index: CipherFormat.string(rec["index"]),
                        year: CipherFormat.integer(rec["year"]), error: nil))
      } catch {
        out.append(Line(line: l.index + 1, byteStart: l.byteStart, byteEnd: l.byteEnd, index: nil, year: nil, error: error.message))
      }
    }
    return (out, data, files.info(member)!.sha256)
  }

  /// Every ext_id of a language, in file order (the bootstrap's text plan).
  public func extIds(_ lang: String) throws -> [String] {
    try lines(lang).lines.compactMap { $0.index.map { "ws-\(lang):\($0)" } }
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    var counts: [String: Int] = [:]
    for lang in Self.langs {
      guard files.contains(CipherPacks.wikisource(lang)) else {
        return AdapterProbeResult(available: false, reason: "wikisource-\(lang).jsonl not found", manifestOK: false, formatOK: false)
      }
      let l = try lines(lang).lines
      counts[lang] = l.filter { $0.index != nil }.count
      counts["\(lang)_undated"] = l.filter { $0.index != nil && $0.year == nil }.count
    }
    return AdapterProbeResult(available: true, manifestOK: true, formatOK: true, counts: counts)
  }

  func langs(_ params: JSONValue) -> [String] {
    guard let c = params["collection"]?.stringValue else { return Self.langs }
    return [c.replacingOccurrences(of: "cipher-wikisource-", with: "")]
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int {
    try langs(params).filter { Self.langs.contains($0) }.reduce(0) { $0 + CipherFormat.lines(try files.data(CipherPacks.wikisource($1))).count }
  }

  /// Front-matter regions: the first two pages when, together, they average < 30 tokens per non-blank line.
  public static func frontMatterRegions(_ text: String) -> [TextRegion] {
    let u = Array(text.utf16)
    var bounds: [(Int, Int)] = []
    var start = 0
    for _ in 0..<frontPages {
      var ff = -1
      var i = start
      while i < u.count { if u[i] == 0x0C { ff = i; break }; i += 1 }
      let end = ff == -1 ? u.count : ff
      bounds.append((start, end))
      if ff == -1 { break }
      start = ff + 1
    }
    var tokens = 0, lines = 0
    for (a, b) in bounds {
      let s = JSText.slice(u, a, b)
      tokens += Tokenizer.tokenize(s).count
      lines += JSString.split(s, "\n").filter { !JSString.trim($0).isEmpty }.count
    }
    if lines == 0 || Double(tokens) / Double(lines) >= frontTokensPerLine { return [] }
    return bounds.filter { $0.1 > $0.0 }.map { TextRegion(start: $0.0, end: $0.1, quality: "front_matter") }
  }

  private static let fileSuffix = JSRegex(js: #"\.(?:pdf|djvu)$"#, "i")

  /// One CanonicalDocument per book of `params.collection` (both languages without it); `params.pages` keeps only the
  /// first N pages (tests); `params.skip` lists ext_ids already loaded; `params.limit` stops after N books.
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    let by = CipherFormat.assertedBy(id, version)
    let skip = Set((params["skip"]?.arrayValue ?? []).compactMap(\.stringValue).map(CodeUnits.init))
    let pageLimit = CipherFormat.integer(params["pages"])
    let limit = CipherFormat.integer(params["limit"])
    var out = BatchSender(channel)
    for lang in langs(params) where Self.langs.contains(lang) {
      let member = CipherPacks.wikisource(lang)
      let (lines, data, sha) = try lines(lang)
      let stored = try files.keep(member)
      var n = 0
      for r in lines {
        if let limit, n >= limit { break }
        try Task.checkCancellation()
        guard let index = r.index else {
          context.warn("E_JSON_PARSE", "wikisource-\(lang).jsonl line \(r.line): \(r.error ?? "not JSON")", nil)
          continue
        }
        let extId = "ws-\(lang):\(index)"
        if skip.contains(CodeUnits(extId)) { continue }
        n += 1
        let base = data.startIndex
        let rec = try JSONValue.parse(data[(base + r.byteStart)..<(base + r.byteEnd)])
        let pages = (rec["pages"]?.arrayValue ?? []).map { CipherFormat.string($0) }
        let kept = pageLimit.map { Array(pages.prefix(max(0, $0))) } ?? pages
        let text = kept.joined(separator: Self.pageSeparator)
        var title = rec["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let hasText = !JSString.trim(text).isEmpty
        if title == nil && !hasText {
          // neither a title nor transcribed pages: the Wikisource index file name is the only name recorded
          title = Self.fileSuffix.replaceFirst(index, with: "")
          context.report(RecordIssue(code: "E_MISSING_TEXT", field: "title",
                                     message: "\(extId) has no title and no transcribed pages; the index file name is used as its title.",
                                     suggestion: "Nothing to do: the document is metadata only.", extId: extId, line: r.line))
        }
        var meta: JSONObject = ["source": .string("wikisource-\(lang).jsonl"), "line": .number(Double(r.line))]
        for (k, v) in rec.objectValue ?? [:] where k != "pages" { meta[k] = v }
        var pagesMeta: JSONObject = ["$text": "document_text", "count": .number(Double(pages.count)), "joined_with": "\\f"]
        if kept.count < pages.count { pagesMeta["kept"] = .number(Double(kept.count)) }
        meta["pages"] = .object(pagesMeta)
        let date: CanonicalDate = if let year = r.year {
          CanonicalDate(role: "publication_unspecified",
                        parsed: try DateGrammar.fromInterval(year, year, precision: "year", basis: "stated",
                                                             rule: "wikisource_index_year", raw: String(year)),
                        assertedBy: by, isChronology: true, note: "Wikisource index year; may be an edition year")
        } else {
          CanonicalDate(role: "publication_unspecified", parsed: CipherFormat.unknownDate("wikisource_index_year"), assertedBy: by,
                        isChronology: true, note: "no year in the Wikisource index")
        }
        let author = rec["author"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        try await out.append(CanonicalDocument(
          extId: extId, kind: "book", title: title, author: author, langDeclared: lang,
          sourceUrl: "https://\(lang).wikisource.org/wiki/Index:\(JSText.encodeURIComponent(index.replacingOccurrences(of: " ", with: "_")))",
          license: "CC BY-SA (Wikisource)",
          text: hasText ? CanonicalText(original: text, decoder: "pages-joined-ff", regions: Self.frontMatterRegions(text), mode: "auto") : nil,
          dates: [date], originalMeta: .object(meta),
          sourceFile: stored == sha ? SourceFileSpan(sha256: sha, byteStart: r.byteStart, byteEnd: r.byteEnd) : nil))
      }
    }
    try await out.flush()
  }

  /// The source line of a document (`_line`): its original_meta's `line`.
  public func line(of document: CanonicalDocument) -> Int? { CipherFormat.integer(document.originalMeta["line"]) }
}
