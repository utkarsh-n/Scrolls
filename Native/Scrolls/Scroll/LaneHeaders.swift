// OWNER: N7
// The lane headers (IOS-SPEC §4.3, §4.4, SPEC §1.3–§1.4; port of the lanes column of lanes-menu.mjs). Each lane has an
// 18 pt header strip on top (reserved: chips never sit over bars) with a sticky glass label chip that stays put while
// time pans — "English · text · 12.4M tok · 1823–1928": the unit and the coverage always show, long labels truncate in
// the middle, warnings append ("⚠ 34% undated"), cluster lanes add "machine label (editable)" — and the shelf chips at
// the trailing edge (ShelfChips.swift). A tap opens the full header with its selection and prominence notes. Lane order
// is a sorting choice, never a scale of meaning: the full header says so. In landscape the 120 pt rail holds the full
// header in two lines. The "+n more lanes" row expands in place from 5 to 10 lanes, then opens the Lanes sheet.

import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum LaneHeaderCopy {
  static let synthetic = "SYN"
  static let orderNote = Copy.laneOrderNote
  static let details = "Lane details"
  static let close = "Close"
  static let coverageOnly = "coverage only: pin a strand to count occurrences"

  /// The compact chip: "Classroom · text · 14k tok · 1906–1960".
  static func chip(_ lane: LaneModel) -> String {
    var parts = [lane.label, lane.modality]
    if let amount = lane.laneCoverage?[lane.coverageUnit == "works" ? "works" : "tokens"]?.numberValue {
      parts.append("\(Format.tokens(amount)) \(lane.coverageUnit == "works" ? "works" : "tok")")
    }
    if let s = lane.laneCoverage?["span"]?.arrayValue, s.count == 2, let a = s[0].numberValue, let b = s[1].numberValue {
      parts.append("\(JSNumber.format(a))–\(JSNumber.format(b))")
    } else if let span = lane.span {
      parts.append(span.label)
    }
    return parts.joined(separator: " · ")
  }

  /// "⚠ 34% undated" when ≥ 20% of the lane's matches are undated.
  static func warning(_ lane: LaneModel) -> String? {
    lane.undatedShare >= ScrollWords.undatedWarn ? "⚠ \(Format.share(lane.undatedShare)) undated" : nil
  }
}

/// The header strips of every lane over the canvas (portrait), positioned with the lane scroll.
struct LaneHeaders: View {
  let model: ScrollModel
  @State private var open: String?

  var body: some View {
    if let build = model.build, !model.landscape {
      let top = model.stripHeight, bottom = Double(model.canvasSize.height) - model.occludedBottom
      ZStack(alignment: .topLeading) {
        ForEach(build.model.lanes, id: \.key) { lane in
          if let box = build.layout.lane(lane.key) {
            let y = top + box.y - model.scrollY
            if y + box.header > top - 0.5, y < bottom {
              header(lane, facet: model.app.viewState.lanes.facet)
                .frame(width: model.timelineWidth, height: box.header, alignment: .leading)
                .offset(y: y)
            }
          }
        }
      }
      .frame(width: model.timelineWidth, height: Double(model.canvasSize.height), alignment: .topLeading)
      .mask(alignment: .topLeading) {
        Rectangle().frame(width: model.timelineWidth, height: max(0, bottom - top)).offset(y: top)
      }
      .popover(item: Binding(get: { open.map { LaneKeyBox(key: $0) } }, set: { open = $0?.key })) { box in
        if let lane = build.model.lanes.first(where: { $0.key == box.key }) {
          LaneDetails(lane: lane, facet: model.app.viewState.lanes.facet, query: model.query)
            .presentationCompactAdaptation(.popover)
        }
      }
    }
  }

