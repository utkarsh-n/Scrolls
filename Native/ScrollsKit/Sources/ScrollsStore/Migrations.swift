// OWNER: N0
// Port of server/db/migrate.mjs (IOS-SPEC §1.3): a fresh database gets schema.sql executed verbatim (its sha256 is
// tested against the reference's file), then — for the device profile — device-profile.sql, then the meta rows. The
// reference's one-off boot repairs are not ported (§2.1: Swift atlases are always built by the current rules).

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore

/// The DDL resources of ScrollsStore.
public enum StoreResources {
  /// The sha256 of server/db/schema.sql at ref-freeze-1; `Migrations` refuses a bundled schema that differs.
  public static let schemaSHA256 = "2340661a9af1103fe00198d997f016cf757ea5904ae1309c0d74ddff6c4ab59e"

  /// The bundled resource `name`, or a misuse error naming it.
  public static func url(_ name: String) throws -> URL {
    let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
    guard let u = Bundle.module.url(forResource: parts[0], withExtension: parts.count > 1 ? parts[1] : nil) else {
      throw StoreError.misuse("ScrollsStore resource \(name) is missing from the bundle")
    }
    return u
  }

  /// The bytes of a bundled resource.
  public static func data(_ name: String) throws -> Data { try Data(contentsOf: url(name)) }

  /// schema.sql, exactly as on disk.
  public static func schemaSQL() throws -> String { String(decoding: try data("schema.sql"), as: UTF8.self) }

  /// device-profile.sql.
  public static func deviceProfileSQL() throws -> String { String(decoding: try data("device-profile.sql"), as: UTF8.self) }

  /// The sha256 (hex) of bytes.
  public static func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

/// Versions recorded in `meta` and on every run (ΔS-7).
public enum StoreVersions {
  /// `schema_version` this code creates and understands.
  public static let schema = 1
  /// The tokenizer version (parity with the reference is tested; G1).
  public static let tokenizer = Tokenizer.version
  /// The segmenter version of server/text/segment.mjs (`seg-1`); ScrollsIngest's segmenter must report the same.
  public static let segmenter = "seg-1"
  /// The device profile tag stored in `meta.profile`.
  public static let deviceProfile = "device-1"

  /// `meta.icu_version` on the phone: `ios<version>/unicode<N>` (`macos…` in the CLI and in tests).
  public static let icu: String = {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    #if os(iOS)
      let os = "ios"
    #else
      let os = "macos"
    #endif
    return "\(os)\(v.majorVersion).\(v.minorVersion)/unicode\(unicodeVersion)"
  }()

