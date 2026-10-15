// OWNER: N0
// What a running task sees (port of jobs/context.mjs, IOS-SPEC §8.4.4): reads on the job lane, writes through the
// single writer, progress (≤ 4 events per second, phase changes at once), the stall rule's heartbeat (§3.7: the
// job's `Progress` advances at least every 2 s, also during a long SQL statement), and `checkpoint()` — cancellation,
// suspension, the thermal pause, the heartbeat and a yield. Runs open through `startRun` and close through
// `finishRun` or the guarded `commitRun` (E_INPUTS_CHANGED, ΔS-2).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// The context of one running job. Safe to use from the task and from its child tasks.
public final class JobContext: Sendable {
  public let id: JobID
  public let type: JobType
  public let reads: ReadPool
  public let text: any TextStore
  /// Progress for BGContinuedProcessingTask (1,000,000 units; `heartbeat()` creeps it forward within the current phase).
  public let progressObject: Progress
  let writer: Writer
  let journal: JournalFile?
  let journalOp: JournalOp?
  let actor: String
  let writes: WriteNeed
  let priority: Int
  let conditions: any DeviceConditionsSource
  let onEvent: @Sendable (JobEvent.Kind, JobContext) -> Void
  let state: Mutex<State>

  static let totalUnits: Int64 = 1_000_000
  /// Progress events are sent at most this often (phase changes and completion at once).
  static let eventInterval: Duration = .milliseconds(250)
  /// The heartbeat advances the Progress at most this often (well inside the 2 s stall rule).
  static let heartbeatInterval: Duration = .milliseconds(250)

  struct State {
    var fraction = 0.0
    var phase: String?
    var message: String?
    var counts: JSONValue?
    var runId: Int64?
    var openRuns: [RunHandle] = []
    var lastEvent: ContinuousClock.Instant?
    var pendingEvent = false
    var lastBeat: ContinuousClock.Instant?
    var cancelRequested = false
    var suspendRequested = false
    var journalEntry: JournalEntry?
    var leases: [WriteLease] = []
  }

  init(id: JobID, type: JobType, reads: ReadPool, writer: Writer, text: any TextStore, journal: JournalFile?,
       journalOp: JournalOp?, actor: String, writes: WriteNeed, priority: Int, conditions: any DeviceConditionsSource,
       onEvent: @escaping @Sendable (JobEvent.Kind, JobContext) -> Void) {
    self.id = id
    self.type = type
    self.reads = reads
    self.writer = writer
    self.text = text
    self.journal = journal
    self.journalOp = journalOp
    self.actor = actor
    self.writes = writes
    self.priority = priority
    self.conditions = conditions
    self.onEvent = onEvent
    self.state = Mutex(State())
    let p = Progress(totalUnitCount: JobContext.totalUnits)
    p.isCancellable = false
    self.progressObject = p
  }

  /// Workers for compute fan-out: 6 / 4 / 1 / 0 / 2 for nominal / fair / serious / critical / Low Power (§1.5); at
  /// least 1, since a critical phone pauses jobs in `checkpoint()` instead.
  public var parallelism: Int { max(1, conditions.current.workers) }

  // ── reads and writes ──

  /// A read on the job lane (shared readers only) with the stall rule's heartbeat and no 5 s deadline.
  public func read<T: Sendable>(deadline: Duration = .seconds(3600), _ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await reads.read(.job, deadline: deadline, heartbeat: { [self] in heartbeat() }, body)
  }

