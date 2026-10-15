// OWNER: N0
// The canonical inputs every importer and adapter hands to the writers (SPEC §12.3, contract shapes
// `CanonicalDocument`, `CanonicalRelationship`, `CanonicalAnnotation`), with the reference's shape rules
// (contracts.mjs refine functions) as `violations()`.

import ScrollsCore

// MARK: - CanonicalDocument

/// What parsers and adapters hand to DocumentWriter: one record, its text, dates, tags and verbatim source metadata.
public struct CanonicalDocument: Sendable, Codable, Equatable {
  public var extId: String
  /// `vocab.DOC_KINDS`
  public var kind: String
  public var title: String?
  public var nativeTitle: String?
  public var author: String?
  public var genre: String?
  public var community: String?
  public var culture: String?
  public var field: String?
  public var langDeclared: String?
  public var sourceUrl: String?
  public var license: String?
  public var prominence: Double?
  public var text: CanonicalText?
  /// Metadata text fields, verbatim.
  public var fields: CanonicalFields?
  /// time_role per field (`summary: 'describes'`, `abstract: 'document'`).
  public var fieldRoles: CanonicalFieldRoles?
  public var dates: [CanonicalDate]
  public var aliases: [CanonicalAlias]?
  public var tags: [CanonicalTag]?
  /// The verbatim source record (bulk text replaced by a pointer). Kept verbatim in the atlas (IOS-SPEC §0.2).
  public var originalMeta: JSONValue
  public var sourceFile: SourceFileSpan?

  public init(extId: String, kind: String, title: String? = nil, nativeTitle: String? = nil, author: String? = nil,
              genre: String? = nil, community: String? = nil, culture: String? = nil, field: String? = nil,
              langDeclared: String? = nil, sourceUrl: String? = nil, license: String? = nil, prominence: Double? = nil,
              text: CanonicalText? = nil, fields: CanonicalFields? = nil, fieldRoles: CanonicalFieldRoles? = nil,
              dates: [CanonicalDate], aliases: [CanonicalAlias]? = nil, tags: [CanonicalTag]? = nil,
              originalMeta: JSONValue, sourceFile: SourceFileSpan? = nil) {
    self.extId = extId
    self.kind = kind
    self.title = title
    self.nativeTitle = nativeTitle
    self.author = author
    self.genre = genre
    self.community = community
    self.culture = culture
    self.field = field
    self.langDeclared = langDeclared
    self.sourceUrl = sourceUrl
    self.license = license
    self.prominence = prominence
    self.text = text
    self.fields = fields
    self.fieldRoles = fieldRoles
    self.dates = dates
    self.aliases = aliases
    self.tags = tags
    self.originalMeta = originalMeta
    self.sourceFile = sourceFile
  }

  /// The reference's shape rules: at most one chronology date, raw or parsed on every date, text bounds and regions
  /// inside the original (UTF-16 offsets, D4). Empty when the document is well-formed.
  public func violations() -> [String] {
    var e: [String] = []
    if dates.filter({ $0.isChronology == true }).count > 1 { e.append("at most one date may be the chronology") }
    for d in dates where d.raw == nil && d.parsed == nil { e.append("date '\(d.role)' needs raw or parsed") }
    if let t = text {
      let n = t.original.utf16.count
      let bs = t.bodyStart ?? 0, be = t.bodyEnd ?? n
      if !(bs >= 0 && bs <= be && be <= n) { e.append("text body bounds outside the original") }
      for r in t.regions ?? [] where !(r.start >= 0 && r.start <= r.end && r.end <= n) {
        e.append("region \(r.start)–\(r.end) outside the original")
      }
    }
    return e
  }
}

/// A document's full text: the decoded original and how it was decoded.
public struct CanonicalText: Sendable, Codable, Equatable {
  public var original: String
  /// 'utf-8' | 'windows-1252' | 'pages-joined-ff'
  public var decoder: String
  public var bodyStart: Int?
  public var bodyEnd: Int?
  public var regions: [TextRegion]?
  /// 'auto' | 'prose' | 'verse'
  public var mode: String?

