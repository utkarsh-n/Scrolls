// OWNER: N3
// Package N3's device self-test steps (IOS-SPEC §2.7, §8.5 N3 acceptance), so the device rows are commands:
//  · perf: the *virus* search ≤ 150 ms (warm; the cold time is reported), materialising *bank* ≤ 1.5 s, tiles of one
//    viewport warm ≤ 16 ms and cold ≤ 120 ms; the Term trail row (≤ 1.5 s) is milestone M2 and stays PENDING.
//  · journey: a 20-mark sample of the demo's *carry the zero* opens at exact offsets — each mark's passage puts the
//    highlight of its occurrence at the occurrence's offsets, and the highlighted text folds to a counted variant.
// The Cipher rows need full Cipher in the self-test atlas (phase A and B); without it they are PENDING with the reason.
// On the simulator every timing is reported as INFO (a proxy, never a device PASS).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService

/// N3's steps, registered in `SelfTestCatalog.n3`.
enum N3Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .perf:
      return [SelfTestStep("N3 search virus", run: searchVirus), SelfTestStep("N3 materialise bank", run: materializeBank),
              SelfTestStep("N3 tiles", run: tilesTiming), SelfTestStep("N3 Term trail", run: termTrail)]
    case .journey:
      return [SelfTestStep("N3 marks at exact offsets", run: marksAtExactOffsets)]
    default:
      return []
    }
  }

  #if targetEnvironment(simulator)
    static let simulator = true
  #else
    static let simulator = false
  #endif

  static func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }

  /// A timing row: PASS/FAIL against the budget on the device, INFO on the simulator.
  static func timed(_ name: String, _ value: Double, budget: Double, _ extra: String = "") -> SelfTestRow {
    let text = "\(String(format: "%.1f", value)) ms (budget ≤ \(Int(budget)) ms)\(extra)"
    if simulator { return .info(name, text + " — simulator: a proxy, not the phone") }
    return value <= budget ? .pass(name, text) : .fail(name, text)
  }

  /// Whether the self-test atlas holds Cipher's full text (the Cipher rows need it).
  static func cipherReady(_ atlas: any AtlasService) async -> String? {
    do {
      let corpora = try await atlas.corpora()
      let data = try ScrollsJSON.value(corpora)
      let cipher = data.arrayValue?.first { $0["slug"]?.stringValue == "cipher" }
      let text = cipher?["collections"]?.arrayValue?.first { $0["slug"]?.stringValue == "cipher-gutenberg" }
      if let tokens = text?["tokens"]?.numberValue, tokens > 0 { return nil }
      return "Cipher's full text is not in this atlas yet (phase B)"
    } catch {
      return "the corpora could not be read: \(error)"
    }
  }

  static func searchVirus(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("search virus ≤ 150 ms", "no atlas is open")] }
    if let why = await cipherReady(atlas) { return [.pending("search virus ≤ 150 ms", why)] }
    do {
      let clock = ContinuousClock()
      let t0 = clock.now
      let cold = try await atlas.search(SearchRequest(q: "virus", corpus: "cipher"))
      let coldMs = ms(clock.now - t0)
      let t1 = clock.now
      _ = try await atlas.search(SearchRequest(q: "virus", corpus: "cipher"))
      let warmMs = ms(clock.now - t1)
      return [timed("search virus (warm) ≤ 150 ms", warmMs, budget: 150,
                    "; cold \(String(format: "%.1f", coldMs)) ms; \(cold.hits.passages) passages, \(cold.kwic.count) KWIC rows")]
    } catch {
      return [.fail("search virus ≤ 150 ms", "\(error)")]
    }
  }

  static func materializeBank(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("materialise bank ≤ 1.5 s", "no atlas is open")] }
    if let why = await cipherReady(atlas) { return [.pending("materialise bank ≤ 1.5 s", why)] }
    do {
      let clock = ContinuousClock()
      let t0 = clock.now
      let tracked = try await atlas.trackExpression(TrackExpressionRequest(surface: "bank", lang: "en", corpus: "cipher"))
      var state = tracked.state
      while state.status == "materializing" {
        if ms(clock.now - t0) > 120_000 { return [.fail("materialise bank ≤ 1.5 s", "still counting after 120 s")] }
        try await Task.sleep(for: .milliseconds(20))
        state = try await atlas.expression(tracked.expression.id).state
      }
      let total = ms(clock.now - t0)
      guard state.status == "ready" else { return [.fail("materialise bank ≤ 1.5 s", "counting ended \(state.status)")] }
      if tracked.state.status != "materializing" {
        return [.info("materialise bank ≤ 1.5 s", "bank was already counted in this atlas (\(state.n ?? 0) matches); nothing was timed")]
      }
      return [timed("materialise bank ≤ 1.5 s", total, budget: 1500, "; \(state.n ?? 0) matches in \(state.docs ?? 0) documents")]
    } catch {
      return [.fail("materialise bank ≤ 1.5 s", "\(error)")]
    }
  }

  /// The demo's first tracked expression in one viewport: cold tiles, then the same tiles warm.
  static func tilesTiming(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("tiles", "no atlas is open")] }
    do {
      let q = try await atlas.timelineQuery(TimelineQueryRequest(strands: [StrandRequest(type: "expression", ref: .int(1))],
                                                                 corpus: "demo", lanes: LanesRequest(facet: "community")))
      guard q.status == "ready" else { return [.pending("tiles", "the demo expression is still being counted (\(q.status))")] }
      // the L2 tiles of 1890–2026: a full-width viewport of the demo
      let clock = ContinuousClock()
      let t0 = clock.now
      let cold = try await atlas.tiles(TilesRequest(q: q.queryKey, tier: "L2", tiles: "2..3"))
      let coldMs = ms(clock.now - t0)
      let t1 = clock.now
      _ = try await atlas.tiles(TilesRequest(q: q.queryKey, tier: "L2", tiles: "2..3"))
      let warmMs = ms(clock.now - t1)
      let cells = cold.tiles.reduce(0) { $0 + $1.lanes.values.reduce(0) { $0 + $1.strands.values.reduce(0) { $0 + $1.count } } }
      return [timed("tiles cold ≤ 120 ms", coldMs, budget: 120, "; \(cells) cells"), timed("tiles warm ≤ 16 ms", warmMs, budget: 16)]
    } catch {
      return [.fail("tiles", "\(error)")]
    }
  }

  static func termTrail(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    [.pending("Term trail first query ≤ 1.5 s", "the Term trail (C2) is package N3's milestone M2 work")]
  }

  /// 20 marks of *carry the zero* (demo): each opens at its occurrence's exact offsets.
  static func marksAtExactOffsets(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let atlas = ctx.model.atlas else { return [.pending("20 marks at exact offsets", "no atlas is open")] }
    do {
      let q = try await atlas.timelineQuery(TimelineQueryRequest(strands: [StrandRequest(type: "expression", ref: .int(1))],
                                                                 corpus: "demo", lanes: LanesRequest(facet: "community")))
      guard q.status == "ready" else { return [.pending("20 marks at exact offsets", "the demo expression is still being counted")] }
      let marks = try await atlas.marks(MarksRequest(q: q.queryKey, limit: 4000)).marks.filter { $0.occ != nil }
      guard !marks.isEmpty else { return [.fail("20 marks at exact offsets", "no marks")] }
      let step = max(1, marks.count / 20)
      let sample = stride(from: 0, to: marks.count, by: step).prefix(20).map { marks[$0] }
      var bad: [String] = []
      for m in sample {
        guard let occ = m.occ else { continue }
        let o = try await atlas.occurrence(occ)
        let p = try await atlas.passage(m.passage, PassageRequest(expr: o.expr, occ: occ))
        guard let h = p.highlights.first(where: { $0.occ == occ }) else { bad.append("occ \(occ.rawValue): no highlight"); continue }
        if h.start != o.start - p.start || h.end != o.end - p.start {
          bad.append("occ \(occ.rawValue): highlight [\(h.start), \(h.end)) ≠ [\(o.start - p.start), \(o.end - p.start))")
          continue
        }
        let units = Array(p.text.utf16)
        guard h.end <= units.count else { bad.append("occ \(occ.rawValue): highlight past the passage"); continue }
        let cut = String(decoding: units[h.start..<h.end], as: UTF16.self)
        let folded = Tokenizer.tokens(cut).tokens.joined(separator: " ")
        if !["carry the zero", "carries the zero", "carried the zero", "carrying the zero"].contains(folded) {
          bad.append("occ \(occ.rawValue): '\(cut)' is not a counted form")
        }
      }
      return bad.isEmpty ? [.pass("\(sample.count) marks at exact offsets", "every highlight sits at its occurrence's offsets and reads a counted form")]
        : [.fail("\(sample.count) marks at exact offsets", "\(bad.count) wrong: \(bad.prefix(3).joined(separator: "; "))")]
    } catch {
      return [.fail("20 marks at exact offsets", "\(error)")]
    }
  }
}

extension SelfTestCatalog {
  static var n3: (any SelfTestSteps.Type)? { N3Steps.self }
}
