// OWNER: N0
// The Scroll's data (contract shapes `TimelineQueryRequest`, `TimelineQuery`, `Lane`, `Tiles`, `Cell`, `ShareCell`,
// `Wash`, `Marks`, `Arcs`, `Arc`, `ArcBucket`, `Shelf`, `BinDrawer`). GET request types mirror the reference's query
// parameters (server/routes/timeline.mjs).

import ScrollsCore

// MARK: - POST /api/timeline/query

/// A pinned strand: an expression or work (numeric ref) or a theme, maker, cluster or baseline (string ref).
public struct StrandRequest: Codable, Sendable, Equatable {
  /// `vocab.STRAND_TYPES`
  public var type: String
  public var ref: IntOrString
  public init(type: String, ref: IntOrString) {
    self.type = type
    self.ref = ref
  }
}

/// How lanes are formed and ordered.
public struct LanesRequest: Codable, Sendable, Equatable {
  /// `vocab.LANE_FACETS` (default 'domain').
  public var facet: String?
  /// `vocab.LANE_ORDERS` (default 'first_observed').
  public var order: String?
  /// 1–48.
  public var max: Int?
  /// The manual order of lane keys.
  public var manual: [String]?
  /// Context-group lanes: the clustering run (a saved view pins it).
  @NullOrAbsent public var run: RunID?

  public init(facet: String? = nil, order: String? = nil, max: Int? = nil, manual: [String]? = nil, run: RunID? = nil) {
    self.facet = facet
    self.order = order
    self.max = max
    self.manual = manual
    self.run = run
  }
}

/// The pins of a saved view opened as saved (D17): counting runs by expression, and a clustering run.
public struct PinnedRuns: Codable, Sendable, Equatable {
  /// Expression id → its materialize run.
  public var materialize: [String: Int]?
  public var cluster: RunID?
  public init(materialize: [String: Int]? = nil, cluster: RunID? = nil) {
    self.materialize = materialize
    self.cluster = cluster
  }
}

/// The cutoffs of a saved view opened as saved: the import cutoff, the save time, the annotation revision.
public struct ViewCutoffs: Codable, Sendable, Equatable {
  public var importBatch: ImportBatchID?
  /// ISO 8601 UTC save time: documents soft-deleted after it still count.
  public var at: String?
  public var annotationRev: Int?
  public init(importBatch: ImportBatchID? = nil, at: String? = nil, annotationRev: Int? = nil) {
    self.importBatch = importBatch
    self.at = at
    self.annotationRev = annotationRev
  }
}

/// Register a canonical query (contract shape `TimelineQueryRequest`).
public struct TimelineQueryRequest: Codable, Sendable, Equatable {
  public var strands: [StrandRequest]
  public var corpus: String
  public var lanes: LanesRequest
  /// The filter grammar string.
  public var f: String?
  /// `{tr, ds, ap, dup, nm, est, bp}` as 0/1.
  public var toggles: [String: Int]?
  /// 'publication' | 'referenced'
  public var timeBasis: String?
  public var runs: PinnedRuns?
  public var cutoffs: ViewCutoffs?
  /// A saved view's annotation revision cutoff (human labels of context groups as saved).
  @NullOrAbsent public var revCutoff: Int?

  public init(strands: [StrandRequest], corpus: String, lanes: LanesRequest, f: String? = nil, toggles: [String: Int]? = nil,
              timeBasis: String? = nil, runs: PinnedRuns? = nil, cutoffs: ViewCutoffs? = nil, revCutoff: Int? = nil) {
    self.strands = strands
    self.corpus = corpus
    self.lanes = lanes
    self.f = f
    self.toggles = toggles
    self.timeBasis = timeBasis
    self.runs = runs
    self.cutoffs = cutoffs
    self.revCutoff = revCutoff
  }

  enum CodingKeys: String, WireNamedKeys {
    case strands, corpus, lanes, f, toggles, timeBasis, runs, cutoffs, revCutoff
    static let wireNames = ["timeBasis": "timeBasis"]
  }
}

