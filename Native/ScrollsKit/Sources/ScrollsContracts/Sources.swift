// OWNER: N0
// Corpora, facets, adapters (probe, load, enable, claims), the Ngram baseline, the demo tour and etymology families
// (contract shapes `Corpus`, `Corpora`, `Facets`, `Adapters`, `AdapterClaims`, `Baseline`, `Tour`, `Etymology`).

import ScrollsCore

// MARK: - Corpora

/// A corpus with its collections (contract shape `Corpus`); a virtual corpus (`real`) lists member corpora instead.
public struct Corpus: Codable, Sendable, Equatable {
  public var slug: String
  public var name: String
  /// 'real' | 'synthetic' | 'user'
  public var kind: String
  public var synthetic: Bool
  public var collections: [CorpusCollection]
  public var virtual: Bool?
  public var members: [String]?
  public var available: Bool?
  @NullOrAbsent public var description: String?

  public init(slug: String, name: String, kind: String, synthetic: Bool, collections: [CorpusCollection],
              virtual: Bool? = nil, members: [String]? = nil, available: Bool? = nil, description: String? = nil) {
    self.slug = slug
    self.name = name
    self.kind = kind
    self.synthetic = synthetic
    self.collections = collections
    self.virtual = virtual
    self.members = members
    self.available = available
    self.description = description
  }
}

/// A collection of a corpus with its coverage, selection note, caveats, licence and load status.
public struct CorpusCollection: Codable, Sendable, Equatable {
  public var slug: String
  public var name: String
  public var domain: String
  public var modality: String
  public var unit: String
  public var sampling: String
  public var rateEligible: Bool
  public var docs: Int
  public var tokens: Int
  public var works: Int
  public var undated: Int
  public var scheduled: Int
  /// `[first year, last year]`, or null when nothing is dated.
  public var span: JSONValue
  @Nullable public var selectionNote: String?
  public var caveats: JSONValue
  @Nullable public var license: String?
  public var status: String
  public var synthetic: Bool?
  public var dating: CollectionDating?
  public var samplingLabel: String?
  @NullOrAbsent public var coverageGate: Int?

  public init(slug: String, name: String, domain: String, modality: String, unit: String, sampling: String,
              rateEligible: Bool, docs: Int, tokens: Int, works: Int, undated: Int, scheduled: Int, span: JSONValue,
              selectionNote: String?, caveats: JSONValue, license: String?, status: String, synthetic: Bool? = nil,
              dating: CollectionDating? = nil, samplingLabel: String? = nil, coverageGate: Int? = nil) {
    self.slug = slug
    self.name = name
    self.domain = domain
    self.modality = modality
    self.unit = unit
    self.sampling = sampling
    self.rateEligible = rateEligible
    self.docs = docs
    self.tokens = tokens
    self.works = works
    self.undated = undated
    self.scheduled = scheduled
    self.span = span
    self.selectionNote = selectionNote
    self.caveats = caveats
    self.license = license
    self.status = status
    self.synthetic = synthetic
    self.dating = dating
    self.samplingLabel = samplingLabel
    self.coverageGate = coverageGate
  }
}

/// How a collection's documents are dated (counts by date basis; `after1928` = dated after the text seam).
public struct CollectionDating: Codable, Sendable, Equatable {
  public var stated: Int
  public var estimated: Int
  public var derived: Int
  public var period: Int
  public var announced: Int
  public var undated: Int
  public var after1928: Int

  public init(stated: Int, estimated: Int, derived: Int, period: Int, announced: Int, undated: Int, after1928: Int) {
    self.stated = stated
    self.estimated = estimated
    self.derived = derived
    self.period = period
    self.announced = announced
    self.undated = undated
    self.after1928 = after1928
  }

  enum CodingKeys: String, WireNamedKeys {
    case stated, estimated, derived, period, announced, undated, after1928
    static let wireNames = ["after1928": "after_1928"]
  }
}

/// GET /api/corpora (contract shape `Corpora`).
public typealias CorporaResponse = [Corpus]

