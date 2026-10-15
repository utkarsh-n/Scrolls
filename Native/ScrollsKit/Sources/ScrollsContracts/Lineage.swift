// OWNER: N0
// Lineage, chains, genealogy, relationship cards and reviews, hypothesis groups and the quotation trace (contract
// shapes `Lineage`, `LineagePath`, `Genealogy`, `Relationship`, `RelationshipRequest`, `ReviewRequest`, `Review`,
// `HypothesisGroup`, `HypothesisGroupRequest`, `Created`, `TraceRequest`, `Trace`). A relationship's evidence status
// is fixed at creation; reviews never change it (SPEC §13).

import ScrollsCore

// MARK: - lineage graph and chains

/// GET /api/lineage query: a bounded graph around a root.
public struct LineageRequest: Codable, Sendable, Equatable {
  /// A reference ('passage:77'), or 'shared:<8 hex>' to expand a widely shared text.
  public var root: String
  /// 1–3 hops (default 2).
  public var depth: Int?
  /// 'both' (default) | 'in' | 'out'
  public var dir: String?
  /// ≤ 150 (default 60).
  public var maxNodes: Int?
  /// Relationship types, comma-separated.
  public var types: String?
  /// Evidence statuses, comma-separated.
  public var status: String?
  /// '1' includes rejected links.
  public var rejected: String?
  public var relRevCutoff: Int?
  public var runs: String?
  public init(root: String, depth: Int? = nil, dir: String? = nil, maxNodes: Int? = nil, types: String? = nil,
              status: String? = nil, rejected: String? = nil, relRevCutoff: Int? = nil, runs: String? = nil) {
    self.root = root
    self.depth = depth
    self.dir = dir
    self.maxNodes = maxNodes
    self.types = types
    self.status = status
    self.rejected = rejected
    self.relRevCutoff = relRevCutoff
    self.runs = runs
  }
}

/// A bounded lineage graph (depth 2 both ways, ≤ 60 nodes; hard cap 150), hypothesis groups, truncation stated
/// (contract shape `Lineage`).
public struct LineageResponse: Codable, Sendable, Equatable {
  public var root: String
  public var nodes: [LineageNode]
  public var edges: [LineageEdge]
  public var groups: [LineageGroup]
  public var truncated: LineageTruncation
  /// "x = the Scroll time scale; rows = hops from the root, never meaning"
  public var layout: String?
  /// Commonplace links (verbatim).
  public var links: JSONValue?
  public var filters: JSONValue?
  public var note: String?
  public var mockNote: String?

  public init(root: String, nodes: [LineageNode], edges: [LineageEdge], groups: [LineageGroup], truncated: LineageTruncation,
              layout: String? = nil) {
    self.root = root
    self.nodes = nodes
    self.edges = edges
    self.groups = groups
    self.truncated = truncated
    self.layout = layout
  }
}

/// A node of the lineage graph: an item with its document, year and hop count.
public struct LineageNode: Codable, Sendable, Equatable {
  public var id: String
  public var label: String
  public var type: String?
  public var synthetic: Bool?
  public var doc: DocumentID?
  @NullOrAbsent public var title: String?
  @NullOrAbsent public var y: Int?
  public var precision: String?
  public var kind: String?
  public var generation: Int?
  public var direction: String?
  public var undated: Bool?
  public var expandable: Int?
  public var rootDocument: Bool?
  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}

/// An edge of the lineage graph.
public struct LineageEdge: Codable, Sendable, Equatable {
  public var relId: RelationshipID
  public var src: String
  public var dst: String
  public var relType: String
  public var family: String
  public var evidenceStatus: String
  public var reviewStatus: String
  @Nullable public var score: Score?
  @Nullable public var method: String?
  @Nullable public var runId: RunID?
  @Nullable public var hypothesisGroup: HypothesisGroupID?
  public var dateConflict: Bool
  public var synthetic: Bool
  @NullOrAbsent public var sourceDataset: String?
  public var feedback: Bool?
  public var createdBy: String?

  public init(relId: RelationshipID, src: String, dst: String, relType: String, family: String, evidenceStatus: String,
              reviewStatus: String, score: Score?, method: String?, runId: RunID?, hypothesisGroup: HypothesisGroupID?,
              dateConflict: Bool, synthetic: Bool) {
    self.relId = relId
    self.src = src
    self.dst = dst
    self.relType = relType
    self.family = family
    self.evidenceStatus = evidenceStatus
    self.reviewStatus = reviewStatus
    self.score = score
    self.method = method
    self.runId = runId
    self.hypothesisGroup = hypothesisGroup
    self.dateConflict = dateConflict
    self.synthetic = synthetic
  }
}

