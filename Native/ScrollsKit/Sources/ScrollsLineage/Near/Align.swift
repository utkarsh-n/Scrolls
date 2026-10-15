// OWNER: N5
// Port of server/lineage/align.mjs (SPEC §4.7): verification of reuse candidates — seed-and-extend to maximal common
// runs of token ids (exact quotations), k-gram seeds for a short span (the targeted trace), and token Smith–Waterman
// (+2 match, −1 mismatch, −1 gap) for near quotations. Scores are f64 in the reference's order, so spans, scores and
// tie-breaks are equal (G1 `g1.align`).

import Foundation

public enum Align {
  /// A maximal common run: a[a0..<a1] == b[b0..<b1].
  public struct Run: Sendable, Equatable {
    public var a0: Int
    public var a1: Int
    public var b0: Int
    public var b1: Int
    public var len: Int { a1 - a0 }
    public init(a0: Int, a1: Int, b0: Int, b1: Int) {
      self.a0 = a0
      self.a1 = a1
      self.b0 = b0
      self.b1 = b1
    }
  }

  /// A seed: a[a…] and b[b…] probably start the same shingle.
  public struct Seed: Sendable, Equatable {
    public var a: Int
    public var b: Int
    public init(a: Int, b: Int) {
      self.a = a
      self.b = b
    }
  }

  /// `seedExtend(a, b, seeds, {minRun, aLo, aHi, bLo, bHi})`: each seed verified token by token and extended both ways
  /// inside the limits; seeds inside an already found run of their diagonal are skipped, so each run is reported once.
  /// Runs of ≥ minRun, sorted by a0 then b0.
  public static func seedExtend(_ a: UnsafeBufferPointer<UInt32>, _ b: UnsafeBufferPointer<UInt32>, _ seeds: [Seed],
                                minRun: Int = 8, aLo: Int = 0, aHi: Int? = nil, bLo: Int = 0, bHi: Int? = nil) -> [Run] {
    let aHi = aHi ?? a.count, bHi = bHi ?? b.count
    var runs: [Run] = []
    var byDiagonal: [Int: [Run]] = [:]
    // sorted by diagonal (a − b), then a; a stable sort as Array.prototype.sort
    let sorted = seeds.enumerated().sorted { x, y in
      let dx = x.element.a - x.element.b, dy = y.element.a - y.element.b
      if dx != dy { return dx < dy }
      if x.element.a != y.element.a { return x.element.a < y.element.a }
      return x.offset < y.offset
    }.map(\.element)
    for s in sorted {
      if s.a < aLo || s.a >= aHi || s.b < bLo || s.b >= bHi { continue }
      let d = s.a - s.b
      if let covered = byDiagonal[d], covered.contains(where: { s.a >= $0.a0 && s.a < $0.a1 }) { continue }
      if a[s.a] != b[s.b] { continue }
      var a0 = s.a, b0 = s.b
      while a0 > aLo && b0 > bLo && a[a0 - 1] == b[b0 - 1] {
        a0 -= 1
        b0 -= 1
      }
      var a1 = s.a + 1, b1 = s.b + 1
      while a1 < aHi && b1 < bHi && a[a1] == b[b1] {
        a1 += 1
        b1 += 1
      }
      let run = Run(a0: a0, a1: a1, b0: b0, b1: b1)
      byDiagonal[d, default: []].append(run)
      if run.len >= minRun { runs.append(run) }
    }
    return runs.enumerated().sorted { x, y in
      if x.element.a0 != y.element.a0 { return x.element.a0 < y.element.a0 }
      if x.element.b0 != y.element.b0 { return x.element.b0 < y.element.b0 }
      return x.offset < y.offset
    }.map(\.element)
  }

  public static func seedExtend(_ a: [UInt32], _ b: [UInt32], _ seeds: [Seed], minRun: Int = 8, aLo: Int = 0, aHi: Int? = nil,
                                bLo: Int = 0, bHi: Int? = nil) -> [Run] {
    a.withUnsafeBufferPointer { pa in
      b.withUnsafeBufferPointer { pb in
        seedExtend(pa, pb, seeds, minRun: minRun, aLo: aLo, aHi: aHi, bLo: bLo, bHi: bHi)
      }
    }
  }

