// OWNER: Q (created by the bring-up, B2)
// The bring-up's live demonstration ("Qwen on this iPhone", -qwen-demo): ~60 real public-domain passages containing
// 'bank' (bank-demo.json, extracted by Tools/qwen-ref.py from a clone of the m5r snapshot: a seeded sample, at most one
// occurrence per book) are read by the embedder on the phone, centred, split by spherical k-means with k fixed at 2,
// and each group is labelled by Qwen3-4B through `label@1`. This file holds the pure steps; the runtime moves tensors.

import Foundation
import ScrollsCore

public struct DemoPassage: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var word: String
  public var passageID: Int64
  public var documentID: Int64
  public var extID: String?
  public var title: String?
  public var author: String?
  public var yearLo: Int?
  public var yearHi: Int?
  public var dateLabel: String?
  public var license: String?
  /// An excerpt of the passage (≤ 60 words each side of the match); `clipped*` say whether it was cut.
  public var text: String
  public var matchStart: Int
  public var matchEnd: Int
  public var clippedLeft: Bool
  public var clippedRight: Bool

  enum CodingKeys: String, CodingKey {
    case id, word, title, author, license, text
    case passageID = "passage_id", documentID = "document_id", extID = "ext_id", yearLo = "year_lo", yearHi = "year_hi"
    case dateLabel = "date_label", matchStart = "match_start", matchEnd = "match_end"
    case clippedLeft = "clipped_left", clippedRight = "clipped_right"
  }

  public var target: Range<Int> { matchStart..<matchEnd }
  public var year: Int? { yearLo }
  public var yearText: String {
    guard let lo = yearLo else { return "undated" }
    if let hi = yearHi, hi != lo { return "\(lo)–\(hi)" }
    return "\(lo)"
  }
}

public struct DemoSet: Codable, Sendable, Equatable {
  public var schema: String
  public var word: String
  public var source: String
  public var selection: String
  public var snapshot: String
  public var occurrencesTotal: Int
  public var passages: [DemoPassage]

  enum CodingKeys: String, CodingKey {
    case schema, word, source, selection, snapshot, passages
    case occurrencesTotal = "occurrences_total"
  }

  public init(schema: String, word: String, source: String, selection: String, snapshot: String, occurrencesTotal: Int,
              passages: [DemoPassage]) {
    self.schema = schema
    self.word = word
    self.source = source
    self.selection = selection
    self.snapshot = snapshot
    self.occurrencesTotal = occurrencesTotal
    self.passages = passages
  }

  public static func load(_ url: URL) throws -> DemoSet {
    try JSONDecoder().decode(DemoSet.self, from: Data(contentsOf: url))
  }

  /// The target's surface forms (folded), excluded from the computed words.
  public var targetForms: Set<String> {
    Set(passages.map { p in
      let u = Array(p.text.utf16)
      let lo = max(0, min(p.matchStart, u.count)), hi = max(lo, min(p.matchEnd, u.count))
      return Fold.fold(String(decoding: u[lo..<hi], as: UTF16.self))
    } + [word])
  }
}

/// rule_v2 at one k (IOS-SPEC-QWEN §3.3; lab `rule_v2.py`), for the demo's fixed k = 2.
public struct GateCheck: Codable, Sendable, Equatable {
  public var k: Int
  public var silhouette: Double
  public var stability: Double
  public var reference: Double
  public var margin: Double
  public var passes: Bool
  public var detail: String

  public static func evaluate(_ x: [[Float]], documents: [Int64], k: Int, thresholds: GateThresholds, seed: UInt32 = 42) -> GateCheck {
    let fit = SphericalKMeans.fit(x, k: k, seed: seed)
    let sil = SphericalKMeans.silhouette(x, labels: fit.labels)
    // stability: 30 subsamples of 80% of the documents, each the best of 3 restarts, mean ARI against the full fit
    var rng = Mulberry32(seed: seed &+ 1000 &* UInt32(k))
    let docs = Array(Set(documents)).sorted()
    var aris: [Double] = []
    for _ in 0..<30 {
      var pool = docs
      for i in stride(from: pool.count - 1, to: 0, by: -1) {
        let j = Int(rng.next() * Double(i + 1))
        pool.swapAt(i, j)
      }
      let keep = Set(pool.prefix(max(2, Int((0.8 * Double(docs.count)).rounded()))))
      let idx = x.indices.filter { keep.contains(documents[$0]) }
      guard idx.count > k else { continue }
      let sub = SphericalKMeans.fit(idx.map { x[$0] }, k: k, seed: UInt32(rng.next() * 1_000_000), restarts: 3)
      aris.append(ARI.score(idx.map { fit.labels[$0] }, sub.labels))
    }
    let stability = aris.isEmpty ? 0 : aris.reduce(0, +) / Double(aris.count)
    let ref = GaussianReference.silhouette(x, k: k, seed: 7)
    let margin = sil - ref
    var detail = "ok"
    var passes = true
    if stability < thresholds.minStability { passes = false; detail = "no_stable_k" }
    else if margin < thresholds.minMargin { passes = false; detail = "below_margin" }
    else if sil < thresholds.floor { passes = false; detail = "below_floor" }
    return GateCheck(k: k, silhouette: sil, stability: stability, reference: ref, margin: margin, passes: passes, detail: detail)
  }
}

