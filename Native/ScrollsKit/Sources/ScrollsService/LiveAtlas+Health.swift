// OWNER: N0
// GET /api/health in process (server/routes/health.mjs): version, contract, data version, atlas bytes, jobs, read
// pool, adapters and the Cipher bootstrap status. Cheap: one read and two queue snapshots.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// The statements of the health answer.
public enum HealthSQL: SQLCatalog {
  static let enabledAdapters = SQL("health.adapters.enabled", "SELECT count(*) FROM source_adapter WHERE enabled = 1",
                                   scan: .scanOK(reason: "source_adapter holds one row per registered adapter"))
  static let lastBootstrap = SQL("health.bootstrap.last",
                                 "SELECT id FROM job WHERE type = 'bootstrap-cipher' ORDER BY id DESC LIMIT 1",
                                 scan: .scanOK(reason: "the job log is small; newest first by rowid"))
  public static let all: [SQL] = [enabledAdapters, lastBootstrap]
}

extension LiveAtlas {
  @concurrent
  public func health() async throws -> HealthResponse {
    let (dataVersion, registered, bootstrapJob) = try await read { c in
      (try Meta.dataVersion(c), try c.prepared(HealthSQL.enabledAdapters).first { Int($0.int(0)) } ?? 0,
       try c.prepared(HealthSQL.lastBootstrap).first { $0.int(0) })
    }
    let running = try await jobQueue.snapshot(.running).count + jobQueue.snapshot(.cancelling).count
    let queued = try await jobQueue.snapshot(.queued).count
    let load = reads.load
    let cipher = try await cipherStatus(bootstrapJob)
    return HealthResponse(
      ok: true, version: BuildInfo.engineVersion, dataVersion: dataVersion, dbBytes: atlasBytes(),
      jobs: HealthJobs(running: running, queued: queued),
      readPool: HealthReadPool(size: reads.size, busy: load.inFlight, queued: load.waiting),
      // the phone's NL adapter is NaturalLanguage in process (ScrollsNL reports each model's availability)
      adapters: ["nl": "in-process", "registered": .number(Double(registered))],
      cipher: cipher)
  }

  /// `health.cipher`: the latest bootstrap job's status, phase, progress and message; without one, whether the bundled
  /// Cipher packs are there to load.
  func cipherStatus(_ bootstrapJob: Int64?) async throws -> BootstrapStatus {
    var s = BootstrapStatus(status: "not_started")
    if let id = bootstrapJob, let job = try await jobQueue.job(JobID(rawValue: id)) {
      s.status = LiveAtlas.bootstrapStatus(job)
      s.$phase = job.phase.map { .value($0) } ?? .null
      s.$progress = .value(job.progress)
      s.$message = job.message.map { .value($0) } ?? .null
      return s
    }
    s.$phase = .null
    s.$progress = .null
    s.$message = .null
    let pack = launch.bundledResources?.appendingPathComponent("cipher-meta.scrollspack")
    if pack == nil || !FileManager.default.fileExists(atPath: pack!.path) {
      s.status = "absent"
      s.message = "Cipher packs not bundled with this build: cipher-meta.scrollspack"
    } else if !launch.startBootstrap {
      s.status = "disabled"
      s.message = "automatic import is off"
    }
    return s
  }

  /// `vocab.CIPHER_STATUS` of a bootstrap job (health.mjs `bootstrapStatus`): while it runs, phase B, full text and
  /// the boilerplate pass are 'fulltext' and every other phase is 'metadata'.
  static func bootstrapStatus(_ job: JobSnapshot) -> String {
    switch job.status {
    case .running, .cancelling:
      let fulltext = (job.phase ?? "").range(of: "^B\\b|full ?text|^boilerplate",
                                             options: [.regularExpression, .caseInsensitive]) != nil
      return fulltext ? "fulltext" : "metadata"
    case .queued: return "queued"
    case .succeeded: return "ready"
    case .failed: return "failed"
    case .cancelled: return "cancelled"
    case .interrupted: return "interrupted"
    }
  }

  /// The atlas file plus its WAL, on disk.
  func atlasBytes() -> Int {
    let fm = FileManager.default
    return [location.atlasPath, location.atlasPath + "-wal"].reduce(0) { sum, p in
      sum + ((try? fm.attributesOfItem(atPath: p)[.size] as? Int) ?? 0)
    }
  }
}
