// OWNER: N0
// Compare, collocations, context groups (clusters), analysis runs and the constellation (contract shapes
// `CompareRequest`, `Compare`, `Measure`, `BaselineRho`, `Collocations`, `Clusters`, `AnalysisRunRequest`,
// `AnalysisRunStarted`, `AnalysisRuns`, `Constellation`). Every gate is a `Gated` value: a gated measure carries no
// numeral (SPEC §13 rule 7).

import ScrollsCore

// MARK: - POST /api/compare

/// One slice of a comparison: a year range and a filter.
public struct CompareSlice: Codable, Sendable, Equatable {
  /// `[lo, hi]` years, inclusive.
  public var years: [Int]
  public var f: String?
  public init(years: [Int], f: String? = nil) {
    self.years = years
    self.f = f
  }
}

/// Compare two slices (contract shape `CompareRequest`).
public struct CompareRequest: Codable, Sendable, Equatable {
  public var expr: [ExpressionID]
  public var a: CompareSlice
  public var b: CompareSlice
  public var measures: [String]?
  /// A saved view opened as saved: its pins (RF-2).
  public var runs: PinnedRuns?
  public var cutoffs: ViewCutoffs?
  /// Reshuffles the passage sample.
  public var seed: Int?
  /// 'descriptive': compare anyway — rates in their own units, no ratio, test or verdict.
  public var override: String?
  public var toggles: [String: Int]?
  public var laneFacet: String?
  public var corpus: String?

  public init(expr: [ExpressionID], a: CompareSlice, b: CompareSlice, measures: [String]? = nil, runs: PinnedRuns? = nil,
              cutoffs: ViewCutoffs? = nil, seed: Int? = nil, override: String? = nil, toggles: [String: Int]? = nil,
              laneFacet: String? = nil, corpus: String? = nil) {
    self.expr = expr
    self.a = a
    self.b = b
    self.measures = measures
    self.runs = runs
    self.cutoffs = cutoffs
    self.seed = seed
    self.override = override
    self.toggles = toggles
    self.laneFacet = laneFacet
    self.corpus = corpus
  }
}

/// Multiplicity first: how many comparisons this session has made, and the notable threshold.
public struct CompareMultiplicity: Codable, Sendable, Equatable {
  public var k: Int
  public var notableSoFar: Int
  public var thresholdPercentile: Double
  public var text: String?
  public var expectedByChance: Double?
  public init(k: Int, notableSoFar: Int, thresholdPercentile: Double, text: String? = nil, expectedByChance: Double? = nil) {
    self.k = k
    self.notableSoFar = notableSoFar
    self.thresholdPercentile = thresholdPercentile
    self.text = text
    self.expectedByChance = expectedByChance
  }
}

/// Coverage and composition of both slices, before any frequency.
public struct CompareCoverage: Codable, Sendable, Equatable {
  /// Tokens, documents, authors, mix, modality and basis of slice A (verbatim).
  public var a: JSONValue
  public var b: JSONValue
  @Nullable public var compositionJsd: Double?
  public var caveats: [String]
  public var modalityGate: String
  public var prominence: JSONValue?
  public var modalityCompared: String?
  public var descriptiveOverride: Bool?
  /// The vector spaces available for the drift measures (verbatim).
  public var spaces: JSONValue?
  /// OpenAlex within-cell shares (verbatim; never a cross-cell rate).
  public var withinCell: JSONValue?

  public init(a: JSONValue, b: JSONValue, compositionJsd: Double?, caveats: [String], modalityGate: String,
              prominence: JSONValue? = nil, modalityCompared: String? = nil, descriptiveOverride: Bool? = nil,
              spaces: JSONValue? = nil, withinCell: JSONValue? = nil) {
    self.a = a
    self.b = b
    self.compositionJsd = compositionJsd
    self.caveats = caveats
    self.modalityGate = modalityGate
    self.prominence = prominence
    self.modalityCompared = modalityCompared
    self.descriptiveOverride = descriptiveOverride
    self.spaces = spaces
    self.withinCell = withinCell
  }
}

/// The passage sample of both slices.
public struct ComparePassages: Codable, Sendable, Equatable {
  /// KWIC-like rows of slice A (verbatim).
  public var a: JSONValue
  public var b: JSONValue
  public var seed: Int
  @NullOrAbsent public var stratifiedBy: JSONValue?
  public var note: String?
  public init(a: JSONValue, b: JSONValue, seed: Int, stratifiedBy: JSONValue? = nil, note: String? = nil) {
    self.a = a
    self.b = b
    self.seed = seed
    self.stratifiedBy = stratifiedBy
    self.note = note
  }
}

