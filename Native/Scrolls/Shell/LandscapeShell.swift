// OWNER: N8
// Landscape (IOS-SPEC §4.4, 932 × 430 pt): no overlay sheet. Selecting something opens a 360 pt inspector column at the
// trailing edge (Then/Now/Next tabs, the drawer, shelves, search results); with nothing selected the transport is a
// trailing-bottom glass capsule with search one tap away. Rotation keeps the selection (it lives in the view state).
// The full landscape layout (the 120 pt lane rail collapsing to chips) is M2; this column is its first form.

import ScrollsCore
import SwiftUI

extension ScrollScreenSlots {
  /// The landscape inspector column (N8).
  func landscapeInspector() -> some View { LandscapeShell(model: model) }
}

struct LandscapeShell: View {
  let model: AppModel

  var body: some View {
    let experience = model.experience
    let open = experience.mode != .idle
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      if open {
        VStack(spacing: 0) {
          PeekRow(model: model, available: 88)
          ScrollView {
            column(experience)
              .padding(.horizontal, Tokens.Geometry.gutter)
              .padding(.bottom, 16)
          }
        }
        .frame(width: Tokens.Geometry.landscapeInspector)
        .frame(maxHeight: .infinity)
        .background(Tokens.bg1.color)
        .overlay(alignment: .leading) { Rectangle().fill(Tokens.rule.color).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("landscapeInspector")
      } else {
        PeekRow(model: model, available: 88)
          .frame(width: Tokens.Geometry.landscapeInspector)
          .padding(.vertical, 6)
          .chromeGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
          .padding(.trailing, 12)
          .padding(.bottom, 8)
      }
    }
    .frame(maxHeight: .infinity, alignment: .bottom)
  }

  @ViewBuilder
  private func column(_ experience: ExperienceModel) -> some View {
    switch experience.mode {
    case .idle: EmptyView()
    case .search: SearchResultsView(model: model)
    case .inspector(let ref): ThenColumn(model: model, ref: ref)
    case .drawer(let bin): BinDrawerView(model: model, bin: bin)
    case .shelf(let shelf): ShelfListView(model: model, shelf: shelf)
    case .yourTurn: YourTurnView(model: model)
    }
  }
}
