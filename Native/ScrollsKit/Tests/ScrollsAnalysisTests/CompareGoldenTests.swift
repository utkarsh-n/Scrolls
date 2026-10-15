// OWNER: N4
// G3 Compare and collocations in the unit tests (IOS-SPEC §2.2, §2.4): the golden requests of g3.compare and
// g3.collocations replayed through the engine's own Compare (CompareEngine.payload) on a `cp -c` clone of the m1r
// snapshot they were generated on, opened read-only with `InlineTextStore`, in the reference's environment (no NL
// adapter, no Ngram store). The multiplicity log of the reference's route (compare_log: k counts the distinct
// comparisons of these expressions in this session) is kept in memory here; `scrolls-cli diff-analysis` (the
// `analysis` stage) replays the same cases through LiveAtlas, with the log in the atlas, on m1r and m5r.
// Counts, ids, states, labels, copy and orders exact; floats within 1e-9 · max(1, |x|). Skips, visibly, when the
// snapshot is not on this Mac. m5r runs here too when SCROLLS_G3_M5R=1.

import Foundation
@testable import ScrollsAnalysis
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Testing

/// A read-only clone of a reference snapshot.
final class SnapshotClone {
  let dir: URL
  let db: URL
  let tokens: URL?

  static var snapshotsRoot: URL {
    if let s = ProcessInfo.processInfo.environment["SCROLLS_SNAPSHOTS"] { return URL(fileURLWithPath: s) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-snapshots")
  }

  static func available(_ name: String) -> Bool {
    FileManager.default.fileExists(atPath: snapshotsRoot.appendingPathComponent("\(name)/SNAPSHOT.json").path)
  }

  /// `cp -c` (APFS clone) of scrolls.db and derived/tokens into a fresh temporary folder; the snapshot is never opened.
  init(_ name: String) throws {
    let src = Self.snapshotsRoot.appendingPathComponent(name)
    let base = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
    dir = base.appendingPathComponent("scrolls-n4-g3-\(name)-\(ProcessInfo.processInfo.processIdentifier)-\(UInt32.random(in: 0...UInt32.max))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    db = dir.appendingPathComponent("scrolls.db")
    try Self.cp(["-c", src.appendingPathComponent("scrolls.db").path, db.path])
    for side in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: src.appendingPathComponent("scrolls.db\(side)").path) {
      try Self.cp(["-c", src.appendingPathComponent("scrolls.db\(side)").path, db.path + side])
    }
    let t = src.appendingPathComponent("derived/tokens")
    if FileManager.default.fileExists(atPath: t.path) {
      let dst = dir.appendingPathComponent("derived/tokens")
      try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Self.cp(["-c", "-R", t.path, dst.path])
      tokens = dst
    } else {
      tokens = nil
    }
  }

  static func cp(_ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = args
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw AnalysisGolden.Missing(description: "cp \(args.joined(separator: " ")) failed") }
  }

  /// Opened immutable: the clone is never written (compare_log is kept in memory), and a read-only WAL database needs no -shm.
  func open() throws -> Connection { try Connection(path: db.path, mode: .readOnlyImmutable, profile: .reference, mmapBytes: 256 << 20) }

  deinit { try? FileManager.default.removeItem(at: dir) }
}

/// The golden normalisation (Golden/lib/normalize.mjs): timestamps → '<ts>', data versions → '<dv>', -0 → 0.
enum GoldenNormalize {
  static let timestamp = try! NSRegularExpression(
    pattern: #"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$"#)

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

  /// The route's error body (`toErrorBody`).
  static func error(_ e: ScrollsError) -> (Int, JSONValue) {
    (e.status ?? 500, ["error": ["code": .string(e.code.rawValue), "message": .string(e.message), "hint": e.hint.map(JSONValue.string) ?? .null,
                                 "detail": e.detail]])
  }
}

@Suite("G3 Compare and collocations (m1r)", .serialized)
struct CompareGoldenTests {
  static var snapshots: [String] {
    var s = ["m1r"]
    if ProcessInfo.processInfo.environment["SCROLLS_G3_M5R"] == "1" { s.append("m5r") }
    return s
  }

