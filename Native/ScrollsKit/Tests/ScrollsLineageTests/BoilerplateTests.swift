// OWNER: N5
// The boilerplate pass (SPEC §4.7, §11; IOS-SPEC §8.5 N5 "G2 boilerplate canary").
//  · the licence lexicon and the canary tokens, as the reference's unit test;
//  · G2 `g2.boilerplate`: the reference test's synthetic books, inserted verbatim from the rows the reference's
//    DocumentWriter wrote, then the seven passes in the reference's order through the real `boilerplate` job: results,
//    flagged passages, doc_tokens, run rows, commonplace records and meta versions all exact;
//  · G2 `g2.boilerplate-m1r` (full Cipher, ≈ 1 min per pass): runs when SCROLLS_LINEAGE_M1R=1 (Tools/check.d/lineage.sh)
//    and the m1r snapshot exists; it compares the corpus-level counts with the snapshot's own recorded run, and the
//    reset pass with the reference's.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
@testable import ScrollsLineage
import ScrollsStore
import Testing

@Suite("Boilerplate pass")
struct BoilerplateTests {
  @Test("licence lexicon: single terms match token starts, pairs match two tokens; the canary tokens")
  func lexicon() {
    let toks = Tokenizer.tokens("Project Gutenberg-tm ebooks are licensed; a computer virus, computer codes, small print. Notebook.").tokens
    let lex = Boilerplate.lexiconStarts(toks)
    #expect(toks.enumerated().filter { lex[$0.offset] != 0 }.map(\.element) == ["project", "ebooks", "licensed", "computer", "computer", "small"])
    #expect(lex.filter { $0 != 0 } == [2, 1, 1, 2, 2, 2])
    #expect(lex[toks.firstIndex(of: "notebook")!] == 0, "'ebook' inside 'notebook' is not a match")
    #expect(Boilerplate.canaryTokens == Tokenizer.tokens("computer virus, or computer codes that damage").tokens)
    // the interned path gives the same starts
    let doc = Boilerplate.Tokenizing().tokens("Project Gutenberg-tm ebooks are licensed; a computer virus, computer codes, small print. Notebook.")
    #expect(doc.lex == lex)
    #expect(doc.ids == Winnow.tokenIds(toks))
  }

  @Test("hex8 pads to eight digits")
  func hex() {
    #expect(Boilerplate.hex8(0) == "00000000")
    #expect(Boilerplate.hex8(0xabc) == "00000abc")
    #expect(Boilerplate.hex8(0xffff_ffff) == "ffffffff")
  }

  @Test("job params: collections by slug or id, dryRun, explain; a bad list is E_VALIDATION")
  func params() throws {
    let t = try BoilerplateTask(params: ["collections": ["cipher-gutenberg", 7], "dryRun": true, "explain": [12, 13]])
    #expect(t.options == BoilerplateOptions(collections: ["cipher-gutenberg", "7"], dryRun: true, explain: [12, 13]))
    #expect(try BoilerplateTask(params: [:]).options == BoilerplateOptions())
    #expect(throws: ScrollsError.self) { _ = try BoilerplateTask(params: ["collections": "bp-wide"]) }
  }

