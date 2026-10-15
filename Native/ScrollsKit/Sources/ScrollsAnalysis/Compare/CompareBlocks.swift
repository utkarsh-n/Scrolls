// OWNER: N4
// The blocks of a Compare payload after frequency (compare.mjs): the prominence check, neighbouring terms, context
// groups from a clustering run with document-block bootstrap CIs, the evidence gates of the three drift measures and
// what stored runs hold for them, the verdict, the vector spaces, machine tone, OpenAlex within-cell shares and the
// human annotation counts. Every gated block is a `Gates.gated` object: no numeral where the measure would be.

import Foundation
import ScrollsCore
import ScrollsStore

/// A computed context-groups block and what measure (a) reads from it.
struct ContextGroups {
  var block: JSONObject
  var run: StoredRuns.ClusterRun?
  var blocksA: [[Double]]
  var blocksB: [[Double]]
}

enum CompareBlocks {
  static let r4 = CompareEngine.r4
  static let r2 = CompareEngine.r2

  // ── prominence ──

  /// Rate direction per prominence tercile (§2.E item 1); terciles pointing both ways fire the caveat.
  static func prominenceCheck(_ a: SliceStats, _ b: SliceStats) -> JSONObject {
    var rows: [JSONObject] = []
    var dirs = Set<String>()
    var comparable = 0
    for t in ["1", "2", "3"] {
      let ta = a.terciles[t], tb = b.terciles[t]
      if ta == nil && tb == nil { continue }
      let na = a.unit == "tokens" ? ta?.n ?? 0 : ta?.k ?? 0
      let nb = b.unit == "tokens" ? tb?.n ?? 0 : tb?.k ?? 0
      let ua = ta?.units ?? 0, ub = tb?.units ?? 0
      var direction: String?
      var ci: JSONValue = .null
      if ua > 0 && ub > 0 && na + nb > 0 {
        let rr = Intervals.poissonRateRatio(Double(na), Double(ua), Double(nb), Double(ub))
        ci = CompareEngine.ci2(rr.ci?.0, rr.ci?.1)
        let lo = rr.ci?.0, hi = rr.ci?.1
        direction = (lo ?? -.infinity) > 1 ? "up" : hi != nil && hi! < 1 ? "down" : "flat"
      }
      if let direction {
        dirs.insert(direction)
        comparable += 1
      } else {
        dirs.insert("null")
      }
      rows.append(["tercile": .int(Int(t)!), "a": ["n": .int(na), "units": .int(ua)], "b": ["n": .int(nb), "units": .int(ub)],
                   "direction": .str(direction), "ratio_ci": ci])
    }
    if comparable < 2 {
      return ["consistent": .null, "terciles": .array(rows.map(JSONValue.object)),
              "note": .string(rows.isEmpty ? "no prominence data in these slices" : "fewer than two prominence terciles are covered by both slices")]
    }
    let split = dirs.contains("up") && dirs.contains("down")
    return ["consistent": .bool(!split), "terciles": .array(rows.map(JSONValue.object)),
            "note": split ? "result depends on prominence stratum" : .null]
  }

  // ── neighbouring terms ──

  static func thresholdsOut() -> JSONValue {
    ["g2": .number(Thresholds.Collocates.g2), "f": .int(Thresholds.Collocates.fXY), "f_y": .int(Thresholds.Collocates.fY),
     "q": .number(Thresholds.Collocates.q), "min_occurrences": .int(Thresholds.Collocates.occurrences)]
  }

  static func neighbourTerms(_ c: Connection, _ cx: CompareContext, reader: inout PassageTextReader) throws -> JSONObject {
    let need = Thresholds.Collocates.occurrences
    let statsA = cx.statsA, statsB = cx.statsB
    let base: JSONObject = ["label": .string(Collocations.contextLabel), "window": .string("±\(Collocations.window) tokens"),
                            "measure": "logDice", "thresholds": thresholdsOut()]
    if statsA.n < need || statsB.n < need {
      let suggestion = cx.suggest(a: statsA.n < need, b: statsB.n < need, WidenCriteria(occurrences: need), Describe(
        text: { "\(Format.count(Double($0.n))) occurrences" }, data: { ["occurrences": .int($0.n)] }))
      let note = Gates.collocatesNote(a: .value(Double(statsA.n)), b: .value(Double(statsB.n)), needed: need)
        + (suggestion != nil ? "" : " No widening inside this corpus reaches the gate.")
      return Gates.gated("insufficient_occurrences", needed: ["occurrences": .int(need)],
                         have: ["a": .int(statsA.n), "b": .int(statsB.n)], suggestion: suggestion.map(JSONValue.object) ?? .null,
                         note: .string(note), extra: base)
    }
    let ca = try Collocations.sliceContexts(c, cx.scope, cx.specA, statsA, reader: &reader, streams: cx.env.tokenStreams)
    let cb = try Collocations.sliceContexts(c, cx.scope, cx.specB, statsB, reader: &reader, streams: cx.env.tokenStreams)
    if ca.unavailable != nil || cb.unavailable != nil {
      var langs = JSSet(ca.unavailable?.langs ?? [])
      for l in cb.unavailable?.langs ?? [] { langs.insert(l) }
      let ta = Double(ca.unavailable?.tokens ?? ca.counts!.N), tb = Double(cb.unavailable?.tokens ?? cb.counts!.N)
      return Gates.gated(
        "not_run", needed: ["token_streams": .strings(langs.array)],
        have: ["a": ca.unavailable?.statusJSON ?? "current", "b": cb.unavailable?.statusJSON ?? "current"],
        suggestion: ["label": .string("Build token streams for \(langs.array.joined(separator: ", "))"),
                     "run": ["stage": "tokstream", "params": ["langs": .strings(langs.array)]]],
        note: .string("Collocates for slices this large (\(Format.tokens(ta)) and \(Format.tokens(tb)) tokens) need current token streams."),
        extra: base)
    }
    let xa = ca.counts!, xb = cb.counts!
    let sa = Collocations.collocates(xa, limit: 1000), sb = Collocations.collocates(xb, limit: 1000)
    let inA = JSSet(sa.rows.map(\.term))
    var inB: [JSKey: Collocations.Row] = [:]
    for r in sb.rows { inB[JSKey(r.term)] = r }
    func brief(_ r: Collocations.Row) -> JSONValue {
      ["term": .string(r.term), "f_xy": .int(r.fXY), "logDice": .number(r.logDice), "g2": .number(r.g2), "q": .number(r.q),
       "ppmi": .number(r.ppmi)]
    }
    var stop = xa.stop
    for s in xb.stop { stop.insert(s) }
    func drop(_ m: JSMap<Double>) -> JSMap<Double> {
      var out = JSMap<Double>()
      for (t, v) in m where !stop.contains(t) { out[t] = v }
      return out
    }
    let key = Keyness.keyness(drop(xa.fxy), drop(xb.fxy), totalA: Double(xa.W), totalB: Double(xb.W)).map { r -> JSONValue in
      ["term": .string(r.term), "log_ratio": r2(r.logRatio), "q": .number(JSRound.precision(r.q, 3)), "side": .string(r.side),
       "f_a": .number(r.fA), "f_b": .number(r.fB)]
    }
    var out = base
    out["gate"] = "ok"
    out["a"] = .array(sa.rows.filter { inB[JSKey($0.term)] == nil }.prefix(50).map(brief))
    out["b"] = .array(sb.rows.filter { !inA.contains($0.term) }.prefix(50).map(brief))
    out["shared"] = .array(sa.rows.filter { inB[JSKey($0.term)] != nil }.prefix(50).map { r in
      let o = inB[JSKey(r.term)]!
      return ["term": .string(r.term), "a": ["f_xy": .int(r.fXY), "logDice": .number(r.logDice)],
              "b": ["f_xy": .int(o.fXY), "logDice": .number(o.logDice)]]
    })
    out["keyness"] = .array(key)
    out["new_uses"] = .strings(sb.rows.filter { (xa.fxy[$0.term] ?? 0) < 3 }.map(\.term))
    out["declining"] = .strings(sa.rows.filter { (xb.fxy[$0.term] ?? 0) < 3 }.map(\.term))
    out["hidden_stopwords"] = ["a": .int(sa.hiddenStopwords), "b": .int(sb.hiddenStopwords)]
    out["candidates"] = ["a": .int(sa.candidates), "b": .int(sb.candidates)]
    out["f_x"] = ["a": .int(xa.fx), "b": .int(xb.fx)]
    out["window_positions"] = ["a": .int(xa.W), "b": .int(xb.W)]
    out["source"] = ["a": .string(xa.source), "b": .string(xb.source)]
    return out
  }

