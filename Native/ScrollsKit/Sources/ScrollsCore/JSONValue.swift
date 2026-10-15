// OWNER: N0
// A JSON value with JavaScript semantics: numbers are IEEE doubles, objects are unordered maps whose keys, like every
// string, compare by code units.
// `JSONValue.parse` follows ECMA-262 JSON.parse; `CanonicalJSON.string` follows the reference's canonicalJson.

import Foundation

/// A JSON value as the reference engine sees it (`JSON.parse` output): every number is a `Double`, and strings and
/// object keys compare by UTF-16 code units as JavaScript's `===` does (Swift's String == would identify canonically
/// equivalent strings such as "é" and "e\u{301}").
public enum JSONValue: Sendable, Hashable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object(JSONObject)

  public static func == (a: JSONValue, b: JSONValue) -> Bool {
    switch (a, b) {
    case (.null, .null): true
    case (.bool(let x), .bool(let y)): x == y
    case (.number(let x), .number(let y)): x == y  // IEEE: NaN ≠ NaN, -0 == 0, as ===
    case (.string(let x), .string(let y)): x.utf8.elementsEqual(y.utf8)
    case (.array(let x), .array(let y)): x == y
    case (.object(let x), .object(let y)): x == y
    default: false
    }
  }

  public func hash(into h: inout Hasher) {
    switch self {
    case .null: h.combine(0)
    case .bool(let b): h.combine(1); h.combine(b)
    case .number(let n): h.combine(2); h.combine(n == 0 ? 0 : n)
    case .string(let s): h.combine(3); ExactKey(s).hash(into: &h)
    case .array(let a): h.combine(4); h.combine(a)
    case .object(let o): h.combine(5); h.combine(o)
    }
  }

  /// Codable goes through Foundation's String-keyed dictionary coding, so object keys are read and written verbatim
  /// (no key strategy, such as ScrollsJSON's snake_case conversion, touches them); Foundation's dictionary identifies
  /// canonically equivalent keys, which `JSONValue.parse` and `CanonicalJSON` keep apart.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null; return }
    if let b = try? c.decode(Bool.self) { self = .bool(b); return }
    if let n = try? c.decode(Double.self) { self = .number(n); return }
    if let s = try? c.decode(String.self) { self = .string(s); return }
    if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
    if let o = try? c.decode([String: JSONValue].self) { self = .object(JSONObject(o)); return }
    throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .null:
      var c = encoder.singleValueContainer()
      try c.encodeNil()
    case .bool(let b):
      var c = encoder.singleValueContainer()
      try c.encode(b)
    case .number(let n):
      var c = encoder.singleValueContainer()
      try c.encode(n)
    case .string(let s):
      var c = encoder.singleValueContainer()
      try c.encode(s)
    case .array(let a):
      var c = encoder.singleValueContainer()
      try c.encode(a)
    case .object(let o):
      var c = encoder.singleValueContainer()
      try c.encode(Dictionary(o.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first }))
    }
  }
}

/// A JSON object with JavaScript's key identity: two keys are the same key exactly when their UTF-16 code units are.
public struct JSONObject: Sendable, Hashable, Sequence, ExpressibleByDictionaryLiteral {
  private var storage: [ExactKey: JSONValue]

  public init() { storage = [:] }

  /// From key/value pairs; a repeated key keeps the last value (JSON.parse, object literals).
  public init<S: Sequence>(_ pairs: S) where S.Element == (String, JSONValue) {
    storage = [:]
    for (k, v) in pairs { storage[ExactKey(k)] = v }
  }

  /// From a Swift dictionary (whose keys are already unique up to canonical equivalence).
  public init(_ dictionary: [String: JSONValue]) { self.init(dictionary.map { ($0.key, $0.value) }) }

  public init(dictionaryLiteral elements: (String, JSONValue)...) { self.init(elements) }

  /// The member named `key` (code-unit equality); assigning nil removes it.
  public subscript(key: String) -> JSONValue? {
    get { storage[ExactKey(key)] }
    set { storage[ExactKey(key)] = newValue }
  }

  public var keys: [String] { storage.keys.map(\.string) }
  public var values: [JSONValue] { Array(storage.values) }
  public var count: Int { storage.count }
  public var isEmpty: Bool { storage.isEmpty }

  public func makeIterator() -> some IteratorProtocol<(key: String, value: JSONValue)> {
    storage.lazy.map { (key: $0.key.string, value: $0.value) }.makeIterator()
  }

