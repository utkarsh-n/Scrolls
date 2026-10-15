// OWNER: N5 (frozen at M0: IOS-SPEC §8.5 "BoilerplatePass"; changes go through N0, additively)
// The boilerplate pass (`lineage/boilerplate.mjs`, pipeline `boilerplate@1.0.0`): winnowing fingerprints of every
// document's whole original, groups shared by many documents, and passages flagged by rule (edge share, licence
// lexicon), so a licence block never counts as text ("computer virus" canary: after the pass no `ok` passage holds the
// licence sentence). N2's pipelines call it after Cipher phase B and after each STEMM text load (ScrollsService/Pipelines);
// the `boilerplate` job type runs it on its own (BoilerplateTask).
//
// Steps, as the reference: (1) fingerprint every full-text document of the scope (k = 8, w = 6) over its whole decoded
// original into typed arrays, never SQLite rows; (2) stable radix sort by hash and classify the groups (widespread =
// > 25 distinct non-duplicate documents; boilerplate when ≥ 50% of the occurrences lie at the body's edges or the
// licence lexicon dominates; otherwise commonplace); (3) decide passages by rules A, B and C (BoilerplateKernel.swift);
// (4) in one transaction flag them, rewrite their documents' doc_tokens and bump meta.quality_version and data_version;
// then count the canary and write the commonplace record.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// The scope and mode of one pass.
public struct BoilerplateOptions: Sendable, Equatable {
  /// Collection slugs to fingerprint; nil is every collection.
  public var collections: [String]?
  /// Count and classify without writing.
  public var dryRun: Bool
  /// Passages whose tallies are returned in `metrics.explain`.
  public var explain: [PassageID]

  public init(collections: [String]? = nil, dryRun: Bool = false, explain: [PassageID] = []) {
    self.collections = collections
    self.dryRun = dryRun
    self.explain = explain
  }
}

/// What a pass did.
public struct BoilerplateResult: Sendable, Equatable {
  /// The `boilerplate` run it recorded (nil for a dry run).
  public var run: RunID?
  public var passagesFlagged: Int
  public var documentsAffected: Int
  /// `ok` passages that still hold the licence sentence: 0 when the pass works (the G2 canary).
  public var canary: Int
  /// Every metric of the reference's return value, verbatim (documents, tokens, fingerprints, groups, widespread,
  /// flagged by rule, explain, data_version).
  public var metrics: JSONValue

  public init(run: RunID?, passagesFlagged: Int, documentsAffected: Int, canary: Int, metrics: JSONValue) {
    self.run = run
    self.passagesFlagged = passagesFlagged
    self.documentsAffected = documentsAffected
    self.canary = canary
    self.metrics = metrics
  }
}

/// Finds and flags boilerplate passages inside a job (it reports progress, checkpoints and records its run through
/// `JobContext`).
public protocol BoilerplatePass: Sendable {
  func run(_ ctx: JobContext, options: BoilerplateOptions) async throws -> BoilerplateResult
}

/// The port of `lineage/boilerplate.mjs`.
public struct BoilerplateDetector: BoilerplatePass {
  /// The pipeline version its runs record.
  public static let pipelineVersion = "boilerplate@1.0.0"
  /// The analysis stage of its runs.
  public static let stage = Stage(rawValue: "boilerplate")

  /// The pass's parameters (the reference's DEFAULTS unless a test overrides them).
  public var parameters: Boilerplate.Parameters

  public init() { parameters = .defaults }

  public init(parameters: Boilerplate.Parameters) { self.parameters = parameters }

  /// A document of the scope, as `SELECT d.id, d.dup_of, t.body_start, t.body_end` reads it.
  struct ScopeDocument: Sendable {
    let id: Int64
    let dupOf: Int64?
    let bodyStart: Int32
    let bodyEnd: Int32
  }

  /// A body passage as the pass reads it.
  struct BodyPassage: Sendable {
    let id: Int64
    let start: Int32
    let end: Int32
    let quality: Boilerplate.SlotQuality
  }

