// OWNER: N6
// The notebook (IOS-SPEC §4.13), pushed from the inspector or More: the notes on one target, or every note, newest
// first. Each note shows its kind, its status (active, read differently since, withdrawn), its body, author and date,
// and opens its revisions; Revise adds a revision, Withdraw marks it withdrawn, "Read it differently" writes a new
// note that supersedes it. Nothing is ever overwritten or deleted. Machine notes are labelled and cannot be edited.
// (The layers, dimensions, the revision scrubber and the orphaned interpretations are the M3 notebook.)

import ScrollsContracts
import ScrollsCore
import SwiftUI

extension RootSlots {
  func notebook(_ seed: NotebookSeed) -> some View { NotebookView(app: model, seed: seed) }
}

struct NotebookView: View {
  let app: AppModel
  let seed: NotebookSeed
  @State private var model: NotebookModel?

  var body: some View {
    Group {
      if let model {
        List {
          if model.fixtures { Text(ViewsCopy.fixtures).font(Typography.meta).foregroundStyle(Tokens.syn.color) }
          Toggle(NotebookCopy.filterAll, isOn: Binding(get: { model.includeAll }, set: { v in
            model.includeAll = v
            Task { await model.load() }
          }))
          .font(Typography.cardBody)
          .listRowBackground(Tokens.bg1.color)
          NoteList(model: model)
            .listRowBackground(Tokens.bg1.color)
        }
        .refreshable { await model.load() }
      } else {
        Color.clear
      }
    }
    .scrollContentBackground(.hidden)
    .background(Tokens.bg0.color)
    .navigationTitle(seed.target.map { NotebookCopy.target($0.type, $0.id) } ?? NotebookCopy.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let target = seed.target {
        ToolbarItem(placement: .primaryAction) {
          Button(NotebookCopy.annotate, systemImage: "square.and.pencil") { _ = app.coordinator.show(.annotationEditor(target)) }
            .accessibilityIdentifier("notebookAnnotate")
        }
      }
    }
    .accessibilityIdentifier("notebook")
    .task {
      if model == nil { model = NotebookModel(app: app, target: seed.target) }
      await model?.load()
    }
    .onChange(of: app.coordinator.card) { _, card in
      if card == nil { Task { await model?.load() } }
    }
  }
}

/// The notes of a model, each with its revisions and actions.
struct NoteList: View {
  let model: NotebookModel

  var body: some View {
    switch model.notes {
    case .idle, .loading:
      CountingLabel(NotebookCopy.loading, fraction: nil)
    case .failed(let e):
      ErrorCard(e) { Task { await model.load() } }
    case .loaded(let notes):
      if notes.isEmpty { Text(NotebookCopy.none).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color) }
      ForEach(notes, id: \.id) { n in NoteRow(model: model, note: n) }
    }
  }
}

struct NoteRow: View {
  let model: NotebookModel
  let note: Annotation
  @State private var expanded = false
  @State private var editing: Edit?
  @State private var draft = ""
  @State private var reason = ""