/// The registered query: its key, lanes (label · unit · coverage), extent, totals, modality seams and gates
/// (contract shape `TimelineQuery`).
public struct TimelineQueryResponse: Codable, Sendable, Equatable {
  public var queryKey: String
  public var dataVersion: Int
  /// 'ready' | 'materializing' | …
  public var status: String
  /// The counting job while materializing.
  @Nullable public var job: Int?
  public var units: [UnitLanes]
  public var lanes: [Lane]
  public var other: OtherLanes
  public var extent: Extent
  public var totals: TimelineTotals
  public var seams: [Seam]
  /// `{rates: {gate, coverage_gate, note}, cluster: {gate, …}}` (verbatim).
  public var gates: JSONValue
  public var provenance: Provenance
  /// 'ok' | 'not_run' | 'gated' | 'unavailable' | 'pending' (context-group lanes, C1).
  public var laneState: String?
  @NullOrAbsent public var laneNote: String?
  /// `{run: {stage, params}}`: the body to POST to /api/analysis/runs (verbatim).
  @NullOrAbsent public var suggestion: JSONValue?
  /// The failed gate of a gated lane state (verbatim; never a group).
  public var gate: JSONValue?
  /// `{run, groups, residual_groups, href, note}` (verbatim).
  public var cluster: JSONValue?
  public var trail: TrailInfo?
  @NullOrAbsent public var baseline: BaselineLink?
  public var claims: [ClaimMarker]?
  /// Per strand: `{baseline, claims}` (verbatim).
  public var strandExtras: JSONValue?
  public var laneOrderNote: String?
  @NullOrAbsent public var samplingNote: String?
  @NullOrAbsent public var timeBasisNote: String?
  /// True while a newer count is being made (the answer is the previous one).
  public var refreshing: Bool?
  public var mockNote: String?

  public init(queryKey: String, dataVersion: Int, status: String, job: Int?, units: [UnitLanes], lanes: [Lane],
              other: OtherLanes, extent: Extent, totals: TimelineTotals, seams: [Seam], gates: JSONValue,
              provenance: Provenance) {
    self.queryKey = queryKey
    self.dataVersion = dataVersion
    self.status = status
    self.job = job
    self.units = units
    self.lanes = lanes
    self.other = other
    self.extent = extent
    self.totals = totals
    self.seams = seams
    self.gates = gates
    self.provenance = provenance
  }

  enum CodingKeys: String, WireNamedKeys {
    case queryKey, dataVersion, status, job, units, lanes, other, extent, totals, seams, gates, provenance, laneState, laneNote
    case suggestion, gate, cluster, trail, baseline, claims, strandExtras, laneOrderNote, samplingNote, timeBasisNote
    case refreshing, mockNote
    static let wireNames = ["queryKey": "queryKey", "dataVersion": "dataVersion"]
  }
}

/// The lanes counted in one unit (units are never pooled).
public struct UnitLanes: Codable, Sendable, Equatable {
  /// `vocab.RATE_UNITS` key.
  public var unit: String
  public var lanes: [String]
  public init(unit: String, lanes: [String]) {
    self.unit = unit
    self.lanes = lanes
  }
}

/// A lane's label: a string, or for a context group `{machine, human}` (the machine label stays beside a rename).
public enum LaneLabel: Codable, Sendable, Equatable {
  case text(String)
  case group(machine: String, human: String?)

  private enum Keys: String, CodingKey { case machine, human }

  public init(from decoder: any Decoder) throws {
    if let s = try? decoder.singleValueContainer().decode(String.self) {
      self = .text(s)
      return
    }
    let c = try decoder.container(keyedBy: Keys.self)
    self = .group(machine: try c.decode(String.self, forKey: .machine), human: try c.decodeIfPresent(String.self, forKey: .human))
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .text(let s):
      var c = encoder.singleValueContainer()
      try c.encode(s)
    case .group(let machine, let human):
      var c = encoder.container(keyedBy: Keys.self)
      try c.encode(machine, forKey: .machine)
      if let human { try c.encode(human, forKey: .human) } else { try c.encodeNil(forKey: .human) }
    }
  }
}

/// A lane's first or last observation: its date label and precision, day bound, date basis and document.
public struct LaneEndpoint: Codable, Sendable, Equatable {
  public var label: String
  public var precision: String
  public var loDay: Int?
  public var hiDay: Int?
  public var basis: String?
  public var document: DocumentID?

  public init(label: String, precision: String, loDay: Int? = nil, hiDay: Int? = nil, basis: String? = nil,
              document: DocumentID? = nil) {
    self.label = label
    self.precision = precision
    self.loDay = loDay
    self.hiDay = hiDay
    self.basis = basis
    self.document = document
  }
}

