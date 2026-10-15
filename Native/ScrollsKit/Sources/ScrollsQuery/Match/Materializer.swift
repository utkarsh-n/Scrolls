// OWNER: N3
// The materialize job (materialize.mjs `materialize`, SPEC §4.5–§4.6): expression + enabled variants → FTS candidates →
// tokenization of each candidate passage (its chunks only, through TextStore) → exact token-sequence match → occurrence
// rows (original offsets, proper-noun guard) → expr_doc rows; then expression_state points at the run and data_version is
// bumped, in the run's guarded final write (ΔS-2). Counts in expr_doc are always complete; occurrence rows are complete
// unless the expression is very frequent (> 300,000 matches): then a stratified sample of ≤ 200 per (passage language,
// decade). A single word that frequent is counted from the FTS index (exact per passage, accent-insensitive, no name
// guard) — the run's metrics say so.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// Parameters of a materialize job (`{expressionId}`; the thresholds default to §4.6, tests lower them).
public struct MaterializeParams: Sendable, Equatable {
  public var expressionId: Int64
  public var sampleAbove: Int
  public var samplePerGroup: Int
  /// Where occurrence ids come from: the local range (on-phone runs) or a source slot (a starter build).
  public var slot: SourceSlot?

  public init(expressionId: Int64, sampleAbove: Int = Materializer.sampleAbove, samplePerGroup: Int = Materializer.samplePerGroup,
              slot: SourceSlot? = nil) {
    self.expressionId = expressionId
    self.sampleAbove = sampleAbove
    self.samplePerGroup = samplePerGroup
    self.slot = slot
  }

  public init(json: JSONValue) throws {
    guard let e = json["expressionId"]?.safeInteger, e > 0 else {
      throw ScrollsError.badRequest(.validation, "materialize needs params.expressionId (an expression id).")
    }
    self.init(expressionId: Int64(e), sampleAbove: json["sampleAbove"]?.safeInteger ?? Materializer.sampleAbove,
              samplePerGroup: json["samplePerGroup"]?.safeInteger ?? Materializer.samplePerGroup,
              slot: json["slot"]?.safeInteger.map { SourceSlot(rawValue: $0) })
  }

  public var json: JSONValue {
    var o: JSONObject = ["expressionId": .int(expressionId)]
    if sampleAbove != Materializer.sampleAbove { o["sampleAbove"] = .int(sampleAbove) }
    if samplePerGroup != Materializer.samplePerGroup { o["samplePerGroup"] = .int(samplePerGroup) }
    if let slot { o["slot"] = .int(slot.rawValue) }
    return .object(o)
  }
}

/// The materialization.
public enum Materializer {
  public static let stage = Stage(rawValue: "materialize")
  /// Candidate passages per write transaction.
  public static let chunk = 400
  /// Above this many matches the occurrence rows are a stratified sample (§4.6).
  public static let sampleAbove = 300_000
  /// Occurrence rows kept per (passage language, decade) group once sampling.
  public static let samplePerGroup = 200

  /// Run metrics (the reference's metrics object; `docs` is a set until the end).
  struct Metrics {
    var mode = "exact"
    var sampleAbove: Int
    var samplePerGroup: Int
    var candidates = 0
    var passagesMatched = 0
    var occAll = 0
    var occTotal = 0
    var namesExcluded = 0
    var sampled = false
    var byVariant = OrderedDict<Int64, Int>()
    var namesByVariant = OrderedDict<Int64, Int>()
    var excludedQuality = OrderedDict<String, Int>()
    var docs = Set<Int64>()
    var namesByDocumentRule: Int?
    var countsIncludeAccentVariants = false
    var nameGuard: String?

