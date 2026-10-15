// OWNER: N1
// Port of store/document-writer.mjs (passages part): the body is tokenized once and segmented (`seg-1`), every
// passage gets its language, and passages go into `passage` and `passage_fts` (the u61m-1 norms joined by ' ': FTS
// token i = tokenizer token i), with doc_tokens over quality 'ok' passages. Also the FTS bulk-load mode (§4.4): automerge
// off while loading many documents, then on again with incremental 'merge' steps instead of one 'optimize' (ΔS-19).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One passage before it is written (the reference's passage object).
struct PassageDraft {
  var field: String
  var start: Int
  var end: Int
  var unit: String
  var pageNo: Int?
  var quality: String
  var timeRole: String
  var fieldClass: String
  var tokenCount: Int
  var tokens: [String]
  var lang: String
  var confidence: Double
}

/// The body passages of a document, its body tokens and its code units.
struct Body {
  var passages: [PassageDraft]
  var bodyTokens: [String]
  var units: [UInt16]
}

/// Tokens, passages and languages of a document as the writer computes them (shared with the dry run's projector, so
/// both see the same passages, token counts and languages).
struct PassageBuilder {
  let interner: TokenInterner
  let detectLanguage: Bool

  /// The tokens of a text through the interner (each distinct raw form folded once).
  func tokenize(_ units: [UInt16]) -> (norms: [String], starts: [Int32], ends: [Int32]) {
    var spans: [TokenSpan] = []
    spans.reserveCapacity(units.count / 5)
    units.withUnsafeBufferPointer { Tokenizer.spans($0, interner: interner, into: &spans) }
    return (spans.map { interner.norm($0.norm) }, spans.map(\.start), spans.map(\.end))
  }

  /// `langOf(tokens, slice, declared)`.
  func langOf(_ tokens: [String], _ slice: ArraySlice<UInt16>, _ declared: String?) -> (lang: String, confidence: Double) {
    if !detectLanguage { return (declared ?? "und", declared != nil ? 1 : 0) }
    let g = LangID.detect(tokens: tokens, declared: declared, script: LangID.scriptOf(units: slice))
    return (g.lang, g.confidence)
  }

  /// `bodyPassages(doc)`.
  func bodyPassages(_ doc: CanonicalDocument, _ t: CanonicalText) -> Body {
    let units = Array(t.original.utf16)
    let tok = tokenize(units)
    let start = t.bodyStart ?? 0, end = t.bodyEnd ?? units.count
    let segs = Segmenter.segment(units: units, starts: tok.starts, ends: tok.ends, mode: t.mode ?? "auto", lang: doc.langDeclared,
                                 regions: t.regions ?? [], start: start, end: end)
    let index = Segmenter.TokenIndex(starts: tok.starts, ends: tok.ends)
    let passages = segs.map { s -> PassageDraft in
      let i0 = index.lowerBound(s.start), i1 = index.lowerBound(s.end)
      let tokens = Array(tok.norms[i0..<i1])
      let l = langOf(tokens, units[s.start..<s.end], doc.langDeclared)
      return PassageDraft(field: "body", start: s.start, end: s.end, unit: s.unit, pageNo: s.pageNo, quality: s.quality,
                          timeRole: s.timeRole, fieldClass: s.fieldClass, tokenCount: s.tokenCount, tokens: tokens, lang: l.lang,
                          confidence: l.confidence)
    }
    let b0 = index.lowerBound(start), b1 = index.lowerBound(end)
    return Body(passages: passages, bodyTokens: Array(tok.norms[b0..<b1]), units: units)
  }

  /// `fieldPassages(doc, fields)`.
  func fieldPassages(_ doc: CanonicalDocument, _ fields: [(String, String)]) -> [PassageDraft] {
    fields.filter { !$0.1.isEmpty }.map { field, value in
      let units = Array(value.utf16)
      let tokens = tokenize(units).norms
      let fc = DocumentWriter.fieldClassOf(field, doc.fieldRoles)
      let l = langOf(tokens, units[...], doc.langDeclared)
      return PassageDraft(field: field, start: 0, end: units.count, unit: "field", pageNo: nil, quality: "ok", timeRole: fc.timeRole,
                          fieldClass: fc.fieldClass, tokenCount: tokens.count, tokens: tokens, lang: l.lang, confidence: l.confidence)
    }
  }
}

extension DocumentWriter {
  var passageBuilder: PassageBuilder { PassageBuilder(interner: interner, detectLanguage: options.detectLanguage) }

