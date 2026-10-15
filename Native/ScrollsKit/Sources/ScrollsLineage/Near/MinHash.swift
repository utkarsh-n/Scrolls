// OWNER: N5
// Port of server/lineage/minhash.mjs (SPEC §4.7): near quotations. Units are sentences (verse lines in verse passages)
// of ≥ 6 tokens; MinHash with 128 permutations over word 3-shingles; LSH with 32 bands × 4 rows (collision threshold
// ≈ 0.42). Permutations come from the bit-exact mulberry32 (seed 42), so signatures and band keys equal the
// reference's (G1 `g1.minhash`, exact). Candidates are verified by token Smith–Waterman (Align) and 3-shingle Jaccard.

import Foundation
import ScrollsCore
import Synchronization

/// MinHash signatures, LSH band keys and near-quote units (`minhash.mjs`).
public enum MinHash {
  public static let perms = 128
  public static let bands = 32
  public static let rows = 4
  /// Shortest unit (tokens) considered for near quotations.
  public static let minUnitTokens = 6
  /// The permutation seed of the reference (`seed = 42`).
  public static let seed: UInt32 = 42

  /// The (a, b) of each permutation `v = a·h + b mod 2³²` (a is odd).
  public struct Permutations: Sendable {
    public let a: [UInt32]
    public let b: [UInt32]
  }

  private static let cache = Mutex<[String: Permutations]>([:])

  /// `permutations(perms, seed)`: a = (⌊r·(2³² − 1)⌋ | 1), b = ⌊r·(2³² − 1)⌋ from one mulberry32 stream, a before b.
  public static func permutations(perms: Int = MinHash.perms, seed: UInt32 = MinHash.seed) -> Permutations {
    let key = "\(perms):\(seed)"
    if let p = cache.withLock({ $0[key] }) { return p }
    var rnd = Mulberry32(seed: seed)
    var a = [UInt32](repeating: 0, count: perms)
    var b = [UInt32](repeating: 0, count: perms)
    for i in 0..<perms {
      a[i] = UInt32((rnd.next() * 4_294_967_295).rounded(.down)) | 1
      b[i] = UInt32((rnd.next() * 4_294_967_295).rounded(.down))
    }
    let p = Permutations(a: a, b: b)
    cache.withLock { $0[key] = p }
    return p
  }

  /// `shingles3(ids)`: the distinct hashes of the word 3-shingles of a token-id sequence, in first-seen order (a
  /// sequence shorter than 3 gives its single shingle).
  public static func shingles3(_ ids: [UInt32]) -> [UInt32] {
    ids.withUnsafeBufferPointer { shingles3($0) }
  }

  /// `shingles3` over a buffer.
  public static func shingles3(_ ids: UnsafeBufferPointer<UInt32>) -> [UInt32] {
    let n = ids.count
    guard n > 0 else { return [] }
    let last = max(1, n - 2)
    var seen = Set<UInt32>(minimumCapacity: last)
    var out: [UInt32] = []
    out.reserveCapacity(last)
    for i in 0..<last {
      var h: UInt32 = 0x811c_9dc5
      for j in i..<min(n, i + 3) { h = (h ^ ids[j]) &* 0x0100_0193 }
      if seen.insert(h).inserted { out.append(h) }
    }
    return out
  }

  /// `jaccard(a, b)` of two shingle sets (0 when both are empty). As the reference, `b` is counted with its
  /// multiplicity (callers pass distinct hashes).
  public static func jaccard(_ a: [UInt32], _ b: [UInt32]) -> Double {
    if a.isEmpty && b.isEmpty { return 0 }
    let sa = Set(a)
    var inter = 0
    for x in b where sa.contains(x) { inter += 1 }
    return Double(inter) / Double(sa.count + b.count - inter)
  }

  /// `minhash(shingles)`: the signature over shingle hashes.
  public static func signature(_ shingles: [UInt32], perms: Int = MinHash.perms, seed: UInt32 = MinHash.seed) -> [UInt32] {
    let p = permutations(perms: perms, seed: seed)
    var sig = [UInt32](repeating: 0xffff_ffff, count: perms)
    p.a.withUnsafeBufferPointer { a in
      p.b.withUnsafeBufferPointer { b in
        sig.withUnsafeMutableBufferPointer { sig in
          for h in shingles {
            for q in 0..<perms {
              let v = (a[q] &* h) &+ b[q]
              if v < sig[q] { sig[q] = v }
            }
          }
        }
      }
    }
    return sig
  }

  /// `minhash(strings)`: string shingles are first hashed with FNV-1a over their UTF-16 code units (the reference's
  /// `charCodeAt`), not their UTF-8.
  public static func signature(strings: [String], perms: Int = MinHash.perms, seed: UInt32 = MinHash.seed) -> [UInt32] {
    signature(strings.map(stringHash), perms: perms, seed: seed)
  }

  /// FNV-1a-32 over the UTF-16 code units of `s` (minhash.mjs's string shingle hash).
  public static func stringHash(_ s: String) -> UInt32 {
    var h: UInt32 = 0x811c_9dc5
    for u in s.utf16 { h = (h ^ UInt32(u)) &* 0x0100_0193 }
    return h
  }

