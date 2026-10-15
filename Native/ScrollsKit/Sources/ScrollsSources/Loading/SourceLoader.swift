// OWNER: N2
// Port of the loading half of `server/jobs/tasks/adapter-load.mjs` (and document-writer.mjs's collection/batch
// helpers): where an adapter's records become rows. Adapters never write SQL; this drives them into a
// `DocumentWriting` (N1's DocumentWriter, or a fake in tests):
//  · source_adapter rows are registered (file importers and every adapter of the registry);
//  · collections are created from the adapter's CollectionSpec (+ caveats) in the adapter's corpus, with ids of the
//    source's slot (§3.3);
//  · one import batch and one writer per collection (per chunk for long loads); the adapter parses on a producer task
//    that sends batches of 500 into a BoundedChannel(4) while this task writes (§1.5); documents are written up to
//    5,000 per writer call (a writer transaction), not one transaction per document — or, for a load with a deadline,
//    as many as the last call's pace fits in 1 s (`SlicePace`), so a chunk still ends within about one call of its
//    deadline (a transaction and a WAL checkpoint per document: phase A wrote 46 GB on the Mac and tripped the phone's
//    1 GB/24 h diskwrites report; bootstrap-writes 2026-10-14);
//  · pack members the adapter keeps get their `original_file` rows (`pack:<name>@<sha8>/<member>`) before any document
//    cites them; issues the adapter reports are written after their batch;
//  · etymology and theme associations, which are not documents, are written here.
// Everything goes through the job's write lease: each statement batch is one transaction that yields to interactive
// writes (§1.5). Cancellation and suspension come from the job's checkpoint.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsStore
import Synchronization

/// What a load runs on: the job's write lease, the writer factory, and the job's checkpoint and progress.
public struct LoadEnvironment: Sendable {
  public var lease: WriteLease
  public var writerFactory: DocumentWriterFactory
  public var jobID: JobID?
  /// Cancellation, suspension, the thermal pause and the stall rule's heartbeat (JobContext.checkpoint).
  public var checkpoint: @Sendable () async throws -> Void

  public init(lease: WriteLease, writerFactory: @escaping DocumentWriterFactory, jobID: JobID?,
              checkpoint: @escaping @Sendable () async throws -> Void) {
    self.lease = lease
    self.writerFactory = writerFactory
    self.jobID = jobID
    self.checkpoint = checkpoint
  }
}

/// A collection as a load knows it.
public struct LoadCollection: Sendable, Equatable {
  public var id: Int64
  public var slug: String
  public var corpusID: Int64
  public var synthetic: Bool
}

/// What loading one collection (or one chunk of it) did.
public struct CollectionLoadResult: Sendable {
  public var batch: Int64
  /// The writer's summary counts (the reference's counts object, verbatim).
  public var counts: JSONValue
  public var documentsSeen: Int
  /// Records the writer refused (their issues are in the batch): not retried by later chunks.
  public var refused: [String]
  /// Stopped at the deadline (or on suspension) with documents left.
  public var stoppedEarly: Bool
  public var dataVersion: Int
}

/// How a load stops early.
public struct LoadOptions: Sendable {
  /// Stop taking documents after this instant; the batch commits what it holds.
  public var deadline: ContinuousClock.Instant?
  /// Load the adapter's relationships and annotations after the documents.
  public var relationships = true
  public var annotations = true
  /// On suspension, commit the documents written so far (text chunks) instead of rolling the batch back (a batch
  /// whose relationships resolve against the whole collection).
  public var commitOnSuspend = false
  public var writerOptions = DocumentWriterOptions()

  public init(deadline: ContinuousClock.Instant? = nil, relationships: Bool = true, annotations: Bool = true,
              commitOnSuspend: Bool = false, writerOptions: DocumentWriterOptions = DocumentWriterOptions()) {
    self.deadline = deadline
    self.relationships = relationships
    self.annotations = annotations
    self.commitOnSuspend = commitOnSuspend
    self.writerOptions = writerOptions
  }
}

/// Drives adapters into the writer.
public struct SourceLoader: Sendable {
  public let env: LoadEnvironment
  public let files: SourceFiles

  public init(env: LoadEnvironment, files: SourceFiles) {
    self.env = env
    self.files = files
  }

  // MARK: rows shared by every load