  // ── context groups ──

  /// The clustering gate over every match of the expression in the slices' collections (`clusterGate`).
  static func clusterGate(_ allTime: WindowStats, _ label: String, run: JSONValue?) -> JSONObject {
    let t = (occurrences: Thresholds.Clustering.occurrences, documents: Thresholds.Clustering.documents)
    let have: JSONObject = ["occurrences": .int(allTime.n), "documents": .int(allTime.docs)]
    let text = "Clustering unavailable: \(Format.count(Double(allTime.n))) occurrences in \(Format.count(Double(allTime.docs))) documents."
    let needed: JSONValue = ["occurrences": .int(t.occurrences), "documents": .int(t.documents)]
    if allTime.n < t.occurrences {
      return Gates.gated("insufficient_occurrences", needed: needed, have: .object(have),
                         note: .string("\(text) '\(label)' needs ≥ \(t.occurrences) in ≥ \(t.documents) documents."))
    }
    if allTime.docs < t.documents {
      return Gates.gated("insufficient_documents", needed: needed, have: .object(have), note: .string(text))
    }
    var h: JSONObject = ["run": .null]
    for (k, v) in have { h[k] = v }
    return Gates.gated("not_run", needed: ["run": "cluster"], have: .object(h),
                       suggestion: run.map { ["label": .string("Group the contexts of '\(label)' (a clustering run)"), "run": $0] } ?? .null,
                       note: "No clustering run exists for this expression yet; context groups need one.")
  }

  /// The clustering run a comparison suggests: this expression, in the compared medium's collections.
  static func clusterRunSuggestion(_ cx: CompareContext) -> JSONValue {
    var params: JSONObject = ["expr": .int(cx.exprs[0].id)]
    if !cx.collectionsUsed.isEmpty { params["collections"] = .strings(cx.collectionsUsed) }
    return ["stage": "cluster", "params": .object(params)]
  }