  public init(original: String, decoder: String, bodyStart: Int? = nil, bodyEnd: Int? = nil, regions: [TextRegion]? = nil,
              mode: String? = nil) {
    self.original = original
    self.decoder = decoder
    self.bodyStart = bodyStart
    self.bodyEnd = bodyEnd
    self.regions = regions
    self.mode = mode
  }
}

/// A region of the original with its quality, time role or field class.
public struct TextRegion: Sendable, Codable, Equatable {
  public var start: Int
  public var end: Int
  public var quality: String?
  public var timeRole: String?
  public var fieldClass: String?
  public init(start: Int, end: Int, quality: String? = nil, timeRole: String? = nil, fieldClass: String? = nil) {
    self.start = start
    self.end = end
    self.quality = quality
    self.timeRole = timeRole
    self.fieldClass = fieldClass
  }
}

/// Metadata text fields, verbatim.
public struct CanonicalFields: Sendable, Codable, Equatable {
  public var title: String?
  public var nativeTitle: String?
  public var summary: String?
  public var abstract: String?
  public var gloss: String?
  public var entry: String?
  public init(title: String? = nil, nativeTitle: String? = nil, summary: String? = nil, abstract: String? = nil,
              gloss: String? = nil, entry: String? = nil) {
    self.title = title
    self.nativeTitle = nativeTitle
    self.summary = summary
    self.abstract = abstract
    self.gloss = gloss
    self.entry = entry
  }
}

/// time_role per metadata field: 'describes' or 'document'.
public struct CanonicalFieldRoles: Sendable, Codable, Equatable {
  public var summary: String?
  public var abstract: String?
  public init(summary: String? = nil, abstract: String? = nil) {
    self.summary = summary
    self.abstract = abstract
  }
}

/// One date assertion of a record: its role, the raw text and/or the parse, who asserted it.
public struct CanonicalDate: Sendable, Codable, Equatable {
  /// `vocab.DATE_ROLES`
  public var role: String
  public var raw: String?
  public var parsed: DateParse?
  public var assertedBy: String
  public var isChronology: Bool?
  public var note: String?
  public init(role: String, raw: String? = nil, parsed: DateParse? = nil, assertedBy: String, isChronology: Bool? = nil,
              note: String? = nil) {
    self.role = role
    self.raw = raw
    self.parsed = parsed
    self.assertedBy = assertedBy
    self.isChronology = isChronology
    self.note = note
  }
}

/// Another id of the same record.
public struct CanonicalAlias: Sendable, Codable, Equatable {
  public var extId: String
  public var title: String?
  public var note: String?
  public init(extId: String, title: String? = nil, note: String? = nil) {
    self.extId = extId
    self.title = title
    self.note = note
  }
}

/// A tag with its provenance and method (`vocab.TAG_SCHEMES`, `vocab.TAG_PROVENANCE`).
public struct CanonicalTag: Sendable, Codable, Equatable {
  public var scheme: String
  public var value: String
  public var weight: Double?
  public var provenance: String
  public var method: String
  public init(scheme: String, value: String, weight: Double? = nil, provenance: String, method: String) {
    self.scheme = scheme
    self.value = value
    self.weight = weight
    self.provenance = provenance
    self.method = method
  }
}

/// Where in the staged source file the record came from.
public struct SourceFileSpan: Sendable, Codable, Equatable {
  public var sha256: String
  public var byteStart: Int
  public var byteEnd: Int
  public init(sha256: String, byteStart: Int, byteEnd: Int) {
    self.sha256 = sha256
    self.byteStart = byteStart
    self.byteEnd = byteEnd
  }
}

// MARK: - CanonicalRelationship