  @Test("g2.boilerplate: the reference test's synthetic books, seven passes in order, exact")
  func syntheticBooks() async throws {
    let report = LineageGolden.Report("g2.boilerplate")
    defer { report.write() }
    let cases = try LineageGolden.load("g2.boilerplate")
    guard let input = cases.first, input["kind"] == "input" else { throw HarnessError(description: "no input case") }
    let dir = try PassHarness.scratchDir("g2-boilerplate")
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = try PassHarness.freshReferenceDatabase(in: dir)
    try Self.load(input, into: path)
    let h = try PassHarness(path: path)
    for c in cases.dropFirst() where c["kind"] == "pass" {
      let label = c["label"]?.stringValue ?? "?"
      let slug = c["collection"]?.stringValue ?? ""
      let collID: Int64 = try await h.read { conn in
        try conn.prepared(dynamic: "SELECT id FROM collection WHERE slug = ?").bindingFirst([.text(slug)]) { $0.int(0) } ?? -1
      }
      let canaryBefore = try await h.read { conn in try BoilerplateDetector.canaryCount(conn, scope: [collID]) }
      report.check(canaryBefore == c["canary_before"]?.int, "\(label): canary before (FTS built from the same rows)",
                   expected: c["canary_before"] ?? .null, actual: .number(Double(canaryBefore)))
      let before = try await Self.qualities(h, collID)
      let options = c["options"] ?? [:]
      var params: JSONObject = ["collections": [.string(slug)]]
      if options["dryRun"]?.boolValue == true { params["dryRun"] = true }
      if let ex = options["explain"]?.arrayValue, !ex.isEmpty { params["explain"] = .array(ex) }
      let snap = try await h.run(BoilerplateTask.type, .object(params))
      report.check(snap.status == .succeeded, "\(label): job status", expected: "succeeded",
                   actual: .string("\(snap.status) \(snap.error?.message ?? "")"))
      let masked: Set<String> = ["duration_ms", "finished_at"]
      let result = (snap.result ?? .null).masking(masked)
      let expected = (c["result"] ?? .null).masking(masked)
      report.check(CanonicalJSON.string(result) == CanonicalJSON.string(expected), "\(label): result", expected: expected,
                   actual: result)
      let after = try await Self.qualities(h, collID)
      let flagged = after.filter { $0.value == "boilerplate" && before[$0.key] != "boilerplate" }.keys.sorted()
      report.check(flagged.map { Int($0) } == c["flagged"]?.ints, "\(label): flagged passages",
                   expected: c["flagged"] ?? .null, actual: .array(flagged.map { .number(Double($0)) }))
      let docTokens = try await h.read { conn in
        try conn.prepared(dynamic: """
          SELECT t.document_id, t.plang, t.field_class, t.tokens, t.passages FROM doc_tokens t JOIN document d ON d.id = t.document_id
          WHERE d.collection_id = ? ORDER BY t.document_id, t.plang, t.field_class
          """).binding([.int(collID)]) { r -> JSONValue in
          ["document_id": .number(Double(r.int(0))), "plang": .string(r.text(1)), "field_class": .string(r.text(2)),
           "tokens": .number(Double(r.int(3))), "passages": .number(Double(r.int(4)))]
        }
      }
      report.check(JSONValue.array(docTokens) == c["doc_tokens"], "\(label): doc_tokens", expected: c["doc_tokens"] ?? .null,
                   actual: .array(docTokens))
      let meta = try await h.read { conn -> JSONValue in
        var o = JSONObject()
        for k in ["data_version", "quality_version"] { if let v = try Meta.get(conn, k) { o[k] = .string(v) } }
        return .object(o)
      }
      report.check(meta == c["meta"], "\(label): meta versions", expected: c["meta"] ?? .null, actual: meta)
      // the run row
      if let runExpected = c["run"], !runExpected.isNull, let runID = runExpected["id"]?.int {
        let run = try await h.read { conn -> JSONValue? in
          try conn.prepared(dynamic: """
            SELECT id, stage, status, pipeline_version, params_json, scope_json, metrics_json FROM analysis_run WHERE id = ?
            """).bindingFirst([.int(Int64(runID))]) { r -> JSONValue in
            ["id": .number(Double(r.int(0))), "stage": .string(r.text(1)), "status": .string(r.text(2)),
             "pipeline_version": .string(r.text(3)), "params": (try? JSONValue.parse(r.text(4))) ?? .null,
             "scope": (try? JSONValue.parse(r.text(5))) ?? .null,
             "metrics": ((try? JSONValue.parse(r.text(6))) ?? .null).masking(masked)]
          }
        }
        let want = runExpected.masking(masked)
        report.check(run.map(CanonicalJSON.string) == CanonicalJSON.string(want), "\(label): run row", expected: want,
                     actual: run ?? .null)
      } else {
        report.check(snap.result?["run_id"]?.isNull == true, "\(label): no run for a dry run")
      }
      // the commonplace record
      let cpFile = Commonplaces.directory(atlasPath: path).appendingPathComponent("commonplace-\(slug).json")
      if let want = c["commonplace"], !want.isNull {
        let got = (try? JSONValue.parse(Data(contentsOf: cpFile)))?.masking(["at"], with: "<ts>") ?? .null
        report.check(CanonicalJSON.string(got) == CanonicalJSON.string(want), "\(label): commonplace record", expected: want,
                     actual: got)
      } else {
        report.check(!FileManager.default.fileExists(atPath: cpFile.path), "\(label): no commonplace record for a dry run")
      }
    }
    // the lineage of the widely shared text the passes recorded: one node, never pairs (graph.mjs commonplaceLineage)
    for c in cases.dropFirst() where c["kind"] == "lineage" {
      var args = QueryArgs()
      for (k, v) in c["args"]?.objectValue ?? JSONObject() { if let s = v.stringValue { args[k] = s } }
      let fixedArgs = args
      let outcome = try await h.read { conn -> LineageG3Tests.Outcome in
        LineageG3Tests.run("lineage", fixedArgs, conn, path)
      }
      LineageG3Tests.compare(report, "lineage \(CanonicalJSON.string(c["args"] ?? .null))", "lineage", c, outcome)
    }
    await h.close()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g2.boilerplate-m1r: full Cipher, as bootstrapped and after a reset; the canary holds",
        .enabled(if: ProcessInfo.processInfo.environment["SCROLLS_LINEAGE_M1R"] == "1" && PassHarness.snapshotAvailable("m1r"),
                 "runs in Tools/check.sh lineage (SCROLLS_LINEAGE_M1R=1, needs ~/Developer/scrolls-snapshots/m1r)"))
  func m1r() async throws {
    let report = LineageGolden.Report("g2.boilerplate-m1r")
    defer { report.write() }
    let cases = try LineageGolden.load("g2.boilerplate-m1r")
    let dir = try PassHarness.scratchDir("g2-boilerplate-m1r")
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = try PassHarness.cloneSnapshot("m1r", into: dir)
    let h = try PassHarness(path: path)
    let keys = ["documents", "duplicates_not_counted", "tokens", "fingerprints", "groups", "widespread", "boilerplate",
                "commonplace", "passages_flagged", "passages_would_flag", "flagged_by_rule", "documents_affected",
                "commonplace_passages", "canary_ok_passages", "params", "dry_run"]
    func pick(_ v: JSONValue?) -> JSONValue { .object(JSONObject(keys.map { ($0, v?[$0] ?? .null) })) }
    var timings: [String: Double] = [:]
    for c in cases {
      let kind = c["kind"]?.stringValue ?? ""
      if kind == "reset" {
        let reset = undelta(c["reset_deltas"]?.ints ?? [])
        let ids = try await h.read { conn in
          try conn.prepared(dynamic: "SELECT id FROM passage WHERE quality = 'boilerplate' ORDER BY id").binding([]) { Int($0.int(0)) }
        }
        report.check(ids == reset, "reset: the boilerplate passages before the reset", expected: .number(Double(reset.count)),
                     actual: .number(Double(ids.count)))
        try await h.writer.write("test reset") { tx in
          try tx.connection.exec("UPDATE passage SET quality = 'ok' WHERE quality = 'boilerplate'")
        }
        let canary = try await h.read { conn in try BoilerplateDetector.canaryCount(conn, scope: nil) }
        report.check(canary == c["canary_after_reset"]?.int, "reset: canary after the reset",
                     expected: c["canary_after_reset"] ?? .null, actual: .number(Double(canary)))
      }
      let t0 = ContinuousClock.now
      let snap = try await h.run(BoilerplateTask.type, [:])
      timings[kind] = (ContinuousClock.now - t0) / .seconds(1)
      report.check(snap.status == .succeeded, "\(kind): job status", actual: .string("\(snap.status) \(snap.error?.message ?? "")"))
      let got = pick(snap.result)
      report.check(got == c["result"], "\(kind): result", expected: c["result"] ?? .null, actual: got)
      if kind == "idempotent" {
        // the corpus-level counts equal the snapshot's own recorded run (the pass that bootstrapped it)
        let corpus = ["documents", "duplicates_not_counted", "tokens", "fingerprints", "groups", "widespread", "boilerplate",
                      "commonplace", "commonplace_passages", "canary_ok_passages", "params"]
        for k in corpus {
          report.check(snap.result?[k] == c["recorded_run"]?[k], "idempotent: \(k) = the snapshot's recorded run",
                       expected: c["recorded_run"]?[k] ?? .null, actual: snap.result?[k] ?? .null)
        }
      }
      let canary = try await h.read { conn in try BoilerplateDetector.canaryCount(conn, scope: nil) }
      report.check(canary == 0 && canary == c["canary"]?.int, "\(kind): canary (0 ok passages hold the licence sentence)",
                   expected: c["canary"] ?? .null, actual: .number(Double(canary)))
      let state = try await Self.state(h)
      report.check(state == c["state"], "\(kind): passage qualities and doc_tokens", expected: c["state"] ?? .null, actual: state)
      if kind == "reset" {
        let flagged = try await h.read { conn in
          try conn.prepared(dynamic: "SELECT id FROM passage WHERE quality = 'boilerplate' ORDER BY id").binding([]) { Int($0.int(0)) }
        }
        report.check(flagged == undelta(c["flagged_deltas"]?.ints ?? []), "reset: flagged passages",
                     expected: .number(Double(c["flagged_deltas"]?.arrayValue?.count ?? 0)), actual: .number(Double(flagged.count)))
      }
    }
    await h.close()
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      let t: JSONValue = .object(JSONObject(timings.map { ($0.key, JSONValue.number(($0.value * 10).rounded() / 10)) }))
      try? Data((CanonicalJSON.string(["family": "g2.boilerplate-m1r", "seconds": t, "machine": "mac"]) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("lineage-boilerplate-m1r-timings.json"))
    }
    #expect(report.passed, "\(report.summary)")
  }

