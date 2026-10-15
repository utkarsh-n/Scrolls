// OWNER: N3
// Timeline in process (server/routes/timeline.mjs): register a canonical query (POST /api/timeline/query) and read the
// Scroll's data by its queryKey — tiles (binned cells, washes, coverage), marks, shelves and bin pages. Every read of a
// key reads the SAME slice (ScrollsQuery's SliceSQL and slice cube), so numerators and denominators never drift apart.
// A queryKey names a resolved def kept in a process-wide registry and, best effort, in `query_def` (QueryRegistry); a
// key unknown to both answers 404 E_QUERY_UNKNOWN and the app registers the query again. Registration queues the
// counting of any expression whose current run is missing or stale; until a first run exists the answer is the lane
// skeleton with `status: materializing` and the job. Tiles are cached per (queryKey, tier, tile, data_version).
// Arcs (C4 summaries, feedback, date conflicts) are milestone M2 and answer NOT_IMPLEMENTED until then.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  static let timelineTiers = ["L0", "L1", "L2", "L3", "L4", "L5"]

  /// `tierParam`: L0…L5, default L2.
  static func tierParam(_ v: String?) throws -> String {
    let t = v ?? "L2"
    guard timelineTiers.contains(t) else {
      throw ScrollsError.badRequest(.validation, "tier must be one of \(timelineTiers.joined(separator: ", ")).",
                                    detail: .object(["field": .string("tier")]))
    }
    return t
  }

  /// The def registered under `q` (memory, then `query_def`).
  func resolveDef(_ q: String?) async throws -> QueryDef {
    try await read { c in try QueryRegistry.resolve(c, q) }
  }

  @concurrent
  public func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse {
    let creq = try CanonicalRequest.make(r)
    try await ensureSiblings(creq)
    let resolved = try await reads.read(.interactive, deadline: .seconds(15)) { c in try QueryDefs.build(c, creq) }
    var jobs: [Int64] = []
    for m in resolved.materialize {
      if let j = try await ensureMaterialized(m.expressionId).job { jobs.append(j.id) }
    }
    let def = resolved.def
    let key = QueryRegistry.register(atlas: location.atlasPath, def)
    let row = QueryRegistry.persistRow(def)
    // best effort, like the reference's persistDef: a busy writer leaves the def in memory only
    _ = try? await writer.write("query_def") { tx in try QueryRegistry.persist(tx, key: row.key, json: row.json) }
    let job = jobs.first.map { Int($0) }
    if def.strands.contains(where: { $0.type == "expression" && $0.run == nil }) {
      let (dv, provenance) = try await read { c in (try Meta.dataVersion(c), try Slices.provenance(c, def)) }
      var out = TimelineQueryResponse(
        queryKey: key, dataVersion: dv, status: "materializing", job: job, units: [], lanes: [], other: OtherLanes(lanes: 0, n: 0),
        extent: Extent(from: nil, to: nil),
        totals: TimelineTotals(n: 0, dated: 0, undated: 0, scheduled: 0, namesExcluded: 0, sampled: false, washesByTier: [:]),
        seams: [], gates: .object([:]), provenance: provenance)
      out.laneOrderNote = def.lanes.facet == "trail" ? TrailLanes.orderNote : Lanes.orderNote(def.lanes.order)
      if def.lanes.facet == "cluster" {
        out.laneState = "pending"
        out.laneNote = "counting the expression first"
      }
      return out
    }
    let revCutoff = r.revCutoff.flatMap { $0 > 0 ? Int64($0) : nil }
    var out = try await reads.read(.interactive, deadline: .seconds(15)) { c in try TimelineQuery.run(c, def, revCutoff: revCutoff) }
    out.queryKey = key
    out.status = "ready"
    out.job = job
    if job != nil { out.refreshing = true }
    return out
  }

  @concurrent
  public func tiles(_ r: TilesRequest) async throws -> TilesResponse {
    let def = try await resolveDef(r.q)
    let tier = try Self.tierParam(r.tier)
    let list = try Tiles.parse(r.tiles)
    if list.count > Tiles.maxTiles {
      throw ScrollsError.badRequest(.validation, "At most \(Tiles.maxTiles) tiles per request.", hint: "Ask for the visible tiles only.")
    }
    let path = location.atlasPath
    let level = Self.timelineTiers.firstIndex(of: tier)!
    var binWidth: Double? = level >= 4 ? nil : Double([1000, 100, 10, 1][level])
    let (dv, computed) = try await read { c -> (Int, TilesResponse?) in
      let dv = try Meta.dataVersion(c)
      let missing = list.filter { QueryRegistry.tile(atlas: path, q: r.q, tier: tier, tile: $0, dataVersion: dv) == nil }
      return (dv, missing.isEmpty ? nil : try Tiles.compute(c, def, tier, missing))
    }
    var byTile: [Int: Tile] = [:]
    if let computed {
      binWidth = computed.binWidth
      for t in computed.tiles {
        byTile[t.tile] = t
        QueryRegistry.store(atlas: path, q: r.q, tier: tier, tile: t, dataVersion: dv)
      }
    }
    var tiles: [Tile] = []
    for t in list {
      if let hit = byTile[t] ?? QueryRegistry.tile(atlas: path, q: r.q, tier: tier, tile: t, dataVersion: dv) { tiles.append(hit) }
    }
    return TilesResponse(queryKey: r.q, tier: tier, binWidth: binWidth, dataVersion: dv, tiles: tiles)
  }

  @concurrent
  public func marks(_ r: MarksRequest) async throws -> MarksResponse {
    let def = try await resolveDef(r.q)
    return try await read { c in
      try TimelineLists.marks(c, def, from: r.from, to: r.to, lane: r.lane.flatMap { $0.isEmpty ? nil : $0 },
                      strand: r.strand.flatMap { $0.isEmpty ? nil : $0 }, limit: r.limit ?? 4000)
    }
  }

  @concurrent
  public func arcs(_ r: ArcsRequest) async throws -> ArcsResponse {
    _ = try await resolveDef(r.q)
    throw ScrollsError.notImplemented(area: "Timeline arcs, bundles, halos and C4 summaries (package N3, milestone M2)")
  }

  @concurrent
  public func shelf(_ r: ShelfRequest) async throws -> ShelfResponse {
    let def = try await resolveDef(r.q)
    let tier = try Self.tierParam(r.tier)
    return try await read { c in
      try TimelineLists.shelf(c, def, which: r.which ?? "undated", lane: r.lane.flatMap { $0.isEmpty ? nil : $0 }, tier: tier,
                      cursor: r.cursor.flatMap { $0.isEmpty ? nil : $0 }, limit: r.limit ?? 50)
    }
  }

  @concurrent
  public func bin(_ r: BinRequest) async throws -> BinResponse {
    let def = try await resolveDef(r.q)
    if r.bin == nil && (r.cell ?? "").isEmpty {
      throw ScrollsError.badRequest(.validation, "bin is required (or cell, on an OpenAlex share lane).",
                                    detail: .object(["field": .string("bin")]))
    }
    let tier = try Self.tierParam(r.tier)
    let text = TextAccess(store: self.text)
    return try await read { c in
      try TimelineLists.bin(c, def, text: text, lane: r.lane, strand: r.strand.flatMap { $0.isEmpty ? nil : $0 }, tier: tier, bin: r.bin,
                    cell: r.cell.flatMap { $0.isEmpty ? nil : $0 }, cursor: r.cursor.flatMap { $0.isEmpty ? nil : $0 },
                    limit: r.limit ?? 50)
    }
  }

  /// `ensureSiblings(ctx, creq)`: a virtual corpus counts each expression in every member corpus, so the members that
  /// lack the expression track it first (idempotent; read first, the writer only when a member is missing).
  func ensureSiblings(_ creq: CanonicalRequest) async throws {
    guard Scopes.isVirtual(creq.corpus) else { return }
    for s in creq.strands where s.type == "expression" {
      guard case .int(let ref) = s.ref else { continue }
      let plans: [Expressions.TrackPlan]? = try await read { c in
        guard let e = try Expressions.get(c, Int64(ref)) else { return nil }
        let scope = try Scopes.resolve(c, creq.corpus)
        guard let ec = e.corpusId, scope.ids.contains(ec) else { return nil }
        if try Scopes.siblings(c, e, scope.members).allSatisfy({ $0.expr != nil }) { return nil }
        return try Scopes.planTrackAcross(c, surface: e.surface, lang: e.lang, kind: e.kind, corpus: creq.corpus)
      }
      for p in plans ?? [] where try await read({ c in try Expressions.existing(c, p) }) == nil {
        let key = ExprKey(kind: p.kind, lang: p.lang, norm: p.norm, corpus: p.corpus?.slug)
        let request = TrackExpressionRequest(surface: p.surface, lang: p.lang, kind: p.kind, corpus: creq.corpus)
        if profile == .device {
          _ = try await userWrites.perform(.trackExpression(key, request), actor: "human:utkarsh") { tx, _ in
            try Expressions.applyTrack(tx, p).id
          }
        } else {
          _ = try await writer.write("track sibling") { tx in try Expressions.applyTrack(tx, p).id }
        }
      }
    }
  }
}
