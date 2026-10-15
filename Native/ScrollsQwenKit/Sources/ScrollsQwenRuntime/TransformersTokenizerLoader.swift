import Foundation
import MLXLMCommon
import OfflineIntelligenceMLX

/// Tokenizer-only delegation to the same local bridge used by shared text inference.
/// Loading this bridge reads the bundled tokenizer/chat template without loading model weights.
public struct TransformersTokenizerLoader: MLXLMCommon.TokenizerLoader {
  public init() {}

  public func load(from directory: URL) async throws -> any MLXLMCommon.Tokenizer {
    try await LocalTokenizerLoader().load(from: directory)
  }
}
