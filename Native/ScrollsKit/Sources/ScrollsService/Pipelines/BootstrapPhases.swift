// OWNER: N2
// The three phases of the Cipher bootstrap (bootstrap-cipher.mjs phaseA, phaseA2, phaseBText, phaseBBoilerplate,
// reconcile, mergeEvidence), run inside a `bootstrap-cipher` job by BootstrapCipherTask.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsLineage
import ScrollsSources
import ScrollsStore
import Synchronization

enum BootstrapPhases {
  typealias B = BootstrapCipher

  static func milliseconds(since t0: ContinuousClock.Instant) -> Double {
    let d = ContinuousClock.now - t0
    return (Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15).rounded()
  }

  static func unavailable(_ adapter: String, _ reason: String?) -> ScrollsError {
    ScrollsError(code: ErrorCode(rawValue: "E_CIPHER_UNAVAILABLE"), message: "\(adapter): \(reason ?? "unavailable")",
                 hint: "Build the Cipher packs again with Tools/packs.sh.", status: 409)
  }

  static func count(_ v: JSONValue?, _ path: String...) -> Int {
    var cur = v
    for k in path { cur = cur?[k] }
    return cur?.safeInteger ?? 0
  }

  // MARK: phase A

  static func phaseA(_ ctx: JobContext, _ loader: SourceLoader, _ files: SourceFiles) async throws -> JSONObject {
    let tA = ContinuousClock.now
    let lease = loader.env.lease
    let actx = AdapterContext(pack: files.packs.first?.reader)
    var result: JSONObject = ["started_at": .string(StoreClock.isoNow())]
    ctx.progress(0, phase: B.Phase.a.label, message: "culture works")

    // text collections exist from the start, so their lanes say "indexing — not yet looked" until phase B ends
    try await lease.batch("text collections") { tx in
      _ = try SourceLoader.ensureCollections(tx, adapter: CipherBooksAdapter(), scope: .slot(.cipherText))
      _ = try SourceLoader.ensureCollections(tx, adapter: CipherWikisourceAdapter(), scope: .slot(.cipherText))
      for slug in B.textCollections where try SourcePipelines.status(tx.connection, slug) != "ready" {
        try SourcePipelines.setStatus(tx, slug, "pending")
      }
    }

    // 1. works + siblings + glosses: one batch (relationships resolve at finish)
    let works = CipherWorksAdapter(files: files)
    let loadedWorks = try await ctx.read { try SourceLoader.loadedExtIds(CipherWorksAdapter.collection, on: $0) }
    if loadedWorks.isEmpty {
      let probe = try await works.probe(actx)
      guard probe.available else { throw unavailable(works.id, probe.reason) }
      let coll = try await lease.batch("works collection") { tx -> LoadCollection in
        let c = try SourceLoader.ensureCollections(tx, adapter: works, extraCaveats: probe.caveats, scope: .slot(.cipherMeta))
        try SourcePipelines.setStatus(tx, CipherWorksAdapter.collection, "indexing")
        return c[0]
      }
      let run = try await ctx.startRun(Stage(rawValue: "cipher_load"),
                                       params: ["threshold": 0.42, "cap": 0.7, "cross_culture": true,
                                                "source": "culture-works.tsv siblings"],
                                       scope: ["collections": ["cipher-culture-works"]], upstream: [], representation: nil,
                                       seed: nil, pipelineVersion: "cipher-theme-cosine@build_culture.py")
      let total = max(1, probe.counts["works"] ?? 1)
      let r = try await loader.loadCollection(works, collection: coll, params: ["runIds": ["cipher_load": .number(Double(run.id.rawValue))]],
                                              scope: .slot(.cipherMeta), onDocument: { n, _, _ in
        if n % 2000 == 0 {
          ctx.progress(B.aShare * 0.8 * Double(n) / Double(total), phase: B.Phase.a.label,
                       message: "culture works \(Format.int(n)) / \(Format.int(total))")
        }
      })
      try await ctx.finishRun(run, .succeeded, metrics: ["kindred": .number(Double(count(r.counts, "relationships", "computed")))])
      try await lease.batch("works ready") { tx in
        let s = try tx.connection.prepared(LoadSQL.terciles)
        try s.bind(.int(coll.id))
        try s.run()
        try SourcePipelines.setStatus(tx, CipherWorksAdapter.collection, "ready")
        try tx.bumpDataVersion()
      }
      result["works"] = ["documents": r.counts["documents"] ?? .null, "relationships": r.counts["relationships"] ?? .null,
                         "annotations": r.counts["annotations"] ?? .null, "issues": r.counts["issues"]?["by_code"] ?? .null,
                         "kindred_run": .number(Double(run.id.rawValue))]
    } else {
      result["works"] = ["skipped": "already loaded"]
    }
    try await ctx.checkpoint()
    ctx.progress(B.aShare * 0.85, phase: B.Phase.a.label, message: "theme associations")

    // 2. themes
    let themes = CipherThemesAdapter(files: files)
    let hasThemes = try await ctx.read { try $0.prepared(LoadSQL.anyThemeAssoc).first { _ in true } ?? false }
    if !hasThemes {
      result["themes"] = try await loader.writeThemeAssocs(try await themes.themeAssocs(.object([:]), actx),
                                                           labels: try await themes.themeLabels(.object([:]), actx))
    } else {
      result["themes"] = ["skipped": "already loaded"]
    }
    try await ctx.checkpoint()
    ctx.progress(B.aShare * 0.9, phase: B.Phase.a.label, message: "etymology (roots.tsv)")

    // 3. roots (idempotent: existing keys are kept)
    let roots = CipherRootsAdapter(files: files)
    result["roots"] = try await loader.writeEtymons(try await roots.etymons(.object([:]), actx))
    let aMS = milliseconds(since: tA)
    result["run"] = .number(Double(try await recordRun(ctx, works: works, label: "phase A", extra: ["phase_a_ms": .number(aMS)]).rawValue))
    ctx.progress(B.aShare, phase: B.Phase.a.label, message: B.readyMessage)
    return result
  }

