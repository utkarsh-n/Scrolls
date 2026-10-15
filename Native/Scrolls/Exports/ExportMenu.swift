// OWNER: N3
// The Exports menu (IOS-SPEC §3.10, SPEC §7.3): one ShareLink per kind of rows and format, for the view as it is drawn
// now. Each file is built only when the share sheet asks for it; its manifest travels first. Placed by the shell (More)
// next to Save view; it needs only the atlas and the current view state.

import ScrollsCore
import ScrollsService
import SwiftUI

struct ExportMenu: View {
  let atlas: any AtlasService
  let viewState: ViewState

  private static let whats: [(key: String, label: String, symbol: String, needsStrand: Bool)] = [
    ("occurrences", ExportsCopy.occurrences, "text.magnifyingglass", true),
    ("aggregates", ExportsCopy.aggregates, "chart.bar", true),
    ("passages", ExportsCopy.passages, "text.alignleft", true),
    ("relationships", ExportsCopy.relationships, "arrow.triangle.branch", false),
    ("annotations", ExportsCopy.annotations, "note.text", false),
  ]
  private static let formats: [(key: String, label: String)] = [("csv", ExportsCopy.csv), ("json", ExportsCopy.json),
                                                                 ("jsonl", ExportsCopy.jsonl)]

  var body: some View {
    let state = ViewState.encode(viewState)
    let tier = viewState.tier == "auto" ? "L2" : viewState.tier
    Menu {
      ForEach(Self.whats, id: \.key) { what in
        if what.needsStrand && viewState.strands.isEmpty {
          Text(ExportsCopy.noStrand)
        } else {
          Menu {
            ForEach(Self.formats, id: \.key) { format in
              let file = ExportFile(atlas: atlas, state: state, what: what.key, format: format.key, tier: tier)
              ShareLink(item: file, preview: SharePreview("\(what.label) · \(format.label)")) {
                Text(format.label)
              }
            }
          } label: {
            Label(what.label, systemImage: what.symbol)
          }
        }
      }
      Section {
        Text(ExportsCopy.manifestNote)
        Text(ExportsCopy.withheldNote)
        if viewState.corpus == "demo" { Text(ExportsCopy.syntheticNote) }
      }
    } label: {
      Label(ExportsCopy.title, systemImage: "square.and.arrow.up")
    }
    .accessibilityIdentifier("exportMenu")
  }
}