  // ── helpers ──

  /// Inserts the golden input rows and indexes every passage's slice in passage_fts (the reference writes the folded
  /// tokens of the slice joined by spaces).
  static func load(_ input: JSONValue, into path: String) throws {
    let c = try Connection(path: path, mode: .readWrite, profile: .reference)
    defer { c.close() }
    try c.transaction(.immediate) {
      let tables = input["tables"] ?? [:]
      for t in ["corpus", "source_adapter", "collection", "import_batch", "document", "document_text", "document_field",
                "passage", "doc_tokens"] {
        try PassHarness.insert(c, table: t, rows: tables[t]?.arrayValue ?? [])
      }
      var originals: [Int64: [UInt16]] = [:]
      for t in tables["document_text"]?.arrayValue ?? [] {
        originals[Int64(t["document_id"]?.int ?? 0)] = Array((t["original"]?.stringValue ?? "").utf16)
      }
      var fields: [String: [UInt16]] = [:]
      for f in tables["document_field"]?.arrayValue ?? [] {
        fields["\(f["document_id"]?.int ?? 0)/\(f["field"]?.stringValue ?? "")"] = Array((f["value"]?.stringValue ?? "").utf16)
      }
      let fts = try c.prepared(dynamic: "INSERT INTO passage_fts (rowid, norm) VALUES (?, ?)")
      for p in tables["passage"]?.arrayValue ?? [] {
        let doc = Int64(p["document_id"]?.int ?? 0), field = p["field"]?.stringValue ?? ""
        let src = field == "body" ? originals[doc] ?? [] : fields["\(doc)/\(field)"] ?? []
        let a = p["start_off"]?.int ?? 0, b = p["end_off"]?.int ?? 0
        let slice = String(decoding: src[a..<b], as: UTF16.self)
        try fts.bind(.int(Int64(p["id"]?.int ?? 0)), .text(Tokenizer.normString(slice)))
        try fts.run()
      }
      for (k, v) in input["meta"]?.objectValue ?? JSONObject() {
        if let s = v.stringValue { try Meta.set(c, k, s) }
      }
    }
  }

