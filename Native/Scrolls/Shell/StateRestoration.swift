// OWNER: N8
// State restoration (IOS-SPEC §4.15, N-23, ΔS-18). `@SceneStorage("view")` holds the canonical view-state hash — centre
// day, zoom, lanes, strands, vantage, selection, range, panels — in the web's grammar, so a link and a restore are the
// same thing. `@SceneStorage("ui")` holds the phone's own state outside the hash, as a small JSON: the inspector's
// detent and SheetMode, the pushed Route path, the inspector tab and whether the reader is open. Both are restored when
// the root first appears, before the engine has opened (so before the Scroll's first tile request). A restored
// selection that no longer resolves is cleared, with a toast.
//
// Scene storage is discarded when he removes the app in the app switcher, yet a force quit must restore too (§8.7 M1
// row 7), so both values are mirrored in UserDefaults (a per-device convenience) and read when the scene's own storage
// comes back empty. A self-test launch neither restores nor writes either store: it runs in its own atlas and must leave
// his reading state as it was (§6.6). `-freshState` (UI tests) starts from the corpus default and clears both stores.
//
// The same wrapper (`RootSlots.scene`) hosts what must sit above the navigation stack: the coach marks, the
// follow-the-bus observers of the experience, deep links (`onOpenURL`) and the launch of the first minute.

import ScrollsContracts
import ScrollsCore
import SwiftUI

/// The phone's UI state outside the hash (`@SceneStorage("ui")`).
nonisolated struct UIStateSnapshot: Codable, Equatable, Sendable {
  var detent: SheetDetent
  var mode: SheetMode
  var path: [Route]
  var tab: InspectorTab
  var readerOpen: Bool

  static let empty = UIStateSnapshot(detent: .peek, mode: .idle, path: [], tab: .then, readerOpen: false)
}

nonisolated enum StateRestoration {
  /// Scene-storage keys (§4.15).
  static let viewKey = "view"
  static let uiKey = "ui"
  /// The UserDefaults mirror of both, read when scene storage is empty (after a force quit).
  static let mirrorViewKey = "scrolls.restore.view"
  static let mirrorUIKey = "scrolls.restore.ui"
  /// The launch argument that starts from defaults and clears both stores (UI tests).
  static let freshArgument = "-freshState"

  /// Whether this launch restores and records state: never for a self-test, never with `-freshState`.
  static func persists(_ launch: LaunchArgs, arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
    launch.selfTest == nil && !arguments.contains(freshArgument)
  }

  /// The stored value to restore: the scene's own, else the mirror.
  static func pick(scene: String, mirror: String?) -> String { scene.isEmpty ? (mirror ?? "") : scene }

  /// The UI snapshot as JSON text ("" when it cannot be written: then nothing is restored, which is safe).
  static func encode(_ s: UIStateSnapshot) -> String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return (try? e.encode(s)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }

  /// The UI snapshot from its JSON; nil for empty or unreadable text (a newer or damaged snapshot is ignored).
  static func decode(_ text: String) -> UIStateSnapshot? {
    guard !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(UIStateSnapshot.self, from: data)
  }

  /// The view state of a stored hash; nil when there is none. A saved-view hash restores its reference's corpus
  /// default (the views API reopens it).
  static func viewState(from hash: String) -> ViewState? {
    guard !hash.isEmpty else { return nil }
    return ViewState.decodeHash(hash).state
  }
}

extension RootSlots {
  /// N8 wraps the root: state restoration, deep links, the coach marks and the experience's observers.
  func scene<Content: View>(_ content: Content) -> some View {
    ExperienceHost(model: model, content: content)
  }
}

/// The root wrapper (N8).
struct ExperienceHost<Content: View>: View {
  let model: AppModel
  let content: Content
  @SceneStorage(StateRestoration.viewKey) private var storedHash = ""
  @SceneStorage(StateRestoration.uiKey) private var storedUI = ""
  @State private var restoredOnce = false
  @State private var launchedTour = false

  var body: some View {
    let experience = model.experience
    content
      .overlay { CoachMarksOverlay(model: model) }
      .overlay(alignment: .topLeading) { DebugStateProbe(model: model) }
      .onAppear(perform: restore)
      .onChange(of: model.viewState) { _, state in record(view: state.hash) }
      .onChange(of: model.viewState.selection) { _, s in experience.selectionChanged(s) }
      .onChange(of: model.viewState.corpus) { _, c in experience.corpusChanged(c) }
      .onChange(of: experience.transport.isPlaying) { _, playing in experience.tour.playChanged(playing) }
      .onChange(of: snapshot) { _, s in record(ui: StateRestoration.encode(s)) }
      .onChange(of: model.phase, initial: true) { _, phase in
        guard phase == .ready, !launchedTour else { return }
        launchedTour = true
        Task {
          await verifyRestoredSelection()
          await experience.tour.launched(restored: experience.restored)
        }
      }
      .onOpenURL { url in Task { await DeepLinks.open(url, model: model) } }
  }

