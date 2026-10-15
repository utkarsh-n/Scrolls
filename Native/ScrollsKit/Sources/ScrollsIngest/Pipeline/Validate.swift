// OWNER: N1
// Port of server/ingest/validate.mjs (SPEC §5.2 step 3, §5.5): the static checks of a mapping, and the dry-run
// projector. The projector has DocumentWriter's interface and repeats its per-document computation — the same
// tokenizer, segmenter and language identifier (PassageBuilder), the same duplicate rules — without writing anything,
// so the projected summary has the commit's numbers. It reads the atlas (read-only) for what an import is compared
// against: existing ids, texts and signatures. Two checks are approximate and say so in `notes`: near duplicates of
// files over 15 M characters are left to the commit, and nothing about the atlas can change between the dry run and the
// commit.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A mapping problem that makes it unusable (400 E_MAPPING_INVALID) — `{target, message, hint, from}`.
public typealias MappingProblem = MappingError

/// What `validateMapping` gives.
public struct MappingValidation: Sendable {
  public var mapping: Mapping
  public var errors: [MappingError]
  public var warnings: [Issue]
}

/// Where a pipeline's records go: DocumentWriter at commit (through `WriterSession`), the projector in the dry run.
/// Synchronous: a session runs inside one write transaction, the projector inside one read.
public protocol ImportSink: AnyObject {
  func addIssue(_ issue: Issue) throws
  /// The document's id (nil when it was rejected) and its issues.
  func addDocument(_ doc: CanonicalDocument, line: Int?) throws -> DocumentWriteResult
  func addRelationship(_ rel: CanonicalRelationship) throws
}

public enum Validate {
  /// Above this many characters of file text, near duplicates are checked at commit only.
  public static let nearDupDryRunChars = 15 * 1024 * 1024

