// OWNER: N1
// G1 text families of the ingest port (IOS-SPEC §2.2): the seg-1 segmenter (g1.segment; the private g1.segment-books
// over 50 snapshot books) and language identification (g1.langid). Exact: every passage's offsets, unit, page,
// quality, time role, field class and token count; every language, confidence, profile score and key order.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsIngest
import Testing

@Suite("G1 segment and langid")
struct TextGoldenTests {
  static func segmentFamily(_ family: String, required: Bool) throws {
    guard let cases = try IngestFixtures.cases(family) else {
      if required { Testing.Issue.record("golden family \(family) is missing") }
      return
    }
    var diffs: [String] = []
    for c in cases {
      let text = c["text"]?.stringValue ?? ""
      let o = c["opts"] ?? .object([:])
      let regions = try o["regions"].map { try IngestFixtures.decode([TextRegion].self, $0) } ?? []
      let units = Array(text.utf16)
      let tok = Tokenizer.tokens(text)
      let segs = Segmenter.segment(units: units, starts: tok.starts, ends: tok.ends, mode: o["mode"]?.stringValue ?? "auto",
                                   lang: o["lang"]?.stringValue, regions: regions, start: o["start"]?.safeInteger ?? 0,
                                   end: o["end"]?.safeInteger)
      let mine: [JSONValue] = segs.map {
        .array([.number(Double($0.start)), .number(Double($0.end)), .string($0.unit), $0.pageNo.map { .number(Double($0)) } ?? .null,
                .string($0.quality), .string($0.timeRole), .string($0.fieldClass), .number(Double($0.tokenCount))])
      }
      let expected = c["out"] ?? .array([])
      if CanonicalJSON.string(.array(mine)) != CanonicalJSON.string(expected) {
        let e = expected.arrayValue ?? []
        let k = (0..<min(mine.count, e.count)).first { CanonicalJSON.string(mine[$0]) != CanonicalJSON.string(e[$0]) } ?? min(mine.count, e.count)
        diffs.append("\(c["source"]?.stringValue ?? "?"): \(mine.count) passages vs \(e.count); first difference at \(k): swift \(k < mine.count ? CanonicalJSON.string(mine[k]) : "∅") node \(k < e.count ? CanonicalJSON.string(e[k]) : "∅")")
      }
    }
    IngestFixtures.report(family, cases: cases.count, mismatches: diffs.count, diffs: diffs)
    for d in diffs.prefix(20) { Testing.Issue.record("\(family): \(d)") }
    #expect(diffs.isEmpty, "\(family): \(diffs.count) of \(cases.count) cases differ")
  }

  @Test("g1.segment: seg-1 = Node on edge, fuzz, mini and demo texts")
  func segment() throws { try Self.segmentFamily("g1.segment", required: true) }

  @Test("g1.segment-books: seg-1 = Node on 50 snapshot books (private family; skipped off this Mac)")
  func segmentBooks() throws { try Self.segmentFamily("g1.segment-books", required: false) }

  @Test("g1.langid: scriptOf, detectLang and documentLang = Node")
  func langid() throws {
    #expect(LangID.isLoaded, "the stop-word lists are missing from the ScrollsIngest bundle")
    guard let cases = try IngestFixtures.cases("g1.langid") else {
      Testing.Issue.record("golden family g1.langid is missing")
      return
    }
    var diffs: [String] = []
    for c in cases {
      switch c["fn"]?.stringValue {
      case "detect":
        let text = c["text"]?.stringValue ?? ""
        let declared = c["declared"]?.stringValue
        let script = LangID.scriptOf(text)
        let g = LangID.detect(tokens: Tokenizer.tokens(text).tokens, declared: declared, script: script)
        let out = c["out"]!
        let scores = out["scores"]?.objectValue ?? JSONObject()
        let order = c["scores_order"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let ok = script == c["script"]?.stringValue && g.lang == out["lang"]?.stringValue
          && g.confidence == out["confidence"]?.numberValue && g.scores.map(\.lang) == order
          && g.scores.allSatisfy { scores[$0.lang]?.numberValue == $0.score }
        if !ok {
          diffs.append("detect \(c["source"]?.stringValue ?? "") '\(text.prefix(60))' declared \(declared ?? "nil"): swift \(script) \(g.lang) \(g.confidence) \(g.scores) node \(CanonicalJSON.string(out))")
        }
      case "documentLang":
        let passages = (c["passages"]?.arrayValue ?? []).map {
          (lang: $0["lang"]!.stringValue!, tokens: $0["tokens"]!.safeInteger!, confidence: $0["confidence"]?.numberValue)
        }
        let d = LangID.documentLang(passages, declared: c["declared"]?.stringValue)
        let out = c["out"]!
        let byLang = out["by_lang"]?.objectValue ?? JSONObject()
        let order = c["by_lang_order"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let ok = d.langText == out["lang_text"]?.stringValue && d.confidence == out["confidence"]?.numberValue
          && d.isTranslation == out["is_translation"]?.boolValue && d.share == out["share"]?.numberValue
          && d.byLang.map(\.lang) == order && d.byLang.allSatisfy { byLang[$0.lang]?.numberValue == $0.share }
        if !ok { diffs.append("documentLang \(CanonicalJSON.string(c["passages"]!)): swift \(d) node \(CanonicalJSON.string(out))") }
      default: diffs.append("unknown case \(CanonicalJSON.string(c).prefix(80))")
      }
    }
    IngestFixtures.report("g1.langid", cases: cases.count, mismatches: diffs.count, diffs: diffs)
    for d in diffs.prefix(20) { Testing.Issue.record("g1.langid: \(d)") }
    #expect(diffs.isEmpty, "g1.langid: \(diffs.count) of \(cases.count) cases differ")
  }
}
