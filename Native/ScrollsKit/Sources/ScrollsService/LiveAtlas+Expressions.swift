// OWNER: N3
// Expressions in process (server/routes/expressions.mjs): track an expression (POST /api/expressions), its payload
// (GET /api/expressions/:id) and its variants (PATCH …/variants). Tracking and a variant change are user acts: on a
// device atlas each is appended to the journal first (`JournalOp.trackExpression` / `.setVariants`, IOS-SPEC §6.2) and
// applied in one transaction; on a reference database opened by the CLI there is no journal and the act is applied
// directly. Counting is the `materialize` job (priority 1), queued whenever an expression's current run is missing or
// stale (`ensureMaterialized`): a payload reports `materializing` with the job until the run commits. In a virtual
// corpus (`real`) the expression is tracked in every member corpus and the payload adds the members up.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsQuery
import ScrollsStore
import Synchronization

/// What `ensureMaterialized` found or did.
struct MaterializeState: Sendable {
  var job: Expressions.JobState?
  var runId: Int64?
  var fresh: Bool
}

/// Serialises `ensureMaterialized` per (atlas, expression): two requests arriving together never queue two counts.
private actor MaterializeGate {
  static let shared = MaterializeGate()
  private var inflight: [String: Task<MaterializeState, any Error>] = [:]

  func ensure(_ key: String, _ body: @escaping @Sendable () async throws -> MaterializeState) async throws -> MaterializeState {
    if let t = inflight[key] { return try await t.value }
    let t = Task { try await body() }
    inflight[key] = t
    defer { inflight[key] = nil }
    return try await t.value
  }
}

/// The queue that runs `materialize` jobs for an atlas. Normally the atlas's own `jobQueue`; a differential run whose
/// build does not register `MaterializeTask` in `TaskRegistry.all` yet installs a queue that does (scrolls-cli
/// diff-read only; see `install`).
public enum MaterializeQueues {
  private static let overrides = Mutex<[String: JobQueue]>([:])

  /// Installs `queue` as the materialize queue of the atlas at `atlasPath` (nil removes it).
  public static func install(_ queue: JobQueue?, atlasPath: String) {
    overrides.withLock { $0[atlasPath] = queue }
  }

  static func queue(for atlas: LiveAtlas) -> JobQueue {
    overrides.withLock { $0[atlas.location.atlasPath] } ?? atlas.jobQueue
  }
}

extension LiveAtlas {
  // MARK: AtlasService

  @concurrent
  public func trackExpression(_ r: TrackExpressionRequest) async throws -> ExpressionResponse {
    let corpus = r.corpus
    if Scopes.isVirtual(corpus) {
      let plans = try await read { c in
        try Scopes.planTrackAcross(c, surface: r.surface, lang: r.lang, kind: r.kind, corpus: corpus!)
      }
      var lead: Int64?
      for p in plans {
        let id = try await applyTrackPlan(p, request: r)
        if lead == nil { lead = id }
      }
      guard let id = lead else { throw ScrollsError(code: .notFound, message: "No member corpus to track in.", status: 404) }
      return try await virtualPayload(id, corpus: corpus!)
    }
    let plan = try await read { c in try Expressions.planTrack(c, surface: r.surface, lang: r.lang, kind: r.kind, corpus: corpus) }
    let id = try await applyTrackPlan(plan, request: r)
    return try await expressionPayload(id)
  }

  @concurrent
  public func expression(_ id: ExpressionID, corpus: String?) async throws -> ExpressionResponse {
    try await requireExpression(id.rawValue)
    if let corpus, Scopes.isVirtual(corpus) { return try await virtualPayload(id.rawValue, corpus: corpus) }
    return try await expressionPayload(id.rawValue)
  }

