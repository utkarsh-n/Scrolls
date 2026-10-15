// OWNER: N6
// The words of the saved-views sheet and the as-saved banner (IOS-SPEC §4.15; SPEC §7.2, D17). The drift sentence
// itself comes from the engine (`Views.driftMessage`, byte-equal to the reference); these are the phone's own lines.

import Foundation
import ScrollsCore

nonisolated enum ViewsCopy {
  static let title = "Saved views"
  static let done = "Done"
  static let saveSection = "Save this view"
  static let namePlaceholder = "Name"
  static let descriptionPlaceholder = "A line about it (optional)"
  static let save = "Save view"
  static let saving = "saving the view…"
  static let savedSection = "Saved"
  static let searchPrompt = "Find a saved view"
  static let loading = "reading the saved views…"
  static let none = "No saved views yet. A saved view keeps the counts it was saved with: later imports and runs never change them."
  static let noMatches = "No saved view has that name."
  static let open = "Open as saved"
  static let openCurrent = "Open with current data"
  static let share = "Share link"
  static let delete = "Delete"
  static let deleteTitle = "Delete this saved view?"
  static let deleteMessage = "Its link stops opening. The view itself is kept in the notebook's history, unchanged."
  static let cancel = "Cancel"
  static let synthetic = "SYNTHETIC"
  static let resaveNote = "Saving again never changes a saved view: it makes a new one beside it."
  static let immutableNote = "A saved view is immutable. It pins the imports, the analysis runs and the notebook as they are now."
  static let fixtures = "Contract fixtures: saving shows a canned answer and writes nothing."
  static let needsName = "A saved view needs a name."

  static func savedLine(_ slug: String) -> String { "Saved as \(slug)." }
  static func fromParent(_ parent: String) -> String { "saved again from \(parent)" }
  static func savedAt(_ iso: String) -> String { "saved \(DisplayTime.day(iso))" }
  static func pinned(_ batch: Int, _ runs: Int) -> String {
    "Pinned: imports up to #\(batch)" + (runs > 0 ? ", \(runs) analysis run\(runs == 1 ? "" : "s")" : "")
  }

  /// The banner over the Scroll once a view is open as saved.
  static func asSavedBanner(name: String, savedAt: String) -> String {
    "As saved on \(DisplayTime.day(savedAt)): \(name). Counts are the ones it was saved with."
  }
  static let currentBanner = "Opened with current data; 'As saved' keeps the counts it was saved with."
  static func restoring(_ lines: [String]) -> String { lines.joined(separator: "; ") }
}

/// Dates for people: the day of an ISO-8601 instant (UTC, as the engine stores it), e.g. "13 Oct 2026".
nonisolated enum DisplayTime {
  static func day(_ iso: String) -> String {
    let u = Array(iso.utf8)
    guard u.count >= 10, let y = Int(String(decoding: u[0..<4], as: UTF8.self)),
      let m = Int(String(decoding: u[5..<7], as: UTF8.self)), let d = Int(String(decoding: u[8..<10], as: UTF8.self)),
      (1...12).contains(m)
    else { return iso }
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return "\(d) \(months[m - 1]) \(y)"
  }

  /// "13 Oct 2026, 14:51 UTC".
  static func minute(_ iso: String) -> String {
    let u = Array(iso.utf8)
    guard u.count >= 16 else { return day(iso) }
    return "\(day(iso)), \(String(decoding: u[11..<16], as: UTF8.self)) UTC"
  }
}
