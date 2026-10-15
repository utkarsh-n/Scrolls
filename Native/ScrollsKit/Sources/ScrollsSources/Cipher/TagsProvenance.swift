// OWNER: N2
// Port of `server/adapters/cipher/tags-provenance.mjs`: doc_tag provenance for culture-work themes, motifs and moods
// (SPEC §6.5), and the index of Cipher's raw tagging batches (`tags/*.jsonl` members of cipher-meta) that decides it.
// Weight 0.55 is a Wikidata genre label by construction (build_culture.py), so a 0.55 theme is `genre_heuristic`;
// a theme named in the work's tagging batch is `machine_tag`; anything else is `documented_category`.

import Foundation
import ScrollsContracts
import ScrollsCore

/// A work's tagging batch: its themes (folded) and the siblings it names.
public struct TaggedWork: Sendable {
  public struct Sibling: Sendable {
    public var title: String
    public var year: Int?
    public var relation: String
  }
  public var file: String
  public var themes: Set<String>
  public var siblings: [Sibling]
}

public enum TagsProvenance {
  public static let genreWeight = 0.55
  public static let genreMoodWeight = 0.5

  /// doc_tag.method values (short: stored on ≈ 600k rows).
  public enum Method {
    public static let documentedCategory = "Wikidata/Wikipedia categories (Cipher)"
    public static let genreHeuristic = "Wikidata genre label, weight 0.55 (Cipher)"
    public static let genreMood = "genre-derived mood, weight 0.50 (Cipher)"
    public static let machineTag = CipherFormat.taggingMethod
    public static let canon = "canon list (Cipher)"
    public static let maker = "Wikidata maker (Cipher)"

    static func of(_ provenance: String) -> String {
      switch provenance {
      case "documented_category": documentedCategory
      case "genre_heuristic": genreHeuristic
      case "machine_tag": machineTag
      default: documentedCategory
      }
    }
  }

  /// `loadTagIndex(tagsDir)`: Wikidata/Cipher id → its batch; later batches (by file name) win for a repeated id.
  public static func loadIndex(_ files: SourceFiles) throws -> [String: TaggedWork] {
    var index: [String: TaggedWork] = [:]
    let names = files.members(prefix: CipherPacks.tagsDir).filter { $0.hasSuffix(".jsonl") }
      .sorted { CanonicalJSON.codeUnitLess($0, $1) }
    for member in names {
      let data = try files.data(member)
      let file = String(member.dropFirst(CipherPacks.tagsDir.count))
      for line in CipherFormat.lines(data) {
        let text = CipherFormat.text(data, line.byteStart, line.byteEnd)
        guard !JSString.trim(text).isEmpty else { continue }
        guard let r = try? JSONValue.parse(text), case .object = r, let q = r["q"]?.stringValue else { continue }
        let themes = Set((r["themes"]?.arrayValue ?? []).map { CipherFormat.fold(CipherFormat.string($0)) })
        let siblings = (r["siblings"]?.arrayValue ?? []).map { s in
          TaggedWork.Sibling(title: CipherFormat.fold(CipherFormat.string(s["title"])), year: CipherFormat.integer(s["year"]),
                             relation: CipherFormat.string(s["relation"]))
        }
        index[q] = TaggedWork(file: file, themes: themes, siblings: siblings)
      }
    }
    return index
  }

  /// `tagProvenance({scheme, value, weight, tagged})`.
  public static func provenance(scheme: String, value: String, weight: Double?, tagged: TaggedWork?) -> String {
    if scheme == "motif" { return "machine_tag" }
    if scheme == "canon" { return "documented_category" }
    if scheme == "maker" { return "catalog" }
    if scheme == "mood" { return weight == genreMoodWeight ? "genre_heuristic" : "machine_tag" }
    if let tagged, tagged.themes.contains(CipherFormat.fold(value)) { return "machine_tag" }
    if weight == genreWeight { return "genre_heuristic" }
    return "documented_category"
  }

