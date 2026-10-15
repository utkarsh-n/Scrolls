// OWNER: N0
// Port of src/shared/evidence-style.mjs: the ONLY evidence → style map (SPEC §8.7, D7, §13 rules 3 and 5). Metal,
// Canvas, SVG and the legend all read it. Evidence status is line pattern + endpoint + badge word, never colour alone;
// review status is an overlay that never changes the line; hue encodes role (family) and is backed by the glyph/label.

/// The inputs of an edge style (a relationship or arc).
public struct EvidenceStyleKey: Sendable, Hashable {
  public var evidenceStatus: String
  public var reviewStatus: String
  public var provenanceQuality: String
  public var family: String?
  public var cue: Bool
  public var isSynthetic: Bool
  public var dateConflict: Bool
  public var origin: String?

  public init(evidenceStatus: String, reviewStatus: String = "unreviewed", provenanceQuality: String = "complete",
              family: String? = nil, cue: Bool = false, isSynthetic: Bool = false, dateConflict: Bool = false,
              origin: String? = nil) {
    self.evidenceStatus = evidenceStatus
    self.reviewStatus = reviewStatus
    self.provenanceQuality = provenanceQuality
    self.family = family
    self.cue = cue
    self.isSynthetic = isSynthetic
    self.dateConflict = dateConflict
    self.origin = origin
  }
}

/// The style of a relationship edge or arc (`edgeStyle` output).
public struct ArcStyle: Sendable, Hashable, JSONRepresentable {
  public enum Endpoint: String, Sendable, Hashable { case dot, square, question }
  public enum Overlay: String, Sendable, Hashable { case check, cross, scales }
  public var dash: [Double]
  public var width: Double
  public var endpoint: Endpoint
  /// The evidence word (+ ' ⚠' on a date conflict).
  public var badge: String
  /// 'amber' | 'violet' | 'ivory2' | 'danger'
  public var hue: String
  public var opacity: Double
  public var strike: Bool
  public var overlay: Overlay?
  public var synthetic: Bool
  public var conflict: Bool
  /// Draw the ✎ badge.
  public var human: Bool

  public var jsonValue: JSONValue {
    .object([
      "dash": dash.jsonValue, "width": width.jsonValue, "endpoint": .string(endpoint.rawValue), "badge": .string(badge),
      "hue": .string(hue), "opacity": opacity.jsonValue, "strike": .bool(strike),
      "overlay": overlay.map { .string($0.rawValue) } ?? .null, "synthetic": .bool(synthetic), "conflict": .bool(conflict),
      "human": .bool(human),
    ])
  }
}

/// The style of a timeline bin cell (`binStyle` output). Colours are token names (tokens.css without '--').
public struct BinStyle: Sendable, Hashable, JSONRepresentable {
  public enum Mark: String, Sendable, Hashable { case rect, baseline, tick, none }
  public var fill: String?
  public var outline: String?
  /// nil | 'hatch' | 'stripes' | 'dots' | 'syn'
  public var pattern: String?
  public var superscript: String?
  public var opacity: Double
  public var mark: Mark
  public var glyph: String?
  public var synthetic: Bool

  public var jsonValue: JSONValue {
    func s(_ v: String?) -> JSONValue { v.map(JSONValue.string) ?? .null }
    return .object([
      "fill": s(fill), "outline": s(outline), "pattern": s(pattern), "superscript": s(superscript),
      "opacity": opacity.jsonValue, "mark": .string(mark.rawValue), "glyph": s(glyph), "synthetic": .bool(synthetic),
    ])
  }
}

/// A legend row: its text (Copy.legendText) and the style drawn with the same code as the marks.
public struct LegendRow: Sendable, Hashable, JSONRepresentable {
  public enum Style: Sendable, Hashable {
    case edge(ArcStyle), bin(BinStyle), hue(String), none
  }
  public var group: String
  public var key: String
  public var label: String
  public var description: String
  public var style: Style

