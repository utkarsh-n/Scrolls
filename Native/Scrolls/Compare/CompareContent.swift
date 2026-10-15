// OWNER: N4
// Everything the Compare screen shows, computed from one payload (src/ui/panels/compare.mjs, rendering helpers ported):
// the multiplicity line, coverage and composition first, frequency with its intervals, passages, neighbouring terms,
// context groups, the drift measures, tone and stance, and "How coverage could affect this". The view draws only what
// this value holds.
//
// SPEC §13 rule 7 by type: a gated part is a `CompareGate`, built from the gate object's `gate`, `needed`, `have`,
// `suggestion` and its sentence — never from its `value`, `ci`, `rate` or any other estimate key — so a numeral the
// payload might carry inside a gated object has no path to the screen. A gated frequency side keeps only its counts
// (matches, documents), never a rate, interval or dispersion.

import Foundation
import ScrollsContracts
import ScrollsCore

/// A gated part of the payload: what failed, what it needs, what the slice has, the widening that would pass it.
nonisolated struct CompareGate: Sendable, Equatable, Identifiable {
  let id: String
  let gate: Gate
  let title: String
  let note: String?

  /// True for `{gate: <code ≠ 'ok'>, …}` (`isGated` of gate-card.mjs).
  static func isGated(_ v: JSONValue?) -> Bool {
    guard let g = v?.objectValue?["gate"]?.stringValue else { return false }
    return g != "ok"
  }

  /// The gate of a gated object, or nil when the object passed (or is not a gate object). Reads no estimate key.
  init?(_ v: JSONValue?, title: String, id: String) {
    guard Self.isGated(v), let o = v?.objectValue, let code = o["gate"]?.stringValue else { return nil }
    gate = Gate(code: GateCode(rawValue: code), needed: o["needed"] ?? .null, have: o["have"] ?? .null,
                suggestion: o["suggestion"] ?? .null, nullKeys: ["value", "ci"])
    self.title = title
    self.id = id
    note = o["note"]?.stringValue ?? o["reason"]?.stringValue
  }

  /// A gate from a typed measure.
  init(_ gate: Gate, title: String, note: String?, id: String) {
    self.gate = gate
    self.title = title
    self.note = note
    self.id = id
  }

  /// Every string the card shows (the text scan of the tests reads these).
  var strings: [String] {
    let m = GateCardModel(gate: gate.code.rawValue, needed: gate.needed, have: gate.have, suggestion: gate.suggestion, note: note,
                          title: title)
    return [m.title, m.gateWords, m.needed, m.have, m.suggestion, m.gate, m.note ?? ""].filter { !$0.isEmpty }
  }
}

/// New slices a gate's suggestion (or the strip) asks for: years and the filter, per side.
nonisolated struct SliceEdit: Sendable, Equatable {
  var a: SliceSeed?
  var b: SliceSeed?

  init(a: SliceSeed?, b: SliceSeed?) {
    self.a = a
    self.b = b
  }

  /// The slices of a suggestion `{a?: {years, f}, b?: {years, f}}`, or nil when it names none.
  init?(suggestion: JSONValue) {
    func side(_ k: String) -> SliceSeed? {
      guard let s = suggestion[k]?.objectValue, let y = s["years"]?.arrayValue, y.count == 2,
            let lo = y[0].safeInteger, let hi = y[1].safeInteger else { return nil }
      return SliceSeed(fromYear: lo, toYear: hi, filter: s["f"]?.stringValue ?? "")
    }
    a = side("a")
    b = side("b")
    if a == nil && b == nil { return nil }
  }
}

