// OWNER: N2
// The source pack's manifest (IOS-SPEC §3.5, §8.4.4; format SPK1): canonical JSON at the head of a `.scrollspack`.
// Each member's sha256 is the sha256 of the staged file on the Mac, so `import_once` and provenance behave as in the
// reference; a document loaded from a pack records `original_file.rel_path = 'pack:<name>@<sha8>/<member>'`.
// The manifest travels as canonical JSON (sorted keys, numbers per Number::toString), written and read by hand here so
// no encoder's key strategy can rename a `counts` key or reorder anything (the bytes are part of the pack's sha256).

import Foundation
import ScrollsContracts
import ScrollsCore

/// One member file of a pack.
public struct PackMemberInfo: Codable, Sendable, Equatable {
  /// The member's path inside the pack (`texts/gutenberg/12.txt`, `openalex/MANIFEST.json`).
  public let path: String
  /// Its size in bytes, uncompressed.
  public let size: Int64
  /// The sha256 of its bytes (hex).
  public let sha256: String

  public init(path: String, size: Int64, sha256: String) {
    self.path = path
    self.size = size
    self.sha256 = sha256
  }
}

/// `{pack_id, name, version, slot, adapter_ids, created_by, reference_commit, licences, attribution, caveats, members,
/// counts}`.
public struct PackManifest: Codable, Sendable, Equatable {
  public let packID: String
  public let name: String
  public let version: String
  /// The source slot whose id range the pack's entity rows take (§3.3).
  public let slot: SourceSlot
  public let adapterIDs: [String]
  /// "scrolls-cli <engine version> <git sha>".
  public let createdBy: String
  public let referenceCommit: String
  public let licences: [String]
  public let attribution: [String]
  public let caveats: [String]
  public let members: [PackMemberInfo]
  public let counts: [String: Int]

  public init(packID: String, name: String, version: String, slot: SourceSlot, adapterIDs: [String], createdBy: String,
              referenceCommit: String, licences: [String], attribution: [String], caveats: [String],
              members: [PackMemberInfo], counts: [String: Int]) {
    self.packID = packID
    self.name = name
    self.version = version
    self.slot = slot
    self.adapterIDs = adapterIDs
    self.createdBy = createdBy
    self.referenceCommit = referenceCommit
    self.licences = licences
    self.attribution = attribution
    self.caveats = caveats
    self.members = members
    self.counts = counts
  }

  enum CodingKeys: String, CodingKey {
    case packID = "pack_id", name, version, slot, adapterIDs = "adapter_ids", createdBy = "created_by"
    case referenceCommit = "reference_commit", licences, attribution, caveats, members, counts
  }

  /// The same manifest with another member list (PackWriter completes the list as members are added).
  public func with(members: [PackMemberInfo]) -> PackManifest {
    PackManifest(packID: packID, name: name, version: version, slot: slot, adapterIDs: adapterIDs, createdBy: createdBy,
                 referenceCommit: referenceCommit, licences: licences, attribution: attribution, caveats: caveats,
                 members: members, counts: counts)
  }

  /// The member with `path`, if the pack has one.
  public func member(_ path: String) -> PackMemberInfo? { members.first { $0.path == path } }

  /// Total uncompressed bytes of every member.
  public var uncompressedBytes: Int64 { members.reduce(0) { $0 + $1.size } }

  // MARK: canonical JSON

  /// The manifest as a JSON value (snake_case keys, as the spec writes them).
  public var jsonValue: JSONValue {
    .object([
      "pack_id": .string(packID), "name": .string(name), "version": .string(version),
      "slot": .number(Double(slot.rawValue)), "adapter_ids": .array(adapterIDs.map(JSONValue.string)),
      "created_by": .string(createdBy), "reference_commit": .string(referenceCommit),
      "licences": .array(licences.map(JSONValue.string)), "attribution": .array(attribution.map(JSONValue.string)),
      "caveats": .array(caveats.map(JSONValue.string)),
      "members": .array(members.map {
        .object(["path": .string($0.path), "size": .number(Double($0.size)), "sha256": .string($0.sha256)])
      }),
      "counts": .object(JSONObject(counts.map { ($0.key, JSONValue.number(Double($0.value))) })),
    ])
  }

