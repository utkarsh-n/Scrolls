// OWNER: N5
// The chain of custody (SPEC §2.C): the least-evidence-cost path between two picked nodes (documented 1, computed 3,
// proposed 5; rejected excluded), shown as a vertical list of link cards whose header reports chain strength = the
// weakest link ("PROPOSED"). An empty answer prints the engine's note, never a guess.

import ScrollsContracts
import ScrollsCore
import SwiftUI

struct ChainOfCustodyView: View {
  let path: LineagePathResponse
  let openEdge: (RelationshipID) -> Void

  /// A step of the path (`[{rel_id, src, dst, rel_type, evidence_status, review_status, cost}]`, verbatim).
  struct Step: Identifiable {
    var id: Int64
    var src: String
    var dst: String
    var relType: String
    var evidenceStatus: String
    var reviewStatus: String
    var cost: Int
  }

  static func steps(_ v: JSONValue) -> [Step] {
    (v.arrayValue ?? []).compactMap { s in
      guard let id = s["rel_id"]?.safeInteger else { return nil }
      return Step(id: Int64(id), src: s["src"]?.stringValue ?? "", dst: s["dst"]?.stringValue ?? "",
                  relType: s["rel_type"]?.stringValue ?? "", evidenceStatus: s["evidence_status"]?.stringValue ?? "",
                  reviewStatus: s["review_status"]?.stringValue ?? "", cost: s["cost"]?.safeInteger ?? 0)
    }
  }

  var body: some View {
    let steps = Self.steps(path.path)
    VStack(alignment: .leading, spacing: 8) {
      if steps.isEmpty {
        Text(path.note ?? "No chain of recorded links joins these two items.").font(Typography.cardBody)
          .foregroundStyle(Tokens.ink2.color)
      } else {
        Text(path.text ?? "Chain strength: weakest link \((path.weakest ?? "—").uppercased()).")
          .font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          .accessibilityIdentifier("lineage.chainStrength")
        if path.reversed == true {
          Text("No chain runs that way; this one runs from the second pick to the first.")
            .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
        ForEach(steps) { s in
          Button { openEdge(RelationshipID(rawValue: s.id)) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              let st = EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: s.evidenceStatus, reviewStatus: s.reviewStatus))
              EvidenceBadge(st.badge)
              VStack(alignment: .leading, spacing: 1) {
                let t = Vocab.relTypeByCode[s.relType]
                Text(verbatim: "\(s.src) \(t?.glyph ?? "") \(t?.label ?? s.relType) \(s.dst)").font(Typography.cardBody)
                  .foregroundStyle(Tokens.ink.color)
                Text(verbatim: "\(s.evidenceStatus) · review \(s.reviewStatus) · cost \(s.cost)")
                  .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(Tokens.bg2.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.small, style: .continuous))
          }
          .buttonStyle(.plain)
        }
        Text(verbatim: "total cost \(JSNumber.format(path.cost))").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    }
  }
}
