// OWNER: N0
// The display-list primitives (IOS-SPEC §4.23, §8.4.7): the one structure the Metal renderer, the Canvas fallback
// and snapshots, SVG export, the hit grid, VoiceOver and the table alternative all read, so what is tapped, painted
// and exported is one object (SPEC §8.3). Frozen at M0: N7 builds and interprets these values (`DisplayBuilder`,
// `visible(at:)`, `hit(_:tolerance:vantage:)`, the style-id table) in its own files; additions go through N0.
//
// Content space: x in days relative to `DisplayList.originDay` (Float keeps sub-day accuracy at 40 pt/day across
// ±4.4 M days), y in lane-stack points. Every primitive carries `revealDay` (its latest day; `alwaysRevealed` for
// archive descriptions) so the vantage is a uniform, never a rebuild.

import CoreGraphics
import ScrollsContracts
import ScrollsCore

// MARK: - Identity and references

/// A primitive's id inside one display list.
public struct PrimID: RawRepresentable, Hashable, Sendable {
  public let rawValue: UInt32
  public init(rawValue: UInt32) { self.rawValue = rawValue }
}

/// A lane's key as the reference names it ("community:Classroom", "trail:literature-text", "cluster:12:3").
public struct LaneKey: RawRepresentable, Hashable, Sendable, Codable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// A bin of one strand in one lane (`ref: {type: 'bin', lane, strand, tier, bin, i}`).
public struct BinRef: Hashable, Sendable, Codable {
  public var lane: LaneKey
  /// The strand row's reference key (an expression id, or `theme:<value>@<provenance>`).
  public var strand: String
  public var tier: Tier
  /// The absolute bin index at `tier` (`tiers.binOfDay`).
  public var bin: Int64
  /// The column of the bin in the strand's `LaneSeries` columns.
  public var index: Int32

  public init(lane: LaneKey, strand: String, tier: Tier, bin: Int64, index: Int32) {
    self.lane = lane
    self.strand = strand
    self.tier = tier
    self.bin = bin
    self.index = index
  }
}

/// A precision wash: items dated to an interval that does not fit one bin (`ref: {type: 'wash', …}`, SPEC D2).
public struct WashRef: Hashable, Sendable, Codable {
  public var lane: LaneKey
  public var strand: String
  public var loDay: Day
  public var hiDay: Day
  /// The items' shared date label ("c. 1960", "1990s").
  public var label: String

  public init(lane: LaneKey, strand: String, loDay: Day, hiDay: Day, label: String) {
    self.lane = lane
    self.strand = strand
    self.loDay = loDay
    self.hiDay = hiDay
    self.label = label
  }
}

/// An UNDATED (⊘) or SCHEDULED (⇥) shelf, for the whole Scroll or one lane (SPEC §1.7).
public struct ShelfRef: Hashable, Sendable, Codable {
  public enum Which: String, Hashable, Sendable, Codable { case undated, scheduled }
  public var which: Which
  /// nil = the shelf of every shown lane.
  public var lane: LaneKey?

  public init(which: Which, lane: LaneKey?) {
    self.which = which
    self.lane = lane
  }
}

/// What a primitive answers when tapped (the reference's `ref`).
public enum PrimRef: Hashable, Sendable {
  case occurrence(OccurrenceID)
  case bin(BinRef)
  case passage(PassageID)
  case relationship(RelationshipID)
  case wash(WashRef)
  case shelf(ShelfRef)
  /// The modality seam at its day (SPEC §1.10).
  case seam(Day)
  /// A lane band: banding, coverage underlay, "no sources" hatch or pending dots of one lane.
  case band(LaneKey)
  /// Decoration that answers nothing.
  case none
}

// MARK: - Flags shared by the instanced primitives

/// Per-instance flags. The low seven bits are the reference's cell flags (`vocab.CELL_FLAGS`) verbatim, so a
/// bar's flags are its cell's flags; the high bits are drawing states.
public struct PrimFlags: OptionSet, Hashable, Sendable {
  public let rawValue: UInt16
  public init(rawValue: UInt16) { self.rawValue = rawValue }

