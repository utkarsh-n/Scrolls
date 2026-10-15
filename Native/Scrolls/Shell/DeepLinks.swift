// OWNER: N8
// Deep links (IOS-SPEC §4.15, §4.16, ΔS-18): the web's view grammar unchanged, so web and phone links are
// interchangeable, and Open in Scrolls routing of files.
// - `scrolls://open#v=1&c=demo&s=e12&…` carries a state (`ViewState.decodeHash`: applied, repaired, never refused);
// - `scrolls://view/<slug>` opens a saved view, `?as=1` as saved (the views API resolves its cutoffs);
//   a hash `#view=<slug>&as=1` does the same;
// - a `.scrollsview` file loads its state; packs and atlases go to Sources & storage (N2), put first where its scan
//   lists them (`DropFolder.receive`: opened from Files they arrive in place, outside the drop folders); a CSV, TSV,
//   JSON, JSONL, TXT or MD file goes to the import wizard (N1) as `RootModal.importFile(url)`.
// Routing is a pure function of the URL (`route(for:)`), tested without the app.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

/// Where a URL goes.
nonisolated enum DeepLinkRoute: Equatable, Sendable {
  /// A view state in the hash grammar.
  case state(String)
  /// A saved view by slug, current or as saved.
  case savedView(slug: String, asSaved: Bool)
  /// A `.scrollsview` file.
  case viewFile(URL)
  /// A pack or an atlas: Sources & storage installs it.
  case packOrAtlas(URL)
  /// A file to import.
  case importFile(URL)
  /// Not understood, with the reason in words.
  case unknown(String)
}

nonisolated enum DeepLinkCopy {
  static let unknownScheme = "This link is not a Scrolls link."
  static let unknownPath = "This Scrolls link names nothing Scrolls can open."
  static let unknownFile = "Scrolls cannot open this kind of file."
  static let viewFileUnreadable = "This view file could not be read; nothing was changed."
  static let openedFromState = "Not saved on this phone: opened from its state. Counts reflect this phone's atlas."
  static func repaired(_ n: Int) -> String { n == 1 ? "The link was repaired in 1 place; the rest was opened as written." : "The link was repaired in \(n) places; the rest was opened as written." }
  static func savedViewFailed(_ message: String) -> String { "The saved view could not be opened: \(message)" }
  static func packNotReceived(_ message: String) -> String { "The file could not be put in Scrolls' Import folder: \(message)" }
}

nonisolated enum DeepLinks {
  static let scheme = "scrolls"
  /// Files the import wizard reads (N1, `ingest/sniff.mjs`).
  static let importExtensions: Set<String> = ["csv", "tsv", "json", "jsonl", "ndjson", "txt", "md", "markdown"]
  static let packExtensions: Set<String> = ["scrollspack", "scrollsatlas", "scrollsarchive"]

  /// Where a URL goes (pure).
  nonisolated static func route(for url: URL) -> DeepLinkRoute {
    if url.isFileURL {
      let ext = url.pathExtension.lowercased()
      if ext == "scrollsview" { return .viewFile(url) }
      if packExtensions.contains(ext) { return .packOrAtlas(url) }
      if importExtensions.contains(ext) { return .importFile(url) }
      return .unknown(DeepLinkCopy.unknownFile)
    }
    guard url.scheme?.lowercased() == scheme else { return .unknown(DeepLinkCopy.unknownScheme) }
    let host = url.host(percentEncoded: false) ?? ""
    let parts = url.pathComponents.filter { $0 != "/" }
    let fragment = url.fragment(percentEncoded: true) ?? ""
    switch host {
    case "open", "":
      if fragment.isEmpty, host.isEmpty { return .unknown(DeepLinkCopy.unknownPath) }
      let decoded = ViewState.decodeHash(fragment)
      if let view = decoded.view { return .savedView(slug: view.slug, asSaved: view.asSaved) }
      return .state(fragment)
    case "view":
      guard let slug = parts.first?.removingPercentEncoding, !slug.isEmpty else { return .unknown(DeepLinkCopy.unknownPath) }
      let asSaved = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "as" && $0.value == "1" } ?? false
      return .savedView(slug: slug, asSaved: asSaved)
    default:
      return .unknown(DeepLinkCopy.unknownPath)
    }
  }

  /// The link of a state (`scrolls://open#…`): the web's hash, unchanged.
  nonisolated static func link(for state: ViewState) -> URL? {
    URL(string: "\(scheme)://open\(state.hash)")
  }

  /// Opens a URL in the app.
  @MainActor
  static func open(_ url: URL, model: AppModel) async {
    let experience = model.experience
    switch route(for: url) {
    case .state(let hash):
      let decoded = ViewState.decodeHash(hash)
      model.coordinator.popToRoot()
      experience.load(hash: hash)
      if !decoded.warnings.isEmpty { model.banner = DeepLinkCopy.repaired(decoded.warnings.count) }
    case .savedView(let slug, let asSaved):
      model.coordinator.popToRoot()
      await openSavedView(slug, asSaved: asSaved, model: model)
    case .viewFile(let file):
      model.coordinator.popToRoot()
      openViewFile(file, model: model)
    case .packOrAtlas(let file):
      model.coordinator.popToRoot()
      do {
        _ = try await DropFolder.receive(file)
      } catch {
        model.banner = DeepLinkCopy.packNotReceived(ErrorCardModel(any: error).message)
      }
      model.coordinator.present(.sources)
    case .importFile(let file):
      model.coordinator.popToRoot()
      model.coordinator.present(.importFile(file))
    case .unknown(let why):
      model.banner = why
    }
  }

  /// A saved view through the views API (N6 resolves its portable cutoffs, §6.4); its state is applied as stored.
  @MainActor
  static func openSavedView(_ slug: String, asSaved: Bool, model: AppModel) async {
    guard let atlas = model.atlas else { return }
    do {
      let v = try await atlas.view(slug, asSaved: asSaved)
      var w: [String] = []
      var state = ViewState.canonicalize(v.state, warnings: &w)
      state.asSaved = asSaved
      state.reducedMotion = model.viewState.reducedMotion
      model.viewState = state
    } catch {
      model.banner = DeepLinkCopy.savedViewFailed(ErrorCardModel(any: error).message)
    }
  }

  /// A `.scrollsview` file: `{scrolls_view: 1, slug, state_hash, state, portable, generation, saved_at}`. Its state is
  /// loaded as written; when its slug is not saved on this phone the banner says the counts are this phone's.
  @MainActor
  static func openViewFile(_ file: URL, model: AppModel) {
    let scoped = file.startAccessingSecurityScopedResource()
    defer { if scoped { file.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: file), let json = try? JSONDecoder().decode(JSONValue.self, from: data),
          let o = json.objectValue, let state = o["state"] else {
      model.banner = DeepLinkCopy.viewFileUnreadable
      return
    }
    var w: [String] = []
    var s = ViewState.canonicalize(state, warnings: &w)
    s.reducedMotion = model.viewState.reducedMotion
    model.viewState = s
    model.banner = DeepLinkCopy.openedFromState
    if let slug = o["slug"]?.stringValue {
      Task {
        // A view of the same slug on this phone is opened as saved, so its counts are the saved ones (D17).
        if let atlas = model.atlas, (try? await atlas.view(slug, asSaved: true)) != nil {
          await openSavedView(slug, asSaved: true, model: model)
          model.banner = nil
        }
      }
    }
  }
}
