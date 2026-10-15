// OWNER: N8
// The Filters sheet (IOS-SPEC §4.22; SPEC §7 filter grammar, §13 rule 9; port of `shell/filters.mjs`). Default
// exclusions come first, because they change every count, as visible labelled switches: translations, retrospective
// descriptions, editorial apparatus, duplicates, proper-noun guard hits and boilerplate are excluded by default and say
// so; estimated dates are included; synthetic material is shown, always labelled. Then the evidence filter (chips:
// all → documented + computed → documented; the tour's "Evidence chip"), then facet values with their counts from
// `facets`, each cycling include → exclude → off.

import LabKitUI
import ScrollsContracts
import ScrollsCore
import SwiftUI

nonisolated enum FiltersCopy {
  static let title = "Filters"
  static let exclusions = "Default exclusions"
  static let evidence = "Evidence"
  static let facets = "Facet values"
  static let done = "Done"
  static let reset = "Reset filters"
  static let loading = "counting facet values…"
  static let synthetic = "Synthetic material"
  static let syntheticOn = "shown, always labelled SYNTHETIC"
  static let syntheticOff = "hidden"
  static let include = "included"
  static let exclude = "excluded"
  static let evidenceAll = "All"
  static let evidenceDC = "Documented + computed"
  static let evidenceD = "Documented only"
  static let evidenceNote = "Line style is evidence: hiding a status hides its arcs; it never changes any status."

  /// `TOGGLE_ROWS`: label, off words, on words.
  static let toggles: [(key: String, label: String, off: String, on: String)] = [
    ("tr", "Translations", "excluded: a translated text was not written in the original's year (D8)", "included, dated by the original"),
    ("ds", "Retrospective descriptions", "excluded: summaries and glosses describe a work later (D9)", "included"),
    ("ap", "Editorial apparatus", "excluded: prefaces, notes and later editorial text", "included"),
    ("dup", "Duplicates", "excluded: the same text counted once", "included"),
    ("nm", "Proper-noun guard hits", "excluded: names that look like the expression (e.g. a person called Gene)", "included"),
    ("est", "Estimated dates", "excluded", "included, drawn with stripes and ≈"),
    ("bp", "Boilerplate", "excluded: licences and front matter", "included"),
  ]

  /// `FILTER_FACETS` with their labels.
  static let facetOrder = ["community", "kind", "lang", "coll", "culture", "field", "basis"]
  static let facetLabels = ["lang": "Language", "coll": "Collection", "basis": "Date basis", "culture": "country of origin (Wikidata)",
                            "field": "STEMM field", "community": "Community", "kind": "Kind"]
  static func value(_ label: String, count: Int) -> String { "\(label) · \(Format.int(count))" }
}

nonisolated enum FilterRules {
  /// `cycleValue`: include → exclude (`-value`) → off.
  static func cycle(_ values: [String], _ value: String) -> [String] {
    var out = values
    if let i = out.firstIndex(of: value) {
      out[i] = "-\(value)"
    } else if let i = out.firstIndex(of: "-\(value)") {
      out.remove(at: i)
    } else {
      out.append(value)
    }
    return out
  }

  /// The evidence filter as one of three steps (`E`: all → documented + computed → documented).
  static func evidenceStep(_ e: [String: Int]) -> String {
    if e["documented"] == 1, e["computed"] == 0, e["proposed"] == 0 { return "d" }
    if e["documented"] == 1, e["computed"] == 1, e["proposed"] == 0 { return "dc" }
    return "all"
  }

  static func applyEvidence(_ step: String, to e: inout [String: Int]) {
    e["documented"] = 1
    e["computed"] = step == "d" ? 0 : 1
    e["proposed"] = step == "all" ? 1 : 0
  }

  /// Active filters and toggles that differ from their defaults (`activeCount`).
  static func activeCount(_ v: ViewState) -> Int {
    let f = v.f
    var n = f.lang.count + f.kind.count + f.coll.count + f.culture.count + f.field.count + f.community.count + f.basis.count
    if f.syn == 0 { n += 1 }
    for (k, d) in zip(Vocab.toggleDefaults.keys, Vocab.toggleDefaults.values) where v.toggles[k] != d { n += 1 }
    return n
  }
}

struct FiltersSheet: View {
  let model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var facets: LoadState<FacetsResponse> = .idle