  public func mapValues(_ transform: (JSONValue) throws -> JSONValue) rethrows -> JSONObject {
    var o = JSONObject()
    o.storage = try storage.mapValues(transform)
    return o
  }
}

/// A string key with JavaScript equality: the same UTF-8 (equivalently UTF-16) code units.
struct ExactKey: Hashable, Sendable {
  let string: String
  init(_ s: String) { string = s }
  static func == (a: ExactKey, b: ExactKey) -> Bool { a.string.utf8.elementsEqual(b.string.utf8) }
  func hash(into h: inout Hasher) {
    var s = string
    s.withUTF8 { h.combine(bytes: UnsafeRawBufferPointer($0)) }
  }
}

// MARK: - Accessors

extension JSONValue {
  /// The member `key` of an object, or `nil` (also for non-objects), like `obj?.[key]` in JavaScript.
  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  /// The element at `index` of an array, or `nil`.
  public subscript(index: Int) -> JSONValue? {
    if case .array(let a) = self, a.indices.contains(index) { return a[index] }
    return nil
  }

  public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
  public var numberValue: Double? { if case .number(let n) = self { return n } else { return nil } }
  public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
  public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
  public var objectValue: JSONObject? { if case .object(let o) = self { return o } else { return nil } }
  public var isNull: Bool { if case .null = self { return true } else { return false } }

  /// The number as an `Int` when it is a safe integer (`Number.isSafeInteger`), else `nil`.
  public var safeInteger: Int? {
    guard case .number(let n) = self, n.rounded(.towardZero) == n, abs(n) <= 9_007_199_254_740_991 else { return nil }
    return Int(n)
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral,
  ExpressibleByIntegerLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(JSONObject(elements)) }
  public init(nilLiteral: ()) { self = .null }
}

// MARK: - Parsing (ECMA-262 JSON.parse)

/// Why `JSONValue.parse` rejected its input; `offset` is a UTF-8 byte offset.
public struct JSONParseError: Error, Sendable, Equatable, CustomStringConvertible {
  public let offset: Int
  public let message: String
  public var description: String { "JSON parse error at byte \(offset): \(message)" }
}

extension JSONValue {
  /// Parses RFC 8259 JSON with `JSON.parse` semantics: duplicate keys keep the last value, numbers are rounded
  /// to the nearest double (overflow becomes ±infinity, as in JavaScript), `-0` stays negative zero.
  /// A lone surrogate escape (`"\ud800"`), which a Swift `String` cannot hold, becomes U+FFFD.
  public static func parse(_ text: String) throws(JSONParseError) -> JSONValue {
    var copy = text
    return try copy.withUTF8 { (bytes) throws(JSONParseError) -> JSONValue in
      var p = JSONParser(bytes)
      return try p.document()
    }
  }

  /// Parses UTF-8 JSON bytes (see `parse(_:)`).
  public static func parse(_ data: Data) throws(JSONParseError) -> JSONValue {
    try data.withUnsafeBytes { (raw) throws(JSONParseError) -> JSONValue in
      var p = JSONParser(raw.bindMemory(to: UInt8.self))
      return try p.document()
    }
  }
}

private struct JSONParser {
  let b: UnsafeBufferPointer<UInt8>
  var i = 0
  init(_ b: UnsafeBufferPointer<UInt8>) { self.b = b }

  func fail(_ m: String) -> JSONParseError { JSONParseError(offset: i, message: m) }

  mutating func ws() {
    while i < b.count, b[i] == 0x20 || b[i] == 0x0A || b[i] == 0x0D || b[i] == 0x09 { i += 1 }
  }

  mutating func document() throws(JSONParseError) -> JSONValue {
    if b.count >= 3, b[0] == 0xEF, b[1] == 0xBB, b[2] == 0xBF { throw fail("byte order mark") }
    ws()
    let v = try value(depth: 0)
    ws()
    if i != b.count { throw fail("unexpected trailing characters") }
    return v
  }

