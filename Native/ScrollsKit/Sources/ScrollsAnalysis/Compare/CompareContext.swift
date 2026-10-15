// OWNER: N4
// Everything a comparison is computed from (compare.mjs `compareContext`): the normalized request, the expressions, the
// scope, each slice's statistics in the compared modality, the composition JSD, the modality and sampling refusals and
// the widening search. The payload is built from it, and the drift and tone jobs (M3) evaluate the same gates from it.

import Foundation
import ScrollsCore
import ScrollsStore

/// Machine tone availability (`adapterStatus()`): on the phone, Apple's NaturalLanguage probed in process (ScrollsNL);
/// in differential runs, the reference's absent adapter.
public struct ToneAvailability: Sendable, Equatable {
  /// Whether the sentiment model is present.
  public var installed: Bool
  /// Languages with sentiment, or nil when unknown.
  public var sentimentLanguages: [String]?
  /// The adapter's name in gate cards.
  public var adapter: String
  /// The sentence when it is missing.
  public var missingReason: String

  public init(installed: Bool, sentimentLanguages: [String]?, adapter: String, missingReason: String) {
    self.installed = installed
    self.sentimentLanguages = sentimentLanguages
    self.adapter = adapter
    self.missingReason = missingReason
  }

  /// The reference without `bin/scrolls-nl` (differential runs).
  public static let referenceAbsent = ToneAvailability(installed: false, sentimentLanguages: nil, adapter: "scrolls-nl",
                                                       missingReason: Gates.toneAdapterMissing)
}

/// What an analysis read may depend on besides the database (injected, so a differential run reproduces the reference's
/// environment and the phone states its own).
public struct AnalysisEnvironment: Sendable {
  public var tone: ToneAvailability
  public var ngram: any NgramLookup
  /// `derived/tokens` (the token streams); nil when there are none.
  public var tokenStreams: URL?

  public init(tone: ToneAvailability, ngram: any NgramLookup, tokenStreams: URL?) {
    self.tone = tone
    self.ngram = ngram
    self.tokenStreams = tokenStreams
  }

  /// The reference's environment on a snapshot clone: no NL adapter, no Ngram store, the clone's token streams.
  public static func reference(tokenStreams: URL?) -> AnalysisEnvironment {
    AnalysisEnvironment(tone: .referenceAbsent, ngram: NgramStoreAbsent.reference, tokenStreams: tokenStreams)
  }
}

/// How a suggestion describes what a widened slice would have.
struct Describe {
  let text: (WindowStats) -> String
  let data: (WindowStats) -> JSONValue
}

/// The comparison context.
final class CompareContext {
  let req: NormalizedCompareRequest
  let exprs: [ResolvedExpression]
  let label: String
  let scope: Scope
  let specA: SliceSpec
  let specB: SliceSpec
  let evA: JSMap<(n: Int, docs: Int, units: Int)>
  let evB: JSMap<(n: Int, docs: Int, units: Int)>
  let domA: String?
  let domB: String?
  let mismatch: Bool
  let descriptive: Bool
  let modality: String?
  let statsA: SliceStats
  let statsB: SliceStats
  let collectionsUsed: [String]
  let sampled: Bool
  let jsd: Double?
  let lang: String?
  let env: AnalysisEnvironment
  private var indexes: [String: WideningIndex] = [:]

  /// `shares(ev, key)`: shares rounded to 4 decimals over the positive entries.
  static func shares(_ ev: JSMap<(n: Int, docs: Int, units: Int)>, _ key: String) -> JSMap<Double> {
    func pick(_ v: (n: Int, docs: Int, units: Int)) -> Int { key == "n" ? v.n : v.docs }
    var t = 0
    for (_, v) in ev { t += pick(v) }
    var out = JSMap<Double>(objectOrder: true)
    if t > 0 { for (k, v) in ev where pick(v) > 0 { out[k] = JSRound.fixed(Double(pick(v)) / Double(t), 4) } }
    return out
  }

  static func sharesJSON(_ m: JSMap<Double>) -> JSONValue { .object(JSONObject(m.entries.map { ($0.key, JSONValue.number($0.value)) })) }

  /// The dominant modality of a slice: ≥ 80% of its matches (or, without matches, of its covered documents).
  static func dominantModality(_ ev: JSMap<(n: Int, docs: Int, units: Int)>) -> String? {
    let byN = shares(ev, "n")
    let use = byN.isEmpty ? shares(ev, "docs") : byN
    for (m, s) in use where s >= ModalityClasses.dominantShare { return m }
    return nil
  }