/// A hypothesis group drawn on the graph.
public struct LineageGroup: Codable, Sendable, Equatable {
  public var id: HypothesisGroupID
  public var question: String
  public var edges: [RelationshipID]
  public init(id: HypothesisGroupID, question: String, edges: [RelationshipID]) {
    self.id = id
    self.question = question
    self.edges = edges
  }
}

/// How many nodes were left out, and why.
public struct LineageTruncation: Codable, Sendable, Equatable {
  public var nodes: Int
  @Nullable public var reason: String?
  public init(nodes: Int, reason: String?) {
    self.nodes = nodes
    self.reason = reason
  }
}

/// GET /api/lineage/path query.
public struct LineagePathRequest: Codable, Sendable, Equatable {
  public var from: String
  public var to: String
  public var types: String?
  public var status: String?
  public init(from: String, to: String, types: String? = nil, status: String? = nil) {
    self.from = from
    self.to = to
    self.types = types
    self.status = status
  }
}

/// The least-evidence-cost chain (documented 1, computed 3, proposed 5; rejected excluded); the chain is as strong as
/// its weakest link (contract shape `LineagePath`).
public struct LineagePathResponse: Codable, Sendable, Equatable {
  /// `[{rel_id, src, dst, rel_type, evidence_status, review_status, cost}]` (verbatim).
  public var path: JSONValue
  public var cost: Double
  @Nullable public var weakest: String?
  public var from: String?
  public var to: String?
  public var reversed: Bool?
  public var text: String?
  public var note: String?
  public init(path: JSONValue, cost: Double, weakest: String?, from: String? = nil, to: String? = nil, reversed: Bool? = nil,
              text: String? = nil, note: String? = nil) {
    self.path = path
    self.cost = cost
    self.weakest = weakest
    self.from = from
    self.to = to
    self.reversed = reversed
    self.text = text
    self.note = note
  }
}

/// GET /api/genealogy query: a work (`document:<id>`) or a maker.
public struct GenealogyRequest: Codable, Sendable, Equatable {
  public var work: String?
  /// A name, or a search maker slug (`maker:<slug>`).
  public var maker: String?
  /// 'forward' | 'back' | 'both' (default)
  public var dir: String?
  /// Default 3.
  public var depth: Int?
  /// Default 150.
  public var max: Int?
  /// Default samples, interpolates, cover_of, remix_of, version_of.
  public var types: String?
  /// Default 'documented'.
  public var status: String?
  public var cursor: String?
  public init(work: String? = nil, maker: String? = nil, dir: String? = nil, depth: Int? = nil, max: Int? = nil,
              types: String? = nil, status: String? = nil, cursor: String? = nil) {
    self.work = work
    self.maker = maker
    self.dir = dir
    self.depth = depth
    self.max = max
    self.types = types
    self.status = status
    self.cursor = cursor
  }
}

/// Works-as-bars genealogy: generations, per-decade density, documented edges with locators (contract shape `Genealogy`).
public struct GenealogyResponse: Codable, Sendable, Equatable {
  public var seed: GenealogySeed
  public var generations: [GenealogyGeneration]
  /// `{rows, cursor}` (verbatim).
  public var truncated: JSONValue
  public var note: String
  public var synthetic: Bool?
  public init(seed: GenealogySeed, generations: [GenealogyGeneration], truncated: JSONValue, note: String,
              synthetic: Bool? = nil) {
    self.seed = seed
    self.generations = generations
    self.truncated = truncated
    self.note = note
    self.synthetic = synthetic
  }
}

/// The work (or maker) the genealogy starts from.
public struct GenealogySeed: Codable, Sendable, Equatable {
  public var doc: DocumentID
  public var title: String
  @Nullable public var maker: String?
  @Nullable public var year: Int?
  public var works: Int?
  public var date: JSONValue?
  public init(doc: DocumentID, title: String, maker: String?, year: Int?, works: Int? = nil, date: JSONValue? = nil) {
    self.doc = doc
    self.title = title
    self.maker = maker
    self.year = year
    self.works = works
    self.date = date
  }
}

/// One generation of the genealogy.
public struct GenealogyGeneration: Codable, Sendable, Equatable {
  public var gen: Int
  public var total: Int
  public var returned: Int
  public var byDecade: [String: Int]
  public var rows: [GenealogyRow]
  public init(gen: Int, total: Int, returned: Int, byDecade: [String: Int], rows: [GenealogyRow]) {
    self.gen = gen
    self.total = total
    self.returned = returned
    self.byDecade = byDecade
    self.rows = rows
  }
}

