// OWNER: N2
// Port of `server/adapters/cipher/books.mjs`: source adapter 'cipher.books': texts/gutenberg.json (693 entries) +
// texts/gutenberg/<id>.txt + pg_catalog.csv rows → 691 documents + 2 aliases (SPEC §6.3).
//  · #1661 is listed three times (three Wikidata items, one text): one document, the other two as aliases.
//  · lang_declared comes from the JSON; DocumentWriter detects lang_text and marks a mismatch as a translation.
//  · The JSON year is Cipher's list year: when it equals the first author's birth + 40 (Cipher's lifetime_year
//    estimate) it is basis 'estimated'; otherwise 'stated' but unverified. `Issued` is the Gutenberg release date:
//    role 'release', never chronology.
// Reads gutenberg.json and the catalogue rows from cipher-meta, the texts from cipher-text.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// gutenberg.json grouped by Gutenberg id, with the catalogue rows.
public struct GutenbergBooks: Sendable {
  public struct Book: Sendable {
    public var id: Int
    /// The most-linked entry (the document); the others become aliases.
    public var entry: JSONValue
    public var others: [JSONValue]
    /// The pg_catalog.csv row, header → value, in header order.
    public var catalog: [(String, String)]?
    public func cat(_ k: String) -> String? { catalog?.first { $0.0 == k }?.1 }
    public var catalogJSON: JSONValue {
      catalog.map { .object(JSONObject($0.map { ($0.0, JSONValue.string($0.1)) })) } ?? .null
    }
  }
  public var books: [Book]
  public var entries: Int

  /// `loadBooks()`.
  public static func load(_ files: SourceFiles) throws -> GutenbergBooks {
    let list = try CipherJSON.parse(try files.data(CipherPacks.gutenbergJSON), what: CipherPacks.gutenbergJSON).arrayValue ?? []
    var order: [Int] = [], byId: [Int: [JSONValue]] = [:]
    for e in list {
      guard let id = CipherFormat.integer(e["id"]) else { continue }
      if byId[id] == nil { order.append(id) }
      byId[id, default: []].append(e)
    }
    let catalog = files.contains(CipherPacks.pgCatalog) ? try loadCatalog(files, wanted: Set(order)) : [:]
    let books = order.map { id -> Book in
      // stable sort, most links first
      let sorted = byId[id]!.enumerated().sorted { a, b in
        let la = a.element["links"]?.numberValue ?? 0, lb = b.element["links"]?.numberValue ?? 0
        return la != lb ? la > lb : a.offset < b.offset
      }.map(\.element)
      return Book(id: id, entry: sorted[0], others: Array(sorted.dropFirst()), catalog: catalog[id])
    }
    return GutenbergBooks(books: books, entries: list.count)
  }

  /// `parseCsv(text)`: RFC 4180 (quoted fields, doubled quotes, newlines inside quotes).
  public static func parseCSV(_ text: String) -> [[String]] {
    let u = Array(text.utf16)
    var rows: [[String]] = [], row: [String] = [], field: [UInt16] = []
    var i = 0, quoted = false
    let n = u.count
    func take() -> String { String(decoding: field, as: UTF16.self) }
    while i < n {
      let c = u[i]
      if quoted {
        if c == 0x22 {
          if i + 1 < n && u[i + 1] == 0x22 { field.append(0x22); i += 2; continue }
          quoted = false; i += 1; continue
        }
        field.append(c); i += 1; continue
      }
      if c == 0x22 && field.isEmpty { quoted = true; i += 1; continue }
      if c == 0x2C { row.append(take()); field = []; i += 1; continue }
      if c == 0x0A || c == 0x0D {
        row.append(take()); field = []
        if row.count > 1 || row[0] != "" { rows.append(row) }
        row = []
        i += c == 0x0D && i + 1 < n && u[i + 1] == 0x0A ? 2 : 1
        continue
      }
      field.append(c); i += 1
    }
    if !field.isEmpty || !row.isEmpty { row.append(take()); rows.append(row) }
    return rows
  }

  /// `loadCatalog(wanted)`: catalogue rows for the wanted ids, header → value in header order.
  static func loadCatalog(_ files: SourceFiles, wanted: Set<Int>) throws -> [Int: [(String, String)]] {
    let rows = parseCSV(String(decoding: try files.data(CipherPacks.pgCatalog), as: UTF8.self))
    guard let header = rows.first else { return [:] }
    var out: [Int: [(String, String)]] = [:]
    for r in rows.dropFirst() {
      let v = JSNumber.parse(r[0])
      guard v.isFinite, v.rounded(.towardZero) == v, wanted.contains(Int(v)) else { continue }
      out[Int(v)] = header.enumerated().map { ($1, $0 < r.count ? r[$0] : "") }
    }
    return out
  }
}

