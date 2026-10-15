// OWNER: N0
// The persistent inspector (IOS-SPEC §4.2): a custom overlay inside the root screen, not a system sheet, so pushed
// destinations cover it naturally and the one-presentation rule holds. Three detents (peek, half, large), a drag
// handle, a velocity snap; it is never dismissed. Only touches inside its own frame reach it: the empty space above it
// is not hit-testable, so the Scroll receives every touch above the sheet (no `presentationBackgroundInteraction`).
// Its height is reported through `occluded` so the Scroll keeps its content above it. At partial heights the
// background is Liquid Glass; at large it is opaque bg-1 (a reading surface). Content panels are opaque (N8).

import SwiftUI

nonisolated enum InspectorCopy {
  static let handle = "Inspector"
  static let handleHint = "Swipe up or down to change its height."
}

struct InspectorSheet<Content: View>: View {
  @Binding private var detent: SheetDetent
  @Binding private var occluded: CGFloat
  private let content: Content

  /// The live drag translation (positive = downwards) while the handle is dragged.
  @State private var drag: CGFloat = 0
  @State private var dragging = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize

  init(detent: Binding<SheetDetent>, occluded: Binding<CGFloat>, @ViewBuilder content: () -> Content) {
    _detent = detent
    _occluded = occluded
    self.content = content()
  }

  var body: some View {
    GeometryReader { proxy in
      let layout = SheetLayout(
        containerHeight: proxy.size.height + proxy.safeAreaInsets.top + proxy.safeAreaInsets.bottom,
        safeTop: proxy.safeAreaInsets.top, safeBottom: proxy.safeAreaInsets.bottom,
        peekContent: typeSize.isAccessibilitySize ? Tokens.Geometry.peek + 40 : Tokens.Geometry.peek)
      let rest = layout.height(detent)
      let height = dragging ? layout.rubberBanded(rest - drag) : rest
      panel(layout: layout, height: height)
        .frame(height: height, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .offset(y: proxy.safeAreaInsets.bottom)
        .onChange(of: rest, initial: true) { _, h in occluded = h }
    }
  }

  private func panel(layout: SheetLayout, height: CGFloat) -> some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Geometry.sheetCornerRadius, style: .continuous)
    let opaque = detent == .large && !dragging
    return VStack(spacing: 0) {
      handle(layout: layout)
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.bottom, layout.safeBottom)
        .clipped()
    }
    .background {
      if opaque {
        shape.fill(Tokens.bg1.color)
          .overlay { shape.strokeBorder(Tokens.rule.color, lineWidth: 1) }
      }
    }
    .chromeGlassIf(!opaque, in: shape)
    .contentShape(shape)
    .accessibilityElement(children: .contain)
    // VoiceOver's escape (two-finger Z) lowers the sheet one detent (§4.19).
    .accessibilityAction(.escape) { if let down = detent.shorter { settle(down) } }
    .accessibilityIdentifier("inspector")
  }

  private func handle(layout: SheetLayout) -> some View {
    Capsule()
      .fill(Tokens.ink3.color)
      .frame(width: 38, height: 5)
      .frame(maxWidth: .infinity, minHeight: Tokens.Geometry.sheetHandleHit)
      .contentShape(Rectangle())
      .gesture(dragGesture(layout: layout))
      .onTapGesture { settle(detent == .peek ? .half : .peek) }
      .accessibilityElement()
      .accessibilityLabel(InspectorCopy.handle)
      .accessibilityValue(detent.spokenName)
      .accessibilityHint(InspectorCopy.handleHint)
      .accessibilityAdjustableAction { direction in
        switch direction {
        case .increment: if let up = detent.taller { settle(up) }
        case .decrement: if let down = detent.shorter { settle(down) }
        @unknown default: break
        }
      }
      .accessibilityIdentifier("inspectorHandle")
  }

  private func dragGesture(layout: SheetLayout) -> some Gesture {
    DragGesture(minimumDistance: 2, coordinateSpace: .global)
      .onChanged { value in
        dragging = true
        drag = value.translation.height
      }
      .onEnded { value in
        let released = layout.rubberBanded(layout.height(detent) - value.translation.height)
        let target = layout.snap(from: detent, height: released, velocity: value.velocity.height)
        dragging = false
        drag = 0
        settle(target)
      }
  }

  private func settle(_ target: SheetDetent) {
    if reduceMotion {
      detent = target
    } else {
      withAnimation(Tokens.Motion.detentSnap) { detent = target }
    }
  }
}

extension View {
  /// Glass in `shape` when `on`; otherwise the view unchanged (the opaque background is drawn by the caller).
  @ViewBuilder
  fileprivate func chromeGlassIf<S: Shape>(_ on: Bool, in shape: S) -> some View {
    if on { chromeGlass(in: shape) } else { self }
  }
}
