// OWNER: N2
// Ports of `server/jobs/tasks/adapter-load.mjs` (`loadAdapterData`, the generic job) and `demo-load.mjs`.
// - `adapter-load {adapter, …}`: one adapter's whole load from its packs (Load on the Sources page, journaled as a
//   `sourceLoad`); the demo's deferred human layer (`{adapter:'demo', apply:'deferred'}`). STEMM's chained loads are
//   M2 work: a STEMM adapter answers NOT_IMPLEMENTED until then, never a partial load.
// - `demo-load`: the SYNTHETIC demo through the ordinary import path (SPEC §9.1): data/demo/* → the writer (corpus demo,
//   every row is_synthetic=1). The human layer the files describe (reviews, Reader A's second revision), the tour's
//   tracked expressions and the pipeline runs belong to other packages (N6, N3, N4, N5); whatever of it this build
//   cannot apply is reported as pending in the result, never invented.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsSources
import ScrollsStore
import Synchronization

enum AdapterLoading {
  /// `loadAdapterData(ctx, adapter, params)`: probe → collections → each collection's documents, aliases,
  /// relationships and annotations (one batch each) → etymons and theme associations.
  static func loadAdapterData(_ ctx: JobContext, _ adapter: any SourceAdapter, files: SourceFiles, params: JSONValue,
                              lease: WriteLease) async throws -> JSONObject {
    let loader = SourceLoader(env: SourcePipelines.environment(ctx, lease: lease), files: files)
    let actx = AdapterContext(pack: files.packs.first?.reader)
    let probe = try await adapter.probe(actx)
    guard probe.available else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_ADAPTER_UNAVAILABLE"),
                         message: "\(adapter.id) is unavailable: \(probe.reason ?? "no reason given")",
                         hint: "Send its source pack from the Mac (Tools/atlas.sh push-pack), then retry.",
                         detail: ["adapter": .string(adapter.id)], status: 409)
    }
    var result: JSONObject = ["adapter": .string(adapter.id), "version": .string(adapter.version),
                              "started_at": .string(StoreClock.isoNow()),
                              "probe": .object(JSONObject(probe.counts.map { ($0.key, JSONValue.number(Double($0.value))) }))]
    let slot = SourceRegistry.slot(for: adapter.id)
    let only = params["collections"]?.arrayValue?.compactMap(\.stringValue)
    try await lease.batch("adapters and collections") { tx in try SourceLoader.registerAdapters(tx) }
    let colls = try await lease.batch("collections") { tx in
      try SourceLoader.ensureCollections(tx, adapter: adapter, extraCaveats: probe.caveats, only: only, scope: .slot(slot))
    }
    let units = max(1, try await adapter.plan(params, actx))
    let done = Mutex(0)
    var collections = JSONObject()
    for (i, c) in colls.enumerated() {
      let aliasCount = Mutex(0)
      let aliasSource = i == 0 ? adapter as? any AliasSource : nil
      var before: (@Sendable (any DocumentWriting, AdapterContext) async throws -> Void)?
      if let a = aliasSource {
        before = { writer, actx in
          let added = try await writer.addAliases(try await a.aliases(params, actx).map { (target: $0.target, alias: $0.alias) })
          aliasCount.withLock { $0 += added.filter { $0 }.count }
        }
      }
      let label = adapter.label
      let r = try await loader.loadCollection(adapter, collection: c, params: params, scope: .slot(slot),
                                              beforeRelationships: before, onDocument: { _, _, _ in
        let n = done.withLock { v -> Int in
          v += 1
          return v
        }
        ctx.progress(Double(n) / Double(units), phase: "load", message: "\(label): \(n) / \(units)")
      })
      collections[c.slug] = r.counts
      if aliasSource != nil { result["aliases"] = .number(Double(aliasCount.withLock { $0 })) }
    }
    result["collections"] = .object(collections)
    if let e = adapter as? any EtymonSource { result["etymology"] = try await loader.writeEtymons(try await e.etymons(params, actx)) }
    if let t = adapter as? any ThemeAssocSource {
      result["themes"] = try await loader.writeThemeAssocs(try await t.themeAssocs(params, actx), labels: try await t.themeLabels(params, actx))
    }
    result["finished_at"] = .string(StoreClock.isoNow())
    return result
  }

  /// The packs an adapter reads, opened (the demo's built from the engine resources).
  static func files(for adapter: any SourceAdapter, atlasPath: String) async throws -> SourceFiles {
    if adapter.id == DemoAdapter.adapterID { return SourceFiles([try await demoPack()]) }
    return try await PackLibrary.files(SourceRegistry.packNames(for: adapter), atlasPath: atlasPath)
  }

  /// The demo pack, written from the engine's resources into the temporary directory (deterministic bytes).
  static func demoPack() async throws -> SourceFiles.Pack {
    if let p = try await PackLibrary.open(DemoPack.name, atlasPath: nil) { return p }
    // keyed by the resources' bytes and the engine version (both go into the pack), so a stale file is never reused
    let key = try DemoPack.resourcesDigest().prefix(16)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-demo-\(key).\(PackFormat.fileExtension)")
    if !FileManager.default.fileExists(atPath: url.path) { _ = try DemoPack.write(to: url) }
    return try await PackLibrary.open(url: url)
  }
}