/// A work in a generation with the documented edges that place it there.
public struct GenealogyRow: Codable, Sendable, Equatable {
  public var doc: DocumentID
  public var title: String
  @Nullable public var maker: String?
  public var date: JSONValue
  public var edges: [GenealogyEdge]
  public var synthetic: Bool?
  public var collection: String?
  public var rateEligible: Bool?
  public init(doc: DocumentID, title: String, maker: String?, date: JSONValue, edges: [GenealogyEdge], synthetic: Bool? = nil) {
    self.doc = doc
    self.title = title
    self.maker = maker
    self.date = date
    self.edges = edges
    self.synthetic = synthetic
  }
}

/// A documented genealogy edge with its source locator.
public struct GenealogyEdge: Codable, Sendable, Equatable {
  public var relId: RelationshipID
  public var relType: String
  public var evidenceStatus: String
  @Nullable public var sourceDataset: String?
  @Nullable public var locator: String?
  public init(relId: RelationshipID, relType: String, evidenceStatus: String, sourceDataset: String?, locator: String?) {
    self.relId = relId
    self.relType = relType
    self.evidenceStatus = evidenceStatus
    self.sourceDataset = sourceDataset
    self.locator = locator
  }
}

// MARK: - relationships

/// An end of a relationship on its card.
public struct RelationshipEnd: Codable, Sendable, Equatable {
  public var ref: String
  public var type: String?
  /// The document's title.
  @NullOrAbsent public var doc: JSONValue?
  @NullOrAbsent public var y: Int?
  public var docId: DocumentID?
  public var label: String?
  public var missing: Bool?
  public init(ref: String, type: String? = nil, doc: JSONValue? = nil, y: Int? = nil, docId: DocumentID? = nil,
              label: String? = nil, missing: Bool? = nil) {
    self.ref = ref
    self.type = type
    self.doc = doc
    self.y = y
    self.docId = docId
    self.label = label
    self.missing = missing
  }
}

/// An evidence span of a relationship.
public struct RelationshipEvidence: Codable, Sendable, Equatable {
  public var id: EvidenceID
  /// `vocab.EVIDENCE_ROLES`
  public var role: String
  @NullOrAbsent public var passage: PassageID?
  @NullOrAbsent public var start: Int?
  @NullOrAbsent public var end: Int?
  @NullOrAbsent public var quote: String?
  @NullOrAbsent public var anchor: JSONValue?
  @NullOrAbsent public var detail: JSONValue?
  public var addedBy: String?
  public var addedAt: String?
  public init(id: EvidenceID, role: String, passage: PassageID? = nil, start: Int? = nil, end: Int? = nil, quote: String? = nil) {
    self.id = id
    self.role = role
    self.passage = passage
    self.start = start
    self.end = end
    self.quote = quote
  }
}

/// One revision of a relationship (append-only).
public struct RelationshipRevision: Codable, Sendable, Equatable {
  public var rev: Int
  /// `vocab.REL_ACTIONS`
  public var action: String
  public var actor: String
  public var at: String?
  @NullOrAbsent public var reason: String?
  @NullOrAbsent public var annotationId: AnnotationID?
  @NullOrAbsent public var before: JSONValue?
  @NullOrAbsent public var after: JSONValue?
  public init(rev: Int, action: String, actor: String, at: String? = nil, reason: String? = nil,
              annotationId: AnnotationID? = nil) {
    self.rev = rev
    self.action = action
    self.actor = actor
    self.at = at
    self.reason = reason
    self.annotationId = annotationId
  }
}

/// The edge card: type and direction, status in words, origin, method or annotator, run, score with its kind,
/// locator, evidence spans, revisions, review state, annotations and the fixed caution (contract shape `Relationship`).
public struct RelationshipResponse: Codable, Sendable, Equatable {
  public var id: RelationshipID
  public var relType: String
  public var family: String
  public var directed: Bool
  public var evidenceStatus: String
  /// `vocab.ORIGINS`
  public var origin: String
  public var createdBy: String
  @Nullable public var method: String?
  @Nullable public var runId: RunID?
  @Nullable public var sourceDataset: String?
  @Nullable public var sourceLocator: String?
  public var provenanceQuality: String
  public var reviewStatus: String
  @Nullable public var score: Score?
  @Nullable public var hypothesisGroup: HypothesisGroupID?
  public var dateConflict: Bool
  @Nullable public var license: String?
  @Nullable public var attribution: String?
  public var src: RelationshipEnd
  public var dst: RelationshipEnd
  public var evidence: [RelationshipEvidence]
  public var revisions: [RelationshipRevision]
  public var annotations: [AnnotationID]
  /// The fixed caution: shared wording can come from a common source.
  public var caution: String
  public var synthetic: Bool
  public var label: String?
  @NullOrAbsent public var inverseLabel: String?
  @NullOrAbsent public var glyph: String?
  public var statusWords: String?
  public var locatorExternal: Bool?
  @NullOrAbsent public var provenanceNote: String?
  @NullOrAbsent public var scoreLabel: String?
  public var createdAt: String?
  /// The run that computed it (`{id, stage, pipeline_version, params, status}`), verbatim.
  public var run: JSONValue?
  /// The citation cue (`{quote, referent}`), verbatim.
  public var cue: JSONValue?
  public var tokens: Int?

