// OWNER: N0
// Typography (IOS-SPEC §4.20): SF Pro for the interface with monospaced digits for counts, SF Mono for numbers in
// tables, and New York for passages with a font cascade, because New York has no Devanagari or Gujarati glyphs:
// New York → Kohinoor Devanagari → Kohinoor Gujarati → the system fallback. Indic passages get more line height
// (1.8 instead of 1.6, and 1 pt more) so vowel signs above and below the line are never clipped.

import SwiftUI
import UIKit

/// Type roles for the interface.
nonisolated enum Typography {
  /// Chrome labels over the Scroll (chips, pills), capped at `.accessibility1` by the chrome modifier.
  static let chrome = Font.footnote.weight(.semibold)
  static let chromeCount = Font.footnote.weight(.semibold).monospacedDigit()
  /// Card titles (gate, error, edge cards).
  static let cardTitle = Font.subheadline.weight(.semibold)
  static let cardBody = Font.subheadline
  /// Counts and denominators in running text.
  static let count = Font.footnote.monospacedDigit()
  /// Numbers in tables (SF Mono).
  static let tableNumber = Font.system(.footnote, design: .monospaced)
  /// Machine codes shown for reference ("insufficient_occurrences", "E_DB_IN_ICLOUD").
  static let code = Font.system(.caption, design: .monospaced)
  static let meta = Font.caption
  static let badge = Font.caption2.weight(.bold)

  // MARK: Passages

  /// Kohinoor faces of the cascade; the M0 probe records whether each exists on the device.
  static let indicFaces = ["KohinoorDevanagari-Regular", "KohinoorGujarati-Regular"]

  /// Line height multiple and size bump for a passage.
  struct PassageMetrics: Sendable, Equatable {
    let lineHeightMultiple: CGFloat
    let sizeBump: CGFloat
  }

  /// Latin passages: line height 1.6; Indic passages (lang `hi`/`gu`, or mostly Indic text): 1.8 and 1 pt more.
  static func passageMetrics(lang: String?, text: String) -> PassageMetrics {
    isIndic(lang: lang, text: text)
      ? PassageMetrics(lineHeightMultiple: 1.8, sizeBump: 1)
      : PassageMetrics(lineHeightMultiple: 1.6, sizeBump: 0)
  }

  /// True for `hi`/`gu` text, or text whose letters are mostly Devanagari or Gujarati.
  static func isIndic(lang: String?, text: String) -> Bool {
    if lang == "hi" || lang == "gu" { return true }
    var letters = 0
    var indic = 0
    for scalar in text.unicodeScalars where scalar.properties.isAlphabetic {
      letters += 1
      if (0x0900...0x097F).contains(scalar.value) || (0x0A80...0x0AFF).contains(scalar.value) { indic += 1 }
      if letters >= 400 { break }
    }
    return letters > 0 && indic * 2 > letters
  }

  /// The passage font at a Dynamic Type size: New York with the Indic cascade.
  @MainActor
  static func passageFont(size: DynamicTypeSize, bump: CGFloat = 0) -> UIFont {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
    let base = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body, compatibleWith: traits)
    let serif = base.withDesign(.serif) ?? base
    let pointSize = base.pointSize + bump
    let cascade = indicFaces.map { UIFontDescriptor(fontAttributes: [.name: $0]) }
    let descriptor = serif.addingAttributes([.cascadeList: cascade])
    return UIFont(descriptor: descriptor, size: pointSize)
  }

  /// The passage font as a SwiftUI font.
  @MainActor
  static func passage(size: DynamicTypeSize, lang: String?, text: String) -> Font {
    Font(passageFont(size: size, bump: passageMetrics(lang: lang, text: text).sizeBump))
  }

  /// Whether a named face is installed (the probe's font row).
  @MainActor
  static func faceExists(_ postScriptName: String) -> Bool {
    UIFont(name: postScriptName, size: 17)?.fontName == postScriptName
  }
}

nonisolated extension UIContentSizeCategory {
  /// The UIKit category of a SwiftUI Dynamic Type size.
  init(_ size: DynamicTypeSize) {
    switch size {
    case .xSmall: self = .extraSmall
    case .small: self = .small
    case .medium: self = .medium
    case .large: self = .large
    case .xLarge: self = .extraLarge
    case .xxLarge: self = .extraExtraLarge
    case .xxxLarge: self = .extraExtraExtraLarge
    case .accessibility1: self = .accessibilityMedium
    case .accessibility2: self = .accessibilityLarge
    case .accessibility3: self = .accessibilityExtraLarge
    case .accessibility4: self = .accessibilityExtraExtraLarge
    case .accessibility5: self = .accessibilityExtraExtraExtraLarge
    @unknown default: self = .large
    }
  }
}
