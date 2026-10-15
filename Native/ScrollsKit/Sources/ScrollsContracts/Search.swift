// OWNER: N0
// Search and tracked expressions (contract shapes `Search`, `ExpressionRequest`, `Expression`, `VariantsPatch`).

import ScrollsCore

/// GET /api/search query.
public struct SearchRequest: Codable, Sendable, Equatable {
  public var q: String
  /// A corpus slug (default 'demo'), or the virtual 'real'.
  public var corpus: String?
  /// 'all' (default) or one suggestion type.
  public var scope: String?
  /// The filter grammar (`lang:en,fr;kind:book;…`).
  public var f: String?
  /// 1–200 (default 20).
  public var limit: Int?
  /// Forces the query language.
  public var lang: String?

  public init(q: String, corpus: String? = nil, scope: String? = nil, f: String? = nil, limit: Int? = nil,
              lang: String? = nil) {
    self.q = q
    self.corpus = corpus
    self.scope = scope
    self.f = f
    self.limit = limit
    self.lang = lang
  }
}

/// Typed suggestions, a KWIC sample and titles; an empty result is computed, with the variants tried (contract shape
/// `Search`).
public struct SearchResponse: Codable, Sendable, Equatable {
  public var query: SearchQuery
  public var suggestions: [SearchSuggestion]
  @Nullable public var expression: SearchExpression?
  public var hits: SearchHits
  public var kwic: [KwicRow]
  public var titles: [SearchTitle]
  @Nullable public var emptyNote: String?
  public var provenance: Provenance

  public init(query: SearchQuery, suggestions: [SearchSuggestion], expression: SearchExpression?, hits: SearchHits,
              kwic: [KwicRow], titles: [SearchTitle], emptyNote: String?, provenance: Provenance) {
    self.query = query
    self.suggestions = suggestions
    self.expression = expression
    self.hits = hits
    self.kwic = kwic
    self.titles = titles
    self.emptyNote = emptyNote
    self.provenance = provenance
  }
}

/// The query as read: surface, folded norm, tokens, kind and the variants tried.
public struct SearchQuery: Codable, Sendable, Equatable {
  public var surface: String
  public var norm: String
  public var tokens: [String]
  public var kind: String
  public var variants: [SearchVariant]
  public var lang: String?

  public init(surface: String, norm: String, tokens: [String], kind: String, variants: [SearchVariant], lang: String? = nil) {
    self.surface = surface
    self.norm = norm
    self.tokens = tokens
    self.kind = kind
    self.variants = variants
    self.lang = lang
  }
}

/// A variant form the search tried.
public struct SearchVariant: Codable, Sendable, Equatable {
  public var form: String
  public var type: String
  @NullOrAbsent public var rule: String?
  public var status: String
  public var enabled: Bool?
  /// Matches under this form, once counted.
  public var n: Int?
  public init(form: String, type: String, rule: String? = nil, status: String, enabled: Bool? = nil, n: Int? = nil) {
    self.form = form
    self.type = type
    self.rule = rule
    self.status = status
    self.enabled = enabled
    self.n = n
  }
}

/// A typed suggestion (expression · work · maker · theme · annotation) with its ref and count.
public struct SearchSuggestion: Codable, Sendable, Equatable {
  public var type: String
  public var label: String
  public var ref: String
  @Nullable public var count: Int?
  /// True while the expression's count is still being made.
  public var preliminary: Bool?
  /// A maker suggestion's name.
  public var name: String?
  /// A title found by trigram typeahead (suggested, never counted).
  public var typeahead: Bool?
  /// A theme's tag provenances.
  public var provenance: [String]?
  public init(type: String, label: String, ref: String, count: Int?, preliminary: Bool? = nil, name: String? = nil,
              typeahead: Bool? = nil, provenance: [String]? = nil) {
    self.type = type
    self.label = label
    self.ref = ref
    self.count = count
    self.preliminary = preliminary
    self.name = name
    self.typeahead = typeahead
    self.provenance = provenance
  }
}

/// The tracked expression a search matched, with its counting state.
public struct SearchExpression: Codable, Sendable, Equatable {
  public var id: ExpressionID
  public var surface: String
  public var norm: String
  public var kind: String
  @Nullable public var lang: String?
  public var state: String
  @NullOrAbsent public var n: Int?
  @NullOrAbsent public var job: Int?
  public var synthetic: Bool
  public var corpus: String?
  public var claims: [ClaimMarker]?

  public init(id: ExpressionID, surface: String, norm: String, kind: String, lang: String?, state: String, n: Int? = nil,
              job: Int? = nil, synthetic: Bool, corpus: String? = nil, claims: [ClaimMarker]? = nil) {
    self.id = id
    self.surface = surface
    self.norm = norm
    self.kind = kind
    self.lang = lang
    self.state = state
    self.n = n
    self.job = job
    self.synthetic = synthetic
    self.corpus = corpus
    self.claims = claims
  }
}