  /// 1–4 matches: an outlined bar.
  public static let sparse = PrimFlags(rawValue: 1)
  /// ¹: ≥ 60% of the bin from one document.
  public static let singleSource = PrimFlags(rawValue: 2)
  /// ≈: > 50% of the bin from estimated dates (stripes).
  public static let estimatedMajority = PrimFlags(rawValue: 4)
  /// A sampled cell (OpenAlex top-cited per cell): a count, never a rate.
  public static let sampled = PrimFlags(rawValue: 8)
  /// Invented demonstration material: the syn-stripe overlay.
  public static let synthetic = PrimFlags(rawValue: 16)
  public static let namesExcluded = PrimFlags(rawValue: 32)
  public static let translationsIncluded = PrimFlags(rawValue: 64)
  /// ◁ "may be older than our record" at the leading end.
  public static let censoredBefore = PrimFlags(rawValue: 1 << 8)
  /// ▷ at the trailing end.
  public static let censoredAfter = PrimFlags(rawValue: 1 << 9)
  /// Opens something when tapped (a passage, a drawer, a card).
  public static let openable = PrimFlags(rawValue: 1 << 10)
  /// Context mode drew it at `Visibility.ghostOpacity` (set by `visible(at:)`, never by the builder).
  public static let ghost = PrimFlags(rawValue: 1 << 11)
  /// Part of the current selection.
  public static let selected = PrimFlags(rawValue: 1 << 12)
  /// A review overlay hides it by default (rejected arcs, drawn at 30% with a strike when shown).
  public static let rejected = PrimFlags(rawValue: 1 << 13)
}

// MARK: - The instanced primitives (one array per draw call, §4.23)

