// OWNER: N2
// Port of `server/adapters/cipher/relations.mjs`: source adapter 'cipher.relations': the documented music genealogy
// beyond the 94k culture works (SPEC §6.6). songs/relations_{mb,wiki,itwofs}.json → one document per relation
// endpoint in `cipher-music-relations` (relation_endpoints, rate_eligible 0), keyed by its MusicBrainz recording
// (`mb:<uuid>`), its Wikidata item (`wd:Q…`) or `t:<fold(title)>|<fold(artist)>|<year>`. An endpoint that is a culture
// work (same Wikidata item, or folded title + a shared artist with years ±1) is not duplicated: the work gets the
// endpoint key as an alias. Every relationship is documented by its source record (`page`). A relation the
// culture-works siblings already state is not repeated: it is returned in `merged` and gains an `external_record`
// evidence row instead (applied by the bootstrap after the batch).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore
import Synchronization

/// The parsed relation files and the decision for every endpoint.
public struct RelationsModel: Sendable {
  public struct Endpoint: Sendable {
    public var key: String
    public var e: RelationEndpoint
    /// The culture-works row this endpoint is (an alias), or nil (its own document).
    public var work: Int?
  }
  public var records: [(code: String, rec: RelationRecord)]
  /// Endpoints in first-seen order.
  public var endpoints: [Endpoint]
  public var byKey: [String: Int]
  public var counts: [String: JSONValue]
  public var documents: Int
}

/// A relation the culture-works siblings already state: it gains an `external_record` evidence row.
public struct MergedRelation: Sendable, Equatable {
  public var relType: String
  public var src: DocKey
  public var dst: DocKey
  public var source: String
  public var locator: String?
  public var page: String?
  public var file: String
}

/// Source adapter 'cipher.relations'.
public struct CipherRelationsAdapter: PackBoundAdapter, CollectionCaveats, AliasSource {
  public static let adapterID = "cipher.relations"
  public static let collection = "cipher-music-relations"
  public static let packNames = [CipherPacks.meta]
  static let worksCollection = CipherWorksAdapter.collection
  static let yearNote = "year as recorded by Cipher from MusicBrainz/Wikipedia; may be a first-release year"

  public let id = CipherRelationsAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher music relations (genealogy)"
  public let access = AdapterAccess.localDataset
  public let license = "MusicBrainz CC0; Wikipedia CC BY-SA; ItwoFS CC BY 2.5 (link-back required)"
  public let attribution = "MusicBrainz; Wikipedia; ItwoFS"
  public let collections = [
    CollectionSpec(slug: CipherRelationsAdapter.collection, name: "Music relations: endpoints (Cipher)", domain: "culture",
                   modality: "titles", unit: "works", sampling: "relation_endpoints", rateEligible: false,
                   exportTextAllowed: true, coverageGate: nil,
                   selectionNote: "works that appear in documented sample/cover/version links"),
  ]
  public let collectionCaveats = [
    CipherRelationsAdapter.collection: [
      "Selected because they appear in a documented link: never a sample of music in general, so no rates.",
      "Absence of a link is not evidence of no sampling.",
    ],
  ]
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherRelationsAdapter { CipherRelationsAdapter(files: files) }

  /// `endpointKey(e)`.
  public static func endpointKey(_ e: RelationEndpoint) -> String {
    if let q = e.qid, q.hasPrefix("mb:") { return q }
    if let q = e.qid, isWikidataItem(q) { return "wd:\(q)" }
    return "t:\(CipherFormat.fold(e.title))|\(CipherFormat.fold(e.artist))|\(e.year.map(String.init) ?? "")"
  }

