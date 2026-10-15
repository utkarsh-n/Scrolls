// OWNER: N2
// `ATLAS.json` (IOS-SPEC §3.5): the facts of one atlas generation, written beside `atlas.sqlite` by whoever built it (the
// CLI's starter and `atlas build`, the phone's rebuild) and read by the inbox before a swap. Fingerprints are the
// LogicalDump digests (rows, sha256) of the evidence and user tables: equal fingerprints of a phone-built and a Mac-built
// generation are G6. Written as canonical JSON (sorted keys), so equal facts give equal bytes.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// `{generation, engine_version, engine_code_hash, stage_code_hashes, schema_version, profile, tokenizer, segmenter,
/// starter_sha256, packs:[{name, sha256, slot}], journal_seq, built_on, built_at, fingerprints:{table:{rows, sha256}}}`.
public struct GenerationManifest: Sendable, Equatable {
  public struct Pack: Sendable, Equatable {
    public var name: String
    public var sha256: String
    public var slot: Int
  }

  public var generation: String
  public var engineVersion: String
  public var engineCodeHash: String
  public var stageCodeHashes: [String: String]
  public var schemaVersion: Int
  public var profile: String
  public var tokenizer: String
  public var segmenter: String
  public var starterSHA256: String?
  public var packs: [Pack]
  public var journalSeq: UInt64
  public var builtOn: String
  public var builtAt: String
  public var fingerprints: [String: TableDigest]

  public static let fileName = "ATLAS.json"

  /// The tables whose fingerprints a generation carries (evidence and user tables; caches, jobs and the text chunks,
  /// which `document_text`'s virtual column covers, are left out).
  public static let skippedTables: Set<String> = ["job", "job_event", "query_def", "tile_cache", "layout_cache", "text_chunk",
                                                  "annotation_fts", "passage_vocab_row", "passage_vocab_inst"]

  /// The facts of the atlas on `c` (its meta keys, its installed packs) with `fingerprints`.
  public static func read(_ c: Connection, fingerprints: [String: TableDigest]) throws -> GenerationManifest {
    let packs = try c.prepared(GenerationSQL.packs).all { Pack(name: $0.text(1), sha256: $0.text(0), slot: Int($0.int(2))) }
    return GenerationManifest(
      generation: try Meta.get(c, "generation") ?? "", engineVersion: try Meta.get(c, "engine_version") ?? BuildInfo.engineVersion,
      engineCodeHash: try Meta.get(c, "engine_code_hash") ?? BuildInfo.sourceDigest, stageCodeHashes: BuildInfo.stageCodeHashes,
      schemaVersion: Int(try Meta.get(c, "schema_version") ?? "0") ?? 0, profile: try Meta.get(c, "profile") ?? "reference",
      tokenizer: try Meta.get(c, "tokenizer_version") ?? "", segmenter: try Meta.get(c, "segmenter_version") ?? "",
      starterSHA256: try Meta.get(c, "starter_sha256"), packs: packs,
      journalSeq: UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0,
      builtOn: try Meta.get(c, "generation_built_on") ?? Migrations.defaultBuiltOn, builtAt: StoreClock.isoNow(),
      fingerprints: fingerprints)
  }

  /// LogicalDump digests of every fingerprinted table of the atlas on `c`, dumped into `scratch` (removed after).
  public static func fingerprints(_ c: Connection, text: any TextStore, scratch: URL) throws -> [String: TableDigest] {
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    let all = try LogicalDump.dump(c, text: text, to: scratch, tables: nil)
    return all.filter { !skippedTables.contains($0.key) }
  }

  public var jsonValue: JSONValue {
    var o: JSONObject = [
      "generation": .string(generation), "engine_version": .string(engineVersion), "engine_code_hash": .string(engineCodeHash),
      "stage_code_hashes": .object(JSONObject(stageCodeHashes.map { ($0.key, JSONValue.string($0.value)) })),
      "schema_version": .number(Double(schemaVersion)), "profile": .string(profile), "tokenizer": .string(tokenizer),
      "segmenter": .string(segmenter), "starter_sha256": starterSHA256.map(JSONValue.string) ?? .null,
      "packs": .array(packs.map { .object(["name": .string($0.name), "sha256": .string($0.sha256), "slot": .number(Double($0.slot))]) }),
      "journal_seq": .number(Double(journalSeq)), "built_on": .string(builtOn), "built_at": .string(builtAt),
    ]
    o["fingerprints"] = .object(JSONObject(fingerprints.map {
      ($0.key, JSONValue.object(["rows": .number(Double($0.value.rows)), "sha256": .string($0.value.sha256)]))
    }))
    return .object(o)
  }

