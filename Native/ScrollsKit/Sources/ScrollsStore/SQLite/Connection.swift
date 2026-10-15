// OWNER: N0
// One SQLite connection (IOS-SPEC §1.4): opened with SQLITE_OPEN_NOMUTEX (THREADSAFE=2: one thread per connection at a
// time, which is exactly one connection per actor), PRAGMAs by role, a prepared-statement LRU, transactions with
// savepoint nesting, and a progress handler every 10,000 VM steps that enforces the request deadline, notices task
// cancellation and calls the job's heartbeat (the stall rule, §3.7). `InterruptHandle` is the one thread-safe entry.

import Foundation
import SQLite3
import Synchronization

/// The sqlite3* of a connection. Statements keep it alive, so finalizing a statement that outlives an evicted cache
/// entry, or a `Connection` released before its statements, is never a use-after-free (`sqlite3_close_v2`).
final class SQLiteHandle {
  let db: OpaquePointer
  init(_ db: OpaquePointer) { self.db = db }
  deinit { sqlite3_close_v2(db) }
}

/// Why the progress handler stopped a statement.
enum InterruptReason: Sendable, Equatable { case deadline, cancelled }

/// State read by the progress handler. Confined to the connection's thread, like the connection itself.
final class ProgressState {
  var deadline: ContinuousClock.Instant?
  var heartbeat: (@Sendable () -> Void)?
  var reason: InterruptReason?

  /// Called by SQLite every 10,000 VM steps; a non-zero result interrupts the running statement.
  func tick() -> Int32 {
    heartbeat?()
    if let d = deadline, ContinuousClock.now >= d {
      reason = .deadline
      return 1
    }
    if Task.isCancelled {
      reason = .cancelled
      return 1
    }
    return 0
  }
}

/// Serialises `sqlite3_interrupt` with the start and end of requests, so an interrupt aimed at one request can never
/// stop the next request that the same connection runs.
final class InterruptGate: Sendable {
  private struct State {
    var db: UInt = 0  // the sqlite3* bit pattern; 0 once closed
    var token: UInt64 = 0  // the running request, 0 when idle
    var next: UInt64 = 0
  }
  private let state = Mutex(State())

  init(_ db: OpaquePointer) {
    let bits = UInt(bitPattern: db)
    state.withLock { $0.db = bits }
  }

  /// Marks a request as running; `token` names it (the read pool's request id), or a fresh one is made.
  func begin(token: UInt64? = nil) -> UInt64 {
    state.withLock {
      if let token {
        $0.token = token
      } else {
        $0.next &+= 1
        $0.token = $0.next | (1 << 63)  // never equal to a pool request id
      }
      return $0.token
    }
  }

  func end() { state.withLock { $0.token = 0 } }

  /// Interrupts the running statement; with a token, only while that request is the one running.
  func interrupt(token: UInt64? = nil) {
    state.withLock {
      guard $0.db != 0, let p = OpaquePointer(bitPattern: $0.db) else { return }
      if let token, $0.token != token { return }
      sqlite3_interrupt(p)
    }
  }

  func invalidate() { state.withLock { $0.db = 0 } }
}

/// Wraps `sqlite3_interrupt`, the one SQLite call that is safe from any thread.
public struct InterruptHandle: Sendable {
  let gate: InterruptGate
  /// Stops whatever statement the connection is running now (it fails with SQLITE_INTERRUPT).
  public func interrupt() { gate.interrupt() }
}

/// A SQLite connection. Not Sendable: confined to its owning actor (`ReadConnection`, `Writer`) or to one task.
public final class Connection {
  public let profile: StoreProfile
  public let path: String
  public let mode: OpenMode
  let handle: SQLiteHandle
  private let progress = ProgressState()
  private let gate: InterruptGate
  private var catalogue = StatementCache(capacity: 128)
  private var dynamic = StatementCache(capacity: 64)
  private var savepoints = 0
  private var closed = false
  /// The decoded-chunk LRU of `ChunkedTextStore` on this connection (IOS-SPEC §3.4: one per reader).
  var decodedChunks: DecodedChunkCache?

