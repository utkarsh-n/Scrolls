// OWNER: N0
// The import wizard's endpoints (SPEC §5.2, §5.7): stage a file → preview → validate a mapping (dry run) → commit as a
// job → revert. Contract shapes `ImportCreated`, `ImportPreview`, `ImportMappingRequest`, `ImportValidation`,
// `ImportSummary`, `JobRef`; the problems CSV is a text body. The mapping itself is the IMPORT-SCHEMA object (N1),
// carried verbatim.

import Foundation
import ScrollsCore

/// The collection a staged file goes into (`X-Scrolls-Collection` on the web): a user collection, created on commit.
public struct ImportCollectionSpec: Codable, Sendable, Equatable {
  public var slug: String?
  public var name: String
  /// 'tokens' | 'works' | 'entries' | 'none'
  public var unit: String?
  public var license: String?

  public init(slug: String? = nil, name: String, unit: String? = nil, license: String? = nil) {
    self.slug = slug
    self.name = name
    self.unit = unit
    self.license = license
  }
}

/// POST /api/imports in process: a file the user picked (already copied into the atlas's inbox) and its collection.
public struct StageImportRequest: Codable, Sendable, Equatable {
  /// The file's location (inside the app container).
  public var file: URL
  /// The name the user knows it by (`X-Scrolls-Filename`); at most 255 characters, no path.
  public var fileName: String
  public var collection: ImportCollectionSpec?

  public init(file: URL, fileName: String, collection: ImportCollectionSpec? = nil) {
    self.file = file
    self.fileName = fileName
    self.collection = collection
  }
}

/// GET /api/imports/:id/preview overrides (the wizard's format, delimiter, header, encoding, JSON pointer, line mode).
public struct ImportPreviewRequest: Codable, Sendable, Equatable {
  /// `vocab.IMPORT_FORMATS` minus 'adapter'.
  public var format: String?
  /// One character, or 'comma' · 'tab' · 'semicolon' · 'pipe'.
  public var delimiter: String?
  public var header: Bool?
  /// A JSON pointer to the records array of a JSON file.
  public var pointer: String?
  /// 'auto' | 'utf-8' | 'windows-1252'
  public var encoding: String?
  public var lineMode: Bool?

  public init(format: String? = nil, delimiter: String? = nil, header: Bool? = nil, pointer: String? = nil,
              encoding: String? = nil, lineMode: Bool? = nil) {
    self.format = format
    self.delimiter = delimiter
    self.header = header
    self.pointer = pointer
    self.encoding = encoding
    self.lineMode = lineMode
  }
}

/// A staged file: its batch id and first preview (contract shape `ImportCreated`).
public struct ImportStagedResponse: Codable, Sendable, Equatable {
  public var importBatchId: ImportBatchID
  public var preview: ImportPreviewResponse

  public init(importBatchId: ImportBatchID, preview: ImportPreviewResponse) {
    self.importBatchId = importBatchId
    self.preview = preview
  }
}

/// Format, encoding, delimiter, columns with samples, sample rows, the suggested mapping and issues (contract shape
/// `ImportPreview`).
public struct ImportPreviewResponse: Codable, Sendable, Equatable {
  public var format: String
  public var encoding: String
  @Nullable public var delimiter: String?
  @Nullable public var header: Bool?
  public var columns: [ImportColumn]
  /// Up to 20 rows as parsed (objects of column → value), verbatim.
  public var sampleRows: JSONValue
  /// A mapping in the IMPORT-SCHEMA form, verbatim.
  public var suggestedMapping: JSONValue
  public var issues: [Issue]
  public var mockNote: String?

  public init(format: String, encoding: String, delimiter: String?, header: Bool?, columns: [ImportColumn],
              sampleRows: JSONValue, suggestedMapping: JSONValue, issues: [Issue], mockNote: String? = nil) {
    self.format = format
    self.encoding = encoding
    self.delimiter = delimiter
    self.header = header
    self.columns = columns
    self.sampleRows = sampleRows
    self.suggestedMapping = suggestedMapping
    self.issues = issues
    self.mockNote = mockNote
  }
}

/// A column of the preview: its name, sample values and the inferred role.
public struct ImportColumn: Codable, Sendable, Equatable {
  public var name: String
  public var samples: JSONValue
  public var inferred: String

  public init(name: String, samples: JSONValue, inferred: String) {
    self.name = name
    self.samples = samples
    self.inferred = inferred
  }
}

/// `{mapping}`: the body of PUT …/mapping and POST …/commit (contract shape `ImportMappingRequest`).
public struct ImportMappingRequest: Codable, Sendable, Equatable {
  /// The IMPORT-SCHEMA mapping, verbatim.
  public var mapping: JSONValue
  public init(mapping: JSONValue) { self.mapping = mapping }
}

/// The dry run of a mapping over every row (contract shape `ImportValidation`).
public struct ImportMappingResponse: Codable, Sendable, Equatable {
  public var validation: ImportSummary
  public init(validation: ImportSummary) { self.validation = validation }
}

