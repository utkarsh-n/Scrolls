// Scrolls' specialist embedder and shared text runtime share one residency coordinator.
// Work admission remains closed across awaits; unload cancels and drains active work before releasing MLX weights.
import Foundation
import MLX
import MLXEmbedders
import MLXLMCommon
import OfflineIntelligence
import OfflineIntelligenceMLX
import ScrollsQwen

public actor ModelManager {
  public enum State: Sendable, Equatable { case none, loading(ModelRole), resident(ModelRole) }
  public private(set) var state: State = .none
  public private(set) var loads: [LoadRecord] = []
  public private(set) var generationChoice: OfflineModelChoice
  public nonisolated let events: AsyncStream<ModelEvent>
  private let continuation: AsyncStream<ModelEvent>.Continuation
  let store: ModelStore
  let budgets: QwenBudgets
  let residency: ResidencyPolicy
  let interaction: InteractionSignal
  private let shared: any IntelligenceRuntime
  private let embeddingLease = MLXExternalModelLease()
  private var embedder: EmbedderModelContainer?
  private var generatorTokenizer: (any MLXLMCommon.Tokenizer)?
  private var verified: Set<String> = []
  private var lastUse = Date()
  private var idleTask: Task<Void, Never>?
  private var workID: UUID?
  private var cancelWork: (@Sendable () -> Void)?
  private var workWaiters: [CheckedContinuation<Void, Never>] = []
  private var unloading = false
  private var unloadWaiters: [CheckedContinuation<Void, Never>] = []
  public private(set) var thermalRestriction: ThermalLevel = .nominal

  public init(store: ModelStore, budgets: QwenBudgets = .provisional, residency: ResidencyPolicy = .standard,
              interaction: InteractionSignal = InteractionSignal(), generationChoice: OfflineModelChoice = .defaultChoice,
              sharedRuntime: any IntelligenceRuntime = MLXIntelligenceRuntime.shared) {
    self.store = store; self.budgets = budgets; self.residency = residency
    self.interaction = interaction; self.generationChoice = generationChoice; self.shared = sharedRuntime
    (events, continuation) = AsyncStream.makeStream(of: ModelEvent.self, bufferingPolicy: .bufferingNewest(64))
    MLXSetup.configure()
  }

  public var residentRole: ModelRole? { if case .resident(let role) = state { role } else { nil } }
  public var activeModels: [ModelSpec] { ScrollsQwen.ModelCatalog.active(generationChoice) }

  public func setGenerationChoice(_ choice: OfflineModelChoice) async throws {
    guard !unloading, workID == nil else { throw IntelligenceError.busy }
    guard generationChoice != choice else { return }
    // Close admission until the old backend releases its weights and process-wide lease.
    unloading = true
    await unloadResident(.roleSwitch)
    generationChoice = choice
    unloading = false
    resumeUnloadWaiters()
  }

  /// Reject overlapping feature work rather than allowing two actor frames to load different models.
  private func withWork<Value: Sendable>(_ operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
    guard !unloading, workID == nil else { throw IntelligenceError.busy }
    try Task.checkCancellation()
    let id = UUID()
    workID = id
    let task = Task { try await operation() }
    cancelWork = { task.cancel() }
    defer {
      if workID == id {
        workID = nil; cancelWork = nil
        let waiters = workWaiters; workWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        if !unloading { touch() }
      }
    }
    return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
  }

  @discardableResult
  public func ensure(_ role: ModelRole) async throws -> LoadRecord? {
    try await withWork { try await self.ensureImpl(role) }
  }

  private func ensureImpl(_ role: ModelRole) async throws -> LoadRecord? {
    try await MLXForegroundExecution.prepare()
    try Task.checkCancellation()
    lastUse = Date()
    if residentRole == role { return nil }
    await unloadResident(.roleSwitch)
    let spec = role == .embedder ? ScrollsQwen.ModelCatalog.embedder : ScrollsQwen.ModelCatalog.generation(generationChoice)
    if !verified.contains(spec.name) {
      let status = store.verify(spec)
      guard status.state == .verified else { throw QwenModelError.notVerified(spec.name, status.verification?.summary ?? QwenCopy.modelsMissing) }
      verified.insert(spec.name)
    }
    if role == .embedder,
       case .refuse(let needed, let available) = ModelAdmission.canLoad(budgets.embedder, available: Footprint.available, headroom: budgets.modelHeadroom) {
      continuation.yield(.refused(role, needed: needed, available: available))
      throw QwenRefused(role: role, needed: needed, available: available)
    }
    state = .loading(role); continuation.yield(.loading(role))
    let before = Footprint.footprint, start = Date()
    do {
      // Hash verification can outlive a foreground transition; recheck immediately before residency allocation.
      try await MLXForegroundExecution.prepare()
      try Task.checkCancellation()
      switch role {
      case .embedder:
        // The shared backend is unloaded and drained before specialist MLX allocation is admitted.
        try embeddingLease.acquire()
        Memory.cacheLimit = residency.cacheLimitBytes
        embedder = try await EmbedderModelFactory.shared.loadContainer(from: store.folder(spec), using: TransformersTokenizerLoader())
      case .generator:
        _ = try await shared.load(model: generationChoice.descriptor, directory: store.folder(spec))
        generatorTokenizer = try await TransformersTokenizerLoader().load(from: store.folder(spec))
      }
      try Task.checkCancellation()
    } catch {
      await unloadResident(.roleSwitch)
      throw error
    }
    let after = Footprint.footprint
    let delta: Int? = if let after, let before { after - before } else { nil }
    let record = LoadRecord(role: role, seconds: Date().timeIntervalSince(start), residentDelta: delta)
    loads.append(record); state = .resident(role)
    continuation.yield(.resident(role, residentDelta: delta ?? 0, seconds: record.seconds))
    return record
  }

  /// Active embedding work must exit its container executor before its external process-wide lease is released.
  public func unloadNow(_ reason: UnloadReason) async {
    if unloading { await withCheckedContinuation { unloadWaiters.append($0) }; return }
    unloading = true
    idleTask?.cancel(); idleTask = nil
    if workID != nil {
      cancelWork?()
      await shared.cancel()
      if workID != nil { await withCheckedContinuation { workWaiters.append($0) } }
    }
    await unloadResident(reason)
    unloading = false; resumeUnloadWaiters()
  }

  private func unloadResident(_ reason: UnloadReason) async {
    idleTask?.cancel(); idleTask = nil
    let role: ModelRole? = if case .loading(let r) = state { r } else { residentRole }
    await shared.unload()
    generatorTokenizer = nil
    embedder = nil
    MLXForegroundExecution.synchronizeIfAllowed()
    Memory.clearCache()
    embeddingLease.release()
    state = .none
    if let role { continuation.yield(.unloaded(role, reason, footprintAfter: Footprint.footprint)) }
  }

  private func resumeUnloadWaiters() {
    let waiters = unloadWaiters; unloadWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  public func setThermalRestriction(_ thermal: ThermalLevel) {
    thermalRestriction = thermal
    if thermal >= .fair { continuation.yield(.paused(thermal)) }
  }

  private func touch() {
    lastUse = Date(); idleTask?.cancel()
    guard let role = residentRole else { return }
    let idle = residency.idle(role)
    idleTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(idle))
      guard !Task.isCancelled else { return }
      await self?.unloadIfIdle(role, idle: idle)
    }
  }

  private func unloadIfIdle(_ role: ModelRole, idle: Double) async {
    if workID == nil && residentRole == role && Date().timeIntervalSince(lastUse) >= idle - 0.5 { await unloadNow(.idle) }
  }

  public func countTokens(_ texts: [String], role: ModelRole) async throws -> [Int] {
    try await withWork {
      try await self.ensureImpl(role)
      return try await self.countResidentTokens(texts, role: role)
    }
  }

  private func countResidentTokens(_ texts: [String], role: ModelRole) async throws -> [Int] {
    switch role {
    case .embedder:
      guard let embedder else { throw QwenModelError.notResident(role) }
      return await embedder.perform { context in texts.map { context.tokenizer.encode(text: $0, addSpecialTokens: false).count } }
    case .generator:
      guard let generatorTokenizer else { throw QwenModelError.notResident(role) }
      return texts.map { generatorTokenizer.encode(text: $0, addSpecialTokens: false).count }
    }
  }

  public func embed(_ texts: [String], plan: BatchPlan, dims: Int,
                    progress: @escaping @Sendable (Int, Int) -> Void) async throws -> (vectors: [[Float]], tokens: [Int]) {
    try await withWork {
      try await self.ensureImpl(.embedder)
      return try await self.embedResident(texts, plan: plan, dims: dims, progress: progress)
    }
  }

  private func embedResident(_ texts: [String], plan: BatchPlan, dims: Int,
                             progress: @escaping @Sendable (Int, Int) -> Void) async throws -> (vectors: [[Float]], tokens: [Int]) {
    guard let embedder else { throw QwenModelError.notResident(.embedder) }
    let interaction = interaction, thermal = thermalRestriction
    return try await embedder.perform { context in
      try Embedder.run(context, texts: texts, plan: plan, dims: dims, interaction: interaction, thermal: thermal, progress: progress)
    }
  }

  public func generate(_ request: GenerateRequest, progress: @escaping @Sendable (GenerateProgress) -> Void) async throws -> ScrollsQwen.GenerateResult {
    try await withWork {
      progress(.loading)
      try await self.ensureImpl(.generator)
      return try await self.generateResident(request, progress: progress)
    }
  }

  private func generateResident(_ request: GenerateRequest, progress: @escaping @Sendable (GenerateProgress) -> Void) async throws -> ScrollsQwen.GenerateResult {
    let model = generationChoice.descriptor
    let sharedRequest = SharedGenerationBridge.request(request)
    try sharedRequest.validate()
    guard let generatorTokenizer else { throw QwenModelError.notResident(.generator) }
    let count = try generatorTokenizer.applyChatTemplate(messages: [
      ["role": "system", "content": sharedRequest.system], ["role": "user", "content": sharedRequest.prompt]
    ], tools: nil, additionalContext: ["enable_thinking": false]).count
    try sharedRequest.validateTokenCount(count, model: model)
    // The shared backend uses 128-token prefill chunks. Admit only when the Scroll is not being manipulated.
    interaction.waitWhileInteracting(limit: 10)
    try Task.checkCancellation()
    progress(.prefill(done: 0, total: count))
    var raw = "", pieces = 0
    var metrics: GenerationMetrics?
    do {
      let runtime = shared
      try await withTaskCancellationHandler {
        let stream = try await runtime.generate(sharedRequest)
        for try await event in stream {
          switch event {
          case .chunk(let chunk):
            if pieces == 0 { progress(.prefill(done: count, total: count)) }
            raw += chunk; pieces += 1; progress(.tokens(pieces))
          case .completed(let value): metrics = value
          }
        }
      } onCancel: { Task { await runtime.cancel() } }
    } catch {
      await shared.cancel()
      if !(error is CancellationError) { throw error }
    }
    if let metrics, !Task.isCancelled {
      return SharedGenerationBridge.result(raw: raw, metrics: metrics, request: sharedRequest, model: model)
    }
    await shared.cancel()
    if !Task.isCancelled { throw QwenModelError.missingCompletion }
    var result = ScrollsQwen.GenerateResult(raw: raw, stop: .cancelled, tokensIn: count, tokensOut: 0,
                                           prefillMs: 0, decodeMs: 0, grammarCompileMs: 0,
                                           grammar: "unconstrained; cancelled before completion metrics", peakFootprint: nil,
                                           error: "Generation cancelled before completion metrics.")
    result.modelID = model.id; result.modelName = ScrollsQwen.ModelCatalog.generation(generationChoice).display
    result.modelRevision = model.revision; result.sharedRequest = sharedRequest
    return result
  }
}

