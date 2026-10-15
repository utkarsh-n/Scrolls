// OWNER: N1
// JavaScript values as the import formats see them (server/ingest/*.mjs work on `JSON.parse` results and plain objects):
// `JSValue` keeps an object's property order exactly as JavaScript does (array-index keys first in ascending order, then
// string keys in insertion order; a repeated key keeps its first position and its last value), because the reference's
// column lists, `Object.values(record)[n]` and sample rows depend on it, and keys compare by UTF-16 code units (`===`).
// `JSONParser` is `JSON.parse` with V8's error messages and positions (the E_JSON_PARSE issues quote them; golden
// g1.formats pins them). `JSText.stringify` is `JSON.stringify`.

import Foundation
import ScrollsCore

/// A key with JavaScript equality (the same UTF-16 code units).
public struct UnitKey: Hashable, Sendable {
  public let units: [UInt16]
  public init(_ s: String) { units = Array(s.utf16) }
  public var string: String { String(decoding: units, as: UTF16.self) }
}

/// A JavaScript object (ordered properties).
public struct JSObject: Sendable, Equatable {
  private var order: [UnitKey] = []
  private var store: [UnitKey: JSValue] = [:]

  public init() {}
  public init(_ pairs: [(String, JSValue)]) { for (k, v) in pairs { self[k] = v } }

  /// `Object.keys(o)`: array-index keys ascending, then the others in insertion order.
  public var keys: [String] {
    let idx = order.compactMap { k -> (UInt32, UnitKey)? in JSObject.arrayIndex(k).map { ($0, k) } }.sorted { $0.0 < $1.0 }.map(\.1)
    let rest = order.filter { JSObject.arrayIndex($0) == nil }
    return (idx + rest).map(\.string)
  }

  public var count: Int { order.count }
  public var isEmpty: Bool { order.isEmpty }
  public var entries: [(key: String, value: JSValue)] { keys.map { ($0, store[UnitKey($0)]!) } }
  public var values: [JSValue] { entries.map(\.value) }

  public subscript(key: String) -> JSValue? {
    get { store[UnitKey(key)] }
    set {
      let k = UnitKey(key)
      if let v = newValue {
        if store[k] == nil { order.append(k) }
        store[k] = v
      } else if store[k] != nil {
        store[k] = nil
        order.removeAll { $0 == k }
      }
    }
  }

  public func has(_ key: String) -> Bool { store[UnitKey(key)] != nil }

  /// A canonical numeric string below 2³² − 1 ('0', '17'; not '017' or '-1').
  static func arrayIndex(_ k: UnitKey) -> UInt32? {
    let u = k.units
    guard !u.isEmpty, u.count <= 10, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
    if u.count > 1 && u[0] == 0x30 { return nil }
    guard let n = UInt64(String(decoding: u, as: UTF16.self)), n < 4_294_967_295 else { return nil }
    return UInt32(n)
  }

  public static func == (a: JSObject, b: JSObject) -> Bool { a.keys == b.keys && a.store == b.store }
}

/// A JavaScript value from `JSON.parse` (or built by a parser).
public indirect enum JSValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSValue])
  case object(JSObject)

  public var stringValue: String? { if case .string(let s) = self { s } else { nil } }
  public var objectValue: JSObject? { if case .object(let o) = self { o } else { nil } }
  public var arrayValue: [JSValue]? { if case .array(let a) = self { a } else { nil } }
  public var numberValue: Double? { if case .number(let n) = self { n } else { nil } }
  public var isNull: Bool { if case .null = self { true } else { false } }
  public var isPlainObject: Bool { objectValue != nil }

  public subscript(key: String) -> JSValue? { objectValue?[key] }

  /// The value as an (unordered) `JSONValue` (original_meta, sample rows).
  public var json: JSONValue {
    switch self {
    case .null: .null
    case .bool(let b): .bool(b)
    case .number(let n): .number(n)
    case .string(let s): .string(s)
    case .array(let a): .array(a.map(\.json))
    case .object(let o): .object(JSONObject(o.entries.map { ($0.key, $0.value.json) }))
    }
  }

  /// From a `JSONValue` (keys in code-unit order, as `JSONValue` keeps none).
  public init(_ v: JSONValue) {
    switch v {
    case .null: self = .null
    case .bool(let b): self = .bool(b)
    case .number(let n): self = .number(n)
    case .string(let s): self = .string(s)
    case .array(let a): self = .array(a.map(JSValue.init))
    case .object(let o): self = .object(JSObject(o.keys.sorted(by: CanonicalJSON.codeUnitLess).map { ($0, JSValue(o[$0]!)) }))
    }
  }
}

