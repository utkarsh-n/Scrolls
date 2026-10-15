// OWNER: N7
// The ruler (IOS-SPEC §4.3, §4.5): its ticks and labels ("1850", "500 BCE", "Apr 1931") and the modality seam's caption
// are drawn by the renderer in the top list (the same primitives the snapshot, SVG and G5 read). This view adds what the
// finger and VoiceOver need over that strip:
//   · the pill under the ruler (the tier change "Now showing yearly bins", "Simplified: …", gap and seam captions);
//   · the brushed range (long press on the ruler, then drag) with its chips: A and B set the Compare slices, Compare
//     opens it (a zoom transition from the chip), × clears the range;
//   · one accessibility element reading the visible stretch and the bins ("1850 to 2026 · Bins: decades · 1 cm ≈ 12.5
//     years").
// The playhead handle is Playhead.swift.

import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum RulerCopy {
  static let label = "Ruler"
  static let sliceA = "A"
  static let sliceB = "B"
  static let compare = "Compare"
  static let clear = "Clear the range"
  static let rangeHint = "A and B make Compare slices from this range."
  static let brushHint = "Long-press the ruler, then drag, to brush a range."
  static let compareSource = "rulerBrush"

  /// "1955–1985".
  static func range(_ lo: Int, _ hi: Int) -> String {
    let a = DayMath.ymdFromDay(lo).y, b = DayMath.ymdFromDay(hi).y
    return Tiers.yearRangeLabel(a, b)
  }

  /// "1850 to 2026 · Bins: decades · 1 cm ≈ 12.5 years".
  static func summary(lo: Double, hi: Double, tier: Tier, daysPerPoint: Double, pointsPerCentimetre: Double) -> String {
    "\(RulerScale.dayLabel(lo)) to \(RulerScale.dayLabel(hi)) · "
      + RulerScale.binCaption(tier, daysPerPoint: daysPerPoint, pointsPerCentimetre: pointsPerCentimetre)
  }
}

struct Ruler: View {
  let model: ScrollModel
  @Environment(\.zoomNamespace) private var zoomNamespace

  /// Points per physical centimetre on this screen (iPhone 15 Pro Max: 460 ppi at 3×).
  static var pointsPerCentimetre: Double { 460 / 3 / 2.54 }

  var body: some View {
    ZStack(alignment: .topLeading) {
      // the strip itself: an accessibility element over the drawn ruler
      Color.clear
        .frame(width: model.timelineWidth, height: model.rulerHeight)
        .contentShape(Rectangle())
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel(RulerCopy.label)
        .accessibilityValue(summary)
        .accessibilityHint(RulerCopy.brushHint)
      if let pill = model.pill {
        Text(pill)
          .font(Typography.chrome)
          .foregroundStyle(Tokens.ink.color)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .chromeGlass(in: Capsule())
          .frame(maxWidth: model.timelineWidth - 32)
          .fixedSize(horizontal: false, vertical: true)
          .position(x: model.timelineWidth / 2, y: model.stripHeight + 22)
          .allowsHitTesting(false)
          .transition(.opacity)
          .chromeTypeCap()
          .accessibilityIdentifier("scrollPill")
      }
      if let r = model.app.viewState.range, r.count == 2, model.brush == nil {
        rangeChips(lo: min(r[0], r[1]), hi: max(r[0], r[1]))
      }
    }
    .animation(model.reduceMotion ? nil : .easeOut(duration: 0.15), value: model.pill)
  }

  private var summary: String {
    let sc = model.axis.scale(width: model.timelineWidth)
    return RulerCopy.summary(lo: sc.loDay, hi: sc.hiDay, tier: model.drawTier, daysPerPoint: model.axis.daysPerPoint,
                             pointsPerCentimetre: Self.pointsPerCentimetre)
  }

  private func rangeChips(lo: Int, hi: Int) -> some View {
    let x0 = model.frame.x(day: Double(lo)), x1 = model.frame.x(day: Double(hi) + 1)
    let mid = min(model.timelineWidth - 110, max(110, (x0 + x1) / 2))
    let v = model.app.viewState
    return HStack(spacing: 6) {
      Text(RulerCopy.range(lo, hi))
        .font(Typography.chromeCount)
        .foregroundStyle(Tokens.ink.color)
      chip(RulerCopy.sliceA, on: v.compare?.a.years == years(lo, hi)) { model.setSlice("a", lo: lo, hi: hi) }
      chip(RulerCopy.sliceB, on: v.compare?.b.years == years(lo, hi)) { model.setSlice("b", lo: lo, hi: hi) }
      Button {
        model.openCompare(lo: lo, hi: hi)
      } label: {
        Image(systemName: "square.split.2x1").font(Typography.chrome)
      }
      .accessibilityLabel(RulerCopy.compare)
      .modifier(ZoomSource(id: RulerCopy.compareSource, namespace: zoomNamespace))
      Button {
        model.app.viewState.range = nil
      } label: {
        Image(systemName: "xmark").font(Typography.chrome)
      }
      .accessibilityLabel(RulerCopy.clear)
    }
    .foregroundStyle(Tokens.ink.color)
    .padding(.horizontal, 10)
    .frame(height: 30)
    .chromeGlass(in: Capsule(), interactive: true)
    .overlay(Capsule().strokeBorder(Tokens.cyan.opacity(0.7), lineWidth: 1))
    .position(x: mid, y: model.stripHeight + 22)
    .chromeTypeCap()
    .accessibilityElement(children: .contain)
    .accessibilityHint(RulerCopy.rangeHint)
  }

