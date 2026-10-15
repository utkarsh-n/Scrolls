// OWNER: N4
// GET /api/collocations in process (server/routes/collocations.mjs): collocates of an expression in one slice, or the
// gate with a widening suggestion and the KWIC rows shown instead; computed on the interactive reader with the
// reference's 5 s deadline. The payload is the reference's JSON; the contract type is decoded from it.

import Foundation
import ScrollsAnalysis
import ScrollsContracts
import ScrollsCore
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse {
    var toggles = JSONObject()
    for (k, v) in r.toggles ?? [:] { toggles[k] = .number(Double(v)) }
    let args = CollocationsArgs(
      expr: String(r.expr.rawValue), slice: r.slice ?? "", f: r.f ?? "", toggles: .object(toggles), stop: r.stop.map(JSONValue.string) ?? .null,
      corpus: r.corpus.flatMap { $0.isEmpty ? nil : $0 }, seed: r.seed.map { .number(Double($0)) } ?? .null, lane: r.lane,
      limit: try Paging.limit(r.limit, max: 200, default: 100))
    let payload = try await collocationsPayload(args)
    return try ScrollsJSON.decode(CollocationsResponse.self, from: payload)
  }

  /// The collocations payload exactly as the reference shapes it (the differential test compares this).
  @concurrent
  public func collocationsPayload(_ args: CollocationsArgs, environment: AnalysisEnvironment? = nil,
                                  deadline: Duration = .seconds(5)) async throws -> JSONValue {
    let env = environment ?? analysisEnvironment
    let text = self.text
    do {
      return try await reads.read(.interactive, deadline: deadline) { c in
        try Collocations.query(c, text: text, args: args, env: env)
      }
    } catch let e as ScrollsError where e.code == .queryTimeout {
      throw ScrollsError(code: .queryTimeout, message: "The collocation query took longer than 5 s and was stopped.",
                         hint: "Narrow the time range or add a filter, then retry.", detail: ["timeout_ms": 5000], status: 503)
    }
  }
}
