// OWNER: N7
// The shelf chips (IOS-SPEC §4.3, §4.7; SPEC §1.4, §1.7; port of shelves.mjs): at the trailing edge of each lane's
// header strip, `⊘ 172` (UNDATED: outside chronology) and `⇥ 1` (SCHEDULED: dated after today), each a sticky glass chip
// that opens its searchable list in the inspector (N8's shelf list). Undated items never enter bins, rates or
// denominators; scheduled items never enter the chronology either. A lane with nothing on a shelf shows no chip.

import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum ShelfCopy {
  static let undated = "UNDATED"
  static let scheduled = "SCHEDULED"
  static let undatedGlyph = "⊘"
  static let scheduledGlyph = "⇥"
  static let undatedNote = "Undated items never enter bins, rates or denominators."
  static let scheduledNote = "Dated after today (announced); outside the chronology until then."

  /// "Classroom: 172 undated — list them".
  static func label(lane: String, n: Int, which: String) -> String {
    "\(lane): \(Format.int(n)) \(which.lowercased()) — list them"
  }
}

struct ShelfChips: View {
  let model: ScrollModel
  let lane: LaneModel

  var body: some View {
    HStack(spacing: 4) {
      if lane.undated > 0 { chip(ShelfCopy.undatedGlyph, n: lane.undated, which: "undated", title: ShelfCopy.undated, note: ShelfCopy.undatedNote) }
      if lane.scheduled > 0 {
        chip(ShelfCopy.scheduledGlyph, n: lane.scheduled, which: "scheduled", title: ShelfCopy.scheduled, note: ShelfCopy.scheduledNote)
      }
    }
  }

  private func chip(_ glyph: String, n: Int, which: String, title: String, note: String) -> some View {
    Button {
      model.app.experience.openShelf(ShelfRef(which: which, lane: lane.key, strand: nil, title: "\(title) · \(lane.label)"))
    } label: {
      Text("\(glyph) \(Format.int(n))")
        .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
        .foregroundStyle(Tokens.ink.color)
        .padding(.horizontal, 7)
        .frame(height: 16)
        .chromeGlass(in: Capsule(), interactive: true)
        .frame(minWidth: Tokens.Geometry.minHit, minHeight: 18)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(ShelfCopy.label(lane: lane.label, n: n, which: title))
    .accessibilityHint(note)
    .accessibilityIdentifier("shelf-\(which)-\(lane.key)")
  }
}