  static func contextGroups(_ c: Connection, _ cx: CompareContext, allTime: WindowStats) throws -> ContextGroups {
    let single = cx.exprs.count == 1
    let g = clusterGate(allTime, cx.label, run: single ? clusterRunSuggestion(cx) : nil)
    if g["gate"] != "not_run" { return ContextGroups(block: g, run: nil, blocksA: [], blocksB: []) }
    if !single {
      let ng = Gates.gated("not_run", needed: ["expressions": 1], have: ["expressions": .int(cx.exprs.count)],
                           note: "Context groups are found per expression; compare one expression to see them.")
      return ContextGroups(block: ng, run: nil, blocksA: [], blocksB: [])
    }
    if cx.sampled && !cx.descriptive {
      let sg = Gates.gated("sampling_design", needed: ["comparison": "within one OpenAlex cell"],
                           have: ["a": .int(cx.statsA.k), "b": .int(cx.statsB.k)],
                           note: .string("\(Gates.samplingDesignNote) Context-group shares are not compared across its cells."))
      return ContextGroups(block: sg, run: nil, blocksA: [], blocksB: [])
    }
    guard let cr = StoredRuns.clusterRun(c, expr: cx.exprs[0].id, modality: cx.statsA.modality, run: cx.req.runs?.cluster,
                                         before: cx.req.cutoffs?.at, revCutoff: cx.req.cutoffs?.annotationRev)
    else { return ContextGroups(block: g, run: nil, blocksA: [], blocksB: []) }
    let k = cr.clusters.count
    let counts = try StoredRuns.clusterDocCounts(c, cr, expr: cx.exprs[0].id)
    let zero = [Double](repeating: 0, count: k)
    func blocksOf(_ st: SliceStats) -> [[Double]] {
      CompareContext.evidenceDocIds(st).map { counts[$0] ?? zero }.filter { $0.contains { $0 > 0 } }
    }
    let blocksA = blocksOf(cx.statsA), blocksB = blocksOf(cx.statsB)
    func total(_ blocks: [[Double]]) -> [Double] {
      var t = [Double](repeating: 0, count: k)
      for b in blocks { for j in 0..<k { t[j] += b[j] } }
      return t
    }
    let ta = total(blocksA), tb = total(blocksB)
    let nA = ta.reduce(0, +), nB = tb.reduce(0, +)
    let ciA = Bootstrap.shareIntervals(blocksA, k), ciB = Bootstrap.shareIntervals(blocksB, k)
    func share(_ t: [Double], _ n: Double, _ j: Int, _ ci: [(Double, Double)?]) -> JSONValue {
      ["share": n != 0 ? r4(t[j] / n) : .null, "ci": ci[j].map { [r4($0.0), r4($0.1)] } ?? .null, "n": .number(t[j])]
    }
    var rows: [JSONObject] = []
    for (j, cl) in cr.clusters.enumerated() {
      var row: JSONObject = ["cluster": .int(cl.id), "ord": .int(cl.ord), "label": .string(cl.label), "status": .string(cl.status),
                             "a": share(ta, nA, j, ciA), "b": share(tb, nB, j, ciB)]
      if let h = cl.humanLabel { row["human_label"] = .string(h) }
      rows.append(row)
    }
    func shareOf(_ r: JSONObject, _ s: String) -> Double? { r[s]?["share"]?.numberValue }
    let isNew = { (r: JSONObject) in shareOf(r, "a") != nil && shareOf(r, "b") != nil && shareOf(r, "a")! < 0.02 && shareOf(r, "b")! >= 0.10 }
    let isGone = { (r: JSONObject) in shareOf(r, "a") != nil && shareOf(r, "b") != nil && shareOf(r, "b")! < 0.02 && shareOf(r, "a")! >= 0.10 }
    func name(_ r: JSONObject) -> JSONValue { r["human_label"] ?? r["label"]! }
    let block: JSONObject = [
      "gate": "ok", "run": .int(cr.run), "representation": .str(cr.representation), "modality": .str(cr.modality), "k": .int(k),
      "shares": .array(rows.map(JSONValue.object)), "n": ["a": .number(nA), "b": .number(nB)],
      "docs": ["a": .int(blocksA.count), "b": .int(blocksB.count)],
      "new_uses": .array(rows.filter(isNew).map(name)), "declining": .array(rows.filter(isGone).map(name)),
      "note": "Context groups are machine hypotheses about usage contexts (context words, not meanings); shares count occurrences with a group, with document-block bootstrap 95% CIs.",
    ]
    return ContextGroups(block: block, run: cr, blocksA: blocksA, blocksB: blocksB)
  }

  // ── drift measures ──

  /// JSD (base 2) between two count vectors; nil when either is empty (`jsdCounts`).
  static func jsdCounts(_ p: [Double], _ q: [Double]) -> Double? {
    var sp = 0.0, sq = 0.0
    for i in 0..<p.count {
      sp += p[i]
      sq += q[i]
    }
    if !(sp > 0 && sq > 0) { return nil }
    var v = 0.0
    for i in 0..<p.count {
      let a = p[i] / sp, b = q[i] / sq, m = (a + b) / 2
      if a > 0 { v += 0.5 * a * jsLog2(a / m) }
      if b > 0 { v += 0.5 * b * jsLog2(b / m) }
    }
    return jsMin(1, jsMax(0, v))
  }

  /// Context-share shift from per-document context-group counts (`contextShareShift`).
  static func contextShareShift(_ blocksA: [[Double]], _ blocksB: [[Double]], _ k: Int) -> (value: Double?, ci: (Double, Double)?) {
    func sum(_ blocks: [[Double]]) -> [Double] {
      var t = [Double](repeating: 0, count: k)
      for b in blocks { for i in 0..<k { t[i] += b[i] } }
      return t
    }
    let value = jsdCounts(sum(blocksA), sum(blocksB))
    let ci = value == nil ? nil : Bootstrap.twoSampleBootstrap(blocksA, blocksB, resamples: 1000, seed: 42) { a, b in
      jsdCounts(sum(a), sum(b))
    }
    return (value, ci)
  }

  static func ordinalPct(_ p: Double) -> String {
    let x = Int(JSNumber.round(p))
    let s = x % 100 >= 11 && x % 100 <= 13 ? "th" : x % 10 == 1 ? "st" : x % 10 == 2 ? "nd" : x % 10 == 3 ? "rd" : "th"
    return "\(x)\(s)"
  }

  /// The §2.E sentence of a passing measure (`measureSentence`).
  static func measureSentence(_ metric: String, _ m: JSONObject, n: [Int], docs: [Int], overlap: JSONObject? = nil, verdict: String? = nil) -> String {
    let counts = "n = \(n.map { Format.count(Double($0)) }.joined(separator: " / ")) · \(docs.map { Format.count(Double($0)) }.joined(separator: " / ")) documents"
    let shift = "estimated shift in usage contexts"
    func fx(_ v: JSONValue?) -> String { JSNumber.toFixed(v?.numberValue ?? .nan, 2) }
    if metric == "sense_share_jsd" {
      let ci = m["ci"]?.arrayValue.map { " [\(fx($0[0])), \(fx($0[1]))]" } ?? ""
      return "Context-share shift JSD \(fx(m["value"]))\(ci) · \(counts) — an \(shift)."
    }
    if metric == "neighbor_overlap" {
      let k = m["k"]?.numberValue.map(JSNumber.format) ?? "25"
      return "Neighbour overlap \(fx(m["jaccard"])) (Jaccard of the top \(k) neighbours; 1 − J = \(fx(m["value"]))) · "
        + "\(ordinalPct(m["percentile"]?.numberValue ?? .nan)) percentile of \(Format.count(m["controls"]?.numberValue)) frequency-matched controls · \(counts)."
    }
    let tail = overlap?["gate"] == "ok" ? " · neighbour overlap \(fx(overlap?["jaccard"]))" : ""
    return "Aligned displacement \(fx(m["value"])) · \(ordinalPct(m["percentile"]?.numberValue ?? .nan)) percentile of \(Format.count(m["controls"]?.numberValue)) frequency-matched controls\(tail)"
      + "\(verdict.map { " → \($0)" } ?? "") · \(counts) — an \(shift)."
  }

  /// The §4.9 verdict: notable only if (c)'s percentile reaches 100 − 5/k and (b)'s Jaccard is ≤ 0.2.
  static func verdict(_ d: JSONObject?, _ o: JSONObject?, k: Int) -> String? {
    guard d?["gate"] == "ok", o?["gate"] == "ok" else { return nil }
    // JavaScript relational operators: null reads as 0, an absent key as NaN
    func num(_ v: JSONValue?) -> Double {
      switch v {
      case .number(let x)?: x
      case .null?: 0
      default: .nan
      }
    }
    return num(d?["percentile"]) >= Multiplicity.notableThreshold(k) && num(o?["jaccard"]) <= 0.2 ? "notable" : "within typical variation"
  }

