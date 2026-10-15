// OWNER: N3
// A JSON value whose object keys keep their insertion order, written exactly as `JSON.stringify` writes a JavaScript
// object literal. Exports are byte strings (the manifest first, then rows in column order), so their key order is part of
// the output; everything compared canonically uses `JSONValue` instead (`.value`).

import ScrollsCore

/// A JSON value with ordered object keys.
public indirect enum OJ: Sendable, Equatable {
  case null
  case bool(Bool)
  case num(Double)
  case str(String)
  case arr([OJ])
  case obj([(String, OJ)])

  public static func == (a: OJ, b: OJ) -> Bool { a.value == b.value }

  /// An integer.
  public static func int(_ n: Int) -> OJ { .num(Double(n)) }
  public static func int(_ n: Int64) -> OJ { .num(Double(n)) }
  /// An optional integer (null when nil).
  public static func int(_ n: Int?) -> OJ { n.map { .num(Double($0)) } ?? .null }
  public static func int(_ n: Int64?) -> OJ { n.map { .num(Double($0)) } ?? .null }
  /// An optional string (null when nil).
  public static func str(_ s: String?) -> OJ { s.map(OJ.str) ?? .null }
  /// An optional number (null when nil).
  public static func num(_ x: Double?) -> OJ { x.map(OJ.num) ?? .null }

  /// The unordered value (for canonical comparison and contract types).
  public var value: JSONValue {
    switch self {
    case .null: .null
    case .bool(let b): .bool(b)
    case .num(let x): .number(x)
    case .str(let s): .string(s)
    case .arr(let a): .array(a.map(\.value))
    case .obj(let o): .object(JSONObject(o.map { ($0.0, $0.1.value) }))
    }
  }

  /// A `JSONValue` as an ordered value (keys in code-unit order: a parsed value has no order of its own).
  public init(_ v: JSONValue) {
    switch v {
    case .null: self = .null
    case .bool(let b): self = .bool(b)
    case .number(let x): self = .num(x)
    case .string(let s): self = .str(s)
    case .array(let a): self = .arr(a.map(OJ.init))
    case .object(let o): self = .obj(o.keys.sorted(by: CanonicalJSON.codeUnitLess).map { ($0, OJ(o[$0]!)) })
    }
  }

  /// `JSON.stringify(value)`.
  public func stringify() -> String {
    var out: [UInt16] = []
    out.reserveCapacity(256)
    write(into: &out)
    return String(decoding: out, as: UTF16.self)
  }

  /// `JSON.stringify(value, null, indent)`.
  public func stringify(indent: Int) -> String {
    var out: [UInt16] = []
    writePretty(into: &out, indent: indent, level: 0)
    return String(decoding: out, as: UTF16.self)
  }

  /// Appends a member (objects only).
  public func adding(_ key: String, _ v: OJ) -> OJ {
    guard case .obj(var o) = self else { return self }
    if let i = o.firstIndex(where: { JSString.equal($0.0, key) }) { o[i].1 = v } else { o.append((key, v)) }
    return .obj(o)
  }

  /// The member named `key` (objects only).
  public subscript(key: String) -> OJ? {
    guard case .obj(let o) = self else { return nil }
    return o.first { JSString.equal($0.0, key) }?.1
  }

  private func write(into out: inout [UInt16]) {
    switch self {
    case .null: out += "null".utf16
    case .bool(let b): out += (b ? "true" : "false").utf16
    case .num(let x): out += (x.isFinite ? JSNumber.format(x) : "null").utf16
    case .str(let s): out += CanonicalJSON.quote(s).utf16
    case .arr(let a):
      out.append(0x5B)
      for (i, e) in a.enumerated() {
        if i > 0 { out.append(0x2C) }
        e.write(into: &out)
      }
      out.append(0x5D)
    case .obj(let o):
      out.append(0x7B)
      for (i, (k, v)) in o.enumerated() {
        if i > 0 { out.append(0x2C) }
        out += CanonicalJSON.quote(k).utf16
        out.append(0x3A)
        v.write(into: &out)
      }
      out.append(0x7D)
    }
  }

  private func writePretty(into out: inout [UInt16], indent: Int, level: Int) {
    let pad = { (n: Int) -> [UInt16] in Array(repeating: 0x20, count: n * indent) }
    switch self {
    case .arr(let a) where !a.isEmpty:
      out.append(0x5B)
      for (i, e) in a.enumerated() {
        if i > 0 { out.append(0x2C) }
        out.append(0x0A)
        out += pad(level + 1)
        e.writePretty(into: &out, indent: indent, level: level + 1)
      }
      out.append(0x0A)
      out += pad(level)
      out.append(0x5D)
    case .obj(let o) where !o.isEmpty:
      out.append(0x7B)
      for (i, (k, v)) in o.enumerated() {
        if i > 0 { out.append(0x2C) }
        out.append(0x0A)
        out += pad(level + 1)
        out += CanonicalJSON.quote(k).utf16
        out += ": ".utf16
        v.writePretty(into: &out, indent: indent, level: level + 1)
      }
      out.append(0x0A)
      out += pad(level)
      out.append(0x7D)
    default:
      write(into: &out)
    }
  }
}

extension OJ: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByFloatLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral
{
  public init(stringLiteral value: String) { self = .str(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .num(Double(value)) }
  public init(floatLiteral value: Double) { self = .num(value) }
  public init(nilLiteral: ()) { self = .null }
  public init(arrayLiteral elements: OJ...) { self = .arr(elements) }
}

extension JSONValue {
  /// A Swift integer as a JSON number.
  public static func int(_ n: Int) -> JSONValue { .number(Double(n)) }
  public static func int(_ n: Int64) -> JSONValue { .number(Double(n)) }
  /// An optional integer (null when nil).
  public static func int(_ n: Int?) -> JSONValue { n.map { .number(Double($0)) } ?? .null }
  public static func int(_ n: Int64?) -> JSONValue { n.map { .number(Double($0)) } ?? .null }
  /// An optional string (null when nil).
  public static func str(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
  /// An optional number (null when nil).
  public static func num(_ x: Double?) -> JSONValue { x.map(JSONValue.number) ?? .null }
}