  /// `registerAdapters`: the file importers' and every registered adapter's `source_adapter` row (the user's
  /// enabled / approved / config choices survive; a network adapter starts disabled).
  public static func registerAdapters(_ tx: WriteTx) throws {
    let up = try tx.connection.prepared(LoadSQL.upsertAdapter)
    for a in SourceRegistry.fileAdapters {
      try up.bind(.text(a.id), .text(a.version), .text(a.label), .text(a.access), .int(1), .text(a.license), .text(a.attribution))
      try up.run()
    }
    for a in SourceRegistry.adapters {
      try up.bind(.text(a.id), .text(a.version), .text(a.label), .text(a.access.rawValue), .int(a.access == .network ? 0 : 1),
                  .text(a.license), .text(a.attribution))
      try up.run()
    }
  }

  /// The collection with `slug`, if it exists.
  public static func collection(_ slug: String, on c: Connection) throws -> LoadCollection? {
    let s = try c.prepared(LoadSQL.collectionBySlug)
    try s.bind(.text(slug))
    return try s.first { LoadCollection(id: $0.int(0), slug: slug, corpusID: $0.int(1), synthetic: $0.int(2) != 0) }
  }

  /// `ensureAdapterCollections`: creates the adapter's collections that do not exist yet (caveats = the spec's, then
  /// `extraCaveats`), in the adapter's corpus, with ids of `scope`.
  public static func ensureCollections(_ tx: WriteTx, adapter: any SourceAdapter, extraCaveats: [String] = [],
                                       only: [String]? = nil, scope: IDScope) throws -> [LoadCollection] {
    let c = tx.connection
    let corpusSlug = SourceRegistry.corpus(for: adapter.id)
    let notes = (adapter as? any CollectionCaveats)?.collectionCaveats ?? [:]
    var out: [LoadCollection] = []
    for spec in adapter.collections where only == nil || only!.contains(spec.slug) {
      if let existing = try collection(spec.slug, on: c) { out.append(existing); continue }
      let corpusStatement = try c.prepared(LoadSQL.corpusBySlug)
      try corpusStatement.bind(.text(corpusSlug))
      guard let corpus = try corpusStatement.first({ (id: $0.int(0), synthetic: $0.int(1)) }) else {
        throw ScrollsError(code: .validation, message: "ensureCollection: unknown corpus '\(corpusSlug)'",
                           hint: "The atlas lacks its seeded corpora; rebuild it.", status: 500)
      }
      let id = try tx.ids.next("collection", scope)
      let caveats = (notes[spec.slug] ?? []) + extraCaveats
      let ins = try c.prepared(LoadSQL.insertCollection)
      try ins.bind(.int(id), .int(corpus.id), .text(adapter.id), .text(spec.slug), .text(spec.name), .text(spec.domain),
                   .text(spec.modality), .text(spec.unit), .text(spec.sampling), .int(spec.rateEligible == false ? 0 : 1),
                   spec.coverageGate.map { .int(Int64($0)) } ?? .null, .int(spec.exportTextAllowed == false ? 0 : 1),
                   .int(corpus.synthetic), .text(adapter.license), .text(adapter.attribution), .string(spec.selectionNote),
                   .text(CanonicalJSON.string(.array(caveats.map(JSONValue.string)))), .null, .null, .text(StoreClock.isoNow()))
      try ins.run()
      out.append(LoadCollection(id: id, slug: spec.slug, corpusID: corpus.id, synthetic: corpus.synthetic != 0))
    }
    return out
  }

  /// `createBatch`: an adapter batch (status 'committing') of `collection`; its id is a log id (commit order).
  public static func createBatch(_ tx: WriteTx, collection: Int64, adapter: any SourceAdapter, params: JSONValue,
                                 fileName: String? = nil, job: JobID?) throws -> Int64 {
    let id = try tx.ids.nextLog("import_batch")
    let ins = try tx.connection.prepared(LoadSQL.insertBatch)
    try ins.bind(.int(id), .int(collection), .text(adapter.id), .text(adapter.version), .string(fileName),
                 .text(CanonicalJSON.string(["params": scrub(params)])), job.map { .int($0.rawValue) } ?? .null,
                 .text(StoreClock.isoNow()))
    try ins.run()
    return id
  }