/// GET /api/facets query.
public struct FacetsRequest: Codable, Sendable, Equatable {
  /// The filter grammar string.
  public var f: String?
  public var corpus: String?
  public init(f: String? = nil, corpus: String? = nil) {
    self.f = f
    self.corpus = corpus
  }
}

/// GET /api/adapters options.
public struct AdaptersRequest: Codable, Sendable, Equatable {
  /// Probe the staged files again.
  public var refresh: Bool?
  public init(refresh: Bool? = nil) { self.refresh = refresh }
}

/// Facet values with document counts for a filter (contract shape `Facets`).
public struct FacetsResponse: Codable, Sendable, Equatable {
  public var facets: [String: [FacetValue]]
  public var provenance: Provenance?

  public init(facets: [String: [FacetValue]], provenance: Provenance? = nil) {
    self.facets = facets
    self.provenance = provenance
  }
}

/// One facet value.
public struct FacetValue: Codable, Sendable, Equatable {
  public var value: String
  public var label: String
  public var count: Int
  public init(value: String, label: String, count: Int) {
    self.value = value
    self.label = label
    self.count = count
  }
}

// MARK: - Adapters

/// A staged-source adapter: probe result, licence, load state (one item of contract shape `Adapters`).
public struct AdapterInfo: Codable, Sendable, Equatable {
  public var id: String
  public var version: String
  /// 'local-file' | 'local-dataset' | 'network'
  public var access: String
  /// `{path, manifest_ok, format_ok, counts}` of the staged files, or null (verbatim).
  public var staged: JSONValue
  public var license: String
  public var loaded: Bool
  @NullOrAbsent public var lastLoad: JSONValue?
  public var label: String?
  public var available: Bool?
  public var reason: String?
  public var command: String?
  public var caveats: JSONValue?
  @NullOrAbsent public var attribution: String?
  public var enabled: Bool?
  public var loadable: Bool?
  public var note: String?
  public var load: AdapterLoadState?
  @NullOrAbsent public var job: AdapterJob?
  public var complete: Bool?

  public init(id: String, version: String, access: String, staged: JSONValue, license: String, loaded: Bool,
              lastLoad: JSONValue? = nil, label: String? = nil, available: Bool? = nil, reason: String? = nil,
              command: String? = nil, caveats: JSONValue? = nil, attribution: String? = nil, enabled: Bool? = nil,
              loadable: Bool? = nil, note: String? = nil, load: AdapterLoadState? = nil, job: AdapterJob? = nil,
              complete: Bool? = nil) {
    self.id = id
    self.version = version
    self.access = access
    self.staged = staged
    self.license = license
    self.loaded = loaded
    self.lastLoad = lastLoad
    self.label = label
    self.available = available
    self.reason = reason
    self.command = command
    self.caveats = caveats
    self.attribution = attribution
    self.enabled = enabled
    self.loadable = loadable
    self.note = note
    self.load = load
    self.job = job
    self.complete = complete
  }
}

/// A live chained load's job.
public struct AdapterJob: Codable, Sendable, Equatable {
  public var id: Int
  public var status: String
  public init(id: Int, status: String) {
    self.id = id
    self.status = status
  }
}

/// The state of a chained STEMM load (`Adapters[].load`).
public struct AdapterLoadState: Codable, Sendable, Equatable {
  /// 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted'
  public var status: String
  @NullOrAbsent public var phase: String?
  @NullOrAbsent public var part: Int?
  @NullOrAbsent public var progress: Double?
  @NullOrAbsent public var message: String?
  public var counts: JSONValue?
  @NullOrAbsent public var coverage: JSONValue?
  public var resume: String?
  @NullOrAbsent public var error: JSONValue?
  @NullOrAbsent public var startedAt: String?
  @NullOrAbsent public var updatedAt: String?
  @NullOrAbsent public var finishedAt: String?
  public var params: JSONValue?

  public init(status: String, phase: String? = nil, part: Int? = nil, progress: Double? = nil, message: String? = nil,
              counts: JSONValue? = nil, coverage: JSONValue? = nil, resume: String? = nil, error: JSONValue? = nil,
              startedAt: String? = nil, updatedAt: String? = nil, finishedAt: String? = nil, params: JSONValue? = nil) {
    self.status = status
    self.phase = phase
    self.part = part
    self.progress = progress
    self.message = message
    self.counts = counts
    self.coverage = coverage
    self.resume = resume
    self.error = error
    self.startedAt = startedAt
    self.updatedAt = updatedAt
    self.finishedAt = finishedAt
    self.params = params
  }
}

