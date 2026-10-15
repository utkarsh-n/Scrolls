// OWNER: N6
// The words of the notebook and the Annotate card (IOS-SPEC §4.13; SPEC §2.F, D18). An annotation is his reading,
// kept beside the evidence and never mixed into it; every edit is a new revision, and nothing is ever overwritten.

import Foundation

nonisolated enum NotebookCopy {
  static let title = "Notebook"
  static let annotate = "Annotate"
  static let cancel = "Cancel"
  static let save = "Save"
  static let saving = "saving the note…"
  static let loading = "reading the notes…"
  static let none = "No notes here yet. A note is your reading of the evidence: it is kept beside it, never mixed into it."
  static let kind = "Kind"
  static let bodyPlaceholder = "What you read in it"
  static let tagsPlaceholder = "Tags, separated by commas"
  static let layerPlaceholder = "Layer (optional)"
  static let quoteHeader = "The words it is about"
  static let notesHeader = "Notes on this"
  static let revisions = "Revisions"
  static let revise = "Revise"
  static let reviseReason = "Why (optional)"
  static let withdraw = "Withdraw"
  static let withdrawReason = "Why you withdraw it (optional)"
  static let withdrawTitle = "Withdraw this note?"
  static let withdrawMessage = "It stays in the notebook's history, marked withdrawn; nothing is deleted."
  static let reinterpret = "Read it differently"
  static let all = "All"
  static let active = "Active"
  static let empty = "The note is empty."
  static let machine = "machine annotation — not evidence"
  static let anchorMoved = "The words were found again after the text moved; the note follows them."
  static let filterAll = "Include superseded and withdrawn notes"
  static let noAnchor = "This passage could not be read, so the note cannot be anchored to its words."
  static let hypothesisNote = "A hypothesis is a reading to test, not evidence."

  static let kindLabels: [String: String] = [
    "interpretation": "Interpretation", "evidence_for": "Evidence for", "evidence_against": "Evidence against",
    "hypothesis": "Hypothesis", "question": "Question", "correction": "Correction", "label": "Label",
  ]
  /// The kinds a person may write (the machine kinds are written by runs only).
  static let humanKinds = ["interpretation", "question", "hypothesis", "evidence_for", "evidence_against", "correction"]

  static let statusWords: [String: String] = ["active": "active", "superseded": "read differently since", "withdrawn": "withdrawn"]

  static func target(_ type: String, _ id: Int64) -> String {
    let names = ["passage": "Passage", "occurrence": "Occurrence", "document": "Document", "expression": "Expression",
                 "cluster": "Context group", "relationship": "Link", "hypothesis_group": "Hypothesis group",
                 "saved_view": "Saved view", "time_window": "Time window", "annotation": "Note"]
    return "\(names[type] ?? type) #\(id)"
  }
  static func revisionLine(_ rev: Int, _ at: String, _ author: String) -> String { "rev \(rev) · \(DisplayTime.minute(at)) · \(author)" }
  static func revisionsCount(_ n: Int) -> String { n == 1 ? "1 revision" : "\(n) revisions" }
  static func by(_ author: String) -> String { "by \(author)" }
}
