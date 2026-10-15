// OWNER: N0
// The `job` table as the queue reads it back (port of jobs/job-rows.mjs; the SQL is in `JobsSQL`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A `job` row as read back.
struct JobRowValues: Sendable {
  let id: Int64
  let type: String
  let params: JSONValue
  let writes: Bool
  let priority: Int
  let status: String
  let progress: Double
  let phase: String?
  let message: String?
  let countsJSON: String?
  let runId: Int64?
  let resultJSON: String?
  let errorJSON: String?
  let createdAt: String
  let startedAt: String?
  let finishedAt: String?

  init(_ r: Row) {
    id = r.int(0)
    type = r.text(1)
    params = (try? JSONValue.parse(r.text(2))) ?? .object([:])
    writes = r.int(3) == 1
    priority = Int(r.int(4))
    status = r.text(5)
    progress = r.double(6)
    phase = r.textOrNil(7)
    message = r.textOrNil(8)
    countsJSON = r.textOrNil(9)
    runId = r.intOrNil(10)
    resultJSON = r.textOrNil(11)
    errorJSON = r.textOrNil(12)
    createdAt = r.text(13)
    startedAt = r.textOrNil(14)
    finishedAt = r.textOrNil(15)
  }

  var snapshot: JobSnapshot {
    let error = errorJSON.flatMap { try? ScrollsJSON.decoder.decode(JobError.self, from: Data($0.utf8)) }
    return JobSnapshot(id: JobID(rawValue: id), type: JobType(rawValue: type), status: JobStatus(rawValue: status) ?? .failed,
                       progress: progress, phase: phase, message: message, counts: countsJSON.flatMap { try? JSONValue.parse($0) },
                       runId: runId, result: resultJSON.flatMap { try? JSONValue.parse($0) }, error: error, params: params,
                       writes: writes, priority: priority, createdAt: createdAt, startedAt: startedAt, finishedAt: finishedAt,
                       after: [])
  }
}
