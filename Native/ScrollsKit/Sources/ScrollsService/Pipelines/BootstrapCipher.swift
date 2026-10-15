// OWNER: N2
// Cipher's bootstrap on the phone (IOS-SPEC §3.6, ΔS-5, D10; port of server/jobs/tasks/bootstrap-cipher.mjs): it
// reads the bundled packs, never a Cipher folder.
//   Phase A  · metadata   works (+ siblings → relationships, meanings → glosses) → themes → roots      pack cipher-meta
//   Phase A2 · genealogy  cipher.relations: endpoints in ≈ 20 s chunks, then aliases + relationships   pack cipher-meta
//   Phase B  · full text  Gutenberg books → Wikisource hi → gu in ≈ 20 s chunks → incremental FTS merges →
//                         BoilerplatePass (N5)                                                  packs cipher-meta, -text
// Each phase is one `bootstrap-cipher` job, journaled as one `JournalOp.sourceLoad` (the pack's sha256, the adapter,
// the phase, the slot) at its final commit. Every phase is resumable: what is loaded is read back from committed
// batches (an interrupted chunk's batch rolls back), and records the writer refused are remembered in meta so later
// chunks do not retry them. A chunk is one import batch through the job's write lease, so interactive writes slip in
// between chunks and a suspension loses at most one chunk (§3.7). Reconciliation counts (§6.8) go into the metrics of
// a 'bootstrap-cipher' run after phase A and at the end. The supervisor (`start`) queues the phases one after another
// when the atlas needs them, so `health.cipher` always describes the phase that runs.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsLineage
import ScrollsSources
import ScrollsStore
import Synchronization

/// The Cipher bootstrap pipeline (the `bootstrap-cipher` job type).
public enum BootstrapCipher {
  /// The phases in order; each is one journaled source load.
  public enum Phase: String, Sendable, CaseIterable, Codable {
    case a = "A", a2 = "A2", b = "B"

    /// The label the job's progress carries.
    public var label: String {
      switch self {
      case .a: "A · metadata"
      case .a2: "A2 · genealogy"
      case .b: "B · full text"
      }
    }
    /// The packs it reads, in lookup order.
    public var packs: [String] {
      switch self {
      case .a, .a2: [CipherPacks.meta]
      case .b: [CipherPacks.meta, CipherPacks.text]
      }
    }
    /// The adapter its journal op names, and the slot of its rows.
    var adapter: (id: String, slot: SourceSlot) {
      switch self {
      case .a: (CipherWorksAdapter.adapterID, .cipherMeta)
      case .a2: (CipherRelationsAdapter.adapterID, .cipherRelations)
      case .b: (CipherBooksAdapter.adapterID, .cipherText)
      }
    }
    /// The job priority (≤ 2 runs at .userInitiated: phase A is the first minute's, §3.6).
    var priority: Int {
      switch self {
      case .a: 2
      case .a2: 3
      case .b: 4
      }
    }
  }

  public static let type = JobType(rawValue: "bootstrap-cipher")
  public static let stateKey = "cipher_bootstrap"
  public static let relations = CipherRelationsAdapter.collection
  public static let textCollections = ["cipher-gutenberg", "cipher-wikisource-hi", "cipher-wikisource-gu"]
  public static let readyMessage = "Cipher titles, relations and etymology are ready"
  public static let fullTextReady = "Cipher full text is ready"
  static let canary = "computer virus or computer codes that damage"
  static let aShare = 0.08, a2Share = 0.03, textShare = 0.82
  static var b0: Double { aShare + a2Share }

  // MARK: state (meta `cipher_bootstrap`)

  /// The stored state: `{started_at, A:{done_at, ms}, A2:{done_at, …}, text_done_at, boilerplate_done_at, boilerplate,
  /// finished_at, final_run, unloadable:{slug:[ext_id]}}`.
  public static func state(_ c: Connection) throws -> JSONObject {
    guard let s = try Meta.get(c, stateKey), let v = try? JSONValue.parse(s), let o = v.objectValue else { return [:] }
    return o
  }

  static func writeState(_ tx: WriteTx, _ patch: JSONObject) throws {
    var s = try state(tx.connection)
    for (k, v) in patch { s[k] = v }
    s["updated_at"] = .string(StoreClock.isoNow())
    try Meta.set(tx.connection, stateKey, CanonicalJSON.string(.object(s)))
  }

  /// Whether `phase` finished in this atlas.
  public static func isDone(_ phase: Phase, _ state: JSONObject) -> Bool {
    switch phase {
    case .a: state["A"]?["done_at"]?.stringValue != nil
    case .a2: state["A2"]?["done_at"]?.stringValue != nil
    case .b: state["finished_at"]?.stringValue != nil
    }
  }

