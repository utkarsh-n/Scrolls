// OWNER: N0
// G1 exact comparisons of the text ports: token classes, tokenizer u61m-1, fold, the tokenizer helpers and the
// sentence breaker (IOS-SPEC §1.7, §2.2).

import CryptoKit
import Foundation
import ScrollsCore
import Testing

/// Code-unit equality of two JSON values through their canonical text (Swift's String == is canonical equivalence).
func sameJSON(_ a: JSONValue, _ b: JSONValue) -> Bool { Array(CanonicalJSON.string(a).utf8) == Array(CanonicalJSON.string(b).utf8) }
func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
func sha256(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

@Suite("G1 text goldens")
struct TextGoldenTests {
  @Test("g1.token-classes: the generated table equals Node's regex classes for every scalar")
  func tokenClasses() throws {
    let fam = try Golden.load("g1.token-classes")
    let report = Golden.Report(fam.name)
    let table = TokenClassTable.lookup
    var covered = 0
    for c in fam.cases {
      let lo = c["lo"]!.int!, hi = c["hi"]!.int!, mask = c["mask"]!.int!
      var bad: Int? = nil
      for cp in lo...hi where Int(table.classes(UInt32(cp)).rawValue) != mask { bad = cp; break }
      covered += hi - lo + 1
      let at = bad ?? lo
      report.check(bad == nil, "U+\(String(at, radix: 16, uppercase: true))", expected: .number(Double(mask)),
                   actual: .number(Double(table.classes(UInt32(at)).rawValue)))
    }
    report.write()
    #expect(covered == 0x110000)
    #expect(report.passed, "\(report.summary)")
  }

  @Test("Drift report: the frozen table against this runtime's Unicode properties (printed, never applied)")
  func unicodeDriftReport() {
    let table = TokenClassTable.lookup
    var drift: [String] = []
    var count = 0
    for cp in UInt32(0)...0x10FFFF {
      guard let scalar = Unicode.Scalar(cp) else { continue }
      let gc = scalar.properties.generalCategory
      var runtime: UnicodeClass = []
      switch gc {
      case .uppercaseLetter: runtime = [.letter, .uppercase]
      case .lowercaseLetter: runtime = [.letter, .lowercase]
      case .titlecaseLetter: runtime = [.letter, .titlecase]
      case .modifierLetter, .otherLetter: runtime = .letter
      case .nonspacingMark, .spacingMark, .enclosingMark: runtime = .mark
      case .decimalNumber, .letterNumber, .otherNumber: runtime = .number
      case .privateUse: runtime = .privateUse
      case .otherSymbol: runtime = .otherSymbol
      case .spaceSeparator, .lineSeparator, .paragraphSeparator: runtime = .separator
      case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation, .initialPunctuation,
        .finalPunctuation, .otherPunctuation: runtime = .punctuation
      default: runtime = []
      }
      let general: UnicodeClass = [.letter, .mark, .number, .privateUse, .otherSymbol, .uppercase, .lowercase, .titlecase,
                                   .separator, .punctuation]
      if table.classes(cp).intersection(general) != runtime {
        count += 1
        if drift.count < 10 { drift.append("U+\(String(cp, radix: 16, uppercase: true))") }
      }
    }
    print("Unicode drift (u61m-1 table, Unicode \(TokenClassTable.unicodeVersion), vs runtime): \(count) scalars differ\(drift.isEmpty ? "" : ", e.g. \(drift.joined(separator: " "))")")
  }

  @Test("g1.tokenize: tokens, offsets and norms equal tokenize() of the reference")
  func tokenize() throws {
    let fam = try Golden.load("g1.tokenize")
    let report = Golden.Report(fam.name)
    for c in fam.cases { checkTokenCase(c, report) }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.tokenize-corpus (private): the rest of the 5,000 sampled corpus passages",
        .enabled(if: Golden.available("g1.tokenize-corpus"), "private family absent on this Mac"))
  func tokenizeCorpus() throws {
    let fam = try Golden.load("g1.tokenize-corpus")
    let report = Golden.Report(fam.name)
    for c in fam.cases { checkTokenCase(c, report) }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  private func checkTokenCase(_ c: JSONValue, _ report: Golden.Report) {
    let text = c["text"]!.stringValue!
    let got = Tokenizer.tokens(text)
    // the interned path must give the same spans and norms as the convenience one
    let interner = TokenInterner()
    var spans: [TokenSpan] = []
    Array(text.utf16).withUnsafeBufferPointer { Tokenizer.spans($0, interner: interner, into: &spans) }
    let internedOK = spans.count == got.tokens.count
      && zip(spans, got.tokens.indices).allSatisfy { s, i in
        s.start == got.starts[i] && s.end == got.ends[i] && same(interner.norm(s.norm), got.tokens[i])
      }
    let source = c["source"]?.stringValue ?? "?"
    let actual: JSONValue = ["tokens": .array(got.tokens.map(JSONValue.string)), "starts": .array(got.starts.map { .number(Double($0)) }),
                             "ends": .array(got.ends.map { .number(Double($0)) })]
    if let tokens = c["tokens"]?.strings {
      let ok = tokens.count == got.tokens.count && zip(tokens, got.tokens).allSatisfy(same)
        && c["starts"]!.ints! == got.starts.map(Int.init) && c["ends"]!.ints! == got.ends.map(Int.init)
      report.check(ok && internedOK, source, expected: c, actual: actual)
    } else {
      let starts = undelta(c["starts_delta"]!.ints!)
      let ends = zip(starts, c["lens"]!.ints!).map { $0 + $1 }
      let ok = c["count"]!.int! == got.tokens.count && starts == got.starts.map(Int.init) && ends == got.ends.map(Int.init)
        && c["norms_sha256"]!.stringValue! == sha256(got.tokens.joined(separator: " "))
      report.check(ok && internedOK, source, expected: c, actual: actual)
    }
  }

  @Test("g1.fold: foldToken over every scalar and the word contexts (Final_Sigma, NFC, digits, joiners)")
  func fold() throws {
    let fam = try Golden.load("g1.fold")
    let report = Golden.Report(fam.name)
    var changed: [UInt32: String] = [:]
    for c in fam.cases {
      if let cp = c["cp"]?.int { changed[UInt32(cp)] = c["fold"]!.stringValue! }
    }
    for cp in UInt32(0)...0x10FFFF {
      guard let scalar = Unicode.Scalar(cp) else { continue }
      let s = String(Character(scalar))
      let expected = changed[cp] ?? s
      let got = Fold.fold(s)
      report.check(same(got, expected), "U+\(String(cp, radix: 16, uppercase: true))", expected: .string(expected), actual: .string(got))
    }
    for c in fam.cases {
      guard let text = c["text"]?.stringValue else { continue }
      let got = Fold.fold(text)
      report.check(same(got, c["fold"]!.stringValue!), text, expected: c["fold"]!, actual: .string(got))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.text-helpers: findSequence, ftsPhrase and isSentenceInitial")
  func helpers() throws {
    let fam = try Golden.load("g1.text-helpers")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      switch c["fn"]!.stringValue! {
      case "findSequence":
        let got = Tokenizer.findSequence(c["tokens"]!.strings!, c["seq"]!.strings!, from: c["from"]!.int!)
        report.check(got == c["out"]!.int!, "findSequence", expected: c["out"]!, actual: .number(Double(got)))
      case "ftsPhrase":
        let got = try? Tokenizer.ftsPhrase(c["s"]!.stringValue!)
        let ok = c["error"]!.isNull ? got.map { same($0, c["out"]!.stringValue!) } ?? false : got == nil
        report.check(ok, c["s"]!.stringValue!, expected: c["out"]!, actual: got.map(JSONValue.string) ?? .null)
      case "isSentenceInitial":
        let got = Tokenizer.isSentenceInitial(c["text"]!.stringValue!, c["start"]!.int!)
        report.check(got == c["out"]!.boolValue!, "\(c["text"]!.stringValue!.debugDescription) @\(c["start"]!.int!)",
                     expected: c["out"]!, actual: .bool(got))
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.sentences: sentence boundaries of the demo documents and edge strings (Intl.Segmenter + ।/॥)")
  func sentences() throws {
    let fam = try Golden.load("g1.sentences")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let got = SentenceBreaker.starts(c["text"]!.stringValue!)
      report.check(got == c["starts"]!.ints!, c["source"]!.stringValue!, expected: c["starts"]!,
                   actual: .array(got.map { .number(Double($0)) }))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.sentences-books (private): 30 Cipher Gutenberg + 10 Wikisource + 10 STEMM books",
        .enabled(if: Golden.available("g1.sentences-books"), "private family absent on this Mac"))
  func sentencesBooks() throws {
    let fam = try Golden.load("g1.sentences-books")
    let report = Golden.Report(fam.name)
    var boundaries = 0, matched = 0
    for c in fam.cases {
      let text = c["text"]!.stringValue!
      let expected = undelta(c["starts_delta"]!.ints!)
      let got = SentenceBreaker.starts(text)
      boundaries += expected.count
      matched += Set(expected).intersection(got).count
      let firstDiff = zip(expected, got).enumerated().first { $0.element.0 != $0.element.1 }?.offset ?? min(expected.count, got.count)
      report.check(got == expected && sha256(text) == c["text_sha256"]!.stringValue!, c["source"]!.stringValue!,
                   expected: ["count": .number(Double(expected.count)), "first_diff_index": .number(Double(firstDiff))],
                   actual: ["count": .number(Double(got.count))])
    }
    print("g1.sentences-books: \(matched) of \(boundaries) reference boundaries found by SentenceBreaker")
    report.write()
    #expect(report.passed, "\(report.summary)")
  }
}
