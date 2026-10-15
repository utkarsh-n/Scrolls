// OWNER: N8
// The Lanes sheet (IOS-SPEC §4.3, §4.7, §4.22; port of `shell/lanes-menu.mjs`). First line, always: "Lane order is a
// sorting choice (first observed), not a scale of meaning." Then the facet as chips (never a menu that hides the
// choice) — context groups only for exactly one pinned expression, the Term trail only in All real — the order rule,
// how many lanes, and every lane of the query on screen with its label · unit · coverage and its notes: "⚠ 34% of
// matches undated", "indexing — not yet looked", the selection note. No y-axis: lanes are categories, not a scale.

import LabKitUI
import ScrollsContracts
import ScrollsCore
import SwiftUI

nonisolated enum LanesCopy {
  static let title = "Lanes"
  static let facet = "Lanes by"
  static let order = "Order"
  static let count = "Lanes shown"
  static let onScreen = "Lanes of this view"
  static let done = "Done"
  static let clusterOff = "Context groups are drawn for exactly one pinned expression."
  static let trailOff = "The Term trail spans every real corpus: switch the corpus to All real."
  static let pending = "indexing — not yet looked"
  static let loading = "counting the lanes…"
  static let noLanes = "No lanes yet: pin a strand to count it."
  static let orderLabels = ["first_observed": "first observed", "total_n": "total n", "alphabetical": "alphabetical", "manual": "manual"]
  static let facetLabels = ["cluster": "Context groups", "trail": "Term trail"]
  static func undatedWarning(_ share: String) -> String { "⚠ \(share) of matches undated" }
  static func lanes(_ n: Int) -> String { "\(n) lanes" }
  static let unitWords = "Each lane keeps its own unit; heights never compare across units."
  /// The shelf buttons of a lane (`shelves.mjs` SHELF titles; ⊘ undated, ⇥ scheduled).
  static func undatedShelf(_ n: Int) -> String { "⊘ \(Format.int(n)) undated" }
  static func scheduledShelf(_ n: Int) -> String { "⇥ \(Format.int(n)) scheduled" }
  static let shelfHint = "Lists them; they never enter bins, rates or denominators."
  static let undatedTitle = "UNDATED"
  static let scheduledTitle = "SCHEDULED"

  static func facetLabel(_ f: String) -> String { facetLabels[f] ?? Copy.laneFacetLabels[f] ?? f }
}

nonisolated enum LaneRules {
  /// Share of undated matches from which a lane warns (§1.7).
  static let undatedWarn = 0.2

  /// `facetOptions`: every facet; 'cluster' only for exactly one pinned expression (C1); 'trail' only in 'real'.
  static func enabled(_ facet: String, view: ViewState) -> Bool {
    if facet == "cluster" { return view.strands.count == 1 && view.strands[0].type == "expression" }
    if facet == "trail" { return view.corpus == "real" }
    return true
  }

  /// The lane's label words (a context group's machine label stays beside a rename).
  static func label(_ l: LaneLabel) -> String {
    switch l {
    case .text(let s): s
    case .group(let machine, let human): human.map { "\($0) (\(machine))" } ?? machine
    }
  }

  /// `laneSubtitle`: unit · coverage, from the engine's header when it has one.
  static func subtitle(_ lane: Lane) -> String {
    let label = self.label(lane.label)
    if let header = lane.header, header.hasPrefix("\(label) · ") { return String(header.dropFirst(label.count + 3)) }
    let cov = lane.coverage.objectValue ?? [:]
    let works = lane.unit.contains("works")
    let amount = (works ? cov["works"] : cov["tokens"])?.numberValue
    var span = ""
    if let s = cov["span"]?.arrayValue, s.count == 2, let a = s[0].numberValue, let b = s[1].numberValue { span = ", \(Int(a))–\(Int(b))" }
    return [lane.modality, "\(Format.tokens(amount)) \(works ? "works" : "tokens")\(span)"].joined(separator: " · ")
  }

  /// `laneNotes`: pending, the selection note, the undated warning.
  static func notes(_ lane: Lane) -> [String] {
    var out: [String] = []
    if lane.state == "pending" { out.append(lane.note ?? LanesCopy.pending) }
    if let s = lane.selection, !(lane.header ?? "").contains(s) { out.append(s) }
    if lane.undatedShare >= undatedWarn { out.append(LanesCopy.undatedWarning(Format.share(lane.undatedShare))) }
    if let w = lane.undatedWarning { out.append(w) }
    return out
  }
}

extension RootSlots {
  func lanes() -> some View { LanesSheet(model: model) }
  func filters() -> some View { FiltersSheet(model: model) }
}

struct LanesSheet: View {
  let model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var lanes: LoadState<[Lane]> = .idle

