// OWNER: N2
// Ports of `server/adapters/cipher/themes.mjs` and `roots.mjs`. Neither yields documents:
// - 'cipher.themes': culture-themes.tsv (theme, count, "other:value|…", example rows) → theme_assoc. The values are
//   Cipher's computed association strengths (shrunk NPMI, build_culture.py): computed, never documented.
// - 'cipher.roots': roots.tsv (54,989 families from Wiktionary via kaikki.org, CC BY-SA) → etymon, etymon_parent,
//   etymon_member (SPEC §6.7). Etymology is periods, not dates: nothing here dates a word. A multi-parent list is never
//   competing hypotheses or one parent; `parent_semantics` records what the list measurably is.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// Source adapter 'cipher.themes'.
public struct CipherThemesAdapter: PackBoundAdapter, ThemeAssocSource {
  public static let adapterID = "cipher.themes"
  public static let packNames = [CipherPacks.meta]
  public static let method = "Cipher NPMI (build_culture.py): normalised PMI × shared-count factor, pairs sharing ≥ 3 works, npmi ≥ 0.2"

  public let id = CipherThemesAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher theme associations"
  public let access = AdapterAccess.localDataset
  public let license = "derived by Cipher from Wikidata (CC0)"
  public let attribution = "Cipher"
  /// Theme associations live in theme_assoc; §6.2 names no collection for them.
  public let collections: [CollectionSpec] = []
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherThemesAdapter { CipherThemesAdapter(files: files) }

  struct Row {
    var theme: String
    var count: Int
    var assoc: [(other: String, value: Double)]
  }

  func load() throws -> (rows: [Row], bad: [Int]) {
    let data = try files.data(CipherPacks.cultureThemes)
    var rows: [Row] = [], bad: [Int] = []
    for line in CipherFormat.lines(data) {
      let c = CipherFormat.tabFields(data, line)
      guard c.count == 4, !c[0].isEmpty else { bad.append(line.index + 1); continue }
      let assoc = TagsProvenance.parseWeighted(c[2]).compactMap { a in a.weight.map { (other: a.value, value: $0) } }
      let n = JSNumber.parse(c[1])
      rows.append(Row(theme: c[0], count: n.isFinite ? Int(n) : 0, assoc: assoc))
    }
    return (rows, bad)
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    guard files.contains(CipherPacks.cultureThemes) else { return .memberMissing(CipherPacks.cultureThemes) }
    let (rows, bad) = try load()
    return AdapterProbeResult(available: bad.isEmpty, reason: bad.first.map { "\(bad.count) malformed rows (first: line \($0))" },
                              manifestOK: true, formatOK: bad.isEmpty,
                              counts: ["themes": rows.count, "associations": rows.reduce(0) { $0 + $1.assoc.count }],
                              caveats: ["Association strengths are computed by Cipher (shrunk NPMI), not documented relations."])
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { try load().rows.count }

  /// No documents: themes are doc_tags of culture works.
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {}

  public func themeAssocs(_ params: JSONValue, _ context: AdapterContext) async throws -> [ThemeAssocRecord] {
    try files.keep(CipherPacks.cultureThemes)
    return try load().rows.flatMap { r in r.assoc.map { ThemeAssocRecord(theme: r.theme, other: $0.other, npmi: $0.value, count: r.count) } }
  }

  public func themeLabels(_ params: JSONValue, _ context: AdapterContext) async throws -> [String] {
    try load().rows.map(\.theme)
  }
}

/// Source adapter 'cipher.roots'.
public struct CipherRootsAdapter: PackBoundAdapter, EtymonSource {
  public static let adapterID = "cipher.roots"
  public static let packNames = [CipherPacks.meta]

  public let id = CipherRootsAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Cipher etymology (roots.tsv)"
  public let access = AdapterAccess.localDataset
  public let license = "CC BY-SA"
  public let attribution = "Wiktionary via kaikki.org (CC BY-SA)"
  /// Etymology lives in the etymon tables; §6.2 names no collection for it.
  public let collections: [CollectionSpec] = []
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> CipherRootsAdapter { CipherRootsAdapter(files: files) }

  /// Levenshtein distance over Unicode scalars (JavaScript `[...s]`), bounded: max+1 once it exceeds `max`.
  public static func editDistance(_ a: [Unicode.Scalar], _ b: [Unicode.Scalar], max: Int = 2) -> Int {
    if abs(a.count - b.count) > max { return max + 1 }
    var prev = Array(0...b.count)
    for i in stride(from: 1, through: a.count, by: 1) {
      var cur = [i] + Array(repeating: 0, count: b.count)
      var best = i
      for j in stride(from: 1, through: b.count, by: 1) {
        cur[j] = Swift.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
        if cur[j] < best { best = cur[j] }
      }
      if best > max { return max + 1 }
      prev = cur
    }
    return prev[b.count]
  }