/// What an import did, or would do (contract shape `ImportSummary`).
public struct ImportSummary: Codable, Sendable, Equatable {
  public var importBatchId: ImportBatchID
  public var collection: String
  public var file: ImportFileInfo
  public var rows: ImportRowCounts
  public var documents: ImportDocumentCounts
  public var passages: Int
  public var tokens: Int
  /// Counts by date precision, circa, scheduled and the span (verbatim).
  public var dates: JSONValue
  public var languages: [String: Int]
  public var relationships: ImportRelationshipCounts
  public var mappingDecisions: [ImportMappingDecision]
  public var problems: ImportProblems
  @NullOrAbsent public var dataVersion: Int?
  @NullOrAbsent public var runId: RunID?
  @NullOrAbsent public var startedAt: String?
  @NullOrAbsent public var finishedAt: String?
  @NullOrAbsent public var durationMs: Int?
  public var mockNote: String?

  public init(importBatchId: ImportBatchID, collection: String, file: ImportFileInfo, rows: ImportRowCounts,
              documents: ImportDocumentCounts, passages: Int, tokens: Int, dates: JSONValue, languages: [String: Int],
              relationships: ImportRelationshipCounts, mappingDecisions: [ImportMappingDecision], problems: ImportProblems,
              dataVersion: Int? = nil, runId: RunID? = nil, startedAt: String? = nil, finishedAt: String? = nil,
              durationMs: Int? = nil, mockNote: String? = nil) {
    self.importBatchId = importBatchId
    self.collection = collection
    self.file = file
    self.rows = rows
    self.documents = documents
    self.passages = passages
    self.tokens = tokens
    self.dates = dates
    self.languages = languages
    self.relationships = relationships
    self.mappingDecisions = mappingDecisions
    self.problems = problems
    self.dataVersion = dataVersion
    self.runId = runId
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.durationMs = durationMs
    self.mockNote = mockNote
  }
}

/// The imported file.
public struct ImportFileInfo: Codable, Sendable, Equatable {
  public var name: String
  public var sha256: String
  public var bytes: Int
  public var encoding: String
  public var format: String
  @NullOrAbsent public var delimiter: String?

  public init(name: String, sha256: String, bytes: Int, encoding: String, format: String, delimiter: String? = nil) {
    self.name = name
    self.sha256 = sha256
    self.bytes = bytes
    self.encoding = encoding
    self.format = format
    self.delimiter = delimiter
  }
}

/// Rows seen, accepted (with and without warnings) and rejected.
public struct ImportRowCounts: Codable, Sendable, Equatable {
  public var seen: Int
  public var accepted: Int
  public var acceptedWithWarnings: Int
  public var rejected: Int
  public init(seen: Int, accepted: Int, acceptedWithWarnings: Int, rejected: Int) {
    self.seen = seen
    self.accepted = accepted
    self.acceptedWithWarnings = acceptedWithWarnings
    self.rejected = rejected
  }
}

/// Documents created, flagged as duplicates, metadata-only and translations.
public struct ImportDocumentCounts: Codable, Sendable, Equatable {
  public var created: Int
  public var duplicatesFlagged: Int
  public var metadataOnly: Int
  public var translations: Int
  public init(created: Int, duplicatesFlagged: Int, metadataOnly: Int, translations: Int) {
    self.created = created
    self.duplicatesFlagged = duplicatesFlagged
    self.metadataOnly = metadataOnly
    self.translations = translations
  }
}

/// Relationships documented, proposed, and targets that did not resolve.
public struct ImportRelationshipCounts: Codable, Sendable, Equatable {
  public var documented: Int
  public var proposed: Int
  public var unresolvedTargets: Int
  public init(documented: Int, proposed: Int, unresolvedTargets: Int) {
    self.documented = documented
    self.proposed = proposed
    self.unresolvedTargets = unresolvedTargets
  }
}

/// Why a target field was mapped the way it was.
public struct ImportMappingDecision: Codable, Sendable, Equatable {
  public var target: String
  @NullOrAbsent public var from: String?
  @NullOrAbsent public var transform: String?
  @NullOrAbsent public var parseRate: Double?
  @NullOrAbsent public var reason: String?

  public init(target: String, from: String? = nil, transform: String? = nil, parseRate: Double? = nil, reason: String? = nil) {
    self.target = target
    self.from = from
    self.transform = transform
    self.parseRate = parseRate
    self.reason = reason
  }
}

/// Problems by code, the first few, and where the full CSV is.
public struct ImportProblems: Codable, Sendable, Equatable {
  public var byCode: [String: Int]
  public var first: [Issue]
  public var download: String
  public init(byCode: [String: Int], first: [Issue], download: String) {
    self.byCode = byCode
    self.first = first
    self.download = download
  }
}

/// GET /api/imports/:id/problems.csv: every issue of the batch, one CSV row each.
public struct ImportProblemsResponse: Sendable, Equatable {
  public var csv: String
  public init(csv: String) { self.csv = csv }
}

/// POST /api/imports/:id/commit: the commit job (progress on the event stream, then the summary).
public typealias ImportCommitResponse = JobRefResponse
/// POST /api/imports/:id/revert: the revert job.
public typealias ImportRevertResponse = JobRefResponse