/// The comparison: multiplicity, coverage and composition first, then frequency with CIs, passages, collocates,
/// context groups, gated measures, tone and human counts (contract shape `Compare`).
public struct CompareResponse: Codable, Sendable, Equatable {
  public var multiplicity: CompareMultiplicity
  public var coverage: CompareCoverage
  /// Rates of A and B with CIs, the rate ratio (each may be gated), standardized rates (verbatim).
  public var freq: JSONValue
  public var passages: ComparePassages
  /// Collocates of A and B, shared, keyness — or a gate (verbatim).
  public var collocates: JSONValue
  /// Context-group shares — or a gate, or null (verbatim).
  public var clusters: JSONValue
  public var measures: [Measure]
  /// Tone — or a gate (verbatim).
  public var tone: JSONValue
  /// Counts of human annotations (verbatim).
  public var human: JSONValue?
  @Nullable public var coverageNote: String?
  public var provenance: Provenance
  public var baselineRho: BaselineRho?
  /// Present only for a comparison computed as saved: the pins and cutoffs it used (RF-2).
  public var asSaved: JSONValue?
  public var version: String?
  public var expressions: JSONValue?
  public var toggles: JSONValue?
  public var mockNote: String?

  public init(multiplicity: CompareMultiplicity, coverage: CompareCoverage, freq: JSONValue, passages: ComparePassages,
              collocates: JSONValue, clusters: JSONValue, measures: [Measure], tone: JSONValue, coverageNote: String?,
              provenance: Provenance) {
    self.multiplicity = multiplicity
    self.coverage = coverage
    self.freq = freq
    self.passages = passages
    self.collocates = collocates
    self.clusters = clusters
    self.measures = measures
    self.tone = tone
    self.coverageNote = coverageNote
    self.provenance = provenance
  }
}

/// A drift or shift measure (contract shape `Measure`): an estimate when its gate passes, otherwise the gate. The
/// slice counts (`n`, `docs`, `authors`) and the note are shown in both states.
public struct Measure: Codable, Sendable, Equatable {
  /// `vocab.DRIFT_METRICS`
  public var metric: String
  public var result: Gated<MeasureEstimate>
  /// `[A, B]` occurrences.
  public var n: [Int]?
  public var docs: [Int]?
  public var authors: [Int]?
  public var note: String?

  public init(metric: String, result: Gated<MeasureEstimate>, n: [Int]? = nil, docs: [Int]? = nil, authors: [Int]? = nil,
              note: String? = nil) {
    self.metric = metric
    self.result = result
    self.n = n
    self.docs = docs
    self.authors = authors
    self.note = note
  }

  private enum CodingKeys: String, CodingKey { case metric, n, docs, authors, note }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    metric = try c.decode(String.self, forKey: .metric)
    n = try c.decodeIfPresent([Int].self, forKey: .n)
    docs = try c.decodeIfPresent([Int].self, forKey: .docs)
    authors = try c.decodeIfPresent([Int].self, forKey: .authors)
    note = try c.decodeIfPresent(String.self, forKey: .note)
    result = try Gated(from: decoder)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(metric, forKey: .metric)
    try c.encodeIfPresent(n, forKey: .n)
    try c.encodeIfPresent(docs, forKey: .docs)
    try c.encodeIfPresent(authors, forKey: .authors)
    try c.encodeIfPresent(note, forKey: .note)
    try result.encode(to: encoder)
  }
}

/// A measure's estimate, with its interval and the run, controls and verdict behind it.
public struct MeasureEstimate: GatedValue {
  public static let nullKeysWhenGated = ["value", "ci"]

  public var value: Double
  @NullOrAbsent public var ci: [Double]?
  public var text: String?
  public var jaccard: Double?
  public var controls: Int?
  public var neighbours: JSONValue?
  public var k: Int?
  public var percentile: Double?
  public var run: RunID?
  public var anchors: Int?
  public var anchorsAvailable: Int?
  public var meanAnchorCos: Double?
  public var meanAnchorCosBefore: Double?
  public var excludedNeighbours: JSONValue?
  public var thresholdPercentile: Double?
  public var verdict: String?
  @NullOrAbsent public var verdictNote: String?

