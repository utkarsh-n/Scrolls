// OWNER: N2
// The starter (IOS-SPEC §3.3 slot 0, §3.6): what `scrolls-cli starter` bundles and what the phone's self-test rebuilds to
// prove "the starter rebuilt on the device = the bundled one" (G6). From nothing, by this engine:
//   1. a new device atlas with the seeded vocabulary and corpora (slot 0);
//   2. `demo-load`: the SYNTHETIC demo through the ordinary import path (the demo pack written from the engine resources);
//   3. the demo's pipeline where this build has it: the tour's expressions tracked (AtlasService.trackExpression, which
//      queues their materialization) and every queued job run to its end. A part that is not built yet is reported in
//      `pending` with the engine's own reason, never faked;
//   4. the WAL checkpointed into the file, then `atlas.sqlite` and `ATLAS.json` (with the LogicalDump fingerprints)
//      copied into the output directory.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsSources
import ScrollsStore

public enum StarterBuild {
  /// Builds the starter in the work root `root` and copies it into the directory `out` (created). Returns the report.
  public static func build(root: URL, into out: URL, conditions: any DeviceConditionsSource = Unthrottled()) async throws
    -> JSONObject
  {
    let fm = FileManager.default
    let location = try AtlasLocation.at(root: root)
    guard !fm.fileExists(atPath: location.atlasPath) else {
      throw ScrollsError(code: .validation, message: "\(root.path) already holds an atlas.", hint: "Use an empty work root.",
                         status: 409)
    }
    var report: JSONObject = ["status": "failed"]
    var pending: [JSONValue] = []

    // 1–2. vocabulary, then the demo world
    let engine = try await AtlasEngine.open(location, origin: .empty, conditions: conditions)
    let load = try await engine.run(JobSpec(type: DemoLoadTask.type, params: [:], priority: 1, actor: "scrolls"))
    await engine.close()
    guard load.status == .succeeded else {
      report["demo_load"] = .string("\(load.status.rawValue): \(load.error?.message ?? load.message ?? "")")
      return report
    }
    report["demo_load"] = load.result ?? .null
    if let p = load.result?["human_layer"]?["pending"]?.arrayValue { pending += p }

    // 3. the demo's pipeline, through the same API the app uses
    let atlas = try await LiveAtlas.open(location, conditions: conditions, launch: .cli)
    var tracked: [JSONValue] = []
    do {
      let tour = try await atlas.tour()
      var wanted: [TrackExpressionRequest] = []
      for step in tour.steps { for t in step.track ?? [] where !wanted.contains(t) { wanted.append(t) } }
      if wanted.isEmpty {
        for e in DemoLoadTask.tourExpressions {
          wanted.append(TrackExpressionRequest(surface: e.surface, lang: e.lang, kind: e.kind, corpus: "demo"))
        }
      }
      for t in wanted {
        do {
          let e = try await atlas.trackExpression(t)
          tracked.append(.string("\(t.surface) → expression \(e.expression.id.rawValue)"))
        } catch let e as ScrollsError {
          pending.append(.string("expression '\(t.surface)': \(e.code.rawValue) — \(e.message)"))
        }
      }
      try await drain(atlas.jobQueue, pending: &pending)
    } catch let e as ScrollsError {
      pending.append(.string("tour: \(e.code.rawValue) — \(e.message)"))
    }
    await atlas.close()
    report["tracked"] = .array(tracked)

    // 4. checkpoint (a few MB: the demo world), fingerprints, copy
    let w = try Writer(path: location.atlasPath, profile: .device)
    _ = try await w.checkpoint(.truncate)
    try await w.close()
    let manifest: GenerationManifest
    do {
      let c = try Connection(path: location.atlasPath, mode: .readOnly, profile: .device)
      defer { c.close() }
      let fp = try GenerationManifest.fingerprints(c, text: ChunkedTextStore(), scratch: root.appendingPathComponent("dump"))
      manifest = try GenerationManifest.read(c, fingerprints: fp)
      report["counts"] = .object(try counts(c))
    }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    try fm.copyItem(at: URL(fileURLWithPath: location.atlasPath), to: out.appendingPathComponent("atlas.sqlite"))
    try manifest.write(to: out.appendingPathComponent(GenerationManifest.fileName))
    report["generation"] = .string(manifest.generation)
    report["fingerprinted_tables"] = .number(Double(manifest.fingerprints.count))
    report["pending"] = .array(pending)
    report["path"] = .string(out.path)
    report["status"] = "built"
    return report
  }

  /// Runs the queue until no job is queued or running (an hour at most); a failed job is reported in `pending`.
  static func drain(_ queue: JobQueue, pending: inout [JSONValue]) async throws {
    let deadline = ContinuousClock.now + .seconds(3600)
    var seen = Set<JobID>()
    while ContinuousClock.now < deadline {
      let open = try await queue.snapshot(.queued) + queue.snapshot(.running)
      if open.isEmpty { break }
      for j in open where seen.insert(j.id).inserted { _ = j }
      if let first = open.first { _ = await queue.wait(for: first.id, timeout: .seconds(60)) }
    }
    for id in seen {
      if let j = try await queue.job(id), j.status != .succeeded {
        pending.append(.string("job \(j.type.rawValue): \(j.status.rawValue) — \(j.error?.message ?? j.message ?? "")"))
      }
    }
  }

  /// Row counts a reader checks at a glance.
  static func counts(_ c: Connection) throws -> JSONObject {
    var o = JSONObject()
    for (k, sql) in [("documents", StarterSQL.documents), ("passages", StarterSQL.passages), ("relationships", StarterSQL.relationships),
                     ("annotations", StarterSQL.annotations), ("expressions", StarterSQL.expressions),
                     ("runs", StarterSQL.runs)] {
      o[k] = .number(Double(try c.prepared(sql).first { $0.int(0) } ?? 0))
    }
    return o
  }
}

/// The starter's report counts.
public enum StarterSQL: SQLCatalog {
  static let documents = SQL("starter.documents", "SELECT count(*) FROM document", scan: .scanOK(reason: "the starter's report, once"))
  static let passages = SQL("starter.passages", "SELECT count(*) FROM passage", scan: .scanOK(reason: "the starter's report, once"))
  static let relationships = SQL("starter.relationships", "SELECT count(*) FROM relationship",
                                 scan: .scanOK(reason: "the starter's report, once"))
  static let annotations = SQL("starter.annotations", "SELECT count(*) FROM annotation", scan: .scanOK(reason: "the starter's report, once"))
  static let expressions = SQL("starter.expressions", "SELECT count(*) FROM expression", scan: .scanOK(reason: "the starter's report, once"))
  static let runs = SQL("starter.runs", "SELECT count(*) FROM analysis_run", scan: .scanOK(reason: "the starter's report, once"))
  public static let all: [SQL] = [documents, passages, relationships, annotations, expressions, runs]
}
