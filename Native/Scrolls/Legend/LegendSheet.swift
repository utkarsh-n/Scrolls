// OWNER: N8
// The Legend sheet (IOS-SPEC §4.7, §4.22; `timeline/legend.mjs` full legend; `evidence-style.mjs` LEGEND_ROWS). First line,
// always: "Lane order is a sorting choice (first observed), not a scale of meaning." Then every row of the shared legend
// — evidence statuses, review overlays, bin states and flags, role hues — each with a swatch drawn from the same style
// the Scroll uses (`EvidenceStyle.legendRows`), so a legend row cannot disagree with a mark; then the coverage step
// classes and the honesty encodings the phone adds (the modality seam, washes, caps, shelves).

import ScrollsCore
import SwiftUI

nonisolated enum LegendCopy {
  static let title = "Legend"
  static let done = "Done"
  static let evidence = "Evidence (line style is evidence)"
  static let overlay = "Reviews and flags (the line pattern never changes)"
  static let bins = "Bins"
  static let role = "Role hues (always backed by a pattern or a word)"
  static let coverage = "Coverage track"
  static let coverageNote = "Grey step classes: 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000). Hatched = no coverage; dotted = pending."
  static let marks = "Marks on the Scroll"
  static let caps = "● ■ ▲ ◆ at the first observation, a 1 pt tick at the last; ◁ ▷ may extend beyond our record"
  static let wash = "Wash: a record dated more widely than one bin; never added to bars or rates"
  static let seam = "The modality seam (1928): full text ends; titles continue. A 1 pt line, never hidden."
  static let shelves = "⊘ undated and ⇥ scheduled: outside the chronology, listed on the lane's shelf"
  static let selection = "Cyan: the current selection and navigation only"
  static let syntheticRibbon = "The SYNTHETIC ribbon: demo material is in view. It cannot be dismissed."
}

extension RootSlots {
  func legend() -> some View { LegendSheet() }
}

struct LegendSheet: View {
  @Environment(\.dismiss) private var dismiss