    var json: JSONValue {
      var o: JSONObject = [
        "mode": .string(mode), "sample_above": .int(sampleAbove), "sample_per_group": .int(samplePerGroup),
        "candidates": .int(candidates), "passages_matched": .int(passagesMatched), "occ_all": .int(occAll),
        "occ_total": .int(occTotal), "names_excluded": .int(namesExcluded), "sampled": .bool(sampled),
        "by_variant": .object(JSONObject(byVariant.pairs.map { (String($0.key), JSONValue.int($0.value)) })),
        "names_by_variant": .object(JSONObject(namesByVariant.pairs.map { (String($0.key), JSONValue.int($0.value)) })),
        "excluded_quality": .object(JSONObject(excludedQuality.pairs.map { ($0.key, JSONValue.int($0.value)) })),
        "docs_total": .int(docs.count),
      ]
      if let n = namesByDocumentRule { o["names_by_document_rule"] = .int(n) }
      if countsIncludeAccentVariants { o["counts_include_accent_variants"] = .bool(true) }
      if let g = nameGuard { o["name_guard"] = .string(g) }
      return .object(o)
    }
  }

  /// The sampling group of a passage: its language and its document's decade (or chronology status).
  static func groupOf(_ p: CandidatePassage) -> String {
    "\(p.lang)|\(p.chronoStatus == "dated" ? String(DayMath.floorDiv(p.yLo ?? 0, 10)) : p.chronoStatus)"
  }

  /// A stable pseudo-random rank of a match.
  static func rankOf(_ passageId: Int64, _ start: Int) -> UInt32 { IDs.fnv1a32("\(passageId):\(start)") }

  /// What a read prepares for the run.
  struct Setup: Sendable {
    var expr: ExpressionRow
    var variants: [VariantRow]
    var seqs: [VariantSeq]
    var scope: JSONValue
    var params: JSONValue
    var variantsHash: String
    var indexable: Bool
    var estimate: Int
    var translit: [Translit.Candidate]
  }

