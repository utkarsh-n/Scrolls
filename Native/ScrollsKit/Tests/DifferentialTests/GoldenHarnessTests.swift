// OWNER: N0
// The golden harness end to end on a committed G1 family (g1.ids): MANIFEST-checked loading, the run closure, the exact
// rule and the report. ScrollsCoreTests checks g1.ids with its own reader; this proves the shared harness agrees.

import Foundation
import ScrollsContracts
import ScrollsCore
import Testing

@Suite("Golden harness")
struct GoldenHarnessTests {
  @Test("g1.ids through GoldenFamily: every case exact", .enabled(if: GoldenFamily<JSONValue, JSONValue>.isAvailable("g1.ids")))
  func ids() async throws {
    let family = try GoldenFamily<JSONValue, JSONValue>("g1.ids", tier: .g1)
    #expect(family.cases.count == 1540)
    let report = try await family.check(.exact) { c in
      let s = c["s"]?.stringValue ?? ""
      switch c["fn"]?.stringValue {
      case "fnv1a32": return .number(Double(IDs.fnv1a32(s)))
      case "shortHash": return .string(IDs.shortHash(s, length: c["n"]?.safeInteger ?? 4))
      case "slugify": return .string(IDs.slug(s, max: c["max"]?.safeInteger ?? 48))
      case "parseRef":
        guard let (type, id) = try? IDs.parseRef(s) else { return .null }
        switch id {
        case .number(let n): return ["type": .string(type), "id": .number(Double(n))]
        case .string(let t): return ["type": .string(type), "id": .string(t)]
        }
      case "ref":
        let args = c["args"]?.arrayValue ?? []
        let type = args.first?.stringValue ?? ""
        let out: String? = switch args.last {
        case .number(let n)?: try? IDs.ref(type, Int64(n))
        case .string(let t)?: try? IDs.ref(type, t)
        default: nil
        }
        return out.map(JSONValue.string) ?? .null
      default:
        return .null
      }
    }
    for d in report.diffs { Issue.record("case \(d.index) \(d.path): \(d.detail)") }
    #expect(report.passed && report.cases == 1540 && report.mismatches == 0)
  }

  @Test("a family that is not in the manifest is unavailable, with the reason")
  func unknownFamily() {
    #expect(!GoldenFamily<JSONValue, JSONValue>.isAvailable("g9.nothing"))
    #expect(throws: GoldenUnavailable.self) { try GoldenFamily<JSONValue, JSONValue>("g9.nothing", tier: .g1) }
  }
}
