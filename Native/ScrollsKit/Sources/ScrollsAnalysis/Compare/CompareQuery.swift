// OWNER: N4
// The Compare payload (server/analysis/compare.mjs `compareQuery`, SPEC §2.E): multiplicity, coverage and composition
// first, the modality and prominence checks, frequency with exact CIs, representative passages, neighbouring terms
// (collocates + keyness), context groups, the three drift measures, tone and human stance counts, and OpenAlex
// within-cell shares (§10.4). A gated measure carries no value (§13 rule 7): every gate object is built by
// `Gates.gated`, which writes null where a numeral would be. The payload is built as JSON with the reference's keys, so
// the differential test (G3) compares it byte for byte after canonicalisation; `LiveAtlas.compare` decodes it into the
// contract types.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The Compare engine.
public enum CompareEngine {
  /// Pipeline version printed on Compare payloads.
  public static let version = "compare@1.2.0"
  static let drift = ["sense_share_jsd", "neighbor_overlap", "aligned_displacement"]
  static let medium = ["text": "text", "titles": "titles", "abstracts": "abstracts", "lexical": "entries", "baseline": "baseline"]
  /// The note of an as-saved comparison (RF-2).
  public static let asSavedNote = "As saved: the counting runs pinned at the save and only the imports it counted (documents of a later revert still count); reader annotations as they stood then."

  /// The multiplicity of a comparison (from compare_log): k comparisons so far including this one, notable so far.
  public struct MultiplicityInput: Sendable {
    public var k: Int
    public var notableSoFar: Int
    public init(k: Int, notableSoFar: Int) {
      self.k = k
      self.notableSoFar = notableSoFar
    }
  }

  static func r4(_ x: Double?) -> JSONValue { .num(JSRound.r4(x)) }
  static func r2(_ x: Double?) -> JSONValue { .num(JSRound.r2(x)) }
  static func ci2(_ a: Double?, _ b: Double?) -> JSONValue { [r2(a), r2(b)] }

  static func describeSlice(_ st: SliceStats) -> String {
    let noun = medium[st.modality] ?? st.modality
    guard let top = Composition.topShare(st.mix) else { return "no \(noun)" }
    return top.share >= 0.995 ? "\(top.key) \(noun)" : "\(JSNumber.format(JSNumber.round(top.share * 100)))% \(top.key) \(noun)"
  }

  static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(Format.count(Double(n))) \(n == 1 ? one : many)" }

  static func overlaps(_ a: (Int, Int), _ b: (Int, Int)) -> Bool { a.0 <= b.1 && b.0 <= a.1 }

  static func objectOf(_ m: JSMap<Int>) -> JSONValue { .object(JSONObject(m.entries.map { ($0.key, JSONValue.int($0.value)) })) }
  static func objectOf(_ m: JSMap<Double>) -> JSONValue { .object(JSONObject(m.entries.map { ($0.key, JSONValue.number($0.value)) })) }

  /// The default passage seed: fnv1a32 of the comparison's canonical JSON, mod 1,000,000.
  static func defaultSeed(_ req: NormalizedCompareRequest) -> Int {
    let body: JSONValue = ["expr": .ints(req.expr), "a": req.a.json, "b": req.b.json, "toggles": req.toggles.json]
    return Int(IDs.fnv1a32(CanonicalJSON.string(body)) % 1_000_000)
  }

