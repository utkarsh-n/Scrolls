// OWNER: N0
// The root screen (IOS-SPEC §4.2–§4.4): one full-bleed Scroll, the chrome over it, and the inspector overlay. Portrait
// geometry on the 15 Pro Max: status bar 0–59 · TopBar 59–103 · SYNTHETIC ribbon 103–117 · minimap · ruler ·
// coverage · lanes · inspector peek 794–898 · home indicator. Landscape has no overlay sheet (§4.4).
//
// Packages fill the screen through `ScrollScreenSlots`: N7 the Scroll (canvas, minimap, ruler, coverage, lanes),
// N8 the top chrome and the inspector's content (and the landscape column). A package fills a slot by declaring the
// same member in an extension of `ScrollScreenSlots` in its own file; a member on the concrete type takes precedence
// over the placeholder default below, so this file never changes when a slot is filled. Always call slots through
// the concrete `ScrollScreenSlots` type (a generic call would see only the defaults).

import LabKitUI
import ScrollsCore
import SwiftUI

/// What the slots of the root screen know about its layout.
struct ScrollScreenGeometry: Equatable {
  /// Height of the top chrome (TopBar and ribbon) below the top safe area.
  var topChrome: CGFloat
  /// Height the inspector covers at the bottom of the screen (0 in landscape).
  var occludedBottom: CGFloat
  var isLandscape: Bool
  var size: CGSize
  var safeArea: EdgeInsets
}

/// The views other packages put on the root screen.
struct ScrollScreenSlots: ScrollScreenSlotDefaults {
  let model: AppModel
  let geometry: ScrollScreenGeometry
}

@MainActor protocol ScrollScreenSlotDefaults {
  var model: AppModel { get }
  var geometry: ScrollScreenGeometry { get }
}

extension ScrollScreenSlotDefaults {
  /// The Scroll: data plane, minimap, ruler, coverage track and lanes, between the top chrome and the inspector (N7).
  func scroll() -> some View { ScrollPlaceholder(model: model, geometry: geometry) }

  /// The TopBar and the ribbon's placement (N8).
  func topChrome() -> some View { ShellTopChrome(model: model) }

  /// The inspector's content inside the overlay (N8).
  func inspector() -> some View { InspectorPlaceholder(model: model) }

  /// The landscape inspector column, shown when something is selected (N8, §4.4).
  func landscapeInspector() -> some View { EmptyView() }
}

struct ScrollScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var topChrome: CGFloat = Tokens.Geometry.topBar
  @State private var appeared = false

  var body: some View {
    @Bindable var coordinator = model.coordinator
    GeometryReader { proxy in
      let landscape = verticalSizeClass == .compact
      let geometry = ScrollScreenGeometry(
        topChrome: topChrome, occludedBottom: landscape ? 0 : coordinator.inspectorHeight, isLandscape: landscape,
        size: proxy.size, safeArea: proxy.safeAreaInsets)
      let slots = ScrollScreenSlots(model: model, geometry: geometry)
      ZStack(alignment: .top) {
        Tokens.bg0.color.ignoresSafeArea()
        slots.scroll()
          .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
        slots.topChrome()
          .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { topChrome = $0 }
        if landscape {
          HStack(spacing: 0) {
            Spacer(minLength: 0)
            slots.landscapeInspector()
          }
        } else {
          InspectorSheet(detent: $coordinator.inspectorDetent, occluded: $coordinator.inspectorHeight) {
            slots.inspector()
          }
        }
      }
    }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .onAppear {
      guard !appeared else { return }
      appeared = true
      model.noteFirstFrame()
    }
  }
}

// MARK: - Placeholder defaults (shown until N7 and N8 fill their slots)