/// Whether a lane's evidence is cut off at the edges of the view.
public struct LaneCensor: Codable, Sendable, Equatable {
  public var left: Bool
  public var right: Bool
  public init(left: Bool, right: Bool) {
    self.left = left
    self.right = right
  }
}

/// One strand's counts within a lane.
public struct LaneStrandCounts: Codable, Sendable, Equatable {
  public var n: Int
  public var docs: Int
  public var dated: Int
  public var undated: Int
  public var scheduled: Int
  public var namesExcluded: Int
  @Nullable public var first: LaneEndpoint?
  @Nullable public var last: LaneEndpoint?
  public var washesByTier: [String: Int]

  public init(n: Int, docs: Int, dated: Int, undated: Int, scheduled: Int, namesExcluded: Int, first: LaneEndpoint?,
              last: LaneEndpoint?, washesByTier: [String: Int]) {
    self.n = n
    self.docs = docs
    self.dated = dated
    self.undated = undated
    self.scheduled = scheduled
    self.namesExcluded = namesExcluded
    self.first = first
    self.last = last
    self.washesByTier = washesByTier
  }
}

/// A lane: label, unit, modality, coverage, counts, first/last observation, undated and scheduled, censoring
/// (contract shape `Lane`), plus the context-group (C1) and Term-trail (C2, C3) fields.
public struct Lane: Codable, Sendable, Equatable {
  public var key: String
  public var label: LaneLabel
  /// `vocab.RATE_UNITS` key; printed on every lane.
  public var unit: String
  public var modality: String
  public var orderRule: String
  /// `{tokens | works, docs, span, …}` (verbatim).
  public var coverage: JSONValue
  public var n: Int
  public var docs: Int
  @Nullable public var first: LaneEndpoint?
  @Nullable public var last: LaneEndpoint?
  public var undated: Int
  public var scheduled: Int
  public var undatedShare: Double
  public var censor: LaneCensor
  public var synthetic: Bool
  public var header: String?
  /// 'pending' while a collection of the lane's medium is still loading.
  public var state: String?
  public var note: String?
  public var selection: String?
  public var examples: JSONValue?
  @NullOrAbsent public var undatedWarning: String?
  /// The lane's rate gate (the minimum denominator), null when the lane carries no rate.
  @NullOrAbsent public var gate: Int?
  public var namesExcluded: Int?
  public var strands: [String: LaneStrandCounts]?
  // Term trail (C2, C3)
  public var kind: String?
  @NullOrAbsent public var trailField: String?
  public var cellFields: [String]?
  public var cellGate: Int?
  /// Etymology period bands `[{strand, href}]` (verbatim).
  public var bands: JSONValue?
  /// 'works' on a works-mode lane.
  public var mode: String?
  public var rateNote: String?
  // Context groups (C1)
  public var labelText: String?
  @NullOrAbsent public var clusterId: Int?
  @NullOrAbsent public var ord: Int?
  public var run: RunID?
  public var status: String?
  public var tentative: Bool?
  @NullOrAbsent public var stability: Double?
  public var groupSize: Int?

  public init(key: String, label: LaneLabel, unit: String, modality: String, orderRule: String, coverage: JSONValue, n: Int,
              docs: Int, first: LaneEndpoint?, last: LaneEndpoint?, undated: Int, scheduled: Int, undatedShare: Double,
              censor: LaneCensor, synthetic: Bool) {
    self.key = key
    self.label = label
    self.unit = unit
    self.modality = modality
    self.orderRule = orderRule
    self.coverage = coverage
    self.n = n
    self.docs = docs
    self.first = first
    self.last = last
    self.undated = undated
    self.scheduled = scheduled
    self.undatedShare = undatedShare
    self.censor = censor
    self.synthetic = synthetic
  }
}

/// Lanes folded into "other".
public struct OtherLanes: Codable, Sendable, Equatable {
  public var lanes: Int
  public var n: Int
  public var keys: [String]?
  public init(lanes: Int, n: Int, keys: [String]? = nil) {
    self.lanes = lanes
    self.n = n
    self.keys = keys
  }
}

/// The dated extent of the query's evidence.
public struct Extent: Codable, Sendable, Equatable {
  @Nullable public var from: String?
  @Nullable public var to: String?
  @NullOrAbsent public var fromDay: Int?
  @NullOrAbsent public var toDay: Int?
  public init(from: String?, to: String?, fromDay: Int? = nil, toDay: Int? = nil) {
    self.from = from
    self.to = to
    self.fromDay = fromDay
    self.toDay = toDay
  }
}

