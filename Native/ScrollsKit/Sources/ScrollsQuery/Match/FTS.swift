// OWNER: N3
// Port of server/aggregate/fts.mjs (SPEC §4.4, §4.6): FTS5 candidates and preliminary passage-hit counts. passage_fts
// indexes the folded token string of every passage (FTS token i = JS token i) and adds accent-insensitivity, so a phrase
// MATCH returns a SUPERSET of the passages where the exact folded sequence occurs; materialization then matches tokens
// exactly. FTS hits are never counts: they are labelled "preliminary: passages containing".

import ScrollsCore
import ScrollsStore

/// A candidate passage with what matching needs (fts.passageRows).
public struct CandidatePassage: Sendable, Equatable {
  public var id: Int64
  public var documentId: Int64
  public var field: String
  public var fieldClass: String
  public var timeRole: String
  public var quality: String
  public var startOff: Int
  public var endOff: Int
  public var lang: String
  public var tokenCount: Int
  public var author: String?
  public var isSynthetic: Bool
  public var yLo: Int?
  public var chronoStatus: String
  public var corpusId: Int64
  public var collectionId: Int64
}

/// FTS candidate search.
public enum FTS {
  /// `ftsQueryString(phrases)`: phrases OR-ed, distinct, in order.
  public static func queryString(_ phrases: [[String]]) throws -> String {
    var parts: [String] = []
    for p in phrases where !p.isEmpty {
      let q = try Tokenizer.ftsPhrase(p)
      if !parts.contains(where: { JSString.equal($0, q) }) { parts.append(q) }
    }
    if parts.isEmpty { throw ScrollsErrorBridge.range("ftsQueryString: no non-empty phrase") }
    return parts.joined(separator: " OR ")
  }

  private static func scopeBindings(_ corpusId: Int64?, _ collections: [Int64]?) -> [SQLValue] {
    var out: [SQLValue] = []
    if let corpusId { out.append(.int(corpusId)) }
    if let collections { out.append(.text(SQLJSON.ints(collections))) }
    return out
  }

  /// `ftsCandidates`: candidate passage ids, ascending.
  public static func candidates(_ c: Connection, phrases: [[String]], corpusId: Int64? = nil, collections: [Int64]? = nil) throws -> [Int64] {
    let s = try c.prepared(MatchSQL.candidates[MatchSQL.scopeIndex(corpus: corpusId != nil, collections: collections != nil)])
    try s.bind([.text(try queryString(phrases))] + scopeBindings(corpusId, collections))
    return try s.all { $0.int(0) }.sorted()
  }

  /// `sampleCandidates`: up to `cap` candidates with their language.
  public static func sample(_ c: Connection, phrases: [[String]], corpusId: Int64? = nil, collections: [Int64]? = nil,
                            cap: Int = 2000) throws -> [(id: Int64, lang: String)] {
    let s = try c.prepared(MatchSQL.samples[MatchSQL.scopeIndex(corpus: corpusId != nil, collections: collections != nil)])
    try s.bind([.text(try queryString(phrases))] + scopeBindings(corpusId, collections) + [.int(Int64(cap))])
    return try s.all { ($0.int(0), $0.text(1)) }
  }

  /// `passageHitCounts`: passages and documents whose folded text contains any phrase, and the undated documents.
  public static func hitCounts(_ c: Connection, phrases: [[String]], corpusId: Int64? = nil,
                               collections: [Int64]? = nil) throws -> (passages: Int, documents: Int, undated: Int) {
    let s = try c.prepared(MatchSQL.hitCounts[MatchSQL.scopeIndex(corpus: corpusId != nil, collections: collections != nil)])
    try s.bind([.text(try queryString(phrases))] + scopeBindings(corpusId, collections))
    return try s.first { (Int($0.int(0)), Int($0.int(1)), Int($0.int(2))) } ?? (0, 0, 0)
  }

  /// `passageRows(ids)`: candidate rows ordered by document, field and offset.
  public static func passageRows(_ c: Connection, _ ids: [Int64]) throws -> [CandidatePassage] {
    if ids.isEmpty { return [] }
    let s = try c.prepared(MatchSQL.passageRows)
    try s.bind([.text(SQLJSON.ints(ids))])
    return try s.all { r in
      CandidatePassage(id: r.int(0), documentId: r.int(1), field: r.text(2), fieldClass: r.text(3), timeRole: r.text(4),
                       quality: r.text(5), startOff: Int(r.int(6)), endOff: Int(r.int(7)), lang: r.text(8),
                       tokenCount: Int(r.int(9)), author: r.textOrNil(10), isSynthetic: r.int(11) == 1,
                       yLo: r.intOrNil(12).map(Int.init), chronoStatus: r.text(13), corpusId: r.int(14), collectionId: r.int(15))
    }
  }

  /// `ftsTerm(token)`: the term FTS stores for a folded token (Latin diacritics stripped).
  public static func term(_ token: String) -> String {
    if !JSText.any(token, .latin) { return token }
    return JSText.nfc(JSText.removeMarks(JSText.nfd(token)))
  }

  /// `termCounts(term)`: per-passage instance counts of one FTS term.
  public static func termCounts(_ c: Connection, _ term: String) throws -> [(passage: Int64, n: Int)] {
    let s = try c.prepared(MatchSQL.termCounts)
    try s.bind([.text(term)])
    return try s.all { ($0.int(0), Int($0.int(1))) }
  }

  /// `termInstanceEstimate(tokens)`: instances of the distinct FTS terms of single-token variants.
  public static func termInstanceEstimate(_ c: Connection, _ tokens: [String]) throws -> Int {
    var seen = JSStringSet()
    var n = 0
    for t in tokens.map(term) where seen.insert(t) {
      n += Int(try c.prepared(MatchSQL.termRow).bindingFirst([.text(t)]) { $0.int(0) } ?? 0)
    }
    return n
  }
}

/// JSON arrays bound to `json_each(?)`, written as `JSON.stringify` writes them.
public enum SQLJSON {
  public static func ints(_ xs: [Int64]) -> String { "[" + xs.map(String.init).joined(separator: ",") + "]" }
  public static func ints(_ xs: [Int]) -> String { "[" + xs.map(String.init).joined(separator: ",") + "]" }
  public static func strings(_ xs: [String]) -> String { "[" + xs.map(CanonicalJSON.quote).joined(separator: ",") + "]" }
}

/// Errors with the reference's shapes.
enum ScrollsErrorBridge {
  struct RangeError: Error, CustomStringConvertible {
    let description: String
  }
  static func range(_ m: String) -> RangeError { RangeError(description: m) }
}