  /// Params as stored in `import_batch.options_json` (no huge arrays, no internal keys).
  public static func scrub(_ params: JSONValue) -> JSONValue {
    var out = JSONObject()
    for (k, v) in params.objectValue ?? [:] {
      if ["writerOptions", "skip", "loaded", "existing", "merged", "siblingKeys"].contains(k) { continue }
      if let a = v.arrayValue, a.count > 50 { out[k] = .string("\(a.count) items") } else { out[k] = v }
    }
    return .object(out)
  }

  /// `original_file` rows of pack members.
  public static func writeOriginals(_ tx: WriteTx, _ originals: [SourceOriginal]) throws {
    guard !originals.isEmpty else { return }
    let ins = try tx.connection.prepared(LoadSQL.insertOriginal)
    let now = StoreClock.isoNow()
    for o in originals {
      try ins.bind(.text(o.sha256), .text(o.relPath), .text(o.sourcePath), .int(o.byteSize), .text(o.encoding),
                   .int(o.hadBOM ? 1 : 0), .text(now))
      try ins.run()
    }
  }

  /// ext_ids already loaded (committed batches) in a collection.
  public static func loadedExtIds(_ slug: String, on c: Connection) throws -> Set<String> {
    guard let coll = try collection(slug, on: c) else { return [] }
    let s = try c.prepared(LoadSQL.loadedExtIds)
    try s.bind(.int(coll.id))
    return Set(try s.all { $0.text(0) })
  }

  /// The collection's status key (`collection_status:<slug>`, read by /api/corpora and the timeline's pending lanes).
  public static func statusKey(_ slug: String) -> String { "collection_status:\(slug)" }

  // MARK: one collection

  /// `loadCollection`: documents (until `options.deadline`), then aliases, relationships and annotations, in one batch.
  public func loadCollection(_ adapter: any SourceAdapter, collection: LoadCollection, params: JSONValue,
                             scope: IDScope, options: LoadOptions = LoadOptions(),
                             beforeRelationships: (@Sendable (any DocumentWriting, AdapterContext) async throws -> Void)? = nil,
                             onDocument: (@Sendable (Int, DocumentWriteResult, CanonicalDocument) -> Void)? = nil)
    async throws -> CollectionLoadResult
  {
    let env = self.env
    let batch = try await env.lease.batch("adapter batch \(adapter.id)") { tx in
      try SourceLoader.createBatch(tx, collection: collection.id, adapter: adapter, params: params, job: env.jobID)
    }
    let target = DocumentWriterTarget(batch: ImportBatchID(rawValue: batch), collection: collection.slug,
                                      corpus: SourceRegistry.corpus(for: adapter.id), ids: scope)
    let writer = try await env.writerFactory(env.lease, target, options.writerOptions)
    let issues = IssueInbox()
    let actx = AdapterContext(pack: files.packs.first?.reader, progress: { _, _, _ in },
                              warn: { code, message, detail in issues.add(RecordIssue.issue(code: code, message: message, detail: detail)) })
    var p = params.objectValue ?? [:]
    p["collection"] = .string(collection.slug)
    let adapterParams = JSONValue.object(p)
    let lines = adapter as? any SourceLines
    var seen = 0
    var refused: [String] = []
    var stoppedEarly = false
    var suspended = false
    do {
      // 1. documents, produced on their own task
      let channel = BoundedChannel<[CanonicalDocument]>(capacity: 4)
      let producer = Task { () -> (any Error)? in
        do {
          try await adapter.documents(adapterParams, actx, into: channel)
          await channel.finish()
          return nil
        } catch {
          await channel.finish()
          return error
        }
      }
      // producer batches are queued — their documents, then the issues reported by then, the order in which the loop
      // wrote them one batch at a time — and written `pace.size` documents per writer call
      var queued: [WriterRecord] = []
      do {
        var pace = SlicePace()
        var queuedDocs: [CanonicalDocument] = []
        var producing = true
        loop: while true {
          let want = pace.size(deadline: options.deadline)
          while producing && queuedDocs.count < want {
            guard let docs = await channel.next() else {
              producing = false
              break
            }
            queued += docs.map { WriterRecord.document($0, line: lines?.line(of: $0)) }
            queuedDocs += docs
            queued += issues.drain().map(WriterRecord.issue)
          }
          if queuedDocs.isEmpty { break }
          let n = min(want, queuedDocs.count)
          var cut = 0, counted = 0
          while counted < n {
            if case .document = queued[cut] { counted += 1 }
            cut += 1
          }
          try await writeKept()
          let call = Array(queued.prefix(cut)), slice = Array(queuedDocs.prefix(n))
          queued.removeFirst(cut)  // `queued` keeps only records the writer has not been given
          queuedDocs.removeFirst(n)
          let t0 = ContinuousClock.now
          let results = try await writer.add(call)
          pace.record(n, took: ContinuousClock.now - t0)
          for (doc, r) in zip(slice, results) {
            seen += 1
            if r.document == nil { refused.append(doc.extId) }
            onDocument?(seen, r, doc)
          }
          if let d = options.deadline, ContinuousClock.now > d {
            stoppedEarly = true
            break loop
          }
          try await env.checkpoint()
        }
      } catch is JobSuspended where options.commitOnSuspend {
        stoppedEarly = true
        suspended = true
      } catch {
        producer.cancel()
        _ = await producer.value
        for case .issue(let i) in queued { try? await writer.addIssue(i) }  // kept by the rollback, as when written per batch
        throw error
      }
      if stoppedEarly {
        producer.cancel()
        _ = await producer.value
      } else if let error = await producer.value {
        throw error
      }
      try await writeKept()
      for case .issue(let i) in queued { try await writer.addIssue(i) }  // documents left unwritten are the next chunk's
      for i in issues.drain() { try await writer.addIssue(i) }

      if !suspended {
        // 2. aliases onto other collections, relationships, annotations
        try await beforeRelationships?(writer, actx)
        if options.relationships {
          try await drain(adapter.relationships, params: adapterParams, actx) { rel in
            for i in try await writer.add(rel) { try await writer.addIssue(i) }
          }
        }
        if options.annotations {
          try await drain(adapter.annotations, params: adapterParams, actx) { ann in
            for i in try await writer.add(ann) { try await writer.addIssue(i) }
          }
        }
        try await writeKept()
        for i in issues.drain() { try await writer.addIssue(i) }
        try await env.checkpoint()
      }
      let summary = try await writer.finish()
      if suspended { throw JobSuspended() }
      return CollectionLoadResult(batch: batch, counts: summary.counts, documentsSeen: seen, refused: refused,
                                  stoppedEarly: stoppedEarly, dataVersion: summary.dataVersion)
    } catch let e as JobSuspended where suspended {
      throw e
    } catch {
      try? await writer.rollback()
      if error is CancellationError || error is JobSuspended {
        _ = try? await env.lease.batch("cancel batch \(batch)") { tx in
          let s = try tx.connection.prepared(LoadSQL.setBatchStatus)
          try s.bind(.text("cancelled"), .int(batch))
          try s.run()
        }
      }
      throw error
    }
  }

