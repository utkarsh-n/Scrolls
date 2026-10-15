// OWNER: N2
// Port of `server/adapters/cipher/siblings.mjs`: culture-works `siblings` → CanonicalRelationship rows (SPEC §6.6).
// Cipher writes each link on both rows and keeps each row's top 8 relatives, so a pair may appear once or twice;
// items with the same (rel_type, src, dst, source code) collapse into one relationship. Evidence status is fixed here,
// once, by the source code: w/d/m/i → documented; kindred → computed (Cipher's theme cosine, with a run); counterpart
// → proposed; any other '-' relation → proposed (machine_tagger) when the pair appears in either work's tagging batch,
// else documented with provenance_quality 'source_unrecorded' (DOC*).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The parse-side statistics of the sibling mapping (reconciliation, §6.8).
public struct SiblingStats: Sendable {
  public var items = 0, unparsed = 0, unknownRelation = 0, badRow = 0, selfLinks = 0, collapsed = 0
  public var byLabel: [String: Int] = [:]
  public var expected: [String: Int] = [:]
  public var locatorsMatched = 0, locatorsUnmatched = 0
  public var rawFiles: [String: Int] = [:]
  public var rawMissing: [String] = []
  public var relationships = 0

  public var jsonValue: JSONValue {
    var o: JSONObject = [
      "items": .number(Double(items)), "unparsed": .number(Double(unparsed)), "unknown_relation": .number(Double(unknownRelation)),
      "bad_row": .number(Double(badRow)), "self": .number(Double(selfLinks)), "collapsed": .number(Double(collapsed)),
      "by_label": .object(JSONObject(byLabel.map { ($0.key, JSONValue.number(Double($0.value))) })),
      "expected": .object(JSONObject(expected.map { ($0.key, JSONValue.number(Double($0.value))) })),
      "locators": ["matched": .number(Double(locatorsMatched)), "unmatched": .number(Double(locatorsUnmatched))],
      "raw_files": .object(JSONObject(rawFiles.map { ($0.key, JSONValue.number(Double($0.value))) })),
      "relationships": .number(Double(relationships)),
    ]
    if !rawMissing.isEmpty { o["raw_missing"] = .array(rawMissing.map(JSONValue.string)) }
    return .object(o)
  }
}

public enum Siblings {
  /// Cipher relation label → (rel_type, direction): 'fwd' the row is the later/dependent end; 'back' the sibling is;
  /// 'sym' undirected.
  public static let relationMap: [String: (relType: String, dir: String)] = [
    "samples": ("samples", "fwd"), "sampled by": ("samples", "back"),
    "interpolates": ("interpolates", "fwd"), "interpolated in": ("interpolates", "back"),
    "cover of": ("cover_of", "fwd"), "covered as": ("cover_of", "back"),
    "version of": ("version_of", "fwd"), "other version": ("version_of", "back"),
    "remix of": ("remix_of", "fwd"), "remixed as": ("remix_of", "back"),
    "answer song to": ("answer_to", "fwd"), "answered by": ("answer_to", "back"),
    "inspired by": ("inspired_by", "fwd"), "inspired": ("inspired_by", "back"),
    "from film": ("part_of", "fwd"), "features song": ("part_of", "back"),
    "written for": ("part_of", "fwd"), "song from": ("part_of", "back"),
    "based on": ("adaptation_of", "fwd"), "adapted as": ("adaptation_of", "back"),
    "remake of": ("remake_of", "fwd"), "remade as": ("remake_of", "back"),
    "homage to": ("homage_to", "fwd"), "echoed by": ("homage_to", "back"),
    "kindred": ("kindred", "sym"), "counterpart": ("counterpart", "sym"),
  ]

  /// Source code → dataset, label, licence and attribution of the documented record.
  public struct Source: Sendable {
    public let dataset: String, label: String, license: String, attribution: String
  }
  public static let sources: [String: Source] = [
    "w": Source(dataset: "wikipedia", label: "Wikipedia", license: "CC BY-SA", attribution: "Wikipedia contributors (CC BY-SA)"),
    "d": Source(dataset: "wikidata", label: "Wikidata", license: "CC0", attribution: "Wikidata (CC0)"),
    "m": Source(dataset: "musicbrainz", label: "MusicBrainz", license: "CC0", attribution: "MusicBrainz (CC0)"),
    "i": Source(dataset: "itwofs", label: "ItwoFS", license: "CC BY 2.5",
                attribution: "ItwoFS (itwofs.com), CC BY 2.5 — link back to the source page"),
  ]

