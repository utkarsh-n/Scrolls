// OWNER: N0
// Reading the evidence: passages, documents and their text, occurrences, KWIC, exports and snapshots (contract shapes
// `Passage`, `PassageDocument`, `Document`, `DocumentText`, `Occurrence`, `Kwic`, `ExportManifest`, `SnapshotRequest`,
// `Snapshot`).

import Foundation
import ScrollsCore

/// A date as a card or a row shows it.
public struct DateLabel: Codable, Sendable, Equatable {
  public var label: String
  public var precision: String
  public init(label: String, precision: String) {
    self.label = label
    self.precision = precision
  }
}

/// The date card: the chronology date's label, precision, basis and role, with notes in words.
public struct DateCard: Codable, Sendable, Equatable {
  public var label: String
  public var precision: String
  public var basis: String
  @Nullable public var role: String?
  /// Sentences (circa, translation, …), verbatim.
  public var notes: JSONValue
  public init(label: String, precision: String, basis: String, role: String?, notes: JSONValue) {
    self.label = label
    self.precision = precision
    self.basis = basis
    self.role = role
    self.notes = notes
  }
}

// MARK: - passages

/// GET /api/passages/:id options: neighbours, and the expression or occurrence to highlight.
public struct PassageRequest: Codable, Sendable, Equatable {
  public var context: Bool?
  public var expr: ExpressionID?
  public var occ: OccurrenceID?
  public init(context: Bool? = nil, expr: ExpressionID? = nil, occ: OccurrenceID? = nil) {
    self.context = context
    self.expr = expr
    self.occ = occ
  }
}

/// A passage with offsets into the original, highlights (relative to `text`), its document and date card, anchor and
/// machine annotations (contract shape `Passage`).
public struct PassageResponse: Codable, Sendable, Equatable {
  public var id: PassageID
  /// `vocab.PASSAGE_FIELDS`
  public var field: String
  public var start: Int
  public var end: Int
  public var text: String
  /// The neighbouring passages (with `context`), verbatim.
  @NullOrAbsent public var before: JSONValue?
  @NullOrAbsent public var after: JSONValue?
  public var highlights: [Highlight]
  public var lang: String
  public var quality: String
  public var timeRole: String
  public var fieldClass: String?
  @NullOrAbsent public var pageNo: Int?
  public var document: PassageDocument
  public var anchor: PassageLocation
  /// Machine annotations (context-group labels, tags, tone), verbatim.
  public var machine: JSONValue?
  /// Relationship counts by status, verbatim.
  public var relationships: JSONValue?
  public var annotations: Int?
  public var synthetic: Bool
  /// The time the passage refers to (`{label, precision}`), when it differs from its publication.
  public var refersTo: JSONValue?
  /// Re-reading after a later vantage (`{label, vantage_from}`).
  public var reread: JSONValue?
  /// Why a passage that is not 'ok' is excluded from counts.
  public var qualityNote: String?
  /// Why a describing or apparatus passage is excluded from frequency by default.
  public var timeNote: String?
  public var mockNote: String?

  public init(id: PassageID, field: String, start: Int, end: Int, text: String, highlights: [Highlight], lang: String,
              quality: String, timeRole: String, document: PassageDocument, anchor: PassageLocation, synthetic: Bool) {
    self.id = id
    self.field = field
    self.start = start
    self.end = end
    self.text = text
    self.highlights = highlights
    self.lang = lang
    self.quality = quality
    self.timeRole = timeRole
    self.document = document
    self.anchor = anchor
    self.synthetic = synthetic
  }
}

/// A highlighted span of a passage's text (UTF-16 offsets relative to `text`).
public struct Highlight: Codable, Sendable, Equatable {
  public var start: Int
  public var end: Int
  @NullOrAbsent public var expr: ExpressionID?
  @NullOrAbsent public var occ: OccurrenceID?
  @NullOrAbsent public var variant: String?
  /// A name-guard hit: shown, and excluded from counts.
  public var nameFlag: Bool?
  public var note: String?
  public init(start: Int, end: Int, expr: ExpressionID? = nil, occ: OccurrenceID? = nil, variant: String? = nil,
              nameFlag: Bool? = nil, note: String? = nil) {
    self.start = start
    self.end = end
    self.expr = expr
    self.occ = occ
    self.variant = variant
    self.nameFlag = nameFlag
    self.note = note
  }
}

