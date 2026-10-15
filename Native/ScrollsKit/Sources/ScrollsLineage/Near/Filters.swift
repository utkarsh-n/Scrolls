// OWNER: N5
// Port of server/lineage/filters.mjs (SPEC §4.7, §13 rules 6 and 9): what shared wording is NOT a quotation. Each
// filter is counted where it is used, so the exclusions stay visible:
//  · structure — a run made of numbering or layout: fewer than 4 distinct tokens, one token over 40% of the run, fewer
//    than 2 content words, or at least half numerals; and lists of names or titles (≥ 60% capitalised words);
//  · production-line text — wording a production line puts into many files at the same place (transcriber's notes,
//    advertisements, licence preambles): ≥ 3 documents, ≥ 80% of the occurrences in the first or last 15% of a body;
//  · widely shared text (> 25 documents) belongs to the "widely shared text" node, never to a pair.
// Token ids are FNV-1a hashes, so numeral classes are learnt from the strings as they are read (`TokenClasses`).

import Foundation
import ScrollsCore

public enum Filters {
  /// Production-line thresholds.
  public enum Production {
    public static let minDocs = 3
    public static let edgeShare = 0.8
    public static let runShare = 0.5
    public static let edge = 0.15
    public static let minDocTokens = 1000
  }

  /// Share of capitalised words at which a run is a list of names or titles.
  public static let listCapitals = 0.6
  static let stopLangs = ["en", "fr", "es", "de", "la", "it", "pt", "hi", "gu"]
  /// Pieces of contractions the tokenizer splits off ("don't" → don + t): never content words.
  static let fragments = ["don", "didn", "doesn", "isn", "wasn", "weren", "aren", "couldn", "wouldn", "shouldn", "won", "hasn",
                          "haven", "hadn", "mustn", "needn", "ain", "ll", "re", "ve", "em"]

  /// `stopIds()`: token ids of the function words of every stop-list language and the contraction fragments.
  public static let stopIds: Set<UInt32> = {
    var s = Set<UInt32>()
    for l in stopLangs { for w in LineageStopwords.lists.first(where: { $0.lang == l })?.words ?? [] { s.insert(IDs.fnv1a32(w)) } }
    for w in fragments { s.insert(IDs.fnv1a32(w)) }
    return s
  }()

  /// trace.mjs `isStop`: the folded token is a stop word of one of the nine languages (compared by code units).
  public static let stopWords: Set<[UInt16]> = {
    var s = Set<[UInt16]>()
    for l in stopLangs { for w in LineageStopwords.lists.first(where: { $0.lang == l })?.words ?? [] { s.insert(Array(w.utf16)) } }
    return s
  }()

  public static func isStop(_ token: String) -> Bool { stopWords.contains(Array(token.utf16)) }

  /// `/^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/`.
  static let roman = try! NSRegularExpression(pattern: "^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$")

  /// `isNumeral(token)`: digits (`^\p{N}+$`), or a roman numeral.
  public static func isNumeral(_ token: String) -> Bool {
    if !token.isEmpty && token.unicodeScalars.allSatisfy({ [.decimalNumber, .letterNumber, .otherNumber].contains($0.properties.generalCategory) }) {
      return true
    }
    guard !token.utf16.isEmpty else { return false }
    let ns = token as NSString
    return roman.firstMatch(in: token, range: NSRange(location: 0, length: ns.length)) != nil
  }

  /// `TokenClasses`: numeral ids learnt from token strings (single characters count with the numerals: neither is
  /// wording).
  public final class TokenClasses {
    public private(set) var numerals = Set<UInt32>()
    public init() {}
    public func see(_ token: String, _ id: UInt32) {
      if isNumeral(token) || token.unicodeScalars.count == 1 { numerals.insert(id) }
    }
  }

  /// `isNameList(text)`: at least 60% of the words start with a capital letter (scripts without case never qualify).
  public static func isNameList(_ text: String) -> Bool {
    let tk = Tokenizer.tokens(text)
    let n = tk.tokens.count
    if n < 4 { return false }
    let u = Array(text.utf16)
    var caps = 0
    for i in 0..<n {
      let s = Int(tk.starts[i])
      guard s < u.count else { continue }
      var cp = UInt32(u[s])
      // /^\p{Lu}/u over text.slice(start, start + 2): a surrogate pair is one character
      if u[s] >= 0xD800, u[s] <= 0xDBFF, s + 1 < u.count, u[s + 1] >= 0xDC00, u[s + 1] <= 0xDFFF {
        cp = 0x10000 + ((UInt32(u[s]) - 0xD800) << 10) + (UInt32(u[s + 1]) - 0xDC00)
      }
      if let scalar = Unicode.Scalar(cp), scalar.properties.generalCategory == .uppercaseLetter { caps += 1 }
    }
    return Double(caps) >= listCapitals * Double(n)
  }

  /// `informative(ids, a0, a1, classes)`: ids[a0..<a1] carries wording rather than structure.
  public static func informative(_ ids: [UInt32], _ a0: Int, _ a1: Int, _ classes: TokenClasses? = nil) -> Bool {
    var freq: [UInt32: Int] = [:]
    var maxN = 0, content = 0, numerals = 0
    for i in a0..<a1 {
      let id = ids[i]
      let n = (freq[id] ?? 0) + 1
      freq[id] = n
      if n > maxN { maxN = n }
      if classes?.numerals.contains(id) == true {
        numerals += 1
      } else if !stopIds.contains(id) {
        content += 1
      }
    }
    let len = a1 - a0
    return freq.count >= 4 && Double(maxN) <= 0.4 * Double(len) && content >= 2 && numerals * 2 < len
  }

  /// `contentTokens(ids, a0, a1, classes)`: tokens that are neither function words nor numerals.
  public static func contentTokens(_ ids: [UInt32], _ a0: Int, _ a1: Int, _ classes: TokenClasses? = nil) -> Int {
    var n = 0
    for i in a0..<a1 where !stopIds.contains(ids[i]) && classes?.numerals.contains(ids[i]) != true { n += 1 }
    return n
  }

  /// `inEdgeZone(pos, len, edge)`: the first or last `edge` share of a document of ≥ 1,000 tokens.
  public static func inEdgeZone(_ pos: Int, _ len: Int, edge: Double = Production.edge) -> Bool {
    len >= Production.minDocTokens && (Double(pos) < edge * Double(len) || Double(pos) >= (1 - edge) * Double(len))
  }
}