  /// `lshBands(signature)`: one u32 per band (FNV-1a over the band index and its rows).
  public static func lshBands(_ signature: [UInt32], bands: Int = MinHash.bands, rows: Int = MinHash.rows) -> [UInt32] {
    var out = [UInt32](repeating: 0, count: bands)
    for band in 0..<bands {
      var h = (0x811c_9dc5 ^ UInt32(truncatingIfNeeded: band)) &* 0x0100_0193
      for r in 0..<rows { h = (h ^ signature[band * rows + r]) &* 0x0100_0193 }
      out[band] = h
    }
    return out
  }

  /// `bandKeysRange(shingles, band0, band1)`: the band keys of bands [band0, band1) straight from shingle hashes,
  /// equal to `lshBands(signature(shingles))[band0..<band1]`; lets a large index compute a few bands at a time.
  public static func bandKeysRange(_ shingles: [UInt32], band0: Int, band1: Int, rows: Int = MinHash.rows,
                                   perms: Int = MinHash.perms, seed: UInt32 = MinHash.seed) -> [UInt32] {
    let p = permutations(perms: perms, seed: seed)
    let p0 = band0 * rows, p1 = band1 * rows
    var sig = [UInt32](repeating: 0xffff_ffff, count: max(0, p1 - p0))
    for h in shingles {
      for q in p0..<p1 {
        let v = (p.a[q] &* h) &+ p.b[q]
        if v < sig[q - p0] { sig[q - p0] = v }
      }
    }
    var out = [UInt32](repeating: 0, count: max(0, band1 - band0))
    for band in band0..<band1 {
      var h = (0x811c_9dc5 ^ UInt32(truncatingIfNeeded: band)) &* 0x0100_0193
      for r in 0..<rows { h = (h ^ sig[(band - band0) * rows + r]) &* 0x0100_0193 }
      out[band - band0] = h
    }
    return out
  }

  /// A unit of a passage: the token range [t0, t1) of its token list.
  public struct Unit: Sendable, Equatable {
    public var t0: Int
    public var t1: Int
    public init(t0: Int, t1: Int) {
      self.t0 = t0
      self.t1 = t1
    }
  }

  /// `unitsOf(text, tok, {verse, minTokens})`: sentences (or lines, in verse) of ≥ `minTokens` tokens. A unit ends
  /// at the last token, or where the gap after a token holds `[.!?;…।॥]` or a blank line (`\n\s*\n`); in verse, where
  /// it holds a newline. Offsets are UTF-16 units relative to `text`.
  public static func unitsOf(_ text: [UInt16], starts: [Int32], ends: [Int32], verse: Bool = false,
                             minTokens: Int = MinHash.minUnitTokens) -> [Unit] {
    var out: [Unit] = []
    let n = starts.count
    var t0 = 0
    for i in 0..<n {
      let lo = Int(ends[i])
      let hi = i + 1 < n ? Int(starts[i + 1]) : text.count
      if i == n - 1 || gapBreaks(text, lo, hi, verse: verse) {
        if i + 1 - t0 >= minTokens { out.append(Unit(t0: t0, t1: i + 1)) }
        t0 = i + 1
      }
    }
    return out
  }

  /// `unitsOf` over a String.
  public static func unitsOf(_ text: String, starts: [Int32], ends: [Int32], verse: Bool = false,
                             minTokens: Int = MinHash.minUnitTokens) -> [Unit] {
    unitsOf(Array(text.utf16), starts: starts, ends: ends, verse: verse, minTokens: minTokens)
  }

  /// Whether `text[lo..<hi]` (clamped as String.slice) breaks a unit.
  static func gapBreaks(_ text: [UInt16], _ lo: Int, _ hi: Int, verse: Bool) -> Bool {
    // String.prototype.slice: negative → 0, past the end → length, end < start → empty
    let a = min(max(lo, 0), text.count), b = min(max(hi, 0), text.count)
    guard a < b else { return false }
    if verse {
      for i in a..<b where text[i] == 0x0A { return true }
      return false
    }
    // /[.!?;…।॥]|\n\s*\n/u
    var newlineOpen = false
    var i = a
    while i < b {
      let c = text[i]
      switch c {
      case 0x2E, 0x21, 0x3F, 0x3B, 0x2026, 0x0964, 0x0965: return true
      case 0x0A:
        if newlineOpen { return true }
        newlineOpen = true
        i += 1
        continue
      default: break
      }
      if newlineOpen {
        // \s* between the two newlines: any JavaScript WhiteSpace or LineTerminator keeps the run open
        var cp = UInt32(c), len = 1
        if c >= 0xD800, c <= 0xDBFF, i + 1 < b, text[i + 1] >= 0xDC00, text[i + 1] <= 0xDFFF {
          cp = 0x10000 + (UInt32(c - 0xD800) << 10) + UInt32(text[i + 1] - 0xDC00)
          len = 2
        }
        if !isJSWhitespace(cp) { newlineOpen = false }
        i += len
        continue
      }
      i += 1
    }
    return false
  }

  /// JavaScript's `\s` (WhiteSpace + LineTerminator), from the generated class table.
  @inline(__always)
  static func isJSWhitespace(_ cp: UInt32) -> Bool {
    if cp >= 0xD800 && cp <= 0xDFFF { return false }
    return TokenClassTable.classes(cp).contains(.whitespace)
  }
}
