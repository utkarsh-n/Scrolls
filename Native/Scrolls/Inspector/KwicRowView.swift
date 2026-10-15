// OWNER: N8
// One concordance row (`passage-card.mjs` renderKwicRow): left context, the match, right context, then title · date ·
// lane · SYN; the whole row opens its passage. Indic rows use the passage cascade so conjuncts shape and vowel signs
// are not clipped (§4.20).

import ScrollsContracts
import SwiftUI

nonisolated enum KwicWords {
  /// `laneValue`: 'community:hiphop' → 'hiphop' (lane headers carry the full label).
  static func laneValue(_ key: String?) -> String? {
    guard let key, !key.isEmpty else { return nil }
    guard let i = key.firstIndex(of: ":") else { return key }
    return String(key[key.index(after: i)...])
  }

  /// "Brennock's Ready Arithmetic · 1911 · classroom".
  static func meta(_ row: KwicRow) -> String {
    [row.title, row.date?.label, laneValue(row.lane)].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
  }

  /// Runs of whitespace (line breaks in the original) shown as single spaces.
  static func flatten(_ s: String) -> String {
    s.replacing(/\s+/, with: " ")
  }
}

struct KwicRowView: View {
  let row: KwicRow
  let onOpen: (KwicRow) -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    Button {
      onOpen(row)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        line
        HStack(spacing: 6) {
          Text(KwicWords.meta(row)).font(Typography.meta).foregroundStyle(Tokens.ink3.color).lineLimit(2)
          if row.synthetic { EvidenceBadge("SYN") }
        }
      }
      .frame(maxWidth: .infinity, minHeight: Tokens.Geometry.minHit, alignment: .leading)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityHint(ThenCopy.opensPassage)
    .accessibilityIdentifier("kwic.\(row.passage.rawValue)")
  }

  private var line: some View {
    let whole = row.left + row.match + row.right
    let metrics = Typography.passageMetrics(lang: nil, text: whole)
    let font = Typography.passageFont(size: typeSize, bump: metrics.sizeBump)
    var text = AttributedString(KwicWords.flatten(row.left))
    var match = AttributedString(row.match)
    match.backgroundColor = Tokens.cyan.opacity(Tokens.Alpha.matchHighlight)
    match.underlineStyle = Text.LineStyle(pattern: .solid, color: Tokens.cyan.color)
    text += match
    text += AttributedString(KwicWords.flatten(row.right))
    return Text(text)
      .font(Font(font).leading(.loose))
      .lineSpacing(PassageStyle.lineSpacing(metrics.lineHeightMultiple, pointSize: font.pointSize) * 0.5)
      .foregroundStyle(Tokens.ink2.color)
      .lineLimit(3)
      .fixedSize(horizontal: false, vertical: true)
  }
}
