// OWNER: N0
// The inspector's three detents (IOS-SPEC §4.2–§4.3) and the geometry behind them. Heights are measured from the
// bottom of the screen, so they include the home-indicator inset: on the 15 Pro Max (932 pt, insets 59/34) peek is
// 104 + 34 = 138 pt (the lanes keep 615 pt), half is 466 pt (lanes 287 pt) and large reaches up to the top safe area
// + 44 pt (829 pt). The inspector snaps with velocity and is never dismissed.

import CoreGraphics

/// Peek (search and transport), half (Then/Now/Next, drawers, results), large (reader, results with the keyboard).
nonisolated enum SheetDetent: String, Hashable, Codable, CaseIterable, Sendable {
  case peek, half, large

  /// The next taller detent, if any.
  var taller: SheetDetent? {
    switch self {
    case .peek: .half
    case .half: .large
    case .large: nil
    }
  }

  /// The next shorter detent, if any.
  var shorter: SheetDetent? {
    switch self {
    case .peek: nil
    case .half: .peek
    case .large: .half
    }
  }

  /// The detent's words for VoiceOver ("Inspector, half height").
  var spokenName: String {
    switch self {
    case .peek: "peek"
    case .half: "half height"
    case .large: "full height"
    }
  }
}

/// The container the inspector lays out in: the whole screen, with its safe-area insets.
nonisolated struct SheetLayout: Sendable, Equatable {
  /// Full container height in points, safe areas included.
  var containerHeight: CGFloat
  var safeTop: CGFloat
  var safeBottom: CGFloat
  /// The peek content height; it grows at accessibility text sizes so the peek row still fits (§4.19).
  var peekContent: CGFloat = Tokens.Geometry.peek

  /// A flick faster than this (pt/s) always moves at least one detent in its direction.
  static let flickVelocity: CGFloat = 900
  /// How far a release projects its velocity (seconds of travel).
  static let projection: CGFloat = 0.18

  /// The sheet's height from the screen bottom at a detent.
  func height(_ detent: SheetDetent) -> CGFloat {
    let peek = peekContent + safeBottom
    let large = max(peek, containerHeight - safeTop - Tokens.Geometry.largeTopGap)
    switch detent {
    case .peek: return peek
    case .half: return min(large, max(peek, (containerHeight / 2).rounded()))
    case .large: return large
    }
  }

  /// The heights a drag may reach before it rubber-bands.
  var range: ClosedRange<CGFloat> { height(.peek)...height(.large) }

  /// A dragged height with a rubber band beyond the outer detents (0.55, the Scroll's own rubber band, §4.5).
  func rubberBanded(_ h: CGFloat) -> CGFloat {
    if h < range.lowerBound { return range.lowerBound - (range.lowerBound - h) * 0.55 }
    if h > range.upperBound { return range.upperBound + (h - range.upperBound) * 0.55 }
    return h
  }

  /// The detent a drag released at `height` with vertical `velocity` (pt/s, positive = downwards) settles on: the
  /// detent nearest the projected height, and at least one step in the flick's direction for a fast flick.
  func snap(from start: SheetDetent, height: CGFloat, velocity: CGFloat) -> SheetDetent {
    let projected = height - velocity * Self.projection
    var best = SheetDetent.peek
    for d in SheetDetent.allCases where abs(self.height(d) - projected) < abs(self.height(best) - projected) {
      best = d
    }
    if velocity <= -Self.flickVelocity, best == start, let up = start.taller { return up }
    if velocity >= Self.flickVelocity, best == start, let down = start.shorter { return down }
    return best
  }
}
