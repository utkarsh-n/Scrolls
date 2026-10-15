// OWNER: N0
// `scrolls-cli dump`: the LogicalDump of an atlas or a reference database (IOS-SPEC §2.3), the Swift half of
// "LogicalDump Swift = Node". It opens the database read-only (immutable for a clone) and never writes to it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

enum DumpCommand: CLICommand {
  static let name = "dump"
  static let summary = "LogicalDump of an atlas or reference database (JSONL per table + digests)"
  static let usage = """
    usage: scrolls-cli dump --db <atlas.sqlite> --out <dir> [--tables a,b,…] [--profile reference|device] [--immutable]
      Writes <dir>/<table>.jsonl (rows sorted by natural key, Native/Docs/DIFFERENTIAL.md "LogicalDump") and prints
      {table: {rows, sha256}} as canonical JSON. --profile defaults to device when the database has the device profile.
      --immutable opens a read-only clone with ?immutable=1. The database must not be his live atlas or under iCloud.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["immutable"])
    let db = URL(fileURLWithPath: try a.required("db")).standardizedFileURL
    let out = URL(fileURLWithPath: try a.required("out")).standardizedFileURL
    let tables = a.value("tables").map { $0.split(separator: ",").map(String.init) }
    guard FileManager.default.fileExists(atPath: db.path) else { throw UsageError("no database at \(db.path)") }
    try AtlasLocation.refuseICloud(db)
    try AtlasLocation.refuseICloud(out)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

    let mode: OpenMode = a.flag("immutable") ? .readOnlyImmutable : .readOnly
    let profile: StoreProfile
    switch a.value("profile") {
    case "reference"?: profile = .reference
    case "device"?: profile = .device
    case nil:
      let probe = try connect(db.path, mode, .reference)
      profile = try Migrations.hasDeviceProfile(probe) ? .device : .reference
      probe.close()
    case let other?: throw UsageError("unknown profile '\(other)'")
    }
    let c = try connect(db.path, mode, profile)
    defer { c.close() }
    let text: any TextStore = profile == .device ? ChunkedTextStore() : InlineTextStore()
    let digests = try LogicalDump.dump(c, text: text, to: out, tables: tables)
    let json = JSONObject(digests.map { ($0.key, JSONValue.object(["rows": .number(Double($0.value.rows)), "sha256": .string($0.value.sha256)])) })
    print(CanonicalJSON.string(.object(json)))
    return 0
  }

  private static func connect(_ path: String, _ mode: OpenMode, _ profile: StoreProfile) throws -> Connection {
    do {
      return try Connection(path: path, mode: mode, profile: profile)
    } catch {
      // SQLITE_CANTOPEN: a WAL database cannot be opened read-only when its -shm file cannot be created
      if error.code & 0xFF == 14 && mode == .readOnly {
        throw UsageError("\(error.message): for a clone nobody writes to, pass --immutable")
      }
      throw error
    }
  }
}
