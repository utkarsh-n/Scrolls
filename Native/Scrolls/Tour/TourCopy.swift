// OWNER: N8
// The first minute's and the tour's own words (IOS-SPEC §4.17; `tour/coachmarks.mjs` coachCopy, `tour/tour.mjs`).
// British English, no mental-state verbs. Names, years and sources in a coach mark come from the data on screen.

nonisolated enum TourCopy {
  static let thePhrase = "the phrase"
  /// Coach ① (`coachCopy` stage 1), with the observed word bold in the card.
  static func coachOne(_ label: String) -> String {
    "Bars span where \u{2018}\(label)\u{2019} was observed. Gaps are real: dotted = looked and found none; hatched = no sources."
  }
  static let observed = "observed"
  static let aDocumentedRecord = "a documented record"
  static let syntheticSuffix = " (synthetic)"
  static let computedByMatching = "computed by text matching"
  static func runSuffix(_ run: Int) -> String { " (run #\(run))" }
  /// The phone's form of coach ②'s last line ("Click" becomes "Tap").
  static let lineStyle = "Line style = evidence. Tap any mark to read its source."
  static let pressPlay = "Press ▶ to watch the phrase acquire history."
  static let yourTurn = "Your turn."
  static let waitingForEngine = "Waiting for the engine."
  static let cipher = "Cipher"
  static let cipherReady = "Cipher titles, relations, etymology and full text are ready."
  static let fullTextIndexing = "full text indexing"
  static func cipherMetadataReady(_ message: String) -> String { "Cipher titles, relations and etymology ready · \(message)" }
  static func cipherImporting(_ percent: Int?) -> String {
    "Cipher: importing titles & relations" + (percent.map { " · \($0)%" } ?? "")
  }

  static let step = "of 3"
  static func stepLabel(_ n: Int) -> String { "\(n) of 3" }
  static let firstMinute = "first minute"
  static let next = "Next"
  static let close = "Close"
  static let dismiss = "Dismiss the coach marks"
  static let dismissed = "Coach marks dismissed. More → Tour brings them back."
  static let switchToCipher = "Switch to Cipher (real data)"
  static let switchHint = "Cipher's titles, relations and etymology load on this phone first; the switch opens once they are ready."
  static let fullTour = "Full tour (4 min)"
  static let startFrom = "Start from"
  static let checking = "checking what Cipher holds…"
  static let nothingSuggested = "nothing confirmed in Cipher yet"
  static let fixtureNote = "Contract fixtures: these chips and counts are canned, not your atlas."
  /// Your turn's start words for Cipher (`START_CANDIDATES.cipher`, the expression ones).
  static let startWords = ["virus", "zero", "sample"]
  static func chipCount(_ n: Int) -> String { "\(n) matches in Cipher" }

  // The full tour card (`tour.mjs` render).
  static func tourTitle(_ i: Int, _ n: Int) -> String { "Guided tour · step \(i) of \(n)" }
  static let doLabel = "Do: "
  static let seeLabel = "You see: "
  static let learnLabel = "It shows: "
  static let back = "Back"
  static let showMe = "Show me"
  static let closeTour = "Close the tour"
  static let loadingTour = "Loading the tour…"
  static func tourTime(_ minutes: Int) -> String { "About \(minutes) minutes in all; steps 1–3 are the first minute." }

  /// The phone's words for a step that names a desktop key (§4.17: E twice → the Evidence chip, L → the Lanes chip,
  /// a ruler brush for A/B, the mark menu and More → Save view for G/N/S).
  static func phoneAction(_ n: Int, _ action: String) -> String {
    switch n {
    case 3: action.replacing("presses E twice", with: "taps the Evidence chip twice")
    case 5: action.replacing("Presses L", with: "Taps the Lanes chip")
    case 7: "Brushes 1955–1985 and 1994–2026 on the ruler, then Compare"
    case 9: "Long-presses the mark: Lineage, then Annotate; then More → Save view"
    default: action.replacing("Clicks", with: "Taps")
    }
  }
}