  /// §4.9 (b)/(c): each slice must hold enough running text for its own space (`spaceSizeGate`).
  static func spaceSizeGate(_ cx: CompareContext, tokens: Int) -> JSONObject? {
    let a = cx.statsA, b = cx.statsB
    if a.unit != "tokens" || b.unit != "tokens" {
      return Gates.gated("slice_too_small", needed: ["tokens_per_slice": .int(tokens)], have: ["a": .null, "b": .null],
                         note: "Slice spaces need running text; these slices are counted in works (titles), so no space can be built.")
    }
    let failA = a.unitsNoTr < tokens, failB = b.unitsNoTr < tokens
    if !failA && !failB { return nil }
    let suggestion = cx.suggest(a: failA, b: failB, WidenCriteria(tokensNoTr: tokens), Describe(
      text: { "\(Format.tokens(Double($0.unitsNoTr))) tokens" }, data: { ["tokens": .int($0.unitsNoTr)] }))
    var parts: [String] = []
    if failA { parts.append("slice A has \(Gates.tokensHave(Double(a.unitsNoTr))) tokens") }
    if failB { parts.append("slice B has \(Gates.tokensHave(Double(b.unitsNoTr))) tokens") }
    let note = "Not estimated: \(parts.joined(separator: " and ")) (needs \(Format.tokens(Double(tokens))))"
      + (suggestion.map { ". \($0["label"]?.stringValue ?? "") would reach it." } ?? "; \(Gates.noWideningNote)")
    return Gates.gated("slice_too_small", needed: ["tokens_per_slice": .int(tokens)],
                       have: ["a": .int(a.unitsNoTr), "b": .int(b.unitsNoTr)], suggestion: suggestion.map(JSONValue.object) ?? .null,
                       note: .string(note))
  }

  /// The evidence gate of one drift measure (`driftGate`); it never returns a value.
  static func driftGate(_ metric: String, _ cx: CompareContext, allTime: WindowStats, runs: (cluster: JSONValue?, drift: JSONValue)) -> JSONObject {
    let a = cx.statsA, b = cx.statsB
    let counts: JSONObject = ["n": .ints([a.n, b.n]), "docs": .ints([a.evidenceDocs, b.evidenceDocs]),
                              "authors": .ints([a.evidenceAuthors.count, b.evidenceAuthors.count])]
    func out(_ gate: JSONObject) -> JSONObject {
      var o: JSONObject = ["metric": .string(metric)]
      for (k, v) in gate { o[k] = v }
      for (k, v) in counts { o[k] = v }
      return o
    }
    if cx.descriptive {
      return out(Gates.gated("modality_mismatch", needed: ["modality": "same"], have: ["a": .string(a.modality), "b": .string(b.modality)]))
    }
    if cx.sampled {
      return out(Gates.gated("sampling_design", needed: ["comparison": "within one OpenAlex cell"], have: ["a": .int(a.k), "b": .int(b.k)],
                             note: .string(Gates.samplingDesignNote)))
    }
    func sl(_ st: SliceStats) -> JSONObject {
      ["occurrences": .int(st.n), "documents": .int(st.evidenceDocs), "authors": .int(st.evidenceAuthors.count),
       "top_document_share": r4(st.topDocShare)]
    }
    let noWiden = " No widening inside this corpus reaches the gate ('\(cx.label)' has \(Format.count(Double(allTime.n))) matches in all)."
    let driftRun: JSONValue = ["label": "Estimate it: build the two slice spaces and their controls (a drift run, minutes)", "run": runs.drift]

    if metric == "sense_share_jsd" {
      typealias T = Thresholds.SenseShareJSD
      let checks: [(String, (SliceStats) -> Bool)] = [
        ("insufficient_occurrences", { $0.n >= T.occurrences }), ("insufficient_documents", { $0.evidenceDocs >= T.documents }),
        ("insufficient_authors", { $0.evidenceAuthors.count >= T.authors }),
        ("single_source", { $0.topDocShare != nil && $0.topDocShare! <= T.topDocShare }),
      ]
      for (code, ok) in checks {
        let failA = !ok(a), failB = !ok(b)
        if !failA && !failB { continue }
        let crit = WidenCriteria(occurrences: T.occurrences, documents: T.documents, authors: T.authors, maxTopDocShare: T.topDocShare)
        let suggestion = cx.suggest(a: failA, b: failB, crit, cx.evidenceText)
        let needs = "context-share shift needs ≥ \(T.occurrences) per slice in ≥ \(T.documents) documents by ≥ \(T.authors) authors, no document holding more than half"
        let note = "Not estimated. A has \(Format.count(Double(a.n))) occurrences in \(Format.count(Double(a.evidenceDocs))) documents, B \(Format.count(Double(b.n))) in \(Format.count(Double(b.evidenceDocs))); \(needs)."
          + (suggestion.map { " \($0["label"]?.stringValue ?? "") would reach it." } ?? noWiden)
        return out(Gates.gated(code, needed: ["occurrences_per_slice": .int(T.occurrences), "documents_per_slice": .int(T.documents),
                                              "authors_per_slice": .int(T.authors), "max_top_document_share": .number(T.topDocShare)],
                               have: ["a": .object(sl(a)), "b": .object(sl(b))], suggestion: suggestion.map(JSONValue.object) ?? .null,
                               note: .string(note)))
      }
      return out(Gates.gated("not_run", needed: ["run": "cluster", "clusters": 2], have: ["run": .null],
                             suggestion: runs.cluster.map { ["label": .string("Group the contexts of '\(cx.label)' (a clustering run)"), "run": $0] } ?? .null,
                             note: "Not estimated yet: the evidence gate passes; context-share shift needs a clustering run with at least two context groups."))
    }

    if metric == "neighbor_overlap" {
      typealias T = Thresholds.NeighborOverlap
      let failA = a.n < T.occurrences, failB = b.n < T.occurrences
      if failA || failB {
        let suggestion = cx.suggest(a: failA, b: failB, WidenCriteria(occurrences: T.occurrences), Describe(
          text: { "\(Format.count(Double($0.n))) occurrences" }, data: { ["occurrences": .int($0.n)] }))
        var parts: [String] = []
        if failA { parts.append("in \(Gates.rangeLabel(a.years)) (\(Format.count(Double(a.n))); needs \(T.occurrences))") }
        if failB { parts.append("in \(Gates.rangeLabel(b.years)) (\(Format.count(Double(b.n))); needs \(T.occurrences))") }
        let rare = "Word too rare " + parts.joined(separator: " and ")
        return out(Gates.gated("insufficient_occurrences", needed: ["occurrences_per_slice": .int(T.occurrences)],
                               have: ["a": .int(a.n), "b": .int(b.n)], suggestion: suggestion.map(JSONValue.object) ?? .null,
                               note: .string(rare + (suggestion.map { ". \($0["label"]?.stringValue ?? "") would reach it." } ?? "; \(Gates.noWideningNote)"))))
      }
      if let g = spaceSizeGate(cx, tokens: T.tokens) { return out(g) }
      return out(Gates.gated("not_run", needed: ["run": "drift"], have: ["run": .null], suggestion: driftRun,
                             note: "Not estimated yet: the evidence gate passes; neighbour overlap needs the two slice spaces (a drift run)."))
    }

    typealias T = Thresholds.AlignedDisplacement
    if let g = spaceSizeGate(cx, tokens: T.tokens) { return out(g) }
    let checks: [(String, String, Int, (SliceStats) -> Bool)] = [
      ("insufficient_occurrences", "occurrences", T.occurrences, { $0.n >= T.occurrences }),
      ("insufficient_documents", "documents", T.documents, { $0.evidenceDocs >= T.documents }),
      ("insufficient_authors", "authors", T.authors, { $0.evidenceAuthors.count >= T.authors }),
    ]
    for (code, key, need, ok) in checks {
      let failA = !ok(a), failB = !ok(b)
      if !failA && !failB { continue }
      let suggestion = cx.suggest(a: failA, b: failB, WidenCriteria(occurrences: T.occurrences, documents: T.documents, authors: T.authors,
                                                                    tokensNoTr: T.tokens), cx.evidenceText)
      return out(Gates.gated(code, needed: ["\(key)_per_slice": .int(need)], have: ["a": sl(a)[key]!, "b": sl(b)[key]!],
                             suggestion: suggestion.map(JSONValue.object) ?? .null,
                             note: suggestion != nil ? .null : .string(Gates.noWideningNote)))
    }
    if let jsd = cx.jsd, jsd > Composition.mismatchJSD {
      return out(Gates.gated("composition_mismatch", needed: ["max_composition_jsd": .number(Composition.mismatchJSD)],
                             have: ["composition_jsd": r4(jsd)],
                             note: .string("Not estimated: the slices differ too much in composition (JSD \(JSNumber.toFixed(jsd, 2)) > \(JSNumber.format(Composition.mismatchJSD)))).")))
    }
    return out(Gates.gated("not_run", needed: ["run": "drift", "anchors": .int(T.anchors)], have: ["run": .null], suggestion: driftRun,
                           note: "Not estimated yet: the evidence gate passes; aligned displacement needs the two slice spaces aligned on ≥ 3,000 anchor words (a drift run)."))
  }

