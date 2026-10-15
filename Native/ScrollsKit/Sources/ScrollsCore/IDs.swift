// OWNER: N0
// Port of src/shared/ids.mjs: typed references, slugs, FNV-1a hashes and SHA-256. Canonical JSON lives in
// CanonicalJSON.swift and mulberry32 in Mulberry32.swift.

import CryptoKit
import Foundation

/// References, slugs and hashes shared by every engine module (SPEC §12.2).
public enum IDs {
  /// A parsed typed reference ('passage:901'): the id is a number when it is 1–15 ASCII digits, else a string.
  public enum RefID: Sendable, Hashable {
    case number(Int64)
    case string(String)
  }

  /// Why `ref` or `parseRef` refused its input (the reference throws a TypeError).
  public struct RefError: Error, Sendable, Equatable {
    public let message: String
    public init(message: String) { self.message = message }
  }

  /// `ref('passage', 901)` → `"passage:901"`. The type must match `^[a-z_][a-z0-9_-]*$`; the id must not be empty.
  public static func ref(_ type: String, _ id: String) throws(RefError) -> String {
    guard isRefType(type) else { throw RefError(message: "ref: invalid type '\(type)'") }
    guard !id.isEmpty else { throw RefError(message: "ref: missing id") }
    return "\(type):\(id)"
  }

  /// `ref(type, number)`.
  public static func ref(_ type: String, _ id: Int64) throws(RefError) -> String { try ref(type, String(id)) }

  /// `parseRef('passage:901')` → `("passage", .number(901))`. Only the first ':' separates, so etymon keys keep
  /// theirs ('etymon:sa:शून्य' → id 'sa:शून्य').
  public static func parseRef(_ s: String) throws(RefError) -> (type: String, id: RefID) {
    let u = Array(s.utf16)
    guard let colon = u.firstIndex(of: 0x3A), colon > 0 else { throw RefError(message: "parseRef: not a reference: '\(s)'") }
    let type = String(decoding: u[..<colon], as: UTF16.self)
    let idUnits = u[(colon + 1)...]
    guard isRefType(type), !idUnits.isEmpty else { throw RefError(message: "parseRef: not a reference: '\(s)'") }
    if idUnits.count <= 15, idUnits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) {
      return (type, .number(Int64(String(decoding: idUnits, as: UTF16.self))!))
    }
    return (type, .string(String(decoding: idUnits, as: UTF16.self)))
  }

  private static func isRefType(_ t: String) -> Bool {
    let u = Array(t.utf8)
    guard let first = u.first, (first >= 0x61 && first <= 0x7A) || first == 0x5F else { return false }
    return u.dropFirst().allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x5F || $0 == 0x2D }
  }

  /// `slugify(s, max)`: a URL-safe slug that keeps letters of every script ('ગણિત પોથી' → 'ગણિત-પોથી'), drops
  /// Latin accents, and cuts at a '-' boundary when longer than `max` UTF-16 units; 'untitled' when nothing is left.
  /// A cut through a surrogate pair leaves U+FFFD where JavaScript would leave a lone surrogate.
  public static func slug(_ s: String, max: Int = 48) -> String {
    let nfkd = (s as NSString).decomposedStringWithCompatibilityMapping
    let stripped = String(String.UnicodeScalarView(nfkd.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
    let lower = JSString.toLowerCase((stripped as NSString).precomposedStringWithCanonicalMapping)
    // drop apostrophes, then collapse every run of non-[\p{L}\p{M}\p{N}] code points into one '-'
    var units: [UInt16] = []
    var inRun = false
    for scalar in lower.unicodeScalars where scalar.value != 0x27 && scalar.value != 0x2019 {
      if TokenClassTable.classes(scalar.value).isDisjoint(with: [.letter, .mark, .number]) {
        if !inRun { units.append(0x2D); inRun = true }
      } else {
        units.append(contentsOf: String(scalar).utf16)
        inRun = false
      }
    }
    while units.first == 0x2D { units.removeFirst() }
    while units.last == 0x2D { units.removeLast() }
    if units.count > max {
      let cut = Array(units[0..<max])
      let at = cut.lastIndex(of: 0x2D) ?? -1
      units = 2 * at >= max ? Array(cut[0..<at]) : cut  // `at >= max / 2` in real division
      while units.last == 0x2D { units.removeLast() }
    }
    return units.isEmpty ? "untitled" : String(decoding: units, as: UTF16.self)
  }

  private static let fnvOffset: UInt32 = 0x811C_9DC5
  private static let fnvPrime: UInt32 = 0x0100_0193

  /// FNV-1a 32-bit over the UTF-8 bytes of `s` (a Swift string has no lone surrogates, so this equals the
  /// reference's code-point walk).
  public static func fnv1a32(_ s: String) -> UInt32 {
    var h = fnvOffset
    for b in s.utf8 { h = (h ^ UInt32(b)) &* fnvPrime }
    return h
  }

  /// FNV-1a 32-bit over raw bytes.
  public static func fnv1a32<Bytes: Sequence>(bytes: Bytes) -> UInt32 where Bytes.Element == UInt8 {
    var h = fnvOffset
    for b in bytes { h = (h ^ UInt32(b)) &* fnvPrime }
    return h
  }

  /// `fnv1a32U32(arr, start, end)`: FNV-1a over the little-endian bytes of `values[range]` (winnowing shingles).
  public static func fnv1a32(u32 values: UnsafeBufferPointer<UInt32>, _ range: Range<Int>) -> UInt32 {
    var h = fnvOffset
    for i in range {
      let v = values[i]
      h = (h ^ (v & 255)) &* fnvPrime
      h = (h ^ ((v >> 8) & 255)) &* fnvPrime
      h = (h ^ ((v >> 16) & 255)) &* fnvPrime
      h = (h ^ (v >> 24)) &* fnvPrime
    }
    return h
  }

  /// `shortHash(s, n)`: `length` (1–16) lowercase hex digits of FNV-1a (not cryptographic).
  public static func shortHash(_ s: String, length: Int = 4) -> String {
    precondition((1...16).contains(length), "shortHash: n must be 1–16")
    let a = hex8(fnv1a32(s))
    if length <= 8 { return String(a.prefix(length)) }
    let b = hex8(fnv1a32("\u{1}" + s))
    return String((a + b).prefix(length))
  }

  /// SHA-256 of the UTF-8 bytes of `s`, lowercase hex (`sha256Hex`).
  public static func sha256Hex(_ s: String) -> String { sha256Hex(bytes: Data(s.utf8)) }

  /// SHA-256 of bytes, lowercase hex.
  public static func sha256Hex(bytes: Data) -> String {
    SHA256.hash(data: bytes).map { b in
      let h = String(b, radix: 16)
      return h.count == 1 ? "0" + h : h
    }.joined()
  }

  private static func hex8(_ v: UInt32) -> String {
    let h = String(v, radix: 16)
    return String(repeating: "0", count: 8 - h.count) + h
  }
}
