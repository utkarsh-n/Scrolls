// OWNER: N4
// Request normalization of server/analysis/slices.mjs and compare.mjs (SPEC §2.E, §7.2): slices {years, f}, the toggles
// with their defaults, the as-saved pins and cutoffs of a saved view (RF-2, D17), and the Compare request. A request is
// validated from its JSON body exactly as the reference validates POST /api/compare, so the messages are byte-equal.

import Foundation
import ScrollsContracts
import ScrollsCore

/// The default exclusions as 0/1 (§7: tr ds ap dup nm est bp; vocab TOGGLE_DEFAULTS).
public struct Toggles: Sendable, Equatable {
  public var tr: Int, ds: Int, ap: Int, dup: Int, nm: Int, est: Int, bp: Int

  public init() {
    let d = Vocab.toggleDefaults
    tr = d["tr"] ?? 0; ds = d["ds"] ?? 0; ap = d["ap"] ?? 0; dup = d["dup"] ?? 0
    nm = d["nm"] ?? 0; est = d["est"] ?? 1; bp = d["bp"] ?? 0
  }

  public static let keys = ["tr", "ds", "ap", "dup", "nm", "est", "bp"]

  public subscript(key: String) -> Int {
    get {
      switch key {
      case "tr": tr
      case "ds": ds
      case "ap": ap
      case "dup": dup
      case "nm": nm
      case "est": est
      case "bp": bp
      default: 0
      }
    }
    set {
      switch key {
      case "tr": tr = newValue
      case "ds": ds = newValue
      case "ap": ap = newValue
      case "dup": dup = newValue
      case "nm": nm = newValue
      case "est": est = newValue
      case "bp": bp = newValue
      default: break
      }
    }
  }

  /// `normalizeToggles(raw)`: 0/1, '0'/'1' and booleans are read; anything else keeps the default.
  public static func normalize(_ raw: JSONValue?) -> Toggles {
    var out = Toggles()
    guard let o = raw?.objectValue else { return out }
    for k in keys {
      switch o[k] {
      case .number(let v) where v == 0 || v == 1: out[k] = Int(v)
      case .string(let s) where s == "0" || s == "1": out[k] = Int(s)!
      case .bool(let b): out[k] = b ? 1 : 0
      default: break
      }
    }
    return out
  }

  public var json: JSONValue { .object(JSONObject(Toggles.keys.map { ($0, JSONValue.number(Double(self[$0]))) })) }
}

/// One slice of a request: whole years [lo, hi] and a filter in the view-state grammar.
public struct SliceRequest: Sendable, Equatable {
  public var lo: Int
  public var hi: Int
  public var f: String
  public var years: (Int, Int) { (lo, hi) }
  public init(lo: Int, hi: Int, f: String) {
    self.lo = lo
    self.hi = hi
    self.f = f
  }
  public var json: JSONValue { ["years": [.number(Double(lo)), .number(Double(hi))], "f": .string(f)] }
}

/// The pins and cutoffs of a saved view opened as saved (RF-2).
public struct AsSavedRuns: Sendable, Equatable {
  /// Expression id (as the reference's string key) → materialize run.
  public var materialize: [(key: String, run: Int)]?
  public var cluster: Int?
  public var json: JSONValue {
    var o = JSONObject()
    if let m = materialize { o["materialize"] = .object(JSONObject(m.map { ($0.key, JSONValue.number(Double($0.run))) })) }
    if let c = cluster { o["cluster"] = .number(Double(c)) }
    return .object(o)
  }
  public static func == (x: AsSavedRuns, y: AsSavedRuns) -> Bool { x.json == y.json }
  /// The pinned run of an expression.
  public func pinned(_ expr: Int) -> Int? { materialize?.first { $0.key == String(expr) }?.run }
}

public struct AsSavedCutoffs: Sendable, Equatable {
  public var importBatch: Int?
  public var at: String?
  public var annotationRev: Int?
  public var json: JSONValue {
    var o = JSONObject()
    if let v = importBatch { o["import_batch"] = .number(Double(v)) }
    if let v = at { o["at"] = .string(v) }
    if let v = annotationRev { o["annotation_rev"] = .number(Double(v)) }
    return .object(o)
  }
}

/// A validated POST /api/compare body (`normalizeCompareRequest`).
public struct NormalizedCompareRequest: Sendable, Equatable {
  public var expr: [Int]
  public var a: SliceRequest
  public var b: SliceRequest
  public var measures: [String]
  public var toggles: Toggles
  public var seed: Int?
  public var laneFacet: String
  public var corpus: String?
  public var override: String?
  public var runs: AsSavedRuns?
  public var cutoffs: AsSavedCutoffs?
}

/// Request validation (slices.mjs and compare.mjs).
public enum SliceRequests {
  /// Years a slice may span (astronomical; §8.2 axis limits).
  public static let minYear = -10000
  public static let maxYear = 2100
  /// Every measure a Compare request may name (§7.2).
  public static let measures = ["freq", "collocates", "clusters", "sense_share_jsd", "neighbor_overlap", "aligned_displacement", "tone"]
  public static let laneFacets = ["collection", "community", "kind", "culture", "language", "field", "domain", "modality", "date_basis"]