  // MARK: phase A2

  static let sourceCode = ["wikipedia": "w", "wikidata": "d", "musicbrainz": "m", "itwofs": "i"]

  static func phaseA2(_ ctx: JobContext, _ loader: SourceLoader, _ files: SourceFiles) async throws -> JSONObject {
    let lease = loader.env.lease
    let rel = CipherRelationsAdapter(files: files)
    let works = CipherWorksAdapter(files: files)
    let m = try rel.model()
    let coll = try await lease.batch("relations collection") { tx -> LoadCollection in
      let c = try SourceLoader.ensureCollections(tx, adapter: rel, scope: .slot(.cipherRelations))
      try SourcePipelines.setStatus(tx, B.relations, "indexing")
      return c[0]
    }
    var refused = B.unloadable(try await ctx.read { try B.state($0) }, B.relations)
    let total = m.documents
    var loaded = try await ctx.read { try SourceLoader.loadedExtIds(B.relations, on: $0) }
    var documents = 0
    ctx.progress(B.aShare, phase: B.Phase.a2.label, message: "relation endpoints")
    while loaded.count + refused.count < total {
      let before = loaded.count + refused.count
      let r = try await loader.loadCollection(
        rel, collection: coll, params: ["skip": .array((loaded.union(refused)).sorted().map(JSONValue.string))],
        scope: .slot(.cipherRelations),
        options: LoadOptions(deadline: .now + SourcePipelines.configuration.chunk, relationships: false, annotations: false,
                             commitOnSuspend: true), onDocument: { n, _, _ in
        if n % 5000 == 0 {
          ctx.progress(B.aShare + B.a2Share * 0.7 * Double(before + n) / Double(max(1, total)), phase: B.Phase.a2.label,
                       message: "relation endpoints \(Format.int(before + n)) / \(Format.int(total))")
        }
      })
      documents += count(r.counts, "documents", "created")
      try await B.addUnloadable(lease, B.relations, r.refused)
      refused.formUnion(r.refused)
      loaded = try await ctx.read { try SourceLoader.loadedExtIds(B.relations, on: $0) }
      if count(r.counts, "documents", "created") + count(r.counts, "documents", "rejected") == 0 && r.refused.isEmpty { break }
    }

    ctx.progress(B.aShare + B.a2Share * 0.7, phase: B.Phase.a2.label, message: "documented relations")
    let siblingKeys = Set(try works.siblingMapping(kindredRun: nil).relationships.compactMap { r -> String? in
      guard r.evidenceStatus == "documented", let code = r.sourceDataset.flatMap({ sourceCode[$0] }) else { return nil }
      return "\(r.relType)|\(r.src.extId ?? "")|\(r.dst.extId ?? "")|\(code)"
    })
    let (rels, merged) = try rel.relationships(siblingKeys: siblingKeys)
    let aliases = Mutex(0)
    let r = try await loader.loadCollection(
      PrecomputedRelationships(base: rel, relationships: rels), collection: coll,
      params: ["skip": .array((loaded.union(refused)).sorted().map(JSONValue.string)), "siblingKeys": .number(Double(siblingKeys.count))],
      scope: .slot(.cipherRelations), options: LoadOptions(annotations: false),
      beforeRelationships: { writer, actx in
        // one writer call (a transaction per ≤ 50,000 rows / 2 s), not a transaction per alias (bootstrap-writes)
        let added = try await writer.addAliases(try await rel.aliases(.object([:]), actx).map { (target: $0.target, alias: $0.alias) })
        aliases.withLock { $0 += added.filter { $0 }.count }
      })
    let mergedRows = try await mergeEvidence(lease, merged)
    try await lease.batch("relations ready") { tx in
      try SourcePipelines.setStatus(tx, B.relations, "ready")
      try tx.bumpDataVersion()
    }
    ctx.progress(B.b0, phase: B.Phase.a2.label, message: "Cipher music genealogy is ready")
    return ["documents": .number(Double(documents)), "counts": .object(JSONObject(m.counts.map { ($0.key, $0.value) })),
            "aliases": .number(Double(aliases.withLock { $0 })), "relationships": r.counts["relationships"] ?? .null,
            "merged": .number(Double(mergedRows))]
  }