/// The conservation totals: Σ bin n + Σ wash n + undated + scheduled = n, per lane and tier.
public struct TimelineTotals: Codable, Sendable, Equatable {
  public var n: Int
  public var dated: Int
  public var undated: Int
  public var scheduled: Int
  public var namesExcluded: Int
  public var sampled: Bool
  public var washesByTier: [String: Int]
  /// Text matches and works apart (a Term trail counts both).
  public var byUnit: UnitTotals?
  public var unitsMixed: Bool?
  /// Per strand, each default exclusion (verbatim).
  public var excluded: JSONValue?

  public init(n: Int, dated: Int, undated: Int, scheduled: Int, namesExcluded: Int, sampled: Bool,
              washesByTier: [String: Int], byUnit: UnitTotals? = nil, unitsMixed: Bool? = nil, excluded: JSONValue? = nil) {
    self.n = n
    self.dated = dated
    self.undated = undated
    self.scheduled = scheduled
    self.namesExcluded = namesExcluded
    self.sampled = sampled
    self.washesByTier = washesByTier
    self.byUnit = byUnit
    self.unitsMixed = unitsMixed
    self.excluded = excluded
  }
}

/// Matches and works counted apart.
public struct UnitTotals: Codable, Sendable, Equatable {
  public var matches: Int
  public var works: Int
  public init(matches: Int, works: Int) {
    self.matches = matches
    self.works = works
  }
}

/// A change of medium drawn across the Scroll (full text ends → titles and abstracts): never a change of meaning.
public struct Seam: Codable, Sendable, Equatable {
  public var kind: String
  public var year: Int
  public var lastCoveredYear: Int?
  public var label: String
  public var collapsible: Bool
  public var hideable: Bool
  public init(kind: String, year: Int, lastCoveredYear: Int? = nil, label: String, collapsible: Bool, hideable: Bool) {
    self.kind = kind
    self.year = year
    self.lastCoveredYear = lastCoveredYear
    self.label = label
    self.collapsible = collapsible
    self.hideable = hideable
  }
}

/// The Term trail's lanes, the lanes the corpora cannot show, and matches outside every lane (C2).
public struct TrailInfo: Codable, Sendable, Equatable {
  public var lanes: [String]
  /// `[{key, label, reason}]` (verbatim).
  public var absent: JSONValue
  public var outside: [String: Int]
  public var note: String?
  public var memberCorpora: Int?
  public init(lanes: [String], absent: JSONValue, outside: [String: Int], note: String? = nil, memberCorpora: Int? = nil) {
    self.lanes = lanes
    self.absent = absent
    self.outside = outside
    self.note = note
    self.memberCorpora = memberCorpora
  }
}

/// Where the Ngram baseline of a single English word is.
public struct BaselineLink: Codable, Sendable, Equatable {
  public var available: Bool
  @Nullable public var href: String?
  @NullOrAbsent public var reason: String?
  public init(available: Bool, href: String?, reason: String? = nil) {
    self.available = available
    self.href = href
    self.reason = reason
  }
}

// MARK: - GET /api/timeline/tiles

/// GET /api/timeline/tiles query.
public struct TilesRequest: Codable, Sendable, Equatable {
  /// The queryKey.
  public var q: String
  /// 'L0' … 'L5'
  public var tier: String
  /// Tile indices, or `a..b` ranges, comma-separated.
  public var tiles: String
  public init(q: String, tier: String, tiles: String) {
    self.q = q
    self.tier = tier
    self.tiles = tiles
  }
}

/// Binned cells, washes, coverage, first/last days and OpenAlex share cells per lane and strand (contract shape `Tiles`).
public struct TilesResponse: Codable, Sendable, Equatable {
  public var queryKey: String
  public var tier: String
  @Nullable public var binWidth: Double?
  public var dataVersion: Int
  public var tiles: [Tile]

  public init(queryKey: String, tier: String, binWidth: Double?, dataVersion: Int, tiles: [Tile]) {
    self.queryKey = queryKey
    self.tier = tier
    self.binWidth = binWidth
    self.dataVersion = dataVersion
    self.tiles = tiles
  }

  enum CodingKeys: String, WireNamedKeys {
    case queryKey, tier, binWidth, dataVersion, tiles
    static let wireNames = ["queryKey": "queryKey", "binWidth": "binWidth", "dataVersion": "dataVersion"]
  }
}

