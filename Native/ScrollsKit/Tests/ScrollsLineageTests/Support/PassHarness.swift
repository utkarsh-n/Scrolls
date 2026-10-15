// OWNER: N5
// Test harness for the lineage jobs: a writer, readers and a JobQueue on a database file (a fresh reference-schema
// database filled with golden input rows, or an APFS clone of a reference snapshot), plus helpers to insert rows from
// golden JSON and to clone snapshots. Never opens ~/Developer/scrolls-data or a snapshot in place.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
@testable import ScrollsLineage
import ScrollsStore

/// A queue on one database, with the lineage tasks registered.
struct PassHarness {
  let path: String
  let writer: Writer
  let reads: ReadPool
  let queue: JobQueue

  init(path: String, profile: StoreProfile = .reference) throws {
    self.path = path
    writer = try Writer(path: path, profile: profile)
    reads = try ReadPool(path: path, profile: profile, mmapBytesPerReader: 8 << 20)
    queue = JobQueue(reads: reads, writer: writer, text: profile == .device ? ChunkedTextStore() : InlineTextStore(),
                     registry: [BoilerplateTask.self], conditions: Unthrottled(), journal: nil)
  }

  /// Runs one job to its end and returns its snapshot. Tests run at priority 2 (`.userInitiated`): the reference's
  /// background priorities would put a test behind the whole machine's load.
  func run(_ type: JobType, _ params: JSONValue, priority: Int = 2, timeout: Duration = .seconds(1800)) async throws
    -> JobSnapshot
  {
    let id = try await queue.enqueue(JobSpec(type: type, params: params, priority: priority))
    guard let snap = await queue.wait(for: id, timeout: timeout) else {
      throw HarnessError(description: "job \(id) did not finish within \(timeout)")
    }
    return snap
  }

  /// A read on the interactive lane (no deadline).
  func read<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await reads.read(.interactive, deadline: .seconds(3600), body)
  }

  func close() async {
    await reads.close()
    try? await writer.close()
  }

  // ── fixtures ──

  /// $TMPDIR/scrolls-n5-tests/<name>-<uuid>/, pruned of folders older than two hours.
  static func scratchDir(_ name: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n5-tests")
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-7200)
    for entry in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] {
      let url = root.appendingPathComponent(entry)
      if let made = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date, made < cutoff {
        try? fm.removeItem(at: url)
      }
    }
    let dir = root.appendingPathComponent("\(name)-\(UUID().uuidString.prefix(8))")
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// A fresh reference-schema database at `<dir>/scrolls.db`.
  static func freshReferenceDatabase(in dir: URL) throws -> String {
    let path = dir.appendingPathComponent("scrolls.db").path
    let c = try Connection(path: path, mode: .readWrite, profile: .reference)
    try Migrations.migrate(c)
    c.close()
    return path
  }

  /// Inserts golden rows (`{column: value}` objects) into `table`, in order.
  static func insert(_ c: Connection, table: String, rows: [JSONValue]) throws {
    for row in rows {
      guard let o = row.objectValue else { continue }
      let cols = o.keys.sorted()
      let sql = "INSERT INTO \(table) (\(cols.joined(separator: ", "))) VALUES (\(cols.map { _ in "?" }.joined(separator: ", ")))"
      let s = try c.prepared(dynamic: sql)
      try s.bind(cols.map { sqlValue(o[$0] ?? .null) })
      try s.run()
    }
  }

  static func sqlValue(_ v: JSONValue) -> SQLValue {
    switch v {
    case .null: return .null
    case .bool(let b): return .int(b ? 1 : 0)
    case .number(let n):
      if n.rounded(.towardZero) == n, abs(n) < 9_007_199_254_740_992 { return .int(Int64(n)) }
      return .double(n)
    case .string(let s): return .text(s)
    default: return .text(CanonicalJSON.string(v))
    }
  }

  /// The reference snapshots root (`SCROLLS_SNAPSHOTS` or ~/Developer/scrolls-snapshots).
  static var snapshotsRoot: URL {
    if let r = ProcessInfo.processInfo.environment["SCROLLS_SNAPSHOTS"] { return URL(fileURLWithPath: r) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-snapshots")
  }

  /// Whether a complete snapshot exists (its SNAPSHOT.json is written last).
  static func snapshotAvailable(_ name: String) -> Bool {
    let d = snapshotsRoot.appendingPathComponent(name)
    return FileManager.default.fileExists(atPath: d.appendingPathComponent("scrolls.db").path)
      && FileManager.default.fileExists(atPath: d.appendingPathComponent("SNAPSHOT.json").path)
  }

  /// An APFS clone (`copyItem` uses clonefile) of a snapshot's database into `dir`; returns the clone's path.
  static func cloneSnapshot(_ name: String, into dir: URL) throws -> String {
    let src = snapshotsRoot.appendingPathComponent(name).appendingPathComponent("scrolls.db")
    let forbidden = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-data").path
    precondition(!src.path.hasPrefix(forbidden), "never open the live data directory")
    let dst = dir.appendingPathComponent("scrolls.db")
    try FileManager.default.copyItem(at: src, to: dst)
    for side in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: src.path + side) {
      try FileManager.default.copyItem(atPath: src.path + side, toPath: dst.path + side)
    }
    return dst.path
  }
}

struct HarnessError: Error, CustomStringConvertible { let description: String }

extension JSONValue {
  /// A copy with the named members replaced (masking durations and timestamps before comparing).
  func masking(_ keys: Set<String>, with value: JSONValue = "<masked>") -> JSONValue {
    switch self {
    case .object(let o):
      var out = JSONObject()
      for (k, v) in o { out[k] = keys.contains(k) ? value : v.masking(keys, with: value) }
      return .object(out)
    case .array(let a): return .array(a.map { $0.masking(keys, with: value) })
    default: return self
    }
  }
}
