// OWNER: N0
// The contract's endpoint table (contracts.mjs ENDPOINTS + tests/helpers/shape.mjs EXTRA_ENDPOINTS) and its shape
// names → Swift types. MockAtlas serves each endpoint's fixture through it; C0 round-trips every fixture body with it.

import Foundation
import ScrollsCore

/// One endpoint of contract 1.3.0, its fixture file, and the contract shapes of its bodies.
public struct ContractEndpoint: Sendable, Hashable, CustomStringConvertible {
  /// What a success answer carries.
  public enum Body: String, Sendable, Hashable {
    /// A JSON body of the `response` shape.
    case json
    /// A server-sent event stream (`events` in the fixture).
    case events
    /// A text download (CSV, JSONL) or a JSON download without a shape.
    case download
    /// Bytes (a stored snapshot).
    case binary
    /// 204, no body.
    case empty
  }

  public let method: String
  /// The route pattern: '/api/passages/:id'.
  public let path: String
  /// The contract shape of the JSON request body, if the endpoint takes one.
  public let request: String?
  /// The contract shape of a success body (nil for streams, downloads and 204).
  public let response: String?
  public let body: Body
  /// The AtlasService method that serves it in process.
  public let service: String

  public init(_ method: String, _ path: String, request: String? = nil, response: String?, body: Body = .json, service: String) {
    self.method = method
    self.path = path
    self.request = request
    self.response = response
    self.body = body
    self.service = service
  }

  /// `GET /api/passages/:id` → `GET__api_passages_{id}.json` (server/http/mock.mjs `fixtureFileName`).
  public var fixtureFile: String {
    var segments: [String] = []
    for seg in path.split(separator: "/", omittingEmptySubsequences: true) {
      segments.append(seg.hasPrefix(":") ? "{\(seg.dropFirst())}" : String(seg))
    }
    return "\(method)__\(segments.joined(separator: "_")).json"
  }

  public var description: String { "\(method) \(path)" }
}

