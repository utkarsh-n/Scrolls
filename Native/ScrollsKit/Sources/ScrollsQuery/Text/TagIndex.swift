// OWNER: N3
// Port of server/aggregate/tagindex.mjs: typeahead over the theme and maker labels of a corpus. Two label indexes per
// corpus, each a shared artifact (built once per state of the corpus's inputs): themes (each distinct theme tag with its
// document count and provenances, plus trigram postings over the folded labels) and makers (each document author or maker
// tag with its document count and slug). A query is folded like the labels and matches a label whose folded form
// contains it; trigram postings only narrow the candidates. Suggestions never count occurrences (§4.4).

import Foundation
import ScrollsCore
import ScrollsStore

/// A label index of one scheme.
public struct LabelIndex: Sendable, Codable {
  public var labels: [String]
  public var folded: [String]
  public var slugs: [String]?
  public var provs: [String]
  public var n: [Int32]
  public var grams: [String]?
  public var offsets: [Int32]?
  public var postings: [Int32]?
}

/// A label found by a query.
public struct LabelHit: Sendable, Equatable {
  public var value: String
  public var n: Int
  public var provenance: [String]
}

/// Theme and maker label indexes.
public enum TagIndex {
  /// `foldLabel(s)`: the label's tokens joined by single spaces.
  public static func fold(_ s: String) -> String { Tokenizer.tokens(s).tokens.joined(separator: " ") }

  /// Distinct trigrams (by code point) of a folded string, in first-seen order.
  static func trigrams(_ s: String) -> [String] {
    let cps = Array(s.unicodeScalars)
    var out: [String] = []
    var seen = JSStringSet()
    if cps.count >= 3 {
      for i in 0...(cps.count - 3) {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: cps[i..<(i + 3)])
        let g = String(v)
        if seen.insert(g) { out.append(g) }
      }
    }
    return out
  }

  /// `buildLabelIndex(rows, {trigrams, slugs})`: labels ranked by n (then label), folded forms, slugs, trigram postings.
  public static func build(_ rows: [(value: String, n: Int, provs: String?)], trigrams withGrams: Bool, slugs: Bool) -> LabelIndex {
    let sorted = rows.sorted { a, b in a.n != b.n ? a.n > b.n : JSText.less(a.value, b.value) }
    let labels = sorted.map(\.value)
    let folded = labels.map(fold)
    var x = LabelIndex(labels: labels, folded: folded, slugs: slugs ? labels.map { IDs.slug($0) } : nil,
                       provs: sorted.map { $0.provs ?? "" }, n: sorted.map { Int32($0.n) }, grams: nil, offsets: nil, postings: nil)
    guard withGrams else { return x }
    var lists: [JSKey: [Int32]] = [:]
    for (id, f) in folded.enumerated() { for g in trigrams(f) { lists[JSKey(g), default: []].append(Int32(id)) } }
    let grams = lists.keys.sorted()
    var offsets: [Int32] = []
    var postings: [Int32] = []
    for g in grams {
      offsets.append(Int32(postings.count))
      postings += lists[g]!
    }
    offsets.append(Int32(postings.count))
    x.grams = grams.map(\.string)
    x.offsets = offsets
    x.postings = postings
    return x
  }

  /// The label index of a corpus for a scheme ('theme' | 'maker'), built when missing.
  public static func index(_ c: Connection, corpusId: Int64, scheme: String) throws -> LabelIndex {
    let name = scheme == "theme" ? "themes2-c\(corpusId)" : "makers2-c\(corpusId)"
    return try Artifacts.shared(c, name: name, key: { try InputsKey.corpus($0, corpusId, scope: .labels) }) { c in
      let s = try c.prepared(scheme == "theme" ? TagIndexSQL.themes : TagIndexSQL.makers)
      try s.bind([.int(corpusId)])
      let rows = try s.all { ($0.text(0), Int($0.int(1)), $0.textOrNil(2)) }
      return build(rows.map { (value: $0.0, n: $0.1, provs: $0.2) }, trigrams: scheme == "theme", slugs: scheme == "maker")
    }
  }

  private static func postings(_ x: LabelIndex, _ gram: String) -> ArraySlice<Int32>? {
    guard let grams = x.grams, let offsets = x.offsets, let postings = x.postings else { return nil }
    var lo = 0, hi = grams.count - 1
    while lo <= hi {
      let mid = (lo + hi) >> 1
      let g = grams[mid]
      if JSString.equal(g, gram) { return postings[Int(offsets[mid])..<Int(offsets[mid + 1])] }
      if JSText.less(g, gram) { lo = mid + 1 } else { hi = mid - 1 }
    }
    return nil
  }

  /// `findLabels(x, query, {limit})`: labels whose folded form contains the folded query, most-tagged first.
  public static func find(_ x: LabelIndex?, _ query: String, limit: Int = 5) -> [LabelHit] {
    let q = fold(query)
    guard let x, !q.isEmpty else { return [] }
    var candidates: ArraySlice<Int32>?
    if x.grams != nil {
      for g in trigrams(q) {
        guard let p = postings(x, g) else { return [] }
        if candidates == nil || p.count < candidates!.count { candidates = p }
      }
    }
    var out: [LabelHit] = []
    let total = candidates?.count ?? x.labels.count
    var k = 0
    while k < total && out.count < limit {
      let id = candidates.map { Int($0[$0.startIndex + k]) } ?? k
      k += 1
      guard JSText.includes(x.folded[id], q) else { continue }
      out.append(LabelHit(value: x.labels[id], n: Int(x.n[id]),
                          provenance: x.provs[id].isEmpty ? [] : JSString.split(x.provs[id], ",")))
    }
    return out
  }

  /// `labelsForRef(x, ref)`: the exact label, or labels whose slug equals the ref; sorted.
  public static func labelsForRef(_ x: LabelIndex, _ ref: String) -> [String] {
    var out: [String] = []
    for i in x.labels.indices where JSString.equal(x.labels[i], ref) || (x.slugs.map { JSString.equal($0[i], ref) } ?? false) {
      out.append(x.labels[i])
    }
    return out.sorted(by: JSText.less)
  }
}

/// Statements of the label indexes.
public enum TagIndexSQL: SQLCatalog {
  static let themes = SQL("q.labels.themes", """
    SELECT t.value, count(DISTINCT t.document_id) AS n, group_concat(DISTINCT t.provenance) AS provs
      FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      WHERE t.scheme = 'theme' AND c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL GROUP BY t.value
    """, scan: .scanOK(reason: "the theme label artifact, once per inputs of the corpus"))
  static let makers = SQL("q.labels.makers", """
    SELECT name AS value, count(DISTINCT doc) AS n, NULL AS provs FROM (
        SELECT d.author AS name, d.id AS doc FROM document d JOIN collection c ON c.id = d.collection_id
          WHERE c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL AND d.author IS NOT NULL
        UNION ALL
        SELECT t.value, t.document_id FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
          WHERE t.scheme = 'maker' AND c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL)
      GROUP BY name
    """, scan: .scanOK(reason: "the maker label artifact, once per inputs of the corpus"))

  public static let all: [SQL] = [themes, makers]
}
