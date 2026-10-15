// OWNER: N3
// Ports of server/routes/passages.mjs and documents.mjs (SPEC §7.2, I2, D4): a passage with offsets into the original,
// highlights relative to its text, its document and date card, its anchor and machine annotations; an occurrence →
// its passage; document metadata (every date assertion, tags with provenance, aliases, fields) and ≤ 20,000-unit slices of
// the decoded original.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Passages, occurrences and documents.
public enum Reading {
  /// Largest slice GET /api/documents/:id/text returns.
  public static let maxTextSlice = 20_000

  // MARK: dates

  /// `documentDates(db, docId)`: every date assertion of a document but the time of import, chronology first.
  public static func documentDates(_ c: Connection, _ docId: Int64) throws -> [(row: DateRow, raw: String?, rule: String?, approx: Bool, note: String?)] {
    let s = try c.prepared(ReadSQL.documentDates)
    try s.bind([.int(docId)])
    return try s.all { r in
      let lo = r.intOrNil(1), hi = r.intOrNil(2)
      let precision = r.text(3), approx = r.int(6) == 1, rule = r.textOrNil(7), raw = r.textOrNil(8)
      let label = lo == nil ? "undated" : DateLabels.formatDateLabel(
        DateParse(loDay: Day(lo!), hiDay: Day(hi ?? lo!), yLo: nil, yHi: nil, precision: precision, basis: r.text(4), approx: approx,
                  rule: rule ?? "", raw: raw, label: "", warnings: []))
      return (DateRow(role: r.text(0), label: label, precision: precision, basis: r.text(4), assertedBy: r.text(5),
                      isChronology: r.int(9) == 1), raw, rule, approx, r.textOrNil(10))
    }
  }

  /// A document row as the date card reads it.
  struct DocFacts {
    var chronoStatus: String
    var basis: String
    var yLo: Int?
    var yHi: Int?
    var dateLabel: String
    var precision: String
    var dateRole: String?
    var isTranslation: Bool
    var langText: String?
    var langDeclared: String?
  }

  /// `dateCard(doc, dates)`.
  static func dateCard(_ d: DocFacts, _ dates: [(row: DateRow, raw: String?, rule: String?, approx: Bool, note: String?)]) -> DateCard {
    let chrono = dates.first { $0.row.isChronology }
    var notes: [String] = []
    let yl = { (y: Int?) in DateLabels.yearLabel(y ?? 0) }
    if d.chronoStatus == "undated" { notes.append("No usable date: outside the chronology (Undated shelf).") }
    if d.basis == "estimated" { notes.append("Estimated date, not stated by the source.") }
    if d.basis == "derived" {
      if chrono?.rule == "vikram_samvat" { notes.append("Vikram Samvat \((d.yLo ?? 0) + 57) → \(yl(d.yLo))–\(yl(d.yHi)) CE (calendar conversion)") }
      else if chrono?.rule == "shaka_samvat" { notes.append("Saka \((d.yLo ?? 0) - 78) → \(yl(d.yLo))–\(yl(d.yHi)) CE (calendar conversion)") }
      else { notes.append("Derived by calendar conversion.") }
    }
    if d.basis == "announced" { notes.append("Announced date after today: shown on the Scheduled shelf, never in rates.") }
    if d.basis == "period" { notes.append("A period, not a date.") }
    if let ch = chrono, ch.approx {
      notes.append("Circa: '\(ch.raw ?? d.dateLabel)' is read as an interval (\(yl(d.yLo))–\(yl(d.yHi))).")
    }
    if d.isTranslation {
      notes.append("Translation (text reads as \(d.langText ?? "null"), declared \(d.langDeclared ?? "unknown")): dated by the original's publication and excluded from text-language chronology by default.")
    }
    if let note = chrono?.note, !note.isEmpty { notes.append(note) }
    return DateCard(label: d.dateLabel, precision: d.precision, basis: d.basis, role: d.dateRole ?? chrono?.row.role,
                    notes: .array(notes.map(JSONValue.string)))
  }

  // MARK: passages

