// OWNER: N7
// Long press on a mark (IOS-SPEC §4.5): `UIContextMenuInteraction` with a preview — the passage with its highlight and
// date chip, opaque (evidence is never refracted) — and the actions Open · Annotate · Lineage · Compare from this bin ·
// Copy citation. The preview reads the passage through the engine when the menu opens; until it arrives it shows what
// the mark itself carries (date, lane, kind). Anything that is not a mark (or a mark the vantage hides) gives no menu,
// so the long press on the ruler stays the brush's.

import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import SwiftUI
import UIKit

nonisolated enum MarkPreviewCopy {
  static let open = "Open"
  static let annotate = "Annotate"
  static let lineage = "Lineage"
  static let compare = "Compare from this bin"
  static let copyCitation = "Copy citation"
  static let loading = "Reading the passage…"
  static let unavailable = "The passage could not be read here."
  static let synthetic = "SYN"
  static let source = "Scrolls"

  /// "Zero Holds the Place, 1994 · Scrolls passage 1204 (Hip-hop)".
  static func citation(title: String?, date: String, passage: Int64, lane: String) -> String {
    "\(title ?? "Untitled document"), \(date) · \(source) passage \(passage) (\(lane))"
  }
}

/// The mark under a long press, with what the menu needs.
struct PressedMark: Equatable {
  var id: PrimID
  var mark: Mark
  var laneLabel: String
  var tier: Tier
}

extension ScrollGestureHost: UIContextMenuInteractionDelegate {
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                              configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard let pressed = model.mark(at: location) else { return nil }
    let model = self.model
    return UIContextMenuConfiguration(identifier: nil, previewProvider: {
      let host = UIHostingController(rootView: MarkPreview(model: model, pressed: pressed))
      host.view.backgroundColor = UIColor(red: 0x16 / 255, green: 0x1A / 255, blue: 0x20 / 255, alpha: 1)
      host.preferredContentSize = CGSize(width: 340, height: 230)
      return host
    }, actionProvider: { _ in
      MarkPreview.menu(model: model, pressed: pressed)
    })
  }
}

extension ScrollModel {
  /// The mark (occurrence or passage) under a canvas point, as the vantage shows it; nil for anything else.
  func mark(at p: CGPoint) -> PressedMark? {
    guard let build, Double(p.y) >= stripHeight else { return nil }
    let list = build.lanes
    let hits = list.hit.hits(contentPoint(p, list: list, part: .lanes), tolerance: CGFloat(HitGrid.touchTolerance), vantage: vantage)
    guard let e = hits.first(where: { $0.entry.hitClass == .mark })?.entry,
      case .mark(let l, let s, let mi) = build.laneMeta[Int(e.id.rawValue)].source,
      let mk = build.model.lanes[l].strands[s].marks?[mi] else { return nil }
    return PressedMark(id: e.id, mark: mk, laneLabel: build.model.lanes[l].label, tier: build.model.tier)
  }
}

