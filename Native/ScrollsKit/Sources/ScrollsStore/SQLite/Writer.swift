// OWNER: N0
// The single read-write connection (IOS-SPEC §1.5): a `Writer` actor on its own DispatchSerialQueue. `write { }` is one
// short BEGIN IMMEDIATE; bulk writers take a `WriteLease` whose batches are one transaction each and yield between
// batches, so an interactive write queued on the actor runs after at most one batch (never parked for 5 s). After each
// bulk batch a PASSIVE checkpoint runs, and the lease pauses while the WAL is over 256 MB (ΔS-19).

import Dispatch
import Foundation
import SQLite3
import ScrollsCore
import Synchronization

/// A transaction of the writer. Only valid inside `Writer.write` / `WriteLease.batch`; not Sendable.
public final class WriteTx {
  public let connection: Connection
  public let ids: RowIDAllocator
  /// The label the write was started with (logs, signposts).
  public let label: String
  private(set) var newDataVersion: Int?

  init(connection: Connection, label: String) {
    self.connection = connection
    self.ids = RowIDAllocator(connection: connection)
    self.label = label
  }

  /// Increments `meta.data_version` (the reference's `bumpDataVersion`) and returns the new version. Every committed
  /// write that changes what a reader sees calls it once; the writer announces the version after COMMIT.
  @discardableResult
  public func bumpDataVersion() throws -> Int {
    let v = try connection.prepared(StoreSQL.bumpDataVersion).first { Int($0.text(0)) ?? 0 } ?? 0
    newDataVersion = v
    return v
  }

  /// Records that `entry` was applied by this transaction (§6.2 step 2): its `journal_applied` row with the largest
  /// id of each cutoff table, and `meta.journal_applied_seq`. Device profile only.
  public func recordJournalApplied(_ entry: JournalEntry) throws {
    guard connection.profile == .device else {
      throw StoreError.misuse("journal_applied exists only in the device profile")
    }
    let maxIDs = try connection.prepared(StoreSQL.cutoffMaxIDs).first { r in
      JSONObject(RowIDPolicy.cutoffTables.enumerated().map { ($0.element, JSONValue.number(Double(r.int(Int32($0.offset))))) })
    } ?? JSONObject()
    let insert = try connection.prepared(StoreSQL.insertJournalApplied)
    try insert.bind(.int(Int64(entry.seq)), .text(entry.op.name), .text(StoreClock.isoNow()),
                    .text(CanonicalJSON.string(.object(maxIDs))))
    try insert.run()
    try Meta.set(connection, "journal_applied_seq", String(entry.seq))
  }
}

/// How hard a checkpoint tries: PASSIVE never waits; TRUNCATE waits for readers and empties the -wal file.
public enum CheckpointMode: Sendable { case passive, truncate }

/// The state of the WAL after a checkpoint.
public struct WALStatus: Sendable {
  public let walBytes: Int
  public let checkpointedFrames: Int
  /// Frames in the WAL, and whether readers kept the checkpoint from finishing.
  public let logFrames: Int
  public let busy: Bool
}

/// What a writer did since it opened (benchmarks and diagnostics: the bootstrap's write volume, ScrollsServiceTests).
public struct WriterStats: Sendable, Equatable {
  /// Committed transactions (`write`, so every `WriteLease.batch`).
  public var transactions = 0
  /// `checkpoint(_:)` calls; the checkpoints SQLite runs itself (`wal_autocheckpoint`) are not counted.
  public var checkpoints = 0
  /// Pages the connection wrote to the WAL (`SQLITE_DBSTATUS_CACHE_WRITE`); checkpoint copies are not counted.
  public var pagesWritten = 0
}