  mutating func value(depth: Int) throws(JSONParseError) -> JSONValue {
    guard depth < 4096 else { throw fail("nesting too deep") }
    guard i < b.count else { throw fail("unexpected end of input") }
    switch b[i] {
    case UInt8(ascii: "{"):
      i += 1
      var o = JSONObject()
      ws()
      if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
      while true {
        ws()
        guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw fail("expected a string key") }
        let k = try string()
        ws()
        guard i < b.count, b[i] == UInt8(ascii: ":") else { throw fail("expected ':'") }
        i += 1
        ws()
        o[k] = try value(depth: depth + 1)
        ws()
        guard i < b.count else { throw fail("unterminated object") }
        if b[i] == UInt8(ascii: ",") { i += 1; continue }
        if b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
        throw fail("expected ',' or '}'")
      }
    case UInt8(ascii: "["):
      i += 1
      var a: [JSONValue] = []
      ws()
      if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
      while true {
        ws()
        a.append(try value(depth: depth + 1))
        ws()
        guard i < b.count else { throw fail("unterminated array") }
        if b[i] == UInt8(ascii: ",") { i += 1; continue }
        if b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
        throw fail("expected ',' or ']'")
      }
    case UInt8(ascii: "\""):
      return .string(try string())
    case UInt8(ascii: "t"): try literal("true"); return .bool(true)
    case UInt8(ascii: "f"): try literal("false"); return .bool(false)
    case UInt8(ascii: "n"): try literal("null"); return .null
    default:
      return .number(try number())
    }
  }

  mutating func literal(_ word: StaticString) throws(JSONParseError) {
    let n = word.utf8CodeUnitCount
    guard i + n <= b.count else { throw fail("unexpected end of input") }
    for k in 0..<n where b[i + k] != word.utf8Start[k] { throw fail("invalid literal") }
    i += n
  }

  mutating func number() throws(JSONParseError) -> Double {
    let start = i
    if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
    guard i < b.count, isDigit(b[i]) else { throw fail("invalid number") }
    if b[i] == UInt8(ascii: "0") { i += 1 } else { while i < b.count, isDigit(b[i]) { i += 1 } }
    if i < b.count, b[i] == UInt8(ascii: ".") {
      i += 1
      guard i < b.count, isDigit(b[i]) else { throw fail("invalid fraction") }
      while i < b.count, isDigit(b[i]) { i += 1 }
    }
    if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
      i += 1
      if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
      guard i < b.count, isDigit(b[i]) else { throw fail("invalid exponent") }
      while i < b.count, isDigit(b[i]) { i += 1 }
    }
    let text = String(decoding: UnsafeBufferPointer(rebasing: b[start..<i]), as: UTF8.self)
    // Double(String) rounds correctly (strtod) and yields ±infinity on overflow, as StringToNumber does.
    guard let d = Double(text) else { throw fail("invalid number") }
    return d
  }

  func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

  mutating func string() throws(JSONParseError) -> String {
    i += 1  // opening quote
    var units: [UInt16] = []
    var runStart = i
    var plain = true  // no escapes so far: decode the bytes directly
    func hex(_ c: UInt8) -> UInt16? {
      switch c {
      case 0x30...0x39: UInt16(c - 0x30)
      case 0x41...0x46: UInt16(c - 0x41 + 10)
      case 0x61...0x66: UInt16(c - 0x61 + 10)
      default: nil
      }
    }
    while i < b.count {
      let c = b[i]
      if c == UInt8(ascii: "\"") {
        if plain {
          let s = String(decoding: UnsafeBufferPointer(rebasing: b[runStart..<i]), as: UTF8.self)
          i += 1
          return s
        }
        units.append(contentsOf: String(decoding: UnsafeBufferPointer(rebasing: b[runStart..<i]), as: UTF8.self).utf16)
        i += 1
        return String(decoding: units, as: UTF16.self)
      }
      if c < 0x20 { throw fail("control character in string") }
      if c == UInt8(ascii: "\\") {
        units.append(contentsOf: String(decoding: UnsafeBufferPointer(rebasing: b[runStart..<i]), as: UTF8.self).utf16)
        plain = false
        i += 1
        guard i < b.count else { throw fail("unterminated escape") }
        switch b[i] {
        case UInt8(ascii: "\""): units.append(0x22)
        case UInt8(ascii: "\\"): units.append(0x5C)
        case UInt8(ascii: "/"): units.append(0x2F)
        case UInt8(ascii: "b"): units.append(0x08)
        case UInt8(ascii: "f"): units.append(0x0C)
        case UInt8(ascii: "n"): units.append(0x0A)
        case UInt8(ascii: "r"): units.append(0x0D)
        case UInt8(ascii: "t"): units.append(0x09)
        case UInt8(ascii: "u"):
          guard i + 4 < b.count, let h0 = hex(b[i + 1]), let h1 = hex(b[i + 2]), let h2 = hex(b[i + 3]),
            let h3 = hex(b[i + 4])
          else { throw fail("invalid \\u escape") }
          units.append(h0 << 12 | h1 << 8 | h2 << 4 | h3)
          i += 4
        default: throw fail("invalid escape")
        }
        i += 1
        runStart = i
        continue
      }
      i += 1
    }
    throw fail("unterminated string")
  }
}