  /// `coverageOf(st, ev, rateGate)`.
  static func coverage(_ st: SliceStats, _ ev: JSMap<(n: Int, docs: Int, units: Int)>, rateGate: String?, _ req: NormalizedCompareRequest) -> JSONValue {
    let tr = req.toggles.tr == 1
    var o: JSONObject = [
      "years": .ints([st.years.0, st.years.1]), "f": .string(st.f), "modality_compared": .string(st.modality),
      "unit": .string(st.unit), "docs": .int(st.docs), "authors": .int(st.authors.count),
      "translations": .int(tr ? st.translationsIncluded : st.translations.docs), "translations_included": .bool(tr),
      "undated_share": r4(st.undatedShare),
      "undated": ["docs": .int(st.undated.docs), "n": .int(st.undated.n)],
      "scheduled": ["docs": .int(st.scheduled.docs), "n": .int(st.scheduled.n)],
      "mix": objectOf(st.mix), "languages": objectOf(st.languages), "collection_mix": objectOf(st.collectionMix),
      "collections": .strings(st.collections.sorted),
      "modality": CompareContext.sharesJSON(CompareContext.shares(ev, "docs")),
      "evidence_modality": CompareContext.sharesJSON(CompareContext.shares(ev, "n")),
      "basis": objectOf(st.basisMix),
      "washes": ["docs": .int(st.washes.docs), "n": .int(st.washes.n)],
      "excluded": excluded(st), "rate_gate": .str(rateGate), "filter_warnings": .strings(st.filterWarnings),
      "synthetic": .bool(st.synthetic),
    ]
    o[st.unit] = .int(st.units)
    let share: Double = tr ? (st.docs > 0 ? Double(st.translationsIncluded) / Double(st.docs) : 0)
      : (st.docs + st.translations.docs > 0 ? Double(st.translations.docs) / Double(st.docs + st.translations.docs) : 0)
    o["translation_share"] = r4(share)
    let stack = st.strata.entries.map { e -> (kind: String, lang: String, collection: String, share: Double) in
      let parts = e.key.components(separatedBy: "|")
      return (parts[0], parts.count > 1 ? parts[1] : "", parts.count > 2 ? parts[2] : "",
              JSRound.fixed(st.units > 0 ? Double(e.value.units) / Double(st.units) : 0, 4))
    }.jsSorted { $1.share - $0.share }
    o["stack"] = .array(stack.map { ["kind": .string($0.kind), "lang": .string($0.lang), "collection": .string($0.collection), "share": .number($0.share)] })
    var terciles = JSONObject()
    for (t, v) in st.terciles { terciles[t] = r4(st.units > 0 ? Double(v.units) / Double(st.units) : 0) }
    o["prominence_terciles"] = .object(terciles)
    o["selection"] = .array(st.selection.map {
      ["collection": .string($0.collection), "sampling": .string($0.sampling), "label": .string($0.label), "note": .str($0.note)]
    })
    return .object(o)
  }

  static func excluded(_ st: SliceStats) -> JSONValue {
    func b(_ x: SliceStats.Bucket) -> JSONValue { ["docs": .int(x.docs), "n": .int(x.n)] }
    return [
      "translations": b(st.translations), "duplicates": b(st.duplicates), "estimated": b(st.estimated), "washes": b(st.washes),
      "other_modality": ["docs": .int(st.otherModality.docs), "n": .int(st.otherModality.n), "modalities": objectOf(st.otherModalities)],
      "describes": .int(st.describes), "apparatus": .int(st.apparatus), "names": .int(st.names),
      "not_rate_eligible": .strings(st.notRateEligible),
    ]
  }

  /// `asSavedBlock(req)`.
  static func asSaved(_ req: NormalizedCompareRequest) -> JSONValue? {
    guard req.runs != nil || req.cutoffs != nil else { return nil }
    return ["runs": req.runs?.json ?? [:], "cutoffs": req.cutoffs?.json ?? [:], "note": .string(asSavedNote)]
  }

