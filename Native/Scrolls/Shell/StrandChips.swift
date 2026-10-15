// OWNER: N8
// The strand chips of the TopBar (IOS-SPEC §4.2–§4.3): one chip per pinned strand — its glyph (● ■ ▲ ◆: glyphs follow
// position) and its words, with ✕ to unpin — in the TopBar's GlassEffectContainer, morphing with `glassEffectID` when a
// strand arrives or leaves (the root screen's only morph: it means "this is now on the Scroll"). In landscape the chips
// are glyphs only, and a tap shows the words. Words come from the Scroll's resolved labels, else the engine.

import ScrollsContracts
import ScrollsCore
import SwiftUI

nonisolated enum StrandCopy {
  static let pinned = "Pinned strands"
  static func unpin(_ label: String) -> String { "Unpin \(label)" }
  static func expression(_ id: Int) -> String { "expression \(id)" }
  /// `STRAND_GLYPH_CHARS`.
  static let glyphs = ["circle": "●", "square": "■", "triangle": "▲", "diamond": "◆"]
}

struct StrandChips: View {
  let model: AppModel
  let namespace: Namespace.ID
  var glyphsOnly = false
  @State private var labels: [String: String] = [:]
  @State private var shownLabel: String?

  var body: some View {
    let strands = model.viewState.strands
    HStack(spacing: 6) {
      ForEach(Array(strands.enumerated()), id: \.element) { i, s in
        chip(s, index: i)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(StrandCopy.pinned)
    .task(id: strands.map(\.id.text).joined(separator: ",")) { await resolveLabels(strands) }
  }

  private func label(_ s: ViewState.Strand) -> String {
    model.experience.bridge.strandLabels[s.id.text] ?? labels[s.id.text]
      ?? (s.type == "expression" ? StrandCopy.expression(Int(s.id.text) ?? 0) : s.id.text)
  }

  private func chip(_ s: ViewState.Strand, index: Int) -> some View {
    let words = label(s)
    let glyph = StrandCopy.glyphs[s.glyph] ?? "●"
    return HStack(spacing: 5) {
      Text(verbatim: glyph).foregroundStyle(Tokens.ink.color).accessibilityHidden(true)
      if !glyphsOnly || shownLabel == s.id.text {
        Text(words).lineLimit(1).truncationMode(.middle).foregroundStyle(Tokens.ink.color)
      }
      Button {
        model.experience.unpin(at: index)
      } label: {
        Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(Tokens.ink3.color)
      }
      .buttonStyle(.plain)
      .frame(minWidth: 24, minHeight: 32)
      .contentShape(Rectangle())
      .accessibilityLabel(StrandCopy.unpin(words))
    }
    .font(Typography.chrome)
    .padding(.leading, 10)
    .padding(.trailing, 4)
    .frame(minHeight: 32)
    .glassEffect(.regular, in: Capsule())
    .glassEffectID(s.id.text, in: namespace)
    .onTapGesture { if glyphsOnly { shownLabel = shownLabel == s.id.text ? nil : s.id.text } }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(glyph) \(words)")
    .accessibilityIdentifier("strandChip.\(s.id.text)")
  }

  /// Expression strands the Scroll has not labelled: their surface from the engine.
  private func resolveLabels(_ strands: [ViewState.Strand]) async {
    guard let atlas = model.atlas else { return }
    for s in strands where s.type == "expression" && labels[s.id.text] == nil && model.experience.bridge.strandLabels[s.id.text] == nil {
      guard case .number(let n) = s.id, let e = try? await atlas.expression(ExpressionID(n), corpus: nil) else { continue }
      labels[s.id.text] = e.expression.surface
    }
  }
}