  /// Measure (a) from a clustering run (`senseShareMeasure`).
  static func senseShareMeasure(_ cx: CompareContext, _ groups: ContextGroups, live: JSONObject) -> JSONObject {
    guard let cr = groups.run else { return live }
    let groupsFound = cr.clusters.filter { $0.status != "residual" }.count
    let counts: JSONObject = ["n": live["n"]!, "docs": live["docs"]!, "authors": live["authors"]!]
    let base: JSONObject = ["metric": "sense_share_jsd", "run": .int(cr.run), "representation": .str(cr.representation)]
    func merge(_ parts: JSONObject...) -> JSONObject {
      var o: JSONObject = [:]
      for p in parts { for (k, v) in p { o[k] = v } }
      return o
    }
    if groupsFound < 2 {
      return merge(base, Gates.gated("no_cluster_structure", needed: ["context_groups": 2], have: ["context_groups": .int(groupsFound)],
                                     note: "Not estimated: the clustering run found no separable context groups."), counts)
    }
    let nA = groups.blocksA.reduce(0.0) { $0 + $1.reduce(0, +) }
    let nB = groups.blocksB.reduce(0.0) { $0 + $1.reduce(0, +) }
    let need = Thresholds.SenseShareJSD.occurrences
    if nA < Double(need) || nB < Double(need) {
      return merge(base, Gates.gated("insufficient_occurrences", needed: ["grouped_occurrences_per_slice": .int(need)],
                                     have: ["a": .number(nA), "b": .number(nB)],
                                     note: .string("Not estimated: \(Format.count(nA)) and \(Format.count(nB)) occurrences have a context group (needs \(need) per slice; occurrences with fewer than 3 usable context words are not grouped).")), counts)
    }
    let r = contextShareShift(groups.blocksA, groups.blocksB, cr.clusters.count)
    guard let value = r.value else { return live }
    var m = base
    m["gate"] = "ok"
    m["value"] = r4(value)
    m["ci"] = r.ci.map { [r4($0.0), r4($0.1)] } ?? .null
    m["n"] = [.number(nA), .number(nB)]
    m["docs"] = .ints([groups.blocksA.count, groups.blocksB.count])
    m["authors"] = live["authors"]!
    m["k"] = .int(cr.clusters.count)
    m["method"] = "JSD (base 2) of context-group shares; document-block bootstrap, 1,000 resamples"
    let n = [Int(nA), Int(nB)], docs = [groups.blocksA.count, groups.blocksB.count]
    m["text"] = .string(measureSentence("sense_share_jsd", m, n: n, docs: docs))
    return m
  }