  /// Opens `path` (":memory:" for an in-memory database) with the PRAGMAs of its role: read-write connections are
  /// writers (WAL, synchronous NORMAL, 64 MB cache, no mmap); read-only ones are readers (query_only, 32 MB cache,
  /// `mmapBytes` of mmap).
  public init(path: String, mode: OpenMode, profile: StoreProfile, mmapBytes: Int = 0) throws(StoreError) {
    var raw: OpaquePointer?
    var flags = SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_EXRESCODE
    var target = path
    switch mode {
    case .readWrite: flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
    case .readOnly: flags |= SQLITE_OPEN_READONLY
    case .readOnlyImmutable:
      flags |= SQLITE_OPEN_READONLY | SQLITE_OPEN_URI
      target = "file:" + Connection.uriEscaped(path) + "?immutable=1"
    }
    let rc = sqlite3_open_v2(target, &raw, flags, nil)
    guard let db = raw else { throw StoreError(code: rc, message: "sqlite3_open_v2 returned no handle", sql: nil) }
    let handle = SQLiteHandle(db)
    guard rc == SQLITE_OK else {
      throw StoreError(code: sqlite3_extended_errcode(db), message: String(cString: sqlite3_errmsg(db)), sql: "open \(path)")
    }
    self.handle = handle
    self.profile = profile
    self.path = path
    self.mode = mode
    self.gate = InterruptGate(db)
    sqlite3_extended_result_codes(db, 1)
    sqlite3_progress_handler(db, 10_000, { ctx in
      guard let ctx else { return 0 }
      return Unmanaged<ProgressState>.fromOpaque(ctx).takeUnretainedValue().tick()
    }, Unmanaged.passUnretained(progress).toOpaque())
    try exec(Pragmas.all)
    switch mode {
    case .readWrite:
      if path != ":memory:" { try exec(Pragmas.wal) }
      try exec(Pragmas.writer)
    case .readOnly, .readOnlyImmutable:
      try exec(Pragmas.reader(mmapBytes: mmapBytes))
    }
  }

  deinit {
    gate.invalidate()
    sqlite3_progress_handler(handle.db, 0, nil, nil)
  }

  var db: OpaquePointer { handle.db }

  /// A catalogued statement, reset and with its bindings cleared (LRU of 128, SQLITE_PREPARE_PERSISTENT).
  public func prepared(_ sql: SQL) throws(StoreError) -> Statement {
    try checkOpen()
    if let s = catalogue.get(sql.text) { return try s.reset() }
    let s = try Statement(handle, sql.text, persistent: true)
    catalogue.put(sql.text, s)
    return s
  }

  /// A statement whose text is built at run time (IN-lists, the LogicalDump's table names); LRU of 64.
  public func prepared(dynamic text: String) throws(StoreError) -> Statement {
    try checkOpen()
    if let s = dynamic.get(text) { return try s.reset() }
    let s = try Statement(handle, text, persistent: false)
    dynamic.put(text, s)
    return s
  }

