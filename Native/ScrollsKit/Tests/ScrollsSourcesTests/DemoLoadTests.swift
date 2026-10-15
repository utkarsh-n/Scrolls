// OWNER: N2
// The demo through the ordinary import path (SPEC §9.1, IOS-SPEC §3.3 slot 0): the demo adapter reads the demo pack
// (data/demo/* byte for byte), the loader drives it into a writer — first a recording fake of the frozen DocumentWriting
// protocol, then N1's DocumentWriter — and the atlas then holds the reference's demo: 228 synthetic documents in
// demo-world with slot-0 ids, the 11 authored relationships, every non-deferred annotation, and the originals recorded
// as pack members. Counts are the m1r snapshot's (built by the frozen reference).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsSources
import ScrollsStore
import Synchronization
import Testing

@Suite("Demo adapter and loader", .serialized)
struct DemoLoadTests {
  static func demoFiles() throws -> SourceFiles {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("n2-demo-\(UUID().uuidString).scrollspack")
    return SourceFiles([try DemoPack.write(to: url)])
  }

  @Test("the demo adapter probes its pack: 228 documents, 11 relationships, the non-deferred annotations")
  func probe() async throws {
    let files = try Self.demoFiles()
    let a = DemoAdapter(files: files)
    let p = try await a.probe(AdapterContext(pack: files.packs.first?.reader))
    #expect(p.available)
    #expect(p.counts["documents"] == 228)
    #expect(p.counts["relationships"] == 11)
    #expect((p.counts["annotations"] ?? 0) > 0)
    let unbound = try await DemoAdapter().probe(AdapterContext(pack: nil))
    #expect(!unbound.available && unbound.reason == "the demo pack is not on this phone")
  }

  @Test("the registry knows every adapter once, with its slot and corpus")
  func registry() {
    let ids = SourceRegistry.adapters.map(\.id)
    #expect(Set(ids).count == ids.count)
    #expect(ids.contains("demo") && ids.contains("cipher.works") && ids.contains("cipher.relations") && ids.contains("cipher.books"))
    #expect(SourceRegistry.slot(for: "demo") == .base)
    #expect(SourceRegistry.slot(for: "cipher.works") == .cipherMeta)
    #expect(SourceRegistry.slot(for: "cipher.relations") == .cipherRelations)
    #expect(SourceRegistry.slot(for: "cipher.wikisource") == .cipherText)
    #expect(SourceRegistry.corpus(for: "demo") == "demo" && SourceRegistry.corpus(for: "cipher.roots") == "cipher")
    #expect(SourceRegistry.adapters.allSatisfy { $0.access != .network })
  }

  @Test("the loader hands a fake writer every record in batches, registers adapters and collections, keeps originals")
  func fakeWriter() async throws {
    let atlas = try await ScratchAtlas()
    let files = try Self.demoFiles()
    let log = RecordingWriter.Box()
    let targets = Locked<[DocumentWriterTarget]>([])
    let lease = await atlas.lease()
    let env = atlas.environment(lease) { _, target, _ in
      targets.withLock { $0.append(target) }
      return RecordingWriter(target: target, log: log, refuse: ["demo:A30"])
    }
    let loader = SourceLoader(env: env, files: files)
    let adapter = DemoAdapter(files: files)
    try await lease.batch("adapters") { tx in try SourceLoader.registerAdapters(tx) }
    let colls = try await lease.batch("collections") { tx in
      try SourceLoader.ensureCollections(tx, adapter: adapter, scope: .slot(.base))
    }
    #expect(colls.map(\.slug) == ["demo-world"])
    #expect(colls[0].synthetic)
    let r = try await loader.loadCollection(adapter, collection: colls[0], params: [:], scope: .slot(.base))
    await lease.end()
    let l = log.withLock { $0 }
    #expect(l.documents.count == 227, "228 records, one refused by the fake")
    #expect(r.documentsSeen == 228 && r.refused == ["demo:A30"])
    #expect(l.relationships == 11 && l.annotations > 0 && l.finished && !l.rolledBack)
    #expect(targets.withLock { $0 }.map(\.ids) == [.slot(.base)])
    #expect(targets.withLock { $0 }.first?.corpus == "demo")
    #expect(try await atlas.scalar(TestSQL.adapters) >= Int64(SourceRegistry.adapters.count + SourceRegistry.fileAdapters.count))
    #expect(try await atlas.scalar(TestSQL.originals, [.text("pack:demo@%/documents.jsonl")]) == 1)
    #expect(try await atlas.scalar(TestSQL.originals, [.text("pack:demo@%")]) == 3)
    #expect(try await atlas.scalar(TestSQL.batches, [.text("committing")]) == 1, "the fake does not commit the batch")
    let collectionID = try await atlas.scalar(TestSQL.collectionID, [.text("demo-world")])
    #expect(collectionID >= 1 && collectionID < RowIDPolicy.slotWidth, "slot-0 id")
    await atlas.close()
  }