/// An end of a canonical relationship: a record of a collection by ext_id, or a typed ref.
public struct CanonicalEndpoint: Sendable, Codable, Equatable {
  public var collection: String?
  public var extId: String?
  public var ref: String?
  public init(collection: String? = nil, extId: String? = nil, ref: String? = nil) {
    self.collection = collection
    self.extId = extId
    self.ref = ref
  }
}

/// A hypothesis group a relationship joins, by key.
public struct CanonicalHypothesisGroup: Sendable, Codable, Equatable {
  public var key: String
  public var question: String
  public init(key: String, question: String) {
    self.key = key
    self.question = question
  }
}

/// An evidence span of a canonical relationship.
public struct CanonicalEvidence: Sendable, Codable, Equatable {
  public var role: String
  public var extId: String?
  /// A passage id, or a passage locator of the source (verbatim).
  public var passage: JSONValue?
  public var start: Int?
  public var end: Int?
  public var quote: String?
  public init(role: String, extId: String? = nil, passage: JSONValue? = nil, start: Int? = nil, end: Int? = nil,
              quote: String? = nil) {
    self.role = role
    self.extId = extId
    self.passage = passage
    self.start = start
    self.end = end
    self.quote = quote
  }
}

/// A relationship as importers, adapters and algorithms hand it to the writer. Its evidence status is bound to its
/// origin (D7): documented ⇔ source_dataset, computed ⇔ algorithm, proposed ⇐ machine tagger or human.
public struct CanonicalRelationship: Sendable, Codable, Equatable {
  public var src: CanonicalEndpoint
  public var dst: CanonicalEndpoint
  public var relType: String
  public var evidenceStatus: String
  public var origin: String
  public var sourceDataset: String?
  public var sourceLocator: String?
  public var provenanceQuality: String?
  public var method: String?
  public var runId: RunID?
  public var createdBy: String
  public var score: Score?
  public var hypothesisGroup: CanonicalHypothesisGroup?
  public var evidence: [CanonicalEvidence]?
  public var license: String?
  public var attribution: String?
  public var provenanceNote: String?

  public init(src: CanonicalEndpoint, dst: CanonicalEndpoint, relType: String, evidenceStatus: String, origin: String,
              sourceDataset: String? = nil, sourceLocator: String? = nil, provenanceQuality: String? = nil,
              method: String? = nil, runId: RunID? = nil, createdBy: String, score: Score? = nil,
              hypothesisGroup: CanonicalHypothesisGroup? = nil, evidence: [CanonicalEvidence]? = nil, license: String? = nil,
              attribution: String? = nil, provenanceNote: String? = nil) {
    self.src = src
    self.dst = dst
    self.relType = relType
    self.evidenceStatus = evidenceStatus
    self.origin = origin
    self.sourceDataset = sourceDataset
    self.sourceLocator = sourceLocator
    self.provenanceQuality = provenanceQuality
    self.method = method
    self.runId = runId
    self.createdBy = createdBy
    self.score = score
    self.hypothesisGroup = hypothesisGroup
    self.evidence = evidence
    self.license = license
    self.attribution = attribution
    self.provenanceNote = provenanceNote
  }

  /// The reference's `relationshipRules` (rule 5, D7) plus "each end names an ext_id or a ref". Empty when valid.
  public func violations() -> [String] {
    var e = RelationshipRules.violations(evidenceStatus: evidenceStatus, origin: origin, sourceDataset: sourceDataset,
                                         sourceLocator: sourceLocator, provenanceQuality: provenanceQuality, runId: runId,
                                         method: method, createdBy: createdBy, relType: relType)
    if src.extId == nil && src.ref == nil { e.append("src needs ext_id or ref") }
    if dst.extId == nil && dst.ref == nil { e.append("dst needs ext_id or ref") }
    return e
  }
}

