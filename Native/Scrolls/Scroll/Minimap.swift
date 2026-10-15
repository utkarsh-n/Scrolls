// OWNER: N7
// The minimap (IOS-SPEC §4.3; port of minimap.mjs): the folded overview — four FIXED linear regimes (Deep time,
// Classical–medieval, Early modern, Modern) joined by labelled zig-zag seams (×3.3 · ×8.9 · ×3.3), never a log axis —
// with one 3 pt row per lane (≤ 5): the lane's covered span (16% ink), its observed span from first to last
// observation (42%) and the observed bins of the loaded tiles (90%); the modality seam as a dashed line; and the visible
// range as a draggable cyan bracket (at least 4 pt wide, never outside the strip). Drag anywhere to move the Scroll
// there; double-tap to fit the data. Before a strand is pinned the rows are the corpus's collections and their spans.

import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum MinimapCopy {
  static let label = "Overview of all time, folded into four fixed linear regimes"
  static let hint = "Drag to move the Scroll; double-tap to fit the data. Swipe up or down to move a quarter of a screen."
  /// "1906 to 2026".
  static func value(_ lo: Double, _ hi: Double) -> String { "visible \(Int(lo.rounded())) to \(Int(hi.rounded()))" }
}

struct Minimap: View {
  let model: ScrollModel

  var body: some View {
    GeometryReader { proxy in
      let w = Double(proxy.size.width), h = Double(proxy.size.height)
      let folded = FoldedScale(width: w)
      ZStack(alignment: .topLeading) {
        MinimapRows(model: model, folded: folded, height: h)
        bracket(folded: folded, height: h)
      }
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { g in model.center(on: folded.day(x: min(w, max(0, Double(g.location.x))))) }
          .onEnded { _ in model.needData(settled: true) }
      )
      .simultaneousGesture(TapGesture(count: 2).onEnded { model.fit() })
      .accessibilityElement()
      .accessibilityLabel(MinimapCopy.label)
      .accessibilityValue(accessibilityValue(folded))
      .accessibilityHint(MinimapCopy.hint)
      .accessibilityAdjustableAction { d in
        let span = model.axis.scale(width: model.timelineWidth).hiDay - model.axis.scale(width: model.timelineWidth).loDay
        model.center(on: model.axis.centerDay + (d == .increment ? 0.25 : -0.25) * span)
      }
      .accessibilityIdentifier("minimap")
    }
    .background(Tokens.bg0.color)
    .overlay(alignment: .bottom) { Rectangle().fill(Tokens.rule.color).frame(height: 1) }
  }

  private func accessibilityValue(_ folded: FoldedScale) -> String {
    let sc = model.axis.scale(width: model.timelineWidth)
    return MinimapCopy.value(FoldedScale.yearOfDay(sc.loDay), FoldedScale.yearOfDay(sc.hiDay))
  }

  private func bracket(folded: FoldedScale, height: Double) -> some View {
    let sc = model.axis.scale(width: model.timelineWidth)
    let box = MinimapGeometry.bracket(x0: folded.x(day: sc.loDay), x1: folded.x(day: sc.hiDay), width: folded.width)
    return RoundedRectangle(cornerRadius: 2, style: .continuous)
      .strokeBorder(Tokens.cyan.color, lineWidth: 1.5)
      .background(Tokens.cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 2, style: .continuous))
      .frame(width: box.width, height: max(4, height - 2))
      .offset(x: box.left, y: 1)
      .allowsHitTesting(false)
  }
}

/// The regimes, seams and lane rows (they change with the data, not with the axis).
private struct MinimapRows: View {
  let model: ScrollModel
  let folded: FoldedScale
  let height: Double

