// OWNER: N0
// Evidence badges (SPEC §8.7, D7; `evidence-style.mjs` BADGES): the word that backs every line pattern — DOC, DOC*,
// CALC, PROP, PROP · CUE — and the overlays SYN, ✎, ✓, ✕, ⚖, ⚠. Evidence is never colour alone: the badge's frame
// repeats the line pattern of its status (solid, dashed 6/4, dotted 1/3), its word is the status, and VoiceOver reads
// the badge's title. Words and meanings come from the generated `Copy.badges`, byte-equal with the reference.

import ScrollsCore
import SwiftUI

/// One badge word with its pattern-backed frame.
struct EvidenceBadge: View {
  /// A key of `Copy.badges` ("DOC", "CALC", "PROP · CUE", "SYN", "⚠", …).
  let key: String

  init(_ key: String) {
    self.key = key
  }

  /// The badges a relationship's style shows, in reading order: the status word, then ⚠, ✎, the review overlay, SYN.
  static func keys(for style: ArcStyle) -> [String] {
    var keys = [style.conflict ? String(style.badge.dropLast(2)) : style.badge]
    if style.conflict { keys.append("⚠") }
    if style.human { keys.append("✎") }
    switch style.overlay {
    case .check: keys.append("✓")
    case .cross: keys.append("✕")
    case .scales: keys.append("⚖")
    case nil: break
    }
    if style.synthetic { keys.append("SYN") }
    return keys
  }

  private var badge: Badge? { Copy.badges[key] }

  /// The frame repeats the evidence line pattern; overlays get a plain hairline.
  private var dash: [CGFloat] {
    switch key {
    case "CALC": [3, 2]
    case "PROP", "PROP · CUE": [1, 2]
    default: []
    }
  }

  private var foreground: Color {
    switch key {
    case "SYN": Tokens.syn.color
    case "⚠", "✕": Tokens.danger.color
    default: Tokens.ink2.color
    }
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 3, style: .continuous)
    Text(verbatim: badge?.text ?? key)
      .font(Typography.badge)
      .foregroundStyle(foreground)
      .padding(.horizontal, 5)
      .padding(.vertical, 1.5)
      .background {
        if key == "SYN" { StripeFill(stripe: Tokens.Pattern.synStripe).clipShape(shape) }
      }
      .overlay { shape.strokeBorder(foreground.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: dash)) }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(badge?.title ?? key)
      .accessibilityHint(badge?.description ?? "")
  }
}

/// A repeating stripe in screen space (`Tokens.Stripe`): the syn-stripe, the "no sources" hatch, estimated stripes.
/// Used by chrome and cards; the Scroll's own patterns are drawn by its renderer from the same tokens.
struct StripeFill: View {
  let stripe: Tokens.Stripe

  var body: some View {
    Canvas(rendersAsynchronously: false) { context, size in
      let colour = stripe.ink.opacity(stripe.alpha)
      // CSS angles: 45° rises to the right ("/"), 135° falls to the right ("\").
      let rising = stripe.angle.truncatingRemainder(dividingBy: 180) < 90
      let span = size.width + size.height
      var x = -size.height
      var path = Path()
      while x < span {
        let a = CGPoint(x: x, y: rising ? size.height : 0)
        let b = CGPoint(x: x + size.height, y: rising ? 0 : size.height)
        path.move(to: a)
        path.addLine(to: b)
        x += stripe.period * 2.squareRoot()
      }
      context.stroke(path, with: .color(colour), lineWidth: stripe.line)
    }
    .accessibilityHidden(true)
  }
}
