// OWNER: Q (created by the bring-up, B2)
// The live demonstration behind "Qwen on this iPhone" (and `scrolls-qwen demo` on the Mac): verify both models; load
// the embedder; read the bundled 'bank' passages (R1, ±24 words, ≤ 128 tokens, batch 8, 256 dims); unload; centre and
// split with k-means (k = 2); load Qwen3-4B; label each group with `label@1` (one call per group, greedy, guided);
// validate and verify each label; unload. Every step's time, footprint and outcome goes into a `DemoReport`.

import Foundation
import ScrollsQwen

public struct DemoStep: Sendable, Equatable {
  public var text: String
  public var fraction: Double?
  public init(_ text: String, _ fraction: Double? = nil) {
    self.text = text
    self.fraction = fraction
  }
}

public enum QwenDemoRunner {
  /// Fits every passage's R1 input under the 128-token cap, shrinking a word per side at a time where needed.
  public static func inputs(_ set: DemoSet, runtime: MLXQwenRuntime, maxTokens: Int = 128) async throws -> [EmbeddingInput] {
    var words = [Int](repeating: 24, count: set.passages.count)
    var result = [EmbeddingInput?](repeating: nil, count: set.passages.count)
    while true {
      let pending = set.passages.indices.filter { result[$0] == nil }
      if pending.isEmpty { break }
      let rendered = pending.map { i -> EmbeddingInput in
        let p = set.passages[i]
        let w = ContextWindow.make(passageText: p.text, target: p.target, rule: .words(words[i]))
        return EmbeddingInput(id: p.id, input: EmbeddingTemplate.occInstr1.render(w, expression: set.word), words: words[i], thin: w.isThin)
      }
      let counts = try await runtime.countTokens(rendered.map(\.input), role: .embedder)
      for (k, i) in pending.enumerated() {
        if counts[k] + 1 <= maxTokens || words[i] == 0 { result[i] = rendered[k] } else { words[i] -= 1 }
      }
    }
    return result.compactMap { $0 }
  }

  public static func run(set: DemoSet, runtime: MLXQwenRuntime, appBuild: String,
                         step: @escaping @Sendable (DemoStep) -> Void) async -> DemoReport {
    let generationModel = await runtime.manager.generationChoice
    let modelName = ScrollsQwen.ModelCatalog.generation(generationModel).display
    let t0 = Date()
    var report = DemoReport(at: ISO8601DateFormatter().string(from: t0), info: runtime.info, appBuild: appBuild,
                            word: set.word, selection: set.selection, source: set.source)
    report.memory.append(Footprint.sample("start"))
    func finish(_ status: String) -> DemoReport {
      report.memory.append(Footprint.sample("end"))
      report.totalSeconds = Date().timeIntervalSince(t0)
      report.status = status
      return report
    }
    // 1. models
    step(DemoStep("Checking the model files (sha256)…"))
    for spec in await runtime.manager.activeModels {
      let s = runtime.store.verify(spec) { f in step(DemoStep("Checking \(spec.display) (sha256)…", f)) }
      if let v = s.verification { report.models.append(v) }
      if s.state != .verified {
        report.problems.append(s.state == .missing ? "\(spec.name): \(QwenCopy.modelsMissing)" : "\(spec.name): \(s.verification?.summary ?? "not checked")")
      }
    }
    if !report.problems.isEmpty { return finish("models missing or not matching the catalogue") }
    // 2. read the passages
    do {
      step(DemoStep("Loading Qwen3-Embedding-0.6B…"))
      if let load = try await runtime.manager.ensure(.embedder) { report.loads.append(load) }
      report.memory.append(Footprint.sample("embedder loaded"))
      step(DemoStep("Fitting \(set.passages.count) windows (±24 words, ≤ 128 tokens)…"))
      let inputs = try await inputs(set, runtime: runtime)
      let sampler = PeakSampler()
      sampler.start()
      let te = Date()
      let n = inputs.count
      let (vectors, tokens) = try await runtime.manager.embed(inputs.map(\.input), plan: .standard, dims: 256) { done, total in
        step(DemoStep("Reading contexts: \(done) of \(total)", Double(done) / Double(max(1, total))))
      }
      let seconds = Date().timeIntervalSince(te)
      report.embed = EmbedRun(windows: n, plan: BatchPlan.standard.key, dims: 256, seconds: seconds, tokens: tokens,
                              peakFootprint: sampler.stop())
      report.memory.append(Footprint.sample("after reading"))
      await runtime.manager.unloadNow(.roleSwitch)
      report.memory.append(Footprint.sample("embedder unloaded"))
      // 3. groups
      step(DemoStep("Grouping with k-means (k = 2)…"))
      let grouping = DemoGrouping.make(set, vectors: vectors)
      report.grouping = grouping
      // 4. labels
      step(DemoStep("Loading \(modelName)…"))
      if let load = try await runtime.manager.ensure(.generator) { report.loads.append(load) }
      report.memory.append(Footprint.sample("\(modelName) loaded"))
      for g in grouping.groups {
        let passages = DemoGrouping.promptPassages(g, set: set)
        let prompt = PromptLibrary.label(word: set.word, computedWords: g.promptWords, passages: passages)
        let promptTokens = try await runtime.countTokens([QwenChat.render(system: prompt.system, user: prompt.user)], role: .generator)[0]
        let request = GenerateRequest(task: .label, promptID: prompt.promptID, system: prompt.system, user: prompt.user,
                                      schema: LabelSchema.json(ids: passages.map(\.id)), maxTokens: LabelSchema.outputCap,
                                      prefillStep: PrefillPlan.step(promptTokens: promptTokens))
        let label = "group \(g.index + 1) of \(grouping.groups.count)"
        let result = try await runtime.manager.generate(request) { p in
          switch p {
          case .loading: step(DemoStep("\(modelName): loading…"))
          case .prefill(let done, let total): step(DemoStep("\(modelName) reads \(label): \(done) of \(total) prompt tokens", nil))
          case .tokens(let n): step(DemoStep("\(modelName) writes \(label): \(n) pieces", nil))
          }
        }
        var verified: VerifiedLabel?
        var rejection: [String] = []
        if result.stop == .accepted {
          switch LabelValidator.validate(raw: result.raw, ids: passages.map(\.id)) {
          case .success(let out): verified = Verifier.verifyLabel(out, passages: passages)
          case .failure(let r): rejection = r.reasons
          }
        } else {
          rejection = [result.stop == .incompleteOutput ? QwenCopy.stoppedAtCap : "stopped: \(result.stop.rawValue)\(result.error.map { " (\($0))" } ?? "")"]
        }
        report.labels.append(DemoLabel(group: g.index, promptID: prompt.promptID, promptSHA256: prompt.promptSHA256,
                                       passages: passages, result: result, verified: verified, rejection: rejection,
                                       badge: QwenCopy.machineBadge(runtime.info.builtOn, model: modelName)))
        report.memory.append(Footprint.sample("after label \(g.index + 1)"))
      }
      await runtime.manager.unloadNow(.user)
      report.memory.append(Footprint.sample("\(modelName) unloaded"))
      step(DemoStep("Done", 1))
      return finish("done")
    } catch is CancellationError {
      await runtime.manager.unloadNow(.user)
      return finish("cancelled")
    } catch {
      await runtime.manager.unloadNow(.user)
      report.problems.append("\(error)")
      return finish("failed")
    }
  }
}

public enum ReportFile {
  public static func write<T: Encodable>(_ value: T, to url: URL) throws {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try enc.encode(value).write(to: url, options: .atomic)
  }
}