  /// Runs one or more statements without results (DDL, PRAGMAs, transaction control).
  public func exec(_ text: String) throws(StoreError) {
    try checkOpen()
    var err: UnsafeMutablePointer<CChar>?
    let rc = sqlite3_exec(db, text, nil, nil, &err)
    if rc != SQLITE_OK {
      let message = err.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(db))
      sqlite3_free(err)
      throw StoreError(code: sqlite3_extended_errcode(db), message: message, sql: text)
    }
  }

  /// Runs `body` in a transaction: `BEGIN DEFERRED|IMMEDIATE … COMMIT`, or a SAVEPOINT when one is already open.
  /// Rolls back and rethrows when `body` throws.
  public func transaction<T>(_ kind: TxKind = .deferred, _ body: () throws -> T) throws -> T {
    if isInTransaction {
      savepoints += 1
      let name = "sp_\(savepoints)"
      try exec("SAVEPOINT \(name)")  // lint: sql-ok (transaction control of Connection.transaction)
      do {
        let out = try body()
        try exec("RELEASE \(name)")  // lint: sql-ok (transaction control of Connection.transaction)
        return out
      } catch {
        try? exec("ROLLBACK TO \(name); RELEASE \(name)")  // lint: sql-ok (transaction control of Connection.transaction)
        throw error
      }
    }
    try exec(kind == .immediate ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED")  // lint: sql-ok (transaction control of Connection.transaction)
    do {
      let out = try body()
      resetBusyStatements()
      try exec("COMMIT")
      return out
    } catch {
      resetBusyStatements()
      if isInTransaction { try? exec("ROLLBACK") }
      throw error
    }
  }

  /// The request deadline the progress handler enforces (nil: none). Expired → the statement fails with
  /// SQLITE_INTERRUPT and `interruptReason == .deadline`.
  public func setDeadline(_ deadline: ContinuousClock.Instant?) { progress.deadline = deadline }

  /// Called by the progress handler every 10,000 VM steps, so a long statement still reports progress (§3.7).
  public func setHeartbeat(_ beat: (@Sendable () -> Void)?) { progress.heartbeat = beat }

  /// The thread-safe interrupt of this connection.
  public var interruptHandle: InterruptHandle { InterruptHandle(gate: gate) }

  /// Rows changed by the last INSERT, UPDATE or DELETE.
  public var changes: Int { Int(sqlite3_changes64(db)) }

  /// The rowid of the last successful INSERT on this connection.
  public var lastInsertRowID: Int64 { sqlite3_last_insert_rowid(db) }

  /// Whether a transaction is open (autocommit is off).
  public var isInTransaction: Bool { sqlite3_get_autocommit(db) == 0 }

  /// Finalizes the cached statements; the file closes once no statement handed out is alive.
  public func close() {
    guard !closed else { return }
    closed = true
    catalogue.removeAll()
    dynamic.removeAll()
    gate.invalidate()
  }

  // ── internal ──

  /// Why the last statement was interrupted by the progress handler (cleared by `beginRequest`).
  var interruptReason: InterruptReason? { progress.reason }

  /// Marks the start of one request (a read or a write): clears the interrupt reason, returns the interrupt token.
  @discardableResult
  func beginRequest(token: UInt64? = nil) -> UInt64 {
    progress.reason = nil
    return gate.begin(token: token)
  }

  func endRequest() { gate.end() }

  var interruptGate: InterruptGate { gate }

  /// Resets every statement still mid-iteration, so COMMIT never fails on a pending read and no snapshot is pinned.
  func resetBusyStatements() {
    var s = sqlite3_next_stmt(db, nil)
    while let stmt = s {
      if sqlite3_stmt_busy(stmt) != 0 { sqlite3_reset(stmt) }
      s = sqlite3_next_stmt(db, stmt)
    }
  }

  func error(_ sql: String?) -> StoreError {
    StoreError(code: sqlite3_extended_errcode(db), message: String(cString: sqlite3_errmsg(db)), sql: sql)
  }

  private func checkOpen() throws(StoreError) {
    if closed { throw StoreError.misuse("the connection to \(path) is closed") }
  }

  private static func uriEscaped(_ path: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "?#%")
    return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
  }
}

/// A least-recently-used map of prepared statements.
struct StatementCache {
  private var entries: [String: (statement: Statement, used: UInt64)] = [:]
  private var clock: UInt64 = 0
  let capacity: Int

  init(capacity: Int) { self.capacity = capacity }

  mutating func get(_ key: String) -> Statement? {
    guard let e = entries[key] else { return nil }
    clock &+= 1
    entries[key] = (e.statement, clock)
    return e.statement
  }

  mutating func put(_ key: String, _ statement: Statement) {
    clock &+= 1
    if entries.count >= capacity, let victim = entries.min(by: { $0.value.used < $1.value.used })?.key {
      entries[victim] = nil  // finalized when its last holder lets go
    }
    entries[key] = (statement, clock)
  }

  mutating func removeAll() { entries.removeAll() }
  var count: Int { entries.count }
}
