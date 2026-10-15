// OWNER: N4
// GET /api/collocations in process (collocations.mjs `collocationsQuery`, `storedCollocations`, `streamsGate`): the
// collocates of an expression in one slice, or the gate with a widening suggestion and the KWIC rows shown instead.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The query of GET /api/collocations, as the route hands it to the reference's `collocationsQuery`.
public struct CollocationsArgs: Sendable {
  public var expr: String
  public var slice: String
  public var f: String
  public var toggles: JSONValue
  public var stop: JSONValue
  public var corpus: String?
  public var seed: JSONValue
  public var lane: String?
  public var limit: Int

  /// `limitParam(q, {max: 200, dflt: 100})` of the route, from the query string.
  public static func limit(_ raw: String?) throws -> Int {
    guard let raw, !raw.isEmpty else { return 100 }
    let n = JSNumber.parse(raw)
    guard n.isFinite, n.rounded(.towardZero) == n, n >= 1 else {
      throw ScrollsError.badRequest(.badLimit, "limit must be a positive integer (got '\(raw)').", hint: "Use 1–200.")
    }
    return Int(min(n, 200))
  }

  public init(expr: String, slice: String, f: String = "", toggles: JSONValue = [:], stop: JSONValue = .null, corpus: String? = nil,
              seed: JSONValue = .null, lane: String? = nil, limit: Int = 100) {
    self.expr = expr
    self.slice = slice
    self.f = f
    self.toggles = toggles
    self.stop = stop
    self.corpus = corpus
    self.seed = seed
    self.lane = lane
    self.limit = limit
  }
}

extension Collocations {
  static func parseSlice(_ raw: String) throws -> (Int, Int) {
    let s = JSString.trim(raw)
    let bad = ScrollsError.badRequest(.validation, "slice must be 'lo-hi' years (got '\(raw)').", hint: "Use e.g. slice=1994-2026.",
                                      detail: ["field": "slice"])
    // /^(-?\d{1,5})(?:-|\.\.)(-?\d{1,5})$/
    let u = Array(s.utf8)
    func number(_ i: inout Int) -> Int? {
      let start = i
      if i < u.count, u[i] == 0x2D { i += 1 }
      let digitsStart = i
      while i < u.count, u[i] >= 0x30 && u[i] <= 0x39, i - digitsStart < 5 { i += 1 }
      guard i > digitsStart else { return nil }
      return Int(String(decoding: u[start..<i], as: UTF8.self))
    }
    var i = 0
    guard let lo = number(&i) else { throw bad }
    if i < u.count, u[i] == 0x2D { i += 1 } else if i + 1 < u.count, u[i] == 0x2E, u[i + 1] == 0x2E { i += 2 } else { throw bad }
    guard let hi = number(&i), i == u.count else { throw bad }
    return (lo, hi)
  }

  static func parseExpr(_ raw: String) throws -> [Int] {
    let parts = JSString.split(raw, ",").map(JSString.trim).filter { !$0.isEmpty }.map(JSNumber.parse)
    guard !parts.isEmpty, parts.count <= 2, parts.allSatisfy({ JSNumber.isSafeInteger($0) && $0 > 0 }) else {
      throw ScrollsError.badRequest(.validation, "expr must be one or two expression ids (got '\(raw)').",
                                    hint: "Track the expression first.", detail: ["field": "expr"])
    }
    return parts.map { Int($0) }
  }

  /// The modality a single slice is read in: the one holding most of its matches (then most documents).
  static func leadingModality(_ ev: JSMap<(n: Int, docs: Int, units: Int)>) -> String {
    ev.entries.jsSorted { x, y in
      x.value.n != y.value.n ? Double(y.value.n - x.value.n) : Double(y.value.docs - x.value.docs)
    }.first?.key ?? "text"
  }

  static func thresholdsOut() -> JSONValue { CompareBlocks.thresholdsOut() }

  /// Canonical params of a collocation run (`collocationRunParams`).
  static func runParams(_ exprs: [ResolvedExpression], _ slice: SliceRequest, _ toggles: Toggles) -> JSONValue {
    ["expr": .ints(exprs.map(\.id)), "materialize": .ints(exprs.map(\.run)), "years": .ints([slice.lo, slice.hi]),
     "f": .string(slice.f), "toggles": toggles.json, "window": .int(window), "version": .string(version)]
  }

