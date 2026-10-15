import Foundation
import Testing
import OfflineIntelligence
@testable import ScrollsQwen

@Suite("Shared offline generation")
struct SharedGenerationBridgeTests {
  private var request: GenerateRequest {
    .init(task: .label, promptID: "label@1", system: "Use only supplied passages.", user: "Word: bank",
          schema: LabelSchema.json(ids: ["P1", "P2", "P3"]), maxTokens: 160, prefillStep: 256, wallLimitSeconds: 90)
  }

  @Test func schemaIsRequestedWithOriginalTaskAndConservativeBudget() throws {
    let shared = SharedGenerationBridge.request(request)
    try shared.validate()
    #expect(shared.prompt == request.user)
    #expect(shared.system.hasPrefix(request.system))
    #expect(shared.system.contains(request.schema))
    #expect(shared.maxOutputTokens == 160)
    #expect(shared.maxPromptTokens == 1024 && shared.maxContextTokens == 4096)
    #expect(shared.temperature == 0 && shared.topP == 1 && shared.seed == 42)
    #expect(shared.timeoutSeconds == 90)
  }

  @Test func lengthCancellationAndTimeoutCannotBecomeAcceptedLabels() {
    for (finish, expected) in [(GenerationFinishReason.length, GenerateResult.Stop.incompleteOutput),
                               (.cancelled, .cancelled), (.timeout, .wallLimit)] {
      let metrics = GenerationMetrics(promptTokens: 100, generatedTokens: 20, firstTokenSeconds: 0.4,
                                      generationSeconds: 2, decodeSeconds: 1.5,
                                      peakFootprintBytes: 1_000_000, mlxPeakAllocatedBytes: 900_000, finishReason: finish)
      let result = SharedGenerationBridge.result(raw: "{\"label\":\"bank\"}", metrics: metrics,
                                                 request: SharedGenerationBridge.request(request),
                                                 model: OfflineIntelligence.ModelCatalog.qwen2B)
      #expect(result.stop == expected)
      #expect(result.stop != .accepted)
      #expect(result.sharedMetrics == metrics)
      #expect(result.grammar.contains("unconstrained"))
      #expect(result.grammarCompileMs == 0)
    }
  }

  @Test func completeOutputStillRequiresScrollsCitationAndDomainChecks() throws {
    let raw = "{\"label\":\"river bank\",\"gloss\":\"The edge of a river.\",\"cites\":[\"P1\",\"NOT_GIVEN\"]}"
    let metrics = GenerationMetrics(promptTokens: 100, generatedTokens: 25, firstTokenSeconds: 0.5,
                                    generationSeconds: 2, decodeSeconds: 1.2,
                                    peakFootprintBytes: 1_000_000, mlxPeakAllocatedBytes: 900_000, finishReason: .stop)
    let result = SharedGenerationBridge.result(raw: raw, metrics: metrics,
                                               request: SharedGenerationBridge.request(request),
                                               model: OfflineIntelligence.ModelCatalog.qwen4B)
    #expect(result.stop == .accepted)
    if case .failure(let rejection) = LabelValidator.validate(raw: result.raw, ids: ["P1", "P2"]) {
      #expect(rejection.reasons.contains { $0.contains("not given") })
    } else { Issue.record("Ungrounded citations must remain rejected after shared inference") }
    #expect(result.modelRevision == OfflineIntelligence.ModelCatalog.qwen4B.revision)
    #expect(result.modelName == "Qwen3.5 4B")
    #expect(try JSONDecoder().decode(GenerateResult.self, from: JSONEncoder().encode(result)) == result)
  }

  @Test func legacyReportsDecodeWithoutInventingNewModelProvenance() throws {
    let json = "{\"raw\":\"{}\",\"stop\":\"accepted\",\"tokensIn\":20,\"tokensOut\":2,\"prefillMs\":3,\"decodeMs\":4,\"grammarCompileMs\":1,\"grammar\":\"as written\"}"
    let result = try JSONDecoder().decode(GenerateResult.self, from: Data(json.utf8))
    #expect(result.modelID == nil && result.modelRevision == nil && result.sharedMetrics == nil)
    #expect(result.grammar == "as written")
  }

  @Test func defaultAndOptionalChoicesMatchSharedPinnedCatalog() {
    #expect(OfflineModelChoice.defaultChoice == .qwen2B)
    #expect(ScrollsQwen.ModelCatalog.generator.name == OfflineModelChoice.qwen2B.resourceFolder)
    #expect(ScrollsQwen.ModelCatalog.generator4B.name == OfflineModelChoice.qwen4B.resourceFolder)
    #expect(ScrollsQwen.ModelCatalog.generator.upstream.contains(OfflineModelChoice.qwen2B.descriptor.revision))
    #expect(ScrollsQwen.ModelCatalog.generator4B.upstream.contains(OfflineModelChoice.qwen4B.descriptor.revision))
    #expect(ScrollsQwen.ModelCatalog.active(.qwen2B).map(\.name) == ["Qwen3-Embedding-0.6B-8bit", "qwen-2b"])
    #expect(ScrollsQwen.ModelCatalog.active(.qwen4B).map(\.name) == ["Qwen3-Embedding-0.6B-8bit", "qwen-4b"])
  }
}