  /// `passageQuery(db, {id, context, expr, occ})`.
  public static func passage(_ c: Connection, text: TextAccess, id: Int64, context: Bool, expr: [Int64]?, occ: Int64?) throws -> PassageResponse {
    guard let p = try c.prepared(ReadSQL.passage).bindingFirst([.int(id)], { r in
      (doc: r.int(0), ord: Int(r.int(1)), field: r.text(2), fieldClass: r.text(3), timeRole: r.text(4), quality: r.text(5),
       start: Int(r.int(6)), end: Int(r.int(7)), pageNo: r.intOrNil(8).map(Int.init), lang: r.text(9), synthetic: r.int(10) == 1)
    }) else { throw ScrollsError(code: .notFound, message: "No passage \(id).", status: 404) }
    guard let d = try c.prepared(ReadSQL.passageDocument).bindingFirst([.int(p.doc)], { r in
      (id: r.int(0), title: r.textOrNil(1), author: r.textOrNil(2), kind: r.text(3),
       facts: DocFacts(chronoStatus: r.text(4), basis: r.text(5), yLo: r.intOrNil(6).map(Int.init), yHi: r.intOrNil(7).map(Int.init),
                       dateLabel: r.text(8), precision: r.text(9), dateRole: r.textOrNil(10), isTranslation: r.int(11) == 1,
                       langText: r.textOrNil(12), langDeclared: r.textOrNil(13)),
       license: r.textOrNil(14) ?? r.textOrNil(17), synthetic: r.int(15) == 1, collection: r.text(16))
    }) else { throw ScrollsError(code: .notFound, message: "No passage \(id).", status: 404) }
    let base = try text.base(c, doc: p.doc, field: p.field) ?? []
    let body = JSText.slice(base, p.start, p.end)
    let hl = try c.prepared(expr == nil ? ReadSQL.highlights : ReadSQL.highlightsOfExpr)
    try hl.bind([.int(id), .int(occ ?? -1)] + (expr.map { [SQLValue.text(SQLJSON.ints($0))] } ?? []))
    let highlights = try hl.all { r -> Highlight in
      var h = Highlight(start: Int(r.int(2)) - p.start, end: Int(r.int(3)) - p.start, expr: ExpressionID(rawValue: r.int(1)),
                        occ: OccurrenceID(rawValue: r.int(0)), variant: r.textOrNil(5))
      if r.isNull(5) { h.$variant = .null }
      if r.int(4) == 1 {
        h.nameFlag = true
        h.note = "excluded as a name (proper-noun guard)"
      }
      return h
    }
    func neighbour(_ ord: Int) throws -> JSONValue {
      guard let n = try c.prepared(ReadSQL.neighbour).bindingFirst([.int(p.doc), .text(p.field), .int(Int64(ord))], { r in
        (r.int(0), Int(r.int(1)), Int(r.int(2)), r.text(3))
      }) else { return .null }
      return .object(["passage": .int(n.0), "text": .string(JSText.string(JSText.slice(base, n.1, n.2))), "quality": .string(n.3)])
    }
    let dates = try documentDates(c, d.id)
    let referenced = dates.first { $0.row.role == "referenced" }
    let sha: String
    if p.field == "body" {
      let stored: String?? = try c.prepared(ReadSQL.originalSHA).bindingFirst([.int(d.id)]) { $0.textOrNil(0) }
      sha = (stored ?? nil) ?? TextDigest.sha256Hex(utf8: JSText.string(base))
    } else {
      sha = TextDigest.sha256Hex(utf8: JSText.string(base))
    }
    func relCount(_ sql: SQL, _ ref: String) throws -> Int { Int(try c.prepared(sql).bindingFirst([.text(ref)]) { $0.int(0) } ?? 0) }
    var out = PassageResponse(
      id: PassageID(rawValue: id), field: p.field, start: p.start, end: p.end, text: JSText.string(body), highlights: highlights,
      lang: p.lang, quality: p.quality, timeRole: p.timeRole,
      document: PassageDocument(id: DocumentID(rawValue: d.id), title: d.title, author: d.author, kind: d.kind, dates: dates.map(\.row),
                                dateCard: dateCard(d.facts, dates), collection: d.collection, license: d.license,
                                isTranslation: d.facts.isTranslation, synthetic: d.synthetic),
      anchor: PassageLocation(docId: DocumentID(rawValue: d.id), sha256: sha, field: p.field, start: p.start, end: p.end),
      synthetic: p.synthetic)
    out.$before = context ? .value(try neighbour(p.ord - 1)) : .null
    out.$after = context ? .value(try neighbour(p.ord + 1)) : .null
    out.fieldClass = p.fieldClass
    out.$pageNo = p.pageNo.map { .value($0) } ?? .null
    out.machine = try machine(c, id)
    out.relationships = .object([
      "out": .int(try relCount(ReadSQL.relOutPassage, String(id))), "in": .int(try relCount(ReadSQL.relInPassage, String(id))),
      "document_out": .int(try relCount(ReadSQL.relOutDocument, String(d.id))),
      "document_in": .int(try relCount(ReadSQL.relInDocument, String(d.id))),
    ])
    out.annotations = Int(try c.prepared(ReadSQL.annotationCount).bindingFirst([.text(String(id))]) { $0.int(0) } ?? 0)
    if let referenced { out.refersTo = .object(["label": .string(referenced.row.label), "precision": .string(referenced.row.precision)]) }
    if p.quality != "ok" { out.qualityNote = "This passage is marked '\(p.quality)' and is excluded from counts." }
    if p.timeRole == "describes" { out.timeNote = "A retrospective description: written later, about the item; excluded from frequency by default." }
    if p.timeRole == "apparatus" { out.timeNote = "Editorial apparatus (heuristic): excluded from frequency by default." }
    return out
  }

