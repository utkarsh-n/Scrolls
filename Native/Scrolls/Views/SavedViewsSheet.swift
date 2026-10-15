// OWNER: N6
// The saved-views sheet (IOS-SPEC §4.15): More → Save view and More → Saved views both open it. The top section saves
// the view on screen (a name, an optional line); the list shows every saved view, newest first, with a schematic
// thumbnail of what it holds (its corpus, strands, Compare slices and vantage) and its pins. Tapping a row opens it as
// saved; a swipe opens it with current data, shares its link or deletes it (soft, after a confirmation).

import ScrollsContracts
import ScrollsCore
import SwiftUI

extension RootSlots {
  func savedViews() -> some View { SavedViewsSheet(app: model) }
}

struct SavedViewsSheet: View {
  let app: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var model: SavedViewsModel?
  @State private var pendingDelete: ViewSummary?
  @FocusState private var nameFocused: Bool

  var body: some View {
    NavigationStack {
      Group {
        if let model { content(model) } else { Color.clear }
      }
      .scrollContentBackground(.hidden)
      .background(Tokens.bg0.color)
      .navigationTitle(ViewsCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(ViewsCopy.done) { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("savedViewsSheet")
    .task {
      if model == nil { model = SavedViewsModel(app: app) }
      await model?.load()
    }
  }

  @ViewBuilder
  private func content(_ m: SavedViewsModel) -> some View {
    @Bindable var m = m
    List {
      Section {
        if m.fixtures { Text(ViewsCopy.fixtures).font(Typography.meta).foregroundStyle(Tokens.syn.color) }
        TextField(ViewsCopy.namePlaceholder, text: $m.name)
          .focused($nameFocused)
          .submitLabel(.done)
          .onSubmit { Task { await m.save() } }
          .accessibilityIdentifier("saveViewName")
        TextField(ViewsCopy.descriptionPlaceholder, text: $m.note, axis: .vertical)
          .lineLimit(1...3)
        Button {
          Task { await m.save() }
        } label: {
          if m.saving { CountingLabel(ViewsCopy.saving, fraction: nil) } else { Text(ViewsCopy.save).font(Typography.chrome) }
        }
        .disabled(m.saving || m.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .frame(minHeight: Tokens.Geometry.minHit)
        .accessibilityIdentifier("saveViewButton")
        if let e = m.saveError { ErrorCard(e) { Task { await m.save() } } }
        if let s = m.lastSaved {
          VStack(alignment: .leading, spacing: 4) {
            Text(ViewsCopy.savedLine(s.slug)).font(Typography.cardBody).foregroundStyle(Tokens.ok.color)
              .accessibilityIdentifier("savedViewSlug")
            if let p = s.parentSlug { Text(ViewsCopy.fromParent(p)).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
            if let warnings = s.warnings?.arrayValue, !warnings.isEmpty {
              ForEach(Array(warnings.enumerated()), id: \.offset) { _, w in
                Text(w.stringValue ?? "").font(Typography.meta).foregroundStyle(Tokens.amber.color)
              }
            }
          }
        }
      } header: {
        Text(ViewsCopy.saveSection)
      } footer: {
        Text(ViewsCopy.immutableNote + " " + ViewsCopy.resaveNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
      .listRowBackground(Tokens.bg1.color)

      Section(ViewsCopy.savedSection) {
        switch m.list {
        case .idle, .loading:
          CountingLabel(ViewsCopy.loading, fraction: nil)
        case .failed(let e):
          ErrorCard(e) { Task { await m.load() } }
        case .loaded(let items):
          if items.isEmpty {
            Text(m.query.isEmpty ? ViewsCopy.none : ViewsCopy.noMatches).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
          }
          ForEach(items, id: \.slug) { v in row(m, v) }
        }
      }
      .listRowBackground(Tokens.bg1.color)
    }
    .searchable(text: $m.query, prompt: ViewsCopy.searchPrompt)
    .onChange(of: m.query) { Task { await m.load() } }
    .confirmationDialog(ViewsCopy.deleteTitle, isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                        titleVisibility: .visible, presenting: pendingDelete) { v in
      Button(ViewsCopy.delete, role: .destructive) { Task { await m.delete(v) } }
      Button(ViewsCopy.cancel, role: .cancel) {}
    } message: { _ in
      Text(ViewsCopy.deleteMessage)
    }
  }

  private func row(_ m: SavedViewsModel, _ v: ViewSummary) -> some View {
    Button {
      Task { await m.open(v, asSaved: true) }
    } label: {
      HStack(alignment: .top, spacing: 12) {
        ViewThumbnail(preview: m.previews[v.slug], synthetic: v.synthetic == true)
          .frame(width: 72, height: 48)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(v.name).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).lineLimit(2)
            if v.synthetic == true {
              Text(ViewsCopy.synthetic).font(Typography.badge).foregroundStyle(Tokens.syn.color)
                .padding(.horizontal, 4).background(Tokens.syn.color.opacity(0.16), in: Capsule())
            }
          }
          if let d = v.description, !d.isEmpty {
            Text(d).font(Typography.meta).foregroundStyle(Tokens.ink2.color).lineLimit(2)
          }
          Text([ViewsCopy.savedAt(v.savedAt), v.corpus, v.parentSlug.map(ViewsCopy.fromParent)].compactMap { $0 }.joined(separator: " · "))
            .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          if let p = m.previews[v.slug] {
            Text(ViewsCopy.pinned(p.importCutoff, p.pinnedRuns)).font(Typography.count).foregroundStyle(Tokens.ink3.color)
          }
        }
        Spacer(minLength: 0)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .frame(minHeight: Tokens.Geometry.minHit)
    .accessibilityElement(children: .combine)
    .accessibilityHint(ViewsCopy.open)
    .accessibilityIdentifier("savedView-\(v.slug)")
    .task { await m.preview(v.slug) }
    .swipeActions(edge: .trailing) {
      Button(ViewsCopy.delete, role: .destructive) { pendingDelete = v }
      if let link = SavedViewsModel.link(v.slug) {
        ShareLink(item: link) { Label(ViewsCopy.share, systemImage: "link") }
      }
    }
    .swipeActions(edge: .leading) {
      Button(ViewsCopy.openCurrent) { Task { await m.open(v, asSaved: false) } }.tint(Tokens.cyan.color)
    }
    .contextMenu {
      Button(ViewsCopy.open, systemImage: "clock.arrow.circlepath") { Task { await m.open(v, asSaved: true) } }
      Button(ViewsCopy.openCurrent, systemImage: "arrow.clockwise") { Task { await m.open(v, asSaved: false) } }
      if let link = SavedViewsModel.link(v.slug) {
        ShareLink(item: link) { Label(ViewsCopy.share, systemImage: "link") }
      }
      Button(ViewsCopy.delete, systemImage: "trash", role: .destructive) { pendingDelete = v }
    }
  }
}
