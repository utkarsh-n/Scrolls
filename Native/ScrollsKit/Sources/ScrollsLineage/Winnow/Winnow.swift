// OWNER: N5
// Port of server/lineage/winnow.mjs (SPEC §4.7): winnowing over token ids (Schleimer, Wilkerson & Aiken 2003) with
// k = 8-token shingles and a window of w = 6. Every window of w consecutive shingle hashes contributes its minimum (the
// rightmost one on ties); consecutive windows that pick the same shingle record it once. Because the choice depends only
// on the window's own hashes, two sequences that share a run of ≥ k + w − 1 = 13 tokens always share at least one
// fingerprint. Expected density ≈ 2 / (w + 1). Token ids are FNV-1a-32 of the folded token (UTF-8), so fingerprints of
// the same words agree across documents, runs, processes and the reference (G1 `g1.winnow`, exact).

import Foundation
import ScrollsCore

/// Winnowing fingerprints and the stable radix sort that groups them (`winnow.mjs`).
public enum Winnow {
  /// Shingle length in tokens (`K`).
  public static let k = 8
  /// Window in shingles (`W`).
  public static let w = 6

  /// One sequence's fingerprints: the hash of each chosen shingle and the index of its first token, positions rising.
  public struct Fingerprints: Sendable, Equatable {
    public var hashes: [UInt32]
    public var positions: [UInt32]
    public init(hashes: [UInt32], positions: [UInt32]) {
      self.hashes = hashes
      self.positions = positions
    }
    public var count: Int { hashes.count }
  }

  /// `tokenId(token)`: FNV-1a-32 over the folded token's UTF-8 (a vocabulary-independent u32 id).
  @inline(__always)
  public static func tokenId(_ token: String) -> UInt32 { IDs.fnv1a32(token) }

  /// `tokenIds(tokens)`.
  public static func tokenIds(_ tokens: [String]) -> [UInt32] { tokens.map { IDs.fnv1a32($0) } }

  /// `shingleHashes(ids, k)`: FNV-1a-32 of every k-shingle (over each id's four little-endian bytes); length
  /// max(0, n − k + 1).
  public static func shingleHashes(_ ids: [UInt32], k: Int = Winnow.k) -> [UInt32] {
    ids.withUnsafeBufferPointer { shingleHashes($0, k: k) }
  }

  /// `shingleHashes` over a buffer.
  public static func shingleHashes(_ ids: UnsafeBufferPointer<UInt32>, k: Int = Winnow.k) -> [UInt32] {
    let n = ids.count - k + 1
    guard n > 0, k > 0 else { return [] }
    return [UInt32](unsafeUninitializedCapacity: n) { out, done in
      for i in 0..<n {
        var h: UInt32 = 0x811c_9dc5
        for j in i..<(i + k) {
          let v = ids[j]
          h = (h ^ (v & 255)) &* 0x0100_0193
          h = (h ^ ((v >> 8) & 255)) &* 0x0100_0193
          h = (h ^ ((v >> 16) & 255)) &* 0x0100_0193
          h = (h ^ (v >> 24)) &* 0x0100_0193
        }
        out[i] = h
      }
      done = n
    }
  }

  /// `winnow(ids, {k, w})`: a sequence with fewer than w shingles yields its single minimum; one shorter than k yields
  /// nothing.
  public static func winnow(_ ids: [UInt32], k: Int = Winnow.k, w: Int = Winnow.w) -> Fingerprints {
    ids.withUnsafeBufferPointer { winnow($0, k: k, w: w) }
  }

  /// `winnow` over a buffer.
  public static func winnow(_ ids: UnsafeBufferPointer<UInt32>, k: Int = Winnow.k, w: Int = Winnow.w) -> Fingerprints {
    let h = shingleHashes(ids, k: k)
    let n = h.count
    guard n > 0 else { return Fingerprints(hashes: [], positions: []) }
    let win = min(w, n)
    var hashes: [UInt32] = []
    var positions: [UInt32] = []
    hashes.reserveCapacity(n * 2 / (win + 1) + 8)
    positions.reserveCapacity(n * 2 / (win + 1) + 8)
    h.withUnsafeBufferPointer { h in
      var last = -1, minI = -1
      var s = 0
      while s + win <= n {
        let e = s + win - 1
        if minI < s {
          // the previous minimum left the window: rescan it
          minI = s
          var j = s + 1
          while j <= e {
            if h[j] <= h[minI] { minI = j }
            j += 1
          }
        } else if h[e] <= h[minI] {
          minI = e
        }
        if minI != last {
          hashes.append(h[minI])
          positions.append(UInt32(minI))
          last = minI
        }
        s += 1
      }
    }
    return Fingerprints(hashes: hashes, positions: positions)
  }

  /// `radixSortPairs(keys, vals, n)`: stable LSD radix sort of (key, value) pairs by key (two 16-bit passes), in
  /// place over the first `n` pairs; equal keys keep their input order (records appended in document order stay
  /// grouped by document within a hash).
  public static func radixSortPairs(_ keys: inout [UInt32], _ vals: inout [UInt32], count n: Int? = nil) {
    let n = n ?? keys.count
    precondition(n <= keys.count && n <= vals.count, "radixSortPairs: n exceeds the arrays")
    guard n >= 2 else { return }
    var k2 = [UInt32](repeating: 0, count: n)
    var v2 = [UInt32](repeating: 0, count: n)
    var count = [Int](repeating: 0, count: 65_536)
    keys.withUnsafeMutableBufferPointer { k1 in
      vals.withUnsafeMutableBufferPointer { v1 in
        k2.withUnsafeMutableBufferPointer { k2 in
          v2.withUnsafeMutableBufferPointer { v2 in
            count.withUnsafeMutableBufferPointer { count in
              // pass 1: low 16 bits, from the caller's arrays into the scratch arrays
              pass(from: (k1, v1), to: (k2, v2), n: n, shift: 0, count: count)
              // pass 2: high 16 bits, back into the caller's arrays
              pass(from: (k2, v2), to: (k1, v1), n: n, shift: 16, count: count)
            }
          }
        }
      }
    }
  }

  @inline(__always)
  private static func pass(from: (UnsafeMutableBufferPointer<UInt32>, UnsafeMutableBufferPointer<UInt32>),
                           to: (UnsafeMutableBufferPointer<UInt32>, UnsafeMutableBufferPointer<UInt32>), n: Int,
                           shift: UInt32, count: UnsafeMutableBufferPointer<Int>) {
    for b in 0..<65_536 { count[b] = 0 }
    for i in 0..<n { count[Int((from.0[i] >> shift) & 0xffff)] += 1 }
    var sum = 0
    for b in 0..<65_536 {
      let c = count[b]
      count[b] = sum
      sum += c
    }
    for i in 0..<n {
      let bucket = Int((from.0[i] >> shift) & 0xffff)
      let p = count[bucket]
      count[bucket] = p + 1
      to.0[p] = from.0[i]
      to.1[p] = from.1[i]
    }
  }
}
