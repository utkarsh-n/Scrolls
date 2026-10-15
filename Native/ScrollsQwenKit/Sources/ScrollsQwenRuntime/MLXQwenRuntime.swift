// OWNER: Q (created by the bring-up, B2)
// `QwenRuntime` over MLX (IOS-SPEC-QWEN §2.3): the app, the demo and the self-test talk to this; it delegates
// residency to `ModelManager` and decisions to the pure `ScrollsQwen`.

import Foundation
import OfflineIntelligence
import ScrollsQwen

public final class MLXQwenRuntime: QwenRuntime {
  public let manager: ModelManager
  public let store: ModelStore
  public let interaction: InteractionSignal
  public let info: RuntimeInfo

  public init(modelsRoot: URL = ModelStore.defaultRoot, budgets: QwenBudgets = .provisional,
              residency: ResidencyPolicy = .standard, interaction: InteractionSignal = InteractionSignal(),
              generationChoice: OfflineModelChoice = .defaultChoice) {
    store = ModelStore(root: modelsRoot)
    self.interaction = interaction
    manager = ModelManager(store: store, budgets: budgets, residency: residency, interaction: interaction,
                           generationChoice: generationChoice)
    info = RuntimeInfo(runtime: RuntimeInfo.versions, device: Footprint.machine, osBuild: Footprint.osBuild,
                       builtOn: Footprint.builtOn, mlxDevice: MLXSetup.deviceName)
  }

  public func installed() async -> [ModelStatus] { store.status() }

  public func setGenerationChoice(_ choice: OfflineModelChoice) async throws {
    try await manager.setGenerationChoice(choice)
  }

  public func countTokens(_ texts: [String], role: ModelRole) async throws -> [Int] {
    try await manager.countTokens(texts, role: role)
  }

  public func embed(_ texts: [String], plan: BatchPlan, dims: Int, priority: QwenPriority,
                    progress: @escaping @Sendable (Int, Int) -> Void) async throws -> [[Float]] {
    try await manager.embed(texts, plan: plan, dims: dims, progress: progress).vectors
  }

  public func generate(_ r: GenerateRequest, priority: QwenPriority,
                       progress: @escaping @Sendable (GenerateProgress) -> Void) async throws -> ScrollsQwen.GenerateResult {
    try await manager.generate(r, progress: progress)
  }

  public func unload(_ reason: UnloadReason) async { await manager.unloadNow(reason) }
}
