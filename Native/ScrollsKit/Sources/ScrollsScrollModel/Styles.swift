// OWNER: N7
// The style-id table of the display list (IOS-SPEC §4.23, §8.4.7: `BarPrim.style` and friends are N7's ids): one id per
// style string of display.mjs/paint.mjs, the reference primitive kind and layer each is drawn as, the pattern of the band
// styles, and the text roles of labels. Metal, `DisplayListCanvas`, SVG, the legend and G5 read this one table, so a
// style id means the same thing everywhere it is drawn or checked.

import ScrollsCore

/// The reference's primitive kinds (`display.mjs`).
public enum PrimKind: String, Sendable, Hashable, CaseIterable {
  case rect, tick, diamond, path, text, glyph, band, wash
}

/// The reference's paint layers.
public enum PrimLayer: String, Sendable, Hashable {
  case bg, data, arcs
}

/// Pattern ids of `BandPrim.pattern` (and the patterns bars and washes overlay), drawn in screen space (`PATTERNS`).
public enum PatternID: UInt16, Sendable, Hashable, CaseIterable {
  case none = 0
  /// 45° at a 6 pt pitch, ink at 9%: "no sources".
  case hatch
  /// 45° at 4 pt, ink at 7%: under a low-coverage bin.
  case hatchLow
  /// Sparse dots at 6 pt, ink at 26%: pending.
  case dots
  /// Backslash stripes at 3 pt, ink at 30%: mostly estimated dates.
  case stripes
  /// Wide backslash stripes at 8 pt, syn at 16%: synthetic material.
  case syn

  /// The reference's pattern name.
  public var name: String? {
    switch self {
    case .none: nil
    case .hatch: "hatch"
    case .hatchLow: "hatch-low"
    case .dots: "dots"
    case .stripes: "stripes"
    case .syn: "syn"
    }
  }

  public init?(name: String?) {
    guard let name else { self = .none; return }
    guard let p = Self.allCases.first(where: { $0.name == name }) else { return nil }
    self = p
  }
}

/// Every style the Scroll draws, with its reference name. The raw value is the GPU style id.
public enum ScrollStyle: UInt16, Sendable, Hashable, CaseIterable {
  case none = 0
  // underlay bands
  case laneEven, laneOdd, hatch, hatchLow, dots, loading, covSpan
  // coverage classes
  case cov0, cov1, cov2, cov3, cov4
  // bins
  case bar, barSparse, barBackdrop, absent, lowTick
  // caps
  case capStart, capChevron, capEnd
  // washes and marks
  case wash, washSyn, markText, markEst, markTitle, bracketStated, bracketEst, bracketDerived, bracketPeriod, coarse
  // ruler and seam
  case rulerMajor, rulerMinor, seamTick, seam
  // texts (label roles)
  case rulerLabel, superscript, lowN, washLabel, coarseLabel, seamLabel, spanLabel

  /// The reference's style string ('lane-0', 'cov-3', 'bar-sparse', …).
  public var name: String {
    switch self {
    case .none: "none"
    case .laneEven: "lane-0"
    case .laneOdd: "lane-1"
    case .hatch: "hatch"
    case .hatchLow: "hatch-low"
    case .dots: "dots"
    case .loading: "loading"
    case .covSpan: "cov-span"
    case .cov0: "cov-0"
    case .cov1: "cov-1"
    case .cov2: "cov-2"
    case .cov3: "cov-3"
    case .cov4: "cov-4"
    case .bar: "bar"
    case .barSparse: "bar-sparse"
    case .barBackdrop: "bar-backdrop"
    case .absent: "absent"
    case .lowTick: "low-tick"
    case .capStart: "cap-start"
    case .capChevron: "cap-chevron"
    case .capEnd: "cap-end"
    case .wash: "wash"
    case .washSyn: "wash-syn"
    case .markText: "mark-text"
    case .markEst: "mark-est"
    case .markTitle: "mark-title"
    case .bracketStated: "bracket-stated"
    case .bracketEst: "bracket-est"
    case .bracketDerived: "bracket-derived"
    case .bracketPeriod: "bracket-period"
    case .coarse: "coarse"
    case .rulerMajor: "ruler-major"
    case .rulerMinor: "ruler-minor"
    case .seamTick: "seam-tick"
    case .seam: "seam"
    case .rulerLabel: "ruler-label"
    case .superscript: "superscript"
    case .lowN: "low-n"
    case .washLabel: "wash-label"
    case .coarseLabel: "coarse-label"
    case .seamLabel: "seam-label"
    case .spanLabel: "span-label"
    }
  }

  private static let byName: [String: ScrollStyle] = Dictionary(uniqueKeysWithValues: allCases.map { ($0.name, $0) })

  /// The style of a reference style string.
  public init?(name: String) {
    guard let s = Self.byName[name] else { return nil }
    self = s
  }

  /// The coverage class style `cov-<cls>`.
  public static func coverage(_ cls: Int) -> ScrollStyle {
    switch cls {
    case ...0: .cov0
    case 1: .cov1
    case 2: .cov2
    case 3: .cov3
    default: .cov4
    }
  }

  /// The coverage class of a `cov-n` style, nil for every other style.
  public var coverageClass: Int? {
    switch self {
    case .cov0: 0
    case .cov1: 1
    case .cov2: 2
    case .cov3: 3
    case .cov4: 4
    default: nil
    }
  }

  /// Is this a text role (drawn from the label atlas)?
  public var isText: Bool {
    switch self {
    case .rulerLabel, .superscript, .lowN, .washLabel, .coarseLabel, .seamLabel, .spanLabel: true
    default: false
    }
  }

  /// The type role of a text style: point size, weight and monospaced digits (`paint.mjs` text spec).
  public var textSpec: (size: Double, semibold: Bool, mono: Bool) {
    switch self {
    case .superscript: (9, false, false)
    case .lowN: (9, false, true)
    case .washLabel, .coarseLabel: (10, false, false)
    case .rulerLabel: (11.5, false, true)
    case .seamLabel: (10.5, true, false)
    case .spanLabel: (11, false, false)
    case .capStart: (10, false, false)
    case .capChevron: (12, false, false)
    default: (10, false, false)
    }
  }

  /// The pattern a band style fills with (bars take theirs from their cell flags).
  public var bandPattern: PatternID {
    switch self {
    case .hatch, .cov0: .hatch
    case .hatchLow: .hatchLow
    case .dots: .dots
    default: .none
    }
  }
}

/// Bits of `PrimFlags` the display builder adds above the frozen ones (bits 14 and 15 are free in N0's set).
extension PrimFlags {
  /// The bar's leading corners are rounded (the first bin of a run, `round: 'l'`).
  public static let roundLeading = PrimFlags(rawValue: 1 << 14)
  /// The bar's trailing corners are rounded (the last bin of a run, `round: 'r'`).
  public static let roundTrailing = PrimFlags(rawValue: 1 << 15)
}

/// The fill pattern of an observed bin (`binStyle(...).pattern`): stripes for an estimated majority, else the synthetic
/// stripe, else none.
public func barPattern(flags: UInt16) -> PatternID {
  let f = PrimFlags(rawValue: flags)
  if f.contains(.estimatedMajority) { return .stripes }
  if f.contains(.synthetic) { return .syn }
  return .none
}