/// The DB CHECKs binding evidence status to origin, as contracts.mjs `relationshipRules` states them.
public enum RelationshipRules {
  public static func violations(evidenceStatus st: String, origin: String, sourceDataset: String?, sourceLocator: String?,
                                provenanceQuality: String?, runId: RunID?, method: String?, createdBy: String?,
                                relType: String?) -> [String] {
    var e: [String] = []
    if st == "documented" {
      if origin != "source_dataset" { e.append("documented requires origin 'source_dataset' (got '\(origin)')") }
      if (sourceDataset ?? "").isEmpty { e.append("documented requires source_dataset") }
      if (sourceLocator ?? "").isEmpty && provenanceQuality != "source_unrecorded" {
        e.append("documented requires source_locator or provenance_quality 'source_unrecorded'")
      }
    }
    if origin == "source_dataset" && st != "documented" { e.append("origin 'source_dataset' must be documented") }
    if st == "computed" && origin != "algorithm" { e.append("computed requires origin 'algorithm'") }
    if origin == "algorithm" && (runId == nil || (method ?? "").isEmpty) { e.append("origin 'algorithm' requires run_id and method") }
    if (origin == "machine_tagger" || origin == "human") && st != "proposed" { e.append("origin '\(origin)' must be proposed") }
    if origin == "machine_tagger" && (method ?? "").isEmpty { e.append("origin 'machine_tagger' requires method") }
    if origin == "human", let createdBy, !createdBy.hasPrefix("human:") { e.append("origin 'human' requires created_by 'human:<name>'") }
    if let relType, !Vocab.relTypeByCode.contains(key: relType) { e.append("unknown rel_type '\(relType)'") }
    return e
  }
}

// MARK: - CanonicalAnnotation

/// The target of a canonical annotation: a record by ext_id, or a typed ref.
public struct CanonicalAnnotationTarget: Sendable, Codable, Equatable {
  public var type: String
  public var extId: String?
  public var ref: String?
  public init(type: String, extId: String? = nil, ref: String? = nil) {
    self.type = type
    self.extId = extId
    self.ref = ref
  }
}

/// A span of the target document's field.
public struct CanonicalAnchor: Sendable, Codable, Equatable {
  public var field: String
  public var start: Int
  public var end: Int
  public var quote: String
  public init(field: String, start: Int, end: Int, quote: String) {
    self.field = field
    self.start = start
    self.end = end
    self.quote = quote
  }
}

/// An annotation as importers, adapters and machine taggers hand it to the writer.
public struct CanonicalAnnotation: Sendable, Codable, Equatable {
  public var target: CanonicalAnnotationTarget
  public var anchor: CanonicalAnchor?
  public var kind: String
  public var author: String
  public var isMachine: Bool
  public var method: String?
  public var runId: RunID?
  public var layer: String?
  public var bodyMd: String
  public var stance: String?
  public var dimensions: JSONValue?
  public var tags: [String]?
  public var evidenceRefs: JSONValue?
  public var supersedesKey: String?

  public init(target: CanonicalAnnotationTarget, anchor: CanonicalAnchor? = nil, kind: String, author: String,
              isMachine: Bool, method: String? = nil, runId: RunID? = nil, layer: String? = nil, bodyMd: String,
              stance: String? = nil, dimensions: JSONValue? = nil, tags: [String]? = nil, evidenceRefs: JSONValue? = nil,
              supersedesKey: String? = nil) {
    self.target = target
    self.anchor = anchor
    self.kind = kind
    self.author = author
    self.isMachine = isMachine
    self.method = method
    self.runId = runId
    self.layer = layer
    self.bodyMd = bodyMd
    self.stance = stance
    self.dimensions = dimensions
    self.tags = tags
    self.evidenceRefs = evidenceRefs
    self.supersedesKey = supersedesKey
  }

  /// Passage and occurrence targets need an anchor; machine annotations need a method. Empty when valid.
  public func violations() -> [String] {
    var e: [String] = []
    if (target.type == "passage" || target.type == "occurrence") && anchor == nil { e.append("a \(target.type) target needs an anchor") }
    if isMachine && (method ?? "").isEmpty { e.append("machine annotations need a method") }
    return e
  }
}
