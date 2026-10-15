// OWNER: N5
// The Lineage explorer, a pushed destination (IOS-SPEC §4.11, SPEC §2.C): x = the Scroll's linear time scale (or ordinal
// spacing, labelled as such), rows = hops from the root, never meaning; undated nodes in a left gutter; the root outlined
// cyan. Edges carry the evidence pattern of `EvidenceStyle` (solid documented, dashed computed, dotted proposed), the
// role hue backed by the type glyph, and review as an overlay word (✓ ✕ ⚖) that never changes the line. Filters:
// evidence statuses (the E cycle), relation types, show rejected. The graph scrolls sideways; "Show as list" is the
// table alternative (and VoiceOver's). Two picked nodes give the chain of custody. Every link opens its edge card.

import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

extension RootSlots {
  func lineage(_ seed: LineageSeed) -> some View {
    LineageView(root: "\(seed.root.kind):\(seed.root.id)", atlas: model.atlas, coordinator: model.coordinator)
  }
}

/// The colour of an `EvidenceStyle` hue name.
nonisolated enum LineageHue {
  static func color(_ hue: String) -> Color {
    switch hue {
    case "amber": Tokens.amber.color
    case "violet": Tokens.violet.color
    case "danger": Tokens.danger.color
    case "cyan": Tokens.cyan.color
    case "ivory", "ink": Tokens.ink.color
    default: Tokens.ink2.color
    }
  }

  /// The style of an edge (`edgeStyle`): pattern by evidence status, overlay by review, hue by family.
  static func style(_ e: LineageEdge) -> ArcStyle {
    EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: e.evidenceStatus, reviewStatus: e.reviewStatus, family: e.family,
                                         cue: false, isSynthetic: e.synthetic, dateConflict: e.dateConflict))
  }
}