  /// One short write transaction (`.commitsOnly` and `.exclusive` jobs).
  public func write<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx) throws -> T) async throws -> T {
    guard writes != .none else { throw StoreError.misuse("\(type) declares writes: .none") }
    return try await writer.write(label, heartbeat: { [self] in heartbeat() }, body)
  }

  /// The bulk lease (`.exclusive` jobs): batches are one transaction each and yield to interactive writes. The queue
  /// ends it when the job ends, if the task did not.
  public func lease() async -> WriteLease {
    precondition(writes == .exclusive, "\(type) asked for the bulk lease without declaring writes: .exclusive")
    let lease = await writer.lease(for: id, heartbeat: { [self] in heartbeat() })
    state.withLock { $0.leases.append(lease) }
    return lease
  }

  /// The final transaction of a journaled act (§6.2): appends the spec's `JournalOp` to the journal (fsync) first,
  /// then runs `body` and records `journal_applied` in the same transaction. Without a journal op it is `write`.
  public func journaledCommit<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx, JournalEntry?) throws -> T) async throws -> T {
    guard let op = journalOp, let journal else { return try await write(label) { try body($0, nil) } }
    let entry: JournalEntry
    if let e = state.withLock({ $0.journalEntry }) {
      entry = e
    } else {
      entry = try await journal.append(op, actor: actor)
      state.withLock { $0.journalEntry = entry }
    }
    return try await write(label) { tx in
      let out = try body(tx, entry)
      try tx.recordJournalApplied(entry)
      return out
    }
  }

  // ── progress ──

  /// Reports progress (0…1); throttled to 4 events per second, phase changes and completion are sent at once.
  public func progress(_ fraction: Double, phase: String? = nil, message: String? = nil, counts: [String: Int] = [:]) {
    let f = fraction.isFinite ? min(1, max(0, fraction)) : 0
    let now = ContinuousClock.now
    let send = state.withLock { s -> Bool in
      let phaseChanged = phase != nil && phase != s.phase
      s.fraction = f
      if let phase { s.phase = phase }
      s.message = message
      if !counts.isEmpty { s.counts = .object(JSONObject(counts.map { ($0.key, JSONValue.number(Double($0.value))) })) }
      if phaseChanged || f >= 1 || s.lastEvent.map({ now - $0 >= JobContext.eventInterval }) ?? true {
        s.lastEvent = now
        s.pendingEvent = false
        return true
      }
      s.pendingEvent = true
      return false
    }
    let units = Int64(f * Double(JobContext.totalUnits))
    if units > progressObject.completedUnitCount { progressObject.completedUnitCount = units }
    if send { onEvent(.progress, self) }
  }

  /// The stall rule (§3.7): advances the Progress by one unit (at most every 250 ms), never past the next 1 % of the
  /// last reported fraction nor to completion, and sends a throttled progress event that is still pending. Called by
  /// `checkpoint()` and by SQLite's progress handler during the job's statements.
  public func heartbeat() {
    let now = ContinuousClock.now
    let (beat, cap, flush) = state.withLock { s -> (Bool, Int64, Bool) in
      if let last = s.lastBeat, now - last < JobContext.heartbeatInterval { return (false, 0, false) }
      s.lastBeat = now
      let base = Int64(s.fraction * Double(JobContext.totalUnits))
      let cap = min(JobContext.totalUnits - 1, base + JobContext.totalUnits / 100)
      var flush = false
      if s.pendingEvent, s.lastEvent.map({ now - $0 >= JobContext.eventInterval }) ?? true {
        s.pendingEvent = false
        s.lastEvent = now
        flush = true
      }
      return (true, cap, flush)
    }
    if beat {
      let current = progressObject.completedUnitCount
      if current < cap { progressObject.completedUnitCount = current + 1 }
    }
    if flush { onEvent(.progress, self) }
  }

  /// Cancellation, suspension, the thermal pause, the heartbeat and a yield. Call at least every 200 ms of work.
  public func checkpoint() async throws {
    try checkStop()
    var paused = false
    while true {
      let t = conditions.current
      let pause = t == .critical || (t == .serious && priority >= 7)
      if !pause { break }
      if !paused {
        paused = true
        state.withLock { $0.message = "paused — the phone is hot" }
        onEvent(.progress, self)
      }
      try await Task.sleep(for: .milliseconds(250))
      try checkStop()
    }
    if conditions.current == .serious { try await Task.sleep(for: .milliseconds(50)) }
    heartbeat()
    await Task.yield()
    try checkStop()
  }

  /// Throws CancellationError or JobSuspended when the queue asked the job to stop.
  public func checkStop() throws {
    let (cancel, suspend) = state.withLock { ($0.cancelRequested, $0.suspendRequested) }
    if cancel || Task.isCancelled { throw CancellationError() }
    if suspend { throw JobSuspended() }
  }

  /// Whether cancellation was requested (by `JobQueue.cancel` or the task's cancellation).
  public var isCancelled: Bool { state.withLock { $0.cancelRequested } || Task.isCancelled }

  // ── runs ──

  /// Opens an analysis run (or returns the succeeded run with the same stage, params, inputs and code hash).
  public func startRun(_ stage: Stage, params: JSONValue, scope: JSONValue, upstream: [RunID], representation: String?,
                       seed: Int?, pipelineVersion: String? = nil, model: String? = nil,
                       modelVersion: String? = nil) async throws -> RunHandle {
    guard writes != .none else { throw StoreError.misuse("\(type) declares writes: .none and cannot open runs") }
    let id = self.id
    let version = pipelineVersion ?? "\(stage.rawValue)@\(BuildInfo.engineVersion)"
    let run = try await writer.write("startRun \(stage)") { tx in
      try Runs.start(tx, stage: stage, pipelineVersion: version, params: params, scope: scope, upstream: upstream,
                     representation: representation, model: model, modelVersion: modelVersion, seed: seed, job: id)
    }
    state.withLock { s in
      if !run.reused { s.openRuns.append(run) }
      if s.runId == nil { s.runId = run.id.rawValue }
    }
    return run
  }

  /// Closes a run (a reused run is left as it is).
  public func finishRun(_ run: RunHandle, _ status: RunStatus, metrics: JSONValue?) async throws {
    if run.reused { return }
    try await writer.write("finishRun \(run.key.stage)") { tx in
      try Runs.finish(tx, run, status, metrics: metrics, gate: .object([:]))
    }
    state.withLock { $0.openRuns.removeAll { $0.id == run.id } }
  }

  /// The guarded short write of a `.commitsOnly` analysis (ΔS-2): in one transaction, re-checks the run's input
  /// fingerprint (E_INPUTS_CHANGED when an import or load committed meanwhile), runs `body` to write the run's rows,
  /// and marks the run succeeded.
  public func commitRun<T: Sendable>(_ run: RunHandle, metrics: JSONValue?, _ body: @Sendable (WriteTx) throws -> T) async throws -> T {
    let out = try await write("commitRun \(run.key.stage)") { tx in
      let now = try Runs.inputFingerprint(tx.connection, scope: run.scope, upstream: run.upstream)
      guard now == run.key.inputFingerprint else { throw Runs.inputsChanged(run) }
      let r = try body(tx)
      if !run.reused { try Runs.finish(tx, run, .succeeded, metrics: metrics, gate: .object([:])) }
      return r
    }
    state.withLock { $0.openRuns.removeAll { $0.id == run.id } }
    return out
  }

  // ── queue side ──

  func requestCancel() { state.withLock { $0.cancelRequested = true } }

  /// Ends the leases the task left open (idempotent).
  func endLeases() async {
    for lease in state.withLock({ $0.leases }) { await lease.end() }
  }
  func requestSuspend() { state.withLock { $0.suspendRequested = true } }

  var openRuns: [RunHandle] { state.withLock { $0.openRuns } }

  /// The live fields the queue merges into the job's snapshot.
  var live: (fraction: Double, phase: String?, message: String?, counts: JSONValue?, runId: Int64?) {
    state.withLock { ($0.fraction, $0.phase, $0.message, $0.counts, $0.runId) }
  }
}