/// One tile of 64 bins.
public struct Tile: Codable, Sendable, Equatable {
  public var tile: Int
  public var bin0: Int
  /// lane → strand → cells.
  public var lanes: [String: TileLane]
  /// lane → `[binIndexInTile, …]` coverage rows (five integers each).
  public var coverage: [String: [[Int]]]
  public var washes: [Wash]
  /// lane → strand → `[[binIndexInTile, first lo_day, last hi_day]]`.
  public var days: [String: [String: [[Int]]]]?
  /// lane → strand → OpenAlex share cells overlapping the tile's years (C3).
  public var cells: [String: [String: [ShareCell]]]?

  public init(tile: Int, bin0: Int, lanes: [String: TileLane], coverage: [String: [[Int]]], washes: [Wash],
              days: [String: [String: [[Int]]]]? = nil, cells: [String: [String: [ShareCell]]]? = nil) {
    self.tile = tile
    self.bin0 = bin0
    self.lanes = lanes
    self.coverage = coverage
    self.washes = washes
    self.days = days
    self.cells = cells
  }
}

/// A lane of a tile: cells by strand.
public struct TileLane: Codable, Sendable, Equatable {
  public var strands: [String: [TileCell]]
  public init(strands: [String: [TileCell]]) { self.strands = strands }
}

/// A tile cell `[binIndexInTile, n, docs, authors, denom, rate, ci_lo, ci_hi, state, flags, dp]` (contract shape `Cell`).
/// States: 1 observed · 2 absent (looked, found none) · 3 low · 4 uncovered · 5 pending. A low, uncovered or pending
/// cell carries no rate or CI (SPEC §13 rule 3); read `state` first, as the reference client does.
public struct TileCell: Codable, Sendable, Equatable {
  public var bin: Int
  public var n: Int
  public var docs: Int
  public var authors: Int
  public var denom: Double
  public var rate: Double?
  public var ciLo: Double?
  public var ciHi: Double?
  public var state: Int
  /// 1 sparse · 2 single source · 4 estimated majority · 8 sampled · 16 synthetic · 32 names excluded · 64 translations.
  public var flags: Int
  /// Gries' DP (dispersion), when computed.
  public var dp: Double?

  public init(bin: Int, n: Int, docs: Int, authors: Int, denom: Double, rate: Double?, ciLo: Double?, ciHi: Double?,
              state: Int, flags: Int, dp: Double?) {
    self.bin = bin
    self.n = n
    self.docs = docs
    self.authors = authors
    self.denom = denom
    self.rate = rate
    self.ciLo = ciLo
    self.ciHi = ciHi
    self.state = state
    self.flags = flags
    self.dp = dp
  }

  public init(from decoder: any Decoder) throws {
    var c = try decoder.unkeyedContainer()
    bin = try c.decode(Int.self)
    n = try c.decode(Int.self)
    docs = try c.decode(Int.self)
    authors = try c.decode(Int.self)
    denom = try c.decode(Double.self)
    rate = try c.decodeNil() ? nil : try c.decode(Double.self)
    ciLo = try c.decodeNil() ? nil : try c.decode(Double.self)
    ciHi = try c.decodeNil() ? nil : try c.decode(Double.self)
    state = try c.decode(Int.self)
    flags = try c.decode(Int.self)
    dp = try c.decodeNil() ? nil : try c.decode(Double.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.unkeyedContainer()
    try c.encode(bin)
    try c.encode(n)
    try c.encode(docs)
    try c.encode(authors)
    try c.encode(denom)
    for v in [rate, ciLo, ciHi] { if let v { try c.encode(v) } else { try c.encodeNil() } }
    try c.encode(state)
    try c.encode(flags)
    if let dp { try c.encode(dp) } else { try c.encodeNil() }
  }
}

/// A record whose date does not fit the bin: drawn as a wash over its range (contract shape `Wash`).
public struct Wash: Codable, Sendable, Equatable {
  public var lane: String
  public var strand: IntOrString
  public var lo: String
  public var hi: String
  public var precision: String
  public var label: String
  public var n: Int
  /// Stable across tiles: dedupe by key.
  public var key: String?
  /// True only in the tile of the wash's first bin.
  public var owner: Bool?
  public var loDay: Int?
  public var hiDay: Int?
  public var synthetic: Bool?

