// OWNER: N7
// The Scroll on the root screen (IOS-SPEC §4.2–§4.4, §4.23): `ScrollStage` fills N0's `scroll()` slot with the minimap,
// the Metal canvas (ruler strip + lanes) and the chrome over it — lane headers and shelf chips on the header strips, the
// playhead handle, pills, the brush chips, the "+n more lanes" row, the state line, and the PerfHUD under `-perf`.
// `ScrollCanvas` is the `UIViewRepresentable` around `ScrollGestureHost` (the MTKView and the recognisers). With
// `-renderer canvas` the same display list is drawn by `DisplayListCanvas` (SwiftUI Canvas, ≤ 60 Hz) under a transparent
// gesture host. Portrait: TopBar (N8) · minimap 24 · ruler 28 · coverage 10 · lanes. Landscape: minimap 20 · ruler 24 ·
// coverage 8, and a 120 pt lane rail with the full header text in two lines.

import Metal
import ScrollsContracts
import ScrollsCore
import ScrollsRender
import ScrollsScrollModel
import SwiftUI

// MARK: - One Scroll model per app model

@MainActor private enum ScrollRegistry {
  static var models: [ObjectIdentifier: ScrollModel] = [:]
}

extension AppModel {
  /// The Scroll (N7): its axis, data, builds, vantage and Play. Registered on the experience's bridge as the transport.
  var scroll: ScrollModel {
    let key = ObjectIdentifier(self)
    if let m = ScrollRegistry.models[key] { return m }
    let m = ScrollModel(app: self)
    ScrollRegistry.models[key] = m
    experience.bridge.register(transport: m)
    return m
  }
}

// MARK: - The slot

extension ScrollScreenSlots {
  /// N7's Scroll in the root screen's slot (replaces the placeholder).
  func scroll() -> some View { ScrollStage(app: model, geometry: geometry) }
}

/// The whole Scroll region below the top chrome.
struct ScrollStage: View {
  /// The coordinate space of the canvas (gestures and overlays agree on it).
  static let space = "scrollCanvas"

  let app: AppModel
  let geometry: ScrollScreenGeometry
  @Environment(\.displayScale) private var displayScale
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let scroll = app.scroll
    let landscape = geometry.isLandscape
    let minimapH = landscape ? Tokens.Geometry.landscapeMinimap : Tokens.Geometry.minimap
    VStack(spacing: 0) {
      Color.clear.frame(height: geometry.topChrome)
      Minimap(model: scroll)
        .frame(height: minimapH)
      HStack(spacing: 0) {
        if landscape {
          LaneRail(model: scroll)
            .frame(width: Tokens.Geometry.landscapeLaneRail)
        }
        canvasStack(scroll)
      }
    }
    .onChange(of: app.viewState, initial: true) { _, v in scroll.viewStateDidChange(v) }
    .onChange(of: landscape, initial: true) { _, l in
      scroll.landscape = l
      scroll.rulerHeight = Double(l ? Tokens.Geometry.landscapeRuler : Tokens.Geometry.ruler)
      scroll.coverageHeight = Double(l ? Tokens.Geometry.landscapeCoverage : Tokens.Geometry.coverage)
      scroll.invalidateData("orientation")
    }
    .onChange(of: geometry.occludedBottom, initial: true) { _, occ in
      scroll.occludedBottom = landscape ? 0 : max(0, Double(occ - geometry.safeArea.bottom))
      scroll.scrollLanes(by: 0)
      scroll.requestFrame()
    }
    .onChange(of: displayScale, initial: true) { _, s in scroll.displayScale = Double(s) }
    // The launch settles once: an atlas opened, or the launch gave up (phase leaves .launching with no atlas).
    .onChange(of: app.atlas != nil || app.phase != .launching) { _, settled in if settled { scroll.engineDidOpen() } }
    .task(id: app.atlas != nil) { await scroll.pinLaunchStrand() }
    .sheet(isPresented: Binding(get: { scroll.showsTable }, set: { scroll.showsTable = $0 })) {
      ScrollTableView(model: scroll)
    }
  }

  private func canvasStack(_ scroll: ScrollModel) -> some View {
    // The canvas is the size it is offered: its layers sit in an overlay, so none of them (sized from the measured
    // canvas, or padded by the inspector) can feed back into the size measured below.
    Color.clear
      .overlay(alignment: .topLeading) { canvasLayers(scroll) }
      .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { r in
        let sizeChanged = scroll.canvasSize != r.size
        scroll.canvasSize = r.size
        scroll.canvasOrigin = r.origin
        // The canvas ends above the home indicator, so the peek covers its content height (InspectorSheet's SheetLayout).
        let peekContent = typeSize.isAccessibilitySize ? Tokens.Geometry.peek + 40 : Tokens.Geometry.peek
        let peekOcc = geometry.isLandscape ? 0 : Double(peekContent)
        scroll.fillHeight = max(0, Double(r.size.height) - scroll.stripHeight - peekOcc - 2)
        if sizeChanged {
          scroll.setAxis(scroll.axis, commit: false)
          scroll.invalidateData("size")
        }
      }
  }

  private func canvasLayers(_ scroll: ScrollModel) -> some View {
    ZStack(alignment: .topLeading) {
      if app.launch.renderer == .canvas || ScrollRenderer.isUnavailable {
        DisplayListCanvas(build: scroll.build, frame: scroll.frame)
          .ignoresSafeArea(edges: .bottom)
          .accessibilityHidden(true)
        ScrollCanvas(model: scroll, metal: false)
      } else {
        ScrollCanvas(model: scroll, metal: true)
      }
      LaneHeaders(model: scroll)
      MoreLanesRow(model: scroll)
      CoverageTrack(model: scroll)
      Ruler(model: scroll)
      Playhead(model: scroll)
      ScrollStateLine(model: scroll, fixtures: app.engine.kind == .fixtures)
      if let choice = scroll.chooser {
        Color.clear
          .frame(width: 1, height: 1)
          .position(choice.anchor)
          .popover(item: Binding(get: { scroll.chooser }, set: { scroll.chooser = $0 })) { c in
            AmbiguityChooser(model: scroll, choice: c)
          }
      }
      if app.launch.perf { PerfHUD(model: scroll) }
    }
    .coordinateSpace(name: ScrollStage.space)
    .clipped()
  }
}