  /// The three drift measures of a comparison and the verdict (`driftBlock`).
  static func driftBlock(_ c: Connection, _ cx: CompareContext, want: Set<String>, allTime: WindowStats, groups: ContextGroups,
                         k: Int) throws -> [JSONObject] {
    let runs = (cluster: cx.exprs.count == 1 ? Optional(clusterRunSuggestion(cx)) : nil,
                drift: JSONValue.object(["stage": "drift", "params": StoredRuns.runParams(cx.req)]))
    var out: [String: JSONObject] = [:]
    var stored: (run: Int, measures: [String: JSONObject])??
    func storedOf() throws -> (run: Int, measures: [String: JSONObject])? {
      if let s = stored { return s }
      let fp = cx.fingerprintScope
      let s = try StoredRuns.storedDrift(c, params: StoredRuns.comparisonParams(cx.req, version: StoredRuns.driftVersion),
                                         scope: fp.scope, upstream: fp.upstream)
      stored = .some(s)
      return s
    }
    for metric in CompareEngine.drift where want.contains(metric) {
      let g = driftGate(metric, cx, allTime: allTime, runs: runs)
      if g["gate"] != "not_run" {
        out[metric] = g
        continue
      }
      if metric == "sense_share_jsd" {
        out[metric] = senseShareMeasure(cx, groups, live: g)
        continue
      }
      guard let s = try storedOf(), let sm = s.measures[metric] else {
        out[metric] = g
        continue
      }
      var m: JSONObject = ["metric": .string(metric)]
      for (k, v) in sm { m[k] = v }
      m["n"] = g["n"]!
      m["docs"] = g["docs"]!
      m["authors"] = g["authors"]!
      m["run"] = .int(s.run)
      out[metric] = m
    }
    func ints(_ v: JSONValue?) -> [Int] { v?.arrayValue?.compactMap { $0.numberValue.map { Int($0) } } ?? [] }
    if var nb = out["neighbor_overlap"], nb["gate"] == "ok" {
      nb["text"] = .string(measureSentence("neighbor_overlap", nb, n: ints(nb["n"]), docs: ints(nb["docs"])))
      out["neighbor_overlap"] = nb
    }
    if var ad = out["aligned_displacement"], ad["gate"] == "ok" {
      let nb = out["neighbor_overlap"]
      let v = verdict(ad, nb, k: k)
      ad["threshold_percentile"] = .number(JSRound.fixed(Multiplicity.notableThreshold(k), 4))
      let finalVerdict = v ?? (nb?["gate"] == "ok" ? "within typical variation" : nil)
      ad["verdict"] = .str(finalVerdict)
      ad["verdict_note"] = v != nil ? .null : "No verdict: neighbour overlap is not estimated for these slices."
      ad["text"] = .string(measureSentence("aligned_displacement", ad, n: ints(ad["n"]), docs: ints(ad["docs"]), overlap: nb,
                                           verdict: finalVerdict))
      out["aligned_displacement"] = ad
    }
    return CompareEngine.drift.compactMap { out[$0] }
  }

  // ── spaces ──

  /// What vector spaces exist or could exist for the strand's language (`spacesInfo`).
  static func spacesInfo(_ c: Connection, _ cx: CompareContext) -> JSONValue {
    guard let lang = cx.lang else { return .null }
    var docs: [(yLo: Int, yHi: Int, tokens: Int, author: String?)] = []
    var allTokens = 0, allDocs = 0
    var authors = JSSet()
    for d in cx.scope.docs {
      if d.tr || d.dup { continue }
      guard let coll = cx.scope.collections[d.coll], coll.modality == "text" || coll.modality == "abstracts" else { continue }
      var tokens = 0
      for t in d.tok where jsEqual(t.plang, lang) && (t.fc == "text" || t.fc == "abstract") { tokens += t.tokens }
      if !(tokens > 0) { continue }
      allTokens += tokens
      allDocs += 1
      if d.hasAuthor { authors.insert(d.author!) }
      if d.chrono == "dated", let lo = d.yLo, let hi = d.yHi { docs.append((lo, hi, tokens, d.author)) }
    }
    let era = Eras.slices(docs)
    let pooled = StoredRuns.pooledSpace(c, lang: lang, collections: cx.collectionsUsed)
    let gate = Eras.gate
    let could = allTokens >= gate.tokens && allDocs >= gate.docs && authors.count >= gate.authors
    var corpora = JSSet()
    for s in cx.collectionsUsed { if let k = cx.scope.collection(slug: s)?.corpusSlug, !k.isEmpty { corpora.insert(k) } }
    let needs: JSONValue = ["tokens": .int(gate.tokens), "docs": .int(gate.docs), "authors": .int(gate.authors)]
    let name = Eras.languageName(lang)
    return [
      "lang": .string(lang), "language": .string(name),
      "pooled": pooled.map { ["space": .int($0.id), "run": .int($0.run), "tokens": .int($0.tokens), "vocab": .int($0.vocab), "dim": .int($0.dim)] } ?? .null,
      "pooled_gate": ["tokens": .int(allTokens), "docs": .int(allDocs), "authors": .int(authors.count), "eligible": .bool(could), "needs": needs],
      "suggestion": pooled == nil && could && !corpora.isEmpty
        ? ["label": .string("Build the \(name) vector spaces: pooled and era slices (a vectors run, minutes)"),
           "run": ["stage": "vectors", "params": ["lang": .string(lang), "corpora": .strings(corpora.sorted)]]]
        : .null,
      "era": [
        "slices": .array(era.slices.map {
          ["years": .ints([$0.years.0, $0.years.1]), "tokens": .int($0.tokens), "docs": .int($0.docs), "authors": .int($0.authors),
           "eligible": .bool($0.eligible)]
        }),
        "eligible": .int(era.eligible), "needs": needs, "note": .str(Eras.note(lang, era)),
      ],
    ]
  }

  // ── tone ──

  static let toneLabel = "Apple NLTagger — modern reader model, fallible, anachronistic for historical text"
  static let toneMethod = "apple-nltagger-sentimentScore"
  static let maxParagraphs = 2000

  /// A tone distribution (`toneDistribution`), unrounded.
  struct ToneDistribution {
    var n: Int
    var docs: Int
    var mean: Double?
    var ci: (Double, Double)?
    var sd: Double?
    var median: Double?
    var histogram: [(lo: Double, hi: Double, n: Int)]
  }

  /// Distribution of tone scores: n, mean with a document-block bootstrap CI, SD, median and a 10-bin histogram.
  static func toneDistribution(_ scores: [Double], docs: [Int]) -> ToneDistribution {
    let n = scores.count
    let bins = 10
    var hist = (0..<bins).map { i in (lo: -1 + Double(2 * i) / Double(bins), hi: -1 + Double(2 * (i + 1)) / Double(bins), n: 0) }
    for s in scores { hist[min(bins - 1, max(0, Int((((s + 1) / 2) * Double(bins)).rounded(.down))))].n += 1 }
    if n == 0 { return ToneDistribution(n: 0, docs: 0, mean: nil, ci: nil, sd: nil, median: nil, histogram: hist) }
    let mean = scores.reduce(0, +) / Double(n)
    let sd = n > 1 ? (scores.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(n - 1)).squareRoot() : 0
    let sorted = scores.sorted()
    var byDoc = JSMap<(s: Double, c: Double)>()
    for (i, s) in scores.enumerated() { byDoc.update(String(docs[i]), default: (0, 0)) { $0.s += s; $0.c += 1 } }
    let ci = Bootstrap.blockBootstrap(byDoc.values) { sample in
      var s = 0.0, c = 0.0
      for b in sample {
        s += b.s
        c += b.c
      }
      return c != 0 ? s / c : nil
    }
    return ToneDistribution(n: n, docs: Set(docs).count, mean: mean, ci: ci, sd: sd, median: Bootstrap.quantile(sorted, 0.5),
                            histogram: hist)
  }