  static func formOf(_ key: String) -> String {
    let u = Array(key.utf16)
    guard let i = u.firstIndex(of: 0x3A) else { return key }
    return String(decoding: u[(i + 1)...], as: UTF16.self)
  }

  /// `parentSemantics(parents)`: none · single · listed_chain · listed_variants · listed_unresolved.
  public static func parentSemantics(_ parents: [String]) -> String {
    if parents.isEmpty { return "none" }
    if parents.count == 1 { return "single" }
    if parents.contains(where: { $0.hasPrefix("sa:") }) && parents.contains(where: { $0.hasPrefix("ine-pro:") }) { return "listed_chain" }
    let first = Array(formOf(parents[0]).unicodeScalars)
    if parents.dropFirst().allSatisfy({ editDistance(first, Array(formOf($0).unicodeScalars)) <= 2 }) { return "listed_variants" }
    return "listed_unresolved"
  }

  func load() throws -> (rows: [EtymonRecord], bad: [Int]) {
    let data = try files.data(CipherPacks.roots)
    var rows: [EtymonRecord] = [], bad: [Int] = []
    for line in CipherFormat.lines(data) {
      let c = CipherFormat.tabFields(data, line)
      guard c.count == 8, !c[0].isEmpty else { bad.append(line.index + 1); continue }
      var parents: [String] = [], seenParents = Set<CodeUnits>()
      if !c[6].isEmpty {
        for p in JSString.split(c[6], "|") where !p.isEmpty && seenParents.insert(CodeUnits(p)).inserted { parents.append(p) }
      }
      var members: [EtymonRecord.Member] = [], seen = Set<CodeUnits>()
      if !c[7].isEmpty {
        for m in JSString.split(c[7], "|") {
          let k = JSString.indexOf(m, ":")
          guard k > 0 else { continue }
          let u = Array(m.utf16)
          let lang = String(decoding: u[..<k], as: UTF16.self), word = String(decoding: u[(k + 1)...], as: UTF16.self)
          guard !word.isEmpty, seen.insert(CodeUnits("\(lang)\u{0}\(word)")).inserted else { continue }
          members.append(EtymonRecord.Member(lang: lang, word: word, norm: Tokenizer.normString(word), rank: members.count + 1))
        }
      }
      rows.append(EtymonRecord(key: c[0], kind: c[1] == "root" ? "root" : "etymon", lang: c[2], form: c[3],
                               roman: c[4].isEmpty ? nil : c[4], gloss: c[5].isEmpty ? nil : c[5], parents: parents,
                               parentSemantics: Self.parentSemantics(parents), members: members))
    }
    return (rows, bad)
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    guard files.contains(CipherPacks.roots) else { return .memberMissing(CipherPacks.roots) }
    let (rows, bad) = try load()
    var counts = ["families": rows.count]
    for r in rows { counts[r.parentSemantics, default: 0] += 1 }
    return AdapterProbeResult(available: bad.isEmpty, reason: bad.first.map { "\(bad.count) malformed rows (first: line \($0))" },
                              manifestOK: true, formatOK: bad.isEmpty, counts: counts,
                              caveats: ["Latin, Ancient Greek, Sanskrit and PIE only; language periods, not dates; member order is a frequency heuristic."])
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { try load().rows.count }

  /// No documents: etymology lives in the etymon tables.
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {}

  public func etymons(_ params: JSONValue, _ context: AdapterContext) async throws -> [EtymonRecord] {
    try files.keep(CipherPacks.roots)
    return try load().rows
  }

  /// `wiktionaryLocator(key)`: the reconstruction page for PIE, else the lemma page (descent edges are virtual until
  /// reviewed, §6.7).
  public static func wiktionaryLocator(_ key: String) -> String {
    let u = Array(key.utf16)
    let i = u.firstIndex(of: 0x3A) ?? 0
    let lang = String(decoding: u[..<i], as: UTF16.self)
    let form = formOf(key)
    if lang == "ine-pro" {
      let bare = form.hasPrefix("*") ? String(form.dropFirst()) : form
      return "https://en.wiktionary.org/wiki/Reconstruction:Proto-Indo-European/\(JSText.encodeURIComponent(bare))"
    }
    return "https://en.wiktionary.org/wiki/\(JSText.encodeURIComponent(form))"
  }
}