nonisolated struct CompareContent: Sendable, Equatable {
  // MARK: types

  struct Fact: Sendable, Equatable, Identifiable {
    var id: String { label }
    let label: String
    let a: String
    let b: String
  }

  /// One segment of the stacked kind × language × collection bar.
  struct Segment: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let share: Double
  }

  struct Coverage: Sendable, Equatable {
    var facts: [Fact]
    var stackA: [Segment]
    var stackB: [Segment]
    var jsdLine: String?
    /// The amber composition card (JSD > 0.15).
    var compositionCaveat: String?
    var prominenceCaveat: String?
    /// The modality refusal (D15) with the engine's suggestion ("Compare titles with titles") and Compare anyway.
    var modalityGate: CompareGate?
  }

  /// One side of the frequency section. A gated side holds no rate, interval or dispersion (no field can).
  enum FreqSide: Sendable, Equatable, Identifiable {
    case rate(slice: String, line: String, docs: String?, dp: String?, point: RatePoint)
    case gated(slice: String, counts: String, gate: CompareGate)
    case missing(slice: String, line: String)

    var id: String {
      switch self {
      case .rate(let s, _, _, _, _), .gated(let s, _, _), .missing(let s, _): s
      }
    }
  }

  /// A rate and its 95% interval for the chart (passing sides only).
  struct RatePoint: Sendable, Equatable {
    let slice: String
    let rate: Double
    let lo: Double?
    let hi: Double?
    let unit: String
  }

  enum Ratio: Sendable, Equatable {
    case value(String)
    case gated(CompareGate)
    case differentUnits
  }

  enum Frequency: Sendable, Equatable {
    case gated(CompareGate)
    case empty(String)
    case shown(sides: [FreqSide], ratio: Ratio?, standardized: [String], method: String, unitLabel: String?)
  }

  struct Cell: Sendable, Equatable, Identifiable {
    var id: String { label + text }
    let label: String
    let text: String
    let low: Bool
  }

  struct WithinCell: Sendable, Equatable {
    var label: String
    var method: String?
    var a: [Cell]
    var b: [Cell]
  }

  enum Baseline: Sendable, Equatable {
    case gated(CompareGate)
    case text(String, label: String)
    case empty(String, label: String)
  }

  struct Passages: Sendable, Equatable {
    var a: [KwicRow]
    var b: [KwicRow]
    var seedLine: String
    var seed: Int
  }

  struct Term: Sendable, Equatable, Identifiable {
    var id: String { term }
    let term: String
    let detail: String
  }

  enum Terms: Sendable, Equatable {
    case gated(CompareGate)
    case empty(String)
    case notRequested(String)
    case shown(label: String, shared: [Term], onlyA: [Term], onlyB: [Term], keyness: [Term])
  }

  struct GroupRow: Sendable, Equatable, Identifiable {
    var id: Int { cluster }
    let cluster: Int
    let label: String
    let humanLabel: String?
    let a: String
    let b: String
    let flag: String?
  }

  enum Groups: Sendable, Equatable {
    case gated(CompareGate)
    case empty(String)
    case shown(meta: String, rows: [GroupRow])
  }

  enum MeasureRow: Sendable, Equatable, Identifiable {
    case value(metric: String, text: String)
    case gated(CompareGate)
    var id: String {
      switch self {
      case .value(let m, _): m
      case .gated(let g): g.id
      }
    }
  }

  enum Tone: Sendable, Equatable {
    case gated(CompareGate, modelMissing: Bool)
    case shown(label: String, lines: [String])
    case notRequested
  }

  // MARK: content

  var subtitle: String
  var sliceA: String
  var sliceB: String
  var multiplicity: String
  var asSavedNote: String?
  var synthetic: Bool
  var coverage: Coverage
  var frequency: Frequency
  var withinCell: WithinCell?
  var baseline: Baseline?
  var passages: Passages
  var terms: Terms
  var groups: Groups
  var measures: [MeasureRow]
  var tone: Tone
  var human: String
  var humanNote: String?
  var coverageNote: String?
  var caveats: [String]

  // MARK: helpers (compare.mjs)

  /// "A 1955–1985", "A 500 BCE–2 BCE" (astronomical years labelled historically, §13 rule 18).
  static func sliceName(_ k: String, _ years: [Int]?) -> String {
    guard let years, years.count == 2 else { return "\(k.uppercased()) \(DateLabels.yearRangeLabel(nil, nil))" }
    return "\(k.uppercased()) \(DateLabels.yearRangeLabel(years[0], years[1]))"
  }

  /// 'memo 60%, bulletin 40%' from a share map (largest first).
  static func shareList(_ mix: JSONValue?) -> String {
    guard let o = mix?.objectValue else { return "—" }
    let entries = o.keys.compactMap { k -> (String, Double)? in o[k]?.numberValue.flatMap { $0.isFinite ? (k, $0) : nil } }
      .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.utf16.lexicographicallyPrecedes($1.0.utf16) }
    return entries.isEmpty ? "—" : entries.map { "\($0.0.replacing("_", with: " ")) \(Format.share($0.1))" }.joined(separator: ", ")
  }

  /// The multiplicity line (§2.E item 0): the engine's text when it sends one, else computed from k.
  static func multiplicityLine(_ m: CompareMultiplicity, label: String?) -> String {
    if let t = m.text, !t.isEmpty { return t }
    let k = m.k
    let what = label.map { " for '\($0)'" } ?? ""
    let expected = Format.number(0.05 * Double(k))
    let pct = Format.number(m.thresholdPercentile)
    return "Comparison #\(k)\(what) in this session; \(m.notableSoFar) of \(k) crossed the notable threshold; with \(k) "
      + "\(k == 1 ? "comparison" : "comparisons"), ~\(expected) \(k == 1 ? "is" : "are") expected by chance at the 95th percentile. "
      + "Notable threshold is the \(pct)th percentile."
  }

  /// Words for a measure that passed its gate: the engine's text wins.
  static func measureText(_ metric: String, _ e: MeasureEstimate, n: [Int]?, docs: [Int]?) -> String {
    if let t = e.text, !t.isEmpty { return t }
    let name = CompareCopy.measureLabels[metric] ?? metric
    var first = "\(name) \(Format.number(e.value, sig: 2))"
    if let ci = e.ci, ci.count == 2 { first += " [\(Format.number(ci[0], sig: 2)), \(Format.number(ci[1], sig: 2))]" }
    var parts = [first]
    if let n { parts.append("n = \(n.map { Format.count(Double($0)) }.joined(separator: " / "))") }
    if let docs { parts.append("\(docs.map { Format.count(Double($0)) }.joined(separator: " / ")) documents") }
    if let p = e.percentile { parts.append("\(Format.number(p))th percentile of frequency-matched controls") }
    if let v = e.verdict { parts.append(v) }
    return parts.joined(separator: " · ")
  }

  /// One OpenAlex cell of a slice, descriptively (§10.4): k of n, and the share with its Wilson CI only when n ≥ 20.
  static let cellMinN = 20
  static func cellWords(_ c: JSONValue) -> Cell {
    let years = c["years"]?.arrayValue?.compactMap(\.safeInteger)
    let field = c["field"]?.stringValue ?? "field"
    let label = "\(field) \(years.map { $0.count == 2 ? DateLabels.yearRangeLabel($0[0], $0[1]) : "" } ?? "")"
      .trimmingCharacters(in: .whitespaces)
    let n = c["n"]?.safeInteger
    let low = !(n.map { $0 >= cellMinN } ?? false)
    let base = "\(Format.count(c["k"]?.numberValue)) of \(Format.count(c["n"]?.numberValue)) sampled works"
    let abstracts = c["abstracts"]?.safeInteger.map { " · abstracts for \(Format.count(Double($0)))" } ?? ""
    if low { return Cell(label: label, text: "\(base)\(abstracts) · too few sampled works for a share (needs \(cellMinN))", low: true) }
    let ci = c["ci"]?.arrayValue.flatMap { a -> String? in
      guard a.count == 2, let lo = a[0].numberValue, let hi = a[1].numberValue else { return nil }
      return " [\(Format.share(lo)), \(Format.share(hi))]"
    } ?? ""
    return Cell(label: label, text: "\(base) · \(Format.share(c["share"]?.numberValue))\(ci)\(abstracts)", low: false)
  }

  /// "Does our sample track a larger corpus? Spearman ρ = 0.9 [0.29, 0.92] (12 decades)", or nil when gated or absent.
  static func baselineRhoText(_ rho: JSONValue?) -> String? {
    guard let o = rho?.objectValue, !CompareGate.isGated(rho), let v = o["value"]?.numberValue, v.isFinite else { return nil }
    var ci = ""
    if let a = o["ci"]?.arrayValue, a.count == 2, let lo = a[0].numberValue, let hi = a[1].numberValue {
      ci = " [\(Format.number(lo, sig: 2)), \(Format.number(hi, sig: 2))]"
    }
    let bins = o["n_bins"]?.safeInteger.map { " (\(Format.count(Double($0))) decades)" } ?? ""
    return "Does our sample track a larger corpus? Spearman ρ = \(Format.number(v, sig: 2))\(ci)\(bins)"
  }

  /// Names of the gated parts (`gatedParts`).
  static func gatedParts(_ p: CompareResponse) -> [String] {
    var out: [String] = []
    if CompareGate.isGated(p.freq) { out.append("frequency") }
    for k in ["a", "b"] where CompareGate.isGated(p.freq[k]) { out.append("rate of \(k.uppercased())") }
    if CompareGate.isGated(p.freq["rate_ratio"]) { out.append("rate ratio") }
    if CompareGate.isGated(p.collocates) { out.append("neighbouring terms") }
    if CompareGate.isGated(p.clusters) { out.append("context groups") }
    for m in p.measures where !m.result.isOK { out.append((CompareCopy.measureLabels[m.metric] ?? m.metric).lowercased()) }
    if CompareGate.isGated(p.tone) { out.append("machine tone") }
    if case .gated? = p.baselineRho?.result { out.append("correlation with the external baseline") }
    return out
  }

  /// Every caveat that fired, in words (`firedCaveats`, §2.E item 8).
  static func firedCaveats(_ p: CompareResponse) -> [String] {
    var out: [String] = []
    let cov = p.coverage
    if cov.caveats.contains("composition") || (cov.compositionJsd.map { $0 > 0.15 } ?? false) {
      out.append("The slices differ in composition (JSD \(Format.number(cov.compositionJsd, sig: 2))): differences may reflect source mix.")
    }
    if cov.modalityGate != "ok" { out.append("The slices are different media; nothing is compared across media by default.") }
    if cov.prominence?["consistent"] == .bool(false) { out.append("The result depends on the prominence stratum.") }
    let m = p.multiplicity
    if m.k > 1 {
      out.append("\(m.k) comparisons in this session: the notable threshold is adjusted to the \(Format.number(m.thresholdPercentile))th percentile.")
    }
    let gated = gatedParts(p)
    if !gated.isEmpty { out.append("Not estimated (a gate failed): \(gated.joined(separator: ", ")).") }
    for s in ["a", "b"] {
      if let u = cov.value(s)["undated_share"]?.numberValue, u >= 0.2 {
        out.append("\(s.uppercased()): \(Format.share(u)) of matches are undated and outside every rate.")
      }
    }
    if p.provenance.synthetic { out.append(CompareCopy.syntheticNote) }
    return out
  }

  // MARK: building

  /// The content of one payload. `years` are the request's slices (for the names); `label` names the expressions.
  init(_ p: CompareResponse, aYears: [Int], bYears: [Int], label: String?) {
    let nameA = Self.sliceName("a", aYears), nameB = Self.sliceName("b", bYears)
    sliceA = nameA
    sliceB = nameB
    subtitle = [label.map { "'\($0)'" }, "\(nameA) · \(nameB)"].compactMap { $0 }.joined(separator: " · ")
    multiplicity = Self.multiplicityLine(p.multiplicity, label: label)
    asSavedNote = p.asSaved?["note"]?.stringValue
    synthetic = p.provenance.synthetic
    coverage = Self.coverage(p, nameA: nameA, nameB: nameB)
    frequency = Self.frequency(p.freq, nameA: nameA, nameB: nameB)
    withinCell = Self.withinCell(p.coverage.withinCell)
    baseline = Self.baseline(p)
    passages = Self.passages(p.passages)
    terms = Self.terms(p.collocates)
    groups = Self.groups(p.clusters, nameA: nameA, nameB: nameB)
    measures = p.measures.map { m in
      switch m.result {
      case .value(let e): .value(metric: m.metric, text: Self.measureText(m.metric, e, n: m.n, docs: m.docs))
      case .gated(let g):
        .gated(CompareGate(g, title: CompareCopy.measureNotEstimated(CompareCopy.measureLabels[m.metric] ?? m.metric), note: m.note,
                           id: "measure.\(m.metric)"))
      }
    }
    tone = Self.tone(p.tone)
    (human, humanNote) = Self.human(p.human)
    coverageNote = p.coverageNote
    caveats = Self.firedCaveats(p)
  }

  static func coverage(_ p: CompareResponse, nameA: String, nameB: String) -> Coverage {
    let cov = p.coverage
    func get(_ s: String, _ f: (JSONValue) -> String) -> String { f(cov.value(s)) }
    func count(_ key: String) -> (JSONValue) -> String { { $0[key]?.numberValue.map { Format.count($0) } ?? "—" } }
    let rows: [(String, (JSONValue) -> String)] = [
      ("tokens", { c in
        if let t = c["tokens"]?.numberValue { return Format.tokens(t) }
        if let w = c["works"]?.numberValue { return "\(Format.count(w)) works" }
        return "—"
      }),
      ("documents", count("docs")), ("authors", count("authors")), ("translations", count("translations")),
      ("undated share", { $0["undated_share"]?.numberValue.map { Format.share($0) } ?? "—" }),
      ("date basis", { shareList($0["basis"]) }), ("modality", { shareList($0["modality"]) }), ("kind mix", { shareList($0["mix"]) }),
    ]
    let facts = rows.map { Fact(label: $0.0, a: get("a", $0.1), b: get("b", $0.1)) }
    func stack(_ s: String) -> [Segment] {
      let c = cov.value(s)
      if let st = c["stack"]?.arrayValue, !st.isEmpty {
        return st.enumerated().compactMap { i, e in
          guard let share = e["share"]?.numberValue, share > 0 else { return nil }
          let label = [e["kind"]?.stringValue, e["lang"]?.stringValue, e["collection"]?.stringValue].compactMap { $0 }.joined(separator: " · ")
          return Segment(id: "\(s).\(i)", label: label, share: share)
        }
      }
      guard let mix = c["mix"]?.objectValue else { return [] }
      return mix.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.enumerated().compactMap { i, k in
        guard let v = mix[k]?.numberValue, v > 0 else { return nil }
        return Segment(id: "\(s).\(i)", label: k, share: v)
      }.sorted { $0.share > $1.share }
    }
    var out = Coverage(facts: facts, stackA: stack("a"), stackB: stack("b"))
    if let jsd = cov.compositionJsd { out.jsdLine = "Composition divergence JSD \(Format.number(jsd, sig: 2)) (base 2)" }
    if cov.caveats.contains("composition") || (cov.compositionJsd.map { $0 > 0.15 } ?? false) {
      out.compositionCaveat = "The slices differ in composition (JSD \(Format.number(cov.compositionJsd, sig: 2))): A is \(shareList(cov.value("a")["mix"])); "
        + "B is \(shareList(cov.value("b")["mix"])). Differences below may reflect source mix; standardized rates are shown beside raw rates."
    }
    if cov.prominence?["consistent"] == .bool(false) {
      out.prominenceCaveat = "Result depends on prominence stratum: rate ratios per prominence tercile point in different directions."
    }
    if cov.modalityGate != "ok" {
      if CompareGate.isGated(p.freq), p.freq["gate"]?.stringValue == cov.modalityGate {
        out.modalityGate = CompareGate(p.freq, title: CompareCopy.crossMediaRefused, id: "coverage.modality")
      } else {
        let g: JSONValue = ["gate": .string(cov.modalityGate), "needed": "the same dominant modality in both slices",
                            "have": ["a": cov.value("a")["modality"] ?? .null, "b": cov.value("b")["modality"] ?? .null], "suggestion": .null]
        out.modalityGate = CompareGate(g, title: CompareCopy.crossMediaRefused, id: "coverage.modality")
      }
    }
    return out
  }

  static func frequency(_ f: JSONValue, nameA: String, nameB: String) -> Frequency {
    if let g = CompareGate(f, title: CompareCopy.freqNotCompared, id: "freq") { return .gated(g) }
    guard f.objectValue != nil else { return .empty(CompareCopy.noFrequency) }
    let unitA = f["a"]?["unit"]?.stringValue, unitB = f["b"]?["unit"]?.stringValue
    let sameUnit = unitA != nil && unitA == unitB
    func side(_ k: String, _ name: String) -> FreqSide {
      let s = f[k]
      if let g = CompareGate(s, title: CompareCopy.rateNotEstimated(k.uppercased()), id: "freq.\(k)") {
        // counts only: a gated rate shows its matches and documents, never a rate, interval or dispersion
        var counts = "\(Format.count(s?["n"]?.numberValue)) matches"
        if let d = s?["docs"]?.numberValue { counts += " · \(Format.count(d)) documents" }
        return .gated(slice: name, counts: counts, gate: g)
      }
      guard let o = s?.objectValue else { return .missing(slice: name, line: "\(name): no frequency reported") }
      let unit = o["unit"]?.stringValue
      let ciArr = o["ci"]?.arrayValue?.map(\.numberValue)
      let line = "\(Format.count(o["n"]?.numberValue)) matches · \(Format.rate(o["rate"]?.numberValue, unit: unit)) \(Format.ci(ciArr, unit: unit))"
      let docs = o["docs"]?.numberValue.map { "\(Format.count($0)) documents" }
      let dp = o["dp"]?.numberValue.map { "dispersion (Gries' DP) \(Format.number($0, sig: 2))" }
      guard let rate = o["rate"]?.numberValue, rate.isFinite else { return .missing(slice: name, line: "\(name): \(line)") }
      let point = RatePoint(slice: k.uppercased(), rate: rate, lo: ciArr?.first ?? nil, hi: ciArr?.last ?? nil, unit: unit ?? "")
      return .rate(slice: name, line: line, docs: docs, dp: dp, point: point)
    }
    var ratio: Ratio?
    let rr = f["rate_ratio"]
    if let g = CompareGate(rr, title: CompareCopy.rateRatioNotEstimated, id: "freq.rate_ratio") {
      ratio = .gated(g)
    } else if let o = rr?.objectValue, sameUnit, let v = o["value"]?.numberValue, v.isFinite {
      var text = "Rate ratio B / A \(Format.number(v))"
      if let ci = o["ci"]?.arrayValue, ci.count == 2 {
        text += " [\(Format.number(ci[0].numberValue)), \(ci[1].numberValue.map { Format.number($0) } ?? "∞")]"
      }
      ratio = .value(text)
    } else if let o = rr?.objectValue, sameUnit, let note = o["note"]?.stringValue {
      ratio = .value(note)
    } else if !sameUnit {
      ratio = .differentUnits
    }
    var standardized: [String] = []
    if let s = f["standardized"]?.objectValue, sameUnit {
      if let a = s["a"]?.numberValue, let b = s["b"]?.numberValue {
        standardized.append("Standardized to the pooled composition: A \(Format.rate(a, unit: unitA)) · B \(Format.rate(b, unit: unitB))")
      }
      if let n = s["note"]?.stringValue { standardized.append(n) }
    }
    let method = [f["ci_method"]?.stringValue ?? "95% confidence intervals", sameUnit ? Format.unitLabel(unitA) : nil]
      .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    return .shown(sides: [side("a", nameA), side("b", nameB)], ratio: ratio, standardized: standardized, method: method,
                  unitLabel: sameUnit ? Format.unitLabel(unitA) : nil)
  }

  static func withinCell(_ wc: JSONValue?) -> WithinCell? {
    guard let o = wc?.objectValue else { return nil }
    return WithinCell(
      label: o["note"]?.stringValue ?? "Each cell is its own top-cited sample; shares are shown side by side, never as a rate, ratio or trend across cells.",
      method: o["method"]?.stringValue,
      a: (o["a"]?.arrayValue ?? []).map(cellWords), b: (o["b"]?.arrayValue ?? []).map(cellWords))
  }

  static func baseline(_ p: CompareResponse) -> Baseline? {
    guard let rho = p.baselineRho else { return nil }
    let json = (try? ScrollsJSON.value(rho)) ?? .null
    if let g = CompareGate(json, title: CompareCopy.rhoNotComputed, id: "baseline") { return .gated(g) }
    if let text = baselineRhoText(json) {
      let note = json["note"]?.stringValue
      return .text(text, label: "\(CompareCopy.baselineRhoLabel): a rank correlation of decade rates, not a check of any count\(note.map { ". \($0)" } ?? "")")
    }
    return .empty(json["note"]?.stringValue ?? json["reason"]?.stringValue ?? CompareCopy.noBaseline, label: CompareCopy.baselineRhoLabel)
  }

  static func passages(_ ps: ComparePassages) -> Passages {
    func rows(_ v: JSONValue) -> [KwicRow] {
      (v.arrayValue ?? []).compactMap { try? ScrollsJSON.decode(KwicRow.self, from: $0) }
    }
    return Passages(a: rows(ps.a), b: rows(ps.b), seedLine: "5 per slice at most, one per document · sampling seed \(ps.seed)", seed: ps.seed)
  }

  static func terms(_ col: JSONValue) -> Terms {
    if let g = CompareGate(col, title: CompareCopy.termsNotComputed, id: "collocates") { return .gated(g) }
    guard let o = col.objectValue else { return .empty(CompareCopy.noTerms) }
    if o["requested"] == .bool(false) { return .notRequested(o["label"]?.stringValue ?? CompareCopy.contextWordsLabel) }
    let shared = (o["shared"]?.arrayValue ?? []).map { x in
      Term(term: x["term"]?.stringValue ?? "",
           detail: "A \(Format.number(x["a"]?["logDice"]?.numberValue)) · B \(Format.number(x["b"]?["logDice"]?.numberValue))")
    }
    let sharedSet = Set(shared.map(\.term))
    func only(_ k: String) -> [Term] {
      (o[k]?.arrayValue ?? []).compactMap { x in
        let t = x["term"]?.stringValue ?? ""
        if sharedSet.contains(t) { return nil }
        var d = "logDice \(Format.number(x["logDice"]?.numberValue)) · f \(Format.count(x["f_xy"]?.numberValue))"
        if let q = x["q"]?.numberValue { d += " · q \(Format.number(q, sig: 2))" }
        return Term(term: t, detail: d)
      }
    }
    let keyness = (o["keyness"]?.arrayValue ?? []).map { x in
      Term(term: x["term"]?.stringValue ?? "",
           detail: "\(Format.number(x["log_ratio"]?.numberValue, sig: 2)) · more around \((x["side"]?.stringValue ?? "").uppercased())")
    }
    let label = "\(o["label"]?.stringValue ?? CompareCopy.contextWordsLabel)\(o["window"]?.stringValue.map { " · window \($0)" } ?? "")"
    return .shown(label: label, shared: shared, onlyA: only("a"), onlyB: only("b"), keyness: keyness)
  }

  static func groups(_ cl: JSONValue, nameA: String, nameB: String) -> Groups {
    if let g = CompareGate(cl, title: CompareCopy.groupsNotAvailable, id: "clusters") { return .gated(g) }
    guard let o = cl.objectValue else { return .empty(CompareCopy.noGroups) }
    func side(_ s: JSONValue?) -> String {
      guard let share = s?["share"]?.numberValue else { return "—" }
      var t = Format.share(share)
      if let ci = s?["ci"]?.arrayValue, ci.count == 2 { t += " [\(Format.share(ci[0].numberValue)), \(Format.share(ci[1].numberValue))]" }
      return t
    }
    let rows = (o["shares"]?.arrayValue ?? []).map { r -> GroupRow in
      let a = r["a"]?["share"]?.numberValue, b = r["b"]?["share"]?.numberValue
      var flag: String?
      if let a, let b, a < 0.02, b >= 0.10 { flag = "new use in B" }
      if let a, let b, b < 0.02, a >= 0.10 { flag = "declining in B" }
      return GroupRow(cluster: r["cluster"]?.safeInteger ?? 0, label: r["label"]?.stringValue ?? "", humanLabel: r["human_label"]?.stringValue,
                      a: "\(nameA) \(side(r["a"]))", b: "\(nameB) \(side(r["b"]))", flag: flag)
    }
    let meta = ["run \(o["run"]?.safeInteger.map(String.init) ?? "—")", o["representation"]?.stringValue.map { "representation \($0)" },
                "shares with document-block bootstrap 95% CIs"].compactMap { $0 }.joined(separator: " · ")
    return .shown(meta: meta, rows: rows)
  }

  static func tone(_ t: JSONValue) -> Tone {
    if let o = t.objectValue, o["requested"] == .bool(false) { return .notRequested }
    if let g = CompareGate(t, title: CompareCopy.toneNotComputed, id: "tone") {
      // the phone's availability gate (§4.10 item 8): Apple's sentiment model is not on this phone
      let missing = g.gate.code == .notRun && (t["needed"]?["model"] != nil || t["have"]?["model"] == .null && t["needed"]?["model"] != nil)
      return .gated(g, modelMissing: missing)
    }
    guard let o = t.objectValue else { return .notRequested }
    let lines = ["a", "b"].map { s -> String in
      let d = o[s]
      var line = "\(s.uppercased()): mean \(Format.number(d?["mean"]?.numberValue, sig: 2))"
      if let ci = d?["ci"]?.arrayValue, ci.count == 2 {
        line += " [\(Format.number(ci[0].numberValue, sig: 2)), \(Format.number(ci[1].numberValue, sig: 2))]"
      }
      return line + " · \(Format.count(d?["n"]?.numberValue)) paragraphs"
    }
    return .shown(label: o["label"]?.stringValue ?? CompareCopy.toneLabel, lines: lines)
  }

  static func human(_ h: JSONValue?) -> (String, String?) {
    func counts(_ o: JSONValue?) -> String {
      guard let obj = o?.objectValue, !obj.isEmpty else { return CompareCopy.none }
      return obj.keys.compactMap { k in obj[k]?.numberValue.map { (k, $0) } }
        .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.utf16.lexicographicallyPrecedes($1.0.utf16) }
        .map { "\($0.0) \(Format.count($0.1))" }.joined(separator: ", ")
    }
    let pf = h?["pragmatic_function"]
    let text = pf?.objectValue != nil ? "A: \(counts(pf?["a"])) · B: \(counts(pf?["b"]))" : CompareCopy.noHumanPragmatic
    return (text, h?["note"]?.stringValue)
  }

  // MARK: the text scan

  /// Every string the screen shows, by section (tests scan these; the view draws nothing else from the payload).
  var allStrings: [String] {
    var out = [subtitle, sliceA, sliceB, multiplicity]
    if let asSavedNote { out.append(asSavedNote) }
    out += coverage.facts.flatMap { [$0.label, $0.a, $0.b] }
    out += (coverage.stackA + coverage.stackB).map(\.label)
    out += [coverage.jsdLine, coverage.compositionCaveat, coverage.prominenceCaveat].compactMap { $0 }
    out += coverage.modalityGate?.strings ?? []
    out += gatedStrings + valueStrings
    out += [human, humanNote, coverageNote].compactMap { $0 }
    out += caveats
    return out.filter { !$0.isEmpty }
  }

  /// The strings of every gated part (each from its gate alone).
  var gates: [CompareGate] {
    var out: [CompareGate] = []
    if let g = coverage.modalityGate { out.append(g) }
    switch frequency {
    case .gated(let g): out.append(g)
    case .shown(let sides, let ratio, _, _, _):
      for s in sides { if case .gated(_, _, let g) = s { out.append(g) } }
      if case .gated(let g)? = ratio { out.append(g) }
    case .empty: break
    }
    if case .gated(let g)? = baseline { out.append(g) }
    if case .gated(let g) = terms { out.append(g) }
    if case .gated(let g) = groups { out.append(g) }
    for m in measures { if case .gated(let g) = m { out.append(g) } }
    if case .gated(let g, _) = tone { out.append(g) }
    return out
  }

  var gatedStrings: [String] {
    var out = gates.flatMap(\.strings)
    if case .shown(let sides, _, _, _, _) = frequency {
      for s in sides { if case .gated(let name, let counts, _) = s { out += [name, counts] } }
    }
    return out
  }

  var valueStrings: [String] {
    var out: [String] = []
    switch frequency {
    case .shown(let sides, let ratio, let standardized, let method, _):
      for s in sides {
        switch s {
        case .rate(let name, let line, let docs, let dp, _): out += [name, line] + [docs, dp].compactMap { $0 }
        case .missing(_, let line): out.append(line)
        case .gated: break
        }
      }
      if case .value(let t)? = ratio { out.append(t) }
      if case .differentUnits? = ratio { out.append(CompareCopy.differentUnits) }
      out += standardized + [method]
    case .empty(let t): out.append(t)
    case .gated: break
    }
    if let withinCell { out += [withinCell.label, withinCell.method].compactMap { $0 } + (withinCell.a + withinCell.b).flatMap { [$0.label, $0.text] } }
    switch baseline {
    case .text(let t, let l)?, .empty(let t, let l)?: out += [t, l]
    default: break
    }
    out.append(passages.seedLine)
    out += (passages.a + passages.b).flatMap { [$0.left, $0.match, $0.right, KwicWords.meta($0)] }
    switch terms {
    case .shown(let label, let shared, let a, let b, let k): out += [label] + (shared + a + b + k).flatMap { [$0.term, $0.detail] }
    case .empty(let t), .notRequested(let t): out.append(t)
    case .gated: break
    }
    switch groups {
    case .shown(let meta, let rows): out += [meta] + rows.flatMap { [$0.label, $0.humanLabel, $0.a, $0.b, $0.flag].compactMap { $0 } }
    case .empty(let t): out.append(t)
    case .gated: break
    }
    for m in measures { if case .value(_, let t) = m { out.append(t) } }
    if case .shown(let label, let lines) = tone { out += [label] + lines }
    return out
  }
}

extension CompareCoverage {
  /// Slice `a` or `b` of the coverage block (verbatim JSON).
  nonisolated func value(_ s: String) -> JSONValue { s == "a" ? a : b }
}
