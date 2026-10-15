// OWNER: N0
// Queue snapshots and events in the reference's shapes (server/jobs/queue.mjs `toJobJson`, routes/jobs.mjs
// progressEvent/doneEvent): every key written, null when empty, and each one valid against the contract shape.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore
import Testing

private func snapshot(_ json: String) throws -> JobSnapshot { try ScrollsJSON.decode(JobSnapshot.self, from: Data(json.utf8)) }

private let running = """
  {"id":301,"type":"materialize","status":"running","progress":0.41,"phase":"counting","message":"counting… 41%",
   "counts":{"documents":79,"of":188},"params":{"expression":12},"writes":true,"priority":3,
   "created_at":"2026-10-04T09:01:00.000Z","started_at":"2026-10-04T09:01:00.000Z","after":[]}
  """

private let failed = """
  {"id":295,"type":"import","status":"failed","progress":0.08,"error":{"code":"E_CSV_QUOTE","message":"An unclosed quote.","hint":null},
   "params":{},"writes":true,"priority":2,"created_at":"2026-10-04T08:50:00.000Z","started_at":"2026-10-04T08:50:00.000Z",
   "finished_at":"2026-10-04T08:51:00.000Z","after":[]}
  """

@Suite("Job shapes")
struct JobShapeTests {
  @Test("a snapshot becomes the reference's job row: every key, null when empty, and a valid Job")
  func jobRow() throws {
    let row = try ScrollsJSON.value(JobResponse(try snapshot(running)))
    let keys = Set(row.objectValue?.keys ?? [])
    #expect(keys == ["id", "type", "status", "progress", "phase", "message", "counts", "run_id", "result", "error", "params",
                     "writes", "priority", "created_at", "started_at", "finished_at"])
    #expect(row["run_id"] == .null && row["finished_at"] == .null && row["error"] == .null)
    #expect(CanonicalJSON.string(try ContractCatalog.roundTrip(shape: "Job", row)) == CanonicalJSON.string(row))
    let f = try ScrollsJSON.value(JobResponse(try snapshot(failed)))
    #expect(f["error"]?["code"] == "E_CSV_QUOTE" && f["error"]?["hint"] == .null)
  }

  @Test("queue events become the `job` channel's progress and done payloads")
  func events() throws {
    let progress = JobEventPayload(JobEvent(kind: .progress, job: try snapshot(running)))
    guard case .progress(let p) = progress else { Issue.record("progress"); return }
    let pj = try ScrollsJSON.value(p)
    #expect(Set(pj.objectValue?.keys ?? []) == ["job", "type", "phase", "fraction", "message", "counts", "status"])
    #expect(CanonicalJSON.string(try ContractCatalog.roundTrip(shape: "JobProgressEvent", pj)) == CanonicalJSON.string(pj))
    let done = JobEventPayload(JobEvent(kind: .done, job: try snapshot(failed)))
    guard case .done(let d) = done else { Issue.record("done"); return }
    let dj = try ScrollsJSON.value(d)
    #expect(Set(dj.objectValue?.keys ?? []) == ["job", "status", "run_id", "error"])
    #expect(dj["status"] == "failed")
    #expect(CanonicalJSON.string(try ContractCatalog.roundTrip(shape: "JobDoneEvent", dj)) == CanonicalJSON.string(dj))
  }
}
