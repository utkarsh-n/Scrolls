// OWNER: N2
// G2 on the Cipher slice (IOS-SPEC §2.2, §2.4 "exact per table, ids mapped to natural keys", §8.5 N2): the slice files of
// g2.cipher-slice-inputs (Golden/slices.mjs) are packed exactly as Tools/packs.sh packs Cipher (cipher-meta, cipher-text),
// this engine runs Cipher's bootstrap on them from an empty device atlas (phases A, A2, B with the boilerplate pass), and
// its LogicalDump is compared with the frozen reference's, table by table.
// The comparison rules beyond the dump spec, each a registered or requested divergence:
// - tables the device profile adds (text_storage, text_chunk, id_counter, pack_install, journal_applied,
//   saved_view_portable) are not in the reference: not compared;
// - original_file.rel_path and .source_path: `pack:<name>@<sha8>/<member>` on the phone vs `originals/<aa>/<sha>` and a
//   Mac path in the reference, by design (IOS-SPEC §3.5); masked on both sides (requested DV, N2-1);
// - raw ids inside text ('document:12', 'run:7', 'import:3', …): both sides' ids are mapped through the id-free keys of
//   slices.mjs ID_MAP_SQL (the same SQL below), because slot-range ids differ from the reference's by design (§3.3);
// - meta keys the device profile adds (profile, journal_applied_seq, base_max_ids, …) are not in the reference: dropped.
// Everything else must be equal. A mismatch reports the table, the counts and the first differing lines; the report is
// Reports/golden-g2.cipher-slice.json.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsSources
import ScrollsStore
import Testing

@Suite("G2 Cipher slice", .serialized)
struct CipherSliceTests {
  static let family = "g2.cipher-slice"
  static let deviceOnly: Set<String> = ["text_storage", "text_chunk", "id_counter", "pack_install", "journal_applied", "saved_view_portable"]
  /// meta keys only the device profile writes (dropped) and keys whose values are timings on both sides (masked).
  static let deviceMetaKeys: Set<String> = ["profile", "journal_applied_seq", "base_max_ids", "starter_sha256", "generation",
                                            "generation_built_on", "engine_version", "engine_code_hash"]
  static let timingMetaKeys: Set<String> = ["cipher_bootstrap"]
  static let idMapSQL: [(table: String, sql: SQL, prefixes: [String])] = [
    ("document", SliceSQL.documentKeys, ["document:"]),
    ("passage", SliceSQL.passageKeys, ["passage:"]),
    ("analysis_run", SliceSQL.runKeys, ["run:"]),
    ("import_batch", SliceSQL.batchKeys, ["import:", "batch:"]),
  ]