  /// Writes the `original_file` rows of members the adapter kept since the last call.
  public func writeKept() async throws {
    let kept = files.drainKept()
    guard !kept.isEmpty else { return }
    try await env.lease.batch("originals") { tx in try SourceLoader.writeOriginals(tx, kept) }
  }

  /// Runs a relationship or annotation producer into `consume`, one record at a time.
  func drain<T: Sendable>(_ produce: @escaping @Sendable (JSONValue, AdapterContext, BoundedChannel<[T]>) async throws -> Void,
                          params: JSONValue, _ actx: AdapterContext,
                          _ consume: (T) async throws -> Void) async throws {
    let channel = BoundedChannel<[T]>(capacity: 4)
    let producer = Task { () -> (any Error)? in
      do {
        try await produce(params, actx, channel)
        await channel.finish()
        return nil
      } catch {
        await channel.finish()
        return error
      }
    }
    do {
      while let batch = await channel.next() {
        for r in batch { try await consume(r) }
        try await env.checkpoint()
      }
    } catch {
      producer.cancel()
      _ = await producer.value
      throw error
    }
    if let error = await producer.value { throw error }
  }

  // MARK: non-document data

  /// `writeEtymons`: etymon rows with their parents and members, in batches of 5,000; existing keys are kept
  /// (idempotent) and typeahead labels are added for new rows only.
  public func writeEtymons(_ rows: [EtymonRecord]) async throws -> JSONValue {
    try await writeKept()
    var etymons = 0, parents = 0, members = 0, skipped = 0
    var bySemantics: [String: Int] = [:]
    var i = 0
    while i < rows.count {
      let chunk = Array(rows[i..<min(rows.count, i + 5000)])
      i += chunk.count
      let r = try await env.lease.batch("etymons") { tx -> (Int, Int, Int, Int, [String: Int]) in
        let c = tx.connection
        let insE = try c.prepared(LoadSQL.insertEtymon), insP = try c.prepared(LoadSQL.insertEtymonParent)
        let insM = try c.prepared(LoadSQL.insertEtymonMember), insL = try c.prepared(LoadSQL.insertLabel)
        var e = 0, p = 0, m = 0, s = 0
        var by: [String: Int] = [:]
        for r in chunk {
          try insE.bind(.text(r.key), .text(r.kind), .text(r.lang), .text(r.form), .string(r.roman), .string(r.gloss),
                        .text(r.parentSemantics))
          try insE.run()
          guard c.changes > 0 else { s += 1; continue }
          e += 1
          by[r.parentSemantics, default: 0] += 1
          for (ord, parent) in r.parents.enumerated() {
            try insP.bind(.text(r.key), .text(parent), .int(Int64(ord)))
            try insP.run()
            p += 1
          }
          for mem in r.members {
            try insM.bind(.text(r.key), .text(mem.lang), .text(mem.word), .text(mem.norm), .int(Int64(mem.rank)))
            try insM.run()
            m += 1
          }
          try insL.bind(.text(r.roman.map { "\(r.form) (\($0))" } ?? r.form), .text("etymon"), .text("etymon:\(r.key)"))
          try insL.run()
        }
        if e > 0 { try tx.bumpDataVersion() }
        return (e, p, m, s, by)
      }
      etymons += r.0; parents += r.1; members += r.2; skipped += r.3
      for (k, v) in r.4 { bySemantics[k, default: 0] += v }
      try await env.checkpoint()
    }
    return ["etymons": .number(Double(etymons)), "parents": .number(Double(parents)), "members": .number(Double(members)),
            "skipped": .number(Double(skipped)),
            "by_semantics": .object(JSONObject(bySemantics.map { ($0.key, JSONValue.number(Double($0.value))) }))]
  }

