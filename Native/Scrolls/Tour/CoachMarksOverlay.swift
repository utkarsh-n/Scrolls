// OWNER: N8
// The coach marks ①②③ and the full tour card (IOS-SPEC §4.17; `tour/coachmarks.mjs`, `tour/tour.mjs`). Glass callouts
// over the Scroll that never block: only the card takes touches, everything around it passes through to the Scroll and
// the inspector. A card points at what the Scroll reports through the bridge (the first bar, the arcs, the Play
// button); without a reported anchor it sits at a fixed place and draws no leader, so it never points at nothing. A
// card never covers the inspector: it is placed above the sheet, and waits while a pushed screen or a sheet is up.
// No pulse, no idle motion (§4.1 rule 4).

import ScrollsContracts
import ScrollsCore
import SwiftUI

struct CoachMarksOverlay: View {
  let model: AppModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let experience = model.experience
    let tour = experience.tour
    let coordinator = model.coordinator
    let covered = !coordinator.path.isEmpty || coordinator.isPresenting
    GeometryReader { proxy in
      ZStack(alignment: .topLeading) {
        if !covered, let stage = tour.stage, stage < .yourTurn {
          coach(stage, experience: experience, in: proxy)
            .transition(.opacity)
        }
        if !covered, tour.fullTourStep != nil {
          FullTourCard(model: model)
            .padding(.top, proxy.safeAreaInsets.top + Tokens.Geometry.topBar + Tokens.Geometry.ribbon + 8)
            .padding(.horizontal, Tokens.Geometry.gutter)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity, alignment: .center)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
    }
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: tour.stage)
  }

  @ViewBuilder
  private func coach(_ stage: CoachStage, experience: ExperienceModel, in proxy: GeometryProxy) -> some View {
    let frame = proxy.frame(in: .global)
    let width = min(340, proxy.size.width - 2 * Tokens.Geometry.gutter)
    let anchor = anchorRect(stage, experience: experience).map { $0.offsetBy(dx: -frame.minX, dy: -frame.minY) }
    let sheetTop = proxy.size.height + proxy.safeAreaInsets.bottom - model.coordinator.inspectorHeight
    let top = placement(stage, anchor: anchor, sheetTop: sheetTop, safeTop: proxy.safeAreaInsets.top)
    let leftX = min(max(Tokens.Geometry.gutter, (anchor?.minX ?? Tokens.Geometry.gutter) - 12), proxy.size.width - width - Tokens.Geometry.gutter)
    ZStack(alignment: .topLeading) {
      if let anchor {
        CoachLeader(from: CGPoint(x: leftX + 24, y: top < anchor.minY ? top + 60 : top), to: CGPoint(x: anchor.midX, y: anchor.midY))
          .allowsHitTesting(false)
        Circle()
          .stroke(Tokens.cyan.color, lineWidth: 1)
          .frame(width: max(18, anchor.height + 8), height: max(18, anchor.height + 8))
          .position(x: anchor.midX, y: anchor.midY)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
      CoachCard(model: model, stage: stage)
        .frame(width: width)
        .offset(x: leftX, y: top)
    }
  }

  /// Where a card points (global coordinates): the Scroll's anchors, or the Play button for ③.
  private func anchorRect(_ stage: CoachStage, experience: ExperienceModel) -> CGRect? {
    switch stage {
    case .first: experience.bridge.anchors[.firstBar]
    case .second: experience.bridge.anchors[.focusMark] ?? experience.bridge.anchors[.documentedArc]
    case .third: experience.bridge.anchors[.playButton]
    case .yourTurn: nil
    }
  }

  /// The card's top: beside its anchor when there is one, otherwise a fixed place over the lanes; always above the sheet.
  private func placement(_ stage: CoachStage, anchor: CGRect?, sheetTop: CGFloat, safeTop: CGFloat) -> CGFloat {
    let lanesTop = safeTop + Tokens.Geometry.topBar + Tokens.Geometry.ribbon + Tokens.Geometry.minimap + Tokens.Geometry.ruler
      + Tokens.Geometry.coverage + 12
    let cardHeight: CGFloat = stage == .second ? 190 : 130
    var y: CGFloat
    switch stage {
    case .third:
      y = (anchor?.minY ?? sheetTop) - cardHeight - 16
    default:
      if let anchor { y = anchor.maxY + 14 } else { y = stage == .first ? lanesTop : lanesTop + 120 }
    }
    return max(lanesTop - 8, min(y, sheetTop - cardHeight - 8))
  }
}