public enum ARI {
  public static func score(_ a: [Int], _ b: [Int]) -> Double {
    precondition(a.count == b.count)
    var m: [Int: [Int: Int]] = [:]
    for i in a.indices { m[a[i], default: [:]][b[i], default: 0] += 1 }
    func c2(_ x: Int) -> Double { Double(x) * Double(x - 1) / 2 }
    let sij = m.values.flatMap(\.values).reduce(0.0) { $0 + c2($1) }
    var rows: [Int: Int] = [:], cols: [Int: Int] = [:]
    for (r, inner) in m { for (c, n) in inner { rows[r, default: 0] += n; cols[c, default: 0] += n } }
    let sa = rows.values.reduce(0.0) { $0 + c2($1) }, sb = cols.values.reduce(0.0) { $0 + c2($1) }
    let n = c2(a.count)
    let expected = n > 0 ? sa * sb / n : 0
    let maxIndex = (sa + sb) / 2
    return maxIndex != expected ? (sij - expected) / (maxIndex - expected) : 1
  }
}

/// The silhouette at k of a Gaussian with the data's mean and covariance, put on the sphere (the lab's reference).
public enum GaussianReference {
  public static func silhouette(_ x: [[Float]], k: Int, seed: UInt32) -> Double {
    let n = x.count, d = x.first?.count ?? 0
    guard n > k, d > 0 else { return 0 }
    var rng = Mulberry32(seed: seed)
    func gauss() -> Double {
      let u1 = max(rng.next(), 1e-12), u2 = rng.next()
      return (-2 * log(u1)).squareRoot() * cos(2 * Double.pi * u2)
    }
    var mu = [Double](repeating: 0, count: d)
    for r in x { for j in 0..<d { mu[j] += Double(r[j]) } }
    for j in 0..<d { mu[j] /= Double(n) }
    let scale = 1 / Double(max(1, n - 1)).squareRoot()
    var g: [[Float]] = []
    for _ in 0..<n {
      let z = (0..<n).map { _ in gauss() }
      var row = mu
      for i in 0..<n where z[i] != 0 {
        let w = z[i] * scale
        for j in 0..<d { row[j] += w * (Double(x[i][j]) - mu[j]) }
      }
      g.append(VectorMath.normalized(row.map { Float($0) }))
    }
    let fit = SphericalKMeans.fit(g, k: k, seed: seed, restarts: 3)
    return SphericalKMeans.silhouette(g, labels: fit.labels)
  }
}

public struct DemoMember: Codable, Sendable, Equatable {
  public var passage: String      // DemoPassage.id
  public var cos: Double          // to its centroid, in the centred space
}

public struct DemoGroup: Codable, Sendable, Equatable {
  public var index: Int
  public var members: [DemoMember]          // nearest first
  public var cardMembers: [String]          // the 5 passages the label prompt saw: 3 nearest + 2 seeded random
  public var distinctive: [DistinctiveWords.Scored]
  public var cardWords: [String]
  public var promptWords: [String]
}

public struct DemoGrouping: Codable, Sendable, Equatable {
  public var k: Int
  public var groups: [DemoGroup]
  public var gate: GateCheck
  public var representation: String

  /// Centre, fit k = 2 (seed 42), order groups by size, pick each group's card members, compute its words.
  public static func make(_ set: DemoSet, vectors: [[Float]], k: Int = 2, seed: UInt32 = 42) -> DemoGrouping {
    let x = VectorMath.centred(vectors)
    let fit = SphericalKMeans.fit(x, k: k, seed: seed)
    let thresholds = GateThresholds.forKey(.r1)!
    let gate = GateCheck.evaluate(x, documents: set.passages.map(\.documentID), k: k, thresholds: thresholds, seed: seed)
    var order = Array(0..<k)
    let sizes = (0..<k).map { j in fit.labels.filter { $0 == j }.count }
    order.sort { sizes[$0] != sizes[$1] ? sizes[$0] > sizes[$1] : (fit.labels.firstIndex(of: $0) ?? 0) < (fit.labels.firstIndex(of: $1) ?? 0) }
    let contexts: [[[String]]] = order.map { j in
      set.passages.indices.filter { fit.labels[$0] == j }.map { DistinctiveWords.context(set.passages[$0].text, target: set.passages[$0].target) }
    }
    let scored = DistinctiveWords.score(contexts, exclude: set.targetForms)
    var rng = Mulberry32(seed: seed &+ 7)
    var groups: [DemoGroup] = []
    for (gi, j) in order.enumerated() {
      let idx = set.passages.indices.filter { fit.labels[$0] == j }
      let members = idx.map { DemoMember(passage: set.passages[$0].id, cos: VectorMath.dot(x[$0], fit.centroids[j])) }
        .sorted { $0.cos != $1.cos ? $0.cos > $1.cos : $0.passage < $1.passage }
      // ≤ 1 per document: the demo already holds one occurrence per book
      var card = Array(members.prefix(3).map(\.passage))
      var rest = Array(members.dropFirst(3).map(\.passage))
      while card.count < min(5, members.count) && !rest.isEmpty {
        card.append(rest.remove(at: Int(rng.next() * Double(rest.count))))
      }
      groups.append(DemoGroup(index: gi, members: members, cardMembers: card, distinctive: Array(scored[gi].prefix(20)),
                              cardWords: DistinctiveWords.cardWords(scored[gi]), promptWords: DistinctiveWords.promptWords(scored[gi])))
    }
    return DemoGrouping(k: k, groups: groups, gate: gate, representation: RepresentationKey.r1.description)
  }

  /// The `label@1` passages for one group: P1…P5, period slots by year, ±25-word excerpts.
  public static func promptPassages(_ g: DemoGroup, set: DemoSet) -> [PromptPassage] {
    let ps = g.cardMembers.compactMap { id in set.passages.first { $0.id == id } }
    let slots = PromptLibrary.slots(years: ps.map(\.year))
    return ps.enumerated().map { i, p in
      PromptPassage(id: "P\(i + 1)", slot: slots[i], source: "book (Project Gutenberg)", title: p.title,
                    text: Excerpt.around(p.text, target: p.target, words: 25))
    }
  }
}
