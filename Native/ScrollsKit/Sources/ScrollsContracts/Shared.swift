// OWNER: N0
// Pieces shared by several contract 1.3.0 responses (src/shared/contracts.mjs "shared pieces"): provenance, issues,
// date rows, anchors, variants, scores, job references and claim markers.

import ScrollsCore

/// The contract version these types mirror (`CONTRACT_VERSION`).
public enum Contract {
  public static let version = "1.3.0"
}

/// What every data response says about its own making: the data version and runs it read, the tokenizer and segmenter,
/// whether it holds synthetic records, and the collections and licences it draws on.
public struct Provenance: Codable, Sendable, Equatable {
  public var dataVersion: Int
  /// Runs by stage: `{materialize: {<expr id>: <run id>}, cluster: <run id>, …}` (verbatim; keys vary by response).
  public var runIds: JSONValue
  public var tokenizer: String
  public var segmenter: String
  public var synthetic: Bool
  public var collections: [String]
  public var licenses: [String]
  /// A virtual corpus's slug ('real') when the response spans member corpora (contract 1.3.0, C2).
  public var corpus: String?
  /// The member corpora of a virtual corpus.
  public var corpora: [String]?

  public init(dataVersion: Int, runIds: JSONValue = [:], tokenizer: String = Tokenizer.version, segmenter: String = "seg-1",
              synthetic: Bool, collections: [String], licenses: [String], corpus: String? = nil, corpora: [String]? = nil) {
    self.dataVersion = dataVersion
    self.runIds = runIds
    self.tokenizer = tokenizer
    self.segmenter = segmenter
    self.synthetic = synthetic
    self.collections = collections
    self.licenses = licenses
    self.corpus = corpus
    self.corpora = corpora
  }
}

/// A problem found while reading or importing a record (SPEC §5.7): a code from `vocab.ISSUE_CODES`, its severity, where
/// it is, and what to do about it (never empty).
public struct Issue: Codable, Sendable, Equatable {
  public var code: String
  /// 'info' | 'warning' | 'rejected' | 'fatal'
  public var severity: String
  @NullOrAbsent public var line: Int?
  @NullOrAbsent public var col: Int?
  @NullOrAbsent public var field: String?
  @NullOrAbsent public var valueExcerpt: String?
  public var message: String
  public var suggestion: String

  public init(code: String, severity: String, line: Int? = nil, col: Int? = nil, field: String? = nil,
              valueExcerpt: String? = nil, message: String, suggestion: String) {
    self.code = code
    self.severity = severity
    self.line = line
    self.col = col
    self.field = field
    self.valueExcerpt = valueExcerpt
    self.message = message
    self.suggestion = suggestion
  }
}

/// One date assertion of a document as the date card lists it.
public struct DateRow: Codable, Sendable, Equatable {
  public var role: String
  public var label: String
  public var precision: String
  public var basis: String
  public var assertedBy: String
  public var isChronology: Bool

  public init(role: String, label: String, precision: String, basis: String, assertedBy: String, isChronology: Bool) {
    self.role = role
    self.label = label
    self.precision = precision
    self.basis = basis
    self.assertedBy = assertedBy
    self.isChronology = isChronology
  }
}

/// A text anchor: a span of a document's decoded original (UTF-16 offsets, D4) with its quote and the text's sha256.
public struct Anchor: Codable, Sendable, Equatable {
  public var docId: DocumentID
  public var sha256: String
  public var field: String
  public var start: Int
  public var end: Int
  public var quote: String
  public var prefix: String?
  public var suffix: String?

  public init(docId: DocumentID, sha256: String, field: String, start: Int, end: Int, quote: String, prefix: String? = nil,
              suffix: String? = nil) {
    self.docId = docId
    self.sha256 = sha256
    self.field = field
    self.start = start
    self.end = end
    self.quote = quote
    self.prefix = prefix
    self.suffix = suffix
  }
}

/// One form an expression is counted under (identity, inflection, spelling, transliteration …) with its count.
public struct Variant: Codable, Sendable, Equatable {
  public var id: Int
  public var form: String
  /// `vocab.VARIANT_TYPES`
  public var type: String
  @NullOrAbsent public var rule: String?
  /// `vocab.EVIDENCE_STATUS`
  public var status: String
  public var enabled: Bool
  /// Occurrences counted under this form; null before counting.
  @Nullable public var n: Int?
  public var lang: String?

  public init(id: Int, form: String, type: String, rule: String? = nil, status: String, enabled: Bool, n: Int?,
              lang: String? = nil) {
    self.id = id
    self.form = form
    self.type = type
    self.rule = rule
    self.status = status
    self.enabled = enabled
    self.n = n
    self.lang = lang
  }
}

/// A relationship's score with its kind (similarity, heuristic strength, match ratio …), never a bare number.
public struct Score: Codable, Sendable, Equatable {
  public var value: Double
  /// `vocab.SCORE_KINDS`
  public var kind: String

  public init(value: Double, kind: String) {
    self.value = value
    self.kind = kind
  }
}

/// `{id}`: a job, a run or a created row named by its id.
public struct IDRef: Codable, Sendable, Equatable {
  public var id: Int
  public init(id: Int) { self.id = id }
}

/// `{job: {id}}`: the answer of an endpoint that started a job.
public struct JobRefResponse: Codable, Sendable, Equatable {
  public var job: IDRef
  public init(job: Int) { self.job = IDRef(id: job) }
}

/// A claim's date as the marker shows it.
public struct ClaimDate: Codable, Sendable, Equatable {
  @Nullable public var loYear: Int?
  @Nullable public var hiYear: Int?
  @Nullable public var label: String?

  public init(loYear: Int?, hiYear: Int?, label: String?) {
    self.loYear = loYear
    self.hiYear = hiYear
    self.label = label
  }
}

/// A span of a passage (`{passage, start, end}`, offsets relative to the passage text).
public struct PassageSpan: Codable, Sendable, Equatable {
  public var passage: PassageID
  public var start: Int
  public var end: Int

  public init(passage: PassageID, start: Int, end: Int) {
    self.passage = passage
    self.start = start
    self.end = end
  }
}

/// The marker the Scroll draws left of a strand for an external attestation claim (Wiktionary): a statement quoted
/// from a source, never an occurrence (SPEC §10.2).
public struct ClaimMarker: Codable, Sendable, Equatable {
  public var label: String
  public var date: ClaimDate
  /// 'default' | 'dimmed'
  public var display: String
  public var reasons: [String]
  public var source: String
  @Nullable public var license: String?
  public var attribution: String?
  public var relation: String?
  @NullOrAbsent public var highlight: PassageSpan?

  public init(label: String, date: ClaimDate, display: String, reasons: [String], source: String, license: String?,
              attribution: String? = nil, relation: String? = nil, highlight: PassageSpan? = nil) {
    self.label = label
    self.date = date
    self.display = display
    self.reasons = reasons
    self.source = source
    self.license = license
    self.attribution = attribution
    self.relation = relation
    self.highlight = highlight
  }
}
