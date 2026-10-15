// OWNER: N6
// The notebook's model (IOS-SPEC §4.13; SPEC §2.F, D18): the notes on one target (or all of them), their revisions,
// and the four acts — annotate, revise, read differently, withdraw. Each act goes through AtlasService, which journals
// it before the atlas transaction (§6.2). A passage or occurrence note is anchored to its words (D18): the anchor
// carries the document, the sha256 of its text, the offsets and the quote, so the note finds its words again after a
// re-segmentation or in another atlas generation.

import LabKitFeedback
import Observation
import ScrollsContracts
import ScrollsCore
import SwiftUI

/// The words a note on a passage or an occurrence is anchored to.
nonisolated struct AnchoredWords: Sendable, Equatable {
  var anchor: ScrollsContracts.Anchor
  var lang: String?
}

@MainActor @Observable
final class NotebookModel {
  private let app: AppModel
  let target: AnnotationTarget?
  var notes: ViewsLoad<[Annotation]> = .idle
  var includeAll = false
  var revisions: [AnnotationID: ViewsLoad<[AnnotationRevision]>] = [:]
  var words: ViewsLoad<AnchoredWords?> = .idle
  var acting = false
  var actError: ErrorCardModel?

  init(app: AppModel, target: AnnotationTarget?) {
    self.app = app
    self.target = target
  }

  var fixtures: Bool { app.engine.kind == .fixtures }

  func load() async {
    guard let atlas = app.atlas else { return }
    if notes.value == nil { notes = .loading }
    var r = AnnotationsRequest()
    if let target { r.target = "\(target.type):\(target.id)" }
    r.include = includeAll ? "all" : nil
    r.limit = 200
    do {
      notes = .loaded(try await atlas.annotations(r).items)
    } catch {
      notes = .failed(ErrorCardModel(any: error))
    }
  }

  func loadRevisions(_ id: AnnotationID) async {
    guard let atlas = app.atlas else { return }
    revisions[id] = .loading
    do {
      revisions[id] = .loaded(try await atlas.annotationRevisions(id))
    } catch {
      revisions[id] = .failed(ErrorCardModel(any: error))
    }
  }

  /// The words a passage or occurrence note is anchored to: the passage's own anchor and text (the whole passage), or
  /// the occurrence's span inside it. Other targets need no anchor.
  func loadWords() async {
    guard let atlas = app.atlas, let target, target.type == "passage" || target.type == "occurrence" else {
      words = .loaded(nil)
      return
    }
    words = .loading
    do {
      if target.type == "passage" {
        let p = try await atlas.passage(PassageID(rawValue: target.id), context: false)
        words = .loaded(AnchoredWords(anchor: ScrollsContracts.Anchor(docId: p.anchor.docId, sha256: p.anchor.sha256, field: p.anchor.field,
                                                     start: p.anchor.start, end: p.anchor.end, quote: p.text), lang: p.lang))
      } else {
        let o = try await atlas.occurrence(OccurrenceID(rawValue: target.id))
        let p = try await atlas.passage(o.passage, context: false)
        let units = Array(p.text.utf16)
        let lo = o.start - p.anchor.start, hi = o.end - p.anchor.start
        guard lo >= 0, hi <= units.count, lo < hi else { words = .loaded(nil); return }
        let quote = String(decoding: units[lo..<hi], as: UTF16.self)
        words = .loaded(AnchoredWords(anchor: ScrollsContracts.Anchor(docId: p.anchor.docId, sha256: p.anchor.sha256, field: p.anchor.field,
                                                     start: o.start, end: o.end, quote: quote), lang: p.lang))
      }
    } catch {
      words = .failed(ErrorCardModel(any: error))
    }
  }

  /// A new note on the target. Returns true when it was saved.
  func create(kind: String, body: String, tags: String, layer: String) async -> Bool {
    guard let atlas = app.atlas, let target else { return false }
    let request = AnnotationCreateRequest(
      target: AnnotationTargetRef(type: target.type, ref: String(target.id)), anchor: words.value??.anchor, kind: kind,
      bodyMd: body, dimensions: [:], tags: Self.tags(tags), layer: layer.trimmingCharacters(in: .whitespaces).isEmpty ? nil : layer)
    return await act { _ = try await atlas.createAnnotation(request) }
  }

  func revise(_ note: Annotation, body: String, reason: String) async -> Bool {
    guard let atlas = app.atlas else { return false }
    let r = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    return await act {
      _ = try await atlas.reviseAnnotation(note.id, AnnotationPatchRequest(bodyMd: body, reason: r.isEmpty ? nil : r))
      self.revisions[note.id] = nil
    }
  }

  func withdraw(_ note: Annotation, reason: String) async -> Bool {
    guard let atlas = app.atlas else { return false }
    let r = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    return await act { _ = try await atlas.withdraw(note.id, WithdrawRequest(reason: r.isEmpty ? nil : r)) }
  }

  func reinterpret(_ note: Annotation, kind: String, body: String) async -> Bool {
    guard let atlas = app.atlas else { return false }
    let request = AnnotationCreateRequest(target: note.target, anchor: note.anchor, kind: kind, bodyMd: body, dimensions: [:],
                                          tags: note.tags, layer: note.layer)
    return await act { _ = try await atlas.reinterpret(note.id, request) }
  }

  private func act(_ body: () async throws -> Void) async -> Bool {
    acting = true
    defer { acting = false }
    do {
      try await body()
      actError = nil
      app.hapticEngine.success()
      await load()
      return true
    } catch {
      actError = ErrorCardModel(any: error)
      return false
    }
  }

  static func tags(_ s: String) -> [String] {
    s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  }
}
