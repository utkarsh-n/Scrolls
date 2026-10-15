// OWNER: Q (created by the bring-up, B2)
// Vectors after pooling (IOS-SPEC-QWEN §3.2, §3.3; QWEN-LAB §1.1): unit-normalise, the Matryoshka cut to 256 dims and
// re-normalise, f16 storage, cosine, centring at analysis time, spherical k-means (k-means++, seeded restarts) and the
// cosine silhouette. Pure Swift on small n (the demo has 60 vectors); accumulations in Double.

import Foundation
import ScrollsCore

public enum VectorMath {
  public static func norm(_ v: [Float]) -> Double {
    var s = 0.0
    for x in v { s += Double(x) * Double(x) }
    return s.squareRoot()
  }

  public static func normalized(_ v: [Float]) -> [Float] {
    let n = norm(v)
    guard n > 1e-12 else { return v }
    return v.map { Float(Double($0) / n) }
  }

  /// The first `dims` components, re-normalised (Qwen3-Embedding is Matryoshka-trained).
  public static func matryoshka(_ v: [Float], dims: Int) -> [Float] {
    normalized(Array(v.prefix(dims)))
  }

  public static func dot(_ a: [Float], _ b: [Float]) -> Double {
    var s = 0.0
    for i in 0..<min(a.count, b.count) { s += Double(a[i]) * Double(b[i]) }
    return s
  }

  public static func cosine(_ a: [Float], _ b: [Float]) -> Double {
    let d = norm(a) * norm(b)
    return d > 1e-12 ? dot(a, b) / d : 0
  }

  public static func f16(_ v: [Float]) -> [Float16] { v.map { Float16($0) } }
  public static func f32(_ v: [Float16]) -> [Float] { v.map { Float($0) } }

  /// Subtract the (weighted) mean vector and re-normalise each row (LAB-2b: centring at analysis time).
  public static func centred(_ rows: [[Float]], weights: [Double]? = nil) -> [[Float]] {
    guard let d = rows.first?.count, !rows.isEmpty else { return rows }
    var mean = [Double](repeating: 0, count: d)
    var wsum = 0.0
    for (i, r) in rows.enumerated() {
      let w = weights?[i] ?? 1
      wsum += w
      for j in 0..<d { mean[j] += w * Double(r[j]) }
    }
    for j in 0..<d { mean[j] /= max(wsum, 1e-12) }
    return rows.map { r in normalized((0..<d).map { Float(Double(r[$0]) - mean[$0]) }) }
  }
}

/// Spherical k-means on unit rows (the lab's `skmeans`, with plain k-means++ seeding): seeded, deterministic.
public struct SphericalKMeans: Sendable, Equatable {
  public var k: Int
  public var labels: [Int]
  public var centroids: [[Float]]
  public var objective: Double

  public static func fit(_ x: [[Float]], k: Int, seed: UInt32 = 42, restarts: Int = 10, iterations: Int = 100) -> SphericalKMeans {
    precondition(k >= 1 && x.count >= k, "k-means needs at least k rows")
    var rng = Mulberry32(seed: seed)
    var best: SphericalKMeans?
    for _ in 0..<max(1, restarts) {
      var c = seedPlusPlus(x, k: k, rng: &rng)
      var labels = [Int](repeating: -1, count: x.count)
      for _ in 0..<iterations {
        var changed = false
        for (i, row) in x.enumerated() {
          var bi = 0, bs = -Double.infinity
          for j in 0..<k {
            let s = VectorMath.dot(row, c[j])
            if s > bs { bs = s; bi = j }
          }
          if labels[i] != bi { labels[i] = bi; changed = true }
        }
        if !changed { break }
        for j in 0..<k {
          let members = x.indices.filter { labels[$0] == j }
          if members.isEmpty {
            // the row least similar to its own centroid starts an empty cluster again (the lab's rule)
            let far = x.indices.min { VectorMath.dot(x[$0], c[labels[$0]]) < VectorMath.dot(x[$1], c[labels[$1]]) }!
            c[j] = x[far]
            labels[far] = j
          } else {
            var sum = [Double](repeating: 0, count: x[0].count)
            for m in members { for d in 0..<sum.count { sum[d] += Double(x[m][d]) } }
            c[j] = VectorMath.normalized(sum.map { Float($0) })
          }
        }
      }
      let obj = x.indices.reduce(0.0) { $0 + VectorMath.dot(x[$1], c[labels[$1]]) }
      if best == nil || obj > best!.objective + 1e-12 {
        best = SphericalKMeans(k: k, labels: labels, centroids: c, objective: obj)
      }
    }
    return best!
  }

  static func seedPlusPlus(_ x: [[Float]], k: Int, rng: inout Mulberry32) -> [[Float]] {
    var c: [[Float]] = [x[min(x.count - 1, Int(rng.next() * Double(x.count)))]]
    var d2 = x.map { max(0, 1 - VectorMath.dot($0, c[0])) }.map { $0 * $0 }
    while c.count < k {
      let total = d2.reduce(0, +)
      var pick = x.count - 1
      if total > 0 {
        var r = rng.next() * total
        for (i, w) in d2.enumerated() {
          r -= w
          if r <= 0 { pick = i; break }
        }
      } else {
        pick = min(x.count - 1, Int(rng.next() * Double(x.count)))
      }
      c.append(x[pick])
      for i in x.indices {
        let d = max(0, 1 - VectorMath.dot(x[i], x[pick]))
        d2[i] = min(d2[i], d * d)
      }
    }
    return c
  }

  /// Mean cosine silhouette (distance 1 − cos); 0 for a single cluster; singletons score 0.
  public static func silhouette(_ x: [[Float]], labels: [Int]) -> Double {
    let ks = Set(labels).sorted()
    guard ks.count > 1 else { return 0 }
    var total = 0.0
    for i in x.indices {
      var sums: [Int: Double] = [:], counts: [Int: Int] = [:]
      for j in x.indices where j != i {
        sums[labels[j], default: 0] += 1 - VectorMath.dot(x[i], x[j])
        counts[labels[j], default: 0] += 1
      }
      let own = labels[i]
      guard let n = counts[own], n > 0 else { continue }
      let a = sums[own]! / Double(n)
      let b = ks.filter { $0 != own }.compactMap { k in counts[k].map { sums[k]! / Double($0) } }.min() ?? 0
      let m = max(a, b)
      total += m > 1e-12 ? (b - a) / m : 0
    }
    return total / Double(x.count)
  }
}
