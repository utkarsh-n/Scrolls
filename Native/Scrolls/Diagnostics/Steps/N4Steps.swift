// OWNER: N4
// Package N4's self-test steps (IOS-SPEC §2.7, §8.5 N4): the device rows of Compare as commands.
//   journey — Compare on the atlas the self-test opened (the demo's 'carry the zero', A 1955–1985 vs B 1994–2026, the
//             §9.6 pair): coverage first, frequency with CIs (or its gate), collocates or their gate, a second request in
//             the same session raises k, and no gated object carries a numeral (SPEC §13 rule 7).
//   perf    — Compare ≤ 1.5 s, timed over three runs (first panel ≤ 150 ms is not separable here: Compare answers in one
//             payload); on the simulator the timing is a proxy (INFO), only the phone passes or fails it. The M3 rows
//             (clusters, the pooled space, drift, the constellation) stay PENDING until those parts land.
// On contract fixtures (MockAtlas) nothing is measured: the rows say so (INFO), never PASS.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService

enum N4Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .journey: [SelfTestStep("N4 compare journey", run: journey)]
    case .perf: [SelfTestStep("N4 compare timing", run: perf), SelfTestStep("N4 M3 rows", run: m3Pending)]
    default: []
    }
  }

  static let budgetSeconds = 1.5
  static let pair = (a: CompareSlice(years: [1955, 1985], f: "syn:1"), b: CompareSlice(years: [1994, 2026], f: "syn:1"))

  /// The demo's 'carry the zero' (or the first tracked expression) in the self-test atlas.
  @MainActor
  static func demoExpression(_ atlas: any AtlasService) async -> ExpressionInfo? {
    var first: ExpressionInfo?
    for id in 1...12 {
      guard let x = try? await atlas.expression(ExpressionID(id)) else { continue }
      if x.expression.surface == "carry the zero" { return x.expression }
      if first == nil { first = x.expression }
    }
    return first
  }

  static func isFixtures(_ ctx: SelfTestContext) -> Bool {
    if case .fixtures = ctx.model.engine.kind { true } else { false }
  }

  /// Paths of gated objects holding a number under an estimate key.
  static func numeralsInGates(_ v: JSONValue, path: String = "$") -> [String] {
    let estimates: Set<String> = ["value", "ci", "rate", "mean", "sd", "median", "share", "jaccard", "percentile", "logDice", "rho"]
    switch v {
    case .array(let a): return a.enumerated().flatMap { numeralsInGates($0.element, path: "\(path)[\($0.offset)]") }
    case .object(let o):
      let gated = (o["gate"]?.stringValue).map { $0 != "ok" } ?? false
      var out: [String] = []
      for (k, x) in o {
        if gated && estimates.contains(k) {
          if case .number = x { out.append("\(path).\(k)") }
          if case .array(let a) = x, a.contains(where: { $0.numberValue != nil }) { out.append("\(path).\(k)") }
        } else {
          out += numeralsInGates(x, path: "\(path).\(k)")
        }
      }
      return out
    default: return []
    }
  }

  @MainActor
  static func journey(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("compare", "no atlas is open")] }
    if isFixtures(ctx) { return [.info("compare", "the engine is the contract fixtures (MockAtlas): nothing to check on the device")] }
    guard let e = await demoExpression(atlas) else { return [.pending("compare", "no tracked expression in the self-test atlas")] }
    var rows: [SelfTestRow] = []
    let req = CompareRequest(expr: [e.id], a: pair.a, b: pair.b)
    do {
      let start = ContinuousClock.now
      let p = try await atlas.compare(req)
      let ms = (ContinuousClock.now - start) / .milliseconds(1)
      rows.append(.info("compare '\(e.surface)'", "A 1955–1985 vs B 1994–2026 in \(Int(ms)) ms"))
      let json = try ScrollsJSON.value(p)
      // coverage first: both slices' facts are there
      let cov = p.coverage
      let hasCoverage = cov.a.objectValue?["docs"] != nil && cov.b.objectValue?["docs"] != nil
      rows.append(hasCoverage ? .pass("coverage", "both slices: documents, authors, mix, modality, basis")
                              : .fail("coverage", "a slice has no coverage facts"))
      // frequency with CIs, or the gate
      let fa = p.freq["a"], fb = p.freq["b"]
      let freqOK = [fa, fb].allSatisfy { s in
        if CompareGate.isGated(s) { return true }
        return s?["rate"]?.numberValue != nil && s?["ci"]?.arrayValue?.count == 2
      }
      rows.append(freqOK ? .pass("frequency", "each slice has a rate with its 95% CI, or a gate card")
                         : .fail("frequency", "a slice has neither a rate with a CI nor a gate"))
      let colOK = CompareGate.isGated(p.collocates) || p.collocates["shared"] != nil
      rows.append(colOK ? .pass("collocates", CompareGate.isGated(p.collocates) ? "gated: \(p.collocates["gate"]?.stringValue ?? "")" : "shared, A only, B only")
                        : .fail("collocates", "neither collocates nor a gate"))
      let bad = numeralsInGates(json)
      rows.append(bad.isEmpty ? .pass("gates", "no gated object carries a numeral") : .fail("gates", "numerals in gated objects: \(bad.prefix(5))"))
      // the same session: a different comparison raises k
      let again = try await atlas.compare(CompareRequest(expr: [e.id], a: CompareSlice(years: [1950, 1985], f: "syn:1"), b: pair.b))
      rows.append(again.multiplicity.k > p.multiplicity.k
        ? .pass("multiplicity", "k \(p.multiplicity.k) → \(again.multiplicity.k), threshold \(Format.number(again.multiplicity.thresholdPercentile))th percentile")
        : .fail("multiplicity", "k did not grow (\(p.multiplicity.k) → \(again.multiplicity.k))"))
    } catch {
      rows.append(.fail("compare", ErrorCardModel(any: error).message))
    }
    return rows
  }

  @MainActor
  static func perf(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("compare ≤ 1.5 s", "no atlas is open")] }
    if isFixtures(ctx) { return [.info("compare ≤ 1.5 s", "contract fixtures: not a measurement")] }
    guard let e = await demoExpression(atlas) else { return [.pending("compare ≤ 1.5 s", "no tracked expression in the self-test atlas")] }
    var times: [Double] = []
    for seed in [1, 2, 3] {
      let start = ContinuousClock.now
      do {
        _ = try await atlas.compare(CompareRequest(expr: [e.id], a: pair.a, b: pair.b, seed: seed))
      } catch {
        return [.fail("compare ≤ 1.5 s", ErrorCardModel(any: error).message)]
      }
      times.append((ContinuousClock.now - start) / .seconds(1))
    }
    let worst = times.max() ?? 0
    let detail = "'\(e.surface)', 3 runs: \(times.map { String(format: "%.3f s", $0) }.joined(separator: ", ")) (budget \(budgetSeconds) s)"
    #if targetEnvironment(simulator)
      return [.info("compare ≤ 1.5 s", "simulator proxy, not the device: \(detail)")]
    #else
      return [worst <= budgetSeconds ? .pass("compare ≤ 1.5 s", detail) : .fail("compare ≤ 1.5 s", detail)]
    #endif
  }

  @MainActor
  static func m3Pending(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    [.pending("bank clusters ≤ 15 s, cancellable ≤ 500 ms", "M3: clustering is not ported yet (package N4)"),
     .pending("English pooled space ≤ 3 min, peak ≤ 600 MB", "M3: vector spaces are not ported yet (package N4)"),
     .pending("drift ≤ 6 min", "M3 (package N4)"),
     .pending("constellation ≤ 300 ms", "M3 (package N4)")]
  }
}

extension SelfTestCatalog {
  static var n4: (any SelfTestSteps.Type)? { N4Steps.self }
}
