// OWNER: N0
// MockAtlas: the AtlasService that answers from the 65 contract fixtures (Resources/contract-fixtures, byte-equal
// copies of tests/contract), so UI work builds against the real shapes from day 1. It chooses a variant the way the
// reference's mock mode does (server/http/mock.mjs `selectVariant`): the one asked for, else the first whose `when`
// matches the request, else the fixture's default. Error variants throw their `ScrollsError` with the status.
// Everything it answers is canned: the app labels it as fixtures wherever it is shown.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// An AtlasService over the contract fixtures.
public struct MockAtlas: AtlasService {
  /// Variant names by AtlasService method ('passage'), by endpoint ('GET /api/passages/:id'), or '*' for every
  /// endpoint that has a variant of that name (the web's `?mock=gated`).
  public let variants: [String: String]
  /// Scales the fixtures' SSE `delay_ms` (1 = as written, 0 = no waiting).
  public let eventDelayScale: Double
  private let fixtures: MockFixtures

  /// Serves the bundled fixtures.
  public init(variant: [String: String] = [:], eventDelayScale: Double = 1) {
    self.init(variant: variant, eventDelayScale: eventDelayScale, fixtures: .bundled)
  }

  /// Serves the fixtures of another directory (for example the reference's tests/contract).
  public init(variant: [String: String] = [:], eventDelayScale: Double = 1, directory: URL) {
    self.init(variant: variant, eventDelayScale: eventDelayScale, fixtures: MockFixtures(directory: directory))
  }

  private init(variant: [String: String], eventDelayScale: Double, fixtures: MockFixtures) {
    self.variants = variant
    self.eventDelayScale = eventDelayScale
    self.fixtures = fixtures
  }

  // MARK: health · events · jobs

  public func health() async throws -> HealthResponse { try serve("health") }

