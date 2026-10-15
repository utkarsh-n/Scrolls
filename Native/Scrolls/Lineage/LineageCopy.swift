// OWNER: N5
// The words of the Lineage explorer, the genealogy, the edge card, the chain of custody and the hypothesis-group card,
// ported from the reference's panels (src/ui/panels/{lineage,genealogy,edge-card}.mjs) and SPEC §2.C/§2.C2. Honesty
// rules (SPEC §13): similarity never establishes influence; a cue is proposed, never documented; a review never
// changes the evidence status; absence of a link is not evidence of no reuse; scores are never probabilities.

import Foundation
import ScrollsCore

nonisolated enum LineageCopy {
  static let title = "Lineage — chain of custody"
  static let genealogyTitle = "Genealogy"
  static let rowsNote = "x = the Scroll time scale; rows = hops from the root, never meaning"
  static let ordinalLabel = "ordinal spacing — equal width per dated year"
  static let linearLabel = "linear time"
  static let caution = "Shared wording or similar contexts can come from a common source; they do not establish influence or intent."
  static let documentedOnly = "Documented only"
  static let allEvidence = "All evidence"
  static let documentedComputed = "Documented + computed"
  static let showRejected = "Show rejected (✕, struck)"
  static let showAsList = "Show as list"
  static let showAsGraph = "Show as graph"
  static let chainStart = "Chain of custody: pick two nodes"
  static let chainStop = "Stop chain of custody"
  static let chainCosts = "least-evidence-cost chain: documented 1, computed 3, proposed 5; rejected excluded"
  static let chainFinding = "Finding the chain…"
  static let noLinks = "No recorded links for this root under these filters."
  static let loadFailed = "The lineage could not be loaded."
  static let expand = "Expand one hop"
  static let lineageFromHere = "Lineage from here"
  static let genealogyFromHere = "Genealogy of this work"
  static let openLink = "Open link card (review, evidence)"
  static let commonplaceNote = "Text shared by many documents is one node, not a quotation edge between every pair."
  static let undatedGutter = "undated"
  static let competing = "Competing hypotheses"
  static let groupNote = "Nothing is deleted: confirming one hypothesis leaves the others as they were."
  static let notInRow = "not in a hop row"

  // edge card
  static let supportingSpans = "Supporting spans"
  static let diffNote = "Shared words plain; substitutions underlined; insertions and omissions dotted."
  static let external = "external"
  static let revisions = "Revision history"
  static let confirm = "Confirm"
  static let reject = "Reject"
  static let dispute = "Dispute"
  static let attach = "Attach evidence"
  static let notePlaceholder = "Say what you checked (at least 10 characters)."
  static let reviewNote = "Your note is kept as an annotation; the evidence status never changes."
  static let attachNote = "Start and end are characters (UTF-16) into that passage’s text."
  static let cue = "Attribution cue"
  static let cueNote = "A cue names a source; which text it refers to is inferred, so the link stays proposed until a person confirms it."
  static let loadingLink = "Loading the link…"
  static let linkFailed = "The link could not be loaded."
  static let groupFailed = "The hypothesis group could not be loaded."
  static let minNote = 10

  // genealogy
  static let genealogyNoteFallback = "Absence of a link is not evidence of no sampling."
  static let relationEndpoint = "relation endpoint — not counted in title rates"
  static let genealogyFailed = "The genealogy could not be loaded."
  static let more = "Show more"

  /// `noteProblem(note)`: nil when the note is long enough.
  static func noteProblem(_ note: String) -> String? {
    let n = JSString.trim(note).utf16.count
    return n >= minNote ? nil : "A note needs at least \(minNote) characters (\(n) so far)."
  }

  /// "Pick 2 more nodes (…)".
  static func pickMore(_ n: Int) -> String { "Pick \(n) more node\(n == 1 ? "" : "s") (\(chainCosts))." }

  /// The row label of a generation.
  static func hopLabel(_ g: Int?) -> String {
    guard let g else { return notInRow }
    if g == 0 { return "root" }
    return "\(g > 0 ? "+" : "")\(g) hop\(abs(g) == 1 ? "" : "s")"
  }

  /// "showing 60 of 183 nodes".
  static func truncation(shown: Int, hidden: Int, reason: String?) -> String {
    reason ?? "showing \(shown) of \(shown + hidden) nodes"
  }

  /// Who or what created the link, in words (`originText`).
  static func origin(_ origin: String, createdBy: String, dataset: String?, method: String?, run: Int64?) -> String {
    let who = JSString.hasPrefix(createdBy, "human:") ? String(createdBy.dropFirst(6)) : createdBy
    switch origin {
    case "source_dataset": return "stated by a source dataset: \(dataset ?? "unnamed")"
    case "algorithm": return "computed by an algorithm" + (run.map { " (run \($0))" } ?? "")
    case "machine_tagger": return "proposed by a machine tagger" + (method.map { " (\($0))" } ?? "")
    case "human": return "proposed by a person: \(who.isEmpty ? "unnamed" : who)"
    default: return origin
    }
  }

  /// "similarity 0.71 — not a probability".
  static func score(_ value: Double, kind: String) -> String {
    let label = Copy.scoreKindLabels[kind] ?? "\(kind) — not a probability"
    let parts = label.components(separatedBy: " — ")
    let number = JSNumber.format((value * 1000).rounded() / 1000)
    return parts.count == 2 ? "\(parts[0]) \(number) — \(parts[1])" : "\(label) \(number)"
  }

  /// The result of a review (the evidence status is unchanged).
  static func reviewDone(revision: Int, status: String) -> String {
    "Review recorded (revision \(revision)): review status \(status); the evidence status is unchanged."
  }

  static func attachDone(_ id: Int) -> String { "Evidence #\(id) attached; the evidence status is unchanged." }

  static func competingCount(_ n: Int) -> String { "⚖ \(n) competing" }

  /// "+214 more — 1990s: 88".
  static func moreRows(_ hidden: Int) -> String { "+\(Format.int(hidden)) more works" }
}