/// GET /api/adapters (contract shape `Adapters`).
public typealias AdaptersResponse = [AdapterInfo]
/// POST /api/adapters/:id/enable answers with the updated adapter list.
public typealias AdapterEnableResponse = [AdapterInfo]
/// POST /api/adapters/:id/load: the first job of the load.
public typealias AdapterLoadResponse = JobRefResponse

/// The body of POST /api/adapters/:id/load: per adapter, what to load (Docs/API.md 1.2.0 "Sources").
public struct AdapterLoadRequest: Codable, Sendable, Equatable {
  /// Network adapters need an explicit approval.
  public var approve: Bool?
  public var collections: [String]?
  /// OpenAlex fields.
  public var fields: [String]?
  /// OpenAlex `[lo, hi]` years.
  public var years: [Int]?
  public var abstracts: Bool?
  /// gutenberg-stemm book ids.
  public var ids: [String]?
  /// Wiktionary: look up an expression's words.
  public var expressionId: Int?
  public var words: [String]?
  public var lang: String?

  public init(approve: Bool? = nil, collections: [String]? = nil, fields: [String]? = nil, years: [Int]? = nil,
              abstracts: Bool? = nil, ids: [String]? = nil, expressionId: Int? = nil, words: [String]? = nil,
              lang: String? = nil) {
    self.approve = approve
    self.collections = collections
    self.fields = fields
    self.years = years
    self.abstracts = abstracts
    self.ids = ids
    self.expressionId = expressionId
    self.words = words
    self.lang = lang
  }

  enum CodingKeys: String, WireNamedKeys {
    case approve, collections, fields, years, abstracts, ids, expressionId, words, lang
    static let wireNames = ["expressionId": "expressionId"]
  }
}

/// The body of POST /api/adapters/:id/enable.
public struct AdapterEnableRequest: Codable, Sendable, Equatable {
  public var approve: Bool?
  public var enabled: Bool?
  public init(approve: Bool? = nil, enabled: Bool? = nil) {
    self.approve = approve
    self.enabled = enabled
  }
}

/// GET /api/adapters/:id/claims query: a word in a language, or a tracked expression.
public struct AdapterClaimsRequest: Codable, Sendable, Equatable {
  public var word: String?
  /// 'en' | 'fr' | 'es' | 'hi' | 'gu'
  public var lang: String?
  public var expr: ExpressionID?
  public init(word: String? = nil, lang: String? = nil, expr: ExpressionID? = nil) {
    self.word = word
    self.lang = lang
    self.expr = expr
  }
}

/// An adapter's external claims for a word or an expression (contract shape `AdapterClaims`).
public struct AdapterClaimsResponse: Codable, Sendable, Equatable {
  public var available: Bool
  public var adapter: String
  public var license: String
  public var attribution: String
  public var note: String
  @NullOrAbsent public var word: String?
  @NullOrAbsent public var lang: String?
  @NullOrAbsent public var expression: ExpressionID?
  public var loaded: Bool?
  public var claims: [Claim]?
  public var reason: String?
  @NullOrAbsent public var command: String?

  public init(available: Bool, adapter: String, license: String, attribution: String, note: String, word: String? = nil,
              lang: String? = nil, expression: ExpressionID? = nil, loaded: Bool? = nil, claims: [Claim]? = nil,
              reason: String? = nil, command: String? = nil) {
    self.available = available
    self.adapter = adapter
    self.license = license
    self.attribution = attribution
    self.note = note
    self.word = word
    self.lang = lang
    self.expression = expression
    self.loaded = loaded
    self.claims = claims
    self.reason = reason
    self.command = command
  }
}

