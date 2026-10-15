// OWNER: N7
// The Canvas drawing of the same display lists (IOS-SPEC §4.23): `ScrollPainter` paints a build and a frame into any
// Core Graphics context with the shader's rules, style for style (the same instances from
// `ScrollRenderer.shapeInstances`, the same colours, alphas, dashes, pattern pitches and phases, the same vantage
// predicate), so it is
//  1. the fallback renderer (`-renderer canvas`, ≤ 60 Hz) through `DisplayListCanvas`, a SwiftUI `Canvas`;
//  2. the snapshot renderer (`ScrollSnapshot`, PNG);
//  3. G8's reference: Metal and this painter must agree on ≥ 99% of pixels (ScrollsRenderTests).

import CoreGraphics
import CoreText
import Foundation
import ScrollsCore
import ScrollsScrollModel
import SwiftUI

/// SPEC §8.7 tokens as Core Graphics colours (= Design/Tokens.swift and Scroll.metal).
nonisolated public enum ScrollPalette {
  public static func rgb(_ hex: UInt32) -> (Double, Double, Double) {
    (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
  }
  public static let bg0: UInt32 = 0x0E1013, bg1: UInt32 = 0x161A20, bg2: UInt32 = 0x1F242C, bg3: UInt32 = 0x2A303A, rule: UInt32 = 0x343A45
  public static let ink: UInt32 = 0xEDE6D6, ink2: UInt32 = 0xBDB5A5, ink3: UInt32 = 0x8E887B
  public static let cyan: UInt32 = 0x4FD8E8, amber: UInt32 = 0xE8A84A, violet: UInt32 = 0xB59AF5, danger: UInt32 = 0xF2826F
  public static let ok: UInt32 = 0x7BD389, syn: UInt32 = 0xD9CFB8

  public static func color(_ hex: UInt32, _ alpha: Double = 1) -> CGColor {
    let (r, g, b) = rgb(hex)
    return CGColor(srgbRed: r, green: g, blue: b, alpha: alpha)
  }
}

/// Paints a display build and a frame into a Core Graphics context whose user space is view points, y down.
nonisolated public enum ScrollPainter {
  /// Paints the whole Scroll: the background, the lanes list (clipped to the lanes area), the top list (clipped to the
  /// strip) and the overlay. `atlasScale` is unused by Core Graphics (text is drawn from CoreText directly).
  public static func paint(build: DisplayBuild?, frame: ScrollFrame, in ctx: CGContext) {
    let w = Double(frame.viewSize.width), h = Double(frame.viewSize.height)
    ctx.saveGState()
    ctx.setFillColor(ScrollPalette.color(ScrollPalette.bg0))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if let build {
      ctx.saveGState()
      ctx.clip(to: CGRect(x: 0, y: frame.stripHeight, width: w, height: max(0, frame.lanesBottom - frame.stripHeight)))
      paintList(build.lanes, meta: build.laneMeta, frame: frame, originY: frame.stripHeight - frame.scrollY, caption: nil, in: ctx)
      ctx.restoreGState()
      ctx.saveGState()
      ctx.clip(to: CGRect(x: 0, y: 0, width: w, height: frame.stripHeight))
      paintList(build.top, meta: build.topMeta, frame: frame, originY: 0, caption: seamCaption(build: build, frame: frame), in: ctx)
      ctx.restoreGState()
    }
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: 0, width: w, height: frame.lanesBottom))
    paintOverlay(build: build, frame: frame, in: ctx)
    ctx.restoreGState()
    ctx.restoreGState()
  }

  /// The seam caption's view-x box (ruler labels under it give way), as the renderer computes it.
  static func seamCaption(build: DisplayBuild, frame: ScrollFrame) -> (Double, Double)? {
    for m in build.topMeta where m.style == .seamLabel {
      guard case .label(let li) = m.slot, li < build.top.labels.count else { continue }
      let l = build.top.labels[li]
      guard let run = build.top.labelRuns[l.key] else { continue }
      let ax = frame.x(day: Double(build.top.originDay) + Double(l.d))
      let place = Seams.captionPlace(seamX: ax, width: DisplayBuilder.seamLabelWidth(run.text), visible: (0, Double(frame.viewSize.width)))
      return (place.x0, place.x1)
    }
    return nil
  }

  /// The vantage alpha of a primitive (`vantageAlpha` in Scroll.metal).
  static func vantageAlpha(_ reveal: Int32, _ flags: UInt16, _ frame: ScrollFrame) -> Double {
    var a = 1.0
    if let v = frame.vantage, reveal != alwaysRevealed {
      if reveal > v.day {
        a = v.mode == .strict ? 0 : Double(Visibility.ghostOpacity)
      } else if let from = frame.fadeFrom, reveal > from {
        a = Double(frame.fade)
      }
    }
    if PrimFlags(rawValue: flags).contains(.ghost) { a *= Double(Visibility.ghostOpacity) }
    return a * Double(frame.dim)
  }

  static func paintList(_ list: DisplayList, meta: [PrimMeta], frame: ScrollFrame, originY: Double, caption: (Double, Double)?,
                        in ctx: CGContext) {
    let (bg, data) = ScrollRenderer.shapeInstances(list, meta: meta)
    let origin = Double(list.originDay)
    let patternX = frame.x(day: origin)
    for s in bg + data {
      let a = vantageAlpha(s.reveal, s.flags, frame)
      guard a > 0.003 else { continue }
      let rect = shapeRect(s, frame: frame, origin: origin, originY: originY)
      paintShape(s, rect: rect, alpha: a, patternX: patternX, frame: frame, in: ctx)
    }
    // labels and glyph caps
    for g in list.glyphs {
      let a = vantageAlpha(g.revealDay, g.flags, frame)
      guard a > 0.003, let run = list.labelRuns[g.glyph], let style = ScrollStyle(rawValue: g.style) else { continue }
      let x = frame.x(day: origin + Double(g.d)), y = Double(g.y) + originY
      drawText(run.text, role: style, size: Double(g.size), anchor: CGPoint(x: x, y: y), align: 1, glyph: true, alpha: a, in: ctx)
    }
    for l in list.labels {
      var a = vantageAlpha(l.revealDay, l.flags, frame)
      guard a > 0.003, let run = list.labelRuns[l.key], let style = ScrollStyle(rawValue: l.style) else { continue }
      var x = frame.x(day: origin + Double(l.d))
      let y = Double(l.y) + originY
      var align = l.align
      if style == .seamLabel {
        let place = Seams.captionPlace(seamX: x, width: ScrollText.metrics(ScrollText.line(run.text, role: style)).width,
                                       visible: (0, Double(frame.viewSize.width)))
        x = place.x
        align = place.alignEnd ? 2 : 0
      }
      if style == .rulerLabel, let c = caption {
        let lw = ScrollText.metrics(ScrollText.line(run.text, role: style)).width
        if x < c.1 + 4 && x + lw > c.0 - 4 { a = 0 }
      }
      guard a > 0.003 else { continue }
      drawText(run.text, role: style, size: nil, anchor: CGPoint(x: x, y: y), align: align, glyph: false, alpha: a, in: ctx)
    }
  }

  /// The view-point box of a shape instance (the shader's x0…x1, y0…y1).
  static func shapeRect(_ s: SInstance, frame: ScrollFrame, origin: Double, originY: Double) -> CGRect {
    let cx0 = frame.x(day: origin + Double(s.d0))
    switch s.kind {
    case .span:
      let x1 = frame.x(day: origin + Double(s.d1))
      return CGRect(x: cx0, y: Double(s.y0) + originY, width: x1 - cx0, height: Double(s.y1 - s.y0))
    case .centre:
      let hw = max(Double(s.p0), 0.5)
      return CGRect(x: cx0 - hw, y: Double(s.y0) + originY, width: 2 * hw, height: Double(s.y1 - s.y0))
    case .diamond:
      let r = Double(s.p0)
      return CGRect(x: cx0 - r, y: Double(s.y0) + originY - r, width: 2 * r, height: 2 * r)
    case .view:
      return CGRect(x: Double(s.d0), y: Double(s.y0), width: Double(s.d1 - s.d0), height: Double(s.y1 - s.y0))
    }
  }

  // MARK: patterns

  /// A diagonal pattern clipped to `rect`: lines where x ± y ≡ 0 (mod pitch) in pattern space (x − patternX, y).
  static func diagonal(_ rect: CGRect, pitch: Double, width: Double, backslash: Bool, color: CGColor, patternX: Double, in ctx: CGContext) {
    guard rect.width > 0, rect.height > 0 else { return }
    ctx.saveGState()
    ctx.clip(to: rect)
    ctx.setStrokeColor(color)
    ctx.setLineWidth(width)
    let x0 = Double(rect.minX) - patternX, x1 = Double(rect.maxX) - patternX, y0 = Double(rect.minY), y1 = Double(rect.maxY)
    // forward: x + y = k·pitch; backslash: x − y = k·pitch
    let lo = backslash ? x0 - y1 : x0 + y0, hi = backslash ? x1 - y0 : x1 + y1
    var k = (lo / pitch).rounded(.down) - 1
    while k * pitch <= hi + pitch {
      let t = k * pitch
      if backslash {
        ctx.move(to: CGPoint(x: t + y0 + patternX, y: y0))
        ctx.addLine(to: CGPoint(x: t + y1 + patternX, y: y1))
      } else {
        ctx.move(to: CGPoint(x: t - y0 + patternX, y: y0))
        ctx.addLine(to: CGPoint(x: t - y1 + patternX, y: y1))
      }
      k += 1
    }
    ctx.strokePath()
    ctx.restoreGState()
  }

  static func pattern(_ id: UInt16, _ rect: CGRect, patternX: Double, alpha: Double, clipPath: CGPath? = nil, in ctx: CGContext) {
    guard let p = PatternID(rawValue: id), p != .none else { return }
    ctx.saveGState()
    if let clipPath {
      ctx.addPath(clipPath)
      ctx.clip()
    }
    switch p {
    case .hatch: diagonal(rect, pitch: 6, width: 1, backslash: false, color: ScrollPalette.color(ScrollPalette.ink, 0.09 * alpha), patternX: patternX, in: ctx)
    case .hatchLow: diagonal(rect, pitch: 4, width: 1, backslash: false, color: ScrollPalette.color(ScrollPalette.ink, 0.07 * alpha), patternX: patternX, in: ctx)
    case .stripes: diagonal(rect, pitch: 3, width: 1, backslash: true, color: ScrollPalette.color(ScrollPalette.ink, 0.30 * alpha), patternX: patternX, in: ctx)
    case .syn: diagonal(rect, pitch: 8, width: 3, backslash: true, color: ScrollPalette.color(ScrollPalette.syn, 0.16 * alpha), patternX: patternX, in: ctx)
    case .dots:
      ctx.clip(to: rect)
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.26 * alpha))
      let x0 = Double(rect.minX) - patternX, x1 = Double(rect.maxX) - patternX
      var i = (x0 / 6).rounded(.down)
      while i * 6 <= x1 {
        var j = (Double(rect.minY) / 6).rounded(.down)
        while j * 6 <= Double(rect.maxY) {
          ctx.addEllipse(in: CGRect(x: i * 6 + 3 - 0.9 + patternX, y: j * 6 + 3 - 0.9, width: 1.8, height: 1.8))
          j += 1
        }
        i += 1
      }
      ctx.fillPath()
    case .none: break
    }
    ctx.restoreGState()
  }

  // MARK: shapes

  static func fill(_ r: CGRect, _ hex: UInt32, _ a: Double, in ctx: CGContext) {
    guard r.width > 0, r.height > 0, a > 0 else { return }
    ctx.setFillColor(ScrollPalette.color(hex, a))
    ctx.fill(r)
  }

  static func fillWhite(_ r: CGRect, white: Double, _ a: Double, in ctx: CGContext) {
    guard r.width > 0, r.height > 0 else { return }
    ctx.setFillColor(CGColor(srgbRed: white, green: white, blue: white, alpha: a))
    ctx.fill(r)
  }

  /// A rect with rounded left corners `rl` and right corners `rr`.
  static func roundRect(_ r: CGRect, rl: Double, rr: Double) -> CGPath {
    let p = CGMutablePath()
    let x0 = Double(r.minX), x1 = Double(r.maxX), y0 = Double(r.minY), y1 = Double(r.maxY)
    p.move(to: CGPoint(x: x0 + rl, y: y0))
    p.addLine(to: CGPoint(x: x1 - rr, y: y0))
    if rr > 0 { p.addArc(tangent1End: CGPoint(x: x1, y: y0), tangent2End: CGPoint(x: x1, y: y0 + rr), radius: rr) } else { p.addLine(to: CGPoint(x: x1, y: y0)) }
    p.addLine(to: CGPoint(x: x1, y: y1 - rr))
    if rr > 0 { p.addArc(tangent1End: CGPoint(x: x1, y: y1), tangent2End: CGPoint(x: x1 - rr, y: y1), radius: rr) } else { p.addLine(to: CGPoint(x: x1, y: y1)) }
    p.addLine(to: CGPoint(x: x0 + rl, y: y1))
    if rl > 0 { p.addArc(tangent1End: CGPoint(x: x0, y: y1), tangent2End: CGPoint(x: x0, y: y1 - rl), radius: rl) } else { p.addLine(to: CGPoint(x: x0, y: y1)) }
    p.addLine(to: CGPoint(x: x0, y: y0 + rl))
    if rl > 0 { p.addArc(tangent1End: CGPoint(x: x0, y: y0), tangent2End: CGPoint(x: x0 + rl, y: y0), radius: rl) } else { p.addLine(to: CGPoint(x: x0, y: y0)) }
    p.closeSubpath()
    return p
  }

  /// Dashes along x in pattern space: `on` points drawn of every `on + off`.
  static func dashedX(_ r: CGRect, on: Double, off: Double, phaseX: Double, _ hex: UInt32, _ a: Double, in ctx: CGContext) {
    ctx.saveGState()
    ctx.clip(to: r)
    ctx.setFillColor(ScrollPalette.color(hex, a))
    let period = on + off
    var t = ((Double(r.minX) - phaseX) / period).rounded(.down) * period + phaseX
    while t < Double(r.maxX) {
      ctx.fill(CGRect(x: t, y: Double(r.minY), width: on, height: Double(r.height)))
      t += period
    }
    ctx.restoreGState()
  }

  /// Dashes along y in view space.
  static func dashedY(_ r: CGRect, on: Double, off: Double, _ hex: UInt32, _ a: Double, in ctx: CGContext) {
    ctx.saveGState()
    ctx.clip(to: r)
    ctx.setFillColor(ScrollPalette.color(hex, a))
    let period = on + off
    var t = (Double(r.minY) / period).rounded(.down) * period
    while t < Double(r.maxY) {
      ctx.fill(CGRect(x: Double(r.minX), y: t, width: Double(r.width), height: on))
      t += period
    }
    ctx.restoreGState()
  }

  // swiftlint:disable:next cyclomatic_complexity function_body_length
  static func paintShape(_ s: SInstance, rect r: CGRect, alpha a: Double, patternX: Double, frame: ScrollFrame, in ctx: CGContext) {
    let x0 = Double(r.minX), y0 = Double(r.minY), w = Double(r.width), h = Double(r.height)
    let flags = PrimFlags(rawValue: s.flags)
    let contrast = frame.highContrast
    let ink3 = contrast ? ScrollPalette.ink2 : ScrollPalette.ink3
    if let o = OverlayStyle(rawValue: s.style) {
      paintOverlayShape(o, r, p0: Double(s.p0), in: ctx)
      return
    }
    guard let style = ScrollStyle(rawValue: s.style) else { return }
    switch style {
    case .none: return
    case .laneEven, .laneOdd:
      fill(r, style == .laneEven ? ScrollPalette.bg0 : ScrollPalette.bg1, a, in: ctx)
      fill(CGRect(x: x0, y: y0 + h - 1, width: w, height: 1), ScrollPalette.rule, (contrast ? 0.9 : 0.55) * a, in: ctx)
    case .hatch, .cov0: pattern(PatternID.hatch.rawValue, r, patternX: patternX, alpha: a, in: ctx)
    case .hatchLow: pattern(PatternID.hatchLow.rawValue, r, patternX: patternX, alpha: a, in: ctx)
    case .dots: pattern(PatternID.dots.rawValue, r, patternX: patternX, alpha: a, in: ctx)
    case .loading: fill(r, ScrollPalette.ink, 0.03 * a, in: ctx)
    case .cov1, .cov2, .cov3, .cov4:
      let alphas = [0.0, 0.12, 0.24, 0.38, 0.56]
      fill(CGRect(x: x0, y: y0, width: max(w - 0.5, 0.5), height: h), ScrollPalette.ink, alphas[style.coverageClass!] * a, in: ctx)
    case .covSpan:
      let syn = flags.contains(.synthetic)
      fill(r, ScrollPalette.ink, (syn ? 0.06 : 0.08) * a, in: ctx)
      if syn { pattern(PatternID.syn.rawValue, r, patternX: patternX, alpha: a, in: ctx) }
      fill(CGRect(x: x0, y: y0, width: w, height: 1), ScrollPalette.ink, 0.32 * a, in: ctx)
      fill(CGRect(x: x0, y: y0 + h - 1, width: w, height: 1), ScrollPalette.ink, 0.32 * a, in: ctx)
      fill(CGRect(x: x0, y: y0 - 3, width: 1, height: h + 6), ScrollPalette.ink, 0.32 * a, in: ctx)
      fill(CGRect(x: x0 + w - 1, y: y0 - 3, width: 1, height: h + 6), ScrollPalette.ink, 0.32 * a, in: ctx)
    case .bar, .barSparse, .barBackdrop:
      let bw = max(w - 0.75, 0.75)
      let rad = min(2, bw / 2, h / 2)
      let narrow = w < 6
      let rl = !narrow && flags.contains(.roundLeading) ? rad : 0, rr = !narrow && flags.contains(.roundTrailing) ? rad : 0
      let body = roundRect(CGRect(x: x0, y: y0, width: bw, height: h), rl: rl, rr: rr)
      if style == .bar {
        if !narrow && h >= 4 && bw >= 2 {
          ctx.addPath(roundRect(CGRect(x: x0 - 1.5, y: y0 - 1.5, width: bw + 3, height: h + 3), rl: rl > 0 ? rl + 1.5 : 0, rr: rr > 0 ? rr + 1.5 : 0))
          ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.07 * a))
          ctx.fillPath()
        }
        ctx.addPath(body)
        ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.88 * a))
        ctx.fillPath()
        let topW = max(0, bw - rl - rr)
        ctx.saveGState()
        ctx.addPath(body)
        ctx.clip()
        fillWhite(CGRect(x: x0 + rl, y: y0, width: topW, height: 1), white: 1, 0.12 * a, in: ctx)
        if h >= 6 { fillWhite(CGRect(x: x0 + rl, y: y0 + h - 1, width: topW, height: 1), white: 0, 0.14 * a, in: ctx) }
        ctx.restoreGState()
      } else if style == .barSparse {
        ctx.addPath(body)
        ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.25 * a))
        ctx.fillPath()
        let inner = roundRect(CGRect(x: x0 + 1, y: y0 + 1, width: max(bw - 2, 0), height: max(h - 2, 0)), rl: max(rl - 1, 0), rr: max(rr - 1, 0))
        ctx.addPath(body)
        ctx.addPath(inner)
        ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.88 * a))
        ctx.fillPath(using: .evenOdd)
      } else {
        ctx.addPath(body)
        ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, 0.20 * a))
        ctx.fillPath()
        ctx.saveGState()
        ctx.addPath(body)
        ctx.clip()
        fill(CGRect(x: x0 + rl, y: y0, width: max(0, bw - rl - rr), height: 1), ScrollPalette.ink, 0.22 * a, in: ctx)
        ctx.restoreGState()
      }
      if s.pattern != 0 { pattern(s.pattern, CGRect(x: x0, y: y0, width: bw, height: h), patternX: patternX, alpha: a, clipPath: body, in: ctx) }
    case .absent:
      let mid = (h / 2).rounded(.down) + 0.5
      dashedX(CGRect(x: x0 + 1, y: y0 + mid - 0.5, width: max(0, w - 2), height: 1), on: 1, off: 3, phaseX: patternX, ink3, a, in: ctx)
    case .lowTick:
      ctx.addRect(r)
      ctx.addRect(r.insetBy(dx: 1, dy: 1))
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink2, a))
      ctx.fillPath(using: .evenOdd)
    case .capEnd: fill(CGRect(x: x0, y: y0, width: max(w, 2), height: h), ScrollPalette.ink, a, in: ctx)
    case .wash, .washSyn:
      let f = s.p0 > 0 ? min(w * Double(s.p0), 40) : 0
      if f > 0.5 {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ink = ScrollPalette.rgb(ScrollPalette.ink)
        let c0 = CGColor(srgbRed: ink.0, green: ink.1, blue: ink.2, alpha: 0), c1 = CGColor(srgbRed: ink.0, green: ink.1, blue: ink.2, alpha: 0.18 * a)
        let grad = CGGradient(colorsSpace: cs, colors: [c0, c1, c1, c0] as CFArray, locations: [0, f / w, 1 - f / w, 1])!
        ctx.saveGState()
        ctx.clip(to: r)
        ctx.drawLinearGradient(grad, start: CGPoint(x: x0, y: y0), end: CGPoint(x: x0 + w, y: y0), options: [])
        ctx.restoreGState()
      } else {
        fill(r, ScrollPalette.ink, 0.18 * a, in: ctx)
      }
      if style == .washSyn { pattern(PatternID.syn.rawValue, r, patternX: patternX, alpha: a, in: ctx) }
      fill(CGRect(x: x0 + f, y: y0, width: max(0, w - 2 * f), height: 1), ScrollPalette.ink, 0.55 * a, in: ctx)
    case .markText: fill(CGRect(x: x0 + w / 2 - 0.5, y: y0, width: 1, height: h), ScrollPalette.ink, a, in: ctx)
    case .markEst:
      ctx.addRect(CGRect(x: x0 + w / 2 - 1, y: y0, width: 2, height: h))
      ctx.addRect(CGRect(x: x0 + w / 2 - 0.5, y: y0 + 1, width: 1, height: max(0, h - 2)))
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, a))
      ctx.fillPath(using: .evenOdd)
    case .markTitle:
      let cx = x0 + w / 2, cy = y0 + h / 2, rr = w / 2
      ctx.move(to: CGPoint(x: cx, y: cy - rr))
      ctx.addLine(to: CGPoint(x: cx + rr, y: cy))
      ctx.addLine(to: CGPoint(x: cx, y: cy + rr))
      ctx.addLine(to: CGPoint(x: cx - rr, y: cy))
      ctx.closePath()
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, a))
      ctx.fillPath()
    case .bracketStated, .bracketEst, .bracketDerived, .bracketPeriod:
      if style == .bracketPeriod { pattern(PatternID.hatch.rawValue, r, patternX: patternX, alpha: a, in: ctx) }
      let mid = h / 2
      let lines = [CGRect(x: x0, y: y0, width: 1, height: mid + 0.5), CGRect(x: x0 + w - 1, y: y0, width: 1, height: mid + 0.5),
                   CGRect(x: x0, y: y0 + mid - 0.5, width: w, height: 1)]
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.ink, a))
      if style == .bracketEst {
        // dashes along x + y (3 on, 2 off) in the box's own coordinates, as the shader cuts them
        for l in lines {
          ctx.saveGState()
          ctx.clip(to: l)
          var k = 0.0
          while k < w + h {
            ctx.move(to: CGPoint(x: x0 + k, y: y0))
            ctx.addLine(to: CGPoint(x: x0 + k + 3, y: y0))
            ctx.addLine(to: CGPoint(x: x0 + k + 3 - (h + 2), y: y0 + h + 2))
            ctx.addLine(to: CGPoint(x: x0 + k - (h + 2), y: y0 + h + 2))
            ctx.closePath()
            k += 5
          }
          ctx.fillPath()
          ctx.restoreGState()
        }
      } else {
        for l in lines { ctx.fill(l) }
      }
    case .coarse: fill(r, ScrollPalette.ink, 0.38 * a, in: ctx)
    case .rulerMajor, .rulerMinor, .seamTick:
      let lw = style == .seamTick ? 1.5 : 1
      let col = style == .rulerMajor ? ink3 : style == .seamTick ? ScrollPalette.ink2 : (contrast ? ScrollPalette.ink3 : ScrollPalette.rule)
      fill(CGRect(x: x0 + w / 2 - lw / 2, y: y0, width: lw, height: h), col, a, in: ctx)
    case .seam:
      dashedY(CGRect(x: x0 + w / 2 - 0.5, y: y0, width: 1, height: h), on: 4, off: 3, ScrollPalette.ink2, 0.85 * a, in: ctx)
    case .rulerLabel, .superscript, .lowN, .washLabel, .coarseLabel, .seamLabel, .spanLabel, .capStart, .capChevron:
      return
    }
  }

  static func paintOverlayShape(_ o: OverlayStyle, _ r: CGRect, p0: Double, in ctx: CGContext) {
    switch o {
    case .playhead: fill(r, ScrollPalette.cyan, 1, in: ctx)
    case .playheadGlow: fill(r, ScrollPalette.cyan, 0.18, in: ctx)
    case .veil: fill(r, ScrollPalette.bg0, p0, in: ctx)
    case .brush:
      fill(r, ScrollPalette.cyan, 0.10, in: ctx)
      fill(CGRect(x: r.minX, y: r.minY, width: 1, height: r.height), ScrollPalette.cyan, 1, in: ctx)
      fill(CGRect(x: r.maxX - 1, y: r.minY, width: 1, height: r.height), ScrollPalette.cyan, 1, in: ctx)
    case .selection:
      ctx.setStrokeColor(ScrollPalette.color(ScrollPalette.cyan, 0.2))
      ctx.setLineWidth(6)
      ctx.stroke(r)
      ctx.setStrokeColor(ScrollPalette.color(ScrollPalette.cyan, 1))
      ctx.setLineWidth(2)
      ctx.stroke(r)
    case .focus:
      ctx.addRect(r)
      ctx.addRect(r.insetBy(dx: 2, dy: 2))
      ctx.setFillColor(ScrollPalette.color(ScrollPalette.cyan, 1))
      ctx.fillPath(using: .evenOdd)
    }
  }

  static func paintOverlay(build: DisplayBuild?, frame: ScrollFrame, in ctx: CGContext) {
    for s in ScrollRenderer.overlay(frame: frame, build: build) {
      guard let o = OverlayStyle(rawValue: s.style) else { continue }
      paintOverlayShape(o, CGRect(x: Double(s.d0), y: Double(s.y0), width: Double(s.d1 - s.d0), height: Double(s.y1 - s.y0)),
                        p0: Double(s.p0), in: ctx)
    }
  }

  // MARK: text

  static func textColor(_ role: ScrollStyle) -> (UInt32, Double, Bool) {
    switch role {
    case .rulerLabel: (ScrollPalette.ink, 0.78, false)
    case .lowN: (ScrollPalette.ink3, 1, false)
    case .capStart, .capChevron: (ScrollPalette.ink, 1, true)
    case .spanLabel: (ScrollPalette.ink2, 1, true)
    default: (ScrollPalette.ink2, 1, false)
    }
  }

  /// Draws a label at its anchor (baseline y; leading, centre or trailing on x; caps centred both ways).
  static func drawText(_ text: String, role: ScrollStyle, size: Double?, anchor: CGPoint, align: UInt8, glyph: Bool, alpha: Double,
                       in ctx: CGContext) {
    let line = ScrollText.line(text, role: role, size: size)
    let m = ScrollText.metrics(line)
    let pl = ScrollText.placement(role: role, align: align, width: m.width, ascent: m.ascent, descent: m.descent, pad: 0, glyph: glyph)
    let x = Double(anchor.x) + pl.ox, baseline = Double(anchor.y) + pl.oy + m.ascent
    let (hex, a, halo) = textColor(role)
    ctx.saveGState()
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    if halo {
      ctx.setTextDrawingMode(.stroke)
      ctx.setLineWidth(3)
      ctx.setLineJoin(.round)
      ctx.setStrokeColor(ScrollPalette.color(ScrollPalette.bg0, alpha))
      ctx.textPosition = CGPoint(x: x, y: baseline)
      CTLineDraw(line, ctx)
    }
    ctx.setTextDrawingMode(.fill)
    let colored = NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): ScrollText.font(role: role, size: size),
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): ScrollPalette.color(hex, a * alpha),
    ])
    ctx.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(CTLineCreateWithAttributedString(colored), ctx)
    ctx.restoreGState()
  }
}