  /// `kgramSeeds(a, b, {k, aLo, aHi})`: every (i, j) where the k-gram of `a` at i (inside [aLo, aHi)) has the same
  /// FNV key as the k-gram of `b` at j; j ascending, and for one j the i in index order.
  public static func kgramSeeds(_ a: UnsafeBufferPointer<UInt32>, _ b: UnsafeBufferPointer<UInt32>, k: Int = 8, aLo: Int = 0,
                                aHi: Int? = nil) -> [Seed] {
    let aHi = aHi ?? a.count
    @inline(__always) func key(_ arr: UnsafeBufferPointer<UInt32>, _ i: Int) -> UInt32 {
      var h: UInt32 = 0x811c_9dc5
      for j in i..<(i + k) { h = (h ^ arr[j]) &* 0x0100_0193 }
      return h
    }
    var index: [UInt32: [Int]] = [:]
    var i = aLo
    while i + k <= aHi {
      index[key(a, i), default: []].append(i)
      i += 1
    }
    var seeds: [Seed] = []
    var j = 0
    while j + k <= b.count {
      if let list = index[key(b, j)] { for i in list { seeds.append(Seed(a: i, b: j)) } }
      j += 1
    }
    return seeds
  }

  public static func kgramSeeds(_ a: [UInt32], _ b: [UInt32], k: Int = 8, aLo: Int = 0, aHi: Int? = nil) -> [Seed] {
    a.withUnsafeBufferPointer { pa in b.withUnsafeBufferPointer { pb in kgramSeeds(pa, pb, k: k, aLo: aLo, aHi: aHi) } }
  }

  /// A local alignment: the score, its normalisation by the shorter side, and the aligned spans.
  public struct SW: Sendable, Equatable {
    public var score: Double
    public var normalized: Double
    public var aStart: Int
    public var aEnd: Int
    public var bStart: Int
    public var bEnd: Int
  }

  /// `smithWaterman(a, b, {match, mismatch, gap})`: Smith–Waterman with linear gaps; `normalized` = score / (match ×
  /// the shorter length), 1 for an exact containment. The start of the best cell is tracked as the reference tracks
  /// it (diagonal, then up, then left; a strictly greater value wins).
  public static func smithWaterman(_ a: UnsafeBufferPointer<UInt32>, _ b: UnsafeBufferPointer<UInt32>, match: Double = 2,
                                   mismatch: Double = -1, gap: Double = -1) -> SW {
    let n = a.count, m = b.count
    if n == 0 || m == 0 { return SW(score: 0, normalized: 0, aStart: 0, aEnd: 0, bStart: 0, bEnd: 0) }
    var prev = [Double](repeating: 0, count: m + 1), cur = [Double](repeating: 0, count: m + 1)
    var prevSi = [Int32](repeating: 0, count: m + 1), curSi = [Int32](repeating: 0, count: m + 1)
    var prevSj = [Int32](repeating: 0, count: m + 1), curSj = [Int32](repeating: 0, count: m + 1)
    var bestScore = 0.0, bestI = 0, bestJ = 0, bestSi: Int32 = 0, bestSj: Int32 = 0
    for i in 1...n {
      cur[0] = 0
      let ai = a[i - 1]
      for j in 1...m {
        let diag = prev[j - 1] + (ai == b[j - 1] ? match : mismatch)
        let up = prev[j] + gap
        let left = cur[j - 1] + gap
        var v = 0.0
        var si = Int32(i), sj = Int32(j)
        if diag > v {
          v = diag
          si = prev[j - 1] > 0 ? prevSi[j - 1] : Int32(i)
          sj = prev[j - 1] > 0 ? prevSj[j - 1] : Int32(j)
        }
        if up > v {
          v = up
          si = prevSi[j]
          sj = prevSj[j]
        }
        if left > v {
          v = left
          si = curSi[j - 1]
          sj = curSj[j - 1]
        }
        cur[j] = v
        curSi[j] = si
        curSj[j] = sj
        if v > bestScore {
          bestScore = v
          bestI = i
          bestJ = j
          bestSi = si
          bestSj = sj
        }
      }
      swap(&prev, &cur)
      swap(&prevSi, &curSi)
      swap(&prevSj, &curSj)
    }
    return SW(score: bestScore, normalized: bestScore / (match * Double(Swift.min(n, m))),
              aStart: bestScore != 0 ? Int(bestSi) - 1 : 0, aEnd: bestI,
              bStart: bestScore != 0 ? Int(bestSj) - 1 : 0, bEnd: bestJ)
  }

  public static func smithWaterman(_ a: [UInt32], _ b: [UInt32], match: Double = 2, mismatch: Double = -1, gap: Double = -1) -> SW {
    a.withUnsafeBufferPointer { pa in
      b.withUnsafeBufferPointer { pb in smithWaterman(pa, pb, match: match, mismatch: mismatch, gap: gap) }
    }
  }
}
