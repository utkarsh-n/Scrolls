// OWNER: N5
// The hypothesis-group card (SPEC §2.C "Competing hypotheses"): a target and a question gathering alternative parent
// links, side by side with their evidence counts, authors and review statuses. Nothing is ever deleted; confirming one
// hypothesis leaves the others exactly as they were (never auto-rejected). Each opens its edge card for review.

import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

extension RootSlots {
  func hypothesisGroupCard(_ id: HypothesisGroupID) -> some View {
    NavigationStack { HypothesisGroupCard(id: id, atlas: model.atlas) }
  }
}

struct HypothesisGroupCard: View {
  let id: HypothesisGroupID
  let atlas: (any AtlasService)?
  @State private var group: HypothesisGroupResponse?
  @State private var error: ErrorCardModel?
  @State private var openEdge: RelationshipID?
  @Environment(\.dismiss) private var dismiss

  /// One hypothesis (`{rel_id, rel_type, glyph, label, evidence_status, review_status, author, evidence, …}`, verbatim).
  struct Hypothesis: Identifiable {
    var id: Int64
    var relType: String
    var label: String
    var evidenceStatus: String
    var reviewStatus: String
    var author: String
    var evidence: Int
    var method: String?
    var synthetic: Bool
  }

  static func hypotheses(_ v: JSONValue) -> [Hypothesis] {
    (v.arrayValue ?? []).compactMap { h in
      guard let id = h["rel_id"]?.safeInteger else { return nil }
      return Hypothesis(id: Int64(id), relType: h["rel_type"]?.stringValue ?? "", label: h["label"]?.stringValue ?? "",
                        evidenceStatus: h["evidence_status"]?.stringValue ?? "", reviewStatus: h["review_status"]?.stringValue ?? "",
                        author: h["author"]?.stringValue ?? "", evidence: h["evidence"]?.safeInteger ?? 0,
                        method: h["method"]?.stringValue, synthetic: h["synthetic"]?.boolValue ?? false)
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if let error {
          ErrorCard(error) { Task { await load() } }
        } else if let g = group {
          Text(g.question).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          Text(verbatim: "\(g.text ?? LineageCopy.competingCount(Self.hypotheses(g.hypotheses).count)) · target \(g.target)")
            .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          ForEach(Self.hypotheses(g.hypotheses)) { h in
            Button { openEdge = RelationshipID(rawValue: h.id) } label: {
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                  let st = EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: h.evidenceStatus, reviewStatus: h.reviewStatus,
                                                                isSynthetic: h.synthetic))
                  EvidenceBadge(st.badge)
                  Text(verbatim: "\(Vocab.relTypeByCode[h.relType]?.glyph ?? "") \(h.label)").font(Typography.cardBody)
                    .foregroundStyle(Tokens.ink.color).multilineTextAlignment(.leading)
                }
                Text(verbatim: "by \(h.author) · \(h.evidence) evidence span\(h.evidence == 1 ? "" : "s") · review \(h.reviewStatus)")
                  .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
                Text(LineageCopy.openLink).font(Typography.meta).foregroundStyle(Tokens.cyan.color)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(10)
              .opaquePanel()
              .syntheticFrame(h.synthetic)
            }
            .buttonStyle(.plain)
          }
          Text(LineageCopy.groupNote).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          Text(LineageCopy.caution).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        } else {
          HStack { ProgressView(); Text("Loading hypothesis group \(id.rawValue)…").font(Typography.meta) }
        }
      }
      .padding(Tokens.Geometry.gutter)
    }
    .background(Tokens.bg0.color)
    .navigationTitle(LineageCopy.competing)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .navigationDestination(item: $openEdge) { rel in EdgeCardView(relationship: rel, atlas: atlas) }
    .task { await load() }
    .accessibilityIdentifier("hypothesisGroupCard")
  }

  private func load() async {
    guard let atlas else { return }
    error = nil
    do {
      group = try await atlas.hypothesisGroup(id)
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.groupFailed)
    }
  }
}

extension RootSlots {
  func nodeCard(_ node: NodeRef) -> some View {
    NavigationStack { NodeCardView(node: node, atlas: model.atlas, coordinator: model.coordinator) }
  }
}

/// A node's card from another destination: what the node is, and the ways on (lineage, genealogy).
struct NodeCardView: View {
  let node: NodeRef
  let atlas: (any AtlasService)?
  let coordinator: PresentationCoordinator
  @State private var info: LineageNode?
  @State private var error: ErrorCardModel?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let error {
        ErrorCard(error)
      } else if let n = info {
        Text(n.title ?? n.label).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        Text(verbatim: "\(n.id) · \(n.label)").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        HStack {
          Button(LineageCopy.lineageFromHere) {
            coordinator.push(.lineage(LineageSeed(root: node)))
          }
          if node.kind == "document" {
            Button(LineageCopy.genealogyFromHere) { coordinator.push(.genealogy(GenealogySeed(work: node))) }
          }
        }
        .buttonStyle(.bordered)
      } else {
        ProgressView()
      }
      Spacer()
    }
    .padding(Tokens.Geometry.gutter)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Tokens.bg0.color)
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .task {
      guard let atlas else { return }
      do {
        let r = try await atlas.lineage(LineageRequest(root: "\(node.kind):\(node.id)", depth: 1, maxNodes: 1))
        info = r.nodes.first { $0.id == r.root }
      } catch {
        self.error = ErrorCardModel(any: error)
      }
    }
  }
}