  public func run(_ ctx: JobContext, options: BoilerplateOptions) async throws -> BoilerplateResult {
    EngineAssert.offMain()
    let p = parameters
    let started = ContinuousClock.now
    let scope: [Int64]? = try await ctx.read { c in try Self.scopeCollections(c, options.collections) }
    let scopeArgs = Self.scopeArgs(scope)
    var run: RunHandle?
    if !options.dryRun {
      let scopeJSON: JSONValue = ["collections": options.collections.map { .array($0.map(JSONValue.string)) } ?? .null]
      run = try await ctx.startRun(Self.stage, params: p.json, scope: scopeJSON, upstream: [], representation: nil, seed: nil,
                                   pipelineVersion: Self.pipelineVersion)
    }

    let (docs, size) = try await ctx.read { c -> ([ScopeDocument], (n: Int, t: Int)) in
      let docs = try c.prepared(LineageSQL.boilerplateDocuments).binding(scopeArgs) { r in
        ScopeDocument(id: r.int(0), dupOf: r.intOrNil(1), bodyStart: Int32(r.int(2)), bodyEnd: Int32(r.int(3)))
      }
      let size = try c.prepared(LineageSQL.boilerplateSize).bindingFirst(scopeArgs) { (Int($0.int(0)), Int($0.int(1))) }
      return (docs, size ?? (0, 0))
    }

    // ── 1. fingerprints ──
    var slots = Boilerplate.SlotTable(capacity: size.n + docs.count)
    var countable = [Bool](repeating: false, count: docs.count)
    var records = Boilerplate.Records(capacity: Int((Double(size.t) * 0.4).rounded(.up)))
    var tokens = 0
    let tokenizing = Boilerplate.Tokenizing()
    let text = ctx.text
    for (di, d) in docs.enumerated() {
      try await ctx.checkpoint()
      countable[di] = d.dupOf == nil
      let (rows, units) = try await ctx.read { c -> ([BodyPassage], [UInt16]) in
        let rows = try c.prepared(LineageSQL.bodyPassages).binding([.int(d.id)]) { r in
          BodyPassage(id: r.int(0), start: Int32(r.int(1)), end: Int32(r.int(2)),
                      quality: Self.slotQuality(r.text(3)))
        }
        let original = try text.fullText(DocumentID(rawValue: d.id), on: c)
        return (rows, Array(original.utf16))
      }
      let passages = rows.map { row in
        Boilerplate.PassageSlot(start: row.start, end: row.end,
                                slot: slots.add(passage: row.id, doc: di, quality: row.quality))
      }
      let outside = slots.add(passage: -1, doc: di, quality: .other)
      let tok = units.withUnsafeBufferPointer { tokenizing.tokens($0) }
      tokens += Boilerplate.fingerprintDocument(tok, bodyStart: d.bodyStart, bodyEnd: d.bodyEnd, passages: passages,
                                                outsideSlot: outside, parameters: p, records: &records, slots: &slots)
      if di % 25 == 0 {
        ctx.progress(0.8 * Double(di + 1) / Double(docs.count), phase: "boilerplate",
                     message: "fingerprints: \(di + 1) / \(docs.count) documents")
      }
    }

    // ── 2. groups ──
    ctx.progress(0.82, phase: "boilerplate", message: "sorting \(Format.int(records.count)) fingerprints")
    Winnow.radixSortPairs(&records.hashes, &records.refs)
    try await ctx.checkpoint()
    let groups = Boilerplate.classifyGroups(records, slots: &slots, countable: countable, parameters: p)

    // ── 3. passages ──
    let (flagged, byRule) = Boilerplate.decidePassages(slots, parameters: p)
    var cpPassages: [Int64: CommonplaceRecord.Entry] = [:]
    var cpGroups: [String: CommonplaceRecord.Group] = [:]
    for s in 0..<slots.used {
      if slots.passage[s] < 0 || slots.fp[s] == 0 || Double(slots.cp[s]) < 0.5 * Double(slots.fp[s]) { continue }
      let key = Boilerplate.hex8(slots.cpKey[s])
      cpPassages[slots.passage[s]] = CommonplaceRecord.Entry(key: key, docs: Int(slots.cpDocs[s]))
      var g = cpGroups[key] ?? CommonplaceRecord.Group(docs: Int(slots.cpDocs[s]), passages: [])
      if g.passages.count < 50 { g.passages.append(slots.passage[s]) }
      cpGroups[key] = g
    }
    let flaggedSet = Set(flagged)
    var explain = JSONObject()
    let explainIDs = Set(options.explain.map(\.rawValue))
    if !explainIDs.isEmpty {
      for s in 0..<slots.used where explainIDs.contains(slots.passage[s]) {
        explain[String(slots.passage[s])] = [
          "fingerprints": .number(Double(slots.fp[s])), "boilerplate": .number(Double(slots.bp[s])),
          "commonplace": .number(Double(slots.cp[s])), "lexicon": .number(Double(slots.lex[s])),
          "edge_zone": .bool(slots.edgeZone[s] == 1), "flagged": .bool(flaggedSet.contains(s)),
        ]
      }
    }
    ctx.progress(0.9, phase: "boilerplate", message: "\(flagged.count) passages are boilerplate")
    try await ctx.checkpoint()

    // ── 4. write ──
    let flaggedPassages = flagged.map { slots.passage[$0] }
    var affectedSet = Set<Int64>()
    var affectedOrder: [Int64] = []  // first-flagged order, as the reference's Set
    for s in flagged where affectedSet.insert(docs[Int(slots.doc[s])].id).inserted {
      affectedOrder.append(docs[Int(slots.doc[s])].id)
    }
    let affected = affectedOrder
    var version: Int?
    if !options.dryRun && !flagged.isEmpty {
      version = try await ctx.write("boilerplate") { tx in
        let c = tx.connection
        let upd = try c.prepared(LineageSQL.flagBoilerplate)
        for id in flaggedPassages {
          try upd.bind(.int(id))
          try upd.run()
        }
        try Self.rewriteDocTokens(c, affected)
        let q = Int(try Meta.get(c, "quality_version") ?? "0") ?? 0
        try Meta.set(c, "quality_version", String(q + 1))
        return try tx.bumpDataVersion()
      }
    }
    let canary = try await ctx.read { c in try Self.canaryCount(c, scope: scope) }
    let finishedAt = StoreClock.isoNow()
    let durationMs = Int((ContinuousClock.now - started) / .milliseconds(1))
    var metrics: JSONObject = [
      "documents": .number(Double(docs.count)),
      "duplicates_not_counted": .number(Double(docs.count - countable.filter { $0 }.count)),
      "tokens": .number(Double(tokens)),
      "fingerprints": .number(Double(records.count)),
      "groups": .number(Double(groups.groups)),
      "widespread": .number(Double(groups.widespread)),
      "boilerplate": .number(Double(groups.boilerplate)),
      "commonplace": .number(Double(groups.commonplace)),
      "passages_flagged": .number(Double(options.dryRun ? 0 : flagged.count)),
      "passages_would_flag": .number(Double(flagged.count)),
      "flagged_by_rule": byRule.json,
      "documents_affected": .number(Double(affected.count)),
      "commonplace_passages": .number(Double(cpPassages.count)),
      "canary_ok_passages": .number(Double(canary)),
      "params": p.json,
      "dry_run": .bool(options.dryRun),
      "data_version": version.map { .number(Double($0)) } ?? .null,
      "duration_ms": .number(Double(durationMs)),
      "finished_at": .string(finishedAt),
    ]
    if !explainIDs.isEmpty { metrics["explain"] = .object(explain) }
    if !options.dryRun {
      try Commonplaces.write(CommonplaceRecord(run: run?.id.rawValue, collections: options.collections, at: finishedAt,
                                               passages: cpPassages, groups: cpGroups), atlasPath: ctx.reads.path)
    }
    if let run { try await ctx.finishRun(run, .succeeded, metrics: .object(metrics)) }
    ctx.progress(1, phase: "boilerplate",
                 message: "boilerplate: \(options.dryRun ? 0 : flagged.count) passages flagged in \(affected.count) documents")
    var out: JSONObject = [
      "run_id": run.map { .number(Double($0.id.rawValue)) } ?? .null,
      "collections": options.collections.map { .array($0.map(JSONValue.string)) } ?? .null,
    ]
    for (k, v) in metrics { out[k] = v }
    return BoilerplateResult(run: run?.id, passagesFlagged: options.dryRun ? 0 : flagged.count,
                             documentsAffected: affected.count, canary: canary, metrics: .object(out))
  }