  /// `/^Q\d+$/`.
  static func isWikidataItem(_ q: String) -> Bool {
    let u = Array(q.utf8)
    return u.count >= 2 && u[0] == 0x51 && u[1...].allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  /// `statesLink(code, rec)`: ItwoFS's coincidence page states a resemblance, not an inspiration.
  public static func statesLink(_ code: String, _ rec: RelationRecord) -> Bool {
    !(code == "i" && JSString.toLowerCase(rec.page ?? "").hasSuffix("/coincidence.html"))
  }

  private static let modelCache = Mutex<(sha: String, model: RelationsModel)?>(nil)

  /// `loadRelations({works})`: parse the raw files and decide every endpoint.
  public func model() throws -> RelationsModel {
    let worksRows = files.contains(CipherPacks.cultureWorks) ? try CultureWorks.load(files).siblingRows : []
    let key = (files.contains(CipherPacks.cultureWorks) ? files.info(CipherPacks.cultureWorks)!.sha256 : "-")
      + RelationRecords.files.map { files.info(RelationRecords.member($0.file))?.sha256 ?? "-" }.joined()
    if let hit = Self.modelCache.withLock({ $0 }), hit.sha == key { return hit.model }

    var records: [(code: String, rec: RelationRecord)] = []
    var counts: [String: JSONValue] = [:]
    var leftOut = 0
    var recordCounts = JSONObject()
    for (code, file) in RelationRecords.files {
      guard let list = try RelationRecords.load(files, file: file) else { recordCounts[file] = "absent"; continue }
      recordCounts[file] = .number(Double(list.count))
      for rec in list {
        if Self.statesLink(code, rec) { records.append((code, rec)) } else { leftOut += 1 }
      }
    }
    // culture works by Wikidata item and by folded title
    var byQid: [String: Int] = [:], byTitle: [String: [Int]] = [:]
    for w in worksRows {
      if !w.qid.isEmpty { byQid[w.qid] = w.row }
      let k = Siblings.joinTitle(w.title)
      guard !k.isEmpty else { continue }
      byTitle[k, default: []].append(w.row)
    }
    var endpoints: [RelationsModel.Endpoint] = [], byKey: [String: Int] = [:]
    var aliased = 0, documents = 0, ambiguous = 0
    for (_, rec) in records {
      for e in [rec.a, rec.b] {
        guard let e, let title = e.title, !title.isEmpty else { continue }
        let key = Self.endpointKey(e)
        if byKey[key] != nil { continue }
        var work: Int?
        if let q = e.qid, let row = byQid[q] {
          work = row
        } else {
          let artists = Siblings.joinArtists(e.artist)
          let hits = (byTitle[Siblings.joinTitle(title)] ?? []).filter { row in
            let w = worksRows[row]
            return !Siblings.joinArtists(w.maker).isDisjoint(with: artists)
              && (w.year == nil || e.year == nil || abs(w.year! - e.year!) <= 1)
          }
          if hits.count == 1 { work = hits[0] } else if hits.count > 1 { ambiguous += 1 }
        }
        byKey[key] = endpoints.count
        endpoints.append(RelationsModel.Endpoint(key: key, e: e, work: work))
        if work != nil { aliased += 1 } else { documents += 1 }
      }
    }
    counts["records"] = .object(recordCounts)
    counts["endpoints"] = .number(Double(endpoints.count))
    counts["aliased"] = .number(Double(aliased))
    counts["documents"] = .number(Double(documents))
    counts["ambiguous"] = .number(Double(ambiguous))
    counts["left_out"] = .number(Double(leftOut))
    let model = RelationsModel(records: records, endpoints: endpoints, byKey: byKey, counts: counts, documents: documents)
    Self.modelCache.withLock { $0 = (key, model) }
    return model
  }

  /// Forgets the parsed model (end of phase A2).
  public static func clearCache() { modelCache.withLock { $0 = nil } }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    let missing = RelationRecords.files.filter { !files.contains(RelationRecords.member($0.file)) }.map(\.file)
    if missing.count == RelationRecords.files.count {
      return AdapterProbeResult(available: false, reason: "no raw relation files in \(CipherPacks.relationsDir)", manifestOK: false,
                                formatOK: false)
    }
    let m = try model()
    var counts: [String: Int] = [:]
    for (k, v) in m.counts where k != "records" { if let n = v.safeInteger { counts[k] = n } }
    for (k, v) in m.counts["records"]?.objectValue ?? [:] { if let n = v.safeInteger { counts[k] = n } }
    var caveats: [String] = []
    if !missing.isEmpty { caveats.append("not found: \(missing.joined(separator: ", "))") }
    if let left = m.counts["left_out"]?.safeInteger, left > 0 {
      caveats.append("\(left) ItwoFS rows of its coincidence page left out: they state a resemblance, not an inspiration")
    }
    return AdapterProbeResult(available: true, manifestOK: true, formatOK: true, counts: counts, caveats: caveats)
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { try model().documents }

  /// One metadata document per endpoint that is not a culture work; `params.skip` lists ext_ids already loaded.
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    let m = try model()
    for (_, file) in RelationRecords.files where files.contains(RelationRecords.member(file)) {
      try files.keep(RelationRecords.member(file))
    }
    let skip = Set((params["skip"]?.arrayValue ?? []).compactMap(\.stringValue).map(CodeUnits.init))
    let by = CipherFormat.assertedBy(id, version)
    let thisYear = DayMath.ymdFromDay(DayMath.today()).y
    var out = BatchSender(channel)
    for ep in m.endpoints {
      guard ep.work == nil, !skip.contains(CodeUnits(ep.key)) else { continue }
      try Task.checkCancellation()
      let e = ep.e
      let date: CanonicalDate
      if let y = e.year {
        if y <= thisYear {
          date = CanonicalDate(role: "release",
                               parsed: try DateGrammar.fromInterval(y, y, precision: "year", basis: "stated",
                                                                    rule: "cipher.relations.year", raw: String(y)),
                               assertedBy: by, isChronology: true, note: Self.yearNote)
        } else {
          date = CanonicalDate(role: "release", raw: String(y), assertedBy: by, isChronology: true, note: Self.yearNote)
        }
      } else {
        date = CanonicalDate(role: "release", parsed: CipherFormat.unknownDate("cipher.relations.year"), assertedBy: by,
                             isChronology: true, note: "no year in the relation record")
      }
      let title = e.title ?? ""
      let wd = e.qid.flatMap { Self.isWikidataItem($0) ? $0 : nil }
      try await out.append(CanonicalDocument(
        extId: ep.key, kind: "song", title: title, author: (e.artist ?? "").isEmpty ? nil : e.artist,
        culture: (e.culture ?? "").isEmpty ? nil : e.culture,
        sourceUrl: ep.key.hasPrefix("mb:") ? "https://musicbrainz.org/recording/\(ep.key.dropFirst(3))" : nil,
        fields: CanonicalFields(title: title), dates: [date],
        aliases: wd.map { [CanonicalAlias(extId: $0, note: "Wikidata item")] },
        originalMeta: ["source": "songs/relations_*.json endpoint", "endpoint": e.jsonValue]))
    }
    try await out.flush()
  }

