// OWNER: N6
// The Annotate card (IOS-SPEC §4.13, "Annotate" from any mark): what the note is about (for a passage or occurrence,
// the very words it is anchored to, D18), a kind, the note, tags and an optional layer; then the notes already on the
// target. Saving journals the act (§6.2) and closes the card. A gate or a machine kind is never offered here.

import ScrollsContracts
import ScrollsCore
import SwiftUI

extension RootSlots {
  func annotationEditor(_ target: AnnotationTarget) -> some View { AnnotationEditor(app: model, target: target) }
}

struct AnnotationEditor: View {
  let app: AppModel
  let target: AnnotationTarget
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var model: NotebookModel?
  @State private var kind = "interpretation"
  @State private var text = ""
  @State private var tags = ""
  @State private var layer = ""

  var body: some View {
    NavigationStack {
      Group {
        if let model { form(model) } else { Color.clear }
      }
      .scrollContentBackground(.hidden)
      .background(Tokens.bg0.color)
      .navigationTitle(NotebookCopy.annotate)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(NotebookCopy.cancel) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(NotebookCopy.save) {
            Task {
              guard let model else { return }
              if await model.create(kind: kind, body: text, tags: tags, layer: layer) { dismiss() }
            }
          }
          .disabled(model?.acting != false || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model?.words.isPending == true)
          .accessibilityIdentifier("annotationSave")
        }
      }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("annotationEditor")
    .task {
      if model == nil { model = NotebookModel(app: app, target: target) }
      await model?.loadWords()
      await model?.load()
    }
  }

  @ViewBuilder
  private func form(_ m: NotebookModel) -> some View {
    List {
      Section {
        Text(NotebookCopy.target(target.type, target.id)).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        switch m.words {
        case .idle, .loading:
          CountingLabel(NotebookCopy.loading, fraction: nil)
        case .failed(let e):
          Text(NotebookCopy.noAnchor).font(Typography.meta).foregroundStyle(Tokens.amber.color)
          ErrorCard(e) { Task { await m.loadWords() } }
        case .loaded(let w):
          if let w {
            Text(w.anchor.quote)
              .font(Typography.passage(size: typeSize, lang: w.lang, text: w.anchor.quote))
              .foregroundStyle(Tokens.ink2.color)
              .lineLimit(8)
              .accessibilityLabel(NotebookCopy.quoteHeader + ": " + w.anchor.quote)
          }
        }
      } header: {
        Text(NotebookCopy.quoteHeader)
      }
      .listRowBackground(Tokens.bg1.color)

      Section {
        Picker(NotebookCopy.kind, selection: $kind) {
          ForEach(NotebookCopy.humanKinds, id: \.self) { k in Text(NotebookCopy.kindLabels[k] ?? k).tag(k) }
        }
        if kind == "hypothesis" { Text(NotebookCopy.hypothesisNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
        TextField(NotebookCopy.bodyPlaceholder, text: $text, axis: .vertical)
          .lineLimit(3...12)
          .accessibilityIdentifier("annotationBody")
        TextField(NotebookCopy.tagsPlaceholder, text: $tags)
          .textInputAutocapitalization(.never)
        TextField(NotebookCopy.layerPlaceholder, text: $layer)
        if m.acting { CountingLabel(NotebookCopy.saving, fraction: nil) }
        if let e = m.actError { ErrorCard(e) {} }
      }
      .listRowBackground(Tokens.bg1.color)

      Section(NotebookCopy.notesHeader) {
        NoteList(model: m)
      }
      .listRowBackground(Tokens.bg1.color)
    }
  }
}

extension ViewsLoad {
  var isPending: Bool {
    switch self {
    case .idle, .loading: true
    default: false
    }
  }
}
