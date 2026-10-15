// OWNER: N1
// Port of server/store/bins.mjs (SPEC §3, D2, D6): precision-aware bin membership (doc_bin) and denominators
// (doc_tokens). A document has a doc_bin row at level L (0 millennium, 1 century, 2 decade, 3 year) iff its year interval
// fits ONE bin of that level (fit-or-wash). Only `chrono_status = 'dated'` documents get rows: undated and scheduled
// items never enter rates (honesty rule 4). doc_tokens counts quality='ok' passages only.
// The type is not called `Bins`, which is ScrollsCore's bin arithmetic; a second `Bins` would make every module that
// imports both ambiguous.

import Foundation
import ScrollsCore
import ScrollsStore

/// doc_bin and doc_tokens rows.
public enum DocBins {
  static let yearLevels: [Level] = [.millennium, .century, .decade, .year]

  /// `binsFor(yLo, yHi)`: the levels at which [yLo, yHi] fits one bin, with that bin.
  public static func binsFor(_ yLo: Int?, _ yHi: Int?) -> [(level: Int, bin: Int)] {
    guard let yLo, let yHi, yLo <= yHi else { return [] }
    return yearLevels.filter { Bins.fits(Int32(clamping: yLo), Int32(clamping: yHi), $0) }
      .map { ($0.rawValue, DayMath.floorDiv(yLo, $0.yearWidth!)) }
  }

  /// `writeDocBins(db, id, yLo, yHi)`: replaces a document's doc_bin rows (nils clear them).
  public static func write(_ c: Connection, document: Int64, _ yLo: Int?, _ yHi: Int?) throws -> Int {
    let del = try c.prepared(IngestSQL.deleteDocBins)
    try del.bind(.int(document))
    try del.run()
    let ins = try c.prepared(IngestSQL.insertDocBin)
    var n = 0
    for b in binsFor(yLo, yHi) {
      try ins.bind(.int(Int64(b.level)), .int(Int64(b.bin)), .int(document))
      try ins.run()
      n += 1
    }
    return n
  }

  /// `rewriteDocTokens(db, ids)`: recomputes doc_tokens (quality='ok' tokens and passages per passage language × field
  /// class), e.g. after the boilerplate pass changes passage quality.
  public static func rewriteDocTokens(_ c: Connection, documents: some Sequence<Int64>) throws {
    let del = try c.prepared(IngestSQL.deleteDocTokens)
    let ins = try c.prepared(IngestSQL.rewriteDocTokens)
    for id in documents {
      try del.bind(.int(id))
      try del.run()
      try ins.bind(.int(id))
      try ins.run()
    }
  }
}
