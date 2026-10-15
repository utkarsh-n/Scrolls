// OWNER: N0
// The in-process API (IOS-SPEC §1.6, §8.4.6): one async method per contract 1.3.0 fixture (65; GET /api/events is the
// `events` stream). Request and response types are the Codable mirrors in ScrollsContracts, so every answer has the
// shape the reference serves. Errors are `ScrollsError` (the reference's error body plus its HTTP status). Writes that
// the reference journals go through `UserWrites` (§6.2) in LiveAtlas.
//
// Signatures follow the contract where §8.4.6's sketch differs: a method returns its fixture's response shape
// (`proposeRelationship` → `Created`, `cancelJob` → `JobCancel`, …), and takes the request parameters its route reads
// (`commitImport` takes the mapping it commits). The extension below keeps the sketch's short forms.

import Foundation
import ScrollsContracts
import ScrollsStore

/// The engine as the app (and the CLI, and the tests) sees it.
public protocol AtlasService: Sendable {
  // MARK: health · events · jobs
  /// GET /api/health
  func health() async throws -> HealthResponse
  /// GET /api/events: every subscriber gets its own stream.
  var events: AsyncStream<AtlasEvent> { get }
  /// GET /api/jobs
  func jobs(_ r: JobsRequest) async throws -> JobsResponse
  /// GET /api/jobs/:id
  func job(_ id: JobID) async throws -> JobResponse
  /// GET /api/jobs/:id/events: progress events, then one done.
  func jobEvents(_ id: JobID) async throws -> JobEventsResponse
  /// POST /api/jobs/:id/cancel: acknowledged within 500 ms; the final "cancelled" arrives as a done event.
  func cancelJob(_ id: JobID) async throws -> JobCancelResponse