  /// `parseWeighted(field)`: a `phrase:weight|…` list or a plain `a|b|c` list; the weight is after the last ':'.
  public static func parseWeighted(_ field: String) -> [(value: String, weight: Double?)] {
    guard !field.isEmpty else { return [] }
    var out: [(value: String, weight: Double?)] = []
    for item in JSString.split(field, "|") where !item.isEmpty {
      let u = Array(item.utf16)
      var k = -1
      for i in stride(from: u.count - 1, through: 0, by: -1) where u[i] == 0x3A {
        k = i
        break
      }
      let tail = k > 0 ? String(decoding: u[(k + 1)...], as: UTF16.self) : ""
      if k > 0, let w = CipherFormat.finiteNumber(tail), isPlainDecimal(tail) {
        let v = JSString.trim(String(decoding: u[..<k], as: UTF16.self))
        if !v.isEmpty { out.append((v, w)) }
      } else {
        let v = JSString.trim(item)
        if !v.isEmpty { out.append((v, nil)) }
      }
    }
    return out
  }

  /// `/^\d+(?:\.\d+)?$/`.
  static func isPlainDecimal(_ s: String) -> Bool {
    let u = Array(s.utf8)
    var i = 0, a = 0
    while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { i += 1 }
    guard i > 0 else { return false }
    if i == u.count { return true }
    guard u[i] == 0x2E else { return false }
    i += 1
    a = i
    while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { i += 1 }
    return i > a && i == u.count
  }

  /// `workTags(cols, tagged)`: maker (catalog), canon (documented_category), themes (by provenance), motifs
  /// (machine_tag), moods (genre_heuristic when every value is at 0.50, else machine_tag).
  public static func workTags(maker: String, canon: String, themes: String, motifs: String, mood: String,
                              tagged: TaggedWork?) -> [CanonicalTag] {
    var tags: [CanonicalTag] = []
    for m in splitMakers(maker) {
      tags.append(CanonicalTag(scheme: "maker", value: m, weight: nil, provenance: "catalog", method: Method.maker))
    }
    for c in parseWeighted(canon) {
      tags.append(CanonicalTag(scheme: "canon", value: c.value, weight: nil, provenance: "documented_category", method: Method.canon))
    }
    for t in parseWeighted(themes) {
      let p = provenance(scheme: "theme", value: t.value, weight: t.weight, tagged: tagged)
      tags.append(CanonicalTag(scheme: "theme", value: t.value, weight: t.weight, provenance: p, method: Method.of(p)))
    }
    for m in parseWeighted(motifs) {
      tags.append(CanonicalTag(scheme: "motif", value: m.value, weight: nil, provenance: "machine_tag", method: Method.machineTag))
    }
    let moods = parseWeighted(mood)
    let genreMoods = !moods.isEmpty && moods.allSatisfy { $0.weight == genreMoodWeight }
    for m in moods {
      tags.append(genreMoods
        ? CanonicalTag(scheme: "mood", value: m.value, weight: m.weight, provenance: "genre_heuristic", method: Method.genreMood)
        : CanonicalTag(scheme: "mood", value: m.value, weight: m.weight, provenance: "machine_tag", method: Method.machineTag))
    }
    return tags
  }

  private static let suffixes: Set<String> = ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]

  /// `splitMakers(maker)`: makers joined by ", "; a trailing "Jr." stays with its name; duplicates dropped.
  public static func splitMakers(_ maker: String) -> [String] {
    guard !maker.isEmpty else { return [] }
    var out: [String] = []
    for part in JSString.split(maker, ", ") {
      let p = JSString.trim(part)
      guard !p.isEmpty else { continue }
      if !out.isEmpty, suffixes.contains(JSString.toLowerCase(p)) {
        out[out.count - 1] += ", \(p)"
      } else {
        out.append(p)
      }
    }
    var seen = Set<CodeUnits>()
    return out.filter { seen.insert(CodeUnits($0)).inserted }
  }
}
