// OWNER: N4
// The index the gate widening searches (slices.mjs `wideningIndex`, `windowStats`): dated documents of a slice's
// filters in one modality, ignoring its years — evidence documents one by one (occurrence, document, author and
// top-document gates) and coverage aggregated by (y_lo, y_hi) (token gates) — plus the dated span that bounds any
// widening. Window membership is fit-or-wash, as for the slices.

import Foundation

/// Statistics of a candidate window (`windowStats`).
public struct WindowStats: Sendable, Equatable {
  public var n = 0
  public var docs = 0
  public var authors = 0
  public var topDocShare: Double?
  public var units = 0
  public var unitsNoTr = 0
  public var coverDocs = 0
  public var coverAuthors = 0
}

/// A slice's widening index.
public final class WideningIndex: @unchecked Sendable {
  struct Evidence { let yLo: Int, yHi: Int, n: Int, author: String? }
  struct Cover {
    let yLo: Int, yHi: Int
    var units: Int, unitsNoTr: Int, docs: Int
    var authors: [String]
  }

  let evidence: [Evidence]
  let cover: [Cover]
  /// The dated span of the slice's filters in this modality; nil when nothing is dated.
  public let bounds: (Int, Int)?
  let unit: String

  init(evidence: [Evidence], cover: [Cover], bounds: (Int, Int)?, unit: String) {
    self.evidence = evidence
    self.cover = cover
    self.bounds = bounds
    self.unit = unit
  }

  /// `wideningIndex(scope, spec, modality)`.
  static func build(_ scope: Scope, _ spec: SliceSpec, _ modality: String) -> WideningIndex {
    let cfg = ModalityConfig(scope, modality, spec.collIds)
    var evidence: [Evidence] = []
    var cover = JSMap<Cover>()
    var minY = Int.max, maxY = Int.min
    for doc in scope.docs {
      if !spec.collSet.contains(doc.coll) || !spec.facetsPass(doc) || doc.chrono != "dated" { continue }
      if scope.collections[doc.coll]!.modality != modality || Slices.exclusion(doc, scope.toggles) != nil { continue }
      let m = Slices.measureDoc(doc, spec, cfg, scope.toggles)
      if !(m.units > 0) { continue }
      guard let yLo = doc.yLo, let yHi = doc.yHi else { continue }
      minY = min(minY, yLo)
      maxY = max(maxY, yHi)
      if m.n > 0 { evidence.append(Evidence(yLo: yLo, yHi: yHi, n: m.n, author: doc.author)) }
      let key = "\(yLo)|\(yHi)"
      cover.update(key, default: Cover(yLo: yLo, yHi: yHi, units: 0, unitsNoTr: 0, docs: 0, authors: [])) { c in
        c.units += m.units
        if !doc.tr { c.unitsNoTr += m.units }
        c.docs += 1
        if doc.hasAuthor { c.authors.append(doc.author!) }
      }
    }
    return WideningIndex(evidence: evidence, cover: cover.values, bounds: minY == Int.max ? nil : (minY, maxY), unit: cfg.unit)
  }

  /// `windowStats(index, lo, hi, {authorsNeeded, coverAuthorsNeeded})`; an infinite bound is nil.
  func windowStats(_ lo: Int?, _ hi: Int?, authorsNeeded: Int = Int.max, coverAuthorsNeeded: Int = 0) -> WindowStats {
    var s = WindowStats()
    var top = 0
    var authors = JSSet()
    for e in evidence {
      if let lo, e.yLo < lo { continue }
      if let hi, e.yHi > hi { continue }
      s.n += e.n
      s.docs += 1
      if e.n > top { top = e.n }
      if let a = e.author, !a.isEmpty, authors.count < authorsNeeded { authors.insert(a) }
    }
    var coverAuthors = JSSet()
    for c in cover {
      if let lo, c.yLo < lo { continue }
      if let hi, c.yHi > hi { continue }
      s.units += c.units
      s.unitsNoTr += c.unitsNoTr
      s.coverDocs += c.docs
      if coverAuthors.count < coverAuthorsNeeded {
        for a in c.authors {
          coverAuthors.insert(a)
          if coverAuthors.count >= coverAuthorsNeeded { break }
        }
      }
    }
    s.authors = authors.count
    s.topDocShare = s.n > 0 ? Double(top) / Double(s.n) : nil
    s.coverAuthors = coverAuthors.count
    return s
  }

  func windowStats(_ lo: Int, _ hi: Int, authorsNeeded: Int = Int.max, coverAuthorsNeeded: Int = 0) -> WindowStats {
    windowStats(Optional(lo), Optional(hi), authorsNeeded: authorsNeeded, coverAuthorsNeeded: coverAuthorsNeeded)
  }
}
