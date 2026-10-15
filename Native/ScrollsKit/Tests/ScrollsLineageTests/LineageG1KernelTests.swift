// OWNER: N5
// G1 goldens of the trace's kernels (IOS-SPEC §2.2), exact against the reference: `g1.align` (k-gram seeds,
// seed-and-extend with limits, Smith–Waterman spans and f64 scores), `g1.cues` (attribution cues in five languages,
// the cue window, the quotation-marks cue, name words and name matching), `g1.filters` (stop ids, numerals, name lists,
// informative windows and content tokens).

import Foundation
import ScrollsCore
@testable import ScrollsLineage
import Testing

@Suite("G1 lineage kernels")
struct LineageG1KernelTests {
  @Test("g1.align: seeds, maximal runs and Smith–Waterman equal the reference's",
        .enabled(if: LineageGolden.available("g1.align")))
  func align() throws {
    let report = LineageGolden.Report("g1.align")
    defer { report.write() }
    for (i, c) in try LineageGolden.load("g1.align").enumerated() {
      let a = c["a"]?.u32s ?? [], b = c["b"]?.u32s ?? []
      switch c["kind"]?.stringValue {
      case "seeds":
        let k = c["k"]?.int ?? 8, aLo = c["a_lo"]?.int ?? 0, aHi = c["a_hi"]?.int ?? a.count, minRun = c["min_run"]?.int ?? 8
        let seeds = Align.kgramSeeds(a, b, k: k, aLo: aLo, aHi: aHi)
        let gotSeeds: JSONValue = .array(seeds.map { [.number(Double($0.a)), .number(Double($0.b))] })
        report.check(gotSeeds == c["seeds"], "#\(i) kgramSeeds", expected: .number(Double(c["seeds"]?.arrayValue?.count ?? 0)),
                     actual: .number(Double(seeds.count)))
        let runs = Align.seedExtend(a, b, seeds, minRun: minRun, aLo: aLo, aHi: aHi)
        let got: JSONValue = .array(runs.map { [.number(Double($0.a0)), .number(Double($0.a1)), .number(Double($0.b0)), .number(Double($0.b1))] })
        report.check(got == c["runs"], "#\(i) seedExtend", expected: c["runs"] ?? .null, actual: got)
      case "sw":
        let o = c["opts"]
        let sw = Align.smithWaterman(a, b, match: o?["match"]?.numberValue ?? 2, mismatch: o?["mismatch"]?.numberValue ?? -1,
                                     gap: o?["gap"]?.numberValue ?? -1)
        let got: JSONValue = ["score": .number(sw.score), "normalized": .number(sw.normalized), "aStart": .number(Double(sw.aStart)),
                              "aEnd": .number(Double(sw.aEnd)), "bStart": .number(Double(sw.bStart)), "bEnd": .number(Double(sw.bEnd))]
        let want = c["result"] ?? .null
        let bitExact = sw.normalized.bitPattern == (want["normalized"]?.numberValue ?? .nan).bitPattern
        report.check(got == want && bitExact, "#\(i) smithWaterman", expected: want, actual: got)
      default:
        report.check(false, "#\(i) unknown kind")
      }
    }
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.cues: cue patterns in five languages, the window, quotation marks, names",
        .enabled(if: LineageGolden.available("g1.cues")))
  func cues() throws {
    let report = LineageGolden.Report("g1.cues")
    defer { report.write() }
    for (i, c) in try LineageGolden.load("g1.cues").enumerated() {
      let text = c["text"]?.stringValue ?? ""
      switch c["kind"]?.stringValue {
      case "all", "all-lang":
        let got: JSONValue = .array(Cues.allCues(text, lang: c["lang"]?.stringValue).map(\.json))
        report.check(got == c["cues"], "#\(i) allCues \(c["source"]?.stringValue ?? "") \(c["lang"]?.stringValue ?? "*")",
                     expected: c["cues"] ?? .null, actual: got)
      case "find":
        let got: JSONValue = .array(Cues.findCues(text, start: c["start"]?.int ?? 0, end: c["end"]?.int ?? 0,
                                                  window: c["window"]?.int ?? Cues.window).map(\.json))
        report.check(got == c["cues"], "#\(i) findCues \(c["source"]?.stringValue ?? "")", expected: c["cues"] ?? .null, actual: got)
      case "nameWords":
        let got: JSONValue = .array(Cues.nameWords(c["name"]?.stringValue).map(JSONValue.string))
        report.check(got == c["words"], "#\(i) nameWords", expected: c["words"] ?? .null, actual: got)
      case "nameMatches":
        let got = Cues.nameMatches(c["name"]?.stringValue, author: c["author"]?.stringValue, title: c["title"]?.stringValue)
        report.check(got == c["value"]?.boolValue, "#\(i) nameMatches \(c["name"]?.stringValue ?? "") / \(c["title"]?.stringValue ?? "")",
                     expected: c["value"] ?? .null, actual: .bool(got))
      default:
        report.check(false, "#\(i) unknown kind")
      }
    }
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.filters: stop ids, numerals, name lists, informative windows",
        .enabled(if: LineageGolden.available("g1.filters")))
  func filters() throws {
    let report = LineageGolden.Report("g1.filters")
    defer { report.write() }
    for (i, c) in try LineageGolden.load("g1.filters").enumerated() {
      switch c["kind"]?.stringValue {
      case "stopIds":
        let ids = Filters.stopIds.sorted()
        report.check(ids.count == c["count"]?.int && u32sha(ids) == c["sha256"]?.stringValue, "#\(i) stopIds",
                     expected: c["count"] ?? .null, actual: .number(Double(ids.count)))
      case "isNumeral":
        let t = c["token"]?.stringValue ?? ""
        report.check(Filters.isNumeral(t) == c["value"]?.boolValue, "#\(i) isNumeral \(t)", expected: c["value"] ?? .null,
                     actual: .bool(Filters.isNumeral(t)))
      case "text":
        let text = c["text"]?.stringValue ?? ""
        let tk = Tokenizer.tokens(text)
        let ids = Winnow.tokenIds(tk.tokens)
        let classes = Filters.TokenClasses()
        for (k, t) in tk.tokens.enumerated() { classes.see(t, ids[k]) }
        report.check(Filters.isNameList(text) == c["name_list"]?.boolValue, "#\(i) isNameList", expected: c["name_list"] ?? .null,
                     actual: .bool(Filters.isNameList(text)))
        report.check(u32json(classes.numerals.sorted()) == c["numerals"], "#\(i) numeral classes", expected: c["numerals"] ?? .null,
                     actual: u32json(classes.numerals.sorted()))
        var got: [JSONValue] = []
        var a0 = 0
        while a0 < ids.count {
          let a1 = min(ids.count, a0 + 13)
          got.append([.number(Double(a0)), .number(Double(a1)), .bool(Filters.informative(ids, a0, a1, classes)),
                      .bool(Filters.informative(ids, a0, a1, nil)), .number(Double(Filters.contentTokens(ids, a0, a1, classes)))])
          a0 += 7
        }
        report.check(JSONValue.array(got) == c["windows"], "#\(i) windows", expected: c["windows"] ?? .null, actual: .array(got))
      default:
        report.check(false, "#\(i) unknown kind")
      }
    }
    #expect(report.passed, "\(report.summary)")
  }
}