/// Source adapter 'cipher.books'.
public struct CipherBooksAdapter: PackBoundAdapter, CollectionCaveats {
  public static let adapterID = "cipher.books"
  public static let collection = "cipher-gutenberg"
  public static let packNames = [CipherPacks.meta, CipherPacks.text]
  static let lifetimeOffset = 40
  static let catalogMethod = "Project Gutenberg catalogue (pg_catalog.csv)"

  public let id = CipherBooksAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher Gutenberg books"
  public let access = AdapterAccess.localDataset
  public let license = "Public domain (US)"
  public let attribution = "Project Gutenberg"
  public let collections = [
    CollectionSpec(slug: CipherBooksAdapter.collection, name: "Project Gutenberg books (Cipher)", domain: "literature",
                   modality: "text", unit: "tokens", sampling: "prominence_selected", rateEligible: true,
                   exportTextAllowed: true, coverageGate: nil,
                   selectionNote: "693 public-domain books chosen by Wikipedia sitelinks (prominence), en/fr/es"),
  ]
  public let collectionCaveats = [
    CipherBooksAdapter.collection: ["Dates are Cipher list years (Wikidata-derived) or author-lifetime estimates, not verified first editions."],
  ]
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherBooksAdapter { CipherBooksAdapter(files: files) }