  public init(lane: String, strand: IntOrString, lo: String, hi: String, precision: String, label: String, n: Int,
              key: String? = nil, owner: Bool? = nil, loDay: Int? = nil, hiDay: Int? = nil, synthetic: Bool? = nil) {
    self.lane = lane
    self.strand = strand
    self.lo = lo
    self.hi = hi
    self.precision = precision
    self.label = label
    self.n = n
    self.key = key
    self.owner = owner
    self.loDay = loDay
    self.hiDay = hiDay
    self.synthetic = synthetic
  }
}

/// One OpenAlex cell of a share lane: k of n sampled works, Wilson CI; a low (n < 20) or uncovered cell carries no share
/// (contract shape `ShareCell`). Never a cross-cell rate or trend.
public struct ShareCell: Codable, Sendable, Equatable {
  public var loYear: Int
  public var hiYear: Int
  public var field: String
  public var cell: String
  public var k: Int
  public var n: Int
  public var nCell: Int?
  @Nullable public var share: Double?
  @Nullable public var ci: [Double]?
  /// 'observed' | 'absent' | 'low' | 'uncovered'
  public var state: String
  public var owner: Bool?
  public var label: String?
  public var text: String?
  public var synthetic: Bool?

  public init(loYear: Int, hiYear: Int, field: String, cell: String, k: Int, n: Int, nCell: Int? = nil, share: Double?,
              ci: [Double]?, state: String, owner: Bool? = nil, label: String? = nil, text: String? = nil,
              synthetic: Bool? = nil) {
    self.loYear = loYear
    self.hiYear = hiYear
    self.field = field
    self.cell = cell
    self.k = k
    self.n = n
    self.nCell = nCell
    self.share = share
    self.ci = ci
    self.state = state
    self.owner = owner
    self.label = label
    self.text = text
    self.synthetic = synthetic
  }
}

// MARK: - GET /api/timeline/marks

/// GET /api/timeline/marks query: individual matches in a range.
public struct MarksRequest: Codable, Sendable, Equatable {
  public var q: String
  /// Day numbers.
  public var from: Int?
  public var to: Int?
  public var lane: String?
  public var strand: String?
  /// ≤ 4,000 (default 4,000).
  public var limit: Int?
  public init(q: String, from: Int? = nil, to: Int? = nil, lane: String? = nil, strand: String? = nil, limit: Int? = nil) {
    self.q = q
    self.from = from
    self.to = to
    self.lane = lane
    self.strand = strand
    self.limit = limit
  }
}

/// Individual matches, each resolving to its passage (contract shape `Marks`).
public struct MarksResponse: Codable, Sendable, Equatable {
  public var marks: [Mark]
  public var truncated: Bool
  public var total: Int
  public var sampled: Bool?
  public init(marks: [Mark], truncated: Bool, total: Int, sampled: Bool? = nil) {
    self.marks = marks
    self.truncated = truncated
    self.total = total
    self.sampled = sampled
  }
}

/// One match on the Scroll.
public struct Mark: Codable, Sendable, Equatable {
  @Nullable public var occ: OccurrenceID?
  public var passage: PassageID
  public var doc: DocumentID
  public var lane: String
  public var strand: IntOrString
  public var loDay: Int
  public var hiDay: Int
  public var precision: String
  public var basis: String
  public var kind: String
  public var nameFlag: Bool
  public var synthetic: Bool

  public init(occ: OccurrenceID?, passage: PassageID, doc: DocumentID, lane: String, strand: IntOrString, loDay: Int,
              hiDay: Int, precision: String, basis: String, kind: String, nameFlag: Bool, synthetic: Bool) {
    self.occ = occ
    self.passage = passage
    self.doc = doc
    self.lane = lane
    self.strand = strand
    self.loDay = loDay
    self.hiDay = hiDay
    self.precision = precision
    self.basis = basis
    self.kind = kind
    self.nameFlag = nameFlag
    self.synthetic = synthetic
  }
}

// MARK: - GET /api/timeline/arcs

/// GET /api/timeline/arcs query: relationship arcs in a range at a vantage.
public struct ArcsRequest: Codable, Sendable, Equatable {
  public var q: String
  public var from: Int?
  public var to: Int?
  /// The vantage day.
  public var vantage: Int?
  /// Evidence filter ('d' documented only, …).
  public var ev: String?
  /// Default 300.
  public var limit: Int?
  public var tier: String?
  public var relRevCutoff: Int?
  public var revCutoff: Int?
  /// Pinned run ids, comma-separated (a saved view read as saved).
  public var runs: String?
  /// `document:<id>` | `passage:<id>` | `occurrence:<id>`: arcs touching it come first, marked `selected`.
  public var sel: String?
  /// Individual arcs up to 1,500 over a range narrower than 50 years.
  public var detail: Bool?
  /// Lane keys, comma-separated.
  public var lanes: String?