  init(_ c: Connection, req: NormalizedCompareRequest, env: AnalysisEnvironment) throws {
    self.req = req
    self.env = env
    exprs = try Expressions.resolve(c, ids: req.expr, pinned: req.runs)
    label = exprs.map(\.surface).joined(separator: " + ")
    scope = try Scopes.load(c, exprs: exprs, slices: [req.a, req.b], toggles: req.toggles, corpus: req.corpus, cutoffs: req.cutoffs)
    specA = scope.specs[0]
    specB = scope.specs[1]
    evA = Slices.modalityEvidence(scope, specA)
    evB = Slices.modalityEvidence(scope, specB)
    domA = Self.dominantModality(evA)
    domB = Self.dominantModality(evB)
    mismatch = domA != nil && domB != nil && domA != domB
    descriptive = mismatch && req.override == "descriptive"
    var modality: String?
    if !mismatch {
      modality = domA ?? domB
      if modality == nil {
        var pooled = JSMap<(n: Int, docs: Int)>(objectOrder: true)
        for ev in [evA, evB] {
          for (m, v) in ev { pooled.update(m, default: (0, 0)) { $0.n += v.n; $0.docs += v.docs } }
        }
        modality = pooled.entries.jsSorted { x, y in
          Double(y.value.n - x.value.n) != 0 ? Double(y.value.n - x.value.n) : Double(y.value.docs - x.value.docs)
        }.first?.key ?? "text"
      }
    }
    self.modality = modality
    statsA = Slices.stats(scope, specA, mismatch ? domA! : modality!)
    statsB = Slices.stats(scope, specB, mismatch ? domB! : modality!)
    var used = JSSet(statsA.collections)
    for s in statsB.collections { used.insert(s) }
    collectionsUsed = used.sorted
    let scopeRef = scope
    sampled = collectionsUsed.contains { s in scopeRef.collection(slug: s)?.sampling == "top_cited_per_cell" }
    jsd = mismatch ? nil : Composition.jsd(statsA.composition, statsB.composition)
    lang = exprs[0].lang ?? Self.primaryLanguage(statsA, statsB)
  }

  /// The language holding most of both slices' tokens (for language-free expressions).
  static func primaryLanguage(_ a: SliceStats, _ b: SliceStats) -> String? {
    var w = JSMap<Double>(objectOrder: true)
    for st in [a, b] { for (l, s) in st.languages { w.update(l, default: 0) { $0 += s * Double(st.units) } } }
    return w.entries.jsSorted { x, y in y.value - x.value }.first?.key
  }

  /// The widening index of a slice, built once.
  func index(_ which: String) -> WideningIndex {
    if let i = indexes[which] { return i }
    let i = WideningIndex.build(scope, which == "a" ? specA : specB, which == "a" ? statsA.modality : statsB.modality)
    indexes[which] = i
    return i
  }

  /// Widens the failing slices (A first, then B against A's new years); nil when either cannot reach the gate.
  func suggest(a failA: Bool, b failB: Bool, _ crit: WidenCriteria, _ describe: Describe) -> JSONObject? {
    var out: JSONObject = [:]
    var wouldHave: JSONObject = [:]
    var yearsA = req.a.years
    var labels: [String] = []
    for which in ["a", "b"] {
      if !(which == "a" ? failA : failB) { continue }
      let spec = which == "a" ? specA : specB
      let other = which == "a" ? req.b.years : yearsA
      guard let w = Gates.widenSuggestion(index(which), years: spec.years, crit: crit, other: other) else { return nil }
      if which == "a" { yearsA = w.years }
      out[which] = ["years": .ints([w.years.0, w.years.1]), "f": .string(spec.fStr)]
      wouldHave[which] = describe.data(w.stats)
      labels.append(Gates.widenLabel(which, w.years, describe.text(w.stats)))
    }
    out["would_have"] = .object(wouldHave)
    out["label"] = .string(labels.joined(separator: " and "))
    return out
  }

  /// `evidenceText`: occurrences in documents (and authors in the data).
  let evidenceText = Describe(
    text: { "\(Format.count(Double($0.n))) occurrences in \(Format.count(Double($0.docs))) documents" },
    data: { ["occurrences": .int($0.n), "documents": .int($0.docs), "authors": .int($0.authors)] })

  /// `driftRunScope(collectionsUsed, exprs)`.
  var fingerprintScope: (scope: JSONValue, upstream: [Int]) { StoredRuns.driftRunScope(collectionsUsed, exprs) }

  /// The documents of a slice that hold counted matches (`evidenceDocIds`).
  static func evidenceDocIds(_ st: SliceStats) -> [Int] { st.perDoc.filter { $0.n > 0 }.map(\.id) }
}