  /// The slice files, written from the private inputs family (sha256 checked).
  static func writeInputs(to root: URL) throws -> Int {
    var n = 0
    for c in try GoldenStore.lines(of: "g2.cipher-slice-inputs") {
      guard let path = c["path"]?.stringValue, let b64 = c["base64"]?.stringValue, let sha = c["sha256"]?.stringValue,
            let data = Data(base64Encoded: b64) else { throw GoldenUnavailable(description: "a malformed input case") }
      let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard got == sha else { throw GoldenUnavailable(description: "input \(path): sha256 \(got) ≠ \(sha)") }
      let url = root.appendingPathComponent(path)
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: url)
      n += 1
    }
    return n
  }

  /// cipher-meta and cipher-text from the slice, as Tools/packs.sh builds them (member lists of CipherPacks.sources).
  static func writePacks(cipherRoot: URL, into dir: URL) throws {
    for name in [CipherPacks.meta, CipherPacks.text] {
      let manifest = PackManifest(packID: name, name: name, version: "1.0.0", slot: name == CipherPacks.meta ? .cipherMeta : .cipherText,
                                  adapterIDs: [], createdBy: "CipherSliceTests", referenceCommit: "", licences: [], attribution: [],
                                  caveats: [], members: [], counts: [:])
      var w = try PackWriter(url: dir.appendingPathComponent("\(name).\(PackFormat.fileExtension)"), manifest: manifest)
      for (member, file) in try CipherPacks.files(of: name, cipherRoot: cipherRoot) { try w.add(member: member, from: file) }
      _ = try w.finish()
    }
  }

  @Test("the Cipher slice built by this engine = the reference's build, table by table (G2 exact)")
  func cipherSlice() async throws {
    try await runSlice(interruptPhaseB: false, report: true)
  }

  @Test("phase B stopped mid-way (the engine closed, as a kill leaves it) resumes from its committed chunks: no document twice, the same atlas")
  func phaseBResumes() async throws {
    let saved = SourcePipelines.configure(SourcePipelines.Configuration(chunk: .seconds(2)))
    defer { SourcePipelines.configure(saved) }
    try await runSlice(interruptPhaseB: true, report: false)
  }

  /// Builds the slice (phases A, A2, B; optionally closing the engine during B and reopening it), then compares.
  func runSlice(interruptPhaseB: Bool, report: Bool) async throws {
    guard GoldenStore.available(Self.family) else {
      Issue.record("\(Self.family) is not in MANIFEST.json yet: regenerate it with Tools/golden.sh g2.cipher-slice,g2.cipher-slice-rows,g2.cipher-slice-inputs")
      return
    }
    guard GoldenStore.available("g2.cipher-slice-inputs") else {
      print("SKIP g2.cipher-slice: the private inputs (~/Developer/scrolls-golden/<ref>/private/g2.cipher-slice-inputs) are absent on this Mac")
      return
    }
    let work = FileManager.default.temporaryDirectory.appendingPathComponent("n2-slice-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: work) }
    let cipher = work.appendingPathComponent("cipher"), packs = work.appendingPathComponent("packs")
    try FileManager.default.createDirectory(at: packs, withIntermediateDirectories: true)
    _ = try Self.writeInputs(to: cipher)
    try Self.writePacks(cipherRoot: cipher, into: packs)

    // the build: an empty device atlas, then the three phases (each a journaled job, as on the phone)
    PackLibrary.reset()
    PackLibrary.addSearchDirectory(packs)
    defer { PackLibrary.reset() }
    let location = try AtlasLocation.at(root: work.appendingPathComponent("root"))
    var engine = try await AtlasEngine.open(location, origin: .empty)
    for phase in BootstrapCipher.Phase.allCases {
      let files = try await PackLibrary.files(phase.packs, atlasPath: location.atlasPath)
      let spec = JobSpec(type: BootstrapCipher.type, params: ["phase": .string(phase.rawValue)], journal: BootstrapCipher.journalOp(phase, files: files))
      if phase == .b && interruptPhaseB {
        let id = try await engine.jobs.enqueue(spec)
        // wait until at least one chunk of books is committed, then close the engine under the running job
        var loaded = 0
        for _ in 0..<1200 where loaded == 0 {
          try await Task.sleep(for: .milliseconds(250))
          loaded = try await engine.read { try SourceLoader.loadedExtIds("cipher-gutenberg", on: $0).count }
        }
        #expect(loaded > 0 && loaded < 25, "the interruption lands between chunks (\(loaded) of 25 books committed)")
        await engine.close()
        engine = try await AtlasEngine.open(location, origin: .existing)
        // a job stopped by suspension stays 'interrupted' across the restart; the bootstrap supervisor then queues the phase
        // again (BootstrapCipher.start), and the new job resumes from the committed chunks — as here
        var snap = try await engine.jobs.job(id)
        var job = id
        if snap?.status == .interrupted || snap?.status == .cancelled {
          job = try await engine.jobs.enqueue(spec)
          snap = try await engine.jobs.job(job)
        }
        let deadline = ContinuousClock.now + .seconds(3600)
        while let s = snap, !s.status.isFinal, ContinuousClock.now < deadline {
          if let waited = await engine.jobs.wait(for: job, timeout: .seconds(60)) {
            snap = waited
          } else {
            snap = try await engine.jobs.job(job)
          }
        }
        #expect(snap?.status == .succeeded, "phase B after the reopen: \(snap?.error?.message ?? snap?.status.rawValue ?? "")")
        let resumedCount = try await engine.read { try SourceLoader.loadedExtIds("cipher-gutenberg", on: $0).count }
        #expect(resumedCount == 25, "every book loaded once the phase resumed (\(resumedCount) of 25)")
        let dups = try await engine.read { c in try c.prepared(SliceSQL.duplicateDocs).first { $0.int(0) } ?? -1 }
        #expect(dups == 0, "\(dups) documents were written twice")
        continue
      }
      let snap = try await engine.run(spec)
      #expect(snap.status == .succeeded, "phase \(phase.rawValue): \(snap.error?.message ?? "")")
      if snap.status != .succeeded { await engine.close(); return }
    }
    await engine.close()
    try compare(location: location, work: work, report: report)
  }

  /// The comparison of the built atlas with the reference's dump (see the header for the rules).
  func compare(location: AtlasLocation, work: URL, report writeReport: Bool) throws {
    // the dumps
    let c = try Connection(path: location.atlasPath, mode: .readOnly, profile: .device)
    defer { c.close() }
    let dumpDir = work.appendingPathComponent("dump")
    let digests = try LogicalDump.dump(c, text: ChunkedTextStore(), to: dumpDir, tables: nil)
    var swiftIDs: [String: [Int64: String]] = [:]
    for m in Self.idMapSQL { swiftIDs[m.table] = Dictionary(try c.prepared(m.sql).all { ($0.int(0), $0.text(1)) }, uniquingKeysWith: { a, _ in a }) }

    let golden = try GoldenStore.lines(of: Self.family)
    var nodeDigest: [String: JSONValue] = [:]
    var nodeRows: [String: [String]] = [:]
    for g in golden {
      guard let table = g["table"]?.stringValue else { continue }
      if g["kind"]?.stringValue == "digest" { nodeDigest[table] = g }
      if g["kind"]?.stringValue == "row", let l = g["line"]?.stringValue { nodeRows[table, default: []].append(l) }
    }
    var nodeIDs: [String: [Int64: String]] = [:]
    let havePrivate = GoldenStore.available("g2.cipher-slice-rows")
    if havePrivate {
      nodeRows = [:]
      for g in try GoldenStore.lines(of: "g2.cipher-slice-rows") {
        guard let t = g["table"]?.stringValue else { continue }
        if g["kind"]?.stringValue == "idmap" {
          for p in g["pairs"]?.arrayValue ?? [] {
            if let id = p[0]?.safeInteger, let k = p[1]?.stringValue { nodeIDs[t, default: [:]][Int64(id)] = k }
          }
        } else {
          nodeRows[t, default: []].append(contentsOf: (g["lines"]?.arrayValue ?? []).compactMap(\.stringValue))
        }
      }
    }

    var diffs: [GoldenDiff] = []
    var compared = 0, equal = 0
    for table in nodeDigest.keys.sorted() where !Self.deviceOnly.contains(table) {
      let nd = nodeDigest[table]!
      if nd["skipped"] != nil { continue }
      compared += 1
      let swiftLines = (try? String(contentsOf: dumpDir.appendingPathComponent("\(table).jsonl"), encoding: .utf8))?
        .split(separator: "\n").map(String.init) ?? []
      let nodeRowsHere = nodeRows[table]
      if nodeRowsHere == nil, let sd = digests[table], sd.rows == nd["rows"]?.safeInteger, sd.sha256 == nd["sha256"]?.stringValue {
        equal += 1
        continue
      }
      guard let nl = nodeRowsHere ?? (nd["rows"]?.safeInteger == 0 ? [] : nil) else {
        diffs.append(GoldenDiff(index: diffs.count, path: table, expected: nd, actual: .string("\(digests[table]?.rows ?? 0) rows"),
                                detail: havePrivate ? "digest differs (this table is compared by digest only)"
                                  : "digest differs and the private rows are absent on this Mac"))
        continue
      }
      let n = Set(nl.compactMap { Self.normalize($0, table: table, ids: nodeIDs) })
      let s = Set(swiftLines.compactMap { Self.normalize($0, table: table, ids: swiftIDs) })
      if n == s { equal += 1; continue }
      let onlyNode = n.subtracting(s).sorted().prefix(3), onlySwift = s.subtracting(n).sorted().prefix(3)
      diffs.append(GoldenDiff(index: diffs.count, path: table,
                              expected: .array(onlyNode.map(JSONValue.string)), actual: .array(onlySwift.map(JSONValue.string)),
                              detail: "reference \(n.count) rows, Swift \(s.count); \(n.subtracting(s).count) only in the reference, \(s.subtracting(n).count) only in Swift"))
    }
    let report = GoldenReport(family: Self.family, tier: "g2", cases: compared, mismatches: diffs.count, diffs: Array(diffs.prefix(40)),
                              passed: diffs.isEmpty)
    if writeReport { try GoldenStore.write(report) }
    for d in diffs.prefix(40) { print("g2.cipher-slice \(d.path): \(d.detail)\n  reference: \(CanonicalJSON.string(d.expected).prefix(900))\n  swift:     \(CanonicalJSON.string(d.actual).prefix(900))") }
    #expect(diffs.isEmpty, "\(diffs.count) of \(compared) tables differ: \(diffs.map(\.path).joined(separator: ", "))")
  }

  /// One dump line with the comparison rules applied (see the header).
  static func normalize(_ line: String, table: String, ids: [String: [Int64: String]]) -> String? {
    guard var v = try? JSONValue.parse(Data(line.utf8)) else { return line }
    if table == "original_file", var o = v.objectValue {
      o["rel_path"] = .string("<pack or originals path>")
      o["source_path"] = .string("<source path>")
      v = .object(o)
    }
    if table == "meta", let key = v["$key"]?.arrayValue?.first?.stringValue {
      if deviceMetaKeys.contains(key) { return nil }
      if timingMetaKeys.contains(key) { return "{\"$meta-timings\":\(CanonicalJSON.string(.string(key)))}" }
    }
    if table == "analysis_run", var o = v.objectValue, var m = o["metrics_json"]?.objectValue {
      // wall-clock fields of a run's metrics (how long a phase or the pass took, when it finished) are not evidence
      for k in ["duration_ms", "finished_at", "phase_a_ms", "elapsed_ms_since_start", "ms"] { m[k] = nil }
      o["metrics_json"] = .object(m)
      v = .object(o)
    }
    if table == "import_batch", var o = v.objectValue {
      // a long load commits one batch per ≈ 20 s chunk on both sides, so how many batches there are and which ids each
      // chunk was asked for (options_json, summary_json) depend on the machine's speed; the batch's natural key does not
      o["options_json"] = nil
      o["summary_json"] = nil
      v = .object(o)
    }
    return CanonicalJSON.string(mapIDs(v, ids))
  }

  /// Strings "<prefix><digits>" → "<prefix>#<id-free key>".
  static func mapIDs(_ v: JSONValue, _ ids: [String: [Int64: String]]) -> JSONValue {
    switch v {
    case .string(let s):
      for m in idMapSQL {
        for p in m.prefixes where s.hasPrefix(p) {
          if let n = Int64(s.dropFirst(p.count)), let k = ids[m.table]?[n] { return .string("\(p)#\(k)") }
        }
      }
      return v
    case .array(let a): return .array(a.map { mapIDs($0, ids) })
    case .object(let o): return .object(o.mapValues { mapIDs($0, ids) })
    default: return v
    }
  }
}