  /// Materializes one expression inside a job.
  public static func run(_ ctx: JobContext, _ p: MaterializeParams) async throws -> JSONValue {
    EngineAssert.offMain()
    let text = ctx.text
    var setup = try await ctx.read { c -> Setup in
      guard let expr = try Expressions.get(c, p.expressionId) else {
        throw ScrollsError(code: .notFound, message: "No expression \(p.expressionId).", status: 404)
      }
      let variants = try Expressions.variants(c, expr.id)
      let enabled = variants.filter(\.enabled)
      if enabled.isEmpty { throw ScrollsError.badRequest(.validation, "Expression \(expr.id) has no enabled variant.") }
      let seqs = enabled.map { VariantSeq(id: $0.id, seq: JSString.split($0.norm, " ")) }
      let (scope, params) = try Expressions.spec(c, expr, variants)
      let singles = seqs.filter { $0.seq.count == 1 }
      let words = JSStringSet(singles.map { $0.seq[0] })
      let indexable = !singles.isEmpty && seqs.allSatisfy { $0.seq.count == 1 || words.contains($0.seq[0]) }
      var uniqueWords: [String] = []
      var seen = JSStringSet()
      for s in singles where seen.insert(s.seq[0]) { uniqueWords.append(s.seq[0]) }
      let estimate = indexable ? try FTS.termInstanceEstimate(c, uniqueWords) : 0
      // transliterations found in the vocabulary: offered (disabled), never counted until enabled
      var translit: [Translit.Candidate] = []
      if !JSText.includes(expr.norm, " "),
        try c.prepared(MatchSQL.hasTransliteration).bindingFirst([.int(expr.id)], { _ in true }) == nil
      {
        translit = try Translit.candidates(c, expr.surface)
      }
      return Setup(expr: expr, variants: variants, seqs: seqs, scope: scope, params: params,
                   variantsHash: Variants.variantsHash(variants.map { ($0.norm, $0.lang, $0.enabled) }), indexable: indexable,
                   estimate: estimate, translit: translit)
    }
    ctx.progress(0, phase: "candidates", message: "finding passages containing '\(setup.expr.surface)'")
    if !setup.translit.isEmpty {
      let expr = setup.expr, found = setup.translit
      try await ctx.write("materialize: transliterations") { tx in
        let ins = try tx.connection.prepared(MatchSQL.insertVariant)
        for t in found {
          let exists = try tx.connection.prepared(MatchSQL.variantExists).bindingFirst([.int(expr.id), .text(""), .text(t.norm)]) { _ in true }
          if exists == true { continue }
          try ins.bind([.int(try tx.ids.next("expression_variant", .local)), .int(expr.id), .text(t.form), .text(t.norm), .null,
                        .text("transliteration"), .text(Translit.rule), .text("computed"), .int(0)])
          try ins.run()
        }
      }
      setup.translit = []
    }
    let run = try await ctx.startRun(stage, params: setup.params, scope: setup.scope, upstream: [], representation: nil, seed: nil,
                                     pipelineVersion: Expressions.pipelineVersion)
    var m = Metrics(sampleAbove: p.sampleAbove, samplePerGroup: p.samplePerGroup)
    for v in setup.seqs {
      m.byVariant[v.id] = 0
      m.namesByVariant[v.id] = 0
    }
    let scope: IDScope = p.slot.map { .slot($0) } ?? .local
    if run.reused {
      // the same count already exists (same params, inputs and code): point the expression at it
      let stored = try await ctx.read { c in
        try c.prepared(MatchSQL.runMetrics).bindingFirst([.int(run.id.rawValue)]) { $0.textOrNil(0) } ?? nil
      }
      let mj = stored.flatMap { try? JSONValue.parse($0) } ?? .object([:])
      let occ = mj["occ_total"]?.safeInteger ?? 0, docs = mj["docs_total"]?.safeInteger ?? 0
      let names = mj["names_excluded"]?.safeInteger ?? 0, sampled = mj["sampled"] == .bool(true)
      let expr = setup.expr, hash = setup.variantsHash
      try await ctx.commitRun(run, metrics: nil) { tx in
        try writeState(tx, expr: expr.id, run: run.id.rawValue, hash: hash, occ: occ, docs: docs, sampled: sampled, names: names)
        try tx.bumpDataVersion()
      }
      ctx.progress(1, phase: "done", message: "\(occ) occurrences in \(docs) documents (an identical count was reused)")
      return .object(["run": .int(run.id.rawValue), "occurrences": .int(mj["occ_all"]?.safeInteger ?? occ), "counted": .int(occ),
                      "documents": .int(docs), "names_excluded": .int(names),
                      "candidates": .int(mj["candidates"]?.safeInteger ?? 0), "sampled": .bool(sampled),
                      "mode": .string(mj["mode"]?.stringValue ?? "exact"), "reused": .bool(true)])
    }
    if setup.indexable && setup.estimate > p.sampleAbove {
      try await countFromIndex(ctx, text: text, setup: setup, run: run.id.rawValue, metrics: &m, perGroup: p.samplePerGroup, scope: scope)
    } else {
      try await countExactly(ctx, text: text, setup: setup, run: run.id.rawValue, metrics: &m, sampleAbove: p.sampleAbove,
                             perGroup: p.samplePerGroup, scope: scope)
    }
    let metricsJSON = m.json
    let expr = setup.expr, hash = setup.variantsHash
    let occTotal = m.occTotal, docs = m.docs.count, sampled = m.sampled, names = m.namesExcluded
    try await ctx.commitRun(run, metrics: metricsJSON) { tx in
      try writeState(tx, expr: expr.id, run: run.id.rawValue, hash: hash, occ: occTotal, docs: docs, sampled: sampled, names: names)
      try tx.bumpDataVersion()
    }
    ctx.progress(1, phase: "done", message: "\(m.occTotal) occurrences in \(m.docs.count) documents\(m.sampled ? " (contexts sampled)" : "")")
    return .object(["run": .int(run.id.rawValue), "occurrences": .int(m.occAll), "counted": .int(m.occTotal),
                    "documents": .int(m.docs.count), "names_excluded": .int(m.namesExcluded), "candidates": .int(m.candidates),
                    "sampled": .bool(m.sampled), "mode": .string(m.mode)])
  }

  static func writeState(_ tx: WriteTx, expr: Int64, run: Int64, hash: String, occ: Int, docs: Int, sampled: Bool, names: Int) throws {
    let s = try tx.connection.prepared(MatchSQL.upsertStateReady)
    try s.bind([.int(expr), .int(run), .text(hash), .int(Int64(occ)), .int(Int64(docs)), .int(sampled ? 1 : 0),
                .int(Int64(names)), .text(StoreClock.isoNow())])
    try s.run()
  }

