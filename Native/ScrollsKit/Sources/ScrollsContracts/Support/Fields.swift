// OWNER: N0
// Presence of contract keys. The contract distinguishes a key that is absent, present with null, and present with a
// value; the C0 round trip compares bytes, so a Swift field must keep that distinction where the contract has it:
//   `T`                       required key, never null
//   `T?`                      optional key, never null (absent when nil)
//   `@Nullable var x: T?`     required key that may be null (written as null when nil)
//   `@NullOrAbsent var x: T?` optional key that may also be null (absent when nil, unless decoded or set as null)
//   `JSONValue`               a contract-opaque value ('object', 'array', 'any'), verbatim, null included

import ScrollsCore

/// A required contract key whose value may be null: always written, as null when `wrappedValue` is nil.
@propertyWrapper
public struct Nullable<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
  public var wrappedValue: Value?

  public init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    wrappedValue = c.decodeNil() ? nil : try c.decode(Value.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    if let wrappedValue { try c.encode(wrappedValue) } else { try c.encodeNil() }
  }
}

/// An optional contract key that may also be null. Reading gives the value or nil; `$key` tells absent from null.
/// Setting nil makes the key absent; set `$key = .null` to write an explicit null.
@propertyWrapper
public struct NullOrAbsent<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
  /// What the key holds on the wire.
  public enum Presence: Sendable, Equatable {
    case absent
    case null
    case value(Value)
  }

  public var projectedValue: Presence

  public var wrappedValue: Value? {
    get { if case .value(let v) = projectedValue { v } else { nil } }
    set { projectedValue = newValue.map(Presence.value) ?? .absent }
  }

  public init(wrappedValue: Value?) { projectedValue = wrappedValue.map(Presence.value) ?? .absent }
  public init(_ presence: Presence) { projectedValue = presence }

  /// Used only outside a keyed container (an array element), where a key cannot be absent: nil reads as null.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    projectedValue = c.decodeNil() ? .null : .value(try c.decode(Value.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch projectedValue {
    case .absent, .null: try c.encodeNil()
    case .value(let v): try c.encode(v)
    }
  }
}

extension KeyedDecodingContainer {
  /// A `@NullOrAbsent` key: absent, null or a value (synthesized `init(from:)` resolves to this overload).
  public func decode<V>(_ type: NullOrAbsent<V>.Type, forKey key: Key) throws -> NullOrAbsent<V> {
    guard contains(key) else { return NullOrAbsent(.absent) }
    if try decodeNil(forKey: key) { return NullOrAbsent(.null) }
    return NullOrAbsent(.value(try decode(V.self, forKey: key)))
  }
}

extension KeyedEncodingContainer {
  /// A `@NullOrAbsent` key: nothing when absent (synthesized `encode(to:)` resolves to this overload).
  public mutating func encode<V>(_ value: NullOrAbsent<V>, forKey key: Key) throws {
    switch value.projectedValue {
    case .absent: break
    case .null: try encodeNil(forKey: key)
    case .value(let v): try encode(v, forKey: key)
    }
  }
}

/// A JSON scalar that is an integer in some rows and a string in others ('integer|string': strand refs, wash strands).
public enum IntOrString: Codable, Sendable, Hashable, CustomStringConvertible {
  case int(Int)
  case string(String)

  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .string(s); return }
    let d = try c.decode(Double.self)
    guard let i = Int(exactly: d) else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "expected an integer or a string, got \(d)")
    }
    self = .int(i)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .int(let i): try c.encode(i)
    case .string(let s): try c.encode(s)
    }
  }

  /// The value as the reference writes it in keys and refs ('12', 'gene').
  public var description: String {
    switch self {
    case .int(let i): String(i)
    case .string(let s): s
    }
  }
}
