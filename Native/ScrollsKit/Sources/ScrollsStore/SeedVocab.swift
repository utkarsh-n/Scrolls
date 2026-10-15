// OWNER: N0
// Port of server/db/seed-vocab.mjs: idempotent upsert of the closed vocabularies stored as rows (rel_type,
// language_period, built-in dimension_def, corpus). Corpus rows take slot-0 ids (IOS-SPEC §3.3), in the reference's
// insertion order, so a fresh atlas numbers them 1…n exactly like a reference database.

import Foundation
import ScrollsCore

/// Seeds the vocabulary rows (SPEC §3.1).
public enum SeedVocab {
  /// Upserts rel_type, language_period, dimension_def (built-ins) and corpus. Safe on every boot: vocabulary rows are
  /// refreshed from `Vocab`; corpus rows keep their id and created_at.
  public static func seed(_ tx: WriteTx) throws {
    let c = tx.connection
    let relType = try c.prepared(StoreSQL.upsertRelType)
    for r in Vocab.relTypes {
      try relType.bind(.text(r.code), .text(r.family), .text(r.label), .text(r.inverseLabel), .int(Int64(r.directed)),
                       .int(Int64(r.requiresPrecedence)), .int(Int64(r.impliesTransmission)), .int(Int64(r.feedbackCapable)),
                       .text(r.glyph), .text(r.description))
      try relType.run()
    }
    let period = try c.prepared(StoreSQL.upsertLanguagePeriod)
    for p in Vocab.languagePeriods {
      try period.bind(.text(p.lang), .text(p.label), .int(Int64(p.loYear)), .int(Int64(p.hiYear)), .integer(p.coreLo),
                      .integer(p.coreHi), .int(Int64(p.fuzzYears)), .text(p.source), .text(p.note))
      try period.run()
    }
    let dim = try c.prepared(StoreSQL.upsertDimension)
    for d in Vocab.dimensions {
      try dim.bind(.text(d.key), .text(d.label), .text(d.type), d.options.isNull ? .null : .text(CanonicalJSON.string(d.options)))
      try dim.run()
    }
    let now = StoreClock.isoNow()
    for corpus in Vocab.corpora {
      if let id = try c.prepared(StoreSQL.corpusBySlug).bindingFirst([.text(corpus.slug)], { $0.int(0) }) {
        let up = try c.prepared(StoreSQL.updateCorpus)
        try up.bind(.text(corpus.name), .text(corpus.description), .string(corpus.license), .int(id))
        try up.run()
      } else {
        let id = try tx.ids.next("corpus", .slot(.base))
        let ins = try c.prepared(StoreSQL.insertCorpus)
        try ins.bind(.int(id), .text(corpus.slug), .text(corpus.name), .text(corpus.kind), .int(Int64(corpus.isSynthetic)),
                     .text(corpus.description), .string(corpus.license), .text(now))
        try ins.run()
      }
    }
  }
}
