// OWNER: N0
// The value types of the SQLite layer (IOS-SPEC §8.4.4): a bound or read value, the transaction kind, the database's
// profile, the open mode and the one error type every SQLite call throws.

import Foundation
import SQLite3

/// A value bound to, or read from, a statement.
public enum SQLValue: Sendable, Equatable {
  case int(Int64)
  case double(Double)
  case text(String)
  case blob([UInt8])
  case null

  /// `.int` for a present integer, `.null` for nil.
  public static func integer(_ v: Int?) -> SQLValue { v.map { .int(Int64($0)) } ?? .null }
  /// `.int` for a present integer, `.null` for nil.
  public static func integer(_ v: Int64?) -> SQLValue { v.map { .int($0) } ?? .null }
  /// `.text` for a present string, `.null` for nil.
  public static func string(_ v: String?) -> SQLValue { v.map { .text($0) } ?? .null }
  /// `.double` for a present number, `.null` for nil.
  public static func real(_ v: Double?) -> SQLValue { v.map { .double($0) } ?? .null }
}

/// How a transaction takes its locks: `BEGIN DEFERRED` (readers) or `BEGIN IMMEDIATE` (writers).
public enum TxKind: Sendable { case deferred, immediate }

/// Which DDL a database was built with: `reference` is a Node-built database (schema.sql only), `device` adds the
/// device profile (chunked text, id counters, journal bookkeeping; IOS-SPEC §3.2).
public enum StoreProfile: String, Sendable { case reference, device }

/// How a connection opens its file. `readOnlyImmutable` opens with `?immutable=1` (test clones that nobody writes).
public enum OpenMode: Sendable { case readWrite, readOnly, readOnlyImmutable }

/// Every failure of the SQLite layer: the (extended) SQLite result code, its message and the statement text.
public struct StoreError: Error, Sendable, Equatable, CustomStringConvertible {
  public let code: Int32
  public let message: String
  public let sql: String?

  public init(code: Int32, message: String, sql: String? = nil) {
    self.code = code
    self.message = message
    self.sql = sql
  }

  /// The primary result code (the low byte of an extended code).
  public var primaryCode: Int32 { code & 0xFF }
  /// A CHECK, UNIQUE, NOT NULL, FOREIGN KEY failure or a `RAISE(ABORT)` trigger.
  public var isConstraint: Bool { primaryCode == SQLITE_CONSTRAINT }
  /// A `CHECK` constraint failed.
  public var isCheck: Bool { code == StoreError.constraintCheck }
  /// A trigger raised `RAISE(ABORT, …)`.
  public var isTriggerAbort: Bool { code == StoreError.constraintTrigger }
  /// Another connection holds the lock (`SQLITE_BUSY` / `SQLITE_LOCKED`).
  public var isBusy: Bool { primaryCode == SQLITE_BUSY || primaryCode == SQLITE_LOCKED }
  /// The statement was stopped by `sqlite3_interrupt` or the progress handler (deadline, cancellation).
  public var isInterrupt: Bool { primaryCode == SQLITE_INTERRUPT }

  public var description: String { "SQLite \(code): \(message)" + (sql.map { " — \($0.prefix(200))" } ?? "") }

  /// SQLITE_CONSTRAINT_CHECK.
  public static let constraintCheck: Int32 = SQLITE_CONSTRAINT | (1 << 8)
  /// SQLITE_CONSTRAINT_TRIGGER.
  public static let constraintTrigger: Int32 = SQLITE_CONSTRAINT | (7 << 8)
  /// A misuse of this layer (not an SQLite error): wrong parameter count, a closed connection, a bad resource.
  public static func misuse(_ message: String, sql: String? = nil) -> StoreError {
    StoreError(code: SQLITE_MISUSE, message: message, sql: sql)
  }
}

/// `SQLITE_TRANSIENT`: SQLite copies the bound bytes before the bind call returns.
var sqliteTransient: sqlite3_destructor_type { unsafeBitCast(-1, to: sqlite3_destructor_type.self) }
