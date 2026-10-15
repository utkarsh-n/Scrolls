// OWNER: N0
// The row cursor of a statement (IOS-SPEC §8.4.4): columns are read in place; `utf16(_:)` is sqlite3_column_text16,
// already the D4 offset space, so short fields are sliced without a String round trip.

import Foundation
import SQLite3

/// The current row of a statement; valid until the statement steps again.
public struct Row {
  let stmt: OpaquePointer

  /// The column as a 64-bit integer (0 for NULL).
  public func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
  /// The column as a double (0 for NULL).
  public func double(_ i: Int32) -> Double { sqlite3_column_double(stmt, i) }
  /// The column as text ("" for NULL); invalid UTF-8 is repaired with U+FFFD.
  public func text(_ i: Int32) -> String {
    guard let p = sqlite3_column_text(stmt, i) else { return "" }
    return String(decoding: UnsafeBufferPointer(start: p, count: Int(sqlite3_column_bytes(stmt, i))), as: UTF8.self)
  }
  /// The column as UTF-16 code units, in place (empty for NULL). Valid until the next step or column read.
  public func utf16(_ i: Int32) -> UnsafeBufferPointer<UInt16> {
    guard let p = sqlite3_column_text16(stmt, i) else { return UnsafeBufferPointer(start: nil, count: 0) }
    let n = Int(sqlite3_column_bytes16(stmt, i)) / 2
    return UnsafeBufferPointer(start: p.assumingMemoryBound(to: UInt16.self), count: n)
  }
  /// The column as bytes (empty for NULL).
  public func blob(_ i: Int32) -> [UInt8] {
    let n = Int(sqlite3_column_bytes(stmt, i))
    guard n > 0, let p = sqlite3_column_blob(stmt, i) else { return [] }
    return Array(UnsafeRawBufferPointer(start: p, count: n))
  }
  /// Whether the column is NULL.
  public func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }

  // ── additive helpers ──

  /// The column as an optional integer.
  public func intOrNil(_ i: Int32) -> Int64? { isNull(i) ? nil : int(i) }
  /// The column as optional text.
  public func textOrNil(_ i: Int32) -> String? { isNull(i) ? nil : text(i) }
  /// The column as an optional double.
  public func doubleOrNil(_ i: Int32) -> Double? { isNull(i) ? nil : double(i) }
  /// The column's storage class as a value.
  public func value(_ i: Int32) -> SQLValue {
    switch sqlite3_column_type(stmt, i) {
    case SQLITE_INTEGER: .int(int(i))
    case SQLITE_FLOAT: .double(double(i))
    case SQLITE_TEXT: .text(text(i))
    case SQLITE_BLOB: .blob(blob(i))
    default: .null
    }
  }
  /// Result columns.
  public var count: Int32 { sqlite3_column_count(stmt) }
  /// The name of column `i`.
  public func name(_ i: Int32) -> String { sqlite3_column_name(stmt, i).map { String(cString: $0) } ?? "" }
}