/// Every endpoint with a fixture (65), and the Swift type of every contract shape.
public enum ContractCatalog {
  public static let endpoints: [ContractEndpoint] = [
    // health · events · jobs (WP0)
    .init("GET", "/api/health", response: "Health", service: "health"),
    .init("GET", "/api/events", response: nil, body: .events, service: "events"),
    .init("GET", "/api/jobs", response: "JobList", service: "jobs"),
    .init("GET", "/api/jobs/:id", response: "Job", service: "job"),
    .init("GET", "/api/jobs/:id/events", response: nil, body: .events, service: "jobEvents"),
    .init("POST", "/api/jobs/:id/cancel", response: "JobCancel", service: "cancelJob"),
    // imports (WP1)
    .init("POST", "/api/imports", response: "ImportCreated", service: "stageImport"),
    .init("PUT", "/api/imports/:id/mapping", request: "ImportMappingRequest", response: "ImportValidation",
          service: "setImportMapping"),
    .init("GET", "/api/imports/:id/preview", response: "ImportPreview", service: "importPreview"),
    .init("GET", "/api/imports/:id/problems.csv", response: nil, body: .download, service: "importProblems"),
    .init("POST", "/api/imports/:id/commit", request: "ImportMappingRequest", response: "JobRef", service: "commitImport"),
    .init("POST", "/api/imports/:id/revert", response: "JobRef", service: "revertImport"),
    // sources (WP2)
    .init("GET", "/api/corpora", response: "Corpora", service: "corpora"),
    .init("GET", "/api/facets", response: "Facets", service: "facets"),
    .init("GET", "/api/adapters", response: "Adapters", service: "adapters"),
    .init("GET", "/api/adapters/:id/claims", response: "AdapterClaims", service: "adapterClaims"),
    .init("POST", "/api/adapters/:id/load", response: "JobRef", service: "loadAdapter"),
    .init("POST", "/api/adapters/:id/enable", response: "Adapters", service: "enableAdapter"),
    .init("GET", "/api/baseline", response: "Baseline", service: "baseline"),
    .init("GET", "/api/tour", response: "Tour", service: "tour"),
    .init("GET", "/api/etymology", response: "Etymology", service: "etymology"),
    // search · timeline · reading · exports (WP3)
    .init("GET", "/api/search", response: "Search", service: "search"),
    .init("POST", "/api/expressions", request: "ExpressionRequest", response: "Expression", service: "trackExpression"),
    .init("GET", "/api/expressions/:id", response: "Expression", service: "expression"),
    .init("PATCH", "/api/expressions/:id/variants", request: "VariantsPatch", response: "Expression", service: "setVariants"),
    .init("POST", "/api/timeline/query", request: "TimelineQueryRequest", response: "TimelineQuery", service: "timelineQuery"),
    .init("GET", "/api/timeline/tiles", response: "Tiles", service: "tiles"),
    .init("GET", "/api/timeline/marks", response: "Marks", service: "marks"),
    .init("GET", "/api/timeline/arcs", response: "Arcs", service: "arcs"),
    .init("GET", "/api/timeline/shelf", response: "Shelf", service: "shelf"),
    .init("GET", "/api/timeline/bin", response: "BinDrawer", service: "bin"),
    .init("GET", "/api/passages/:id", response: "Passage", service: "passage"),
    .init("GET", "/api/documents/:id", response: "Document", service: "document"),
    .init("GET", "/api/documents/:id/text", response: "DocumentText", service: "documentText"),
    .init("GET", "/api/kwic", response: "Kwic", service: "kwic"),
    .init("GET", "/api/occurrences/:id", response: "Occurrence", service: "occurrence"),
    .init("GET", "/api/export", response: nil, body: .download, service: "export"),
    .init("POST", "/api/snapshots", request: "SnapshotRequest", response: "Snapshot", service: "createSnapshot"),
    .init("GET", "/api/snapshots/:file", response: nil, body: .binary, service: "snapshot"),
    // analysis (WP4)
    .init("POST", "/api/compare", request: "CompareRequest", response: "Compare", service: "compare"),
    .init("GET", "/api/collocations", response: "Collocations", service: "collocations"),
    .init("GET", "/api/clusters", response: "Clusters", service: "clusters"),
    .init("POST", "/api/analysis/runs", request: "AnalysisRunRequest", response: "AnalysisRunStarted", service: "startRun"),
    .init("GET", "/api/analysis/runs", response: "AnalysisRuns", service: "runs"),
    .init("GET", "/api/constellation", response: "Constellation", service: "constellation"),
    // lineage · provenance · notebook · views (WP5)
    .init("GET", "/api/lineage", response: "Lineage", service: "lineage"),
    .init("GET", "/api/lineage/path", response: "LineagePath", service: "lineagePath"),
    .init("GET", "/api/genealogy", response: "Genealogy", service: "genealogy"),
    .init("GET", "/api/relationships/:id", response: "Relationship", service: "relationship"),
    .init("POST", "/api/relationships", request: "RelationshipRequest", response: "Created", service: "proposeRelationship"),
    .init("POST", "/api/relationships/:id/review", request: "ReviewRequest", response: "Review", service: "review"),
    .init("POST", "/api/relationships/:id/evidence", response: "Created", service: "addEvidence"),
    .init("GET", "/api/hypothesis-groups/:id", response: "HypothesisGroup", service: "hypothesisGroup"),
    .init("POST", "/api/hypothesis-groups", request: "HypothesisGroupRequest", response: "Created",
          service: "createHypothesisGroup"),
    .init("POST", "/api/trace", request: "TraceRequest", response: "Trace", service: "trace"),
    .init("GET", "/api/annotations", response: "Annotations", service: "annotations"),
    .init("POST", "/api/annotations", request: "AnnotationRequest", response: "AnnotationRev", service: "createAnnotation"),
    .init("PATCH", "/api/annotations/:id", request: "AnnotationPatch", response: "AnnotationRev", service: "reviseAnnotation"),
    .init("POST", "/api/annotations/:id/reinterpret", request: "AnnotationRequest", response: "AnnotationReinterpreted",
          service: "reinterpret"),
    .init("POST", "/api/annotations/:id/withdraw", response: "AnnotationRev", service: "withdraw"),
    .init("GET", "/api/annotations/:id/revisions", response: "AnnotationRevisions", service: "annotationRevisions"),
    .init("POST", "/api/views", request: "ViewRequest", response: "ViewSaved", service: "saveView"),
    .init("GET", "/api/views", response: "Views", service: "views"),
    .init("GET", "/api/views/:slug", response: "View", service: "view"),
    .init("DELETE", "/api/views/:slug", response: nil, body: .empty, service: "deleteView"),
  ]

