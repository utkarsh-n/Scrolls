// OWNER: N0
// Analysis runs (port of jobs/context.mjs startRun / finishRun / findReusableRun / inputFingerprint). A run is reused
// when a succeeded run has the same (stage, params_hash, input_fingerprint) — and, on the phone, the same code_hash
// (ΔS-7: the hash of the Swift sources of the stage). Rows of a run are visible only once it succeeded.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// An open (or reused) analysis run.
public struct RunHandle: Sendable, Equatable {
  public let id: RunID
  public let key: RunKey
  /// A succeeded run with the same key existed: nothing was inserted and its rows are the result.
  public let reused: Bool
  public let scope: JSONValue
  public let upstream: [RunID]
}

/// Statements of ScrollsJobs (runs and the job table).
public enum JobsSQL: SQLCatalog {
  static let collectionBatches = SQL("jobs.runs.batches", """
    SELECT c.slug, c.id, MAX(b.id) AS batch FROM collection c
    LEFT JOIN import_batch b ON b.collection_id = c.id AND b.status = 'committed' GROUP BY c.id ORDER BY c.slug
    """, scan: .scanOK(reason: "one row per collection (tens)"))
  static let reusableRun = SQL("jobs.runs.reuse", """
    SELECT id FROM analysis_run WHERE stage = ? AND params_hash = ? AND input_fingerprint = ? AND status = 'succeeded'
      AND code_hash = ? ORDER BY id DESC LIMIT 1
    """)
  static let insertRun = SQL("jobs.runs.insert", """
    INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
        input_fingerprint, data_version, upstream_run_ids, representation, model, model_version, seed, tokenizer_version,
        segmenter_version, icu_version, status, job_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    """)
  static let finishRun = SQL("jobs.runs.finish",
    "UPDATE analysis_run SET status = ?, metrics_json = ?, gate_json = ?, finished_at = ? WHERE id = ?")
  static let closeJobRuns = SQL("jobs.runs.close-of-job",
    "UPDATE analysis_run SET status = ?, finished_at = ? WHERE job_id = ? AND status = 'running'",
    scan: .scanOK(reason: "analysis_run has no job_id index; tens to thousands of rows"))
  static let failAllRunning = SQL("jobs.runs.fail-running", """
    UPDATE analysis_run SET status = 'failed', finished_at = ?,
      notes = 'interrupted: the app stopped while this run was open' WHERE status = 'running'
    """, scan: .scanOK(reason: "boot recovery, once"))

