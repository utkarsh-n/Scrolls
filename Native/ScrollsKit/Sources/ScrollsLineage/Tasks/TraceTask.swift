// OWNER: N5
// Job 'trace' (port of server/jobs/tasks/trace.mjs and lineage/trace.mjs `traceSpan`): the targeted quotation trace of
// one span, then the computed (and cue-proposed) links of a 'trace' run. Links the reuse index or an earlier trace already
// made (same type, same passages) are reported, not duplicated. AtlasService.trace waits ≤ 1.5 s for the job and
// otherwise answers with it while it continues (LiveAtlas+Trace.swift). The search only reads; the links are written in
// one guarded short write that also marks the run succeeded (`.commitsOnly`, ΔS-2: a trace never waits behind a bulk
// load for the writer). Registered in ScrollsService/TaskRegistry.swift (N0's file).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// The `trace` job.
public struct TraceTask: JobTask {
  public static let type = JobType(rawValue: "trace")
  public static let writes = WriteNeed.commitsOnly
  public static let resumable = false
  /// One span's candidates (≤ 400 passages, their documents' texts decoded once each).
  public static let budget = ResourceBudget(peakBytes: 96 << 20, maxThreads: 1, mayStartInBackground: false)

  let request: TraceRequest

  /// Params: `{passage, start, end, relative?}`.
  public init(params: JSONValue) throws {
    guard let p = params["passage"]?.safeInteger else {
      throw ScrollsError.badRequest(.validation, "Send { passage, start, end } as JSON.", detail: ["field": .null])
    }
    guard let s = params["start"]?.safeInteger, let e = params["end"]?.safeInteger else {
      throw ScrollsError.badRequest(.validation, "A trace needs integer start and end.", detail: ["field": "start"])
    }
    request = TraceRequest(passage: PassageID(rawValue: Int64(p)), start: s, end: e, relative: params["relative"]?.boolValue == true)
  }

  public init(_ request: TraceRequest) { self.request = request }

  /// The job's params for a request.
  public static func params(_ r: TraceRequest) -> JSONValue {
    ["passage": .number(Double(r.passage.rawValue)), "start": .number(Double(r.start)), "end": .number(Double(r.end)),
     "relative": .bool(r.relative == true)]
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    EngineAssert.offMain()
    let request = self.request, text = ctx.text, path = ctx.reads.path
    ctx.progress(0.05, phase: "trace", message: "searching")
    let result = try await ctx.read { c in try TraceQuery.run(LineageReader(c, text: text, atlasPath: path), request) }
    try await ctx.checkpoint()
    let span = result.span
    let run = try await ctx.startRun(Stage(rawValue: "trace"),
                                     params: ["passage": .number(Double(span.passage.id)), "start": .number(Double(span.start)),
                                              "end": .number(Double(span.end))],
                                     scope: [:], upstream: [], representation: nil, seed: nil,
                                     pipelineVersion: TraceQuery.pipelineVersion)
    let runId = run.id.rawValue
    // the run's metrics as the reference records them: `relationships` counts every id the trace reports (one per
    // match unless the span is excluded, one per cue unless structure or production text), repeats included
    let cuesAllowed = result.excluded == nil || result.excluded == "widely_shared"
    let reported = (result.excluded == nil ? result.exact.count + result.near.count : 0) + (cuesAllowed ? result.cues.count : 0)
    let metrics: JSONValue = ["exact": .number(Double(result.exact.count)), "near": .number(Double(result.near.count)),
                              "similar_wording": .number(Double(result.body["similar_wording"]?.arrayValue?.count ?? 0)),
                              "cues": .number(Double(result.cues.count)), "relationships": .number(Double(reported))]
    ctx.progress(0.8, phase: "trace", message: "writing links")
    let created = try await ctx.commitRun(run, metrics: metrics) { tx -> [Int64] in
      try TraceWrites.write(tx, result, runId: runId, text: text)
    }
    var unique: [Int64] = []
    var seen = Set<Int64>()
    for id in created where seen.insert(id).inserted { unique.append(id) }
    var out = result.body
    out["run_id"] = .number(Double(runId))
    out["created_relationships"] = .array(unique.map { .number(Double($0)) })
    ctx.progress(1, phase: "trace", message: "\(result.exact.count) exact, \(result.near.count) near")
    return .object(out)
  }
}

/// The trace job's writes (`traceSpan`'s transaction).
enum TraceWrites {
  /// A visible algorithmic link of the same type between the same passages.
  static func existing(_ c: Connection, _ relType: String, _ src: Int64, _ dst: Int64) throws -> Int64? {
    try c.prepared(LineageSQL.existingLink).bindingFirst([.text(relType), .text(String(src)), .text(String(dst))]) { $0.int(0) }
  }

