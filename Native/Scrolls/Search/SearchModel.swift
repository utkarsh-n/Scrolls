// OWNER: N8
// Search (IOS-SPEC §4.9; port of `shell/search.mjs`): one field for expressions, works, makers, themes, etymology and
// annotations. Typing runs `search` after 180 ms; the answer's typed suggestions are grouped, each with its count and
// unit; the computed empty state is shown verbatim ("0 is an observation about this index"). Romanised Indic matches
// (`query.variants` of type `transliteration`, the engine's `translit-key@1`) appear as their own Expression rows,
// labelled "romanised match — a suggestion, not a merge", each with its own count; tracking one tracks the
// native-script form. Romanised and native forms are never merged here.

import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService

/// A suggestion group, in the order the sheet lists them (§4.9).
nonisolated enum SuggestionGroup: String, CaseIterable, Sendable {
  case expressions, works, makers, themes, etymology, annotations, sources

  static func of(_ type: String) -> SuggestionGroup {
    switch type {
    case "expression": .expressions
    case "work": .works
    case "maker": .makers
    case "theme": .themes
    case "etymology": .etymology
    case "annotation": .annotations
    default: .sources
    }
  }

  var title: String {
    switch self {
    case .expressions: SearchCopy.groupExpressions
    case .works: SearchCopy.groupWorks
    case .makers: SearchCopy.groupMakers
    case .themes: SearchCopy.groupThemes
    case .etymology: SearchCopy.groupEtymology
    case .annotations: SearchCopy.groupAnnotations
    case .sources: SearchCopy.groupSources
    }
  }
}

/// What choosing a suggestion does (`suggestionAction`).
nonisolated enum SuggestionAction: Equatable, Sendable {
  case pin(type: String, id: ViewState.StrandID)
  case track
  case openDocument(Int)
  case genealogy(Int)
  case sources
  case notebook(Int)
  case info

  /// `suggestionAction(s)`; on the phone a work opens its Genealogy (§4.9 "Works (→ Genealogy)").
  static func of(_ s: SearchSuggestion) -> SuggestionAction {
    let ref = s.ref
    let parts = ref.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
    let type = parts[0], id = parts.count > 1 ? parts[1] : ""
    switch type {
    case "expression":
      if id == "new" { return .track }
      if let n = Int(id) { return .pin(type: "expression", id: .number(n)) }
    case "document":
      if let n = Int(id) { return s.type == "work" ? .genealogy(n) : .openDocument(n) }
    case "maker" where !id.isEmpty: return .pin(type: "maker", id: .string(id))
    case "theme" where !id.isEmpty: return .pin(type: "theme", id: .string(id))
    case "work":
      if let n = Int(id) { return .pin(type: "work", id: .number(n)) }
    case "annotation":
      if let n = Int(id) { return .notebook(n) }
    case "adapters": return .sources
    default: break
    }
    return ref == "adapters" ? .sources : .info
  }
}

/// A romanised match: a native-script form the engine found for a Latin query (§4.9).
nonisolated struct RomanisedMatch: Sendable, Equatable, Identifiable {
  let form: String
  /// "hi" or "gu" from the form's script; nil for another script.
  let lang: String?
  /// Matches of this form alone, once counted (the variant's own `n`, or a count of the form).
  var count: Int?
  /// The count is of passages containing the form (a search of an untracked form), not of matches.
  var countsPassages = false
  var counting: Bool

  var id: String { form }

  /// The script's language: Devanagari → Hindi (hi), Gujarati → Gujarati (gu).
  static func language(of form: String) -> String? {
    for s in form.unicodeScalars where s.properties.isAlphabetic {
      if (0x0900...0x097F).contains(s.value) { return "hi" }
      if (0x0A80...0x0AFF).contains(s.value) { return "gu" }
    }
    return nil
  }

  /// The romanised matches of a search answer, in the engine's order, at most `max`.
  static func from(_ r: SearchResponse, max: Int = 4) -> [RomanisedMatch] {
    var seen = Set<String>()
    var out: [RomanisedMatch] = []
    for v in r.query.variants where v.type == "transliteration" && !seen.contains(v.form) {
      seen.insert(v.form)
      out.append(RomanisedMatch(form: v.form, lang: language(of: v.form), count: v.n, counting: v.n == nil))
      if out.count >= max { break }
    }
    return out
  }

  /// "शून्य · Hindi · 412 matches" (the count when known).
  var line: String {
    var parts = [form]
    if let lang { parts.append(SearchCopy.languageName(lang)) }
    if let count { parts.append(countsPassages ? SearchCopy.passages(count) : SearchCopy.matches(count)) }
    return parts.joined(separator: " · ")
  }
}