  /// `validateMapping(mapping, {columns, format})`: `errors` make the mapping unusable; `warnings` are shown with the dry
  /// run. `columns` nil = do not check the columns.
  public static func validateMapping(_ raw: JSValue?, columns: [String]?, format: String?) -> MappingValidation {
    var (m, errors) = MappingRules.normalize(raw)
    var warnings: [Issue] = []
    let fmt = format ?? (m.format.isEmpty ? nil : m.format)
    let strictColumns = columns != nil && ["csv", "tsv", "txt", "md"].contains(fmt ?? "")
    func hasColumn(_ s: String) -> Bool { columns?.contains { JSString.equal($0, s) } ?? false }
    for (target, spec) in m.fields {
      guard let from = spec.from else { continue }
      switch from {
      case .number(let n):
        if n != n.rounded(.towardZero) || n < 1 || (columns.map { n > Double($0.count) } ?? false) {
          errors.append(MappingError(target: target, message: "Target '\(target)' maps to column number \(JSNumber.format(n)), which the file does not have.",
                                     hint: columns.map { "The file has \($0.count) columns." } ?? "Column numbers start at 1.", from: from))
        }
      case .string(let s):
        if strictColumns && !hasColumn(s) {
          errors.append(MappingError(target: target, message: "Target '\(target)' maps to column '\(s)', which the file does not have.",
                                     hint: "Pick a column from the preview.", from: from))
        } else if columns != nil && !hasColumn(s) && !s.hasPrefix("/") {
          warnings.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: nil, col: nil, field: s, valueExcerpt: nil,
            message: "Target '\(target)' reads '\(s)', which none of the sampled records has.",
            suggestion: "Check the spelling; records without that key leave the target empty."))
        }
      default:
        if from.isNull { continue }  // `from: null` with a constant
        errors.append(MappingError(target: target, message: "Target '\(target)': 'from' must be a column name, a column number or a JSON Pointer.",
                                   hint: "Pick a column from the preview.", from: from))
      }
    }
    if m.field("text") == nil && m.field("title") == nil {
      errors.append(MappingError(target: "text", message: "Neither text nor title is mapped, so every row would be rejected (E_MISSING_TEXT).",
                                 hint: "Map a text column, or a title for metadata-only records.", from: nil))
    }
    if let c = m.field("collection") {
      let slug = m.collection?["slug"].flatMap { MappingRules.isTruthy($0) ? JSText.string($0) : nil }
      warnings.append(Issue(code: "E_FIELD_TYPE", severity: "info", line: nil, col: nil, field: c.from.map(JSText.string) ?? "collection", valueExcerpt: nil,
        message: "Per-row collections are not supported yet: every row goes into '\(slug ?? "the chosen collection")'; the row's value is kept in its metadata.",
        suggestion: "Import each collection as its own file, or keep the value as metadata."))
    }
    if let e = m.field("date_end"), m.field("date") == nil {
      warnings.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: nil, col: nil, field: e.from.map(JSText.string) ?? "date_end", valueExcerpt: nil,
        message: "An end date is mapped without a start date; rows will be undated.", suggestion: "Map the start date as well."))
    }
    if let c = m.collection, let slugV = c["slug"], MappingRules.isTruthy(slugV) {
      let given = JSText.string(slugV)
      let slug = IDs.slug(given)
      if !JSString.equal(slug, given) {
        errors.append(MappingError(target: nil, message: "Collection slug '\(given)' is not a slug (try '\(slug)').",
                                   hint: "Use lower-case letters, digits and hyphens.", from: nil))
      }
      if let u = c["unit"], !u.isNull, u.stringValue != "tokens" && u.stringValue != "works" {
        errors.append(MappingError(target: nil, message: "Collection unit '\(JSText.string(u))' is not 'tokens' or 'works'.",
                                   hint: "Use 'tokens' for texts and 'works' for title lists.", from: nil))
      }
      if let n = c["name"], !n.isNull, n.stringValue == nil {
        errors.append(MappingError(target: nil, message: "Collection name must be text.", hint: "Type a name.", from: nil))
      }
      if let l = c["license"], !l.isNull, l.stringValue == nil {
        errors.append(MappingError(target: nil, message: "Collection licence must be text.",
                                   hint: "Type the licence, e.g. \"own\" or \"CC BY 4.0\".", from: nil))
      }
    } else {
      errors.append(MappingError(target: nil, message: "The mapping names no collection.", hint: "Give the collection a name in the upload step.", from: nil))
    }
    for (k, _) in m.fields where MappingRules.targets[k] == nil && !k.hasPrefix("meta.") {
      errors.append(MappingError(target: k, message: "'\(k)' is not a target field.", hint: "See Docs/IMPORT-SCHEMA.md.", from: nil))
    }
    m.format = fmt ?? m.format
    return MappingValidation(mapping: m, errors: errors, warnings: warnings)
  }
}

/// The dry-run sink (`createProjector(db, {collectionSlug, options, textChars, onIssue})`): nothing is written; every
/// issue goes to `onIssue` (the pipeline streams them to the dry run's problems.csv).
public final class Projector: ImportSink {
  static let chronoRoles = DocumentWriter.chronoRoles
  static let scanLangClasses = DocumentWriter.scanLangClasses
  static let issuesKept = 20

  let c: Connection?
  let collectionSlug: String
  let dedupe: String
  let detectLanguage: Bool
  let collectionID: Int64?
  let nearDupOn: Bool
  public private(set) var notes: [String] = []
  var tally = Tally()
  var shaSeen: [String: Int?] = [:]
  var metaSeen: [String: Int?] = [:]
  var metaDB: [String: Int64]?
  let near = Dedupe.NearDupIndex()
  var nearLoaded = false
  var accepted = Set<UnitKey>()
  var pendingRels: [CanonicalRelationship] = []
  var seq = 0
  let onIssue: ((Issue) -> Void)?
  let builder: PassageBuilder
  var targetsSyntheticCache: Bool?

