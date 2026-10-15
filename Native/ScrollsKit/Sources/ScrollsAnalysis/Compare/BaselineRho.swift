// OWNER: N4
// Port of server/analysis/baseline-rho.mjs (SPEC §10.2, §2.E): "Does our sample track a larger corpus?" — Spearman ρ
// between the strand's per-decade rate in the compared running text and the Google Books Ngram rate per million over the
// same decades, with a moving-block bootstrap interval. Only an English single word has a baseline; a decade counts when
// our slice text meets the rate gate there and Google's decade rests on ≥ 500 books; fewer than 8 such decades → gate
// card, no ρ (§13 rule 7). The Ngram store is reached through `NgramLookup` (the STEMM attach is N2's, M2), so a phone
// without it says so in its own words.

import Foundation
import ScrollsCore

/// One decade of the Ngram baseline.
public struct NgramDecade: Sendable, Equatable {
  public var decade: Int
  public var matches: Double
  public var tokens: Double
  public var volumes: Double
  public init(decade: Int, matches: Double, tokens: Double, volumes: Double) {
    self.decade = decade
    self.matches = matches
    self.tokens = tokens
    self.volumes = volumes
  }
}

/// A word's Ngram series, or why there is none (`series(word, {from, to, lang})` of adapters/stemm/ngram.mjs).
public enum NgramSeries: Sendable, Equatable {
  case available(decades: [NgramDecade], label: String?, attribution: String?, license: String?, caveats: [String])
  case unavailable(reason: String)
}

/// The external baseline store.
public protocol NgramLookup: Sendable {
  func series(_ word: String, from: Int?, to: Int?, lang: String?) -> NgramSeries
}

/// No Ngram store: the reference's checks of the word, then `reason`.
public struct NgramStoreAbsent: NgramLookup {
  public let reason: String
  public init(reason: String) { self.reason = reason }

  /// The reference's wording when `sources/ngram-baseline/ngram-eng-1.sqlite` is not staged (differential runs).
  public static let reference = NgramStoreAbsent(reason: "The Ngram store is not staged (sources/ngram-baseline/ngram-eng-1.sqlite).")
  /// The phone's wording until the STEMM baseline arrives (DV: IOS-SPEC §3.6, N2 M2).
  public static let phone = NgramStoreAbsent(
    reason: "The Ngram baseline is not on this phone yet; it arrives with the STEMM sources from the Mac.")

  public func series(_ word: String, from: Int?, to: Int?, lang: String?) -> NgramSeries {
    let raw = JSString.trim(word)
    if raw.isEmpty { return .unavailable(reason: "no word given") }
    if raw.utf16.contains(where: JSString.isWhitespace) { return .unavailable(reason: "single words only") }
    // `/^en\b/i`
    if let lang, !lang.isEmpty, !BaselineRho.isEnglish(JSString.toLowerCase(lang)) {
      return .unavailable(reason: "The Ngram store holds English words only.")
    }
    return .unavailable(reason: reason)
  }
}
/// The baseline correlation.
enum BaselineRho {
  static let minBins = 8, maxYear = 2019, minVolumes = 500.0, block = 3, resamples = 1000
  static let seed: UInt32 = 42
  static let note = "Different corpus, different composition: Google Books is a much larger library with its own selection; "
    + "ρ only says whether the two decade series rise and fall together."

  /// `/^en\b/`: 'en' followed by a non-word character or the end.
  static func isEnglish(_ lang: String?) -> Bool {
    guard let lang else { return false }
    let u = Array(lang.utf16)
    guard u.count >= 2, u[0] == 0x65, u[1] == 0x6E else { return false }
    if u.count == 2 { return true }
    let c = u[2]
    let word = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
    return !word
  }

  /// Average ranks, 1-based.
  static func ranks(_ v: [Double]) -> [Double] {
    let idx = Array(0..<v.count).jsSorted { v[$0] - v[$1] }
    var out = [Double](repeating: 0, count: v.count)
    var i = 0
    while i < idx.count {
      var j = i
      while j + 1 < idx.count && v[idx[j + 1]] == v[idx[i]] { j += 1 }
      let r = Double(i + j) / 2 + 1
      for t in i...j { out[idx[t]] = r }
      i = j + 1
    }
    return out
  }

