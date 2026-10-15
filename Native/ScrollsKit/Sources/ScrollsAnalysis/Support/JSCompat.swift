// OWNER: N4
// JavaScript semantics the analysis port needs to give the reference's numbers and orders exactly (IOS-SPEC §2.4):
// strings compared and hashed by UTF-16 code units (a JS Set/Map never merges canonically equivalent strings, a Swift
// Set does), insertion-ordered maps (a JS Map, and a JS object with its integer-like keys first), a stable sort
// (Array.prototype.sort is stable), and `Number(x.toFixed(d))` / `Number(x.toPrecision(p))` rounding.

import Foundation
import ScrollsCore

/// A string compared and hashed by its UTF-16 code units, as a JavaScript Set or Map key.
public struct JSKey: Hashable, Sendable, Comparable, CustomStringConvertible {
  public let string: String
  private let units: [UInt16]

  public init(_ s: String) {
    string = s
    units = Array(s.utf16)
  }

  public static func == (a: JSKey, b: JSKey) -> Bool { a.units == b.units }
  public func hash(into h: inout Hasher) { h.combine(units) }
  /// Code-unit order (JavaScript's `<` on strings).
  public static func < (a: JSKey, b: JSKey) -> Bool { a.units.lexicographicallyPrecedes(b.units) }
  public var description: String { string }
}

/// JavaScript's `a < b` on strings: UTF-16 code-unit order.
@inline(__always)
func jsLess(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }

/// JavaScript's `a === b` on strings.
@inline(__always)
func jsEqual(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

/// Whether a JavaScript object would treat `key` as an array index (those keys enumerate first, ascending).
func isArrayIndexKey(_ key: String) -> Bool {
  let u = Array(key.utf8)
  guard !u.isEmpty, u.count <= 10, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return false }
  if u.count > 1 && u[0] == 0x30 { return false }
  guard let v = UInt64(key) else { return false }
  return v < 4_294_967_295
}

/// An insertion-ordered map keyed by strings compared by code units: a JavaScript `Map`, or (with `objectOrder`) a plain
/// object, whose integer-like keys enumerate first in ascending order and the rest in insertion order.
public struct JSMap<Value>: Sequence {
  private var order: [JSKey] = []
  private var store: [JSKey: Value] = [:]
  public let objectOrder: Bool

  public init(objectOrder: Bool = false) { self.objectOrder = objectOrder }

  public subscript(key: String) -> Value? {
    get { store[JSKey(key)] }
    set {
      let k = JSKey(key)
      if let newValue {
        if store.updateValue(newValue, forKey: k) == nil { order.append(k) }
      } else if store.removeValue(forKey: k) != nil {
        order.removeAll { $0 == k }
      }
    }
  }

  /// Mutates the value of `key`, inserting `make()` first when absent.
  public mutating func update(_ key: String, default make: @autoclosure () -> Value, _ body: (inout Value) -> Void) {
    let k = JSKey(key)
    if store[k] == nil {
      store[k] = make()
      order.append(k)
    }
    body(&store[k]!)
  }

  public func has(_ key: String) -> Bool { store[JSKey(key)] != nil }
  public var count: Int { order.count }
  public var isEmpty: Bool { order.isEmpty }

  /// Keys in JavaScript enumeration order.
  public var keys: [String] {
    guard objectOrder else { return order.map(\.string) }
    let index = order.filter { isArrayIndexKey($0.string) }.sorted { UInt64($0.string)! < UInt64($1.string)! }
    return index.map(\.string) + order.filter { !isArrayIndexKey($0.string) }.map(\.string)
  }

  public var entries: [(key: String, value: Value)] { keys.map { ($0, store[JSKey($0)]!) } }
  public var values: [Value] { keys.map { store[JSKey($0)]! } }

  public func makeIterator() -> IndexingIterator<[(key: String, value: Value)]> { entries.makeIterator() }
}

/// An insertion-ordered set of strings compared by code units (a JavaScript `Set`).
public struct JSSet: Sequence {
  private var order: [JSKey] = []
  private var members: Set<JSKey> = []

  public init() {}
  public init<S: Sequence>(_ items: S) where S.Element == String { for s in items { insert(s) } }

  @discardableResult
  public mutating func insert(_ s: String) -> Bool {
    let k = JSKey(s)
    guard members.insert(k).inserted else { return false }
    order.append(k)
    return true
  }

  public func contains(_ s: String) -> Bool { members.contains(JSKey(s)) }
  public var count: Int { order.count }
  public var isEmpty: Bool { order.isEmpty }
  public var array: [String] { order.map(\.string) }
  /// Sorted as JavaScript's default `sort()` on strings (code units).
  public var sorted: [String] { order.sorted().map(\.string) }

  public func makeIterator() -> IndexingIterator<[String]> { array.makeIterator() }
}

extension Array {
  /// A stable sort (JavaScript's Array.prototype.sort is stable): `areInIncreasingOrder` is a strict weak order; equal
  /// elements keep their order.
  func stableSorted(by areInIncreasingOrder: (Element, Element) -> Bool) -> [Element] {
    enumerated().sorted { x, y in
      if areInIncreasingOrder(x.element, y.element) { return true }
      if areInIncreasingOrder(y.element, x.element) { return false }
      return x.offset < y.offset
    }.map(\.element)
  }

  /// A stable sort from a JavaScript comparator (negative: a before b).
  func jsSorted(_ compare: (Element, Element) -> Double) -> [Element] {
    stableSorted { compare($0, $1) < 0 }
  }
}

/// Number formatting as the reference rounds its payload numbers.
enum JSRound {
  /// `Number(x.toFixed(d))`.
  static func fixed(_ x: Double, _ d: Int) -> Double { JSNumber.parse(JSNumber.toFixed(x, d)) }
  /// `Number(x.toPrecision(p))`.
  static func precision(_ x: Double, _ p: Int) -> Double { JSNumber.parse(JSNumber.toPrecision(x, p)) }
  /// The compare module's `r4`: null stays null.
  static func r4(_ x: Double?) -> Double? { x.map { fixed($0, 4) } }
  static func r2(_ x: Double?) -> Double? { x.map { fixed($0, 2) } }
}

/// `Math.sign(a) * Math.sign(b) < 0` as JavaScript evaluates it (NaN never compares).
func jsSign(_ x: Double) -> Double { x > 0 ? 1 : x < 0 ? -1 : x }

/// `Math.min` / `Math.max` with JavaScript's NaN rule.
func jsMin(_ a: Double, _ b: Double) -> Double { a.isNaN || b.isNaN ? .nan : Swift.min(a, b) }
func jsMax(_ a: Double, _ b: Double) -> Double { a.isNaN || b.isNaN ? .nan : Swift.max(a, b) }

/// `Math.log2` with the reference's argument handling (V8 computes it with fdlibm; libm may differ in the last ulp,
/// within the §2.4 tolerance of the exact float paths).
@inline(__always) func jsLog2(_ x: Double) -> Double { Foundation.log2(x) }
/// `Math.log` (bit-identical with V8: ScrollsCore's fdlibm port).
@inline(__always) func jsLog(_ x: Double) -> Double { JSMath.log(x) }
/// `Math.exp` (libm; V8's fdlibm may differ in the last ulp).
@inline(__always) func jsExp(_ x: Double) -> Double { Foundation.exp(x) }
/// `a ** b` (libm pow).
@inline(__always) func jsPow(_ a: Double, _ b: Double) -> Double { Foundation.pow(a, b) }