  /// The newest Unicode version whose characters this runtime knows (the largest `age` of any assigned scalar).
  public static let unicodeVersion: String = {
    var best = (0, 0)
    for v in 0...0x10FFFF {
      guard let s = Unicode.Scalar(v), let age = s.properties.age else { continue }
      if (age.major, age.minor) > best { best = (age.major, age.minor) }
    }
    return "\(best.0).\(best.1)"
  }()
}

/// What `Migrations.migrate` did.
public struct MigrationResult: Sendable, Equatable {
  public let from: Int
  public let to: Int
  /// The device profile was added by this call.
  public let addedDeviceProfile: Bool
}

/// Creates or checks a Scrolls database.
public enum Migrations {
  /// Brings the database on `c` (a read-write connection outside any transaction) to schema version 1, with the
  /// device profile when `c.profile == .device`. A current database is left as it is (a reference database opened as
  /// `.device` gains the profile tables). Throws E_SCHEMA_NEWER, E_DB_FOREIGN, or E_SCHEMA_MISMATCH when the bundled
  /// schema.sql is not the reference's.
  @discardableResult
  public static func migrate(_ c: Connection, builtOn: String = defaultBuiltOn) throws -> MigrationResult {
    let from = try currentVersion(c)
    if from > StoreVersions.schema {
      throw ScrollsError(code: .schemaNewer,
                         message: "Database schema_version \(from) is newer than this Scrolls (\(StoreVersions.schema)).",
                         hint: "Update Scrolls, or rebuild the atlas.", detail: nil)
    }
    if from == StoreVersions.schema {
      let added = c.profile == .device ? try applyDeviceProfileIfMissing(c, builtOn: builtOn) : false
      return MigrationResult(from: from, to: from, addedDeviceProfile: added)
    }
    let schema = try StoreResources.data("schema.sql")
    guard StoreResources.sha256Hex(schema) == StoreResources.schemaSHA256 else {
      throw ScrollsError(code: .schemaMismatch,
                         message: "The bundled schema.sql is not the reference's (sha256 \(StoreResources.sha256Hex(schema))).",
                         hint: "Rebuild Scrolls from a clean checkout.", detail: nil)
    }
    // PRAGMA journal_mode cannot change inside a transaction, so the DDL runs as written, outside one (as the reference).
    try c.exec(String(decoding: schema, as: UTF8.self))
    if c.profile == .device { try c.exec(try StoreResources.deviceProfileSQL()) }
    try c.transaction(.immediate) {
      try Meta.set(c, "schema_version", String(StoreVersions.schema))
      try Meta.set(c, "data_version", "0")
      try Meta.set(c, "tokenizer_version", StoreVersions.tokenizer)
      try Meta.set(c, "segmenter_version", StoreVersions.segmenter)
      try Meta.set(c, "icu_version", StoreVersions.icu)
      try Meta.set(c, "created_at", StoreClock.isoNow())
      if c.profile == .device { try writeProfileMeta(c, builtOn: builtOn) }
    }
    return MigrationResult(from: from, to: StoreVersions.schema, addedDeviceProfile: c.profile == .device)
  }

  /// `device` on iOS, `mac` in the CLI and tests (`meta.generation_built_on`).
  public static var defaultBuiltOn: String {
    #if os(iOS)
      "device"
    #else
      "mac"
    #endif
  }

  /// The schema version of the database (0 when empty). Throws E_DB_FOREIGN for tables without a meta table.
  public static func currentVersion(_ c: Connection) throws -> Int {
    let hasMeta = try c.prepared(StoreSQL.tableNamed).bindingFirst([.text("meta")]) { _ in true } ?? false
    if !hasMeta {
      let tables = try c.prepared(StoreSQL.tableCount).first { $0.int(0) } ?? 0
      if tables > 0 {
        throw ScrollsError(code: .dbForeign,
                           message: "The database has tables but no meta table: it is not a Scrolls database.",
                           hint: "Choose a Scrolls atlas.", detail: nil)
      }
      return 0
    }
    return Int(try Meta.get(c, "schema_version") ?? "0") ?? 0
  }

  /// Whether the device profile's tables exist.
  public static func hasDeviceProfile(_ c: Connection) throws -> Bool {
    try c.prepared(StoreSQL.tableNamed).bindingFirst([.text("text_storage")]) { _ in true } ?? false
  }

  private static func applyDeviceProfileIfMissing(_ c: Connection, builtOn: String) throws -> Bool {
    if try hasDeviceProfile(c) { return false }
    try c.exec(try StoreResources.deviceProfileSQL())
    try c.transaction(.immediate) { try writeProfileMeta(c, builtOn: builtOn) }
    return true
  }

  private static func writeProfileMeta(_ c: Connection, builtOn: String) throws {
    try Meta.set(c, "profile", StoreVersions.deviceProfile)
    try Meta.set(c, "generation", Fold.asciiLowercased(UUID().uuidString))
    try Meta.set(c, "generation_built_on", builtOn)
    try Meta.set(c, "engine_version", BuildInfo.engineVersion)
    try Meta.set(c, "engine_code_hash", BuildInfo.sourceDigest)
    try Meta.set(c, "journal_applied_seq", "0")
    if try Meta.get(c, "base_max_ids") == nil { try Meta.set(c, "base_max_ids", "{}") }
  }
}