/// Passages, documents, undated and name-guard hits; `preliminary` while counting runs.
public struct SearchHits: Codable, Sendable, Equatable {
  public var passages: Int
  public var documents: Int
  public var undated: Int
  public var namesExcluded: Int
  public var preliminary: Bool
  public var contextsSampled: Bool?

  public init(passages: Int, documents: Int, undated: Int, namesExcluded: Int, preliminary: Bool,
              contextsSampled: Bool? = nil) {
    self.passages = passages
    self.documents = documents
    self.undated = undated
    self.namesExcluded = namesExcluded
    self.preliminary = preliminary
    self.contextsSampled = contextsSampled
  }
}

/// A title that matched.
public struct SearchTitle: Codable, Sendable, Equatable {
  public var documentId: DocumentID
  public var title: String
  public var kind: String
  @Nullable public var year: Int?
  public var synthetic: Bool
  public init(documentId: DocumentID, title: String, kind: String, year: Int?, synthetic: Bool) {
    self.documentId = documentId
    self.title = title
    self.kind = kind
    self.year = year
    self.synthetic = synthetic
  }
}

/// POST /api/expressions: track an expression (contract shape `ExpressionRequest`).
public struct TrackExpressionRequest: Codable, Sendable, Equatable {
  public var surface: String
  @NullOrAbsent public var lang: String?
  @NullOrAbsent public var kind: String?
  @NullOrAbsent public var corpus: String?

  public init(surface: String, lang: String? = nil, kind: String? = nil, corpus: String? = nil) {
    self.surface = surface
    self.lang = lang
    self.kind = kind
    self.corpus = corpus
  }
}

/// An expression with its variants (n per variant), counting state and claim markers (contract shape `Expression`).
public struct ExpressionResponse: Codable, Sendable, Equatable {
  public var expression: ExpressionInfo
  public var variants: [Variant]
  public var state: ExpressionState
  public var claims: [ClaimMarker]?
  /// In a virtual corpus, the expression in each member corpus with its own state (C2).
  public var members: [ExpressionMember]?

  public init(expression: ExpressionInfo, variants: [Variant], state: ExpressionState, claims: [ClaimMarker]? = nil,
              members: [ExpressionMember]? = nil) {
    self.expression = expression
    self.variants = variants
    self.state = state
    self.claims = claims
    self.members = members
  }
}

/// The expression row.
public struct ExpressionInfo: Codable, Sendable, Equatable {
  public var id: ExpressionID
  public var surface: String
  public var norm: String
  public var kind: String
  @Nullable public var lang: String?
  public var synthetic: Bool
  @NullOrAbsent public var corpus: String?

  public init(id: ExpressionID, surface: String, norm: String, kind: String, lang: String?, synthetic: Bool,
              corpus: String? = nil) {
    self.id = id
    self.surface = surface
    self.norm = norm
    self.kind = kind
    self.lang = lang
    self.synthetic = synthetic
    self.corpus = corpus
  }
}

/// The counting state: status ∈ `vocab.EXPRESSION_STATES`, the counting job, run and counts.
public struct ExpressionState: Codable, Sendable, Equatable {
  public var status: String
  @NullOrAbsent public var job: Int?
  @NullOrAbsent public var run: RunID?
  @NullOrAbsent public var n: Int?
  @NullOrAbsent public var docs: Int?
  /// Every name-guard hit of the count, before any view rule.
  @NullOrAbsent public var namesExcluded: Int?

  public init(status: String, job: Int? = nil, run: RunID? = nil, n: Int? = nil, docs: Int? = nil, namesExcluded: Int? = nil) {
    self.status = status
    self.job = job
    self.run = run
    self.n = n
    self.docs = docs
    self.namesExcluded = namesExcluded
  }
}

/// The expression in one member corpus of a virtual corpus.
public struct ExpressionMember: Codable, Sendable, Equatable {
  public var corpus: String
  public var id: ExpressionID
  public var state: ExpressionState
  public init(corpus: String, id: ExpressionID, state: ExpressionState) {
    self.corpus = corpus
    self.id = id
    self.state = state
  }
}

/// PATCH /api/expressions/:id/variants: enable or disable variants (contract shape `VariantsPatch`); counting reruns.
public struct VariantsPatchRequest: Codable, Sendable, Equatable {
  public var variants: [VariantToggle]
  /// 'real' applies the change to every member corpus.
  public var corpus: String?

  public init(variants: [VariantToggle], corpus: String? = nil) {
    self.variants = variants
    self.corpus = corpus
  }
}

/// One variant switched on or off.
public struct VariantToggle: Codable, Sendable, Equatable {
  public var id: Int
  public var enabled: Bool
  public init(id: Int, enabled: Bool) {
    self.id = id
    self.enabled = enabled
  }
}
