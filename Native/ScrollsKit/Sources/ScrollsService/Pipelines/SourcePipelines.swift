// OWNER: N2
// What every source-load task shares: the document writer and the boilerplate pass they call (N1's DocumentWriter and
// N5's BoilerplateDetector by default; tests and the CLI's dry runs swap in fakes through `SourcePipelines.configure`),
// the load environment over a job's write lease, the installed-pack record (pack_install, DP-3), collection statuses
// in meta, and the incremental FTS merge that replaces the reference's 'optimize' (ΔS-19).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsLineage
import ScrollsSources
import ScrollsStore
import Synchronization

/// The pluggable parts of the source pipelines.
public enum SourcePipelines {
  public struct Configuration: Sendable {
    public var writerFactory: DocumentWriterFactory
    public var boilerplate: any BoilerplatePass
    /// Wall time of one chunk of a long load (one import batch; a suspension loses at most this much work).
    public var chunk: Duration
    public init(writerFactory: @escaping DocumentWriterFactory = { try await DocumentWriter.open(lease: $0, target: $1, options: $2) },
                boilerplate: any BoilerplatePass = BoilerplateDetector(), chunk: Duration = .seconds(20)) {
      self.writerFactory = writerFactory
      self.boilerplate = boilerplate
      self.chunk = chunk
    }
  }

  private static let current = Mutex(Configuration())

  /// The configuration the tasks use (process-wide: tasks are created by type from the job table).
  public static var configuration: Configuration { current.withLock { $0 } }

  /// Replaces the configuration (tests; the CLI). Returns the previous one.
  @discardableResult
  public static func configure(_ c: Configuration) -> Configuration {
    current.withLock { old in
      defer { old = c }
      return old
    }
  }

  /// The load environment of a job: its lease, the configured writer factory, its checkpoint.
  static func environment(_ ctx: JobContext, lease: WriteLease) -> LoadEnvironment {
    LoadEnvironment(lease: lease, writerFactory: configuration.writerFactory, jobID: ctx.id,
                    checkpoint: { try await ctx.checkpoint() })
  }

  /// The atlas file of a job (packs installed beside it are found from it).
  static func atlasPath(_ ctx: JobContext) -> String { ctx.reads.path }

  /// Records the packs a load reads (`pack_install`, once per pack sha256).
  static func recordPacks(_ lease: WriteLease, _ files: SourceFiles) async throws {
    try await lease.batch("pack_install") { tx in
      let ins = try tx.connection.prepared(PipelineSQL.insertPackInstall)
      for p in files.packs {
        let m = p.reader.manifest
        try ins.bind(.text(p.sha256), .text(m.name), .text(m.version), .int(Int64(m.slot.rawValue)), .int(Int64(m.members.count)),
                     .null, .text(StoreClock.isoNow()))
        try ins.run()
      }
    }
  }

  /// `collection_status:<slug>` = status ('pending' | 'indexing' | 'ready' | 'partial' | 'empty').
  static func setStatus(_ tx: WriteTx, _ slug: String, _ status: String) throws {
    try Meta.set(tx.connection, SourceLoader.statusKey(slug), status)
  }

  static func status(_ c: Connection, _ slug: String) throws -> String? { try Meta.get(c, SourceLoader.statusKey(slug)) }

  /// FTS bulk mode (§4.4): automerge off while loading many documents.
  static func ftsBulkLoad(_ lease: WriteLease, on: Bool) async throws {
    try await lease.batch(on ? "fts automerge off" : "fts automerge on") { tx in
      try tx.connection.prepared(on ? SourcesFTSSQL.automergeOff : SourcesFTSSQL.automergeOn).run()
    }
  }

  /// The end of a bulk load: incremental `merge` steps (each its own short transaction) until FTS5 reports no more work,
  /// instead of one long 'optimize' (ΔS-19, the stall rule).
  static func ftsMerge(_ lease: WriteLease, checkpoint: @Sendable () async throws -> Void, maxSteps: Int = 10_000) async throws -> Int {
    var steps = 0
    while steps < maxSteps {
      let changed = try await lease.batch("fts merge") { tx -> Int64 in
        let c = tx.connection
        let before = try c.prepared(SourcesFTSSQL.totalChanges).first { $0.int(0) } ?? 0
        try c.prepared(SourcesFTSSQL.merge).run()
        let after = try c.prepared(SourcesFTSSQL.totalChanges).first { $0.int(0) } ?? 0
        return after - before
      }
      steps += 1
      try await checkpoint()
      if changed < 2 { break }
    }
    return steps
  }
}

/// FTS maintenance statements of the source pipelines.
public enum SourcesFTSSQL: SQLCatalog {
  public static let automergeOff = SQL("sources.fts.automergeOff", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 0)")
  public static let automergeOn = SQL("sources.fts.automergeOn", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 4)")
  /// One incremental merge step of 500 pages; a `total_changes()` delta below 2 means nothing was left to merge.
  public static let merge = SQL("sources.fts.merge", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('merge', 500)")
  public static let totalChanges = SQL("sources.fts.totalChanges", "SELECT total_changes()")
  public static let all: [SQL] = [automergeOff, automergeOn, merge, totalChanges]
}

/// A JSON object helper for task results.
extension JSONObject {
  mutating func set(_ k: String, _ n: Int) { self[k] = .number(Double(n)) }
}
