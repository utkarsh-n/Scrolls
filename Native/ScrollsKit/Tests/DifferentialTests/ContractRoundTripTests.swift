// OWNER: N0
// C0 in the differential suite (IOS-SPEC §2.2): the 65 contract fixtures MockAtlas bundles round-trip through their
// Swift types, and those copies are the reference's tests/contract byte for byte. Tools/check.sh runs this as
// DifferentialTests.ContractRoundTripTests and reads Reports/c0-contracts.json.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import Testing

private enum Paths {
  /// …/Scrolls (the reference's root), five levels above this file.
  static let referenceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  static let contract = referenceRoot.appendingPathComponent("tests/contract")
  static let bundled = referenceRoot.appendingPathComponent("Native/ScrollsKit/Sources/ScrollsService/Resources/contract-fixtures")
}

@Suite("C0 · ContractRoundTripTests")
struct ContractRoundTripTests {
  @Test("every body, event, request and example request of the bundled fixtures round-trips in canonical JSON")
  func roundTrip() throws {
    let r = try ContractRoundTrip.run(directory: Paths.bundled)
    for m in r.mismatches.prefix(40) { Issue.record("\(m)") }
    #expect(r.fixtures == 65)
    #expect(r.passed, "\(r.mismatches.count) mismatches, \(r.unshaped.count) unshaped of \(r.bodies.count) bodies")
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      try Data(CanonicalJSON.string(ContractRoundTrip.report(r)).utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("c0-contracts.json"))
    }
  }

  @Test("the bundled fixtures are byte-equal to tests/contract")
  func byteEqual() throws {
    func digests(_ dir: URL) throws -> [String: String] {
      var out: [String: String] = [:]
      for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name.hasSuffix(".json") {
        out[name] = SHA256.hash(data: try Data(contentsOf: dir.appendingPathComponent(name))).map { String(format: "%02x", $0) }.joined()
      }
      return out
    }
    let reference = try digests(Paths.contract), bundled = try digests(Paths.bundled)
    #expect(reference.count == 65)
    #expect(reference == bundled)
  }

  @Test("MockAtlas answers the default variant of every JSON endpoint with a body that round-trips")
  func mockDefaults() async throws {
    let atlas = MockAtlas(eventDelayScale: 0)
    let h = try await atlas.health()
    #expect(try ContractCatalog.roundTrip(shape: "Health", try ScrollsJSON.value(h)) == (try ScrollsJSON.value(h)))
    let q = try await atlas.timelineQuery(TimelineQueryRequest(strands: [StrandRequest(type: "expression", ref: .int(12))],
                                                               corpus: "demo", lanes: LanesRequest(facet: "community")))
    #expect(q.lanes.count == 10)
    #expect(q.provenance.synthetic)
  }
}

@Suite("Golden rules (§2.4)")
struct GoldenRuleTests {
  @Test("exact, relative and geometry compare numbers as §2.4 says")
  func numericRules() {
    let e: JSONValue = ["a": 1.0, "b": [100.0, 2.5]]
    #expect(GoldenCompare.difference(.exact, expected: e, actual: e) == nil)
    #expect(GoldenCompare.difference(.relative(1e-9), expected: e, actual: ["a": 1.0000000001, "b": [100.00000001, 2.5]]) == nil)
    #expect(GoldenCompare.difference(.relative(1e-9), expected: e, actual: ["a": 1.001, "b": [100.0, 2.5]]) != nil)
    #expect(GoldenCompare.difference(.geometry(points: 0.01), expected: e, actual: ["a": 1.009, "b": [99.995, 2.5]]) == nil)
    #expect(GoldenCompare.difference(.geometry(points: 0.01), expected: e, actual: ["a": 1.02, "b": [100.0, 2.5]]) != nil)
  }

  @Test("the adjusted Rand index is 1 for a relabelling and below 1 for a different partition")
  func ari() {
    #expect(GoldenCompare.adjustedRandIndex(["a", "a", "b", "b"], ["x", "x", "y", "y"]) == 1)
    #expect(GoldenCompare.adjustedRandIndex(["a", "a", "b", "b"], ["x", "y", "x", "y"]) < 0.5)
  }

  @Test("principal-angle cosines: 1 for the same subspace under a rotation, 0 for orthogonal ones")
  func subspace() {
    let a = [[1.0, 0], [0, 1], [0, 0]]
    let rotated = [[0.6, 0.8], [-0.8, 0.6], [0, 0]]
    #expect(GoldenCompare.principalCosines(a, rotated, k: 2).allSatisfy { abs($0 - 1) < 1e-12 })
    let other = [[0.0], [0], [1]]
    #expect(GoldenCompare.principalCosines([[1.0], [0], [0]], other, k: 1) == [0])
  }
}
