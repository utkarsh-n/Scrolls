// OWNER: N8
// The inspector's content inside N0's overlay (IOS-SPEC §4.8): the peek row (search, transport, and the Scroll's tap
// sentence), then — at half and large — what the SheetMode says: the start card, search results, Then / Now / Next,
// the reader, the bin drawer, a shelf list, or Your turn. Content panels are opaque; the sheet's glass is N0's.

import ScrollsContracts
import ScrollsCore
import SwiftUI

extension ScrollScreenSlots {
  /// The inspector's content (N8).
  func inspector() -> some View { InspectorContent(model: model) }
}

struct InspectorContent: View {
  let model: AppModel
  @State private var available: CGFloat = 76
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let experience = model.experience
    VStack(spacing: 0) {
      PeekRow(model: model, available: peekHeight)
      if let sentence = experience.bridge.peekSentence, model.coordinator.inspectorDetent != .peek || experience.mode == .idle {
        Text(sentence)
          .font(Typography.meta)
          .foregroundStyle(Tokens.ink2.color)
          .lineLimit(model.coordinator.inspectorDetent == .peek ? 1 : nil)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, Tokens.Geometry.gutter)
          .padding(.bottom, 4)
          .accessibilityIdentifier("peekSentence")
      }
      ScrollView {
        modeContent(experience)
          .padding(.horizontal, Tokens.Geometry.gutter)
          .padding(.top, 8)
          .padding(.bottom, 24)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)
      .opacity(model.coordinator.inspectorDetent == .peek ? 0 : 1)
      .accessibilityHidden(model.coordinator.inspectorDetent == .peek)
    }
    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { available = $0 }
    .accessibilityElement(children: .contain)
    .accessibilityAction(.escape) {
      // Escape (two-finger Z): clear the selection, or lower the sheet (§4.19).
      if model.viewState.selection != nil { experience.clearSelection() } else { model.coordinator.inspectorDetent = .peek }
    }
    .accessibilityAction(.magicTap) { experience.transport.togglePlay() }
  }

  /// The peek rows share what the sheet gives its content at peek (N0's peek detent less its handle).
  private var peekHeight: CGFloat {
    model.coordinator.inspectorDetent == .peek ? max(72, available) : (typeSize.isAccessibilitySize ? 104 : 88)
  }

  @ViewBuilder
  private func modeContent(_ experience: ExperienceModel) -> some View {
    switch experience.mode {
    case .idle:
      StartCard(model: model)
    case .search:
      SearchResultsView(model: model)
    case .inspector(let ref):
      if experience.readerOpen, let target = readerTarget(experience) {
        ReaderView(model: model, reader: ReaderModel(target: target)) {
          experience.readerOpen = false
        }
        .frame(minHeight: 520)
        .id(target.document)
      } else {
        ThenColumn(model: model, ref: ref)
      }
    case .drawer(let bin):
      BinDrawerView(model: model, bin: bin)
    case .shelf(let shelf):
      ShelfListView(model: model, shelf: shelf)
    case .yourTurn:
      YourTurnView(model: model)
    }
  }

  private func readerTarget(_ experience: ExperienceModel) -> ReaderTarget? {
    guard let p = experience.then.passage.value else { return nil }
    return ReaderTarget(document: p.document.id, passageStart: p.start, passageEnd: p.end, highlights: p.highlights, lang: p.lang,
                        title: p.document.title ?? "", synthetic: p.synthetic)
  }
}

/// The start card (`tour.mjs` renderStartCard): a welcome, not an error, while nothing is pinned; otherwise what the
/// sheet holds when nothing is selected.
struct StartCard: View {
  let model: AppModel

  var body: some View {
    let real = model.viewState.corpus != "demo"
    VStack(alignment: .leading, spacing: 8) {
      if model.viewState.strands.isEmpty {
        Text(real ? ThenCopy.startTitleReal : ThenCopy.startTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Text(SearchCopy.placeholder).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
        Text(ThenCopy.startHint).font(Typography.meta).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
      } else {
        Text(StartCopy.selectHint).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
      }
      Text(ThenCopy.footer).font(Typography.meta).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .accessibilityIdentifier("startCard")
  }
}

nonisolated enum StartCopy {
  static let selectHint = "Tap a bar, a gap or a mark on the Scroll: its passage, its counts or its sentence opens here."
}
