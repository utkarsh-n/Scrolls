// OWNER: N8
// IndicTypographyTests (IOS-SPEC §4.20, §8.5 N8): Devanagari and Gujarati in the reader, KWIC rows and chips. A Hindi and
// a Gujarati passage are laid out in TextKit 2 with the passage face (New York → Kohinoor Devanagari → Kohinoor
// Gujarati → system) and must show no `.notdef` glyph (every `CTRunGetGlyphs` ≠ 0) and no clipped line fragment (each
// fragment at least its line's ascent + descent). Indic text gets line height 1.8 and 1 pt more; Latin keeps 1.6.

import CoreText
import ScrollsContracts
import SwiftUI
import Testing
import UIKit

@testable import Scrolls

@MainActor
@Suite("Indic typography (§4.20)")
struct IndicTypographyTests {
  /// Conjuncts, vowel signs above and below, nukta and anusvara.
  nonisolated static let hindi = "शून्य ने स्थान को संभाला; क्षेत्र, ज्ञान, श्रृंगार और द्वार में मात्राएँ ऊपर-नीचे लगती हैं।"
  /// The demo's Gujarati passage (p140) plus conjuncts.
  nonisolated static let gujarati = "શૂન્ય ઉપાડો, બાળકો — એ ખાલી જગ્યા સાચવે છે. ક્ષેત્ર, જ્ઞાન, શ્રદ્ધા."

  /// Every glyph of the attributed string's Core Text line(s) is a real glyph (no `.notdef`, glyph id 0).
  private func notdefCount(_ s: NSAttributedString) -> Int {
    let line = CTLineCreateWithAttributedString(s)
    var zeros = 0
    for run in CTLineGetGlyphRuns(line) as? [CTRun] ?? [] {
      let n = CTRunGetGlyphCount(run)
      var glyphs = [CGGlyph](repeating: 0, count: n)
      CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
      zeros += glyphs.filter { $0 == 0 }.count
    }
    return zeros
  }

  /// Lays the string out in TextKit 2 at `width` and returns, per line fragment, (fragment height, ascent + descent).
  private func lineFits(_ s: NSAttributedString, width: CGFloat) -> [(height: CGFloat, needed: CGFloat)] {
    let storage = NSTextContentStorage()
    let layout = NSTextLayoutManager()
    storage.addTextLayoutManager(layout)
    let container = NSTextContainer(size: CGSize(width: width, height: 10_000))
    layout.textContainer = container
    storage.attributedString = s
    var out: [(CGFloat, CGFloat)] = []
    layout.enumerateTextLayoutFragments(from: layout.documentRange.location, options: [.ensuresLayout]) { fragment in
      for line in fragment.textLineFragments {
        let sub = line.attributedString.attributedSubstring(from: line.characterRange)
        let ct = CTLineCreateWithAttributedString(sub)
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        _ = CTLineGetTypographicBounds(ct, &ascent, &descent, &leading)
        out.append((line.typographicBounds.height, ascent + descent))
      }
      return true
    }
    return out
  }

  private func passage(_ text: String, lang: String) -> NSAttributedString {
    let units = (text as NSString).length
    let segments = PassageSegments.segments(text, [Highlight(start: 0, end: min(5, units))])
    return PassageStyle.attributed(segments, lang: lang, size: .large)
  }

  @Test("the Kohinoor faces of the cascade are installed (or the system cascade is recorded by the probe)")
  func faces() {
    for face in Typography.indicFaces {
      #expect(Typography.faceExists(face), "\(face) is missing: the system cascade draws Indic text")
    }
  }

  @Test("Indic passages get line height 1.8 and 1 pt more; Latin keeps 1.6", arguments: [
    ("hi", hindi, 1.8, 1.0), ("gu", gujarati, 1.8, 1.0), ("en", "Carry the zero, children.", 1.6, 0.0),
    (nil, hindi, 1.8, 1.0),
  ] as [(String?, String, Double, Double)])
  func metrics(lang: String?, text: String, multiple: Double, bump: Double) {
    let m = Typography.passageMetrics(lang: lang, text: text)
    #expect(Double(m.lineHeightMultiple) == multiple)
    #expect(Double(m.sizeBump) == bump)
  }

  @Test("reader: no .notdef glyph and no clipped line in TextKit 2", arguments: [("hi", hindi), ("gu", gujarati)])
  func reader(lang: String, text: String) {
    let s = passage(text, lang: lang)
    #expect(notdefCount(s) == 0, "\(lang): .notdef glyphs in the passage face")
    let lines = lineFits(s, width: 398)
    #expect(lines.count >= 2, "\(lang): expected a wrapped passage at 398 pt, got \(lines.count) line(s)")
    for (i, l) in lines.enumerated() {
      #expect(l.height + 0.5 >= l.needed, "\(lang) line \(i): fragment \(l.height) pt < ascent + descent \(l.needed) pt")
    }
  }

  @Test("KWIC rows and chips set Hindi and Gujarati without .notdef", arguments: [
    "हिन्दी · text", "ગુજરાતી · text", "…ने स्थान को शून्य ने संभाला…", "…ખાલી જગ્યા શૂન્ય સાચવે…",
  ])
  func kwicAndChips(text: String) {
    let kwicFont = Typography.passageFont(size: .large, bump: 1)
    #expect(notdefCount(NSAttributedString(string: text, attributes: [.font: kwicFont])) == 0)
    let chipFont = UIFont.preferredFont(forTextStyle: .footnote)
    #expect(notdefCount(NSAttributedString(string: text, attributes: [.font: chipFont])) == 0)
  }

  @Test("the passage face is New York with the Indic cascade")
  func cascade() {
    let font = Typography.passageFont(size: .large)
    let cascade = font.fontDescriptor.fontAttributes[.cascadeList] as? [UIFontDescriptor] ?? []
    let names = cascade.compactMap { $0.fontAttributes[.name] as? String }
    #expect(names == Typography.indicFaces)
    #expect(font.fontDescriptor.symbolicTraits.contains(.traitBold) == false)
  }
}