/// `JSON.stringify` and JavaScript's `String(x)`.
public enum JSText {
  /// `JSON.stringify(v)` of a `JSONValue`: keys in code-unit order (a `JSONValue` keeps no insertion order; every reader
  /// of these columns parses them), numbers as Number::toString, non-finite numbers as null.
  public static func stringify(_ v: JSONValue) -> String { CanonicalJSON.string(v) }

  /// `JSON.stringify(v)` of a JavaScript value, keys in property order.
  public static func stringify(_ v: JSValue) -> String {
    var out: [UInt16] = []
    write(v, &out)
    return String(decoding: out, as: UTF16.self)
  }

  static func write(_ v: JSValue, _ out: inout [UInt16]) {
    switch v {
    case .null: out += "null".utf16
    case .bool(let b): out += (b ? "true" : "false").utf16
    case .number(let n): out += (n.isFinite ? JSNumber.format(n) : "null").utf16
    case .string(let s): out += CanonicalJSON.quote(s).utf16
    case .array(let a):
      out.append(0x5B)
      for (k, x) in a.enumerated() {
        if k > 0 { out.append(0x2C) }
        write(x, &out)
      }
      out.append(0x5D)
    case .object(let o):
      out.append(0x7B)
      for (k, e) in o.entries.enumerated() {
        if k > 0 { out.append(0x2C) }
        out += CanonicalJSON.quote(e.key).utf16
        out.append(0x3A)
        write(e.value, &out)
      }
      out.append(0x7D)
    }
  }

  /// JavaScript `String(v)` of a parsed value (arrays join with ',', objects print '[object Object]').
  public static func string(_ v: JSValue) -> String {
    switch v {
    case .null: "null"
    case .bool(let b): b ? "true" : "false"
    case .number(let n): JSNumber.format(n)
    case .string(let s): s
    case .array(let a): a.map { $0.isNull ? "" : string($0) }.joined(separator: ",")
    case .object: "[object Object]"
    }
  }
}

/// A `JSON.parse` SyntaxError: V8's message text.
public struct JSONSyntaxError: Error, Sendable, Equatable {
  public let message: String
}

/// `JSON.parse` over UTF-16 code units, with V8's error messages (Node 26).
public struct JSONParser {
  let u: [UInt16]
  var i = 0

  public init(_ text: String) { u = Array(text.utf16) }
  public init(units: [UInt16]) { u = units }

  /// Parses the whole text or throws V8's SyntaxError message.
  public static func parse(_ text: String) throws(JSONSyntaxError) -> JSValue {
    var p = JSONParser(text)
    return try p.document()
  }

  static let special: Set<String> = ["undefined", "NaN", "Infinity", "[object Object]"]

  mutating func document() throws(JSONSyntaxError) -> JSValue {
    ws()
    let v = try value()
    ws()
    if i < u.count { throw at("Unexpected non-whitespace character after JSON", i) }
    return v
  }

  mutating func ws() {
    while i < u.count, u[i] == 0x20 || u[i] == 0x09 || u[i] == 0x0A || u[i] == 0x0D { i += 1 }
  }

  /// "<message> in JSON at position p (line l column c)" (V8 counts \r\n as one line break, a lone \r as one).
  func at(_ m: String, _ p: Int) -> JSONSyntaxError {
    var line = 1, lastBreak = 0, k = 0
    while k < p {
      if u[k] == 0x0D, k < p - 1, u[k + 1] == 0x0A { k += 1 }
      if u[k] == 0x0D || u[k] == 0x0A {
        line += 1
        lastBreak = k + 1
      }
      k += 1
    }
    return JSONSyntaxError(message: "\(m) in JSON at position \(p) (line \(line) column \(1 + p - lastBreak))")
  }

  func endOfInput() -> JSONSyntaxError { JSONSyntaxError(message: "Unexpected end of JSON input") }

  /// An unexpected character (or the end of input) where a value or literal character was expected.
  func unexpected(_ p: Int) -> JSONSyntaxError {
    if p >= u.count { return endOfInput() }
    let src = String(decoding: u, as: UTF16.self)
    if JSONParser.special.contains(src) { return JSONSyntaxError(message: "\"\(src)\" is not valid JSON") }
    let ch = String(decoding: [u[p]], as: UTF16.self)
    return JSONSyntaxError(message: "Unexpected token '\(ch)', \(context(p)) is not valid JSON")
  }

  /// V8's context string of an unexpected token (the reference strips it; kept for fidelity).
  func context(_ p: Int) -> String {
    let n = u.count, k = 10
    func s(_ a: Int, _ b: Int) -> String { String(decoding: u[max(0, a)..<min(n, b)], as: UTF16.self) }
    if n < 2 * k + 1 { return "\"\(s(0, n))\"" }
    if p < k { return "\"\(s(0, p + k))\"..." }
    if p < n - k { return "...\"\(s(p - k, p + k))\"..." }
    return "...\"\(s(p - k, n))\""
  }

