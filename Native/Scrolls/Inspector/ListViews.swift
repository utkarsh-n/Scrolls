// OWNER: N8
// The bin drawer and the shelf lists as views (IOS-SPEC §4.8; `timeline/drawer.mjs`): the denominator line first
// ("1910s · Classroom · 14 occurrences in 38,120 tokens · 367 per million [201–616]"), then a lazy list of KWIC rows by
// date, 50 a page, each opening Then; a sampled bin says how many contexts were sampled. Shelves add a filter box.
// Loading always shows words (never a bare spinner); an engine error is an opaque card with Retry.

import ScrollsContracts
import ScrollsCore
import SwiftUI

struct BinDrawerView: View {
  let model: AppModel
  let bin: BinRef

  var body: some View {
    let list = model.experience.list
    VStack(alignment: .leading, spacing: 10) {
      header(title: ThenCopy.binTitle(KwicWords.laneValue(bin.lane) ?? bin.lane))
      if !list.denominatorLine.isEmpty {
        Text(list.denominatorLine)
          .font(Typography.count)
          .foregroundStyle(list.denominatorSynthetic ? Tokens.syn.color : Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("drawerDenominator")
      }
      if list.total > list.kwicRows.count, list.cursor == nil, !list.kwicRows.isEmpty {
        Text(ThenCopy.contextsSampled(list.kwicRows.count, list.total)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(list.kwicRows.enumerated()), id: \.offset) { _, row in
          KwicRowView(row: row) { r in model.experience.select(InspectedRef(type: "passage", id: Int(r.passage.rawValue)).selection) }
          Divider().overlay(Tokens.rule.color)
        }
      }
      footer(list)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(list.denominatorSynthetic)
    .accessibilityIdentifier("binDrawer")
  }

  private func header(title: String) -> some View {
    HStack {
      Text(title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
      Spacer()
      Button {
        model.experience.closeList()
      } label: {
        Image(systemName: "xmark").foregroundStyle(Tokens.ink2.color)
      }
      .frame(minWidth: Tokens.Geometry.minHit, minHeight: Tokens.Geometry.minHit)
      .accessibilityLabel(ThenCopy.closeList)
    }
  }
}

struct ShelfListView: View {
  let model: AppModel
  let shelf: ShelfRef

  var body: some View {
    let list = model.experience.list
    @Bindable var bindable = list
    let rows = ListRules.filter(list.shelfItems, list.filter) { [$0.title, $0.author, $0.dateLabel, $0.lane] }
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(shelf.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
        Spacer()
        Button {
          model.experience.closeList()
        } label: {
          Image(systemName: "xmark").foregroundStyle(Tokens.ink2.color)
        }
        .frame(minWidth: Tokens.Geometry.minHit, minHeight: Tokens.Geometry.minHit)
        .accessibilityLabel(ThenCopy.closeList)
      }
      Text(ListRules.shelfLine(shelf.which)).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        .fixedSize(horizontal: false, vertical: true)
      TextField(ThenCopy.filterList, text: $bindable.filter)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 10)
        .frame(minHeight: Tokens.Geometry.minHit)
        .background(Tokens.bg0.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
        .accessibilityLabel(ThenCopy.filterList)
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(rows) { item in
          Button {
            if let p = item.passage {
              model.experience.select(InspectedRef(type: "passage", id: Int(p.rawValue)).selection)
            } else if let d = item.document {
              model.experience.select(InspectedRef(type: "document", id: Int(d.rawValue)).selection)
            }
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(item.title).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).lineLimit(2)
                if item.synthetic { EvidenceBadge("SYN") }
              }
              Text([item.author, item.kind, item.dateLabel, KwicWords.laneValue(item.lane), item.n.map { "n = \(Format.int($0))" }]
                .compactMap { $0 }.joined(separator: " · "))
                .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            }
            .frame(maxWidth: .infinity, minHeight: Tokens.Geometry.minHit, alignment: .leading)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(item.passage == nil && item.document == nil)
          Divider().overlay(Tokens.rule.color)
        }
      }
      ListFooter(list: list)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(list.shelfItems.contains { $0.synthetic })
    .accessibilityIdentifier("shelfList")
  }
}

/// "22 of 22", Load 50 more, loading words or the error card.
struct ListFooter: View {
  let list: ListModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch list.state {
      case .failed(let card): ErrorCard(card) { list.retry() }
      case .loading: CountingLabel(ThenCopy.loading, fraction: nil)
      default:
        Text(ListRules.countLine(shown: max(list.kwicRows.count, list.shelfItems.count), total: list.total))
          .font(Typography.count).foregroundStyle(Tokens.ink3.color)
      }
      if list.cursor != nil, !list.state.isLoading {
        Button(ThenCopy.loadMore) { list.loadMore() }.font(Typography.chrome).frame(minHeight: Tokens.Geometry.minHit)
      }
    }
  }
}

extension BinDrawerView {
  fileprivate func footer(_ list: ListModel) -> some View { ListFooter(list: list) }
}
