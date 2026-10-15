// OWNER: N0
// Sentence boundaries for segmenter seg-1's long-block splits (server/text/segment.mjs sentenceBoundaries): the starts
// of the sentences Intl.Segmenter finds, plus the end of every run of danda (।) / double danda (॥).
//
// The starts of NSString's .bySentences ENCLOSING ranges equal Intl.Segmenter's segment starts on 562,089 of 562,089
// boundaries over 30 Cipher books; NLTokenizer(.sentence) missed 6,507 (IOS-SPEC §0.2, DV-3). The enumeration is
// locale-independent (root ICU rules), as Intl.Segmenter is for the en/es/fr/hi/gu documents of the corpus.

import Foundation

/// Sentence boundaries of seg-1.
public enum SentenceBreaker {
  /// The interior sentence boundaries of `s` (UTF-16 offsets strictly between 0 and the length), sorted and unique:
  /// every sentence start after the first, and the end of every ।/॥ run.
  public static func starts(_ s: String) -> [Int] {
    let ns = s as NSString
    let n = ns.length
    guard n > 0 else { return [] }
    var out = Set<Int>()
    ns.enumerateSubstrings(in: NSRange(location: 0, length: n), options: [.bySentences, .substringNotRequired]) {
      _, _, enclosing, _ in
      if enclosing.location > 0 { out.insert(enclosing.location) }
    }
    var i = 0
    while i < n {
      let c = ns.character(at: i)
      if c == 0x0964 || c == 0x0965 {
        var j = i + 1
        while j < n, ns.character(at: j) == 0x0964 || ns.character(at: j) == 0x0965 { j += 1 }
        out.insert(j)
        i = j
      } else {
        i += 1
      }
    }
    return out.filter { $0 > 0 && $0 < n }.sorted()
  }
}