  var body: some View {
    let v = model.viewState
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          InstrumentPanel("01", FiltersCopy.exclusions) {
            ForEach(FiltersCopy.toggles, id: \.key) { row in
              let on = v.toggles[row.key] == 1
              GlassToggle(row.label, isOn: Binding(get: { model.viewState.toggles[row.key] == 1 },
                                                   set: { model.viewState.toggles[row.key] = $0 ? 1 : 0 }),
                          icon: on ? "checkmark.circle" : "minus.circle", note: on ? row.on : row.off)
                .accessibilityIdentifier("toggle.\(row.key)")
            }
            GlassToggle(FiltersCopy.synthetic, isOn: Binding(get: { model.viewState.f.syn == 1 }, set: { model.viewState.f.syn = $0 ? 1 : 0 }),
                        icon: "square.dashed", note: v.f.syn == 1 ? FiltersCopy.syntheticOn : FiltersCopy.syntheticOff)
          }
          InstrumentPanel("02", FiltersCopy.evidence, caption: FiltersCopy.evidenceNote) {
            ChoiceChips([ChoiceChips<String>.Item("all", FiltersCopy.evidenceAll), .init("dc", FiltersCopy.evidenceDC), .init("d", FiltersCopy.evidenceD)],
                        selection: Binding(get: { FilterRules.evidenceStep(model.viewState.evidence) },
                                           set: { FilterRules.applyEvidence($0, to: &model.viewState.evidence) }),
                        columns: 3, identifierPrefix: "evidence")
          }
          InstrumentPanel("03", FiltersCopy.facets) { facetList }
          if FilterRules.activeCount(v) > 0 {
            Button(FiltersCopy.reset) {
              let d = ViewState.defaultState(v.corpus)
              model.viewState.f = d.f
              model.viewState.toggles = d.toggles
            }
            .frame(minHeight: Tokens.Geometry.minHit)
          }
        }
        .padding(16)
      }
      .background(Tokens.bg0.color)
      .navigationTitle(FiltersCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(FiltersCopy.done) { dismiss() } } }
      .task { await load() }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("filtersSheet")
  }

  @ViewBuilder
  private var facetList: some View {
    switch facets {
    case .idle, .loading: CountingLabel(FiltersCopy.loading, fraction: nil)
    case .failed(let card): ErrorCard(card) { Task { await load() } }
    case .loaded(let r):
      ForEach(FiltersCopy.facetOrder.filter { r.facets[$0]?.isEmpty == false }, id: \.self) { key in
        VStack(alignment: .leading, spacing: 6) {
          Text(FiltersCopy.facetLabels[key] ?? key).font(Typography.meta.weight(.semibold)).foregroundStyle(Tokens.ink3.color)
          FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(r.facets[key] ?? [], id: \.value) { fv in facetChip(key, fv) }
          }
        }
      }
    }
  }

  private func facetChip(_ key: String, _ fv: FacetValue) -> some View {
    let values = filterValues(key)
    let included = values.contains(fv.value)
    let excluded = values.contains("-\(fv.value)")
    return Button {
      setFilterValues(key, FilterRules.cycle(values, fv.value))
    } label: {
      HStack(spacing: 4) {
        if included { Image(systemName: "checkmark").accessibilityHidden(true) }
        if excluded { Image(systemName: "minus").accessibilityHidden(true) }
        Text(FiltersCopy.value(fv.label, count: fv.count)).strikethrough(excluded)
      }
      .font(Typography.meta)
      .foregroundStyle(included ? Tokens.bg0.color : Tokens.ink.color)
      .padding(.horizontal, 10)
      .frame(minHeight: 32)
      .background(included ? Tokens.cyan.color : Tokens.bg2.color, in: Capsule())
    }
    .buttonStyle(.plain)
    .frame(minHeight: Tokens.Geometry.minHit)
    .accessibilityValue(included ? FiltersCopy.include : excluded ? FiltersCopy.exclude : "")
  }

  private func filterValues(_ key: String) -> [String] {
    let f = model.viewState.f
    switch key {
    case "lang": return f.lang
    case "kind": return f.kind
    case "coll": return f.coll
    case "culture": return f.culture
    case "field": return f.field
    case "community": return f.community
    case "basis": return f.basis
    default: return []
    }
  }

  private func setFilterValues(_ key: String, _ values: [String]) {
    switch key {
    case "lang": model.viewState.f.lang = values
    case "kind": model.viewState.f.kind = values
    case "coll": model.viewState.f.coll = values
    case "culture": model.viewState.f.culture = values
    case "field": model.viewState.f.field = values
    case "community": model.viewState.f.community = values
    case "basis": model.viewState.f.basis = values
    default: break
    }
    model.viewState = model.viewState.canonicalized()
  }

  private func load() async {
    guard let atlas = model.atlas else { return }
    facets = .loading
    do {
      facets = .loaded(try await atlas.facets(FacetsRequest(f: ViewQuery.filter(model.viewState), corpus: model.viewState.corpus)))
    } catch {
      facets = .failed(ErrorCardModel(any: error))
    }
  }
}