  var body: some View {
    let view = model.viewState
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(Copy.laneOrderNote)
            .font(Typography.cardBody.weight(.medium))
            .foregroundStyle(Tokens.ink.color)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("laneOrderNote")
          InstrumentPanel("01", LanesCopy.facet) {
            ChoiceChips(Vocab.laneFacets.filter { LaneRules.enabled($0, view: view) }.map { ChoiceChips<String>.Item($0, LanesCopy.facetLabel($0)) },
                        selection: binding(\.lanes.facet), columns: 2, identifierPrefix: "laneFacet") { f in
              f == "cluster" ? Copy.laneFacetLabels["cluster"] ?? "" : ""
            }
            if !LaneRules.enabled("cluster", view: view) { note(LanesCopy.clusterOff) }
            if !LaneRules.enabled("trail", view: view) { note(LanesCopy.trailOff) }
          }
          InstrumentPanel("02", LanesCopy.order) {
            ChoiceChips(Vocab.laneOrders.filter { $0 != "manual" }.map { ChoiceChips<String>.Item($0, LanesCopy.orderLabels[$0] ?? $0) },
                        selection: binding(\.lanes.order), columns: 3, identifierPrefix: "laneOrder") { _ in Copy.laneOrderNote }
          }
          InstrumentPanel("03", LanesCopy.count) {
            Stepper(LanesCopy.lanes(view.lanes.max), value: binding(\.lanes.max), in: 1...Tokens.Geometry.maxLanes)
              .frame(minHeight: Tokens.Geometry.minHit)
          }
          InstrumentPanel("04", LanesCopy.onScreen, caption: LanesCopy.unitWords) { laneList }
        }
        .padding(16)
      }
      .background(Tokens.bg0.color)
      .navigationTitle(LanesCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(LanesCopy.done) { dismiss() } } }
      .task(id: view.hash) { await loadLanes() }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("lanesSheet")
  }

  @ViewBuilder
  private var laneList: some View {
    switch lanes {
    case .idle, .loading: CountingLabel(LanesCopy.loading, fraction: nil)
    case .failed(let card): ErrorCard(card) { Task { await loadLanes() } }
    case .loaded(let list):
      if list.isEmpty { note(LanesCopy.noLanes) }
      ForEach(Array(list.enumerated()), id: \.offset) { _, lane in
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(LaneRules.label(lane.label)).font(Typography.cardBody.weight(.semibold)).foregroundStyle(Tokens.ink.color)
            if lane.synthetic { EvidenceBadge("SYN") }
          }
          Text(LaneRules.subtitle(lane)).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          ForEach(LaneRules.notes(lane), id: \.self) { n in
            Text(n).font(Typography.meta).foregroundStyle(n.hasPrefix("⚠") ? Tokens.amber.color : Tokens.ink3.color)
          }
          if lane.undated > 0 || lane.scheduled > 0 {
            HStack(spacing: 8) {
              if lane.undated > 0 { shelfButton("undated", lane) }
              if lane.scheduled > 0 { shelfButton("scheduled", lane) }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
      }
    }
  }

  /// A lane's shelf (⊘ undated, ⇥ scheduled): the sheet closes and the list opens in the inspector (§4.8 Shelves).
  private func shelfButton(_ which: String, _ lane: Lane) -> some View {
    let label = LaneRules.label(lane.label)
    let undated = which == "undated"
    return Button {
      let ref = ShelfRef(which: which, lane: lane.key, strand: nil,
                         title: "\(undated ? LanesCopy.undatedTitle : LanesCopy.scheduledTitle) · \(label)")
      dismiss()
      model.experience.openShelf(ref)
    } label: {
      Text(undated ? LanesCopy.undatedShelf(lane.undated) : LanesCopy.scheduledShelf(lane.scheduled))
        .font(Typography.chromeCount)
        .foregroundStyle(Tokens.ink.color)
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
        .background(Tokens.bg2.color, in: Capsule())
    }
    .buttonStyle(.plain)
    .frame(minHeight: Tokens.Geometry.minHit)
    .accessibilityHint(LanesCopy.shelfHint)
    .accessibilityIdentifier("shelf.\(which).\(lane.key)")
  }

  private func note(_ s: String) -> some View {
    Text(s).font(Typography.meta).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
  }

  private func binding<T>(_ path: WritableKeyPath<ViewState, T>) -> Binding<T> {
    Binding(get: { model.viewState[keyPath: path] }, set: { model.viewState[keyPath: path] = $0 })
  }

  private func loadLanes() async {
    guard let atlas = model.atlas else { return }
    if lanes.value == nil { lanes = .loading }
    do {
      let q = try await atlas.timelineQuery(ViewQuery.request(model.viewState))
      lanes = .loaded(q.lanes)
    } catch {
      lanes = .failed(ErrorCardModel(any: error))
    }
  }
}
