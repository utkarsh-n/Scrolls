// OWNER: N4
// Compare, the pushed destination (IOS-SPEC §4.10): the range strip with A and B brackets on top, the multiplicity line
// pinned under the title, then coverage and composition first, frequency with its intervals, representative passages
// (seed printed, Reshuffle), neighbouring terms in tabs, context groups, estimated displacement, tone and stance, and
// "How coverage could affect this" last. A is always the earlier slice and sits over B (A | B in landscape). Every
// gated part is an opaque `GateCard` built from its gate alone, with [Apply] when the suggestion names wider slices.

import Charts
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

extension RootSlots {
  func compare(_ seed: CompareSeed) -> some View {
    let fixtures: Bool = if case .fixtures = model.engine.kind { true } else { false }
    return CompareView(seed: seed, atlas: model.atlas, fixtures: fixtures)
  }
}

struct CompareView: View {
  @State private var model: CompareModel
  @Environment(\.verticalSizeClass) private var verticalSize

  enum TermsTab: String, CaseIterable, Identifiable {
    case shared, onlyA, onlyB
    var id: String { rawValue }
    var title: String {
      switch self {
      case .shared: CompareCopy.tabShared
      case .onlyA: CompareCopy.tabOnlyA
      case .onlyB: CompareCopy.tabOnlyB
      }
    }
  }

  init(seed: CompareSeed, atlas: (any AtlasService)?, fixtures: Bool) {
    _model = State(initialValue: CompareModel(seed: seed, atlas: atlas, fixtures: fixtures))
  }

  /// Landscape lays A and B side by side.
  private var sideBySide: Bool { verticalSize == .compact }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 18, pinnedViews: [.sectionHeaders]) {
        Section {
          bodyContent
        } header: {
          header
        }
      }
      .padding(.horizontal, Tokens.Geometry.gutter)
      .padding(.bottom, 32)
    }
    .background(Tokens.bg0.color)
    .navigationTitle(CompareCopy.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 0) {
          Text(CompareCopy.title).font(.headline)
          Text(model.shown?.subtitle ?? "\(CompareContent.sliceName("a", [model.a.fromYear, model.a.toYear])) · \(CompareContent.sliceName("b", [model.b.fromYear, model.b.toYear]))")
            .font(Typography.meta).foregroundStyle(Tokens.ink3.color).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
      }
    }
    .task { await model.run() }
    .accessibilityIdentifier("compare.screen")
  }

  // MARK: header: strip + multiplicity (pinned)

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      CompareRangeStrip(a: model.a, b: model.b, extent: model.extent) { edit in
        Task { await model.apply(edit) }
      }
      .frame(height: 64)
      if let content = model.shown {
        Text(content.multiplicity)
          .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("compare.multiplicity")
        if let note = content.asSavedNote {
          Text(note).font(Typography.meta).foregroundStyle(Tokens.violet.color).fixedSize(horizontal: false, vertical: true)
        }
      }
      if model.fixtures {
        Text(CompareCopy.fixtures).font(Typography.meta).foregroundStyle(Tokens.amber.color)
      }
      if let r = model.running {
        CountingLabel(CompareCopy.running(r.stage, r.job), fraction: r.fraction)
      }
      if let end = model.runEnd {
        Text(end).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
    }
    .padding(.vertical, 8)
    .background(Tokens.bg0.color)
  }

  // MARK: body by phase

  @ViewBuilder
  private var bodyContent: some View {
    switch model.phase {
    case .needsExpression:
      emptyCard(CompareCopy.pinExpression)
    case .failed(let e):
      ErrorCard(e) { Task { await model.run(force: true) } }
    case .loading:
      CountingLabel(CompareCopy.comparing(CompareContent.sliceName("a", [model.a.fromYear, model.a.toYear]),
                                          CompareContent.sliceName("b", [model.b.fromYear, model.b.toYear])), fraction: nil)
      if let c = model.shown { panels(c).opacity(0.5).allowsHitTesting(false) }
    case .loaded(let c):
      panels(c)
    }
  }

  private func emptyCard(_ text: String) -> some View {
    Text(text).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
      .padding(14).frame(maxWidth: .infinity, alignment: .leading).opaquePanel()
  }

  private func panels(_ c: CompareContent) -> some View {
    ComparePanels(content: c, sideBySide: sideBySide, actions: CompareActions(
      apply: { edit in Task { await model.apply(edit) } },
      startRun: model.running == nil ? { s in Task { await model.startSuggestedRun(s) } } : nil,
      compareAnyway: { Task { await model.compareAnyway() } },
      reshuffle: { Task { await model.reshuffle() } }))
  }
}