  static let insertJob = SQL("jobs.job.insert", """
    INSERT INTO job (id, type, params_json, writes, priority, status, progress, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    """)
  static let updateJob = SQL("jobs.job.update", """
    UPDATE job SET status = ?, progress = ?, phase = ?, message = ?, counts_json = ?, run_id = ?, result_json = ?,
      error_json = ?, started_at = ?, finished_at = ?, cancel_requested = ?, heartbeat_at = ? WHERE id = ?
    """)
  static let insertJobEvent = SQL("jobs.job.event", """
    INSERT INTO job_event (id, job_id, at, level, phase, progress, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let jobColumns = "id, type, params_json, writes, priority, status, progress, phase, message, counts_json, run_id, "
    + "result_json, error_json, created_at, started_at, finished_at"
  static let recentJobs = SQL("jobs.job.recent", "SELECT \(jobColumns) FROM job ORDER BY id DESC LIMIT ?")
  static let jobsByStatus = SQL("jobs.job.by-status",
    "SELECT \(jobColumns) FROM job WHERE status = ? ORDER BY id DESC LIMIT ?")
  static let jobByID = SQL("jobs.job.get", "SELECT \(jobColumns) FROM job WHERE id = ?")
  static let unfinishedJobs = SQL("jobs.job.unfinished",
    "SELECT \(jobColumns) FROM job WHERE status IN ('running', 'cancelling') ORDER BY id")
  static let queuedJobs = SQL("jobs.job.queued", "SELECT \(jobColumns) FROM job WHERE status = 'queued' ORDER BY id")

  public static let all: [SQL] = [
    collectionBatches, reusableRun, insertRun, finishRun, closeJobRuns, failAllRunning, insertJob, updateJob,
    insertJobEvent, recentJobs, jobsByStatus, jobByID, unfinishedJobs, queuedJobs,
  ]
}

/// The run bookkeeping a `JobContext` uses.
enum Runs {
  /// sha256 (hex) of a string's UTF-8.
  static func sha256(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

  /// The input fingerprint of a run: its scope, the newest committed import batch of each collection in scope (all
  /// collections when the scope names none), the passage-quality version, upstream runs, tokenizer and segmenter.
  static func inputFingerprint(_ c: Connection, scope: JSONValue, upstream: [RunID]) throws -> String {
    let wanted: [String]? = scope["collections"]?.arrayValue?.map { v in
      switch v {
      case .string(let s): s
      case .number(let n): JSNumber.format(n)
      default: CanonicalJSON.string(v)
      }
    }
    var batches = JSONObject()
    for r in try c.prepared(JobsSQL.collectionBatches).all({ (slug: $0.text(0), id: $0.int(1), batch: $0.intOrNil(2)) }) {
      if wanted == nil || wanted!.contains(where: { JSString.equal($0, r.slug) || $0 == String(r.id) }) {
        batches[r.slug] = .number(Double(r.batch ?? 0))
      }
    }
    let body: JSONValue = .object([
      "scope": scope, "batches": .object(batches), "quality": .string(try Meta.get(c, "quality_version") ?? "0"),
      "upstream": .array(upstream.map(\.rawValue).sorted().map { .number(Double($0)) }),
      "tokenizer": .string(StoreVersions.tokenizer), "segmenter": .string(StoreVersions.segmenter),
    ])
    return sha256(CanonicalJSON.string(body))
  }

  /// Opens a run in `tx` (or finds the reusable one).
  static func start(_ tx: WriteTx, stage: Stage, pipelineVersion: String, params: JSONValue, scope: JSONValue,
                    upstream: [RunID], representation: String?, model: String?, modelVersion: String?, seed: Int?,
                    job: JobID) throws -> RunHandle {
    let c = tx.connection
    let paramsJSON = CanonicalJSON.string(params)
    let key = RunKey(stage: stage, paramsHash: sha256(paramsJSON),
                     inputFingerprint: try inputFingerprint(c, scope: scope, upstream: upstream),
                     codeHash: BuildInfo.codeHash(stage: stage.rawValue))
    if let id = try c.prepared(JobsSQL.reusableRun).bindingFirst(
      [.text(stage.rawValue), .text(key.paramsHash), .text(key.inputFingerprint), .text(key.codeHash)], { $0.int(0) })
    {
      return RunHandle(id: RunID(rawValue: id), key: key, reused: true, scope: scope, upstream: upstream)
    }
    let id = try tx.ids.nextLog("analysis_run")
    let ins = try c.prepared(JobsSQL.insertRun)
    try ins.bind(.int(id), .text(stage.rawValue), .text(pipelineVersion), .text(key.codeHash), .text(paramsJSON),
                 .text(key.paramsHash), .text(CanonicalJSON.string(scope)), .text(key.inputFingerprint),
                 .int(Int64(try Meta.dataVersion(c))),
                 .text(CanonicalJSON.string(.array(upstream.map { .number(Double($0.rawValue)) }))),
                 .string(representation), .string(model), .string(modelVersion), .integer(seed),
                 .text(StoreVersions.tokenizer), .text(StoreVersions.segmenter), .text(StoreVersions.icu),
                 .int(job.rawValue), .text(StoreClock.isoNow()))
    try ins.run()
    return RunHandle(id: RunID(rawValue: id), key: key, reused: false, scope: scope, upstream: upstream)
  }

  /// Closes a run.
  static func finish(_ tx: WriteTx, _ run: RunHandle, _ status: RunStatus, metrics: JSONValue?, gate: JSONValue) throws {
    guard status != .running else { throw StoreError.misuse("finishRun: a run cannot finish as 'running'") }
    let up = try tx.connection.prepared(JobsSQL.finishRun)
    try up.bind(.text(status.rawValue), .string(metrics.map(CanonicalJSON.string)), .text(CanonicalJSON.string(gate)),
                .text(StoreClock.isoNow()), .int(run.id.rawValue))
    try up.run()
  }

  /// E_INPUTS_CHANGED: an import or load committed while an analysis ran, so its results describe other inputs.
  static func inputsChanged(_ run: RunHandle) -> ScrollsError {
    ScrollsError(code: .inputsChanged,
                 message: "The inputs of this \(run.key.stage) run changed while it ran; its results were not saved.",
                 hint: "Run it again; it will use the new inputs.", detail: .object(["run": .number(Double(run.id.rawValue))]),
                 status: 409)
  }
}