  public init(_ c: Connection?, collection: String, dedupe: String = "flag", detectLanguage: Bool = true, textChars: Int = 0,
              onIssue: ((Issue) -> Void)? = nil) throws {
    self.c = c
    self.collectionSlug = collection
    self.dedupe = dedupe
    self.detectLanguage = detectLanguage
    self.onIssue = onIssue
    self.collectionID = try c.flatMap { try $0.prepared(ImportSQL.collectionIDBySlug).bindingFirst([.text(collection)]) { $0.int(0) } }
    self.nearDupOn = dedupe != "off" && textChars <= Validate.nearDupDryRunChars
    if dedupe != "off" && !nearDupOn {
      notes.append("Near-duplicate texts (W_NEAR_DUP) are checked at commit only for files over 15 M characters; they are not counted in this projection.")
    }
    builder = PassageBuilder(interner: TokenInterner(), detectLanguage: detectLanguage)
  }

  /// The counts so far (`counts()`).
  public var counts: JSONValue { tally.json }

  /// `recordIssue(issue)` of the projector (its own defaults: the suggestion is the issue's or a generic one).
  @discardableResult
  func record(_ i: Issue, vars: JSONObject = [:]) -> Issue {
    let def = Vocab.issueCodes[i.code]
    let full = Issue(code: i.code, severity: i.severity.isEmpty ? def?.severity ?? "warning" : i.severity, line: i.line, col: i.col,
                     field: i.field, valueExcerpt: DocumentWriter.excerpt(i.valueExcerpt),
                     message: !i.message.isEmpty ? i.message : def.map { Vocab.fillTemplate($0.template, vars) } ?? i.code,
                     suggestion: !i.suggestion.isEmpty ? i.suggestion : "See the message for what to change.")
    tally.issuesTotal += 1
    tally.issuesByCode.add(full.code)
    if tally.issuesFirst.count < Projector.issuesKept { tally.issuesFirst.append(full) }
    onIssue?(full)
    return full
  }

  public func addIssue(_ issue: Issue) throws { record(issue) }

  func reject(_ issues: inout [Issue], _ i: Issue, vars: JSONObject = [:]) -> DocumentWriteResult {
    var r = i
    r.severity = "rejected"
    issues.append(record(r, vars: vars))
    tally.documents["rejected", default: 0] += 1
    return DocumentWriteResult(document: nil, issues: issues)
  }

  public func addDocument(_ doc: CanonicalDocument, line: Int?) throws -> DocumentWriteResult {
    var issues: [Issue] = []
    let errs = CanonicalCheck.document(doc)
    if !errs.isEmpty {
      return reject(&issues, Issue(code: "E_FIELD_TYPE", severity: "rejected", line: line, valueExcerpt: doc.extId,
        message: "Record \(doc.extId) does not match the document contract: \(errs.prefix(3).joined(separator: "; "))", suggestion: ""))
    }
    if let t = doc.text, t.original.utf16.count > DocumentWriter.maxTextChars {
      let size = JSNumber.toFixed(Double(t.original.utf16.count) / 1_048_576, 1) + " M characters"
      return reject(&issues, Issue(code: "E_ROW_TOO_LARGE", severity: "rejected", line: line, field: "text", valueExcerpt: doc.extId, message: "", suggestion: ""),
                    vars: ["line": line.map { .number(Double($0)) } ?? .string(doc.extId), "field": "text", "size": .string(size)])
    }
    return try project(doc, line: line, &issues)
  }

  public func addRelationship(_ rel: CanonicalRelationship) throws { pendingRels.append(rel) }

  // MARK: one document

