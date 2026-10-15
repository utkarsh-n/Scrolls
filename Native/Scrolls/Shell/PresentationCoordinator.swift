// OWNER: N0
// At most one system presentation at a time (IOS-SPEC §4.2). The coordinator owns the navigation path, the root
// modal, the card of the top pushed destination and the inspector overlay's detent, and enforces the rules:
// - presenting a modal while a card is up dismisses the card first; the modal follows once the card has gone;
// - a card is presented only by the top pushed destination (never on the root, never under a modal);
// - popovers (the ambiguity chooser, the year picker) exist only on the root while nothing else is presented;
// - pushing a destination closes whatever is presented.
// PresentationTests drive every pair of transitions through these methods.

import Observation
import SwiftUI

@MainActor @Observable
final class PresentationCoordinator {
  /// The pushed destinations, root first.
  var path: [Route] = [] {
    didSet {
      guard path.count < oldValue.count else { return }
      card = nil
      zoomSources = zoomSources.filter { path.contains($0.key) }
    }
  }
  /// The system sheet on the root, if any.
  private(set) var modal: RootModal?
  /// The card sheet of the top pushed destination, if any.
  private(set) var card: CardModal?
  /// A modal waiting for the card to finish dismissing.
  private(set) var pendingModal: RootModal?
  /// The inspector overlay's detent (it is part of the root view, never a system sheet).
  var inspectorDetent: SheetDetent = .peek
  /// The height the inspector covers at the bottom of the screen, in points (feeds `ScrollModel.occludedBottom`).
  var inspectorHeight: CGFloat = 0

  init() {}

  /// Something the system presents right now (a modal or a card).
  var isPresenting: Bool { modal != nil || card != nil }

  /// A root popover may open only on the root with nothing presented.
  var canShowPopover: Bool { path.isEmpty && modal == nil && card == nil && pendingModal == nil }

  /// The zoom-transition source of each pushed route that was opened from a marked view (§4.2): the brushed-range
  /// chip, an inspector button, the anchor over a long-pressed mark.
  private(set) var zoomSources: [Route: String] = [:]

  /// Pushes a destination; anything presented is closed first. `source` names the root view it zooms from (marked
  /// with `.matchedTransitionSource(id: source, in: zoomNamespace)`); nil pushes without a zoom.
  func push(_ route: Route, from source: String? = nil) {
    card = nil
    modal = nil
    pendingModal = nil
    zoomSources[route] = source
    path.append(route)
  }

  /// Pops the top destination (its card goes with it).
  func pop() {
    guard !path.isEmpty else { return }
    path.removeLast()
  }

  /// Back to the Scroll: pops every destination and closes every presentation.
  func popToRoot() {
    dismissAll()
    path.removeAll()
  }

  /// Presents a root modal. With a card up, the card is dismissed first and the modal follows on `cardDidDismiss()`.
  func present(_ m: RootModal) {
    if card != nil {
      card = nil
      pendingModal = m
      return
    }
    pendingModal = nil
    modal = m
  }

  /// Shows a card on the top pushed destination. Refused (returns false) on the root or while a modal is up.
  @discardableResult
  func show(_ c: CardModal) -> Bool {
    guard !path.isEmpty, modal == nil, pendingModal == nil else { return false }
    card = c
    return true
  }

  /// Closes every presentation; the path stays.
  func dismissAll() {
    card = nil
    modal = nil
    pendingModal = nil
  }

  /// The root modal was dismissed (by a swipe or its own button).
  func modalDidDismiss() {
    modal = nil
  }

  /// The card was dismissed; a modal that waited for it is presented now.
  func cardDidDismiss() {
    card = nil
    if let next = pendingModal {
      pendingModal = nil
      modal = next
    }
  }

  // MARK: Bindings for the sheets

  /// The root sheet's binding: clearing it records the dismissal.
  var modalBinding: Binding<RootModal?> {
    Binding(get: { self.modal }, set: { if $0 == nil { self.modalDidDismiss() } else if let m = $0 { self.present(m) } })
  }

  /// The card sheet's binding for a destination: only the top destination sees the card.
  func cardBinding(for route: Route) -> Binding<CardModal?> {
    Binding(
      get: { self.path.last == route ? self.card : nil },
      set: { if $0 == nil { self.cardDidDismiss() } else if let c = $0 { self.show(c) } })
  }
}