  /// An external_record evidence row (and an add_evidence revision) on each culture-works sibling a raw record restates.
  static func mergeEvidence(_ lease: WriteLease, _ merged: [MergedRelation]) async throws -> Int {
    guard !merged.isEmpty else { return 0 }
    let by = CipherFormat.assertedBy(CipherRelationsAdapter.adapterID, "1.0.0")
    return try await lease.batch("merge relation evidence") { tx -> Int in
      let c = tx.connection
      let doc = try c.prepared(PipelineSQL.docByExt), relOf = try c.prepared(PipelineSQL.relationshipOf)
      let seen = try c.prepared(PipelineSQL.evidenceSeen), insEv = try c.prepared(PipelineSQL.insertEvidence)
      let insRev = try c.prepared(PipelineSQL.insertRevision), bump = try c.prepared(PipelineSQL.bumpRev)
      var n = 0
      for x in merged {
        try doc.bind(.text(x.src.collection), .text(x.src.extId))
        guard let s = try doc.first({ $0.int(0) }) else { continue }
        try doc.bind(.text(x.dst.collection), .text(x.dst.extId))
        guard let d = try doc.first({ $0.int(0) }) else { continue }
        let dataset = ["w": "wikipedia", "m": "musicbrainz", "i": "itwofs"][x.source] ?? x.source
        try relOf.bind(.text(x.relType), .text(String(s)), .text(String(d)), .text(dataset))
        guard let r = try relOf.first({ (id: $0.int(0), rev: $0.int(1)) }) else { continue }
        let detail = CanonicalJSON.string(["file": .string(x.file), "page": x.page.map(JSONValue.string) ?? .null,
                                           "locator": x.locator.map(JSONValue.string) ?? .null])
        try seen.bind(.int(r.id), .text(detail))
        if try seen.first({ _ in true }) == true { continue }
        let at = StoreClock.isoNow()
        let ev = try tx.ids.next("relationship_evidence", .slot(.cipherRelations))
        try insEv.bind(.int(ev), .int(r.id), .text(detail), .text(by), .text(at))
        try insEv.run()
        let rev = try tx.ids.nextLog("relationship_revision")
        try insRev.bind(.int(rev), .int(r.id), .int(r.rev + 1), .text(by), .text(at),
                        .text(CanonicalJSON.string(["evidence_id": .number(Double(ev)), "role": "external_record",
                                                    "locator": x.locator.map(JSONValue.string) ?? .null])),
                        .text("the raw \(x.file) record restates this Cipher relation"))
        try insRev.run()
        try bump.bind(.int(r.rev + 1), .int(r.id))
        try bump.run()
        n += 1
      }
      if n > 0 { try tx.bumpDataVersion() }
      return n
    }
  }