  /// One write of a counting chunk.
  enum Op: Sendable {
    case insert(expression: Int64, variant: Int64, passage: Int64, document: Int64, start: Int, end: Int, tok: Int, name: Bool,
                sampled: Bool, run: Int64)
    case skip
    case deleteRun(Int64)
  }

  /// Runs the ops in one transaction; returns the occurrence id of each op (nil for skips and deletes).
  static func apply(_ tx: WriteTx, _ ops: [Op], exprDoc: [ExprDocRow], expression: Int64, run: Int64, scope: IDScope) throws -> [Int64?] {
    let c = tx.connection
    let ins = try c.prepared(MatchSQL.insertOccurrence)
    var ids: [Int64?] = []
    ids.reserveCapacity(ops.count)
    for op in ops {
      switch op {
      case .skip: ids.append(nil)
      case .deleteRun(let r):
        let d = try c.prepared(MatchSQL.deleteRunOccurrences)
        try d.bind([.int(r)])
        try d.run()
        ids.append(nil)
      case let .insert(e, v, p, doc, s, en, tok, name, sampled, r):
        let id = try tx.ids.next("occurrence", scope)
        try ins.bind([.int(id), .int(e), .int(v), .int(p), .int(doc), .int(Int64(s)), .int(Int64(en)), .int(Int64(tok)),
                      .int(name ? 1 : 0), .int(sampled ? 1 : 0), .int(r)])
        try ins.run()
        ids.append(id)
      }
    }
    try ExprDocAccumulator.write(c, run: run, expression: expression, exprDoc)
    return ids
  }

  /// A body-text occurrence of a single word, noted for rule (d) of the guard.
  struct NameNote {
    var flagged = 0
    var lower = 0
    var capitalized = 0
    var otherCounted = 0
    var candidates: [(pid: Int64, lang: String, start: Int, variantId: Int64, occId: Int64?)] = []
  }

  /// The maker names of a corpus for the title rule (a shared artifact per state of the corpus's inputs).
  public static func corpusNames(_ c: Connection, _ corpusId: Int64?) throws -> NameIndex {
    try Artifacts.shared(c, name: "names1-c\(corpusId.map(String.init) ?? "all")", key: { c in
      if let corpusId { return try InputsKey.corpus(c, corpusId, scope: .rate) }
      return "v\(try Meta.dataVersion(c))"
    }) { c in Names.nameIndex(try makerNameRows(c, corpusId)) }
  }

  /// `makerNameRows(db, corpusId)`: distinct authors and maker tags of the corpus's rate-eligible collections.
  static func makerNameRows(_ c: Connection, _ corpusId: Int64?) throws -> [String] {
    let a = try c.prepared(corpusId == nil ? MatchSQL.makerAuthorsAll : MatchSQL.makerAuthors)
    try a.bind(corpusId.map { [SQLValue.int($0)] } ?? [])
    var names = try a.all { $0.text(0) }
    let t = try c.prepared(corpusId == nil ? MatchSQL.makerTagsAll : MatchSQL.makerTags)
    try t.bind(corpusId.map { [SQLValue.int($0)] } ?? [])
    names += try t.all { $0.text(0) }
    return names
  }

