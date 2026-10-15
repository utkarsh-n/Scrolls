// OWNER: N0
// The value types of the job system (IOS-SPEC §8.4.4): job types and their write needs, resource budgets, the thermal
// throttle, a job's spec, its snapshot (the contract's Job shape) and the events the queue publishes.

import Foundation
import ScrollsCore
import ScrollsStore

/// A job type: the reference's `JOB_TYPES` keys plus the phone's own.
public struct JobType: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(_ rawValue: String) { self.rawValue = rawValue }

  public static let packInstall = JobType(rawValue: "pack-install"), generationBuild = JobType(rawValue: "generation-build"),
    generationSwap = JobType(rawValue: "generation-swap"), journalReplay = JobType(rawValue: "journal-replay"),
    maintenance = JobType(rawValue: "maintenance")

  /// The phone's types (not in vocab.JOB_TYPES), with their priorities.
  public static let phoneTypes: [JobType: Int] = [packInstall: 2, generationBuild: 6, generationSwap: 1, journalReplay: 2,
                                                  maintenance: 9]

  /// The reference's priority for this type (vocab.JOB_TYPES), the phone type's, or 5.
  public var defaultPriority: Int {
    Vocab.jobTypes[rawValue]?.priority ?? JobType.phoneTypes[self] ?? 5
  }

  /// Whether the type is known (vocab.JOB_TYPES or a phone type).
  public var isKnown: Bool { Vocab.jobTypes[rawValue] != nil || JobType.phoneTypes[self] != nil }

  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public var description: String { rawValue }
}

/// What a job needs from the writer: nothing (read-only), short guarded commits (analysis jobs, ΔS-2), or the
/// exclusive bulk lease (imports, source loads). The queue runs ≤ 1 exclusive and ≤ 2 other jobs at once.
public enum WriteNeed: Sendable, Equatable { case none, commitsOnly, exclusive }

/// A task's declared resources (§3.8): peak dirty memory, file mappings, threads, and whether it may start while the
/// app is in the background.
public struct ResourceBudget: Sendable, Equatable {
  public var peakBytes: Int
  public var mappedBytes: Int
  public var maxThreads: Int
  public var mayStartInBackground: Bool
  public init(peakBytes: Int, mappedBytes: Int = 0, maxThreads: Int = 1, mayStartInBackground: Bool = false) {
    self.peakBytes = peakBytes
    self.mappedBytes = mappedBytes
    self.maxThreads = maxThreads
    self.mayStartInBackground = mayStartInBackground
  }
  /// A light task: 32 MB, one thread, may start in the background.
  public static let light = ResourceBudget(peakBytes: 32 << 20, maxThreads: 1, mayStartInBackground: true)
}

/// The title and subtitle of a BGContinuedProcessingTask, when he asked to keep a job running after leaving.
public struct ContinuedProcessingRequest: Sendable, Equatable, Codable {
  public var title: String
  public var subtitle: String
  public init(title: String, subtitle: String) {
    self.title = title
    self.subtitle = subtitle
  }
}

/// A job to queue.
public struct JobSpec: Sendable {
  public var type: JobType
  public var params: JSONValue
  public var priority: Int
  /// Jobs that must succeed before this one starts (demo: materialize → cluster → label).
  public var after: [JobID]
  /// Set when the job is a journaled act; it is appended to the journal by `JobContext.journaledCommit` (§6.2).
  public var journal: JournalOp?
  public var continuedProcessing: ContinuedProcessingRequest?
  /// The journal actor of the act ("scrolls" for automatic jobs, "human:utkarsh" for his).
  public var actor: String
  /// Jobs nobody asked for (derived builds) do not start in Low Power Mode or at critical heat.
  public var userStarted: Bool

  public init(type: JobType, params: JSONValue = .object([:]), priority: Int? = nil, after: [JobID] = [],
              journal: JournalOp? = nil, continuedProcessing: ContinuedProcessingRequest? = nil, actor: String = "scrolls",
              userStarted: Bool = true) {
    self.type = type
    self.params = params
    self.priority = min(9, max(1, priority ?? type.defaultPriority))
    self.after = after
    self.journal = journal
    self.continuedProcessing = continuedProcessing
    self.actor = actor
    self.userStarted = userStarted
  }
}

/// `vocab.JOB_STATUS`.
public enum JobStatus: String, Sendable, Codable, CaseIterable {
  case queued, running, succeeded, failed, cancelling, cancelled, interrupted

  /// A status a job never leaves by itself.
  public var isFinal: Bool { self == .succeeded || self == .failed || self == .cancelled || self == .interrupted }
}

/// A failed job's error as the API shows it: `{code, message, hint}` (stacks never leave the engine).
public struct JobError: Sendable, Codable, Equatable, Error {
  public var code: String?
  public var message: String
  public var hint: String?
  public init(code: String?, message: String, hint: String?) {
    self.code = code
    self.message = message
    self.hint = hint
  }

  /// `{code, message, hint}` with nulls, as `job.error_json` holds it.
  public var jsonValue: JSONValue {
    .object(["code": code.map(JSONValue.string) ?? .null, "message": .string(message), "hint": hint.map(JSONValue.string) ?? .null])
  }
}

/// A job as the API shows it (contract Job shape, `toJobJson` of the reference) plus its dependencies.
public struct JobSnapshot: Sendable, Codable, Equatable {
  public var id: JobID
  public var type: JobType
  public var status: JobStatus
  public var progress: Double
  public var phase: String?
  public var message: String?
  public var counts: JSONValue?
  public var runId: Int64?
  public var result: JSONValue?
  public var error: JobError?
  public var params: JSONValue
  public var writes: Bool
  public var priority: Int
  public var createdAt: String
  public var startedAt: String?
  public var finishedAt: String?
  public var after: [JobID]
}

/// What the queue publishes (≤ 4 progress events per job per second; state changes at once).
public struct JobEvent: Sendable, Equatable {
  public enum Kind: String, Sendable { case queued, started, progress, cancelling, done }
  public let kind: Kind
  public let job: JobSnapshot
  public init(kind: Kind, job: JobSnapshot) {
    self.kind = kind
    self.job = job
  }
}

/// Thrown by `JobContext.checkpoint()` when the queue suspends its jobs (the app is going to the background).
public struct JobSuspended: Error, Sendable, Equatable {
  public init() {}
}
