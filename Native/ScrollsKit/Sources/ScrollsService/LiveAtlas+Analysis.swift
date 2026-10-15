// OWNER: N4
// Analysis runs in process (server/routes/analysis.mjs; SPEC §4.0, §7.1):
//   runs(_:)      GET /api/analysis/runs?stage=&expr=&limit=&cursor= → newest first
//   startRun(_:)  POST /api/analysis/runs {stage, params?, expr?} → the job, or the identical finished run reused
// Startable stages: tokstream (token streams), drift and tone (params = a Compare request, as saved when it carries pins
// and cutoffs), and the other stages' tasks with their params passed through. A stage whose task has not landed in
// TaskRegistry is refused by the queue (E_JOB_TYPE), never faked.

import Foundation
import ScrollsAnalysis
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// The statements of the runs list.
public enum AnalysisRunsSQL: SQLCatalog {
  static let list = SQL("analysis.runs.list", """
    SELECT id, stage, status, pipeline_version, params_json, started_at, finished_at, representation FROM analysis_run r
      WHERE (?1 IS NULL OR r.stage = ?1) AND (?2 IS NULL OR r.id < ?2)
        AND (?3 IS NULL OR json_extract(r.params_json, '$.expr') = ?3 OR json_extract(r.params_json, '$.expression') = ?3
             OR EXISTS (SELECT 1 FROM json_each(r.params_json, '$.expr') j WHERE j.value = ?3)
             OR json_extract(r.scope_json, '$.expression') = ?3)
      ORDER BY r.id DESC LIMIT ?4
    """, scan: .scanOK(reason: "analysis_run is small (one row per run); newest first by its primary key"))
  static let runJob = SQL("analysis.runs.job", "SELECT job_id FROM analysis_run WHERE id = ?")
  public static let all: [SQL] = [list, runJob]
}

extension LiveAtlas {
  static let startableStages = ["tokstream", "collocations", "vectors", "drift", "tone", "cluster", "layout", "reuse-index"]

  @concurrent
  public func runs(_ r: RunsRequest) async throws -> RunsResponse {
    if let s = r.stage, !s.isEmpty, !Vocab.stages.contains(s) {
      throw ScrollsError.badRequest(.validation, "Unknown stage '\(s)'.", hint: "Use one of \(Vocab.stages.joined(separator: ", ")).",
                                    detail: ["stage": .string(s)])
    }
    let limit = try Paging.limit(r.limit, max: 200, default: 50)
    let before = try Paging.decodeCursor(r.cursor)?["before"]?.safeInteger
    let stage = r.stage.flatMap { $0.isEmpty ? nil : $0 }
    let expr = r.expr.map { Int64($0.rawValue) }
    let items = try await reads.read(.interactive, deadline: .seconds(5)) { c in
      let s = try c.prepared(AnalysisRunsSQL.list)
      try s.bind(stage.map(SQLValue.text) ?? .null, before.map { .int(Int64($0)) } ?? .null, expr.map(SQLValue.int) ?? .null,
                 .int(Int64(limit)))
      return try s.all { row in
        RunInfo(id: RunID(rawValue: row.int(0)), stage: row.text(1), status: row.text(2), pipelineVersion: row.text(3),
                params: (try? JSONValue.parse(row.text(4))) ?? .object([:]), startedAt: row.text(5), finishedAt: row.textOrNil(6),
                representation: row.textOrNil(7))
      }
    }
    var out = RunsResponse(items: items)
    out.$cursor = items.count == limit ? .value(Paging.encodeCursor(["before": .number(Double(items.last!.id.rawValue))])) : .null
    return out
  }

  @concurrent
  public func startRun(_ r: StartRunRequest) async throws -> StartRunResponse {
    let stage = r.stage
    guard Self.startableStages.contains(stage) else {
      throw ScrollsError.badRequest(.validation, "Unknown stage '\(stage)'.", hint: "Use \(Self.startableStages.joined(separator: ", ")).",
                                    detail: ["stage": .string(stage)])
    }
    let params = r.params?.objectValue ?? JSONObject()
    if CanonicalJSON.string(.object(params)).utf16.count > 10000 {
      throw ScrollsError.badRequest(.validation, "params is too large.", detail: ["field": "params"])
    }
    switch stage {
    case "tokstream": return try await startTokstream(params)
    case "drift", "tone":
      var body = params
      if body["expr"] == nil, let e = r.expr { body["expr"] = [.number(Double(e.rawValue))] }
      let req = try SliceRequests.normalizeCompare(.object(body))
      var p: JSONObject = ["expr": .array(req.expr.map { .number(Double($0)) }), "a": req.a.json, "b": req.b.json, "toggles": req.toggles.json,
                           "corpus": req.corpus.map(JSONValue.string) ?? .null]
      if let runs = req.runs { p["runs"] = runs.json }
      if let cutoffs = req.cutoffs { p["cutoffs"] = cutoffs.json }
      let job = try await jobQueue.enqueue(JobSpec(type: JobType(stage), params: .object(p)))
      return StartRunResponse(job: Int(job.rawValue), run: nil, reused: false)
    default:
      var p = params
      if let e = r.expr { p["expr"] = .number(Double(e.rawValue)) }
      let job = try await jobQueue.enqueue(JobSpec(type: JobType(stage), params: .object(p)))
      return StartRunResponse(job: Int(job.rawValue), run: nil, reused: false)
    }
  }

  /// tokstream: reuse the run whose streams are all current, else queue the job.
  func startTokstream(_ params: JSONObject) async throws -> StartRunResponse {
    var langs: [String]?
    if let l = params["langs"], !l.isNull {
      let ok = l.arrayValue?.allSatisfy { v in
        guard let s = v.stringValue, (1...32).contains(s.utf8.count) else { return false }
        return s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D }
      } ?? false
      guard ok else {
        throw ScrollsError.badRequest(.validation, "params.langs must list language codes.", hint: "e.g. {\"langs\": [\"en\"]}",
                                      detail: ["field": "params.langs"])
      }
      langs = l.arrayValue?.compactMap(\.stringValue)
    } else if let l = params["lang"]?.stringValue {
      langs = [l]
    }
    let dir = location.derivedDir.appendingPathComponent("tokens")
    if let langs, !langs.isEmpty {
      let reuse: (run: Int, job: Int)? = try await reads.read(.interactive, deadline: .seconds(5)) { c in
        for l in langs {
          if !(try TokenStreams.status(c, dir, l).fresh) { return nil }
        }
        guard let m = try? JSONValue.parse(Data(contentsOf: dir.appendingPathComponent("\(langs[0]).json"))),
              let run = m["run_id"]?.safeInteger else { return nil }
        let s = try c.prepared(AnalysisRunsSQL.runJob)
        guard let job = try s.bindingFirst([.int(Int64(run))], { $0.intOrNil(0) }) ?? nil else { return nil }
        return (run, Int(job))
      }
      if let reuse { return StartRunResponse(job: reuse.job, run: RunID(reuse.run), reused: true) }
    }
    let job = try await jobQueue.enqueue(JobSpec(type: TokStreamTask.type, params: ["langs": langs.map { .array($0.map(JSONValue.string)) } ?? .null]))
    return StartRunResponse(job: Int(job.rawValue), run: nil, reused: false)
  }
}
