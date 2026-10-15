// OWNER: N5
// G3 `g3.lineage` (IOS-SPEC §2.2): the lineage graph, the chain of custody and the genealogy on an APFS clone of m1r,
// request for request against the reference's graph.mjs / path.mjs / genealogy.mjs (Golden/requests/lineage plus a
// systematic sample per relationship type and status). Every response is compared EXACTLY as JSON (counts, ids, labels,
// order, truncation, notes), every error by status, code, message, hint and detail; each response must also decode into
// its contract type (what LiveAtlas returns). Runs when SCROLLS_LINEAGE_G3=1 (Tools/check.d/lineage.sh) and m1r exists.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsLineage
import ScrollsStore
import Testing

@Suite("G3 lineage on m1r")
struct LineageG3Tests {
  static var enabled: Bool {
    ProcessInfo.processInfo.environment["SCROLLS_LINEAGE_G3"] == "1" && PassHarness.snapshotAvailable("m1r")
      && LineageGolden.available("g3.lineage")
  }

  @Test("g3.lineage: lineage, path and genealogy responses equal the reference's",
        .enabled(if: LineageG3Tests.enabled, "runs in Tools/check.sh lineage (SCROLLS_LINEAGE_G3=1, needs the m1r snapshot)"))
  func m1r() throws {
    let report = LineageGolden.Report("g3.lineage")
    defer { report.write() }
    let cases = try LineageGolden.load("g3.lineage")
    let dir = try PassHarness.scratchDir("g3-lineage")
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = try PassHarness.cloneSnapshot("m1r", into: dir)
    let derived = PassHarness.snapshotsRoot.appendingPathComponent("m1r/derived")
    if FileManager.default.fileExists(atPath: derived.path) {
      try FileManager.default.copyItem(at: derived, to: dir.appendingPathComponent("derived"))
    }
    let c = try Connection(path: path, mode: .readOnly, profile: .reference)
    defer { c.close() }
    var timings: [(String, Double)] = []
    for (i, cs) in cases.enumerated() {
      let kind = cs["kind"]?.stringValue ?? "", id = cs["id"]?.stringValue ?? "#\(i)"
      var args = QueryArgs()
      for (k, v) in cs["args"]?.objectValue ?? JSONObject() { if let s = v.stringValue { args[k] = s } }
      let t0 = ContinuousClock.now
      let outcome = Self.run(kind, args, c, path)
      timings.append((id, (ContinuousClock.now - t0) / .seconds(1)))
      Self.compare(report, id, kind, cs, outcome)
    }
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      let slow = timings.sorted { $0.1 > $1.1 }.prefix(5).map { JSONValue.object(["id": .string($0.0), "s": .number(($0.1 * 1000).rounded() / 1000)]) }
      let total = timings.reduce(0) { $0 + $1.1 }
      try? Data((CanonicalJSON.string(["family": "g3.lineage", "requests": .number(Double(timings.count)),
                                       "seconds": .number((total * 100).rounded() / 100), "slowest": .array(slow),
                                       "machine": "mac (release, InlineTextStore)"]) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("lineage-g3-timings.json"))
    }
    #expect(report.passed, "\(report.summary)")
  }

  enum Outcome: Sendable {
    case response(JSONValue)
    case error(ScrollsError)
    case crash(String)
  }

  static func run(_ kind: String, _ args: QueryArgs, _ c: Connection, _ path: String) -> Outcome {
    do {
      switch kind {
      case "lineage": return .response(try LineageGraph.query(LineageReader(c, text: InlineTextStore(), atlasPath: path), args))
      case "path": return .response(try ChainOfCustody.query(c, args))
      case "genealogy": return .response(try Genealogy.query(c, args))
      default: return .crash("unknown kind \(kind)")
      }
    } catch let e as ScrollsError {
      return .error(e)
    } catch {
      return .crash("\(error)")
    }
  }

  /// Compares one outcome with its golden case (response or error), and checks that a response decodes into its
  /// contract type.
  static func compare(_ report: LineageGolden.Report, _ id: String, _ kind: String, _ cs: JSONValue, _ outcome: Outcome) {
    switch outcome {
    case .response(let got):
      guard let want = cs["response"] else {
        report.check(false, "\(id): the reference answered an error", expected: cs["error"] ?? .null, actual: got)
        return
      }
      let same = CanonicalJSON.string(got) == CanonicalJSON.string(want)
      report.check(same, "\(id): response", expected: same ? .null : want, actual: same ? .null : firstDifference(want, got))
      do {
        switch kind {
        case "lineage": _ = try ScrollsJSON.decode(LineageResponse.self, from: got)
        case "path": _ = try ScrollsJSON.decode(LineagePathResponse.self, from: got)
        default: _ = try ScrollsJSON.decode(GenealogyResponse.self, from: got)
        }
        report.check(true, "\(id): decodes")
      } catch {
        report.check(false, "\(id): decodes into the contract type", actual: .string("\(error)"))
      }
    case .error(let e):
      guard let want = cs["error"] else {
        report.check(false, "\(id): Swift answered an error", expected: "a response", actual: .string(e.description))
        return
      }
      let got: JSONValue = ["status": e.status.map { .number(Double($0)) } ?? .null, "code": .string(e.code.rawValue),
                            "message": .string(e.message), "hint": e.hint.map(JSONValue.string) ?? .null, "detail": e.detail]
      report.check(CanonicalJSON.string(got) == CanonicalJSON.string(want), "\(id): error", expected: want, actual: got)
    case .crash(let message):
      report.check(false, "\(id): threw", expected: cs["response"] ?? cs["error"] ?? .null, actual: .string(message))
    }
  }

  /// The first differing member path between two JSON values (for a readable report).
  static func firstDifference(_ a: JSONValue, _ b: JSONValue, path: String = "$") -> JSONValue {
    switch (a, b) {
    case (.object(let x), .object(let y)):
      for k in Set(x.keys).union(y.keys).sorted() where x[k] != y[k] {
        return firstDifference(x[k] ?? .null, y[k] ?? .null, path: "\(path).\(k)")
      }
    case (.array(let x), .array(let y)):
      if x.count != y.count { return ["path": .string(path), "reference_count": .number(Double(x.count)), "swift_count": .number(Double(y.count))] }
      for (i, (u, v)) in zip(x, y).enumerated() where u != v { return firstDifference(u, v, path: "\(path)[\(i)]") }
    default: break
    }
    return ["path": .string(path), "reference": a, "swift": b]
  }
}
