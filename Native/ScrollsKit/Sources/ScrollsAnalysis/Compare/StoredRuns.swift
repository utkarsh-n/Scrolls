// OWNER: N4
// What Compare reads from stored runs (server/analysis/drift.mjs, tone.mjs, occvec.mjs, labels.mjs and
// jobs/context.mjs): input fingerprints, the newest clustering run of an expression with its context groups and
// per-document counts, stored drift results (neighbour overlap, aligned displacement) of exactly this comparison, stored
// machine tone, the vector spaces, and era slices. The runs themselves are built by jobs (N4 M3); M1 reads them.

import CryptoKit
import Foundation
import ScrollsCore
import ScrollsStore

/// sha256 hex of a string's UTF-8.
func sha256Hex(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

/// Fingerprints and stored runs.
enum StoredRuns {
  /// `inputFingerprint(db, {scope, upstream})` of jobs/context.mjs.
  static func inputFingerprint(_ c: Connection, scope: JSONValue, upstream: [Int]) throws -> String {
    let wanted: [String]? = scope["collections"]?.arrayValue?.map { v in
      switch v {
      case .string(let s): s
      case .number(let n): JSNumber.format(n)
      default: CanonicalJSON.string(v)
      }
    }
    var batches = JSONObject()
    for r in try c.rows(AnalysisSQL.collectionBatches, [], { (slug: $0.text(0), id: $0.i(1), batch: $0.iOrNil(2)) }) {
      if wanted == nil || wanted!.contains(where: { jsEqual($0, r.slug) || $0 == String(r.id) }) {
        batches[r.slug] = .int(r.batch ?? 0)
      }
    }
    let body: JSONValue = [
      "scope": scope, "batches": .object(batches), "quality": .string(try c.metaValue("quality_version") ?? "0"),
      "upstream": .ints(upstream.sorted()), "tokenizer": .string(Tokenizer.version), "segmenter": .string("seg-1"),
    ]
    return sha256Hex(CanonicalJSON.string(body))
  }

  /// `driftRunScope(collections, exprs)`.
  static func driftRunScope(_ collections: [String], _ exprs: [ResolvedExpression]) -> (scope: JSONValue, upstream: [Int]) {
    (["collections": .strings(collections.sorted(by: jsLess))], exprs.map(\.run).sorted())
  }

  /// The comparison's run parameters (`runParams` of compareContext, then driftRunParams / toneRunParams).
  static func comparisonParams(_ req: NormalizedCompareRequest, version: String, extra: JSONObject = [:]) -> JSONValue {
    var o: JSONObject = [
      "version": .string(version), "expr": .ints(req.expr.sorted()), "a": req.a.json, "b": req.b.json,
      "toggles": req.toggles.json, "corpus": .str(req.corpus),
    ]
    for (k, v) in extra { o[k] = v }
    if let r = req.runs { o["runs"] = r.json }
    if let c = req.cutoffs { o["cutoffs"] = c.json }
    return .object(o)
  }

  /// The `run` suggestion params of a comparison (`runParams`): expr, a, b, toggles, corpus and the as-saved pins.
  static func runParams(_ req: NormalizedCompareRequest) -> JSONValue {
    var o: JSONObject = ["expr": .ints(req.expr), "a": req.a.json, "b": req.b.json, "toggles": req.toggles.json,
                         "corpus": .str(req.corpus)]
    if let r = req.runs { o["runs"] = r.json }
    if let c = req.cutoffs { o["cutoffs"] = c.json }
    return .object(o)
  }

  // ── drift ──

  static let driftVersion = "drift@1.0.0"
  static let toneVersion = "tone@1.0.0"

  /// `storedDriftResults(db, params, fp)`: the newest succeeded drift run of exactly this comparison on current data.
  static func storedDrift(_ c: Connection, params: JSONValue, scope: JSONValue, upstream: [Int]) throws
    -> (run: Int, measures: [String: JSONObject])?
  {
    let hash = sha256Hex(CanonicalJSON.string(params))
    let fp = try inputFingerprint(c, scope: scope, upstream: upstream)
    guard let run = try c.first(AnalysisSQL.storedDriftRun, [.text(hash), .text(fp)], { $0.i(0) }) else { return nil }
    var measures: [String: JSONObject] = [:]
    for r in try c.rows(AnalysisSQL.driftResults, [.int(Int64(run))], { r in
      (metric: r.text(0), value: r.doubleOrNil(1), ciLo: r.doubleOrNil(2), ciHi: r.doubleOrNil(3), pct: r.doubleOrNil(4),
       gate: r.text(5), detail: r.text(6))
    }) {
      let detail = JSONValue.parseOrNil(r.detail)?.objectValue ?? [:]
      if r.gate == "ok" {
        var o = detail
        o["gate"] = "ok"
        o["value"] = .num(r.value)
        o["ci"] = r.ciLo == nil ? .null : [.num(r.ciLo), .num(r.ciHi)]
        o["percentile"] = .num(r.pct)
        measures[r.metric] = o
      } else {
        measures[r.metric] = Gates.gated(r.gate, needed: detail["needed"] ?? [:], have: detail["have"] ?? [:],
                                         suggestion: .null, note: detail["note"] ?? .null)
      }
    }
    return (run, measures)
  }

  // ── clustering runs ──

  struct ClusterRow {
    var id: Int
    var ord: Int
    var label: String
    var status: String
    var size: Int
    var humanLabel: String?
  }

  struct ClusterRun {
    var run: Int
    var representation: String?
    var modality: String?
    var clusters: [ClusterRow]
  }

  /// `clusterRunFor(db, exprId, {modality, run, before, revCutoff})`.
  static func clusterRun(_ c: Connection, expr: Int, modality: String?, run: Int?, before: String?, revCutoff: Int?) -> ClusterRun? {
    let row: (id: Int, rep: String?, modality: String?)?
    do {
      if let run {
        row = try c.first(AnalysisSQL.clusterRunPinned, [.int(Int64(run)), .string(modality), .string(modality), .int(Int64(expr))]) {
          ($0.i(0), $0.textOrNil(1), $0.textOrNil(2))
        }
      } else {
        row = try c.first(AnalysisSQL.clusterRunNewest,
                          [.string(before), .string(before), .string(modality), .string(modality), .int(Int64(expr))]) {
          ($0.i(0), $0.textOrNil(1), $0.textOrNil(2))
        }
      }
    } catch {
      return nil
    }
    guard let row else { return nil }
    var clusters = (try? c.rows(AnalysisSQL.clustersOfRun, [.int(Int64(row.id)), .int(Int64(expr))]) { r in
      ClusterRow(id: r.i(0), ord: r.i(1), label: r.text(2), status: r.text(3), size: r.i(4), humanLabel: r.textOrNil(5))
    }) ?? []
    if let revCutoff {
      let then = humanLabels(c, clusters.map(\.id), revCutoff: revCutoff)
      for i in clusters.indices { clusters[i].humanLabel = then[clusters[i].id] }
    }
    return ClusterRun(run: row.id, representation: row.rep, modality: row.modality, clusters: clusters)
  }

  /// `humanLabels(db, clusterIds, {revCutoff})`: the readers' labels (trimmed, non-empty) as they stood at the cutoff.
  static func humanLabels(_ c: Connection, _ ids: [Int], revCutoff: Int?) -> [Int: String] {
    var out: [Int: String] = [:]
    if ids.isEmpty { return out }
    let rows = (try? c.rows(AnalysisSQL.humanLabels, [.text(jsonArray(ids)), .integer(revCutoff), .integer(revCutoff)]) { r in
      (ref: r.text(1), body: r.text(3))
    }) ?? []
    for r in rows {
      let label = JSString.trim(r.body)
      if label.isEmpty { continue }
      if let id = Int(r.ref) { out[id] = label }
    }
    return out
  }

  /// `clusterDocCounts(db, cr, exprId)`: document id → counts by cluster position.
  static func clusterDocCounts(_ c: Connection, _ cr: ClusterRun, expr: Int) throws -> [Int: [Double]] {
    var pos: [Int: Int] = [:]
    for (i, cl) in cr.clusters.enumerated() { pos[cl.id] = i }
    var out: [Int: [Double]] = [:]
    let s = try c.prepared(AnalysisSQL.clusterDocCounts)
    try s.bind(.int(Int64(cr.run)), .int(Int64(expr)))
    while let r = try s.step() {
      guard let j = pos[r.i(1)] else { continue }
      out[r.i(0), default: [Double](repeating: 0, count: cr.clusters.count)][j] += 1
    }
    return out
  }

  // ── tone ──

  /// `storedTone(db, params, fp)`.
  static func storedTone(_ c: Connection, params: JSONValue, scope: JSONValue, upstream: [Int]) throws
    -> (run: Int, modelVersion: String?, rows: [(passage: Int, doc: Int, score: Double)])?
  {
    let hash = sha256Hex(CanonicalJSON.string(params))
    let fp = try inputFingerprint(c, scope: scope, upstream: upstream)
    guard let run = try c.first(AnalysisSQL.storedToneRun, [.text(hash), .text(fp)], { ($0.i(0), $0.textOrNil(1)) }) else {
      return nil
    }
    let rows = try c.rows(AnalysisSQL.toneRows, [.int(Int64(run.0))]) { r -> (passage: Int, doc: Int, score: Double)? in
      // json_extract gives a number only for a numeric score (`typeof r.score === 'number'`)
      switch r.value(2) {
      case .int(let n): return (r.i(0), r.i(1), Double(n))
      case .double(let d): return (r.i(0), r.i(1), d)
      default: return nil
      }
    }.compactMap { $0 }
    return (run.0, run.1, rows)
  }

  // ── spaces ──

  struct SpaceRow {
    var id: Int
    var run: Int
    var collections: [String]
    var tokens: Int
    var vocab: Int
    var dim: Int
  }

  /// `pooledSpaceFor(db, lang, {collections})`.
  static func pooledSpace(_ c: Connection, lang: String, collections: [String]) -> SpaceRow? {
    let spaces = (try? c.rows(AnalysisSQL.spaces, [.text(lang), .text(lang), .int(1), .int(1), .null, .null]) { r in
      SpaceRow(id: r.i(0), run: r.i(1), collections: (JSONValue.parseOrNil(r.text(4))?.arrayValue ?? []).compactMap(\.stringValue),
               tokens: r.i(5), vocab: r.i(6), dim: r.i(7))
    }) ?? []
    if collections.isEmpty { return spaces.first }
    let want = JSSet(collections)
    func covers(_ sp: SpaceRow) -> Bool { want.allSatisfy { w in sp.collections.contains { jsEqual($0, w) } } }
    if let exact = spaces.first(where: { covers($0) && $0.collections.count == want.count }) { return exact }
    let superset = spaces.filter(covers).jsSorted { a, b in
      a.collections.count != b.collections.count ? Double(a.collections.count - b.collections.count) : Double(b.id - a.id)
    }.first
    if let superset { return superset }
    return spaces.first { sp in collections.contains { c in sp.collections.contains { jsEqual($0, c) } } }
  }
}

/// Era slices and the words around them (drift.mjs §4.8).
enum Eras {
  static let boundaries = [1800, 1850, 1875, 1900, 1929]
  static let gate = (tokens: 3_000_000, docs: 10, authors: 5)
  static let languageNames = ["en": "English", "fr": "French", "es": "Spanish", "de": "German", "hi": "Hindi",
                              "gu": "Gujarati", "la": "Latin", "it": "Italian", "pt": "Portuguese"]

  /// 'Spanish', or the code.
  static func languageName(_ lang: String) -> String {
    languageNames[String(lang.split(separator: "-", omittingEmptySubsequences: false).first ?? "")] ?? lang
  }

  struct Slice {
    var years: (Int, Int)
    var tokens: Int
    var docs: Int
    var authors: Int
    var eligible: Bool
  }

  /// `eraSlices(docs)`: contiguous slices built greedily from the earliest year.
  static func slices(_ docs: [(yLo: Int, yHi: Int, tokens: Int, author: String?)]) -> (slices: [Slice], eligible: Int) {
    if docs.isEmpty { return ([], 0) }
    var minY = Int.max, maxY = Int.min
    for d in docs {
      minY = min(minY, d.yLo)
      maxY = max(maxY, d.yHi)
    }
    let cuts = boundaries.filter { $0 > minY && $0 <= maxY } + [maxY + 1]
    func stats(_ lo: Int, _ hi: Int) -> (tokens: Int, docs: Int, authors: Int) {
      var tokens = 0, n = 0
      var authors = JSSet()
      for d in docs where !(d.yLo < lo || d.yHi > hi) {
        tokens += d.tokens
        n += 1
        if let a = d.author, !a.isEmpty { authors.insert(a) }
      }
      return (tokens, n, authors.count)
    }
    var out: [Slice] = []
    var start = minY
    for b in cuts where b > start {
      let s = stats(start, b - 1)
      if s.tokens >= gate.tokens && s.docs >= gate.docs && s.authors >= gate.authors {
        out.append(Slice(years: (start, b - 1), tokens: s.tokens, docs: s.docs, authors: s.authors, eligible: true))
        start = b
      }
    }
    if start <= maxY {
      let s = stats(start, maxY)
      out.append(Slice(years: (start, maxY), tokens: s.tokens, docs: s.docs, authors: s.authors, eligible: false))
    }
    return (out, out.filter(\.eligible).count)
  }

  /// `eraNote(lang, era)`.
  static func note(_ lang: String, _ era: (slices: [Slice], eligible: Int)) -> String? {
    if era.eligible >= 2 { return nil }
    let name = languageName(lang)
    let short = era.slices.first { !$0.eligible }
    let why = short.map { " (\(Gates.rangeLabel($0.years)) has \(shortfall($0)))" } ?? ""
    let count = era.eligible == 0 ? "no eligible slice" : "one eligible slice"
    return "Aligned displacement unavailable for \(name): \(count)\(why)"
  }

  static func shortfall(_ s: Slice) -> String {
    if s.tokens < gate.tokens { return "\(Gates.tokensHave(Double(s.tokens))) tokens; needs \(Format.tokens(gate.tokens))" }
    if s.docs < gate.docs { return "\(Format.count(Double(s.docs))) documents; needs \(gate.docs)" }
    return "\(Format.count(Double(s.authors))) authors; needs \(gate.authors)"
  }
}