  // MARK: - SQL helpers

  /// `scopeCollections(db, collections)`: ids of the named collections (unknown names are dropped); nil = every one.
  static func scopeCollections(_ c: Connection, _ collections: [String]?) throws -> [Int64]? {
    guard let collections, !collections.isEmpty else { return nil }
    var ids: [Int64] = []
    for name in collections {
      if let id = try c.prepared(LineageSQL.collectionBySlug).bindingFirst([.text(name)], { $0.int(0) }) {
        ids.append(id)
      } else if let n = Int64(name), let id = try c.prepared(LineageSQL.collectionByID).bindingFirst([.int(n)], { $0.int(0) }) {
        ids.append(id)  // a job's params may name a collection by id (the reference's numeric form)
      }
    }
    return ids
  }

  /// `[scope ? 1 : null, JSON.stringify(scope ?? [])]`.
  static func scopeArgs(_ scope: [Int64]?) -> [SQLValue] {
    [scope == nil ? .null : .int(1), .text(CanonicalJSON.string(.array((scope ?? []).map { .number(Double($0)) })))]
  }

  static func slotQuality(_ q: String) -> Boilerplate.SlotQuality {
    q == "ok" ? .ok : q == "boilerplate" ? .boilerplate : .other
  }

  /// `rewriteDocTokens(db, documentIds)` (store/bins.mjs): the denominators of each document from its ok passages.
  static func rewriteDocTokens(_ c: Connection, _ documents: [Int64]) throws {
    let del = try c.prepared(LineageSQL.deleteDocTokens)
    let ins = try c.prepared(LineageSQL.insertDocTokens)
    for id in documents {
      try del.bind(.int(id))
      try del.run()
      try ins.bind(.int(id))
      try ins.run()
    }
  }

  /// `canaryCount(db, collectionIds)`: ok passages of a scope that still contain the canary sentence (FTS phrase,
  /// accent-insensitive).
  public static func canaryCount(_ c: Connection, scope: [Int64]?) throws -> Int {
    let phrase = "\"" + Boilerplate.canaryTokens.joined(separator: " ") + "\""
    let args = scopeArgs(scope)
    return Int(try c.prepared(LineageSQL.canaryCount).bindingFirst([.text(phrase)] + args) { $0.int(0) } ?? 0)
  }
}

extension Statement {
  /// Binds `values` and maps every row (then resets).
  func binding<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
