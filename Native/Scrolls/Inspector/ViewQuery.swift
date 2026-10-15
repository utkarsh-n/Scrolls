// OWNER: N8
// The timeline request of a view state (`tiles-client.mjs` queryBody): the canonical request the Scroll registers, so
// the drawer, the shelves and the coach marks ask about the query on screen. Registration is deterministic (the same
// canonical request gives the same key), so registering it here and in the Scroll yields one key.

import ScrollsContracts
import ScrollsCore

nonisolated enum ViewQuery {
  /// `queryBody(view, {maxLanes})`: strands, corpus, lanes, the filter with its defaults, toggles, time basis, and the
  /// pinned counting runs of a view opened as saved.
  static func request(_ view: ViewState, maxLanes: Int? = nil) -> TimelineQueryRequest {
    let strands = view.strands.map { s -> StrandRequest in
      switch s.id {
      case .number(let n): StrandRequest(type: s.type, ref: .int(n))
      case .string(let t): StrandRequest(type: s.type, ref: .string(t))
      }
    }
    let lanes = LanesRequest(facet: view.lanes.facet, order: view.lanes.order, max: min(view.lanes.max, maxLanes ?? view.lanes.max),
                             manual: nil, run: view.lanes.run.map { RunID(rawValue: Int64($0)) })
    var body = TimelineQueryRequest(strands: strands, corpus: view.corpus, lanes: lanes,
                                    f: ViewState.formatFilter(view.f, withDefaults: true), toggles: view.toggles,
                                    timeBasis: view.timeBasis)
    if !view.runs.materialize.isEmpty {
      body.runs = PinnedRuns(materialize: Dictionary(uniqueKeysWithValues: view.runs.materialize.map { (String($0.key), $0.value) }))
    }
    return body
  }

  /// The view's filter in the `f` grammar, or nil when it is the default (search and KWIC requests).
  static func filter(_ view: ViewState) -> String? {
    let f = ViewState.formatFilter(view.f)
    return f.isEmpty ? nil : f
  }
}