/// The anchor of a passage: its document, the original's sha256, field and offsets.
public struct PassageLocation: Codable, Sendable, Equatable {
  public var docId: DocumentID
  public var sha256: String
  public var field: String
  public var start: Int
  public var end: Int
  public init(docId: DocumentID, sha256: String, field: String, start: Int, end: Int) {
    self.docId = docId
    self.sha256 = sha256
    self.field = field
    self.start = start
    self.end = end
  }
}

/// The document a passage belongs to, with its dates and date card (contract shape `PassageDocument`).
public struct PassageDocument: Codable, Sendable, Equatable {
  public var id: DocumentID
  @Nullable public var title: String?
  @Nullable public var author: String?
  public var kind: String
  public var dates: [DateRow]
  public var dateCard: DateCard
  public var collection: String
  @Nullable public var license: String?
  public var isTranslation: Bool
  public var synthetic: Bool

  public init(id: DocumentID, title: String?, author: String?, kind: String, dates: [DateRow], dateCard: DateCard,
              collection: String, license: String?, isTranslation: Bool, synthetic: Bool) {
    self.id = id
    self.title = title
    self.author = author
    self.kind = kind
    self.dates = dates
    self.dateCard = dateCard
    self.collection = collection
    self.license = license
    self.isTranslation = isTranslation
    self.synthetic = synthetic
  }
}

// MARK: - documents

/// Document metadata: every date assertion, tags with provenance, aliases (contract shape `Document`).
public struct DocumentResponse: Codable, Sendable, Equatable {
  public var id: DocumentID
  public var extId: String
  public var kind: String
  @Nullable public var title: String?
  public var collection: String
  public var hasFullText: Bool
  public var dates: [DateRow]
  public var dateCard: DateCard?
  /// `[{scheme, value, weight, provenance, method, note?}]`, verbatim.
  public var tags: JSONValue
  /// `[{ext_id, title, note}]`, verbatim.
  public var aliases: JSONValue
  public var synthetic: Bool
  @NullOrAbsent public var nativeTitle: String?
  @NullOrAbsent public var author: String?
  public var album: String?
  public var collectionName: String?
  /// Field passages (title, summary, abstract …) with their ids and offsets, verbatim.
  public var fields: JSONValue?
  @NullOrAbsent public var langDeclared: String?
  @NullOrAbsent public var langText: String?
  public var isTranslation: Bool?
  @NullOrAbsent public var dupOf: DocumentID?
  public var passages: Int?
  public var tokens: Int?
  @NullOrAbsent public var community: String?
  @NullOrAbsent public var culture: String?
  @NullOrAbsent public var field: String?
  @NullOrAbsent public var genre: String?
  @NullOrAbsent public var sourceUrl: String?
  @NullOrAbsent public var license: String?
  public var exportTextAllowed: Bool?
  /// UTF-16 length of the original (full-text documents).
  public var length: Int?
  /// `{start, end}` of the body within the original.
  public var body: JSONValue?
  public var sha256: String?
  /// Metadata-only documents say why there is no text.
  public var textNote: String?
  public var deletedAt: String?
  public var mockNote: String?

  public init(id: DocumentID, extId: String, kind: String, title: String?, collection: String, hasFullText: Bool,
              dates: [DateRow], dateCard: DateCard? = nil, tags: JSONValue, aliases: JSONValue, synthetic: Bool) {
    self.id = id
    self.extId = extId
    self.kind = kind
    self.title = title
    self.collection = collection
    self.hasFullText = hasFullText
    self.dates = dates
    self.dateCard = dateCard
    self.tags = tags
    self.aliases = aliases
    self.synthetic = synthetic
  }
}

/// A slice (≤ 20k UTF-16 units) of a document's decoded original (contract shape `DocumentText`).
public struct DocumentTextResponse: Codable, Sendable, Equatable {
  public var documentId: DocumentID
  public var from: Int
  public var to: Int
  public var text: String
  public var length: Int
  public var synthetic: Bool?
  public init(documentId: DocumentID, from: Int, to: Int, text: String, length: Int, synthetic: Bool? = nil) {
    self.documentId = documentId
    self.from = from
    self.to = to
    self.text = text
    self.length = length
    self.synthetic = synthetic
  }
}