  static func write(_ tx: WriteTx, _ result: TraceQuery.Result, runId: Int64, text: any TextStore) throws -> [Int64] {
    let c = tx.connection
    let docs = TraceQuery.Docs(c)
    let span = result.span
    guard let myDoc = try docs.get(span.docId) else { return [] }
    let me = Classify.Side(passage: span.passage.id, doc: myDoc)
    let at = StoreClock.isoNow()
    var created: [Int64] = []
    var texts: [Int64: [UInt16]] = [:]
    func fieldText(_ doc: Int64, _ field: String) throws -> (units: [UInt16], sha: String?) {
      if field == "body" {
        if texts[doc] == nil { texts[doc] = Array(try text.fullText(DocumentID(rawValue: doc), on: c).utf16) }
        let sha = try c.prepared(LineageSQL.originalSHA).bindingFirst([.int(doc)]) { $0.textOrNil(0) } ?? nil
        return (texts[doc]!, sha)
      }
      let v = try c.prepared(LineageSQL.fieldValue).bindingFirst([.int(doc), .text(field)]) { Array($0.text(0).utf16) } ?? []
      return (v, nil)
    }
    func write(_ m: TraceQuery.Match, exact: Bool) throws {
      if result.excluded != nil { return }
      guard let otherDoc = try docs.get(m.doc) else { return }
      let other = Classify.Side(passage: m.passage, doc: otherDoc)
      let k = Classify.classify(a: me, b: other, exact: exact, score: m.score)
      let method = exact ? Classify.Methods.traceExact : m.via == "lsh" ? Classify.Methods.traceNearLsh : Classify.Methods.traceNear
      if let found = try existing(c, k.relType, k.src.passage, k.dst.passage) {
        created.append(found)
        return
      }
      let field = try c.prepared(LineageSQL.passageField).bindingFirst([.int(m.passage)]) { $0.text(0) } ?? "body"
      let t = try fieldText(otherDoc.id, field)
      let detail = exact ? LineageJSON.ordered([("tokens", .number(Double(m.tokens)))])
        : LineageJSON.ordered([("alignment_score", m.score.map(JSONValue.number) ?? .null), ("jaccard", m.jaccard.map(JSONValue.number) ?? .null)])
      let mine = Classify.Evidence(role: "source_span", passage: me.passage, docId: myDoc.id, field: span.field, start: m.spanStart,
                                   end: m.spanEnd, text: span.text.units, sha: span.text.sha, detail: detail)
      let theirs = Classify.Evidence(role: "target_span", passage: m.passage, docId: otherDoc.id, field: field, start: m.start,
                                     end: m.end, text: t.units, sha: t.sha, detail: detail)
      var s = mine, d = theirs
      if k.src.passage != me.passage {
        s = theirs
        s.role = "source_span"
        d = mine
        d.role = "target_span"
      }
      created.append(try Classify.insert(tx, relType: k.relType, status: "computed", src: k.src, dst: k.dst, directed: k.directed,
                                         score: k.score, method: method, runId: runId, evidence: [s, d], at: at))
    }
    for m in result.exact { try write(m, exact: true) }
    for m in result.near { try write(m, exact: false) }
    var perCueOrder: [String] = []
    var perCue: [String: [(id: Int64, quote: String)]] = [:]
    // a cue naming the source of a famous line still proposes a citation; structure and production text never do
    let cues = result.excluded != nil && result.excluded != "widely_shared" ? [] : result.cues
    for cue in cues {
      let method = "attribution cue (\(cue.cue.lang ?? "null")): \"\(cue.cue.pattern)\""
      if let found = try existing(c, "explicit_citation", me.passage, cue.passage) {
        created.append(found)
        continue
      }
      guard let citedDoc = try docs.get(cue.doc) else { continue }
      let detail = LineageJSON.ordered([("quote", .string(cue.cue.quote)), ("name", cue.cue.name.map(JSONValue.string) ?? .null),
                                        ("referent", "inferred")])
      let ev = Classify.Evidence(role: "citation_cue", passage: me.passage, docId: myDoc.id, field: span.field, start: cue.cue.start,
                                 end: cue.cue.end, text: span.text.units, sha: span.text.sha, detail: detail)
      let id = try Classify.insert(tx, relType: "explicit_citation", status: "proposed", src: me,
                                   dst: Classify.Side(passage: cue.passage, doc: citedDoc), directed: 1, score: nil, method: method,
                                   runId: runId, evidence: [ev], at: at)
      created.append(id)
      let key = "\(cue.cue.start):\(cue.cue.end)"
      if perCue[key] == nil { perCueOrder.append(key) }
      perCue[key, default: []].append((id, cue.cue.quote))
    }
    // one cue naming an author with several matching texts: competing referents, side by side
    for key in perCueOrder {
      guard let list = perCue[key], list.count >= 2 else { continue }
      let gid = try Classify.insertGroup(tx, target: me.passage, question: "Which text does “\(list[0].quote)” refer to?", runId: runId,
                                         synthetic: myDoc.isSynthetic, at: at)
      for x in list { try Classify.setGroup(tx, x.id, gid) }
    }
    try Classify.writeCreateRevisions(tx, runId: runId, at: at)
    return created
  }
}
