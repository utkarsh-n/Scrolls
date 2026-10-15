// OWNER: N0
// Annotations and saved views (contract shapes `Annotation`, `Annotations`, `AnnotationRequest`, `AnnotationPatch`,
// `AnnotationRev`, `AnnotationReinterpreted`, `AnnotationRevisions`, `ViewRequest`, `ViewSaved`, `View`, `Views`).
// Edits append revisions; nothing is updated or deleted (D18); a saved view never changes under its reader (D17).

import ScrollsCore

// MARK: - annotations

/// What an annotation is about: `{type, ref}` (`vocab.ANNOTATION_TARGETS`).
public struct AnnotationTargetRef: Codable, Sendable, Hashable {
  public var type: String
  public var ref: String
  public init(type: String, ref: String) {
    self.type = type
    self.ref = ref
  }
}

/// GET /api/annotations query: a target's annotations, with layers, facets and an as-of bound.
public struct AnnotationsRequest: Codable, Sendable, Equatable {
  /// 'passage:901'
  public var target: String?
  /// 'superseded', 'withdrawn' or 'all', comma-separated.
  public var include: String?
  /// What existed at that time, with the text of then.
  public var asOf: String?
  /// A saved view's annotation revision cutoff.
  public var revCutoff: Int?
  public var kind: String?
  public var author: String?
  public var layer: String?
  public var tag: String?
  /// `key` or `key:value`.
  public var dimension: String?
  public var contradicted: Bool?
  public var from: String?
  public var to: String?
  /// '0' | '1' | 'only'
  public var machine: String?
  public var doc: DocumentID?
  public var q: String?
  public var cursor: String?
  public var limit: Int?
  public init(target: String? = nil, include: String? = nil, asOf: String? = nil, revCutoff: Int? = nil, kind: String? = nil,
              author: String? = nil, layer: String? = nil, tag: String? = nil, dimension: String? = nil,
              contradicted: Bool? = nil, from: String? = nil, to: String? = nil, machine: String? = nil,
              doc: DocumentID? = nil, q: String? = nil, cursor: String? = nil, limit: Int? = nil) {
    self.target = target
    self.include = include
    self.asOf = asOf
    self.revCutoff = revCutoff
    self.kind = kind
    self.author = author
    self.layer = layer
    self.tag = tag
    self.dimension = dimension
    self.contradicted = contradicted
    self.from = from
    self.to = to
    self.machine = machine
    self.doc = doc
    self.q = q
    self.cursor = cursor
    self.limit = limit
  }
}

/// A page of annotations (contract shape `Annotations`).
public struct AnnotationsResponse: Codable, Sendable, Equatable {
  public var items: [Annotation]
  @NullOrAbsent public var cursor: String?
  public init(items: [Annotation], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}

/// An annotation as its current (or as-of) revision shows it (contract shape `Annotation`). Machine annotations are
/// labelled, fallible and cannot be edited.
public struct Annotation: Codable, Sendable, Equatable {
  public var id: AnnotationID
  public var target: AnnotationTargetRef
  /// `vocab.ANNOTATION_KINDS`
  public var kind: String
  public var author: String
  public var isMachine: Bool
  @NullOrAbsent public var method: String?
  /// 'active' | 'superseded' | 'withdrawn'
  public var status: String
  public var rev: Int
  public var bodyMd: String
  @NullOrAbsent public var layer: String?
  @NullOrAbsent public var supersedes: AnnotationID?
  @NullOrAbsent public var anchor: Anchor?
  public var dimensions: JSONValue?
  public var tags: [String]?
  public var createdAt: String
  public var synthetic: Bool
  /// A hypothesis's label.
  public var label: String?
  @NullOrAbsent public var supersededBy: AnnotationID?
  @NullOrAbsent public var runId: RunID?
  public var revisions: Int?
  @NullOrAbsent public var stance: String?
  public var evidenceRefs: JSONValue?
  public var revAt: String?
  @NullOrAbsent public var reason: String?
  @NullOrAbsent public var supersededAt: String?
  @NullOrAbsent public var withdrawnAt: String?
  public var contradicted: Bool?
  public var fallible: Bool?

  public init(id: AnnotationID, target: AnnotationTargetRef, kind: String, author: String, isMachine: Bool, status: String,
              rev: Int, bodyMd: String, createdAt: String, synthetic: Bool) {
    self.id = id
    self.target = target
    self.kind = kind
    self.author = author
    self.isMachine = isMachine
    self.status = status
    self.rev = rev
    self.bodyMd = bodyMd
    self.createdAt = createdAt
    self.synthetic = synthetic
  }
}

/// POST /api/annotations (and …/reinterpret): a new annotation; passage and occurrence targets need an anchor
/// (contract shape `AnnotationRequest`).
public struct AnnotationCreateRequest: Codable, Sendable, Equatable {
  public var target: AnnotationTargetRef
  public var anchor: Anchor?
  public var kind: String
  public var bodyMd: String
  public var dimensions: JSONValue?
  public var tags: [String]?
  /// `[{type, id, start, end, role}]` (verbatim).
  public var evidenceRefs: JSONValue?
  @NullOrAbsent public var layer: String?
  @NullOrAbsent public var stance: String?
  /// Default 'you'.
  public var author: String?

