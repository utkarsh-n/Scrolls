// OWNER: N0
// The root of the scene (IOS-SPEC §4.2): one NavigationStack whose root is the Scroll; pushed destinations (Compare,
// Lineage, Genealogy, Constellation, Notebook) present their own cards; root modals are one `.sheet` on the stack.
// The presentation coordinator keeps it to one system presentation at a time. Launch phases that stop the app from
// opening an atlas (a probe mismatch, an integrity failure) cover the screen with an opaque card; nothing is changed.
//
// Packages provide destinations, modals and cards through `RootSlots`, in the same way as `ScrollScreenSlots`:
// declare the member (for example `func compare(_ seed: CompareSeed) -> some View`) in an extension of `RootSlots`
// in your own file, and the concrete member replaces the placeholder default. `scene(_:)` wraps the whole root for
// what must sit above the navigation stack (state restoration, deep links, hardware-keyboard commands: N8).

import LabKitUI
import ScrollsContracts
import SwiftUI

/// Pushed destinations, root modals and cards, by owner.
struct RootSlots: RootSlotDefaults {
  let model: AppModel

  @ViewBuilder
  func destination(_ route: Route) -> some View {
    switch route {
    case .compare(let seed): compare(seed)
    case .lineage(let seed): lineage(seed)
    case .genealogy(let seed): genealogy(seed)
    case .constellation(let seed): constellation(seed)
    case .notebook(let seed): notebook(seed)
    }
  }

  @ViewBuilder
  func modal(_ m: RootModal) -> some View {
    switch m {
    case .importFile(let url): importWizard(url)
    case .sources: sources()
    case .savedViews: savedViews()
    case .lanes: lanes()
    case .filters: filters()
    case .legend: legend()
    case .howItWorks: howItWorks()
    case .settings: settings()
    case .jobs: jobsTray()
    case .yearPicker: yearPicker()
    case .diagnostics: DiagnosticsView()
    }
  }

  @ViewBuilder
  func card(_ c: CardModal) -> some View {
    switch c {
    case .edge(let id): edgeCard(id)
    case .node(let node): nodeCard(node)
    case .hypothesisGroup(let id): hypothesisGroupCard(id)
    case .annotationEditor(let target): annotationEditor(target)
    }
  }
}

/// Placeholder defaults: each names the package that brings the real view.
@MainActor protocol RootSlotDefaults {
  var model: AppModel { get }
}

extension RootSlotDefaults {
  /// Wraps the whole root (state restoration, deep links, key commands: N8). The default changes nothing.
  func scene<Content: View>(_ content: Content) -> some View { content }

  func compare(_ seed: CompareSeed) -> some View { NotBuiltView(title: "Compare", package: "N4") }
  func lineage(_ seed: LineageSeed) -> some View { NotBuiltView(title: "Lineage", package: "N5") }
  func genealogy(_ seed: GenealogySeed) -> some View { NotBuiltView(title: "Genealogy", package: "N5") }
  func constellation(_ seed: ConstellationSeed) -> some View { NotBuiltView(title: "Constellation", package: "N4") }
  func notebook(_ seed: NotebookSeed) -> some View { NotBuiltView(title: "Notebook", package: "N6") }

  func importWizard(_ url: URL?) -> some View { NotBuiltView(title: "Import", package: "N1", modal: true) }
  func sources() -> some View { NotBuiltView(title: "Sources and storage", package: "N2", modal: true) }
  func savedViews() -> some View { NotBuiltView(title: "Saved views", package: "N6", modal: true) }
  func lanes() -> some View { NotBuiltView(title: "Lanes", package: "N8", modal: true) }
  func filters() -> some View { NotBuiltView(title: "Filters", package: "N8", modal: true) }
  func legend() -> some View { NotBuiltView(title: "Legend", package: "N8", modal: true) }
  func howItWorks() -> some View { NotBuiltView(title: "How Scrolls works", package: "N8", modal: true) }
  func settings() -> some View { NotBuiltView(title: "Settings", package: "N8", modal: true) }
  func jobsTray() -> some View { NotBuiltView(title: "Jobs", package: "N8", modal: true) }
  func yearPicker() -> some View { NotBuiltView(title: "Year picker", package: "N8", modal: true) }

  func edgeCard(_ id: RelationshipID) -> some View { NotBuiltView(title: "Edge card", package: "N5", modal: true) }
  func nodeCard(_ node: NodeRef) -> some View { NotBuiltView(title: "Node card", package: "N5", modal: true) }
  func hypothesisGroupCard(_ id: HypothesisGroupID) -> some View {
    NotBuiltView(title: "Hypothesis group", package: "N5", modal: true)
  }
  func annotationEditor(_ target: AnnotationTarget) -> some View {
    NotBuiltView(title: "Annotation editor", package: "N6", modal: true)
  }
}

