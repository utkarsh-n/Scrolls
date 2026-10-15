// OWNER: N4
// Small helpers over ScrollsStore's statements for the analysis code: bind, map every row, first row. Every text comes
// from `AnalysisSQL` (the catalogue); nothing here holds SQL.

import Foundation
import ScrollsCore
import ScrollsStore

extension Connection {
  /// Every row of a catalogued statement, mapped (the statement is reset afterwards, so it may be reused at once).
  func rows<T>(_ sql: SQL, _ args: [SQLValue] = [], _ map: (Row) throws -> T) throws -> [T] {
    let s = try prepared(sql)
    try s.bind(args)
    return try s.all(map)
  }

  /// The first row mapped, or nil.
  func first<T>(_ sql: SQL, _ args: [SQLValue] = [], _ map: (Row) throws -> T) throws -> T? {
    let s = try prepared(sql)
    return try s.bindingFirst(args, map)
  }

  /// `meta.value` of `key`.
  func metaValue(_ key: String) throws -> String? { try first(AnalysisSQL.meta, [.text(key)]) { $0.text(0) } }
}

extension Row {
  /// An integer column as Int (0 for NULL).
  func i(_ c: Int32) -> Int { Int(int(c)) }
  /// An optional integer column.
  func iOrNil(_ c: Int32) -> Int? { intOrNil(c).map(Int.init) }
  /// A column as a JSON value with SQLite's storage class (integers and reals as numbers).
  func json(_ c: Int32) -> JSONValue {
    switch value(c) {
    case .int(let n): .number(Double(n))
    case .double(let d): .number(d)
    case .text(let s): .string(s)
    case .blob, .null: .null
    }
  }
}

extension JSONValue {
  /// The value as JSON text would parse in the reference (`JSON.parse`), or nil when it is not valid JSON.
  static func parseOrNil(_ text: String?) -> JSONValue? {
    guard let text else { return nil }
    return try? JSONValue.parse(text)
  }

  /// A JSON number.
  static func int(_ n: Int) -> JSONValue { .number(Double(n)) }
  /// A JSON number or null.
  static func num(_ x: Double?) -> JSONValue { x.map(JSONValue.number) ?? .null }
  /// A JSON string or null.
  static func str(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
  /// A JSON array of strings.
  static func strings(_ a: [String]) -> JSONValue { .array(a.map(JSONValue.string)) }
  /// A JSON array of integers.
  static func ints(_ a: [Int]) -> JSONValue { .array(a.map { .number(Double($0)) }) }
}

/// The JSON text of the reference's `JSON.stringify` for arrays of integers (json_each arguments).
func jsonArray(_ ids: [Int]) -> String { "[" + ids.map(String.init).joined(separator: ",") + "]" }