extension ScrollRenderer {
  /// The overlay quads of a frame (shared by Metal and the Canvas painter).
  nonisolated public static func overlay(frame: ScrollFrame, build: DisplayBuild?) -> [SInstance] {
    var out: [SInstance] = []
    let w = Double(frame.viewSize.width), bottom = frame.lanesBottom, strip = frame.stripHeight
    func quad(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, _ style: OverlayStyle, p0: Float = 0) {
      out.append(SInstance(d0: Float(x0), d1: Float(x1), y0: Float(y0), y1: Float(y1), p0: p0, style: style.rawValue, flags: 0,
                           kind: .view, reveal: .min, id: 0))
    }
    if let v = frame.vantage {
      let x = frame.x(day: Double(v.day) + 1)
      if frame.veil && x < w { quad(max(0, x), strip, w, bottom, .veil, p0: v.mode == .strict ? 0.22 : 0.12) }
      if x >= 0 && x <= w {
        let rx = (x * frame.scale).rounded() / frame.scale
        quad(rx - 3, 0, rx + 3, bottom, .playheadGlow)
        quad(rx - 1, 0, rx + 1, bottom, .playhead)
      }
    }
    if let b = frame.brush {
      let a = frame.x(day: b.lowerBound), c = frame.x(day: b.upperBound + 1)
      quad(min(a, c), 0, max(a, c), bottom, .brush)
    }
    if let build {
      for id in frame.selection {
        guard let r = selectionBox(id, build: build, frame: frame) else { continue }
        quad(Double(r.minX), Double(r.minY), Double(r.maxX), Double(r.maxY), .selection)
      }
    }
    if let f = frame.focus { quad(Double(f.minX), Double(f.minY), Double(f.maxX), Double(f.maxY), .focus) }
    return out
  }

