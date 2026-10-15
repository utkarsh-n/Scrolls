// OWNER: N0
// The journal's operations and the stable keys they use (IOS-SPEC §6.2–§6.4; frozen at the N0 merge). An op names its
// rows by keys that survive any generation — natural keys and D18 anchors, never row ids — so replaying the journal
// into a rebuilt atlas finds the same rows. Ops travel in the contract's JSON shape (ScrollsJSON, snake_case): where
// the spec names a contract request type the op holds it; otherwise the request body is kept verbatim as JSONValue
// next to the portable keys that replace its row ids.
//
// The wire form is the synthesized enum coding with named payload keys, e.g.
//   {"track_expression":{"expr":{…},"request":{…}}}  ·  {"view_delete":{"slug":"carry-the-zero-3f9a"}}

import Foundation
import ScrollsContracts
import ScrollsCore

/// A document across generations: `collection slug : ext_id` (UNIQUE in the DDL).
public struct DocKey: Codable, Sendable, Hashable {
  public var collection: String
  public var extId: String
  public init(collection: String, extId: String) {
    self.collection = collection
    self.extId = extId
  }
}

/// The D18 anchor of a span: it survives re-segmentation (`anchors.mjs`).
public struct PassageAnchor: Codable, Sendable, Hashable {
  public var doc: DocKey
  public var originalSha256: String
  public var field: String
  public var start: Int
  public var end: Int
  public var quote: String
  public var prefix: String
  public var suffix: String
  public init(doc: DocKey, originalSha256: String, field: String, start: Int, end: Int, quote: String, prefix: String,
              suffix: String) {
    self.doc = doc
    self.originalSha256 = originalSha256
    self.field = field
    self.start = start
    self.end = end
    self.quote = quote
    self.prefix = prefix
    self.suffix = suffix
  }
}

/// An import batch: (collection slug, file or pack sha256, adapter id, ordinal among batches with the same triple).
public struct BatchKey: Codable, Sendable, Hashable {
  public var collection: String?
  public var fileSha256: String?
  public var adapterId: String
  public var ordinal: Int
  public init(collection: String?, fileSha256: String?, adapterId: String, ordinal: Int) {
    self.collection = collection
    self.fileSha256 = fileSha256
    self.adapterId = adapterId
    self.ordinal = ordinal
  }
}

/// A run: the reference's reuse rule (stage, params_hash, input_fingerprint) plus the code hash.
public struct RunKey: Codable, Sendable, Hashable {
  public var stage: Stage
  public var paramsHash: String
  public var inputFingerprint: String
  public var codeHash: String
  public init(stage: Stage, paramsHash: String, inputFingerprint: String, codeHash: String) {
    self.stage = stage
    self.paramsHash = paramsHash
    self.inputFingerprint = inputFingerprint
    self.codeHash = codeHash
  }
}

/// An expression: (kind, lang, norm, corpus slug) — the `expr_key` index.
public struct ExprKey: Codable, Sendable, Hashable {
  public var kind: String
  public var lang: String?
  public var norm: String
  public var corpus: String?
  public init(kind: String, lang: String?, norm: String, corpus: String?) {
    self.kind = kind
    self.lang = lang
    self.norm = norm
    self.corpus = corpus
  }
}

/// An annotation: the `seq` of its `annotationCreate`.
public struct AnnotationKey: Codable, Sendable, Hashable {
  public var seq: UInt64
  public init(seq: UInt64) { self.seq = seq }
}

/// A hypothesis group: the `seq` of its `hypothesisGroupCreate`.
public struct HypothesisGroupKey: Codable, Sendable, Hashable {
  public var seq: UInt64
  public init(seq: UInt64) { self.seq = seq }
}

/// A sense cluster: its run and its ordinal.
public struct ClusterKey: Codable, Sendable, Hashable {
  public var run: RunKey
  public var ordinal: Int
  public init(run: RunKey, ordinal: Int) {
    self.run = run
    self.ordinal = ordinal
  }
}

/// A relationship endpoint by stable key (`rel_endpoint_types`).
public enum EndpointKey: Codable, Sendable, Hashable {
  case document(key: DocKey)
  case passage(anchor: PassageAnchor)
  case occurrence(expr: ExprKey, anchor: PassageAnchor)
  case expression(key: ExprKey)
  case etymon(key: String)
  case cluster(key: ClusterKey)
}

