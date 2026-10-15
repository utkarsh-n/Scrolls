// OWNER: N4
// G1 stats (IOS-SPEC §2.2, §2.4): the pure functions of server/analysis/{intervals,bootstrap,composition,keyness,
// multiplicity,gates,baseline-rho,drift,tone,collocations}.mjs on the seeded inputs of Golden/gen-analysis.mjs. Strings
// and integers exact; floats on the exact f64 paths within 1e-9 · max(1, |x|) (the reference's summation order is kept,
// so nearly every value is bit-equal; the tolerance only covers libm's last ulp of log2/exp/pow, DV-5).

import Foundation
@testable import ScrollsAnalysis
import ScrollsCore
import Testing

@Suite("G1 stats goldens")
struct StatsGoldenTests {
  // MARK: JSON helpers

  static func num(_ v: JSONValue?) -> Double {
    switch v {
    case .number(let x)?: return x
    case .object(let o)? where o["$num"] != nil:
      switch o["$num"]?.stringValue {
      case "Infinity": return .infinity
      case "-Infinity": return -.infinity
      default: return .nan
      }
    default: return .nan
    }
  }
  static func nums(_ v: JSONValue?) -> [Double] { v?.arrayValue?.map { num($0) } ?? [] }
  static func j(_ x: Double?) -> JSONValue {
    guard let x else { return .null }
    if x.isFinite { return .number(x) }
    return ["$num": .string(x.isNaN ? "NaN" : x > 0 ? "Infinity" : "-Infinity")]
  }
  static func pair(_ p: (Double, Double)?) -> JSONValue { p.map { [j($0.0), j($0.1)] } ?? .null }
  static func doubleMap(_ entries: JSONValue?) -> JSMap<Double> {
    var m = JSMap<Double>()
    for e in entries?.arrayValue ?? [] { m[e[0]!.stringValue!] = num(e[1]) }
    return m
  }
  /// `Object.entries` passed as `[[k, v], …]` into a plain object (integer-like keys first, as a JS object).
  static func objectMap(_ entries: JSONValue?) -> JSMap<Double> {
    var m = JSMap<Double>(objectOrder: true)
    for e in entries?.arrayValue ?? [] { m[e[0]!.stringValue!] = num(e[1]) }
    return m
  }

  // MARK: the evaluator