  /// `machineOf(db, passageId)`: cluster memberships of the passage's occurrences (succeeded runs only).
  static func machine(_ c: Connection, _ passageId: Int64) throws -> JSONValue {
    let s = try c.prepared(ReadSQL.machine)
    try s.bind([.int(passageId)])
    return .array(try s.all { r in
      .object(["kind": .string(r.text(0)), "cluster": .int(r.int(1)), "label": .string(r.text(2)), "margin": .num(r.doubleOrNil(3)),
               "run": .int(r.int(4))])
    })
  }

  /// GET /api/occurrences/:id.
  public static func occurrence(_ c: Connection, _ id: Int64) throws -> OccurrenceResponse {
    guard let o = try c.prepared(ReadSQL.occurrence).bindingFirst([.int(id)], { r in
      OccurrenceResponse(id: OccurrenceID(rawValue: r.int(0)), passage: PassageID(rawValue: r.int(1)), doc: DocumentID(rawValue: r.int(2)),
                         expr: ExpressionID(rawValue: r.int(3)), start: Int(r.int(4)), end: Int(r.int(5)), nameFlag: r.int(6) == 1,
                         runId: RunID(rawValue: r.int(7)), synthetic: r.int(8) == 1)
    }) else {
      throw ScrollsError(code: .notFound, message: "No occurrence \(id).",
                         hint: "Occurrences belong to a materialize run; search the expression again.", status: 404)
    }
    return o
  }

  // MARK: documents

