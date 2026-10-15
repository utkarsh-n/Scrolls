// OWNER: N8
// The experience's state on the main actor (IOS-SPEC §4.8, §4.9, §4.15, §4.17): the inspector's `SheetMode`, the
// search, the Then column, the bin drawer and shelves, the tour, the transport row, the haptic map and the bridge to
// the Scroll. It hangs off the app model as `model.experience` (one per AppModel), so N0's files never change for it.
// It follows the frozen bus — `AppModel.viewState` — whatever sets it: a selection made on the Scroll opens Then; a
// bin selection opens its drawer; clearing it returns the sheet to idle.

import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

@MainActor @Observable
final class ExperienceModel {
  /// Strong on purpose: the registry keeps the experience, and the experience keeps its app model, so the unowned
  /// references of the sub-models (and of their timers) can never outlive it.
  @ObservationIgnored let app: AppModel
  /// What the inspector shows.
  var mode: SheetMode = .idle
  /// The inspector's tab while it shows a selection.
  var tab: InspectorTab = .then
  /// The reader is open over the Then column (at large).
  var readerOpen = false
  /// Asks the peek row's search field for focus (the tour's Your turn, `/`).
  var focusSearchRequest = 0
  let bridge: ScrollBridge
  let haptics: HapticsMap
  let search: SearchModel
  let then: ThenModel
  let list: ListModel
  let tour: TourModel
  let transport: TransportModel
  /// The mode the inspector returns to when a list or search closes.
  @ObservationIgnored private var previousMode: SheetMode = .idle
  /// The restored UI state was applied (StateRestoration).
  @ObservationIgnored var restored = false

  init(app: AppModel) {
    self.app = app
    let bridge = ScrollBridge()
    let haptics = HapticsMap(engine: app.hapticEngine)
    self.bridge = bridge
    self.haptics = haptics
    search = SearchModel(app: app)
    then = ThenModel(app: app)
    list = ListModel(app: app, bridge: bridge)
    tour = TourModel(app: app)
    transport = TransportModel(app: app, bridge: bridge, haptics: haptics)
    search.attach(self)
    tour.attach(self)
  }

  private var coordinator: PresentationCoordinator { app.coordinator }

  // MARK: Following the view state (the frozen bus)

  /// The view-state selection changed (on the Scroll, from search, a link or a restore).
  func selectionChanged(_ selection: ViewState.Selection?) {
    if let ref = InspectedRef(selection) {
      readerOpen = false
      mode = .inspector(ref)
      tab = .then
      then.open(ref)
      raise(to: .half)
      haptics.play(.select)
      if ref.type == "occurrence" || ref.type == "passage" { tour.passageOpened() }
    } else if let selection, selection.type == "bin", case .string(let id) = selection.id, let bin = BinRef(selectionID: id) {
      mode = .drawer(bin)
      list.openBin(bin)
      raise(to: .half)
    } else if selection == nil {
      switch mode {
      case .inspector, .drawer:
        mode = .idle
        then.open(nil)
        list.close()
      default: break
      }
    }
  }

  /// The corpus changed: the start card and coach marks follow.
  func corpusChanged(_ corpus: String) {
    tour.corpusChanged(corpus)
    search.clear()
  }

  // MARK: Acting on the view state

  /// Select something (search rows, KWIC rows, deep links): through the bus, so the Scroll highlights it too.
  func select(_ selection: ViewState.Selection?) {
    if app.viewState.selection == selection {
      selectionChanged(selection)
    } else {
      app.viewState.selection = selection
    }
  }

  /// Clear the selection and lower the sheet (VoiceOver escape, the close button).
  func clearSelection() {
    app.viewState.selection = nil
    mode = .idle
    readerOpen = false
    then.open(nil)
    list.close()
    coordinator.inspectorDetent = .peek
  }

  /// PIN_STRAND: at most four strands; glyphs follow position (canonicalised). The chip morphs into the TopBar and the
  /// sheet drops to peek so the Scroll shows it.
  func pin(type: String, id: ViewState.StrandID, label: String?, quiet: Bool = false) {
    var v = app.viewState
    if v.strands.contains(where: { $0.type == type && $0.id == id }) {
      if !quiet { settleAfterPin() }
      return
    }
    guard v.strands.count < ViewState.maxStrands else {
      app.banner = SearchCopy.maxStrands
      return
    }
    v.strands.append(ViewState.Strand(type: type, id: id, variants: .default, glyph: ""))
    if let label { bridge.strandLabels[id.text] = label }
    withAnimation(Tokens.Motion.detentSnap) { app.viewState = v.canonicalized() }
    if !quiet {
      settleAfterPin()
      if let label { AccessibilityNotification.Announcement(SearchCopy.pinned(label)).post() }
    }
  }

