// OWNER: N8
// The search's own words (IOS-SPEC §4.9; `shell/search.mjs`). British English; no mental-state verbs. Counts always
// carry what they count.

import ScrollsCore

nonisolated enum SearchCopy {
  /// `PLACEHOLDER.long` / `.short` of the reference.
  static let placeholder = "Search a word, phrase, work, maker or theme"
  static let placeholderShort = "Search words, works, themes"
  static let fieldLabel = "Search"
  static let clear = "Clear the search"
  static let cancel = "Cancel"
  static let groupExpressions = "Expressions"
  static let groupWorks = "Works"
  static let groupMakers = "Makers"
  static let groupThemes = "Themes"
  static let groupEtymology = "Etymology"
  static let groupAnnotations = "Annotations"
  static let groupSources = "Sources"
  static let track = "Track as strand"
  static let pin = "Pin"
  static let genealogy = "Genealogy"
  static let openCard = "Card"
  static let romanisedTitle = "Romanised matches"
  static let romanisedNote = "romanised match — a suggestion, not a merge"
  static let counting = "counting…"
  static let countingNew = "Counting the new expression…"
  static let preliminary = "preliminary: passages containing"
  static let notCounted = "not counted yet"
  static let tryAgain = "Retry"
  static let examples = "Passages"
  static let variantsTried = "Variants tried"
  static let searching = "Searching…"
  static let noSuggestions = "No suggestions for this search."
  static let typeahead = "title typeahead: suggested, not counted"
  static let maxStrands = "At most 4 strands can be pinned; unpin one first."

  /// Badge word per suggestion type (`TYPE_BADGE`: always a word, never colour alone).
  static let typeBadge: [String: String] = [
    "expression": "EXPR", "work": "WORK", "maker": "MAKER", "theme": "THEME", "etymology": "ETYM", "adapter": "SOURCES",
    "annotation": "NOTE",
  ]

  /// A suggestion's count with what it counts (§4.1 rule 6, §4.9 "count, unit and corpus"): an expression's matches in
  /// the corpus searched ("340 matches · Demo"), a maker's or a theme's documents, the annotations that mention it.
  static func countWords(type: String, count n: Int, corpus: String?) -> String {
    switch type {
    case "expression": [matches(n), corpus].compactMap { $0 }.joined(separator: " · ")
    case "maker", "theme", "work": n == 1 ? "1 document" : "\(Format.int(n)) documents"
    case "annotation": n == 1 ? "1 annotation" : "\(Format.int(n)) annotations"
    default: Format.int(n)
    }
  }

  /// "331 passages" (one → "1 passage"): passages containing a form, not matches.
  static func passages(_ n: Int) -> String { n == 1 ? "1 passage" : "\(Format.int(n)) passages" }

  /// "412 matches" (one match → "1 match").
  static func matches(_ n: Int) -> String { n == 1 ? "1 match" : "\(Format.int(n)) matches" }

  /// The language of a romanised match's script.
  static func languageName(_ lang: String) -> String {
    switch lang {
    case "hi": "Hindi"
    case "gu": "Gujarati"
    default: lang
    }
  }

  /// The hits line: "331 passages · 96 documents · 1 undated" (`search.mjs` render).
  static func hitsLine(_ h: SearchHitsWords) -> String {
    var parts = ["\(Format.int(h.passages)) passages", "\(Format.int(h.documents)) documents"]
    if h.undated > 0 { parts.append("\(Format.int(h.undated)) undated") }
    if h.namesExcluded > 0 { parts.append("\(Format.int(h.namesExcluded)) proper-noun hits excluded") }
    if h.preliminary { parts.append("preliminary (not yet counted)") }
    return parts.joined(separator: " · ")
  }

  /// "carries the zero (inflection, computed)".
  static func variant(_ form: String, type: String, status: String) -> String { "\(form) (\(type), \(status))" }

  /// "Pinned carry the zero."
  static func pinned(_ label: String) -> String { "Pinned \(label)." }
}

/// The numbers of a hits line, so the copy formats them without importing contract types.
nonisolated struct SearchHitsWords: Sendable, Equatable {
  var passages: Int
  var documents: Int
  var undated: Int
  var namesExcluded: Int
  var preliminary: Bool
}
