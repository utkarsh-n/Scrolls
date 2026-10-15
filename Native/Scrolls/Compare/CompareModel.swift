// OWNER: N4
// The state of one Compare destination (IOS-SPEC §4.10; compare.mjs `compareRequest`, `compareAsSaved`, `run`,
// `applySlices`): the request built from the view it was opened from (its expression strands, filters, toggles and, as
// saved, its pins and cutoffs — RF-2), the slices (A always the earlier one), the passage seed, the descriptive
// override, and the payload as it arrives. A gate card's [Apply] widens the slices it names and runs again.

import Foundation
import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import ScrollsStore

/// The pieces of a POST /api/compare body that come from the view (`compareRequest(view)`).
nonisolated struct CompareBasis: Sendable, Equatable {
  var expr: [ExpressionID]
  var globalFilter: String
  var toggles: [String: Int]
  var runs: PinnedRuns?
  var cutoffs: ViewCutoffs?
  /// The saved view a hash names (`#view=<slug>&as=1`): its cutoffs are read through the views API.
  var savedView: SavedViewReference?

  /// The basis of a view-state hash. Expression strands (the first two), the filter grammar of `f`, the toggles; as saved
  /// (`asSaved`), the pinned counting runs of the compared expressions and the clustering run.
  init(viewHash: String) {
    let decoded = ViewState.decodeHash(viewHash)
    let s = decoded.state
    savedView = decoded.view
    expr = s.strands.filter { $0.type == "expression" }.compactMap { strand -> ExpressionID? in
      if case .number(let id) = strand.id { return ExpressionID(id) }
      return nil
    }.prefix(2).map { $0 }
    globalFilter = ViewState.formatFilter(s.f)
    toggles = s.toggles
    if s.asSaved || decoded.view?.asSaved == true {
      var m: [String: Int] = [:]
      for id in expr { if let run = s.runs.materialize[Int(id.rawValue)] { m[String(id.rawValue)] = run } }
      let pins = PinnedRuns(materialize: m.isEmpty ? nil : m, cluster: s.runs.cluster.map { RunID($0) })
      runs = pins.materialize == nil && pins.cluster == nil ? nil : pins
    }
  }

  /// The cutoffs of a saved view response (`{import_batch, at, annotation_rev}`; `at` falls back to its save time).
  static func cutoffs(of v: SavedViewResponse) -> ViewCutoffs? {
    let c = v.cutoffs
    let batch = c?["import_batch"]?.safeInteger.map { ImportBatchID($0) }
    let at = c?["at"]?.stringValue ?? v.savedAt
    let rev = c?["annotation_rev"]?.safeInteger
    return ViewCutoffs(importBatch: batch, at: at, annotationRev: rev)
  }
}

@MainActor @Observable
final class CompareModel {
  enum Phase: Equatable {
    case needsExpression
    case loading
    case loaded(CompareContent)
    case failed(ErrorCardModel)
  }

  private(set) var a: SliceSeed
  private(set) var b: SliceSeed
  private(set) var phase: Phase = .loading
  /// The last good content, kept on screen while a new request runs (panels never blank out).
  private(set) var shown: CompareContent?
  private(set) var label: String?
  private(set) var passageSeed: Int?
  private(set) var descriptive = false
  private(set) var basis: CompareBasis
  /// A run a gate card's suggestion started (`{stage, params}`): its job and progress until it ends.
  private(set) var running: RunState?
  private(set) var runEnd: String?

  struct RunState: Equatable {
    var stage: String
    var job: Int
    var fraction: Double?
  }
  let fixtures: Bool
  @ObservationIgnored private let atlas: (any AtlasService)?
  @ObservationIgnored private var seq = 0
  @ObservationIgnored private var lastKey: String?

  init(seed: CompareSeed, atlas: (any AtlasService)?, fixtures: Bool) {
    a = seed.a
    b = seed.b
    basis = CompareBasis(viewHash: seed.viewHash)
    self.atlas = atlas
    self.fixtures = fixtures
  }

  /// The request body (`compareRequest`), or nil without an expression strand.
  var request: CompareRequest? {
    guard !basis.expr.isEmpty else { return nil }
    func slice(_ s: SliceSeed) -> CompareSlice { CompareSlice(years: [s.fromYear, s.toYear], f: s.filter.isEmpty ? basis.globalFilter : s.filter) }
    return CompareRequest(expr: basis.expr, a: slice(a), b: slice(b), measures: CompareModel.allMeasures, runs: basis.runs,
                          cutoffs: basis.cutoffs, seed: passageSeed, override: descriptive ? "descriptive" : nil,
                          toggles: basis.toggles)
  }

