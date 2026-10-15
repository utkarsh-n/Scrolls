// OWNER: N5
// Package N5's device self-test steps (IOS-SPEC §2.7, §8.5): one step per acceptance row that needs the phone, so the
// device rows are commands. The probe suite is N0's and gets nothing from here.
//  · journey: winnowing parity on iOS — the three bundled sample books tokenized, folded, hashed and winnowed equal the
//    reference's fingerprints (the boilerplate pass, the trace and the reuse index rest on them); the genealogy of
//    *Funky Drummer* (32 / 98 / 48 works over 3 generations, the reference's counts on m1r) when the Cipher relations
//    are on this atlas;
//  · perf: the fingerprinting throughput on this phone (INFO), and the targeted trace of a span ≥ 13 tokens (≤ 1.5 s on
//    the device; the simulator's time is a proxy, INFO). The reuse index (≤ 8 min, ≤ 600 MB) stays PENDING until it lands.
// A row that cannot run here is PENDING with its reason, never PASS.

import Foundation
import ScrollsContracts
import ScrollsLineage
import ScrollsService

/// N5's steps, registered in `SelfTestCatalog.n5`.
enum N5Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .journey:
      return [SelfTestStep("N5 winnow parity", run: winnowParity), SelfTestStep("N5 genealogy", run: genealogyRow)]
    case .perf:
      return [SelfTestStep("N5 fingerprint throughput", run: throughput), SelfTestStep("N5 trace", run: traceTiming),
              SelfTestStep("N5 reuse index", run: reuseIndexRow)]
    default:
      return []
    }
  }

  #if targetEnvironment(simulator)
    static let proxyNote = " (simulator: a proxy, not the phone)"
    static let onDevice = false
  #else
    static let proxyNote = ""
    static let onDevice = true
  #endif

  /// Whether this run answers from the contract fixtures (no live engine).
  static func isFixtures(_ ctx: SelfTestContext) -> Bool {
    if case .fixtures = ctx.model.engine.kind { return true }
    return false
  }

  /// The bundled sample books (N0's probe samples) winnowed on this OS = the reference (g1.winnow `probe-book`).
  static func winnowParity(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let dir = EngineLaunchOptions.bundledProbeSamples else {
      return [.pending("winnow parity", "the app bundle has no Probe/ sample books")]
    }
    let results = await Task.detached(priority: .userInitiated) { WinnowProbe.checkAll(in: dir) }.value
    return results.map { r in
      r.passed ? .pass("winnow \(r.name)", r.detail) : .fail("winnow \(r.name)", r.detail)
    }
  }

  /// Tokens per second of tokenize + fold + FNV + winnow on this phone (the boilerplate pass's inner loop).
  static func throughput(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let dir = EngineLaunchOptions.bundledProbeSamples else {
      return [.pending("fingerprint throughput", "the app bundle has no Probe/ sample books")]
    }
    let results = await Task.detached(priority: .userInitiated) { WinnowProbe.checkAll(in: dir) }.value
    let tokens = results.reduce(0) { $0 + $1.tokens }
    let seconds = results.reduce(0.0) { $0 + $1.seconds }
    guard tokens > 0, seconds > 0 else { return [.pending("fingerprint throughput", "no sample book could be read")] }
    let rate = Double(tokens) / seconds
    return [.info("fingerprint throughput", "\(tokens) tokens in \(String(format: "%.3f", seconds)) s = \(Int(rate)) tokens/s\(proxyNote)")]
  }

  /// *Funky Drummer*'s family tree: the reference's 32 / 98 / 48 works in generations +1 / +2 / +3 (g3.lineage on m1r).
  static func genealogyRow(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "genealogy Funky Drummer"
    guard let atlas = ctx.model.atlas, !isFixtures(ctx) else {
      return [.pending(name, "needs the live engine (this run answers from the contract fixtures)")]
    }
    do {
      let found = try await atlas.search(SearchRequest(q: "Funky Drummer", corpus: "cipher", limit: 20))
      guard let work = found.titles.first(where: { $0.title == "Funky Drummer" && $0.year == 1970 }) else {
        return [.pending(name, "Funky Drummer (1970) is not in this atlas yet: it needs Cipher's relations (phase A2)")]
      }
      let t0 = ContinuousClock.now
      let g = try await atlas.genealogy(GenealogyRequest(work: "document:\(work.documentId.rawValue)"))
      let ms = Int((ContinuousClock.now - t0) / .milliseconds(1))
      let totals = g.generations.sorted { $0.gen < $1.gen }.map { "\($0.gen):\($0.total)" }
      let detail = "generations \(totals.joined(separator: " ")) in \(ms) ms\(proxyNote)"
      return totals == ["1:32", "2:98", "3:48"] ? [.pass(name, detail)] : [.fail(name, "\(detail); the reference has 1:32 2:98 3:48")]
    } catch {
      return [.fail(name, "\(error)")]
    }
  }

  /// The targeted trace of a demo span of ≥ 13 tokens: ≤ 1.5 s on the device (the call answers 'done' inline).
  static func traceTiming(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "trace ≤ 1.5 s"
    guard let atlas = ctx.model.atlas, !isFixtures(ctx) else {
      return [.pending(name, "needs the live engine (this run answers from the contract fixtures)")]
    }
    do {
      let found = try await atlas.search(SearchRequest(q: "carry the zero", corpus: "demo", limit: 20))
      guard let row = found.kwic.first(where: { $0.absStart != nil && $0.absEnd != nil }),
        let s = row.absStart, let e = row.absEnd
      else { return [.pending(name, "no demo passage holds “carry the zero” in this atlas")] }
      // the match with its KWIC context on both sides (≥ 13 tokens), clipped by the engine's own check if needed
      var spans = [(s - row.left.utf16.count, e + row.right.utf16.count), (s, e + row.right.utf16.count), (s - row.left.utf16.count, e)]
      spans = spans.map { (max(0, $0.0), $0.1) }
      var last: Error?
      for (a, b) in spans {
        let t0 = ContinuousClock.now
        do {
          let r = try await atlas.trace(TraceRequest(passage: row.passage, start: a, end: b))
          let secs = (ContinuousClock.now - t0) / .seconds(1)
          let words = (r.span?["tokens"]?.safeInteger).map { "\($0) tokens" } ?? "span"
          let detail = "\(words), status \(r.status), \(r.exact?.arrayValue?.count ?? 0) exact · \(r.near?.arrayValue?.count ?? 0) near in \(String(format: "%.3f", secs)) s\(proxyNote)"
          if !onDevice { return [.info(name, detail)] }
          return r.status == "done" && secs <= 1.5 ? [.pass(name, detail)] : [.fail(name, detail)]
        } catch {
          last = error
        }
      }
      return [.fail(name, "no span could be traced: \(last.map { "\($0)" } ?? "unknown")")]
    } catch {
      return [.fail(name, "\(error)")]
    }
  }

  static func reuseIndexRow(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    [.pending("reuse index ≤ 8 min, peak ≤ 600 MB", "the global reuse index on the phone is N5's remaining M2 work")]
  }
}

extension SelfTestCatalog {
  static var n5: (any SelfTestSteps.Type)? { N5Steps.self }
}
