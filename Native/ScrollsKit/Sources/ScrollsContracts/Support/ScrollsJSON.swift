// OWNER: N0
// The one JSON coder pair of the contract types (IOS-SPEC §1.6): Swift properties are camelCase and the wire is the
// reference's snake_case. The conversion is a custom key strategy, not Foundation's convertTo/FromSnakeCase, because
// the contract also has camelCase keys (`dataVersion`, `queryKey`, …) and keys with digits (`after_1928`) that the
// stock strategies cannot round-trip: a type names those in its CodingKeys through `WireNamedKeys`.
// String-keyed dictionaries (and therefore every `JSONValue` object) bypass key strategies, so their keys stay verbatim.

import Foundation
import ScrollsCore

/// The shared encoder and decoder of every contract type, and helpers to move between Swift values and `JSONValue`.
public enum ScrollsJSON {
  /// Encodes contract values with snake_case keys (see `WireNamedKeys` for the exceptions); compact, unsorted output.
  /// Use `canonical(_:)` for comparisons and hashes.
  public static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.keyEncodingStrategy = .custom(encodeKey)
    e.outputFormatting = [.withoutEscapingSlashes]
    e.nonConformingFloatEncodingStrategy = .throw
    return e
  }

  /// Decodes contract values written by the reference (or by `encoder`).
  public static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .custom(decodeKey)
    return d
  }

  /// The JSON bytes of a contract value.
  public static func data<T: Encodable>(_ v: T) throws -> Data { try encoder.encode(v) }

  /// The value as a `JSONValue` (what `JSON.parse` of its encoding gives).
  public static func value<T: Encodable>(_ v: T) throws -> JSONValue { try JSONValue.parse(data(v)) }

  /// The canonical JSON text of a value (sorted keys, JavaScript number formatting): the form C0 compares.
  public static func canonical<T: Encodable>(_ v: T) throws -> String { CanonicalJSON.string(try value(v)) }

  /// Decodes a contract type from JSON bytes.
  public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T { try decoder.decode(type, from: data) }

  /// Decodes a contract type from a `JSONValue` (for example a fixture body or an opaque field).
  public static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
    try decoder.decode(type, from: Data(CanonicalJSON.string(value).utf8))
  }

  // MARK: key conversion

  /// `queryKey` → `query_key`: an underscore before each ASCII capital, which is lowered. ASCII only: no locale, and no
  /// Swift String case mapping (banned in the engine by the lint).
  public static func snakeCase(_ key: String) -> String {
    var out: [UInt8] = []
    out.reserveCapacity(key.utf8.count + 4)
    for (i, b) in key.utf8.enumerated() {
      if b >= 0x41 && b <= 0x5A {
        if i > 0 { out.append(0x5F) }
        out.append(b + 0x20)
      } else {
        out.append(b)
      }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `query_key` → `queryKey`: each ASCII letter after an inner underscore is raised and the underscore dropped. A key
  /// without an inner underscore (`dataVersion`, `sha256`), or with leading, trailing or doubled underscores, is kept.
  public static func camelCase(_ key: String) -> String {
    let u = Array(key.utf8)
    guard let first = u.first, let last = u.last, first != 0x5F, last != 0x5F, u.contains(0x5F) else { return key }
    var out: [UInt8] = []
    out.reserveCapacity(u.count)
    var raise = false
    for (i, b) in u.enumerated() {
      if b == 0x5F {
        if i > 0 && u[i - 1] == 0x5F { return key }
        raise = true
        continue
      }
      out.append(raise && b >= 0x61 && b <= 0x7A ? b - 0x20 : b)
      raise = false
    }
    return String(decoding: out, as: UTF8.self)
  }

  private static let encodeKey: @Sendable ([any CodingKey]) -> any CodingKey = { path in
    guard let key = path.last else { return WireKey("") }
    if let named = type(of: key) as? any WireNamedKeys.Type, let wire = named.wireNames[key.stringValue] {
      return WireKey(wire)
    }
    if key.intValue != nil { return key }
    return WireKey(snakeCase(key.stringValue))
  }

  private static let decodeKey: @Sendable ([any CodingKey]) -> any CodingKey = { path in
    guard let key = path.last else { return WireKey("") }
    if key.intValue != nil { return key }
    return WireKey(camelCase(key.stringValue))
  }
}

/// CodingKeys whose JSON names are not the snake_case form of their Swift names: the contract's camelCase keys
/// (`dataVersion`), and snake_case keys a round trip through `camelCase` would lose (`after_1928` → `after1928`).
/// `wireNames` maps the Swift key (`stringValue`) to the JSON key; the decoder needs nothing, because
/// `ScrollsJSON.camelCase` of each listed JSON key is the Swift key. Such a CodingKeys enum must list every stored
/// property: an optional property left out would silently never be coded.
public protocol WireNamedKeys: CodingKey {
  static var wireNames: [String: String] { get }
}

/// A plain string coding key (the result of a key conversion, and the key of hand-written containers).
public struct WireKey: CodingKey, Sendable, Hashable {
  public let stringValue: String
  public var intValue: Int? { nil }
  public init(_ s: String) { stringValue = s }
  public init?(stringValue: String) { self.stringValue = stringValue }
  public init?(intValue: Int) { nil }
}
