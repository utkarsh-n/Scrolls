// OWNER: N3
// Tracked expressions (materialize.mjs, SPEC §4.5, §4.6, D6): the expression row, its identity and generated variants and
// its expression_state; the strand's languages (§4.6: a French variant is never divided by English tokens); the language
// guess; freshness (§4.0: params + input fingerprint); the Expression payload of §7.2; Wiktionary claim markers (never
// occurrences, §10.2); per-match name-guard overrides.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// An `expression` row.
public struct ExpressionRow: Sendable, Equatable {
  public var id: Int64
  public var corpusId: Int64?
  public var kind: String
  public var surface: String
  public var norm: String
  public var lang: String?
  public var origin: String
  public var isSynthetic: Bool
  public var metaJSON: String
}

/// An `expression_variant` row.
public struct VariantRow: Sendable, Equatable {
  public var id: Int64
  public var expressionId: Int64
  public var form: String
  public var norm: String
  public var lang: String?
  public var variantType: String
  public var rule: String
  public var evidenceStatus: String
  public var enabled: Bool
}

/// A `corpus` row.
public struct CorpusRow: Sendable, Equatable {
  public var id: Int64
  public var slug: String
  public var name: String
  public var isSynthetic: Bool
  public var kind: String
}

/// Tracked expressions.
public enum Expressions {
  /// Pipeline version recorded on every materialize run.
  public static let pipelineVersion = "materialize@1.1.0"
  static let latinLangs = ["en", "fr", "es", "de", "la", "it", "pt"]
  /// Passage languages written in each script.
  static let scriptLangs: [String: [String]] = ["Latn": latinLangs + ["und", "und-Latn"], "Deva": ["hi", "sa", "mr"], "Gujr": ["gu"]]
  static let maxSurface = 200

  // MARK: reads

  static func exprRow(_ r: Row) -> ExpressionRow {
    ExpressionRow(id: r.int(0), corpusId: r.intOrNil(1), kind: r.text(2), surface: r.text(3), norm: r.text(4),
                  lang: r.textOrNil(5), origin: r.text(6), isSynthetic: r.int(7) == 1, metaJSON: r.text(8))
  }

  /// `getExpression(db, id)`.
  public static func get(_ c: Connection, _ id: Int64) throws -> ExpressionRow? {
    try c.prepared(MatchSQL.exprByID).bindingFirst([.int(id)], exprRow)
  }

  /// `variantsOf(db, id)`: identity first, then by id.
  public static func variants(_ c: Connection, _ id: Int64) throws -> [VariantRow] {
    let s = try c.prepared(MatchSQL.variantsOf)
    try s.bind([.int(id)])
    return try s.all { r in
      VariantRow(id: r.int(0), expressionId: r.int(1), form: r.text(2), norm: r.text(3), lang: r.textOrNil(4),
                 variantType: r.text(5), rule: r.text(6), evidenceStatus: r.text(7), enabled: r.int(8) == 1)
    }
  }

  static func corpusRow(_ r: Row) -> CorpusRow {
    CorpusRow(id: r.int(0), slug: r.text(1), name: r.text(2), isSynthetic: r.int(3) == 1, kind: r.text(4))
  }

  /// `corpusBySlug(db, slug)`.
  public static func corpus(_ c: Connection, slug: String?) throws -> CorpusRow? {
    guard let slug, !slug.isEmpty else { return nil }
    return try c.prepared(MatchSQL.corpusBySlug).bindingFirst([.text(slug)], corpusRow)
  }

  /// The corpus of an id.
  public static func corpus(_ c: Connection, id: Int64?) throws -> CorpusRow? {
    guard let id else { return nil }
    return try c.prepared(MatchSQL.corpusByID).bindingFirst([.int(id)], corpusRow)
  }

  /// `countedCollections(db, corpusId)`: the corpus's collections except lexical entries, by slug.
  public static func countedCollections(_ c: Connection, corpusId: Int64?) throws -> [(id: Int64, slug: String)] {
    let s = try c.prepared(corpusId == nil ? MatchSQL.countedCollectionsAll : MatchSQL.countedCollections)
    try s.bind(corpusId.map { [SQLValue.int($0)] } ?? [])
    return try s.all { ($0.int(0), $0.text(1)) }
  }

