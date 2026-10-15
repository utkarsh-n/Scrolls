// OWNER: N0
// Glass is chrome; data is opaque (IOS-SPEC §4.1 rule 3, §4.22). Liquid Glass is used only for controls that float
// over the Scroll: TopBar chips, the status chip and More, the inspector at partial heights, the transport capsule,
// coach marks, pills and toasts, and lane chips on the header strip. Passages, gate cards, edge cards and Compare
// panels sit on opaque bg-0/bg-1, so evidence is never refracted. Reduce Transparency makes glass opaque (system).

import LabKitUI
import SwiftUI

extension View {
  /// Liquid Glass for chrome floating over the Scroll, in `shape`. `interactive` adds the press response for controls.
  func chromeGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
    glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
  }

  /// Chrome over the Scroll stops growing at `.accessibility1` and offers the Large Content Viewer instead (§4.19).
  func chromeTypeCap() -> some View {
    dynamicTypeSize(...LabMetrics.stageChromeTypeCap)
      .accessibilityShowsLargeContentViewer()
  }

  /// An opaque evidence surface: bg-1 with a hairline rule. Gate, error and edge cards and every data panel.
  func opaquePanel(cornerRadius: CGFloat = Tokens.Radius.card) -> some View {
    modifier(OpaquePanel(cornerRadius: cornerRadius))
  }

  /// The dashed 1 pt frame around any panel that shows synthetic (demo) material (§4.7 "SYNTHETIC everywhere").
  func syntheticFrame(_ isSynthetic: Bool, cornerRadius: CGFloat = Tokens.Radius.card) -> some View {
    overlay {
      if isSynthetic {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Tokens.syn.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
          .accessibilityHidden(true)
      }
    }
  }
}

/// bg-1 fill, rule hairline (raised under Increase Contrast), continuous corners.
private struct OpaquePanel: ViewModifier {
  let cornerRadius: CGFloat
  @Environment(\.colorSchemeContrast) private var contrast

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    content
      .background(Tokens.bg1.color, in: shape)
      .overlay { shape.strokeBorder(Tokens.rule.opacity(Palette.hairline(contrast)), lineWidth: 1) }
  }
}
