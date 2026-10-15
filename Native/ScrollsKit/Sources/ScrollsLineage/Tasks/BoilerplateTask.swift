// OWNER: N5
// Job 'boilerplate' (port of server/jobs/tasks/boilerplate.mjs): the boilerplate vs commonplace pass (SPEC §4.7). The
// Cipher bootstrap runs the pass right after the books load (phase B, through `BoilerplatePass`); it can also be queued
// on its own, e.g. {collections: ['cipher-gutenberg']}. It writes passage quality, doc_tokens and the versions in one
// transaction, so it is a bulk-writing job as in the reference (`writes: true`); the queue announces the data_version
// bump when it commits. Registered in ScrollsService/TaskRegistry.swift (N0's file).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs

/// The `boilerplate` job.
public struct BoilerplateTask: JobTask {
  public static let type = JobType(rawValue: "boilerplate")
  public static let writes = WriteNeed.exclusive
  /// Not re-queued after a crash: the bootstrap re-runs the pass when its phase was not marked done, and a second
  /// pass over the same scope is idempotent.
  public static let resumable = false
  /// Fingerprint records (≈ 0.29 per token, 8 bytes, doubled while sorting) and the slot tallies at Cipher scale.
  public static let budget = ResourceBudget(peakBytes: 384 << 20, maxThreads: 1, mayStartInBackground: false)

  let options: BoilerplateOptions

  /// Params: `{collections?: [slug | id], dryRun?: bool, explain?: [passage id]}`.
  public init(params: JSONValue) throws {
    var collections: [String]?
    if let list = params["collections"], !list.isNull {
      guard let items = list.arrayValue else {
        throw ScrollsError.badRequest(.validation, "collections must be a list of collection slugs.")
      }
      collections = try items.map { v in
        if let s = v.stringValue { return s }
        if let n = v.safeInteger { return String(n) }
        throw ScrollsError.badRequest(.validation, "collections must be a list of collection slugs.")
      }
    }
    let explain = (params["explain"]?.arrayValue ?? []).compactMap { $0.safeInteger.map { PassageID(rawValue: Int64($0)) } }
    options = BoilerplateOptions(collections: collections, dryRun: params["dryRun"]?.boolValue == true, explain: explain)
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    try await BoilerplateDetector().run(ctx, options: options).metrics
  }
}