  /// The Swift value of one golden case, in the reference's JSON shape.
  static func evaluate(_ fn: String, _ a: [JSONValue]) -> JSONValue? {
    switch fn {
    case "lnGamma": return j(Intervals.lnGamma(num(a[0])))
    case "gammaP": return j(Intervals.gammaP(num(a[0]), num(a[1])))
    case "gammaQ": return j(Intervals.gammaQ(num(a[0]), num(a[1])))
    case "gammaPInv": return j(Intervals.gammaPInv(num(a[0]), num(a[1])))
    case "chi2Quantile": return j(Intervals.chi2Quantile(num(a[0]), num(a[1])))
    case "chi2Sf": return j(Intervals.chi2Sf(num(a[0]), num(a[1])))
    case "betaI": return j(Intervals.betaI(num(a[0]), num(a[1]), num(a[2])))
    case "betaIInv": return j(Intervals.betaIInv(num(a[0]), num(a[1]), num(a[2])))
    case "normalQuantile": return j(Intervals.normalQuantile(num(a[0])))
    case "Z95": return j(Intervals.z95)
    case "garwoodCI": return pair(Intervals.garwoodCI(num(a[0])))
    case "wilsonCI": return pair(Intervals.wilsonCI(num(a[0]), num(a[1])))
    case "clopperPearsonCI": return pair(Intervals.clopperPearsonCI(num(a[0]), num(a[1])))
    case "poissonRate":
      let r = Intervals.poissonRate(num(a[0]), num(a[1]), scale: num(a[2]))
      return ["rate": j(r.rate), "ci": pair(r.ci)]
    case "proportionRate":
      let r = Intervals.proportionRate(num(a[0]), num(a[1]), scale: num(a[2]))
      return ["rate": j(r.rate), "ci": pair(r.ci)]
    case "poissonRateRatio":
      let r = Intervals.poissonRateRatio(num(a[0]), num(a[1]), num(a[2]), num(a[3]))
      return ["value": j(r.value), "ci": r.ci.map { [j($0.0), j($0.1)] } ?? .null, "unbounded": .bool(r.unbounded)]
    case "g2": return j(Intervals.g2(num(a[0]), num(a[1]), num(a[2]), num(a[3])))
    case "benjaminiHochberg": return .array(Intervals.benjaminiHochberg(nums(a[0])).map { j($0) })
    case "griesDP":
      let parts = (a[0].arrayValue ?? []).map { (n: num($0["n"]), size: num($0["size"])) }
      return j(Intervals.griesDP(parts))
    case "quantile": return j(Bootstrap.quantile(nums(a[0]), num(a[1])))
    case "blockBootstrapMean":
      let blocks = (a[0].arrayValue ?? []).map { nums($0) }
      let seed = UInt32(num(a[1]))
      return pair(Bootstrap.blockBootstrap(blocks, seed: seed) { s in
        var t = 0.0, c = 0.0
        for b in s {
          t += b[0]
          c += b[1]
        }
        return c != 0 ? t / c : nil
      })
    case "contextShareShift":
      let blocksA = (a[0].arrayValue ?? []).map { nums($0) }, blocksB = (a[1].arrayValue ?? []).map { nums($0) }
      let k = Int(num(a[2]))
      let r = CompareBlocks.contextShareShift(blocksA, blocksB, k)
      func sum(_ blocks: [[Double]]) -> [Double] {
        var t = [Double](repeating: 0, count: k)
        for b in blocks { for i in 0..<k { t[i] += b[i] } }
        return t
      }
      let ta = sum(blocksA), tb = sum(blocksB)
      let nA = ta.reduce(0, +), nB = tb.reduce(0, +)
      return ["value": j(r.value), "ci": pair(r.ci), "sharesA": .array(ta.map { j(nA != 0 ? $0 / nA : 0) }),
              "sharesB": .array(tb.map { j(nB != 0 ? $0 / nB : 0) }), "nA": j(nA), "nB": j(nB)]
    case "jsdCounts": return j(CompareBlocks.jsdCounts(nums(a[0]), nums(a[1])))
    case "shareIntervals":
      let blocks = (a[0].arrayValue ?? []).map { nums($0) }
      return .array(Bootstrap.shareIntervals(blocks, Int(num(a[1]))).map { pair($0) })
    case "percentileOf": return j(Bootstrap.percentileOf(num(a[0]), nums(a[1])))
    case "compositionJsd": return j(Composition.jsd(objectMap(a[0]), objectMap(a[1])))
    case "standardizedRates":
      var strata = JSMap<Composition.Stratum>()
      for e in a[0].arrayValue ?? [] {
        var s = Composition.Stratum()
        s.a = (num(e[1]?["a"]?["n"]), num(e[1]?["a"]?["denom"]))
        s.b = (num(e[1]?["b"]?["n"]), num(e[1]?["b"]?["denom"]))
        strata[e[0]!.stringValue!] = s
      }
      guard let r = Composition.standardizedRates(strata, scale: num(a[1])) else { return .null }
      return ["a": j(r.a), "b": j(r.b), "strata": j(Double(r.strata)), "weight_covered": j(r.weightCovered),
              "matches_covered": ["a": j(r.matchesCoveredA), "b": j(r.matchesCoveredB)]]
    case "topShare":
      guard let t = Composition.topShare(objectMap(a[0])) else { return .null }
      return ["key": .string(t.key), "share": j(t.share)]
    case "keyness":
      let rows = Keyness.keyness(doubleMap(a[0]), doubleMap(a[1]), totalA: num(a[2]), totalB: num(a[3]))
      return .array(rows.map {
        ["term": .string($0.term), "f_a": j($0.fA), "f_b": j($0.fB), "log_ratio": j($0.logRatio), "g2": j($0.g2), "p": j($0.p),
         "q": j($0.q), "side": .string($0.side)]
      })
    case "notableThreshold": return j(Multiplicity.notableThreshold(Int(num(a[0]))))
    case "ordinal": return .string(Multiplicity.ordinal(num(a[0])))
    case "multiplicityBlock":
      return Multiplicity.block(k: Int(num(a[0])), notableSoFar: Int(num(a[1])), label: a[2].stringValue ?? "")
    case "tokensHave": return .string(Gates.tokensHave(num(a[0])))
    case "unitsLabel": return .string(Gates.unitsLabel(num(a[0]), a[1].stringValue ?? ""))
    case "lowCoverageNote": return .string(Gates.lowCoverageNote(num(a[0]), num(a[1]), a[2].stringValue ?? ""))
    case "collocatesNote":
      let have = a[0].objectValue ?? [:]
      func side(_ k: String) -> Gates.Side {
        guard let v = have[k] else { return .absent }
        return .value(v.isNull ? nil : num(v))
      }
      return .string(Gates.collocatesNote(a: side("a"), b: side("b"), needed: Int(num(a[1]))))
    case "rangeLabel":
      let y = nums(a[0])
      return .string(Gates.rangeLabel((Int(y[0]), Int(y[1]))))
    case "widenLabel":
      let y = nums(a[1])
      return .string(Gates.widenLabel(a[0].stringValue, (Int(y[0]), Int(y[1])), a[2].stringValue ?? ""))
    case "ranks": return .array(BaselineRho.ranks(nums(a[0])).map { j($0) })
    case "spearman": return j(BaselineRho.spearman(nums(a[0]), nums(a[1])))
    case "blockBootstrapRho":
      let r = BaselineRho.blockBootstrapRho(nums(a[0]), nums(a[1]))
      return ["ci": pair(r.ci), "used": j(Double(r.used)), "skipped": j(Double(r.skipped))]
    case "toneDistribution":
      let d = CompareBlocks.toneDistribution(nums(a[0]), docs: nums(a[1]).map { Int($0) })
      return ["n": j(Double(d.n)), "docs": j(Double(d.docs)), "mean": j(d.mean), "ci": pair(d.ci), "sd": j(d.sd), "median": j(d.median),
              "histogram": .array(d.histogram.map { ["lo": j($0.lo), "hi": j($0.hi), "n": j(Double($0.n))] })]
    case "collocates":
      var counts = Collocations.Counts(source: "golden", langs: [], passages: 0, stop: JSSet((a[6].arrayValue ?? []).compactMap(\.stringValue)))
      counts.fxy = doubleMap(a[0])
      counts.fy = doubleMap(a[1])
      counts.fx = Int(num(a[2]))
      counts.W = Int(num(a[3]))
      counts.N = Int(num(a[4]))
      counts.sumFyAlpha = num(a[5])
      let r = Collocations.collocates(counts, showStop: a[7].boolValue ?? false, limit: 100)
      return ["rows": .array(r.rows.map {
        ["term": .string($0.term), "f_xy": j(Double($0.fXY)), "f_y": j(Double($0.fY)), "logDice": j($0.logDice), "ppmi": j($0.ppmi),
         "g2": j($0.g2), "q": j($0.q)]
      }), "candidates": j(Double(r.candidates)), "significant": j(Double(r.significant)), "hidden_stopwords": j(Double(r.hiddenStopwords))]
    case "measureSentence":
      let metric = a[0].stringValue ?? ""
      let m = a[1].objectValue ?? [:]
      let opts = a[2].objectValue ?? [:]
      let overlap = opts["overlap"]?.objectValue
      let verdict = opts["verdict"]?.stringValue
      return .string(CompareBlocks.measureSentence(metric, m, n: nums(opts["n"]).map { Int($0) }, docs: nums(opts["docs"]).map { Int($0) },
                                                   overlap: overlap, verdict: verdict))
    default: return nil
    }
  }

  @Test("g1.stats: intervals, bootstrap, composition, keyness, multiplicity, gate copy, baseline ρ, tone, collocates")
  func stats() throws {
    let family = "g1.stats"
    let cases = try AnalysisGolden.load(family)
    var mismatches: [String] = []
    var unknown = Set<String>()
    for (i, c) in cases.enumerated() {
      let fn = c["fn"]?.stringValue ?? "?"
      guard let got = Self.evaluate(fn, c["args"]?.arrayValue ?? []) else {
        unknown.insert(fn)
        mismatches.append("#\(i) \(fn): no Swift port in this test")
        continue
      }
      if let d = AnalysisGolden.diff(c["out"] ?? .null, got) { mismatches.append("#\(i) \(fn): \(d)") }
    }
    AnalysisGolden.report(family, cases: cases.count, mismatches: mismatches)
    #expect(unknown.isEmpty, "functions without a port: \(unknown.sorted())")
    #expect(mismatches.isEmpty, "\(mismatches.count) of \(cases.count) differ; first: \(mismatches.prefix(8).joined(separator: " | "))")
  }
}