public enum QwenModelError: Error, CustomStringConvertible, Sendable {
  case notVerified(String, String), notResident(ModelRole), promptTooLong(Int), missingCompletion
  public var description: String {
    switch self {
    case .notVerified(let name, let why): "\(name): \(why)"
    case .notResident(let role): "\(role.rawValue) is not resident"
    case .promptTooLong(let count): "the prompt has \(count) tokens; the cap is \(PrefillPlan.promptCap)"
    case .missingCompletion: "Shared generation ended without completion metrics."
    }
  }
}

/// Where MLX computes. The iOS Simulator's Metal lacks what MLX's kernels need, so there MLX runs on the CPU
/// (`-qwen-device gpu` tries the GPU anyway); the phone and the Mac use the GPU.
public enum MLXSetup {
  nonisolated(unsafe) private static var done = false
  nonisolated(unsafe) public private(set) static var usesGPU = true
  private static let lock = NSLock()

  public static func configure() {
    lock.lock()
    defer { lock.unlock() }
    guard !done else { return }
    done = true
    #if targetEnvironment(simulator)
    let wantGPU = ProcessInfo.processInfo.arguments.contains("gpu")
      && ProcessInfo.processInfo.arguments.contains("-qwen-device")
    usesGPU = wantGPU
    #else
    usesGPU = !ProcessInfo.processInfo.arguments.contains("-qwen-cpu")
    #endif
    if !usesGPU { Device.setDefault(device: Device.cpu) }
  }

  public static var deviceName: String { usesGPU ? "gpu" : "cpu" }
}