/// A relationship across generations.
public enum RelKey: Codable, Sendable, Hashable {
  /// Documented: sha256 of the canonical JSON of (rel_type, src key, dst key, source_dataset, source_locator).
  case documented(hash: String)
  /// Computed by a run: the run and both endpoints.
  case computed(run: RunKey, src: EndpointKey, dst: EndpointKey)
  /// Proposed by him: the `seq` of its `relationshipPropose`.
  case human(seq: UInt64)
}

/// What an annotation is about (`annotation_targets`).
public enum AnnotationTarget: Codable, Sendable, Hashable {
  case endpoint(key: EndpointKey)
  case relationship(key: RelKey)
  case hypothesisGroup(key: HypothesisGroupKey)
  case savedView(slug: String)
  case timeWindow(run: RunKey, label: String)
  case annotation(key: AnnotationKey)
}

/// A source load: which pack (by sha256), which adapter, which phase, which slot. Auto ops have actor "scrolls".
public struct SourceLoadOp: Codable, Sendable, Equatable {
  public var pack: String
  public var packSha256: String
  public var adapterId: String
  public var adapterVersion: String
  public var phase: String?
  public var params: JSONValue
  public var slot: SourceSlot
  public init(pack: String, packSha256: String, adapterId: String, adapterVersion: String, phase: String?, params: JSONValue,
              slot: SourceSlot) {
    self.pack = pack
    self.packSha256 = packSha256
    self.adapterId = adapterId
    self.adapterVersion = adapterVersion
    self.phase = phase
    self.params = params
    self.slot = slot
  }
}

/// A committed file import: the original (sha256 and its Notebook/originals path) and how it was mapped.
public struct ImportCommitOp: Codable, Sendable, Equatable {
  public var originalSha256: String
  public var originalPath: String
  public var fileName: String?
  public var format: String
  public var mapping: JSONValue
  public var options: JSONValue
  /// The collection spec (slug, name, unit, …) the import created or used.
  public var collection: JSONValue
  public init(originalSha256: String, originalPath: String, fileName: String?, format: String, mapping: JSONValue,
              options: JSONValue, collection: JSONValue) {
    self.originalSha256 = originalSha256
    self.originalPath = originalPath
    self.fileName = fileName
    self.format = format
    self.mapping = mapping
    self.options = options
    self.collection = collection
  }
}

/// A new annotation: its target by stable key, and the request body as he sent it.
public struct AnnotationCreateOp: Codable, Sendable, Equatable {
  public var target: AnnotationTarget
  public var request: JSONValue
  public init(target: AnnotationTarget, request: JSONValue) {
    self.target = target
    self.request = request
  }
}

/// A proposed relationship (origin human ⇒ proposed, by trigger): endpoints, evidence spans and group by stable key.
public struct RelationshipProposeOp: Codable, Sendable, Equatable {
  public var src: EndpointKey
  public var dst: EndpointKey
  public var group: HypothesisGroupKey?
  public var evidence: [PassageAnchor]
  public var request: JSONValue
  public init(src: EndpointKey, dst: EndpointKey, group: HypothesisGroupKey?, evidence: [PassageAnchor], request: JSONValue) {
    self.src = src
    self.dst = dst
    self.group = group
    self.evidence = evidence
    self.request = request
  }
}

/// A new hypothesis group about `target`.
public struct HypothesisGroupCreateOp: Codable, Sendable, Equatable {
  public var target: EndpointKey
  public var request: JSONValue
  public init(target: EndpointKey, request: JSONValue) {
    self.target = target
    self.request = request
  }
}

/// A user-defined interpretation dimension (`dimension_def`).
public struct DimensionDefOp: Codable, Sendable, Equatable {
  public var key: String
  public var label: String
  public var type: String
  public var options: JSONValue?
  public init(key: String, label: String, type: String, options: JSONValue?) {
    self.key = key
    self.label = label
    self.type = type
    self.options = options
  }
}

/// What a saved view's selection points at, by stable key.
public enum PortableSelection: Codable, Sendable, Equatable {
  case occurrence(expr: ExprKey, anchor: PassageAnchor)
  case cluster(key: ClusterKey)
  case passage(anchor: PassageAnchor)
  case document(key: DocKey)
  case relationship(key: RelKey)
}

/// The portable cutoffs of a saved view (IOS-SPEC §6.4): what "as saved" means in any generation.
public struct PortableCutoffs: Codable, Sendable, Equatable {
  public var generation: String  // meta.generation at save
  public var journalSeq: UInt64  // this viewSave op's own seq; "before the view" = seq < journalSeq
  public var runKeys: [String: RunKey]  // each run id in run_ids_json → its RunKey
  public var strands: [String: ExprKey]  // "e12" → ExprKey
  public var selection: PortableSelection?
  public var packs: [String]  // sha256 of every pack installed before the save (a cross-check)
  public init(generation: String, journalSeq: UInt64, runKeys: [String: RunKey], strands: [String: ExprKey],
              selection: PortableSelection?, packs: [String]) {
    self.generation = generation
    self.journalSeq = journalSeq
    self.runKeys = runKeys
    self.strands = strands
    self.selection = selection
    self.packs = packs
  }
}