  /// The exact path: tokenization of every candidate passage; switches to sampled occurrence rows past the cap.
  static func countExactly(_ ctx: JobContext, text: any TextStore, setup: Setup, run: Int64, metrics m: inout Metrics,
                           sampleAbove: Int, perGroup: Int, scope: IDScope) async throws {
    let expr = setup.expr, seqs = setup.seqs
    let (ids, names) = try await ctx.read { c -> ([Int64], NameIndex) in
      let colls = try Expressions.countedCollections(c, corpusId: expr.corpusId).map(\.id)
      let ids = try FTS.candidates(c, phrases: seqs.map(\.seq), corpusId: expr.corpusId, collections: colls)
      return (ids, try corpusNames(c, expr.corpusId))
    }
    m.candidates = ids.count
    var overrides: [String: String] = [:]
    for (k, v) in Expressions.nameOverrides(expr) { overrides[k] = v }
    let ov = overrides
    var acc = ExprDocAccumulator()
    var groups = OrderedDict<String, [UInt32]>()
    let guardable = !JSText.includes(expr.norm, " ")
    var docNames = OrderedDict<Int64, NameNote>()
    let reader = TextAccess(store: text)
    var i = 0
    while i < ids.count {
      try await ctx.checkpoint()
      let slice = Array(ids[i..<min(ids.count, i + chunk)])
      let found = try await ctx.read { c in
        try Matching.matchPassages(c, text: reader, try FTS.passageRows(c, slice), seqs, names: names, overrides: ov)
      }
      var ops: [Op] = []
      var notes: [(opIndex: Int, p: CandidatePassage, match: PassageMatch)] = []
      for f in found {
        let p = f.passage
        m.passagesMatched += 1
        for match in f.matches {
          m.occAll += 1
          if !m.sampled && m.occAll > sampleAbove {
            m.sampled = true
            ops.append(.deleteRun(run))
          }
          groups[groupOf(p), default: []].append(rankOf(p.id, match.start))
          let opIndex = ops.count
          ops.append(m.sampled ? .skip
            : .insert(expression: expr.id, variant: match.variantId, passage: p.id, document: p.documentId, start: match.start,
                      end: match.end, tok: match.tokIndex, name: match.nameFlag, sampled: false, run: run))
          if p.quality != "ok" {
            m.excludedQuality[p.quality] = (m.excludedQuality[p.quality] ?? 0) + 1
            continue
          }
          acc.add(p, start: match.start, nameFlag: match.nameFlag)
          if match.nameFlag {
            m.namesExcluded += 1
            m.namesByVariant[match.variantId] = (m.namesByVariant[match.variantId] ?? 0) + 1
          } else {
            m.occTotal += 1
            m.byVariant[match.variantId] = (m.byVariant[match.variantId] ?? 0) + 1
            m.docs.insert(p.documentId)
          }
          if guardable { notes.append((opIndex, p, match)) }
        }
      }
      let rows = acc.drain()
      let opsF = ops
      let occIds = try await ctx.write("materialize: count") { tx in
        try apply(tx, opsF, exprDoc: rows, expression: expr.id, run: run, scope: scope)
      }
      for n in notes { noteForNameRule(&docNames, n.p, n.match, occIds[n.opIndex]) }
      ctx.progress(min(0.99, Double(i + chunk) / Double(max(1, ids.count))) * (m.sampled ? 0.5 : 1), phase: "counting",
                   message: "counting… \(min(ids.count, i + chunk)) / \(ids.count) passages")
      i += chunk
    }
    var flipped = Set<String>()
    if guardable { flipped = try await applyDocumentNameRule(ctx, expr: expr.id, run: run, docNames: docNames, metrics: &m) }
    guard m.sampled else { return }
    // second pass: keep the perGroup lowest-ranked matches of each group (stable, reproducible)
    var cut: [String: UInt32?] = [:]
    for (g, ranks) in groups.pairs { cut[g] = ranks.count > perGroup ? ranks.sorted()[perGroup - 1] : nil }
    i = 0
    while i < ids.count {
      try await ctx.checkpoint()
      let slice = Array(ids[i..<min(ids.count, i + chunk)])
      let found = try await ctx.read { c in
        try Matching.matchPassages(c, text: reader, try FTS.passageRows(c, slice), seqs, names: names, overrides: ov)
      }
      var ops: [Op] = []
      for f in found {
        let p = f.passage
        let limit = cut[groupOf(p)] ?? nil
        for match in f.matches {
          if let limit, rankOf(p.id, match.start) > limit { continue }
          let name = match.nameFlag || flipped.contains("\(p.id):\(match.start)")
          ops.append(.insert(expression: expr.id, variant: match.variantId, passage: p.id, document: p.documentId,
                             start: match.start, end: match.end, tok: match.tokIndex, name: name, sampled: limit != nil, run: run))
        }
      }
      let opsF = ops
      _ = try await ctx.write("materialize: sample") { tx in
        try apply(tx, opsF, exprDoc: [], expression: expr.id, run: run, scope: scope)
      }
      ctx.progress(0.5 + min(0.49, Double(i + chunk) / Double(max(1, ids.count)) / 2), phase: "sampling",
                   message: "keeping a stratified sample of contexts")
      i += chunk
    }
  }

