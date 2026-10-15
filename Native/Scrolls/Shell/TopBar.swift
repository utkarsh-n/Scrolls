// OWNER: N8
// The TopBar (IOS-SPEC §4.2–§4.3, 59–103 pt in portrait; §4.4 36 pt in landscape): state he reads, not controls he
// hammers. Leading: the corpus chip ("Demo" + SYN, "Cipher", "STEMM", "All real"), a menu that switches corpus — Cipher
// only once its phase A is done, saying why until then. Centre: up to four strand chips in one GlassEffectContainer,
// morphing with `glassEffectID` (the root screen's only morph: "this is now on the Scroll"). Trailing: the status chip
// (a determinate ring, "Cipher 45%") and More. Under it, the SYNTHETIC ribbon whenever demo material is in scope; it
// cannot be dismissed. Glass is chrome only; nothing here sits over bars.

import ScrollsContracts
import ScrollsCore
import SwiftUI

nonisolated enum TopBarCopy {
  static let corpus = "Corpus"
  static let corpusHint = "Switches the corpus the Scroll reads."
  static let demo = "Demo"
  static let cipher = "Cipher"
  static let stemm = "STEMM"
  static let allReal = "All real"
  static let synthetic = "synthetic demonstration corpus"
  static let cipherWaiting = "Cipher opens once its titles, relations and etymology are on this phone"
  static let stemmAbsent = "STEMM needs its source pack (Sources and storage)"
  static let allRealNote = "Every real corpus together; never the synthetic demo"
  static let statusHint = "Opens the jobs tray."

  /// The corpus chip's words (`ShellCopy.corpusName` uses the same names).
  static func name(_ slug: String) -> String {
    switch slug {
    case "demo": demo
    case "cipher": cipher
    case "stemm": stemm
    case "real", "all": allReal
    default: slug
    }
  }
}

extension ScrollScreenSlots {
  /// The TopBar and the ribbon's placement (N8).
  func topChrome() -> some View { TopChrome(model: model, landscape: geometry.isLandscape) }
}

/// TopBar + ribbon.
struct TopChrome: View {
  let model: AppModel
  let landscape: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(spacing: 0) {
      TopBar(model: model, landscape: landscape)
      if model.syntheticInScope { SyntheticRibbon() }
    }
  }
}

struct TopBar: View {
  let model: AppModel
  var landscape = false
  @Namespace private var morph
  @State private var corpora: [Corpus] = []

  var body: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(spacing: 8) {
        corpusMenu
        StrandChips(model: model, namespace: morph, glyphsOnly: landscape)
          .frame(maxWidth: .infinity)
        StatusChip(state: model.jobs.chip) { model.coordinator.present(.jobs) }
          .accessibilityHint(TopBarCopy.statusHint)
        MoreMenu(model: model)
      }
    }
    .padding(.horizontal, Tokens.Geometry.gutter)
    .frame(height: landscape ? Tokens.Geometry.landscapeTopBar : Tokens.Geometry.topBar)
    .chromeTypeCap()
    .task(id: model.phase) {
      guard model.phase == .ready, let atlas = model.atlas else { return }
      if let c = try? await atlas.corpora() { corpora = c }
    }
  }

  private var cipherOpenable: Bool { CoachWords.cipherOpenable(model.jobs.health?.cipher) }

  private func available(_ slug: String) -> Bool {
    if corpora.isEmpty { return slug == "demo" || slug == "cipher" }
    return corpora.contains { $0.slug == slug && $0.available != false }
  }

  private var corpusMenu: some View {
    let current = model.viewState.corpus
    return Menu {
      Picker(TopBarCopy.corpus, selection: Binding(get: { current }, set: { model.experience.setCorpus($0) })) {
        Text(TopBarCopy.demo).tag("demo")
        Text(TopBarCopy.cipher).tag("cipher").selectionDisabled(!cipherOpenable)
        if available("stemm") { Text(TopBarCopy.stemm).tag("stemm") }
        if available("real") { Text(TopBarCopy.allReal).tag("real") }
      }
      if !cipherOpenable {
        Text(CoachWords.cipherLine(model.jobs.health?.cipher))
      }
    } label: {
      HStack(spacing: 6) {
        Text(TopBarCopy.name(current))
        if current == "demo" { EvidenceBadge("SYN") }
      }
      .font(Typography.chrome)
      .foregroundStyle(Tokens.ink.color)
      .padding(.horizontal, 12)
      .frame(minHeight: 32)
      .chromeGlass(in: Capsule(), interactive: true)
      .frame(minHeight: Tokens.Geometry.minHit)
      .contentShape(Rectangle())
    }
    .accessibilityLabel(TopBarCopy.corpus)
    .accessibilityValue(current == "demo" ? "\(TopBarCopy.demo), \(TopBarCopy.synthetic)" : TopBarCopy.name(current))
    .accessibilityHint(TopBarCopy.corpusHint)
    .accessibilityIdentifier("corpusChip")
  }
}
