// OWNER: N3
// Exact token-sequence matching (materialize.mjs matchTokens / matchPassages): every candidate passage is tokenized with
// u61m-1 over its ORIGINAL text, the enabled variants' folded sequences are found exactly (at one start the longest
// sequence wins), offsets are absolute UTF-16 offsets of the document coordinate base, and single-word matches pass the
// proper-noun guard. Tokens are interned so each distinct raw form is folded once (IOS-SPEC §0.2).

import ScrollsCore
import ScrollsStore

/// One variant's folded token sequence.
public struct VariantSeq: Sendable, Equatable {
  public var id: Int64
  public var seq: [String]
  public init(id: Int64, seq: [String]) {
    self.id = id
    self.seq = seq
  }
}

/// One exact match inside a passage.
public struct PassageMatch: Sendable, Equatable {
  /// Absolute offsets (document coordinate base).
  public var start: Int
  public var end: Int
  public var tokIndex: Int
  public var variantId: Int64
  public var nameFlag: Bool
  /// A single word (or a possessive "Gene's"): the guard applies.
  public var word: Bool
  /// The word is capitalized.
  public var cap: Bool
  /// A reader's override decided the flag.
  public var overridden: Bool
}

/// The matches of one passage.
public struct PassageMatches: Sendable {
  public var passage: CandidatePassage
  public var matches: [PassageMatch]
}

/// Matching.
public enum Matching {
  /// `matchTokens(tokens, seqs)`: all matches; at one start the longest sequence wins; sorted by start index.
  public static func matchTokens(_ tokens: [TokenID], _ seqs: [(id: Int64, seq: [TokenID])]) -> [(i: Int, len: Int, variantId: Int64)] {
    var best: [Int: (i: Int, len: Int, variantId: Int64)] = [:]
    for (id, seq) in seqs {
      let n = seq.count
      guard n > 0, tokens.count >= n else { continue }
      var i = 0
      while i <= tokens.count - n {
        if tokens[i] == seq[0] {
          var k = 1
          while k < n && tokens[i + k] == seq[k] { k += 1 }
          if k == n {
            if let cur = best[i] {
              if n > cur.len { best[i] = (i, n, id) }
            } else {
              best[i] = (i, n, id)
            }
          }
        }
        i += 1
      }
    }
    return best.values.sorted { $0.i < $1.i }
  }

  /// `matchPassages(db, passages, seqs, {guard, names, overrides})`.
  public static func matchPassages(_ c: Connection, text: TextAccess, _ passages: [CandidatePassage], _ seqs: [VariantSeq],
                                   guardNames: Bool = true, names: NameIndex? = nil,
                                   overrides: [String: String] = [:]) throws -> [PassageMatches] {
    let interner = TokenInterner()
    let seqIDs = seqs.map { (id: $0.id, seq: $0.seq.map { interner.intern(norm: $0) }) }
    let sID = interner.intern(norm: "s")
    var out: [PassageMatches] = []
    var authorDoc: Int64?
    var authorSet = JSStringSet()
    var spans: [TokenSpan] = []
    for p in passages {
      let units = try text.passage(c, doc: p.documentId, field: p.field, start: p.startOff, end: p.endOff)
      spans.removeAll(keepingCapacity: true)
      units.withUnsafeBufferPointer { Tokenizer.spans($0, interner: interner, into: &spans) }
      let ids = spans.map(\.norm)
      let hits = matchTokens(ids, seqIDs)
      if hits.isEmpty { continue }
      if authorDoc != p.documentId {
        authorDoc = p.documentId
        authorSet = Names.authorTokens(p.author)
      }
      let tok = TokenList(tokens: spans.map { interner.norm($0.norm) }, starts: spans.map(\.start), ends: spans.map(\.end))
      var matches: [PassageMatch] = []
      for h in hits {
        let s = Int(tok.starts[h.i]), e = Int(tok.ends[h.i + h.len - 1])
        let word = h.len == 1 || (h.len == 2 && ids[h.i + 1] == sID)
        let wordEnd = Int(tok.ends[h.i])
        var flag = guardNames && word
          && Names.nameFlag(units, start: s, end: wordEnd, authorSet: authorSet, fieldClass: p.fieldClass, names: names, tok: tok)
        let o = overrides["\(p.documentId):\(p.field):\(p.startOff + s)"]
        if o == "count" { flag = false } else if o == "exclude" { flag = true }
        let raw = String(decoding: units[s..<wordEnd], as: UTF16.self)
        matches.append(PassageMatch(start: p.startOff + s, end: p.startOff + e, tokIndex: h.i, variantId: h.variantId,
                                    nameFlag: flag, word: word, cap: Names.isCapitalized(raw),
                                    overridden: o == "count" || o == "exclude"))
      }
      out.append(PassageMatches(passage: p, matches: matches))
    }
    return out
  }
}