struct LineageView: View {
  @State private var model: LineageModel
  let coordinator: PresentationCoordinator
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(root: String, atlas: (any AtlasService)?, coordinator: PresentationCoordinator) {
    _model = State(initialValue: LineageModel(root: root, atlas: atlas))
    self.coordinator = coordinator
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        header
        filters
        if model.chainMode { chainPanel }
        content
        Text(LineageCopy.caution).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, Tokens.Geometry.gutter)
      .padding(.bottom, 32)
    }
    .background(Tokens.bg0.color)
    .navigationTitle(LineageCopy.title)
    .navigationBarTitleDisplayMode(.inline)
    .task { if model.data == nil { await model.load() } }
    .accessibilityIdentifier("lineage.screen")
  }

  // MARK: header and filters

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(verbatim: "root: \(model.rootWords)").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        .accessibilityIdentifier("lineage.root")
      Text(LineageCopy.rowsNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      if let t = model.data?.truncated, t.nodes > 0 {
        Text(LineageCopy.truncation(shown: model.data?.nodes.count ?? 0, hidden: t.nodes, reason: t.reason))
          .font(Typography.meta).foregroundStyle(Tokens.amber.color)
          .accessibilityIdentifier("lineage.truncated")
      }
    }
  }

  private var filters: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Button {
          model.statusMode = model.statusMode.next
          Task { await model.load() }
        } label: {
          Label(model.statusMode.title, systemImage: "line.3.horizontal.decrease")
        }
        .buttonStyle(.bordered)
        .accessibilityHint("Cycles all evidence, documented and computed, documented only")
        .accessibilityIdentifier("lineage.status")
        Menu {
          ForEach(model.presentTypes, id: \.self) { code in
            Button {
              if model.types.contains(code) { model.types.remove(code) } else { model.types.insert(code) }
              Task { await model.load() }
            } label: {
              let t = Vocab.relTypeByCode[code]
              Label("\(t?.glyph ?? "") \(t?.label ?? code)", systemImage: model.types.contains(code) ? "checkmark" : "")
            }
          }
          if !model.types.isEmpty {
            Button("All types") {
              model.types = []
              Task { await model.load() }
            }
          }
        } label: {
          Label(model.types.isEmpty ? "All types" : "\(model.types.count) types", systemImage: "link")
        }
        .buttonStyle(.bordered)
      }
      HStack(spacing: 8) {
        Toggle(LineageCopy.showRejected, isOn: Binding(get: { model.showRejected }, set: { v in
          model.showRejected = v
          Task { await model.load() }
        }))
        .toggleStyle(.button)
        Toggle(model.ordinal ? LineageCopy.ordinalLabel : LineageCopy.linearLabel, isOn: $model.ordinal)
          .toggleStyle(.button)
      }
      .font(Typography.meta)
      HStack(spacing: 8) {
        Toggle(model.listMode ? LineageCopy.showAsGraph : LineageCopy.showAsList, isOn: $model.listMode).toggleStyle(.button)
          .accessibilityIdentifier("lineage.listToggle")
        Toggle(model.chainMode ? LineageCopy.chainStop : LineageCopy.chainStart, isOn: $model.chainMode).toggleStyle(.button)
          .accessibilityIdentifier("lineage.chainToggle")
      }
      .font(Typography.meta)
    }
    .controlSize(.small)
  }

  // MARK: content

  @ViewBuilder
  private var content: some View {
    if let error = model.error {
      ErrorCard(error) { Task { await model.load() } }
    } else if model.data == nil {
      HStack(spacing: 8) {
        ProgressView()
        Text("Loading the lineage of \(model.root.replacingOccurrences(of: ":", with: " "))…")
          .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    } else if let data = model.data {
      if model.visibleEdges.isEmpty && data.links?.arrayValue?.isEmpty != false {
        Text(LineageCopy.noLinks).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading).opaquePanel()
      }
      if model.listMode {
        LineageListView(data: data, edges: model.visibleEdges, openEdge: openEdge, selectNode: select)
      } else {
        graph(data)
      }
      if let id = model.selected, let node = data.nodes.first(where: { $0.id == id }) { nodeDetail(node) }
      if !data.groups.isEmpty { groupsPanel(data.groups) }
      legend
    }
  }

  private func openEdge(_ id: RelationshipID) { coordinator.show(.edge(id)) }

  private func select(_ id: String) {
    if model.chainMode {
      Task { await model.pick(id) }
    } else {
      model.selected = model.selected == id ? nil : id
    }
  }

  private func graph(_ data: LineageResponse) -> some View {
    GeometryReader { geo in
      let layout = LineageLayout(data, width: max(geo.size.width, 320), ordinal: model.ordinal)
      ScrollView(.horizontal, showsIndicators: true) {
        LineageGraphCanvas(layout: layout, edges: model.visibleEdges, root: data.root, selected: model.selected,
                           picks: model.picks, expanding: model.expanding,
                           selectNode: select, expand: { id in Task { await model.expand(id) } }, openEdge: openEdge)
          .frame(width: layout.width, height: layout.height + 28)
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Lineage graph: \(data.nodes.count) nodes, \(model.visibleEdges.count) links. \(LineageCopy.rowsNote).")
    }
    .frame(height: LineageLayout(data, width: 320, ordinal: model.ordinal).height + 40)
    .background(Tokens.bg1.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous))
  }

  // MARK: panels

  private func nodeDetail(_ n: LineageNode) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(n.title ?? n.label).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Spacer()
        if n.synthetic == true { EvidenceBadge("SYN") }
      }
      Text(verbatim: "\(n.id) · \(n.label)\(n.undated == true ? " · undated" : "") · \(LineageCopy.hopLabel(n.generation))")
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      if n.type == "commonplace" {
        Text(LineageCopy.commonplaceNote).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      HStack(spacing: 8) {
        if n.id != model.root && n.type != "commonplace" {
          Button(LineageCopy.lineageFromHere) { Task { await model.reroot(n.id) } }
        }
        if (n.expandable ?? 0) > 0 {
          Button("\(LineageCopy.expand) (+\(n.expandable ?? 0))") { Task { await model.expand(n.id) } }
            .disabled(model.expanding.contains(n.id))
        }
        if let doc = n.doc {
          Button(LineageCopy.genealogyFromHere) {
            coordinator.push(.genealogy(GenealogySeed(work: NodeRef(kind: "document", id: doc.rawValue))))
          }
        }
      }
      .buttonStyle(.bordered).controlSize(.small)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(n.synthetic == true)
    .accessibilityIdentifier("lineage.nodeDetail")
  }

  private func groupsPanel(_ groups: [LineageGroup]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(LineageCopy.competing).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      ForEach(groups, id: \.id) { g in
        Button {
          coordinator.show(.hypothesisGroup(g.id))
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(g.question).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).multilineTextAlignment(.leading)
            Text(LineageCopy.competingCount(g.edges.count)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
      }
      Text(LineageCopy.groupNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
    }
    .padding(12)
    .opaquePanel()
  }

  private var chainPanel: some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.picks.count < 2 {
        Text(LineageCopy.pickMore(2 - model.picks.count)).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      } else {
        Text(verbatim: "\(model.picks[0]) → \(model.picks[1])").font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      if model.findingPath {
        HStack { ProgressView(); Text(LineageCopy.chainFinding).font(Typography.meta) }
      } else if let e = model.pathError {
        ErrorCard(e)
      } else if let p = model.path {
        ChainOfCustodyView(path: p, openEdge: openEdge)
      }
    }
    .padding(12)
    .opaquePanel()
    .accessibilityIdentifier("lineage.chain")
  }

  private var legend: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(["documented", "computed", "proposed"], id: \.self) { s in
        HStack(spacing: 8) {
          let st = EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: s))
          Canvas { ctx, size in
            var p = Path()
            p.move(to: CGPoint(x: 0, y: size.height / 2))
            p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
            ctx.stroke(p, with: .color(Tokens.ink2.color), style: StrokeStyle(lineWidth: st.width, dash: st.dash.map { CGFloat($0) }))
          }
          .frame(width: 36, height: 8)
          .accessibilityHidden(true)
          EvidenceBadge(st.badge)
          Text(Copy.badges[st.badge]?.title ?? s).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// The graph: edges drawn in a Canvas with their evidence pattern; nodes, link glyphs and ＋ as buttons on top.