  /// Aliases for endpoints that are culture works (the loader adds them before the relationships resolve).
  public func aliases(_ params: JSONValue, _ context: AdapterContext) async throws -> [AliasRecord] {
    try model().endpoints.compactMap { ep in
      ep.work.map {
        AliasRecord(target: DocKey(collection: Self.worksCollection, extId: "cw:\($0)"),
                    alias: CanonicalAlias(extId: ep.key, title: ep.e.title,
                                          note: "relation endpoint (MusicBrainz/Wikipedia/ItwoFS)"))
      }
    }
  }

  public func relationships(_ params: JSONValue, _ context: AdapterContext,
                            into channel: BoundedChannel<[CanonicalRelationship]>) async throws {
    var out = BatchSender(channel)
    for rel in try relationships(siblingKeys: nil).relationships {
      try Task.checkCancellation()
      try await out.append(rel)
    }
    try await out.flush()
  }

  /// One relationship per record, documented by the record's page; records whose relation the culture-works siblings
  /// already state (`siblingKeys`: `rel_type|cw:src|cw:dst|source`) are returned in `merged` instead.
  public func relationships(siblingKeys: Set<String>?) throws -> (relationships: [CanonicalRelationship], merged: [MergedRelation]) {
    let m = try model()
    let by = CipherFormat.assertedBy(id, version)
    var seen = Set<String>()
    var rels: [CanonicalRelationship] = [], merged: [MergedRelation] = []
    func end(_ ep: RelationsModel.Endpoint) -> CanonicalEndpoint {
      ep.work.map { CanonicalEndpoint(collection: Self.worksCollection, extId: "cw:\($0)") }
        ?? CanonicalEndpoint(collection: Self.collection, extId: ep.key)
    }
    func docKey(_ e: CanonicalEndpoint) -> DocKey { DocKey(collection: e.collection ?? "", extId: e.extId ?? "") }
    for (code, rec) in m.records {
      guard let ra = rec.a, let rb = rec.b, let ia = m.byKey[Self.endpointKey(ra)], let ib = m.byKey[Self.endpointKey(rb)]
      else { continue }
      let a = m.endpoints[ia], b = m.endpoints[ib]
      guard a.key != b.key else { continue }
      guard let mapped = Siblings.map(relation: rec.forward ?? "", row: 1, source: code, from: 0) else { continue }
      let (src, dst) = mapped.src == 0 ? (a, b) : (b, a)
      let locator = Siblings.pageLocator(code, rec.page)
      if let sw = src.work, let dw = dst.work, siblingKeys?.contains("\(mapped.relType)|cw:\(sw)|cw:\(dw)|\(code)") == true {
        merged.append(MergedRelation(relType: mapped.relType, src: docKey(end(src)), dst: docKey(end(dst)), source: code,
                                     locator: locator, page: rec.page, file: Siblings.rawFiles[code] ?? ""))
        continue
      }
      let dedupe = "\(mapped.relType)|\(src.key)|\(dst.key)|\(code)"
      guard seen.insert(dedupe).inserted else { continue }
      let s = Siblings.sources[code]!
      let file = RelationRecords.files.first { $0.code == code }!.file
      var rel = CanonicalRelationship(
        src: end(src), dst: end(dst), relType: mapped.relType, evidenceStatus: "documented", origin: "source_dataset",
        sourceDataset: s.dataset, method: "\(s.label) relation record (\(file))", createdBy: by,
        score: rec.strength.flatMap { $0.isFinite ? Score(value: $0, kind: "heuristic_strength") : nil },
        license: s.license, attribution: s.attribution, provenanceNote: "Cipher raw relation '\(rec.forward ?? "")'")
      if let locator { rel.sourceLocator = locator } else { rel.provenanceQuality = "source_unrecorded" }
      rels.append(rel)
    }
    return (rels, merged)
  }
}