  public init(value: Double, ci: [Double]?, text: String? = nil) {
    self.value = value
    self.ci = ci
    self.text = text
  }
}

/// Spearman ρ of the strand's per-decade rate against the Ngram baseline (contract shape `BaselineRho`): unavailable
/// (with a reason), or a gate — an ok gate carries ρ and its CI, any other gate carries no numeral.
public struct BaselineRho: Codable, Sendable, Equatable {
  public var available: Bool
  public var reason: String?
  @NullOrAbsent public var note: String?
  /// nil when the correlation is unavailable (no gate key).
  public var result: Gated<RhoEstimate>?
  public var nBins: Int?
  public var years: [Int]?
  public var unit: String?
  public var forms: [String]?
  public var formsMissing: [String]?
  @NullOrAbsent public var label: String?
  @NullOrAbsent public var attribution: String?
  @NullOrAbsent public var license: String?
  public var caveats: [String]?
  public var rule: String?
  public var series: [BaselineRhoDecade]?

  public init(available: Bool, reason: String? = nil, note: String? = nil, result: Gated<RhoEstimate>? = nil) {
    self.available = available
    self.reason = reason
    self.note = note
    self.result = result
  }

  private enum CodingKeys: String, CodingKey {
    case available, reason, note, gate, nBins, years, unit, forms, formsMissing, label, attribution, license, caveats, rule, series
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    available = try c.decode(Bool.self, forKey: .available)
    reason = try c.decodeIfPresent(String.self, forKey: .reason)
    _note = try c.decode(NullOrAbsent<String>.self, forKey: .note)
    result = c.contains(.gate) ? try Gated(from: decoder) : nil
    nBins = try c.decodeIfPresent(Int.self, forKey: .nBins)
    years = try c.decodeIfPresent([Int].self, forKey: .years)
    unit = try c.decodeIfPresent(String.self, forKey: .unit)
    forms = try c.decodeIfPresent([String].self, forKey: .forms)
    formsMissing = try c.decodeIfPresent([String].self, forKey: .formsMissing)
    _label = try c.decode(NullOrAbsent<String>.self, forKey: .label)
    _attribution = try c.decode(NullOrAbsent<String>.self, forKey: .attribution)
    _license = try c.decode(NullOrAbsent<String>.self, forKey: .license)
    caveats = try c.decodeIfPresent([String].self, forKey: .caveats)
    rule = try c.decodeIfPresent(String.self, forKey: .rule)
    series = try c.decodeIfPresent([BaselineRhoDecade].self, forKey: .series)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(available, forKey: .available)
    try c.encodeIfPresent(reason, forKey: .reason)
    try c.encode(_note, forKey: .note)
    try result?.encode(to: encoder)
    try c.encodeIfPresent(nBins, forKey: .nBins)
    try c.encodeIfPresent(years, forKey: .years)
    try c.encodeIfPresent(unit, forKey: .unit)
    try c.encodeIfPresent(forms, forKey: .forms)
    try c.encodeIfPresent(formsMissing, forKey: .formsMissing)
    try c.encode(_label, forKey: .label)
    try c.encode(_attribution, forKey: .attribution)
    try c.encode(_license, forKey: .license)
    try c.encodeIfPresent(caveats, forKey: .caveats)
    try c.encodeIfPresent(rule, forKey: .rule)
    try c.encodeIfPresent(series, forKey: .series)
  }
}

/// ρ with its moving-block bootstrap CI, the decades it spans, the method and the sentence.
public struct RhoEstimate: GatedValue {
  public static let nullKeysWhenGated = ["value", "ci"]
  public var value: Double
  @NullOrAbsent public var ci: [Double]?
  @NullOrAbsent public var span: [Int]?
  public var method: String?
  public var text: String?
  public init(value: Double, ci: [Double]?, span: [Int]? = nil, method: String? = nil, text: String? = nil) {
    self.value = value
    self.ci = ci
    self.span = span
    self.method = method
    self.text = text
  }
}

/// One decade of the ρ series: our count and rate (null below our rate gate) beside Google's rate and volumes.
public struct BaselineRhoDecade: Codable, Sendable, Equatable {
  public var decade: Int
  /// 'a' | 'b'
  public var slice: String
  public var n: Int
  public var tokens: Int
  @Nullable public var rate: Double?
  public var lowCoverage: Bool
  @Nullable public var baselinePerMillion: Double?
  public var volumes: Int
  public var thin: Bool
  public var shared: Bool
  public init(decade: Int, slice: String, n: Int, tokens: Int, rate: Double?, lowCoverage: Bool, baselinePerMillion: Double?,
              volumes: Int, thin: Bool, shared: Bool) {
    self.decade = decade
    self.slice = slice
    self.n = n
    self.tokens = tokens
    self.rate = rate
    self.lowCoverage = lowCoverage
    self.baselinePerMillion = baselinePerMillion
    self.volumes = volumes
    self.thin = thin
    self.shared = shared
  }
}