  func project(_ doc: CanonicalDocument, line: Int?, _ issues: inout [Issue]) throws -> DocumentWriteResult {
    let ctx = DateContext(now: DayMath.today())
    let assertions = doc.dates.map { d -> CanonicalDate in
      var a = d
      if a.parsed == nil {
        let r = DateGrammar.parse(d.raw, context: ctx)
        a.parsed = r.issue != nil ? nil : r
      }
      return a
    }
    let chrono = assertions.first { $0.isChronology == true } ?? assertions.first { Projector.chronoRoles.contains($0.role) }
    let cp: DateParse? = chrono?.parsed.flatMap { $0.loDay != nil ? $0 : nil }
    let chronoStatus = cp == nil ? "undated" : cp!.basis == "announced" ? "scheduled" : "dated"

    var fields: [(String, String)] = []
    if let f = doc.fields {
      fields = [("title", f.title), ("native_title", f.nativeTitle), ("summary", f.summary), ("abstract", f.abstract),
                ("gloss", f.gloss), ("entry", f.entry)].compactMap { k, v in v.map { (k, $0) } }
    }
    if doc.text == nil && !fields.contains(where: { !$0.1.isEmpty }), let t = doc.title, !t.isEmpty {
      if let k = fields.firstIndex(where: { $0.0 == "title" }) { fields[k].1 = t } else { fields.insert(("title", t), at: 0) }
    }
    let body = doc.text.map { builder.bodyPassages(doc, $0) } ?? Body(passages: [], bodyTokens: [], units: [])
    let passages = body.passages + builder.fieldPassages(doc, fields)

    let langPassages = passages.filter { Projector.scanLangClasses.contains($0.fieldClass) && $0.quality == "ok" }
      .map { (lang: $0.lang, tokens: $0.tokenCount, confidence: Optional($0.confidence)) }
    let dl = detectLanguage ? LangID.documentLang(langPassages, declared: doc.langDeclared)
      : DocumentLanguage(langText: doc.langDeclared ?? "und", confidence: doc.langDeclared != nil ? 1 : 0, isTranslation: false, share: 0, byLang: [])
    if dl.isTranslation {
      issues.append(record(Issue(code: "W_LANG_MISMATCH", severity: "", line: line, field: "lang_declared", valueExcerpt: doc.langDeclared,
        message: "", suggestion: "Nothing to do if this is a translation (excluded from text-language chronology by default); otherwise correct the declared language."),
        vars: ["declared": .string(doc.langDeclared ?? ""), "detected": .string(dl.langText),
               "scores": .string(dl.byLang.map { "\($0.lang) \(JSNumber.toFixed($0.share, 2))" }.joined(separator: " / "))]))
    }
    let detected = dl.byLang.filter { !$0.lang.hasPrefix("und") }
    if detected.count > 1 && detected[1].share >= 0.15 {
      issues.append(record(Issue(code: "W_MIXED_LANGUAGE", severity: "", line: line, message: "",
        suggestion: "Nothing to do: lanes split by passage language."),
        vars: ["title": .string(doc.title ?? doc.extId),
               "mix": .string(detected.map { "\($0.lang) (\(JSNumber.format(JSNumber.round($0.share * 100)))%)" }.joined(separator: " and "))]))
    }

    let textSha: String? = body.bodyTokens.isEmpty ? nil : TextDigest.sha256Hex(utf8: body.bodyTokens.joined(separator: " "))
    var dup: String?
    if let textSha, dedupe != "off" {
      if let l = shaSeen[textSha] {
        dup = "the row on line \(l.map(String.init) ?? "null")"
      } else if let c, let d = try c.prepared(ImportSQL.textShaLive).bindingFirst([.text(textSha)], { $0.int(0) }) {
        dup = "document \(d)"
      }
      if let dup {
        if dedupe == "skip" {
          return reject(&issues, Issue(code: "W_DUP_CONTENT", severity: "rejected", line: line, valueExcerpt: doc.extId,
            message: "\(doc.extId): same text as \(dup); skipped (dedupe = skip).", suggestion: "Set duplicates to \"flag\" to keep both, excluded from counts."))
        }
        issues.append(record(Issue(code: "W_DUP_CONTENT", severity: "", line: line, valueExcerpt: doc.extId,
          message: "Same text as \(dup); excluded from counts by default.",
          suggestion: "Keep it flagged (excluded from counts by default), or remove one of the two from the file.")))
        tally.documents["duplicates_flagged", default: 0] += 1
      } else {
        shaSeen[textSha] = .some(line)
      }
    }
    if doc.text != nil && dup == nil && nearDupOn, let sig = MinHash.signature(body.bodyTokens) {
      try loadNear()
      if let hit = near.query(sig) {
        issues.append(record(Issue(code: "W_NEAR_DUP", severity: "", line: line, valueExcerpt: doc.extId,
          message: "Nearly the same text as \(hit.label) (MinHash Jaccard \(JSNumber.toFixed(hit.j, 2))).",
          suggestion: "Choose \"keep both\" or \"mark as duplicate\" in the import summary.")))
        tally.documents["near_duplicates", default: 0] += 1
      }
      near.add("the row on line \(line.map(String.init) ?? "null")", sig)
    }
    if doc.text == nil && dedupe != "off", let title = doc.title, !title.isEmpty {
      let key = DupIndex.metaKey(title: title, author: doc.author, yLo: cp?.yLo.map(Int.init))
      if let other = try metadataDuplicate(key) {
        issues.append(record(Issue(code: "W_DUP_METADATA", severity: "", line: line, valueExcerpt: doc.title,
          message: "Same title, author and year as \(other).", suggestion: "Check whether the two records describe the same work.")))
      } else {
        metaSeen[key] = .some(line)
      }
    }

    let tokenTotal = passages.reduce(0) { $0 + $1.tokenCount }
    tally.documents["created", default: 0] += 1
    if doc.text == nil { tally.documents["metadata_only", default: 0] += 1 }
    if dl.isTranslation { tally.documents["translations", default: 0] += 1 }
    tally.passages += passages.count
    tally.tokens += tokenTotal
    tally.languages.add(dl.langText)
    let dk = chronoStatus == "undated" ? "unknown" : chronoStatus == "scheduled" ? "scheduled" : cp!.approx ? "circa" : cp!.precision
    tally.dates.add(dk)
    if chronoStatus == "dated", let cp, let lo = cp.loDay, let hi = cp.hiDay {
      if tally.spanLo == nil || Int(lo) < tally.spanLo!.day { tally.spanLo = (Int(lo), cp.label) }
      if tally.spanHi == nil || Int(hi) > tally.spanHi!.day { tally.spanHi = (Int(hi), cp.label) }
    }
    accepted.insert(UnitKey(doc.extId))
    seq += 1
    return DocumentWriteResult(document: DocumentID(rawValue: Int64(-seq)), issues: issues)
  }