  /// The tokens of a text through the writer's interner (each distinct raw form folded once).
  func tokenize(_ units: [UInt16]) -> (norms: [String], starts: [Int32], ends: [Int32]) { passageBuilder.tokenize(units) }

  /// `bodyPassages(doc)`.
  func bodyPassages(_ doc: CanonicalDocument, _ t: CanonicalText) -> Body { passageBuilder.bodyPassages(doc, t) }

  /// `fieldClassOf(field, roles)`.
  static func fieldClassOf(_ field: String, _ roles: CanonicalFieldRoles?) -> (fieldClass: String, timeRole: String) {
    switch field {
    case "title", "native_title": return ("title", "document")
    case "summary": return (roles?.summary ?? "describes") == "document" ? ("text", "document") : ("describes", "describes")
    case "abstract": return (roles?.abstract ?? "document") == "describes" ? ("describes", "describes") : ("abstract", "document")
    default: return ("describes", "describes")  // gloss, entry: written later, about the item
    }
  }

  /// `fieldPassages(doc, fields)`.
  func fieldPassages(_ doc: CanonicalDocument, _ fields: [(String, String)]) -> [PassageDraft] { passageBuilder.fieldPassages(doc, fields) }

  /// Writes the passages, their FTS rows and doc_tokens; returns the rows written.
  func writePassages(document id: Int64, _ passages: [PassageDraft], yLo: Int?, yHi: Int?, _ tx: WriteTx) throws -> Int {
    let c = tx.connection
    let insPassage = try c.prepared(IngestSQL.insertPassage)
    let insFTS = try c.prepared(IngestSQL.insertFTS)
    var ords: [String: Int] = [:]
    var okOrder: [String] = []
    var ok: [String: (lang: String, fieldClass: String, tokens: Int, passages: Int)] = [:]
    var rows = 0
    for p in passages {
      let ord = (ords[p.field] ?? -1) + 1
      ords[p.field] = ord
      let pid = try tx.ids.next("passage", scope)
      try insPassage.bind([.int(pid), .int(id), .int(Int64(ord)), .text(p.field), .text(p.fieldClass), .text(p.timeRole), .text(p.unit),
                           .text(p.quality), .int(Int64(p.start)), .int(Int64(p.end)), .integer(p.pageNo), .text(p.lang),
                           .double(p.confidence), .int(Int64(p.tokenCount)), .integer(yLo), .integer(yHi), .int(synthetic)])
      try insPassage.run()
      try insFTS.bind(.int(pid), .text(p.tokens.joined(separator: " ")))
      try insFTS.run()
      rows += 2
      if p.quality == "ok" {
        let k = "\(p.lang)\u{0}\(p.fieldClass)"
        if ok[k] == nil {
          okOrder.append(k)
          ok[k] = (p.lang, p.fieldClass, 0, 0)
        }
        ok[k]!.tokens += p.tokenCount
        ok[k]!.passages += 1
      }
    }
    let insTokens = try c.prepared(IngestSQL.insertDocTokens)
    for k in okOrder {
      let t = ok[k]!
      try insTokens.bind(.int(id), .text(t.lang), .text(t.fieldClass), .int(Int64(t.tokens)), .int(Int64(t.passages)))
      try insTokens.run()
      rows += 1
    }
    return rows
  }
}

/// The FTS bulk-load mode of a long load (`setFtsBulkLoad`).
public enum FTSWriter {
  /// Automerge off while loading many documents.
  public static func beginBulkLoad(_ c: Connection) throws { try c.prepared(IngestSQL.ftsAutomergeOff).run() }

  /// Automerge back on; then incremental merge steps (each a bounded amount of work, so no statement runs long)
  /// until a step merges nothing. The reference runs one 'optimize'; the phone never does (ΔS-19).
  public static func endBulkLoad(_ c: Connection, step pages: Int = 500, maxSteps: Int = 10_000) throws {
    try c.prepared(IngestSQL.ftsAutomergeOn).run()
    for _ in 0..<maxSteps {
      let before = try c.prepared(IngestSQL.totalChanges).first { $0.int(0) } ?? 0
      let s = try c.prepared(IngestSQL.ftsMerge)
      try s.bind(.int(Int64(-pages)))
      try s.run()
      let after = try c.prepared(IngestSQL.totalChanges).first { $0.int(0) } ?? 0
      if after - before <= 1 { break }
    }
  }
}