extension EnvironmentValues {
  /// The root's namespace for zoom transitions into pushed destinations (§4.2). Sources live in the root (the ruler's
  /// range chip, inspector buttons, the anchor over a long-pressed mark) and pass their id to `coordinator.push(_:from:)`.
  @Entry var zoomNamespace: Namespace.ID?
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Namespace private var zoom

  var body: some View {
    @Bindable var coordinator = model.coordinator
    let slots = RootSlots(model: model)
    slots.scene(stack(slots, coordinator: coordinator))
      .environment(\.zoomNamespace, zoom)
      .overlay(alignment: .top) {
        SelfTestBanner(model: model)
          .padding(.top, Tokens.Geometry.topBar + Tokens.Geometry.ribbon + Tokens.Geometry.minimap + 8)
          .padding(.horizontal, Tokens.Geometry.gutter)
      }
      .overlay { LaunchPhaseCover(phase: model.phase) }
      .statusBanner(Binding(get: { model.banner }, set: { model.banner = $0 }), icon: "info.circle", duration: 8,
                    topInset: Tokens.Geometry.topBar + Tokens.Geometry.ribbon + 8)
  }

  private func stack(_ slots: RootSlots, coordinator: PresentationCoordinator) -> some View {
    @Bindable var coordinator = coordinator
    return NavigationStack(path: $coordinator.path) {
      ScrollScreen()
        .navigationDestination(for: Route.self) { route in
          zoomed(slots.destination(route), from: coordinator.zoomSources[route])
            .sheet(item: coordinator.cardBinding(for: route), onDismiss: { coordinator.cardDidDismiss() }) { card in
              slots.card(card)
            }
        }
    }
    .sheet(item: coordinator.modalBinding, onDismiss: { coordinator.modalDidDismiss() }) { modal in
      slots.modal(modal)
    }
  }

  /// A destination zooms from its source when it was pushed from one; otherwise it pushes as usual.
  @ViewBuilder
  private func zoomed<V: View>(_ destination: V, from source: String?) -> some View {
    if let source {
      destination.navigationTransition(.zoom(sourceID: source, in: zoom))
    } else {
      destination
    }
  }
}

/// Covers the screen while launching and when the atlas cannot be opened; transparent once ready.
struct LaunchPhaseCover: View {
  let phase: AppModel.Phase
  @State private var slow = false

  var body: some View {
    switch phase {
    case .ready, .replaying:
      EmptyView()
    case .launching:
      ZStack {
        Tokens.bg0.color.ignoresSafeArea()
        if slow {
          Text(LaunchCopy.opening).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      }
      .task {
        try? await Task.sleep(for: .seconds(1))
        slow = true
      }
    case .probeFailed(let details):
      stopped(LaunchCopy.probeTitle, details.isEmpty ? LaunchCopy.probeMessage : details)
    case .integrityFailed(let details):
      stopped(LaunchCopy.integrityTitle, details)
    }
  }

  private func stopped(_ title: String, _ message: String) -> some View {
    ZStack {
      Tokens.bg0.color.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 10) {
        Text(title).font(.title3.weight(.semibold)).foregroundStyle(Tokens.ink.color)
        Text(message).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
        if !message.contains(LaunchCopy.nothingChanged) {
          Text(LaunchCopy.nothingChanged).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      }
      .padding(20)
      .opaquePanel()
      .padding(Tokens.Geometry.gutter)
    }
    .accessibilityElement(children: .combine)
  }
}

nonisolated enum LaunchCopy {
  static let opening = "Opening the atlas"
  static let nothingChanged = "Nothing was changed."
  static let probeTitle = "This phone's SQLite tokenizes differently"
  static let probeMessage = "This phone's SQLite tokenizes differently from the one Scrolls was built against."
  static let integrityTitle = "The atlas failed its check"
}

/// A destination, modal or card that another package has not built yet. It says so, and nothing else.
struct NotBuiltView: View {
  let title: String
  let package: String
  var modal = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    if modal {
      NavigationStack { content }
    } else {
      content
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(title) \(ShellCopy.notBuiltSuffix)").font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      Text(verbatim: "Package \(package)").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
    }
    .padding(20)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(Tokens.bg0.color)
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if modal {
        ToolbarItem(placement: .confirmationAction) { Button(ShellCopy.done) { dismiss() } }
      }
    }
    .accessibilityIdentifier("notBuilt.\(title)")
  }
}