  // MARK: phase B

  static func phaseB(_ ctx: JobContext, _ loader: SourceLoader, _ files: SourceFiles) async throws -> JSONObject {
    let lease = loader.env.lease
    let books = CipherBooksAdapter(files: files), ws = CipherWikisourceAdapter(files: files)
    var chunks: [JSONValue] = []
    var st = try await ctx.read { try B.state($0) }

    if st["text_done_at"] == nil {
      // the plan: every ext_id, by collection, in bootstrap order
      var all: [String: [String]] = ["cipher-gutenberg": try GutenbergBooks.load(files).books.map { "pg:\($0.id)" }]
      for lang in CipherWikisourceAdapter.langs { all["cipher-wikisource-\(lang)"] = try ws.extIds(lang) }
      let colls = try await lease.batch("text collections") { tx -> [String: LoadCollection] in
        var out: [String: LoadCollection] = [:]
        for c in try SourceLoader.ensureCollections(tx, adapter: books, scope: .slot(.cipherText)) { out[c.slug] = c }
        for c in try SourceLoader.ensureCollections(tx, adapter: ws, scope: .slot(.cipherText)) { out[c.slug] = c }
        return out
      }
      let total = all.values.reduce(0) { $0 + $1.count }
      var done = 0
      for slug in B.textCollections {
        let loaded = try await ctx.read { try SourceLoader.loadedExtIds(slug, on: $0) }
        done += all[slug]!.filter { loaded.contains($0) || B.unloadable(st, slug).contains($0) }.count
      }
      try await SourcePipelines.ftsBulkLoad(lease, on: true)
      do {
        for slug in B.textCollections {
          var refused = B.unloadable(st, slug)
          var loaded = try await ctx.read { try SourceLoader.loadedExtIds(slug, on: $0) }
          var remaining = all[slug]!.filter { !loaded.contains($0) && !refused.contains($0) }
          let status = try await ctx.read { try SourcePipelines.status($0, slug) }
          if remaining.isEmpty {
            if status != "ready" { try await lease.batch("status") { tx in try SourcePipelines.setStatus(tx, slug, "ready") } }
            continue
          }
          try await lease.batch("status") { tx in try SourcePipelines.setStatus(tx, slug, "indexing") }
          let adapter: any SourceAdapter = slug == "cipher-gutenberg" ? books : ws
          while !remaining.isEmpty {
            let params: JSONValue = slug == "cipher-gutenberg"
              ? ["ids": .array(remaining.compactMap { Int($0.dropFirst(3)) }.map { .number(Double($0)) })]
              : ["skip": .array(loaded.union(refused).sorted().map(JSONValue.string))]
            let before = done
            let r = try await loader.loadCollection(
              adapter, collection: colls[slug]!, params: params, scope: .slot(.cipherText),
              options: LoadOptions(deadline: .now + SourcePipelines.configuration.chunk, relationships: false,
                                   annotations: false, commitOnSuspend: true), onDocument: { n, _, _ in
              let fraction = B.b0 + B.textShare * Double(before + n) / Double(max(1, total))
              ctx.progress(fraction, phase: B.Phase.b.label, message: "full text \(Format.int(before + n)) / \(Format.int(total)) books")
            })
            try await B.addUnloadable(lease, slug, r.refused)
            refused.formUnion(r.refused)
            var chunk = JSONObject()
            chunk["collection"] = .string(slug)
            chunk.set("documents", count(r.counts, "documents", "created"))
            chunk.set("rejected", count(r.counts, "documents", "rejected"))
            chunk.set("translations", count(r.counts, "documents", "translations"))
            chunk["tokens"] = r.counts["tokens"] ?? .null
            chunk["issues"] = r.counts["issues"]?["by_code"] ?? .null
            chunks.append(.object(chunk))
            loaded = try await ctx.read { try SourceLoader.loadedExtIds(slug, on: $0) }
            remaining = remaining.filter { !loaded.contains($0) && !refused.contains($0) }
            done = before + r.documentsSeen
            if count(r.counts, "documents", "created") + count(r.counts, "documents", "rejected") == 0 && r.refused.isEmpty { break }
          }
          if remaining.isEmpty { try await lease.batch("status") { tx in try SourcePipelines.setStatus(tx, slug, "ready") } }
        }
      } catch {
        try? await SourcePipelines.ftsBulkLoad(lease, on: false)  // leave the index merging normally
        throw error
      }
      ctx.progress(B.b0 + B.textShare, phase: B.Phase.b.label, message: "merging the full-text index")
      try await SourcePipelines.ftsBulkLoad(lease, on: false)
      let steps = try await SourcePipelines.ftsMerge(lease, checkpoint: { try await ctx.checkpoint() })
      try await lease.batch("text done") { tx in try B.writeState(tx, ["text_done_at": .string(StoreClock.isoNow())]) }
      st = try await ctx.read { try B.state($0) }
      chunks.append(["fts_merge_steps": .number(Double(steps))])
    }

    // the boilerplate pass (N5): a pass that is not built yet is reported, never faked
    var boilerplate: JSONObject = [:]
    if st["boilerplate_done_at"] == nil {
      ctx.progress(B.b0 + B.textShare + 0.03, phase: B.Phase.b.label, message: "boilerplate pass")
      let t0 = ContinuousClock.now
      do {
        let r = try await SourcePipelines.configuration.boilerplate.run(ctx, options: BoilerplateOptions())  // every collection, as the reference's boilerplatePass(db, ctx)
        boilerplate = ["status": "done", "run": r.run.map { .number(Double($0.rawValue)) } ?? .null,
                       "passages_flagged": .number(Double(r.passagesFlagged)), "canary": .number(Double(r.canary)), "metrics": r.metrics]
      } catch let e as ScrollsError where e.code == .notImplemented {
        boilerplate = ["status": "not_available",
                       "reason": "the boilerplate pass (N5) is not built yet; licence paragraphs inside book bodies were flagged by the adapter regions only"]
      }
      boilerplate["ms"] = .number(milliseconds(since: t0))
      let record = boilerplate
      try await lease.batch("boilerplate done") { tx in
        try B.writeState(tx, ["boilerplate_done_at": .string(StoreClock.isoNow()),
                              "boilerplate": ["status": record["status"] ?? .null, "reason": record["reason"] ?? .null]])
      }
    }
    ctx.progress(0.99, phase: B.Phase.b.label, message: "reconciliation")
    let final = try await ctx.read { try B.state($0) }
    var extra: JSONObject = ["boilerplate": ["status": final["boilerplate"]?["status"] ?? .null, "reason": final["boilerplate"]?["reason"] ?? .null]]
    extra["phase_a_ms"] = final["A"]?["ms"] ?? .null
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let started = final["started_at"]?.stringValue, let t = iso.date(from: started) {
      extra["elapsed_ms_since_start"] = .number((Date().timeIntervalSince(t) * 1000).rounded())
    }
    let run = try await recordRun(ctx, works: CipherWorksAdapter(files: files), label: "complete", extra: extra)
    return ["chunks": .array(chunks), "boilerplate": .object(boilerplate), "final_run": .number(Double(run.rawValue))]
  }

