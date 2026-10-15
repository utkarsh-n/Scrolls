// OWNER: N4
// Machine tone's availability on this device (IOS-SPEC §4.10, SPEC §4.10): Apple's NaturalLanguage runs in process —
// the phone has no `scrolls-nl` adapter — so the Tone gate asks NLTagger which languages have a sentiment model here.
// When English has none the gate card says so in the spec's words, and the opt-in system download of Apple's language
// assets (ΔS-17) is offered by the UI, never started by this module.

import Foundation
import NaturalLanguage
import ScrollsAnalysis

/// What NaturalLanguage offers for machine tone on this device.
public enum NLAvailability {
  /// The languages probed for a sentiment model (the corpus languages of SPEC §4.3).
  static let probed: [(code: String, language: NLLanguage)] = [
    ("en", .english), ("fr", .french), ("es", .spanish), ("de", .german), ("it", .italian), ("pt", .portuguese),
    ("hi", .hindi), ("gu", .gujarati),
  ]

  /// The gate card's sentence when English sentiment is missing.
  #if os(iOS)
    public static let missing = "Tone needs Apple's English sentiment model, which is not on this phone."
  #else
    public static let missing = "Tone needs Apple's English sentiment model, which is not on this Mac."
  #endif

  /// Languages whose paragraphs NLTagger can score here.
  public static func sentimentLanguages() -> [String] {
    probed.filter { NLTagger.availableTagSchemes(for: .paragraph, language: $0.language).contains(.sentimentScore) }.map(\.code)
  }

  /// The availability Compare's tone block reads (probed once per process).
  public static let current: ToneAvailability = {
    let langs = sentimentLanguages()
    return ToneAvailability(installed: langs.contains("en"), sentimentLanguages: langs, adapter: "Apple NaturalLanguage (in process)",
                            missingReason: missing)
  }()
}
