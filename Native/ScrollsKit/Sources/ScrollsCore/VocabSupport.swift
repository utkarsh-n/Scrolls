// OWNER: N0
// Support for the generated Vocab.swift and Copy.swift: an insertion-ordered map (JavaScript objects keep key order,
// and several vocabularies are read in that order, e.g. TOGGLE_DEFAULTS in the view-state hash), the JSON bridge the
// parity tests use, and fillTemplate.

import Foundation

/// A string-keyed map that keeps the reference object's key order.
public struct OrderedMap<Value: Sendable & Hashable>: Sendable, Hashable, RandomAccessCollection {
  public let keys: [String]
  public let values: [Value]
  private let positions: [String: Int]

  /// Builds the map from pairs in order; a repeated key keeps its first position and takes the last value, as
  /// assigning a property of a JavaScript object does.
  public init(_ pairs: [(String, Value)]) {
    var keys: [String] = []
    var values: [Value] = []
    var positions: [String: Int] = [:]
    for (k, v) in pairs {
      if let i = positions[k] {
        values[i] = v
      } else {
        positions[k] = keys.count
        keys.append(k)
        values.append(v)
      }
    }
    self.keys = keys
    self.values = values
    self.positions = positions
  }

  public subscript(key: String) -> Value? { positions[key].map { values[$0] } }
  public func contains(key: String) -> Bool { positions[key] != nil }

  public var startIndex: Int { 0 }
  public var endIndex: Int { keys.count }
  public subscript(position: Int) -> (key: String, value: Value) { (keys[position], values[position]) }

  public static func == (a: Self, b: Self) -> Bool { a.keys == b.keys && a.values == b.values }
  public func hash(into h: inout Hasher) {
    h.combine(keys)
    h.combine(values)
  }
}

/// A value with a canonical JSON form equal to the reference's (`jsonValue` of a generated row is the JavaScript
/// object it was generated from).
public protocol JSONRepresentable {
  var jsonValue: JSONValue { get }
}

extension JSONValue: JSONRepresentable { public var jsonValue: JSONValue { self } }
extension String: JSONRepresentable { public var jsonValue: JSONValue { .string(self) } }
extension Int: JSONRepresentable { public var jsonValue: JSONValue { .number(Double(self)) } }
extension Double: JSONRepresentable { public var jsonValue: JSONValue { .number(self) } }
extension Bool: JSONRepresentable { public var jsonValue: JSONValue { .bool(self) } }
extension Array: JSONRepresentable where Element: JSONRepresentable {
  public var jsonValue: JSONValue { .array(map(\.jsonValue)) }
}
extension OrderedMap: JSONRepresentable where Value: JSONRepresentable {
  public var jsonValue: JSONValue {
    .object(JSONObject(zip(keys, values.map(\.jsonValue))))
  }
}

/// Resources/vocab.json is missing from the bundle (a packaging error).
public struct VocabResourceMissing: Error, Sendable {}

extension Vocab {
  /// Resources/vocab.json: every export of src/shared/vocab.mjs as JSON (what vocabulary seeding reads). Equal to the
  /// typed statics of this enum and of `Copy` (tested).
  public static func bundledJSON() throws -> JSONValue {
    guard let url = Bundle.module.url(forResource: "vocab", withExtension: "json") else { throw VocabResourceMissing() }
    return try JSONValue.parse(Data(contentsOf: url))
  }

  /// `fillTemplate(template, vars)`: replaces `{name}` placeholders (`[a-z_]+`). A missing or null value leaves the
  /// placeholder visible, so a missing value is noticed rather than silently blanked. Values print as JavaScript's
  /// `String(x)` does.
  public static func fillTemplate(_ template: String, _ vars: JSONObject) -> String {
    let u = Array(template.utf16)
    var out: [UInt16] = []
    out.reserveCapacity(u.count)
    var i = 0
    while i < u.count {
      if u[i] == 0x7B {  // '{'
        var j = i + 1
        while j < u.count, (u[j] >= 0x61 && u[j] <= 0x7A) || u[j] == 0x5F { j += 1 }
        if j > i + 1, j < u.count, u[j] == 0x7D {
          let name = String(decoding: u[(i + 1)..<j], as: UTF16.self)
          if let v = vars[name], !v.isNull {
            out.append(contentsOf: jsString(v).utf16)
          } else {
            out.append(contentsOf: u[i...j])
          }
          i = j + 1
          continue
        }
      }
      out.append(u[i])
      i += 1
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// JavaScript `String(x)` of a JSON value (arrays join with ',', null and undefined elements print empty).
  static func jsString(_ v: JSONValue) -> String {
    switch v {
    case .null: "null"
    case .bool(let b): b ? "true" : "false"
    case .number(let n): JSNumber.format(n)
    case .string(let s): s
    case .array(let a): a.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
    case .object: "[object Object]"
    }
  }
}
