// OWNER: N7
// The PNG snapshot of the Scroll (port of src/ui/timeline/snapshot.mjs `composePng` / `snapshotCaption`): the Scroll as
// it is on screen, drawn by the Canvas painter, with a 176 pt lane-label column, the SYNTHETIC stamp across the top
// whenever demo material is in it (IOS-SPEC §4.7: "the stamp on PNG exports"), and a footer with the legend line and the
// caption ("Scrolls · demo · carry the zero · data v47 · … · contains SYNTHETIC data · Lane order is …").

import CoreGraphics
import CoreText
import Foundation
import ScrollsCore
import ScrollsScrollModel

nonisolated public enum ScrollSnapshot {
  /// `STAMP`.
  public static let stamp = "SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links."
  /// The legend line of the footer (snapshot.mjs, verbatim).
  public static let legendLine =
    "▬ observed · ┈ looked, found none · ▨ no sources · ⁘ indexing · ▭ wash: date wider than the bin · DOC solid · CALC dashed · PROP dotted"
  static let labelW = 176.0, stampH = 26.0, footH = 46.0

  /// `snapshotCaption({view, query, labels})`.
  public static func caption(view: ViewState, dataVersion: Int?, totals: Format.Totals?, synthetic: Bool, labels: [String]) -> String {
    var parts = ["Scrolls", view.corpus]
    if !labels.isEmpty { parts.append(labels.joined(separator: " · ")) }
    if let dv = dataVersion { parts.append("data v\(dv)") }
    let runs = view.runs.materialize.sorted { $0.key < $1.key }.map { "e\($0.key)→run \($0.value)" }
    if !runs.isEmpty { parts.append(runs.joined(separator: ", ")) }
    if let totals { parts.append(Format.totalsText(totals)) }
    if synthetic || view.corpus == "demo" { parts.append("contains SYNTHETIC data") }
    return parts.joined(separator: " · ")
  }

  /// The composed PNG. `frame.viewSize` is the Scroll's size; the image adds the label column, the stamp and the footer.
  public static func png(build: DisplayBuild?, frame: ScrollFrame, synthetic: Bool, caption: String, scale: Double = 2) -> Data? {
    let top = synthetic ? stampH : 0
    let W = labelW + Double(frame.viewSize.width), H = top + Double(frame.viewSize.height) + footH
    let pw = Int((W * scale).rounded()), ph = Int((H * scale).rounded())
    guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(ph))
    ctx.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
    ctx.setFillColor(ScrollPalette.color(ScrollPalette.bg0))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    if synthetic {
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.bg1))
      ctx.fill(CGRect(x: 0, y: 0, width: W, height: stampH))
      ctx.setStrokeColor(CGColor(srgbRed: 217 / 255, green: 207 / 255, blue: 184 / 255, alpha: 0.16))
      ctx.setLineWidth(3)
      var x = -stampH
      while x < W {
        ctx.move(to: CGPoint(x: x, y: 0))
        ctx.addLine(to: CGPoint(x: x + stampH, y: stampH))
        x += 8
      }
      ctx.strokePath()
      text(stamp, size: 12, semibold: true, hex: ScrollPalette.syn, at: CGPoint(x: W / 2, y: 17), centre: true, maxWidth: W - 20, in: ctx)
    }
    ctx.saveGState()
    ctx.translateBy(x: labelW, y: top)
    ScrollPainter.paint(build: build, frame: frame, in: ctx)
    ctx.restoreGState()
    ctx.setFillColor(ScrollPalette.color(ScrollPalette.bg1))
    ctx.fill(CGRect(x: 0, y: top, width: labelW, height: Double(frame.viewSize.height)))
    if let build {
      ctx.saveGState()
      ctx.clip(to: CGRect(x: 0, y: top + frame.stripHeight, width: labelW, height: Double(frame.viewSize.height) - frame.stripHeight))
      for lane in build.model.lanes {
        guard let l = build.layout.lane(lane.key) else { continue }
        let y = top + frame.stripHeight + l.y - frame.scrollY
        let ly = y + min(l.h / 2, 20)
        text(lane.label, size: 13, semibold: false, medium: true, hex: ScrollPalette.ink, at: CGPoint(x: 10, y: ly), maxWidth: labelW - 44, in: ctx)
        if lane.synthetic { text("SYN", size: 9.5, semibold: true, hex: ScrollPalette.syn, at: CGPoint(x: labelW - 32, y: ly), maxWidth: 30, in: ctx) }
        let sub = ScrollWords.laneSubtitle(lane)
        if !sub.isEmpty && l.h >= 36 {
          text(sub, size: 11, semibold: false, hex: ScrollPalette.ink3, at: CGPoint(x: 10, y: ly + 15), maxWidth: labelW - 16, in: ctx)
        }
      }
      ctx.restoreGState()
    }
    let footY = top + Double(frame.viewSize.height)
    text(legendLine, size: 11, semibold: false, hex: ScrollPalette.ink2, at: CGPoint(x: 10, y: footY + 16), maxWidth: W - 20, in: ctx)
    text("\(caption) · \(Copy.laneOrderNote)", size: 11, semibold: false, hex: ScrollPalette.ink2, at: CGPoint(x: 10, y: footY + 34),
         maxWidth: W - 20, in: ctx)
    return ctx.makeImage().flatMap(Raster.png)
  }

  /// One line of text at a baseline (y-down context), squeezed to `maxWidth` the way canvas `fillText` does.
  static func text(_ s: String, size: Double, semibold: Bool, medium: Bool = false, hex: UInt32, at p: CGPoint, centre: Bool = false,
                   maxWidth: Double, in ctx: CGContext) {
    let base = CTFontCreateUIFontForLanguage(.system, CGFloat(size), nil)!
    let weight = semibold ? 0.3 : medium ? 0.23 : 0
    let font = weight > 0
      ? CTFontCreateWithFontDescriptor(CTFontDescriptorCreateCopyWithAttributes(CTFontCopyFontDescriptor(base),
                                                                               [kCTFontTraitsAttribute: [kCTFontWeightTrait: weight]] as CFDictionary), CGFloat(size), nil)
      : base
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): ScrollPalette.color(hex),
    ]))
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    let squeeze = width > maxWidth ? maxWidth / width : 1
    ctx.saveGState()
    let x = centre ? Double(p.x) - min(width, maxWidth) / 2 : Double(p.x)
    ctx.translateBy(x: x, y: Double(p.y))
    ctx.scaleBy(x: squeeze, y: 1)
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    ctx.textPosition = .zero
    CTLineDraw(line, ctx)
    ctx.restoreGState()
  }
}