  public static let kindredMethod = "cipher-theme-cosine (build_culture.py): rarity-weighted theme cosine ≥ 0.42, capped 0.7, cross-culture"
  public static let counterpartMethod = "Cipher tagging pass or title match"
  public static let unrecordedNote = "Wikidata P144/P941/P4969, Wikipedia lead or remake/format table — source not recorded by Cipher"
  static let rawFiles: [String: String] = ["w": "relations_wiki.json", "m": "relations_mb.json", "i": "relations_itwofs.json"]

  /// One parsed `row:relation:strength[:source]` item.
  public struct Item: Sendable {
    public var row: Int
    public var relation: String
    public var strength: Double?
    public var source: String?
    public var ok: Bool
  }

  /// `parseSiblings(field)`.
  public static func parse(_ field: String) -> [Item] {
    guard !field.isEmpty else { return [] }
    return JSString.split(field, "|").filter { !$0.isEmpty }.map { raw in
      let p = JSString.split(raw, ":")
      let rowNumber = JSNumber.parse(p[0])
      let row = rowNumber.isFinite && rowNumber.rounded(.towardZero) == rowNumber && rowNumber >= 0 && rowNumber < 1e9
        ? Int(rowNumber) : -1
      let strengthValue = p.count >= 3 ? JSNumber.parse(p[2]) : .nan
      let source = p.count >= 4 && !p[3].isEmpty ? p[3] : nil
      let ok = (p.count == 3 || p.count == 4) && row >= 0 && strengthValue.isFinite
      return Item(row: row, relation: p.count > 1 ? p[1] : "", strength: strengthValue.isFinite ? strengthValue : nil,
                  source: source, ok: ok)
    }
  }

  /// A mapped item.
  public struct Mapped: Sendable {
    public var relType: String
    public var src: Int
    public var dst: Int
    public var directed: Bool
    public var evidenceStatus: String
    public var origin: String
    public var source: String?
  }

  /// `mapSibling(item, {from, taggedPair})`.
  public static func map(relation: String, row: Int, source: String?, from: Int, taggedPair: Bool = false) -> Mapped? {
    guard let m = relationMap[relation] else { return nil }
    let directed = m.dir != "sym"
    let (src, dst) = m.dir == "fwd" ? (from, row) : m.dir == "back" ? (row, from) : (max(from, row), min(from, row))
    let known = source.flatMap { sources[$0] != nil ? $0 : nil }
    let status: (String, String)
    if m.relType == "kindred" { status = ("computed", "algorithm") }
    else if m.relType == "counterpart" { status = ("proposed", "machine_tagger") }
    else if known != nil { status = ("documented", "source_dataset") }
    else if taggedPair { status = ("proposed", "machine_tagger") }
    else { status = ("documented", "source_dataset") }
    return Mapped(relType: m.relType, src: src, dst: dst, directed: directed, evidenceStatus: status.0, origin: status.1,
                  source: m.relType == "kindred" || m.relType == "counterpart" ? nil : known)
  }

  // MARK: titles, artists, locators

