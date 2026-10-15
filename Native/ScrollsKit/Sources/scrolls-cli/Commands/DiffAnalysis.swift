// OWNER: N4
// `scrolls-cli diff-analysis`: IOS-SPEC §2.2 G3 (Compare and collocations). Replays the golden requests of
// g3.compare and g3.collocations, in order and in their sessions, on fresh `cp -c` clones of the snapshots they were
// generated on (opened as reference-profile atlases through `InlineTextStore`, with the snapshot's token streams), in
// the reference's environment (no NL adapter, no Ngram store), and compares the engine's payload with the golden by the
// §2.4 rules: counts, ids, states, labels, copy and orders exact; floats within 1e-9 · max(1, |x|). Each payload is also
// decoded into the contract type and re-encoded, and the keys the contract types do not carry are listed (they are
// requests to N0, never mismatches). Writes Reports/golden-<family>.json and a detailed report.

import Foundation
import ScrollsAnalysis
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore

enum DiffAnalysisCommand: CLICommand {
  static let name = "diff-analysis"
  static let summary = "replay G3 Compare and collocations requests on snapshot clones and compare with the goldens"
  static let usage = """
    usage: scrolls-cli diff-analysis --golden <Golden dir> [--families g3.compare,g3.collocations]
                                     [--snapshots <dir>] [--reports <dir>] [--report <file.json>] [--keep]
      --golden     the committed golden folder (Tests/DifferentialTests/Golden) or ~/Developer/scrolls-golden/<ref>
      --snapshots  default ~/Developer/scrolls-snapshots (clones are made with cp -c under $TMPDIR, never opened in place)
      --reports    where golden-<family>.json is written (default: none)
      --keep       keep the clones (their paths are printed)
      Exit code 0 when every case matches, 1 otherwise.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["keep"])
    let golden = URL(fileURLWithPath: try a.required("golden"))
    let families = (a.value("families") ?? "g3.compare,g3.collocations").split(separator: ",").map(String.init)
    let snapshots = URL(fileURLWithPath: a.value("snapshots")
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-snapshots").path)
    var details: [JSONValue] = []
    var failed = false
    for family in families {
      let cases = try loadFamily(golden, family)
      var mismatches: [String] = []
      var contractGaps: [String: Int] = [:]
      var bySnapshot: [String: [JSONValue]] = [:]
      var order: [String] = []
      for c in cases {
        let s = c["snapshot"]?.stringValue ?? "m1r"
        if bySnapshot[s] == nil { order.append(s) }
        bySnapshot[s, default: []].append(c)
      }
      for snapshot in order {
        let clone = try Clone.make(snapshots, snapshot)
        defer { if !a.flag("keep") { clone.remove() } else { print("kept \(clone.root.path)") } }
        let atlas = try await LiveAtlas.open(clone.location, conditions: Unthrottled(),
                                             launch: EngineLaunchOptions(startBootstrap: false, profile: .reference))
        let env = AnalysisEnvironment.reference(tokenStreams: clone.location.derivedDir.appendingPathComponent("tokens"))
        for c in bySnapshot[snapshot]! {
          let id = c["id"]?.stringValue ?? "?"
          let start = ContinuousClock.now
          let (status, body) = await replay(atlas, family: family, c, env: env)
          let ms = (ContinuousClock.now - start).milliseconds
          let actual: JSONValue = ["status": .number(Double(status)), "body": Normalize.value(body)]
          let expected: JSONValue = ["status": c["status"] ?? .null, "body": c["body"] ?? .null]
          let d = Compare.diff(expected, actual)
          if let d { mismatches.append("\(id): \(d)") }
          var lost: [String] = []
          if status == 200 { lost = contractLoss(family, body) }
          for k in lost { contractGaps[k, default: 0] += 1 }
          details.append(["family": .string(family), "id": .string(id), "status": .number(Double(status)), "ms": .number(ms),
                          "match": .bool(d == nil), "diff": d.map(JSONValue.string) ?? .null, "contract_lost": .array(lost.map(JSONValue.string))])
          print("\(d == nil ? "ok  " : "DIFF") \(family) \(id) \(status) \(JSNumber.format(ms)) ms\(d.map { " — \($0)" } ?? "")")
        }
        await atlas.close()
      }
      let passed = mismatches.isEmpty && !cases.isEmpty
      failed = failed || !passed
      print("\(family): \(cases.count) cases, \(mismatches.count) mismatches")
      if !contractGaps.isEmpty {
        print("  keys the contract types drop: \(contractGaps.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))")
      }
      if let dir = a.value("reports") {
        let report: JSONValue = [
          "family": .string(family), "cases": .number(Double(cases.count)), "mismatches": .number(Double(mismatches.count)),
          "diffs": .array(mismatches.prefix(20).map(JSONValue.string)), "passed": .bool(passed),
          "contract_lost": .object(JSONObject(contractGaps.map { ($0.key, JSONValue.number(Double($0.value))) })),
        ]
        try Data((CanonicalJSON.string(report) + "\n").utf8)
          .write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
      }
    }
    if let path = a.value("report") {
      try Data((CanonicalJSON.string(.array(details)) + "\n").utf8).write(to: URL(fileURLWithPath: path))
    }
    return failed ? 1 : 0
  }

  /// One golden request through the engine: (status, body) as the reference's route answers it.
  static func replay(_ atlas: LiveAtlas, family: String, _ c: JSONValue, env: AnalysisEnvironment) async -> (Int, JSONValue) {
    do {
      if family == "g3.compare" {
        let body = try await atlas.comparePayload(c["request"] ?? .null, session: c["session"]?.stringValue, environment: env,
                                                  deadline: .seconds(3600))
        return (200, body)
      }
      let q = c["request"]?.objectValue ?? [:]
      var toggles = JSONObject()
      for (k, v) in q["toggles"]?.objectValue ?? [:] { toggles[k] = v }
      let args = CollocationsArgs(
        expr: q["expr"]?.stringValue ?? "", slice: q["slice"]?.stringValue ?? "", f: q["f"]?.stringValue ?? "",
        toggles: .object(toggles), stop: q["stop"] ?? .null,
        corpus: q["corpus"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }, seed: q["seed"] ?? .null, lane: q["lane"]?.stringValue,
        limit: try CollocationsArgs.limit(q["limit"]?.stringValue))
      return (200, try await atlas.collocationsPayload(args, environment: env, deadline: .seconds(3600)))
    } catch let e as ScrollsError {
      return (e.status ?? 500, ["error": ["code": .string(e.code.rawValue), "message": .string(e.message),
                                          "hint": e.hint.map(JSONValue.string) ?? .null, "detail": e.detail]])
    } catch {
      return (500, ["error": ["code": "E_INTERNAL", "message": .string(String(describing: error)), "hint": .null, "detail": .null]])
    }
  }

  /// The payload's keys that the contract type does not carry (decode → encode → compare key paths).
  static func contractLoss(_ family: String, _ body: JSONValue) -> [String] {
    do {
      let typed: JSONValue
      if family == "g3.compare" {
        typed = try ScrollsJSON.value(try ScrollsJSON.decode(CompareResponse.self, from: body))
      } else {
        typed = try ScrollsJSON.value(try ScrollsJSON.decode(CollocationsResponse.self, from: body))
      }
      var lost: [String] = []
      keyLoss(body, typed, "$", &lost)
      return Array(Set(lost)).sorted()
    } catch {
      return ["decode failed: \(error)"]
    }
  }

  static func keyLoss(_ full: JSONValue, _ typed: JSONValue, _ path: String, _ out: inout [String]) {
    switch (full, typed) {
    case (.object(let a), .object(let b)):
      for k in a.keys {
        if let v = b[k] { keyLoss(a[k]!, v, "\(path).\(k)", &out) } else { out.append("\(path).\(k)") }
      }
    case (.array(let a), .array(let b)):
      for i in 0..<min(a.count, b.count) { keyLoss(a[i], b[i], "\(path)[]", &out) }
    default: break
    }
  }

  static func loadFamily(_ golden: URL, _ family: String) throws -> [JSONValue] {
    let dir = golden.appendingPathComponent(family)
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".jsonl") }.sorted()
    var cases: [JSONValue] = []
    for f in files {
      let data = try Data(contentsOf: dir.appendingPathComponent(f))
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty { cases.append(try JSONValue.parse(Data(line))) }
    }
    return cases
  }
}

/// A `cp -c` clone of a snapshot laid out as an atlas root.
struct Clone {
  let root: URL
  let location: AtlasLocation

  static func make(_ snapshots: URL, _ name: String) throws -> Clone {
    let src = snapshots.appendingPathComponent(name)
    let base = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
    let root = base.appendingPathComponent("scrolls-diff-analysis-\(name)-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.removeItem(at: root)
    let atlas = root.appendingPathComponent("Atlas")
    try FileManager.default.createDirectory(at: atlas.appendingPathComponent("derived"), withIntermediateDirectories: true)
    try cp(["-c", src.appendingPathComponent("scrolls.db").path, atlas.appendingPathComponent("atlas.sqlite").path])
    for side in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db\(side)").path) {
      try cp(["-c", src.appendingPathComponent("scrolls.db\(side)").path, atlas.appendingPathComponent("atlas.sqlite\(side)").path])
    }
    let tokens = src.appendingPathComponent("derived/tokens")
    if FileManager.default.fileExists(atPath: tokens.path) {
      try cp(["-c", "-R", tokens.path, atlas.appendingPathComponent("derived/tokens").path])
    }
    return Clone(root: root, location: try AtlasLocation.at(root: root))
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

/// The golden normalisation of Golden/lib/normalize.mjs: timestamps → '<ts>', data versions → '<dv>', -0 → 0.
enum Normalize {
  static let timestamp = try! NSRegularExpression(
    pattern: #"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$"#)

  static func value(_ v: JSONValue) -> JSONValue {
    switch v {
    case .string(let s):
      let r = NSRange(s.startIndex..., in: s)
      return timestamp.firstMatch(in: s, range: r) != nil ? "<ts>" : v
    case .number(let x): return x == 0 ? .number(0) : v
    case .array(let a): return .array(a.map(value))
    case .object(let o):
      var out = JSONObject()
      for (k, x) in o { out[k] = k == "data_version" || k == "dataVersion" ? "<dv>" : value(x) }
      return .object(out)
    default: return v
    }
  }
}

/// The §2.4 comparison of two JSON values (exact strings and integers; floats within 1e-9 · max(1, |x|); redacted text
/// by its sha256 and length).
enum Compare {
  static func sha256(_ s: String) -> String { TextDigest.sha256Hex(utf8: s) }

  static func diff(_ expected: JSONValue, _ actual: JSONValue, path: String = "$") -> String? {
    switch (expected, actual) {
    case (.number(let x), .number(let y)):
      if x == y { return nil }
      if x.rounded() == x && y.rounded() == y && abs(x) < 9e15 { return "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))" }
      return abs(x - y) <= 1e-9 * max(1, abs(x)) ? nil : "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))"
    case (.object(let o), .string(let s)) where o["$redacted"] != nil:
      return sha256(s) == o["$redacted"]?.stringValue && s.utf16.count == o["len"]?.safeInteger ? nil : "\(path): redacted text differs"
    case (.string(let a), .string(let b)):
      return a.utf16.elementsEqual(b.utf16) ? nil : "\(path): \"\(a.prefix(160))\" ≠ \"\(b.prefix(160))\""
    case (.array(let a), .array(let b)):
      if a.count != b.count { return "\(path): \(a.count) items ≠ \(b.count) items" }
      for i in a.indices { if let d = diff(a[i], b[i], path: "\(path)[\(i)]") { return d } }
      return nil
    case (.object(let a), .object(let b)):
      let ka = Set(a.keys), kb = Set(b.keys)
      if ka != kb { return "\(path): keys missing \(ka.subtracting(kb).sorted()), extra \(kb.subtracting(ka).sorted())" }
      for k in a.keys.sorted() { if let d = diff(a[k]!, b[k]!, path: "\(path).\(k)") { return d } }
      return nil
    default:
      return expected == actual ? nil : "\(path): \(CanonicalJSON.string(expected).prefix(200)) ≠ \(CanonicalJSON.string(actual).prefix(200))"
    }
  }
}

extension Duration {
  var milliseconds: Double { Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15 }
}