/// A thin cyan line from a card to its anchor (static: no pulse).
nonisolated private struct CoachLeader: Shape {
  var from: CGPoint
  var to: CGPoint

  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: from)
    p.addLine(to: to)
    return p.strokedPath(StrokeStyle(lineWidth: 1))
  }
}

/// One coach card: "1 of 3" and ×, the words, then Next.
struct CoachCard: View {
  let model: AppModel
  let stage: CoachStage

  var body: some View {
    let tour = model.experience.tour
    let text = CoachWords.text(stage, label: tour.strandLabel, doc: tour.documentedArc, calc: tour.computedArc, cipher: model.jobs.health?.cipher)
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(TourCopy.stepLabel(stage.rawValue)).font(Typography.meta.weight(.semibold)).foregroundStyle(Tokens.cyan.color)
        Spacer()
        Button {
          tour.dismiss()
          AccessibilityNotification.Announcement(TourCopy.dismissed).post()
        } label: {
          Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(Tokens.ink2.color)
        }
        .frame(minWidth: Tokens.Geometry.minHit, minHeight: 32)
        .contentShape(Rectangle())
        .accessibilityLabel(TourCopy.dismiss)
        .accessibilityIdentifier("coachDismiss")
      }
      ForEach(Array(text.lines.enumerated()), id: \.offset) { i, line in
        lineView(line, first: i == 0)
      }
      HStack {
        Spacer()
        Button(TourCopy.next) { tour.go(stage.next) }
          .font(Typography.chrome)
          .foregroundStyle(Tokens.cyan.color)
          .frame(minWidth: Tokens.Geometry.minHit, minHeight: 36)
          .accessibilityIdentifier("coachNext")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .chromeGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .chromeTypeCap()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("coach.\(stage.rawValue)")
    .onAppear {
      AccessibilityNotification.Announcement(text.lines.joined(separator: " ")).post()
    }
  }

  /// Coach ①'s word "observed" is bold (the reference's strong).
  private func lineView(_ line: String, first: Bool) -> some View {
    var a = AttributedString(line)
    if stage == .first, first, let r = a.range(of: TourCopy.observed) { a[r].inlinePresentationIntent = .stronglyEmphasized }
    return Text(a)
      .font(Typography.cardBody)
      .foregroundStyle(Tokens.ink.color)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// The guided tour card (10 steps, non-modal): Do / You see / It shows, Back · Show me · Next, and ×.
struct FullTourCard: View {
  let model: AppModel

  var body: some View {
    let tour = model.experience.tour
    VStack(alignment: .leading, spacing: 8) {
      if let step = tour.currentStep, let i = tour.fullTourStep {
        HStack(spacing: 8) {
          Text(TourCopy.tourTitle(min(i, tour.steps.count), tour.steps.count)).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          if step.synthetic { EvidenceBadge("SYN") }
          Spacer()
          closeButton(tour)
        }
        para(TourCopy.doLabel, TourCopy.phoneAction(step.n, step.action))
        para(TourCopy.seeLabel, step.see)
        para(TourCopy.learnLabel, step.learn)
        HStack {
          Button(TourCopy.back) { tour.stepFullTour(-1) }.disabled(i <= 1)
          Spacer()
          Button(TourCopy.showMe) { tour.showMe() }.buttonStyle(.borderedProminent).tint(Tokens.cyan.color)
            .foregroundStyle(Tokens.bg0.color)
            .accessibilityIdentifier("tourShowMe")
          Spacer()
          Button(TourCopy.next) { tour.stepFullTour(1) }.disabled(i >= tour.steps.count)
        }
        .font(Typography.chrome)
        .frame(minHeight: Tokens.Geometry.minHit)
        Text(TourCopy.tourTime(tour.minutes ?? 4)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      } else {
        HStack {
          CountingLabel(TourCopy.loadingTour, fraction: nil)
          Spacer()
          closeButton(tour)
        }
      }
    }
    .padding(14)
    .chromeGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .syntheticFrame(tour.currentStep?.synthetic ?? false, cornerRadius: 18)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("fullTourCard")
  }

  private func closeButton(_ tour: TourModel) -> some View {
    Button {
      tour.closeFullTour()
    } label: {
      Image(systemName: "xmark").foregroundStyle(Tokens.ink2.color)
    }
    .frame(minWidth: Tokens.Geometry.minHit, minHeight: Tokens.Geometry.minHit)
    .accessibilityLabel(TourCopy.closeTour)
  }

  private func para(_ label: String, _ text: String) -> some View {
    Text("\(Text(label).fontWeight(.semibold))\(text)")
      .font(Typography.cardBody)
      .foregroundStyle(Tokens.ink.color)
      .fixedSize(horizontal: false, vertical: true)
  }
}
