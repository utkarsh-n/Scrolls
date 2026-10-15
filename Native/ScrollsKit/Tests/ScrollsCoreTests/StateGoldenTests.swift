// OWNER: N0
// G1 exact comparisons of the view state, the evidence style and the vocabularies (IOS-SPEC §1.3, §2.2).

import Foundation
import ScrollsCore
import Testing

@Suite("G1 view-state, evidence-style and vocab goldens")
struct StateGoldenTests {
  @Test("g1.viewstate: defaultState, canonicalize + warnings, encode, decodeHash, stateHash and the filter grammar")
  func viewState() throws {
    let fam = try Golden.load("g1.viewstate")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      switch c["fn"]!.stringValue! {
      case "defaultState":
        let got = ViewState.defaultState(c["corpus"]!.stringValue!).jsonValue
        report.check(sameJSON(got, c["out"]!), "defaultState(\(c["corpus"]!.stringValue!))", expected: c["out"]!, actual: got)
      case "state":
        var warnings: [String] = []
        let s = ViewState.canonicalize(c["input"]!, warnings: &warnings)
        let decoded = ViewState.decodeHash(s.hash)
        let got: JSONValue = [
          "canonical": s.jsonValue, "warnings": .array(warnings.map(JSONValue.string)), "hash": .string(s.hash),
          "decoded": decoded.state.jsonValue, "decodeWarnings": .array(decoded.warnings.map(JSONValue.string)),
          "stateHash": .string(s.stateHash),
        ]
        let want: JSONValue = [
          "canonical": c["canonical"]!, "warnings": c["warnings"]!, "hash": c["hash"]!, "decoded": c["decoded"] ?? c["canonical"]!,
          "decodeWarnings": c["decodeWarnings"]!, "stateHash": c["stateHash"]!,
        ]
        report.check(sameJSON(got, want), CanonicalJSON.string(c["input"]!), expected: want, actual: got)
      case "decodeHash":
        let r = ViewState.decodeHash(c["hash"]!.stringValue!)
        let view: JSONValue = r.view.map { ["slug": .string($0.slug), "asSaved": .bool($0.asSaved)] } ?? .null
        let got: JSONValue = ["out": ["state": r.state.jsonValue, "warnings": .array(r.warnings.map(JSONValue.string)), "view": view],
                              "reencoded": .string(r.state.hash)]
        let want: JSONValue = ["out": c["out"]!, "reencoded": c["reencoded"]!]
        report.check(sameJSON(got, want), c["hash"]!.stringValue!, expected: want, actual: got)
      case "parseFilter":
        var warnings: [String] = []
        let f = ViewState.parseFilter(c["input"]!.stringValue!, warnings: &warnings)
        var asState = ViewState.defaultState()
        asState.f = f
        let got: JSONValue = ["out": asState.jsonValue["f"]!, "warnings": .array(warnings.map(JSONValue.string)),
                              "formatted": .string(ViewState.formatFilter(f)),
                              "withDefaults": .string(ViewState.formatFilter(f, withDefaults: true))]
        let want: JSONValue = ["out": c["out"]!, "warnings": c["warnings"]!, "formatted": c["formatted"]!, "withDefaults": c["withDefaults"]!]
        report.check(sameJSON(got, want), c["input"]!.stringValue!, expected: want, actual: got)
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.evidence-style: edgeStyle, binStyle, BADGES and LEGEND_ROWS")
  func evidenceStyle() throws {
    let fam = try Golden.load("g1.evidence-style")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      switch c["fn"]!.stringValue! {
      case "edgeStyle":
        let r = c["rel"]!
        let key = EvidenceStyleKey(
          evidenceStatus: r["evidence_status"]!.stringValue!, reviewStatus: r["review_status"]?.stringValue ?? "unreviewed",
          provenanceQuality: r["provenance_quality"]?.stringValue ?? "complete", family: r["family"]?.stringValue,
          cue: r["cue"] == .bool(true), isSynthetic: r["is_synthetic"] == .number(1) || r["is_synthetic"] == .bool(true),
          dateConflict: r["date_conflict"] == .bool(true), origin: r["origin"]?.stringValue)
        do {
          let got = try EvidenceStyle.edgeStyle(key).jsonValue
          report.check(sameJSON(got, c["out"]!), CanonicalJSON.string(r), expected: c["out"]!, actual: got)
        } catch {
          report.check(c["error"]?.stringValue == error.message, CanonicalJSON.string(r), expected: c["error"]!, actual: .string(error.message))
        }
      case "binStyle":
        let cell = c["cell"]!
        let flags = cell["flags"]!.int!
        let result: Result<BinStyle, EvidenceStyleError>
        switch cell["state"]! {
        case .number(let n): result = Result { () throws(EvidenceStyleError) in try EvidenceStyle.binStyle(state: Int(n), flags: flags) }
        case .string(let s): result = Result { () throws(EvidenceStyleError) in try EvidenceStyle.binStyle(state: s, flags: flags) }
        default: result = .failure(EvidenceStyleError(message: "bad golden cell"))
        }
        switch result {
        case .success(let got):
          report.check(sameJSON(got.jsonValue, c["out"]!), CanonicalJSON.string(cell), expected: c["out"]!, actual: got.jsonValue)
        case .failure(let error):
          report.check(c["error"]?.stringValue == error.message, CanonicalJSON.string(cell), expected: c["error"]!,
                       actual: .string(error.message))
        }
      case "BADGES":
        report.check(sameJSON(Copy.badges.jsonValue, c["out"]!), "BADGES", expected: c["out"]!, actual: Copy.badges.jsonValue)
      case "LEGEND_ROWS":
        let got = JSONValue.array(EvidenceStyle.legendRows.map(\.jsonValue))
        report.check(sameJSON(got, c["out"]!), "LEGEND_ROWS", expected: c["out"]!, actual: got)
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.vocab: every export of vocab.mjs equals the generated Vocab/Copy statics and Resources/vocab.json; fillTemplate")
  func vocab() throws {
    let fam = try Golden.load("g1.vocab")
    let report = Golden.Report(fam.name)
    let bundled = try Vocab.bundledJSON()
    var exports = Set<String>()
    for c in fam.cases {
      if let name = c["export"]?.stringValue {
        exports.insert(name)
        let typed = Vocab.jsonValue(ofExport: name) ?? Copy.jsonValue(ofExport: name) ?? .null
        let fromResource = bundled[name] ?? .null
        report.check(sameJSON(typed, c["value"]!) && sameJSON(fromResource, c["value"]!), name, expected: c["value"]!, actual: typed)
      } else {
        let got = Vocab.fillTemplate(c["template"]!.stringValue!, c["vars"]!.objectValue!)
        report.check(same(got, c["out"]!.stringValue!), c["template"]!.stringValue!, expected: c["out"]!, actual: .string(got))
      }
    }
    // nothing generated that the reference no longer exports, and nothing exported that was not generated
    let generated = Set(Vocab.exportNames + Copy.exportNames.filter { $0 != "BADGES" && $0 != "LEGEND_TEXT" })
    report.check(generated == exports, "export names", expected: .array(exports.sorted().map(JSONValue.string)),
                 actual: .array(generated.sorted().map(JSONValue.string)))
    report.write()
    #expect(report.passed, "\(report.summary)")
  }
}