  static func noteForNameRule(_ docNames: inout OrderedDict<Int64, NameNote>, _ p: CandidatePassage, _ m: PassageMatch,
                              _ occId: Int64?) {
    guard m.word else { return }
    var d = docNames[p.documentId] ?? NameNote()
    defer { docNames[p.documentId] = d }
    if p.fieldClass != "text" {
      if !m.nameFlag { d.otherCounted += 1 }
      return
    }
    if m.nameFlag { d.flagged += 1 }
    else if !m.cap { d.lower += 1 }
    else if m.overridden { d.otherCounted += 1 }
    else {
      d.capitalized += 1
      d.candidates.append((p.id, p.lang, m.start, m.variantId, occId))
    }
  }

  /// Rule (d) of the guard: moves a document's capitalized occurrences from counted to excluded-as-names.
  static func applyDocumentNameRule(_ ctx: JobContext, expr: Int64, run: Int64, docNames: OrderedDict<Int64, NameNote>,
                                    metrics m: inout Metrics) async throws -> Set<String> {
    var moved = Set<String>()
    let docs = docNames.pairs.filter { Names.documentNameRule(flagged: $0.value.flagged, lower: $0.value.lower,
                                                              capitalized: $0.value.capitalized) }
    if docs.isEmpty { return moved }
    var occUpdates: [Int64] = []
    var rowUpdates: [(k: Int, doc: Int64, lang: String)] = []
    for (doc, d) in docs {
      var byLang = OrderedDict<String, Int>()
      for cnd in d.candidates {
        moved.insert("\(cnd.pid):\(cnd.start)")
        if let occ = cnd.occId, !m.sampled { occUpdates.append(occ) }
        byLang[cnd.lang] = (byLang[cnd.lang] ?? 0) + 1
        m.occTotal -= 1
        m.namesExcluded += 1
        m.byVariant[cnd.variantId] = (m.byVariant[cnd.variantId] ?? 0) - 1
        m.namesByVariant[cnd.variantId] = (m.namesByVariant[cnd.variantId] ?? 0) + 1
      }
      for (lang, k) in byLang.pairs { rowUpdates.append((k, doc, lang)) }
      if d.otherCounted == 0 { m.docs.remove(doc) }
    }
    let occ = occUpdates, rowsF = rowUpdates
    try await ctx.write("materialize: name rule") { tx in
      let o = try tx.connection.prepared(MatchSQL.flagOccurrence)
      for id in occ {
        try o.bind([.int(id)])
        try o.run()
      }
      let r = try tx.connection.prepared(MatchSQL.nameRuleExprDoc)
      for u in rowsF {
        try r.bind([.int(Int64(u.k)), .int(expr), .int(run), .int(u.doc), .text(u.lang)])
        try r.run()
      }
    }
    m.namesByDocumentRule = moved.count
    return moved
  }