  /// Spearman's ρ (Pearson correlation of average ranks); nil when either series is constant.
  static func spearman(_ x: [Double], _ y: [Double]) -> Double? {
    let n = x.count
    if n < 2 { return nil }
    let rx = ranks(x), ry = ranks(y)
    var mx = 0.0, my = 0.0
    for i in 0..<n {
      mx += rx[i]
      my += ry[i]
    }
    mx /= Double(n)
    my /= Double(n)
    var sxy = 0.0, sxx = 0.0, syy = 0.0
    for i in 0..<n {
      let a = rx[i] - mx, b = ry[i] - my
      sxy += a * b
      sxx += a * a
      syy += b * b
    }
    return sxx > 0 && syy > 0 ? sxy / (sxx * syy).squareRoot() : nil
  }

  /// Moving-block bootstrap 95% interval of ρ.
  static func blockBootstrapRho(_ x: [Double], _ y: [Double]) -> (ci: (Double, Double)?, used: Int, skipped: Int) {
    let n = x.count
    let L = max(1, min(block, n))
    let starts = n - L + 1
    var rng = Mulberry32(seed: seed)
    var vals: [Double] = []
    var skipped = 0
    var bx = [Double](repeating: 0, count: n), by = [Double](repeating: 0, count: n)
    for _ in 0..<resamples {
      var at = 0
      while at < n {
        let s = Int((rng.next() * Double(starts)).rounded(.down))
        var t = 0
        while t < L && at < n {
          bx[at] = x[s + t]
          by[at] = y[s + t]
          t += 1
          at += 1
        }
      }
      guard let rho = spearman(bx, by) else {
        skipped += 1
        continue
      }
      vals.append(rho)
    }
    if Double(vals.count) < Double(resamples) / 2 { return (nil, vals.count, skipped) }
    let sorted = vals.sorted()
    func q(_ p: Double) -> Double {
      sorted[min(sorted.count - 1, max(0, Int(JSNumber.round(p * Double(sorted.count - 1)))))]
    }
    return ((q(0.025), q(0.975)), vals.count, skipped)
  }

  static func unavailable(_ reason: String) -> JSONObject {
    ["available": false, "reason": .string(reason), "note": .string(reason)]
  }

