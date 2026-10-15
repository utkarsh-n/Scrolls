// OWNER: N0
// GET /api/jobs, GET /api/jobs/:id, POST /api/jobs/:id/cancel and the job and data payloads of the event streams
// (contract shapes `Job`, `JobList`, `JobCancel`, `JobProgressEvent`, `JobDoneEvent`, `DataEvent`).

import ScrollsCore

/// One job row (contract shape `Job`).
public struct JobResponse: Codable, Sendable, Equatable {
  public var id: Int
  /// A `vocab.JOB_TYPES` code, or a phone type (pack-install, generation-build, …).
  public var type: String
  /// `vocab.JOB_STATUS`
  public var status: String
  public var progress: Double
  @NullOrAbsent public var phase: String?
  @NullOrAbsent public var message: String?
  /// Progress counts (`{documents, of}`, `{books_done, books}` …), verbatim.
  @NullOrAbsent public var counts: JSONValue?
  @NullOrAbsent public var runId: RunID?
  /// The task's result (verbatim).
  @NullOrAbsent public var result: JSONValue?
  /// `{code, message, hint}` of a failed job (verbatim).
  @NullOrAbsent public var error: JSONValue?
  /// The job's parameters (verbatim).
  public var params: JSONValue?
  /// Whether the job writes evidence (`vocab.JOB_TYPES`).
  public var writes: Bool?
  /// 1 (first) … 9.
  public var priority: Int?
  public var createdAt: String
  @NullOrAbsent public var startedAt: String?
  @NullOrAbsent public var finishedAt: String?

  public init(id: Int, type: String, status: String, progress: Double, phase: String? = nil, message: String? = nil,
              counts: JSONValue? = nil, runId: RunID? = nil, result: JSONValue? = nil, error: JSONValue? = nil,
              createdAt: String, startedAt: String? = nil, finishedAt: String? = nil) {
    self.id = id
    self.type = type
    self.status = status
    self.progress = progress
    self.phase = phase
    self.message = message
    self.counts = counts
    self.runId = runId
    self.result = result
    self.error = error
    self.createdAt = createdAt
    self.startedAt = startedAt
    self.finishedAt = finishedAt
  }
}

/// A page of jobs, newest first (contract shape `JobList`).
public struct JobsResponse: Codable, Sendable, Equatable {
  public var items: [JobResponse]
  @NullOrAbsent public var cursor: String?
  public init(items: [JobResponse], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}

/// The answer to a cancel request; the final "cancelled" arrives as a `done` event (contract shape `JobCancel`).
public struct JobCancelResponse: Codable, Sendable, Equatable {
  /// 'cancelling' | 'cancelled' | 'finished' | 'not_found'
  public var status: String
  public init(status: String) { self.status = status }
}

/// A job's progress (`job` and `progress` events; contract shape `JobProgressEvent`).
public struct JobProgressPayload: Codable, Sendable, Equatable {
  public var job: Int
  public var type: String
  @Nullable public var phase: String?
  public var fraction: Double
  @Nullable public var message: String?
  @NullOrAbsent public var counts: JSONValue?
  /// The job's status ('running', 'cancelling' …).
  public var status: String?

  public init(job: Int, type: String, phase: String?, fraction: Double, message: String?, counts: JSONValue? = nil,
              status: String? = nil) {
    self.job = job
    self.type = type
    self.phase = phase
    self.fraction = fraction
    self.message = message
    self.counts = counts
    self.status = status
  }
}

/// A job's end (`job` and `done` events; contract shape `JobDoneEvent`). A chained load's `result.continued_by` names
/// the next job.
public struct JobDonePayload: Codable, Sendable, Equatable {
  public var job: Int
  /// `vocab.JOB_STATUS`
  public var status: String
  @NullOrAbsent public var runId: RunID?
  @NullOrAbsent public var error: JSONValue?
  @NullOrAbsent public var result: JSONValue?

  public init(job: Int, status: String, runId: RunID? = nil, error: JSONValue? = nil, result: JSONValue? = nil) {
    self.job = job
    self.status = status
    self.runId = runId
    self.error = error
    self.result = result
  }
}

/// One event of a job's stream: progress, then exactly one done.
public enum JobEventPayload: Sendable, Equatable {
  case progress(JobProgressPayload)
  case done(JobDonePayload)

  /// The job the event is about.
  public var job: Int {
    switch self {
    case .progress(let p): p.job
    case .done(let d): d.job
    }
  }
}

/// A committed write bumped the data version (`data` event; contract shape `DataEvent`).
public struct DataChangedPayload: Codable, Sendable, Equatable {
  public var dataVersion: Int
  public init(dataVersion: Int) { self.dataVersion = dataVersion }
  enum CodingKeys: String, WireNamedKeys {
    case dataVersion
    static let wireNames = ["dataVersion": "dataVersion"]
  }
}

/// GET /api/jobs/:id/events in process: the job's events as they happen (progress events, then one done).
public struct JobEventsResponse: Sendable {
  public let events: AsyncThrowingStream<JobEventPayload, any Error>
  public init(events: AsyncThrowingStream<JobEventPayload, any Error>) { self.events = events }
}

/// GET /api/jobs query: newest first, optionally one status.
public struct JobsRequest: Codable, Sendable, Equatable {
  /// `vocab.JOB_STATUS`
  public var status: String?
  public var cursor: String?
  public var limit: Int?
  public init(status: String? = nil, cursor: String? = nil, limit: Int? = nil) {
    self.status = status
    self.cursor = cursor
    self.limit = limit
  }
}