  private static let bracketed = JSRegex(js: #"\(.*?\)|\[.*?\]"#)
  private static let featTail = JSRegex(js: #"\s(?:feat\.?|ft\.|featuring)\s.*$"#, "i")
  private static let artistSplit = JSRegex(js:
    #"\s*(?:,|;|&|\+|/|(?<![A-Za-z0-9_])feat\.?|(?<![A-Za-z0-9_])ft\.|(?<![A-Za-z0-9_])featuring(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])with(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])and(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])y(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])et(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])x(?![A-Za-z0-9_]))\s*"#,
    "i")

  /// `joinTitle(title)`: no "(…)", "[…]" or "feat. …" tail, then folded.
  public static func joinTitle(_ title: String?) -> String {
    let a = bracketed.replaceAll(title ?? "", with: " ")
    return CipherFormat.fold(featTail.replaceFirst(a, with: " "))
  }

  /// `joinArtists(artist)`: every credited artist, folded.
  public static func joinArtists(_ artist: String?) -> Set<String> {
    Set(artistSplit.split(artist ?? "").map { CipherFormat.fold($0) }.filter { !$0.isEmpty })
  }

  static func rawKey(_ code: String, title: String?) -> String { "\(code)|\(joinTitle(title))" }

  static func yearsAgree(_ a: Int?, _ b: Int?) -> Bool {
    guard let a, let b else { return true }
    return abs(a - b) <= 1
  }

  private static let editionPrefix = JSRegex(js: "^(fr|es|en):(.+)$")

  /// `pageLocator(code, page)`: MusicBrainz and ItwoFS pages are URLs already; Wikipedia pages are article titles,
  /// prefixed "fr:"/"es:" for those editions.
  public static func pageLocator(_ code: String, _ page: String?) -> String? {
    guard let page, !page.isEmpty else { return nil }
    if page.hasPrefix("http://") || page.hasPrefix("https://") { return page }
    guard code == "w" else { return nil }
    let m = editionPrefix.exec(page)
    let site = m?.groups[0] ?? "en"
    let title = (m?.groups[1] ?? page).replacingOccurrences(of: " ", with: "_")
    let encoded = JSText.encodeURIComponent(title).replacingOccurrences(of: "%2F", with: "/").replacingOccurrences(of: "%3A", with: ":")
    return "https://\(site).wikipedia.org/wiki/\(encoded)"
  }

  /// A work as the locator join compares it.
  public struct WorkRef: Sendable {
    public var title: String
    public var maker: String
    public var year: Int?
  }

  /// An index of the raw files by (source, folded title), for the wanted keys only.
  public struct RawIndex: Sendable {
    var entries: [String: [(record: Int, file: String, side: Character)]] = [:]
    var records: [String: [RelationRecord]] = [:]
  }

  /// `loadRawRelations(relationsDir, wanted)`.
  public static func loadRawIndex(_ files: SourceFiles, wanted: Set<String>) throws
    -> (index: RawIndex, counts: [String: Int], missing: [String])
  {
    var index = RawIndex()
    var counts: [String: Int] = [:], missing: [String] = []
    for code in ["w", "m", "i"] {
      let file = rawFiles[code]!
      guard let list = try RelationRecords.load(files, file: file) else { missing.append(file); continue }
      counts[file] = list.count
      index.records[file] = list
      for (n, rec) in list.enumerated() {
        for side: Character in ["a", "b"] {
          guard let e = rec.side(side), let t = e.title, !t.isEmpty else { continue }
          let key = rawKey(code, title: t)
          guard wanted.contains(key) else { continue }
          index.entries[key, default: []].append((n, file, side))
        }
      }
    }
    return (index, counts, missing)
  }

  private static func shareArtist(_ a: Set<String>, _ b: Set<String>) -> Bool { !a.isDisjoint(with: b) }

  /// `findLocator(index, code, a, b)`.
  static func findLocator(_ index: RawIndex, _ code: String, _ a: WorkRef, _ b: WorkRef) -> String? {
    let kb = rawKey(code, title: b.title)
    let artistsA = joinArtists(a.maker), artistsB = joinArtists(b.maker)
    for entry in index.entries[rawKey(code, title: a.title)] ?? [] {
      guard let rec = index.records[entry.file]?[entry.record] else { continue }
      let mine = entry.side == "a" ? rec.a : rec.b
      let other = entry.side == "a" ? rec.b : rec.a
      guard let mine, let other, let ot = other.title, !ot.isEmpty, rawKey(code, title: ot) == kb else { continue }
      guard shareArtist(artistsA, joinArtists(mine.artist)), shareArtist(artistsB, joinArtists(other.artist)) else { continue }
      guard yearsAgree(mine.year, a.year), yearsAgree(other.year, b.year) else { continue }
      if let loc = pageLocator(code, rec.page) { return loc }
    }
    return nil
  }

  // MARK: the whole mapping

  /// A culture-works row as the mapping needs it.
  public struct Row: Sendable {
    public var row: Int
    public var qid: String
    public var title: String
    public var native: String
    public var maker: String
    public var year: Int?
    public var siblings: String
  }

  static func taggedNames(_ tagged: TaggedWork?, _ b: Row) -> Bool {
    guard let tagged else { return false }
    let titles = Set([CipherFormat.fold(b.title), CipherFormat.fold(b.native)].filter { !$0.isEmpty })
    return tagged.siblings.contains { s in
      titles.contains(s.title) && (s.year == nil || b.year == nil || abs(s.year! - b.year!) <= 2)
    }
  }

  /// `buildSiblingRelationships(...)`: the culture-works relationships and the parse statistics.
  public static func build(rows: [Row], tagIndex: [String: TaggedWork], files: SourceFiles?, kindredRunID: RunID?,
                           createdBy: String, collection: String) throws -> (relationships: [CanonicalRelationship], stats: SiblingStats) {
    var stats = SiblingStats()
    struct Group { var mapped: Mapped; var strength: Double; var labels: [String] }
    var order: [String] = []
    var groups: [String: Group] = [:]
    for r in rows {
      for item in parse(r.siblings) {
        stats.items += 1
        let label = "\(item.relation) [\(item.source ?? "-")]"
        stats.byLabel[label, default: 0] += 1
        guard item.ok else { stats.unparsed += 1; continue }
        guard item.row < rows.count else { stats.badRow += 1; continue }
        guard item.row != r.row else { stats.selfLinks += 1; continue }
        let other = rows[item.row]
        let needsTagCheck = item.source == nil && relationMap[item.relation].map { !["kindred", "counterpart"].contains($0.relType) } == true
        let taggedPair = needsTagCheck && (taggedNames(tagIndex[r.qid], other) || taggedNames(tagIndex[other.qid], r))
        guard let mapped = map(relation: item.relation, row: item.row, source: item.source, from: r.row, taggedPair: taggedPair)
        else { stats.unknownRelation += 1; continue }
        let key = "\(mapped.relType)|\(mapped.src)|\(mapped.dst)|\(mapped.source ?? "-")"
        if var g = groups[key] {
          stats.collapsed += 1
          g.strength = max(g.strength, item.strength ?? -.infinity)
          if !g.labels.contains(where: { JSString.equal($0, item.relation) }) { g.labels.append(item.relation) }
          if mapped.evidenceStatus == "proposed" && g.mapped.evidenceStatus == "documented" && mapped.source == nil { g.mapped = mapped }
          groups[key] = g
        } else {
          groups[key] = Group(mapped: mapped, strength: item.strength ?? -.infinity, labels: [item.relation])
          order.append(key)
        }
      }
    }

    // the locator join for w/m/i
    var index = RawIndex()
    if let files {
      var wanted = Set<String>()
      for key in order {
        let m = groups[key]!.mapped
        guard let s = m.source, rawFiles[s] != nil else { continue }
        wanted.insert(rawKey(s, title: rows[m.src].title))
        wanted.insert(rawKey(s, title: rows[m.dst].title))
      }
      let raw = try loadRawIndex(files, wanted: wanted)
      index = raw.index
      stats.rawFiles = raw.counts
      stats.rawMissing = raw.missing
    }

    var out: [CanonicalRelationship] = []
    for key in order {
      let g = groups[key]!
      let m = g.mapped
      let src = rows[m.src], dst = rows[m.dst]
      var rel = CanonicalRelationship(
        src: CanonicalEndpoint(collection: collection, extId: "cw:\(m.src)"),
        dst: CanonicalEndpoint(collection: collection, extId: "cw:\(m.dst)"),
        relType: m.relType, evidenceStatus: m.evidenceStatus, origin: m.origin, createdBy: createdBy,
        score: Score(value: g.strength, kind: "heuristic_strength"),
        provenanceNote: "Cipher " + g.labels.map { "'\($0)'" }.joined(separator: " / "))
      if m.relType == "kindred" {
        rel.method = kindredMethod
        rel.runId = kindredRunID
      } else if m.relType == "counterpart" {
        rel.method = counterpartMethod
      } else if m.evidenceStatus == "proposed" {
        rel.method = "\(CipherFormat.taggingMethod); pair named in a tagging batch (title, year ±2)"
      } else if let code = m.source, let s = sources[code] {
        rel.sourceDataset = s.dataset
        rel.license = s.license
        rel.attribution = s.attribution
        rel.method = "\(s.label) via Cipher ('\(code)')"
        let a = WorkRef(title: src.title, maker: src.maker, year: src.year)
        let b = WorkRef(title: dst.title, maker: dst.maker, year: dst.year)
        let loc = rawFiles[code] != nil ? (findLocator(index, code, a, b) ?? findLocator(index, code, b, a)) : nil
        if let loc {
          rel.sourceLocator = loc
          stats.locatorsMatched += 1
        } else {
          rel.provenanceQuality = "source_unrecorded"
          if rawFiles[code] != nil { stats.locatorsUnmatched += 1 }
          rel.provenanceNote! += code == "d" ? "; Wikidata statement, item not recorded" : "; not found in \(rawFiles[code]!)"
        }
      } else {
        rel.sourceDataset = "wikidata-or-wikipedia"
        rel.provenanceQuality = "source_unrecorded"
        rel.provenanceNote! += "; \(unrecordedNote)"
      }
      // after the locator join, as siblings.mjs does (it counts locators of every group): relationMap names only
      // seeded rel_types, so nothing is dropped here in practice
      guard Vocab.relTypeByCode.contains(key: rel.relType) else { continue }
      stats.expected["\(rel.relType)|\(rel.evidenceStatus)", default: 0] += 1
      out.append(rel)
    }
    stats.relationships = out.count
    return (out, stats)
  }
}