  static func bad(_ message: String, _ hint: String?, _ detail: JSONValue) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, hint: hint, detail: detail)
  }

  /// `normalizeSlice(raw, which)`.
  public static func normalizeSlice(_ raw: JSONValue?, _ which: String) throws -> SliceRequest {
    let name = which.uppercased()
    let years = raw?["years"]?.arrayValue
    guard let years, years.count == 2, let lo = years[0].safeInteger, let hi = years[1].safeInteger, lo <= hi else {
      throw bad("Slice \(name) must have years [lo, hi] with lo ≤ hi.", "Set both slices with A and B on a range, then C.",
                ["field": .string("\(which).years")])
    }
    if lo < minYear || hi > maxYear {
      throw bad("Slice \(name) must lie between \(minYear) and \(maxYear).", "Years are astronomical (1 BCE = 0).",
                ["field": .string("\(which).years")])
    }
    let f: String?
    switch raw?["f"] {
    case nil, .null?: f = ""
    case .string(let s)?: f = s
    default: f = nil
    }
    guard let f, f.utf16.count <= 1000 else {
      throw bad("Slice \(name) has a malformed filter.", "Use the filter grammar, e.g. 'lang:en;kind:book'.",
                ["field": .string("\(which).f")])
    }
    return SliceRequest(lo: lo, hi: hi, f: f)
  }

  /// A UTC instant as the reference writes a save time.
  static func isISOInstant(_ s: String) -> Bool {
    let u = Array(s.utf8)
    func digits(_ r: Range<Int>) -> Int? {
      guard r.upperBound <= u.count else { return nil }
      var v = 0
      for i in r {
        guard u[i] >= 0x30 && u[i] <= 0x39 else { return nil }
        v = v * 10 + Int(u[i] - 0x30)
      }
      return v
    }
    guard u.count >= 20, let y = digits(0..<4), u[4] == 0x2D, let mo = digits(5..<7), u[7] == 0x2D, let d = digits(8..<10),
          u[10] == 0x54, let h = digits(11..<13), u[13] == 0x3A, let mi = digits(14..<16), u[16] == 0x3A,
          let sec = digits(17..<19) else { return false }
    var i = 19
    if u[i] == 0x2E {
      i += 1
      let start = i
      while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { i += 1 }
      guard (1...3).contains(i - start) else { return false }
    }
    guard i == u.count - 1, u[i] == 0x5A else { return false }
    // Date.parse: a finite instant (month 1–12, day 1–31, 24:00:00 allowed, minutes and seconds < 60)
    _ = y
    guard (1...12).contains(mo), (1...31).contains(d), mi < 60, sec < 60 else { return false }
    return h < 24 || (h == 24 && mi == 0 && sec == 0)
  }

  /// `normalizeAsSaved(body, exprIds)`.
  public static func normalizeAsSaved(_ body: JSONObject, exprIds: [Int]) throws -> (runs: AsSavedRuns?, cutoffs: AsSavedCutoffs?) {
    func badField(_ message: String, _ field: String) -> ScrollsError {
      bad(message, "Send the runs and cutoffs of GET /api/views/:slug, as the timeline query does.", ["field": .string(field)])
    }
    func posInt(_ v: JSONValue?) -> Int? { v?.safeInteger.flatMap { $0 > 0 ? $0 : nil } }
    var runs: AsSavedRuns?
    if let r = body["runs"], !r.isNull {
      guard let ro = r.objectValue else {
        throw badField("runs must be {materialize: {<expression id>: <run id>}, cluster?: <run id>}.", "runs")
      }
      let m = ro["materialize"] ?? .object([:])
      guard let mo = m.objectValue else { throw badField("runs.materialize must map expression ids to run ids.", "runs.materialize") }
      var materialize: [(key: String, run: Int)] = []
      for k in JSMap<Int>.objectKeyOrder(mo.keys) {
        let v = mo[k]!
        let idNum = JSNumber.parse(k)
        guard JSNumber.isSafeInteger(idNum), idNum > 0, let run = posInt(v) else {
          throw badField("runs.materialize must map expression ids to run ids (got \(k): \(CanonicalJSON.string(v))).", "runs.materialize")
        }
        let id = Int(idNum)
        if exprIds.contains(id) { materialize.append((String(id), run)) }
      }
      let clusterV = ro["cluster"] ?? .null
      var cluster: Int?
      if !clusterV.isNull {
        guard let c = posInt(clusterV) else { throw badField("runs.cluster must be a clustering run id.", "runs.cluster") }
        cluster = c
      }
      var out = AsSavedRuns()
      if !materialize.isEmpty { out.materialize = materialize }
      out.cluster = cluster
      runs = (out.materialize == nil && out.cluster == nil) ? nil : out
    }
    var cutoffs: AsSavedCutoffs?
    if let c = body["cutoffs"], !c.isNull {
      guard let co = c.objectValue else { throw badField("cutoffs must be {import_batch?, at?, annotation_rev?}.", "cutoffs") }
      var out = AsSavedCutoffs()
      if let v = co["import_batch"], !v.isNull {
        guard let n = posInt(v) else { throw badField("cutoffs.import_batch must be a positive integer.", "cutoffs.import_batch") }
        out.importBatch = n
      }
      if let v = co["at"], !v.isNull {
        guard let s = v.stringValue, isISOInstant(s) else {
          throw badField("cutoffs.at must be the view's save time (an ISO 8601 UTC timestamp).", "cutoffs.at")
        }
        out.at = s
      }
      if let v = co["annotation_rev"], !v.isNull {
        guard let n = v.safeInteger, n >= 0 else {
          throw badField("cutoffs.annotation_rev must be a non-negative integer.", "cutoffs.annotation_rev")
        }
        out.annotationRev = n
      }
      cutoffs = (out.importBatch == nil && out.at == nil && out.annotationRev == nil) ? nil : out
    }
    return (runs, cutoffs)
  }

  /// `normalizeCompareRequest(body)`.
  public static func normalizeCompare(_ body: JSONValue) throws -> NormalizedCompareRequest {
    guard let o = body.objectValue else {
      throw bad("The comparison request must be a JSON object.", "Send {expr, a, b}.", .null)
    }
    guard let ea = o["expr"]?.arrayValue, (1...2).contains(ea.count),
          ea.allSatisfy({ ($0.safeInteger ?? 0) > 0 }) else {
      throw bad("expr must list one or two expression ids.", "Track the expression first, then compare.", ["field": "expr"])
    }
    let m = o["measures"].flatMap { $0.isNull ? nil : $0 }
    var want: [String] = measures
    if let m {
      guard let arr = m.arrayValue, arr.allSatisfy({ $0.stringValue.map { measures.contains($0) } ?? false }) else {
        throw bad("measures may only name \(measures.joined(separator: ", ")).", "Leave measures out for all of them.",
                  ["field": "measures"])
      }
      want = arr.compactMap(\.stringValue)
    }
    var seed: Int?
    if let s = o["seed"], !s.isNull {
      guard let v = s.safeInteger, v >= 0 else {
        throw bad("seed must be a non-negative integer.", "Leave it out for the default draw.", ["field": "seed"])
      }
      seed = v
    }
    var lane = "collection"
    if let l = o["lane_facet"], !l.isNull {
      guard let s = l.stringValue, laneFacets.contains(s) else {
        throw bad("lane_facet must be one of \(laneFacets.joined(separator: ", ")).", nil, ["field": "lane_facet"])
      }
      lane = s
    }
    var override: String?
    if let v = o["override"], !v.isNull {
      guard v.stringValue == "descriptive" else {
        throw bad("override may only be 'descriptive'.", "It shows each rate in its own unit, with no ratio, test or verdict.",
                  ["field": "override"])
      }
      override = "descriptive"
    }
    var corpus: String?
    if let v = o["corpus"], !v.isNull {
      guard let s = v.stringValue else { throw bad("corpus must be a corpus slug.", nil, ["field": "corpus"]) }
      corpus = s
    }
    var ids: [Int] = []
    for v in ea { let id = v.safeInteger!; if !ids.contains(id) { ids.append(id) } }
    let (runs, cutoffs) = try normalizeAsSaved(o, exprIds: ids)
    return NormalizedCompareRequest(
      expr: ids, a: try normalizeSlice(o["a"], "a"), b: try normalizeSlice(o["b"], "b"),
      measures: measures.filter { want.contains($0) }, toggles: Toggles.normalize(o["toggles"]), seed: seed, laneFacet: lane,
      corpus: corpus, override: override, runs: runs, cutoffs: cutoffs)
  }

  /// Which variant of a scope statement applies (`scopeDocFilter`): live documents, or as saved the documents of
  /// imports ≤ the cutoff including those soft-deleted after the save time. Each variant is its own catalogued text,
  /// worded as the reference builds it, so SQLite plans (and orders rows) as the reference does.
  public enum ScopeFilter: Sendable {
    case live
    case at(String)
    case batch(Int)
    case atBatch(String, Int)

    public init(_ c: AsSavedCutoffs?) {
      switch (c?.at, c?.importBatch) {
      case (let at?, let b?): self = .atBatch(at, b)
      case (let at?, nil): self = .at(at)
      case (nil, let b?): self = .batch(b)
      default: self = .live
      }
    }
  }
}

extension JSMap {
  /// JavaScript object key enumeration order of `keys` (integer-like first, ascending; then insertion order). A decoded
  /// JSON object has no insertion order, so the rest keep code-unit order.
  static func objectKeyOrder(_ keys: [String]) -> [String] {
    let index = keys.filter(isArrayIndexKey).sorted { UInt64($0)! < UInt64($1)! }
    let rest = keys.filter { !isArrayIndexKey($0) }.sorted(by: jsLess)
    return index + rest
  }
}