// MARK: - collocations and clusters

/// GET /api/collocations query.
public struct CollocationsRequest: Codable, Sendable, Equatable {
  public var expr: ExpressionID
  /// `<lo>-<hi>` years.
  public var slice: String?
  public var f: String?
  /// `{tr, ds, ap, dup, nm, est, bp}` as 0/1.
  public var toggles: [String: Int]?
  /// Stop-word handling.
  public var stop: String?
  public var corpus: String?
  public var seed: Int?
  public var lane: String?
  /// ≤ 200 (default 100).
  public var limit: Int?
  public init(expr: ExpressionID, slice: String? = nil, f: String? = nil, toggles: [String: Int]? = nil, stop: String? = nil,
              corpus: String? = nil, seed: Int? = nil, lane: String? = nil, limit: Int? = nil) {
    self.expr = expr
    self.slice = slice
    self.f = f
    self.toggles = toggles
    self.stop = stop
    self.corpus = corpus
    self.seed = seed
    self.lane = lane
    self.limit = limit
  }
}

/// Collocates of an expression in a slice (logDice; G² ≥ 10.83, f ≥ 5, q < .05), or the gate with a widening
/// suggestion and the KWIC rows shown instead (contract shape `Collocations`).
public struct CollocationsResponse: Codable, Sendable, Equatable {
  public var expr: ExpressionID?
  public var slice: String?
  public var result: Gated<CollocationsResult>
  public var note: String?
  /// What the gated answer shows instead.
  public var kwic: [KwicRow]?

  public init(expr: ExpressionID? = nil, slice: String? = nil, result: Gated<CollocationsResult>, note: String? = nil,
              kwic: [KwicRow]? = nil) {
    self.expr = expr
    self.slice = slice
    self.result = result
    self.note = note
    self.kwic = kwic
  }

  private enum CodingKeys: String, CodingKey { case expr, slice, note, kwic }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    expr = try c.decodeIfPresent(ExpressionID.self, forKey: .expr)
    slice = try c.decodeIfPresent(String.self, forKey: .slice)
    note = try c.decodeIfPresent(String.self, forKey: .note)
    kwic = try c.decodeIfPresent([KwicRow].self, forKey: .kwic)
    result = try Gated(from: decoder)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(expr, forKey: .expr)
    try c.encodeIfPresent(slice, forKey: .slice)
    try c.encodeIfPresent(note, forKey: .note)
    try c.encodeIfPresent(kwic, forKey: .kwic)
    try result.encode(to: encoder)
  }
}

/// The collocates of a slice that passed its gate.
public struct CollocationsResult: GatedValue {
  public static let nullKeysWhenGated: [String] = []
  /// `[{term, f_xy, logDice, g2, q}]` (verbatim).
  public var collocates: JSONValue
  public var window: String?
  public var measure: String?
  public var thresholds: JSONValue?
  /// "context words, not meanings"
  public var label: String?
  public var provenance: Provenance?
  public init(collocates: JSONValue, window: String? = nil, measure: String? = nil, thresholds: JSONValue? = nil,
              label: String? = nil, provenance: Provenance? = nil) {
    self.collocates = collocates
    self.window = window
    self.measure = measure
    self.thresholds = thresholds
    self.label = label
    self.provenance = provenance
  }
}

/// GET /api/clusters query.
public struct ClustersRequest: Codable, Sendable, Equatable {
  public var expr: ExpressionID
  public var run: RunID?
  /// A saved view's human labels as saved.
  public var revCutoff: Int?
  public init(expr: ExpressionID, run: RunID? = nil, revCutoff: Int? = nil) {
    self.expr = expr
    self.run = run
    self.revCutoff = revCutoff
  }
}

/// Sense hypotheses (context groups) of one expression: machine labels, shares, stability, transitions — or a gate
/// (contract shape `Clusters`).
public struct ClustersResponse: Codable, Sendable, Equatable {
  public var result: Gated<ClusterResult>
  public var note: String?
  /// The lanes a gated clustering falls back to ('language').
  public var fallbackLanes: String?