  /// The endpoint an AtlasService method serves, by method name ('passage').
  public static func endpoint(service: String) -> ContractEndpoint? { endpoints.first { $0.service == service } }

  /// Request bodies of endpoints that have no request shape in contracts.mjs but carry an `example_request`
  /// (adapter load and enable, evidence): the Swift type that mirrors them.
  public static let unshapedRequests: [String: String] = [
    "POST /api/adapters/:id/load": "AdapterLoadRequest",
    "POST /api/adapters/:id/enable": "AdapterEnableRequest",
    "POST /api/relationships/:id/evidence": "EvidenceRequest",
  ]

  /// JSON download bodies (no contract shape yet): the Swift type that mirrors them.
  public static let unshapedBodies: [String: String] = [
    "GET /api/export": "ExportDocument",
  ]

  /// The Swift type of a contract shape name (contracts.mjs `SHAPES`), plus the Swift-only names of
  /// `unshapedRequests` and `unshapedBodies`. Nil for a name with no Swift mirror.
  public static func type(ofShape name: String) -> (any Codable.Type)? {
    switch name {
    // shared pieces
    case "Provenance": Provenance.self
    case "Issue": Issue.self
    case "DateParse": DateParse.self
    case "DateRow": DateRow.self
    case "Anchor": Anchor.self
    case "Variant": Variant.self
    case "Lane": Lane.self
    case "Cell": TileCell.self
    case "Wash": Wash.self
    case "Arc": Arc.self
    case "Measure": Measure.self
    case "Job": JobResponse.self
    case "Annotation": Annotation.self
    case "ShareCell": ShareCell.self
    case "ArcBucket": ArcBucket.self
    case "ImportSummary": ImportSummary.self
    case "ImportPreview": ImportPreviewResponse.self
    case "PassageDocument": PassageDocument.self
    case "ErrorBody": ErrorBody.self
    case "JobRef": JobRefResponse.self
    // health, jobs, events
    case "Health": HealthResponse.self
    case "JobList": JobsResponse.self
    case "JobCancel": JobCancelResponse.self
    case "JobProgressEvent": JobProgressPayload.self
    case "JobDoneEvent": JobDonePayload.self
    case "DataEvent": DataChangedPayload.self
    case "BootstrapEvent": BootstrapStatus.self
    case "AdapterEvent": AdapterStatus.self
    // imports
    case "ImportCreated": ImportStagedResponse.self
    case "ImportMappingRequest": ImportMappingRequest.self
    case "ImportValidation": ImportMappingResponse.self
    // sources
    case "Corpus": Corpus.self
    case "Corpora": CorporaResponse.self
    case "Facets": FacetsResponse.self
    case "Adapters": AdaptersResponse.self
    case "AdapterClaims": AdapterClaimsResponse.self
    case "Baseline": BaselineResponse.self
    case "Tour": TourResponse.self
    case "Etymology": EtymologyResponse.self
    case "AdapterLoadRequest": AdapterLoadRequest.self
    case "AdapterEnableRequest": AdapterEnableRequest.self
    // search, timeline, reading
    case "Search": SearchResponse.self
    case "ExpressionRequest": TrackExpressionRequest.self
    case "Expression": ExpressionResponse.self
    case "VariantsPatch": VariantsPatchRequest.self
    case "TimelineQueryRequest": TimelineQueryRequest.self
    case "TimelineQuery": TimelineQueryResponse.self
    case "Tiles": TilesResponse.self
    case "Marks": MarksResponse.self
    case "Arcs": ArcsResponse.self
    case "Shelf": ShelfResponse.self
    case "BinDrawer": BinResponse.self
    case "Passage": PassageResponse.self
    case "Document": DocumentResponse.self
    case "DocumentText": DocumentTextResponse.self
    case "Occurrence": OccurrenceResponse.self
    case "Kwic": KwicResponse.self
    case "ExportManifest": ExportManifest.self
    case "ExportDocument": ExportDocument.self
    case "SnapshotRequest": SnapshotCreateRequest.self
    case "Snapshot": SnapshotCreateResponse.self
    // analysis
    case "CompareRequest": CompareRequest.self
    case "Compare": CompareResponse.self
    case "BaselineRho": BaselineRho.self
    case "Collocations": CollocationsResponse.self
    case "Clusters": ClustersResponse.self
    case "AnalysisRunRequest": StartRunRequest.self
    case "AnalysisRunStarted": StartRunResponse.self
    case "AnalysisRuns": RunsResponse.self
    case "Constellation": ConstellationResponse.self
    // lineage and provenance
    case "Lineage": LineageResponse.self
    case "LineagePath": LineagePathResponse.self
    case "Genealogy": GenealogyResponse.self
    case "Relationship": RelationshipResponse.self
    case "RelationshipRequest": ProposeRelationshipRequest.self
    case "ReviewRequest": ReviewRequest.self
    case "Review": ReviewResponse.self
    case "HypothesisGroup": HypothesisGroupResponse.self
    case "HypothesisGroupRequest": HypothesisGroupCreateRequest.self
    case "Created": CreatedResponse.self
    case "TraceRequest": TraceRequest.self
    case "Trace": TraceResponse.self
    case "EvidenceRequest": EvidenceRequest.self
    // notebook and views
    case "AnnotationRequest": AnnotationCreateRequest.self
    case "AnnotationPatch": AnnotationPatchRequest.self
    case "AnnotationRev": AnnotationRevResponse.self
    case "AnnotationReinterpreted": AnnotationReinterpretedResponse.self
    case "Annotations": AnnotationsResponse.self
    case "AnnotationRevisions": AnnotationRevisionsResponse.self
    case "ViewRequest": SaveViewRequest.self
    case "ViewSaved": ViewSavedResponse.self
    case "View": SavedViewResponse.self
    case "Views": ViewsResponse.self
    // canonical inputs
    case "CanonicalDocument": CanonicalDocument.self
    case "CanonicalRelationship": CanonicalRelationship.self
    case "CanonicalAnnotation": CanonicalAnnotation.self
    default: nil
    }
  }

  /// Decodes `value` as the shape's Swift type and encodes it again: the C0 round trip of one body.
  public static func roundTrip(shape name: String, _ value: JSONValue) throws -> JSONValue {
    guard let type = type(ofShape: name) else { throw UnknownShape(name: name) }
    return try roundTrip(type, value)
  }

  private static func roundTrip<T: Codable>(_ type: T.Type, _ value: JSONValue) throws -> JSONValue {
    try ScrollsJSON.value(try ScrollsJSON.decode(type, from: value))
  }

  /// A shape name with no Swift mirror.
  public struct UnknownShape: Error, Sendable, CustomStringConvertible {
    public let name: String
    public var description: String { "no Swift type mirrors contract shape '\(name)'" }
  }
}
