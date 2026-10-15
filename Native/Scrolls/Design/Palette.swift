// OWNER: N0
// `LabPalette.scrolls`, built from the SPEC §8.7 tokens (signature = cyan, §4.22), and the one place token names
// used by the shared evidence style (`EvidenceStyle`, `BinStyle`: "amber", "ink-2", "danger", …) become colours.
// LabKit's semantic colours (live green, value amber) are not used for evidence: Scrolls' words are documented,
// computed and proposed, and they never sit next to LabKit's measured/modelled vocabulary (I3).

import LabKitCore
import LabKitUI
import SwiftUI

nonisolated extension LabColor {
  /// The LabKit colour of a Scrolls token.
  init(_ token: TokenColor) { self.init(token.red, token.green, token.blue) }
}

nonisolated extension LabGround {
  /// Scrolls' ground: the charcoal canvas, panels on bg-1, ivory secondary and meta text.
  static let observatory = LabGround(
    name: "observatory", stage: LabColor(Tokens.bg0), background: LabColor(Tokens.bg0), panel: LabColor(Tokens.bg1),
    plot: LabColor(Tokens.bg0), muted: LabColor(Tokens.ink2), dim: LabColor(Tokens.ink3), hairlineAlpha: 0.12)
}

nonisolated extension LabPalette {
  /// Scrolls' palette: the observatory ground and the cyan signature (selection and navigation only).
  /// The data hues are the role hues of the evidence encoding, in legend order.
  static let scrolls = LabPalette(
    app: "Scrolls", ground: .observatory, signature: LabColor(Tokens.cyan),
    dataHues: [
      DataHue("amber", "Reference to earlier material", LabColor(Tokens.amber)),
      DataHue("violet", "Reinterpretation", LabColor(Tokens.violet)),
      DataHue("ivory2", "Similarity", LabColor(Tokens.ink2)),
      DataHue("danger", "Date conflict", LabColor(Tokens.danger)),
    ])
}

/// Token names → colours, for styles that come from the engine as names.
nonisolated enum Palette {
  /// The colour of a token or role-hue name ("ink", "ink-2", "ivory2", "amber", "violet", "cyan", "danger", "syn",
  /// "bg-1", …). nil for a name the tokens do not define: a style is never guessed.
  static func color(named name: String) -> Color? {
    token(named: name)?.color
  }

  /// The token behind a name (see `color(named:)`).
  static func token(named name: String) -> TokenColor? {
    switch name {
    case "bg-0", "bg0": Tokens.bg0
    case "bg-1", "bg1": Tokens.bg1
    case "bg-2", "bg2": Tokens.bg2
    case "bg-3", "bg3": Tokens.bg3
    case "rule": Tokens.rule
    case "ink": Tokens.ink
    case "ink-2", "ink2", "ivory2", "ivory-2", "edge": Tokens.ink2
    case "ink-3", "ink3": Tokens.ink3
    case "cyan", "focus": Tokens.cyan
    case "amber": Tokens.amber
    case "violet": Tokens.violet
    case "danger": Tokens.danger
    case "ok": Tokens.ok
    case "syn": Tokens.syn
    default: nil
    }
  }

  /// Meta text: `ink-3`, swapped for `ink-2` under Increase Contrast (§4.19).
  static func meta(_ contrast: ColorSchemeContrast) -> Color {
    contrast == .increased ? Tokens.ink2.color : Tokens.ink3.color
  }

  /// Hairline opacity of rules on panels, raised under Increase Contrast.
  static func hairline(_ contrast: ColorSchemeContrast) -> Double {
    contrast == .increased ? 0.9 : 0.6
  }
}