  /// The ext_ids the writer refused in a collection (not retried).
  static func unloadable(_ state: JSONObject, _ slug: String) -> Set<String> {
    Set((state["unloadable"]?[slug]?.arrayValue ?? []).compactMap(\.stringValue))
  }

  static func addUnloadable(_ lease: WriteLease, _ slug: String, _ ids: [String]) async throws {
    guard !ids.isEmpty else { return }
    try await lease.batch("bootstrap unloadable") { tx in
      let s = try state(tx.connection)
      var u = s["unloadable"]?.objectValue ?? [:]
      let old = (u[slug]?.arrayValue ?? []).compactMap(\.stringValue)
      var seen = Set(old)
      u[slug] = .array((old + ids.filter { seen.insert($0).inserted }).map(JSONValue.string))
      try writeState(tx, ["unloadable": .object(u)])
    }
  }

  // MARK: queueing (the supervisor)

  /// The journal op of a phase: the pack it reads by sha256, the adapter, the phase, the slot.
  public static func journalOp(_ phase: Phase, files: SourceFiles) -> JournalOp {
    let primary = phase == .b ? files.packs.last : files.packs.first
    var params: JSONObject = ["adapters": .array((phase == .a ? ["cipher.works", "cipher.themes", "cipher.roots"]
                                                  : phase == .a2 ? ["cipher.relations"] : ["cipher.books", "cipher.wikisource"]).map(JSONValue.string))]
    params["packs"] = .object(JSONObject(files.packs.map { ($0.name, JSONValue.string($0.sha256)) }))
    return .sourceLoad(SourceLoadOp(pack: primary?.name ?? phase.packs.last!, packSha256: primary?.sha256 ?? "",
                                    adapterId: phase.adapter.id, adapterVersion: "1.0.0", phase: phase.rawValue,
                                    params: .object(params), slot: phase.adapter.slot))
  }

  private static let supervisors = Mutex<[String: Task<Void, Never>]>([:])

  /// Starts the bootstrap of `atlas` when it needs it and the bundled packs are there: the phases not done yet are
  /// queued one after another (each waits for the previous one to succeed). Idempotent per atlas; returns at once.
  /// The app calls it after the atlas opens (`EngineLaunchOptions.startBootstrap`); Sources → Build calls it too.
  @discardableResult
  public static func start(_ atlas: LiveAtlas, through last: Phase = .b,
                           continued: ContinuedProcessingRequest? = nil) async -> Bool {
    let path = atlas.location.atlasPath
    guard PackLibrary.url(of: CipherPacks.meta, atlasPath: path) != nil else { return false }
    if let running = supervisors.withLock({ $0[path] }), !running.isCancelled { return true }
    let task = Task.detached(priority: .utility) {
      await supervise(atlas, through: last, continued: continued)
      _ = supervisors.withLock { $0.removeValue(forKey: path) }
    }
    supervisors.withLock { $0[path] = task }
    return true
  }

  /// Stops supervising `atlas` (the atlas is closing or being swapped); queued and running jobs are left to the queue.
  public static func stop(_ atlas: LiveAtlas) {
    supervisors.withLock { $0.removeValue(forKey: atlas.location.atlasPath) }?.cancel()
  }

  static func supervise(_ atlas: LiveAtlas, through last: Phase, continued: ContinuedProcessingRequest?) async {
    let path = atlas.location.atlasPath
    for phase in Phase.allCases {
      if Task.isCancelled { return }
      guard let st = try? await atlas.read({ try state($0) }) else { return }
      if isDone(phase, st) {
        if phase == .a { atlas.hub.send(.bootstrap(readyStatus(st))) }
        if phase == last { return }
        continue
      }
      do {
        var found = try await existingJob(atlas, phase)
        if found == nil { found = try await enqueue(atlas, phase, path: path, continued: phase == .b ? continued : nil) }
        guard let id = found else { return }
        while true {
          if Task.isCancelled { return }
          guard let snap = await atlas.jobQueue.wait(for: id, timeout: .seconds(3600)) else { return }
          switch snap.status {
          case .succeeded:
            break
          case .interrupted, .queued, .running, .cancelling:
            // suspended with the app (re-queued on resume) or still running at the timeout: keep waiting
            try await Task.sleep(for: .seconds(2))
            continue
          case .failed, .cancelled:
            atlas.hub.send(.bootstrap(BootstrapStatus(status: snap.status == .failed ? "failed" : "cancelled", phase: phase.label,
                                                      progress: snap.progress, message: snap.error?.message ?? snap.message)))
            return
          }
          break
        }
        if phase == .a, let st = try? await atlas.read({ try state($0) }) { atlas.hub.send(.bootstrap(readyStatus(st))) }
        if phase == .b {
          atlas.hub.send(.bootstrap(BootstrapStatus(status: "ready", phase: phase.label, progress: 1, message: fullTextReady,
                                                    ready: ["titles", "relations", "etymology", "fulltext"])))
        }
      } catch {
        return
      }
      if phase == last { return }
    }
  }

