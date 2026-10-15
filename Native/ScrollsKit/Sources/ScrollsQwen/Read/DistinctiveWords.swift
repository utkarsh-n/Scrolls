// OWNER: Q (created by the bring-up, B2)
// Computed words per group (IOS-SPEC-QWEN §3.6 step 1): weighted log-odds with an informative Dirichlet prior
// (Monroe, Colaresi & Quinn 2008), each group against the rest, over the engine's folded words within ±10 of the
// target. The card shows the top 4 with z ≥ 1.96 and in-group count ≥ 3 ("machine label: …"); the label prompt gets
// up to 10 words with z > 0 and count ≥ 2. N4 owns the production version; this one serves the bring-up's demo.

import Foundation
import ScrollsCore

public enum Stopwords {
  /// A small English list (function words and the commonest verbs); folded forms.
  public static let english: Set<String> = [
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at", "be",
    "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could", "did", "do", "does",
    "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her",
    "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
    "just", "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or",
    "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than",
    "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those",
    "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which",
    "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself", "yourselves", "upon",
    "said", "one", "two", "s", "t", "thou", "thee", "thy", "ye", "shall", "may", "might", "must", "also", "yet",
    "let", "us", "came", "come", "went", "go", "made", "make", "like", "well", "much", "many", "little",
    "every", "ever", "never", "still", "though", "without", "within", "toward", "towards", "among", "along",
  ]
}

public enum DistinctiveWords {
  public struct Scored: Sendable, Equatable, Codable {
    public var word: String
    public var z: Double
    public var count: Int
  }

  /// `contexts[g]` = the folded context words of group g's members. Excludes stop-words, words shorter than 3
  /// letters, words with digits, and `exclude` (the target's forms).
  public static func score(_ contexts: [[[String]]], exclude: Set<String>, alpha0: Double = 100) -> [[Scored]] {
    func keep(_ w: String) -> Bool {
      w.count >= 3 && !Stopwords.english.contains(w) && !exclude.contains(w)
        && !w.unicodeScalars.contains { CharacterSet.decimalDigits.contains($0) }
    }
    var groupCounts: [[String: Int]] = contexts.map { members in
      var c: [String: Int] = [:]
      for m in members { for w in m where keep(w) { c[w, default: 0] += 1 } }
      return c
    }
    var total: [String: Int] = [:]
    for c in groupCounts { for (w, n) in c { total[w, default: 0] += n } }
    let grand = Double(max(1, total.values.reduce(0, +)))
    var out: [[Scored]] = []
    for g in groupCounts.indices {
      let yi = groupCounts[g]
      let ni = Double(yi.values.reduce(0, +))
      let nj = grand - ni
      var scored: [Scored] = []
      for (w, tw) in total {
        let a = alpha0 * Double(tw) / grand
        let y1 = Double(yi[w] ?? 0)
        let y2 = Double(tw) - y1
        guard y1 > 0 else { continue }
        let l1 = log((y1 + a) / max(1e-9, ni + alpha0 - y1 - a))
        let l2 = log((y2 + a) / max(1e-9, nj + alpha0 - y2 - a))
        let v = 1 / (y1 + a) + 1 / (y2 + a)
        scored.append(Scored(word: w, z: (l1 - l2) / v.squareRoot(), count: Int(y1)))
      }
      scored.sort { $0.z != $1.z ? $0.z > $1.z : $0.word < $1.word }
      out.append(scored)
    }
    groupCounts.removeAll()
    return out
  }

  /// The folded engine words within ±`radius` of the target (UTF-16 span) in `text`.
  public static func context(_ text: String, target: Range<Int>, radius: Int = 10) -> [String] {
    let t = ScrollsCore.Tokenizer.tokenize(text)
    let left = t.filter { $0.end <= target.lowerBound }.suffix(radius)
    let right = t.filter { $0.start >= target.upperBound }.prefix(radius)
    return (left + right).map(\.norm)
  }

  public static func cardWords(_ s: [Scored]) -> [String] {
    Array(s.filter { $0.z >= 1.96 && $0.count >= 3 }.prefix(4).map(\.word))
  }

  public static func promptWords(_ s: [Scored]) -> [String] {
    Array(s.filter { $0.z > 0 && $0.count >= 2 }.prefix(10).map(\.word))
  }
}