@MainActor @Observable
final class SearchModel {
  @ObservationIgnored private unowned let app: AppModel
  @ObservationIgnored private weak var experience: ExperienceModel?
  /// The field's text.
  var text = "" {
    didSet { if text != oldValue { schedule() } }
  }
  private(set) var result: LoadState<SearchResponse> = .idle
  private(set) var romanised: [RomanisedMatch] = []
  /// A track or pin in flight (the row shows it).
  private(set) var working: String?
  @ObservationIgnored private var debounce: Task<Void, Never>?
  @ObservationIgnored private var seq = 0

  /// `DEBOUNCE_MS`.
  static let debounce: Duration = .milliseconds(180)

  init(app: AppModel) {
    self.app = app
  }

  func attach(_ experience: ExperienceModel) { self.experience = experience }

  /// The suggestions grouped in the sheet's order, empty groups left out.
  var groups: [(group: SuggestionGroup, items: [SearchSuggestion])] {
    guard let r = result.value else { return [] }
    let byGroup = Dictionary(grouping: r.suggestions, by: { SuggestionGroup.of($0.type) })
    return SuggestionGroup.allCases.compactMap { g in byGroup[g].map { (g, $0) } }
  }

  /// Runs now (Return in the field, Retry).
  func runNow() {
    debounce?.cancel()
    let q = text
    debounce = Task { await run(q) }
  }

  func clear() {
    debounce?.cancel()
    seq += 1
    text = ""
    result = .idle
    romanised = []
  }

  private func schedule() {
    debounce?.cancel()
    let q = text
    guard !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      seq += 1
      result = .idle
      romanised = []
      return
    }
    debounce = Task {
      try? await Task.sleep(for: Self.debounce)
      guard !Task.isCancelled else { return }
      await run(q)
    }
  }

  private func run(_ q: String) async {
    guard let atlas = app.atlas, !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    seq += 1
    let mySeq = seq
    result = .loading
    let view = app.viewState
    do {
      let r = try await atlas.search(SearchRequest(q: q, corpus: view.corpus, scope: "all", f: ViewQuery.filter(view), limit: 10))
      guard mySeq == seq else { return }
      result = .loaded(r)
      romanised = RomanisedMatch.from(r)
      for m in romanised where m.counting { Task { await count(m.form, seq: mySeq) } }
    } catch {
      guard mySeq == seq, !(error is CancellationError) else { return }
      result = .failed(ErrorCardModel(any: error))
      romanised = []
    }
  }

  /// A romanised form's own count: a text search of that form alone (never added to the query's count).
  private func count(_ form: String, seq mySeq: Int) async {
    guard let atlas = app.atlas else { return }
    let r = try? await atlas.search(SearchRequest(q: form, corpus: app.viewState.corpus, scope: "text", limit: 1))
    guard mySeq == seq, let i = romanised.firstIndex(where: { $0.form == form }) else { return }
    // The tracked expression's own count (matches); else the passages containing the form, said as passages; a
    // preliminary count is never shown as a number here.
    if let n = r?.suggestions.first(where: { $0.type == "expression" })?.count {
      romanised[i].count = n
    } else if let hits = r?.hits, !hits.preliminary {
      romanised[i].count = hits.passages
      romanised[i].countsPassages = true
    }
    romanised[i].counting = false
  }

  // MARK: Choosing

  func choose(_ s: SearchSuggestion) async {
    guard let experience else { return }
    switch SuggestionAction.of(s) {
    case .pin(let type, let id):
      experience.pin(type: type, id: id, label: s.label)
    case .track:
      let q = result.value?.query
      await track(surface: q?.surface ?? text, kind: q?.kind, lang: nil, label: s.label)
    case .openDocument(let n):
      experience.select(InspectedRef(type: "document", id: n).selection)
    case .genealogy(let n):
      experience.openGenealogy(document: n)
    case .sources:
      app.coordinator.present(.sources)
    case .notebook(let n):
      app.coordinator.push(.notebook(NotebookSeed(target: AnnotationTarget(type: "annotation", id: Int64(n)))))
    case .info:
      return
    }
  }

  /// Tracks the native-script form of a romanised match (never the romanised spelling).
  func track(_ m: RomanisedMatch) async {
    await track(surface: m.form, kind: nil, lang: m.lang, label: m.form)
  }

  /// POST /api/expressions, then pin the new strand.
  func track(surface: String, kind: String?, lang: String?, label: String) async {
    guard let atlas = app.atlas, let experience else { return }
    working = surface
    defer { working = nil }
    do {
      let r = try await atlas.trackExpression(TrackExpressionRequest(surface: surface, lang: lang, kind: kind, corpus: app.viewState.corpus))
      experience.pin(type: "expression", id: .number(Int(r.expression.id.rawValue)), label: r.expression.surface)
      if r.state.status == "materializing" { app.banner = SearchCopy.countingNew }
    } catch {
      app.banner = ErrorCardModel(any: error).message
    }
  }

  /// A KWIC preview row opens its passage.
  func open(_ row: KwicRow) {
    experience?.select(InspectedRef(type: "passage", id: Int(row.passage.rawValue)).selection)
  }
}