/// What the panels can ask of the destination.
struct CompareActions {
  var apply: (SliceEdit) -> Void = { _ in }
  /// Starts the run a suggestion names (`{run: {stage, params}}`); nil while one is running.
  var startRun: ((JSONValue) -> Void)?
  var compareAnyway: () -> Void = {}
  var reshuffle: () -> Void = {}
}

/// The stacked panels of one comparison, drawn from its content alone (hosted by tests for the text scan).
struct ComparePanels: View {
  let content: CompareContent
  var sideBySide = false
  var actions = CompareActions()
  @State private var termsTab = CompareView.TermsTab.shared

  var body: some View { panels(content) }

  @ViewBuilder
  private func panels(_ c: CompareContent) -> some View {
    VStack(alignment: .leading, spacing: 22) {
      coverage(c)
      frequency(c)
      if let wc = c.withinCell { withinCell(wc, c) }
      if let b = c.baseline { baseline(b) }
      passages(c)
      terms(c.terms)
      groups(c.groups)
      measures(c.measures)
      tone(c)
      caveats(c)
    }
    .syntheticFrame(c.synthetic)
  }

  // MARK: sections

  private func section<Content: View>(_ title: String, id: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.title3.weight(.semibold)).foregroundStyle(Tokens.ink.color)
        .accessibilityAddTraits(.isHeader)
      content()
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("compare.section.\(id)")
  }

  private func gateCard(_ g: CompareGate) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      GateCard(g.gate, title: g.title, note: g.note) { suggestion in
        if let edit = SliceEdit(suggestion: suggestion) { actions.apply(edit) }
      }
      // a suggestion that names a run (token streams, …) can be started from here; Compare asks again when it ends
      if let stage = g.gate.suggestion["run"]?["stage"]?.stringValue, let start = actions.startRun {
        Button(CompareCopy.runLabel(stage)) { start(g.gate.suggestion) }
          .buttonStyle(.bordered).tint(Tokens.cyan.color).frame(minHeight: Tokens.Geometry.minHit)
          .accessibilityIdentifier("compare.run.\(stage)")
      }
    }
    .accessibilityIdentifier("compare.gate.\(g.id)")
  }

  private func emptyCard(_ text: String) -> some View {
    Text(text).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
      .padding(14).frame(maxWidth: .infinity, alignment: .leading).opaquePanel()
  }

  private func caveatBox(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(verbatim: "⚠").accessibilityHidden(true)
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
    .font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
    .background(Tokens.amber.opacity(Tokens.Alpha.amberTint), in: RoundedRectangle(cornerRadius: Tokens.Radius.card))
    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).stroke(Tokens.amber.color.opacity(0.6), lineWidth: 1))
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func pair<A: View, B: View>(@ViewBuilder _ a: () -> A, @ViewBuilder _ b: () -> B) -> some View {
    if sideBySide {
      HStack(alignment: .top, spacing: 16) { a().frame(maxWidth: .infinity, alignment: .topLeading); b().frame(maxWidth: .infinity, alignment: .topLeading) }
    } else {
      VStack(alignment: .leading, spacing: 12) { a(); b() }
    }
  }

  private func coverage(_ c: CompareContent) -> some View {
    section(CompareCopy.coverage, id: "coverage") {
      Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
        GridRow {
          Text(verbatim: "")
          Text(c.sliceA).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          Text(c.sliceB).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        }
        ForEach(c.coverage.facts) { f in
          GridRow {
            Text(f.label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            Text(f.a).font(Typography.tableNumber).foregroundStyle(Tokens.ink.color)
            Text(f.b).font(Typography.tableNumber).foregroundStyle(Tokens.ink.color)
          }
          .accessibilityElement(children: .combine)
        }
      }
      CompositionBar(name: c.sliceA, segments: c.coverage.stackA)
      CompositionBar(name: c.sliceB, segments: c.coverage.stackB)
      if let jsd = c.coverage.jsdLine { Text(jsd).font(Typography.count).foregroundStyle(Tokens.ink2.color) }
      if let cav = c.coverage.compositionCaveat { caveatBox(cav) }
      if let p = c.coverage.prominenceCaveat { caveatBox(p) }
      if let g = c.coverage.modalityGate {
        gateCard(g)
        Button(CompareCopy.compareAnyway) { actions.compareAnyway() }
          .buttonStyle(.bordered).tint(Tokens.amber.color).frame(minHeight: Tokens.Geometry.minHit)
          .accessibilityIdentifier("compare.anyway")
      }
    }
  }

  @ViewBuilder
  private func frequency(_ c: CompareContent) -> some View {
    section(CompareCopy.frequency, id: "freq") {
      switch c.frequency {
      case .gated(let g): gateCard(g)
      case .empty(let t): emptyCard(t)
      case .shown(let sides, let ratio, let standardized, let method, let unitLabel):
        let points = sides.compactMap { s -> CompareContent.RatePoint? in if case .rate(_, _, _, _, let p) = s { p } else { nil } }
        if !points.isEmpty { FrequencyChart(points: points, unitLabel: unitLabel ?? "").frame(height: 120) }
        ForEach(sides) { side in
          switch side {
          case .rate(let name, let line, let docs, let dp, _):
            VStack(alignment: .leading, spacing: 2) {
              Text(name).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
              Text(([line] + [docs, dp].compactMap { $0 }).joined(separator: " · ")).font(Typography.count).foregroundStyle(Tokens.ink2.color)
            }
            .accessibilityElement(children: .combine)
          case .gated(let name, let counts, let g):
            VStack(alignment: .leading, spacing: 6) {
              Text(name).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
              Text(counts).font(Typography.count).foregroundStyle(Tokens.ink2.color)
              gateCard(g)
            }
          case .missing(_, let line):
            Text(line).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          }
        }
        switch ratio {
        case .value(let t)?: Text(t).font(Typography.count).foregroundStyle(Tokens.ink.color)
        case .gated(let g)?: gateCard(g)
        case .differentUnits?: Text(CompareCopy.differentUnits).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        case nil: EmptyView()
        }
        ForEach(standardized, id: \.self) { Text($0).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
        Text(method).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    }
  }

  private func withinCell(_ wc: CompareContent.WithinCell, _ c: CompareContent) -> some View {
    section(CompareCopy.withinCell, id: "within_cell") {
      Text(wc.label).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      if let m = wc.method { Text(m).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
      pair({ cells(c.sliceA, wc.a) }, { cells(c.sliceB, wc.b) })
    }
  }

  private func cells(_ name: String, _ cells: [CompareContent.Cell]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(name).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      if cells.isEmpty { Text(CompareCopy.noCell).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
      ForEach(cells) { cell in
        VStack(alignment: .leading, spacing: 1) {
          Text(cell.label).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          Text(cell.text).font(Typography.count).foregroundStyle(cell.low ? Tokens.ink3.color : Tokens.ink.color)
        }
        .accessibilityElement(children: .combine)
      }
    }
  }

  @ViewBuilder
  private func baseline(_ b: CompareContent.Baseline) -> some View {
    section(CompareCopy.baseline, id: "baseline") {
      switch b {
      case .gated(let g):
        gateCard(g)
        Text(CompareCopy.baselineRhoLabel).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      case .text(let t, let label):
        Text(t).font(Typography.count).foregroundStyle(Tokens.ink.color)
        Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      case .empty(let t, let label):
        emptyCard(t)
        Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    }
  }

  private func passages(_ c: CompareContent) -> some View {
    section(CompareCopy.passages, id: "passages") {
      pair({ passageColumn(c.sliceA, c.passages.a) }, { passageColumn(c.sliceB, c.passages.b) })
      HStack {
        Text(c.passages.seedLine).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        Spacer()
        Button(CompareCopy.reshuffle) { actions.reshuffle() }
          .buttonStyle(.bordered).frame(minHeight: Tokens.Geometry.minHit)
          .accessibilityIdentifier("compare.reshuffle")
      }
    }
  }

  private func passageColumn(_ name: String, _ rows: [KwicRow]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(name).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      if rows.isEmpty { Text(CompareCopy.noPassagesInSlice).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
      ForEach(rows, id: \.passage) { row in
        KwicRowView(row: row) { _ in }
        Divider().overlay(Tokens.rule.color)
      }
    }
  }

  @ViewBuilder
  private func terms(_ t: CompareContent.Terms) -> some View {
    section(CompareCopy.terms, id: "collocates") {
      switch t {
      case .gated(let g): gateCard(g)
      case .empty(let s): emptyCard(s)
      case .notRequested(let label): Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      case .shown(let label, let shared, let onlyA, let onlyB, let keyness):
        Text(label).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        Picker(CompareCopy.terms, selection: $termsTab) {
          ForEach(CompareView.TermsTab.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        termList(termsTab == .shared ? shared : termsTab == .onlyA ? onlyA : onlyB)
        if !keyness.isEmpty {
          Text(CompareCopy.keynessTitle).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).padding(.top, 6)
          termList(keyness)
        }
      }
    }
  }

  private func termList(_ items: [CompareContent.Term]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if items.isEmpty { Text(CompareCopy.none).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
      ForEach(items) { item in
        HStack(alignment: .firstTextBaseline) {
          Text(item.term).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          Spacer(minLength: 8)
          Text(item.detail).font(Typography.count).foregroundStyle(Tokens.ink3.color)
        }
        .accessibilityElement(children: .combine)
      }
    }
  }

  @ViewBuilder
  private func groups(_ g: CompareContent.Groups) -> some View {
    section(CompareCopy.groups, id: "clusters") {
      switch g {
      case .gated(let gate): gateCard(gate)
      case .empty(let t): emptyCard(t)
      case .shown(let meta, let rows):
        Text(meta).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        ForEach(rows) { r in
          VStack(alignment: .leading, spacing: 2) {
            Text(r.humanLabel ?? r.label).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
            if r.humanLabel != nil { Text(r.label).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
            Text("\(r.a) · \(r.b)").font(Typography.count).foregroundStyle(Tokens.ink2.color)
            if let flag = r.flag { Text(flag).font(Typography.meta).foregroundStyle(Tokens.cyan.color) }
          }
          .padding(.vertical, 4)
          .accessibilityElement(children: .combine)
        }
      }
    }
  }

  private func measures(_ ms: [CompareContent.MeasureRow]) -> some View {
    section(CompareCopy.measures, id: "measures") {
      Text(CompareCopy.shiftLine).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      if ms.isEmpty { emptyCard(CompareCopy.noMeasures) }
      ForEach(ms) { m in
        switch m {
        case .value(let metric, let text):
          Text(text).font(Typography.count).foregroundStyle(Tokens.ink.color).accessibilityIdentifier("compare.measure.\(metric)")
        case .gated(let g): gateCard(g)
        }
      }
    }
  }

  @ViewBuilder
  private func tone(_ c: CompareContent) -> some View {
    section(CompareCopy.tone, id: "tone") {
      switch c.tone {
      case .gated(let g, let modelMissing):
        gateCard(g)
        if modelMissing {
          Text(CompareCopy.toneModelMissing).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          Text(CompareCopy.toneDownload).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      case .shown(let label, let lines):
        Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        ForEach(lines, id: \.self) { Text($0).font(Typography.count).foregroundStyle(Tokens.ink.color) }
      case .notRequested:
        EmptyView()
      }
      Text(CompareCopy.humanPragmatic).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).padding(.top, 4)
      Text(c.human).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
      if let n = c.humanNote { Text(n).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
    }
  }

  private func caveats(_ c: CompareContent) -> some View {
    section(CompareCopy.caveats, id: "caveats") {
      if let note = c.coverageNote { Text(note).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).fixedSize(horizontal: false, vertical: true) }
      if c.caveats.isEmpty { Text(CompareCopy.noCaveat).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
      ForEach(c.caveats, id: \.self) { line in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(verbatim: "•").accessibilityHidden(true)
          Text(line).fixedSize(horizontal: false, vertical: true)
        }
        .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
    }
  }
}

/// The stacked kind × language × collection bar of one slice.
struct CompositionBar: View {
  let name: String
  let segments: [CompareContent.Segment]
  private static let inks: [TokenColor] = [Tokens.cyan, Tokens.violet, Tokens.amber, Tokens.ok, Tokens.ink2]

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      GeometryReader { geo in
        HStack(spacing: 1) {
          ForEach(Array(segments.enumerated()), id: \.element.id) { i, s in
            Rectangle().fill(Self.inks[i % Self.inks.count].color.opacity(0.75))
              .frame(width: max(1, geo.size.width * s.share))
          }
        }
      }
      .frame(height: 10)
      .clipShape(RoundedRectangle(cornerRadius: 3))
      Text("\(name): \(segments.prefix(4).map { "\($0.label) \(Format.share($0.share))" }.joined(separator: ", "))")
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color).lineLimit(2)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(name) mix: \(segments.map { "\($0.label) \(Format.share($0.share))" }.joined(separator: ", "))")
  }
}

/// The frequency of each passing slice: a dot at its rate and a rule over its 95% interval; linear axis only.
struct FrequencyChart: View {
  let points: [CompareContent.RatePoint]
  let unitLabel: String

  var body: some View {
    Chart(points, id: \.slice) { p in
      if let lo = p.lo, let hi = p.hi {
        RuleMark(xStart: .value("low", lo), xEnd: .value("high", hi), y: .value("slice", p.slice))
          .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
          .foregroundStyle(Tokens.cyan.color.opacity(0.6))
      }
      PointMark(x: .value("rate", p.rate), y: .value("slice", p.slice))
        .foregroundStyle(Tokens.cyan.color)
        .symbolSize(60)
    }
    .chartXScale(type: .linear)
    .chartXAxisLabel(unitLabel)
    .chartYScale(domain: points.map(\.slice))
    .accessibilityLabel(CompareCopy.frequency)
  }
}