  public init(result: Gated<ClusterResult>, note: String? = nil, fallbackLanes: String? = nil) {
    self.result = result
    self.note = note
    self.fallbackLanes = fallbackLanes
  }

  private enum CodingKeys: String, CodingKey { case note, fallbackLanes }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    note = try c.decodeIfPresent(String.self, forKey: .note)
    fallbackLanes = try c.decodeIfPresent(String.self, forKey: .fallbackLanes)
    result = try Gated(from: decoder)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(note, forKey: .note)
    try c.encodeIfPresent(fallbackLanes, forKey: .fallbackLanes)
    try result.encode(to: encoder)
  }
}

/// A clustering run's groups: computed hypotheses over context words, not meanings.
public struct ClusterResult: GatedValue {
  public static let nullKeysWhenGated = ["value"]
  public var run: RunID?
  public var representation: String?
  public var expr: ExpressionID?
  public var expression: JSONValue?
  public var k: Int?
  public var seed: Int?
  public var stabilityNote: String?
  /// The groups: labels (machine and human), counts, stability, status (verbatim).
  public var clusters: JSONValue
  public var transitions: JSONValue?
  public var windows: JSONValue?
  public var shares: JSONValue?
  public var convergence: JSONValue?
  public var n: Int?
  public var docs: Int?
  @NullOrAbsent public var newerRun: RunID?
  @NullOrAbsent public var newerNote: String?
  public var method: JSONValue?
  public var selection: JSONValue?
  public var excluded: JSONValue?
  public var synthetic: Bool?
  public var provenance: Provenance?

  public init(clusters: JSONValue) { self.clusters = clusters }
}

// MARK: - analysis runs

/// POST /api/analysis/runs: start a run (contract shape `AnalysisRunRequest`).
public struct StartRunRequest: Codable, Sendable, Equatable {
  /// cluster · vectors · drift · tone · tokstream · collocations · layout · reuse-index
  public var stage: String
  public var params: JSONValue?
  @NullOrAbsent public var expr: ExpressionID?
  public init(stage: String, params: JSONValue? = nil, expr: ExpressionID? = nil) {
    self.stage = stage
    self.params = params
    self.expr = expr
  }
}

/// The run's job, and the run when an identical finished one was reused (contract shape `AnalysisRunStarted`).
public struct StartRunResponse: Codable, Sendable, Equatable {
  public var job: IDRef
  @NullOrAbsent public var run: RunID?
  public var reused: Bool?
  public init(job: Int, run: RunID? = nil, reused: Bool? = nil) {
    self.job = IDRef(id: job)
    self.run = run
    self.reused = reused
  }
}

/// GET /api/analysis/runs query.
public struct RunsRequest: Codable, Sendable, Equatable {
  public var stage: String?
  public var expr: ExpressionID?
  public var cursor: String?
  public var limit: Int?
  public init(stage: String? = nil, expr: ExpressionID? = nil, cursor: String? = nil, limit: Int? = nil) {
    self.stage = stage
    self.expr = expr
    self.cursor = cursor
    self.limit = limit
  }
}