  /// The very-frequent path for single words: per-passage counts from passage_vocab_inst, then a stratified sample of
  /// exact matches as occurrence rows.
  static func countFromIndex(_ ctx: JobContext, text: any TextStore, setup: Setup, run: Int64, metrics m: inout Metrics,
                             perGroup: Int, scope: IDScope) async throws {
    m.mode = "fts-index"
    m.sampled = true
    m.countsIncludeAccentVariants = true
    m.nameGuard = "not applied: counts come from the FTS index"
    let expr = setup.expr, seqs = setup.seqs
    let singles = seqs.filter { $0.seq.count == 1 }
    var termOwner = OrderedDict<JSKey, Int64>()
    for s in singles {
      let t = JSKey(FTS.term(s.seq[0]))
      if termOwner[t] == nil { termOwner[t] = s.id }
    }
    let owners = termOwner.pairs.map { ($0.key.string, $0.value) }
    let (perPassage, counted, names) = try await ctx.read { c -> (OrderedDict<Int64, (n: Int, variant: Int64)>, Set<Int64>, NameIndex) in
      var per = OrderedDict<Int64, (n: Int, variant: Int64)>()
      for (term, variant) in owners {
        for r in try FTS.termCounts(c, term) {
          if let cur = per[r.passage] { per[r.passage] = (cur.n + r.n, cur.variant) } else { per[r.passage] = (r.n, variant) }
        }
      }
      let colls = Set(try Expressions.countedCollections(c, corpusId: expr.corpusId).map(\.id))
      return (per, colls, try corpusNames(c, expr.corpusId))
    }
    let ids = perPassage.keys.sorted()
    m.candidates = ids.count
    var acc = ExprDocAccumulator()
    var byGroup = OrderedDict<String, [CandidatePassage]>()
    var i = 0
    while i < ids.count {
      try await ctx.checkpoint()
      let slice = Array(ids[i..<min(ids.count, i + chunk)])
      let rows = try await ctx.read { c in try FTS.passageRows(c, slice) }.filter { counted.contains($0.collectionId) }
      for p in rows {
        let (n, variant) = perPassage[p.id]!
        m.passagesMatched += 1
        m.occAll += n
        if p.quality != "ok" {
          m.excludedQuality[p.quality] = (m.excludedQuality[p.quality] ?? 0) + n
          continue
        }
        acc.add(p, start: p.startOff, nameFlag: false, count: n)
        m.occTotal += n
        m.byVariant[variant] = (m.byVariant[variant] ?? 0) + n
        m.docs.insert(p.documentId)
        byGroup[groupOf(p), default: []].append(p)
      }
      let drained = acc.drain()
      _ = try await ctx.write("materialize: index counts") { tx in
        try apply(tx, [], exprDoc: drained, expression: expr.id, run: run, scope: scope)
      }
      ctx.progress(min(0.8, Double(i + chunk) / Double(max(1, ids.count)) * 0.8), phase: "counting",
                   message: "counting from the index… \(min(ids.count, i + chunk)) / \(ids.count) passages")
      i += chunk
    }
    let reader = TextAccess(store: text)
    for passages in byGroup.values {
      try await ctx.checkpoint()
      let ordered = stableSorted(passages) { rankOf($0.id, 0) < rankOf($1.id, 0) }
      var kept = 0
      var k = 0
      var ops: [Op] = []
      while k < ordered.count && kept < perGroup {
        let batch = Array(ordered[k..<min(ordered.count, k + 32)])
        let found = try await ctx.read { c in
          try batch.map { p in try Matching.matchPassages(c, text: reader, [p], seqs, names: names).first?.matches ?? [] }
        }
        for (j, matches) in found.enumerated() {
          if kept >= perGroup { break }
          let p = batch[j]
          for match in matches {
            if kept >= perGroup { break }
            ops.append(.insert(expression: expr.id, variant: match.variantId, passage: p.id, document: p.documentId,
                               start: match.start, end: match.end, tok: match.tokIndex, name: match.nameFlag, sampled: true, run: run))
            kept += 1
          }
        }
        k += 32
      }
      let opsF = ops
      _ = try await ctx.write("materialize: contexts") { tx in
        try apply(tx, opsF, exprDoc: [], expression: expr.id, run: run, scope: scope)
      }
    }
  }
}

/// The `materialize` job type (priority 1; a guarded commit, ΔS-2). Registered in ScrollsService's TaskRegistry.
public struct MaterializeTask: JobTask {
  public static let type = JobType(rawValue: "materialize")
  public static let writes = WriteNeed.commitsOnly
  public static let resumable = false
  public static let budget = ResourceBudget(peakBytes: 192 << 20, maxThreads: 1, mayStartInBackground: false)
  let params: MaterializeParams

  public init(params: JSONValue) throws { self.params = try MaterializeParams(json: params) }

  public func run(_ ctx: JobContext) async throws -> JSONValue { try await Materializer.run(ctx, params) }
}
