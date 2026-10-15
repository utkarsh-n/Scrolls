// OWNER: N4
// POST /api/compare in process (server/routes/compare.mjs + analysis/compare.mjs): the comparison runs on the
// interactive reader in one WAL snapshot (5 s deadline → QUERY_TIMEOUT, as the reference's read pool), and the
// multiplicity log (compare_log) is kept by the writer: k counts the distinct comparisons of these expressions in this
// session (the per-launch SessionID, ΔS-1), including this one. As-saved requests compute with the view's pins and
// cutoffs (RF-2). The payload is the reference's JSON; the contract types are decoded from it.

import Foundation
import ScrollsAnalysis
import ScrollsContracts
import ScrollsNL
import ScrollsCore
import ScrollsStore

/// The statements of the multiplicity log.
public enum CompareSQL: SQLCatalog {
  static let prior = SQL("compare.log.prior", """
    SELECT request_hash, MAX(notable_count) AS notable FROM compare_log
      WHERE session_id = ? AND expression_key = ? GROUP BY request_hash
    """)
  static let insert = SQL("compare.log.insert", """
    INSERT INTO compare_log (id, session_id, expression_key, request_hash, measures_json, notable_count, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    """)
  public static let all: [SQL] = [prior, insert]
}

extension LiveAtlas {
  @concurrent
  public func compare(_ r: CompareRequest) async throws -> CompareResponse {
    let payload = try await comparePayload(try ScrollsJSON.value(r))
    return try ScrollsJSON.decode(CompareResponse.self, from: Self.typedComparePayload(payload))
  }

  /// The reference sends OpenAlex's within-cell shares at the top level (`within_cell`); contract 1.3.0's Swift type
  /// carries them in `coverage.within_cell`. They are moved there for the typed response only (the payload the
  /// differential test compares keeps the reference's shape), so the phone shows them instead of dropping them.
  static func typedComparePayload(_ payload: JSONValue) -> JSONValue {
    guard var o = payload.objectValue, let wc = o["within_cell"], var cov = o["coverage"]?.objectValue else { return payload }
    cov["within_cell"] = wc
    o["coverage"] = .object(cov)
    return .object(o)
  }

  /// The environment of this atlas's analysis reads: Apple's NaturalLanguage as probed on this device, no Ngram store
  /// until the STEMM baseline arrives (N2, M2), the atlas's own token streams.
  public var analysisEnvironment: AnalysisEnvironment {
    AnalysisEnvironment(tone: NLAvailability.current, ngram: NgramStoreAbsent.phone,
                        tokenStreams: location.derivedDir.appendingPathComponent("tokens"))
  }

  /// The Compare payload exactly as the reference shapes it (the differential test compares this). `session` names the
  /// multiplicity log's session (default: this launch's); `environment` replaces the phone's (a differential run passes
  /// the reference's); `deadline` is the read pool's 5 s (a differential run lifts it: the goldens are generated through
  /// the route handler without the pool's timer, so a slow reference answer is still a 200 there).
  @concurrent
  public func comparePayload(_ body: JSONValue, session: String? = nil, environment: AnalysisEnvironment? = nil,
                             deadline: Duration = .seconds(5)) async throws -> JSONValue {
    let req = try SliceRequests.normalizeCompare(body)
    let session = session ?? self.session
    let key = Multiplicity.expressionKey(req.expr)
    let hash = Multiplicity.comparisonHash(req)
    let env = environment ?? analysisEnvironment
    let text = self.text
    let (prior, payload): ([String: Int], JSONValue)
    do {
      (prior, payload) = try await reads.read(.interactive, deadline: deadline) { c in
        var prior: [String: Int] = [:]
        let s = try c.prepared(CompareSQL.prior)
        try s.bind(.text(session), .text(key))
        while let row = try s.step() { prior[row.text(0)] = Int(row.int(1)) }
        let isNew = prior[hash] == nil
        let notable = prior.filter { $0.key != hash && $0.value > 0 }.count
        let k = prior.count + (isNew ? 1 : 0)
        let p = try CompareEngine.payload(c, text: text, request: req,
                                          multiplicity: .init(k: k, notableSoFar: notable), env: env)
        return (prior, p)
      }
    } catch let e as ScrollsError where e.code == .queryTimeout {
      throw ScrollsError(code: .queryTimeout, message: "The comparison took longer than 5 s and was stopped.",
                         hint: "Narrow the time range or add a filter, then retry.", detail: ["timeout_ms": 5000], status: 503)
    }
    if prior[hash] == nil {
      let notableNow = payload["measures"]?.arrayValue?.filter { $0["verdict"] == "notable" }.count ?? 0
      let measures = CanonicalJSON.string(.array(req.measures.map(JSONValue.string)))
      try await writer.write("compare_log") { tx in
        let id = try tx.ids.nextLog("compare_log")
        let ins = try tx.connection.prepared(CompareSQL.insert)
        try ins.bind(.int(id), .text(session), .text(key), .text(hash), .text(measures), .int(Int64(notableNow)),
                     .text(StoreClock.isoNow()))
        try ins.run()
      }
    }
    return payload
  }
}
