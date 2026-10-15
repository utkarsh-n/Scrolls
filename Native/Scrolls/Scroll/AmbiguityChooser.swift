// OWNER: N7
// The ambiguity chooser (IOS-SPEC §4.5): when two or more marks lie within 6 pt of each other under a tap, a popover
// (compact adaptation: a popover, never a sheet) lists up to six of them in the hit grid's order — "1994 · Zero Holds
// the Place · song" — and the chosen row answers as a tap on it would. Titles come from the documents; until a title
// arrives the row says what the mark itself carries (date, lane, kind), never a guess.

import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum ChooserCopy {
  static let title = "Several marks here"
  static let hint = "They lie within 6 pt of each other. Pick one."
  static let synthetic = "SYN"
  static let untitled = "untitled document"
}

struct AmbiguityChooser: View {
  let model: ScrollModel
  let choice: AmbiguityChoice
  @State private var titles: [Int64: String] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 2) {
        Text(ChooserCopy.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Text(ChooserCopy.hint).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      Divider().overlay(Tokens.rule.color)
      ForEach(choice.rows) { row in
        Button {
          model.choose(row)
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(row.date).font(Typography.count).foregroundStyle(Tokens.ink.color)
            Text(title(row)).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).lineLimit(1)
            Text(row.kind).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            Spacer(minLength: 4)
            if row.synthetic { EvidenceBadge(ChooserCopy.synthetic) }
          }
          .padding(.horizontal, 14)
          .frame(minHeight: Tokens.Geometry.minHit)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(row.date), \(title(row)), \(row.kind), \(row.lane)")
      }
    }
    .frame(minWidth: 280, maxWidth: 360)
    .background(Tokens.bg1.color)
    .presentationCompactAdaptation(.popover)
    .task { await loadTitles() }
  }

  private func title(_ row: AmbiguityChoice.Row) -> String {
    if let doc = row.doc, let t = titles[doc.rawValue] { return t }
    return row.lane
  }

  private func loadTitles() async {
    guard let atlas = model.app.atlas else { return }
    for row in choice.rows {
      guard let doc = row.doc, titles[doc.rawValue] == nil else { continue }
      if let d = try? await atlas.document(doc) { titles[doc.rawValue] = d.title ?? ChooserCopy.untitled }
    }
  }
}
