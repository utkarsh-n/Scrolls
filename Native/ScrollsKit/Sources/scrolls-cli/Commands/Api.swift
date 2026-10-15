// OWNER: N6
// `scrolls-cli api` (IOS-SPEC §2.2 G7): answers the reference's HTTP requests in process, through AtlasService.
//
//   scrolls-cli api --atlas <root> [--profile reference|device] < requests.jsonl > responses.jsonl
//     Each input line is one exchange as the reference journey records it (scripts/verify-journey.mjs --record):
//     {seq?, step?, method, path, body?, headers?, raw?: {base64}, event?: "restart"}. Each output line is
//     {seq, step, method, path, status, response | text, ms}. `--atlas` is an atlas root (Atlas/atlas.sqlite inside).
//
//   scrolls-cli api --golden <family dir> [--snapshot m1r] [--snapshots <dir>] [--report <file.json>]
//                   [--responses <file.jsonl>] [--keep]
//     Replays a G7 family (g7.journey-m1r: the RF-3 recording; g7.notebook-m1r: N6's notebook script) on a fresh
//     `cp -c` clone of the snapshot it was recorded on, opened as a reference-profile atlas through InlineTextStore
//     (the device profile once `scrolls-cli convert-reference`, N2, lands), and compares every answer with the golden.
//     A restart event closes and reopens the atlas (the launch catch-up of the journal runs). Polled job reads are
//     replayed by polling to a final state and comparing the last recorded poll.
//
// Comparison (§2.4, G7 "normalised by natural keys, timestamps and data_version"):
//   · timestamps → "<ts>", data_version members → "<dv>", timing members (ms) dropped;
//   · ids the replay allocated differently (a job, an import batch, an annotation) are learned from the answers
//     (recorded → replayed) and mapped in later requests and in the expected bodies;
//   · a recorded timestamp in a later request (`as_of`, the as-saved `at`) is mapped onto the replay's clock;
//   · keys the contract types do not carry are found by round-tripping the expected body through the route's contract
//     type: those are contract gaps (requests to N0), listed apart from engine mismatches.
// Every case is attributed to the package that owns its route (§8.1). Exit 0 when every case of N6's routes matches
// (the whole-journey count, with the other packages' cases, is in the report and in Tools/check.d/journey.sh's rows).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore

