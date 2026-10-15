// OWNER: N3
// `scrolls-cli diff-read`: IOS-SPEC §2.2 G3 (the read path). Replays a recorded G3 family (g3.read-m1r, g3.read-m5r:
// every request the reference server answered, in order, writes included) in process on a fresh `cp -c` clone of the
// same snapshot, opened as a reference-profile atlas through `InlineTextStore`, and compares each response with the
// reference's by the §2.4 rules: counts, ids, states, labels, copy and sort orders exact; non-integer numbers within
// 1e-9 · max(1, |x|); timestamps and data versions normalised as Golden/lib/normalize.mjs does. Expressions the plan
// tracks are counted by the Swift materializer (its own job), so their occurrence and run ids are the engine's own.
// The reference's materialize code hash is adopted for freshness (DV-9), so the reference's runs on the snapshot are
// reused exactly when the reference reuses them. Writes Reports/golden-<family>.json and, with --report, every case.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsQuery
import ScrollsService
import ScrollsStore

enum DiffReadCommand: CLICommand {
  static let name = "diff-read"
  static let summary = "replay G3 read requests in process on a snapshot clone and compare with the reference"
  static let usage = """
    usage: scrolls-cli diff-read [--golden <dir>] [--family g3.read-m1r] [--snapshots <dir>] [--reports <dir>]
                                 [--report <file.json>] [--only <id-prefix>] [--keep] [--verbose]
      --golden     a folder holding <family>/cases-*.jsonl (default ~/Developer/scrolls-golden/<newest>/private)
      --family     g3.read-m1r (default) or g3.read-m5r; its snapshot is the part after 'read-'
      --snapshots  default ~/Developer/scrolls-snapshots (the clone is made with cp -c under $TMPDIR, never opened in place)
      --reports    where golden-<family>.json is written
      --only       replay every case but report only the ids with this prefix
      Exit code 0 when every case matches, 1 otherwise.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["keep", "verbose"])
    let family = a.value("family") ?? "g3.read-m1r"
    guard let dash = family.range(of: "read-") else { throw UsageError("--family must be g3.read-<snapshot>") }
    let snapshot = String(family[dash.upperBound...])
    let home = FileManager.default.homeDirectoryForCurrentUser
    let golden = try a.value("golden").map { URL(fileURLWithPath: $0) } ?? newestPrivateGolden(home, family)
    let snapshots = URL(fileURLWithPath: a.value("snapshots") ?? home.appendingPathComponent("Developer/scrolls-snapshots").path)
    let cases = try loadCases(golden.appendingPathComponent(family))
    print("diff-read: \(cases.count) cases of \(family) from \(golden.path)")

    let clone = try ReadClone.make(snapshots, snapshot)
    defer { if a.flag("keep") { print("kept \(clone.root.path)") } else { clone.remove() } }
    let atlas = try await LiveAtlas.open(clone.location, conditions: Unthrottled(),
                                         launch: EngineLaunchOptions(startBootstrap: false, profile: .reference))
    // the reference's materialize code identity (DV-9), read from its newest materialize run on the snapshot
    let code = try await atlas.read { c in try ReadDiffSQL.referenceCode(c) }
    Expressions.adoptReferenceCodeHash(code)
    defer { Expressions.adoptReferenceCodeHash(nil) }
    // until TaskRegistry registers MaterializeTask (N0), the counts of this run go through a queue that does
    var privateQueue: JobQueue?
    if TaskRegistry.missing.contains("materialize") {
      let q = JobQueue(reads: atlas.reads, writer: atlas.writer, text: atlas.text, registry: [MaterializeTask.self],
                       conditions: Unthrottled(), journal: atlas.journal)
      MaterializeQueues.install(q, atlasPath: atlas.location.atlasPath)
      privateQueue = q
      print("diff-read: TaskRegistry does not register 'materialize' yet; counting through a private queue")
    }
    defer { MaterializeQueues.install(nil, atlasPath: atlas.location.atlasPath) }

    var mismatches: [String] = []
    var details: [JSONValue] = []
    var gaps: [String: Int] = [:]
    var byEndpoint: [String: (cases: Int, failed: Int)] = [:]
    var totalMs = 0.0
    for c in cases {
      let id = c["id"]?.stringValue ?? "?"
      let method = c["method"]?.stringValue ?? "GET"
      let path = c["path"]?.stringValue ?? ""
      let start = ContinuousClock.now
      let (status, body) = await replay(atlas, method: method, path: path, body: c["body"])
      if c["wait"]?.stringValue == "materialize" {
        try await waitForCounts(atlas, privateQueue, body)
      }
      let ms = ReadDiffTime.ms(ContinuousClock.now - start)
      totalMs += ms
      let actual: JSONValue = ["status": .number(Double(status)), "response": ReadNormalize.value(body)]
      let expected: JSONValue = ["status": c["status"] ?? .null, "response": c["response"] ?? .null]
      let d = ReadCompare.diff(expected, actual)
      let endpoint = "\(method) \(ReadDiffRoute.endpoint(path))"
      var e = byEndpoint[endpoint] ?? (0, 0)
      e.cases += 1
      if let d {
        e.failed += 1
        mismatches.append("\(id) \(endpoint): \(d.text)")
        if let gap = d.missingKeys { for k in gap { gaps[k, default: 0] += 1 } }
      }
      byEndpoint[endpoint] = e
      if let only = a.value("only"), !id.hasPrefix(only) { continue }
      details.append(["id": .string(id), "step": c["step"] ?? .null, "path": .string(path), "status": .number(Double(status)),
                      "ms": .number((ms * 10).rounded() / 10), "match": .bool(d == nil), "diff": d.map { .string($0.text) } ?? .null])
      if d != nil || a.flag("verbose") {
        print("\(d == nil ? "ok  " : "DIFF") \(id) \(method) \(path.prefix(110)) \(status) \(JSNumber.format((ms * 10).rounded() / 10)) ms\(d.map { " — \($0.text)" } ?? "")")
      }
    }
    await atlas.close()
    let passed = mismatches.isEmpty && !cases.isEmpty
    print("\(family): \(cases.count) cases, \(cases.count - mismatches.count) exact, \(mismatches.count) divergent; replay \(JSNumber.format(totalMs.rounded())) ms")
    for (k, v) in byEndpoint.sorted(by: { $0.key < $1.key }) { print("  \(k): \(v.cases) cases, \(v.failed) divergent") }
    if !gaps.isEmpty {
      print("  keys the Swift response lacks (contract gaps or engine omissions): "
        + gaps.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))
    }
    if let dir = a.value("reports") {
      let report: JSONValue = [
        "family": .string(family), "cases": .number(Double(cases.count)), "mismatches": .number(Double(mismatches.count)),
        "diffs": .array(mismatches.prefix(40).map(JSONValue.string)), "passed": .bool(passed),
        "by_endpoint": .object(JSONObject(byEndpoint.map { ($0.key, ["cases": .number(Double($0.value.cases)), "divergent": .number(Double($0.value.failed))]) })),
        "missing_keys": .object(JSONObject(gaps.map { ($0.key, JSONValue.number(Double($0.value))) })),
        "replay_ms": .number(totalMs.rounded()),
      ]
      try Data((CanonicalJSON.string(report) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
    }
    if let path = a.value("report") {
      try Data((CanonicalJSON.string(.array(details)) + "\n").utf8).write(to: URL(fileURLWithPath: path))
    }
    return passed ? 0 : 1
  }

  /// After a recorded write that queued a count (track, variants), waits for the engine's count to finish, as the
  /// generator waited for the reference's job.
  static func waitForCounts(_ atlas: LiveAtlas, _ queue: JobQueue?, _ body: JSONValue) async throws {
    guard let job = body["state"]?["job"]?.safeInteger else { return }
    let q = queue ?? atlas.jobQueue
    let snap = await q.wait(for: JobID(rawValue: Int64(job)), timeout: .seconds(1800))
    if let snap, snap.status != .succeeded {
      print("diff-read: materialize job \(job) ended \(snap.status.rawValue): \(snap.error?.message ?? "")")
    }
  }

  /// One recorded request through the engine: (status, body) as the reference's route answers it.
  static func replay(_ atlas: LiveAtlas, method: String, path: String, body: JSONValue?) async -> (Int, JSONValue) {
    do {
      return (200, try await ReadDiffRoute.call(atlas, method: method, path: path, body: body))
    } catch let e as ScrollsError {
      return (e.status ?? 500, ["error": ["code": .string(e.code.rawValue), "message": .string(e.message),
                                          "hint": e.hint.map(JSONValue.string) ?? .null, "detail": e.detail]])
    } catch {
      return (500, ["error": ["code": "E_INTERNAL", "message": .string(String(describing: error)), "hint": .null, "detail": .null]])
    }
  }

  static func newestPrivateGolden(_ home: URL, _ family: String) throws -> URL {
    let root = home.appendingPathComponent("Developer/scrolls-golden")
    let fm = FileManager.default
    let dirs = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
    let candidates = dirs.map { root.appendingPathComponent($0).appendingPathComponent("private") }
      .filter { fm.fileExists(atPath: $0.appendingPathComponent(family).path) }
      .sorted { a, b in
        let ma = (try? fm.attributesOfItem(atPath: a.appendingPathComponent(family).path)[.modificationDate] as? Date) ?? .distantPast
        let mb = (try? fm.attributesOfItem(atPath: b.appendingPathComponent(family).path)[.modificationDate] as? Date) ?? .distantPast
        return ma > mb
      }
    guard let first = candidates.first else {
      throw UsageError("no \(family) under \(root.path)/*/private (run Tools/golden.sh \(family), or pass --golden)")
    }
    return first
  }

  static func loadCases(_ dir: URL) throws -> [JSONValue] {
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".jsonl") }.sorted()
    var cases: [JSONValue] = []
    for f in files {
      let data = try Data(contentsOf: dir.appendingPathComponent(f))
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty { cases.append(try JSONValue.parse(Data(line))) }
    }
    return cases
  }
}

/// The statement the diff needs on the clone.
enum ReadDiffSQL: SQLCatalog {
  static let referenceCode = SQL("cli.diff-read.reference-code", """
    SELECT json_extract(params_json, '$.code') FROM analysis_run WHERE stage = 'materialize' AND status = 'succeeded'
      ORDER BY id DESC LIMIT 1
    """, scan: .scanOK(reason: "analysis_run is small (runs, not rows)"))
  static let all: [SQL] = [referenceCode]

  static func referenceCode(_ c: Connection) throws -> String? {
    try c.prepared(referenceCode).first { $0.isNull(0) ? nil : $0.text(0) } ?? nil
  }
}

/// The reference's routes of the read area, mapped onto AtlasService calls; answers the body as JSON (exports and
/// snapshots as the generator records non-JSON bodies).
enum ReadDiffRoute {
  /// The route pattern of a path (`/api/passages/:id`), for the per-endpoint table.
  static func endpoint(_ path: String) -> String {
    let p = String(path.split(separator: "?", maxSplits: 1).first ?? "")
    let parts = p.split(separator: "/").map(String.init)
    return "/" + parts.map { $0.allSatisfy(\.isNumber) ? ":id" : $0 }.joined(separator: "/")
  }

  static func query(_ path: String) -> [(String, String)] {
    guard let q = path.split(separator: "?", maxSplits: 1).dropFirst().first else { return [] }
    return q.split(separator: "&").map { kv in
      let pair = kv.split(separator: "=", maxSplits: 1).map(String.init)
      func dec(_ s: String) -> String { (s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding) ?? s }
      return (dec(pair[0]), pair.count > 1 ? dec(pair[1]) : "")
    }
  }

  /// A typed request from the query string: integer parameters become numbers, the flags booleans.
  static func request<T: Decodable>(_ type: T.Type, _ params: [(String, String)], ints: Set<String> = [], bools: Set<String> = [])
    throws -> T
  {
    var o = JSONObject()
    for (k, v) in params {
      if ints.contains(k) {
        guard let n = Int(v) else {
          throw ScrollsError.badRequest(.validation, "\(k) must be an integer (got '\(v)').", detail: .object(["field": .string(k)]))
        }
        o[k] = .number(Double(n))
      } else if bools.contains(k) {
        o[k] = .bool(v == "1" || v == "true")
      } else {
        o[k] = .string(v)
      }
    }
    return try ScrollsJSON.decode(type, from: .object(o))
  }

  static func id(_ s: Substring) throws -> Int64 {
    guard let n = Int64(s), n > 0 else { throw ScrollsError(code: .badID, message: "'\(s)' is not an id.", status: 400) }
    return n
  }

  static func call(_ atlas: LiveAtlas, method: String, path: String, body: JSONValue?) async throws -> JSONValue {
    let route = String(path.split(separator: "?", maxSplits: 1).first ?? "")
    let parts = route.split(separator: "/")
    let q = query(path)
    func param(_ k: String) -> String? { q.last { $0.0 == k }?.1 }
    switch (method, parts.count >= 2 ? Array(parts.dropFirst()) : []) {
    case ("GET", ["search"]):
      return try ScrollsJSON.value(try await atlas.search(try request(SearchRequest.self, q, ints: ["limit"])))
    case ("POST", ["expressions"]):
      return try ScrollsJSON.value(try await atlas.trackExpression(try ScrollsJSON.decode(TrackExpressionRequest.self, from: body ?? .object([:]))))
    case ("GET", let p) where p.count == 2 && p[0] == "expressions":
      return try ScrollsJSON.value(try await atlas.expression(ExpressionID(rawValue: try id(p[1])), corpus: param("corpus")))
    case ("PATCH", let p) where p.count == 3 && p[0] == "expressions" && p[2] == "variants":
      return try ScrollsJSON.value(try await atlas.setVariants(ExpressionID(rawValue: try id(p[1])),
                                                               try ScrollsJSON.decode(VariantsPatchRequest.self, from: body ?? .object([:]))))
    case ("POST", ["timeline", "query"]):
      return try ScrollsJSON.value(try await atlas.timelineQuery(try ScrollsJSON.decode(TimelineQueryRequest.self, from: body ?? .object([:]))))
    case ("GET", ["timeline", "tiles"]):
      return try ScrollsJSON.value(try await atlas.tiles(TilesRequest(q: param("q") ?? "", tier: param("tier") ?? "L2", tiles: param("tiles") ?? "")))
    case ("GET", ["timeline", "marks"]):
      return try ScrollsJSON.value(try await atlas.marks(try request(MarksRequest.self, q, ints: ["from", "to", "limit"])))
    case ("GET", ["timeline", "shelf"]):
      return try ScrollsJSON.value(try await atlas.shelf(try request(ShelfRequest.self, q, ints: ["limit"])))
    case ("GET", ["timeline", "bin"]):
      return try ScrollsJSON.value(try await atlas.bin(try request(BinRequest.self, q, ints: ["bin", "limit"])))
    case ("GET", ["kwic"]):
      return try ScrollsJSON.value(try await atlas.kwic(try request(KwicRequest.self, q, ints: ["expr", "from", "to", "limit", "import_batch"])))
    case ("GET", let p) where p.count == 2 && p[0] == "passages":
      let r = try request(PassageRequest.self, q, ints: ["expr", "occ"], bools: ["context"])
      return try ScrollsJSON.value(try await atlas.passage(PassageID(rawValue: try id(p[1])), r))
    case ("GET", let p) where p.count == 2 && p[0] == "occurrences":
      return try ScrollsJSON.value(try await atlas.occurrence(OccurrenceID(rawValue: try id(p[1]))))
    case ("GET", let p) where p.count == 2 && p[0] == "documents":
      return try ScrollsJSON.value(try await atlas.document(DocumentID(rawValue: try id(p[1]))))
    case ("GET", let p) where p.count == 3 && p[0] == "documents" && p[2] == "text":
      func int(_ k: String) throws -> Int? {
        guard let v = param(k), !v.isEmpty else { return nil }
        guard let n = Int(v) else { throw ScrollsError.badRequest(.validation, "\(k) must be an integer (got '\(v)').") }
        return n
      }
      return try ScrollsJSON.value(try await atlas.documentText(DocumentID(rawValue: try id(p[1])), from: try int("from"), to: try int("to")))
    case ("GET", ["export"]):
      let r = try await atlas.export(try request(ExportRequest.self, q))
      return exportBody(r)
    default:
      throw ScrollsError(code: .notFound, message: "diff-read has no route for \(method) \(route).", status: 404)
    }
  }

  /// An export as the generator records it: JSON parsed; JSONL lines parsed; CSV with timestamps masked.
  static func exportBody(_ r: ExportResponse) -> JSONValue {
    let ct = r.contentType.split(separator: ";").first.map(String.init) ?? r.contentType
    let text = String(decoding: r.data, as: UTF8.self)
    if ct.contains("json") && !ct.contains("jsonl") && !ct.contains("ndjson") {
      return (try? JSONValue.parse(text)) ?? .string(text)
    }
    var o: JSONObject = ["content_type": .string(ct), "rows": r.rows.map { .string(String($0)) } ?? .null,
                         "disposition": r.fileName.map { .string("attachment; filename=\"\($0)\"") } ?? .null]
    if ct.contains("jsonl") || ct.contains("ndjson") {
      o["jsonl"] = .array(text.split(separator: "\n", omittingEmptySubsequences: true).map { l in
        (try? JSONValue.parse(String(l))) ?? .string(String(l))
      })
    } else if ct.contains("csv") {
      o["csv"] = .string(ReadNormalize.maskCSV(text))
    } else {
      o["text"] = .string(text)
    }
    return .object(o)
  }
}

/// A `cp -c` clone of a snapshot laid out as an atlas root (the snapshot is never opened in place).
struct ReadClone {
  let root: URL
  let location: AtlasLocation

  static func make(_ snapshots: URL, _ name: String) throws -> ReadClone {
    let src = snapshots.appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db").path) else {
      throw UsageError("snapshot \(name) not found at \(src.path)")
    }
    let base = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
    let root = base.appendingPathComponent("scrolls-diff-read-\(name)-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.removeItem(at: root)
    let atlas = root.appendingPathComponent("Atlas")
    try FileManager.default.createDirectory(at: atlas, withIntermediateDirectories: true)
    try cp(["-c", src.appendingPathComponent("scrolls.db").path, atlas.appendingPathComponent("atlas.sqlite").path])
    for side in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db\(side)").path) {
      try cp(["-c", src.appendingPathComponent("scrolls.db\(side)").path, atlas.appendingPathComponent("atlas.sqlite\(side)").path])
    }
    return ReadClone(root: root, location: try AtlasLocation.at(root: root))
  }

  static func cp(_ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = args
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw UsageError("cp \(args.joined(separator: " ")) failed") }
  }

  func remove() { try? FileManager.default.removeItem(at: root) }
}

/// Golden/lib/normalize.mjs on the Swift side: timestamps → '<ts>', data versions → '<dv>', -0 → 0.
enum ReadNormalize {
  static let timestamp = try! NSRegularExpression(
    pattern: #"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$"#)
  static let tsInText = try! NSRegularExpression(pattern: #"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z"#)
  static let dvInText = try! NSRegularExpression(pattern: #""data_version":\d+"#)

  static func value(_ v: JSONValue) -> JSONValue {
    switch v {
    case .string(let s):
      return timestamp.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil ? "<ts>" : v
    case .number(let x): return x == 0 ? .number(0) : v
    case .array(let a): return .array(a.map(value))
    case .object(let o):
      var out = JSONObject()
      for (k, x) in o { out[k] = k == "data_version" || k == "dataVersion" ? "<dv>" : value(x) }
      return .object(out)
    default: return v
    }
  }

  static func maskCSV(_ s: String) -> String {
    let r1 = tsInText.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "<ts>")
    return dvInText.stringByReplacingMatches(in: r1, range: NSRange(r1.startIndex..., in: r1), withTemplate: "\"data_version\":\"<dv>\"")
  }
}

/// The §2.4 comparison: strings and integers exact (by UTF-16 code units), other numbers within 1e-9 · max(1, |x|),
/// redacted text by its sha256 and length.
enum ReadCompare {
  struct Diff {
    var text: String
    /// When the only difference is that the Swift response lacks keys: their paths.
    var missingKeys: [String]?
  }

  static func diff(_ expected: JSONValue, _ actual: JSONValue, path: String = "$") -> Diff? {
    switch (expected, actual) {
    case (.number(let x), .number(let y)):
      if x == y { return nil }
      if x.rounded() == x && y.rounded() == y && abs(x) < 9e15 { return Diff(text: "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))") }
      return abs(x - y) <= 1e-9 * max(1, abs(x)) ? nil : Diff(text: "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))")
    case (.object(let o), .string(let s)) where o["$redacted"] != nil:
      return TextDigest.sha256Hex(utf8: s) == o["$redacted"]?.stringValue && s.utf16.count == o["len"]?.safeInteger
        ? nil : Diff(text: "\(path): redacted text differs")
    case (.string(let a), .string(let b)):
      return a.utf16.elementsEqual(b.utf16) ? nil : Diff(text: "\(path): \"\(a.prefix(160))\" ≠ \"\(b.prefix(160))\"")
    case (.array(let a), .array(let b)):
      if a.count != b.count { return Diff(text: "\(path): \(a.count) items ≠ \(b.count) items") }
      for i in a.indices { if let d = diff(a[i], b[i], path: "\(path)[\(i)]") { return d } }
      return nil
    case (.object(let a), .object(let b)):
      let ka = Set(a.keys), kb = Set(b.keys)
      if ka != kb {
        let missing = ka.subtracting(kb).sorted(), extra = kb.subtracting(ka).sorted()
        // keys absent on the Swift side whose reference value is null are reported but kept apart
        let gap = missing.map { "\(generic(path)).\($0)" }
        var rest: Diff?
        for k in ka.intersection(kb).sorted() { if let d = diff(a[k]!, b[k]!, path: "\(path).\(k)") { rest = d; break } }
        return Diff(text: "\(path): keys missing \(missing), extra \(extra)\(rest.map { "; then \($0.text)" } ?? "")",
                    missingKeys: extra.isEmpty && rest == nil ? gap : nil)
      }
      for k in a.keys.sorted() { if let d = diff(a[k]!, b[k]!, path: "\(path).\(k)") { return d } }
      return nil
    default:
      return expected == actual ? nil
        : Diff(text: "\(path): \(CanonicalJSON.string(expected).prefix(200)) ≠ \(CanonicalJSON.string(actual).prefix(200))")
    }
  }

  /// A path with array indices folded (`$.lanes[3].x` → `$.lanes[].x`), for the gap table.
  static func generic(_ path: String) -> String {
    path.replacingOccurrences(of: #"\[\d+\]"#, with: "[]", options: .regularExpression)
  }
}

/// Milliseconds of a duration (kept here so this command depends on no other command's helpers).
enum ReadDiffTime {
  static func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }
}
