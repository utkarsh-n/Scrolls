// OWNER: N4
// The words of Compare (IOS-SPEC §4.10; src/ui/panels/compare.mjs, ported byte-equal where the web says the same thing,
// plus the phone's own: the range strip, the gate card actions and the tone availability card of ΔS-17). No string here
// states a number of its own: every numeral on the screen comes from the payload through `Format`.

import Foundation

nonisolated enum CompareCopy {
  static let title = "Compare"
  static let back = "Back"
  static let editSlices = "Edit slices"
  static let done = "Done"
  static let compare = "Compare"
  static let reshuffle = "Reshuffle"
  static let retry = "Retry"

  // sections (compare.mjs section titles)
  static let coverage = "Coverage & composition"
  static let frequency = "Frequency"
  static let withinCell = "Within-cell shares (OpenAlex)"
  static let baseline = "External baseline"
  static let passages = "Representative passages"
  static let terms = "Neighbouring terms"
  static let groups = "Context groups"
  static let measures = "Estimated displacement"
  static let tone = "Tone and stance"
  static let caveats = "How coverage could affect this"

  // labels
  static let contextWordsLabel = "context words, not meanings"
  static let shiftLabel = "estimated shift in usage contexts"
  static let shiftLine = "An estimated shift in usage contexts, never a verdict about meaning."
  static let toneLabel = "Apple NLTagger — modern reader model, fallible, anachronistic for historical text"
  static let baselineRhoLabel = "Google Books Ngram is a different corpus"
  static let measureLabels: [String: String] = [
    "rate_ratio": "Rate ratio", "sense_share_jsd": "Context-share shift", "neighbor_overlap": "Neighbour overlap",
    "aligned_displacement": "Aligned displacement", "convergence": "Convergence",
  ]

  // gate card titles (compare.mjs)
  static let freqNotCompared = "Frequency not compared"
  static let rateRatioNotEstimated = "Rate ratio not estimated"
  static func rateNotEstimated(_ slice: String) -> String { "Rate for slice \(slice) not estimated" }
  static let termsNotComputed = "Neighbouring terms not computed"
  static let groupsNotAvailable = "Context groups not available"
  static let toneNotComputed = "Machine tone not computed"
  static let rhoNotComputed = "Spearman ρ against the Ngram baseline not computed"
  static let crossMediaRefused = "Cross-media comparison refused"
  static func measureNotEstimated(_ label: String) -> String { "\(label): not estimated" }

  // actions
  static let compareAnyway = "Compare anyway (descriptive only)"
  /// The modality gate's own suggestion is worded by the engine ("Compare titles with titles").
  static let applyWidening = "Apply"

  // empty states (compare.mjs renderEmptyCard)
  static let noFrequency = "No frequency was reported for these slices."
  static let noTerms = "No neighbouring terms were reported."
  static let noGroups = "Context groups need a clustering run; none exists for this comparison."
  static let noBaseline = "No correlation with the external baseline was reported."
  static let noMeasures = "No displacement measure was requested."
  static let noPassagesInSlice = "No passages in this slice."
  static let noCell = "No OpenAlex cell fits this slice."
  static let noCaveat = "No caveat fired."
  static let differentUnits = "No rate ratio: the slices are counted in different units."
  static let noHumanPragmatic = "No human annotations of pragmatic function in either slice."
  static let humanPragmatic = "Pragmatic function (human annotations)"
  static let pinExpression = "Pin an expression to compare it across the two slices."
  static let setSlices = "Set two slices: brush a range on the Scroll and press A, then another range and press B, or drag the brackets above."
  static let none = "none"

  // terms tabs
  static let tabShared = "Around both"
  static let tabOnlyA = "Only around A"
  static let tabOnlyB = "Only around B"
  static let keynessTitle = "Keyness (log ratio, Benjamini–Hochberg q < .05)"

  // tone availability on the phone (IOS-SPEC §4.10 item 8, ΔS-17)
  static let toneModelMissing = "Tone needs Apple's English sentiment model, which is not on this phone."
  static let toneDownload = "Download Apple's language assets (a system download)"

  // runs a gate card suggests (runs.mjs)
  static let runNotStarted = "The run could not be started."
  static func runWords(_ stage: String) -> String { GateCardCopy.runStageWords[stage] ?? "a \(stage) run" }
  static func runLabel(_ stage: String) -> String { "Start \(runWords(stage))" }
  static func running(_ stage: String, _ job: Int) -> String { "Running \(runWords(stage)) (job \(job)); Compare asks again when it ends…" }
  static func runEnded(_ stage: String, _ status: String, _ message: String?) -> String {
    "\(runWords(stage).prefix(1).uppercased() + runWords(stage).dropFirst()) ended \(status)\(message.map { ": \($0)" } ?? "")."
  }

  // the range strip
  static let stripLabel = "Slices on the time axis"
  static let yearsHint = "Years before the common era are astronomical: 0 is 1 BCE, −44 is 45 BCE."
  static func bracketLabel(_ slice: String) -> String { "Slice \(slice)" }

  // loading
  static func comparing(_ a: String, _ b: String) -> String { "Comparing \(a) with \(b)…" }
  static let couldNotCompute = "The comparison could not be computed."
  static let noEngine = "No atlas is open, so nothing can be compared."

  // fixtures and synthetic data (SPEC §13 rule 6)
  static let fixtures = "Contract fixtures (MockAtlas): canned responses, not your atlas."
  static let syntheticNote = "The comparison includes SYNTHETIC demonstration data."
}
