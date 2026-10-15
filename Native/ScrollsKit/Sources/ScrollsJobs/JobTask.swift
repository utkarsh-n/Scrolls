// OWNER: N0
// The task contract (IOS-SPEC §8.4.4; the reference's tasks/<type>.mjs `run(ctx, params)`): each job type is one
// `JobTask`, registered in ScrollsService/TaskRegistry.swift. A task runs off the queue's actor (a detached task at the
// job's priority), reports through its `JobContext`, and calls `checkpoint()` at least every 200 ms of work.

import Foundation
import ScrollsCore
import ScrollsStore

/// One job type's implementation.
public protocol JobTask: Sendable {
  static var type: JobType { get }
  /// What the task needs from the writer (ΔS-2: analysis tasks are `.commitsOnly`).
  static var writes: WriteNeed { get }
  /// Whether an interrupted job of this type is re-queued at boot and resumes from the cursor its committed rows imply.
  static var resumable: Bool { get }
  static var budget: ResourceBudget { get }
  /// Validates and keeps the params; throws a ScrollsError for bad params (the job fails before it starts).
  init(params: JSONValue) throws
  /// Does the work; the result becomes `job.result_json`.
  func run(_ ctx: JobContext) async throws -> JSONValue
}