  private func header(_ lane: LaneModel, facet: String) -> some View {
    HStack(spacing: 4) {
      Button {
        open = lane.key
      } label: {
        HStack(spacing: 4) {
          Text(LaneHeaderCopy.chip(lane))
            .lineLimit(1)
            .truncationMode(.middle)
          if let w = LaneHeaderCopy.warning(lane) {
            Text(w).foregroundStyle(Tokens.danger.color).lineLimit(1).layoutPriority(1)
          }
          if facet == "cluster" {
            Text(lane.machineLabel == nil ? "machine label (editable)" : "machine label").foregroundStyle(Tokens.ink3.color).lineLimit(1)
          }
          if lane.synthetic {
            Text(LaneHeaderCopy.synthetic).font(.system(size: 8, weight: .bold)).foregroundStyle(Tokens.syn.color)
          }
        }
        .font(.system(size: 10.5, weight: .medium))
        .foregroundStyle(Tokens.ink.color)
        .padding(.horizontal, 7)
        .frame(height: 16)
        .chromeGlass(in: Capsule(), interactive: true)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .frame(maxWidth: model.timelineWidth - 110, alignment: .leading)
      .accessibilityLabel(LaneHeaderCopy.chip(lane) + (LaneHeaderCopy.warning(lane).map { ", \($0)" } ?? "") + (lane.synthetic ? ", synthetic" : ""))
      .accessibilityHint(LaneHeaderCopy.details)
      Spacer(minLength: 4)
      ShelfChips(model: model, lane: lane)
    }
    .padding(.horizontal, 6)
    .chromeTypeCap()
  }
}

/// A lane key as an `Identifiable` popover item.
private struct LaneKeyBox: Identifiable {
  var key: String
  var id: String { key }
}

/// The full header of a lane: unit and coverage, the notes, the order note.
struct LaneDetails: View {
  let lane: LaneModel
  let facet: String
  let query: TimelineQueryResponse?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(lane.label).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        if lane.synthetic { EvidenceBadge("SYN") }
      }
      Text(ScrollWords.laneSubtitle(lane)).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
        .fixedSize(horizontal: false, vertical: true)
      Text(Format.unitLabel(lane.unit)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      ForEach(Array(ScrollWords.laneNotes(lane, facet: facet).enumerated()), id: \.offset) { _, n in
        Text(n.text).font(Typography.meta).foregroundStyle(n.kind == "warn" ? Tokens.danger.color : Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let w = query?.lanes.first(where: { $0.key == lane.key })?.undatedWarning {
        Text(w).font(Typography.meta).foregroundStyle(Tokens.danger.color).fixedSize(horizontal: false, vertical: true)
      }
      if lane.coverageOnly {
        Text(LaneHeaderCopy.coverageOnly).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
      Divider().overlay(Tokens.rule.color)
      Text(LaneHeaderCopy.orderNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .frame(width: 320, alignment: .leading)
    .background(Tokens.bg1.color)
    .syntheticFrame(lane.synthetic, cornerRadius: 0)
  }
}

/// The landscape lane rail (§4.4): the full header in two lines beside each lane, aligned with it.
struct LaneRail: View {
  let model: ScrollModel

  var body: some View {
    GeometryReader { _ in
      if let build = model.build {
        let top = model.stripHeight
        ZStack(alignment: .topLeading) {
          ForEach(build.model.lanes, id: \.key) { lane in
            if let box = build.layout.lane(lane.key) {
              VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 3) {
                  Text(lane.label).font(.system(size: 11, weight: .semibold)).foregroundStyle(Tokens.ink.color).lineLimit(1)
                  if lane.synthetic { Text("SYN").font(.system(size: 7.5, weight: .bold)).foregroundStyle(Tokens.syn.color) }
                }
                Text(ScrollWords.laneSubtitle(lane)).font(.system(size: 9.5)).foregroundStyle(Tokens.ink3.color).lineLimit(2)
                if let w = LaneHeaderCopy.warning(lane) { Text(w).font(.system(size: 9.5)).foregroundStyle(Tokens.danger.color).lineLimit(1) }
                ShelfChips(model: model, lane: lane)
              }
              .padding(.horizontal, 6)
              .frame(width: Tokens.Geometry.landscapeLaneRail, height: max(18, box.h), alignment: .topLeading)
              .background(box.index % 2 == 1 ? Tokens.bg1.color : Tokens.bg0.color)
              .offset(y: top + box.y - model.scrollY)
              .accessibilityElement(children: .combine)
            }
          }
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .clipped()
      }
    }
    .background(Tokens.bg0.color)
    .overlay(alignment: .trailing) { Rectangle().fill(Tokens.rule.color).frame(width: 1) }
  }
}

/// "+n more lanes": expands in place up to 10 lanes, then opens the Lanes sheet.
struct MoreLanesRow: View {
  let model: ScrollModel

  var body: some View {
    if let build = model.build, let more = build.layout.more, build.model.hiddenLanes > 0 {
      let y = model.stripHeight + more.y - model.scrollY
      if y < Double(model.canvasSize.height) - model.occludedBottom, y > model.stripHeight - more.h {
        Button {
          if model.expandedLanes || build.model.lanes.count >= Tokens.Geometry.maxLanes {
            model.app.coordinator.present(.lanes)
          } else {
            model.expandedLanes = true
            model.invalidateData("lanes")
          }
        } label: {
          Text(model.expandedLanes ? "\(ScrollCopy.moreLanes(build.model.hiddenLanes)) · \(ScrollCopy.lanesSheet)"
               : ScrollCopy.moreLanes(build.model.hiddenLanes))
            .font(Typography.chrome)
            .foregroundStyle(Tokens.ink2.color)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .chromeGlass(in: Capsule(), interactive: true)
        }
        .buttonStyle(.plain)
        .frame(minHeight: Tokens.Geometry.minHit)
        .position(x: 90, y: y + more.h / 2)
        .chromeTypeCap()
        .accessibilityIdentifier("moreLanes")
      }
    }
  }
}
