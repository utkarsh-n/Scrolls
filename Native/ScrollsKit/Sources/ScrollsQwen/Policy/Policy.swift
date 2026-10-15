// OWNER: Q (created by the bring-up, B2)
// Memory, heat and scheduling policy (IOS-SPEC-QWEN §2.2, §2.5, §2.6; QWEN-LAB §2.2–§2.8). Pure decisions: the MLX
// runtime (ScrollsQwenKit) asks these and does what they say. Every number here is a Mac measurement or an estimate
// until the M1a probe replaces it with the phone's value; `source` says which.

import Foundation
import Synchronization

// MARK: - Batch and prefill plans

public struct BatchPlan: Codable, Sendable, Hashable {
  /// 8; 4 while the Scroll is visible (lab §2.8 R2).
  public var batchSize: Int
  /// Stable order (token length, input index): right padding wastes least.
  public var sortByTokenLength: Bool
  /// Per window, instruction and <|endoftext|> included.
  public var maxTokens: Int

  public init(batchSize: Int, sortByTokenLength: Bool = true, maxTokens: Int = 128) {
    self.batchSize = batchSize
    self.sortByTokenLength = sortByTokenLength
    self.maxTokens = maxTokens
  }

  public static let standard = BatchPlan(batchSize: 8)
  public static let interactive = BatchPlan(batchSize: 4)

  /// Recorded on every vector run: byte identity holds only within one plan (LAB-10).
  public var key: String { "b\(batchSize)/\(sortByTokenLength ? "len" : "input")/right/\(maxTokens)" }

  /// The batches, as lists of input indices: sorted by (length, index), cut every `batchSize`.
  public func batches(tokenCounts: [Int]) -> [[Int]] {
    let order = sortByTokenLength
      ? tokenCounts.indices.sorted { (tokenCounts[$0], $0) < (tokenCounts[$1], $1) }
      : Array(tokenCounts.indices)
    return stride(from: 0, to: order.count, by: max(1, batchSize)).map { Array(order[$0..<min(order.count, $0 + batchSize)]) }
  }
}

public enum PrefillPlan {
  /// 256 up to 1,024 prompt tokens, 128 above (lab §2.3: step 512 cost +148 MB of peak at 1k and was not faster).
  public static func step(promptTokens: Int) -> Int { promptTokens <= 1_024 ? 256 : 128 }
  /// M1–M2 cap on a prompt (2,048 only behind the S3 switch, §2.5).
  public static let promptCap = 1_024
}

// MARK: - Budgets and admission

public struct ModelBudget: Codable, Sendable, Equatable {
  /// The resident delta after a load.
  public var loadBytes: Int
  /// Peak − resident delta for the planned work shape.
  public var growthBytes: Int
  public var source: String
}

public struct QwenBudgets: Codable, Sendable, Equatable {
  public var embedder: ModelBudget
  public var generator: ModelBudget
  public var modelHeadroom: Int

  /// §2.5's provisional values (Mac MLX peaks).
  public static let provisional = QwenBudgets(
    embedder: ModelBudget(loadBytes: 633_000_000, growthBytes: 887_000_000,
                          source: "lab §2.2: Mac MLX 8 × 128 peaked 1.520 GB; weights 633 MB"),
    generator: ModelBudget(loadBytes: 2_265_000_000, growthBytes: 700_000_000,
                           source: "lab §2.3: Mac MLX 1k prompt, step 256 peaked 2.938 GB; weights 2.265 GB"),
    modelHeadroom: 600_000_000)

  public func budget(_ role: ModelRole) -> ModelBudget { role == .embedder ? embedder : generator }
}

public enum ModelAdmission {
  public enum Decision: Sendable, Equatable { case admit, refuse(needed: Int, available: Int) }

  /// Before a load: available − reservedByOthers ≥ load + growth + headroom. `available` nil (macOS, the simulator
  /// without a limit) admits: there is no jetsam limit to protect.
  public static func canLoad(_ b: ModelBudget, available: Int?, reservedByOthers: Int = 0, headroom: Int) -> Decision {
    guard let available else { return .admit }
    let needed = b.loadBytes + b.growthBytes + headroom
    return available - reservedByOthers >= needed ? .admit : .refuse(needed: needed, available: available - reservedByOthers)
  }

  /// After the load the weights already show in os_proc_available_memory(); hold only the growth.
  public static func heldAfterLoad(_ b: ModelBudget, measuredResidentDelta: Int, measuredPeak: Int?) -> Int {
    max(b.growthBytes, (measuredPeak ?? 0) - measuredResidentDelta)
  }
}

// MARK: - Residency, unloading, heat

public enum UnloadReason: String, Codable, Sendable {
  case background, memoryWarning, memoryPressureCritical, thermalCritical, idle, roleSwitch, user
}

public enum ThermalLevel: Int, Codable, Sendable, Comparable {
  case nominal, fair, serious, critical
  public static func < (a: ThermalLevel, b: ThermalLevel) -> Bool { a.rawValue < b.rawValue }
  public var word: String { ["nominal", "fair", "serious", "critical"][rawValue] }
}