/// The shell's own copy (placeholders and chrome words). British English; no mental-state verbs.
nonisolated enum ShellCopy {
  static let scrollTitle = "The Scroll is not drawn in this build"
  static let scrollBody = "Lanes, bars, washes and arcs come from the Scroll renderer (package N7). Until it lands, this area only marks where the Scroll's parts will sit. Nothing here is data."
  static let regions = ["minimap", "ruler", "coverage", "lanes"]
  static let inspectorTitle = "Inspector"
  static let inspectorBody = "Search, Play and Step arrive with the inspector package (N8). Drag the handle to try the three heights."
  static let engineTitle = "Engine"
  static let evidenceTitle = "Evidence words"
  static let evidenceNote = "Line style is evidence: every link carries one of these words as well as its pattern."
  static let more = "More"
  static let diagnostics = "Diagnostics"
  static let fixturesNote = "Contract fixtures (MockAtlas): canned responses, not your atlas."
  static let demo = "Demo"
  static let cipher = "Cipher"
  static let stemm = "STEMM"
  static let allReal = "All real"
  static let notBuiltSuffix = "is not in this build yet."
  static let done = "Done"
  static let contract = "Contract"
  static let dataVersion = "Data version"
  static let jobs = "Jobs"
  static func jobsLine(running: Int, queued: Int) -> String {
    "\(Format.int(running)) running · \(Format.int(queued)) queued"
  }

  /// The corpus chip's words for a view-state corpus slug.
  static func corpusName(_ slug: String) -> String {
    switch slug {
    case "demo": demo
    case "cipher": cipher
    case "stemm": stemm
    case "real", "all": allReal
    default: slug
    }
  }
}

/// The §4.3 regions, outlined and named, with one note that nothing is drawn yet.
struct ScrollPlaceholder: View {
  let model: AppModel
  let geometry: ScrollScreenGeometry

  var body: some View {
    let landscape = geometry.isLandscape
    let rows: [(String, CGFloat)] = [
      (ShellCopy.regions[0], landscape ? Tokens.Geometry.landscapeMinimap : Tokens.Geometry.minimap),
      (ShellCopy.regions[1], landscape ? Tokens.Geometry.landscapeRuler : Tokens.Geometry.ruler),
      (ShellCopy.regions[2], landscape ? Tokens.Geometry.landscapeCoverage : Tokens.Geometry.coverage),
    ]
    VStack(spacing: 0) {
      Color.clear.frame(height: geometry.topChrome)
      ForEach(rows, id: \.0) { name, height in
        regionGuide(name, height: height)
      }
      ZStack {
        Rectangle().strokeBorder(Tokens.rule.color, style: StrokeStyle(lineWidth: 1, dash: [2, 4]))
        VStack(alignment: .leading, spacing: 8) {
          Text(ShellCopy.scrollTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          Text(ShellCopy.scrollBody).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
            .fixedSize(horizontal: false, vertical: true)
          Text(model.engine.summary).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
        .padding(16)
        .frame(maxWidth: 420, alignment: .leading)
        .opaquePanel()
        .padding(Tokens.Geometry.gutter)
      }
      .frame(maxHeight: .infinity)
      Color.clear.frame(height: max(0, geometry.occludedBottom - geometry.safeArea.bottom))
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("scrollPlaceholder")
  }

  private func regionGuide(_ name: String, height: CGFloat) -> some View {
    Text(name)
      .font(.system(size: min(9, height - 2), weight: .medium, design: .monospaced))
      .foregroundStyle(Tokens.ink3.color)
      .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .leading)
      .padding(.leading, 8)
      .overlay(alignment: .bottom) { Rectangle().fill(Tokens.rule.color).frame(height: 1) }
      .accessibilityHidden(true)
  }
}

/// The TopBar placeholder: the corpus chip, the status chip and More (N8 replaces it with the real TopBar), then the
/// SYNTHETIC ribbon whenever demo material is in scope.
struct ShellTopChrome: View {
  let model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          corpusChip
          Spacer(minLength: 8)
          StatusChip(state: model.jobs.chip) { model.coordinator.present(.diagnostics) }
          moreMenu
        }
      }
      .padding(.horizontal, Tokens.Geometry.gutter)
      .frame(height: Tokens.Geometry.topBar)
      .chromeTypeCap()
      if model.syntheticInScope { SyntheticRibbon() }
    }
  }

  private var corpusChip: some View {
    HStack(spacing: 6) {
      Text(ShellCopy.corpusName(model.viewState.corpus))
      if model.viewState.corpus == "demo" { EvidenceBadge("SYN") }
    }
    .font(Typography.chrome)
    .foregroundStyle(Tokens.ink.color)
    .padding(.horizontal, 12)
    .frame(minHeight: 32)
    .chromeGlass(in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("corpusChip")
  }

  private var moreMenu: some View {
    Menu {
      Button(ShellCopy.diagnostics, systemImage: "stethoscope") { model.coordinator.present(.diagnostics) }
    } label: {
      Image(systemName: "ellipsis")
        .font(Typography.chrome)
        .foregroundStyle(Tokens.ink.color)
        .frame(width: 32, height: 32)
        .chromeGlass(in: Circle(), interactive: true)
        .frame(width: Tokens.Geometry.minHit, height: Tokens.Geometry.minHit)
        .contentShape(Rectangle())
    }
    .accessibilityLabel(ShellCopy.more)
    .accessibilityIdentifier("moreMenu")
  }
}