  /// One Compare request through the engine with the route's multiplicity bookkeeping.
  static func compare(_ c: Connection, _ body: JSONValue, session: String, log: inout [String: [String: Int]],
                      env: AnalysisEnvironment) -> (Int, JSONValue) {
    do {
      let req = try SliceRequests.normalizeCompare(body)
      let key = "\(session)|\(Multiplicity.expressionKey(req.expr))"
      let hash = Multiplicity.comparisonHash(req)
      let prior = log[key] ?? [:]
      let isNew = prior[hash] == nil
      let notable = prior.filter { $0.key != hash && $0.value > 0 }.count
      let payload = try CompareEngine.payload(c, text: InlineTextStore(), request: req,
                                              multiplicity: .init(k: prior.count + (isNew ? 1 : 0), notableSoFar: notable), env: env)
      if isNew {
        log[key, default: [:]][hash] = payload["measures"]?.arrayValue?.filter { $0["verdict"] == "notable" }.count ?? 0
      }
      return (200, payload)
    } catch let e as ScrollsError {
      return GoldenNormalize.error(e)
    } catch {
      return (500, ["error": ["code": "E_INTERNAL", "message": .string(String(describing: error)), "hint": .null, "detail": .null]])
    }
  }

  static func collocations(_ c: Connection, _ q: JSONObject, env: AnalysisEnvironment) -> (Int, JSONValue) {
    do {
      var toggles = JSONObject()
      for (k, v) in q["toggles"]?.objectValue ?? [:] { toggles[k] = v }
      let args = CollocationsArgs(
        expr: q["expr"]?.stringValue ?? "", slice: q["slice"]?.stringValue ?? "", f: q["f"]?.stringValue ?? "",
        toggles: .object(toggles), stop: q["stop"] ?? .null, corpus: q["corpus"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
        seed: q["seed"] ?? .null, lane: q["lane"]?.stringValue, limit: try CollocationsArgs.limit(q["limit"]?.stringValue))
      return (200, try Collocations.query(c, text: InlineTextStore(), args: args, env: env))
    } catch let e as ScrollsError {
      return GoldenNormalize.error(e)
    } catch {
      return (500, ["error": ["code": "E_INTERNAL", "message": .string(String(describing: error)), "hint": .null, "detail": .null]])
    }
  }

  static func replay(_ family: String) throws -> (cases: Int, mismatches: [String], skipped: [String]) {
    let all = try AnalysisGolden.load(family)
    var mismatches: [String] = []
    var skipped: [String] = []
    var ran = 0
    for snapshot in ["m1r", "m5r"] {
      let cases = all.filter { ($0["snapshot"]?.stringValue ?? "m1r") == snapshot }
      if cases.isEmpty { continue }
      guard snapshots.contains(snapshot), SnapshotClone.available(snapshot) else {
        skipped.append("\(snapshot): \(cases.count) cases (\(snapshots.contains(snapshot) ? "snapshot absent" : "SCROLLS_G3_M5R≠1"))")
        continue
      }
      let clone = try SnapshotClone(snapshot)
      let c = try clone.open()
      let env = AnalysisEnvironment.reference(tokenStreams: clone.tokens)
      var log: [String: [String: Int]] = [:]
      for k in cases {
        let id = k["id"]?.stringValue ?? "?"
        let (status, body) = family == "g3.compare"
          ? compare(c, k["request"] ?? .null, session: k["session"]?.stringValue ?? "no-session", log: &log, env: env)
          : collocations(c, k["request"]?.objectValue ?? [:], env: env)
        ran += 1
        let expected: JSONValue = ["status": k["status"] ?? .null, "body": k["body"] ?? .null]
        let actual: JSONValue = ["status": .number(Double(status)), "body": GoldenNormalize.value(body)]
        if let d = AnalysisGolden.diff(expected, actual) { mismatches.append("\(id): \(d)") }
        // §13 rule 7 on the engine's own payload, whatever the golden says
        for v in GatedScan.violations(body) { mismatches.append("\(id): numeral in a gated object at \(v)") }
      }
    }
    return (ran, mismatches, skipped)
  }

  @Test("g3.compare: POST /api/compare on m1r, sessions in order (multiplicity), every gate code reached there")
  func compareFamily() throws {
    let r = try Self.replay("g3.compare")
    if !r.skipped.isEmpty { print("g3.compare skipped: \(r.skipped.joined(separator: "; "))") }
    #expect(r.cases > 0 || !SnapshotClone.available("m1r"), "no case ran")
    #expect(r.mismatches.isEmpty, "\(r.mismatches.count) of \(r.cases) differ: \(r.mismatches.prefix(6).joined(separator: " | "))")
  }

  @Test("g3.collocations: GET /api/collocations on m1r")
  func collocationsFamily() throws {
    let r = try Self.replay("g3.collocations")
    if !r.skipped.isEmpty { print("g3.collocations skipped: \(r.skipped.joined(separator: "; "))") }
    #expect(r.mismatches.isEmpty, "\(r.mismatches.count) of \(r.cases) differ: \(r.mismatches.prefix(6).joined(separator: " | "))")
  }
}