  var body: some View {
    let rows = laneRows()
    let seams = model.query?.seams ?? []
    Canvas(rendersAsynchronously: false) { ctx, size in
      let h = Double(size.height)
      let small = h < 24
      for (i, r) in folded.regimes.enumerated() {
        ctx.fill(Path(CGRect(x: r.x0, y: 0, width: r.x1 - r.x0, height: h)), with: .color(i % 2 == 1 ? Tokens.bg1.color : Tokens.bg0.color))
        let font = Font.system(size: small ? 8 : 9, weight: .medium)
        let name = FoldedScale.regimeName(r.key, room: r.x1 - r.x0 - 10) { t in Double(t.count) * (small ? 4.6 : 5.2) }
        if !name.isEmpty {
          ctx.draw(Text(name).font(font).foregroundStyle(Tokens.ink3.color), at: CGPoint(x: r.x0 + 5, y: small ? 4 : 5), anchor: .leading)
        }
      }
      for s in folded.seams {
        var p = Path()
        for (k, pt) in FoldedScale.zigzag(x: s.x, y0: 0, y1: h).enumerated() {
          if k == 0 { p.move(to: CGPoint(x: pt.x, y: pt.y)) } else { p.addLine(to: CGPoint(x: pt.x, y: pt.y)) }
        }
        ctx.stroke(p, with: .color(Tokens.ink3.color), lineWidth: 1)
        ctx.draw(Text(s.label).font(.system(size: 8.5).monospacedDigit()).foregroundStyle(Tokens.ink2.color),
                 at: CGPoint(x: s.x + 6, y: h - 4), anchor: .leading)
      }
      let geo = MinimapGeometry.rows(lanes: max(1, rows.count), height: h)
      for (i, row) in rows.enumerated() {
        let y = geo.top + Double(min(i, geo.rows - 1)) * geo.rowHeight
        if let span = row.span {
          let x0 = folded.x(year: span.lowerBound), x1 = folded.x(year: span.upperBound + 1)
          ctx.fill(Path(CGRect(x: x0, y: y, width: max(1, x1 - x0), height: geo.rowHeight - 1)), with: .color(Tokens.ink.opacity(0.16)))
        }
        if let obs = row.observed {
          let x0 = folded.x(day: Double(obs.lowerBound)), x1 = folded.x(day: Double(obs.upperBound + 1))
          ctx.fill(Path(CGRect(x: x0, y: y, width: max(1, x1 - x0), height: geo.rowHeight - 1)), with: .color(Tokens.ink.opacity(0.42)))
        }
        for b in row.bins {
          let x0 = folded.x(day: Double(b.lowerBound)), x1 = folded.x(day: Double(b.upperBound + 1))
          ctx.fill(Path(CGRect(x: x0, y: y, width: max(1, x1 - x0), height: geo.rowHeight - 1)), with: .color(Tokens.ink.opacity(0.9)))
        }
      }
      for seam in seams {
        let x = (folded.x(year: Double(seam.year))).rounded() + 0.5
        var p = Path()
        p.move(to: CGPoint(x: x, y: 0))
        p.addLine(to: CGPoint(x: x, y: h))
        ctx.stroke(p, with: .color(Tokens.ink2.color), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
      }
    }
    .accessibilityHidden(true)
  }

  struct Row {
    var span: ClosedRange<Double>?
    var observed: ClosedRange<Int>?
    var bins: [ClosedRange<Int>]
  }

  /// One row per lane: the query's lanes (span, first → last) and the observed bins of the build; before a strand is
  /// pinned, the corpus's collections.
  private func laneRows() -> [Row] {
    if let q = model.query {
      let built = Dictionary(model.lanes.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
      return q.lanes.prefix(model.expandedLanes ? Tokens.Geometry.maxLanes : Tokens.Geometry.defaultLanes).map { lane in
        var span: ClosedRange<Double>?
        if let s = lane.coverage["span"]?.arrayValue, s.count == 2, let a = s[0].numberValue, let b = s[1].numberValue { span = a...max(a, b) }
        var observed: ClosedRange<Int>?
        if let a = LabelParse.parse(lane.first?.label)?.loDay, let b = LabelParse.parse(lane.last?.label)?.hiDay {
          observed = Int(a)...max(Int(a), Int(b))
        }
        var bins: [ClosedRange<Int>] = []
        for s in built[lane.key]?.strands ?? [] {
          let c = s.cols
          for i in 0..<c.count where c.state[i] == .observed { bins.append(Int(c.loDay[i])...Int(c.hiDay[i])) }
        }
        return Row(span: span, observed: observed, bins: bins)
      }
    }
    return (model.corpus?.collections ?? []).prefix(Tokens.Geometry.defaultLanes).map { c in
      let s = c.span.arrayValue
      let lo = LabelParse.parse(s?.first?.stringValue)?.yLo, hi = LabelParse.parse(s.flatMap { $0.count > 1 ? $0[1].stringValue : nil })?.yHi
      return Row(span: lo.flatMap { l in hi.map { Double(l)...Double(max(l, $0)) } }, observed: nil, bins: [])
    }
  }
}