  enum Edit: Identifiable {
    case revise, withdraw, reinterpret
    var id: Self { self }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Text(note.label ?? NotebookCopy.kindLabels[note.kind] ?? note.kind).font(Typography.badge)
          .foregroundStyle(note.isMachine ? Tokens.violet.color : Tokens.cyan.color)
        Text(NotebookCopy.statusWords[note.status] ?? note.status).font(Typography.meta)
          .foregroundStyle(note.status == "active" ? Tokens.ink3.color : Tokens.amber.color)
        if note.synthetic { Text(ViewsCopy.synthetic).font(Typography.badge).foregroundStyle(Tokens.syn.color) }
        Spacer()
      }
      if note.isMachine { Text(NotebookCopy.machine).font(Typography.meta).foregroundStyle(Tokens.violet.color) }
      Text(note.bodyMd).font(Typography.cardBody).foregroundStyle(note.status == "withdrawn" ? Tokens.ink3.color : Tokens.ink.color)
        .strikethrough(note.status == "withdrawn", color: Tokens.ink3.color)
      if let q = note.anchor?.quote, !q.isEmpty {
        Text("\u{201C}\(q)\u{201D}").font(Typography.meta).foregroundStyle(Tokens.ink2.color).lineLimit(3)
      }
      Text([NotebookCopy.by(note.author), DisplayTime.minute(note.revAt ?? note.createdAt),
            NotebookCopy.revisionsCount(note.revisions ?? note.rev)].joined(separator: " · "))
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      if !(note.tags ?? []).isEmpty {
        Text((note.tags ?? []).map { "#\($0)" }.joined(separator: " ")).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      HStack(spacing: 14) {
        Button(NotebookCopy.revisions) {
          expanded.toggle()
          if expanded { Task { await model.loadRevisions(note.id) } }
        }
        if !note.isMachine, note.status == "active" {
          Button(NotebookCopy.revise) { draft = note.bodyMd; reason = ""; editing = .revise }
          Button(NotebookCopy.reinterpret) { draft = ""; editing = .reinterpret }
          Button(NotebookCopy.withdraw, role: .destructive) { reason = ""; editing = .withdraw }
        }
      }
      .font(Typography.chrome)
      .buttonStyle(.borderless)
      .frame(minHeight: Tokens.Geometry.minHit)
      if expanded { revisions }
      if let editing { editor(editing) }
    }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var revisions: some View {
    switch model.revisions[note.id] ?? .idle {
    case .idle, .loading:
      CountingLabel(NotebookCopy.loading, fraction: nil)
    case .failed(let e):
      ErrorCard(e) { Task { await model.loadRevisions(note.id) } }
    case .loaded(let revs):
      ForEach(revs, id: \.rev) { r in
        VStack(alignment: .leading, spacing: 2) {
          Text(NotebookCopy.revisionLine(r.rev, r.at, r.author)).font(Typography.count).foregroundStyle(Tokens.ink3.color)
          Text(r.bodyMd).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          if let why = r.reason { Text(why).font(Typography.meta).italic().foregroundStyle(Tokens.ink3.color) }
        }
        .padding(.leading, 10)
      }
    }
  }

  /// Revise, read differently or withdraw, inline in the row (no second presentation over a card, IOS-SPEC §4.2).
  private func editor(_ edit: Edit) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(edit == .revise ? NotebookCopy.revise : edit == .withdraw ? NotebookCopy.withdrawTitle : NotebookCopy.reinterpret)
        .font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      switch edit {
      case .revise:
        TextField(NotebookCopy.bodyPlaceholder, text: $draft, axis: .vertical).lineLimit(3...12)
        TextField(NotebookCopy.reviseReason, text: $reason)
      case .reinterpret:
        TextField(NotebookCopy.bodyPlaceholder, text: $draft, axis: .vertical).lineLimit(3...12)
      case .withdraw:
        Text(NotebookCopy.withdrawMessage).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        TextField(NotebookCopy.withdrawReason, text: $reason)
      }
      if let e = model.actError { ErrorCard(e) {} }
      HStack(spacing: 18) {
        Button(NotebookCopy.cancel) { editing = nil }
        Button(edit == .withdraw ? NotebookCopy.withdraw : NotebookCopy.save, role: edit == .withdraw ? .destructive : nil) {
          Task {
            let ok: Bool = switch edit {
            case .revise: await model.revise(note, body: draft, reason: reason)
            case .reinterpret: await model.reinterpret(note, kind: note.kind, body: draft)
            case .withdraw: await model.withdraw(note, reason: reason)
            }
            if ok { editing = nil }
          }
        }
        .disabled(model.acting || (edit != .withdraw && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      }
      .font(Typography.chrome)
      .buttonStyle(.borderless)
      .frame(minHeight: Tokens.Geometry.minHit)
    }
    .textFieldStyle(.roundedBorder)
    .padding(10)
    .background(Tokens.bg2.color, in: RoundedRectangle(cornerRadius: 10))
  }
}