  /// UNPIN_STRAND by position: glyphs follow position, so they are reassigned.
  func unpin(at index: Int) {
    var v = app.viewState
    guard v.strands.indices.contains(index) else { return }
    v.strands.remove(at: index)
    v.strands = v.strands.map { ViewState.Strand(type: $0.type, id: $0.id, variants: $0.variants, glyph: "") }
    withAnimation(Tokens.Motion.detentSnap) { app.viewState = v.canonicalized() }
  }

  private func settleAfterPin() {
    if mode == .search || mode == .yourTurn { mode = .idle }
    search.clear()
    coordinator.inspectorDetent = .peek
  }

  /// SET_CORPUS: the corpus's defaults (the viewer's reduced-motion setting kept).
  func setCorpus(_ corpus: String) {
    guard app.viewState.corpus != corpus else { return }
    var d = ViewState.defaultState(corpus)
    d.reducedMotion = app.viewState.reducedMotion
    app.viewState = d
  }

  /// LOAD_STATE from a hash (tour steps, links): applied, repaired, never refused.
  func load(hash: String) {
    let decoded = ViewState.decodeHash(hash)
    var s = decoded.state
    s.reducedMotion = app.viewState.reducedMotion
    app.viewState = s
    if let view = decoded.view {
      Task { await DeepLinks.openSavedView(view.slug, asSaved: view.asSaved, model: app) }
    }
  }

  // MARK: The sheet

  /// Raise the inspector to at least `detent` (never lowers it).
  func raise(to detent: SheetDetent) {
    let order: [SheetDetent] = [.peek, .half, .large]
    guard let now = order.firstIndex(of: coordinator.inspectorDetent), let want = order.firstIndex(of: detent), want > now else { return }
    coordinator.inspectorDetent = detent
  }

  /// The search field took focus: results at large with the keyboard (§4.9).
  func beginSearch() {
    if mode != .search { previousMode = mode }
    mode = .search
    coordinator.inspectorDetent = .large
  }

  /// The search was cancelled: back to what was shown before.
  func endSearch() {
    guard mode == .search else { return }
    mode = previousMode
    search.clear()
    if mode == .idle { coordinator.inspectorDetent = .peek }
  }

  /// A shelf chip (⊘ / ⇥) or a wash on the Scroll opens its list (N7 calls this through the bridge's owner).
  func openShelf(_ ref: ShelfRef) {
    mode = .shelf(ref)
    list.openShelf(ref)
    raise(to: .half)
  }

  /// Close a drawer or shelf list; a bin drawer also clears its bin selection.
  func closeList() {
    if case .drawer = mode, app.viewState.selection?.type == "bin" { app.viewState.selection = nil }
    mode = .idle
    list.close()
  }

  /// The end of the first minute (§4.17): the inspector shows Your turn with the search field focused.
  func showYourTurn() {
    mode = .yourTurn
    raise(to: .half)
    focusSearchRequest += 1
  }

  /// Your turn's close: back to idle at peek.
  func closeYourTurn() {
    mode = .idle
    tour.dismiss()
    coordinator.inspectorDetent = .peek
  }

  /// A work's Genealogy (N5's destination), from a search row or the Then column.
  func openGenealogy(document id: Int) {
    coordinator.push(.genealogy(GenealogySeed(work: NodeRef(kind: "document", id: Int64(id)))))
  }

  /// The Lineage of a passage or document (N5).
  func openLineage(_ node: NodeRef) {
    coordinator.push(.lineage(LineageSeed(root: node)))
  }

  /// Annotate: the Notebook on this target (N6).
  func annotate(_ target: AnnotationTarget) {
    coordinator.push(.notebook(NotebookSeed(target: target)))
  }
}

// MARK: - One experience per app model

/// The experience models by app model (one AppModel per process; tests may make more).
@MainActor private enum ExperienceRegistry {
  static var models: [ObjectIdentifier: ExperienceModel] = [:]
}

extension AppModel {
  /// The experience (N8): the inspector, search, tour, transport, haptics and the bridge to the Scroll.
  var experience: ExperienceModel {
    let key = ObjectIdentifier(self)
    if let m = ExperienceRegistry.models[key] { return m }
    let m = ExperienceModel(app: self)
    ExperienceRegistry.models[key] = m
    return m
  }
}
