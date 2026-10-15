// OWNER: N4
// The range-edit strip at the top of Compare (IOS-SPEC §4.10): a 64 pt time axis over both slices with draggable A and B
// brackets. A drag moves the nearer edge of a bracket in whole years; on release the slices are set (A stays the earlier
// one) and the comparison runs again. VoiceOver adjusts each bracket's edges a year at a time. Years are astronomical
// (0 = 1 BCE) and labelled historically (§13 rule 18). The axis is linear and draws no data of its own.

import ScrollsCore
import SwiftUI

struct CompareRangeStrip: View {
  let a: SliceSeed
  let b: SliceSeed
  let extent: ClosedRange<Int>
  let onChange: (SliceEdit) -> Void

  @State private var dragA: (Int, Int)?
  @State private var dragB: (Int, Int)?

  private func x(_ year: Double, _ width: CGFloat) -> CGFloat {
    let span = Double(max(1, extent.upperBound - extent.lowerBound + 1))
    return CGFloat((year - Double(extent.lowerBound)) / span) * width
  }

  private func year(_ x: CGFloat, _ width: CGFloat) -> Int {
    let span = Double(max(1, extent.upperBound - extent.lowerBound + 1))
    let y = Double(extent.lowerBound) + Double(x / max(1, width)) * span
    return min(extent.upperBound, max(extent.lowerBound, Int(y.rounded(.down))))
  }

  var body: some View {
    GeometryReader { geo in
      let w = geo.size.width
      ZStack(alignment: .topLeading) {
        Canvas { ctx, size in
          // axis and decade ticks
          let axisY = size.height - 16
          ctx.stroke(Path { p in p.move(to: CGPoint(x: 0, y: axisY)); p.addLine(to: CGPoint(x: size.width, y: axisY)) },
                     with: .color(Tokens.rule.color), lineWidth: 1)
          let span = extent.upperBound - extent.lowerBound
          let step = [1, 5, 10, 25, 50, 100, 250, 500, 1000].first { span / $0 <= 8 } ?? 1000
          var t = Int((Double(extent.lowerBound) / Double(step)).rounded(.up)) * step
          while t <= extent.upperBound {
            let tx = x(Double(t), size.width)
            ctx.stroke(Path { p in p.move(to: CGPoint(x: tx, y: axisY)); p.addLine(to: CGPoint(x: tx, y: axisY + 4)) },
                       with: .color(Tokens.ink3.color), lineWidth: 1)
            ctx.draw(Text(DateLabels.yearLabel(t)).font(.system(size: 9)).foregroundStyle(Tokens.ink3.color),
                     at: CGPoint(x: tx, y: axisY + 10))
            t += step
          }
        }
        bracket("A", base: (a.fromYear, a.toYear), years: dragA ?? (a.fromYear, a.toYear), row: 0, width: w, ink: Tokens.cyan) { dragA = $0 } end: { v in
          dragA = nil
          onChange(SliceEdit(a: SliceSeed(fromYear: v.0, toYear: v.1, filter: a.filter), b: nil))
        }
        bracket("B", base: (b.fromYear, b.toYear), years: dragB ?? (b.fromYear, b.toYear), row: 1, width: w, ink: Tokens.violet) { dragB = $0 } end: { v in
          dragB = nil
          onChange(SliceEdit(a: nil, b: SliceSeed(fromYear: v.0, toYear: v.1, filter: b.filter)))
        }
      }
      .coordinateSpace(.named(Self.space))
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(CompareCopy.stripLabel)
    .accessibilityHint(CompareCopy.yearsHint)
  }

  private static let space = "compare.strip"

  /// One bracket: a band over [lo, hi] whose nearer edge (to where the drag began) follows a horizontal drag.
  private func bracket(_ name: String, base: (Int, Int), years: (Int, Int), row: Int, width: CGFloat, ink: TokenColor,
                       moving: @escaping ((Int, Int)) -> Void, end: @escaping ((Int, Int)) -> Void) -> some View {
    let x0 = x(Double(years.0), width), x1 = x(Double(years.1 + 1), width)
    let top = CGFloat(4 + row * 20)
    return ZStack(alignment: .leading) {
      RoundedRectangle(cornerRadius: 4)
        .fill(ink.color.opacity(0.22))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(ink.color, lineWidth: 1.5))
      Text("\(name) \(DateLabels.yearRangeLabel(years.0, years.1))")
        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Tokens.ink.color)
        .lineLimit(1).fixedSize().padding(.horizontal, 4)
    }
    .frame(width: max(12, x1 - x0), height: 18)
    .offset(x: x0, y: top)
    .contentShape(Rectangle().inset(by: -10))
    .gesture(
      DragGesture(minimumDistance: 2, coordinateSpace: .named(Self.space))
        .onChanged { g in
          let startYear = year(g.startLocation.x, width)
          let nowYear = year(g.location.x, width)
          let mid = (base.0 + base.1) / 2
          var lo = base.0, hi = base.1
          if startYear <= mid { lo = min(nowYear, hi) } else { hi = max(nowYear, lo) }
          moving((lo, hi))
        }
        .onEnded { _ in end(years) }
    )
    .accessibilityElement()
    .accessibilityLabel("\(CompareCopy.bracketLabel(name)) \(DateLabels.yearRangeLabel(years.0, years.1))")
    .accessibilityAdjustableAction { dir in
      switch dir {
      case .increment: end((years.0 + 1, max(years.1, years.0 + 1)))
      case .decrement: end((years.0 - 1, years.1))
      @unknown default: break
      }
    }
    .accessibilityIdentifier("compare.bracket.\(name)")
  }
}