  @concurrent
  public func setVariants(_ id: ExpressionID, _ r: VariantsPatchRequest) async throws -> ExpressionResponse {
    let eid = id.rawValue
    let expr = try await requireExpression(eid)
    if r.variants.isEmpty {
      throw ScrollsError.badRequest(.validation, "Send variants: [{id, enabled}] (and/or names: [{document_id, field, start, counted}]).",
                                    detail: .object(["field": .string("variants")]))
    }
    let corpus = r.corpus.flatMap { $0.isEmpty ? nil : $0 }
    let changes = r.variants.map { (id: Int64($0.id), enabled: $0.enabled) }
    let virtual = corpus.map(Scopes.isVirtual) ?? false
    // the members (and their mapped variant ids) are read before the act, so the act is exactly what is applied
    let mirrored: [(Int64, [(id: Int64, enabled: Bool)])] = virtual ? try await read { c in
      try Self.mirroredChanges(c, eid, changes, corpus: corpus!)
    } : []
    let key = try await read { c in try Self.exprKey(c, expr) }
    let apply: @Sendable (WriteTx) throws -> Void = { tx in
      _ = try Expressions.setVariantsEnabled(tx, eid, changes)
      for (m, ch) in mirrored where !ch.isEmpty { _ = try Expressions.setVariantsEnabled(tx, m, ch) }
    }
    if profile == .device {
      _ = try await userWrites.perform(.setVariants(key, r), actor: "human:utkarsh") { tx, _ in try apply(tx) }
    } else {
      try await writer.write("set variants \(eid)") { tx in try apply(tx) }
    }
    if virtual { return try await virtualPayload(eid, corpus: corpus!) }
    return try await expressionPayload(eid)
  }

  // MARK: shared with the timeline, search and KWIC areas

  /// `ensureMaterialized(db, jobs, id)`: the newest job when it is still active; nothing when the current run is fresh;
  /// otherwise a new `materialize` job.
  func ensureMaterialized(_ id: Int64) async throws -> MaterializeState {
    let queue = MaterializeQueues.queue(for: self)
    return try await MaterializeGate.shared.ensure("\(location.atlasPath)|\(id)") { [self] in
      let (fr, last) = try await self.read { c in (try Expressions.freshness(c, id), try Expressions.latestMaterializeJob(c, id)) }
      var live: Expressions.JobState?
      if let last {
        let snap = try await queue.job(JobID(rawValue: last.id))
        live = Expressions.JobState(id: last.id, status: snap?.status.rawValue ?? last.status)
      }
      if let live, ["queued", "running", "cancelling"].contains(live.status) {
        return MaterializeState(job: live, runId: fr.runId, fresh: fr.fresh)
      }
      if fr.fresh { return MaterializeState(job: live, runId: fr.runId, fresh: true) }
      let job = try await queue.enqueue(JobSpec(type: MaterializeTask.type, params: MaterializeParams(expressionId: id).json))
      return MaterializeState(job: Expressions.JobState(id: job.rawValue, status: "queued"), runId: fr.runId, fresh: false)
    }
  }

  /// `payload(ctx, id)`: the Expression payload with the newest job's live state.
  func expressionPayload(_ id: Int64) async throws -> ExpressionResponse {
    let st = try await ensureMaterialized(id)
    guard let p = try await read({ c in try Expressions.payload(c, id, job: st.job) }) else {
      throw ScrollsError(code: .notFound, message: "No expression \(id).", status: 404)
    }
    return p
  }

  /// `virtualPayload(ctx, id, corpus)`: the first member's expression (corpus = the virtual slug), variants with n
  /// added up over the members (matched by form and language), the state of all members, every member's own state.
  func virtualPayload(_ id: Int64, corpus: String) async throws -> ExpressionResponse {
    let members = try await read { c in try Self.memberIds(c, id, corpus: corpus) }
    var payloads: [(corpus: String, id: Int64, payload: ExpressionResponse)] = []
    for m in members { payloads.append((m.corpus, m.id, try await expressionPayload(m.id))) }
    guard let lead = payloads.first(where: { $0.id == id }) ?? payloads.first else {
      throw ScrollsError(code: .notFound, message: "No expression \(id).", status: 404)
    }
    let p = lead.payload
    let states = payloads.map(\.payload.state)
    let status = states.contains { $0.status == "materializing" } ? "materializing"
      : states.allSatisfy { $0.status == "ready" } ? "ready" : states.contains { $0.status == "failed" } ? "failed" : "none"
    func sum(_ k: KeyPath<ExpressionState, Int?>) -> Int? {
      states.allSatisfy { $0[keyPath: k] != nil } ? states.reduce(0) { $0 + $1[keyPath: k]! } : nil
    }
    let variants = p.variants.map { v -> Variant in
      let same = payloads.map { m in m.payload.variants.first { $0.form == v.form && $0.lang == v.lang } }
      var out = v
      out.n = same.allSatisfy { $0?.n != nil } ? same.reduce(0) { $0 + $1!.n! } : nil
      return out
    }
    var seen = Set<String>()
    var claims: [ClaimMarker] = []
    for m in payloads {
      for cm in m.payload.claims ?? [] {
        let k = "\(cm.label)|\(cm.date.loYear.map(String.init) ?? "undefined")|\(cm.date.hiYear.map(String.init) ?? "undefined")"
        if seen.insert(k).inserted { claims.append(cm) }
      }
    }
    var expr = p.expression
    expr.corpus = corpus
    var state = ExpressionState(status: status, job: states.compactMap(\.job).first, run: nil, n: sum(\.n), docs: sum(\.docs),
                                namesExcluded: sum(\.namesExcluded))
    state.$job = state.job.map { .value($0) } ?? .null
    state.$run = .null
    state.$n = state.n.map { .value($0) } ?? .null
    state.$docs = state.docs.map { .value($0) } ?? .null
    state.$namesExcluded = state.namesExcluded.map { .value($0) } ?? .null
    return ExpressionResponse(expression: expr, variants: variants, state: state, claims: claims,
                              members: payloads.map { ExpressionMember(corpus: $0.corpus, id: ExpressionID(rawValue: $0.id), state: $0.payload.state) })
  }

