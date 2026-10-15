// OWNER: N0
// C0 (IOS-SPEC §2.2) in the Contracts target's own tests, so it runs before ScrollsService and DifferentialTests can
// build: every body, variant, SSE event, request and example request of the 65 contract fixtures decodes into its
// Swift type and encodes back to the same canonical JSON. Writes Reports/c0-contracts.json when Tools/check.sh passes
// SCROLLS_REPORTS_DIR.

import Foundation
import ScrollsContracts
import ScrollsCore
import Testing

@Suite("C0 contract round trip")
struct ContractRoundTripC0Tests {
  @Test("the endpoint table matches the 65 fixtures: file names, request and response shapes")
  func catalogMatchesFixtures() throws {
    let fixtures = try ContractFixtures.load()
    #expect(fixtures.count == 65)
    #expect(ContractCatalog.endpoints.count == 65)
    let byFile = Dictionary(uniqueKeysWithValues: ContractCatalog.endpoints.map { ($0.fixtureFile, $0) })
    #expect(Set(byFile.keys) == Set(fixtures.map(\.file)))
    #expect(Set(ContractCatalog.endpoints.map(\.service)).count == 65, "one AtlasService method per endpoint")
    for f in fixtures {
      guard let e = byFile[f.file] else { continue }
      #expect(f.json["method"]?.stringValue == e.method, "\(f.file) method")
      #expect(f.json["path"]?.stringValue == e.path, "\(f.file) path")
      #expect(f.json["request"]?.stringValue == e.request, "\(f.file) request shape")
      #expect(f.json["response"]?.stringValue == e.response, "\(f.file) response shape")
      if let r = e.response { #expect(ContractCatalog.type(ofShape: r) != nil, "\(r) has a Swift type") }
      if let r = e.request { #expect(ContractCatalog.type(ofShape: r) != nil, "\(r) has a Swift type") }
    }
  }

  @Test("every fixture body, event, request and example request round-trips byte-equal in canonical JSON")
  func roundTrip() throws {
    let r = try ContractRoundTrip.run(directory: ContractFixtures.contractDir)
    for m in r.mismatches.prefix(40) { Issue.record("\(m)") }
    #expect(r.mismatches.isEmpty, "\(r.mismatches.count) of \(r.bodies.count) bodies do not round-trip")
    #expect(r.unshaped.isEmpty, "bodies with no Swift mirror: \(r.unshaped)")
    // counted independently of ContractRoundTrip: every JSON body, variant request, event payload and example request
    // (Node over ref-freeze-1's fixtures: 221 + 7 + 13 + 19 = 260)
    var expected = 0
    for f in try ContractFixtures.load() {
      if let ex = f.json["example_request"], !ex.isNull { expected += 1 }
      for (_, v) in f.json["variants"]?.objectValue ?? [:] {
        if v["body"] != nil { expected += 1 }
        if v["request"] != nil { expected += 1 }
        expected += (v["events"]?.arrayValue ?? []).filter { $0["data"] != nil }.count
      }
    }
    #expect(r.bodies.count == expected, "C0 covers every body (\(r.bodies.count) of \(expected))")
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      try Data(CanonicalJSON.string(ContractRoundTrip.report(r)).utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("c0-contracts.json"))
    }
  }

  @Test("a key the Swift type does not know fails the round trip (the safety net works)")
  func unknownKeyFails() throws {
    var probed = 0
    for f in try ContractFixtures.load() {
      for b in ContractRoundTrip.bodies(ofFixture: f.file, f.json).bodies where b.part == "body" && b.shape != "ErrorBody" {
        guard case .object(var o) = b.value else { continue }
        o["zz_not_in_contract"] = .number(1)
        let probe = ContractRoundTrip.Body(file: b.file, variant: b.variant, part: b.part, shape: b.shape, value: .object(o))
        #expect(ContractRoundTrip.check(probe) != nil, "\(b.file) [\(b.variant)] kept an unknown key")
        probed += 1
      }
    }
    #expect(probed > 100)
  }

  @Test("every contract shape that fixtures use has a Swift mirror, and so do the canonical inputs")
  func shapesHaveMirrors() {
    for name in ["Provenance", "Issue", "DateParse", "DateRow", "Anchor", "Variant", "Lane", "Cell", "Wash", "Arc", "Measure",
                 "Job", "Annotation", "ShareCell", "ArcBucket", "ImportSummary", "ImportPreview", "PassageDocument",
                 "ErrorBody", "JobRef", "BaselineRho", "ExportManifest", "CanonicalDocument", "CanonicalRelationship",
                 "CanonicalAnnotation"] {
      #expect(ContractCatalog.type(ofShape: name) != nil, "\(name)")
    }
  }
}