  /// The comparison payload. `c` is one read transaction; `text` reads passage text; `env` is the phone's or the
  /// reference's environment (tone adapter, Ngram store, token streams).
  public static func payload(_ c: Connection, text: any TextStore, request req: NormalizedCompareRequest,
                             multiplicity mult: MultiplicityInput, env: AnalysisEnvironment) throws -> JSONValue {
    EngineAssert.offMain()
    let cx = try CompareContext(c, req: req, env: env)
    let statsA = cx.statsA, statsB = cx.statsB
    let expressions: JSONValue = .array(cx.exprs.map {
      ["id": .int($0.id), "surface": .string($0.surface), "lang": .str($0.lang), "run": .int($0.run), "synthetic": .bool($0.synthetic)]
    })
    let seed = req.seed ?? defaultSeed(req)
    let want = Set(req.measures)
    var reader = PassageTextReader(c, text)
    let synthetic = statsA.synthetic || statsB.synthetic || cx.exprs.contains { $0.synthetic }
    var licenses = JSSet()
    for s in cx.collectionsUsed { if let l = cx.scope.collection(slug: s)?.license, !l.isEmpty { licenses.insert(l) } }
    var materialize = JSONObject()
    for e in cx.exprs { materialize[String(e.id)] = .int(e.run) }
    let provenance: JSONValue = [
      "data_version": .int(try Meta.dataVersion(c)), "run_ids": ["materialize": .object(materialize)],
      "tokenizer": .string(Tokenizer.version), "segmenter": "seg-1", "synthetic": .bool(synthetic),
      "collections": .strings(cx.collectionsUsed), "licenses": .strings(licenses.sorted),
    ]
    var caveats: [String] = []
    var notes: [String] = []
    let multiplicity = Multiplicity.block(k: mult.k, notableSoFar: mult.notableSoFar, label: cx.label)
    var out: JSONObject = ["version": .string(version), "expressions": expressions, "toggles": req.toggles.json,
                           "multiplicity": multiplicity]
    if let s = asSaved(req) { out["as_saved"] = s }

    // ── modality refusal (default for cross-modality slices, D15) ──
    if cx.mismatch && !cx.descriptive {
      let common = cx.evA.keys.filter { cx.evB.has($0) }
      var suggestion: JSONValue = .null
      if !common.isEmpty {
        let m = common.jsSorted { x, y in
          let ex = cx.evA[x]!, ey = cx.evA[y]!, fx = cx.evB[x]!, fy = cx.evB[y]!
          let dn = Double((fy.n + ey.n) - (fx.n + ex.n))
          return dn != 0 ? dn : Double((fy.docs + ey.docs) - (fx.docs + ex.docs))
        }[0]
        func colls(_ spec: SliceSpec) -> [String] {
          spec.collIds.compactMap { cx.scope.collections[$0] }.filter { $0.modality == m }.map(\.slug).sorted(by: jsLess)
        }
        func withColl(_ spec: SliceSpec) -> String {
          let keep = JSString.split(spec.fStr, ";").filter { !JSString.trim($0).isEmpty && !JSString.hasPrefix(JSString.trim($0), "coll:") }
          return (keep + ["coll:\(colls(spec).joined(separator: ","))"]).joined(separator: ";")
        }
        suggestion = ["label": .string("Compare \(medium[m]!) with \(medium[m]!)"),
                      "a": ["years": .ints([req.a.lo, req.a.hi]), "f": .string(withColl(cx.specA))],
                      "b": ["years": .ints([req.b.lo, req.b.hi]), "f": .string(withColl(cx.specB))]]
      }
      let sentence = "A is \(describeSlice(statsA)), B is \(describeSlice(statsB)): different media."
      let have: JSONValue = ["a": .string(statsA.modality), "b": .string(statsB.modality)]
      func card() -> JSONObject { Gates.gated("modality_mismatch", needed: ["modality": "same"], have: have) }
      caveats.append("modality")
      out["coverage"] = ["a": coverage(statsA, cx.evA, rateGate: nil, req), "b": coverage(statsB, cx.evB, rateGate: nil, req),
                         "composition_jsd": .null, "caveats": .strings(caveats), "modality_gate": "modality_mismatch"]
      out["freq"] = .object(Gates.gated(
        "modality_mismatch", needed: ["modality": "the same dominant modality in both slices"],
        have: ["a": CompareContext.sharesJSON(CompareContext.shares(cx.evA, "n")), "b": CompareContext.sharesJSON(CompareContext.shares(cx.evB, "n"))],
        suggestion: suggestion,
        note: .string("\(sentence) Compare anyway shows each rate in its own unit, with no ratio, test or verdict.")))
      out["passages"] = ["a": [], "b": [], "seed": .int(seed)]
      out["collocates"] = .object(card())
      out["clusters"] = .null
      out["measures"] = .array(drift.filter { want.contains($0) }.map { metric in
        var m = card()
        m["metric"] = .string(metric)
        return .object(m)
      })
      var tone = card()
      tone["reason"] = "Tone is not compared across media."
      out["tone"] = .object(tone)
      out["human"] = try CompareBlocks.humanCounts(c, cx.scope, statsA, statsB, revCutoff: req.cutoffs?.annotationRev)
      out["coverage_note"] = .string("A is \(describeSlice(statsA)) and B is \(describeSlice(statsB)): a change of medium, not of meaning. Nothing is compared across media by default.")
      out["provenance"] = provenance
      return .object(out)
    }

    // ── frequency ──
    func rateGateOf(_ st: SliceStats) -> String { st.units >= st.gateUnits ? "ok" : "insufficient_coverage" }
    func freqSlice(_ st: SliceStats, _ which: String) -> JSONObject {
      let gate = rateGateOf(st)
      var base: JSONObject = [
        "n": .int(st.rateN), "occurrences": .int(st.n), "unit": .string(st.rateUnit), "units": .int(st.units),
        "docs": .int(st.evidenceDocs), "covered_docs": .int(st.docs), "authors": .int(st.evidenceAuthors.count),
        "dp": r4(st.dp), "single_source": .bool(st.topDocShare != nil && st.topDocShare! >= 0.6), "top_doc_share": r4(st.topDocShare),
        "synthetic": .bool(st.synthetic),
      ]
      if gate != "ok" {
        let unit = st.unit
        let w = cx.suggest(a: which == "a", b: which == "b", WidenCriteria(units: st.gateUnits), Describe(
          text: { Gates.unitsLabel(Double($0.units), unit) },
          data: { [unit: .int($0.units), "occurrences": .int($0.n)] }))
        let note = Gates.lowCoverageNote(Double(st.rateN), Double(st.units), st.unit) + (w != nil ? "" : "; \(Gates.noWideningNote)")
        return Gates.gated("insufficient_coverage", needed: [st.unit: .int(st.gateUnits)], have: [st.unit: .int(st.units)],
                           suggestion: w.map(JSONValue.object) ?? .null, note: .string(note), extra: base)
      }
      let r = st.unit == "tokens" ? Intervals.poissonRate(Double(st.n), Double(st.units), scale: st.scale)
        : Intervals.proportionRate(Double(st.k), Double(st.units), scale: st.scale)
      base["gate"] = "ok"
      base["rate"] = r2(r.rate)
      base["ci"] = ci2(r.ci.0, r.ci.1)
      return base
    }
    var freq: JSONObject
    var withinCell: JSONValue?
    if cx.sampled && !cx.descriptive {
      freq = Gates.gated("sampling_design", needed: ["comparison": "within one OpenAlex cell"],
                         have: ["a": ["works_matching": .int(statsA.k), "works_sampled": .int(statsA.units)],
                                "b": ["works_matching": .int(statsB.k), "works_sampled": .int(statsB.units)]],
                         note: .string(Gates.samplingDesignNote))
      caveats.append("sampling_design")
      withinCell = try CompareBlocks.withinCellShares(c, cx.scope, [cx.specA, cx.specB], req.toggles)
    } else {
      let fa = freqSlice(statsA, "a"), fb = freqSlice(statsB, "b")
      freq = ["a": .object(fa), "b": .object(fb), "ci_method": .string(statsA.unit == "tokens" ? "Garwood exact Poisson 95%" : "Wilson score 95%")]
      if cx.descriptive {
        freq["rate_ratio"] = .object(Gates.gated("modality_mismatch", needed: ["modality": "same"],
                                                 have: ["a": .string(statsA.modality), "b": .string(statsB.modality)],
                                                 note: "Descriptive only: each rate is in its own unit; no ratio, test or verdict across media."))
      } else if fa["gate"] != "ok" || fb["gate"] != "ok" {
        let failA = fa["gate"] != "ok", failB = fb["gate"] != "ok"
        let need = max(statsA.gateUnits, statsB.gateUnits)
        var parts: [String] = []
        if failA { parts.append("slice A has \(Gates.unitsLabel(Double(statsA.units), statsA.unit))") }
        if failB { parts.append("slice B has \(Gates.unitsLabel(Double(statsB.units), statsA.unit))") }
        freq["rate_ratio"] = .object(Gates.gated(
          "insufficient_coverage", needed: [statsA.unit: .int(need)], have: ["a": .int(statsA.units), "b": .int(statsB.units)],
          suggestion: combineSuggestions([fa, fb], failA: failA, failB: failB),
          note: .string("Not estimated: \(parts.joined(separator: " and ")) (needs \(Gates.unitsLabel(Double(need), statsA.unit))).")))
      } else {
        let rr = Intervals.poissonRateRatio(Double(statsA.rateN), Double(statsA.units), Double(statsB.rateN), Double(statsB.units))
        let note: JSONValue = rr.value == nil
          ? .string(rr.ci != nil ? "A has no occurrences: the ratio has no upper bound." : "Neither slice has an occurrence: no ratio.")
          : .null
        freq["rate_ratio"] = [
          "value": r2(rr.value), "ci": rr.ci.map { ci2($0.0, $0.1) } ?? .null, "unbounded": .bool(rr.unbounded),
          "direction": "B relative to A",
          "method": .string(statsA.unit == "tokens" ? "exact conditional (Clopper–Pearson on n_B of n_A + n_B)"
            : "exact conditional, Poisson approximation for works (Clopper–Pearson on k_B of k_A + k_B)"),
          "note": note,
        ]
        if let jsd = cx.jsd, jsd > Composition.caveatJSD {
          freq["standardized"] = standardized(statsA, statsB)
        }
      }
    }
    if cx.descriptive { caveats.append("modality") }

    // ── prominence ──
    let prominence = CompareBlocks.prominenceCheck(statsA, statsB)
    if prominence["consistent"] == .bool(false) { caveats.append("prominence") }

    // ── context groups (needed by measure (a)) ──
    let allTime = cx.index("a").windowStats(nil, nil)
    let groups = try CompareBlocks.contextGroups(c, cx, allTime: allTime)

    // ── passages ──
    var rng = Mulberry32(seed: JSNumber.toUint32(Double(seed)))
    let pa = try Passages.sample(c, cx.scope, cx.specA, statsA, rng: &rng, laneFacet: req.laneFacet, reader: &reader)
    let pb = try Passages.sample(c, cx.scope, cx.specB, statsB, rng: &rng, laneFacet: req.laneFacet, reader: &reader)
    let passages: JSONValue = [
      "a": .array(pa), "b": .array(pb), "seed": .int(seed), "stratified_by": .null,
      "note": "One passage per document at most, drawn with the printed seed; a new seed reshuffles. Not stratified by context group.",
    ]

    // ── neighbouring terms ──
    let colloc: JSONValue
    if !want.contains("collocates") {
      colloc = ["requested": false, "label": .string(Collocations.contextLabel)]
    } else if cx.descriptive {
      colloc = .object(Gates.gated("modality_mismatch", needed: ["modality": "same"],
                                   have: ["a": .string(statsA.modality), "b": .string(statsB.modality)]))
    } else {
      colloc = .object(try CompareBlocks.neighbourTerms(c, cx, reader: &reader))
    }

    // ── context groups, drift measures, tone ──
    let clusters: JSONValue = want.contains("clusters") ? .object(groups.block) : .null
    let measures = try CompareBlocks.driftBlock(c, cx, want: want, allTime: allTime, groups: groups, k: mult.k)

    // ── caveats and the coverage paragraph ──
    if let jsd = cx.jsd, jsd > Composition.caveatJSD {
      caveats.append("composition")
      notes.append("The slices differ in composition (JSD \(JSNumber.toFixed(jsd, 2))): A is \(describeSlice(statsA)), B is \(describeSlice(statsB)). "
        + "Differences below may reflect source mix\(freq["standardized"] != nil ? "; directly standardized rates are shown beside the raw rates" : "").")
    }
    if cx.descriptive {
      notes.append("A is \(describeSlice(statsA)) and B is \(describeSlice(statsB)): shown descriptively, each in its own unit, with no ratio, test or verdict.")
    }
    for st in [statsA, statsB] {
      let S = st.which.uppercased()
      if st.otherModality.docs > 0 {
        caveats.append("mixed_modality")
        let names = st.otherModalities.keys.map { medium[$0] ?? $0 }.joined(separator: " and ")
        notes.append("Slice \(S) also holds \(names) (\(plural(st.otherModality.docs, "document", "documents")), \(plural(st.otherModality.n, "match", "matches"))); only \(medium[st.modality] ?? "undefined") is compared.")
      }
      if rateGateOf(st) != "ok" {
        caveats.append("low_coverage")
        notes.append("Slice \(S) has \(Gates.unitsLabel(Double(st.units), st.unit)) (needs \(Gates.unitsLabel(Double(st.gateUnits), st.unit))): its rate is not estimated.")
      }
      if st.undatedShare >= 0.2 {
        caveats.append("undated")
        notes.append("\(JSNumber.format(JSNumber.round(st.undatedShare * 100)))% of the documents matching slice \(S)'s filters are undated and cannot be placed in it.")
      }
      if st.washes.docs > 0 {
        caveats.append("washes")
        let one = st.washes.docs == 1
        notes.append("\(plural(st.washes.docs, "document", "documents")) (\(plural(st.washes.n, "match", "matches"))) \(one ? "has a date" : "have dates") too coarse to fit slice \(S) and \(one ? "is" : "are") left out.")
      }
      if st.translations.docs > 0 {
        caveats.append("translations_excluded")
        notes.append("\(plural(st.translations.docs, "translated document is", "translated documents are")) excluded from slice \(S) (text-language chronology).")
      }
      if st.names > 0 {
        caveats.append("names_excluded")
        notes.append("\(plural(st.names, "match", "matches")) in slice \(S) \(st.names == 1 ? "is" : "are") excluded as names.")
      }
      if (st.basisMix["estimated"] ?? 0) >= 0.5 {
        caveats.append("estimated_dates")
        notes.append("Most of slice \(S)'s documents are dated by estimate.")
      }
      for s in st.selection {
        caveats.append("selection")
        let note = (s.note ?? "").isEmpty ? "" : " (\(s.note!))"
        notes.append("\(s.collection) in slice \(S): \(s.label)\(note).")
      }
    }
    if prominence["consistent"] == .bool(false) {
      notes.append("The result depends on prominence stratum: rates move in different directions across prominence terciles.")
    }
    if cx.sampled { notes.append("\(Gates.samplingDesignNote) Within-cell presence shares are shown side by side, descriptively.") }
    if overlaps(req.a.years, req.b.years) {
      caveats.append("overlapping_slices")
      notes.append("The slices overlap (\(Gates.rangeLabel(req.a.years)) and \(Gates.rangeLabel(req.b.years))): documents in both are counted twice and the interval of the ratio is too narrow.")
    }
    if cx.exprs.count > 1 { notes.append("Counts pool \(cx.exprs.count) expressions (\(cx.label)).") }
    if req.toggles.bp == 1 {
      notes.append("Boilerplate passages are not counted even with the boilerplate toggle on: counts and denominators come from passages of ok quality only.")
    }
    if statsA.synthetic && statsB.synthetic {
      notes.append("Both slices are synthetic.")
    } else if statsA.synthetic || statsB.synthetic {
      notes.append("Slice \(statsA.synthetic ? "A" : "B") contains synthetic documents.")
    }

    var unique: [String] = []
    for cv in caveats where !unique.contains(cv) { unique.append(cv) }
    out["coverage"] = [
      "a": coverage(statsA, cx.evA, rateGate: rateGateOf(statsA), req), "b": coverage(statsB, cx.evB, rateGate: rateGateOf(statsB), req),
      "composition_jsd": r4(cx.jsd), "caveats": .strings(unique), "modality_gate": .string(cx.descriptive ? "modality_mismatch" : "ok"),
      "modality_compared": .string(statsA.modality), "descriptive_override": .bool(cx.descriptive), "prominence": .object(prominence),
      "spaces": CompareBlocks.spacesInfo(c, cx),
    ]
    out["freq"] = .object(freq)
    if let withinCell { out["within_cell"] = withinCell }
    out["baseline_rho"] = .object(BaselineRho.block(cx, lookup: env.ngram))
    out["passages"] = passages
    out["collocates"] = colloc
    out["clusters"] = clusters
    out["measures"] = .array(measures.map(JSONValue.object))
    out["tone"] = want.contains("tone") ? .object(try CompareBlocks.toneBlock(c, cx)) : ["requested": false]
    out["human"] = try CompareBlocks.humanCounts(c, cx.scope, statsA, statsB, revCutoff: req.cutoffs?.annotationRev)
    out["coverage_note"] = .string(notes.isEmpty ? "No coverage caveat fired for these slices." : notes.joined(separator: " "))
    out["provenance"] = provenance
    return .object(out)
  }

