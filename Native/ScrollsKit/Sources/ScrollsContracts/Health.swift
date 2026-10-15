// OWNER: N0
// GET /api/health (contract shape `Health`) and the bootstrap and adapter status objects it shares with the event
// stream (`BootstrapEvent`, `AdapterEvent`).

import ScrollsCore

/// The engine's state at a glance: versions, data version, size, jobs, read pool, adapters, the Cipher bootstrap and
/// the boot-time integrity check of originals/.
public struct HealthResponse: Codable, Sendable, Equatable {
  public var ok: Bool
  public var version: String
  /// The contract version the engine serves ("1.3.0").
  public var contract: String
  public var dataVersion: Int
  public var dbBytes: Int
  public var jobs: HealthJobs
  public var readPool: HealthReadPool
  /// `{nl: 'missing' | …, registered: <source_adapter rows>}` (verbatim).
  public var adapters: JSONValue
  public var cipher: BootstrapStatus
  public var integrity: IntegrityStatus?
  /// Set on mock bodies (fixtures and MockAtlas).
  public var mock: Bool?

  public init(ok: Bool, version: String, contract: String = Contract.version, dataVersion: Int, dbBytes: Int,
              jobs: HealthJobs, readPool: HealthReadPool, adapters: JSONValue, cipher: BootstrapStatus,
              integrity: IntegrityStatus? = nil, mock: Bool? = nil) {
    self.ok = ok
    self.version = version
    self.contract = contract
    self.dataVersion = dataVersion
    self.dbBytes = dbBytes
    self.jobs = jobs
    self.readPool = readPool
    self.adapters = adapters
    self.cipher = cipher
    self.integrity = integrity
    self.mock = mock
  }

  enum CodingKeys: String, WireNamedKeys {
    case ok, version, contract, dataVersion, dbBytes, jobs, readPool, adapters, cipher, integrity, mock
    static let wireNames = ["dataVersion": "dataVersion", "dbBytes": "dbBytes", "readPool": "readPool"]
  }
}

/// Running and queued jobs.
public struct HealthJobs: Codable, Sendable, Equatable {
  public var running: Int
  public var queued: Int
  public init(running: Int, queued: Int) {
    self.running = running
    self.queued = queued
  }
}

/// The read pool: readers, busy readers, and reads waiting for one.
public struct HealthReadPool: Codable, Sendable, Equatable {
  public var size: Int
  public var busy: Int
  public var queued: Int?
  public init(size: Int, busy: Int, queued: Int? = nil) {
    self.size = size
    self.busy = busy
    self.queued = queued
  }
}

/// The Cipher bootstrap (`health.cipher`, and the `bootstrap` event): status ∈ `vocab.CIPHER_STATUS`, with the phase,
/// progress and message of the latest bootstrap job, and the corpora ready when phase A finishes.
public struct BootstrapStatus: Codable, Sendable, Equatable {
  public var status: String
  @NullOrAbsent public var phase: String?
  @NullOrAbsent public var progress: Double?
  @NullOrAbsent public var message: String?
  public var ready: [String]?

  public init(status: String, phase: String? = nil, progress: Double? = nil, message: String? = nil, ready: [String]? = nil) {
    self.status = status
    self.phase = phase
    self.progress = progress
    self.message = message
    self.ready = ready
  }
}

/// The boot-time check of the verbatim originals (contract 1.3.0, final gate). Absent in mock mode.
public struct IntegrityStatus: Codable, Sendable, Equatable {
  /// 'checking' | 'ok' | 'missing_originals' | 'unknown'
  public var status: String
  public var checkedAt: String?
  public var files: Int?
  public var missingFiles: Int?
  public var sizeMismatch: Int?
  public var referencedMissing: Int?
  public var documentsAffected: Int?
  public var reason: String?
  public var sample: [IntegritySample]?

  public init(status: String, checkedAt: String? = nil, files: Int? = nil, missingFiles: Int? = nil, sizeMismatch: Int? = nil,
              referencedMissing: Int? = nil, documentsAffected: Int? = nil, reason: String? = nil,
              sample: [IntegritySample]? = nil) {
    self.status = status
    self.checkedAt = checkedAt
    self.files = files
    self.missingFiles = missingFiles
    self.sizeMismatch = sizeMismatch
    self.referencedMissing = referencedMissing
    self.documentsAffected = documentsAffected
    self.reason = reason
    self.sample = sample
  }
}

/// One original that is missing or the wrong size, with how many documents were made from it.
public struct IntegritySample: Codable, Sendable, Equatable {
  public var sha256: String
  public var relPath: String
  /// 'missing' | 'size'
  public var problem: String
  public var documents: Int
  public init(sha256: String, relPath: String, problem: String, documents: Int) {
    self.sha256 = sha256
    self.relPath = relPath
    self.problem = problem
    self.documents = documents
  }
}

/// An adapter's load state as the `adapter` event channel reports it (`AdapterEvent`).
public struct AdapterStatus: Codable, Sendable, Equatable {
  public var id: String
  public var loaded: Bool
  public var staged: Bool
  @Nullable public var message: String?
  /// The next job of a chained load; null at its end.
  @NullOrAbsent public var job: Int?
  @NullOrAbsent public var progress: Double?
  @NullOrAbsent public var status: String?

  public init(id: String, loaded: Bool, staged: Bool, message: String?, job: Int? = nil, progress: Double? = nil,
              status: String? = nil) {
    self.id = id
    self.loaded = loaded
    self.staged = staged
    self.message = message
    self.job = job
    self.progress = progress
    self.status = status
  }
}
