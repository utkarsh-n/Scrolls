// OWNER: N0
// The job queue (port of jobs/queue.mjs; IOS-SPEC §1.5, ΔS-2). Jobs run in priority order (1 = interactive … 9 =
// background), at most one bulk-writing (`.exclusive`) job and two others at once, each as a detached task at the
// Swift priority of its job priority, after the jobs it waits for (`after:`) have succeeded. State changes are
// written to `job`/`job_event` at once; progress is published at once (≤ 4/s, by the context) and written once a
// second. Cancellation is acknowledged at the job's next checkpoint, and a running SQL statement is interrupted.
// `suspendAll` lets running jobs commit their chunk and stop (the app is leaving); `recoverInterrupted` turns jobs a
// crash left running into `interrupted` and re-queues resumable types (they resume from their committed rows).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// The queue of one atlas.
public actor JobQueue {
  /// Read-mostly jobs (`.none`, `.commitsOnly`) running at once.
  public static let maxReadMostly = 2
  /// Finished jobs kept in memory (older ones are read back from the `job` table).
  static let keptFinished = 256
  /// Only one running job may declare a peak above this (§3.8).
  public static let largePeakBytes = 256 << 20
  /// In the background no job may start whose peak is above this, or that cannot start there (§3.7, §3.8).
  public static let backgroundPeakBytes = 300 << 20

  private struct Record {
    var snapshot: JobSnapshot
    let spec: JobSpec
    let taskType: (any JobTask.Type)?
    var ctx: JobContext?
    var task: Task<Void, Never>?
    var reservation: MemoryReservation?
    var suspended = false
    /// False from the moment `complete` sets a final status until its row and closing event are persisted: a `wait`
    /// arriving in between (actor reentrancy) waits for the persisted state instead of returning early.
    var settled = true
    var waiters: [(token: UInt64, continuation: CheckedContinuation<JobSnapshot?, Never>)] = []
    var writes: WriteNeed { taskType?.writes ?? .none }
  }

  private enum Outcome: Sendable {
    case succeeded(JSONValue)
    case failed(JobError)
    case cancelled
    case interrupted
  }

  private let reads: ReadPool
  private let writer: Writer
  private let text: any TextStore
  private let tasks: [JobType: any JobTask.Type]
  private let conditions: any DeviceConditionsSource
  private let journal: JournalFile?
  private var jobs: [JobID: Record] = [:]
  private var suspended = false
  private var ticker: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var foreground = true
  private var scheduling = false
  private var rescheduleRequested = false
  private var waiterTokens: UInt64 = 0
  private nonisolated let hub = EventHub()

  /// `registry` lists every task type (ScrollsService's `TaskRegistry.all`).
  public init(reads: ReadPool, writer: Writer, text: any TextStore, registry: [any JobTask.Type],
              conditions: any DeviceConditionsSource, journal: JournalFile?) {
    self.reads = reads
    self.writer = writer
    self.text = text
    var tasks: [JobType: any JobTask.Type] = [:]
    for t in registry { tasks[t.type] = t }
    self.tasks = tasks
    self.conditions = conditions
    self.journal = journal
  }

  /// Job events, from the moment of the call. Each call returns a new stream.
  public nonisolated var events: AsyncStream<JobEvent> { hub.subscribe() }

  // ── public API ──

  /// Queues a job and starts it when its turn comes. Throws E_JOB_TYPE for a type without a registered task.
  public func enqueue(_ spec: JobSpec) async throws -> JobID {
    guard let taskType = tasks[spec.type] else {
      throw ScrollsError(code: .jobType, message: "Unknown job type '\(spec.type)'.",
                         hint: "Known types: \(tasks.keys.map(\.rawValue).sorted().joined(separator: ", ")).", detail: nil,
                         status: 400)
    }
    for dep in spec.after where jobs[dep] == nil {
      // a job of an earlier session is final (boot recovery loaded every unfinished one); its status decides
      guard let row = try await loadRow(dep) else {
        throw ScrollsError(code: .notFound, message: "No job \(dep.rawValue) to wait for.", hint: nil, detail: nil,
                           status: 404)
      }
      if jobs[dep] == nil { jobs[dep] = record(from: row) }
    }
    let now = StoreClock.isoNow()
    let exclusive = taskType.writes == .exclusive
    let id = try await writer.write("enqueue \(spec.type)") { tx in
      let id = try tx.ids.nextLog("job")
      let ins = try tx.connection.prepared(JobsSQL.insertJob)
      try ins.bind(.int(id), .text(spec.type.rawValue), .text(CanonicalJSON.string(spec.params)), .int(exclusive ? 1 : 0),
                   .int(Int64(spec.priority)), .text(JobStatus.queued.rawValue), .text(now))
      try ins.run()
      return JobID(rawValue: id)
    }
    let snapshot = JobSnapshot(id: id, type: spec.type, status: .queued, progress: 0, phase: nil, message: nil, counts: nil,
                               runId: nil, result: nil, error: nil, params: spec.params, writes: exclusive,
                               priority: spec.priority, createdAt: now, startedAt: nil, finishedAt: nil, after: spec.after)
    jobs[id] = Record(snapshot: snapshot, spec: spec, taskType: taskType)
    hub.publish(JobEvent(kind: .queued, job: snapshot))
    await schedule()
    return id
  }

  /// Requests cancellation: a queued job is cancelled at once (and the jobs waiting for it with it); a running one is
  /// `cancelling` until its next checkpoint, and its running statement is interrupted.
  public func cancel(_ id: JobID) async {
    guard var r = jobs[id] else { return }
    switch r.snapshot.status {
    case .queued:
      await complete(id, .cancelled)
    case .running:
      r.snapshot.status = .cancelling
      r.snapshot.message = "cancelling"
      jobs[id] = r
      r.ctx?.requestCancel()
      r.task?.cancel()
      hub.publish(JobEvent(kind: .cancelling, job: r.snapshot))
      await persist(id, event: ("info", "cancel requested"))
    default:
      break
    }
  }

  /// Stops starting jobs and asks running ones to stop at their next checkpoint (their current chunk commits). After
  /// `within`, jobs still running are cancelled (their open transaction rolls back). Stopped jobs become `interrupted`
  /// and `resumeAll()` queues them again.
  public func suspendAll(within: Duration) async {
    suspended = true
    let running = jobs.filter { $0.value.snapshot.status == .running || $0.value.snapshot.status == .cancelling }.map(\.key)
    for id in running {
      jobs[id]?.suspended = true
      jobs[id]?.ctx?.requestSuspend()
    }
    let deadline = ContinuousClock.now + within
    while ContinuousClock.now < deadline, running.contains(where: { isActive($0) }) {
      try? await Task.sleep(for: .milliseconds(20))
    }
    for id in running where isActive(id) { jobs[id]?.task?.cancel() }
    let hard = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < hard, running.contains(where: { isActive($0) }) {
      try? await Task.sleep(for: .milliseconds(20))
    }
  }

  /// Whether the app is in the foreground. In the background only jobs that may start there (and whose peak is
  /// ≤ 300 MB) start; heavy analysis waits for the foreground (§3.7).
  public func setForeground(_ isForeground: Bool) async {
    foreground = isForeground
    if isForeground { await schedule() }
  }

  /// Starts jobs again, re-queuing the ones `suspendAll` stopped.
  public func resumeAll() async {
    suspended = false
    for (id, r) in jobs where r.suspended && r.snapshot.status == .interrupted {
      await requeue(id, message: "resumed")
    }
    await schedule()
  }

  /// Boot recovery: jobs left `running`/`cancelling` become `interrupted` and their runs `failed`; resumable types are
  /// queued again, and every queued job is loaded and scheduled. Runs once at boot, before any job of this session.
  public func recoverInterrupted() async throws {
    guard !jobs.values.contains(where: { isActive($0.snapshot.id) }) else {
      throw StoreError.misuse("recoverInterrupted runs at boot, before any job of this session starts")
    }
    let at = StoreClock.isoNow()
    let interrupted = try await writer.write("recover interrupted jobs") { tx -> [JobRowValues] in
      let c = tx.connection
      let rows = try c.prepared(JobsSQL.unfinishedJobs).all(JobRowValues.init)
      let up = try c.prepared(JobsSQL.updateJob)
      for row in rows {
        try up.bind(.text(JobStatus.interrupted.rawValue), .double(row.progress), .string(row.phase),
                    .text("interrupted: the app stopped while this job ran"), .string(row.countsJSON), .integer(row.runId),
                    .string(row.resultJSON), .string(row.errorJSON), .string(row.startedAt), .text(at), .int(0), .text(at),
                    .int(row.id))
        try up.run()
        try JobQueue.insertEvent(tx, job: row.id, level: "warn", phase: row.phase, progress: row.progress,
                                 message: "interrupted by a restart")
      }
      let fail = try c.prepared(JobsSQL.failAllRunning)
      try fail.bind(.text(at))
      try fail.run()
      return rows
    }
    for row in interrupted {
      let type = JobType(rawValue: row.type)
      if tasks[type]?.resumable == true {
        jobs[JobID(rawValue: row.id)] = record(from: row)
        await requeue(JobID(rawValue: row.id), message: "re-queued after a restart")
      }
    }
    let queued = try await reads.read(.interactive) { c in try c.prepared(JobsSQL.queuedJobs).all(JobRowValues.init) }
    for row in queued where jobs[JobID(rawValue: row.id)] == nil {
      jobs[JobID(rawValue: row.id)] = record(from: row)
    }
    await schedule()
  }

  /// Jobs newest first: this session's live state over the `job` table (200 newest, or all of one status).
  public func snapshot(_ status: JobStatus?) async throws -> [JobSnapshot] {
    let rows = try await reads.read(.interactive) { c -> [JobRowValues] in
      if let status {
        let s = try c.prepared(JobsSQL.jobsByStatus)
        try s.bind(.text(status.rawValue), .int(5000))
        return try s.all(JobRowValues.init)
      }
      let s = try c.prepared(JobsSQL.recentJobs)
      try s.bind(.int(200))
      return try s.all(JobRowValues.init)
    }
    var byID: [JobID: JobSnapshot] = [:]
    for row in rows { byID[JobID(rawValue: row.id)] = row.snapshot }
    for (id, r) in jobs where status == nil || r.snapshot.status == status { byID[id] = liveSnapshot(id) ?? r.snapshot }
    return byID.values.filter { status == nil || $0.status == status }.sorted { $0.id > $1.id }
  }

  /// One job (live state first), or nil.
  public func job(_ id: JobID) async throws -> JobSnapshot? {
    if jobs[id] != nil { return liveSnapshot(id) }
    return try await loadRow(id)?.snapshot
  }

  /// The `Progress` of a running job (bound to its BGContinuedProcessingTask by the app; §3.7), or nil.
  public func progress(of id: JobID) -> Progress? { jobs[id]?.ctx?.progressObject }

  /// Waits until job `id` is final (or `timeout` passes) and returns its snapshot.
  public func wait(for id: JobID, timeout: Duration = .seconds(30)) async -> JobSnapshot? {
    guard let r = jobs[id] else { return try? await loadRow(id)?.snapshot }
    if r.snapshot.status.isFinal && r.settled { return r.snapshot }
    waiterTokens &+= 1
    let token = waiterTokens
    let timer = Task { [weak self] in
      try? await Task.sleep(for: timeout)
      await self?.expireWaiter(id, token: token)
    }
    defer { timer.cancel() }
    return await withCheckedContinuation { c in jobs[id]?.waiters.append((token, c)) }
  }

  // ── scheduling ──

  private func isActive(_ id: JobID) -> Bool {
    guard let s = jobs[id]?.snapshot.status else { return false }
    return s == .running || s == .cancelling
  }

  private func schedule() async {
    guard !suspended else { return }
    // one pass at a time: a pass awaits the writer when it starts a job, and a second pass meanwhile would decide on
    // a stale view of what runs; it asks the running pass to look again instead
    if scheduling {
      rescheduleRequested = true
      return
    }
    scheduling = true
    defer { scheduling = false }
    repeat {
      rescheduleRequested = false
      await schedulePass()
    } while rescheduleRequested && !suspended
  }

  private func schedulePass() async {
    let throttle = conditions.current
    let queued = jobs.values.filter { $0.snapshot.status == .queued }
      .sorted { ($0.snapshot.priority, $0.snapshot.id) < ($1.snapshot.priority, $1.snapshot.id) }.map(\.snapshot.id)
    var waiting = false
    for id in queued {
      guard let r = jobs[id], r.snapshot.status == .queued else { continue }
      switch dependencyState(r.spec.after) {
      case .blocked: continue
      case .failed(let dep):
        await complete(id, .failed(JobError(code: ErrorCode.dependency.rawValue, message: "Job \(dep.rawValue), which this job waits for, did not succeed.",
                                            hint: "Run that job again, then this one.")))
        continue
      case .ready: break
      }
      let active = jobs.values.filter { isActive($0.snapshot.id) }
      let exclusive = active.filter { $0.writes == .exclusive }.count
      let others = active.count - exclusive
      if r.writes == .exclusive ? exclusive >= 1 : others >= JobQueue.maxReadMostly { continue }
      if throttle == .critical || (!r.spec.userStarted && !throttle.allowsAutomaticStarts) {
        waiting = true
        continue
      }
      let budget = r.taskType?.budget ?? .light
      if !foreground && (!budget.mayStartInBackground || budget.peakBytes > JobQueue.backgroundPeakBytes) {
        continue  // setForeground(true) schedules again
      }
      if budget.peakBytes > JobQueue.largePeakBytes,
        active.contains(where: { ($0.taskType?.budget.peakBytes ?? 0) > JobQueue.largePeakBytes })
      {
        continue  // starts when the other large job ends
      }
      let reservation: MemoryReservation
      do {
        reservation = try MemoryBudget.reserve(bytes: budget.peakBytes)
      } catch {
        if jobs[id]?.snapshot.message != "waiting for memory: \(error)" {
          jobs[id]?.snapshot.message = "waiting for memory: \(error)"
          if let s = jobs[id]?.snapshot { hub.publish(JobEvent(kind: .progress, job: s)) }
        }
        waiting = true
        continue
      }
      await start(id, reservation: reservation)
    }
    if waiting && retry == nil {
      retry = Task { [weak self] in
        try? await Task.sleep(for: .seconds(2))
        await self?.retryNow()
      }
    }
  }

  private func retryNow() async {
    retry = nil
    await schedule()
  }

  private enum DependencyState { case ready, blocked, failed(JobID) }

  private func dependencyState(_ after: [JobID]) -> DependencyState {
    for dep in after {
      guard let s = jobs[dep]?.snapshot.status else { continue }
      switch s {
      case .succeeded: continue
      case .failed, .cancelled, .interrupted: return .failed(dep)
      default: return .blocked
      }
    }
    return .ready
  }

  private func start(_ id: JobID, reservation: MemoryReservation) async {
    guard var r = jobs[id], r.snapshot.status == .queued, let taskType = r.taskType else {
      reservation.release()
      return
    }
    let ctx = JobContext(id: id, type: r.spec.type, reads: reads, writer: writer, text: text, journal: journal,
                         journalOp: r.spec.journal, actor: r.spec.actor, writes: taskType.writes, priority: r.spec.priority,
                         conditions: conditions, onEvent: { [hub, base = r.snapshot] kind, ctx in
                           hub.publish(JobEvent(kind: kind, job: JobQueue.merge(base, ctx)))
                         })
    r.ctx = ctx
    r.reservation = reservation
    r.snapshot.status = .running
    r.snapshot.startedAt = StoreClock.isoNow()
    r.snapshot.finishedAt = nil
    r.snapshot.message = nil
    r.snapshot.progress = 0
    r.suspended = false
    jobs[id] = r
    // persist 'running' before the task starts, so a crash right after is recovered as 'interrupted', not re-run
    await persist(id, event: ("info", "started"))
    hub.publish(JobEvent(kind: .started, job: r.snapshot))
    let params = r.spec.params
    let priority = JobQueue.taskPriority(r.spec.priority)
    jobs[id]?.task = Task.detached(priority: priority) { [weak self] in
      let outcome = await JobQueue.execute(taskType, params: params, ctx: ctx)
      await self?.complete(id, outcome)
    }
    startTicker()
  }

  /// Runs a task off the queue's actor and classifies how it ended.
  private static func execute(_ taskType: any JobTask.Type, params: JSONValue, ctx: JobContext) async -> Outcome {
    do {
      let task = try taskType.init(params: params)
      try await ctx.checkpoint()
      let result = try await task.run(ctx)
      await ctx.endLeases()
      return .succeeded(result)
    } catch is JobSuspended {
      await ctx.endLeases()
      return .interrupted
    } catch {
      await ctx.endLeases()
      if ctx.isCancelled { return ctx.state.withLock({ $0.suspendRequested }) ? .interrupted : .cancelled }
      if error is CancellationError { return .cancelled }
      return .failed(JobQueue.jobError(error))
    }
  }

  static func jobError(_ error: any Error) -> JobError {
    if let e = error as? ScrollsError { return JobError(code: e.code.rawValue, message: e.message, hint: e.hint) }
    if let e = error as? JobError { return e }
    if let e = error as? StoreError { return JobError(code: "E_SQLITE", message: e.message, hint: nil) }
    return JobError(code: nil, message: String(describing: error), hint: nil)
  }

  /// Ends a job: closes its open runs, writes its final state, releases its memory, wakes waiters, schedules more.
  private func complete(_ id: JobID, _ outcome: Outcome) async {
    guard var r = jobs[id] else { return }
    var status: JobStatus
    switch outcome {
    case .succeeded(let result):
      status = .succeeded
      r.snapshot.result = result
      r.snapshot.progress = 1
    case .failed(let e):
      status = .failed
      r.snapshot.error = e
    case .cancelled: status = .cancelled
    case .interrupted: status = .interrupted
    }
    if r.suspended && status != .succeeded { status = .interrupted }
    if let ctx = r.ctx {
      let live = ctx.live
      r.snapshot.phase = live.phase ?? r.snapshot.phase
      if status != .succeeded { r.snapshot.progress = live.fraction }
      r.snapshot.counts = live.counts ?? r.snapshot.counts
      r.snapshot.runId = live.runId ?? r.snapshot.runId
      if status == .succeeded { r.snapshot.message = live.message }
    }
    r.snapshot.status = status
    r.snapshot.finishedAt = StoreClock.isoNow()
    if status == .interrupted { r.snapshot.message = "interrupted: the app left the foreground" }
    if status == .cancelled { r.snapshot.message = "cancelled" }
    r.reservation?.release()
    r.reservation = nil
    r.task = nil
    r.settled = false
    jobs[id] = r
    let runStatus: RunStatus = status == .cancelled ? .cancelled : .failed
    // a task must finish its runs: one left open is never shown as succeeded (the reference's _closeOpenRuns)
    if let ctx = r.ctx, status != .succeeded || !ctx.openRuns.isEmpty {
      let at = StoreClock.isoNow()
      _ = try? await writer.write("close runs of job \(id.rawValue)") { tx in
        let s = try tx.connection.prepared(JobsSQL.closeJobRuns)
        try s.bind(.text(runStatus.rawValue), .text(at), .int(id.rawValue))
        try s.run()
      }
    }
    let message: String
    switch outcome {
    case .failed(let e): message = "failed: \(e.message)"
    default: message = status.rawValue
    }
    await persist(id, event: (status == .failed ? "error" : "info", message))
    // waiters are collected only now, so one that arrived while the row was being written is answered too
    jobs[id]?.settled = true
    let waiters = jobs[id]?.waiters ?? []
    jobs[id]?.waiters = []
    hub.publish(JobEvent(kind: .done, job: r.snapshot))
    for w in waiters { w.continuation.resume(returning: r.snapshot) }
    // jobs that wait for a job that did not succeed cannot run
    if status != .succeeded && status != .interrupted {
      for (other, o) in jobs where o.snapshot.status == .queued && o.spec.after.contains(id) {
        await complete(other, .failed(JobError(code: ErrorCode.dependency.rawValue, message: "Job \(id.rawValue), which this job waits for, \(status.rawValue).",
                                               hint: "Run that job again, then this one.")))
      }
    }
    pruneFinished()
    await schedule()
  }

  /// Forgets the oldest finished jobs beyond `keptFinished` that no queued job waits for.
  private func pruneFinished() {
    let finished = jobs.values.filter { $0.snapshot.status.isFinal && $0.settled && $0.waiters.isEmpty && !$0.suspended }
      .map(\.snapshot.id).sorted()
    guard finished.count > JobQueue.keptFinished else { return }
    let needed = Set(jobs.values.filter { !$0.snapshot.status.isFinal }.flatMap(\.spec.after))
    for id in finished.prefix(finished.count - JobQueue.keptFinished) where !needed.contains(id) { jobs[id] = nil }
  }

  private func requeue(_ id: JobID, message: String) async {
    guard var r = jobs[id] else { return }
    r.snapshot.status = .queued
    r.snapshot.finishedAt = nil
    r.snapshot.message = message
    r.ctx = nil
    jobs[id] = r
    await persist(id, event: ("info", message))
    hub.publish(JobEvent(kind: .queued, job: r.snapshot))
  }

  private func expireWaiter(_ id: JobID, token: UInt64) {
    guard let k = jobs[id]?.waiters.firstIndex(where: { $0.token == token }) else { return }
    jobs[id]?.waiters.remove(at: k).continuation.resume(returning: nil)
  }

  // ── persistence ──

  private func liveSnapshot(_ id: JobID) -> JobSnapshot? {
    guard let r = jobs[id] else { return nil }
    guard let ctx = r.ctx, r.snapshot.status == .running || r.snapshot.status == .cancelling else { return r.snapshot }
    return JobQueue.merge(r.snapshot, ctx)
  }

  /// The snapshot with the context's live progress fields.
  static func merge(_ base: JobSnapshot, _ ctx: JobContext) -> JobSnapshot {
    var s = base
    let live = ctx.live
    s.progress = live.fraction
    s.phase = live.phase
    s.message = live.message ?? (base.status == .cancelling ? "cancelling" : nil)
    s.counts = live.counts
    s.runId = live.runId
    return s
  }

  /// Writes the job's live state (and an optional job_event) in one short transaction.
  private func persist(_ id: JobID, event: (level: String, message: String)?) async {
    guard let s = liveSnapshot(id) else { return }
    let heartbeat = s.status == .running || s.status == .cancelling ? StoreClock.isoNow() : nil
    let cancelRequested = s.status == .cancelling || s.status == .cancelled
    _ = try? await writer.write("job \(id.rawValue) state") { tx in
      let up = try tx.connection.prepared(JobsSQL.updateJob)
      try up.bind(.text(s.status.rawValue), .double(s.progress), .string(s.phase), .string(s.message),
                  .string(s.counts.map(CanonicalJSON.string)), .integer(s.runId), .string(s.result.map(CanonicalJSON.string)),
                  .string(s.error.map { CanonicalJSON.string($0.jsonValue) }), .string(s.startedAt), .string(s.finishedAt),
                  .int(cancelRequested ? 1 : 0), .string(heartbeat), .int(id.rawValue))
      try up.run()
      if let event {
        try JobQueue.insertEvent(tx, job: id.rawValue, level: event.level, phase: s.phase, progress: s.progress,
                                 message: event.message)
      }
    }
  }

  static func insertEvent(_ tx: WriteTx, job: Int64, level: String, phase: String?, progress: Double?, message: String) throws {
    let ins = try tx.connection.prepared(JobsSQL.insertJobEvent)
    try ins.bind(.int(try tx.ids.nextLog("job_event")), .int(job), .text(StoreClock.isoNow()), .text(level), .string(phase),
                 .real(progress), .text(message), .null)
    try ins.run()
  }

  /// While jobs run: writes their progress and heartbeat_at once a second.
  private func startTicker() {
    guard ticker == nil else { return }
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self, await self.tick() else { break }
      }
    }
  }

  private func tick() async -> Bool {
    let running = jobs.filter { $0.value.snapshot.status == .running || $0.value.snapshot.status == .cancelling }.map(\.key)
    if running.isEmpty {
      ticker = nil
      return false
    }
    for id in running { await persist(id, event: nil) }
    return true
  }

  private func loadRow(_ id: JobID) async throws -> JobRowValues? {
    try await reads.read(.interactive) { c in try c.prepared(JobsSQL.jobByID).bindingFirst([.int(id.rawValue)], JobRowValues.init) }
  }

  private func record(from row: JobRowValues) -> Record {
    let type = JobType(rawValue: row.type)
    let spec = JobSpec(type: type, params: row.params, priority: row.priority)
    return Record(snapshot: row.snapshot, spec: spec, taskType: tasks[type])
  }

  /// Swift task priority by job priority: ≤ 2 user-initiated, 3–6 utility, 7–9 background (§1.5).
  static func taskPriority(_ p: Int) -> TaskPriority {
    p <= 2 ? .userInitiated : p <= 6 ? .utility : .background
  }
}

/// Fans job events out to every subscriber.
final class EventHub: Sendable {
  private let subscribers = Mutex<[UInt64: AsyncStream<JobEvent>.Continuation]>([:])
  private let ids = Atomic<UInt64>(0)

  func subscribe() -> AsyncStream<JobEvent> {
    let id = ids.add(1, ordering: .relaxed).newValue
    let (stream, continuation) = AsyncStream<JobEvent>.makeStream(bufferingPolicy: .bufferingNewest(512))
    continuation.onTermination = { [weak self] _ in _ = self?.subscribers.withLock { $0.removeValue(forKey: id) } }
    subscribers.withLock { $0[id] = continuation }
    return stream
  }

  func publish(_ event: JobEvent) {
    for c in subscribers.withLock({ Array($0.values) }) { c.yield(event) }
  }
}