  public init(q: String, from: Int? = nil, to: Int? = nil, vantage: Int? = nil, ev: String? = nil, limit: Int? = nil,
              tier: String? = nil, relRevCutoff: Int? = nil, revCutoff: Int? = nil, runs: String? = nil, sel: String? = nil,
              detail: Bool? = nil, lanes: String? = nil) {
    self.q = q
    self.from = from
    self.to = to
    self.vantage = vantage
    self.ev = ev
    self.limit = limit
    self.tier = tier
    self.relRevCutoff = relRevCutoff
    self.revCutoff = revCutoff
    self.runs = runs
    self.sel = sel
    self.detail = detail
    self.lanes = lanes
  }
}

/// Arcs in range: individual arcs within the tier budget (forward above, feedback below), bundles and hidden counts, or
/// a summary of buckets (contract shape `Arcs`).
public struct ArcsResponse: Codable, Sendable, Equatable {
  public var total: Int
  public var returned: Int
  /// Hidden arcs by reason (budget, kindred, rejected, filtered, vantage, outside).
  public var hidden: [String: Int]
  public var items: [Arc]
  /// `[{lanes, bins, tier, count, width, status, label}]` (verbatim).
  public var bundles: JSONValue
  public var budget: Int?
  @NullOrAbsent public var chip: ArcChip?
  /// Re-reading halos (verbatim).
  public var halos: JSONValue?
  /// Annotated feedback (verbatim).
  public var annotated: JSONValue?
  public var scope: String?
  /// 'individual' | 'summary' (C4)
  public var mode: String?
  public var buckets: [ArcBucket]?
  public var individual: [Arc]?
  public var candidates: Int?
  public var bucketLevel: Int?
  public var bucketWidth: Int?
  public var detail: Bool?
  public var summaryNote: String?

  public init(total: Int, returned: Int, hidden: [String: Int], items: [Arc], bundles: JSONValue) {
    self.total = total
    self.returned = returned
    self.hidden = hidden
    self.items = items
    self.bundles = bundles
  }
}

/// The "+N more arcs (filtered)" chip.
public struct ArcChip: Codable, Sendable, Equatable {
  public var count: Int
  public var label: String
  public init(count: Int, label: String) {
    self.count = count
    self.label = label
  }
}

/// An end of an arc: its passage or document, year, lane and day bounds.
public struct ArcEnd: Codable, Sendable, Equatable {
  @NullOrAbsent public var passage: PassageID?
  @NullOrAbsent public var doc: DocumentID?
  @Nullable public var y: Int?
  @NullOrAbsent public var lane: String?
  @NullOrAbsent public var loDay: Int?
  @NullOrAbsent public var hiDay: Int?

  public init(passage: PassageID? = nil, doc: DocumentID? = nil, y: Int?, lane: String? = nil, loDay: Int? = nil,
              hiDay: Int? = nil) {
    self.passage = passage
    self.doc = doc
    self.y = y
    self.lane = lane
    self.loDay = loDay
    self.hiDay = hiDay
  }
}

/// A relationship drawn as an arc (contract shape `Arc`). Feedback arcs come only from feedback-capable types, never
/// from computed similarity, and a date conflict is never feedback (SPEC §13 rule 6).
public struct Arc: Codable, Sendable, Equatable {
  public var relId: RelationshipID
  public var relType: String
  public var family: String
  /// 'documented' | 'computed' | 'proposed'
  public var evidenceStatus: String
  public var provenanceQuality: String?
  public var reviewStatus: String?
  public var cue: Bool?
  public var src: ArcEnd
  public var dst: ArcEnd
  public var feedback: Bool
  public var dateConflict: Bool?
  public var synthetic: Bool
  public var source: String?
  @NullOrAbsent public var runId: RunID?
  public var tokens: Int?
  @NullOrAbsent public var hypothesisGroup: HypothesisGroupID?
  public var human: Bool?
  public var glyph: String?
  public var directed: Bool?
  @NullOrAbsent public var score: Score?
  /// Touches the selected item (summary mode).
  public var selected: Bool?