/// An occurrence → its passage, document and expression, so a reloaded `sel=occ:N` opens it (contract shape `Occurrence`).
public struct OccurrenceResponse: Codable, Sendable, Equatable {
  public var id: OccurrenceID
  public var passage: PassageID
  public var doc: DocumentID
  public var expr: ExpressionID
  public var start: Int
  public var end: Int
  public var nameFlag: Bool
  public var runId: RunID
  public var synthetic: Bool
  public init(id: OccurrenceID, passage: PassageID, doc: DocumentID, expr: ExpressionID, start: Int, end: Int,
              nameFlag: Bool, runId: RunID, synthetic: Bool) {
    self.id = id
    self.passage = passage
    self.doc = doc
    self.expr = expr
    self.start = start
    self.end = end
    self.nameFlag = nameFlag
    self.runId = runId
    self.synthetic = synthetic
  }
}

// MARK: - KWIC

/// GET /api/kwic query: an expression's concordance (or a registered query's, by `q`), as saved when pinned.
public struct KwicRequest: Codable, Sendable, Equatable {
  public var expr: ExpressionID?
  /// A registered queryKey (instead of `expr`).
  public var q: String?
  public var corpus: String?
  /// Pinned run ids, comma-separated (as saved).
  public var runs: String?
  public var importBatch: ImportBatchID?
  public var at: String?
  public var facet: String?
  public var f: String?
  /// Day numbers.
  public var from: Int?
  public var to: Int?
  public var lane: String?
  /// 'date' (default) or 'spread'.
  public var sort: String?
  public var cursor: String?
  /// Default 50.
  public var limit: Int?

  public init(expr: ExpressionID? = nil, q: String? = nil, corpus: String? = nil, runs: String? = nil,
              importBatch: ImportBatchID? = nil, at: String? = nil, facet: String? = nil, f: String? = nil, from: Int? = nil,
              to: Int? = nil, lane: String? = nil, sort: String? = nil, cursor: String? = nil, limit: Int? = nil) {
    self.expr = expr
    self.q = q
    self.corpus = corpus
    self.runs = runs
    self.importBatch = importBatch
    self.at = at
    self.facet = facet
    self.f = f
    self.from = from
    self.to = to
    self.lane = lane
    self.sort = sort
    self.cursor = cursor
    self.limit = limit
  }
}

/// Concordance rows; each opens its passage (contract shape `Kwic`).
public struct KwicResponse: Codable, Sendable, Equatable {
  public var rows: [KwicRow]
  public var total: Int?
  @NullOrAbsent public var cursor: String?
  /// What the rows were drawn from; null while a large corpus's slice cube is still being built.
  @NullOrAbsent public var denominator: KwicDenominator?
  public init(rows: [KwicRow], total: Int? = nil, cursor: String? = nil, denominator: KwicDenominator? = nil) {
    self.rows = rows
    self.total = total
    self.cursor = cursor
    self.denominator = denominator
  }
}

/// One concordance row: left context, match, right context, with the passage and document it opens.
public struct KwicRow: Codable, Sendable, Equatable {
  public var passage: PassageID
  public var doc: DocumentID
  public var start: Int
  public var end: Int
  public var left: String
  public var match: String
  public var right: String
  public var synthetic: Bool
  @NullOrAbsent public var title: String?
  public var date: DateLabel?
  @NullOrAbsent public var lane: String?
  /// Offsets into the document text.
  public var absStart: Int?
  public var absEnd: Int?
  @NullOrAbsent public var occ: OccurrenceID?
  /// The collection's licence withholds its text from exports (`export_text_allowed = 0`).
  public var textWithheld: Bool?

  public init(passage: PassageID, doc: DocumentID, start: Int, end: Int, left: String, match: String, right: String,
              synthetic: Bool, title: String? = nil, date: DateLabel? = nil, lane: String? = nil, absStart: Int? = nil,
              absEnd: Int? = nil, occ: OccurrenceID? = nil) {
    self.passage = passage
    self.doc = doc
    self.start = start
    self.end = end
    self.left = left
    self.match = match
    self.right = right
    self.synthetic = synthetic
    self.title = title
    self.date = date
    self.lane = lane
    self.absStart = absStart
    self.absEnd = absEnd
    self.occ = occ
  }
}

/// The slice a KWIC page was drawn from.
public struct KwicDenominator: Codable, Sendable, Equatable {
  @NullOrAbsent public var tokens: Int?
  @NullOrAbsent public var works: Int?
  @NullOrAbsent public var docs: Int?
  @NullOrAbsent public var from: Int?
  @NullOrAbsent public var to: Int?
  @NullOrAbsent public var lane: String?
  @NullOrAbsent public var note: String?
  public init(tokens: Int? = nil, works: Int? = nil, docs: Int? = nil, from: Int? = nil, to: Int? = nil, lane: String? = nil,
              note: String? = nil) {
    self.tokens = tokens
    self.works = works
    self.docs = docs
    self.from = from
    self.to = to
    self.lane = lane
    self.note = note
  }
}