/// The `adapter-load` job: `{adapter, …adapter params}`; `{adapter: 'demo', apply: 'deferred'}` applies the demo's
/// deferred human layer.
public struct AdapterLoadTask: JobTask {
  public static let type = JobType(rawValue: "adapter-load")
  public static let writes = WriteNeed.exclusive
  public static let resumable = false
  public static let budget = ResourceBudget(peakBytes: 256 << 20, maxThreads: 2, mayStartInBackground: true)

  let adapterID: String
  let params: JSONValue

  public init(params: JSONValue) throws {
    guard let id = params["adapter"]?.stringValue, !id.isEmpty else {
      throw ScrollsError.badRequest(.validation, "adapter-load needs {adapter: \"<id>\"}.", hint: "Name a registered adapter.")
    }
    guard SourceRegistry.adapter(id: id) != nil else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_ADAPTER_UNKNOWN"), message: "Unknown adapter '\(id)'.",
                         hint: "Known adapters: \(SourceRegistry.adapters.map(\.id).joined(separator: ", ")).", status: 404)
    }
    adapterID = id
    self.params = params
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    if adapterID == DemoAdapter.adapterID && params["apply"]?.stringValue == "deferred" {
      let result = DemoLoadTask.deferredPending()
      _ = try await ctx.journaledCommit("demo deferred") { _, _ in }
      return result
    }
    let registered = SourceRegistry.adapter(id: adapterID)!
    var user = params.objectValue ?? [:]
    for k in ["adapter", "apply", "approve", "chain", "untilDone", "chunkMs", "relChunk"] { user[k] = nil }
    let files = try await AdapterLoading.files(for: registered, atlasPath: SourcePipelines.atlasPath(ctx))
    let adapter = SourceRegistry.bind(registered, to: files)
    let lease = await ctx.lease()
    try await SourcePipelines.recordPacks(lease, files)
    let result = try await AdapterLoading.loadAdapterData(ctx, adapter, files: files, params: .object(user), lease: lease)
    await lease.end()
    _ = try await ctx.journaledCommit("adapter-load \(adapterID)") { tx, _ in try tx.bumpDataVersion() }
    ctx.progress(1, phase: "load", message: "\(adapter.label): loaded")
    return .object(result)
  }
}

/// The `demo-load` job (`{step?: 'load', force?: bool}`).
public struct DemoLoadTask: JobTask {
  public static let type = JobType(rawValue: "demo-load")
  public static let writes = WriteNeed.exclusive
  public static let resumable = false
  public static let budget = ResourceBudget(peakBytes: 64 << 20, maxThreads: 1, mayStartInBackground: true)

  /// The expressions the tour follows (tracked with origin 'demo').
  public static let tourExpressions: [(surface: String, lang: String?, kind: String, cluster: Bool)] = [
    ("carry the zero", "en", "phrase", true), ("flux up", "en", "phrase", true),
    ("ghost in the margin", "en", "phrase", false), ("◉", nil, "symbol", false),
  ]

  let force: Bool
  let deferred: Bool

  public init(params: JSONValue) throws {
    force = params["force"]?.boolValue ?? false
    deferred = params["step"]?.stringValue == "deferred"
  }

  /// What the deferred step would apply, all pending in this build (N6's review and label layers).
  static func deferredPending() -> JSONValue {
    ["reviews": 0, "labels": 0,
     "pending": ["reviews: the review layer (N6) is not built into this load yet",
                 "label: the notebook layer (N6) is not built into this load yet"]]
  }

  public func run(_ ctx: JobContext) async throws -> JSONValue {
    if deferred { return Self.deferredPending() }
    let loaded = try await ctx.read { c -> Int in
      guard let coll = try SourceLoader.collection(DemoAdapter.collection, on: c) else { return 0 }
      let s = try c.prepared(LoadSQL.documentCount)
      try s.bind(.int(coll.id))
      return Int(try s.first { $0.int(0) } ?? 0)
    }
    if loaded > 0 && !force { return ["skipped": "the demo corpus is already loaded", "documents": .number(Double(loaded))] }
    let t0 = ContinuousClock.now
    let files = SourceFiles([try await AdapterLoading.demoPack()])
    let lease = await ctx.lease()
    try await SourcePipelines.recordPacks(lease, files)
    var result = try await AdapterLoading.loadAdapterData(ctx, DemoAdapter(files: files), files: files, params: .object([:]),
                                                          lease: lease)
    await lease.end()
    // the human layer and the pipeline runs of the tour belong to other packages; this build reports them as pending
    let human = try DemoAdapter(files: files).humanLayer()
    var pending: [JSONValue] = []
    for r in human.reviews { pending.append(.string("review of \(r["key"]?.stringValue ?? "?"): the review layer (N6) is not built into this load yet")) }
    for a in human.revisions { pending.append(.string("revision of \(a["key"]?.stringValue ?? "?"): the notebook layer (N6) is not built into this load yet")) }
    for e in Self.tourExpressions {
      pending.append(.string("expression '\(e.surface)': tracking (N3) is not built into this load yet; the tour tracks it when it opens"))
    }
    pending.append("the pipeline runs (materialize, reuse-index, cluster) wait for their packages (N3, N5, N4)")
    result["human_layer"] = ["reviews": 0, "revisions": 0, "expressions": .object([:]), "queued": [], "pending": .array(pending)]
    result["ms"] = .number(BootstrapPhases.milliseconds(since: t0))
    _ = try await ctx.journaledCommit("demo-load") { tx, _ in try tx.bumpDataVersion() }
    ctx.progress(1, phase: "demo", message: "demo loaded")
    return .object(result)
  }
}