  public var jsonValue: JSONValue {
    let style: JSONValue = switch self.style {
    case .edge(let e): e.jsonValue
    case .bin(let b): b.jsonValue
    case .hue(let h): ["hue": .string(h)]
    case .none: .null
    }
    return ["group": .string(group), "key": .string(key), "label": .string(label), "description": .string(description), "style": style]
  }
}

/// Why a style was refused: an unknown evidence or review status or cell state is never guessed.
public struct EvidenceStyleError: Error, Sendable, Equatable {
  public let message: String
  public init(message: String) { self.message = message }
}

/// The evidence → style map.
public enum EvidenceStyle {
  static let lineWidth = 1.5
  static let rejectedOpacity = 0.3

  /// `edgeStyle(rel)` for a known evidence and review status (anything else is a programming error).
  public static func style(_ key: EvidenceStyleKey) -> ArcStyle {
    do { return try edgeStyle(key) } catch { preconditionFailure(error.message) }
  }

  /// `edgeStyle(rel)`: throws on an unknown evidence or review status.
  public static func edgeStyle(_ key: EvidenceStyleKey) throws(EvidenceStyleError) -> ArcStyle {
    let base: (dash: [Double], endpoint: ArcStyle.Endpoint, badge: String)
    switch key.evidenceStatus {
    case "documented": base = ([], .dot, "DOC")
    case "computed": base = ([6, 4], .square, "CALC")
    case "proposed": base = ([1, 3], .question, "PROP")
    default: throw EvidenceStyleError(message: "edgeStyle: unknown evidence_status '\(key.evidenceStatus)'")
    }
    let overlay: ArcStyle.Overlay?
    switch key.reviewStatus {
    case "unreviewed": overlay = nil
    case "confirmed": overlay = .check
    case "rejected": overlay = .cross
    case "disputed": overlay = .scales
    default: throw EvidenceStyleError(message: "edgeStyle: unknown review_status '\(key.reviewStatus)'")
    }
    var badge = base.badge
    if key.evidenceStatus == "documented" && key.provenanceQuality == "source_unrecorded" { badge = "DOC*" }
    if key.evidenceStatus == "proposed" && key.cue { badge = "PROP · CUE" }
    if key.dateConflict { badge += " ⚠" }
    let rejected = key.reviewStatus == "rejected"
    return ArcStyle(dash: base.dash, width: lineWidth, endpoint: base.endpoint, badge: badge,
                    hue: key.dateConflict ? "danger" : key.family.flatMap { Vocab.familyHue[$0] } ?? "ivory2",
                    opacity: rejected ? rejectedOpacity : 1, strike: rejected, overlay: overlay, synthetic: key.isSynthetic,
                    conflict: key.dateConflict, human: key.origin == "human")
  }

  /// `binStyle({state, flags})` with the state as its tile code (1–5).
  public static func binStyle(state code: Int, flags: Int = 0) throws(EvidenceStyleError) -> BinStyle {
    guard let name = Vocab.cellStates[String(code)] else {
      throw EvidenceStyleError(message: "binStyle: unknown state '\(code)'")
    }
    return try binStyle(state: name, flags: flags)
  }

