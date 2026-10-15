// OWNER: N0
// The honesty rules the contract types carry (SPEC §13): a gated value decodes as `.gated` and writes no numeral;
// the canonical inputs refuse what the reference's shape rules refuse.

import Foundation
import ScrollsContracts
import ScrollsCore
import Testing

private func fixture(_ file: String) throws -> JSONValue {
  try JSONValue.parse(try Data(contentsOf: ContractFixtures.contractDir.appendingPathComponent(file)))
}

private func bodies(_ file: String) throws -> [(String, JSONValue)] {
  let f = try fixture(file)
  return (f["variants"]?.objectValue ?? [:]).compactMap { name, v in
    (v["status"]?.safeInteger ?? 200) < 400 ? v["body"].map { (name, $0) } : nil
  }
}

/// No gated object anywhere in the value carries a numeral in value, ci, ci_lo, ci_hi or null_percentile
/// (contracts.mjs `gateNumerals`).
private func gatedObjectsCarryNoNumeral(_ v: JSONValue, path: String = "$") -> [String] {
  var out: [String] = []
  switch v {
  case .array(let a):
    for (i, x) in a.enumerated() { out += gatedObjectsCarryNoNumeral(x, path: "\(path)[\(i)]") }
  case .object(let o):
    if let g = o["gate"]?.stringValue, g != "ok", Vocab.gateCodes.contains(g) {
      for k in ["value", "ci", "ci_lo", "ci_hi", "null_percentile"] where o[k] != nil && o[k] != .null {
        out.append("\(path).\(k)")
      }
    }
    for (k, x) in o { out += gatedObjectsCarryNoNumeral(x, path: "\(path).\(k)") }
  default:
    break
  }
  return out
}

@Suite("Honesty in the contract types")
struct HonestyTypeTests {
  @Test("Compare measures and the baseline correlation decode gated exactly when their gate is not ok")
  func compareGates() throws {
    var gated = 0, ok = 0
    for (name, body) in try bodies("POST__api_compare.json") {
      let c = try ScrollsJSON.decode(CompareResponse.self, from: body)
      for (m, raw) in zip(c.measures, body["measures"]?.arrayValue ?? []) {
        let code = raw["gate"]?.stringValue
        #expect(m.result.code.rawValue == code, "\(name) \(m.metric)")
        switch m.result {
        case .value: ok += 1
        case .gated(let g):
          gated += 1
          #expect(g.code != .ok)
          #expect(Set(g.nullKeys).isSubset(of: MeasureEstimate.nullKeysWhenGated))
        }
      }
      if let rho = c.baselineRho, let result = rho.result {
        #expect(result.code.rawValue == body["baseline_rho"]?["gate"]?.stringValue)
      }
      #expect(gatedObjectsCarryNoNumeral(try ScrollsJSON.value(c)).isEmpty, "\(name)")
    }
    #expect(gated > 0 && ok > 0, "the fixtures hold both states (\(ok) ok, \(gated) gated)")
  }

  @Test("collocations and clusters: the gated variants decode as .gated, the ok ones as .value")
  func topLevelGates() throws {
    for (name, body) in try bodies("GET__api_collocations.json") {
      let c = try ScrollsJSON.decode(CollocationsResponse.self, from: body)
      #expect(c.result.isOK == (body["gate"]?.stringValue == "ok"), "\(name)")
    }
    for (name, body) in try bodies("GET__api_clusters.json") {
      let c = try ScrollsJSON.decode(ClustersResponse.self, from: body)
      #expect(c.result.isOK == (body["gate"]?.stringValue == "ok"), "\(name)")
    }
  }

  @Test("every successful fixture body, as Swift re-encodes it, keeps gated objects free of numerals")
  func noNumeralsWhenGated() throws {
    for e in ContractCatalog.endpoints {
      guard let shape = e.response else { continue }
      for (name, body) in try bodies(e.fixtureFile) {
        let back = try ContractCatalog.roundTrip(shape: shape, body)
        #expect(gatedObjectsCarryNoNumeral(back).isEmpty, "\(e.fixtureFile) [\(name)]")
      }
    }
  }