/// The preview of a pressed mark: the passage text with its highlights, the date chip and the lane.
struct MarkPreview: View {
  let model: ScrollModel
  let pressed: PressedMark
  @State private var passage: PassageResponse?
  @State private var failed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(ScrollModelBuilder.markLabel(pressed.mark))
          .font(Typography.chromeCount)
          .foregroundStyle(Tokens.ink.color)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(Tokens.bg2.color, in: Capsule())
        Text("\(pressed.laneLabel) · \(pressed.mark.kind) · \(pressed.mark.precision) · \(pressed.mark.basis)")
          .font(Typography.meta)
          .foregroundStyle(Tokens.ink3.color)
          .lineLimit(1)
        Spacer(minLength: 0)
        if pressed.mark.synthetic { EvidenceBadge(MarkPreviewCopy.synthetic) }
      }
      if let passage {
        Text(highlighted(passage))
          .font(.system(.body, design: .serif))
          .lineSpacing(4)
          .lineLimit(7)
          .frame(maxWidth: .infinity, alignment: .leading)
        if let title = passage.document.title {
          Text(title).font(Typography.meta).foregroundStyle(Tokens.ink2.color).lineLimit(1)
        }
      } else {
        Text(failed ? MarkPreviewCopy.unavailable : MarkPreviewCopy.loading)
          .font(Typography.cardBody)
          .foregroundStyle(Tokens.ink3.color)
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(width: 340, height: 230, alignment: .topLeading)
    .background(Tokens.bg1.color)
    .syntheticFrame(pressed.mark.synthetic, cornerRadius: 0)
    .task { await load() }
  }

  private func load() async {
    guard let atlas = model.app.atlas else {
      failed = true
      return
    }
    do {
      passage = try await atlas.passage(pressed.mark.passage, PassageRequest(context: false, occ: pressed.mark.occ))
    } catch {
      failed = true
    }
  }

  /// The passage with its highlights (cyan underline on a 25% cyan ground, §4.8). Highlight offsets are UTF-16 offsets
  /// in the document (D4); the passage's own text starts at `start`.
  private func highlighted(_ p: PassageResponse) -> AttributedString {
    var s = AttributedString(p.text)
    s.foregroundColor = Tokens.ink.color
    let length = p.text.utf16.count
    for h in p.highlights {
      let lo = max(0, h.start - p.start), hi = min(length, h.end - p.start)
      guard lo < hi, let range = Range(NSRange(location: lo, length: hi - lo), in: p.text), let ar = Range(range, in: s) else { continue }
      s[ar].backgroundColor = Tokens.cyan.opacity(Tokens.Alpha.matchHighlight)
      s[ar].underlineStyle = .single
    }
    return s
  }

  /// The menu of a pressed mark.
  static func menu(model: ScrollModel, pressed: PressedMark) -> UIMenu {
    let m = pressed.mark
    let selection = m.occ.map { ViewState.Selection(type: "occurrence", id: .number(Int($0.rawValue))) }
      ?? ViewState.Selection(type: "passage", id: .number(Int(m.passage.rawValue)))
    let open = UIAction(title: MarkPreviewCopy.open, image: UIImage(systemName: "text.book.closed")) { _ in
      model.app.experience.select(selection)
    }
    let annotate = UIAction(title: MarkPreviewCopy.annotate, image: UIImage(systemName: "square.and.pencil")) { _ in
      model.app.experience.annotate(AnnotationTarget(type: "passage", id: m.passage.rawValue))
    }
    let lineage = UIAction(title: MarkPreviewCopy.lineage, image: UIImage(systemName: "point.3.connected.trianglepath.dotted")) { _ in
      model.app.experience.openLineage(NodeRef(kind: "passage", id: m.passage.rawValue))
    }
    let compare = UIAction(title: MarkPreviewCopy.compare, image: UIImage(systemName: "square.split.2x1")) { _ in
      model.compareFromBin(day: m.loDay, tier: pressed.tier)
    }
    let copy = UIAction(title: MarkPreviewCopy.copyCitation, image: UIImage(systemName: "doc.on.doc")) { _ in
      Task { @MainActor in
        let title = try? await model.app.atlas?.document(m.doc).title
        UIPasteboard.general.string = MarkPreviewCopy.citation(title: title ?? nil, date: ScrollModelBuilder.markLabel(m),
                                                               passage: m.passage.rawValue, lane: pressed.laneLabel)
      }
    }
    return UIMenu(children: [open, annotate, lineage, compare, copy])
  }
}

extension ScrollModel {
  /// Compare from a bin: slice A is the bin's years, slice B the rest of the data up to the vantage (or the reference's
  /// default second slice when the bin is already the end).
  func compareFromBin(day: Int, tier: Tier) {
    let bin = tier.bin(ofDay: day)
    let aFrom = DayMath.ymdFromDay(tier.startDay(ofBin: bin)).y, aTo = DayMath.ymdFromDay(tier.endDay(ofBin: bin)).y
    let ext = extentDays()
    let endYear = DayMath.ymdFromDay(min(app.viewState.vantage.day, ext?.upperBound ?? DayMath.today())).y
    let startYear = ext.map { DayMath.ymdFromDay($0.lowerBound).y } ?? aFrom
    let b = aTo < endYear ? SliceSeed(fromYear: aTo + 1, toYear: endYear) : SliceSeed(fromYear: startYear, toYear: max(startYear, aFrom - 1))
    app.coordinator.push(.compare(CompareSeed(SliceSeed(fromYear: aFrom, toYear: aTo), b, viewHash: app.viewState.hash)))
  }
}