  /// `combineSuggestions(blocks, failing)`.
  static func combineSuggestions(_ blocks: [JSONObject], failA: Bool, failB: Bool) -> JSONValue {
    var parts: [String] = []
    var out: JSONObject = [:]
    var would: JSONObject = [:]
    for (i, which) in ["a", "b"].enumerated() {
      if !(which == "a" ? failA : failB) { continue }
      guard let s = blocks[i]["suggestion"]?.objectValue else { return .null }
      parts.append(s["label"]?.stringValue ?? "")
      out[which] = s[which] ?? .null
      would[which] = s["would_have"]?[which] ?? .null
    }
    out["would_have"] = .object(would)
    out["label"] = .string(parts.joined(separator: " and "))
    return .object(out)
  }

  /// Directly standardized rates beside the raw ones (composition JSD > 0.15).
  static func standardized(_ a: SliceStats, _ b: SliceStats) -> JSONValue {
    var strata = JSMap<Composition.Stratum>()
    for (st, side) in [(a, "a"), (b, "b")] {
      for (k, v) in st.strata {
        strata.update(k, default: Composition.Stratum()) { e in
          let entry = (n: Double(st.unit == "tokens" ? v.n : v.k), denom: Double(v.units))
          if side == "a" { e.a = entry } else { e.b = entry }
        }
      }
    }
    guard let std = Composition.standardizedRates(strata, scale: a.scale) else {
      return ["a": .null, "b": .null, "note": "no kind × language × collection stratum occurs in both slices"]
    }
    let cover = Composition.standardizeMinCover
    let coveredA = std.matchesCoveredA.map { $0 < cover } ?? false
    let coveredB = std.matchesCoveredB.map { $0 < cover } ?? false
    let thin = std.weightCovered < cover || coveredA || coveredB
    func rawRate(_ st: SliceStats) -> Double? {
      guard st.units > 0 else { return nil }
      let n = st.unit == "tokens" ? st.n : st.k
      return Double(n) / Double(st.units)
    }
    let raw: [Double?] = [rawRate(a), rawRate(b)]
    if thin {
      var tail = ""
      if let m = std.matchesCoveredA { tail += ", \(JSNumber.format(JSNumber.round(m * 100)))% of A's matches" }
      if let m = std.matchesCoveredB { tail += ", \(JSNumber.format(JSNumber.round(m * 100)))% of B's matches" }
      let held = JSNumber.format(JSNumber.round(std.weightCovered * 100))
      let pooled = a.unit == "tokens" ? "tokens" : "works"
      let needs = JSNumber.format(JSNumber.round(cover * 100))
      let note = "The slices share too little of their mix for standardized rates: the strata found in both hold \(held)% of the pooled \(pooled)\(tail) (needs \(needs)%)."
      var o: JSONObject = ["a": .null, "b": .null, "strata": .int(std.strata), "weight_covered": r4(std.weightCovered)]
      o["note"] = .string(note)
      return .object(o)
    }
    let reversed = raw.allSatisfy { $0 != nil } && jsSign(raw[1]! - raw[0]!) * jsSign(std.b - std.a) < 0
    var o: JSONObject = ["a": r2(std.a), "b": r2(std.b), "strata": .int(std.strata), "weight_covered": r4(std.weightCovered),
                         "method": "direct standardization to the pooled kind × language × collection mix"]
    if reversed { o["note"] = "Standardized and raw rates point in opposite directions: the difference lies in the mix of sources, not within them." }
    return .object(o)
  }
}