  static func qualities(_ h: PassHarness, _ coll: Int64) async throws -> [Int64: String] {
    try await h.read { conn in
      var out: [Int64: String] = [:]
      for (id, q) in try conn.prepared(dynamic: """
        SELECT p.id, p.quality FROM passage p JOIN document d ON d.id = p.document_id WHERE d.collection_id = ?
        """).binding([.int(coll)], { ($0.int(0), $0.text(1)) }) { out[id] = q }
      return out
    }
  }

  /// `{quality: {q: n}, doc_tokens_sha256}` as the generator's `state()`.
  static func state(_ h: PassHarness) async throws -> JSONValue {
    try await h.read { conn -> JSONValue in
      var q = JSONObject()
      for (k, n) in try conn.prepared(dynamic: "SELECT quality, count(*) FROM passage GROUP BY quality ORDER BY quality")
        .binding([], { ($0.text(0), $0.int(1)) }) { q[k] = .number(Double(n)) }
      let lines = try conn.prepared(dynamic: """
        SELECT document_id, plang, field_class, tokens, passages FROM doc_tokens ORDER BY document_id, plang, field_class
        """).binding([]) { r in "\(r.int(0))\t\(r.text(1))\t\(r.text(2))\t\(r.int(3))\t\(r.int(4))" }
      return ["quality": .object(q), "doc_tokens_sha256": .string(IDs.sha256Hex(lines.joined(separator: "\n")))]
    }
  }
}

/// Decodes a delta list back to absolute values.
func undelta(_ d: [Int]) -> [Int] {
  var out: [Int] = []
  out.reserveCapacity(d.count)
  var acc = 0
  for x in d {
    acc += x
    out.append(acc)
  }
  return out
}
