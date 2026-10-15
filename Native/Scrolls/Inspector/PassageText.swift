// OWNER: N8
// A passage's text with its matches highlighted at their UTF-16 offsets (IOS-SPEC §4.8, D4; port of
// `passage-card.mjs` highlightSegments): highlights are clamped to the text, never split a surrogate pair, and
// overlapping highlights merge into one mark listing every occurrence it covers; the segments concatenate back to the
// text exactly. The match style is cyan 25% behind the text plus an underline (the selected occurrence a heavier
// underline), in the passage face of §4.20: New York with the Kohinoor Devanagari and Gujarati cascade, line height 1.6
// (1.8 and 1 pt more for Indic text). The same attributes feed SwiftUI `Text`, the TextKit 2 reader and the tests.

import ScrollsContracts
import SwiftUI
import UIKit

/// One run of a passage: plain text, or a mark over one or more highlights.
nonisolated struct HighlightSegment: Sendable, Equatable {
  /// UTF-16 offsets into the passage text.
  var start: Int
  var end: Int
  var text: String
  var mark: Bool
  var occurrences: [Int64]
  var variants: [String]
  var selected: Bool
  /// A name-guard hit (shown, excluded from counts).
  var nameFlag: Bool
}

nonisolated enum PassageSegments {
  private static func isHigh(_ c: UInt16) -> Bool { (0xD800...0xDBFF).contains(c) }
  private static func isLow(_ c: UInt16) -> Bool { (0xDC00...0xDFFF).contains(c) }

  /// `highlightSegments(text, highlights, {selectedOcc, selectedSpan})`.
  static func segments(_ text: String, _ highlights: [Highlight], selectedOcc: OccurrenceID? = nil,
                       selectedSpan: Range<Int>? = nil) -> [HighlightSegment] {
    let units = Array(text.utf16)
    let n = units.count
    struct Span { var s: Int; var e: Int; var hls: [Highlight] }
    var spans: [Span] = []
    for hl in highlights {
      var s = max(0, min(n, hl.start))
      var e = max(0, min(n, hl.end))
      guard s < e else { continue }
      if s > 0, s < n, isLow(units[s]), isHigh(units[s - 1]) { s -= 1 }
      if e < n, e > 0, isLow(units[e]), isHigh(units[e - 1]) { e += 1 }
      spans.append(Span(s: s, e: e, hls: [hl]))
    }
    spans.sort { ($0.s, $0.e) < ($1.s, $1.e) }
    var merged: [Span] = []
    for sp in spans {
      if var last = merged.last, sp.s < last.e {
        last.e = max(last.e, sp.e)
        last.hls += sp.hls
        merged[merged.count - 1] = last
      } else {
        merged.append(sp)
      }
    }
    func slice(_ a: Int, _ b: Int) -> String { String(utf16CodeUnits: Array(units[a..<b]), count: b - a) }
    var out: [HighlightSegment] = []
    var at = 0
    func plain(_ a: Int, _ b: Int) {
      if b > a { out.append(HighlightSegment(start: a, end: b, text: slice(a, b), mark: false, occurrences: [], variants: [],
                                             selected: false, nameFlag: false)) }
    }
    for m in merged {
      plain(at, m.s)
      let occs = m.hls.compactMap { $0.occ?.rawValue }
      var variants: [String] = []
      for v in m.hls.compactMap(\.variant) where !variants.contains(v) { variants.append(v) }
      let byOcc = selectedOcc.map { occs.contains($0.rawValue) } ?? false
      let bySpan = selectedSpan.map { m.s <= $0.lowerBound && $0.upperBound <= m.e && !$0.isEmpty } ?? false
      out.append(HighlightSegment(start: m.s, end: m.e, text: slice(m.s, m.e), mark: true, occurrences: occs, variants: variants,
                                  selected: byOcc || bySpan, nameFlag: m.hls.allSatisfy { $0.nameFlag == true }))
      at = m.e
    }
    plain(at, n)
    return out
  }
}

/// The passage face and its attributes (§4.20).
enum PassageStyle {
  /// The UIKit attributes of a passage body at a Dynamic Type size.
  static func attributes(lang: String?, text: String, size: DynamicTypeSize) -> [NSAttributedString.Key: Any] {
    let metrics = Typography.passageMetrics(lang: lang, text: text)
    let font = Typography.passageFont(size: size, bump: metrics.sizeBump)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = metrics.lineHeightMultiple
    paragraph.lineBreakMode = .byWordWrapping
    return [.font: font, .paragraphStyle: paragraph, .foregroundColor: UIColor(Tokens.ink.color)]
  }

  /// The attributes of a match (cyan 25% behind, underlined; the selected one double-underlined).
  static func markAttributes(selected: Bool) -> [NSAttributedString.Key: Any] {
    [.backgroundColor: UIColor(Tokens.cyan.opacity(Tokens.Alpha.matchHighlight)),
     .underlineStyle: (selected ? NSUnderlineStyle.double : NSUnderlineStyle.single).rawValue,
     .underlineColor: UIColor(Tokens.cyan.color)]
  }

  /// The passage as an attributed string for TextKit (the reader and the typography tests).
  static func attributed(_ segments: [HighlightSegment], lang: String?, size: DynamicTypeSize) -> NSAttributedString {
    let text = segments.map(\.text).joined()
    let out = NSMutableAttributedString(string: text, attributes: attributes(lang: lang, text: text, size: size))
    for s in segments where s.mark {
      out.addAttributes(markAttributes(selected: s.selected), range: NSRange(location: s.start, length: s.end - s.start))
    }
    return out
  }

  /// The passage for SwiftUI `Text`: the same marks, in AttributedString runs.
  static func swiftUI(_ segments: [HighlightSegment]) -> AttributedString {
    var out = AttributedString()
    for s in segments {
      var run = AttributedString(s.text)
      if s.mark {
        run.backgroundColor = Tokens.cyan.opacity(Tokens.Alpha.matchHighlight)
        run.underlineStyle = Text.LineStyle(pattern: .solid, color: Tokens.cyan.color)
        if s.selected { run.inlinePresentationIntent = .stronglyEmphasized }
      }
      out += run
    }
    return out
  }

  /// SwiftUI line spacing for a line-height multiple at a point size.
  static func lineSpacing(_ multiple: CGFloat, pointSize: CGFloat) -> CGFloat { max(0, (multiple - 1) * pointSize) }
}

/// A passage body in the reading face, with its matches marked (opaque, never glass).
struct PassageTextView: View {
  let segments: [HighlightSegment]
  let lang: String?
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let text = segments.map(\.text).joined()
    let metrics = Typography.passageMetrics(lang: lang, text: text)
    let font = Typography.passageFont(size: typeSize, bump: metrics.sizeBump)
    Text(PassageStyle.swiftUI(segments))
      .font(Font(font))
      .lineSpacing(PassageStyle.lineSpacing(metrics.lineHeightMultiple, pointSize: font.pointSize))
      .foregroundStyle(Tokens.ink.color)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .environment(\.locale, Locale(identifier: lang.flatMap { $0.hasPrefix("und") ? nil : $0 } ?? "en"))
      .accessibilityIdentifier("passageText")
  }
}