  /// `writeThemeAssocs`: theme associations (upserted) and, the first time, the theme typeahead labels.
  public func writeThemeAssocs(_ assocs: [ThemeAssocRecord], labels: [String]) async throws -> JSONValue {
    try await writeKept()
    let (written, labelled) = try await env.lease.batch("theme associations") { tx -> (Int, Int) in
      let c = tx.connection
      let hadLabels = try c.prepared(LoadSQL.anyThemeAssoc).first { _ in true } ?? false
      let ins = try c.prepared(LoadSQL.upsertThemeAssoc)
      for a in assocs {
        try ins.bind(.text(a.theme), .text(a.other), .double(a.npmi))
        try ins.run()
      }
      var n = 0
      if !hadLabels {
        let insL = try c.prepared(LoadSQL.insertLabel)
        for name in labels {
          try insL.bind(.text(name), .text("theme"), .text("theme:\(name)"))
          try insL.run()
          n += 1
        }
      }
      try tx.bumpDataVersion()
      return (assocs.count, n)
    }
    return ["assocs": .number(Double(written)), "labels": .number(Double(labelled))]
  }
}

/// How many documents one writer call takes. Without a deadline, a writer transaction's worth (5,000; the writer closes
/// a transaction earlier at 50,000 rows or 2 s). With a deadline, as many as the last call's pace fits in `target` (at
/// least one, at most 5,000), so a chunk still ends within about one call of its deadline: a book at a time, hundreds of
/// small records at a time. Each B-tree page a transaction touches is written to the WAL (and checkpointed) once per
/// transaction, so fewer, larger transactions write less (bootstrap-writes, 2026-10-14).
struct SlicePace {
  static let target: Duration = .seconds(1)
  private var perDocument: Duration?

  func size(deadline: ContinuousClock.Instant?) -> Int {
    guard deadline != nil else { return DocumentWriter.flushDocuments }
    guard let per = perDocument, per > .zero else { return 1 }
    return max(1, min(DocumentWriter.flushDocuments, Int(SlicePace.target / per)))
  }

  mutating func record(_ documents: Int, took: Duration) {
    if documents > 0 { perDocument = took / documents }
  }
}

/// Issues an adapter reported (on its producer task), waiting for their batch.
final class IssueInbox: Sendable {
  private let issues = Mutex<[Issue]>([])
  func add(_ i: Issue) { issues.withLock { $0.append(i) } }
  func drain() -> [Issue] {
    issues.withLock { s in
      defer { s = [] }
      return s
    }
  }
}