  static func readyStatus(_ st: JSONObject) -> BootstrapStatus {
    BootstrapStatus(status: isDone(.b, st) ? "ready" : "metadata", phase: Phase.a.label, progress: aShare, message: readyMessage,
                    ready: ["titles", "relations", "etymology"])
  }

  /// A queued or running bootstrap job of `phase` (a resumed one after a restart), if any.
  static func existingJob(_ atlas: LiveAtlas, _ phase: Phase) async throws -> JobID? {
    for status in [JobStatus.running, .queued, .cancelling] {
      for j in try await atlas.jobQueue.snapshot(status) where j.type == type && j.params["phase"]?.stringValue == phase.rawValue {
        return j.id
      }
    }
    return nil
  }

  static func enqueue(_ atlas: LiveAtlas, _ phase: Phase, path: String, continued: ContinuedProcessingRequest?) async throws -> JobID {
    let files = try await PackLibrary.files(phase.packs, atlasPath: path)
    return try await atlas.jobQueue.enqueue(JobSpec(type: type, params: ["phase": .string(phase.rawValue)],
                                                    priority: phase.priority, journal: journalOp(phase, files: files),
                                                    continuedProcessing: continued, actor: "scrolls", userStarted: true))
  }
}

/// The `bootstrap-cipher` job: one phase (params `{phase: "A" | "A2" | "B"}`).
public struct BootstrapCipherTask: JobTask {
  public static let type = BootstrapCipher.type
  public static let writes = WriteNeed.exclusive
  public static let resumable = true
  public static let budget = ResourceBudget(peakBytes: 256 << 20, maxThreads: 2, mayStartInBackground: true)

  let phase: BootstrapCipher.Phase

  public init(params: JSONValue) throws {
    guard let p = params["phase"]?.stringValue.flatMap(BootstrapCipher.Phase.init(rawValue:)) else {
      throw ScrollsError.badRequest(.validation, "bootstrap-cipher needs params.phase: A, A2 or B.",
                                    hint: "Queue the phases through BootstrapCipher.start.")
    }
    phase = p
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    let t0 = ContinuousClock.now
    let files = try await PackLibrary.files(phase.packs, atlasPath: SourcePipelines.atlasPath(ctx))
    let lease = await ctx.lease()
    let loader = SourceLoader(env: SourcePipelines.environment(ctx, lease: lease), files: files)
    try await SourcePipelines.recordPacks(lease, files)
    try await lease.batch("register adapters") { tx in
      try SourceLoader.registerAdapters(tx)
      if try BootstrapCipher.state(tx.connection)["started_at"] == nil {
        try BootstrapCipher.writeState(tx, ["started_at": .string(StoreClock.isoNow())])
      }
    }
    var result: JSONObject
    switch phase {
    case .a: result = try await BootstrapPhases.phaseA(ctx, loader, files)
    case .a2: result = try await BootstrapPhases.phaseA2(ctx, loader, files)
    case .b: result = try await BootstrapPhases.phaseB(ctx, loader, files)
    }
    await lease.end()
    let ms = BootstrapPhases.milliseconds(since: t0)
    result["ms"] = .number(ms)
    let phase = self.phase
    _ = try await ctx.journaledCommit("bootstrap \(phase.rawValue) done") { tx, _ in
      var patch: JSONObject = [:]
      switch phase {
      case .a: patch["A"] = ["done_at": .string(StoreClock.isoNow()), "ms": .number(ms)]
      case .a2: patch["A2"] = ["done_at": .string(StoreClock.isoNow()), "ms_last": .number(ms)]
      case .b: patch["finished_at"] = .string(StoreClock.isoNow())
      }
      try BootstrapCipher.writeState(tx, patch)
      try tx.bumpDataVersion()
    }
    let message = phase == .a ? BootstrapCipher.readyMessage : phase == .a2 ? "Cipher music genealogy is ready" : BootstrapCipher.fullTextReady
    let end = phase == .a ? BootstrapCipher.aShare : phase == .a2 ? BootstrapCipher.b0 : 1
    ctx.progress(end, phase: phase.label, message: message)
    RelationRecords.clear()
    if phase != .a { CultureWorks.clear(); CipherRelationsAdapter.clearCache() }
    return .object(result)
  }
}