  /// `binStyle({state, flags})` with the state by name: what to draw in the strand — a rect (observed), a dotted
  /// baseline (absent), a hollow tick of raw n (low), or nothing but the lane underlay (uncovered, pending).
  public static func binStyle(state name: String, flags: Int = 0) throws(EvidenceStyleError) -> BinStyle {
    func flag(_ f: String) -> Bool { flags & (Vocab.cellFlags[f] ?? 0) != 0 }
    let synthetic = flag("synthetic")
    switch name {
    case "observed":
      let sparse = flag("sparse"), estimated = flag("estimated_majority")
      return BinStyle(fill: "ink", outline: sparse ? "ink" : nil, pattern: estimated ? "stripes" : synthetic ? "syn" : nil,
                      superscript: flag("single_source") ? "¹" : nil, opacity: sparse ? 0.25 : 0.88, mark: .rect,
                      glyph: estimated ? "≈" : nil, synthetic: synthetic)
    case "absent":
      return BinStyle(fill: nil, outline: "ink-3", pattern: nil, superscript: nil, opacity: 1, mark: .baseline, glyph: nil, synthetic: synthetic)
    case "low":
      return BinStyle(fill: nil, outline: "ink-2", pattern: "hatch", superscript: nil, opacity: 0.5, mark: .tick, glyph: nil, synthetic: synthetic)
    case "uncovered":
      return BinStyle(fill: nil, outline: nil, pattern: "hatch", superscript: nil, opacity: 1, mark: .none, glyph: nil, synthetic: synthetic)
    case "pending":
      return BinStyle(fill: nil, outline: nil, pattern: "dots", superscript: nil, opacity: 1, mark: .none, glyph: nil, synthetic: synthetic)
    default:
      throw EvidenceStyleError(message: "binStyle: unknown state '\(name)'")
    }
  }

  /// `LEGEND_ROWS`, in display order: every evidence status, every overlay, every bin state and flag, every role hue,
  /// and the lane-order note. Text comes from Copy.legendText; each style is computed by the code that draws the marks.
  public static let legendRows: [LegendRow] = Copy.legendText.map { t in
    LegendRow(group: t.group, key: t.key, label: t.label, description: t.description, style: legendStyle(t.group, t.key))
  }

  private static func legendStyle(_ group: String, _ key: String) -> LegendRow.Style {
    let flags = Vocab.cellFlags
    switch (group, key) {
    case ("evidence", "documented"): return .edge(style(.init(evidenceStatus: "documented", family: "citation")))
    case ("evidence", "documented_unrecorded"):
      return .edge(style(.init(evidenceStatus: "documented", provenanceQuality: "source_unrecorded", family: "citation")))
    case ("evidence", "computed"): return .edge(style(.init(evidenceStatus: "computed", family: "quotation")))
    case ("evidence", "proposed"): return .edge(style(.init(evidenceStatus: "proposed", family: "allusion")))
    case ("evidence", "proposed_cue"): return .edge(style(.init(evidenceStatus: "proposed", family: "citation", cue: true)))
    case ("overlay", "confirmed"): return .edge(style(.init(evidenceStatus: "proposed", reviewStatus: "confirmed", family: "allusion")))
    case ("overlay", "rejected"): return .edge(style(.init(evidenceStatus: "proposed", reviewStatus: "rejected", family: "allusion")))
    case ("overlay", "disputed"): return .edge(style(.init(evidenceStatus: "proposed", reviewStatus: "disputed", family: "allusion")))
    case ("overlay", "human"): return .edge(style(.init(evidenceStatus: "proposed", family: "allusion", origin: "human")))
    case ("overlay", "date_conflict"): return .edge(style(.init(evidenceStatus: "documented", family: "citation", dateConflict: true)))
    case ("overlay", "synthetic"): return .edge(style(.init(evidenceStatus: "documented", family: "citation", isSynthetic: true)))
    case ("bins", "observed"): return .bin(knownBin("observed"))
    case ("bins", "sparse"): return .bin(knownBin("observed", flags["sparse"] ?? 0))
    case ("bins", "single_source"): return .bin(knownBin("observed", flags["single_source"] ?? 0))
    case ("bins", "estimated"): return .bin(knownBin("observed", flags["estimated_majority"] ?? 0))
    case ("bins", let state): return .bin(knownBin(state))
    case ("role", let hue): return .hue(hue)
    default: return .none
    }
  }

  /// A bin style of the generated legend, whose states are the vocabulary's own.
  private static func knownBin(_ state: String, _ flags: Int = 0) -> BinStyle {
    do { return try binStyle(state: state, flags: flags) } catch { preconditionFailure(error.message) }
  }
}
