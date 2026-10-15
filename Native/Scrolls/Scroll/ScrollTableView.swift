// OWNER: N7
// The table alternative (IOS-SPEC §4.19, N-18; port of a11y-table.mjs): the Scroll as a `List` grouped by lane and
// strand, one row per bin — "1910s · 14 · 367 per million [201–616] · 38k tokens · observed · single source" — then the
// segments in time order (bars, absences, low coverage, gaps, washes). It is built from THE SAME `StrandSeries` arrays
// the renderer draws (`ScrollWords.tables` hands over the painter's own columns; ScrollAppTests check the identity), so
// what is read equals what is drawn. Gated or suppressed numbers print "—", never 0; a low bin never prints a rate.

import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum TableCopy {
  static let title = "The Scroll as a table"
  static let done = "Done"
  static let empty = "Nothing is drawn yet: no lanes with strands."
  static let segments = "In time order"
  static let synthetic = "SYNTHETIC — invented material"
  static let columns = ["bin", "n", "rate", "95% CI", "coverage", "state", "flags"]
}

struct ScrollTableView: View {
  let model: ScrollModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        let tables = model.build.map { ScrollWords.tables($0.model) } ?? []
        if tables.isEmpty {
          Text(TableCopy.empty).foregroundStyle(Tokens.ink2.color)
        }
        ForEach(tables) { t in
          Section {
            if t.synthetic {
              Text(TableCopy.synthetic).font(Typography.meta).foregroundStyle(Tokens.syn.color)
            }
            ForEach(t.rows) { row in
              VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                  Text(row.bin).font(Typography.tableNumber).foregroundStyle(Tokens.ink.color)
                  Spacer()
                  Text(row.state).font(Typography.meta).foregroundStyle(row.state == "observed" ? Tokens.ink.color : Tokens.ink2.color)
                }
                Text("n = \(row.n) · \(row.rate) \(row.ci) · \(row.coverage)\(row.flags.isEmpty ? "" : " · \(row.flags)")")
                  .font(Typography.tableNumber)
                  .foregroundStyle(Tokens.ink2.color)
              }
              .accessibilityElement(children: .combine)
              .listRowBackground(Tokens.bg1.color)
            }
            DisclosureGroup(TableCopy.segments) {
              ForEach(Array(t.segments.enumerated()), id: \.offset) { _, s in
                Text(s).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
              }
            }
            .listRowBackground(Tokens.bg1.color)
          } header: {
            VStack(alignment: .leading, spacing: 2) {
              Text("\(t.lane) · \(t.strand)").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
              Text(t.unit).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            }
            .textCase(nil)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Tokens.bg0.color)
      .navigationTitle(TableCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button(TableCopy.done) { dismiss() } }
      }
    }
    .accessibilityIdentifier("scrollTable")
  }
}
