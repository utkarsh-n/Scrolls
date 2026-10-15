// OWNER: N8
// More (IOS-SPEC §4.2): every action that is not a thumb control — Sources and storage, Saved views, Save view, Import a
// file, Lanes, Filters, Legend, Compare, the Tour, How Scrolls works, Settings, Jobs and Diagnostics — each presented
// through the PresentationCoordinator (one system presentation at a time). At accessibility text sizes the SYNTHETIC
// ribbon keeps only its stripes and its sentence moves here.

import ScrollsCore
import SwiftUI

nonisolated enum MoreCopy {
  static let more = "More"
  static let sources = "Sources and storage"
  static let savedViews = "Saved views"
  static let saveView = "Save view"
  static let importFile = "Import a file"
  static let lanes = "Lanes"
  static let filters = "Filters"
  static let legend = "Legend"
  static let compare = "Compare"
  static let tour = "Tour"
  static let howItWorks = "How Scrolls works"
  static let settings = "Settings"
  static let jobs = "Jobs"
  static let diagnostics = "Diagnostics"
  static let shareLink = "Share link"
}

struct MoreMenu: View {
  let model: AppModel
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let c = model.coordinator
    Menu {
      if typeSize.isAccessibilitySize, model.syntheticInScope {
        Section { Text(RibbonCopy.sentence) }
      }
      Section {
        Button(MoreCopy.lanes, systemImage: "rectangle.split.1x2") { c.present(.lanes) }
        Button(MoreCopy.filters, systemImage: "line.3.horizontal.decrease") { c.present(.filters) }
        Button(MoreCopy.legend, systemImage: "list.bullet.rectangle") { c.present(.legend) }
        Button(MoreCopy.compare, systemImage: "square.split.2x1") { openCompare() }
      }
      Section {
        Button(MoreCopy.saveView, systemImage: "bookmark") { c.present(.savedViews) }
        Button(MoreCopy.savedViews, systemImage: "books.vertical") { c.present(.savedViews) }
        if let link = DeepLinks.link(for: model.viewState) {
          ShareLink(item: link) { Label(MoreCopy.shareLink, systemImage: "link") }
        }
        Button(MoreCopy.importFile, systemImage: "square.and.arrow.down") { c.present(.importFile(nil)) }
        Button(MoreCopy.sources, systemImage: "externaldrive") { c.present(.sources) }
      }
      Section {
        Button(MoreCopy.tour, systemImage: "figure.walk") { model.experience.tour.replay() }
        Button(MoreCopy.howItWorks, systemImage: "info.circle") { c.present(.howItWorks) }
        Button(MoreCopy.settings, systemImage: "gearshape") { c.present(.settings) }
        Button(MoreCopy.jobs, systemImage: "list.bullet.clipboard") { c.present(.jobs) }
        Button(MoreCopy.diagnostics, systemImage: "stethoscope") { c.present(.diagnostics) }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(Typography.chrome)
        .foregroundStyle(Tokens.ink.color)
        .frame(width: 32, height: 32)
        .chromeGlass(in: Circle(), interactive: true)
        .frame(width: Tokens.Geometry.minHit, height: Tokens.Geometry.minHit)
        .contentShape(Rectangle())
    }
    .accessibilityLabel(MoreCopy.more)
    .accessibilityIdentifier("moreMenu")
  }

  /// Compare from the view's range when it has one (A = the range, B = the rest up to the vantage), else from the
  /// default slices of the reference (1955–1985 and 1994–2026 on the demo; two halves of 1800–2026 elsewhere).
  private func openCompare() {
    let v = model.viewState
    let seed: CompareSeed
    if let c = v.compare, c.a.years.count == 2, c.b.years.count == 2 {
      seed = CompareSeed(SliceSeed(fromYear: c.a.years[0], toYear: c.a.years[1], filter: c.a.f),
                         SliceSeed(fromYear: c.b.years[0], toYear: c.b.years[1], filter: c.b.f), viewHash: v.hash)
    } else if v.corpus == "demo" {
      seed = CompareSeed(SliceSeed(fromYear: 1955, toYear: 1985), SliceSeed(fromYear: 1994, toYear: 2026), viewHash: v.hash)
    } else {
      seed = CompareSeed(SliceSeed(fromYear: 1800, toYear: 1913), SliceSeed(fromYear: 1914, toYear: 2026), viewHash: v.hash)
    }
    model.coordinator.push(.compare(seed))
  }
}
