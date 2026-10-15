// OWNER: N5
// Genealogy, the sampling family tree (IOS-SPEC §4.11, SPEC §2.C2; port of src/ui/panels/genealogy.mjs): one row per
// work, grouped by generation from the seed (gen 0 = seed; +1 = works that sample, cover, interpolate, remix or version
// it; −1 = what it sampled), sorted by date inside a generation. x = the Scroll's linear time scale: each work is a
// diamond at its date, with an elbow connector from its parent's row. A density strip counts works per decade per
// generation. Defaults: documented only, depth ≤ 3 each way, ≤ 150 rows, paged with the engine's cursor. The honesty
// note is always printed: absence of a link is not evidence of no sampling. Relation-endpoint works say that they never
// enter title rates.

import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

extension RootSlots {
  func genealogy(_ seed: GenealogySeed) -> some View {
    GenealogyView(work: "\(seed.work.kind):\(seed.work.id)", atlas: model.atlas, coordinator: model.coordinator)
  }
}

@MainActor @Observable
final class GenealogyModel {
  let work: String
  let atlas: (any AtlasService)?
  private(set) var data: GenealogyResponse?
  private(set) var error: ErrorCardModel?
  private(set) var loadingMore = false
  var dir = "both"
  var documentedOnly = true

  init(work: String, atlas: (any AtlasService)?) {
    self.work = work
    self.atlas = atlas
  }

  func request(cursor: String? = nil) -> GenealogyRequest {
    GenealogyRequest(work: work, dir: dir, status: documentedOnly ? nil : "documented,proposed,computed", cursor: cursor)
  }

  func load() async {
    guard let atlas else { return }
    error = nil
    do {
      data = try await atlas.genealogy(request())
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.genealogyFailed)
    }
  }

  /// The next page (the engine's cursor), merged generation by generation.
  func more() async {
    guard let atlas, let base = data, let cursor = base.truncated["cursor"]?.stringValue else { return }
    loadingMore = true
    defer { loadingMore = false }
    do {
      let next = try await atlas.genealogy(request(cursor: cursor))
      var merged = base
      for g in next.generations {
        if let i = merged.generations.firstIndex(where: { $0.gen == g.gen }) {
          merged.generations[i].rows += g.rows
          merged.generations[i].returned += g.returned
        } else {
          merged.generations.append(g)
        }
      }
      merged.truncated = next.truncated
      data = merged
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.genealogyFailed)
    }
  }
}

/// The genealogy's time axis (pure): every row's year on one linear scale, so diamonds line up across rows.
nonisolated struct GenealogyLayout: Sendable, Equatable {
  var lo: Int
  var hi: Int

  /// The year a row's date label ends with (works are dated to a year or finer; undated → nil).
  static func year(_ date: JSONValue) -> Int? {
    guard let label = date["label"]?.stringValue else { return nil }
    let digits = label.split(whereSeparator: { !$0.isNumber && $0 != "-" }).compactMap { Int($0) }.filter { abs($0) < 10_000 }
    return digits.last
  }

  init(_ data: GenealogyResponse) {
    var years = data.seed.year.map { [$0] } ?? []
    for g in data.generations { for r in g.rows { if let y = Self.year(r.date) { years.append(y) } } }
    lo = years.min() ?? 1900
    hi = max(years.max() ?? 2000, lo + 1)
  }

  /// The position of a year in [0, 1] (linear time).
  func fraction(_ year: Int) -> CGFloat { CGFloat(year - lo) / CGFloat(hi - lo) }
}

struct GenealogyView: View {
  @State private var model: GenealogyModel
  let coordinator: PresentationCoordinator

