// OWNER: N4
// Job 'tokstream' (server/jobs/tasks/tokstream.mjs; SPEC §4.7): writes the token-id streams per language into the
// atlas's `derived/tokens/` (the reference's layout), from one read snapshot, so collocations and Compare's neighbouring
// terms read large slices without tokenizing them again. params: {langs?: [string]} or {lang: string} (absent = every
// language with quality='ok' passages). Read-only for the database (`writes: false` in vocab.JOB_TYPES): its only rows
// are its analysis_run, opened and closed through the writer's short transactions (ΔS-2). The streams live beside the
// atlas: `derived/` of the directory that holds `atlas.sqlite` (AtlasLocation: `Atlas/derived`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

public struct TokStreamTask: JobTask {
  public static let type = JobType("tokstream")
  public static let writes = WriteNeed.commitsOnly
  public static let resumable = false
  /// The English stream of Cipher (≈ 36 M tokens): ids in memory as u32 (≈ 150 MB) plus the vocabulary.
  public static let budget = ResourceBudget(peakBytes: 400 << 20, maxThreads: 1, mayStartInBackground: false)

  let langs: [String]?

  public init(params: JSONValue) throws {
    if let a = params["langs"]?.arrayValue, !a.isEmpty {
      guard a.allSatisfy({ $0.stringValue != nil }) else {
        throw ScrollsError.badRequest(.validation, "langs must list language codes.", detail: ["field": "langs"])
      }
      langs = a.compactMap(\.stringValue)
    } else if let l = params["lang"]?.stringValue, !l.isEmpty {
      langs = [l]
    } else {
      langs = nil
    }
  }

  /// `derived/tokens` beside the atlas the job reads.
  static func tokensDir(_ ctx: JobContext) -> URL {
    URL(fileURLWithPath: ctx.reads.path).deletingLastPathComponent().appendingPathComponent("derived/tokens")
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    let langsJSON: JSONValue = langs.map { .strings($0) } ?? .null
    let run = try await ctx.startRun(Stage(rawValue: "tokstream"), params: ["langs": langsJSON], scope: ["langs": langsJSON],
                                     upstream: [], representation: nil, seed: nil, pipelineVersion: TokenStreams.version)
    let dir = Self.tokensDir(ctx)
    let langs = self.langs
    let runID = Int(run.id.rawValue)
    do {
      let result = try await ctx.read { c in
        try TokenStreams.build(c, text: ctx.text, dir: dir, langs: langs, runID: runID, checkpoint: { try ctx.checkStop() },
                               progress: { f, msg in ctx.progress(f, phase: "tokstream", message: msg) })
      }
      try await ctx.finishRun(run, .succeeded, metrics: result.json)
      var out: JSONObject = ["run_id": .int(runID)]
      for (k, v) in result.json.objectValue ?? [:] { out[k] = v }
      return .object(out)
    } catch {
      try? await ctx.finishRun(run, error is CancellationError ? .cancelled : .failed, metrics: nil)
      throw error
    }
  }
}