  /// `documentQuery(db, {id})`.
  public static func document(_ c: Connection, text: TextAccess, id: Int64) throws -> DocumentResponse {
    guard let d = try c.prepared(ReadSQL.document).bindingFirst([.int(id)], { r in
      (extId: r.text(1), kind: r.text(2), title: r.textOrNil(3), nativeTitle: r.textOrNil(4), author: r.textOrNil(5),
       collection: r.text(6), collectionName: r.text(7), hasFullText: r.int(8) == 1,
       facts: DocFacts(chronoStatus: r.text(9), basis: r.text(10), yLo: r.intOrNil(11).map(Int.init), yHi: r.intOrNil(12).map(Int.init),
                       dateLabel: r.text(13), precision: r.text(14), dateRole: r.textOrNil(15), isTranslation: r.int(16) == 1,
                       langText: r.textOrNil(17), langDeclared: r.textOrNil(18)),
       dupOf: r.intOrNil(19), passages: Int(r.int(20)), tokens: Int(r.int(21)), community: r.textOrNil(22), culture: r.textOrNil(23),
       field: r.textOrNil(24), genre: r.textOrNil(25), sourceURL: r.textOrNil(26), license: r.textOrNil(27) ?? r.textOrNil(28),
       exportTextAllowed: r.int(29) == 1, synthetic: r.int(30) == 1, modality: r.text(31), deletedAt: r.textOrNil(32))
    }) else { throw ScrollsError(code: .notFound, message: "No document \(id).", status: 404) }
    let dates = try documentDates(c, id)
    let tags = try c.prepared(ReadSQL.tags)
    try tags.bind([.int(id)])
    let tagRows: [JSONValue] = try tags.all { r in
      var o: JSONObject = ["scheme": .string(r.text(0)), "value": .string(r.text(1)), "weight": .num(r.doubleOrNil(2)),
                           "provenance": .string(r.text(3)), "method": .str(r.textOrNil(4))]
      if r.text(3) == "machine_tag" || r.text(3) == "adapter_machine" { o["note"] = "machine tag — fallible" }
      return .object(o)
    }
    let aliases = try c.prepared(ReadSQL.aliases)
    try aliases.bind([.int(id)])
    let aliasRows: [JSONValue] = try aliases.all { r in
      .object(["ext_id": .string(r.text(0)), "title": .str(r.textOrNil(1)), "note": .str(r.textOrNil(2))])
    }
    let fields = try c.prepared(ReadSQL.fields)
    try fields.bind([.int(id)])
    let fieldRows: [JSONValue] = try fields.all { r in
      .object(["field": .string(r.text(0)), "passage": .int(r.int(1)), "field_class": .string(r.text(2)), "time_role": .string(r.text(3)),
               "quality": .string(r.text(4)), "start": .int(r.int(5)), "end": .int(r.int(6))])
    }
    var out = DocumentResponse(id: DocumentID(rawValue: id), extId: d.extId, kind: d.kind, title: d.title, collection: d.collection,
                               hasFullText: d.hasFullText, dates: dates.map(\.row), dateCard: dateCard(d.facts, dates),
                               tags: .array(tagRows), aliases: .array(aliasRows), synthetic: d.synthetic)
    out.$nativeTitle = d.nativeTitle.map { .value($0) } ?? .null
    out.$author = d.author.map { .value($0) } ?? .null
    out.collectionName = d.collectionName
    out.fields = .array(fieldRows)
    out.$langDeclared = d.facts.langDeclared.map { .value($0) } ?? .null
    out.$langText = d.facts.langText.map { .value($0) } ?? .null
    out.isTranslation = d.facts.isTranslation
    out.$dupOf = d.dupOf.map { .value(DocumentID(rawValue: $0)) } ?? .null
    out.passages = d.passages
    out.tokens = d.tokens
    out.$community = d.community.map { .value($0) } ?? .null
    out.$culture = d.culture.map { .value($0) } ?? .null
    out.$field = d.field.map { .value($0) } ?? .null
    out.$genre = d.genre.map { .value($0) } ?? .null
    out.$sourceUrl = d.sourceURL.map { .value($0) } ?? .null
    out.$license = d.license.map { .value($0) } ?? .null
    out.exportTextAllowed = d.exportTextAllowed
    let original = d.hasFullText ? try text.base(c, doc: id, field: "body") : nil
    if let original {
      let t = try c.prepared(ReadSQL.bodyBounds).bindingFirst([.int(id)]) { r in (r.intOrNil(0), r.intOrNil(1), r.textOrNil(2)) }
      out.length = original.count
      out.body = .object(["start": .int(t?.0 ?? nil), "end": .int(t?.1 ?? nil)])
      out.sha256 = t?.2 ?? nil
    } else {
      out.textNote = d.modality == "titles" ? "Metadata only: this collection holds titles, not lyrics or scripts."
        : "Metadata only: this record has no full text."
    }
    if let del = d.deletedAt { out.deletedAt = del }
    return out
  }

  /// `documentTextQuery(db, {id, from, to})`: original.slice(from, to), at most 20,000 code units.
  public static func documentText(_ c: Connection, text: TextAccess, id: Int64, from: Int?, to: Int?) throws -> DocumentTextResponse {
    guard let syn = try c.prepared(ReadSQL.documentSynthetic).bindingFirst([.int(id)], { $0.int(0) == 1 }) else {
      throw ScrollsError(code: .notFound, message: "No document \(id).", status: 404)
    }
    guard let original = try text.base(c, doc: id, field: "body") else {
      throw ScrollsError(code: .notFound, message: "Document \(id) has no full text (metadata only).",
                         hint: "Open its title or summary passages instead.", status: 404)
    }
    let length = original.count
    let f = from ?? 0
    let t = to ?? min(length, f + maxTextSlice)
    guard f >= 0, f <= t, t <= length else {
      throw ScrollsError(code: .range, message: "from/to must lie inside the document (length \(length)).",
                         hint: "Ask for a slice inside the document.", detail: .object(["length": .int(length)]), status: 400)
    }
    if t - f > maxTextSlice {
      throw ScrollsError(code: .range, message: "A slice is at most \(maxTextSlice) characters (asked for \(t - f)).",
                         hint: "Ask for a smaller slice.", detail: .object(["length": .int(length)]), status: 400)
    }
    return DocumentTextResponse(documentId: DocumentID(rawValue: id), from: f, to: t, text: JSText.string(original[f..<t]),
                                length: length, synthetic: syn)
  }
}