  func loadNear() throws {
    if nearLoaded { return }
    nearLoaded = true
    guard let c, let coll = collectionID else { return }
    let n = try c.prepared(ImportSQL.signatureCount).bindingFirst([.int(coll)]) { $0.int(0) } ?? 0
    if n > 100_000 { return }
    for (id, sig) in try c.prepared(ImportSQL.signatures).bindingAll([.int(coll)], { ($0.int(0), MinHash.signature(bytes: $0.blob(1))) }) {
      near.add("document \(id)", sig)
    }
  }

  func metadataDuplicate(_ key: String) throws -> String? {
    if let l = metaSeen[key] { return "the row on line \(l.map(String.init) ?? "null")" }
    if metaDB == nil {
      var m: [String: Int64] = [:]
      if let c, let coll = collectionID {
        for r in try c.prepared(ImportSQL.metadataRows).bindingAll([.int(coll)], { ($0.int(0), $0.textOrNil(1), $0.textOrNil(2), $0.intOrNil(3)) }) {
          m[DupIndex.metaKey(title: r.1, author: r.2, yLo: r.3.map(Int.init))] = r.0
        }
      }
      metaDB = m
    }
    return metaDB![key].map { "document \($0)" }
  }

  // MARK: relationships

  /// A real import never links into the synthetic demo (§13 rule 1); only the demo itself may.
  func targetsSynthetic() throws -> Bool {
    if let v = targetsSyntheticCache { return v }
    var v = false
    if let c, let coll = collectionID { v = try c.prepared(ImportSQL.collectionSynthetic).bindingFirst([.int(coll)]) { $0.int(0) } == 1 }
    targetsSyntheticCache = v
    return v
  }

