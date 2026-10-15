// OWNER: N2
// The raw music relation files of Cipher (`songs/relations_{mb,wiki,itwofs}.json`: 161,803 + 9,581 + 428 records of
// {a, b, forward, backward, strength, source, page}), decoded straight into structs (the 76 MB MusicBrainz file would
// cost hundreds of MB as a generic JSON tree on the phone). They are read by the culture-works locator join
// (siblings.mjs, phase A) and by `cipher.relations` (phase A2), so the decoded files are kept for the process,
// keyed by the member sha256, until `RelationRecords.clear()`.

import Foundation
import ScrollsContracts
import ScrollsCore
import Synchronization

/// One end of a raw relation record, with which keys the file actually wrote (the endpoint is kept verbatim in
/// `original_meta`).
public struct RelationEndpoint: Sendable, Decodable {
  public var title: String?
  public var artist: String?
  public var qid: String?
  public var culture: String?
  /// `Number.isInteger(year) ? year : null` is applied by the readers; the raw number is kept for the verbatim copy.
  public var yearValue: Double?
  public var hasKey: Set<String>

  enum K: String, CodingKey, CaseIterable { case title, artist, qid, culture, year }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    hasKey = Set(c.allKeys.map(\.rawValue))
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    artist = try? c.decodeIfPresent(String.self, forKey: .artist)
    qid = try? c.decodeIfPresent(String.self, forKey: .qid)
    culture = try? c.decodeIfPresent(String.self, forKey: .culture)
    yearValue = try? c.decodeIfPresent(Double.self, forKey: .year)
  }

  /// `Number.isInteger(e.year) ? e.year : null`.
  public var year: Int? {
    guard let y = yearValue, y.isFinite, y.rounded(.towardZero) == y, abs(y) < 1e9 else { return nil }
    return Int(y)
  }

  /// The endpoint as the file wrote it (absent keys stay absent; null stays null).
  public var jsonValue: JSONValue {
    var o = JSONObject()
    if hasKey.contains("title") { o["title"] = title.map(JSONValue.string) ?? .null }
    if hasKey.contains("artist") { o["artist"] = artist.map(JSONValue.string) ?? .null }
    if hasKey.contains("qid") { o["qid"] = qid.map(JSONValue.string) ?? .null }
    if hasKey.contains("culture") { o["culture"] = culture.map(JSONValue.string) ?? .null }
    if hasKey.contains("year") { o["year"] = yearValue.map(JSONValue.number) ?? .null }
    return .object(o)
  }
}

/// One raw relation record.
public struct RelationRecord: Sendable, Decodable {
  public var a: RelationEndpoint?
  public var b: RelationEndpoint?
  public var forward: String?
  public var backward: String?
  public var strength: Double?
  public var source: String?
  public var page: String?

  enum K: String, CodingKey { case a, b, forward, backward, strength, source, page }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    a = try? c.decodeIfPresent(RelationEndpoint.self, forKey: .a)
    b = try? c.decodeIfPresent(RelationEndpoint.self, forKey: .b)
    forward = try? c.decodeIfPresent(String.self, forKey: .forward)
    backward = try? c.decodeIfPresent(String.self, forKey: .backward)
    strength = try? c.decodeIfPresent(Double.self, forKey: .strength)
    source = try? c.decodeIfPresent(String.self, forKey: .source)
    page = try? c.decodeIfPresent(String.self, forKey: .page)
  }

  public func side(_ s: Character) -> RelationEndpoint? { s == "a" ? a : b }
}

/// The three raw files by source code.
public enum RelationRecords {
  /// Source code → file name (siblings.mjs RAW_FILES / relations.mjs FILES), in relations.mjs's order.
  public static let files: [(code: String, file: String)] = [
    ("m", "relations_mb.json"), ("w", "relations_wiki.json"), ("i", "relations_itwofs.json"),
  ]

  public static func member(_ file: String) -> String { CipherPacks.relationsDir + file }

  private static let cache = Mutex<[String: [RelationRecord]]>([:])

  /// The decoded records of one file (nil when the pack has no such member).
  public static func load(_ files: SourceFiles, file: String) throws -> [RelationRecord]? {
    let m = member(file)
    guard let info = files.info(m) else { return nil }
    if let hit = cache.withLock({ $0[info.sha256] }) { return hit }
    let data = try files.data(m)
    let records: [RelationRecord]
    do { records = try JSONDecoder().decode([RelationRecord].self, from: data) } catch {
      throw ScrollsError(code: ErrorCode(rawValue: "E_JSON_PARSE"), message: "\(m) is not the expected JSON array: \(error)",
                         hint: "Build the cipher-meta pack again from Cipher's files.", status: 422)
    }
    cache.withLock { $0[info.sha256] = records }
    return records
  }

  /// Forgets the decoded files (end of phase A2; memory warnings).
  public static func clear() { cache.withLock { $0.removeAll() } }
}