  /// `baselineRho(cx, {lookup})`.
  static func block(_ cx: CompareContext, lookup: any NgramLookup) -> JSONObject {
    guard cx.exprs.count == 1 else { return unavailable("The external baseline is compared for one expression at a time.") }
    let expr = cx.exprs[0]
    if !isEnglish(expr.lang) { return unavailable("No external baseline: the Ngram store holds English words only.") }
    if expr.norm.contains(" ") { return unavailable("No external baseline: the Ngram store holds single words only.") }
    if cx.sampled { return unavailable("Not compared: OpenAlex cells are top-cited samples, not a series of rates.") }
    if cx.statsA.modality != "text" || cx.statsB.modality != "text" {
      return unavailable("Not compared: Google Books is book text and these slices compare \(cx.statsA.modality).")
    }
    var forms: [String] = []
    for v in expr.variants where v.tokens.count == 1 && (v.lang == nil || isEnglish(v.lang)) && !forms.contains(where: { jsEqual($0, v.norm) }) {
      forms.append(v.norm)
    }
    let req = cx.req
    let lo = min(req.a.lo, req.b.lo)
    let hi = min(maxYear, max(req.a.hi, req.b.hi))
    let base = lookup.series(expr.norm, from: lo, to: hi, lang: "en")
    guard case .available(let decades, let label, let attribution, let license, let caveats) = base else {
      if case .unavailable(let reason) = base { return unavailable("No external baseline for '\(expr.norm)': \(reason).") }
      return unavailable("No external baseline for '\(expr.norm)': the Ngram store is not staged.")
    }
    var byDecade: [Int: NgramDecade] = [:]
    for d in decades { byDecade[d.decade] = d }
    var missing: [String] = []
    for f in forms where !jsEqual(f, expr.norm) {
      guard case .available(let ds, _, _, _, _) = lookup.series(f, from: lo, to: hi, lang: "en") else {
        missing.append(f)
        continue
      }
      for d in ds where byDecade[d.decade] != nil { byDecade[d.decade]!.matches += d.matches }
    }
    let sameFilter = jsEqual(req.a.f, req.b.f)
    func inside(_ d: Int, _ y: (Int, Int)) -> Bool { d >= y.0 && d + 9 <= y.1 }
    struct DecadeRow {
      var decade: Int, slice: String, n: Int, tokens: Int, rate: Double?, adequate: Bool
      var perMillion: Double?, volumes: Double, theirAdequate: Bool, shared: Bool
    }
    var rows: [DecadeRow] = []
    var d = Int((Double(lo) / 10).rounded(.up)) * 10
    while d + 9 <= hi {
      defer { d += 10 }
      let which: String? = sameFilter ? "a" : inside(d, req.a.years) ? "a" : inside(d, req.b.years) ? "b" : nil
      guard let which else { continue }
      let st = which == "a" ? cx.statsA : cx.statsB
      let w = cx.index(which).windowStats(d, d + 9)
      let g = byDecade[d]
      let rate: Double? = w.units > 0 ? (Double(w.n) / Double(w.units)) * 1e6 : nil
      let adequate = w.units >= st.gateUnits
      let perMillion: Double? = g.flatMap { $0.tokens > 0 ? ($0.matches / $0.tokens) * 1e6 : nil }
      let volumes = g?.volumes ?? 0
      let theirAdequate = g.map { $0.volumes >= minVolumes } ?? false
      rows.append(DecadeRow(decade: d, slice: which, n: w.n, tokens: w.units, rate: rate, adequate: adequate, perMillion: perMillion,
                            volumes: volumes, theirAdequate: theirAdequate, shared: adequate && theirAdequate && perMillion != nil))
    }
    let shared = rows.filter(\.shared)
    var meta: JSONObject = [
      "available": true, "unit": "per million tokens", "years": .ints([lo, hi]),
      "forms": .strings([expr.norm] + forms.filter { f in !jsEqual(f, expr.norm) && !missing.contains { jsEqual($0, f) } }),
      "forms_missing": .strings(missing), "label": .str(label), "attribution": .str(attribution), "license": .string(license ?? "CC BY 3.0"),
      "caveats": .strings(caveats),
      "rule": .string("≥ \(minBins) decades up to \(maxYear), each with our rate gate met and ≥ \(Int(minVolumes)) books in Google's decade"),
      "series": .array(rows.map { r in
        [
          "decade": .int(r.decade), "slice": .string(r.slice), "n": .int(r.n), "tokens": .int(r.tokens),
          "rate": r.rate == nil || !r.adequate ? .null : .number(JSRound.precision(r.rate!, 4)), "low_coverage": .bool(!r.adequate),
          "baseline_per_million": .num(r.perMillion.map { JSRound.precision($0, 4) }), "volumes": .number(r.volumes),
          "thin": .bool(r.volumes < minVolumes), "shared": .bool(r.shared),
        ]
      }),
    ]
    if shared.count < minBins {
      meta["n_bins"] = .int(shared.count)
      let g = Gates.gated("insufficient_coverage", needed: ["decades": .int(minBins)], have: ["decades": .int(shared.count)],
                          note: .string("Not compared: \(Format.count(Double(shared.count))) decade\(shared.count == 1 ? "" : "s") between \(lo) and \(hi) have enough text here and in Google Books (needs \(minBins)). Widen the slices to span more decades."))
      for (k, v) in g { meta[k] = v }
      return meta
    }
    let x = shared.map { $0.rate! }, y = shared.map { $0.perMillion! }
    guard let rho = spearman(x, y) else {
      meta["n_bins"] = .int(shared.count)
      let allZero = x.allSatisfy { $0 == 0 }
      let g = Gates.gated("insufficient_occurrences", needed: ["varying_rates": true], have: ["decades": .int(shared.count)],
                          note: .string("Not compared: the rate is the same in every shared decade\(allZero ? " (no occurrence in any)" : ""), so ρ is undefined."))
      for (k, v) in g { meta[k] = v }
      return meta
    }
    let boot = blockBootstrapRho(x, y)
    let ci = boot.ci.map { [JSRound.fixed($0.0, 2), JSRound.fixed($0.1, 2)] }
    let first = shared[0].decade, last = shared[shared.count - 1].decade + 9
    let r2 = JSRound.fixed(rho, 2)
    meta["gate"] = "ok"
    meta["value"] = .number(r2)
    meta["ci"] = ci.map { .array($0.map(JSONValue.number)) } ?? .null
    meta["n_bins"] = .int(shared.count)
    meta["span"] = .ints([first, last])
    meta["method"] = .string("Spearman ρ over decades; moving-block bootstrap 95% CI (blocks of \(block) decades, \(boot.used) resamples, seed \(seed))")
    meta["note"] = .string(note)
    let ciText = ci.map { " [\(JSNumber.format($0[0])), \(JSNumber.format($0[1]))]" } ?? ""
    meta["text"] = .string("Does our sample track a larger corpus? ρ = \(JSNumber.format(r2))\(ciText) (\(shared.count) decades, \(first)–\(last)). \(note)")
    return meta
  }
}
