// OWNER: Q (created by the bring-up, B2)
// `-selftest qwen` (IOS-SPEC-QWEN §2.9 rows, critique §4.2 M1a): writes Documents/qwen-selftest.json.
//   S4  speeds and footprints: embedder load + 64 R1 windows at batch 8; 4B load + one label prompt at step 256
//   S5  the label JSON round trip (validate → canonical bytes → decode → equal) and greedy determinism (same bytes twice)
//   S6  vector parity: the bundled sample against the Python MLX reference (cos ≥ 0.999 each)
//   S7  cancellation (embedding between batches, generation per token; acknowledged ≤ 500 ms) and unload (footprint
//       back within 300 MB of the pre-load baseline)
// Speeds are INFO rows (there is no bar until the phone has been measured); the rest PASS or FAIL.

import Foundation
import ScrollsQwen

public enum QwenSelfTest {
  public static func run(demo set: DemoSet, parity: ParitySample?, runtime: MLXQwenRuntime, appBuild: String,
                         step: @escaping @Sendable (DemoStep) -> Void) async -> SelfTestReport {
    let generationModel = await runtime.manager.generationChoice
    let modelName = ScrollsQwen.ModelCatalog.generation(generationModel).display
    let t0 = Date()
    var r = SelfTestReport(at: ISO8601DateFormatter().string(from: t0), info: runtime.info, appBuild: appBuild)
    let baseline = Footprint.sample("baseline (no model)")
    r.memory.append(baseline)
    func row(_ id: String, _ name: String, _ status: ProbeCheck.Status, _ detail: String, _ numbers: [String: Double] = [:]) {
      r.rows.append(ProbeCheck(id: id, name: name, status: status, detail: detail, numbers: numbers))
    }
    func mb(_ b: Int?) -> String { b.map { QwenCopy.mb($0) } ?? "n/a" }
    r.rows.append(ProbeCheck(id: "S0", name: "where it ran", status: .info,
                             detail: "\(runtime.info.device) · \(runtime.info.osBuild) · MLX on \(runtime.info.mlxDevice) · built on \(runtime.info.builtOn.rawValue)",
                             numbers: ["available_at_start": Double(baseline.available ?? -1), "footprint_at_start": Double(baseline.footprint ?? -1)]))
    for spec in await runtime.manager.activeModels {
      let s = runtime.store.verify(spec) { f in step(DemoStep("sha256 \(spec.display)", f)) }
      let ok = s.state == .verified
      row("S1-\(spec.role.rawValue)", "\(spec.display) files and sha256", ok ? .pass : .fail,
          s.verification.map { "\($0.summary) in \(String(format: "%.1f", $0.seconds)) s" } ?? QwenCopy.modelsMissing)
    }
    if r.rows.contains(where: { $0.status == .fail }) {
      r.status = SelfTestReport.status(r.rows)
      r.totalSeconds = Date().timeIntervalSince(t0)
      return r
    }
    do {
      // ── embedder ─────────────────────────────────────────────────────────────────────────────────────────────
      step(DemoStep("S4: loading the embedder"))
      let load = try await runtime.manager.ensure(.embedder)
      if let load { r.loads.append(load) }
      r.memory.append(Footprint.sample("embedder loaded"))
      if let parity {
        step(DemoStep("S6: parity with the Python reference (\(parity.items.count) windows)"))
        let (vs, toks) = try await runtime.manager.embed(parity.items.map(\.input), plan: BatchPlan(batchSize: 8), dims: parity.dims) { _, _ in }
        let cos = zip(vs, parity.items).map { VectorMath.cosine($0, $1.vector) }
        let mismatched = zip(toks, parity.items).filter { $1.tokens != nil && $0 != $1.tokens! }.count
        let minCos = cos.min() ?? 0
        row("S6", "vectors against Python MLX (\(parity.runtime))", minCos >= 0.999 && !cos.isEmpty ? .pass : .fail,
            String(format: "%d windows, plan %@: cos min %.5f, mean %.5f; token counts differ on %d", cos.count, parity.plan, minCos,
                   cos.reduce(0, +) / Double(max(1, cos.count)), mismatched),
            ["cos_min": minCos, "cos_mean": cos.reduce(0, +) / Double(max(1, cos.count)), "token_mismatches": Double(mismatched)])
      } else {
        row("S6", "vectors against Python MLX", .fail, "the parity sample is missing from the app bundle")
      }
      let base = try await QwenDemoRunner.inputs(set, runtime: runtime)
      var texts = base.map(\.input)
      while texts.count < 64 { texts.append(base[texts.count % base.count].input) }
      step(DemoStep("S4: 64 windows at batch 8"))
      let sampler = PeakSampler()
      sampler.start()
      let te = Date()
      let (_, tokens) = try await runtime.manager.embed(texts, plan: .standard, dims: 256) { d, t in
        step(DemoStep("S4: \(d) of \(t) windows", Double(d) / Double(t)))
      }
      let secs = Date().timeIntervalSince(te)
      let peak = sampler.stop()
      let run = EmbedRun(windows: texts.count, plan: BatchPlan.standard.key, dims: 256, seconds: secs, tokens: tokens, peakFootprint: peak)
      row("S4-embed", "embedder speed and footprint", .info,
          String(format: "load %.2f s (resident +%@); %d windows (%d–%d tokens) in %.2f s = %.1f windows/s; peak footprint %@",
                 load?.seconds ?? 0, mb(load?.residentDelta), run.windows, run.tokensMin, run.tokensMax, secs, run.windowsPerSecond, mb(peak)),
          ["load_s": load?.seconds ?? 0, "windows_per_s": run.windowsPerSecond, "peak_footprint": Double(peak ?? 0)])
      // S7a: cancel between embedding batches (batch 1, so a boundary comes quickly)
      step(DemoStep("S7: cancelling an embedding run"))
      let started = Flag()
      let job = Task {
        try await runtime.manager.embed(texts, plan: BatchPlan(batchSize: 1), dims: 256) { d, _ in if d >= 1 { started.set() } }
      }
      await started.wait(timeout: 60)
      let tc = Date()
      job.cancel()
      let outcome = await job.result
      let ack = Date().timeIntervalSince(tc)
      let cancelled: Bool = if case .failure(let e) = outcome { e is CancellationError } else { false }
      row("S7-embed-cancel", "embedding cancelled between batches", cancelled && ack <= 0.5 ? .pass : .fail,
          String(format: "%@ %.0f ms after the cancel", cancelled ? "acknowledged" : "NOT cancelled (it finished)", ack * 1000), ["ack_ms": ack * 1000])
      await runtime.manager.unloadNow(.roleSwitch)
      try? await Task.sleep(for: .milliseconds(300))
      let afterEmbed = Footprint.sample("embedder unloaded")
      r.memory.append(afterEmbed)
      if let a = afterEmbed.footprint, let b = baseline.footprint {
        row("S7-embed-unload", "embedder unload returns memory", a - b <= 300_000_000 ? .pass : .fail,
            "footprint \(mb(a)) after unload against \(mb(b)) before any load (bar: +300 MB)", ["delta": Double(a - b)])
      }
      // ── generator ────────────────────────────────────────────────────────────────────────────────────────────
      step(DemoStep("S4: loading \(modelName)"))
      let gload = try await runtime.manager.ensure(.generator)
      if let gload { r.loads.append(gload) }
      r.memory.append(Footprint.sample("\(modelName) loaded"))
      // one label prompt built from the demo's first five passages (the S4 shape: ≈ 450–550 tokens at step 256)
      let ps = Array(set.passages.prefix(5))
      let slots = PromptLibrary.slots(years: ps.map(\.year))
      let passages = ps.enumerated().map { i, p in
        PromptPassage(id: "P\(i + 1)", slot: slots[i], source: "book (Project Gutenberg)", title: p.title,
                      text: Excerpt.around(p.text, target: p.target, words: 25))
      }
      let prompt = PromptLibrary.label(word: set.word, computedWords: [], passages: passages)
      let promptTokens = try await runtime.countTokens([QwenChat.render(system: prompt.system, user: prompt.user)], role: .generator)[0]
      let request = GenerateRequest(task: .label, promptID: prompt.promptID, system: prompt.system, user: prompt.user,
                                    schema: LabelSchema.json(ids: passages.map(\.id)), maxTokens: LabelSchema.outputCap,
                                    prefillStep: PrefillPlan.step(promptTokens: promptTokens))
      step(DemoStep("S4/S5: label prompt, first run"))
      let first = try await runtime.manager.generate(request) { _ in }
      row("S4-generate", "\(modelName) speed and footprint", first.stop == .accepted ? .info : .fail,
          String(format: "load %.2f s (resident +%@); %d prompt tokens at step %d: prefill %.1f tok/s; %d output tokens: decode %.1f tok/s; peak footprint %@; stop %@",
                 gload?.seconds ?? 0, mb(gload?.residentDelta), first.tokensIn, 128, first.prefillTokensPerSecond,
                 first.tokensOut, first.decodeTokensPerSecond, mb(first.peakFootprint), first.stop.rawValue),
          ["load_s": gload?.seconds ?? 0, "prefill_tok_s": first.prefillTokensPerSecond, "decode_tok_s": first.decodeTokensPerSecond,
           "prompt_tokens": Double(first.tokensIn), "peak_footprint": Double(first.peakFootprint ?? 0)])
      step(DemoStep("S5: the same prompt again"))
      let second = try await runtime.manager.generate(request) { _ in }
      let same = first.raw == second.raw
      let greedyDetail: String = same
        ? "identical bytes (\(first.raw.utf8.count) B); grammar: \(first.grammar), compiled in \(first.grammarCompileMs) ms"
        : "outputs differ: «\(first.raw)» vs «\(second.raw)»"
      row("S5-greedy", "greedy determinism (same prompt twice)", same && first.stop == .accepted ? .pass : .fail, greedyDetail)
      switch LabelValidator.validate(raw: first.raw, ids: passages.map(\.id)) {
      case .success(let out):
        let canon = LabelValidator.canonical(out)
        let back = try? JSONDecoder().decode(LabelOutput.self, from: Data(canon.utf8))
        let v = Verifier.verifyLabel(out, passages: passages)
        row("S5-json", "label JSON round trip and checks", back == out ? .pass : .fail,
            "\(canon) · verifier: \(v.verdict.rawValue)\(v.withheld.isEmpty ? "" : " (" + v.withheld.joined(separator: "; ") + ")")")
      case .failure(let e):
        row("S5-json", "label JSON round trip and checks", .fail, "raw «\(first.raw)» rejected: \(e.reasons.joined(separator: "; "))")
      }
      // S7b: cancel during decoding
      step(DemoStep("S7: cancelling a generation"))
      let decoding = Flag()
      let gjob = Task {
        try await runtime.manager.generate(request) { p in if case .tokens(let n) = p, n >= 2 { decoding.set() } }
      }
      await decoding.wait(timeout: 120)
      let gc = Date()
      gjob.cancel()
      let gout = await gjob.result
      let gack = Date().timeIntervalSince(gc)
      let gstop: String = switch gout {
      case .success(let res): res.stop.rawValue
      case .failure(let e): "\(e)"
      }
      row("S7-generate-cancel", "generation cancelled per token", gstop == "cancelled" && gack <= 0.5 ? .pass : .fail,
          String(format: "stop %@ %.0f ms after the cancel (cancel during prefill waits for the current chunk: not measured here)", gstop, gack * 1000),
          ["ack_ms": gack * 1000])
      await runtime.manager.unloadNow(.user)
      try? await Task.sleep(for: .milliseconds(300))
      let after = Footprint.sample("\(modelName) unloaded")
      r.memory.append(after)
      if let a = after.footprint, let b = baseline.footprint {
        row("S7-generate-unload", "\(modelName) unload returns memory", a - b <= 300_000_000 ? .pass : .fail,
            "footprint \(mb(a)) after unload against \(mb(b)) before any load (bar: +300 MB)", ["delta": Double(a - b)])
      }
    } catch {
      await runtime.manager.unloadNow(.user)
      row("S-error", "self-test stopped", .fail, "\(error)")
    }
    r.status = SelfTestReport.status(r.rows)
    r.totalSeconds = Date().timeIntervalSince(t0)
    return r
  }
}

/// A one-shot signal awaited with a timeout.
final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var isSet = false
  func set() { lock.lock(); isSet = true; lock.unlock() }
  var value: Bool { lock.lock(); defer { lock.unlock() }; return isSet }
  func wait(timeout: Double) async {
    let end = Date().addingTimeInterval(timeout)
    while !value && Date() < end { try? await Task.sleep(for: .milliseconds(10)) }
  }
}