  /// Rows of a succeeded collocations run with the same params and inputs (`storedCollocations`).
  static func stored(_ c: Connection, params: JSONValue, collections: [String], expr: Int, slice: SliceRequest) throws
    -> (run: Int, rows: [JSONValue])?
  {
    let hash = sha256Hex(CanonicalJSON.string(params))
    let upstream = params["materialize"]?.arrayValue?.compactMap { $0.numberValue.map { Int($0) } } ?? []
    let fp = try StoredRuns.inputFingerprint(c, scope: ["collections": .strings(collections)], upstream: upstream)
    guard let run = try c.first(AnalysisSQL.storedCollocationRun, [.text(hash), .text(fp)], { $0.i(0) }) else { return nil }
    let key = "\(slice.lo)..\(slice.hi)|\(slice.f)"
    let rows = try c.rows(AnalysisSQL.storedCollocations, [.int(Int64(run)), .int(Int64(expr)), .text(key)]) { r -> JSONValue in
      ["term": .string(r.text(0)), "f_xy": r.json(1), "f_y": r.json(2), "g2": r.json(3), "q": r.json(4), "logDice": r.json(5),
       "ppmi": r.json(6)]
    }
    return (run, rows)
  }

  /// The collocations payload (`collocationsQuery`).
  public static func query(_ c: Connection, text: any TextStore, args: CollocationsArgs, env: AnalysisEnvironment) throws -> JSONValue {
    EngineAssert.offMain()
    let ids = try parseExpr(args.expr)
    let years = try parseSlice(args.slice)
    let slice = try SliceRequests.normalizeSlice(["years": .ints([years.0, years.1]), "f": .string(args.f)], "a")
    let toggles = Toggles.normalize(args.toggles)
    let showStop: Bool = switch args.stop {
    case .number(1), .string("1"), .bool(true): true
    default: false
    }
    let exprs = try Expressions.resolve(c, ids: ids, pinned: nil)
    let scope = try Scopes.load(c, exprs: exprs, slices: [slice], toggles: toggles, corpus: args.corpus, cutoffs: nil)
    let spec = scope.specs[0]
    let modality = leadingModality(Slices.modalityEvidence(scope, spec))
    let stats = Slices.stats(scope, spec, modality)
    let label = exprs.map(\.surface).joined(separator: " + ")
    let collections = stats.collections.sorted
    var licenses = JSSet()
    for s in collections { if let l = scope.collection(slug: s)?.license, !l.isEmpty { licenses.insert(l) } }
    var materialize = JSONObject()
    for e in exprs { materialize[String(e.id)] = .int(e.run) }
    var provenance: JSONObject = [
      "data_version": .int(try Meta.dataVersion(c)), "run_ids": ["materialize": .object(materialize)],
      "tokenizer": .string(Tokenizer.version), "segmenter": "seg-1",
      "synthetic": .bool(stats.synthetic || exprs.contains { $0.synthetic }), "collections": .strings(collections),
      "licenses": .strings(licenses.sorted),
    ]
    let base: JSONObject = [
      "expr": ids.count == 1 ? .int(ids[0]) : .ints(ids), "expression_label": .string(label), "label": .string(contextLabel),
      "slice": .string("\(slice.lo)-\(slice.hi)"), "f": .string(slice.f), "modality": .string(modality),
      "window": .string("±\(window) tokens"), "measure": "logDice",
    ]
    let need = Thresholds.Collocates.occurrences
    var reader = PassageTextReader(c, text)

    if stats.n < need {
      let index = WideningIndex.build(scope, spec, modality)
      let w = Gates.widenSuggestion(index, years: slice.years, crit: WidenCriteria(occurrences: need))
      let suggestion: JSONValue = w.map { w in
        ["label": .string(Gates.widenLabel(nil, w.years, "\(w.stats.n) occurrences")), "slice": .string("\(w.years.0)-\(w.years.1)"),
         "years": .ints([w.years.0, w.years.1]), "f": .string(slice.f),
         "would_have": ["occurrences": .int(w.stats.n), "documents": .int(w.stats.docs)]]
      } ?? .null
      let seed: Double = {
        let n: Double = switch args.seed {
        case .number(let x): x
        case .string(let s): JSNumber.parse(s)
        case .bool(let b): b ? 1 : 0
        default: .nan
        }
        return n.isNaN || n == 0 ? 1 : n
      }()
      var rng = Mulberry32(seed: JSNumber.toUint32(seed))
      let kwic = try Passages.sample(c, scope, spec, stats, rng: &rng, count: 10, laneFacet: args.lane ?? "collection", reader: &reader)
      var extra = base
      extra["kwic"] = .array(kwic)
      extra["provenance"] = .object(provenance)
      let note = Gates.collocatesNote(a: .value(Double(stats.n)), b: .absent, needed: need)
        + (suggestion.isNull ? " No widening inside this corpus reaches the gate." : "")
      return .object(Gates.gated("insufficient_occurrences", needed: ["occurrences": .int(need)], have: ["occurrences": .int(stats.n)],
                                 suggestion: suggestion, note: .string(note), extra: extra))
    }

    let params = runParams(exprs, slice, toggles)
    if let stored = try stored(c, params: params, collections: collections, expr: exprs[0].id, slice: slice) {
      let stop = stopSet(stats.languages.keys)
      let rows = stored.rows.filter { showStop || !stop.contains($0["term"]?.stringValue ?? "") }.prefix(args.limit)
      var o = base
      o["gate"] = "ok"
      o["thresholds"] = thresholdsOut()
      o["collocates"] = .array(Array(rows))
      o["source"] = "stored"
      o["run"] = .int(stored.run)
      o["f_x"] = .int(stats.n)
      var runIds = provenance["run_ids"]!.objectValue!
      runIds["collocations"] = .int(stored.run)
      provenance["run_ids"] = .object(runIds)
      o["provenance"] = .object(provenance)
      return .object(o)
    }
    let ctx = try sliceContexts(c, scope, spec, stats, reader: &reader, streams: env.tokenStreams)
    if let u = ctx.unavailable { return .object(streamsGate(base, u, .object(provenance))) }
    let x = ctx.counts!
    let scored = collocates(x, showStop: showStop, limit: args.limit)
    var o = base
    o["gate"] = "ok"
    o["thresholds"] = thresholdsOut()
    o["collocates"] = .array(scored.rows.map { r in
      ["term": .string(r.term), "f_xy": .int(r.fXY), "f_y": .int(r.fY), "logDice": .number(r.logDice), "ppmi": .number(r.ppmi),
       "g2": .number(r.g2), "q": .number(r.q)]
    })
    o["candidates"] = .int(scored.candidates)
    o["hidden_stopwords"] = .int(scored.hiddenStopwords)
    o["source"] = .string(x.source)
    o["f_x"] = .int(x.fx)
    o["window_positions"] = .int(x.W)
    o["slice_tokens"] = .int(x.N)
    o["provenance"] = .object(provenance)
    return .object(o)
  }

  /// The gate when a slice is too large to tokenize on the fly and its token streams are missing or stale.
  static func streamsGate(_ base: JSONObject, _ u: Unavailable, _ provenance: JSONValue) -> JSONObject {
    var extra = base
    extra["provenance"] = provenance
    let states = u.status.filter { s in u.langs.contains(s.lang) }
    return Gates.gated(
      "not_run", needed: ["token_streams": .strings(u.langs)], have: ["token_streams": u.statusJSON, "slice_tokens": .int(u.tokens)],
      suggestion: ["label": .string("Build token streams for \(u.langs.joined(separator: ", "))"),
                   "run": ["stage": "tokstream", "params": ["langs": .strings(u.langs)]]],
      note: .string("Collocates for a slice of \(u.tokens) tokens need current token streams (\(u.langs.map { l in "\(l): \(states.first { $0.lang == l }?.words ?? "undefined")" }.joined(separator: "; "))))."),
      extra: extra)
  }
}