/// The inspector placeholder: the peek row explains what arrives with N8; at half and large it shows the engine's
/// health (labelled when it comes from fixtures) and the evidence words.
struct InspectorPlaceholder: View {
  let model: AppModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 4) {
          Text(ShellCopy.inspectorTitle).font(.headline).foregroundStyle(Tokens.ink.color)
          Text(ShellCopy.inspectorBody).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        EngineHealthPanel(model: model)
        EvidenceWordsPanel()
      }
      .padding(.horizontal, Tokens.Geometry.gutter)
      .padding(.bottom, 16)
    }
    .scrollBounceBehavior(.basedOnSize)
  }
}

/// The engine's health at a glance (`health()`), flagged when it comes from contract fixtures.
struct EngineHealthPanel: View {
  let model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ShellCopy.engineTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      Text(model.engine.summary).font(Typography.meta)
        .foregroundStyle(model.engine.kind == .fixtures ? Tokens.syn.color : Tokens.ink2.color)
        .fixedSize(horizontal: false, vertical: true)
      if let health = model.jobs.health {
        if health.mock == true, model.engine.kind != .fixtures {
          Text(ShellCopy.fixturesNote).font(Typography.meta).foregroundStyle(Tokens.syn.color)
            .fixedSize(horizontal: false, vertical: true)
        }
        LabeledContent(ShellCopy.contract, value: health.contract)
        LabeledContent(ShellCopy.dataVersion, value: Format.int(health.dataVersion))
        LabeledContent(ShellCopy.jobs, value: ShellCopy.jobsLine(running: health.jobs.running, queued: health.jobs.queued))
        VStack(alignment: .leading, spacing: 2) {
          Text("\(ShellCopy.cipher) · \(health.cipher.status)").font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          if let message = health.cipher.message {
            CountingLabel(message, fraction: health.cipher.progress)
          }
        }
      } else if let error = model.jobs.lastError {
        ErrorCard(error) { Task { await model.jobs.refresh() } }
      }
    }
    .font(Typography.cardBody)
    .foregroundStyle(Tokens.ink2.color)
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
  }
}

/// The badge words and what each states (`Copy.badges`): legend content, not data.
struct EvidenceWordsPanel: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ShellCopy.evidenceTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      Text(ShellCopy.evidenceNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        .fixedSize(horizontal: false, vertical: true)
      ForEach(Array(Copy.badges.keys), id: \.self) { key in
        if let badge = Copy.badges[key] {
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            EvidenceBadge(key).frame(minWidth: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
              Text(badge.title).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
              Text(badge.description).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
  }
}