/// Every operation that creates `import_batch`, `relationship_revision` or `annotation_revision` rows, or that he
/// started (§6.2; the set is frozen by JournalPolicyTests).
public enum JournalOp: Codable, Sendable, Equatable {
  case sourceLoad(SourceLoadOp)
  case adapterEnable(adapter: String, enabled: Bool)
  case importCommit(ImportCommitOp)
  case importRevert(BatchKey)
  case trackExpression(ExprKey, TrackExpressionRequest)
  case setVariants(ExprKey, VariantsPatchRequest)
  case annotationCreate(AnnotationCreateOp)
  case annotationRevise(AnnotationKey, AnnotationPatchRequest)
  case annotationReinterpret(AnnotationKey, AnnotationCreateOp)
  case annotationWithdraw(AnnotationKey, reason: String)
  case relationshipPropose(RelationshipProposeOp)
  case relationshipReview(RelKey, ReviewRequest)
  case relationshipEvidence(RelKey, EvidenceRequest)
  case hypothesisGroupCreate(HypothesisGroupCreateOp)
  case dimensionDefine(DimensionDefOp)
  case clusterLabel(ClusterKey, label: String)
  case runCommit(RunKey, stage: Stage, params: JSONValue)
  case viewSave(SaveViewRequest, portable: PortableCutoffs)
  case viewDelete(slug: String)

  // named payload keys (camelCase, so they survive ScrollsJSON's snake_case round trip)
  enum SourceLoadCodingKeys: String, CodingKey { case _0 = "load" }
  enum ImportCommitCodingKeys: String, CodingKey { case _0 = "commit" }
  enum ImportRevertCodingKeys: String, CodingKey { case _0 = "batch" }
  enum TrackExpressionCodingKeys: String, CodingKey { case _0 = "expr", _1 = "request" }
  enum SetVariantsCodingKeys: String, CodingKey { case _0 = "expr", _1 = "patch" }
  enum AnnotationCreateCodingKeys: String, CodingKey { case _0 = "create" }
  enum AnnotationReviseCodingKeys: String, CodingKey { case _0 = "annotation", _1 = "patch" }
  enum AnnotationReinterpretCodingKeys: String, CodingKey { case _0 = "annotation", _1 = "create" }
  enum AnnotationWithdrawCodingKeys: String, CodingKey { case _0 = "annotation", reason }
  enum RelationshipProposeCodingKeys: String, CodingKey { case _0 = "propose" }
  enum RelationshipReviewCodingKeys: String, CodingKey { case _0 = "relationship", _1 = "review" }
  enum RelationshipEvidenceCodingKeys: String, CodingKey { case _0 = "relationship", _1 = "evidence" }
  enum HypothesisGroupCreateCodingKeys: String, CodingKey { case _0 = "create" }
  enum DimensionDefineCodingKeys: String, CodingKey { case _0 = "dimension" }
  enum ClusterLabelCodingKeys: String, CodingKey { case _0 = "cluster", label }
  enum RunCommitCodingKeys: String, CodingKey { case _0 = "run", stage, params }
  enum ViewSaveCodingKeys: String, CodingKey { case _0 = "request", portable }

  /// The case name: `journal_applied.op`.
  public var name: String {
    switch self {
    case .sourceLoad: "sourceLoad"
    case .adapterEnable: "adapterEnable"
    case .importCommit: "importCommit"
    case .importRevert: "importRevert"
    case .trackExpression: "trackExpression"
    case .setVariants: "setVariants"
    case .annotationCreate: "annotationCreate"
    case .annotationRevise: "annotationRevise"
    case .annotationReinterpret: "annotationReinterpret"
    case .annotationWithdraw: "annotationWithdraw"
    case .relationshipPropose: "relationshipPropose"
    case .relationshipReview: "relationshipReview"
    case .relationshipEvidence: "relationshipEvidence"
    case .hypothesisGroupCreate: "hypothesisGroupCreate"
    case .dimensionDefine: "dimensionDefine"
    case .clusterLabel: "clusterLabel"
    case .runCommit: "runCommit"
    case .viewSave: "viewSave"
    case .viewDelete: "viewDelete"
    }
  }
}
