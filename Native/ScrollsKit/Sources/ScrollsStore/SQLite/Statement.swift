// OWNER: N0
// A prepared statement and the row cursor over it (IOS-SPEC §8.4.4). `Row` reads columns in place: `utf16(_:)` is
// sqlite3_column_text16, already the D4 offset space, so short fields are sliced without a String round trip.

import Foundation
import SQLite3

/// A prepared statement. Not Sendable: it belongs to its connection's owner.
public final class Statement {
  let stmt: OpaquePointer
  let handle: SQLiteHandle
  /// The statement text (for errors and EXPLAIN).
  public let text: String

  init(_ handle: SQLiteHandle, _ text: String, persistent: Bool) throws(StoreError) {
    var raw: OpaquePointer?
    let flags = persistent ? UInt32(SQLITE_PREPARE_PERSISTENT) : 0
    let rc = sqlite3_prepare_v3(handle.db, text, -1, flags, &raw, nil)
    guard rc == SQLITE_OK, let s = raw else {
      throw StoreError(code: sqlite3_extended_errcode(handle.db), message: String(cString: sqlite3_errmsg(handle.db)), sql: text)
    }
    self.stmt = s
    self.handle = handle
    self.text = text
  }

  deinit { sqlite3_finalize(stmt) }

  /// Resets the cursor and clears the bindings.
  @discardableResult
  func reset() throws(StoreError) -> Statement {
    sqlite3_reset(stmt)
    sqlite3_clear_bindings(stmt)
    return self
  }

  /// Binds positional parameters 1…n (after a reset, so a statement can be re-bound mid-iteration).
  public func bind(_ values: SQLValue...) throws(StoreError) { try bind(values) }

  /// Binds positional parameters 1…n.
  public func bind(_ values: [SQLValue]) throws(StoreError) {
    sqlite3_reset(stmt)
    sqlite3_clear_bindings(stmt)
    let expected = Int(sqlite3_bind_parameter_count(stmt))
    guard values.count == expected else {
      throw StoreError.misuse("expected \(expected) parameters, got \(values.count)", sql: text)
    }
    for (k, v) in values.enumerated() {
      let i = Int32(k + 1)
      let rc: Int32
      switch v {
      case .null: rc = sqlite3_bind_null(stmt, i)
      case .int(let n): rc = sqlite3_bind_int64(stmt, i, n)
      case .double(let d): rc = sqlite3_bind_double(stmt, i, d)
      case .text(let s):
        var s = s
        rc = s.withUTF8 { b in
          b.count == 0
            ? sqlite3_bind_text(stmt, i, "", 0, sqliteTransient)
            : sqlite3_bind_text(stmt, i, UnsafeRawPointer(b.baseAddress!).assumingMemoryBound(to: CChar.self), Int32(b.count), sqliteTransient)
        }
      case .blob(let bytes):
        rc = bytes.isEmpty
          ? sqlite3_bind_zeroblob(stmt, i, 0)
          : bytes.withUnsafeBytes { sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32($0.count), sqliteTransient) }
      }
      guard rc == SQLITE_OK else { throw error() }
    }
  }

  /// Advances to the next row; nil when the statement is done. The row is valid until the next `step()`.
  public func step() throws(StoreError) -> Row? {
    switch sqlite3_step(stmt) {
    case SQLITE_ROW: return Row(stmt: stmt)
    case SQLITE_DONE: return nil
    default:
      let e = error()
      sqlite3_reset(stmt)
      throw e
    }
  }

  /// Runs the statement to completion (an INSERT, UPDATE or DELETE), then resets it.
  public func run() throws(StoreError) {
    while try step() != nil {}
    sqlite3_reset(stmt)
  }

  /// Maps every remaining row, then resets the statement.
  public func all<T>(_ map: (Row) throws -> T) throws -> [T] {
    var out: [T] = []
    do {
      while let row = try step() { out.append(try map(row)) }
    } catch {
      sqlite3_reset(stmt)
      throw error
    }
    sqlite3_reset(stmt)
    return out
  }

  /// The first row mapped, or nil; the statement is reset afterwards.
  public func first<T>(_ map: (Row) throws -> T) throws -> T? {
    defer { sqlite3_reset(stmt) }
    guard let row = try step() else { return nil }
    return try map(row)
  }

  /// Result columns.
  public var columnCount: Int32 { sqlite3_column_count(stmt) }
  /// The name of result column `i`.
  public func columnName(_ i: Int32) -> String { sqlite3_column_name(stmt, i).map { String(cString: $0) } ?? "" }

  private func error() -> StoreError {
    StoreError(code: sqlite3_extended_errcode(handle.db), message: String(cString: sqlite3_errmsg(handle.db)), sql: text)
  }
}
