// OWNER: N4
// Port of server/analysis/bootstrap.mjs (SPEC §4.8–§4.10): document-block bootstrap intervals and control percentiles.
// Occurrences of one document are not independent, so intervals resample whole documents ("blocks") with replacement;
// resample indices come from the bit-exact `Mulberry32`, so every interval equals the reference's (IOS-SPEC §2.4).

import ScrollsCore

/// Bootstrap intervals and percentiles.
public enum Bootstrap {
  /// Resamples per interval (§4.8: 1,000).
  public static let resamples = 1000
  /// Default seed of every bootstrap (§4.8 "seed 42").
  public static let seed: UInt32 = 42

  /// Quantile of an ascending-sorted array by linear interpolation (type 7); nil for an empty array.
  public static func quantile(_ sorted: [Double], _ p: Double) -> Double? {
    let n = sorted.count
    if n == 0 { return nil }
    let h = Double(n - 1) * p
    let lo = Int(h.rounded(.down)), hi = Int(h.rounded(.up))
    return sorted[lo] + (h - Double(lo)) * (sorted[hi] - sorted[lo])
  }

  /// `Math.floor(rng() * n)`.
  @inline(__always)
  static func draw(_ rng: inout Mulberry32, _ n: Int) -> Int { Int((rng.next() * Double(n)).rounded(.down)) }

  /// JavaScript's numeric sort of finite values (`(a, b) => a - b`).
  static func sortedAscending(_ values: [Double]) -> [Double] { values.sorted { $0 < $1 } }

  /// 95% CI of a statistic by resampling blocks with replacement; nil with fewer than 2 blocks or no finite resample.
  public static func blockBootstrap<B>(_ blocks: [B], resamples: Int = resamples, seed: UInt32 = seed, level: Double = 0.95,
                                       _ statistic: ([B]) -> Double?) -> (Double, Double)? {
    let n = blocks.count
    if n < 2 { return nil }
    var rng = Mulberry32(seed: seed)
    var sample = blocks
    var values: [Double] = []
    for _ in 0..<resamples {
      for i in 0..<n { sample[i] = blocks[draw(&rng, n)] }
      if let v = statistic(sample), v.isFinite { values.append(v) }
    }
    if values.isEmpty { return nil }
    let sorted = sortedAscending(values)
    let a = (1 - level) / 2
    return (quantile(sorted, a)!, quantile(sorted, 1 - a)!)
  }

  /// Bootstrap of a statistic over two independent sets of blocks (A and B resampled separately).
  public static func twoSampleBootstrap<B>(_ blocksA: [B], _ blocksB: [B], resamples: Int = resamples, seed: UInt32 = seed,
                                           level: Double = 0.95, _ statistic: ([B], [B]) -> Double?) -> (Double, Double)? {
    if blocksA.count < 2 || blocksB.count < 2 { return nil }
    var rng = Mulberry32(seed: seed)
    var sa = blocksA, sb = blocksB
    var values: [Double] = []
    for _ in 0..<resamples {
      for i in 0..<sa.count { sa[i] = blocksA[draw(&rng, blocksA.count)] }
      for i in 0..<sb.count { sb[i] = blocksB[draw(&rng, blocksB.count)] }
      if let v = statistic(sa, sb), v.isFinite { values.append(v) }
    }
    if values.isEmpty { return nil }
    let sorted = sortedAscending(values)
    let a = (1 - level) / 2
    return (quantile(sorted, a)!, quantile(sorted, 1 - a)!)
  }

  /// Percentile of a value within a control distribution: share strictly below plus half the ties, × 100.
  public static func percentileOf(_ value: Double, _ controls: [Double]) -> Double? {
    let n = controls.count
    if n == 0 || !value.isFinite { return nil }
    var below = 0.0, ties = 0.0
    for c in controls {
      if c < value { below += 1 } else if c == value { ties += 1 }
    }
    return (100 * (below + ties / 2)) / Double(n)
  }

  /// 95% CIs of every category's share at once, resampling documents (each block: one document's counts per category).
  public static func shareIntervals(_ blocks: [[Double]], _ k: Int, resamples: Int = resamples, seed: UInt32 = seed,
                                    level: Double = 0.95) -> [(Double, Double)?] {
    let n = blocks.count
    if n < 2 { return Array(repeating: nil, count: k) }
    var rng = Mulberry32(seed: seed)
    var draws = Array(repeating: [Double](), count: k)
    var tot = [Double](repeating: 0, count: k)
    for _ in 0..<resamples {
      for j in 0..<k { tot[j] = 0 }
      var all = 0.0
      for _ in 0..<n {
        let b = blocks[draw(&rng, n)]
        for j in 0..<k {
          tot[j] += b[j]
          all += b[j]
        }
      }
      if !(all > 0) { continue }
      for j in 0..<k { draws[j].append(tot[j] / all) }
    }
    let a = (1 - level) / 2
    return draws.map { d in
      if d.isEmpty { return nil }
      let s = sortedAscending(d)
      return (quantile(s, a)!, quantile(s, 1 - a)!)
    }
  }
}