  public var events: AsyncStream<AtlasEvent> {
    let (stream, continuation) = AsyncStream.makeStream(of: AtlasEvent.self)
    guard let (variant, _) = try? pick("events", request: MockRequest()), (variant["status"]?.safeInteger ?? 200) < 400 else {
      continuation.finish()
      return stream
    }
    let events = variant["events"]?.arrayValue ?? []
    let keepOpen = variant["keep_open"] == .bool(true)
    let scale = eventDelayScale
    let task = Task {
      for e in events {
        await MockAtlas.wait(e["delay_ms"], scale: scale)
        if Task.isCancelled { break }
        if let event = try? MockAtlas.atlasEvent(e) { continuation.yield(event) }
      }
      if !keepOpen { continuation.finish() }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
  }

  public func jobs(_ r: JobsRequest) async throws -> JobsResponse { try serve("jobs", query: r) }

  public func job(_ id: JobID) async throws -> JobResponse { try serve("job", params: ["id": String(id.rawValue)]) }

  public func jobEvents(_ id: JobID) async throws -> JobEventsResponse {
    let (variant, _) = try pick("jobEvents", request: MockRequest(params: ["id": String(id.rawValue)]))
    try MockAtlas.throwIfError(variant)
    let events = variant["events"]?.arrayValue ?? []
    let scale = eventDelayScale
    let stream = AsyncThrowingStream<JobEventPayload, any Error> { continuation in
      let task = Task {
        do {
          for e in events {
            await MockAtlas.wait(e["delay_ms"], scale: scale)
            try Task.checkCancellation()
            guard case .job(let payload) = try MockAtlas.atlasEvent(e) else { continue }
            continuation.yield(payload)
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
    return JobEventsResponse(events: stream)
  }

  public func cancelJob(_ id: JobID) async throws -> JobCancelResponse {
    try serve("cancelJob", params: ["id": String(id.rawValue)])
  }

  // MARK: imports

  public func stageImport(_ r: StageImportRequest) async throws -> ImportStagedResponse { try serve("stageImport") }

  public func setImportMapping(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportMappingResponse {
    try serve("setImportMapping", params: ["id": id.description], body: r)
  }

  public func importPreview(_ id: ImportBatchID, _ r: ImportPreviewRequest) async throws -> ImportPreviewResponse {
    try serve("importPreview", params: ["id": id.description], query: r)
  }

  public func importProblems(_ id: ImportBatchID) async throws -> ImportProblemsResponse {
    let (variant, _) = try pick("importProblems", request: MockRequest(params: ["id": id.description]))
    try MockAtlas.throwIfError(variant)
    return ImportProblemsResponse(csv: variant["text"]?.stringValue ?? "")
  }

  public func commitImport(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportCommitResponse {
    try serve("commitImport", params: ["id": id.description], body: r)
  }

  public func revertImport(_ id: ImportBatchID) async throws -> ImportRevertResponse {
    try serve("revertImport", params: ["id": id.description])
  }

  // MARK: corpora · adapters · baseline · tour · etymology

  public func corpora() async throws -> CorporaResponse { try serve("corpora") }
  public func facets(_ r: FacetsRequest) async throws -> FacetsResponse { try serve("facets", query: r) }
  public func adapters(_ r: AdaptersRequest) async throws -> AdaptersResponse { try serve("adapters", query: r) }

  public func adapterClaims(_ id: String, _ r: AdapterClaimsRequest) async throws -> AdapterClaimsResponse {
    try serve("adapterClaims", params: ["id": id], query: r)
  }

  public func loadAdapter(_ id: String, _ r: AdapterLoadRequest) async throws -> AdapterLoadResponse {
    try serve("loadAdapter", params: ["id": id], body: r)
  }

  public func enableAdapter(_ id: String, _ r: AdapterEnableRequest) async throws -> AdapterEnableResponse {
    try serve("enableAdapter", params: ["id": id], body: r)
  }

  public func baseline(_ r: BaselineRequest) async throws -> BaselineResponse { try serve("baseline", query: r) }
  public func tour() async throws -> TourResponse { try serve("tour") }
  public func etymology(_ r: EtymologyRequest) async throws -> EtymologyResponse { try serve("etymology", query: r) }

  // MARK: search · expressions · timeline · reading · exports

  public func search(_ r: SearchRequest) async throws -> SearchResponse { try serve("search", query: r) }

  public func trackExpression(_ r: TrackExpressionRequest) async throws -> ExpressionResponse {
    try serve("trackExpression", body: r)
  }

  public func expression(_ id: ExpressionID, corpus: String?) async throws -> ExpressionResponse {
    try serve("expression", params: ["id": id.description], query: corpus.map { ["corpus": $0] })
  }

  public func setVariants(_ id: ExpressionID, _ r: VariantsPatchRequest) async throws -> ExpressionResponse {
    try serve("setVariants", params: ["id": id.description], body: r)
  }

  public func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse {
    try serve("timelineQuery", body: r)
  }

  public func tiles(_ r: TilesRequest) async throws -> TilesResponse { try serve("tiles", query: r) }
  public func marks(_ r: MarksRequest) async throws -> MarksResponse { try serve("marks", query: r) }
  public func arcs(_ r: ArcsRequest) async throws -> ArcsResponse { try serve("arcs", query: r) }
  public func shelf(_ r: ShelfRequest) async throws -> ShelfResponse { try serve("shelf", query: r) }
  public func bin(_ r: BinRequest) async throws -> BinResponse { try serve("bin", query: r) }

  public func passage(_ id: PassageID, _ r: PassageRequest) async throws -> PassageResponse {
    try serve("passage", params: ["id": id.description], query: r)
  }

  public func document(_ id: DocumentID) async throws -> DocumentResponse {
    try serve("document", params: ["id": id.description])
  }

  public func documentText(_ id: DocumentID, from: Int?, to: Int?) async throws -> DocumentTextResponse {
    var q: [String: String] = [:]
    if let from { q["from"] = String(from) }
    if let to { q["to"] = String(to) }
    return try serve("documentText", params: ["id": id.description], query: q)
  }

  public func kwic(_ r: KwicRequest) async throws -> KwicResponse { try serve("kwic", query: r) }

  public func occurrence(_ id: OccurrenceID) async throws -> OccurrenceResponse {
    try serve("occurrence", params: ["id": id.description])
  }

  public func export(_ r: ExportRequest) async throws -> ExportResponse {
    let (variant, _) = try pick("export", request: MockRequest(query: MockRequest.query(r)))
    try MockAtlas.throwIfError(variant)
    if let text = variant["text"]?.stringValue {
      return ExportResponse(contentType: variant["content_type"]?.stringValue ?? "text/plain; charset=utf-8", data: Data(text.utf8))
    }
    let body = variant["body"] ?? .null
    return ExportResponse(contentType: variant["content_type"]?.stringValue ?? "application/json; charset=utf-8",
                          data: Data(CanonicalJSON.string(body).utf8))
  }

  public func createSnapshot(_ r: SnapshotCreateRequest) async throws -> SnapshotCreateResponse {
    try serve("createSnapshot", body: r)
  }

  public func snapshot(_ file: String) async throws -> SnapshotResponse {
    let (variant, _) = try pick("snapshot", request: MockRequest(params: ["file": file]))
    try MockAtlas.throwIfError(variant)
    guard let b64 = variant["base64"]?.stringValue, let data = Data(base64Encoded: b64) else {
      throw MockAtlas.fixtureProblem("snapshot", "the variant has no base64 body")
    }
    return SnapshotResponse(contentType: variant["content_type"]?.stringValue ?? "application/octet-stream", data: data)
  }

  // MARK: analysis

  public func compare(_ r: CompareRequest) async throws -> CompareResponse { try serve("compare", body: r) }
  public func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse { try serve("collocations", query: r) }
  public func clusters(_ r: ClustersRequest) async throws -> ClustersResponse { try serve("clusters", query: r) }
  public func startRun(_ r: StartRunRequest) async throws -> StartRunResponse { try serve("startRun", body: r) }
  public func runs(_ r: RunsRequest) async throws -> RunsResponse { try serve("runs", query: r) }

  public func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse {
    try serve("constellation", query: r)
  }

  // MARK: lineage · provenance · notebook · views

  public func lineage(_ r: LineageRequest) async throws -> LineageResponse { try serve("lineage", query: r) }
  public func lineagePath(_ r: LineagePathRequest) async throws -> LineagePathResponse { try serve("lineagePath", query: r) }
  public func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse { try serve("genealogy", query: r) }

  public func relationship(_ id: RelationshipID) async throws -> RelationshipResponse {
    try serve("relationship", params: ["id": id.description])
  }

  public func proposeRelationship(_ r: ProposeRelationshipRequest) async throws -> CreatedResponse {
    try serve("proposeRelationship", body: r)
  }

  public func review(_ id: RelationshipID, _ r: ReviewRequest) async throws -> ReviewResponse {
    try serve("review", params: ["id": id.description], body: r)
  }

  public func addEvidence(_ id: RelationshipID, _ r: EvidenceRequest) async throws -> CreatedResponse {
    try serve("addEvidence", params: ["id": id.description], body: r)
  }

  public func hypothesisGroup(_ id: HypothesisGroupID) async throws -> HypothesisGroupResponse {
    try serve("hypothesisGroup", params: ["id": id.description])
  }

  public func createHypothesisGroup(_ r: HypothesisGroupCreateRequest) async throws -> CreatedResponse {
    try serve("createHypothesisGroup", body: r)
  }

  public func trace(_ r: TraceRequest) async throws -> TraceResponse { try serve("trace", body: r) }
  public func annotations(_ r: AnnotationsRequest) async throws -> AnnotationsResponse { try serve("annotations", query: r) }

  public func createAnnotation(_ r: AnnotationCreateRequest) async throws -> AnnotationRevResponse {
    try serve("createAnnotation", body: r)
  }

  public func reviseAnnotation(_ id: AnnotationID, _ r: AnnotationPatchRequest) async throws -> AnnotationRevResponse {
    try serve("reviseAnnotation", params: ["id": id.description], body: r)
  }

  public func reinterpret(_ id: AnnotationID, _ r: AnnotationCreateRequest) async throws -> AnnotationReinterpretedResponse {
    try serve("reinterpret", params: ["id": id.description], body: r)
  }

  public func withdraw(_ id: AnnotationID, _ r: WithdrawRequest) async throws -> AnnotationRevResponse {
    try serve("withdraw", params: ["id": id.description], body: r)
  }

  public func annotationRevisions(_ id: AnnotationID) async throws -> AnnotationRevisionsResponse {
    try serve("annotationRevisions", params: ["id": id.description])
  }

  public func saveView(_ r: SaveViewRequest) async throws -> ViewSavedResponse { try serve("saveView", body: r) }
  public func views(_ r: ViewsRequest) async throws -> ViewsResponse { try serve("views", query: r) }

  public func view(_ slug: String, asSaved: Bool) async throws -> SavedViewResponse {
    try serve("view", params: ["slug": slug], query: asSaved ? ["as": "1"] : nil)
  }

  public func deleteView(_ slug: String) async throws -> DeleteViewResponse {
    let (variant, _) = try pick("deleteView", request: MockRequest(params: ["slug": slug]))
    try MockAtlas.throwIfError(variant)
    return DeleteViewResponse()
  }
}

// MARK: - serving

extension MockAtlas {
  /// The variant this request gets, and its name.
  func pick(_ service: String, request: MockRequest) throws -> (variant: JSONValue, name: String) {
    guard let endpoint = ContractCatalog.endpoint(service: service) else {
      throw MockAtlas.fixtureProblem(service, "no contract endpoint")
    }
    let fixture = try fixtures.fixture(endpoint.fixtureFile)
    let asked = variants[service] ?? variants[endpoint.description] ?? variants["*"]
    if let asked, let v = fixture.json["variants"]?[asked] { return (v, asked) }
    for name in fixture.variantOrder {
      if let v = fixture.json["variants"]?[name], let when = v["when"], request.matches(when) { return (v, name) }
    }
    guard let name = fixture.json["default"]?.stringValue, let v = fixture.json["variants"]?[name] else {
      throw MockAtlas.fixtureProblem(service, "the default variant is missing")
    }
    return (v, name)
  }

  private func serve<T: Decodable>(_ service: String, params: [String: String] = [:], query: (any Encodable)? = nil,
                                   body: (any Encodable)? = nil) throws -> T {
    let request = MockRequest(query: query.map(MockRequest.query) ?? [:], params: params,
                              body: body.flatMap { try? ScrollsJSON.value($0) })
    let (variant, name) = try pick(service, request: request)
    try MockAtlas.throwIfError(variant)
    guard let json = variant["body"] else { throw MockAtlas.fixtureProblem(service, "variant '\(name)' has no JSON body") }
    do {
      return try ScrollsJSON.decode(T.self, from: json)
    } catch {
      throw MockAtlas.fixtureProblem(service, "variant '\(name)' does not decode as \(T.self): \(error)")
    }
  }

  static func throwIfError(_ variant: JSONValue) throws {
    let status = variant["status"]?.safeInteger ?? 200
    guard status >= 400 else { return }
    guard let body = variant["body"], let e = try? ScrollsJSON.decode(ErrorBody.self, from: body) else {
      throw ScrollsError(code: .internalError, message: "The fixture's error variant has no error body.", status: status)
    }
    throw ScrollsError(code: e.error.code, message: e.error.message, hint: e.error.hint, detail: e.error.detail, status: status)
  }

  static func fixtureProblem(_ service: String, _ what: String) -> ScrollsError {
    ScrollsError(code: .internalError, message: "MockAtlas.\(service): \(what).", hint: "The contract fixtures are bundled with ScrollsService.",
                 status: 500)
  }

  /// An SSE event of a fixture as an AtlasEvent (`job`/`progress`/`done` → .job, `data`, `bootstrap`, `adapter`).
  static func atlasEvent(_ e: JSONValue) throws -> AtlasEvent? {
    guard let data = e["data"] else { return nil }
    switch e["event"]?.stringValue {
    case "job", "progress", "done":
      if e["shape"]?.stringValue == "JobDoneEvent" || e["event"]?.stringValue == "done" {
        return .job(.done(try ScrollsJSON.decode(JobDonePayload.self, from: data)))
      }
      return .job(.progress(try ScrollsJSON.decode(JobProgressPayload.self, from: data)))
    case "data":
      return .dataChanged(try ScrollsJSON.decode(DataChangedPayload.self, from: data).dataVersion)
    case "bootstrap":
      return .bootstrap(try ScrollsJSON.decode(BootstrapStatus.self, from: data))
    case "adapter":
      return .adapter(try ScrollsJSON.decode(AdapterStatus.self, from: data))
    default:
      return nil
    }
  }

  static func wait(_ delay: JSONValue?, scale: Double) async {
    guard let ms = delay?.numberValue, ms > 0, scale > 0 else { return }
    try? await Task.sleep(for: .milliseconds(ms * scale))
  }
}

/// A request as mock mode sees it: query and route parameters as strings, and the JSON body.
struct MockRequest {
  var query: [String: String] = [:]
  var params: [String: String] = [:]
  var body: JSONValue?

  /// A GET request type's fields as query parameters (snake_case names, values as JavaScript's `String(v)`); nested
  /// objects (toggles) contribute their members.
  static func query(_ value: any Encodable) -> [String: String] {
    guard case .object(let o)? = try? ScrollsJSON.value(value) else { return [:] }
    var out: [String: String] = [:]
    for (k, v) in o {
      if case .object(let inner) = v {
        for (ik, iv) in inner { out[ik] = jsString(iv) }
      } else {
        out[k] = jsString(v)
      }
    }
    return out
  }

  static func jsString(_ v: JSONValue) -> String {
    switch v {
    case .null: "null"
    case .bool(let b): b ? "true" : "false"
    case .number(let n): JSNumber.format(n)
    case .string(let s): s
    case .array(let a): a.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
    case .object: "[object Object]"
    }
  }

  /// mock.mjs `matches`: every listed query and route parameter equal as strings, every listed body member equal.
  func matches(_ when: JSONValue) -> Bool {
    for (k, v) in when["query"]?.objectValue ?? [:] where query[k] != MockRequest.jsString(v) { return false }
    for (k, v) in when["params"]?.objectValue ?? [:] where params[k] != MockRequest.jsString(v) { return false }
    for (k, v) in when["body"]?.objectValue ?? [:] {
      guard let have = body?[k], CanonicalJSON.string(have) == CanonicalJSON.string(v) else { return false }
    }
    return true
  }
}

/// The fixture files, parsed once.
final class MockFixtures: Sendable {
  struct Fixture: Sendable {
    let json: JSONValue
    /// The variant names in file order (`when` matching takes the first that matches).
    let variantOrder: [String]
  }

  /// The copies bundled with ScrollsService.
  static let bundled = MockFixtures(directory: Bundle.module.url(forResource: "contract-fixtures", withExtension: nil))

  private let loaded: Result<[String: Fixture], ScrollsError>

  init(directory: URL?) {
    loaded = Result { () throws(ScrollsError) -> [String: Fixture] in
      guard let directory, let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
        throw MockAtlas.fixtureProblem("fixtures", "the contract-fixtures directory is missing")
      }
      var out: [String: Fixture] = [:]
      for name in names where name.hasSuffix(".json") {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
          let json = try? JSONValue.parse(data)
        else { throw MockAtlas.fixtureProblem("fixtures", "\(name) does not parse") }
        out[name] = Fixture(json: json, variantOrder: MockFixtures.memberKeys(of: "variants", in: data))
      }
      return out
    }
  }

  func fixture(_ file: String) throws -> Fixture {
    let all = try loaded.get()
    guard let f = all[file] else { throw MockAtlas.fixtureProblem("fixtures", "\(file) is missing") }
    return f
  }

  /// The keys, in document order, of the object that is member `name` of the top-level object. A small scanner, since
  /// `JSONValue` objects (like JavaScript's) compare by key, while mock.mjs iterates variants in this order.
  static func memberKeys(of name: String, in data: Data) -> [String] {
    let b = [UInt8](data)
    let quote = UInt8(ascii: "\""), backslash = UInt8(ascii: "\\")
    var i = 0
    var depth = 0
    var keys: [String] = []
    var targetDepth: Int?
    var lastTopKey: String?
    while i < b.count {
      let c = b[i]
      if c == quote {
        let start = i
        i += 1
        while i < b.count, b[i] != quote { i += b[i] == backslash ? 2 : 1 }
        i += 1
        var j = i
        while j < b.count, b[j] == 0x20 || b[j] == 0x0A || b[j] == 0x0D || b[j] == 0x09 { j += 1 }
        guard j < b.count, b[j] == UInt8(ascii: ":") else { continue }
        let key = (try? JSONValue.parse(Data(b[start..<min(i, b.count)])))?.stringValue ?? ""
        if depth == 1 { lastTopKey = key } else if depth == targetDepth { keys.append(key) }
        continue
      }
      if c == UInt8(ascii: "{") || c == UInt8(ascii: "[") {
        depth += 1
        if c == UInt8(ascii: "{"), depth == 2, targetDepth == nil, lastTopKey == name { targetDepth = 2 }
      } else if c == UInt8(ascii: "}") || c == UInt8(ascii: "]") {
        if depth == targetDepth { return keys }
        depth -= 1
      }
      i += 1
    }
    return keys
  }
}
