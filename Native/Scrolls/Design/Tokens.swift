// OWNER: N0
// Design tokens: SPEC §8.7 verbatim (public/styles/tokens.css), plus the phone geometry of IOS-SPEC §4.3–§4.4 and
// the motion rules of §4.1/§4.6. Dark only: a reading instrument, an observatory at night. Hue is reserved for roles
// (cyan = selection and navigation, amber = earlier material, violet = reinterpretation) and is always backed by a
// pattern or a word, because the three hues differ by only 1.1–1.2:1 in luminance.

import SwiftUI

/// A gamma-encoded sRGB colour token, kept as its hex value so the tokens read exactly like tokens.css.
nonisolated struct TokenColor: Sendable, Hashable {
  let hex: UInt32

  init(_ hex: UInt32) { self.hex = hex }

  var red: Double { Double((hex >> 16) & 0xFF) / 255 }
  var green: Double { Double((hex >> 8) & 0xFF) / 255 }
  var blue: Double { Double(hex & 0xFF) / 255 }

  /// The token as a SwiftUI colour.
  var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: 1) }

  /// The token at an opacity (the rgba() tints of tokens.css).
  func opacity(_ alpha: Double) -> Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }
}

/// The Scrolls colour, pattern, geometry and motion tokens.
nonisolated enum Tokens {
  // MARK: Colours (SPEC §8.7)

  /// Deep charcoal canvas; also the launch colour (§4.17).
  static let bg0 = TokenColor(0x0E1013)
  /// Panels; alternate lane band.
  static let bg1 = TokenColor(0x161A20)
  /// Raised surfaces, popovers.
  static let bg2 = TokenColor(0x1F242C)
  /// Pressed and hover states.
  static let bg3 = TokenColor(0x2A303A)
  /// Non-text rules and lane-banding edges (decorative, 1.67:1).
  static let rule = TokenColor(0x343A45)
  /// Warm ivory: text and bars (15.3:1 on bg-0).
  static let ink = TokenColor(0xEDE6D6)
  /// Secondary text (9.4:1); also the role hue `ivory2` (similarity, kindred, counterpart).
  static let ink2 = TokenColor(0xBDB5A5)
  /// Meta text (5.4:1 on bg-0, 4.95:1 on bg-1); never on bg-2 or bg-3.
  static let ink3 = TokenColor(0x8E887B)
  /// Selection and navigation only: playhead, focus, selected marks, range, minimap bracket.
  static let cyan = TokenColor(0x4FD8E8)
  /// Historical reference: arcs to earlier material, Then, deep-time bands, CUE.
  static let amber = TokenColor(0xE8A84A)
  /// Reinterpretation: feedback arcs, Now, the re-read halo, hypotheses.
  static let violet = TokenColor(0xB59AF5)
  /// Date conflicts, errors, rejected.
  static let danger = TokenColor(0xF2826F)
  /// Job success only.
  static let ok = TokenColor(0x7BD389)
  /// SYNTHETIC ribbon and badge text (deliberately not a semantic hue).
  static let syn = TokenColor(0xD9CFB8)

  // MARK: Tints and alphas (tokens.css)

  enum Alpha {
    /// Selection glow: cyan 2 pt plus a 6 pt halo at 20% (§4.7).
    static let cyanHalo = 0.20
    static let amberTint = 0.14
    static let violetTint = 0.14
    static let dangerTint = 0.14
    /// Precision wash band (§4.7).
    static let wash = 0.18
    /// A ghosted primitive in context mode.
    static let ghost = 0.15
    /// The previous tier while new tiles load ("dimmed 40%", §4.18).
    static let staleTier = 0.6
    static let scrim = 0.72
    /// A highlighted match in a passage (cyan 25% background plus an underline, §4.8).
    static let matchHighlight = 0.25
  }

  // MARK: Patterns (tokens.css; drawn in screen space so they never stretch under zoom)

  /// A repeating stripe: `repeating-linear-gradient(angle, ink·alpha 0 line, transparent line period)`.
  struct Stripe: Sendable, Hashable {
    /// CSS gradient angle in degrees (45 = hatch "/", 135 = stripes "\").
    let angle: Double
    let ink: TokenColor
    let alpha: Double
    /// Painted width of each stripe, in points.
    let line: Double
    /// Distance between stripe starts, in points.
    let period: Double
  }

  /// A dot grid: `radial-gradient(ink·alpha radius, transparent) 0 0 / pitch pitch`.
  struct Dots: Sendable, Hashable {
    let ink: TokenColor
    let alpha: Double
    let radius: Double
    let pitch: Double
  }

  enum Pattern {
    /// `--syn-stripe`: synthetic material.
    static let synStripe = Stripe(angle: 135, ink: Tokens.syn, alpha: 0.16, line: 3, period: 8)
    /// `--hatch-none`: uncovered, "no sources" (6 pt pitch, §4.7).
    static let hatchNone = Stripe(angle: 45, ink: Tokens.ink, alpha: 0.10, line: 1, period: 6)
    /// `--hatch-low`: the low-coverage underlay.
    static let hatchLow = Stripe(angle: 45, ink: Tokens.ink, alpha: 0.06, line: 1, period: 4)
    /// `--stripes-est`: mostly estimated dates.
    static let stripesEstimated = Stripe(angle: 135, ink: Tokens.ink, alpha: 0.22, line: 1, period: 3)
    /// `--dots-pending`: "indexing — not yet looked".
    static let dotsPending = Dots(ink: Tokens.ink, alpha: 0.22, radius: 1, pitch: 6)
  }

  // MARK: Geometry (points; §4.3 portrait 430 × 932, §4.4 landscape)

  enum Geometry {
    static let topBar: CGFloat = 44
    static let ribbon: CGFloat = 14
    static let minimap: CGFloat = 24
    static let ruler: CGFloat = 28
    static let coverage: CGFloat = 10
    static let laneHeader: CGFloat = 18
    static let slot: CGFloat = 24
    static let slotCompact: CGFloat = 16
    static let slotComfortable: CGFloat = 32
    static let arcRoom: CGFloat = 10
    /// Lanes shown by default; "+n more lanes" expands in place up to 10.
    static let defaultLanes = 5
    static let maxLanes = 10

    /// The inspector's peek detent: the search field (44) and the transport row (44) plus margins.
    static let peek: CGFloat = 104
    /// The large detent stops this far below the top safe area.
    static let largeTopGap: CGFloat = 44
    static let sheetCornerRadius: CGFloat = 28
    static let sheetHandleHit: CGFloat = 28

    /// Every control's minimum hit area (§4.19).
    static let minHit: CGFloat = 44
    /// Nothing interactive this close to the home indicator (§4.3).
    static let homeIndicatorClearance: CGFloat = 12
    static let gutter: CGFloat = 16

    // Landscape (§4.4)
    static let landscapeTopBar: CGFloat = 36
    static let landscapeMinimap: CGFloat = 20
    static let landscapeRuler: CGFloat = 24
    static let landscapeCoverage: CGFloat = 8
    static let landscapeLaneRail: CGFloat = 120
    static let landscapeInspector: CGFloat = 360
  }

  enum Radius {
    /// Opaque cards (gate, error, edge) and panels.
    static let card: CGFloat = 12
    static let chip: CGFloat = 14
    /// tokens.css `--radius`.
    static let small: CGFloat = 6
  }

  // MARK: Motion (§4.1 rule 4, §4.6; none of it under Reduce Motion)

  enum Motion {
    /// The demo's first paint: one fade of the whole data plane, never a stagger (ΔS-8).
    static let firstPaintFade = 0.2
    /// Panning a selected mark into view.
    static let selectionPan = 0.25
    /// Newly revealed marks during Play.
    static let markFade = 0.15
    /// One bin per step at 1× (1.2 s under Reduce Motion).
    static let playStep = 0.4
    static let playStepReduced = 1.2
    /// Inspector detent snap.
    static let detentSnap = Animation.smooth(duration: 0.28)
  }
}