/// The single writer of an atlas.
public actor Writer {
  /// Above this WAL size a bulk lease pauses until a TRUNCATE checkpoint succeeds (ΔS-19: 256 MB on the phone).
  public static let walPauseBytes = 256 << 20

  private let queue: DispatchSerialQueue
  private let connection: Connection
  private var commitObserver: (@Sendable (Int) -> Void)?
  private var activeLease: JobID?
  private var counts = WriterStats()
  public nonisolated let path: String
  public nonisolated let profile: StoreProfile

  public nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

  /// Opens the read-write connection (WAL, synchronous NORMAL; IOS-SPEC §1.4).
  public init(path: String, profile: StoreProfile) throws {
    queue = DispatchSerialQueue(label: "scrolls.writer", qos: .utility)
    connection = try Connection(path: path, mode: .readWrite, profile: profile)
    self.path = path
    self.profile = profile
  }

  /// Runs `body` in one `BEGIN IMMEDIATE` transaction; rolls back and rethrows on error. A cancelled task stops the
  /// running statement (CancellationError). `heartbeat` is called every 10,000 VM steps (a job's stall rule).
  public func write<T: Sendable>(_ label: String, heartbeat: (@Sendable () -> Void)? = nil,
                                 _ body: @Sendable (WriteTx) throws -> T) throws -> T {
    try Task.checkCancellation()
    let tx = WriteTx(connection: connection, label: label)
    connection.beginRequest()
    connection.setHeartbeat(heartbeat)
    defer {
      connection.setHeartbeat(nil)
      connection.endRequest()
    }
    let out: T
    do {
      out = try connection.transaction(.immediate) {
        let r = try body(tx)
        try tx.ids.flush()
        return r
      }
    } catch let e as StoreError where e.isInterrupt {
      if Task.isCancelled || connection.interruptReason == .cancelled { throw CancellationError() }
      throw e
    }
    counts.transactions += 1
    if let v = tx.newDataVersion { commitObserver?(v) }
    return out
  }

  /// The writer's counters since it opened.
  public var stats: WriterStats {
    var s = counts
    var current: Int32 = 0, highwater: Int32 = 0
    if sqlite3_db_status(connection.db, SQLITE_DBSTATUS_CACHE_WRITE, &current, &highwater, 0) == SQLITE_OK { s.pagesWritten = Int(current) }
    return s
  }

  /// Called after every commit that bumped `meta.data_version`, with the new version (AtlasEvent.dataChanged).
  public func setCommitObserver(_ observer: (@Sendable (Int) -> Void)?) { commitObserver = observer }

  /// A lease for a bulk-writing job. The job queue admits one exclusive job at a time, so one lease is active.
  public func lease(for job: JobID) -> WriteLease { lease(for: job, heartbeat: nil) }

  /// A lease whose batches call `heartbeat` while their statements run.
  public func lease(for job: JobID, heartbeat: (@Sendable () -> Void)?) -> WriteLease {
    activeLease = job
    return WriteLease(writer: self, job: job, heartbeat: heartbeat)
  }

  /// The job whose bulk lease is open, if any (diagnostics).
  public var leaseHolder: JobID? { activeLease }

  func endLease(_ job: JobID) {
    if activeLease == job { activeLease = nil }
  }

  /// `PRAGMA wal_checkpoint(PASSIVE|TRUNCATE)` and the WAL's size afterwards.
  public func checkpoint(_ mode: CheckpointMode) throws -> WALStatus {
    counts.checkpoints += 1
    let r = try connection.prepared(mode == .passive ? StoreSQL.checkpointPassive : StoreSQL.checkpointTruncate)
      .first { (busy: $0.int(0), log: $0.int(1), done: $0.int(2)) }
    return WALStatus(walBytes: walBytes, checkpointedFrames: Int(r?.done ?? 0), logFrames: Int(r?.log ?? 0),
                     busy: (r?.busy ?? 0) != 0)
  }

  /// Bytes in the -wal file (0 when there is none).
  public var walBytes: Int {
    let attrs = try? FileManager.default.attributesOfItem(atPath: path + "-wal")
    return (attrs?[.size] as? NSNumber)?.intValue ?? 0
  }

  /// Closes the connection; later writes fail.
  public func close() throws { connection.close() }
}