  /// The selection ring's rectangle of a lanes primitive in view points (`paintOverlay` `ring`: 2 pt around the box,
  /// 7 pt around a glyph's 12 pt square).
  nonisolated public static func selectionBox(_ id: PrimID, build: DisplayBuild, frame: ScrollFrame) -> CGRect? {
    let list = build.lanes
    guard Int(id.rawValue) < build.laneMeta.count else { return nil }
    let origin = Double(list.originDay), oy = frame.stripHeight - frame.scrollY
    func vx(_ d: Float) -> Double { frame.x(day: origin + Double(d)) }
    var x0 = 0.0, x1 = 0.0, y0 = 0.0, y1 = 0.0, glyph = false
    switch build.laneMeta[Int(id.rawValue)].slot {
    case .bar(let i): (x0, x1, y0, y1) = (vx(list.bars[i].d0), vx(list.bars[i].d1), Double(list.bars[i].y0), Double(list.bars[i].y1))
    case .band(let i): (x0, x1, y0, y1) = (vx(list.bands[i].d0), vx(list.bands[i].d1), Double(list.bands[i].y0), Double(list.bands[i].y1))
    case .wash(let i): (x0, x1, y0, y1) = (vx(list.washes[i].d0), vx(list.washes[i].d1), Double(list.washes[i].y0), Double(list.washes[i].y1))
    case .tick(let i):
      let t = list.ticks[i], c = vx(t.d)
      (x0, x1, y0, y1) = (c - Double(t.width) / 2, c + Double(t.width) / 2, Double(t.y0), Double(t.y1))
    case .diamond(let i):
      let d = list.diamonds[i], c = vx(d.d), r = Double(d.size)
      (x0, x1, y0, y1) = (c - r, c + r, Double(d.y) - r, Double(d.y) + r)
    case .glyph(let i):
      let g = list.glyphs[i], c = vx(g.d)
      (x0, x1, y0, y1) = (c - 6, c + 6, Double(g.y) - 6, Double(g.y) + 6)
      glyph = true
    case .label: return nil
    }
    let pad = glyph ? 7.0 : 2.0
    let w = (glyph ? 12 : max(2, x1 - x0)) + 2 * pad - 2, hh = (glyph ? 12 : max(2, y1 - y0)) + 2 * pad - 2
    return CGRect(x: x0 - pad + 1, y: y0 + oy - pad + 1, width: w, height: hh)
  }
}

/// The SwiftUI fallback renderer (`-renderer canvas`): the same build and frame through `ScrollPainter`.
public struct DisplayListCanvas: View {
  let build: DisplayBuild?
  let frame: ScrollFrame

  public init(build: DisplayBuild?, frame: ScrollFrame) {
    self.build = build
    self.frame = frame
  }

  public var body: some View {
    Canvas(rendersAsynchronously: false) { context, size in
      var f = frame
      f.viewSize = size
      context.withCGContext { cg in ScrollPainter.paint(build: build, frame: f, in: cg) }
    }
  }
}
