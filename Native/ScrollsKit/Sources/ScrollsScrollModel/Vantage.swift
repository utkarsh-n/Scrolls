// OWNER: N0
// The vantage predicate, defined once (IOS-SPEC §4.6, §4.23, §8.4.7). The reference applies it while building the
// display list (`display.mjs` `vantageState` and `gate()`); the phone builds the list once without a vantage, stores
// `revealDay = hiDay` in every primitive, and applies this same predicate in the shader, the hit grid and VoiceOver.
// `DisplayList.visible(at:)` and `HitGrid.hit(_:tolerance:vantage:)` are implemented by N7 on top of `visibility`.

import ScrollsCore

/// Strict hides what the vantage has not reached; context draws it ghosted (SPEC §1.9).
public enum VantageMode: Sendable, Hashable, Codable {
  case strict, context
}

/// The reading clock: "as of" a day, in strict or context mode.
public struct Vantage: Sendable, Equatable, Hashable, Codable {
  /// The last day the reader has reached (a bin end while scrubbing, §4.6).
  public var day: Int32
  public var mode: VantageMode

  public init(day: Int32, mode: VantageMode) {
    self.day = day
    self.mode = mode
  }

  /// The vantage of a view state (`v=` in the hash). Days outside `Int32` cannot occur: the view state clamps
  /// them to 10000 BCE … 2100 CE.
  public init(_ v: ViewState.Vantage) {
    self.init(day: Int32(clamping: v.day), mode: v.strict ? .strict : .context)
  }
}

/// How a primitive dated up to `revealDay` is drawn at a vantage (`display.mjs` `vantageState`).
public enum Visibility: Sendable, Hashable {
  case show, ghost, hide

  /// Opacity of a ghosted primitive in context mode (`display.mjs` `GHOST_ALPHA`).
  public static let ghostOpacity: Float = 0.15
}

/// `revealDay` of primitives that describe the archive rather than an observation (coverage, hatches, absence,
/// the seam, lane bands): no vantage ever hides them (SPEC §1.9).
public let alwaysRevealed: Int32 = .min

/// The vantage predicate, equal to `display.mjs` `vantageState(hiDay, vantage)`: shown when there is no vantage or
/// the primitive's latest day is on or before it; otherwise hidden in strict mode and ghosted in context mode.
public func visibility(revealDay: Int32, at v: Vantage?) -> Visibility {
  guard let v, revealDay > v.day else { return .show }
  return v.mode == .strict ? .hide : .ghost
}
