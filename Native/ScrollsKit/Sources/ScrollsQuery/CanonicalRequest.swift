// OWNER: N3
// Port of query.mjs `canonicalRequest` (SPEC §7.2 POST /api/timeline/query): a request validated and normalized —
// strands (≤ 4), corpus, lanes (facet, order, max 1–48, manual order, cluster run), the filter grammar, the toggles over
// vocab.TOGGLE_DEFAULTS, the time basis, pinned materialize runs and a saved view's cutoffs (D17). The canonical request
// is what `QueryDef.build` resolves; the def's hash is the queryKey.

import Foundation
import ScrollsContracts
import ScrollsCore

/// A validated timeline request.
public struct CanonicalRequest: Sendable, Equatable {
  /// A pinned strand: expression and work refs are numbers, theme and maker refs strings.
  public struct StrandRef: Sendable, Equatable {
    public var type: String
    public var ref: IntOrString

    public init(type: String, ref: IntOrString) {
      self.type = type
      self.ref = ref
    }
  }

  /// `lanes`: facet, order, max, manual order and (cluster lanes) the clustering run.
  public struct LaneSpec: Sendable, Equatable {
    public var facet: String
    public var order: String
    public var max: Int
    public var manual: [String]
    public var run: Int64?
  }

  /// A saved view's cutoffs (D17): its import batch cutoff and save time.
  public struct Cutoffs: Sendable, Equatable {
    public var importBatch: Int64?
    public var at: String?

    public init(importBatch: Int64?, at: String?) {
      self.importBatch = importBatch
      self.at = at
    }
  }

  public var strands: [StrandRef]
  public var corpus: String
  public var lanes: LaneSpec
  public var f: ViewState.Filters
  /// TOGGLE_DEFAULTS keys, in their order.
  public var toggles: [(key: String, value: Int)]
  public var timeBasis: String
  /// Expression id (as a string key) → pinned materialize run.
  public var runs: [String: Int64]
  public var cutoffs: Cutoffs?

  public static func == (a: CanonicalRequest, b: CanonicalRequest) -> Bool {
    a.strands == b.strands && a.corpus == b.corpus && a.lanes == b.lanes && a.f == b.f
      && a.toggles.map(\.key) == b.toggles.map(\.key) && a.toggles.map(\.value) == b.toggles.map(\.value)
      && a.timeBasis == b.timeBasis && a.runs == b.runs && a.cutoffs == b.cutoffs
  }

  /// The value of toggle `key` (0 or 1).
  public func toggle(_ key: String) -> Int { toggles.first { $0.key == key }?.value ?? 0 }

  static let defaultMaxLanes = 10
  /// `ISO_INSTANT`: a UTC instant as nowIso() writes it.
  static func isISOInstant(_ s: String) -> Bool {
    let u = Array(s.utf8)
    func digits(_ r: Range<Int>) -> Bool { r.allSatisfy { $0 < u.count && u[$0] >= 0x30 && u[$0] <= 0x39 } }
    guard u.count >= 20, digits(0..<4), u[4] == 0x2D, digits(5..<7), u[7] == 0x2D, digits(8..<10), u[10] == 0x54,
      digits(11..<13), u[13] == 0x3A, digits(14..<16), u[16] == 0x3A, digits(17..<19)
    else { return false }
    if u.count == 20 { return u[19] == 0x5A }
    guard u[19] == 0x2E, u.last == 0x5A else { return false }
    let frac = u.count - 21
    return (1...3).contains(frac) && digits(20..<(20 + frac))
  }