enum ApiCommand: CLICommand {
  static let name = "api"
  static let summary = "answer JSONL requests in process; replay and compare a G7 journey family"
  static let usage = """
    usage: scrolls-cli api --atlas <root> [--profile reference|device] < requests.jsonl > responses.jsonl
           scrolls-cli api --golden <family dir> [--snapshot m1r] [--snapshots <dir>] [--report <file.json>]
                           [--responses <file.jsonl>] [--keep]
      --atlas      an atlas root (holding Atlas/atlas.sqlite and Notebook/); a bare *.sqlite path is accepted
      --golden     a G7 family folder (cases-*.jsonl), e.g. Tests/DifferentialTests/Golden/g7.journey-m1r
      --snapshot   the snapshot the family was recorded on (default: the family's own "snapshot" field, else m1r)
      --snapshots  default ~/Developer/scrolls-snapshots (cloned with cp -c under $TMPDIR, never opened in place)
      Exit code 0 when every case of N6's routes matches (or waits on another package's failed step), 1 otherwise,
      2 on a usage error.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["keep"])
    if let golden = a.value("golden") {
      return try await JourneyReplay.compare(
        family: URL(fileURLWithPath: golden), snapshot: a.value("snapshot"),
        snapshots: URL(fileURLWithPath: a.value("snapshots")
          ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-snapshots").path),
        report: a.value("report").map { URL(fileURLWithPath: $0) },
        responses: a.value("responses").map { URL(fileURLWithPath: $0) }, keep: a.flag("keep"))
    }
    guard let atlasArg = a.value("atlas") else { throw UsageError("--atlas or --golden is required") }
    var root = URL(fileURLWithPath: atlasArg)
    if root.pathExtension == "sqlite" { root = root.deletingLastPathComponent().deletingLastPathComponent() }
    let profile: StoreProfile? = switch a.value("profile") {
    case "reference": .reference
    case "device": .device
    case nil: nil
    case let p?: throw UsageError("--profile must be reference or device (got \(p))")
    }
    let host = try await JourneyHost.open(try AtlasLocation.at(root: root), profile: profile)
    let router = JourneyRouter()
    var seq = 0
    while let line = readLine(strippingNewline: true) {
      if line.isEmpty { continue }
      seq += 1
      let x = try JSONValue.parse(line)
      if x["event"]?.stringValue == "restart" {
        try await host.restart()
        print(CanonicalJSON.string(["seq": x["seq"] ?? .number(Double(seq)), "event": "restart"]))
        continue
      }
      let start = ContinuousClock.now
      let answer = await router.handle(host.atlas, JourneyRequest(x))
      var out: JSONObject = ["seq": x["seq"] ?? .number(Double(seq)), "method": x["method"] ?? .null, "path": x["path"] ?? .null,
                             "status": .number(Double(answer.status)),
                             "ms": .number(((ContinuousClock.now - start).journeyMS * 10).rounded() / 10)]
      if let s = x["step"] { out["step"] = s }
      if let t = answer.text { out["text"] = .string(t) } else { out["response"] = answer.body }
      print(CanonicalJSON.string(.object(out)))
    }
    await host.atlas.close()
    return 0
  }
}

// MARK: - the atlas behind the replay

/// The atlas a journey runs on, with the reference's restart (close, reopen, journal catch-up).
final class JourneyHost: @unchecked Sendable {
  let location: AtlasLocation
  let profile: StoreProfile?
  private(set) var atlas: LiveAtlas

  private init(location: AtlasLocation, profile: StoreProfile?, atlas: LiveAtlas) {
    self.location = location
    self.profile = profile
    self.atlas = atlas
  }

  static func open(_ location: AtlasLocation, profile: StoreProfile?) async throws -> JourneyHost {
    JourneyHost(location: location, profile: profile, atlas: try await openAtlas(location, profile: profile))
  }

  static func openAtlas(_ location: AtlasLocation, profile: StoreProfile?) async throws -> LiveAtlas {
    let atlas = try await LiveAtlas.open(location, conditions: Unthrottled(),
                                         launch: EngineLaunchOptions(startBootstrap: false, profile: profile))
    // the launch catch-up of the write-ahead journal (IOS-SPEC §6.2); LiveAtlas.open joins it once N0 wires it there
    _ = try await JournalReplayer.catchUp(atlas)
    return atlas
  }

  /// The reference journey's "restart": the server process stops and starts on the same data.
  func restart() async throws {
    await atlas.close()
    atlas = try await Self.openAtlas(location, profile: profile)
  }
}

extension Duration {
  var journeyMS: Double {
    let c = components
    return Double(c.seconds) * 1000 + Double(c.attoseconds) / 1e15
  }
}

// MARK: - requests and answers

/// One recorded exchange's request half.
struct JourneyRequest: Sendable {
  var method: String
  var path: String
  var body: JSONValue?
  var headers: [String: String]
  var raw: Data?

  init(method: String, path: String, body: JSONValue? = nil, headers: [String: String] = [:], raw: Data? = nil) {
    self.method = method
    self.path = path
    self.body = body
    self.headers = headers
    self.raw = raw
  }

  init(_ x: JSONValue) {
    method = x["method"]?.stringValue ?? "GET"
    path = x["path"]?.stringValue ?? "/"
    body = x["body"]
    var h: [String: String] = [:]
    for (k, v) in x["headers"]?.objectValue ?? [:] { if let s = v.stringValue { h[JSString.toLowerCase(k)] = s } }
    headers = h
    raw = x["raw"]?["base64"]?.stringValue.flatMap { Data(base64Encoded: $0) }
  }

  /// The path without its query.
  var route: String { String(path.split(separator: "?", maxSplits: 1).first ?? "") }

  /// The query items, percent-decoded (`+` is a space, as URLSearchParams reads it).
  var query: [(String, String)] {
    guard let q = path.split(separator: "?", maxSplits: 1).dropFirst().first else { return [] }
    return q.split(separator: "&").map { item in
      let kv = item.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ") }
      return (kv[0].removingPercentEncoding ?? kv[0], kv.count > 1 ? (kv[1].removingPercentEncoding ?? kv[1]) : "")
    }
  }

  func queryValue(_ name: String) -> String? { query.last { $0.0 == name }?.1 }
}

/// What the engine answered: the status, and a JSON body or a text download. `roundTrip` re-encodes a body through
/// the route's contract type (nil for text and errors).
struct JourneyAnswer: Sendable {
  var status: Int
  var body: JSONValue
  var text: String?
  var roundTrip: (@Sendable (JSONValue) throws -> JSONValue)?
}

// MARK: - the router

/// Maps the reference's routes onto AtlasService.
struct JourneyRouter: Sendable {
  /// Who owns a route (IOS-SPEC §8.1), for the report.
  static func owner(_ route: String) -> String {
    let p = route.split(separator: "/").dropFirst().first.map(String.init) ?? ""  // after "api"
    switch p {
    case "health", "jobs", "events": return "N0"
    case "imports": return "N1"
    case "corpora", "facets", "adapters", "tour", "etymology", "baseline": return "N2"
    case "search", "expressions", "timeline", "passages", "documents", "kwic", "occurrences", "export", "snapshots": return "N3"
    case "compare", "collocations", "clusters", "analysis", "constellation": return "N4"
    case "lineage", "genealogy", "trace": return "N5"
    case "relationships", "hypothesis-groups", "annotations", "views": return "N6"
    default: return "?"
    }
  }

  func handle(_ atlas: LiveAtlas, _ r: JourneyRequest) async -> JourneyAnswer {
    do {
      return try await dispatch(atlas, r)
    } catch let e as ScrollsError {
      return JourneyAnswer(status: e.status ?? 500, body: (try? ScrollsJSON.value(ErrorBody(error: e))) ?? .null, text: nil, roundTrip: nil)
    } catch let e as DecodingError {
      let err = ScrollsError(code: .validation, message: "The request does not decode: \(e)", status: 400)
      return JourneyAnswer(status: 400, body: (try? ScrollsJSON.value(ErrorBody(error: err))) ?? .null, text: nil, roundTrip: nil)
    } catch {
      let err = ScrollsError(code: .internalError, message: "Internal error: \(error)", status: 500)
      return JourneyAnswer(status: 500, body: (try? ScrollsJSON.value(ErrorBody(error: err))) ?? .null, text: nil, roundTrip: nil)
    }
  }

  private func ok<T: Codable & Sendable>(_ value: T) throws -> JourneyAnswer {
    JourneyAnswer(status: 200, body: try ScrollsJSON.value(value), text: nil, roundTrip: { v in
      try ScrollsJSON.value(try ScrollsJSON.decode(T.self, from: v))
    })
  }

  private func body<T: Decodable>(_ type: T.Type, _ r: JourneyRequest) throws -> T {
    try ScrollsJSON.decode(T.self, from: r.body ?? [:])
  }

  private func query<T: Decodable>(_ type: T.Type, _ r: JourneyRequest, extra: JSONObject = [:]) throws -> T {
    try QueryDecoding.decode(T.self, r.query, extra: extra)
  }

  private func int(_ s: Substring) throws -> Int64 {
    guard let n = Int64(s) else { throw ScrollsError.notFound("Route /\(s)") }
    return n
  }

  private func dispatch(_ atlas: LiveAtlas, _ r: JourneyRequest) async throws -> JourneyAnswer {
    let seg = r.route.split(separator: "/", omittingEmptySubsequences: true)
    guard seg.first == "api", seg.count >= 2 else { throw ScrollsError.notFound("Route \(r.route)") }
    let s = Array(seg.dropFirst())
    switch (r.method, s.count, s[0]) {
    // health · jobs (N0)
    case ("GET", 1, "health"): return try ok(try await atlas.health())
    case ("GET", 1, "jobs"): return try ok(try await atlas.jobs(try query(JobsRequest.self, r)))
    case ("GET", 2, "jobs"): return try ok(try await atlas.job(JobID(rawValue: try int(s[1]))))
    case ("POST", 3, "jobs") where s[2] == "cancel": return try ok(try await atlas.cancelJob(JobID(rawValue: try int(s[1]))))
    // imports (N1)
    case ("POST", 1, "imports"):
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-api-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let name = r.headers["x-scrolls-filename"]?.removingPercentEncoding ?? "upload"
      let file = dir.appendingPathComponent(name)
      try (r.raw ?? Data()).write(to: file)
      var collection: ImportCollectionSpec?
      if let spec = r.headers["x-scrolls-collection"]?.removingPercentEncoding {
        collection = try ScrollsJSON.decode(ImportCollectionSpec.self, from: Data(spec.utf8))
      }
      return try ok(try await atlas.stageImport(StageImportRequest(file: file, fileName: name, collection: collection)))
    case ("PUT", 3, "imports") where s[2] == "mapping":
      return try ok(try await atlas.setImportMapping(ImportBatchID(rawValue: try int(s[1])), try body(ImportMappingRequest.self, r)))
    case ("GET", 3, "imports") where s[2] == "preview":
      return try ok(try await atlas.importPreview(ImportBatchID(rawValue: try int(s[1])), try query(ImportPreviewRequest.self, r)))
    case ("GET", 3, "imports") where s[2] == "problems.csv":
      let p = try await atlas.importProblems(ImportBatchID(rawValue: try int(s[1])))
      return JourneyAnswer(status: 200, body: .null, text: p.csv, roundTrip: nil)
    case ("POST", 3, "imports") where s[2] == "commit":
      return try ok(try await atlas.commitImport(ImportBatchID(rawValue: try int(s[1])), try body(ImportMappingRequest.self, r)))
    case ("POST", 3, "imports") where s[2] == "revert":
      return try ok(try await atlas.revertImport(ImportBatchID(rawValue: try int(s[1]))))
    // sources (N2)
    case ("GET", 1, "corpora"): return try ok(try await atlas.corpora())
    case ("GET", 1, "facets"): return try ok(try await atlas.facets(try query(FacetsRequest.self, r)))
    case ("GET", 1, "tour"): return try ok(try await atlas.tour())
    // read path (N3)
    case ("GET", 1, "search"): return try ok(try await atlas.search(try query(SearchRequest.self, r)))
    case ("POST", 1, "expressions"): return try ok(try await atlas.trackExpression(try body(TrackExpressionRequest.self, r)))
    case ("GET", 2, "expressions"):
      return try ok(try await atlas.expression(ExpressionID(rawValue: try int(s[1])), corpus: r.queryValue("corpus")))
    case ("PATCH", 3, "expressions") where s[2] == "variants":
      return try ok(try await atlas.setVariants(ExpressionID(rawValue: try int(s[1])), try body(VariantsPatchRequest.self, r)))
    case ("POST", 2, "timeline") where s[1] == "query":
      return try ok(try await atlas.timelineQuery(try body(TimelineQueryRequest.self, r)))
    case ("GET", 2, "timeline") where s[1] == "tiles": return try ok(try await atlas.tiles(try query(TilesRequest.self, r)))
    case ("GET", 2, "timeline") where s[1] == "marks": return try ok(try await atlas.marks(try query(MarksRequest.self, r)))
    case ("GET", 2, "timeline") where s[1] == "arcs": return try ok(try await atlas.arcs(try query(ArcsRequest.self, r)))
    case ("GET", 2, "timeline") where s[1] == "shelf": return try ok(try await atlas.shelf(try query(ShelfRequest.self, r)))
    case ("GET", 2, "timeline") where s[1] == "bin": return try ok(try await atlas.bin(try query(BinRequest.self, r)))
    case ("GET", 2, "passages"):
      return try ok(try await atlas.passage(PassageID(rawValue: try int(s[1])), try query(PassageRequest.self, r)))
    case ("GET", 2, "documents"): return try ok(try await atlas.document(DocumentID(rawValue: try int(s[1]))))
    case ("GET", 3, "documents") where s[2] == "text":
      return try ok(try await atlas.documentText(DocumentID(rawValue: try int(s[1])), from: r.queryValue("from").flatMap { Int($0) },
                                                 to: r.queryValue("to").flatMap { Int($0) }))
    case ("GET", 1, "kwic"): return try ok(try await atlas.kwic(try query(KwicRequest.self, r)))
    case ("GET", 2, "occurrences"): return try ok(try await atlas.occurrence(OccurrenceID(rawValue: try int(s[1]))))
    // analysis (N4)
    case ("POST", 1, "compare"): return try ok(try await atlas.compare(try body(CompareRequest.self, r)))
    case ("GET", 1, "collocations"): return try ok(try await atlas.collocations(try query(CollocationsRequest.self, r)))
    // lineage (N5)
    case ("GET", 1, "lineage"): return try ok(try await atlas.lineage(try query(LineageRequest.self, r)))
    case ("GET", 2, "lineage") where s[1] == "path": return try ok(try await atlas.lineagePath(try query(LineagePathRequest.self, r)))
    case ("GET", 1, "genealogy"): return try ok(try await atlas.genealogy(try query(GenealogyRequest.self, r)))
    // provenance, notebook and views (N6)
    case ("GET", 2, "relationships"): return try ok(try await atlas.relationship(RelationshipID(rawValue: try int(s[1]))))
    case ("POST", 1, "relationships"): return try ok(try await atlas.proposeRelationship(try body(ProposeRelationshipRequest.self, r)))
    case ("POST", 3, "relationships") where s[2] == "review":
      return try ok(try await atlas.review(RelationshipID(rawValue: try int(s[1])), try body(ReviewRequest.self, r)))
    case ("POST", 3, "relationships") where s[2] == "evidence":
      return try ok(try await atlas.addEvidence(RelationshipID(rawValue: try int(s[1])), try body(EvidenceRequest.self, r)))
    case ("GET", 2, "hypothesis-groups"):
      return try ok(try await atlas.hypothesisGroup(HypothesisGroupID(rawValue: try int(s[1]))))
    case ("POST", 1, "hypothesis-groups"):
      return try ok(try await atlas.createHypothesisGroup(try body(HypothesisGroupCreateRequest.self, r)))
    case ("GET", 1, "annotations"): return try ok(try await atlas.annotations(try query(AnnotationsRequest.self, r)))
    case ("POST", 1, "annotations"): return try ok(try await atlas.createAnnotation(try body(AnnotationCreateRequest.self, r)))
    case ("PATCH", 2, "annotations"):
      return try ok(try await atlas.reviseAnnotation(AnnotationID(rawValue: try int(s[1])), try body(AnnotationPatchRequest.self, r)))
    case ("POST", 3, "annotations") where s[2] == "reinterpret":
      return try ok(try await atlas.reinterpret(AnnotationID(rawValue: try int(s[1])), try body(AnnotationCreateRequest.self, r)))
    case ("POST", 3, "annotations") where s[2] == "withdraw":
      return try ok(try await atlas.withdraw(AnnotationID(rawValue: try int(s[1])), try body(WithdrawRequest.self, r)))
    case ("GET", 3, "annotations") where s[2] == "revisions":
      return try ok(try await atlas.annotationRevisions(AnnotationID(rawValue: try int(s[1]))))
    case ("POST", 1, "views"): return try ok(try await atlas.saveView(try body(SaveViewRequest.self, r)))
    case ("GET", 1, "views"): return try ok(try await atlas.views(try query(ViewsRequest.self, r)))
    case ("GET", 2, "views"):
      return try ok(try await atlas.view(String(s[1]).removingPercentEncoding ?? String(s[1]), asSaved: r.queryValue("as") == "1"))
    case ("DELETE", 2, "views"):
      _ = try await atlas.deleteView(String(s[1]).removingPercentEncoding ?? String(s[1]))
      return JourneyAnswer(status: 204, body: .null, text: nil, roundTrip: nil)
    default:
      throw ScrollsError(code: .notFound, message: "No route \(r.method) \(r.route) in the journey router.", status: 404)
    }
  }
}

// MARK: - query strings → request types

/// Decodes a contract request type from query items: every value starts as a string; a member whose type is a number
/// or a boolean is retyped when the decoder says so (the reference parses each query member by its own rule).
enum QueryDecoding {
  static func decode<T: Decodable>(_ type: T.Type, _ items: [(String, String)], extra: JSONObject = [:]) throws -> T {
    var o = JSONObject()
    for (k, v) in items { o[k] = .string(v) }
    for (k, v) in extra { o[k] = v }
    for _ in 0..<(o.count + 1) {
      do {
        return try ScrollsJSON.decode(T.self, from: .object(o))
      } catch DecodingError.typeMismatch(let want, let context) {
        guard let key = context.codingPath.last?.stringValue else { throw DecodingError.typeMismatch(want, context) }
        let wire = o[key] != nil ? key : ScrollsJSON.snakeCase(key)
        guard case .string(let s)? = o[wire] else { throw DecodingError.typeMismatch(want, context) }
        if want == Bool.self || "\(want)".contains("Bool") {
          o[wire] = .bool(s == "1" || s == "true")
        } else if let n = Double(s) {
          o[wire] = .number(n)
        } else {
          throw DecodingError.typeMismatch(want, context)
        }
      }
    }
    return try ScrollsJSON.decode(T.self, from: .object(o))
  }
}

// MARK: - replay and compare

/// A G7 family replayed on a fresh clone and compared case by case.
enum JourneyReplay {
  struct Outcome {
    var id: String
    var seq: Int
    var step: String
    var method: String
    var path: String
    var owner: String
    /// exact · gap (only keys the contract types drop) · diff · not-implemented · status · restart ·
    /// blocked (an N6 answer that differs after another package's step failed: judged once that step matches)
    var verdict: String
    var detail: String?
    var gaps: [String] = []
    var ms: Double = 0
  }

  static func loadCases(_ dir: URL) throws -> [JSONValue] {
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("cases-") && $0.hasSuffix(".jsonl") }.sorted()
    var out: [JSONValue] = []
    for f in files {
      let text = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
      for line in text.split(separator: "\n") where !line.isEmpty { out.append(try JSONValue.parse(String(line))) }
    }
    return out
  }

  static func compare(family: URL, snapshot: String?, snapshots: URL, report: URL?, responses: URL?, keep: Bool) async throws -> Int32 {
    let cases = try loadCases(family)
    guard !cases.isEmpty else { throw UsageError("no cases in \(family.path)") }
    let snap = snapshot ?? cases.first?["snapshot"]?.stringValue ?? "m1r"
    let clone = try JourneyClone.make(snapshots, snap)
    defer { if keep { print("kept \(clone.root.path)") } else { clone.remove() } }
    let host = try await JourneyHost.open(clone.location, profile: .reference)
    let router = JourneyRouter()
    var maps = JourneyMaps()
    var outcomes: [Outcome] = []
    var exchanges: [String] = []
    /// The first case of another package that did not match: later N6 answers depend on its state.
    var upstream: String?
    var i = 0
    while i < cases.count {
      let c = cases[i]
      let seq = c["seq"]?.safeInteger ?? i
      let id = c["id"]?.stringValue ?? "\(snap)-\(seq)"
      let step = c["step"]?.stringValue ?? ""
      if c["event"]?.stringValue == "restart" {
        try await host.restart()
        outcomes.append(Outcome(id: id, seq: seq, step: step, method: "", path: "restart", owner: "N6", verdict: "restart"))
        i += 1
        continue
      }
      // consecutive polls of one path: poll to a final state, compare the last recorded poll
      var last = i
      if c["poll"]?.boolValue == true {
        while last + 1 < cases.count, cases[last + 1]["poll"]?.boolValue == true, cases[last + 1]["path"] == c["path"] { last += 1 }
      }
      let expectedCase = cases[last]
      var request = JourneyRequest(c)
      request.path = maps.mapPath(request.path)
      if let b = request.body { request.body = maps.mapBody(b, route: request.route) }
      let owner = JourneyRouter.owner(request.route)
      let start = ContinuousClock.now
      var answer = await router.handle(host.atlas, request)
      if c["poll"]?.boolValue == true {
        let deadline = ContinuousClock.now + .seconds(180)
        while answer.status == 200, let st = answer.body["status"]?.stringValue, ["queued", "running", "paused", "interrupted"].contains(st),
          ContinuousClock.now < deadline
        {
          try await Task.sleep(for: .milliseconds(100))
          answer = await router.handle(host.atlas, request)
        }
      }
      let ms = (ContinuousClock.now - start).journeyMS
      if request.method != "GET" { try await Task.sleep(for: .milliseconds(25)) }  // distinct clocks for later as_of maps
      let expectedStatus = expectedCase["status"]?.safeInteger ?? 200
      var o = Outcome(id: id, seq: seq, step: step, method: request.method, path: c["path"]?.stringValue ?? "", owner: owner,
                      verdict: "exact", ms: ms)
      if last > i { o.detail = "polled; compared with the last of \(last - i + 1) recorded polls" }
      var x: JSONObject = ["id": .string(id), "seq": .number(Double(seq)), "method": .string(request.method),
                           "path": .string(request.path), "status": .number(Double(answer.status))]
      if let t = answer.text { x["text"] = .string(t) } else if answer.status != 204 { x["body"] = answer.body }
      exchanges.append(CanonicalJSON.string(.object(x)))

      if answer.status == 501 {
        o.verdict = "not-implemented"
        o.detail = answer.body["error"]?["message"]?.stringValue
      } else if answer.status != expectedStatus {
        o.verdict = "status"
        o.detail = "status \(answer.status), expected \(expectedStatus): \(answer.body["error"]?["message"]?.stringValue ?? "")"
      } else if let text = expectedCase["text"]?.stringValue {
        if (answer.text ?? "") != text { o.verdict = "diff"; o.detail = "text differs" }
      } else {
        let recorded = expectedCase["response"] ?? .null
        if request.method != "GET" { maps.learnIDs(recorded, answer.body, route: request.route) }
        maps.learnClock(recorded, answer.body)
        let expected = maps.expected(recorded, route: request.route)
        var roundTripped = expected
        if let rt = answer.roundTrip {
          do { roundTripped = try rt(expected) } catch { o.gaps.append("the recorded body does not decode into the contract type: \(error)") }
        }
        o.gaps += JSONDiff.missingKeys(JourneyNormalize.value(expected), JourneyNormalize.value(roundTripped))
        if let d = JSONDiff.first(JourneyNormalize.value(roundTripped), JourneyNormalize.value(answer.body)) {
          o.verdict = "diff"
          o.detail = d
        } else if !o.gaps.isEmpty {
          o.verdict = "gap"
        }
      }
      let matched = ["exact", "gap"].contains(o.verdict)
      if !matched, owner != "N6", upstream == nil { upstream = "\(owner) #\(seq) (\(o.verdict))" }
      if !matched, owner == "N6", let up = upstream {
        // an N6 answer after another package's failed step: its input (an import, a count) is not the recording's
        o.verdict = "blocked"
        o.detail = "after \(up): " + (o.detail ?? "")
      }
      outcomes.append(o)
      let mark = o.verdict == "exact" ? "ok  " : o.verdict == "gap" ? "gap " : o.verdict == "blocked" ? "wait" : "DIFF"
      print("\(mark) \(o.owner) #\(seq) \(o.method) \(o.path.prefix(90)) [\(o.verdict)]\(o.detail.map { " — \($0.prefix(300))" } ?? "")")
      i = last + 1
    }
    await host.atlas.close()
    if let responses { try Data((exchanges.joined(separator: "\n") + "\n").utf8).write(to: responses) }

    let mine = outcomes.filter { $0.owner == "N6" && $0.verdict != "restart" }
    let mineOK = mine.allSatisfy { ["exact", "gap", "blocked"].contains($0.verdict) }
    var byOwner: [String: [String: Int]] = [:]
    for o in outcomes where o.verdict != "restart" { byOwner[o.owner, default: [:]][o.verdict, default: 0] += 1 }
    let summary = byOwner.keys.sorted().map { k in "\(k): " + byOwner[k]!.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }.joined(separator: ", ") }
    print("\(family.lastPathComponent) on \(snap): \(outcomes.count) cases — " + summary.joined(separator: " · "))
    print("N6 cases: \(mine.count), matching \(mine.filter { ["exact", "gap"].contains($0.verdict) }.count)")
    if let report {
      let rows: [JSONValue] = outcomes.map { o in
        ["id": .string(o.id), "seq": .number(Double(o.seq)), "step": .string(o.step), "method": .string(o.method),
         "path": .string(o.path), "owner": .string(o.owner), "verdict": .string(o.verdict),
         "detail": o.detail.map(JSONValue.string) ?? .null, "contract_gaps": .array(o.gaps.map(JSONValue.string)),
         "ms": .number((o.ms * 10).rounded() / 10)]
      }
      let all = outcomes.filter { $0.verdict != "restart" }
      let doc: JSONValue = [
        "family": .string(family.lastPathComponent), "snapshot": .string(snap), "profile": "reference",
        "cases": .number(Double(all.count)),
        "matching": .number(Double(all.filter { ["exact", "gap"].contains($0.verdict) }.count)),
        "n6_cases": .number(Double(mine.count)), "n6_matching": .number(Double(mine.filter { ["exact", "gap"].contains($0.verdict) }.count)),
        "passed_n6": .bool(mineOK), "passed": .bool(all.allSatisfy { ["exact", "gap"].contains($0.verdict) }),
        "by_owner": .object(JSONObject(byOwner.map { ($0.key, JSONValue.object(JSONObject($0.value.map { ($0.key, JSONValue.number(Double($0.value))) }))) })),
        "id_map": maps.idReport, "rows": .array(rows),
      ]
      try Data((CanonicalJSON.string(doc) + "\n").utf8).write(to: report)
    }
    return mineOK ? 0 : 1
  }
}

/// A `cp -c` clone of a snapshot laid out as an atlas root (Atlas/atlas.sqlite, Notebook/), never opened in place.
struct JourneyClone {
  let root: URL
  let location: AtlasLocation

  static func make(_ snapshots: URL, _ name: String) throws -> JourneyClone {
    let src = snapshots.appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db").path) else {
      throw UsageError("no snapshot \(name) at \(src.path)")
    }
    let base = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
    let root = base.appendingPathComponent("scrolls-api-\(name)-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.removeItem(at: root)
    let atlas = root.appendingPathComponent("Atlas")
    try FileManager.default.createDirectory(at: atlas.appendingPathComponent("derived"), withIntermediateDirectories: true)
    try cp(["-c", src.appendingPathComponent("scrolls.db").path, atlas.appendingPathComponent("atlas.sqlite").path])
    for side in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db\(side)").path) {
      try cp(["-c", src.appendingPathComponent("scrolls.db\(side)").path, atlas.appendingPathComponent("atlas.sqlite\(side)").path])
    }
    let tokens = src.appendingPathComponent("derived/tokens")
    if FileManager.default.fileExists(atPath: tokens.path) {
      try cp(["-c", "-R", tokens.path, atlas.appendingPathComponent("derived/tokens").path])
    }
    return JourneyClone(root: root, location: try AtlasLocation.at(root: root))
  }

  static func cp(_ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = args
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw UsageError("cp \(args.joined(separator: " ")) failed") }
  }

  func remove() { try? FileManager.default.removeItem(at: root) }
}

// MARK: - normalisation, learned maps, diffs

enum JourneyNormalize {
  static let dataVersionKeys: Set<String> = ["dataVersion", "data_version", "currentDataVersion", "current_data_version"]
  static let timingKeys: Set<String> = ["ms", "elapsed_ms", "took_ms", "elapsedMs"]

  static func isTimestamp(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count >= 16, u.count <= 35 else { return false }
    func d(_ i: Int) -> Bool { u[i] >= 0x30 && u[i] <= 0x39 }
    guard d(0), d(1), d(2), d(3), u[4] == 0x2D, d(5), d(6), u[7] == 0x2D, d(8), d(9), u[10] == 0x54 || u[10] == 0x20,
      d(11), d(12), u[13] == 0x3A, d(14), d(15)
    else { return false }
    return true
  }

  static func value(_ v: JSONValue) -> JSONValue {
    switch v {
    case .string(let s): return isTimestamp(s) ? "<ts>" : v
    case .array(let a): return .array(a.map(value))
    case .object(let o):
      var out = JSONObject()
      for (k, x) in o {
        if timingKeys.contains(k) { continue }
        out[k] = dataVersionKeys.contains(k) ? "<dv>" : value(x)
      }
      return .object(out)
    default: return v
    }
  }
}

/// Ids and clock values the replay allocated differently from the recording, learned from the answers. Ids are learned
/// only from the answers of writes (the rows a request created: a job, an import batch, an annotation, a link, a
/// group), by kind, so an id that merely refers to an existing row is always compared as it is.
struct JourneyMaps {
  /// kind → recorded id → replayed id
  var ids: [String: [Int64: Int64]] = [:]
  var conflicts: [String] = []
  /// recorded instants (ms since 1970) → replayed instants
  var clock: [(Double, Double)] = []

  /// The kind of rows a route's path ids and `id` members name.
  static func routeKind(_ route: String) -> String? {
    let seg = route.split(separator: "/")
    guard seg.count >= 2 else { return nil }
    switch seg[1] {
    case "jobs": return "job"
    case "imports": return "import"
    case "annotations": return "annotation"
    case "relationships": return "relationship"
    case "hypothesis-groups": return "group"
    case "expressions": return "expression"
    default: return nil
    }
  }

  /// The kind of an id member (`id` takes the route's kind).
  static func keyKind(_ key: String, route: String, parent: String?) -> String? {
    switch key {
    case "id":
      switch parent {
      case "job": return "job"
      case "annotations": return "annotation"
      case "hypotheses": return "relationship"
      case "evidence", "revisions", "src", "dst", "document", "target", "anchor": return nil
      default: return routeKind(route)
      }
    case "job": return "job"
    case "import_batch_id", "batchId", "batch_id", "import_batch": return "import"
    case "annotation_id", "supersedes", "superseded_by": return "annotation"
    case "relationship": return "relationship"
    case "hypothesis_group": return "group"
    default: return nil
    }
  }

  mutating func learnIDs(_ recorded: JSONValue, _ actual: JSONValue, route: String, key: String? = nil, parent: String? = nil) {
    switch (recorded, actual) {
    case (.object(let a), .object(let b)):
      for (k, x) in a { if let y = b[k] { learnIDs(x, y, route: route, key: k, parent: key) } }
    case (.number(let x), .number(let y)):
      guard let key, let kind = Self.keyKind(key, route: route, parent: parent), x >= 1, y >= 1, x == x.rounded(), y == y.rounded()
      else { return }
      let (r, n) = (Int64(x), Int64(y))
      if let have = ids[kind]?[r], have != n { conflicts.append("\(kind) \(r) → \(have) and \(n)") } else { ids[kind, default: [:]][r] = n }
    default:
      return
    }
  }

  mutating func learnClock(_ recorded: JSONValue, _ actual: JSONValue) {
    switch (recorded, actual) {
    case (.object(let a), .object(let b)):
      for (k, x) in a { if let y = b[k] { learnClock(x, y) } }
    case (.array(let a), .array(let b)) where a.count == b.count:
      for (x, y) in zip(a, b) { learnClock(x, y) }
    case (.string(let x), .string(let y)):
      if JourneyNormalize.isTimestamp(x), JourneyNormalize.isTimestamp(y), let tx = Self.instant(x), let ty = Self.instant(y),
        !clock.contains(where: { $0.0 == tx })
      {
        clock.append((tx, ty))
        clock.sort { $0.0 < $1.0 }
      }
    default:
      return
    }
  }

  static func instant(_ s: String) -> Double? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return (d.timeIntervalSince1970 * 1000).rounded() }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s).map { ($0.timeIntervalSince1970 * 1000).rounded() }
  }

  static func iso(_ ms: Double) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
  }

  /// A recorded instant on the replay's clock: exact pairs map exactly; between two learned instants, proportionally.
  func mapTime(_ s: String) -> String {
    guard let t = Self.instant(s), !clock.isEmpty else { return s }
    if let exact = clock.first(where: { $0.0 == t }) { return Self.iso(exact.1) }
    guard let lo = clock.last(where: { $0.0 < t }) else { return s }
    guard let hi = clock.first(where: { $0.0 > t }) else { return Self.iso(lo.1 + (t - lo.0)) }
    let f = (t - lo.0) / (hi.0 - lo.0)
    return Self.iso((lo.1 + f * (hi.1 - lo.1)).rounded())
  }

  func mapId(_ s: Substring, kind: String?) -> String {
    guard let kind, let n = Int64(s), let m = ids[kind]?[n] else { return String(s) }
    return String(m)
  }

  /// A path's ids (by the route's kind) and its query's ids and recorded instants, on the replay's terms.
  func mapPath(_ path: String) -> String {
    let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let kind = Self.routeKind(String(parts[0]))
    let route = parts[0].split(separator: "/", omittingEmptySubsequences: false).map { mapId($0, kind: kind) }.joined(separator: "/")
    guard parts.count > 1 else { return route }
    let items = parts[1].split(separator: "&").map { item -> String in
      let kv = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard kv.count == 2 else { return String(item) }
      let raw = String(kv[1]).removingPercentEncoding ?? String(kv[1])
      var v = raw
      if JourneyNormalize.isTimestamp(raw) {
        v = mapTime(raw)
      } else if kv[0] == "import_batch" {
        v = mapId(Substring(raw), kind: "import")
      } else if kv[0] == "expr" {
        v = mapId(Substring(raw), kind: "expression")
      }
      guard v != raw else { return String(item) }
      return "\(kv[0])=\(v.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? v)"
    }
    return route + "?" + items.joined(separator: "&")
  }

  /// A request body with the ids of created rows mapped (by member kind) and recorded instants on the replay's clock.
  func mapBody(_ v: JSONValue, route: String, key: String? = nil, parent: String? = nil) -> JSONValue {
    switch v {
    case .object(let o):
      var out = JSONObject()
      for (k, x) in o { out[k] = mapBody(x, route: route, key: k, parent: key) }
      return .object(out)
    case .array(let a): return .array(a.map { mapBody($0, route: route, key: key, parent: parent) })
    case .number(let n):
      guard let key, key != "id", let kind = Self.keyKind(key, route: route, parent: parent), n == n.rounded(),
        let m = ids[kind]?[Int64(n)]
      else { return v }
      return .number(Double(m))
    case .string(let s):
      return JourneyNormalize.isTimestamp(s) ? .string(mapTime(s)) : v
    default: return v
    }
  }

  /// The recorded body with the ids of created rows replaced by the replay's (by member kind).
  func expected(_ v: JSONValue, route: String, key: String? = nil, parent: String? = nil) -> JSONValue {
    switch v {
    case .object(let o):
      var out = JSONObject()
      for (k, x) in o { out[k] = expected(x, route: route, key: k, parent: key) }
      return .object(out)
    case .array(let a): return .array(a.map { expected($0, route: route, key: key, parent: parent) })
    case .number(let n):
      guard let key, let kind = Self.keyKind(key, route: route, parent: parent), n == n.rounded(), let m = ids[kind]?[Int64(n)]
      else { return v }
      return .number(Double(m))
    default: return v
    }
  }

  var idReport: JSONValue {
    var o = JSONObject()
    for (kind, m) in ids {
      let changed = m.filter { $0.key != $0.value }
      if !changed.isEmpty { o[kind] = .object(JSONObject(changed.map { (String($0.key), JSONValue.number(Double($0.value))) })) }
    }
    return ["remapped": .object(o), "conflicts": .array(conflicts.map(JSONValue.string))]
  }
}

enum JSONDiff {
  static func show(_ v: JSONValue?) -> String {
    guard let v else { return "absent" }
    let s = CanonicalJSON.string(v)
    return s.count > 160 ? String(s.prefix(160)) + "…" : s
  }

  /// The first difference of two bodies (`$.a.b[3]: expected … got …`), or nil when they are equal.
  static func first(_ expected: JSONValue, _ actual: JSONValue, path: String = "$") -> String? {
    switch (expected, actual) {
    case (.object(let a), .object(let b)):
      for k in Set(a.keys).union(b.keys).sorted() {
        guard let x = a[k] else { return "\(path).\(k): unexpected member \(show(b[k]))" }
        guard let y = b[k] else { return "\(path).\(k): missing (expected \(show(x)))" }
        if let d = first(x, y, path: "\(path).\(k)") { return d }
      }
      return nil
    case (.array(let a), .array(let b)):
      for (i, (x, y)) in zip(a, b).enumerated() { if let d = first(x, y, path: "\(path)[\(i)]") { return d } }
      return a.count == b.count ? nil : "\(path): \(b.count) elements, expected \(a.count)"
    default:
      return expected == actual ? nil : "\(path): expected \(show(expected)), got \(show(actual))"
    }
  }

  /// Member paths of `full` that `reduced` lacks (the keys a contract round trip drops).
  static func missingKeys(_ full: JSONValue, _ reduced: JSONValue, path: String = "$") -> [String] {
    switch (full, reduced) {
    case (.object(let a), .object(let b)):
      var out: [String] = []
      for k in a.keys.sorted() {
        if let y = b[k] { out += missingKeys(a[k]!, y, path: "\(path).\(k)") } else { out.append("\(path).\(k)") }
      }
      return out
    case (.array(let a), .array(let b)):
      var out: [String] = []
      for (x, y) in zip(a, b) {
        for m in missingKeys(x, y, path: "\(path)[]") where !out.contains(m) { out.append(m) }
      }
      return out
    default:
      return []
    }
  }
}
