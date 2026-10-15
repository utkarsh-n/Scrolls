// OWNER: N3
// JavaScript string and regular-expression semantics the read path needs (IOS-SPEC §1.7): UTF-16 code-unit slicing,
// `\p{…}` class tests through the generated token-class table (Node's ICU, frozen with u61m-1), `\s` and the few
// normalisations the reference calls. Nothing here uses Swift's grapheme or canonical-equivalence string semantics.

import Foundation
import ScrollsCore

/// Code-unit and code-point helpers with JavaScript's meaning.
public enum JSText {
  // MARK: code units

  /// The UTF-16 code units of a string (the D4 offset space).
  @inline(__always)
  public static func units(_ s: String) -> [UInt16] { Array(s.utf16) }

  /// A string from code units (a lone surrogate becomes U+FFFD, as SQLite stores it).
  @inline(__always)
  public static func string(_ u: some Collection<UInt16>) -> String { String(decoding: u, as: UTF16.self) }

  /// `s.slice(a, b)` over code units, with JavaScript's negative indices and clamping.
  public static func slice(_ u: [UInt16], _ from: Int, _ to: Int? = nil) -> [UInt16] {
    let n = u.count
    func clamp(_ i: Int) -> Int { i < 0 ? max(0, n + i) : min(i, n) }
    let a = clamp(from), b = clamp(to ?? n)
    return a < b ? Array(u[a..<b]) : []
  }

  /// `s.slice(a, b)` of a string.
  public static func slice(_ s: String, _ from: Int, _ to: Int? = nil) -> String { string(slice(units(s), from, to)) }

  /// `s.endsWith(x)` by code units.
  public static func endsWith(_ s: String, _ x: String) -> Bool { JSString.hasSuffix(s, x) }

  /// Whether `s` ends with any of `xs`.
  public static func endsWithAny(_ s: String, _ xs: [String]) -> Bool { xs.contains { JSString.hasSuffix(s, $0) } }

  /// `s[i]` as a one-unit string ("" past the end), as JavaScript indexes strings.
  public static func charAt(_ s: String, _ i: Int) -> String {
    let u = units(s)
    guard i >= 0, i < u.count else { return "" }
    return string([u[i]])
  }

  /// `s.includes(x)` by code units.
  public static func includes(_ s: String, _ x: String) -> Bool { JSString.indexOf(s, x) >= 0 }

  // MARK: code points and classes

  /// The code points of a string (`[...s]`); lone surrogates cannot occur in a Swift string.
  @inline(__always)
  public static func codePoints(_ s: String) -> [UInt32] { s.unicodeScalars.map(\.value) }

  /// The classes of a code point as the reference's regular expressions see them.
  @inline(__always)
  public static func classes(_ cp: UInt32) -> UnicodeClass { TokenClassTable.classes(cp) }

  /// `/\p{X}/u.test(s)`: some code point has one of the classes.
  public static func any(_ s: String, _ c: UnicodeClass) -> Bool {
    s.unicodeScalars.contains { !TokenClassTable.classes($0.value).isDisjoint(with: c) }
  }

  /// `/^[\p{X}]+$/u.test(s)`: non-empty and every code point has one of the classes.
  public static func all(_ s: String, _ c: UnicodeClass) -> Bool {
    !s.isEmpty && s.unicodeScalars.allSatisfy { !TokenClassTable.classes($0.value).isDisjoint(with: c) }
  }

  /// `/^[\p{X}]/u.test(s)`: the first code point has one of the classes.
  public static func startsWithClass(_ s: String, _ c: UnicodeClass) -> Bool {
    guard let f = s.unicodeScalars.first else { return false }
    return !TokenClassTable.classes(f.value).isDisjoint(with: c)
  }

  /// Whether a code point lies in any of the inclusive ranges (a bracket class of code points).
  @inline(__always)
  public static func inRanges(_ cp: UInt32, _ ranges: [ClosedRange<UInt32>]) -> Bool { ranges.contains { $0.contains(cp) } }

  /// `/[a-b…]/u.test(s)` over code-point ranges.
  public static func anyInRanges(_ s: String, _ ranges: [ClosedRange<UInt32>]) -> Bool {
    s.unicodeScalars.contains { inRanges($0.value, ranges) }
  }