  public init(id: RelationshipID, relType: String, family: String, directed: Bool, evidenceStatus: String, origin: String,
              createdBy: String, method: String?, runId: RunID?, sourceDataset: String?, sourceLocator: String?,
              provenanceQuality: String, reviewStatus: String, score: Score?, hypothesisGroup: HypothesisGroupID?,
              dateConflict: Bool, license: String?, attribution: String?, src: RelationshipEnd, dst: RelationshipEnd,
              evidence: [RelationshipEvidence], revisions: [RelationshipRevision], annotations: [AnnotationID],
              caution: String, synthetic: Bool) {
    self.id = id
    self.relType = relType
    self.family = family
    self.directed = directed
    self.evidenceStatus = evidenceStatus
    self.origin = origin
    self.createdBy = createdBy
    self.method = method
    self.runId = runId
    self.sourceDataset = sourceDataset
    self.sourceLocator = sourceLocator
    self.provenanceQuality = provenanceQuality
    self.reviewStatus = reviewStatus
    self.score = score
    self.hypothesisGroup = hypothesisGroup
    self.dateConflict = dateConflict
    self.license = license
    self.attribution = attribution
    self.src = src
    self.dst = dst
    self.evidence = evidence
    self.revisions = revisions
    self.annotations = annotations
    self.caution = caution
    self.synthetic = synthetic
  }
}

/// An evidence span sent with a proposal or attached later.
public struct EvidenceSpanRequest: Codable, Sendable, Equatable {
  public var passage: PassageID?
  public var start: Int?
  public var end: Int?
  /// `vocab.EVIDENCE_ROLES`
  public var role: String?
  /// Offsets into the passage text instead of the document text.
  public var relative: Bool?
  public var extId: String?
  public var quote: String?
  public init(passage: PassageID? = nil, start: Int? = nil, end: Int? = nil, role: String? = nil, relative: Bool? = nil,
              extId: String? = nil, quote: String? = nil) {
    self.passage = passage
    self.start = start
    self.end = end
    self.role = role
    self.relative = relative
    self.extId = extId
    self.quote = quote
  }
}

/// POST /api/relationships: propose a link — always proposed, origin human, never documented (contract shape
/// `RelationshipRequest`).
public struct ProposeRelationshipRequest: Codable, Sendable, Equatable {
  public var src: String
  public var dst: String
  public var relType: String
  public var evidence: [EvidenceSpanRequest]
  public var note: String
  @NullOrAbsent public var group: HypothesisGroupID?
  /// Default 'you'.
  public var author: String?
  public init(src: String, dst: String, relType: String, evidence: [EvidenceSpanRequest], note: String,
              group: HypothesisGroupID? = nil, author: String? = nil) {
    self.src = src
    self.dst = dst
    self.relType = relType
    self.evidence = evidence
    self.note = note
    self.group = group
    self.author = author
  }
}

/// POST /api/relationships/:id/evidence: attach a span (appends a revision).
public struct EvidenceRequest: Codable, Sendable, Equatable {
  public var passage: PassageID?
  public var start: Int?
  public var end: Int?
  public var role: String?
  public var note: String?
  public var relative: Bool?
  public var author: String?
  public var quote: String?
  public var locator: String?
  public init(passage: PassageID? = nil, start: Int? = nil, end: Int? = nil, role: String? = nil, note: String? = nil,
              relative: Bool? = nil, author: String? = nil, quote: String? = nil, locator: String? = nil) {
    self.passage = passage
    self.start = start
    self.end = end
    self.role = role
    self.note = note
    self.relative = relative
    self.author = author
    self.quote = quote
    self.locator = locator
  }
}

/// `{id}` of a created row, with the status the engine forced on it (contract shape `Created`).
public struct CreatedResponse: Codable, Sendable, Equatable {
  public var id: Int
  public var evidenceStatus: String?
  public var origin: String?
  public var relationship: RelationshipID?
  public var revision: Int?
  public init(id: Int, evidenceStatus: String? = nil, origin: String? = nil, relationship: RelationshipID? = nil,
              revision: Int? = nil) {
    self.id = id
    self.evidenceStatus = evidenceStatus
    self.origin = origin
    self.relationship = relationship
    self.revision = revision
  }
}

