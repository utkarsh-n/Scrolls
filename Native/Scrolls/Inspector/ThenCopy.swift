// OWNER: N8
// The inspector's own words (IOS-SPEC §4.8; `panels/inspector.mjs`, `passage-card.mjs`, `timeline/drawer.mjs`, ported
// verbatim where the reference has them). British English; no mental-state verbs; every count names its denominator.

import ScrollsCore

nonisolated enum ThenCopy {
  /// The fixed footer of §2.D.
  static let footer = "Then shows documents and their settings, not anyone's private thoughts."
  /// With no recorded relationship (§2.D NOW).
  static let noRelationship = "No recorded relationship; these are separate uses of the same expression."
  static let contextLabel = "context words, not meanings"
  static let thenTab = "Then"
  static let nowTab = "Now"
  static let nextTab = "Next"
  static let thenSub = "the passage, in its setting"
  static let nowSub = "a later use"
  static let nextSub = "what followed"
  static let nowLater = "Now and Next arrive in a later build: the later passages and the relationships that link them to this one."
  static let openFailed = "This selection could not be opened."
  static let opening = "Opening the passage…"
  static let openingDocument = "Opening the document…"
  static let undated = "undated"
  static let showNeighbours = "Show neighbouring passages"
  static let hideNeighbours = "Hide neighbouring passages"
  static let openReader = "Open in reader"
  static let opensPassage = "Opens its passage."
  static let lineage = "Lineage"
  static let annotate = "Annotate"
  static let genealogy = "Genealogy: who sampled, covered, remixed it"
  static let contemporaryUses = "Contemporary uses"
  static let machineTitle = "Machine annotations (fallible)"
  static func renamedBy(_ label: String) -> String { " — renamed by a reader: \(label)" }
  static func refersTo(_ label: String) -> String { "refers to \(label)" }
  static func lookingIn(_ from: Int, _ to: Int) -> String { "Looking in \(from)–\(to)…" }
  static func noYear(_ label: String) -> String { "No year interval to centre a window on (date: \(label))." }
  static let noExpression = "No tracked expression is highlighted in this passage, so there are no uses to list."
  static func noOtherUse(_ from: Int, _ to: Int) -> String { "No other use of this expression is listed in \(from)–\(to)." }
  static func noUses(_ from: Int, _ to: Int) -> String {
    "No uses of this expression in \(from)–\(to) in the loaded corpus. 0 is an observation about this index."
  }
  static func showing(_ n: Int, perLane: Int) -> String { "showing \(n), at most \(perLane) per lane" }
  static func offsets(field: String, start: Int, end: Int) -> String {
    "\(field) · characters \(Format.int(start))–\(Format.int(end)) of the original"
  }
  static let syntheticLabel = "synthetic"
  static func collection(_ c: String) -> String { "collection \(c)" }
  static func licence(_ l: String) -> String { "licence \(l)" }
  static func language(_ l: String) -> String { "language \(l)" }

  // Passage notes (`passageNotes`, §13 rule 9: default exclusions are visible).
  static let fieldNotes: [String: String] = [
    "title": "title field", "native_title": "title in the original script", "summary": "summary field",
    "abstract": "abstract field", "gloss": "gloss field", "entry": "dictionary entry",
  ]
  static func field(_ f: String) -> String { fieldNotes[f] ?? "\(f) field" }
  static let describes = "describes the work and is not dated with it; excluded from counts by default"
  static let apparatus = "editorial apparatus; excluded from counts by default"
  static func quality(_ q: String) -> String { "quality: \(q.replacing("_", with: " ")); excluded from counts by default" }
  static let translation = "a translation: excluded from text-language chronology by default"

  // The document card of a selected work or book.
  static func documentTitle(_ id: Int) -> String { "Document \(id)" }
  static let tags = "Tags"
  static func passages(_ n: Int) -> String { "\(Format.int(n)) passages" }
  static func tokens(_ n: Int) -> String { "\(Format.tokens(n)) tokens" }

  // The drawer and the shelves (`drawer.mjs`).
  static let undatedShelf = "Undated items never enter bins, rates or denominators."
  static let scheduledShelf = "Dated after today (announced); outside the chronology."
  static let washesShelf = "Records whose dates do not fit one bin at this level: shown as washes, never added to bars or rates."
  static let filterList = "Filter this list"
  static let loadMore = "Load 50 more"
  static let loading = "loading…"
  static let closeList = "Close the list"
  static let undatedTitle = "Undated"
  static let scheduledTitle = "Scheduled"
  static let washesTitle = "Washes"
  static func binTitle(_ lane: String) -> String { "Bin · \(lane)" }
  static func contextsSampled(_ shown: Int, _ total: Int) -> String {
    "contexts sampled: \(Format.int(shown)) of \(Format.int(total)) in this bin"
  }

  // The reader (`reader.mjs`).
  static let readerTitle = "Reader"
  static let earlier = "Earlier"
  static let later = "Later"
  static let done = "Done"
  static func readerRange(_ from: Int, _ to: Int, _ length: Int) -> String {
    "characters \(Format.int(from))–\(Format.int(to)) of \(Format.int(length))"
  }
  static let metadataOnly = "Metadata only: there is no text to read for this document."

  // The start card and the idle sheet.
  static let startTitle = "Pin a strand to draw it"
  static let startTitleReal = "Where would you like to start?"
  static let startHint = "Until a strand is pinned the lanes show only each collection\u{2019}s dated span and size: nothing is counted yet."
  static let selectionCleared = "The saved selection no longer resolves in this atlas, so it was cleared."
  static let relationship = "Relationship"
}