  static let allMeasures = ["freq", "collocates", "clusters", "sense_share_jsd", "neighbor_overlap", "aligned_displacement", "tone"]

  /// Runs the comparison (again when `force`); the newest request wins.
  func run(force: Bool = false) async {
    guard let atlas else {
      phase = .failed(ErrorCardModel(what: CompareCopy.couldNotCompute, message: CompareCopy.noEngine, hint: nil, code: nil))
      return
    }
    if basis.savedView?.asSaved == true, basis.cutoffs == nil, let ref = basis.savedView {
      if let v = try? await atlas.view(ref.slug, asSaved: true) {
        basis.cutoffs = CompareBasis.cutoffs(of: v)
        if basis.runs == nil, let pins = v.runIds {
          var m: [String: Int] = [:]
          for id in basis.expr { if let r = pins["materialize"]?[String(id.rawValue)]?.safeInteger { m[String(id.rawValue)] = r } }
          let cluster = pins["cluster"]?.safeInteger.map { RunID($0) }
          if !m.isEmpty || cluster != nil { basis.runs = PinnedRuns(materialize: m.isEmpty ? nil : m, cluster: cluster) }
        }
      }
    }
    guard let req = request else {
      phase = .needsExpression
      return
    }
    let key = (try? CanonicalJSON.string(ScrollsJSON.value(req))) ?? UUID().uuidString
    if !force, key == lastKey, case .loaded = phase { return }
    lastKey = key
    seq += 1
    let mine = seq
    phase = .loading
    if label == nil { label = await expressionLabel(atlas) }
    do {
      let p = try await atlas.compare(req)
      guard mine == seq else { return }
      let content = CompareContent(p, aYears: req.a.years, bYears: req.b.years, label: label)
      shown = content
      phase = .loaded(content)
    } catch {
      guard mine == seq else { return }
      lastKey = nil
      phase = .failed(ErrorCardModel(any: error, what: CompareCopy.couldNotCompute))
    }
  }

  private func expressionLabel(_ atlas: any AtlasService) async -> String? {
    var names: [String] = []
    for id in basis.expr {
      if let x = try? await atlas.expression(id) { names.append(x.expression.surface) } else { names.append("expression \(id.rawValue)") }
    }
    return names.isEmpty ? nil : names.joined(separator: " + ")
  }

  /// A new draw of the passage sample (`Reshuffle`): the same comparison, so k does not move.
  func reshuffle() async {
    passageSeed = Int.random(in: 0..<(1 << 31))
    await run(force: true)
  }

  /// New slices from a gate card's suggestion or from the strip; A stays the earlier slice. The override is reset.
  func apply(_ edit: SliceEdit) async {
    let na = edit.a ?? a, nb = edit.b ?? b
    let ordered = CompareSeed(na, nb, viewHash: "")
    a = ordered.a
    b = ordered.b
    descriptive = false
    passageSeed = nil
    await run()
  }

  /// "Compare anyway (descriptive only)": each rate in its own unit, with no ratio, test or verdict.
  func compareAnyway() async {
    descriptive = true
    await run(force: true)
  }

  /// Starts the run a gate card suggests (`suggestion.run = {stage, params}`), follows its job, and compares again when it
  /// ends (`startSuggestedRun` + `followJob` of runs.mjs).
  func startSuggestedRun(_ suggestion: JSONValue) async {
    guard let atlas, running == nil, let spec = suggestion["run"]?.objectValue, let stage = spec["stage"]?.stringValue else { return }
    runEnd = nil
    do {
      let started = try await atlas.startRun(StartRunRequest(stage: stage, params: spec["params"] ?? .object([:])))
      running = RunState(stage: stage, job: started.job.id, fraction: started.reused == true ? 1 : 0)
      while let r = running {
        let j = try await atlas.job(JobID(rawValue: Int64(r.job)))
        if ["succeeded", "failed", "cancelled", "interrupted"].contains(j.status) {
          running = nil
          if j.status != "succeeded" {
            runEnd = CompareCopy.runEnded(stage, j.status, j.error?["message"]?.stringValue)
          }
          break
        }
        running?.fraction = j.progress
        try await Task.sleep(for: .milliseconds(500))
      }
      await run(force: true)
    } catch {
      running = nil
      runEnd = ErrorCardModel(any: error, what: CompareCopy.runNotStarted).message
    }
  }

  /// The years of both slices together (the strip's extent).
  var extent: ClosedRange<Int> {
    let lo = min(a.fromYear, b.fromYear), hi = max(a.toYear, b.toYear)
    let pad = max(10, (hi - lo) / 6)
    return (lo - pad)...(hi + pad)
  }
}
