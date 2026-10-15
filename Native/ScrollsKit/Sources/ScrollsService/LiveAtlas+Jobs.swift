// OWNER: N0
// The jobs API in process (server/routes/jobs.mjs): list, one job, its event stream, cancel. Job rows come from the
// JobQueue (this session's live state over the `job` table) and are shaped as the reference's `toJobJson`.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func jobs(_ r: JobsRequest) async throws -> JobsResponse {
    var status: JobStatus?
    if let s = r.status, !s.isEmpty {
      guard let known = JobStatus(rawValue: s) else {
        throw ScrollsError.badRequest(.badStatus, "Unknown job status '\(s)'.",
                                      hint: "Use one of \(JobStatus.allCases.map(\.rawValue).joined(separator: ", ")).")
      }
      status = known
    }
    let limit = try Paging.limit(r.limit, max: 200, default: 50)
    let before = try Paging.decodeCursor(r.cursor)?["before"]?.safeInteger
    let all = try await jobQueue.snapshot(status)
    let page = Array(all.filter { before == nil || $0.id.rawValue < Int64(before!) }.prefix(limit))
    var out = JobsResponse(items: page.map(JobResponse.init))
    out.$cursor = page.count == limit ? .value(Paging.encodeCursor(["before": .number(Double(page.last!.id.rawValue))])) : .null
    return out
  }

  @concurrent
  public func job(_ id: JobID) async throws -> JobResponse {
    guard let s = try await jobQueue.job(id) else { throw ScrollsError.notFound("Job \(id.rawValue)") }
    return JobResponse(s)
  }

  /// The job's current state as one progress event (or its done event when it has ended), then its events until done.
  @concurrent
  public func jobEvents(_ id: JobID) async throws -> JobEventsResponse {
    let events = jobQueue.events  // subscribed before the state is read, so no event falls between the two
    guard let first = try await jobQueue.job(id) else { throw ScrollsError.notFound("Job \(id.rawValue)") }
    let stream = AsyncThrowingStream<JobEventPayload, any Error> { continuation in
      if first.status.isFinal {
        continuation.yield(JobEventPayload(JobEvent(kind: .done, job: first)))
        continuation.finish()
        return
      }
      continuation.yield(JobEventPayload(JobEvent(kind: .progress, job: first)))
      let task = Task {
        for await e in events where e.job.id == id {
          let payload = JobEventPayload(e)
          continuation.yield(payload)
          if case .done = payload { break }
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
    return JobEventsResponse(events: stream)
  }

  /// 'cancelling' for a running job (the final "cancelled" arrives as a done event), 'cancelled' for a queued one,
  /// 'finished' for one that has ended, 'not_found' for an unknown id.
  @concurrent
  public func cancelJob(_ id: JobID) async throws -> JobCancelResponse {
    guard let before = try await jobQueue.job(id) else { return JobCancelResponse(status: "not_found") }
    if before.status.isFinal { return JobCancelResponse(status: "finished") }
    await jobQueue.cancel(id)
    let after = try await jobQueue.job(id)
    switch after?.status {
    case .cancelled?: return JobCancelResponse(status: "cancelled")
    case let s? where s.isFinal: return JobCancelResponse(status: "finished")
    default: return JobCancelResponse(status: "cancelling")
    }
  }
}

extension JobResponse {
  /// A queue snapshot in the reference's `toJobJson` form: every key written, null when empty.
  public init(_ s: JobSnapshot) {
    self.init(id: Int(s.id.rawValue), type: s.type.rawValue, status: s.status.rawValue, progress: s.progress,
              createdAt: s.createdAt)
    $phase = s.phase.map { .value($0) } ?? .null
    $message = s.message.map { .value($0) } ?? .null
    $counts = s.counts.map { .value($0) } ?? .null
    $runId = s.runId.map { .value(RunID(rawValue: $0)) } ?? .null
    $result = s.result.map { .value($0) } ?? .null
    $error = s.error.map { .value($0.jsonValue) } ?? .null
    params = s.params
    writes = s.writes
    priority = s.priority
    $startedAt = s.startedAt.map { .value($0) } ?? .null
    $finishedAt = s.finishedAt.map { .value($0) } ?? .null
  }
}

extension JobEventPayload {
  /// A queue event as the reference's SSE `job` channel writes it: `done` for a job's end, `progress` otherwise
  /// (queued, started, progress and cancelling all carry the job's status).
  public init(_ e: JobEvent) {
    let s = e.job
    if e.kind == .done {
      var d = JobDonePayload(job: Int(s.id.rawValue), status: s.status.rawValue)
      d.$runId = s.runId.map { .value(RunID(rawValue: $0)) } ?? .null
      d.$error = s.error.map { .value($0.jsonValue) } ?? .null
      if let result = s.result { d.result = result }
      self = .done(d)
    } else {
      var p = JobProgressPayload(job: Int(s.id.rawValue), type: s.type.rawValue, phase: s.phase, fraction: s.progress,
                                 message: s.message, status: s.status.rawValue)
      p.$counts = s.counts.map { .value($0) } ?? .null
      self = .progress(p)
    }
  }
}