  static func bad(_ message: String, field: String? = nil, hint: String? = nil) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, hint: hint, detail: field.map { .object(["field": .string($0)]) } ?? .null)
  }

  /// `canonicalRequest(body)` over the contract request type.
  public static func make(_ body: TimelineQueryRequest) throws -> CanonicalRequest {
    if body.corpus.isEmpty { throw bad("corpus is required.", field: "corpus") }
    if body.strands.isEmpty {
      throw bad("At least one strand is required.", field: "strands", hint: "Pin an expression, a theme, a work or a maker.")
    }
    if body.strands.count > 4 { throw bad("At most 4 strands can be pinned.", field: "strands") }
    var strands: [StrandRef] = []
    for (i, s) in body.strands.enumerated() {
      guard Vocab.strandTypes.contains(s.type) else {
        throw bad("strands[\(i)].type must be one of \(Vocab.strandTypes.joined(separator: ", ")).", field: "strands[\(i)].type")
      }
      let numeric = s.type == "expression" || s.type == "work"
      if numeric {
        let n: Int?
        switch s.ref {
        case .int(let v): n = v
        case .string(let t): n = Int(t).flatMap { String($0) == t ? $0 : nil } ?? JSNumber.parseInteger(t)
        }
        guard let n, n > 0 else { throw bad("strands[\(i)].ref is missing or invalid.", field: "strands[\(i)].ref") }
        strands.append(StrandRef(type: s.type, ref: .int(n)))
      } else {
        let t = s.ref.description
        if t.isEmpty { throw bad("strands[\(i)].ref is missing or invalid.", field: "strands[\(i)].ref") }
        strands.append(StrandRef(type: s.type, ref: .string(t)))
      }
    }
    let facet = body.lanes.facet ?? "domain"
    guard Vocab.laneFacets.contains(facet) else {
      throw bad("lanes.facet must be one of \(Vocab.laneFacets.joined(separator: ", ")).", field: "lanes.facet")
    }
    let order = body.lanes.order ?? "first_observed"
    guard Vocab.laneOrders.contains(order) else {
      throw bad("lanes.order must be one of \(Vocab.laneOrders.joined(separator: ", ")).", field: "lanes.order")
    }
    let max = Swift.max(1, Swift.min(48, body.lanes.max ?? defaultMaxLanes))
    let manual = Array((body.lanes.manual ?? []).prefix(200))
    let run = body.lanes.run.map(\.rawValue)
    if let run, run <= 0 { throw bad("lanes.run must be a clustering run id.", field: "lanes.run") }
    var warnings: [String] = []
    let f = ViewState.parseFilter(body.f ?? "", warnings: &warnings)
    var toggles: [(key: String, value: Int)] = []
    for (k, d) in zip(Vocab.toggleDefaults.keys, Vocab.toggleDefaults.values) {
      let v = body.toggles?[k]
      toggles.append((k, v == 0 || v == 1 ? v! : d))
    }
    let timeBasis = body.timeBasis ?? "publication"
    guard Vocab.timeBases.contains(timeBasis) else {
      throw bad("timeBasis must be one of \(Vocab.timeBases.joined(separator: ", ")).", field: "timeBasis")
    }
    var runs: [String: Int64] = [:]
    for (k, v) in body.runs?.materialize ?? [:] { runs[k] = Int64(v) }
    let cut = body.cutoffs?.importBatch?.rawValue
    if let cut, cut <= 0 { throw bad("cutoffs.import_batch must be a positive integer.", field: "cutoffs") }
    let at = body.cutoffs?.at
    if let at, !isISOInstant(at) {
      throw bad("cutoffs.at must be the view's save time (an ISO 8601 UTC timestamp).", field: "cutoffs.at")
    }
    let cutoffs = cut != nil || at != nil ? Cutoffs(importBatch: cut, at: at) : nil
    return CanonicalRequest(strands: strands, corpus: body.corpus,
                            lanes: LaneSpec(facet: facet, order: order, max: max, manual: manual, run: run), f: f,
                            toggles: toggles, timeBasis: timeBasis, runs: runs, cutoffs: cutoffs)
  }

  /// A request built by the engine itself (search, kwic, defs of saved views).
  public static func simple(corpus: String, strands: [StrandRef], facet: String, f: String = "", order: String? = nil,
                            max: Int? = nil, manual: [String]? = nil, run: Int64? = nil, toggles: [String: Int]? = nil,
                            timeBasis: String? = nil, runs: [String: Int64] = [:], cutoffs: Cutoffs? = nil) throws -> CanonicalRequest {
    let body = TimelineQueryRequest(
      strands: strands.map { StrandRequest(type: $0.type, ref: $0.ref) }, corpus: corpus,
      lanes: LanesRequest(facet: facet, order: order, max: max, manual: manual, run: run.map { RunID(rawValue: $0) }), f: f,
      toggles: toggles, timeBasis: timeBasis,
      runs: runs.isEmpty ? nil : PinnedRuns(materialize: runs.mapValues { Int($0) }),
      cutoffs: cutoffs.map { ViewCutoffs(importBatch: $0.importBatch.map { ImportBatchID(rawValue: $0) }, at: $0.at) })
    return try make(body)
  }
}

extension JSNumber {
  /// `Number(t)` when it is an integer (the reference's `Number(s.ref)` for a numeric strand ref), else nil.
  static func parseInteger(_ t: String) -> Int? {
    let x = JSNumber.parse(t)
    guard x.isFinite, x == x.rounded(), abs(x) < 9_007_199_254_740_992 else { return nil }
    return Int(x)
  }
}