/// An external attestation claim (Wiktionary): a statement quoted from a source, never an occurrence (§10.2).
public struct Claim: Codable, Sendable, Equatable {
  public var label: String
  /// 'default' | 'dimmed'
  public var display: String
  public var reasons: [String]
  @NullOrAbsent public var yearLo: Int?
  @NullOrAbsent public var yearHi: Int?
  @NullOrAbsent public var precision: String?
  @NullOrAbsent public var dateText: String?
  @NullOrAbsent public var relation: String?
  @NullOrAbsent public var span: String?
  @NullOrAbsent public var url: String?
  @NullOrAbsent public var license: String?
  @NullOrAbsent public var attribution: String?
  // The claim row as stored (loaded claims) or as the word index holds it (lookups).
  public var assertion: Int?
  public var expression: ExpressionID?
  public var approx: Bool?
  public var source: String?
  public var v: Int?
  public var kind: String?
  @NullOrAbsent public var qualifier: JSONValue?
  @NullOrAbsent public var alternatives: JSONValue?
  public var word: String?
  public var lang: String?
  public var pos: String?
  public var entryIds: [String]?
  public var entryId: String?
  @NullOrAbsent public var spanStart: Int?
  @NullOrAbsent public var spanEnd: Int?
  public var spanInExcerpt: Bool?
  @NullOrAbsent public var subjectHint: String?
  public var senseSpecific: Bool?
  @NullOrAbsent public var contextLanguage: String?
  public var document: DocumentID?
  public var passage: PassageID?
  @NullOrAbsent public var highlight: PassageSpan?
  public var rule: String?
  public var key: String?
  @NullOrAbsent public var periodPart: String?
  @NullOrAbsent public var era: String?
  public var ambiguous: Bool?
  @NullOrAbsent public var year: Int?
  @NullOrAbsent public var viaTemplate: String?
  public var written: Bool?
  public var openEnded: Bool?

  public init(label: String, display: String, reasons: [String]) {
    self.label = label
    self.display = display
    self.reasons = reasons
  }
}

// MARK: - Baseline, tour, etymology

/// GET /api/baseline query: one word's external Ngram baseline.
public struct BaselineRequest: Codable, Sendable, Equatable {
  public var word: String
  public var lang: String?
  public var from: Int?
  public var to: Int?
  public init(word: String, lang: String? = nil, from: Int? = nil, to: Int? = nil) {
    self.word = word
    self.lang = lang
    self.from = from
    self.to = to
  }
}

/// External Ngram baseline for one word, or why there is none (contract shape `Baseline`).
public struct BaselineResponse: Codable, Sendable, Equatable {
  public var available: Bool
  public var word: String?
  @NullOrAbsent public var lang: String?
  public var reason: String?
  public var label: String?
  public var attribution: String?
  /// `[{decade, per_million, volumes}]` (verbatim).
  public var decades: JSONValue?
  public var caveats: JSONValue?
  public var topForm: String?
  public var forms: Int?
  public var mockNote: String?

  public init(available: Bool, word: String? = nil, lang: String? = nil, reason: String? = nil, label: String? = nil,
              attribution: String? = nil, decades: JSONValue? = nil, caveats: JSONValue? = nil, topForm: String? = nil,
              forms: Int? = nil, mockNote: String? = nil) {
    self.available = available
    self.word = word
    self.lang = lang
    self.reason = reason
    self.label = label
    self.attribution = attribution
    self.decades = decades
    self.caveats = caveats
    self.topForm = topForm
    self.forms = forms
    self.mockNote = mockNote
  }
}

/// The demo tour, ids resolved (contract shape `Tour`).
public struct TourResponse: Codable, Sendable, Equatable {
  public var steps: [TourStep]
  public var minutes: Int?
  public init(steps: [TourStep], minutes: Int? = nil) {
    self.steps = steps
    self.minutes = minutes
  }
}

/// One tour step: what to do, what to see, what it teaches, and the view state it opens.
public struct TourStep: Codable, Sendable, Equatable {
  public var n: Int
  public var action: String
  public var see: String
  public var learn: String
  public var anchor: String
  /// The view-state hash the step opens ('#v=1&c=demo&…').
  public var state: String
  public var synthetic: Bool
  public var firstMinute: Bool?
  /// Resolved ids (`{occurrence, relationship, passage, lineage_root}`), verbatim.
  public var refs: JSONValue?
  /// What the step still waits for.
  public var pending: [String]?
  /// What to POST to /api/expressions so the step's strand resolves.
  public var track: [TrackExpressionRequest]?

