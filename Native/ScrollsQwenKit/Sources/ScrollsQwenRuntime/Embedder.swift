// OWNER: Q (created by the bring-up, B2)
// Contextual vectors (IOS-SPEC-QWEN §2.3 "Embedding", §3.2; QWEN-LAB §1.1): tokenise without special tokens and append
// <|endoftext|> (151643); sort by length; pad on the right with <|endoftext|>; run the model with its causal mask only
// (right padding sits after every real token, so no real token attends to it, exactly as the Python reference);
// pool the last real token (`Pooling(strategy: .last)` with the padding mask, no layer norm); normalise the full
// 1024 in f32, cut to `dims`, normalise again. Cancellation and the yield rule are checked between batches.

import Foundation
import MLX
import MLXEmbedders
import MLXLMCommon
import OfflineIntelligenceMLX
import ScrollsQwen

enum Embedder {
  static let endOfText = QwenChat.endOfTextID

  static func tokenize(_ tokenizer: any MLXLMCommon.Tokenizer, _ texts: [String], maxTokens: Int) -> [[Int]] {
    texts.map { t in
      var ids = tokenizer.encode(text: t, addSpecialTokens: false)
      if ids.count + 1 > maxTokens { ids = Array(ids.prefix(maxTokens - 1)) }   // inputs are fitted before; a guard only
      return ids + [endOfText]
    }
  }

  static func run(_ ctx: EmbedderModelContext, texts: [String], plan: BatchPlan, dims: Int, interaction: InteractionSignal,
                  thermal: ThermalLevel, progress: @Sendable (Int, Int) -> Void) throws -> (vectors: [[Float]], tokens: [Int]) {
    let ids = tokenize(ctx.tokenizer, texts, maxTokens: plan.maxTokens)
    let pooling = Pooling(strategy: .last)
    var out = [[Float]](repeating: [], count: texts.count)
    var done = 0
    for batch in plan.batches(tokenCounts: ids.map(\.count)) {
      try Task.checkCancellation()
      interaction.waitWhileInteracting(limit: 10)
      try Task.checkCancellation()
      guard MLXForegroundExecution.isAllowed else { throw CancellationError() }
      let t0 = Date()
      let width = batch.map { ids[$0].count }.max() ?? 1
      var flat: [Int32] = []
      var mask: [Int32] = []
      flat.reserveCapacity(batch.count * width)
      mask.reserveCapacity(batch.count * width)
      for i in batch {
        let x = ids[i]
        flat += x.map(Int32.init) + [Int32](repeating: Int32(endOfText), count: width - x.count)
        mask += [Int32](repeating: 1, count: x.count) + [Int32](repeating: 0, count: width - x.count)
      }
      let input = MLXArray(flat, [batch.count, width])
      let m = MLXArray(mask, [batch.count, width])
      let output = ctx.model(input, positionIds: nil, tokenTypeIds: nil, attentionMask: nil)
      let pooled = pooling(output, mask: m, normalize: false, applyLayerNorm: false).asType(.float32)
      eval(pooled)
      let hidden = pooled.dim(-1)
      let values = pooled.asArray(Float.self)
      for (r, i) in batch.enumerated() {
        let full = Array(values[(r * hidden)..<((r + 1) * hidden)])
        out[i] = VectorMath.matryoshka(VectorMath.normalized(full), dims: dims)
      }
      done += batch.count
      progress(done, texts.count)
      let rest = QwenMemoryPolicy.restAfterBatch(batchSeconds: Date().timeIntervalSince(t0), thermal: thermal)
      if rest.isFinite && rest > 0 { usleep(UInt32(min(rest, 5) * 1_000_000)) }
    }
    return (out, ids.map(\.count))
  }
}