  @Test("a gated value made in Swift writes its gate and null in place of the numerals")
  func gatedFromSwift() throws {
    let gate = Gate(code: .sliceTooSmall, needed: ["tokens_per_slice": 3_000_000], have: ["a": 21400, "b": 30100],
                    nullKeys: MeasureEstimate.nullKeysWhenGated)
    let m = Measure(metric: "neighbor_overlap", result: .gated(gate), note: "no widening inside this corpus reaches the gate")
    #expect(try ScrollsJSON.canonical(m) == #"{"ci":null,"gate":"slice_too_small","have":{"a":21400,"b":30100},"metric":"neighbor_overlap","needed":{"tokens_per_slice":3000000},"note":"no widening inside this corpus reaches the gate","suggestion":null,"value":null}"#)
  }

  @Test("canonical relationships: evidence status is bound to origin (D7)")
  func relationshipRules() {
    let end = CanonicalEndpoint(collection: "c", extId: "1")
    let documented = CanonicalRelationship(src: end, dst: end, relType: "explicit_citation", evidenceStatus: "documented",
                                           origin: "source_dataset", sourceDataset: "openalex", sourceLocator: "W1",
                                           createdBy: "adapter:stemm.openalex")
    #expect(documented.violations().isEmpty)
    var noDataset = documented
    noDataset.sourceDataset = nil
    #expect(noDataset.violations().contains("documented requires source_dataset"))
    var human = documented
    human.evidenceStatus = "documented"
    human.origin = "human"
    human.createdBy = "Reader A"
    #expect(human.violations().contains("origin 'human' must be proposed"))
    #expect(human.violations().contains("origin 'human' requires created_by 'human:<name>'"))
    var computed = documented
    computed.evidenceStatus = "computed"
    computed.origin = "algorithm"
    #expect(computed.violations().contains("origin 'algorithm' requires run_id and method"))
    var unknownType = documented
    unknownType.relType = "influenced"
    #expect(unknownType.violations().contains("unknown rel_type 'influenced'"))
    let noEnds = CanonicalRelationship(src: CanonicalEndpoint(), dst: end, relType: "explicit_citation",
                                       evidenceStatus: "proposed", origin: "human", createdBy: "human:you")
    #expect(noEnds.violations() == ["src needs ext_id or ref"])
  }

  @Test("canonical documents: one chronology date, raw or parsed dates, regions inside the original (UTF-16)")
  func documentRules() {
    let text = CanonicalText(original: "😀 zero", decoder: "utf-8", bodyStart: 0, bodyEnd: 7,
                             regions: [TextRegion(start: 0, end: 7), TextRegion(start: 3, end: 8)])
    let doc = CanonicalDocument(extId: "x", kind: "book", text: text,
                                dates: [CanonicalDate(role: "publication", raw: "1911", assertedBy: "a", isChronology: true),
                                        CanonicalDate(role: "edition", assertedBy: "a", isChronology: true)],
                                originalMeta: [:])
    #expect(doc.violations() == ["at most one date may be the chronology", "date 'edition' needs raw or parsed",
                                 "region 3–8 outside the original"])
  }

  @Test("canonical annotations: passage targets need an anchor, machine annotations a method")
  func annotationRules() {
    let a = CanonicalAnnotation(target: CanonicalAnnotationTarget(type: "passage", extId: "x"), kind: "machine_tag",
                                author: "tagger", isMachine: true, bodyMd: "t")
    #expect(a.violations() == ["a passage target needs an anchor", "machine annotations need a method"])
  }

  @Test("fixture file names follow mock.mjs fixtureFileName")
  func fixtureNames() {
    #expect(ContractCatalog.endpoint(service: "importProblems")?.fixtureFile == "GET__api_imports_{id}_problems.csv.json")
    #expect(ContractCatalog.endpoint(service: "hypothesisGroup")?.fixtureFile == "GET__api_hypothesis-groups_{id}.json")
    #expect(ContractCatalog.endpoint(service: "deleteView")?.fixtureFile == "DELETE__api_views_{slug}.json")
  }
}