  static func documentRef(_ ref: String) -> Int64? {
    guard JSString.hasPrefix(ref, "document:") else { return nil }
    let digits = JSString.slice(ref, 9)
    guard !digits.isEmpty, digits.utf16.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
    return Int64(digits)
  }

  func syntheticRef(_ e: CanonicalEndpoint) throws -> Bool {
    guard let c else { return false }
    if let ref = e.ref {
      guard let id = Projector.documentRef(ref) else { return false }
      return try c.prepared(ImportSQL.documentSynthetic).bindingFirst([.int(id)]) { $0.int(0) } == 1
    }
    guard let ext = e.extId, !ext.isEmpty, let coll = e.collection, !coll.isEmpty, !JSString.equal(coll, collectionSlug) else { return false }
    return try c.prepared(ImportSQL.syntheticExtInSlug).bindingFirst([.text(coll), .text(ext)]) { _ in true } ?? false
  }

  func resolves(_ e: CanonicalEndpoint) throws -> Bool {
    if let ref = e.ref {
      guard let id = Projector.documentRef(ref), let c else { return false }
      return try c.prepared(ImportSQL.liveDocument).bindingFirst([.int(id)]) { _ in true } ?? false
    }
    guard let ext = e.extId, !ext.isEmpty else { return false }
    let slug = (e.collection?.isEmpty == false ? e.collection : nil) ?? collectionSlug
    if JSString.equal(slug, collectionSlug) && accepted.contains(UnitKey(ext)) { return true }
    guard let c else { return false }
    if JSString.equal(slug, collectionSlug) {
      guard let coll = collectionID else { return false }
      return try c.prepared(ImportSQL.extOrAliasInCollection).bindingFirst([.int(coll), .text(ext), .int(coll), .text(ext)]) { _ in true } ?? false
    }
    return try c.prepared(ImportSQL.extOrAliasInSlug).bindingFirst([.text(slug), .text(ext), .text(slug), .text(ext)]) { _ in true } ?? false
  }

  /// `finish()`: the queued relationships checked; returns `{batch_id: null, collection, …counts, data_version: null}`.
  public func finish() throws -> JSONValue {
    for rel in pendingRels {
      let srcOk = try resolves(rel.src), dstOk = try resolves(rel.dst)
      var fake: CanonicalEndpoint?
      let intoSynthetic = try targetsSynthetic()
      if srcOk && dstOk && !intoSynthetic {
        if try syntheticRef(rel.src) { fake = rel.src } else if try syntheticRef(rel.dst) { fake = rel.dst }
      }
      if let fake {
        tally.relationships["unresolved_targets", default: 0] += 1
        let isSrc = fake == rel.src
        let shown = fake.extId ?? fake.ref
        record(Issue(code: "W_SYNTHETIC_TARGET", severity: "warning", field: isSrc ? "src" : "dst", valueExcerpt: shown,
          message: "Relationship \(rel.relType): \(isSrc ? "source" : "target") '\(shown ?? "?")' is in the synthetic demo (invented material); the link was not created.",
          suggestion: "Link real records to real records only: the demo is invented material and never part of your data."))
        continue
      }
      if !srcOk || !dstOk {
        tally.relationships["unresolved_targets", default: 0] += 1
        let which = !srcOk ? rel.src : rel.dst
        let shown = which.extId ?? which.ref
        record(Issue(code: "W_UNRESOLVED_TARGET", severity: "warning", field: !srcOk ? "src" : "dst", valueExcerpt: shown,
          message: "Relationship \(rel.relType): \(!srcOk ? "source" : "target") '\(shown ?? "?")' was not found; the link was not created.",
          suggestion: "Check the target id: it must be an id in this file or this collection (or a unique id elsewhere in Scrolls)."))
        continue
      }
      tally.relationships[rel.evidenceStatus, default: 0] += 1
    }
    var o: JSONObject = ["batch_id": .null, "collection": .string(collectionSlug)]
    if case .object(let counts) = tally.json { for (k, v) in counts { o[k] = v } }
    o["data_version"] = .null
    return .object(o)
  }
}