/// A bar or rectangle: a run of observed bins, a cell rect, a cap. 28 bytes of payload; the GPU instance layout
/// (ScrollShaderTypes.h, N7) pads it to 32.
public struct BarPrim: Sendable, Equatable {
  /// Leading and trailing edges in days relative to `DisplayList.originDay`.
  public var d0: Float, d1: Float
  /// Top and bottom in lane-stack points.
  public var y0: Float, y1: Float
  /// EvidenceStyle / BinStyle id (N7's style table).
  public var style: UInt16
  /// `PrimFlags` raw value.
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d0: Float, d1: Float, y0: Float, y1: Float, style: UInt16, flags: UInt16, revealDay: Int32, id: PrimID) {
    self.d0 = d0
    self.d1 = d1
    self.y0 = y0
    self.y1 = y1
    self.style = style
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// A band in the lane underlay: banding, coverage classes, the "no sources" hatch, pending dots, period bands,
/// the seam. Patterns are drawn in screen space (6 pt pitch), so a hatch never stretches under zoom.
public struct BandPrim: Sendable, Equatable {
  public var d0: Float, d1: Float
  public var y0: Float, y1: Float
  public var style: UInt16
  /// Pattern id: none, hatch, dots, stripes, period (N7's table).
  public var pattern: UInt16
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d0: Float, d1: Float, y0: Float, y1: Float, style: UInt16, pattern: UInt16, flags: UInt16,
              revealDay: Int32, id: PrimID) {
    self.d0 = d0
    self.d1 = d1
    self.y0 = y0
    self.y1 = y1
    self.style = style
    self.pattern = pattern
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// A precision wash: a band at opacity .18 with a 1 pt top rule; circa ends feathered 10% (§4.7).
public struct WashPrim: Sendable, Equatable {
  public var d0: Float, d1: Float
  public var y0: Float, y1: Float
  public var style: UInt16
  public var flags: UInt16
  /// Feather at each end as a fraction of the width (0 for a hard edge).
  public var featherLo: Float, featherHi: Float
  public var revealDay: Int32
  public var id: PrimID

  public init(d0: Float, d1: Float, y0: Float, y1: Float, style: UInt16, flags: UInt16, featherLo: Float,
              featherHi: Float, revealDay: Int32, id: PrimID) {
    self.d0 = d0
    self.d1 = d1
    self.y0 = y0
    self.y1 = y1
    self.style = style
    self.flags = flags
    self.featherLo = featherLo
    self.featherHi = featherHi
    self.revealDay = revealDay
    self.id = id
  }
}

/// A vertical tick: a `low` bin's hollow tick, an end tick, a ruler tick, a dotted `absent` baseline segment.
public struct TickPrim: Sendable, Equatable {
  /// Position in days relative to the origin.
  public var d: Float
  public var y0: Float, y1: Float
  /// Stroke width in points (constant under zoom).
  public var width: Float
  public var style: UInt16
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d: Float, y0: Float, y1: Float, width: Float, style: UInt16, flags: UInt16, revealDay: Int32, id: PrimID) {
    self.d = d
    self.y0 = y0
    self.y1 = y1
    self.width = width
    self.style = style
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// A diamond or work mark: an occurrence mark, a Wiktionary claim (hollow amber), a cap.
public struct DiamondPrim: Sendable, Equatable {
  public var d: Float
  /// Centre in lane-stack points.
  public var y: Float
  /// Half-diagonal in points (constant under zoom).
  public var size: Float
  public var style: UInt16
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d: Float, y: Float, size: Float, style: UInt16, flags: UInt16, revealDay: Int32, id: PrimID) {
    self.d = d
    self.y = y
    self.size = size
    self.style = style
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// An arc from earlier to later material: a quadratic Bézier tessellated in the vertex shader, dashed by arc length.
/// Pattern = evidence status, hue = role, overlay = review (SPEC §8.7); never colour alone.
public struct ArcPrim: Sendable, Equatable {
  /// The earlier and the later end, in days relative to the origin.
  public var d0: Float, d1: Float
  /// Baseline of both ends in lane-stack points.
  public var y: Float
  /// Signed control height in points (negative = above the baseline; feedback arcs go below).
  public var height: Float
  /// 0 solid (documented) · 1 dashed 6/4 (computed) · 2 dotted 1/3 (proposed).
  public var dash: UInt8
  /// 0 filled dot · 1 hollow square · 2 "?" (`ArcStyle.Endpoint`).
  public var endpoint: UInt8
  /// Role hue: 0 amber · 1 violet · 2 ivory-2 · 3 danger.
  public var role: UInt8
  /// Review overlay: 0 none · 1 ✓ · 2 ✕ · 3 ⚖ (the line pattern never changes).
  public var review: UInt8
  public var flags: UInt16
  /// The later end's day: an arc appears only when both ends are on or before the vantage (§4.6).
  public var revealDay: Int32
  public var id: PrimID

  public init(d0: Float, d1: Float, y: Float, height: Float, dash: UInt8, endpoint: UInt8, role: UInt8, review: UInt8,
              flags: UInt16, revealDay: Int32, id: PrimID) {
    self.d0 = d0
    self.d1 = d1
    self.y = y
    self.height = height
    self.dash = dash
    self.endpoint = endpoint
    self.role = role
    self.review = review
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// A single glyph from the label atlas: caps ● ■ ▲ ◆, censoring ◁ ▷, ¹, ≈, ⚠, ✓ ✕ ⚖, ⑂ ⑃.
public struct GlyphPrim: Sendable, Equatable {
  public var d: Float
  public var y: Float
  /// The glyph's key in the label atlas.
  public var glyph: LabelKey
  /// Point size (7 pt for caps, §4.7).
  public var size: Float
  public var style: UInt16
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d: Float, y: Float, glyph: LabelKey, size: Float, style: UInt16, flags: UInt16, revealDay: Int32,
              id: PrimID) {
    self.d = d
    self.y = y
    self.glyph = glyph
    self.size = size
    self.style = style
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// A shaped text run drawn from the label atlas (whole `CTLine`s, so Devanagari and Gujarati conjuncts are shaped).
public struct LabelPrim: Sendable, Equatable {
  /// Anchor position in days relative to the origin.
  public var d: Float
  /// Baseline in lane-stack points.
  public var y: Float
  /// The run's key in `DisplayList.labelRuns`.
  public var key: LabelKey
  /// 0 leading · 1 centre · 2 trailing, relative to the anchor.
  public var align: UInt8
  public var style: UInt16
  public var flags: UInt16
  public var revealDay: Int32
  public var id: PrimID

  public init(d: Float, y: Float, key: LabelKey, align: UInt8, style: UInt16, flags: UInt16, revealDay: Int32,
              id: PrimID) {
    self.d = d
    self.y = y
    self.key = key
    self.align = align
    self.style = style
    self.flags = flags
    self.revealDay = revealDay
    self.id = id
  }
}

/// The key of a shaped run in the label atlas.
public struct LabelKey: RawRepresentable, Hashable, Sendable {
  public let rawValue: UInt32
  public init(rawValue: UInt32) { self.rawValue = rawValue }
}

/// The text of a label or glyph and the type role it is shaped with (N7's role table: ruler, lane chip, count, …).
public struct LabelRun: Hashable, Sendable {
  public var text: String
  public var role: UInt16

  public init(text: String, role: UInt16) {
    self.text = text
    self.role = role
  }
}

// MARK: - The numbers behind the primitives

/// The state of a bin (`vocab.CELL_STATE_CODES`): the four kinds of "no bar" are never merged (SPEC §13 rule 3).
public enum BinState: UInt8, Sendable, Hashable, Codable {
  case observed = 1, absent, low, uncovered, pending
}

/// One strand's bins in one lane, as typed columns sorted by bin (`model.buildColumns`). The renderer, the hit grid,
/// the tap sentences, Audio Graphs and the table alternative read these same arrays (identity-tested by N7).
public struct StrandSeries: Sendable, Equatable {
  /// The strand row's reference key.
  public var ref: String
  public var label: String
  /// "●", "■", "▲" or "◆" (`vocab.STRAND_GLYPH_CHARS`).
  public var glyph: String
  public var bin: [Int64]
  public var loDay: [Day]
  public var hiDay: [Day]
  public var n: [Int32]
  public var docs: [Int32]
  /// The denominator in the lane's coverage unit; NaN when the cell has none.
  public var denom: [Double]
  /// The rate in the lane unit; NaN when no rate is drawn (low, absent, sampled cells).
  public var rate: [Double]
  public var ciLo: [Double]
  public var ciHi: [Double]
  public var state: [BinState]
  /// `PrimFlags` raw values (the cell flags).
  public var flags: [UInt16]

  public init(ref: String, label: String, glyph: String, bin: [Int64] = [], loDay: [Day] = [], hiDay: [Day] = [],
              n: [Int32] = [], docs: [Int32] = [], denom: [Double] = [], rate: [Double] = [], ciLo: [Double] = [],
              ciHi: [Double] = [], state: [BinState] = [], flags: [UInt16] = []) {
    self.ref = ref
    self.label = label
    self.glyph = glyph
    self.bin = bin
    self.loDay = loDay
    self.hiDay = hiDay
    self.n = n
    self.docs = docs
    self.denom = denom
    self.rate = rate
    self.ciLo = ciLo
    self.ciHi = ciHi
    self.state = state
    self.flags = flags
  }

  /// Number of bins (every column has this length).
  public var count: Int { bin.count }
}

/// A lane and its strands, with the units every count is stated in (§4.1 rule 6: every count names its denominator).
public struct LaneSeries: Sendable, Equatable {
  public var key: LaneKey
  public var label: String
  /// The rate unit ("per_million_tokens", "per_1000_works", …; `vocab.RATE_UNITS`).
  public var unit: String
  /// The coverage unit words ("tokens", "works").
  public var coverageUnit: String
  /// "text", "titles", "abstracts", "lexical" or "baseline".
  public var modality: String
  public var synthetic: Bool
  /// Top and bottom of the lane in lane-stack points.
  public var y0: Float, y1: Float
  public var tier: Tier
  public var strands: [StrandSeries]
  /// Maximal runs of bins with no sources, as closed day intervals.
  public var uncovered: [DayInterval]
  /// Maximal runs of bins still indexing.
  public var pending: [DayInterval]

  public init(key: LaneKey, label: String, unit: String, coverageUnit: String, modality: String, synthetic: Bool,
              y0: Float, y1: Float, tier: Tier, strands: [StrandSeries], uncovered: [DayInterval] = [],
              pending: [DayInterval] = []) {
    self.key = key
    self.label = label
    self.unit = unit
    self.coverageUnit = coverageUnit
    self.modality = modality
    self.synthetic = synthetic
    self.y0 = y0
    self.y1 = y1
    self.tier = tier
    self.strands = strands
    self.uncovered = uncovered
    self.pending = pending
  }
}

/// Why the builder stepped to a coarser tier: the "Simplified: decade bins (too many marks for one screen)" pill.
/// Counted over ungated primitives (DV-7).
public struct SimplifiedReason: Sendable, Equatable {
  public enum Budget: String, Sendable, Hashable { case shapes, marks, labels }
  /// Which per-frame budget was exceeded (`display.BUDGET`: 20,000 shapes, 4,000 marks, 150 labels).
  public var budget: Budget
  /// How many primitives the finer tier would have drawn.
  public var wanted: Int
  /// The tier actually drawn.
  public var drawnTier: Tier

  public init(budget: Budget, wanted: Int, drawnTier: Tier) {
    self.budget = budget
    self.wanted = wanted
    self.drawnTier = drawnTier
  }
}

// MARK: - The hit grid

/// Hit classes in priority order on overlap (`hit.mjs`): mark > arc > cap > bin > wash > band > other.
public enum HitClass: UInt8, Sendable, Hashable, Comparable {
  case other = 0, band, wash, bin, cap, arc, mark

  public static func < (a: HitClass, b: HitClass) -> Bool { a.rawValue < b.rawValue }
}

/// One indexed primitive. Bounds are in content points at the build zoom (x = days from the origin × `pointsPerDay`).
public struct HitEntry: Sendable, Equatable {
  public var id: PrimID
  public var hitClass: HitClass
  public var bounds: CGRect
  /// An arc's polyline (16 samples, §8.4), hit along the curve instead of its box; nil for everything else.
  public var polyline: [CGPoint]?
  public var revealDay: Int32
  public var openable: Bool

  public init(id: PrimID, hitClass: HitClass, bounds: CGRect, polyline: [CGPoint]?, revealDay: Int32, openable: Bool) {
    self.id = id
    self.hitClass = hitClass
    self.bounds = bounds
    self.polyline = polyline
    self.revealDay = revealDay
    self.openable = openable
  }
}

/// A grid cell (column, row) of `HitGrid.cellSize` points.
public struct HitCell: Hashable, Sendable {
  public var column: Int32
  public var row: Int32

  public init(column: Int32, row: Int32) {
    self.column = column
    self.row = row
  }
}

/// A uniform spatial grid over the display list in content coordinates, built after layout or a tier change and never
/// on pan (`hit.mjs`). Queries honour the vantage: hidden primitives are not hit; ghosted ones are (§4.23).
public struct HitGrid: Sendable, Equatable {
  /// Cell size in points (`hit.CELL`).
  public static let cellSize: Double = 24
  /// Touch tolerance in points for marks, caps and arcs (`hit.TOLERANCE.touch`); areas need a direct hit.
  public static let touchTolerance: Double = 12

  /// The zoom the content coordinates were built at.
  public var pointsPerDay: Double
  public var entries: [HitEntry]
  /// Entry indices per cell.
  public var cells: [HitCell: [Int32]]
  /// Entry indices of very wide bands (lane underlays), per row, so they do not fill thousands of cells.
  public var rows: [Int32: [Int32]]

  public init(pointsPerDay: Double, entries: [HitEntry] = [], cells: [HitCell: [Int32]] = [:], rows: [Int32: [Int32]] = [:]) {
    self.pointsPerDay = pointsPerDay
    self.entries = entries
    self.cells = cells
    self.rows = rows
  }
}

// MARK: - The display list

/// Everything one viewport draws, built off the main actor by `DisplayBuilder` (N7) without a vantage.
public struct DisplayList: Sendable {
  /// The day every `d` is relative to (the viewport centre at build time).
  public var originDay: Day
  public var bands: [BandPrim]
  public var washes: [WashPrim]
  public var bars: [BarPrim]
  public var ticks: [TickPrim]
  public var diamonds: [DiamondPrim]
  public var arcs: [ArcPrim]
  public var glyphs: [GlyphPrim]
  public var labels: [LabelPrim]
  /// The text of every `LabelKey` used by `labels` and `glyphs`.
  public var labelRuns: [LabelKey: LabelRun]
  public var refs: [PrimID: PrimRef]
  /// The reference's string ids (`display.mjs`), for G5.
  public var referenceIDs: [PrimID: String]
  public var lanes: [LaneSeries]
  public var simplified: SimplifiedReason?
  public var hit: HitGrid

  public init(originDay: Day, bands: [BandPrim] = [], washes: [WashPrim] = [], bars: [BarPrim] = [],
              ticks: [TickPrim] = [], diamonds: [DiamondPrim] = [], arcs: [ArcPrim] = [], glyphs: [GlyphPrim] = [],
              labels: [LabelPrim] = [], labelRuns: [LabelKey: LabelRun] = [:], refs: [PrimID: PrimRef] = [:],
              referenceIDs: [PrimID: String] = [:], lanes: [LaneSeries] = [], simplified: SimplifiedReason? = nil,
              hit: HitGrid) {
    self.originDay = originDay
    self.bands = bands
    self.washes = washes
    self.bars = bars
    self.ticks = ticks
    self.diamonds = diamonds
    self.arcs = arcs
    self.glyphs = glyphs
    self.labels = labels
    self.labelRuns = labelRuns
    self.refs = refs
    self.referenceIDs = referenceIDs
    self.lanes = lanes
    self.simplified = simplified
    self.hit = hit
  }

  /// A list with nothing in it (before the first tiles arrive).
  public static func empty(originDay: Day, pointsPerDay: Double) -> DisplayList {
    DisplayList(originDay: originDay, hit: HitGrid(pointsPerDay: pointsPerDay))
  }

  /// Instances across every primitive array (the renderer's budget counts these).
  public var instanceCount: Int {
    bands.count + washes.count + bars.count + ticks.count + diamonds.count + arcs.count + glyphs.count + labels.count
  }
}