  // MARK: reconciliation (§6.8)

  /// The reconciliation counts (what the files say vs what the atlas holds) in a succeeded 'bootstrap-cipher' run.
  static func recordRun(_ ctx: JobContext, works: CipherWorksAdapter, label: String, extra: JSONObject = [:]) async throws -> RunID {
    let expected = try works.siblingMapping(kindredRun: RunID(rawValue: 0)).stats
    var metrics: JSONObject = ["label": .string(label)]
    for (k, v) in extra { metrics[k] = v }
    metrics["reconciliation"] = try await ctx.read { try reconcile($0, expected: expected.expected) }
    var parse = expected.jsonValue.objectValue ?? [:]
    parse["expected"] = nil
    metrics["siblings_parse"] = .object(parse)
    let run = try await ctx.startRun(Stage(rawValue: "bootstrap-cipher"), params: ["label": .string(label)],
                                     scope: ["collections": .array((["cipher-culture-works", B.relations] + B.textCollections).map(JSONValue.string))],
                                     upstream: [], representation: nil, seed: nil, pipelineVersion: "bootstrap-cipher@1.0.0")
    try await ctx.finishRun(run, .succeeded, metrics: .object(metrics))
    return run.id
  }

  /// `reconcile(db, {expectedRelationships})`.
  static func reconcile(_ c: Connection, expected: [String: Int]?) throws -> JSONValue {
    func one(_ sql: SQL, _ values: [SQLValue]) throws -> Int {
      let s = try c.prepared(sql)
      try s.bind(values)
      return Int(try s.first { $0.int(0) } ?? 0)
    }
    func pairs(_ sql: SQL, _ values: [SQLValue]) throws -> JSONObject {
      let s = try c.prepared(sql)
      try s.bind(values)
      return JSONObject(try s.all { ($0.isNull(0) ? "null" : $0.text(0), JSONValue.number(Double($0.int(1)))) })
    }
    var m = JSONObject()
    if let cw = try SourceLoader.collection(CipherWorksAdapter.collection, on: c) {
      let sib = CipherFormat.assertedBy(CipherWorksAdapter.adapterID, "1.0.0")
      var works = JSONObject()
      works.set("documents", try one(PipelineSQL.docCount, [.int(cw.id)]))
      works.set("undated", try one(PipelineSQL.docChrono, [.int(cw.id), .text("undated")]))
      works.set("scheduled", try one(PipelineSQL.docChrono, [.int(cw.id), .text("scheduled")]))
      works.set("glosses", try one(PipelineSQL.glosses, [.int(cw.id)]))
      m["works"] = .object(works)
      let s = try c.prepared(PipelineSQL.siblingsByTypeStatus)
      try s.bind(.int(cw.id), .text(sib))
      var rels: [String: Int] = [:]
      for r in try s.all({ ("\($0.text(0))|\($0.text(1))", Int($0.int(2))) }) { rels[r.0] = r.1 }
      let w = try c.prepared(PipelineSQL.siblingsWith)
      try w.bind(.int(cw.id), .text(sib))
      let (unrecorded, located, conflicts) = try w.first { (Int($0.int(0)), Int($0.int(1)), Int($0.int(2))) } ?? (0, 0, 0)
      var rel: JSONObject = ["by_type_status": .object(JSONObject(rels.map { ($0.key, JSONValue.number(Double($0.value))) }))]
      rel.set("kindred_computed", rels["kindred|computed"] ?? 0)
      rel.set("counterpart_proposed", rels["counterpart|proposed"] ?? 0)
      rel.set("documented_unrecorded", unrecorded)
      rel.set("with_locator", located)
      rel.set("date_conflicts", conflicts)
      if let expected {
        rel["expected"] = .object(JSONObject(expected.map { ($0.key, JSONValue.number(Double($0.value))) }))
        rel["match"] = .bool(Set(expected.keys).union(rels.keys).allSatisfy { (expected[$0] ?? 0) == (rels[$0] ?? 0) })
      }
      m["relationships"] = .object(rel)
    }
    if let pg = try SourceLoader.collection("cipher-gutenberg", on: c) {
      var g = JSONObject()
      g.set("documents", try one(PipelineSQL.docCount, [.int(pg.id)]))
      g.set("aliases", try one(PipelineSQL.aliasCount, [.int(pg.id)]))
      g["translations"] = .object(try pairs(PipelineSQL.translations, [.int(pg.id)]))
      g["by_basis"] = .object(try pairs(PipelineSQL.byBasis, [.int(pg.id)]))
      g.set("undated", try one(PipelineSQL.docChrono, [.int(pg.id), .text("undated")]))
      g.set("lifetime_estimates", try one(PipelineSQL.lifetimeEstimates, [.int(pg.id)]))
      g["passages_by_quality"] = .object(try pairs(PipelineSQL.passagesByQuality, [.int(pg.id)]))
      g.set("apparatus_passages", try one(PipelineSQL.passagesByTimeRole, [.int(pg.id), .text("apparatus")]))
      g.set("canary_ok_passages", try one(PipelineSQL.canaryOK, [.text("\"\(B.canary)\""), .int(pg.id)]))
      g.set("tokens", try one(PipelineSQL.textTokens, [.int(pg.id)]))
      m["gutenberg"] = .object(g)
    }
    if let mr = try SourceLoader.collection(B.relations, on: c) {
      let by = CipherFormat.assertedBy(CipherRelationsAdapter.adapterID, "1.0.0")
      var r = JSONObject()
      r.set("documents", try one(PipelineSQL.docCount, [.int(mr.id)]))
      r.set("undated", try one(PipelineSQL.docChrono, [.int(mr.id), .text("undated")]))
      if let cw = try SourceLoader.collection(CipherWorksAdapter.collection, on: c) {
        r.set("aliases_on_works", try one(PipelineSQL.relationEndpointAliases, [.int(cw.id)]))
      } else {
        r.set("aliases_on_works", 0)
      }
      let s = try c.prepared(PipelineSQL.relationsByQuality)
      try s.bind(.text(by))
      r["relationships"] = .object(JSONObject(try s.all { ("\($0.text(0))|\($0.text(1))", JSONValue.number(Double($0.int(2)))) }))
      let nd = try c.prepared(PipelineSQL.relationsNonDocumented)
      try nd.bind(.text(by))
      let (nonDocumented, conflicts) = try nd.first { (Int($0.int(0)), Int($0.int(1))) } ?? (0, 0)
      r.set("non_documented", nonDocumented)
      r.set("merged_evidence_rows", try one(PipelineSQL.evidenceAddedBy, [.text(by)]))
      r.set("date_conflicts", conflicts)
      m["music_relations"] = .object(r)
    }
    for lang in CipherWikisourceAdapter.langs {
      guard let w = try SourceLoader.collection("cipher-wikisource-\(lang)", on: c) else { continue }
      var o = JSONObject()
      o.set("documents", try one(PipelineSQL.docCount, [.int(w.id)]))
      o.set("undated", try one(PipelineSQL.docChrono, [.int(w.id), .text("undated")]))
      let q = try pairs(PipelineSQL.passagesByQuality, [.int(w.id)])
      o["front_matter_passages"] = q["front_matter"] ?? .number(0)
      o.set("tokens", try one(PipelineSQL.textTokens, [.int(w.id)]))
      m["wikisource_\(lang)"] = .object(o)
    }
    var ety = JSONObject()
    ety.set("etymons", try one(PipelineSQL.etymonCount, []))
    ety["by_semantics"] = .object(try pairs(PipelineSQL.etymonBySemantics, []))
    ety.set("members", try one(PipelineSQL.etymonMembers, []))
    m["etymology"] = .object(ety)
    var th = JSONObject()
    th.set("associations", try one(PipelineSQL.themeAssocs, []))
    m["themes"] = .object(th)
    return .object(m)
  }
}

/// An adapter that yields relationships computed beforehand (phase A2: the relations minus those the siblings already
/// state) under the identity of `base`.
struct PrecomputedRelationships: SourceAdapter {
  let base: CipherRelationsAdapter
  let list: [CanonicalRelationship]
  init(base: CipherRelationsAdapter, relationships: [CanonicalRelationship]) {
    self.base = base
    self.list = relationships
  }
  var id: String { base.id }
  var version: String { base.version }
  var label: String { base.label }
  var access: AdapterAccess { base.access }
  var license: String { base.license }
  var attribution: String { base.attribution }
  var collections: [ScrollsSources.CollectionSpec] { base.collections }
  func probe(_ context: AdapterContext) async throws -> AdapterProbeResult { try await base.probe(context) }
  func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { 0 }
  func documents(_ params: JSONValue, _ context: AdapterContext, into channel: BoundedChannel<[CanonicalDocument]>) async throws {}
  func relationships(_ params: JSONValue, _ context: AdapterContext,
                     into channel: BoundedChannel<[CanonicalRelationship]>) async throws {
    var out = BatchSender(channel)
    for r in list {
      try Task.checkCancellation()
      try await out.append(r)
    }
    try await out.flush()
  }
}
