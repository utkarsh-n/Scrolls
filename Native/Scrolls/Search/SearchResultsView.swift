// OWNER: N8
// The search results in the inspector at large (IOS-SPEC §4.9): typed suggestion groups — Expressions (with Track as
// strand, count and unit), Works (→ Genealogy), Makers, Themes, Etymology, Annotations — each row with its type word
// (EXPR, WORK, …: a word, never colour alone) and count; romanised Indic matches as their own Expression rows; the
// hits line; the computed empty note; variants tried; three passages. While counting, words and a number, never a
// spinner.

import ScrollsContracts
import ScrollsCore
import SwiftUI

struct SearchResultsView: View {
  let model: AppModel

  var body: some View {
    let search = model.experience.search
    VStack(alignment: .leading, spacing: 14) {
      switch search.result {
      case .idle:
        EmptyView()
      case .loading:
        CountingLabel(SearchCopy.searching, fraction: nil)
      case .failed(let card):
        ErrorCard(card) { search.runNow() }
      case .loaded(let r):
        loaded(r, search)
      }
    }
    .accessibilityIdentifier("searchResults")
  }

  @ViewBuilder
  private func loaded(_ r: SearchResponse, _ search: SearchModel) -> some View {
    if let note = r.emptyNote {
      Text(note)
        .font(Typography.cardBody)
        .foregroundStyle(Tokens.ink.color)
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opaquePanel()
        .accessibilityIdentifier("searchEmptyNote")
    }
    ForEach(search.groups, id: \.group) { g in
      group(g.group, g.items, search)
    }
    if !search.romanised.isEmpty { romanised(search) }
    if search.groups.isEmpty, search.romanised.isEmpty, r.emptyNote == nil {
      Text(SearchCopy.noSuggestions).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
    }
    Text(SearchCopy.hitsLine(SearchHitsWords(passages: r.hits.passages, documents: r.hits.documents, undated: r.hits.undated,
                                             namesExcluded: r.hits.namesExcluded, preliminary: r.hits.preliminary)))
      .font(Typography.count)
      .foregroundStyle(Tokens.ink2.color)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("searchHits")
    let tried = r.query.variants.filter { $0.type != "transliteration" }
    if !tried.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text(SearchCopy.variantsTried).font(Typography.meta.weight(.semibold)).foregroundStyle(Tokens.ink3.color)
        Text(tried.map { SearchCopy.variant($0.form, type: $0.type, status: $0.status) }.joined(separator: ", "))
          .font(Typography.meta).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
      }
    }
    if !r.kwic.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        Text(SearchCopy.examples).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        ForEach(Array(r.kwic.prefix(3).enumerated()), id: \.offset) { _, row in
          KwicRowView(row: row) { search.open($0) }
          Divider().overlay(Tokens.rule.color)
        }
      }
      .padding(14)
      .opaquePanel()
      .syntheticFrame(r.provenance.synthetic)
    }
  }

  private func group(_ group: SuggestionGroup, _ items: [SearchSuggestion], _ search: SearchModel) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(group.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
        .padding(.bottom, 4)
      ForEach(Array(items.enumerated()), id: \.offset) { _, s in
        SuggestionRow(suggestion: s, corpus: TopBarCopy.name(model.viewState.corpus), working: search.working != nil) {
          Task { await search.choose(s) }
        }
        Divider().overlay(Tokens.rule.color)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .accessibilityIdentifier("searchGroup.\(group.rawValue)")
  }

  private func romanised(_ search: SearchModel) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(SearchCopy.romanisedTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
      Text(SearchCopy.romanisedNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color).padding(.bottom, 4)
      ForEach(search.romanised) { m in
        Button {
          Task { await search.track(m) }
        } label: {
          HStack(spacing: 8) {
            Text(verbatim: "EXPR").font(Typography.badge).foregroundStyle(Tokens.ink2.color)
            Text(m.line).font(Typography.passage(size: .large, lang: m.lang, text: m.form)).foregroundStyle(Tokens.ink.color)
            Spacer()
            if m.counting { Text(SearchCopy.counting).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
            Text(SearchCopy.track).font(Typography.chrome).foregroundStyle(Tokens.cyan.color)
          }
          .frame(minHeight: Tokens.Geometry.minHit)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(SearchCopy.romanisedNote)
        .accessibilityIdentifier("romanised.\(m.form)")
        Divider().overlay(Tokens.rule.color)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
  }
}

/// One typed suggestion: its type word, its label, its count (or why there is none), and its action word.
struct SuggestionRow: View {
  let suggestion: SearchSuggestion
  /// The corpus searched, by name (an expression's count is in it).
  let corpus: String
  let working: Bool
  let action: () -> Void

  var body: some View {
    let s = suggestion
    let act = SuggestionAction.of(s)
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(verbatim: SearchCopy.typeBadge[s.type] ?? s.type.uppercased())
          .font(Typography.badge)
          .foregroundStyle(Tokens.ink2.color)
          .frame(minWidth: 44, alignment: .leading)
        VStack(alignment: .leading, spacing: 2) {
          Text(s.label).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).fixedSize(horizontal: false, vertical: true)
          if s.typeahead == true { Text(SearchCopy.typeahead).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
          if s.preliminary == true { Text(SearchCopy.preliminary).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
        }
        Spacer(minLength: 4)
        if let n = s.count {
          Text(SearchCopy.countWords(type: s.type, count: n, corpus: corpus))
            .font(Typography.count).foregroundStyle(Tokens.ink2.color).multilineTextAlignment(.trailing)
        }
        switch act {
        case .pin, .track: Text(SearchCopy.track).font(Typography.chrome).foregroundStyle(Tokens.cyan.color)
        case .genealogy: Text(SearchCopy.genealogy).font(Typography.chrome).foregroundStyle(Tokens.cyan.color)
        default: EmptyView()
        }
      }
      .frame(minHeight: Tokens.Geometry.minHit)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(act == .info || working)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("suggestion.\(s.ref)")
  }
}