/// The id-free keys of slices.mjs ID_MAP_SQL, in Swift (the same SQL text).
enum SliceSQL: SQLCatalog {
  static let documentKeys = SQL("test.n2.slice.documentKeys",
                                "SELECT d.id AS id, c.slug || '|' || d.ext_id AS key FROM document d JOIN collection c ON c.id = d.collection_id",
                                scan: .scanOK(reason: "test: every document"))
  static let passageKeys = SQL("test.n2.slice.passageKeys", """
    SELECT p.id AS id, c.slug || '|' || d.ext_id || '|' || p.field || '|' || p.ord AS key
    FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    """, scan: .scanOK(reason: "test: every passage"))
  static let runKeys = SQL("test.n2.slice.runKeys",
                           "SELECT id, stage || '|' || ROW_NUMBER() OVER (PARTITION BY stage ORDER BY id) AS key FROM analysis_run",
                           scan: .scanOK(reason: "test: every run"))
  static let batchKeys = SQL("test.n2.slice.batchKeys", """
    SELECT b.id AS id, c.slug || '|' || b.adapter_id || '|' || ROW_NUMBER() OVER (PARTITION BY b.collection_id, b.adapter_id ORDER BY b.id) AS key
    FROM import_batch b JOIN collection c ON c.id = b.collection_id
    """, scan: .scanOK(reason: "test: every batch"))
  static let duplicateDocs = SQL("test.n2.slice.duplicateDocs", """
    SELECT count(*) FROM (SELECT collection_id, ext_id FROM document GROUP BY collection_id, ext_id HAVING count(*) > 1)
    """, scan: .scanOK(reason: "test: every document"))
  static let all: [SQL] = [documentKeys, passageKeys, runKeys, batchKeys, duplicateDocs]
}
