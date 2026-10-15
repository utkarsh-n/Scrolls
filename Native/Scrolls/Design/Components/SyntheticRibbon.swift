// OWNER: N0
// The SYNTHETIC ribbon (SPEC §1.11, §9.1, §13 rule 1; IOS-SPEC §4.3): a striped band under the TopBar, shown whenever
// any demo collection is in scope. It cannot be dismissed, and its whole sentence stays readable: the web's fix pass
// found that one line with an ellipsis hid "invented people, texts, dates and links". At the default size the sentence
// fits one 430 pt line in 14 pt; larger text wraps and the band grows; at accessibility sizes the sentence moves into
// More (N8) and the stripes stay, with the sentence still read by VoiceOver.

import SwiftUI

nonisolated enum RibbonCopy {
  /// `src/ui/main.mjs` RIBBON_TEXT, byte-equal.
  static let sentence = "SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links."
  /// The short label left on the stripes at accessibility sizes.
  static let short = "SYNTHETIC"
}

struct SyntheticRibbon: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .caption2) private var fontSize: CGFloat = 9

  var body: some View {
    let full = !typeSize.isAccessibilitySize
    Text(full ? RibbonCopy.sentence : RibbonCopy.short)
      .font(.system(size: min(fontSize, 13), weight: .semibold).width(.condensed))
      .tracking(0.2)
      .foregroundStyle(Tokens.syn.color)
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 8)
      .padding(.vertical, 1)
      .frame(maxWidth: .infinity, minHeight: Tokens.Geometry.ribbon)
      .background {
        ZStack {
          Tokens.bg1.color
          StripeFill(stripe: Tokens.Pattern.synStripe)
        }
      }
      .overlay(alignment: .bottom) { Rectangle().fill(Tokens.rule.color).frame(height: 1).accessibilityHidden(true) }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(RibbonCopy.sentence)
      .accessibilityAddTraits(.isStaticText)
      .accessibilityIdentifier("syntheticRibbon")
  }
}