// MARK: - exports and snapshots

/// GET /api/export query: a saved view or a state, what to export, the format.
public struct ExportRequest: Codable, Sendable, Equatable {
  public var view: String?
  /// base64url of the UTF-8 view-state hash.
  public var state: String?
  /// 'occurrences' (default) | 'aggregates' | 'passages' | 'relationships' | 'annotations' | 'bundle'
  public var what: String?
  /// 'json' (default) | 'jsonl' | 'csv' (the HTML bundle is later, ΔS-14).
  public var format: String?
  public var tier: String?
  public var snapshot: String?
  public init(view: String? = nil, state: String? = nil, what: String? = nil, format: String? = nil, tier: String? = nil,
              snapshot: String? = nil) {
    self.view = view
    self.state = state
    self.what = what
    self.format = format
    self.tier = tier
    self.snapshot = snapshot
  }
}

/// The manifest that opens every export: JSON top-level key, first JSONL line, CSV '#' block (contract shape
/// `ExportManifest`). Licences and attributions travel with the data.
public struct ExportManifest: Codable, Sendable, Equatable {
  public var exportVersion: String
  public var generatedAt: String
  @Nullable public var view: String?
  @Nullable public var state: String?
  public var dataVersion: Int
  public var runIds: JSONValue
  /// The filter string, or the filter object (verbatim).
  public var filters: JSONValue
  public var toggles: JSONValue
  public var syntheticIncluded: Bool
  public var licenses: [String]
  public var attributions: [String]
  public var warning: String?
  public var relationshipScope: String?

  public init(exportVersion: String, generatedAt: String, view: String?, state: String?, dataVersion: Int, runIds: JSONValue,
              filters: JSONValue, toggles: JSONValue, syntheticIncluded: Bool, licenses: [String], attributions: [String],
              warning: String? = nil, relationshipScope: String? = nil) {
    self.exportVersion = exportVersion
    self.generatedAt = generatedAt
    self.view = view
    self.state = state
    self.dataVersion = dataVersion
    self.runIds = runIds
    self.filters = filters
    self.toggles = toggles
    self.syntheticIncluded = syntheticIncluded
    self.licenses = licenses
    self.attributions = attributions
    self.warning = warning
    self.relationshipScope = relationshipScope
  }
}

/// A JSON export: the manifest, then the rows (verbatim; their columns depend on `what`).
public struct ExportDocument: Codable, Sendable, Equatable {
  public var manifest: ExportManifest
  public var rows: JSONValue
  public init(manifest: ExportManifest, rows: JSONValue) {
    self.manifest = manifest
    self.rows = rows
  }
}

/// An export file: its bytes and how to save them.
public struct ExportResponse: Sendable, Equatable {
  public var contentType: String
  public var fileName: String?
  /// Rows written (the reference's X-Scrolls-Rows).
  public var rows: Int?
  public var data: Data
  public init(contentType: String, fileName: String? = nil, rows: Int? = nil, data: Data) {
    self.contentType = contentType
    self.fileName = fileName
    self.rows = rows
    self.data = data
  }
}

/// POST /api/snapshots: store a PNG or SVG of a view (contract shape `SnapshotRequest`).
public struct SnapshotCreateRequest: Codable, Sendable, Equatable {
  @NullOrAbsent public var view: String?
  /// A PNG data URL.
  public var png: String?
  /// An SVG document.
  public var svg: String?
  /// A synthetic view's SVG must carry the SYNTHETIC stamp.
  public var synthetic: Bool?
  public init(view: String? = nil, png: String? = nil, svg: String? = nil, synthetic: Bool? = nil) {
    self.view = view
    self.png = png
    self.svg = svg
    self.synthetic = synthetic
  }
}

/// The stored snapshot (contract shape `Snapshot`).
public struct SnapshotCreateResponse: Codable, Sendable, Equatable {
  public var file: String
  public var url: String?
  public init(file: String, url: String? = nil) {
    self.file = file
    self.url = url
  }
}

/// GET /api/snapshots/:file: the stored image.
public struct SnapshotResponse: Sendable, Equatable {
  public var contentType: String
  public var data: Data
  public init(contentType: String, data: Data) {
    self.contentType = contentType
    self.data = data
  }
}