/// POST /api/relationships/:id/review: confirm, reject or dispute with a note of at least 10 characters (contract
/// shape `ReviewRequest`).
public struct ReviewRequest: Codable, Sendable, Equatable {
  /// 'confirm' | 'reject' | 'dispute'
  public var action: String
  public var note: String
  public var author: String?
  public init(action: String, note: String, author: String? = nil) {
    self.action = action
    self.note = note
    self.author = author
  }
}

/// The review state after a review; the evidence status is unchanged (contract shape `Review`).
public struct ReviewResponse: Codable, Sendable, Equatable {
  public var reviewStatus: String
  public var revision: Int
  public var annotationId: AnnotationID
  public var evidenceStatus: String?
  public init(reviewStatus: String, revision: Int, annotationId: AnnotationID, evidenceStatus: String? = nil) {
    self.reviewStatus = reviewStatus
    self.revision = revision
    self.annotationId = annotationId
    self.evidenceStatus = evidenceStatus
  }
}

// MARK: - hypothesis groups

/// Competing hypotheses for one target, side by side; confirming one never rejects the others (contract shape
/// `HypothesisGroup`).
public struct HypothesisGroupResponse: Codable, Sendable, Equatable {
  public var id: HypothesisGroupID
  public var question: String
  public var target: String
  /// `[{rel_id, dst, label, evidence_status, review_status, author, evidence}]` (verbatim).
  public var hypotheses: JSONValue
  public var synthetic: Bool
  public var createdBy: String?
  /// "⚖ 2 competing"
  public var text: String?
  public init(id: HypothesisGroupID, question: String, target: String, hypotheses: JSONValue, synthetic: Bool,
              createdBy: String? = nil, text: String? = nil) {
    self.id = id
    self.question = question
    self.target = target
    self.hypotheses = hypotheses
    self.synthetic = synthetic
    self.createdBy = createdBy
    self.text = text
  }
}

/// POST /api/hypothesis-groups: open a group on a target with a question (contract shape `HypothesisGroupRequest`).
public struct HypothesisGroupCreateRequest: Codable, Sendable, Equatable {
  public var target: String
  public var question: String
  /// Existing proposals to place in the group.
  public var relationships: [RelationshipID]?
  public var author: String?
  public init(target: String, question: String, relationships: [RelationshipID]? = nil, author: String? = nil) {
    self.target = target
    self.question = question
    self.relationships = relationships
    self.author = author
  }
}

// MARK: - trace

/// POST /api/trace: trace a span (contract shape `TraceRequest`).
public struct TraceRequest: Codable, Sendable, Equatable {
  public var passage: PassageID
  public var start: Int
  public var end: Int
  /// Offsets into the passage text instead of the document text.
  public var relative: Bool?
  public init(passage: PassageID, start: Int, end: Int, relative: Bool? = nil) {
    self.passage = passage
    self.start = start
    self.end = end
    self.relative = relative
  }
}

/// A targeted quotation trace: done inline (≤ 1.5 s) with exact, near and similar-wording matches, or continuing as a
/// job; it creates computed relationships only (contract shape `Trace`).
public struct TraceResponse: Codable, Sendable, Equatable {
  /// 'done' | 'running'
  public var status: String
  /// Matches (verbatim rows).
  public var exact: JSONValue?
  public var near: JSONValue?
  public var similarWording: JSONValue?
  public var createdRelationships: [RelationshipID]?
  public var job: IDRef?
  public var note: String
  @NullOrAbsent public var nearIndex: TraceNearIndex?
  @NullOrAbsent public var exclusion: TraceExclusion?
  /// The traced span (`{passage, start, end, tokens, quote}`), verbatim.
  public var span: JSONValue?
  public var cues: JSONValue?
  public var mockNote: String?
  public init(status: String, note: String) {
    self.status = status
    self.note = note
  }
}

/// The near-quote index a trace used.
public struct TraceNearIndex: Codable, Sendable, Equatable {
  public var run: RunID
  public init(run: RunID) { self.run = run }
}

/// Why a widely shared span lists matches without making links.
public struct TraceExclusion: Codable, Sendable, Equatable {
  /// 'structure' | 'widely_shared' | 'production_line'
  public var kind: String
  public var note: String
  public var documents: Int?
  public init(kind: String, note: String, documents: Int? = nil) {
    self.kind = kind
    self.note = note
    self.documents = documents
  }
}