  init(work: String, atlas: (any AtlasService)?, coordinator: PresentationCoordinator) {
    _model = State(initialValue: GenealogyModel(work: work, atlas: atlas))
    self.coordinator = coordinator
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        controls
        if let e = model.error {
          ErrorCard(e) { Task { await model.load() } }
        } else if let d = model.data {
          seedHeader(d)
          let axis = GenealogyLayout(d)
          Text(verbatim: "x: \(axis.lo)–\(axis.hi), linear time").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          ForEach(d.generations.sorted { $0.gen < $1.gen }, id: \.gen) { g in generation(g, axis) }
          if let hidden = d.truncated["rows"]?.safeInteger, hidden > 0 {
            Button(model.loadingMore ? "Loading…" : "\(LineageCopy.moreRows(hidden)) — \(LineageCopy.more)") {
              Task { await model.more() }
            }
            .buttonStyle(.bordered).disabled(model.loadingMore)
            .accessibilityIdentifier("genealogy.more")
          }
          Text(d.note).font(Typography.meta).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("genealogy.note")
        } else {
          HStack { ProgressView(); Text("Loading the genealogy…").font(Typography.meta) }
        }
      }
      .padding(.horizontal, Tokens.Geometry.gutter)
      .padding(.bottom, 32)
    }
    .background(Tokens.bg0.color)
    .navigationTitle(LineageCopy.genealogyTitle)
    .navigationBarTitleDisplayMode(.inline)
    .task { if model.data == nil { await model.load() } }
    .accessibilityIdentifier("genealogy.screen")
  }

  private var controls: some View {
    HStack(spacing: 8) {
      Picker("Direction", selection: Binding(get: { model.dir }, set: { v in
        model.dir = v
        Task { await model.load() }
      })) {
        Text("both").tag("both")
        Text("later (+)").tag("forward")
        Text("earlier (−)").tag("back")
      }
      .pickerStyle(.segmented)
      Toggle(LineageCopy.documentedOnly, isOn: Binding(get: { model.documentedOnly }, set: { v in
        model.documentedOnly = v
        Task { await model.load() }
      }))
      .toggleStyle(.button).font(Typography.meta)
    }
    .controlSize(.small)
  }

  private func seedHeader(_ d: GenealogyResponse) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(d.seed.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        if d.synthetic == true { EvidenceBadge("SYN") }
      }
      Text(verbatim: "\(d.seed.maker ?? "maker not recorded")\(d.seed.year.map { " · \($0)" } ?? "") · gen 0 (seed)")
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      let totals = d.generations.sorted { $0.gen < $1.gen }.map { "\($0.gen > 0 ? "+" : "")\($0.gen): \($0.total)" }
      if !totals.isEmpty {
        Text(verbatim: "works per generation — \(totals.joined(separator: " · "))").font(Typography.meta)
          .foregroundStyle(Tokens.ink2.color)
          .accessibilityIdentifier("genealogy.totals")
      }
    }
  }

  private func generation(_ g: GenealogyGeneration, _ axis: GenealogyLayout) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(verbatim: "\(g.gen > 0 ? "+" : "")\(g.gen) · \(g.total) work\(g.total == 1 ? "" : "s")\(g.returned < g.total ? " (showing \(g.returned))" : "")")
          .font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Spacer()
      }
      densityStrip(g.byDecade)
      ForEach(g.rows, id: \.doc) { r in workRow(r, axis) }
    }
    .padding(12)
    .opaquePanel()
  }

  /// Works per decade in this generation.
  private func densityStrip(_ byDecade: [String: Int]) -> some View {
    let decades = byDecade.keys.compactMap(Int.init).sorted()
    let peak = max(1, byDecade.values.max() ?? 1)
    return HStack(alignment: .bottom, spacing: 2) {
      ForEach(decades, id: \.self) { d in
        let n = byDecade[String(d)] ?? 0
        VStack(spacing: 1) {
          Rectangle().fill(Tokens.amber.opacity(0.7)).frame(width: 14, height: max(2, 22 * CGFloat(n) / CGFloat(peak)))
          Text(verbatim: "’\(String(format: "%02d", ((d % 100) + 100) % 100))").font(.system(size: 8)).foregroundStyle(Tokens.ink3.color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(d)s: \(n) work\(n == 1 ? "" : "s")")
      }
    }
    .frame(height: 34, alignment: .bottom)
  }

  private func workRow(_ r: GenealogyRow, _ axis: GenealogyLayout) -> some View {
    let year = GenealogyLayout.year(r.date)
    return Button {
      coordinator.push(.lineage(LineageSeed(root: NodeRef(kind: "document", id: r.doc.rawValue))))
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(verbatim: "◆").font(.caption).foregroundStyle(Tokens.amber.color)
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: "\(r.title) — \(r.maker ?? "maker not recorded") (\(r.date["label"]?.stringValue ?? "undated")\(r.date["precision"]?.stringValue.map { " · \($0)" } ?? ""))")
            .font(Typography.cardBody).foregroundStyle(Tokens.ink.color).multilineTextAlignment(.leading)
          Text(verbatim: r.edges.map { e in
            "\(Vocab.relTypeByCode[e.relType]?.glyph ?? "") \(e.relType.replacingOccurrences(of: "_", with: " ")) · \(e.evidenceStatus)\(e.sourceDataset.map { " · \($0)" } ?? "")"
          }.joined(separator: "; "))
          .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          if r.rateEligible == false {
            Text(LineageCopy.relationEndpoint).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          }
        }
        Spacer(minLength: 0)
        if r.synthetic == true { EvidenceBadge("SYN") }
        // the work's date on the genealogy's linear time axis (an open track when undated)
        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Rectangle().fill(Tokens.rule.opacity(0.6)).frame(height: 1)
            if let year {
              Text(verbatim: "◆").font(.system(size: 9)).foregroundStyle(Tokens.amber.color)
                .offset(x: axis.fraction(year) * (geo.size.width - 8))
            }
          }
          .frame(maxHeight: .infinity)
        }
        .frame(width: 72, height: 16)
        .accessibilityHidden(true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain)
    .accessibilityHint(year.map { "\($0). Opens its lineage." } ?? "Opens its lineage.")
  }
}