  public init(n: Int, action: String, see: String, learn: String, anchor: String, state: String, synthetic: Bool,
              firstMinute: Bool? = nil, refs: JSONValue? = nil, pending: [String]? = nil,
              track: [TrackExpressionRequest]? = nil) {
    self.n = n
    self.action = action
    self.see = see
    self.learn = learn
    self.anchor = anchor
    self.state = state
    self.synthetic = synthetic
    self.firstMinute = firstMinute
    self.refs = refs
    self.pending = pending
    self.track = track
  }
}

/// GET /api/etymology query.
public struct EtymologyRequest: Codable, Sendable, Equatable {
  public var expr: ExpressionID
  public init(expr: ExpressionID) { self.expr = expr }
}

/// The roots.tsv families of an expression's single words — periods, not dates (contract shape `Etymology`).
public struct EtymologyResponse: Codable, Sendable, Equatable {
  public var available: Bool
  public var expression: ExpressionID?
  @NullOrAbsent public var word: String?
  @NullOrAbsent public var lang: String?
  public var families: [EtymologyFamily]?
  public var roots: [EtymologyRoot]?
  public var reason: String?
  @NullOrAbsent public var note: String?
  public var source: String

  public init(available: Bool, expression: ExpressionID? = nil, word: String? = nil, lang: String? = nil,
              families: [EtymologyFamily]? = nil, roots: [EtymologyRoot]? = nil, reason: String? = nil, note: String? = nil,
              source: String) {
    self.available = available
    self.expression = expression
    self.word = word
    self.lang = lang
    self.families = families
    self.roots = roots
    self.reason = reason
    self.note = note
    self.source = source
  }
}

/// An etymon or root (`Etymon`).
public struct Etymon: Codable, Sendable, Equatable {
  public var key: String
  public var lang: String
  public var form: String
  @Nullable public var roman: String?
  @Nullable public var gloss: String?
  /// 'etymon' | 'root'
  public var kind: String
  /// True on a parent that more than one family lists (C5).
  public var shared: Bool?

  public init(key: String, lang: String, form: String, roman: String?, gloss: String?, kind: String, shared: Bool? = nil) {
    self.key = key
    self.lang = lang
    self.form = form
    self.roman = roman
    self.gloss = gloss
    self.kind = kind
    self.shared = shared
  }
}

/// A family: an etymon whose members hold one of the expression's words, with its listed parents in order.
public struct EtymologyFamily: Codable, Sendable, Equatable {
  public var key: String
  public var lang: String
  public var form: String
  @Nullable public var roman: String?
  @Nullable public var gloss: String?
  public var kind: String
  /// `vocab.PARENT_SEMANTICS`: a multi-parent list is a "listed roots" bracket, never competing hypotheses.
  public var parentSemantics: String
  public var parents: [Etymon]
  /// `[{lang, word, rank}]` (verbatim).
  public var members: JSONValue

  public init(key: String, lang: String, form: String, roman: String?, gloss: String?, kind: String,
              parentSemantics: String, parents: [Etymon], members: JSONValue) {
    self.key = key
    self.lang = lang
    self.form = form
    self.roman = roman
    self.gloss = gloss
    self.kind = kind
    self.parentSemantics = parentSemantics
    self.parents = parents
    self.members = members
  }
}

/// A listed root, once, with the families that list it (C5).
public struct EtymologyRoot: Codable, Sendable, Equatable {
  public var key: String
  public var lang: String
  public var form: String
  @Nullable public var roman: String?
  @Nullable public var gloss: String?
  public var kind: String
  public var families: [String]
  public var isFamily: Bool

  public init(key: String, lang: String, form: String, roman: String?, gloss: String?, kind: String, families: [String],
              isFamily: Bool) {
    self.key = key
    self.lang = lang
    self.form = form
    self.roman = roman
    self.gloss = gloss
    self.kind = kind
    self.families = families
    self.isFamily = isFamily
  }
}
