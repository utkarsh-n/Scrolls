// OWNER: N3
// Port of server/aggregate/exprdoc.mjs: expr_doc rows — exact counts per expression × document × passage language × field
// class (SPEC D6, §3). THE aggregation base of every tile: n excludes proper-noun-guard hits (n_names holds them) and counts
// only quality='ok' passages, so it divides cleanly by doc_tokens.

import ScrollsStore

/// One expr_doc row.
public struct ExprDocRow: Sendable, Equatable {
  public var documentId: Int64
  public var plang: String
  public var fieldClass: String
  public var n: Int
  public var nNames: Int
  public var nPassages: Int
  public var firstOff: Int?
}

/// Accumulates matches into expr_doc rows (one per document, passage language, field class).
public struct ExprDocAccumulator: Sendable {
  private struct Acc: Sendable {
    var row: ExprDocRow
    var passages: Set<Int64>
  }
  private var rows = OrderedDict<String, Acc>()

  public init() {}

  /// Adds a match of a quality='ok' passage (or `count` matches at once on the very-frequent path).
  public mutating func add(_ p: CandidatePassage, start: Int, nameFlag: Bool, count: Int = 1) {
    let key = "\(p.documentId)\u{0}\(p.lang)\u{0}\(p.fieldClass)"
    var a = rows[key] ?? Acc(row: ExprDocRow(documentId: p.documentId, plang: p.lang, fieldClass: p.fieldClass, n: 0, nNames: 0,
                                             nPassages: 0, firstOff: nil), passages: [])
    if nameFlag { a.row.nNames += count } else {
      a.row.n += count
      a.passages.insert(p.id)
    }
    if a.row.firstOff == nil || start < a.row.firstOff! { a.row.firstOff = start }
    rows[key] = a
  }

  /// The rows accumulated so far (and forget them).
  public mutating func drain() -> [ExprDocRow] {
    let out = rows.values.map { a -> ExprDocRow in
      var r = a.row
      r.nPassages = a.passages.count
      return r
    }
    rows = OrderedDict()
    return out
  }

  /// `writeExprDoc`: inserts (summing rows of the same key) inside the caller's transaction.
  public static func write(_ c: Connection, run: Int64, expression: Int64, _ rows: [ExprDocRow]) throws {
    let s = try c.prepared(MatchSQL.upsertExprDoc)
    for r in rows {
      try s.bind([.int(expression), .int(r.documentId), .text(r.plang), .text(r.fieldClass), .int(Int64(r.n)),
                  .int(Int64(r.nNames)), .int(Int64(r.nPassages)), .integer(r.firstOff), .int(run)])
      try s.run()
    }
  }
}