  public init(target: AnnotationTargetRef, anchor: Anchor? = nil, kind: String, bodyMd: String, dimensions: JSONValue? = nil,
              tags: [String]? = nil, evidenceRefs: JSONValue? = nil, layer: String? = nil, stance: String? = nil,
              author: String? = nil) {
    self.target = target
    self.anchor = anchor
    self.kind = kind
    self.bodyMd = bodyMd
    self.dimensions = dimensions
    self.tags = tags
    self.evidenceRefs = evidenceRefs
    self.layer = layer
    self.stance = stance
    self.author = author
  }
}

/// PATCH /api/annotations/:id: an edit is a new revision (contract shape `AnnotationPatch`).
public struct AnnotationPatchRequest: Codable, Sendable, Equatable {
  public var bodyMd: String
  @NullOrAbsent public var reason: String?
  public var dimensions: JSONValue?
  public var tags: [String]?
  public var author: String?
  public init(bodyMd: String, reason: String? = nil, dimensions: JSONValue? = nil, tags: [String]? = nil, author: String? = nil) {
    self.bodyMd = bodyMd
    self.reason = reason
    self.dimensions = dimensions
    self.tags = tags
    self.author = author
  }
}

/// POST /api/annotations/:id/withdraw: appends a withdrawing revision; nothing is deleted.
public struct WithdrawRequest: Codable, Sendable, Equatable {
  public var reason: String?
  public var author: String?
  public init(reason: String? = nil, author: String? = nil) {
    self.reason = reason
    self.author = author
  }
}

/// The annotation and its new revision (contract shape `AnnotationRev`).
public struct AnnotationRevResponse: Codable, Sendable, Equatable {
  public var id: AnnotationID
  public var rev: Int
  /// 'withdrawn' after a withdrawal.
  public var status: String?
  public init(id: AnnotationID, rev: Int, status: String? = nil) {
    self.id = id
    self.rev = rev
    self.status = status
  }
}

/// The new annotation and the one it supersedes, which stays as a visible layer (contract shape
/// `AnnotationReinterpreted`).
public struct AnnotationReinterpretedResponse: Codable, Sendable, Equatable {
  public var id: AnnotationID
  public var supersedes: AnnotationID
  public init(id: AnnotationID, supersedes: AnnotationID) {
    self.id = id
    self.supersedes = supersedes
  }
}

/// One revision of an annotation (append-only).
public struct AnnotationRevision: Codable, Sendable, Equatable {
  public var rev: Int
  public var bodyMd: String
  public var dimensions: JSONValue
  public var tags: [String]
  public var author: String
  public var at: String
  @Nullable public var reason: String?
  @NullOrAbsent public var stance: String?
  public var evidenceRefs: JSONValue?
  public init(rev: Int, bodyMd: String, dimensions: JSONValue, tags: [String], author: String, at: String, reason: String?) {
    self.rev = rev
    self.bodyMd = bodyMd
    self.dimensions = dimensions
    self.tags = tags
    self.author = author
    self.at = at
    self.reason = reason
  }
}

/// Every revision of an annotation (contract shape `AnnotationRevisions`).
public typealias AnnotationRevisionsResponse = [AnnotationRevision]

// MARK: - saved views

/// POST /api/views: save an immutable view (contract shape `ViewRequest`).
public struct SaveViewRequest: Codable, Sendable, Equatable {
  public var name: String
  /// The view state object (SPEC §8.2), verbatim.
  public var state: JSONValue
  public var comparisonsTried: Int?
  @NullOrAbsent public var description: String?
  /// Re-saving a view makes `slug~2`.
  public var parentSlug: String?
  public var author: String?
  public init(name: String, state: JSONValue, comparisonsTried: Int? = nil, description: String? = nil,
              parentSlug: String? = nil, author: String? = nil) {
    self.name = name
    self.state = state
    self.comparisonsTried = comparisonsTried
    self.description = description
    self.parentSlug = parentSlug
    self.author = author
  }
}

/// The saved view's slug, link, data version and pinned runs (contract shape `ViewSaved`).
public struct ViewSavedResponse: Codable, Sendable, Equatable {
  public var slug: String
  public var url: String
  public var dataVersion: Int
  public var runIds: JSONValue
  /// The canonical view-state hash.
  public var hash: String?
  @NullOrAbsent public var parentSlug: String?
  public var savedAt: String?
  public var stateHash: String?
  public var cutoffs: JSONValue?
  public var counts: JSONValue?
  public var warnings: JSONValue?
  public var synthetic: Bool?
  public init(slug: String, url: String, dataVersion: Int, runIds: JSONValue, hash: String? = nil, parentSlug: String? = nil) {
    self.slug = slug
    self.url = url
    self.dataVersion = dataVersion
    self.runIds = runIds
    self.hash = hash
    self.parentSlug = parentSlug
  }