  /// The canonical JSON text written into the pack.
  public var canonicalJSON: String { CanonicalJSON.string(jsonValue) }

  /// Reads a manifest from its JSON value; throws `E_PACK_INVALID` naming the first bad key.
  public init(json: JSONValue) throws {
    guard let o = json.objectValue else { throw PackError.invalid("the manifest is not a JSON object") }
    func string(_ k: String) throws -> String {
      guard let s = o[k]?.stringValue else { throw PackError.invalid("manifest key '\(k)' is missing or not a string") }
      return s
    }
    func strings(_ k: String) throws -> [String] {
      guard let a = o[k]?.arrayValue else { throw PackError.invalid("manifest key '\(k)' is missing or not an array") }
      return try a.map {
        guard let s = $0.stringValue else { throw PackError.invalid("manifest key '\(k)' holds a non-string") }
        return s
      }
    }
    guard let slot = o["slot"]?.safeInteger, (0...14).contains(slot) else {
      throw PackError.invalid("manifest key 'slot' is missing or outside 0…14")
    }
    guard let rawMembers = o["members"]?.arrayValue else { throw PackError.invalid("manifest key 'members' is missing") }
    let members = try rawMembers.map { m -> PackMemberInfo in
      guard let path = m["path"]?.stringValue, let size = m["size"]?.safeInteger, let sha = m["sha256"]?.stringValue else {
        throw PackError.invalid("a manifest member lacks path, size or sha256")
      }
      return PackMemberInfo(path: path, size: Int64(size), sha256: sha)
    }
    var counts: [String: Int] = [:]
    for (k, v) in o["counts"]?.objectValue ?? [:] {
      guard let n = v.safeInteger else { throw PackError.invalid("manifest count '\(k)' is not an integer") }
      counts[k] = n
    }
    self.init(packID: try string("pack_id"), name: try string("name"), version: try string("version"),
              slot: SourceSlot(rawValue: slot), adapterIDs: try strings("adapter_ids"), createdBy: try string("created_by"),
              referenceCommit: try string("reference_commit"), licences: try strings("licences"),
              attribution: try strings("attribution"), caveats: try strings("caveats"), members: members, counts: counts)
  }
}

/// Why a pack cannot be read or written, as the Sources page and the CLI say it.
public enum PackError {
  public static let invalidCode = ErrorCode(rawValue: "E_PACK_INVALID")
  public static let memberCode = ErrorCode(rawValue: "E_PACK_MEMBER")
  public static let checksumCode = ErrorCode(rawValue: "E_PACK_CHECKSUM")

  /// The file is not a well-formed SPK1 pack.
  public static func invalid(_ why: String) -> ScrollsError {
    ScrollsError(code: invalidCode, message: "Not a readable Scrolls source pack: \(why).",
                 hint: "Build it again with Tools/packs.sh, then send it again.", status: 400)
  }

  /// The pack has no such member.
  public static func noMember(_ path: String, pack: String) -> ScrollsError {
    ScrollsError(code: memberCode, message: "The pack '\(pack)' has no member '\(path)'.",
                 hint: "The pack was built from other files than this engine expects; build it again with Tools/packs.sh.",
                 status: 404)
  }

  /// A member's bytes or the whole file do not hash to what the manifest says.
  public static func checksum(_ what: String, expected: String, got: String) -> ScrollsError {
    ScrollsError(code: checksumCode,
                 message: "\(what) does not match its sha256 (expected \(expected.prefix(12))…, got \(got.prefix(12))…). Nothing was loaded from it.",
                 hint: "The file was damaged in transfer; send it again.", status: 409)
  }
}
