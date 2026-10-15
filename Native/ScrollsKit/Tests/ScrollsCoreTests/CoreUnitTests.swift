// OWNER: N0
// Unit tests of ScrollsCore behaviour that the goldens do not reach: JSON.parse's rejections, Codable round trips, the
// saved-view hash, and a source lint over ScrollsCore itself (the package-wide LintTests live with the app shell).

import Foundation
import ScrollsCore
import Testing

@Suite("ScrollsCore units")
struct CoreUnitTests {
  @Test("JSONValue.parse rejects what JSON.parse rejects", arguments: [
    "", " ", "[1,]", "{\"a\":1,}", "01", "-", "1.", ".5", "1e", "+1", "NaN", "Infinity", "'x'", "\"\u{1}\"", "[1 2]", "{1:2}",
    "\u{FEFF}1", "\"\\x\"", "\"\\u12\"", "tru", "nul", "[", "{\"a\"}", "1 2",
  ])
  func parseRejects(_ text: String) {
    #expect(throws: JSONParseError.self) { try JSONValue.parse(text) }
  }

  @Test("JSONValue.parse: duplicate keys keep the last value, -0 stays negative, overflow is infinity, lone surrogates become U+FFFD")
  func parseSemantics() throws {
    #expect(try JSONValue.parse(#"{"a":1,"a":2}"#) == ["a": 2])
    #expect(try JSONValue.parse("-0").numberValue?.sign == .minus)
    #expect(try JSONValue.parse("1e400").numberValue == .infinity)
    #expect(try JSONValue.parse(#""\ud800x""#).stringValue == "\u{FFFD}x")
    #expect(try JSONValue.parse(#""\ud83d\ude00""#).stringValue == "😀")
    #expect(try JSONValue.parse(" [true, false, null, \"\\/\"] ") == [true, false, nil, "/"])
  }

  @Test("JSONValue object keys pass a snake_case encoder and decoder verbatim (payloads are not contract keys)")
  func keyStrategies() throws {
    let v: JSONValue = ["timeBasis": 1, "data_version": 2, "nested": ["centerDay": true]]
    let enc = JSONEncoder()
    enc.keyEncodingStrategy = .convertToSnakeCase
    let data = try enc.encode(v)
    #expect(try JSONValue.parse(data) == v)
    let dec = JSONDecoder()
    dec.keyDecodingStrategy = .convertFromSnakeCase
    #expect(try dec.decode(JSONValue.self, from: data) == v)
  }

  @Test("CanonicalJSON sorts keys by UTF-16 code units, as Array.prototype.sort does")
  func canonicalOrder() {
    // U+FF5E (BMP) sorts after the surrogate pair of U+1F600 in UTF-16 order, before it in scalar order
    let v: JSONValue = ["\u{FF5E}": 1, "😀": 2, "b": 3, "a": 4]
    #expect(CanonicalJSON.string(v) == #"{"a":4,"b":3,"😀":2,"～":1}"#)
  }

  @Test("A saved-view hash is not a state: ViewState(hash:) throws with the reference")
  func savedViewHash() {
    #expect(throws: ViewStateNeedsSavedView.self) { try ViewState(hash: "#view=my-view&as=1&c=cipher") }
    let r = ViewState.decodeHash("#view=my-view&as=1&c=cipher")
    #expect(r.view == SavedViewReference(slug: "my-view", asSaved: true))
    #expect(r.state.corpus == "cipher")
  }

  @Test("decode(encode(s)) == canonicalize(s), and ViewState round-trips through Codable")
  func viewStateRoundTrip() throws {
    var s = ViewState.defaultState("cipher")
    s.strands = [.init(type: "expression", id: .number(12), variants: .ids([3, 7]), glyph: "circle")]
    s.selection = .init(type: "bin", id: .string("L3:190:x"))
    s.lineage.root = "etymon:sa:शून्य"
    let back = try ViewState(hash: s.hash)
    #expect(back == s.canonicalized())
    let data = try JSONEncoder().encode(s)
    #expect(try JSONDecoder().decode(ViewState.self, from: data) == s.canonicalized())
  }

  @Test("DateParse encodes as the reference's object and decodes back, also through snake_case key strategies")
  func dateParseCodable() throws {
    let ctx = DateContext(now: DayMath.dayFromYMD(2026, 10, 4))
    let enc = JSONEncoder()
    enc.keyEncodingStrategy = .convertToSnakeCase
    let dec = JSONDecoder()
    dec.keyDecodingStrategy = .convertFromSnakeCase
    for raw in ["c. 1894", "17 May 1994", "2019-02-30", "n.d.", "संवत 1987"] {
      let p = DateGrammar.parse(raw, context: ctx)
      let data = try enc.encode(p)
      #expect(try JSONValue.parse(data) == p.jsonValue, "\(raw)")
      let back = try dec.decode(DateParse.self, from: data)
      #expect(back.loDay == p.loDay && back.yHi == p.yHi && back.label == p.label && back.approx == p.approx
              && back.issue == p.issue, "\(raw)")
    }
  }

  @Test("The date grammar reads the §5.3 examples with their rules")
  func dateExamples() {
    let ctx = DateContext(now: DayMath.dayFromYMD(2026, 10, 4))
    let cases: [(String, String, String)] = [
      ("1931-04-07", "iso_day", "7 Apr 1931"), ("c. 1931", "circa", "c. 1931"), ("the 1800s", "hundreds", "1800s"),
      ("early 19th century", "century_part", "early 19th century"), ("500 BCE", "bce", "500 BCE"),
      ("संवत 1987", "vikram_samvat", "1930–1931 (VS 1987)"), ("spring 1850", "season", "Mar–May 1850"),
      ("२ अक्टूबर १८६९", "dmy_named", "2 Oct 1869"), ("2030", "year+future", "2030"),
    ]
    for (raw, rule, label) in cases {
      let p = DateGrammar.parse(raw, context: ctx)
      #expect(p.rule == rule && p.label == label, "\(raw) → \(p.rule) \(p.label)")
    }
    #expect(DateGrammar.parse("2019-02-30", context: ctx).issue?.code == "E_DATE_INVALID")
    #expect(DateGrammar.parse("'90s", context: ctx).issue?.code == "E_DATE_AMBIGUOUS")
  }

  @Test("Fold keeps Final_Sigma and the tokenizer keeps joiners inside words")
  func foldAndTokens() {
    #expect(Fold.fold("ΟΔΟΣ ΣΑΣ") == "οδος σας")
    #expect(Tokenizer.tokenize("क्\u{200D}ष").map(\.norm) == ["क्ष"])
    #expect(Tokenizer.tokenize("❤\u{FE0F} ᙭x").map(\.norm) == ["❤\u{FE0F}", "x"])
  }

  @Test("ScrollsCore source lint: no Swift String lowercasing, no networking API, no LabKit")
  func sourceLint() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/ScrollsCore")
    // spelled in pieces so that this file does not trip the same lint
    let banned = [".lower" + "cased()", "URL" + "Session", "NW" + "Connection", "import " + "Network", "CF" + "Socket",
                  "import " + "LabKit"]
    var offences: [String] = []
    let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
    var swiftFiles = 0
    for url in files where url.pathExtension == "swift" {
      swiftFiles += 1
      let text = try String(contentsOf: url, encoding: .utf8)
      for word in banned where text.contains(word) { offences.append("\(url.lastPathComponent): \(word)") }
      #expect(text.hasPrefix("// OWNER: N0"), "\(url.lastPathComponent) must start with its owner line")
    }
    #expect(swiftFiles > 20)
    #expect(offences.isEmpty, "\(offences)")
  }
}