  /// The block of one slice's distribution (compare.mjs `dist`): rounded to 4 decimals.
  static func toneDistributionJSON(_ d: ToneDistribution) -> JSONValue {
    ["n": .int(d.n), "docs": .int(d.docs), "mean": r4(d.mean), "ci": d.ci.map { [r4($0.0), r4($0.1)] } ?? .null, "sd": r4(d.sd),
     "median": r4(d.median), "histogram": .array(d.histogram.map { ["lo": .number($0.lo), "hi": .number($0.hi), "n": .int($0.n)] })]
  }

  /// Machine tone (`toneBlock`): a stored tone run of this comparison, otherwise why it is not estimated.
  static func toneBlock(_ c: Connection, _ cx: CompareContext) throws -> JSONObject {
    let status = cx.env.tone
    let t = Thresholds.Tone.paragraphs
    let fp = cx.fingerprintScope
    let params = StoredRuns.comparisonParams(cx.req, version: StoredRuns.toneVersion, extra: ["max_paragraphs": .int(maxParagraphs)])
    if let stored = try StoredRuns.storedTone(c, params: params, scope: fp.scope, upstream: fp.upstream) {
      let inA = Set(CompareContext.evidenceDocIds(cx.statsA)), inB = Set(CompareContext.evidenceDocIds(cx.statsB))
      let ra = stored.rows.filter { inA.contains($0.doc) }, rb = stored.rows.filter { inB.contains($0.doc) }
      if ra.count < t || rb.count < t {
        var g = Gates.gated("insufficient_occurrences", needed: ["paragraphs_per_slice": .int(t)], have: ["a": .int(ra.count), "b": .int(rb.count)])
        g["reason"] = .string("Machine tone needs ≥ \(t) scored paragraphs per slice (A \(Format.count(Double(ra.count))), B \(Format.count(Double(rb.count)))).")
        g["run"] = .int(stored.run)
        return g
      }
      return ["gate": "ok", "label": .string(toneLabel), "method": .string(toneMethod), "model_version": .str(stored.modelVersion),
              "run": .int(stored.run), "a": toneDistributionJSON(toneDistribution(ra.map(\.score), docs: ra.map(\.doc))),
              "b": toneDistributionJSON(toneDistribution(rb.map(\.score), docs: rb.map(\.doc))),
              "note": "Distribution of machine scores over paragraphs holding the expression (−1 negative … 1 positive); never a label on one passage."]
    }
    let needed: JSONObject = ["adapter": .string(status.adapter), "paragraphs_per_slice": .int(t)]
    if !status.installed {
      var g = Gates.gated("not_run", needed: .object(needed), have: ["adapter": .null])
      g["reason"] = .string(status.missingReason)
      return g
    }
    if let langs = status.sentimentLanguages, let lang = cx.lang, !langs.contains(lang) {
      var n = needed
      n["language"] = .strings(langs)
      var g = Gates.gated("not_run", needed: .object(n), have: ["adapter": .string(status.adapter), "language": .string(lang)])
      g["reason"] = .string("Tone is not available for \(Eras.languageName(lang))")
      return g
    }
    var g = Gates.gated("not_run", needed: .object(needed), have: ["adapter": .string(status.adapter), "run": .null],
                        suggestion: ["label": "Score the paragraphs of both slices with the on-device adapter (a tone run)",
                                     "run": ["stage": "tone", "params": StoredRuns.runParams(cx.req)]])
    g["reason"] = "Machine tone has not been estimated for these slices."
    return g
  }

  // ── OpenAlex within-cell shares ──

  static let openAlexBins: [(Int, Int)] = [(1665, 1799), (1800, 1849), (1850, 1874), (1875, 1899)]
    + (0..<25).map { (1900 + 5 * $0, 1904 + 5 * $0) } + [(2025, 2026)]