  // MARK: languages

  /// `strandLanguages(expr, variants)`: the passage languages a strand is counted in (nil = any).
  public static func strandLanguages(lang: String?, variants: [(lang: String?, enabled: Bool, norm: String, type: String)]) -> [String]? {
    guard let exprLang = lang, !exprLang.isEmpty else { return nil }
    var langs = Set<String>()
    for v in variants where v.enabled {
      let script = Variants.scriptOfTokens(JSString.split(v.norm, " "))
      if v.type == "transliteration" {
        for l in scriptLangs[script] ?? ["und"] { langs.insert(l) }
        continue
      }
      guard let l = v.lang ?? Optional(exprLang), !l.isEmpty else { return nil }
      langs.insert(l)
      if script == "Latn" {
        langs.insert("und")
        langs.insert("und-Latn")
      } else if script != "Gujr" && script != "Deva" {
        langs.insert("und")
      }
    }
    if langs.isEmpty { langs.insert(exprLang) }
    return langs.sorted(by: CanonicalJSON.codeUnitLess)
  }

  /// strandLanguages over variant rows.
  public static func strandLanguages(_ expr: ExpressionRow, _ variants: [VariantRow]) -> [String]? {
    strandLanguages(lang: expr.lang, variants: variants.map { ($0.lang, $0.enabled, $0.norm, $0.variantType) })
  }

  private static let guesses = Mutex<[String: String]>([:])

  /// `guessLanguage(db, tokens, corpusId)`: Devanagari → hi, Gujarati → gu; Latin → the language of most passages where
  /// the exact folded form occurs (en/fr/es/de/la/it/pt), else 'en'; symbols and other scripts → nil.
  public static func guessLanguage(_ c: Connection, tokens: [String], corpusId: Int64?) throws -> String? {
    let script = Variants.scriptOfTokens(tokens)
    if script == "Deva" { return "hi" }
    if script == "Gujr" { return "gu" }
    if script != "Latn" { return nil }
    let key = "\(c.path)|\(corpusId.map(String.init) ?? "null")|\(try Meta.dataVersion(c))|\(tokens.joined(separator: " "))"
    if let hit = guesses.withLock({ $0[key] }) { return hit }
    var rows: [(id: Int64, lang: String)] = []
    do { rows = try FTS.sample(c, phrases: [tokens], corpusId: corpusId, cap: 200) } catch { rows = [] }
    var guess = "en"
    if !rows.isEmpty {
      let found = try Matching.matchPassages(c, text: TextAccess.for(c), try FTS.passageRows(c, rows.map(\.id)),
                                             [VariantSeq(id: 0, seq: tokens)], guardNames: false)
      var votes = OrderedDict<String, Int>()
      for f in found where latinLangs.contains(f.passage.lang) {
        votes[f.passage.lang] = (votes[f.passage.lang] ?? 0) + f.matches.count
      }
      if let best = stableSorted(votes.pairs, by: { $0.value > $1.value }).first { guess = best.key }
    }
    guesses.withLock { g in
      if g.count > 256 { g.removeAll() }
      g[key] = guess
    }
    return guess
  }

  // MARK: tracking

  /// What tracking an expression will write: validated, its language decided (a read), its variants generated.
  public struct TrackPlan: Sendable {
    public var surface: String
    public var norm: String
    public var kind: String
    public var lang: String?
    public var corpus: CorpusRow?
    public var origin: String
    public var createdBy: String
    public var generated: [GeneratedVariant]
  }