  mutating func value() throws(JSONSyntaxError) -> JSValue {
    guard i < u.count else { throw endOfInput() }
    switch u[i] {
    case 0x7B: return try object()
    case 0x5B: return try array()
    case 0x22: return .string(try string())
    case 0x2D, 0x30...0x39: return .number(try number())
    case 0x74: try literal("true"); return .bool(true)
    case 0x66: try literal("false"); return .bool(false)
    case 0x6E: try literal("null"); return .null
    default: throw unexpected(i)
    }
  }

  mutating func literal(_ word: String) throws(JSONSyntaxError) {
    for w in word.utf16 {
      guard i < u.count else { throw endOfInput() }
      guard u[i] == w else { throw unexpected(i) }
      i += 1
    }
  }

  mutating func object() throws(JSONSyntaxError) -> JSValue {
    i += 1
    var o = JSObject()
    ws()
    if i < u.count, u[i] == 0x7D {
      i += 1
      return .object(o)
    }
    guard i < u.count, u[i] == 0x22 else { throw at("Expected property name or '}'", i) }
    while true {
      let key = try string()
      ws()
      guard i < u.count, u[i] == 0x3A else { throw at("Expected ':' after property name", i) }
      i += 1
      ws()
      o[key] = try value()
      ws()
      if i < u.count, u[i] == 0x2C {
        i += 1
        ws()
        guard i < u.count, u[i] == 0x22 else { throw at("Expected double-quoted property name", i) }
        continue
      }
      if i < u.count, u[i] == 0x7D {
        i += 1
        return .object(o)
      }
      throw at("Expected ',' or '}' after property value", i)
    }
  }

  mutating func array() throws(JSONSyntaxError) -> JSValue {
    i += 1
    var a: [JSValue] = []
    ws()
    if i < u.count, u[i] == 0x5D {
      i += 1
      return .array(a)
    }
    while true {
      ws()
      a.append(try value())
      ws()
      if i < u.count, u[i] == 0x2C {
        i += 1
        continue
      }
      if i < u.count, u[i] == 0x5D {
        i += 1
        return .array(a)
      }
      throw at("Expected ',' or ']' after array element", i)
    }
  }

  mutating func string() throws(JSONSyntaxError) -> String {
    i += 1
    var out: [UInt16] = []
    while true {
      guard i < u.count else { throw at("Unterminated string", i) }
      let c = u[i]
      if c == 0x22 {
        i += 1
        return String(decoding: out, as: UTF16.self)
      }
      if c < 0x20 { throw at("Bad control character in string literal", i) }
      if c == 0x5C {
        guard i + 1 < u.count else { throw endOfInput() }
        let e = u[i + 1]
        switch e {
        case 0x22: out.append(0x22)
        case 0x5C: out.append(0x5C)
        case 0x2F: out.append(0x2F)
        case 0x62: out.append(0x08)
        case 0x66: out.append(0x0C)
        case 0x6E: out.append(0x0A)
        case 0x72: out.append(0x0D)
        case 0x74: out.append(0x09)
        case 0x75:
          var v: UInt16 = 0
          for k in 0..<4 {
            let p = i + 2 + k
            guard p < u.count, let d = JSONParser.hex(u[p]) else { throw at("Bad Unicode escape", p) }
            v = v << 4 | d
          }
          out.append(v)
          i += 6
          continue
        default: throw at("Bad escaped character", i + 1)
        }
        i += 2
        continue
      }
      out.append(c)
      i += 1
    }
  }

  static func hex(_ c: UInt16) -> UInt16? {
    switch c {
    case 0x30...0x39: c - 0x30
    case 0x41...0x46: c - 0x41 + 10
    case 0x61...0x66: c - 0x61 + 10
    default: nil
    }
  }

  mutating func number() throws(JSONSyntaxError) -> Double {
    let start = i
    func digit(_ p: Int) -> Bool { p < u.count && u[p] >= 0x30 && u[p] <= 0x39 }
    if u[i] == 0x2D {
      i += 1
      guard digit(i) else { throw at("No number after minus sign", i) }
    }
    if u[i] == 0x30 {
      i += 1
      if digit(i) { throw at("Unexpected number", i) }
    } else {
      while digit(i) { i += 1 }
    }
    if i < u.count, u[i] == 0x2E {
      i += 1
      guard digit(i) else { throw at("Unterminated fractional number", i) }
      while digit(i) { i += 1 }
    }
    if i < u.count, u[i] == 0x65 || u[i] == 0x45 {
      i += 1
      if i < u.count, u[i] == 0x2B || u[i] == 0x2D { i += 1 }
      guard digit(i) else { throw at("Exponent part is missing a number", i) }
      while digit(i) { i += 1 }
    }
    let s = String(decoding: u[start..<i], as: UTF16.self)
    return Double(s) ?? (s.hasPrefix("-") ? -.infinity : .infinity)
  }
}