  private static let birthRE = JSRegex(js: #"(?:^|[\s,])(-?\d{3,4})\??\s*(?:BCE\s*)?-\s*(?:\d{3,4}|\?)?"#)
  private static let lifeTail = JSRegex(js: #",?\s*-?\d{3,4}\??-?\d{0,4}\??.*$"#)

  /// First author's birth year from a catalogue Authors cell ("Darwin, Charles, 1809-1882; …"), or nil.
  public static func firstAuthorBirth(_ authors: String?) -> Int? {
    let first = JSString.split(authors ?? "", ";")[0]
    guard let m = birthRE.exec(first), let g = m.groups[0] else { return nil }
    let y = Int(JSNumber.parse(g))
    return JSString.indexOf(first, "BCE") >= 0 ? 1 - y : y
  }

  /// "Austen, Jane, 1775-1817" → "Jane Austen".
  static func firstAuthorName(_ authors: String?) -> String? {
    let first = JSString.trim(lifeTail.replaceFirst(JSString.split(authors ?? "", ";")[0], with: ""))
    let parts = JSString.split(first, ",").map { JSString.trim($0) }.filter { !$0.isEmpty }
    return parts.count >= 2 ? "\(parts[1]) \(parts[0])" : parts.first
  }

  /// The dates of a book (§6.3).
  public static func bookDates(_ entry: JSONValue, _ catalog: GutenbergBooks.Book, by: String) throws -> [CanonicalDate] {
    var dates: [CanonicalDate] = []
    if let year = CipherFormat.integer(entry["year"]) {
      let birth = firstAuthorBirth(catalog.cat("Authors"))
      if let birth, year == birth + lifetimeOffset {
        dates.append(CanonicalDate(role: "publication",
                                   parsed: try DateGrammar.fromInterval(year, year, precision: "year", basis: "estimated",
                                                                        rule: "cipher_lifetime_year", raw: String(year)),
                                   assertedBy: by, isChronology: true,
                                   note: "Cipher's author-lifetime estimate (first author's birth \(birth) + 40); it may coincide with the true date"))
      } else {
        dates.append(CanonicalDate(role: "publication",
                                   parsed: try DateGrammar.fromInterval(year, year, precision: "year", basis: "stated",
                                                                        rule: "cipher_list_year", raw: String(year)),
                                   assertedBy: by, isChronology: true, note: "Cipher list year (Wikidata-derived), unverified"))
      }
    } else {
      dates.append(CanonicalDate(role: "publication", parsed: CipherFormat.unknownDate("cipher_books_no_year"), assertedBy: by,
                                 isChronology: true, note: "gutenberg.json gives no year"))
    }
    if let issued = catalog.cat("Issued"), !issued.isEmpty {
      dates.append(CanonicalDate(role: "release", raw: issued, assertedBy: by, isChronology: false,
                                 note: "Project Gutenberg release date (not a publication date)"))
    }
    return dates
  }

  static func catalogTags(_ b: GutenbergBooks.Book) -> [CanonicalTag] {
    guard b.catalog != nil else { return [] }
    var tags: [CanonicalTag] = []
    for c in JSString.split(b.cat("LoCC") ?? "", ";").map({ JSString.trim($0) }) where !c.isEmpty {
      tags.append(CanonicalTag(scheme: "locc", value: c, weight: nil, provenance: "catalog", method: catalogMethod))
    }
    for s in JSString.split(b.cat("Subjects") ?? "", ";").map({ JSString.trim($0) }) where !s.isEmpty {
      tags.append(CanonicalTag(scheme: "subject", value: s, weight: nil, provenance: "catalog", method: catalogMethod))
    }
    return tags
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    for member in [CipherPacks.gutenbergJSON, CipherPacks.pgCatalog] where !files.contains(member) {
      return .memberMissing(member)
    }
    let g = try GutenbergBooks.load(files)
    let missing = g.books.filter { !files.contains(CipherPacks.gutenbergText($0.id)) }.map(\.id)
    return AdapterProbeResult(available: true, manifestOK: true, formatOK: true,
                              counts: ["entries": g.entries, "books": g.books.count, "files_missing": missing.count,
                                       "aliases": g.books.reduce(0) { $0 + $1.others.count }],
                              caveats: missing.isEmpty ? [] : ["text missing for \(missing.count) books: \(missing.prefix(5).map(String.init).joined(separator: ", "))"])
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int {
    let g = try GutenbergBooks.load(files)
    guard let ids = params["ids"]?.arrayValue else { return g.books.count }
    let only = Set(ids.compactMap { CipherFormat.integer($0) ?? $0.stringValue.flatMap { Int($0) } })
    return g.books.filter { only.contains($0.id) }.count
  }

  /// One CanonicalDocument per Gutenberg id; `params.ids` limits the books, `params.skip` lists ext_ids already loaded.
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    let g = try GutenbergBooks.load(files)
    let only = params["ids"]?.arrayValue.map { Set($0.compactMap { CipherFormat.integer($0) }) }
    let skip = Set((params["skip"]?.arrayValue ?? []).compactMap(\.stringValue).map(CodeUnits.init))
    let by = CipherFormat.assertedBy(id, version)
    var out = BatchSender(channel)
    for b in g.books {
      if let only, !only.contains(b.id) { continue }
      let extId = "pg:\(b.id)"
      if skip.contains(CodeUnits(extId)) { continue }
      try Task.checkCancellation()
      let member = CipherPacks.gutenbergText(b.id)
      guard files.contains(member) else {
        context.warn("W_TEXT_MISSING", "\(extId): \(member) not found; skipped", nil)
        continue
      }
      let bytes = try files.data(member)
      let dec = CipherFormat.decode(bytes)
      let entryAuthor = b.entry["author"]?.stringValue
      let yHi = CipherFormat.integer(b.entry["year"])
      let gr = GutenbergText.regions(dec.text, yHi: yHi, author: entryAuthor ?? b.cat("Authors"))
      for var issue in gr.issues {
        issue.extId = extId
        context.report(issue)
      }
      if dec.decoder != "utf-8" {
        context.report(RecordIssue(code: "W_ENCODING_FALLBACK", field: "text",
                                   message: "\(extId): bytes are not valid UTF-8 (first bad byte at \(dec.badByte.map(String.init) ?? "null")); read as Windows-1252.",
                                   suggestion: "Nothing to do if the text reads correctly; otherwise re-download the file as UTF-8.",
                                   extId: extId))
      }
      let subjects = JSString.split(b.cat("Subjects") ?? "", ";").map { JSString.trim($0) }
      let field = FieldMap.laneForLocc(b.cat("LoCC"), subjects: subjects)
      let stored = try files.keep(member)
      let sha = files.info(member)!.sha256
      let title = b.entry["title"]?.stringValue ?? b.cat("Title")
      let author = (entryAuthor?.isEmpty == false ? entryAuthor : nil) ?? Self.firstAuthorName(b.cat("Authors")).flatMap { $0.isEmpty ? nil : $0 }
      let links = b.entry["links"]?.numberValue
      let meta: JSONValue = [
        "source": "gutenberg.json + pg_catalog.csv", "entries": .array([b.entry] + b.others), "catalog": b.catalogJSON,
        "text": ["$text": "document_text", "file": .string("texts/gutenberg/\(b.id).txt"), "marker": .string(gr.marker),
                 "had_bom": .bool(dec.hadBOM)],
      ]
      try await out.append(CanonicalDocument(
        extId: extId, kind: "book", title: title, author: author, field: field,
        langDeclared: b.entry["language"]?.stringValue, sourceUrl: "https://www.gutenberg.org/ebooks/\(b.id)",
        license: "Public domain in the USA (Project Gutenberg)", prominence: links.flatMap { $0.isFinite ? $0 : nil },
        text: CanonicalText(original: dec.text, decoder: dec.decoder, bodyStart: gr.bodyStart, bodyEnd: gr.bodyEnd,
                            regions: gr.regions.map(\.textRegion), mode: "auto"),
        dates: try Self.bookDates(b.entry, b, by: by),
        aliases: b.others.map { o in
          CanonicalAlias(extId: "wd:\(CipherFormat.string(o["q"]))", title: o["title"]?.stringValue,
                         note: "the same Gutenberg text (#\(b.id)) is listed by Cipher for this Wikidata item too (\(CipherFormat.integer(o["year"]).map(String.init) ?? o["year"].map { CipherFormat.string($0) }.flatMap { $0.isEmpty ? nil : $0 } ?? "no year"))")
        },
        tags: Self.catalogTags(b), originalMeta: meta,
        sourceFile: stored == sha ? SourceFileSpan(sha256: sha, byteStart: 0, byteEnd: bytes.count) : nil))
    }
    try await out.flush()
  }
}