  enum CodingKeys: String, WireNamedKeys {
    case slug, url, dataVersion, runIds, hash, parentSlug, savedAt, stateHash, cutoffs, counts, warnings, synthetic
    static let wireNames = ["dataVersion": "dataVersion", "runIds": "runIds", "savedAt": "savedAt"]
  }
}

/// A saved view as saved, with what changed since (contract shape `View`).
public struct SavedViewResponse: Codable, Sendable, Equatable {
  public var slug: String
  /// The view state object (SPEC §8.2), verbatim.
  public var state: JSONValue
  public var savedAt: String
  public var dataVersion: Int
  public var currentDataVersion: Int
  public var drift: ViewDrift
  public var name: String?
  @NullOrAbsent public var description: String?
  @NullOrAbsent public var parentSlug: String?
  public var stateHash: String?
  public var hash: String?
  public var url: String?
  public var savedBy: String?
  public var runIds: JSONValue?
  /// `{import_batch, annotation_rev, relationship_rev}` (verbatim).
  public var cutoffs: JSONValue?
  public var comparisonsTried: Int?
  public var asSaved: Bool?
  /// `{asSaved, current}` counts (verbatim).
  public var counts: JSONValue?
  public var synthetic: Bool?

  public init(slug: String, state: JSONValue, savedAt: String, dataVersion: Int, currentDataVersion: Int, drift: ViewDrift,
              name: String? = nil) {
    self.slug = slug
    self.state = state
    self.savedAt = savedAt
    self.dataVersion = dataVersion
    self.currentDataVersion = currentDataVersion
    self.drift = drift
    self.name = name
  }

  enum CodingKeys: String, WireNamedKeys {
    case slug, state, savedAt, dataVersion, currentDataVersion, drift, name, description, parentSlug, stateHash, hash, url
    case savedBy, runIds, cutoffs, comparisonsTried, asSaved, counts, synthetic
    static let wireNames = ["savedAt": "savedAt", "dataVersion": "dataVersion", "currentDataVersion": "currentDataVersion",
                            "savedBy": "savedBy", "runIds": "runIds", "asSaved": "asSaved"]
  }
}

/// What changed since a view was saved, and whether it can still be opened as saved.
public struct ViewDrift: Codable, Sendable, Equatable {
  public var dataChanged: Bool
  public var importsSince: JSONValue
  public var revertedSince: JSONValue?
  public var asSavedAvailable: Bool
  public var newerRuns: JSONValue
  @Nullable public var message: String?
  public var annotationsSince: Int?
  public var relationshipRevisionsSince: Int?

  public init(dataChanged: Bool, importsSince: JSONValue, revertedSince: JSONValue? = nil, asSavedAvailable: Bool,
              newerRuns: JSONValue, message: String?) {
    self.dataChanged = dataChanged
    self.importsSince = importsSince
    self.revertedSince = revertedSince
    self.asSavedAvailable = asSavedAvailable
    self.newerRuns = newerRuns
    self.message = message
  }

  enum CodingKeys: String, WireNamedKeys {
    case dataChanged, importsSince, revertedSince, asSavedAvailable, newerRuns, message, annotationsSince
    case relationshipRevisionsSince
    static let wireNames = ["dataChanged": "dataChanged", "importsSince": "importsSince", "revertedSince": "revertedSince",
                            "asSavedAvailable": "asSavedAvailable", "newerRuns": "newerRuns",
                            "annotationsSince": "annotationsSince", "relationshipRevisionsSince": "relationshipRevisionsSince"]
  }
}

/// GET /api/views query.
public struct ViewsRequest: Codable, Sendable, Equatable {
  public var q: String?
  public var cursor: String?
  public var limit: Int?
  public init(q: String? = nil, cursor: String? = nil, limit: Int? = nil) {
    self.q = q
    self.cursor = cursor
    self.limit = limit
  }
}

/// Saved views, newest first (contract shape `Views`).
public struct ViewsResponse: Codable, Sendable, Equatable {
  public var items: [ViewSummary]
  @NullOrAbsent public var cursor: String?
  public init(items: [ViewSummary], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}

/// One saved view in the list.
public struct ViewSummary: Codable, Sendable, Equatable {
  public var slug: String
  public var name: String
  public var savedAt: String
  public var dataVersion: Int
  @NullOrAbsent public var description: String?
  @NullOrAbsent public var parentSlug: String?
  @NullOrAbsent public var corpus: String?
  public var synthetic: Bool?
  public init(slug: String, name: String, savedAt: String, dataVersion: Int, description: String? = nil,
              parentSlug: String? = nil, corpus: String? = nil, synthetic: Bool? = nil) {
    self.slug = slug
    self.name = name
    self.savedAt = savedAt
    self.dataVersion = dataVersion
    self.description = description
    self.parentSlug = parentSlug
    self.corpus = corpus
    self.synthetic = synthetic
  }

  enum CodingKeys: String, WireNamedKeys {
    case slug, name, savedAt, dataVersion, description, parentSlug, corpus, synthetic
    static let wireNames = ["savedAt": "savedAt", "dataVersion": "dataVersion"]
  }
}

/// DELETE /api/views/:slug: the view is soft-deleted (its links stop resolving; the row stays). 204, no body.
public struct DeleteViewResponse: Sendable, Equatable {
  public init() {}
}