  private func years(_ lo: Int, _ hi: Int) -> [Int] { [DayMath.ymdFromDay(lo).y, DayMath.ymdFromDay(hi).y] }

  private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(Typography.chrome)
        .foregroundStyle(on ? Tokens.bg0.color : Tokens.cyan.color)
        .frame(width: 26, height: 22)
        .background(on ? Tokens.cyan.color : Color.clear, in: Capsule())
    }
    .frame(minWidth: 30, minHeight: 30)
    .accessibilityLabel("Compare slice \(title)")
    .accessibilityAddTraits(on ? .isSelected : [])
  }
}

/// A zoom-transition source when the environment carries the root's namespace.
private struct ZoomSource: ViewModifier {
  let id: String
  let namespace: Namespace.ID?

  func body(content: Content) -> some View {
    if let namespace {
      content.matchedTransitionSource(id: id, in: namespace)
    } else {
      content
    }
  }
}

extension ScrollModel {
  /// The brush ended: the range becomes the view's (`SET_RANGE`), its end snapped to the bin's end.
  func commitBrush(_ b: ClosedRange<Double>) {
    brush = nil
    let lo = Int(b.lowerBound.rounded()), hiRaw = Int(b.upperBound.rounded())
    guard frame.x(day: b.upperBound) - frame.x(day: b.lowerBound) >= 4 else { return }
    let hi = drawTier.snapToBinEnd(Double(hiRaw))
    app.viewState.range = [lo, max(lo, hi)]
    let words = "Range \(RulerScale.dayLabel(Double(lo)))–\(RulerScale.dayLabel(Double(hi))) selected. A or B makes it a Compare slice."
    showPill(words)
  }

  /// Sets Compare slice A or B from a range (`SET_COMPARE`), keeping the other slice (or the reference's default).
  func setSlice(_ slice: String, lo: Int, hi: Int) {
    var v = app.viewState
    let years = [DayMath.ymdFromDay(lo).y, DayMath.ymdFromDay(hi).y]
    let f = ViewState.formatFilter(v.f, withDefaults: false)
    let mine = ViewState.Slice(years: years, f: f)
    let fallback = defaultSlices()
    var c = v.compare ?? ViewState.Compare(a: fallback.a, b: fallback.b)
    if slice == "a" { c.a = mine } else { c.b = mine }
    v.compare = c
    app.viewState = v
    showPill("Compare slice \(slice.uppercased()): \(Tiers.yearRangeLabel(years[0], years[1]))")
  }

  /// The reference's default slices (1955–1985 and 1994–2026 on the demo; two halves of 1800–2026 elsewhere).
  func defaultSlices() -> (a: ViewState.Slice, b: ViewState.Slice) {
    let f = ViewState.formatFilter(app.viewState.f, withDefaults: false)
    if app.viewState.corpus == "demo" {
      return (ViewState.Slice(years: [1955, 1985], f: f), ViewState.Slice(years: [1994, 2026], f: f))
    }
    return (ViewState.Slice(years: [1800, 1913], f: f), ViewState.Slice(years: [1914, 2026], f: f))
  }

  /// Opens Compare: the brushed range against the other slice of the view (or the default one).
  func openCompare(lo: Int, hi: Int) {
    let a = SliceSeed(fromYear: DayMath.ymdFromDay(lo).y, toYear: DayMath.ymdFromDay(hi).y)
    let v = app.viewState
    var other: SliceSeed
    if let c = v.compare, c.b.years.count == 2, c.b.years != [a.fromYear, a.toYear] {
      other = SliceSeed(fromYear: c.b.years[0], toYear: c.b.years[1], filter: c.b.f)
    } else if let c = v.compare, c.a.years.count == 2, c.a.years != [a.fromYear, a.toYear] {
      other = SliceSeed(fromYear: c.a.years[0], toYear: c.a.years[1], filter: c.a.f)
    } else {
      let d = defaultSlices().b
      other = SliceSeed(fromYear: d.years[0], toYear: d.years[1])
      if other.fromYear <= a.toYear && other.toYear >= a.fromYear {
        let d2 = defaultSlices().a
        other = SliceSeed(fromYear: d2.years[0], toYear: d2.years[1])
      }
    }
    app.coordinator.push(.compare(CompareSeed(a, other, viewHash: v.hash)), from: RulerCopy.compareSource)
  }
}