public struct ResidencyPolicy: Codable, Sendable, Equatable {
  public var idleEmbedder: Double      // seconds
  public var idleGenerator: Double
  /// MLX's buffer cache limit while a model is resident (AttentionMachine's 16 MB, proven on his phone; §2.3's
  /// 64 MB for the 4B is an estimate M1a measures).
  public var cacheLimitBytes: Int
  public var unloadAtThermal: ThermalLevel

  public static let standard = ResidencyPolicy(idleEmbedder: 30, idleGenerator: 90, cacheLimitBytes: 16 << 20,
                                               unloadAtThermal: .critical)

  public func idle(_ role: ModelRole) -> Double { role == .embedder ? idleEmbedder : idleGenerator }
}

public enum QwenPriority: Int, Codable, Sendable, Comparable {
  case waiting = 0, reading = 1, labels = 2, readAll = 3
  public static func < (a: QwenPriority, b: QwenPriority) -> Bool { a.rawValue < b.rawValue }
}

/// What the memory guard does with a system event (§2.6 "Unload triggers" and the thermal table).
public enum QwenMemoryPolicy {
  public enum Event: Sendable, Equatable {
    case background, memoryWarning, memoryPressureCritical, thermal(ThermalLevel), lowPower(Bool)
  }
  public enum Action: Sendable, Equatable {
    case unload(UnloadReason)
    /// Serious heat: generation only for work he is waiting for; embedding rests 2 s between batches.
    case restrict(ThermalLevel)
    case none
  }

  public static func action(for e: Event, policy: ResidencyPolicy = .standard) -> Action {
    switch e {
    case .background: .unload(.background)
    case .memoryWarning: .unload(.memoryWarning)
    case .memoryPressureCritical: .unload(.memoryPressureCritical)
    case .thermal(let t) where t >= policy.unloadAtThermal: .unload(.thermalCritical)
    case .thermal(let t) where t >= .fair: .restrict(t)
    case .thermal, .lowPower: .none
    }
  }

  /// May new work of this priority start now?
  public static func mayStart(_ p: QwenPriority, generation: Bool, thermal: ThermalLevel, lowPower: Bool,
                              explicitRequest: Bool) -> Bool {
    if thermal >= .critical { return false }
    if lowPower && !explicitRequest { return false }
    if thermal == .serious { return generation ? p == .waiting : p <= .reading }
    return true
  }

  /// Rest after an embedding batch, as a fraction of the batch's own time (fair: 20%) or seconds (serious: 2 s).
  public static func restAfterBatch(batchSeconds: Double, thermal: ThermalLevel) -> Double {
    switch thermal {
    case .nominal: 0
    case .fair: 0.2 * batchSeconds
    case .serious: 2
    case .critical: .infinity
    }
  }
}

// MARK: - Yield to the Scroll

/// Set by the Scroll (N7) through the app's Qwen host; read by the runtime between batches and prefill chunks.
public final class InteractionSignal: Sendable {
  private let state = Mutex<(interacting: Bool, scrollVisible: Bool)>((false, false))

  public init() {}

  public func set(interacting: Bool, scrollVisible: Bool) {
    state.withLock { $0 = (interacting, scrollVisible) }
  }

  public var interacting: Bool { state.withLock { $0.interacting } }
  public var scrollVisible: Bool { state.withLock { $0.scrollVisible } }

  /// Blocks the calling thread (never the main thread) while interacting, polling every 16 ms, for at most `limit` s.
  public func waitWhileInteracting(limit: Double) {
    let end = Date().addingTimeInterval(limit)
    while interacting && Date() < end { usleep(16_000) }
  }
}

public enum YieldPolicy {
  /// The batch plan to use now, or nil to wait: no new embedding batch starts while interacting; batch 4 while the
  /// Scroll is visible.
  public static func nextBatch(interacting: Bool, scrollVisible: Bool, thermal: ThermalLevel, lowPower: Bool,
                               priority: QwenPriority) -> BatchPlan? {
    if interacting || thermal >= .critical { return nil }
    if thermal == .serious && priority > .reading { return nil }
    if lowPower && priority >= .labels { return nil }
    return scrollVisible ? .interactive : .standard
  }
}

// MARK: - Gate thresholds

public struct GateThresholds: Codable, Sendable, Equatable {
  public var minStability: Double
  public var minMargin: Double
  public var floor: Double
  public var provenance: String
  public var provisional: Bool

  /// rule_v2, frozen per representation key; nil → `representation_mismatch`.
  public static func forKey(_ k: RepresentationKey) -> GateThresholds? {
    guard k.model == "qe06-q8", k.sha8 == ModelCatalog.embedder.sha8, k.template == EmbeddingTemplate.occInstr1.rawValue,
          k.dims == 256 else { return nil }
    return GateThresholds(minStability: 0.8, minMargin: 0.03, floor: 0.10,
                          provenance: "rule_v2: 13 real-word runs read by one agent (QWEN-LAB §1.5); not calibrated on pseudo-words",
                          provisional: true)
  }
}