  public init(generation: String, engineVersion: String, engineCodeHash: String, stageCodeHashes: [String: String],
              schemaVersion: Int, profile: String, tokenizer: String, segmenter: String, starterSHA256: String?,
              packs: [Pack], journalSeq: UInt64, builtOn: String, builtAt: String, fingerprints: [String: TableDigest]) {
    self.generation = generation
    self.engineVersion = engineVersion
    self.engineCodeHash = engineCodeHash
    self.stageCodeHashes = stageCodeHashes
    self.schemaVersion = schemaVersion
    self.profile = profile
    self.tokenizer = tokenizer
    self.segmenter = segmenter
    self.starterSHA256 = starterSHA256
    self.packs = packs
    self.journalSeq = journalSeq
    self.builtOn = builtOn
    self.builtAt = builtAt
    self.fingerprints = fingerprints
  }

  /// Reads `ATLAS.json`.
  public init(json v: JSONValue) throws {
    guard let generation = v["generation"]?.stringValue, let schema = v["schema_version"]?.safeInteger else {
      throw ScrollsError(code: GenerationError.invalidCode, message: "ATLAS.json lacks generation or schema_version.",
                         hint: "Build the atlas again with Tools/atlas.sh.", status: 400)
    }
    var fp: [String: TableDigest] = [:]
    for (k, d) in v["fingerprints"]?.objectValue ?? [:] {
      if let rows = d["rows"]?.safeInteger, let sha = d["sha256"]?.stringValue { fp[k] = TableDigest(rows: rows, sha256: sha) }
    }
    var stages: [String: String] = [:]
    for (k, s) in v["stage_code_hashes"]?.objectValue ?? [:] { if let s = s.stringValue { stages[k] = s } }
    self.init(generation: generation, engineVersion: v["engine_version"]?.stringValue ?? "",
              engineCodeHash: v["engine_code_hash"]?.stringValue ?? "", stageCodeHashes: stages, schemaVersion: schema,
              profile: v["profile"]?.stringValue ?? "", tokenizer: v["tokenizer"]?.stringValue ?? "",
              segmenter: v["segmenter"]?.stringValue ?? "", starterSHA256: v["starter_sha256"]?.stringValue,
              packs: (v["packs"]?.arrayValue ?? []).compactMap { p in
                guard let n = p["name"]?.stringValue, let s = p["sha256"]?.stringValue else { return nil }
                return Pack(name: n, sha256: s, slot: p["slot"]?.safeInteger ?? 0)
              },
              journalSeq: UInt64(v["journal_seq"]?.safeInteger ?? 0), builtOn: v["built_on"]?.stringValue ?? "",
              builtAt: v["built_at"]?.stringValue ?? "", fingerprints: fp)
  }

  public static func read(at url: URL) throws -> GenerationManifest {
    try GenerationManifest(json: try JSONValue.parse(Data(contentsOf: url)))
  }

  public func write(to url: URL) throws {
    try Data((CanonicalJSON.string(jsonValue) + "\n").utf8).write(to: url, options: .atomic)
  }

  /// Tables whose fingerprints differ between two generations (G6: empty means phone = Mac).
  public func differingTables(_ other: GenerationManifest) -> [String] {
    Set(fingerprints.keys).union(other.fingerprints.keys).filter { fingerprints[$0] != other.fingerprints[$0] }.sorted()
  }
}

/// The statements of generations.
public enum GenerationSQL: SQLCatalog {
  public static let packs = SQL("generation.packs",
                                "SELECT pack_sha256, name, slot FROM pack_install ORDER BY slot, name, pack_sha256",
                                scan: .scanOK(reason: "a handful of installed packs"))
  public static let all: [SQL] = [packs]
}

/// Why a generation cannot be read or installed.
public enum GenerationError {
  public static let invalidCode = ErrorCode(rawValue: "E_GENERATION_INVALID")
  public static let incompatibleCode = ErrorCode(rawValue: "E_GENERATION_INCOMPATIBLE")
}
