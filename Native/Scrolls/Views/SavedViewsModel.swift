// OWNER: N6
// The saved-views model (IOS-SPEC §4.15, §6.4; SPEC D17): save the view on screen, list the saved views, open one as
// saved (its pinned cutoffs and runs, resolved by the engine's ViewCutoffResolver in this generation) or with current
// data, and delete one (soft: its link stops opening, the row and the journal keep it). Every write goes through
// AtlasService, which journals it before the atlas transaction (§6.2), so a saved view survives a force quit.

import LabKitFeedback
import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

/// Loading state of one list or card.
nonisolated enum ViewsLoad<Value: Sendable & Equatable>: Sendable, Equatable {
  case idle
  case loading
  case loaded(Value)
  case failed(ErrorCardModel)

  var value: Value? { if case .loaded(let v) = self { v } else { nil } }
}

/// What a row's thumbnail and pin line show, read from the saved view itself.
nonisolated struct ViewPreview: Sendable, Equatable {
  var corpus: String
  var strands: Int
  var compare: [[Int]]
  var range: [Int]?
  var vantageYear: Int?
  var selection: String?
  var importCutoff: Int
  var pinnedRuns: Int
  var documentsAsSaved: Int?

  init(_ v: SavedViewResponse) {
    let s = v.state
    corpus = s["corpus"]?.stringValue ?? "demo"
    strands = s["strands"]?.arrayValue?.count ?? 0
    var cmp: [[Int]] = []
    for side in ["a", "b"] {
      if let ys = s["compare"]?[side]?["years"]?.arrayValue?.compactMap(\.safeInteger), ys.count == 2 { cmp.append(ys) }
    }
    compare = cmp
    range = s["range"]?.arrayValue?.compactMap(\.safeInteger)
    vantageYear = s["vantage"]?["day"]?.safeInteger.map { DayMath.ymdFromDay($0).y }
    selection = s["selection"]?["type"]?.stringValue
    importCutoff = v.cutoffs?["import_batch"]?.safeInteger ?? 0
    var runs = 0
    for (k, x) in v.runIds?.objectValue ?? [:] {
      if k == "materialize" { runs += x.objectValue?.count ?? 0 } else if !x.isNull { runs += 1 }
    }
    pinnedRuns = runs
    documentsAsSaved = v.counts?["asSaved"]?["documents"]?.safeInteger
  }
}

@MainActor @Observable
final class SavedViewsModel {
  private let app: AppModel
  var list: ViewsLoad<[ViewSummary]> = .idle
  var previews: [String: ViewPreview] = [:]
  var query = ""
  var name = ""
  var note = ""
  var saving = false
  var saveError: ErrorCardModel?
  var lastSaved: ViewSavedResponse?

  init(app: AppModel) { self.app = app }

  var fixtures: Bool { app.engine.kind == .fixtures }

  func load() async {
    guard let atlas = app.atlas else { return }
    if list.value == nil { list = .loading }
    do {
      let q = query.trimmingCharacters(in: .whitespaces)
      list = .loaded(try await atlas.views(ViewsRequest(q: q.isEmpty ? nil : q, limit: 200)).items)
    } catch {
      list = .failed(ErrorCardModel(any: error))
    }
  }

  /// The thumbnail data of one row (its saved state and pins), read once.
  func preview(_ slug: String) async {
    guard previews[slug] == nil, let atlas = app.atlas else { return }
    if let v = try? await atlas.view(slug, asSaved: true) { previews[slug] = ViewPreview(v) }
  }

  /// Saves the view on screen. Saving again never edits a view: the engine makes `slug~n` beside it.
  func save() async {
    guard let atlas = app.atlas else { return }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      saveError = ErrorCardModel(any: ScrollsError(code: .validation, message: ViewsCopy.needsName, status: 400))
      return
    }
    saving = true
    defer { saving = false }
    var state = app.viewState
    state.asSaved = false
    let description = note.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      let saved = try await atlas.saveView(SaveViewRequest(name: trimmed, state: state.jsonValue,
                                                           description: description.isEmpty ? nil : description))
      lastSaved = saved
      saveError = nil
      name = ""
      note = ""
      app.hapticEngine.success()  // the haptic map's `success` (a view saved)
      await load()
    } catch {
      saveError = ErrorCardModel(any: error)
    }
  }

  /// Opens a view (as saved, or with current data) and says so over the Scroll.
  func open(_ v: ViewSummary, asSaved: Bool) async {
    app.coordinator.dismissAll()
    await DeepLinks.openSavedView(v.slug, asSaved: asSaved, model: app)
    guard app.viewState.asSaved == asSaved else { return }
    var lines = [asSaved ? ViewsCopy.asSavedBanner(name: v.name, savedAt: v.savedAt) : ViewsCopy.currentBanner]
    if asSaved, let live = app.atlas as? LiveAtlas, let p = try? await live.viewProvenance(v.slug) {
      if let banner = p.banner { lines.append(banner) }
      if !p.restoring.isEmpty { lines.append(ViewsCopy.restoring(p.restoring)) }
    }
    if asSaved, let full = try? await app.atlas?.view(v.slug, asSaved: true), let drift = full.drift.message {
      lines.append(drift)
    }
    app.banner = lines.joined(separator: " ")
  }

  func delete(_ v: ViewSummary) async {
    guard let atlas = app.atlas else { return }
    do {
      _ = try await atlas.deleteView(v.slug)
      previews[v.slug] = nil
      await load()
    } catch {
      list = .failed(ErrorCardModel(any: error))
    }
  }

  /// `scrolls://view/<slug>?as=1`: opens the view as saved on any phone that holds it.
  static func link(_ slug: String) -> URL? {
    var c = URLComponents()
    c.scheme = "scrolls"
    c.host = "view"
    c.path = "/" + slug
    c.queryItems = [URLQueryItem(name: "as", value: "1")]
    return c.url
  }
}
