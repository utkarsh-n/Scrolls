// OWNER: N3
// G1 of the read path (IOS-SPEC §2.2, §8.5 N3): the variant generator, the transliteration key, the proper-noun guard and
// KWIC lines equal the reference's on every golden case, exactly (strings by UTF-16 code units).

import Foundation
import ScrollsCore
import ScrollsQuery
import Testing

@Suite("G1 read path")
struct ReadG1GoldenTests {
  @Test("g1.variants: generateVariants, variantsHash, script and kind of tokens")
  func variants() throws {
    let r = QueryGolden.Report("g1.variants")
    for c in try QueryGolden.load("g1.variants") {
      let id = c["id"]?.stringValue ?? "?"
      let surface = c["surface"]?.stringValue ?? ""
      let lang = c["lang"]?.stringValue
      let kinds = c["kinds"]?.arrayValue?.compactMap(\.stringValue)
      let out = Variants.generate(surface, lang: lang, kinds: kinds)
      let actual: JSONValue = .array(out.map { v in
        ["form": .string(v.form), "norm": .string(v.norm), "tokens": .array(v.tokens.map(JSONValue.string)),
         "lang": v.lang.map(JSONValue.string) ?? .null, "type": .string(v.type), "rule": .string(v.rule),
         "status": .string(v.status), "enabled": .bool(v.enabled)]
      })
      let expected = c["out"] ?? .array([])
      r.check(CanonicalJSON.string(actual) == CanonicalJSON.string(expected), "\(id) \(surface) [\(lang ?? "null")]",
              expected: expected, actual: actual)
      let toks = Tokenizer.tokens(surface).tokens
      if !toks.isEmpty {
        r.check(Variants.scriptOfTokens(toks) == c["script"]?.stringValue, "\(id) script", expected: c["script"] ?? .null,
                actual: .string(Variants.scriptOfTokens(toks)))
        r.check(Variants.kindOfTokens(toks) == c["kind"]?.stringValue, "\(id) kind", expected: c["kind"] ?? .null,
                actual: .string(Variants.kindOfTokens(toks)))
      }
      let ident: [(norm: String, lang: String?, enabled: Bool)] = toks.isEmpty ? [] : [(toks.joined(separator: " "), lang, true)]
      let hash = Variants.variantsHash(ident + out.map { ($0.norm, $0.lang, $0.enabled) })
      r.check(hash == c["hash"]?.stringValue, "\(id) hash", expected: c["hash"] ?? .null, actual: .string(hash))
    }
    r.write()
    #expect(r.passed, "\(r.summary)")
  }

  @Test("g1.translit: romanKey and translitMatch")
  func translit() throws {
    let r = QueryGolden.Report("g1.translit")
    for c in try QueryGolden.load("g1.translit") {
      let id = c["id"]?.stringValue ?? "?"
      if let word = c["word"]?.stringValue {
        let key = Translit.romanKey(word)
        r.check(QueryGolden.same(key, c["key"]?.stringValue), "\(id) romanKey(\(word))", expected: c["key"] ?? .null, actual: .string(key))
      } else if let a = c["a"]?.stringValue, let b = c["b"]?.stringValue {
        let m = Translit.match(a, b)
        r.check(m == c["match"]?.boolValue, "\(id) match(\(a), \(b))", expected: c["match"] ?? .null, actual: .bool(m))
      } else if let k = c["minKey"]?.safeInteger {
        r.check(k == Translit.minKey, "MIN_KEY", expected: .number(Double(k)), actual: .number(Double(Translit.minKey)))
      }
    }
    r.write()
    #expect(r.passed, "\(r.summary)")
  }