struct LineageGraphCanvas: View {
  let layout: LineageLayout
  let edges: [LineageEdge]
  let root: String
  let selected: String?
  let picks: [String]
  let expanding: Set<String>
  let selectNode: (String) -> Void
  let expand: (String) -> Void
  let openEdge: (RelationshipID) -> Void

  private var position: [String: CGPoint] {
    Dictionary(layout.nodes.map { ($0.id, CGPoint(x: $0.x, y: $0.y)) }, uniquingKeysWith: { a, _ in a })
  }

  var body: some View {
    let pos = position
    ZStack(alignment: .topLeading) {
      Canvas { ctx, size in
        // year ticks and hop rows
        for t in layout.ticks {
          var p = Path()
          p.move(to: CGPoint(x: t.x, y: 4))
          p.addLine(to: CGPoint(x: t.x, y: size.height - 18))
          ctx.stroke(p, with: .color(Tokens.rule.opacity(0.5)), lineWidth: 0.5)
          ctx.draw(Text(t.label).font(.caption2).foregroundStyle(Tokens.ink3.color), at: CGPoint(x: t.x, y: size.height - 8))
        }
        for r in layout.rows {
          ctx.draw(Text(r.label).font(.caption2).foregroundStyle(Tokens.ink3.color),
                   at: CGPoint(x: 4, y: r.y - 16), anchor: .leading)
        }
        for e in edges {
          guard let a = pos[e.src], let b = pos[e.dst] else { continue }
          let st = LineageHue.style(e)
          let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 18)
          var path = Path()
          path.move(to: a)
          path.addQuadCurve(to: b, control: mid)
          let colour = LineageHue.color(st.hue).opacity(st.opacity)
          ctx.stroke(path, with: .color(colour), style: StrokeStyle(lineWidth: st.width, lineCap: .round,
                                                                    dash: st.dash.map { CGFloat($0) }))
          if e.relType != "shared_wording" && (Vocab.relTypeByCode[e.relType]?.directed ?? 1) == 1 {
            // arrowhead at the source end (the earlier item): src → dst
            let angle = atan2(b.y - mid.y, b.x - mid.x)
            var head = Path()
            head.move(to: b)
            head.addLine(to: CGPoint(x: b.x - 9 * cos(angle - 0.4), y: b.y - 9 * sin(angle - 0.4)))
            head.move(to: b)
            head.addLine(to: CGPoint(x: b.x - 9 * cos(angle + 0.4), y: b.y - 9 * sin(angle + 0.4)))
            ctx.stroke(head, with: .color(colour), lineWidth: 1.2)
          }
        }
      }
      ForEach(edges, id: \.relId) { e in
        if let a = pos[e.src], let b = pos[e.dst] {
          let st = LineageHue.style(e)
          Button {
            openEdge(e.relId)
          } label: {
            Text(verbatim: (Vocab.relTypeByCode[e.relType]?.glyph ?? "·") + overlayWord(st))
              .font(.caption2.weight(.semibold))
              .strikethrough(st.strike)
              .foregroundStyle(LineageHue.color(st.hue))
              .padding(.horizontal, 4).padding(.vertical, 1)
              .background(Tokens.bg1.color.opacity(0.9), in: Capsule())
          }
          .buttonStyle(.plain)
          .frame(minWidth: 30, minHeight: 30)
          .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 9)
          .accessibilityLabel(linkWords(e))
        }
      }
      ForEach(layout.nodes) { n in
        nodeButton(n)
      }
    }
  }

  private func overlayWord(_ st: ArcStyle) -> String {
    switch st.overlay {
    case .check?: " ✓"
    case .cross?: " ✕"
    case .scales?: " ⚖"
    case nil: ""
    }
  }

  /// A link in words for VoiceOver: "quotes exactly · computed · unreviewed".
  private func linkWords(_ e: LineageEdge) -> String {
    let t = Vocab.relTypeByCode[e.relType]
    return "\(e.src) \(t?.label ?? e.relType) \(e.dst), \(e.evidenceStatus), \(e.reviewStatus)"
  }

  private func nodeButton(_ n: LineageLayout.Node) -> some View {
    let isRoot = n.id == root
    let picked = picks.contains(n.id)
    let title = n.node.title ?? n.node.label
    return VStack(spacing: 2) {
      ZStack {
        Circle().fill(n.node.type == "commonplace" ? Tokens.ink3.color : Tokens.ink2.color).frame(width: 10, height: 10)
        if isRoot { Circle().strokeBorder(Tokens.cyan.color, lineWidth: 2).frame(width: 18, height: 18) }
        if picked || selected == n.id { Circle().strokeBorder(Tokens.cyan.opacity(0.7), lineWidth: 1.5).frame(width: 24, height: 24) }
      }
      Text(title).font(.caption2).foregroundStyle(Tokens.ink.color).lineLimit(1).frame(maxWidth: 110)
      Text(n.node.label).font(.caption2).foregroundStyle(Tokens.ink3.color).lineLimit(1)
      if (n.node.expandable ?? 0) > 0 {
        Button {
          expand(n.id)
        } label: {
          Text(verbatim: expanding.contains(n.id) ? "…" : "＋\(n.node.expandable ?? 0)")
            .font(.caption2.weight(.bold)).foregroundStyle(Tokens.cyan.color)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(LineageCopy.expand): \(n.node.expandable ?? 0) more links")
      }
    }
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(Rectangle())
    .onTapGesture { selectNode(n.id) }
    .position(x: n.x, y: n.y + 18)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title), \(n.node.label), \(LineageCopy.hopLabel(n.node.generation))\(isRoot ? ", root" : "")")
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { selectNode(n.id) }
  }
}