  /// Within-cell presence shares (§10.4; `withinCellShares`).
  static func withinCellShares(_ c: Connection, _ scope: Scope, _ specs: [SliceSpec], _ toggles: Toggles) throws -> JSONValue {
    let sampledColls = scope.collectionList.filter { $0.sampling == "top_cited_per_cell" }.map(\.id)
    var cellOf: [Int: String] = [:]
    if !sampledColls.isEmpty {
      let filter = SliceRequests.ScopeFilter(scope.cutoffs)
      let liveArgs: [SQLValue] = switch filter {
      case .live: []
      case .at(let at): [.text(at)]
      case .batch(let b): [.int(Int64(b))]
      case .atBatch(let at, let b): [.text(at), .int(Int64(b))]
      }
      let s = try c.prepared(AnalysisSQL.sampleCells(filter))
      try s.bind([.text(jsonArray(sampledColls))] + liveArgs)
      while let r = try s.step() {
        if case .text(let cell) = r.value(1) { cellOf[r.i(0)] = cell }
      }
    }
    func one(_ spec: SliceSpec) -> JSONValue {
      struct Cell { var cell: String, field: String, years: (Int, Int), n = 0, k = 0, abstracts = 0 }
      var cells = JSMap<Cell>()
      for d in scope.docs {
        if !spec.collSet.contains(d.coll) || !sampledColls.contains(d.coll) || !spec.facetsPass(d) { continue }
        if toggles.dup == 0 && d.dup { continue }
        if toggles.tr == 0 && d.tr { continue }
        if toggles.est == 0 && d.basis == "estimated" { continue }
        if !d.tok.contains(where: { ($0.fc == "title" || $0.fc == "abstract") && spec.langOk($0.plang, $0.fc, d.langText) }) { continue }
        var key = cellOf[d.id]
        var years: (Int, Int)
        if let k = key, let range = cellYears(k) {
          years = range
        } else {
          guard d.chrono == "dated", let yLo = d.yLo, let yHi = d.yHi,
                let bin = openAlexBins.first(where: { yLo >= $0.0 && yLo <= $0.1 }), yHi <= bin.1 else { continue }
          years = bin
          key = "\(d.field ?? "unknown field")|\(bin.0)-\(bin.1)"
        }
        if years.0 < spec.years.0 || years.1 > spec.years.1 { continue }
        let k = key!
        let fieldName = JSString.slice(k, 0, lastIndex(of: "|", in: k))
        cells.update(k, default: Cell(cell: k, field: fieldName, years: years)) { cl in
          cl.n += 1
          if d.tok.contains(where: { $0.fc == "abstract" && $0.tokens > 0 }) { cl.abstracts += 1 }
          let hit = d.hits.contains { h in
            (h.fc == "title" || h.fc == "abstract") && spec.langOk(h.plang, h.fc, d.langText) && (h.n + (toggles.nm == 1 ? h.names : 0)) > 0
          }
          if hit { cl.k += 1 }
        }
      }
      let sorted = cells.values.jsSorted { x, y in
        switch ReferenceCollation.compare(x.field, y.field) {
        case .orderedAscending: return -1
        case .orderedDescending: return 1
        case .orderedSame: return Double(x.years.0 - y.years.0)
        }
      }
      return .array(sorted.map { cl in
        let (lo, hi) = Intervals.wilsonCI(Double(cl.k), Double(cl.n))
        return ["cell": .string(cl.cell), "field": .string(cl.field), "years": .ints([cl.years.0, cl.years.1]), "n": .int(cl.n),
                "k": .int(cl.k), "abstracts": .int(cl.abstracts), "share": r4(Double(cl.k) / Double(cl.n)), "ci": [r4(lo), r4(hi)],
                "text": .string("\(Format.count(Double(cl.k))) of \(Format.count(Double(cl.n))) · abstracts for \(Format.count(Double(cl.abstracts)))")]
      })
    }
    return ["a": one(specs[0]), "b": one(specs[1]), "method": "k of n sampled works (title or abstract) mention the expression; Wilson 95% CI",
            "note": "Each cell is OpenAlex's own sample of the 200 most-cited works for one field and period; shares are shown side by side, never as a rate, ratio or trend across cells."]
  }

  /// `|YYYY-YYYY` at the end of a cell key → its years.
  static func cellYears(_ key: String) -> (Int, Int)? {
    let u = Array(key.utf16)
    guard u.count >= 10 else { return nil }
    let tail = u.suffix(10)
    let t = Array(tail)
    guard t[0] == 0x7C, t[5] == 0x2D else { return nil }
    let digits = t[1..<5] + t[6..<10]
    guard digits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
    let s = String(decoding: t, as: UTF16.self)
    let lo = Int(s.dropFirst().prefix(4))!, hi = Int(s.suffix(4))!
    return (lo, hi)
  }

  static func lastIndex(of sep: String, in s: String) -> Int {
    let u = Array(s.utf16), p = Array(sep.utf16)[0]
    return u.lastIndex(of: p) ?? -1
  }

  // ── human annotation counts ──

  static let humanNote = "Counts of human annotations in each slice; no automatic irony or stance detection."

  /// `humanCounts(db, scope, statsA, statsB, {revCutoff})`.
  static func humanCounts(_ c: Connection, _ scope: Scope, _ a: SliceStats, _ b: SliceStats, revCutoff: Int?) throws -> JSONValue {
    let inA = Set(a.perDoc.map(\.id)), inB = Set(b.perDoc.map(\.id))
    var counts: [String: [String: JSMap<Int>]] = [
      "pragmatic_function": ["a": JSMap(objectOrder: true), "b": JSMap(objectOrder: true)],
      "stance": ["a": JSMap(objectOrder: true), "b": JSMap(objectOrder: true)],
    ]
    func tally(_ doc: Int?, _ dims: JSONValue) {
      for (side, set) in [("a", inA), ("b", inB)] {
        guard let doc, set.contains(doc) else { continue }
        for dim in ["pragmatic_function", "stance"] {
          if case .string(let v)? = dims[dim], !v.isEmpty { counts[dim]![side]!.update(v, default: 0) { $0 += 1 } }
        }
      }
    }
    if let revCutoff {
      let rows = try c.rows(AnalysisSQL.humanAnnotationsAt, [.int(Int64(revCutoff))]) { r in (id: r.i(0), status: r.text(1), doc: r.iOrNil(2)) }
      for a in rows {
        guard let shown = try shownAt(c, id: a.id, status: a.status, revCutoff: revCutoff), shown.status == "active",
              let dims = JSONValue.parseOrNil(shown.dimensions) else { continue }
        tally(a.doc, dims)
      }
    } else {
      let rows = (try? c.rows(AnalysisSQL.humanCounts) { r in (dims: r.text(2), doc: r.iOrNil(3)) }) ?? []
      for r in rows {
        guard let dims = JSONValue.parseOrNil(r.dims) else { continue }
        tally(r.doc, dims)
      }
    }
    func obj(_ m: JSMap<Int>) -> JSONValue { CompareEngine.objectOf(m) }
    return ["pragmatic_function": ["a": obj(counts["pragmatic_function"]!["a"]!), "b": obj(counts["pragmatic_function"]!["b"]!)],
            "stance": ["a": obj(counts["stance"]!["a"]!), "b": obj(counts["stance"]!["b"]!)], "note": .string(humanNote)]
  }

  /// `annotationShownAt(db, a, revCutoff)`: the revision shown at the cutoff and the status then, or nil.
  static func shownAt(_ c: Connection, id: Int, status: String, revCutoff: Int) throws -> (dimensions: String, status: String)? {
    let revs = try c.rows(AnalysisSQL.annotationRevisions, [.int(Int64(id))]) { r in (id: r.i(0), dims: r.text(2)) }
    let shown = revs.filter { $0.id <= revCutoff }
    guard let last = shown.last else { return nil }
    var st = "active"
    if status == "withdrawn", let final = revs.last, final.id <= revCutoff { st = "withdrawn" }
    if let succ = try c.first(AnalysisSQL.supersededBy, [.int(Int64(id))], { $0.i(0) }),
       let first = try c.first(AnalysisSQL.firstRevision, [.int(Int64(succ))], { $0.i(0) }), first <= revCutoff {
      st = "superseded"
    }
    return (last.dims, st)
  }
}
