// OWNER: N6
// A saved view's thumbnail: a schematic of what the view holds, drawn from its saved state — not a picture of data.
// The axis runs 1500–2030 (wider when the view's slices reach outside it); Compare's slices A and B are tinted bands,
// a brushed range is outlined, the vantage is the cyan line, and one dot per strand sits at the top. A synthetic view
// carries the SYNTHETIC stripes. Nothing in it is a count, so nothing in it can be mistaken for one.

import ScrollsCore
import SwiftUI

struct ViewThumbnail: View {
  let preview: ViewPreview?
  let synthetic: Bool

  var body: some View {
    Canvas { ctx, size in
      let frame = CGRect(origin: .zero, size: size)
      ctx.fill(Path(roundedRect: frame, cornerRadius: 6), with: .color(Tokens.bg2.color))
      if synthetic {
        var y: CGFloat = -size.width
        while y < size.height {
          var p = Path()
          p.move(to: CGPoint(x: 0, y: y))
          p.addLine(to: CGPoint(x: size.width, y: y + size.width))
          ctx.stroke(p, with: .color(Tokens.syn.color.opacity(0.16)), lineWidth: 2)
          y += 7
        }
      }
      guard let preview else { return }
      var lo = 1500, hi = 2030
      for ys in preview.compare + (preview.range.map { [$0] } ?? []) where ys.count == 2 {
        lo = min(lo, ys[0])
        hi = max(hi, ys[1])
      }
      let span = CGFloat(max(1, hi - lo))
      func x(_ year: Int) -> CGFloat { 4 + (size.width - 8) * CGFloat(year - lo) / span }
      let base = size.height - 10
      var axis = Path()
      axis.move(to: CGPoint(x: 4, y: base))
      axis.addLine(to: CGPoint(x: size.width - 4, y: base))
      ctx.stroke(axis, with: .color(Tokens.rule.color), lineWidth: 1)
      for (i, ys) in preview.compare.enumerated() where ys.count == 2 {
        let r = CGRect(x: x(ys[0]), y: 12, width: max(2, x(ys[1]) - x(ys[0])), height: base - 12)
        ctx.fill(Path(r), with: .color((i == 0 ? Tokens.amber : Tokens.violet).color.opacity(0.28)))
      }
      if let r = preview.range, r.count == 2 {
        let rect = CGRect(x: x(r[0]), y: 10, width: max(2, x(r[1]) - x(r[0])), height: base - 10)
        ctx.stroke(Path(rect), with: .color(Tokens.ink2.color), lineWidth: 1)
      }
      if let v = preview.vantageYear, v >= lo, v <= hi {
        var line = Path()
        line.move(to: CGPoint(x: x(v), y: 8))
        line.addLine(to: CGPoint(x: x(v), y: base + 4))
        ctx.stroke(line, with: .color(Tokens.cyan.color), lineWidth: 1.5)
      }
      for i in 0..<min(preview.strands, 6) {
        let dot = CGRect(x: 6 + CGFloat(i) * 8, y: 3, width: 5, height: 5)
        ctx.fill(Path(ellipseIn: dot), with: .color(Tokens.ink.color))
      }
    }
    .accessibilityHidden(true)
  }
}