  // MARK: imports (commit and revert are journaled)
  /// POST /api/imports: stage a file and preview it.
  func stageImport(_ r: StageImportRequest) async throws -> ImportStagedResponse
  /// PUT /api/imports/:id/mapping: validate a mapping with a dry run over all rows.
  func setImportMapping(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportMappingResponse
  /// GET /api/imports/:id/preview
  func importPreview(_ id: ImportBatchID, _ r: ImportPreviewRequest) async throws -> ImportPreviewResponse
  /// GET /api/imports/:id/problems.csv
  func importProblems(_ id: ImportBatchID) async throws -> ImportProblemsResponse
  /// POST /api/imports/:id/commit: a job.
  func commitImport(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportCommitResponse
  /// POST /api/imports/:id/revert: a job (soft delete).
  func revertImport(_ id: ImportBatchID) async throws -> ImportRevertResponse

  // MARK: corpora · adapters · baseline · tour · etymology (load and enable are journaled)
  /// GET /api/corpora
  func corpora() async throws -> CorporaResponse
  /// GET /api/facets
  func facets(_ r: FacetsRequest) async throws -> FacetsResponse
  /// GET /api/adapters
  func adapters(_ r: AdaptersRequest) async throws -> AdaptersResponse
  /// GET /api/adapters/:id/claims
  func adapterClaims(_ id: String, _ r: AdapterClaimsRequest) async throws -> AdapterClaimsResponse
  /// POST /api/adapters/:id/load: a job (a chain of jobs for STEMM loads).
  func loadAdapter(_ id: String, _ r: AdapterLoadRequest) async throws -> AdapterLoadResponse
  /// POST /api/adapters/:id/enable
  func enableAdapter(_ id: String, _ r: AdapterEnableRequest) async throws -> AdapterEnableResponse
  /// GET /api/baseline
  func baseline(_ r: BaselineRequest) async throws -> BaselineResponse
  /// GET /api/tour
  func tour() async throws -> TourResponse
  /// GET /api/etymology
  func etymology(_ r: EtymologyRequest) async throws -> EtymologyResponse

  // MARK: search · expressions · timeline · passages · documents · KWIC · occurrences · exports · snapshots
  /// GET /api/search
  func search(_ r: SearchRequest) async throws -> SearchResponse
  /// POST /api/expressions (journaled)
  func trackExpression(_ r: TrackExpressionRequest) async throws -> ExpressionResponse
  /// GET /api/expressions/:id (`corpus` 'real' answers the expression across member corpora)
  func expression(_ id: ExpressionID, corpus: String?) async throws -> ExpressionResponse
  /// PATCH /api/expressions/:id/variants (journaled)
  func setVariants(_ id: ExpressionID, _ r: VariantsPatchRequest) async throws -> ExpressionResponse
  /// POST /api/timeline/query
  func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse
  /// GET /api/timeline/tiles
  func tiles(_ r: TilesRequest) async throws -> TilesResponse
  /// GET /api/timeline/marks
  func marks(_ r: MarksRequest) async throws -> MarksResponse
  /// GET /api/timeline/arcs
  func arcs(_ r: ArcsRequest) async throws -> ArcsResponse
  /// GET /api/timeline/shelf
  func shelf(_ r: ShelfRequest) async throws -> ShelfResponse
  /// GET /api/timeline/bin
  func bin(_ r: BinRequest) async throws -> BinResponse
  /// GET /api/passages/:id
  func passage(_ id: PassageID, _ r: PassageRequest) async throws -> PassageResponse
  /// GET /api/documents/:id
  func document(_ id: DocumentID) async throws -> DocumentResponse
  /// GET /api/documents/:id/text (≤ 20k UTF-16 units; nil bounds = from 0, up to 20k)
  func documentText(_ id: DocumentID, from: Int?, to: Int?) async throws -> DocumentTextResponse
  /// GET /api/kwic
  func kwic(_ r: KwicRequest) async throws -> KwicResponse
  /// GET /api/occurrences/:id
  func occurrence(_ id: OccurrenceID) async throws -> OccurrenceResponse
  /// GET /api/export
  func export(_ r: ExportRequest) async throws -> ExportResponse
  /// POST /api/snapshots
  func createSnapshot(_ r: SnapshotCreateRequest) async throws -> SnapshotCreateResponse
  /// GET /api/snapshots/:file
  func snapshot(_ file: String) async throws -> SnapshotResponse

  // MARK: analysis
  /// POST /api/compare
  func compare(_ r: CompareRequest) async throws -> CompareResponse
  /// GET /api/collocations
  func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse
  /// GET /api/clusters
  func clusters(_ r: ClustersRequest) async throws -> ClustersResponse
  /// POST /api/analysis/runs (journaled when it writes evidence, §6.2)
  func startRun(_ r: StartRunRequest) async throws -> StartRunResponse
  /// GET /api/analysis/runs
  func runs(_ r: RunsRequest) async throws -> RunsResponse
  /// GET /api/constellation
  func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse

  // MARK: lineage · provenance · notebook · views (writes are journaled)
  /// GET /api/lineage
  func lineage(_ r: LineageRequest) async throws -> LineageResponse
  /// GET /api/lineage/path
  func lineagePath(_ r: LineagePathRequest) async throws -> LineagePathResponse
  /// GET /api/genealogy
  func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse
  /// GET /api/relationships/:id
  func relationship(_ id: RelationshipID) async throws -> RelationshipResponse
  /// POST /api/relationships: always proposed, origin human.
  func proposeRelationship(_ r: ProposeRelationshipRequest) async throws -> CreatedResponse
  /// POST /api/relationships/:id/review: the evidence status never changes.
  func review(_ id: RelationshipID, _ r: ReviewRequest) async throws -> ReviewResponse
  /// POST /api/relationships/:id/evidence
  func addEvidence(_ id: RelationshipID, _ r: EvidenceRequest) async throws -> CreatedResponse
  /// GET /api/hypothesis-groups/:id
  func hypothesisGroup(_ id: HypothesisGroupID) async throws -> HypothesisGroupResponse
  /// POST /api/hypothesis-groups
  func createHypothesisGroup(_ r: HypothesisGroupCreateRequest) async throws -> CreatedResponse
  /// POST /api/trace: ≤ 1.5 s inline, else `{job}`.
  func trace(_ r: TraceRequest) async throws -> TraceResponse
  /// GET /api/annotations
  func annotations(_ r: AnnotationsRequest) async throws -> AnnotationsResponse
  /// POST /api/annotations
  func createAnnotation(_ r: AnnotationCreateRequest) async throws -> AnnotationRevResponse
  /// PATCH /api/annotations/:id: a new revision.
  func reviseAnnotation(_ id: AnnotationID, _ r: AnnotationPatchRequest) async throws -> AnnotationRevResponse
  /// POST /api/annotations/:id/reinterpret
  func reinterpret(_ id: AnnotationID, _ r: AnnotationCreateRequest) async throws -> AnnotationReinterpretedResponse
  /// POST /api/annotations/:id/withdraw
  func withdraw(_ id: AnnotationID, _ r: WithdrawRequest) async throws -> AnnotationRevResponse
  /// GET /api/annotations/:id/revisions
  func annotationRevisions(_ id: AnnotationID) async throws -> AnnotationRevisionsResponse
  /// POST /api/views (+ PortableCutoffs, §6.4)
  func saveView(_ r: SaveViewRequest) async throws -> ViewSavedResponse
  /// GET /api/views
  func views(_ r: ViewsRequest) async throws -> ViewsResponse
  /// GET /api/views/:slug (`asSaved`: resolved by ViewCutoffResolver)
  func view(_ slug: String, asSaved: Bool) async throws -> SavedViewResponse
  /// DELETE /api/views/:slug (soft)
  func deleteView(_ slug: String) async throws -> DeleteViewResponse
}

extension AtlasService {
  /// GET /api/adapters without a re-probe.
  public func adapters() async throws -> AdaptersResponse { try await adapters(AdaptersRequest()) }
  /// GET /api/views, newest first.
  public func views() async throws -> ViewsResponse { try await views(ViewsRequest()) }
  /// GET /api/imports/:id/preview with the staged settings.
  public func importPreview(_ id: ImportBatchID) async throws -> ImportPreviewResponse {
    try await importPreview(id, ImportPreviewRequest())
  }
  /// GET /api/expressions/:id in its own corpus.
  public func expression(_ id: ExpressionID) async throws -> ExpressionResponse { try await expression(id, corpus: nil) }
  /// GET /api/passages/:id, with or without its neighbours.
  public func passage(_ id: PassageID, context: Bool) async throws -> PassageResponse {
    try await passage(id, PassageRequest(context: context))
  }
  /// GET /api/documents/:id/text from 0, up to 20k UTF-16 units.
  public func documentText(_ id: DocumentID) async throws -> DocumentTextResponse {
    try await documentText(id, from: nil, to: nil)
  }
}
