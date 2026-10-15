// OWNER: N2
// Port of `server/adapters/cipher/works.mjs`: source adapter 'cipher.works': culture-works.tsv (94,385 rows, no
// header, 16 columns, 0-based row = id) → one metadata document per row, siblings → relationships, meanings → machine
// glosses (SPEC §6.5, §6.6). Titles are the only text dated with the work; summaries are later descriptions.
// Reads the cipher-meta pack (`culture-works.tsv`, `tags/*.jsonl`, `songs/relations_*.json`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore
import Synchronization

/// The parsed culture-works.tsv (cached per member sha256 for the process: phase A and A2 both read it).
public struct CultureWorks: Sendable {
  public struct Row: Sendable {
    public var row: Int
    public var cols: [String]
    public var year: Int?
    public var byteStart: Int
    public var byteEnd: Int
    public func col(_ name: String) -> String { cols[CultureWorks.column[name]!] }
  }
  public static let columns = ["qid", "kind", "culture", "year", "weight", "title", "native_title", "maker", "summary",
                               "canon", "themes", "motifs", "meaning", "mood", "siblings", "sampled_count"]
  static let column: [String: Int] = Dictionary(uniqueKeysWithValues: columns.enumerated().map { ($1, $0) })

  public var sha256: String
  public var rows: [Row]
  /// Lines that do not have 16 tab-separated fields: (line number, fields).
  public var bad: [(line: Int, fields: Int)]

  private static let cache = Mutex<CultureWorks?>(nil)

  /// `loadWorks()`: parsed once per member sha256.
  public static func load(_ files: SourceFiles) throws -> CultureWorks {
    guard let info = files.info(CipherPacks.cultureWorks) else {
      throw SourceFilesError.missing(CipherPacks.cultureWorks, in: files.packs.map(\.name))
    }
    if let hit = cache.withLock({ $0 }), hit.sha256 == info.sha256 { return hit }
    let data = try files.data(CipherPacks.cultureWorks)
    var rows: [Row] = []
    var bad: [(line: Int, fields: Int)] = []
    for line in CipherFormat.lines(data) {
      var c = CipherFormat.tabFields(data, line)
      if c.count != columns.count { bad.append((line.index + 1, c.count)) }
      if c.count < columns.count { c += Array(repeating: "", count: columns.count - c.count) }
      if c.count > columns.count { c = Array(c.prefix(columns.count)) }
      // '' is Cipher's unknown year (8,227 rows); 0 never occurs but would mean the same (§0.1)
      let y = c[3]
      let year = CipherFormat.isIntegerLiteral(y) && y != "0" ? Int(JSNumber.parse(y)) : nil
      rows.append(Row(row: line.index, cols: c, year: year, byteStart: line.byteStart, byteEnd: line.byteEnd))
    }
    let parsed = CultureWorks(sha256: info.sha256, rows: rows, bad: bad)
    cache.withLock { $0 = parsed }
    return parsed
  }

  /// Forgets the parsed rows.
  public static func clear() { cache.withLock { $0 = nil } }

  /// The rows as the sibling mapping and the relations adapter see them.
  public var siblingRows: [Siblings.Row] {
    rows.map {
      Siblings.Row(row: $0.row, qid: $0.cols[0], title: $0.cols[5], native: $0.cols[6], maker: $0.cols[7], year: $0.year,
                   siblings: $0.cols[14])
    }
  }
}

/// Source adapter 'cipher.works'.
public struct CipherWorksAdapter: PackBoundAdapter, CollectionCaveats {
  public static let adapterID = "cipher.works"
  public static let collection = "cipher-culture-works"
  public static let packNames = [CipherPacks.meta]

  public let id = CipherWorksAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher culture works"
  public let access = AdapterAccess.localDataset
  public let license = "Wikidata CC0"
  public let attribution = "Wikidata; Wikipedia"
  public let collections = [
    CollectionSpec(slug: CipherWorksAdapter.collection, name: "Culture works: titles (Cipher)", domain: "culture",
                   modality: "titles", unit: "works", sampling: "prominence_selected", rateEligible: true,
                   exportTextAllowed: true, coverageGate: nil,
                   selectionNote: "Wikidata works ranked by sitelinks and canon lists"),
  ]
  public let collectionCaveats = [
    CipherWorksAdapter.collection: [
      "Titles only: Cipher holds no lyrics.",
      "Summaries are later descriptions (Wikidata) and are excluded from counts by default.",
      "Themes, motifs, moods and one-line meanings partly come from a machine tagging pass; they are fallible annotations, never text.",
    ],
  ]
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherWorksAdapter { CipherWorksAdapter(files: files) }