/// "Show as list": every node by hop row, then every link in words, each opening its card.
struct LineageListView: View {
  let data: LineageResponse
  let edges: [LineageEdge]
  let openEdge: (RelationshipID) -> Void
  let selectNode: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Nodes").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      ForEach(data.nodes.sorted { ($0.generation ?? .max, $0.y ?? .max, $0.id) < ($1.generation ?? .max, $1.y ?? .max, $1.id) },
              id: \.id) { n in
        Button { selectNode(n.id) } label: {
          VStack(alignment: .leading, spacing: 1) {
            Text(n.title ?? n.label).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
            Text(verbatim: "\(LineageCopy.hopLabel(n.generation)) · \(n.label) · \(n.id)")
              .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
      }
      Text("Links").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).padding(.top, 6)
      ForEach(edges, id: \.relId) { e in
        let st = LineageHue.style(e)
        Button { openEdge(e.relId) } label: {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            EvidenceBadge(st.conflict ? String(st.badge.dropLast(2)) : st.badge)
            VStack(alignment: .leading, spacing: 1) {
              Text(verbatim: "\(e.src) \(Vocab.relTypeByCode[e.relType]?.glyph ?? "") \(Vocab.relTypeByCode[e.relType]?.label ?? e.relType) \(e.dst)")
                .font(Typography.cardBody).foregroundStyle(Tokens.ink.color).strikethrough(st.strike)
              Text(verbatim: "\(e.evidenceStatus) · review \(e.reviewStatus)\(e.method.map { " · \($0)" } ?? "")")
                .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(12)
    .opaquePanel()
    .accessibilityIdentifier("lineage.list")
  }
}