  /// JavaScript `\s` for a code point (WhiteSpace and LineTerminator).
  @inline(__always)
  public static func isSpace(_ cp: UInt32) -> Bool {
    if cp < 0x80 { return cp == 0x20 || (cp >= 0x09 && cp <= 0x0D) }
    return TokenClassTable.classes(cp).contains(.whitespace)
  }

  // MARK: normalisation

  /// `s.normalize('NFD')`.
  public static func nfd(_ s: String) -> String { (s as NSString).decomposedStringWithCanonicalMapping }
  /// `s.normalize('NFC')`.
  public static func nfc(_ s: String) -> String { (s as NSString).precomposedStringWithCanonicalMapping }

  /// `s.replace(/\p{M}/gu, '')`.
  public static func removeMarks(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for sc in s.unicodeScalars where !TokenClassTable.classes(sc.value).contains(.mark) { out.append(sc) }
    return String(out)
  }

  /// `s.replace(/\s+/g, ' ')`.
  public static func collapseSpaces(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    var inSpace = false
    for sc in s.unicodeScalars {
      if isSpace(sc.value) {
        if !inSpace { out.append(" ") }
        inSpace = true
      } else {
        out.append(sc)
        inSpace = false
      }
    }
    return String(out)
  }

  // MARK: comparisons

  /// `a.localeCompare(b, 'en')` as a sort predicate (ReferenceCollation).
  @inline(__always)
  public static func localeLess(_ a: String, _ b: String) -> Bool { ReferenceCollation.less(a, b) }

  /// `a.localeCompare(b, 'en')` as -1 / 0 / 1.
  public static func localeCompare(_ a: String, _ b: String) -> Int {
    switch ReferenceCollation.compare(a, b) {
    case .orderedAscending: -1
    case .orderedDescending: 1
    case .orderedSame: 0
    }
  }

  /// `a < b` on strings in JavaScript (code-unit order).
  @inline(__always)
  public static func less(_ a: String, _ b: String) -> Bool { CanonicalJSON.codeUnitLess(a, b) }

  /// A string as `String(x)` writes a JavaScript number.
  @inline(__always)
  public static func num(_ x: Double) -> String { JSNumber.format(x) }

  /// `JSON.stringify` of a value (keys in the order given: see `OrderedJSON`).
  public static func json(_ v: JSONValue) -> String { CanonicalJSON.string(v) }
}

/// A set of strings with JavaScript equality (code units), not Swift's canonical equivalence.
public struct JSStringSet: Sendable {
  private var storage: Set<[UInt16]> = []
  public init() {}
  public init<S: Sequence>(_ items: S) where S.Element == String { for s in items { insert(s) } }
  @discardableResult
  public mutating func insert(_ s: String) -> Bool { storage.insert(Array(s.utf16)).inserted }
  public func contains(_ s: String) -> Bool { storage.contains(Array(s.utf16)) }
  public var count: Int { storage.count }
  public var isEmpty: Bool { storage.isEmpty }
}

/// A key that compares strings by code units, for dictionaries that must behave like JavaScript Maps.
public struct JSKey: Hashable, Sendable, Comparable {
  public let units: [UInt16]
  public init(_ s: String) { units = Array(s.utf16) }
  public var string: String { String(decoding: units, as: UTF16.self) }
  public static func < (a: JSKey, b: JSKey) -> Bool { a.units.lexicographicallyPrecedes(b.units) }
}

/// An insertion-ordered dictionary (a JavaScript Map or object literal whose key order matters).
public struct OrderedDict<Key: Hashable, Value> {
  public private(set) var keys: [Key] = []
  private var storage: [Key: Value] = [:]
  public init() {}
  public subscript(key: Key) -> Value? {
    get { storage[key] }
    set {
      if let newValue {
        if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
      } else if storage.removeValue(forKey: key) != nil {
        keys.removeAll { $0 == key }
      }
    }
  }
  public subscript(key: Key, default d: @autoclosure () -> Value) -> Value {
    get { storage[key] ?? d() }
    set { self[key] = newValue }
  }
  public var values: [Value] { keys.map { storage[$0]! } }
  public var count: Int { keys.count }
  public var isEmpty: Bool { keys.isEmpty }
  public func contains(_ key: Key) -> Bool { storage[key] != nil }
  public var pairs: [(key: Key, value: Value)] { keys.map { ($0, storage[$0]!) } }
}

extension OrderedDict: Sendable where Key: Sendable, Value: Sendable {}