  static func bad(_ message: String, field: String, hint: String? = nil) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, hint: hint, detail: .object(["field": .string(field)]))
  }

  /// The read half of `trackExpression`: validation and the language guess.
  public static func planTrack(_ c: Connection, surface raw: String, lang: String?, kind: String?, corpus: String?,
                               origin: String = "user_query", createdBy: String = "user") throws -> TrackPlan {
    let text = JSString.trim(raw)
    let tokens = Tokenizer.tokens(text).tokens
    if tokens.isEmpty { throw bad("The expression is empty.", field: "surface", hint: "Type a word, a phrase or a symbol.") }
    if text.utf16.count > maxSurface {
      throw bad("The expression is longer than \(maxSurface) characters.", field: "surface",
                hint: "Track a shorter phrase; use the targeted trace for long quotations.")
    }
    if let kind, !Vocab.expressionKinds.contains(kind) {
      throw bad("Unknown expression kind '\(kind)'.", field: "kind", hint: "Use one of \(Vocab.expressionKinds.joined(separator: ", ")).")
    }
    let corp = try corpus.flatMap { try Expressions.corpus(c, slug: $0) }
    if let corpus, !corpus.isEmpty, corp == nil {
      throw bad("Unknown corpus '\(corpus)'.", field: "corpus", hint: "Use demo, cipher, stemm or user.")
    }
    let k = kind ?? Variants.kindOfTokens(tokens)
    let l: String?
    if let lang, !lang.isEmpty { l = JSString.toLowerCase(lang) } else { l = try guessLanguage(c, tokens: tokens, corpusId: corp?.id) }
    return TrackPlan(surface: text, norm: tokens.joined(separator: " "), kind: k, lang: l, corpus: corp, origin: origin,
                     createdBy: createdBy, generated: Variants.generate(text, lang: l))
  }

  /// The id of the expression a plan would track, when it is tracked already (same kind, language, norm and corpus).
  public static func existing(_ c: Connection, _ plan: TrackPlan) throws -> Int64? {
    try c.prepared(MatchSQL.exprByKey).bindingFirst(
      [.text(plan.kind), .text(plan.lang ?? ""), .text(plan.norm), .int(plan.corpus?.id ?? 0)], { $0.int(0) })
  }

  /// The write half of `trackExpression` (idempotent): the expression, its variants and its state.
  public static func applyTrack(_ tx: WriteTx, _ plan: TrackPlan) throws -> (id: Int64, created: Bool) {
    let c = tx.connection
    if let id = try c.prepared(MatchSQL.exprByKey).bindingFirst(
      [.text(plan.kind), .text(plan.lang ?? ""), .text(plan.norm), .int(plan.corpus?.id ?? 0)], { $0.int(0) })
    {
      return (id, false)
    }
    let id = try tx.ids.next("expression", .local)
    let ins = try c.prepared(MatchSQL.insertExpression)
    try ins.bind([.int(id), .integer(plan.corpus?.id), .text(plan.kind), .text(plan.surface), .text(plan.norm),
                  .string(plan.lang), .text(plan.origin), .int(plan.corpus?.isSynthetic == true ? 1 : 0),
                  .text(plan.createdBy), .text(StoreClock.isoNow())])
    try ins.run()
    func addVariant(form: String, norm: String, type: String, rule: String, status: String, enabled: Bool) throws {
      let exists = try c.prepared(MatchSQL.variantExists).bindingFirst([.int(id), .text(plan.lang ?? ""), .text(norm)]) { _ in true }
      if exists == true { return }
      let v = try c.prepared(MatchSQL.insertVariant)
      try v.bind([.int(try tx.ids.next("expression_variant", .local)), .int(id), .text(form), .text(norm), .string(plan.lang),
                  .text(type), .text(rule), .text(status), .int(enabled ? 1 : 0)])
      try v.run()
    }
    try addVariant(form: plan.surface, norm: plan.norm, type: "identity", rule: "identity", status: "documented", enabled: true)
    for g in plan.generated {
      try addVariant(form: g.form, norm: g.norm, type: g.type, rule: g.rule, status: g.status, enabled: g.enabled)
    }
    let vars = try variants(c, id)
    let st = try c.prepared(MatchSQL.insertState)
    try st.bind([.int(id), .text(Variants.variantsHash(vars.map { ($0.norm, $0.lang, $0.enabled) })), .text(StoreClock.isoNow())])
    try st.run()
    return (id, true)
  }

  /// `setVariantsEnabled(db, id, changes)`: returns whether the enabled set changed.
  public static func setVariantsEnabled(_ tx: WriteTx, _ id: Int64, _ changes: [(id: Int64, enabled: Bool)]) throws -> Bool {
    let c = tx.connection
    if changes.isEmpty {
      throw bad("variants must be a non-empty list of {id, enabled}.", field: "variants")
    }
    let before = Variants.variantsHash(try variants(c, id).map { ($0.norm, $0.lang, $0.enabled) })
    let up = try c.prepared(MatchSQL.setVariantEnabled)
    for ch in changes {
      try up.bind([.int(ch.enabled ? 1 : 0), .int(ch.id), .int(id)])
      try up.run()
      if c.changes != 1 { throw bad("Variant \(ch.id) does not belong to expression \(id).", field: "variants") }
    }
    let vars = try variants(c, id)
    if !vars.contains(where: \.enabled) {
      throw bad("At least one variant must stay enabled.", field: "variants", hint: "Enable the identity form or another variant.")
    }
    let after = Variants.variantsHash(vars.map { ($0.norm, $0.lang, $0.enabled) })
    let s = try c.prepared(MatchSQL.setStateHash)
    try s.bind([.text(after), .text(StoreClock.isoNow()), .int(id)])
    try s.run()
    return before != after
  }

  /// `nameOverrides(expr)`: per-match overrides `doc:field:start` → 'count' | 'exclude', sorted by key.
  public static func nameOverrides(_ expr: ExpressionRow) -> [(key: String, value: String)] {
    guard case .object(let meta)? = try? JSONValue.parse(expr.metaJSON), case .object(let o)? = meta["name_overrides"] else { return [] }
    return o.keys.sorted(by: CanonicalJSON.codeUnitLess).compactMap { k in o[k]?.stringValue.map { (k, $0) } }
  }

  /// `setNameOverrides(db, id, overrides)`.
  public static func setNameOverrides(_ tx: WriteTx, _ id: Int64,
                                      _ overrides: [(documentId: Int64, field: String, start: Int, counted: Bool)]) throws {
    let c = tx.connection
    guard let expr = try get(c, id) else { throw ScrollsError(code: .notFound, message: "No expression \(id).", status: 404) }
    var meta = (try? JSONValue.parse(expr.metaJSON))?.objectValue ?? JSONObject()
    var names = meta["name_overrides"]?.objectValue ?? JSONObject()
    for o in overrides { names["\(o.documentId):\(o.field):\(o.start)"] = .string(o.counted ? "count" : "exclude") }
    meta["name_overrides"] = .object(names)
    let s = try c.prepared(MatchSQL.setExprMeta)
    try s.bind([.text(CanonicalJSON.string(.object(meta))), .int(id)])
    try s.run()
  }

  // MARK: freshness

  /// `materializeSpec(db, expr, variants)`: the run's scope and params.
  public static func spec(_ c: Connection, _ expr: ExpressionRow, _ variants: [VariantRow]) throws -> (scope: JSONValue, params: JSONValue) {
    let corpus = try Expressions.corpus(c, id: expr.corpusId)?.slug
    let collections = try countedCollections(c, corpusId: expr.corpusId).map(\.slug)
    let enabled = variants.filter(\.enabled).map { "\($0.lang ?? ""):\($0.norm)" }.sorted(by: CanonicalJSON.codeUnitLess)
    var overrides = JSONObject()
    for (k, v) in nameOverrides(expr) { overrides[k] = .string(v) }
    let scope: JSONValue = .object(["corpus": .str(corpus), "collections": .array(collections.map(JSONValue.string)),
                                    "expression": .int(expr.id)])
    let params: JSONValue = .object([
      "expression": .int(expr.id), "kind": .string(expr.kind), "lang": .str(expr.lang), "norm": .string(expr.norm),
      "variants": .array(enabled.map(JSONValue.string)), "name_overrides": .object(overrides),
      "code": .string(matchingCodeHash),
    ])
    return (scope, params)
  }

  /// The hash of the code that decides what a materialization counts (ΔS-7: the Swift sources of the stage), 16 hex.
  /// A differential run (scrolls-cli diff-read) adopts the reference's value, so the reference's own runs on a cloned
  /// snapshot count as fresh exactly when the reference would reuse them (DV-9: the hashes differ by construction; the
  /// matching rules are what G3 proves equal).
  public static var matchingCodeHash: String {
    differentialCodeHash.withLock { $0 } ?? String(BuildInfo.codeHash(stage: "materialize").prefix(16))
  }

  private static let differentialCodeHash = Mutex<String?>(nil)

  /// Installs (or removes, with nil) the reference's materialize code hash for a differential run. Never used by the app.
  public static func adoptReferenceCodeHash(_ hash: String?) { differentialCodeHash.withLock { $0 = hash } }

  /// `freshness(db, id)`: the current run and whether it counted the same variant set over the same committed imports.
  public static func freshness(_ c: Connection, _ id: Int64) throws -> (runId: Int64?, fresh: Bool) {
    guard let expr = try get(c, id) else { return (nil, false) }
    guard let st = try c.prepared(MatchSQL.freshness).bindingFirst([.int(id)], { ($0.int(0), $0.text(1), $0.text(2)) }) else {
      return (nil, false)
    }
    let (scope, params) = try spec(c, expr, try variants(c, id))
    let fingerprint = try Fingerprint.input(c, scope: scope)
    let fresh = st.1 == IDs.sha256Hex(CanonicalJSON.string(params)) && st.2 == fingerprint
    return (st.0, fresh)
  }

  /// `latestMaterializeJob(db, id)`: the newest materialize job row of an expression.
  public static func latestMaterializeJob(_ c: Connection, _ id: Int64) throws -> (id: Int64, status: String)? {
    try c.prepared(MatchSQL.latestMaterializeJob).bindingFirst([.int(id)]) { ($0.int(0), $0.text(1)) }
  }

  // MARK: payload

  /// The live state of an expression's newest job, as the queue knows it.
  public struct JobState: Sendable, Equatable {
    public var id: Int64
    public var status: String
    public init(id: Int64, status: String) {
      self.id = id
      self.status = status
    }
  }

  /// `expressionPayload(db, id, {job})`: the Expression of §7.2. `job` is the newest job's live state (nil: none;
  /// pass `.unknown` to read the job table).
  public static func payload(_ c: Connection, _ id: Int64, job: JobState?) throws -> ExpressionResponse? {
    guard let expr = try get(c, id) else { return nil }
    let st = try c.prepared(MatchSQL.statePayload).bindingFirst([.int(id)]) { ($0.intOrNil(0), $0.textOrNil(1), $0.textOrNil(2)) }
    var metrics: JSONObject?
    if let st, st.2 == "succeeded", let mj = st.1 { metrics = (try? JSONValue.parse(mj))?.objectValue }
    let active = job.map { ["queued", "running", "cancelling"].contains($0.status) } ?? false
    let status = active ? "materializing" : metrics != nil ? "ready" : job?.status == "failed" ? "failed" : "none"
    let byVariant = metrics?["by_variant"]?.objectValue
    let variants = try variants(c, id).map { v -> Variant in
      var n: Int?
      if metrics != nil && v.enabled, let x = byVariant?[String(v.id)]?.safeInteger { n = x }
      return Variant(id: Int(v.id), form: v.form, type: v.variantType, rule: v.variantType != "identity" ? v.rule : nil,
                     status: v.evidenceStatus, enabled: v.enabled, n: n, lang: v.lang)
    }
    let corpus = try Expressions.corpus(c, id: expr.corpusId)?.slug
    let state = ExpressionState(status: status, job: active ? Int(job!.id) : nil, run: metrics != nil ? st?.0.map { RunID(rawValue: $0) } : nil,
                                n: metrics?["occ_total"]?.safeInteger, docs: metrics?["docs_total"]?.safeInteger,
                                namesExcluded: metrics?["names_excluded"]?.safeInteger)
    var out = ExpressionResponse(expression: ExpressionInfo(id: ExpressionID(rawValue: expr.id), surface: expr.surface,
                                                            norm: expr.norm, kind: expr.kind, lang: expr.lang,
                                                            synthetic: expr.isSynthetic, corpus: corpus),
                                 variants: variants, state: nullStates(state), claims: expr.isSynthetic ? [] : try claims(c, id))
    out.expression.$corpus = corpus.map { .value($0) } ?? .null
    return out
  }

  /// The reference writes every state key (null when unknown): `@NullOrAbsent` keys set to explicit nulls.
  static func nullStates(_ s: ExpressionState) -> ExpressionState {
    var out = s
    out.$job = s.job.map { .value($0) } ?? .null
    out.$run = s.run.map { .value($0) } ?? .null
    out.$n = s.n.map { .value($0) } ?? .null
    out.$docs = s.docs.map { .value($0) } ?? .null
    out.$namesExcluded = s.namesExcluded.map { .value($0) } ?? .null
    return out
  }

  // MARK: claims (Wiktionary attestation claims, §10.2)

  static let wiktionaryLicense = "CC BY-SA 4.0 / GFDL"
  static let wiktionaryAttribution = "Wiktionary contributors; extracted with Wiktextract (Ylonen 2022) via kaikki.org"

  /// `expressionClaims(db, id)`: the markers left of a strand (default display first, then by year).
  public static func claims(_ c: Connection, _ id: Int64) throws -> [ClaimMarker] {
    let s = try c.prepared(MatchSQL.claims)
    try s.bind([.int(id)])
    let rows = try s.all { r in
      (loYear: r.intOrNil(2).map(Int.init), hiYear: r.intOrNil(3).map(Int.init), raw: r.textOrNil(6), note: r.textOrNil(8))
    }
    let markers = rows.map { row -> ClaimMarker in
      let n = row.note.flatMap { try? JSONValue.parse($0) }?.objectValue
      guard let n else {
        let label = JSString.split(row.note ?? "", ";")[0]
        return ClaimMarker(label: label, date: ClaimDate(loYear: row.loYear, hiYear: row.hiYear, label: row.raw), display: "dimmed",
                           reasons: ["note not structured"], source: "wiktionary", license: wiktionaryLicense,
                           attribution: wiktionaryAttribution, relation: nil, highlight: nil)
      }
      func str(_ k: String) -> String? { n[k]?.stringValue }
      let dateText: String? = n.keys.contains("date_text") ? str("date_text") : row.raw
      var highlight: PassageSpan?
      if let p = n["passage"]?.safeInteger, p != 0, let inEx = n["span_in_excerpt"], inEx != .null, inEx != .bool(false),
        let a = n["span_start"]?.safeInteger, let b = n["span_end"]?.safeInteger
      {
        highlight = PassageSpan(passage: PassageID(rawValue: Int64(p)), start: a, end: b)
      }
      let reasons = n["reasons"]?.arrayValue?.compactMap(\.stringValue) ?? []
      var m = ClaimMarker(label: str("label") ?? "", date: ClaimDate(loYear: row.loYear, hiYear: row.hiYear, label: dateText),
                          display: str("display") == "default" ? "default" : "dimmed", reasons: reasons, source: "wiktionary",
                          license: n.keys.contains("license") ? str("license") : wiktionaryLicense,
                          attribution: n.keys.contains("attribution") ? str("attribution") : wiktionaryAttribution,
                          relation: str("relation"), highlight: highlight)
      m.$highlight = highlight.map { .value($0) } ?? .null
      return m
    }
    return stableSorted(markers) { a, b in
      let da = a.display == "default" ? 0 : 1, db = b.display == "default" ? 0 : 1
      if da != db { return da < db }
      return (a.date.loYear ?? 0) < (b.date.loYear ?? 0)
    }
  }
}

