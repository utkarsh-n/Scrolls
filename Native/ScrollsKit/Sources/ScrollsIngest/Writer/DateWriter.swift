// OWNER: N1
// Port of store/document-writer.mjs (dates part): every date of a record is parsed (or taken as the adapter parsed it),
// its issues and warnings are recorded, the chronology is chosen (an explicit `is_chronology`, else the first date of a
// chronology role), and the assertions are written to date_assertion — the dated ones into the R-tree too — followed
// by the ingestion assertion ("time of import, not a date of the text").

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One date assertion of a record, as the writer holds it before writing.
struct Assertion {
  var role: String
  var parsed: DateParse?
  var raw: String?
  var assertedBy: String
  var isChronology: Bool
  var note: String?
  var issue: DateIssue?
}

extension DocumentWriter {
  /// `parseAssertions(doc, line, issues)`.
  func parseAssertions(_ doc: CanonicalDocument, line: Int?, _ issues: inout [Issue], _ tx: WriteTx) throws -> [Assertion] {
    var out: [Assertion] = []
    for d in doc.dates {
      var parsed = d.parsed
      var issue: DateIssue?
      if parsed == nil {
        let r = DateGrammar.parse(d.raw, context: dateContext)
        if let i = r.issue { issue = i } else { parsed = r }
      }
      if let issue {
        let suggestion: String? = issue.suggestions.isEmpty ? nil
          : "Try \(issue.suggestions.map { "'\($0)'" }.joined(separator: " or ")); the record was kept as undated."
        issues.append(try recordIssue(IssueSpec(code: issue.code, line: line, field: "date:\(d.role)", valueExcerpt: d.raw,
                                                message: "\(doc.extId): \(issue.message)", suggestion: suggestion), tx))
      }
      for w in parsed?.warnings ?? [] {
        let value = d.raw ?? parsed?.raw
        issues.append(try recordIssue(IssueSpec(code: w, line: line, field: "date:\(d.role)", valueExcerpt: value,
          vars: ["value": value.map(JSONValue.string) ?? .null, "from": parsed?.yLo.map { .number(Double($0)) } ?? .null,
                 "to": parsed?.yHi.map { .number(Double($0)) } ?? .null]), tx))
      }
      out.append(Assertion(role: d.role, parsed: parsed, raw: d.raw ?? parsed?.raw, assertedBy: d.assertedBy,
                           isChronology: d.isChronology == true, note: d.note, issue: issue))
    }
    return out
  }

  /// `chronologyOf(assertions)`: the flagged assertion, else the first of a chronology role (which becomes flagged).
  func chronologyIndex(_ a: inout [Assertion]) -> Int? {
    if let k = a.firstIndex(where: { $0.isChronology }) { return k }
    if let k = a.firstIndex(where: { DocumentWriter.chronoRoles.contains($0.role) }) {
      a[k].isChronology = true
      return k
    }
    return nil
  }

  /// Writes the assertions and the ingestion assertion; returns the rows written.
  func writeAssertions(document id: Int64, _ assertions: [Assertion], chronoIndex: Int?, _ tx: WriteTx) throws -> Int {
    let c = tx.connection
    let insDate = try c.prepared(IngestSQL.insertDate)
    let insRtree = try c.prepared(IngestSQL.insertRtree)
    var rows = 0
    func write(_ a: Assertion, isChrono: Bool) throws {
      let p = a.parsed
      let dated = p != nil && p!.loDay != nil
      var note = a.note
      if let i = a.issue { note = [a.note, "\(i.code): \(i.message)"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "; ") }
      let aid = try tx.ids.next("date_assertion", scope)
      try insDate.bind([
        .int(aid), .int(id), .text(a.role), dated ? .integer(p!.loDay.map(Int.init)) : .null,
        dated ? .integer(p!.hiDay.map(Int.init)) : .null, dated ? .integer(p!.yLo.map(Int.init)) : .null,
        dated ? .integer(p!.yHi.map(Int.init)) : .null, .text(dated ? p!.precision : "unknown"), .text(dated ? p!.basis : "unknown"),
        .int((p?.approx ?? false) ? 1 : 0), .string(a.raw), .text(a.issue != nil ? "unparsed" : p?.rule ?? "unknown"),
        .text(a.assertedBy), .int(isChrono ? 1 : 0), .string(note),
      ])
      try insDate.run()
      if dated {
        try insRtree.bind(.int(aid), .integer(p!.loDay.map(Int.init)), .integer(p!.hiDay.map(Int.init)))
        try insRtree.run()
      }
      rows += dated ? 2 : 1
    }
    for (k, a) in assertions.enumerated() { try write(a, isChrono: k == chronoIndex) }
    let ingestion = DateParse(loDay: Int32(today), hiDay: Int32(today), yLo: Int32(todayYear), yHi: Int32(todayYear), precision: "day",
                              basis: "stated", approx: false, rule: "ingestion", raw: nil, label: "", warnings: [])
    try write(Assertion(role: "ingestion", parsed: ingestion, raw: nowISO, assertedBy: assertedIngestion, isChronology: false,
                        note: "time of import (not a date of the text)", issue: nil), isChrono: false)
    return rows
  }
}