  @Test("g1.names: the proper-noun guard (rules a, a', b, c) and its helpers")
  func names() throws {
    let r = QueryGolden.Report("g1.names")
    for c in try QueryGolden.load("g1.names") {
      let id = c["id"]?.stringValue ?? "?"
      switch c["kind"]?.stringValue ?? "" {
      case "body", "phrase", "title":
        let text = c["text"]?.stringValue ?? ""
        let units = Array(text.utf16)
        let start = c["start"]?.safeInteger ?? 0, end = c["end"]?.safeInteger ?? 0
        var index: NameIndex?
        if let n = c["names"]?.objectValue {
          index = NameIndex(names: n["names"]?.arrayValue?.compactMap(\.stringValue) ?? [], maxTokens: n["maxTokens"]?.safeInteger ?? 1)
        }
        let flag = Names.nameFlag(units, start: start, end: end, author: c["author"]?.stringValue,
                                  fieldClass: c["kind"]?.stringValue == "title" ? "title" : "text",
                                  clipStart: c["clipStart"]?.safeInteger ?? 0, clipEnd: c["clipEnd"]?.safeInteger, names: index)
        r.check(flag == c["flag"]?.boolValue, "\(id) \(c["kind"]?.stringValue ?? "") '\(String(text.prefix(80)))' [\(start), \(end))",
                expected: c["flag"] ?? .null, actual: .bool(flag))
      case "authorTokens":
        let set = Names.authorTokens(c["author"]?.stringValue)
        let want = c["tokens"]?.arrayValue?.compactMap(\.stringValue) ?? []
        r.check(set.count == Set(want.map { Array($0.utf16) }).count && want.allSatisfy(set.contains), "\(id) authorTokens",
                expected: c["tokens"] ?? .null)
      case "splitMakerNames":
        let out = Names.splitMakerNames(c["raw"]?.stringValue ?? "")
        let want = c["out"]?.arrayValue?.compactMap(\.stringValue) ?? []
        r.check(out.count == want.count && zip(out, want).allSatisfy { QueryGolden.same($0, $1) }, "\(id) splitMakerNames",
                expected: c["out"] ?? .null, actual: .array(out.map(JSONValue.string)))
      case "nameIndex":
        let ix = Names.nameIndex(c["input"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        let want = c["names"]?.arrayValue?.compactMap(\.stringValue) ?? []
        r.check(ix.names.count == want.count && zip(ix.names, want).allSatisfy { QueryGolden.same($0, $1) }
                  && ix.maxTokens == c["maxTokens"]?.safeInteger, "\(id) nameIndex",
                expected: c["names"] ?? .null, actual: .array(ix.names.map(JSONValue.string)))
      case "documentNameRule":
        let i = c["input"] ?? .null
        let out = Names.documentNameRule(flagged: i["flagged"]?.safeInteger ?? 0, lower: i["lower"]?.safeInteger ?? 0,
                                         capitalized: i["capitalized"]?.safeInteger ?? 0)
        r.check(out == c["out"]?.boolValue, "\(id) documentNameRule", expected: c["out"] ?? .null, actual: .bool(out))
      case "classes":
        let raw = c["raw"]?.stringValue ?? ""
        r.check(Names.isCapitalized(raw) == c["capitalized"]?.boolValue && Names.isCaseless(raw) == c["caseless"]?.boolValue,
                "\(id) classes of '\(raw)'", expected: c, actual: ["capitalized": .bool(Names.isCapitalized(raw)),
                                                                     "caseless": .bool(Names.isCaseless(raw))])
      default:
        r.check(false, "\(id): unknown case kind")
      }
    }
    r.write()
    #expect(r.passed, "\(r.summary)")
  }

  @Test("g1.kwic: KWIC lines from the original, clipped at the passage")
  func kwic() throws {
    let r = QueryGolden.Report("g1.kwic")
    for c in try QueryGolden.load("g1.kwic") {
      let id = c["id"]?.stringValue ?? "?"
      let text = Array((c["text"]?.stringValue ?? "").utf16)
      let start = c["start"]?.safeInteger ?? 0, end = c["end"]?.safeInteger ?? 0
      let line = Kwic.line(text, start: start, end: end, window: c["window"]?.safeInteger ?? 12,
                           clipStart: c["clipStart"]?.safeInteger ?? 0, clipEnd: c["clipEnd"]?.safeInteger)
      let s = { (u: [UInt16]) in String(decoding: u, as: UTF16.self) }
      let out = c["out"] ?? .null
      let ok = Array((out["left"]?.stringValue ?? "").utf16) == line.left && Array((out["match"]?.stringValue ?? "").utf16) == line.match
        && Array((out["right"]?.stringValue ?? "").utf16) == line.right
      r.check(ok, "\(id) [\(start), \(end))", expected: out,
              actual: ["left": .string(s(line.left)), "match": .string(s(line.match)), "right": .string(s(line.right))])
    }
    r.write()
    #expect(r.passed, "\(r.summary)")
  }
}