  public init(relId: RelationshipID, relType: String, family: String, evidenceStatus: String, src: ArcEnd, dst: ArcEnd,
              feedback: Bool, synthetic: Bool) {
    self.relId = relId
    self.relType = relType
    self.family = family
    self.evidenceStatus = evidenceStatus
    self.src = src
    self.dst = dst
    self.feedback = feedback
    self.synthetic = synthetic
  }
}

/// Arcs of a summary per (lane pair, bin pair), by evidence status (contract shape `ArcBucket`, C4).
public struct ArcBucket: Codable, Sendable, Equatable {
  @Nullable public var srcLane: String?
  @Nullable public var dstLane: String?
  public var srcBin: Int
  public var dstBin: Int
  public var n: Int
  public var byStatus: StatusCounts
  public var feedback: Int?
  public var dateConflicts: Int?
  public var synthetic: Bool?
  /// `[lo, hi]` years of the source bin.
  public var srcYears: [Int]?
  public var dstYears: [Int]?

  public init(srcLane: String?, dstLane: String?, srcBin: Int, dstBin: Int, n: Int, byStatus: StatusCounts,
              feedback: Int? = nil, dateConflicts: Int? = nil, synthetic: Bool? = nil, srcYears: [Int]? = nil,
              dstYears: [Int]? = nil) {
    self.srcLane = srcLane
    self.dstLane = dstLane
    self.srcBin = srcBin
    self.dstBin = dstBin
    self.n = n
    self.byStatus = byStatus
    self.feedback = feedback
    self.dateConflicts = dateConflicts
    self.synthetic = synthetic
    self.srcYears = srcYears
    self.dstYears = dstYears
  }
}

/// Counts by evidence status (they add up to the bucket's n).
public struct StatusCounts: Codable, Sendable, Equatable {
  public var documented: Int
  public var computed: Int
  public var proposed: Int
  public init(documented: Int, computed: Int, proposed: Int) {
    self.documented = documented
    self.computed = computed
    self.proposed = proposed
  }
}

// MARK: - shelf and bin drawer

/// GET /api/timeline/shelf query: UNDATED, SCHEDULED or washes.
public struct ShelfRequest: Codable, Sendable, Equatable {
  public var q: String
  /// 'undated' (default) | 'scheduled' | 'washes'
  public var which: String?
  public var lane: String?
  public var tier: String?
  public var cursor: String?
  /// Default 50.
  public var limit: Int?
  public init(q: String, which: String? = nil, lane: String? = nil, tier: String? = nil, cursor: String? = nil,
              limit: Int? = nil) {
    self.q = q
    self.which = which
    self.lane = lane
    self.tier = tier
    self.cursor = cursor
    self.limit = limit
  }
}

/// A shelf list (contract shape `Shelf`).
public struct ShelfResponse: Codable, Sendable, Equatable {
  public var which: String
  public var total: Int
  /// Rows of the shelf (documents and passages, or washes), verbatim.
  public var items: JSONValue
  @NullOrAbsent public var cursor: String?
  public init(which: String, total: Int, items: JSONValue, cursor: String? = nil) {
    self.which = which
    self.total = total
    self.items = items
    self.cursor = cursor
  }
}

/// GET /api/timeline/bin query: a bin's drawer (or an OpenAlex cell's, with `cell`).
public struct BinRequest: Codable, Sendable, Equatable {
  public var q: String
  public var lane: String
  public var strand: String?
  public var tier: String?
  public var bin: Int?
  /// `<field>|<lo>-<hi>` on a share lane.
  public var cell: String?
  public var cursor: String?
  public var limit: Int?
  public init(q: String, lane: String, strand: String? = nil, tier: String? = nil, bin: Int? = nil, cell: String? = nil,
              cursor: String? = nil, limit: Int? = nil) {
    self.q = q
    self.lane = lane
    self.strand = strand
    self.tier = tier
    self.bin = bin
    self.cell = cell
    self.cursor = cursor
    self.limit = limit
  }
}

/// The bin drawer: the denominator line, then KWIC rows sorted by date (contract shape `BinDrawer`).
public struct BinResponse: Codable, Sendable, Equatable {
  /// The cell's numbers in words and figures (verbatim).
  public var denominator: JSONValue
  public var rows: [KwicRow]
  @NullOrAbsent public var cursor: String?
  public var total: Int?
  public init(denominator: JSONValue, rows: [KwicRow], cursor: String? = nil, total: Int? = nil) {
    self.denominator = denominator
    self.rows = rows
    self.cursor = cursor
    self.total = total
  }
}