  private static let groups: [(key: String, title: String)] = [
    ("evidence", LegendCopy.evidence), ("overlay", LegendCopy.overlay), ("bins", LegendCopy.bins), ("role", LegendCopy.role),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(Copy.laneOrderNote)
            .font(Typography.cardBody.weight(.medium))
            .foregroundStyle(Tokens.ink.color)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("legendOrderNote")
          ForEach(Self.groups, id: \.key) { g in
            section(g.title) {
              ForEach(EvidenceStyle.legendRows.filter { $0.group == g.key }, id: \.key) { row in
                LegendLine(row: row)
              }
            }
          }
          section(LegendCopy.marks) {
            ForEach([LegendCopy.caps, LegendCopy.wash, LegendCopy.seam, LegendCopy.shelves, LegendCopy.selection, LegendCopy.syntheticRibbon],
                    id: \.self) { line in
              Text(line).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
            }
          }
          section(LegendCopy.coverage) {
            HStack(spacing: 2) {
              ForEach(0..<5, id: \.self) { i in
                Rectangle().fill(Tokens.ink.opacity(0.08 + 0.14 * Double(i))).frame(height: 10)
              }
            }
            .accessibilityHidden(true)
            Text(LegendCopy.coverageNote).font(Typography.meta).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(16)
      }
      .background(Tokens.bg0.color)
      .navigationTitle(LegendCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(LegendCopy.done) { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("legendSheet")
  }

  private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
      content()
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
  }
}

/// One legend row: its swatch, label and description.
struct LegendLine: View {
  let row: ScrollsCore.LegendRow

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      LegendSwatch(style: row.style).frame(width: 34, height: 16).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
      VStack(alignment: .leading, spacing: 1) {
        Text(row.label).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).fixedSize(horizontal: false, vertical: true)
        if !row.description.isEmpty {
          Text(row.description).font(Typography.meta).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// A swatch drawn from the shared style: an arc's dash, width, hue and endpoint; a bin's mark, fill and pattern; a hue.
struct LegendSwatch: View {
  let style: ScrollsCore.LegendRow.Style

  var body: some View {
    Canvas { ctx, size in
      let mid = size.height / 2
      switch style {
      case .edge(let e):
        let colour = (Palette.color(named: e.hue) ?? Tokens.ink2.color).opacity(e.opacity)
        var line = Path()
        line.move(to: CGPoint(x: 2, y: mid))
        line.addLine(to: CGPoint(x: size.width - 8, y: mid))
        ctx.stroke(line, with: .color(colour), style: StrokeStyle(lineWidth: max(1, e.width), dash: e.dash.map { CGFloat($0) }))
        let end = CGRect(x: size.width - 8, y: mid - 3, width: 6, height: 6)
        switch e.endpoint {
        case .dot: ctx.fill(Path(ellipseIn: end), with: .color(colour))
        case .square: ctx.stroke(Path(end), with: .color(colour), lineWidth: 1)
        case .question: ctx.draw(Text(verbatim: "?").font(.system(size: 9, weight: .bold)).foregroundStyle(colour), at: CGPoint(x: end.midX, y: mid))
        }
        if e.strike {
          var s = Path()
          s.move(to: CGPoint(x: 8, y: mid + 4))
          s.addLine(to: CGPoint(x: size.width - 14, y: mid - 4))
          ctx.stroke(s, with: .color(colour), lineWidth: 1)
        }
      case .bin(let b):
        let rect = CGRect(x: 3, y: 3, width: size.width - 6, height: size.height - 6)
        switch b.mark {
        case .rect:
          let fill = (b.fill.flatMap(Palette.color(named:)) ?? Tokens.ink.color).opacity(b.opacity)
          ctx.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(fill))
          if let outline = b.outline.flatMap(Palette.color(named:)) {
            ctx.stroke(Path(roundedRect: rect, cornerRadius: 2), with: .color(outline), lineWidth: 1)
          }
        case .baseline:
          var p = Path()
          p.move(to: CGPoint(x: 2, y: mid))
          p.addLine(to: CGPoint(x: size.width - 2, y: mid))
          ctx.stroke(p, with: .color(Tokens.ink3.color), style: StrokeStyle(lineWidth: 1, dash: [1, 3]))
        case .tick:
          ctx.stroke(Path(CGRect(x: size.width / 2 - 1, y: 3, width: 1.5, height: size.height - 6)), with: .color(Tokens.ink2.color), lineWidth: 1)
        case .none:
          break
        }
        if b.pattern == "hatch" || b.pattern == "stripes" || b.pattern == "syn" {
          var p = Path()
          var x: CGFloat = -size.height
          while x < size.width {
            p.move(to: CGPoint(x: x, y: size.height))
            p.addLine(to: CGPoint(x: x + size.height, y: 0))
            x += b.pattern == "hatch" ? 6 : 4
          }
          ctx.stroke(p, with: .color(Tokens.ink.opacity(b.pattern == "hatch" ? 0.3 : 0.4)), lineWidth: 1)
        } else if b.pattern == "dots" {
          for x in stride(from: 3.0, to: size.width, by: 6) {
            for y in stride(from: 3.0, to: size.height, by: 6) {
              ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(Tokens.ink.opacity(0.5)))
            }
          }
        }
        if let glyph = b.superscript ?? b.glyph {
          ctx.draw(Text(verbatim: glyph).font(.system(size: 9)).foregroundStyle(Tokens.bg0.color), at: CGPoint(x: size.width - 7, y: 6))
        }
      case .hue(let name):
        ctx.fill(Path(ellipseIn: CGRect(x: size.width / 2 - 5, y: mid - 5, width: 10, height: 10)),
                 with: .color(Palette.color(named: name) ?? Tokens.ink2.color))
      case .none:
        break
      }
    }
    .accessibilityHidden(true)
  }
}
