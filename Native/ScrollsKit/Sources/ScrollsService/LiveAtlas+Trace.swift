// OWNER: N5
// Trace in process (server/routes/trace.mjs): the targeted quotation trace of a span. The span is checked at once (400 /
// 404 before a job is queued); the search and its writes run as a 'trace' job (ScrollsLineage `TraceTask`), and the
// call waits up to 1.5 s for it, otherwise answering `{status: 'running', job: {id}}` while the job continues.
// Until the job type is registered in TaskRegistry (N0's file), the trace runs read-only in the call and says that it
// wrote no links — never a silent difference.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsLineage
import ScrollsStore

extension LiveAtlas {
  /// How long a trace call waits for its job (`SYNC_MS`).
  static let traceSyncWait: Duration = .milliseconds(1500)

  @concurrent
  public func trace(_ r: TraceRequest) async throws -> TraceResponse {
    let text = self.text, path = location.atlasPath
    _ = try await read { c in try TraceQuery.check(LineageReader(c, text: text, atlasPath: path), r) }  // 400 / 404 at once
    let id: JobID
    do {
      id = try await jobQueue.enqueue(JobSpec(type: TraceTask.type, params: TraceTask.params(r), userStarted: true))
    } catch let e as ScrollsError where e.code == .jobType {
      let found = try await read { c in try TraceQuery.run(LineageReader(c, text: text, atlasPath: path), r) }
      var body = found.body
      body["note"] = .string((body["note"]?.stringValue ?? TraceQuery.note)
        + " The trace job is not registered in this build, so no links were written.")
      body["created_relationships"] = []
      return try ScrollsJSON.decode(TraceResponse.self, from: .object(body))
    }
    guard let snap = await jobQueue.wait(for: id, timeout: Self.traceSyncWait), snap.status.isFinal else {
      var out = TraceResponse(status: "running", note: "The trace continues as job \(id.rawValue).")
      out.job = IDRef(id: Int(id.rawValue))
      return out
    }
    switch snap.status {
    case .succeeded:
      return try ScrollsJSON.decode(TraceResponse.self, from: snap.result ?? .null)
    case .cancelled:
      throw ScrollsError(code: ErrorCode(rawValue: "E_CANCELLED"), message: "Trace job \(id.rawValue) was cancelled.", status: 409)
    default:
      let code = snap.error?.code ?? "E_TRACE_FAILED"
      throw ScrollsError(code: ErrorCode(rawValue: code), message: snap.error?.message ?? "Trace job \(id.rawValue) failed.",
                         hint: snap.error?.hint, detail: ["job": .number(Double(id.rawValue))],
                         status: code == "E_VALIDATION" ? 400 : 500)
    }
  }
}