  /// What `@SceneStorage("ui")` keeps.
  private var snapshot: UIStateSnapshot {
    let e = model.experience
    return UIStateSnapshot(detent: model.coordinator.inspectorDetent, mode: e.mode, path: model.coordinator.path, tab: e.tab,
                           readerOpen: e.readerOpen)
  }

  private var persists: Bool { StateRestoration.persists(model.launch) }

  /// Writes the view hash to scene storage and its mirror (not in a self-test or a fresh launch).
  private func record(view hash: String) {
    guard persists, restoredOnce else { return }
    storedHash = hash
    UserDefaults.standard.set(hash, forKey: StateRestoration.mirrorViewKey)
  }

  /// Writes the UI snapshot to scene storage and its mirror.
  private func record(ui text: String) {
    guard persists, restoredOnce else { return }
    storedUI = text
    UserDefaults.standard.set(text, forKey: StateRestoration.mirrorUIKey)
  }

  /// Restores the view state and the UI state once, at first appearance.
  private func restore() {
    guard !restoredOnce else { return }
    restoredOnce = true
    let experience = model.experience
    guard persists else {
      if ProcessInfo.processInfo.arguments.contains(StateRestoration.freshArgument) {
        storedHash = ""
        storedUI = ""
        UserDefaults.standard.removeObject(forKey: StateRestoration.mirrorViewKey)
        UserDefaults.standard.removeObject(forKey: StateRestoration.mirrorUIKey)
      }
      return
    }
    let defaults = UserDefaults.standard
    let hash = StateRestoration.pick(scene: storedHash, mirror: defaults.string(forKey: StateRestoration.mirrorViewKey))
    let uiText = StateRestoration.pick(scene: storedUI, mirror: defaults.string(forKey: StateRestoration.mirrorUIKey))
    if let state = StateRestoration.viewState(from: hash) {
      var s = state
      s.reducedMotion = model.viewState.reducedMotion
      model.viewState = s
      experience.restored = true
    }
    if let ui = StateRestoration.decode(uiText) {
      model.coordinator.inspectorDetent = ui.detent
      experience.tab = ui.tab
      switch ui.mode {
      case .search, .yourTurn: experience.mode = .idle   // a field's focus and the end of the tour are not restored
      case .shelf(let ref): experience.openShelf(ref)
      default: experience.mode = ui.mode
      }
      if !ui.path.isEmpty { model.coordinator.path = ui.path }
      experience.readerOpen = ui.readerOpen
      experience.restored = true
    }
    // The selection of the restored hash opens its Then column or drawer (the bus has not changed since launch).
    if experience.restored { experience.selectionChanged(model.viewState.selection) }
  }

  /// A restored selection whose id no longer resolves is cleared, with a toast (§4.15).
  private func verifyRestoredSelection() async {
    guard model.experience.restored, let selection = model.viewState.selection, let atlas = model.atlas,
          case .number(let n) = selection.id else { return }
    do {
      switch selection.type {
      case "occurrence": _ = try await atlas.occurrence(OccurrenceID(n))
      case "passage": _ = try await atlas.passage(PassageID(n), PassageRequest())
      case "document": _ = try await atlas.document(DocumentID(n))
      default: return
      }
    } catch let error as ScrollsError where error.code == .notFound {
      model.experience.clearSelection()
      model.banner = ThenCopy.selectionCleared
    } catch {
      // Another failure (an engine part not built, a timeout) says nothing about the id: the selection stays.
    }
  }
}

/// Under `-ui-testing`, one invisible element carries the view-state hash and the sheet mode, so StateRestorationTests
/// can compare them across a kill. Absent in every other launch.
private struct DebugStateProbe: View {
  let model: AppModel

  var body: some View {
    if model.launch.uiTesting {
      Color.clear
        .frame(width: 2, height: 2)
        .accessibilityElement()
        .accessibilityLabel("view state")
        .accessibilityValue("\(model.viewState.hash)|\(model.experience.mode.name)|\(model.coordinator.inspectorDetent.rawValue)")
        .accessibilityIdentifier("debug.viewState")
        .allowsHitTesting(false)
    }
  }
}