  /// 404 E_NOT_FOUND unless the expression exists.
  @discardableResult
  func requireExpression(_ id: Int64) async throws -> ExpressionRow {
    guard let e = try await read({ c in try Expressions.get(c, id) }) else {
      throw ScrollsError(code: .notFound, message: "No expression \(id).", status: 404)
    }
    return e
  }

  // MARK: helpers

  /// Applies one track plan as a user act (journaled on a device atlas); returns the expression id. An expression that
  /// already exists is not tracked again (no journal entry).
  private func applyTrackPlan(_ plan: Expressions.TrackPlan, request r: TrackExpressionRequest) async throws -> Int64 {
    if let existing = try await read({ c in try Expressions.existing(c, plan) }) { return existing }
    let key = ExprKey(kind: plan.kind, lang: plan.lang, norm: plan.norm, corpus: plan.corpus?.slug)
    if profile == .device {
      return try await userWrites.perform(.trackExpression(key, r), actor: "human:utkarsh") { tx, _ in
        try Expressions.applyTrack(tx, plan).id
      }
    }
    return try await writer.write("track expression") { tx in try Expressions.applyTrack(tx, plan).id }
  }

  /// The stable key of an expression (its journal identity).
  static func exprKey(_ c: Connection, _ e: ExpressionRow) throws -> ExprKey {
    ExprKey(kind: e.kind, lang: e.lang, norm: e.norm, corpus: try Expressions.corpus(c, id: e.corpusId)?.slug)
  }

  /// `memberIds(db, id, corpus)`: the member expressions of a virtual corpus, the expression's own corpus first in id order.
  static func memberIds(_ c: Connection, _ id: Int64, corpus: String) throws -> [(corpus: String, id: Int64)] {
    let scope = try Scopes.resolve(c, corpus)
    guard let e = try Expressions.get(c, id) else { throw ScrollsError(code: .notFound, message: "No expression \(id).", status: 404) }
    guard let ec = e.corpusId, scope.ids.contains(ec) else {
      throw ScrollsError.badRequest(.validation,
                                    "Expression \(id) belongs to a corpus outside '\(corpus)' (the synthetic demo is never part of it).",
                                    hint: "Track '\(e.surface)' in \(corpus).", detail: .object(["field": .string("corpus")]))
    }
    return try Scopes.siblings(c, e, scope.members).compactMap { s in s.expr.map { (s.corpus, $0.id) } }
  }

  /// `mirrorVariants`: a variant change applied to every sibling, matching variants by folded form, language and type.
  static func mirroredChanges(_ c: Connection, _ id: Int64, _ changes: [(id: Int64, enabled: Bool)], corpus: String) throws
    -> [(Int64, [(id: Int64, enabled: Bool)])]
  {
    let own = try Expressions.variants(c, id)
    var out: [(Int64, [(id: Int64, enabled: Bool)])] = []
    for m in try memberIds(c, id, corpus: corpus) where m.id != id {
      let theirs = try Expressions.variants(c, m.id)
      var mapped: [(id: Int64, enabled: Bool)] = []
      for ch in changes {
        guard let v = own.first(where: { $0.id == ch.id }),
          let t = theirs.first(where: { $0.norm == v.norm && $0.lang == v.lang && $0.variantType == v.variantType })
        else { continue }
        mapped.append((t.id, ch.enabled))
      }
      out.append((m.id, mapped))
    }
    return out
  }
}