/// Runs with versions and parameters (contract shape `AnalysisRuns`).
public struct RunsResponse: Codable, Sendable, Equatable {
  public var items: [RunInfo]
  @NullOrAbsent public var cursor: String?
  public init(items: [RunInfo], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}

/// One analysis run.
public struct RunInfo: Codable, Sendable, Equatable {
  public var id: RunID
  public var stage: String
  /// `vocab.RUN_STATUS`
  public var status: String
  public var pipelineVersion: String
  public var params: JSONValue
  public var startedAt: String
  @NullOrAbsent public var finishedAt: String?
  @NullOrAbsent public var representation: String?
  public init(id: RunID, stage: String, status: String, pipelineVersion: String, params: JSONValue, startedAt: String,
              finishedAt: String? = nil, representation: String? = nil) {
    self.id = id
    self.stage = stage
    self.status = status
    self.pipelineVersion = pipelineVersion
    self.params = params
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.representation = representation
  }
}

// MARK: - constellation

/// GET /api/constellation query.
public struct ConstellationRequest: Codable, Sendable, Equatable {
  /// Strand refs, comma-separated.
  public var strands: String
  /// Periods `<lo>-<hi>`; A is always the earlier.
  public var a: String?
  public var b: String?
  /// 'occurrences' | 'docs' | 'authors'
  public var size: String?
  /// Edge kinds, comma-separated (cooc, member, occurs, rel, etym).
  public var edges: String?
  public var maxNodes: Int?
  public var maxEdges: Int?
  public var toggles: [String: Int]?
  public var corpus: String?
  /// `x:<id>`: expand one node.
  public var expand: String?
  public var relayout: Bool?
  public var runs: String?
  public var revCutoff: Int?
  public init(strands: String, a: String? = nil, b: String? = nil, size: String? = nil, edges: String? = nil,
              maxNodes: Int? = nil, maxEdges: Int? = nil, toggles: [String: Int]? = nil, corpus: String? = nil,
              expand: String? = nil, relayout: Bool? = nil, runs: String? = nil, revCutoff: Int? = nil) {
    self.strands = strands
    self.a = a
    self.b = b
    self.size = size
    self.edges = edges
    self.maxNodes = maxNodes
    self.maxEdges = maxEdges
    self.toggles = toggles
    self.corpus = corpus
    self.expand = expand
    self.relayout = relayout
    self.runs = runs
    self.revCutoff = revCutoff
  }
}

/// Nodes and edges with stable positions; periods A and B never move nodes (contract shape `Constellation`).
public struct ConstellationResponse: Codable, Sendable, Equatable {
  public var nodes: [ConstellationNode]
  public var edges: [ConstellationEdge]
  public var legend: JSONValue
  public var layout: ConstellationLayout
  /// What was left out ("+38 more"), verbatim.
  public var truncated: JSONValue
  public var periods: JSONValue?
  /// Only in A, only in B, grew > 2× (verbatim).
  @NullOrAbsent public var diff: JSONValue?
  /// Gates of gated edge kinds (verbatim).
  public var gates: JSONValue?
  public var synthetic: Bool?
  public var provenance: Provenance?

  public init(nodes: [ConstellationNode], edges: [ConstellationEdge], legend: JSONValue, layout: ConstellationLayout,
              truncated: JSONValue) {
    self.nodes = nodes
    self.edges = edges
    self.legend = legend
    self.layout = layout
    self.truncated = truncated
  }
}

/// A node of the constellation.
public struct ConstellationNode: Codable, Sendable, Equatable {
  public var id: String
  public var type: String
  public var label: String
  public var size: JSONValue
  public var pos: [Double]
  /// Presence per period (verbatim).
  public var present: JSONValue
  public var ref: String?
  public var modality: JSONValue?
  public var synthetic: Bool?
  public var machineLabel: String?
  @NullOrAbsent public var humanLabel: String?
  public var status: String?
  public var tentative: Bool?
  public var run: RunID?
  public var representation: String?
  public var year: Int?
  public var more: Int?
  public init(id: String, type: String, label: String, size: JSONValue, pos: [Double], present: JSONValue) {
    self.id = id
    self.type = type
    self.label = label
    self.size = size
    self.pos = pos
    self.present = present
  }
}

/// An edge of the constellation; a gated edge has a null weight.
public struct ConstellationEdge: Codable, Sendable, Equatable {
  public var s: String
  public var t: String
  public var kind: String
  public var weight: JSONValue
  @Nullable public var measure: String?
  public var relId: RelationshipID?
  public var evidenceStatus: String?
  public var run: RunID?
  public var present: JSONValue?
  public var relType: String?
  public var family: String?
  public var reviewStatus: String?
  public var provenanceQuality: String?
  public var synthetic: Bool?
  public var note: String?
  public init(s: String, t: String, kind: String, weight: JSONValue, measure: String?) {
    self.s = s
    self.t = t
    self.kind = kind
    self.weight = weight
    self.measure = measure
  }
}

/// The layout's key (stable positions), algorithm, pinning and cache.
public struct ConstellationLayout: Codable, Sendable, Equatable {
  public var key: String
  public var algorithm: String
  public var pinned: Bool
  public var generation: Int?
  public var seed: Int?
  public var placed: Int?
  @NullOrAbsent public var toast: String?
  public var cache: String?
  public init(key: String, algorithm: String, pinned: Bool, generation: Int? = nil, seed: Int? = nil, placed: Int? = nil,
              toast: String? = nil, cache: String? = nil) {
    self.key = key
    self.algorithm = algorithm
    self.pinned = pinned
    self.generation = generation
    self.seed = seed
    self.placed = placed
    self.toast = toast
    self.cache = cache
  }
}