/// The input fingerprint of a run (jobs/context.mjs inputFingerprint; ScrollsJobs' `Runs.inputFingerprint` computes the
/// same value when a run starts): its scope, the newest committed import batch of each collection in scope, the passage
/// quality version, upstream runs, tokenizer and segmenter.
public enum Fingerprint {
  public static func input(_ c: Connection, scope: JSONValue, upstream: [Int64] = []) throws -> String {
    let wanted: [String]? = scope["collections"]?.arrayValue?.map { v in
      switch v {
      case .string(let s): s
      case .number(let n): JSNumber.format(n)
      default: CanonicalJSON.string(v)
      }
    }
    var batches = JSONObject()
    for r in try c.prepared(MatchSQL.collectionBatches).all({ (slug: $0.text(0), id: $0.int(1), batch: $0.intOrNil(2)) }) {
      if wanted == nil || wanted!.contains(where: { JSString.equal($0, r.slug) || $0 == String(r.id) }) {
        batches[r.slug] = .number(Double(r.batch ?? 0))
      }
    }
    let body: JSONValue = .object([
      "scope": scope, "batches": .object(batches), "quality": .string(try Meta.get(c, "quality_version") ?? "0"),
      "upstream": .array(upstream.sorted().map { .number(Double($0)) }),
      "tokenizer": .string(Tokenizer.version), "segmenter": .string(StoreVersions.segmenter),
    ])
    return IDs.sha256Hex(CanonicalJSON.string(body))
  }
}