  @Test("N1's DocumentWriter loads the demo: 228 synthetic documents with slot-0 ids, 11 relationships, originals as pack members")
  func realWriter() async throws {
    let atlas = try await ScratchAtlas()
    let files = try Self.demoFiles()
    let lease = await atlas.lease()
    let env = atlas.environment(lease) { try await DocumentWriter.open(lease: $0, target: $1, options: $2) }
    let loader = SourceLoader(env: env, files: files)
    let adapter = DemoAdapter(files: files)
    try await lease.batch("adapters") { tx in try SourceLoader.registerAdapters(tx) }
    let coll = try await lease.batch("collections") { tx in
      try SourceLoader.ensureCollections(tx, adapter: adapter, scope: .slot(.base))
    }[0]
    let r = try await loader.loadCollection(adapter, collection: coll, params: [:], scope: .slot(.base))
    await lease.end()
    #expect(r.refused.isEmpty)
    #expect(try await atlas.scalar(TestSQL.documents, [.text("demo-world")]) == 228)
    #expect(try await atlas.scalar(TestSQL.synthetic) == 228)
    let maxID = try await atlas.scalar(TestSQL.idRange)
    #expect(maxID > 0 && maxID < RowIDPolicy.slotWidth, "every demo document takes a slot-0 id (max \(maxID))")
    #expect(try await atlas.scalar(TestSQL.relationships) == 11)
    #expect(try await atlas.scalar(TestSQL.annotations) > 0)
    #expect(try await atlas.scalar(TestSQL.sourceFiles) == 228, "every document points at its line of documents.jsonl")
    #expect(try await atlas.scalar(TestSQL.batches, [.text("committed")]) == 1)
    await atlas.close()
  }

  @Test("a cancelled load rolls its batch back and marks it cancelled")
  func cancelled() async throws {
    let atlas = try await ScratchAtlas()
    let files = try Self.demoFiles()
    let log = RecordingWriter.Box()
    let lease = await atlas.lease()
    let seen = Locked(0)
    let env = LoadEnvironment(lease: lease, writerFactory: { _, t, _ in RecordingWriter(target: t, log: log) }, jobID: nil,
                              checkpoint: {
                                if seen.withLock({ v -> Int in v += 1; return v }) > 1 { throw CancellationError() }
                              })
    let loader = SourceLoader(env: env, files: files)
    let adapter = DemoAdapter(files: files)
    let coll = try await lease.batch("collections") { tx in
      try SourceLoader.registerAdapters(tx)
      return try SourceLoader.ensureCollections(tx, adapter: adapter, scope: .slot(.base))
    }[0]
    do {
      _ = try await loader.loadCollection(adapter, collection: coll, params: [:], scope: .slot(.base))
      Issue.record("a cancelled load returned")
    } catch is CancellationError {
    }
    await lease.end()
    #expect(log.withLock { $0.rolledBack })
    #expect(try await atlas.scalar(TestSQL.batches, [.text("cancelled")]) == 1)
    await atlas.close()
  }
}