extension ScrollRenderer {
  /// No Metal device here (the Canvas renderer stands in, labelled in Diagnostics).
  static var isUnavailable: Bool { MTLCreateSystemDefaultDevice() == nil }
}

extension ScrollModel {
  /// `-strand <word>` (LaunchArgs): once, when the engine is open and nothing is pinned, the word's expression is
  /// searched and pinned through the experience (the same action as a search row), so a launch can open on a strand.
  func pinLaunchStrand() async {
    guard let word = app.launch.strand, !launchStrandDone, let atlas = app.atlas, app.viewState.strands.isEmpty else { return }
    launchStrandDone = true
    guard let res = try? await atlas.search(SearchRequest(q: word, corpus: app.viewState.corpus)), let e = res.expression else {
      showPill("-strand \(word): no expression found")
      return
    }
    app.experience.pin(type: "expression", id: .number(Int(e.id.rawValue)), label: e.surface, quiet: true)
  }
}

/// The Metal Scroll in SwiftUI: the gesture host around the MTKView.
struct ScrollCanvas: UIViewRepresentable {
  let model: ScrollModel
  let metal: Bool

  func makeUIView(context: Context) -> ScrollGestureHost { ScrollGestureHost(model: model, metal: metal) }

  func updateUIView(_ view: ScrollGestureHost, context: Context) { view.requestFrame() }
}

/// The Scroll's state in words while it has nothing (or not everything) to draw, and the fixtures label.
struct ScrollStateLine: View {
  let model: ScrollModel
  let fixtures: Bool

  var body: some View {
    // An overlay on a clear view: the bottom inset follows the inspector, and a tall inspector must never make the line
    // taller than the canvas (that grew the canvas, then the inspector, then the canvas, without end on his iPhone).
    Color.clear.overlay(alignment: .bottomLeading) { content }
      .allowsHitTesting(false)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 6) {
      switch model.status {
      case .querying, .idle:
        line(ScrollCopy.loading, spinning: true)
      case .counting(let words):
        line(words, spinning: true)
      case .failed(let message):
        Text(message)
          .font(Typography.cardBody)
          .foregroundStyle(Tokens.ink.color)
          .padding(14)
          .opaquePanel()
          .padding(.horizontal, Tokens.Geometry.gutter)
      case .ready, .start:
        if model.build?.model.lanes.isEmpty == true { line(ScrollCopy.empty, spinning: false) }
      }
      if fixtures {
        Text(ScrollCopy.fixtures)
          .font(Typography.meta)
          .foregroundStyle(Tokens.syn.color)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(Tokens.bg0.opacity(0.85), in: Capsule())
          .padding(.leading, 10)
          .accessibilityIdentifier("scrollFixturesNote")
      }
    }
    .padding(.bottom, CGFloat(model.occludedBottom) + 8)
  }

  private func line(_ text: String, spinning: Bool) -> some View {
    HStack(spacing: 8) {
      if spinning { ProgressView().controlSize(.small).tint(Tokens.ink2.color) }
      Text(text).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .chromeGlass(in: Capsule())
    .padding(.leading, 10)
    .accessibilityElement(children: .combine)
  }
}