  static let summaryEra = (2012, 2026)

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    guard files.contains(CipherPacks.cultureWorks) else { return .memberMissing(CipherPacks.cultureWorks) }
    var missing: [String] = []
    if files.members(prefix: CipherPacks.tagsDir).isEmpty { missing.append("tagsDir") }
    if files.members(prefix: CipherPacks.relationsDir).isEmpty { missing.append("relationsDir") }
    let w = try CultureWorks.load(files)
    let reason = w.bad.first.map { "\(w.bad.count) rows do not have \(CultureWorks.columns.count) tab-separated columns (first: line \($0.line))" }
    return AdapterProbeResult(available: w.bad.isEmpty, reason: reason, manifestOK: true, formatOK: w.bad.isEmpty,
                              counts: ["works": w.rows.count, "undated": w.rows.filter { $0.year == nil }.count],
                              caveats: missing.isEmpty ? [] : ["not found: \(missing.joined(separator: ", ")) (tag provenance or locators fall back)"])
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int {
    try CultureWorks.load(files).rows.count
  }

  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    let w = try CultureWorks.load(files)
    let tags = try TagsProvenance.loadIndex(files)
    let by = CipherFormat.assertedBy(id, version)
    let limit = CipherFormat.integer(params["limit"]) ?? w.rows.count
    let stored = try files.keep(CipherPacks.cultureWorks)
    var out = BatchSender(channel)
    let summaryDate = try DateGrammar.fromInterval(Self.summaryEra.0, Self.summaryEra.1, precision: "range", basis: "estimated",
                                                   rule: "wikidata_description_era")
    for r in w.rows.prefix(max(0, min(limit, w.rows.count))) {
      try Task.checkCancellation()
      let c = r.cols
      let title = c[5], native = c[6], summary = c[8], maker = c[7], kind = c[1], culture = c[2], weight = c[4], qid = c[0]
      var fields = CanonicalFields(title: title)
      if !native.isEmpty && !JSString.equal(native, title) { fields.nativeTitle = native }
      if !summary.isEmpty { fields.summary = summary }
      var dates = [chronology(r, by)]
      if !summary.isEmpty {
        dates.append(CanonicalDate(role: "authored_description", parsed: summaryDate, assertedBy: by,
                                   note: "Wikidata description, written 2012–2026 (estimated)"))
      }
      var meta: JSONObject = ["source": "culture-works.tsv", "row": .number(Double(r.row))]
      for (i, k) in CultureWorks.columns.enumerated() { meta[k] = .string(c[i]) }
      let prominence: Double? = weight.isEmpty ? nil : CipherFormat.finiteNumber(weight)
      let doc = CanonicalDocument(
        extId: "cw:\(r.row)", kind: kind.isEmpty ? "work" : kind, title: title.isEmpty ? nil : title,
        nativeTitle: fields.nativeTitle, author: maker.isEmpty ? nil : maker, culture: culture.isEmpty ? nil : culture,
        prominence: prominence, fields: fields, fieldRoles: CanonicalFieldRoles(summary: "describes"), dates: dates,
        aliases: qid.isEmpty ? [] : [CanonicalAlias(extId: qid, note: qid.hasPrefix("Q") ? "Wikidata item" : "Cipher stub id")],
        tags: TagsProvenance.workTags(maker: maker, canon: c[9], themes: c[10], motifs: c[11], mood: c[13], tagged: tags[qid]),
        originalMeta: .object(meta),
        sourceFile: stored == w.sha256 ? SourceFileSpan(sha256: w.sha256, byteStart: r.byteStart, byteEnd: r.byteEnd) : nil)
      try await out.append(doc)
    }
    try await out.flush()
  }

  /// '' (or 0) → undated; otherwise the raw year through the date grammar (> now → announced, negative → BCE).
  func chronology(_ r: CultureWorks.Row, _ by: String) -> CanonicalDate {
    guard r.year != nil else {
      return CanonicalDate(role: "publication", parsed: CipherFormat.unknownDate("cipher_works_year", raw: r.cols[3]),
                           assertedBy: by, isChronology: true, note: "no year in culture-works.tsv")
    }
    return CanonicalDate(role: "publication", raw: r.cols[3], assertedBy: by, isChronology: true, note: "Cipher year (Wikidata)")
  }

  /// Siblings → relationships (§6.6); `params.runIds.cipher_load` is the run behind the computed kindred pairs.
  public func relationships(_ params: JSONValue, _ context: AdapterContext,
                            into channel: BoundedChannel<[CanonicalRelationship]>) async throws {
    let mapping = try siblingMapping(kindredRun: CipherFormat.integer(params["runIds"]?["cipher_load"]).map { RunID(rawValue: Int64($0)) })
    var out = BatchSender(channel)
    for r in mapping.relationships {
      try Task.checkCancellation()
      try await out.append(r)
    }
    try await out.flush()
  }

  /// The relationships and the parse-side statistics (reconciliation, §6.8).
  public func siblingMapping(kindredRun: RunID?) throws -> (relationships: [CanonicalRelationship], stats: SiblingStats) {
    let w = try CultureWorks.load(files)
    let hasRelations = !files.members(prefix: CipherPacks.relationsDir).isEmpty
    return try Siblings.build(rows: w.siblingRows, tagIndex: try TagsProvenance.loadIndex(files),
                              files: hasRelations ? files : nil, kindredRunID: kindredRun,
                              createdBy: CipherFormat.assertedBy(id, version), collection: Self.collection)
  }

  /// One-line meanings → machine glosses on the work (not document text, §6.5).
  public func annotations(_ params: JSONValue, _ context: AdapterContext,
                          into channel: BoundedChannel<[CanonicalAnnotation]>) async throws {
    let w = try CultureWorks.load(files)
    var out = BatchSender(channel)
    for r in w.rows where !r.cols[12].isEmpty {
      try Task.checkCancellation()
      try await out.append(CanonicalAnnotation(
        target: CanonicalAnnotationTarget(type: "document", extId: "cw:\(r.row)"), kind: "machine_gloss",
        author: "Cipher tagging pass", isMachine: true, method: CipherFormat.taggingMethod, layer: "Cipher tagging pass",
        bodyMd: r.cols[12], tags: []))
    }
    try await out.flush()
  }
}
