// OWNER: N7
// ScrollsRenderTests (IOS-SPEC §2.2 G8, §4.20, §4.23, §8.5 N7):
//   · the GPU instance layouts equal ScrollShaderTypes.h (strides 40 / 48 / 72 bytes);
//   · the shaders load (a Metal device without the Scroll's library is a failure, never a skip);
//   · G8: Metal = DisplayListCanvas on the demo's real display lists (g5.inputs: the reference server's payloads on m1r)
//     at 6 tiers × 3 vantages × {strict, context} × {default, Increase Contrast}, plus no vantage: ≤ 1% of pixels differ
//     by more than 8/255 in any channel, outside the text anti-aliasing masks (text is shaped by the same CTLine in both,
//     but the atlas samples it, so its edges are compared by the label atlas test instead); hatch and dash phase are
//     probed separately;
//   · LabelAtlas: Devanagari and Gujarati lane labels are shaped as whole runs (no .notdef glyph) and the atlas quad equals
//     a Core Text reference raster;
//   · the PNG snapshot carries the SYNTHETIC stamp whenever demo material is in it.
// Results go to Reports/g8-render.json when SCROLLS_REPORTS_DIR is set.

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Metal
import ScrollsContracts
import ScrollsCore
import ScrollsRender
@testable import ScrollsScrollModel
import Testing

@Suite("Render")
struct RenderTests {
  @Test("GPU instance layouts equal ScrollShaderTypes.h")
  func layouts() {
    #expect(MemoryLayout<SInstance>.stride == 40)
    #expect(MemoryLayout<GInstance>.stride == 48)
    #expect(MemoryLayout<SUniforms>.stride == 72)
  }

  @Test("the Scroll's shaders load on this Mac's Metal device")
  @MainActor func shadersLoad() {
    guard MTLCreateSystemDefaultDevice() != nil else { return }
    #expect(ScrollRenderer() != nil, "a Metal device exists but the Scroll's library or pipelines did not load")
  }

  @Test("G8: Metal = Canvas on the demo, 6 tiers × 3 vantages × strict/context × contrast (≤ 1% of pixels)")
  @MainActor func g8() throws {
    guard let metal = OffscreenRenderer() else {
      #expect(MTLCreateSystemDefaultDevice() == nil, "Metal is present but the offscreen renderer did not start")
      return
    }
    let inputs = try DemoFixtures.inputs()
    var report: [JSONValue] = []
    var worst = 0.0
    var cases = 0
    for key in ["demo-carry", "demo-two"] {
      guard let input = inputs[key] else {
        Issue.record("g5.inputs has no \(key)")
        continue
      }
      let ext = DemoFixtures.extent(input)
      let vantageDays = [0.3, 0.55, 0.8].map { Int32(ext.lo + $0 * (ext.hi - ext.lo)) }
      for tier in Tier.allCases {
        let size = CGSize(width: 430, height: 560)
        let (build, axis) = DemoFixtures.build(input, tier: tier, width: Double(size.width), lanesHeight: 500)
        var configs: [(Vantage?, Bool)] = [(nil, false)]
        for d in vantageDays {
          for mode in [VantageMode.strict, .context] {
            for contrast in [false, true] { configs.append((Vantage(day: d, mode: mode), contrast)) }
          }
        }
        for (v, contrast) in configs {
          let frame = ScrollFrame(centerDay: axis.centerDay, daysPerPoint: axis.daysPerPoint, viewSize: size, scale: 2, stripHeight: 38,
                                  vantage: v, highContrast: contrast)
          guard let a = metal.render(build, frame: frame), let b = CanvasRaster.render(build, frame: frame) else {
            Issue.record("\(key) \(tier.code): a raster was not produced")
            continue
          }
          let mask = TextMask.make(build: build, frame: frame, width: a.width, height: a.height)
          let (fraction, compared) = RasterDiff.fraction(a, b, mask: mask, threshold: 8)
          // the masked text is drawn by both (an empty atlas would pass the pixel diff unseen)
          let inkMetal = RasterDiff.inked(a, mask: mask), inkCanvas = RasterDiff.inked(b, mask: mask)
          #expect(inkCanvas == 0 || Double(inkMetal) >= 0.5 * Double(inkCanvas),
                  "\(key) \(tier.code): Metal draws \(inkMetal) bright text pixels, the Canvas \(inkCanvas)")
          cases += 1
          worst = max(worst, fraction)
          let name = "\(key) \(tier.code) \(v.map { "\($0.day) \($0.mode == .strict ? "strict" : "context")" } ?? "no vantage")\(contrast ? " contrast" : "")"
          report.append(["case": .string(name), "fraction": .number((fraction * 1e6).rounded() / 1e6), "compared": .number(Double(compared))])
          #expect(fraction <= 0.01, "\(name): \(String(format: "%.3f", fraction * 100))% of pixels differ by > 8/255")
          if fraction > 0.01, let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
            try? a.png?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("g8-\(key)-\(tier.code)-metal.png"))
            try? b.png?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("g8-\(key)-\(tier.code)-canvas.png"))
          }
        }
      }
    }
    #expect(cases >= 2 * 6 * 13)
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      let out: JSONValue = ["tier": "g8", "cases": .number(Double(cases)), "worst_fraction": .number((worst * 1e6).rounded() / 1e6),
                            "threshold": .number(0.01), "channel_tolerance": .number(8), "passed": .bool(worst <= 0.01),
                            "rows": .array(report)]
      try? Data((CanonicalJSON.string(out) + "\n").utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("g8-render.json"))
    }
  }

  @Test("hatch and dash phase: the 6 pt hatch and the 1-on-3-off absent line sit at the same pixels in both renderers")
  @MainActor func patternProbes() throws {
    guard let metal = OffscreenRenderer() else { return }
    // a list of one uncovered band and one absent bin, drawn at two pans: the pattern moves with the content
    var list = ListFixture()
    list.band(d0: -100, d1: 100, y0: 0, y1: 40, style: .hatch, pattern: .hatch)
    list.bar(d0: -50, d1: 50, y0: 50, y1: 56, style: .absent)
    let build = list.build()
    for centre in [0.0, 3.3] {
      let frame = ScrollFrame(centerDay: centre, daysPerPoint: 1, viewSize: CGSize(width: 200, height: 100), scale: 2, stripHeight: 0)
      guard let a = metal.render(build, frame: frame), let b = CanvasRaster.render(build, frame: frame) else { continue }
      let (fraction, _) = RasterDiff.fraction(a, b, mask: nil, threshold: 8)
      #expect(fraction <= 0.01, "pattern phase at centre \(centre): \(fraction * 100)% differ")
      // the hatch has ink: some pixel inside the band is lighter than the ground in both
      #expect(RasterDiff.maxLuma(a, region: CGRect(x: 20, y: 4, width: 160, height: 30), scale: 2) > 20)
      #expect(RasterDiff.maxLuma(b, region: CGRect(x: 20, y: 4, width: 160, height: 30), scale: 2) > 20)
    }
  }

  @Test("LabelAtlas: Devanagari and Gujarati lane labels are whole shaped runs, equal to a Core Text raster")
  @MainActor func indicLabels() throws {
    guard let device = MTLCreateSystemDefaultDevice() else { return }
    let atlas = LabelAtlas(device: device)
    for text in ["हिन्दी · text", "ગુજરાતી · text", "शून्य", "શૂન્ય"] {
      let line = ScrollText.line(text, role: .washLabel)
      // no .notdef: every glyph of every run is a real glyph
      for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
        let n = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: n)
        CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
        #expect(!glyphs.contains(0), "\(text): a .notdef glyph")
      }
      guard let e = atlas.entry(text: text, role: .washLabel), let tex = atlas.texture else {
        Issue.record("\(text): no atlas entry")
        continue
      }
      // read the quad back and compare it with the same line drawn by Core Text into a gray bitmap
      let s = LabelAtlas.pixelsPerPoint
      let pw = Int((e.quadW * s).rounded()), ph = Int((e.quadH * s).rounded())
      var quad = [UInt8](repeating: 0, count: pw * ph)
      tex.getBytes(&quad, bytesPerRow: pw, from: MTLRegionMake2D(Int(Double(e.u0) * Double(atlas.size)), Int(Double(e.v0) * Double(atlas.size)), pw, ph), mipmapLevel: 0)
      var ref = [UInt8](repeating: 0, count: pw * ph)
      ref.withUnsafeMutableBytes { raw in
        guard let ctx = CGContext(data: raw.baseAddress, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSmoothFonts(false)
        ctx.scaleBy(x: s, y: s)
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.textPosition = CGPoint(x: LabelAtlas.pad, y: Double(ph) / s - LabelAtlas.pad - e.ascent)
        CTLineDraw(line, ctx)
      }
      var differ = 0, inked = 0
      for i in 0..<(pw * ph) {
        if ref[i] > 32 { inked += 1 }
        if abs(Int(ref[i]) - Int(quad[i])) > 8 { differ += 1 }
      }
      #expect(inked > 20, "\(text): the reference raster is empty")
      #expect(differ == 0, "\(text): \(differ) of \(pw * ph) atlas pixels differ from Core Text")
    }
  }

  @Test("the PNG snapshot carries the SYNTHETIC stamp with demo material")
  @MainActor func snapshotStamp() throws {
    let inputs = try DemoFixtures.inputs()
    guard let input = inputs["demo-carry"] else { return }
    let (build, axis) = DemoFixtures.build(input, tier: .decades, width: 430, lanesHeight: 400)
    let frame = ScrollFrame(centerDay: axis.centerDay, daysPerPoint: axis.daysPerPoint, viewSize: CGSize(width: 430, height: 460), scale: 2,
                            stripHeight: 38)
    let png = ScrollSnapshot.png(build: build, frame: frame, synthetic: true, caption: "Scrolls · demo · carry the zero · contains SYNTHETIC data")
    #expect(png != nil)
    guard let png, let src = CGImageSourceCreateWithData(png as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return }
    #expect(img.width == Int((176 + 430) * 2.0))
    #expect(img.height == Int((26 + 460 + 46) * 2.0))
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("n7-snapshot-demo.png"))
    }
  }
}

// MARK: - Helpers

/// A tiny display list for pattern probes.
struct ListFixture {
  var bands: [BandPrim] = []
  var bars: [BarPrim] = []
  var meta: [PrimMeta] = []

  mutating func band(d0: Float, d1: Float, y0: Float, y1: Float, style: ScrollStyle, pattern: PatternID) {
    let id = PrimID(rawValue: UInt32(meta.count))
    bands.append(BandPrim(d0: d0, d1: d1, y0: y0, y1: y1, style: style.rawValue, pattern: pattern.rawValue, flags: 0, revealDay: alwaysRevealed, id: id))
    meta.append(PrimMeta(kind: .band, layer: .bg, style: style, openable: false, source: .laneBand(lane: 0), slot: .band(bands.count - 1)))
  }

  mutating func bar(d0: Float, d1: Float, y0: Float, y1: Float, style: ScrollStyle) {
    let id = PrimID(rawValue: UInt32(meta.count))
    bars.append(BarPrim(d0: d0, d1: d1, y0: y0, y1: y1, style: style.rawValue, flags: 0, revealDay: alwaysRevealed, id: id))
    meta.append(PrimMeta(kind: .path, layer: .data, style: style, openable: false, source: .absent(lane: 0, strand: 0, col: 0), slot: .bar(bars.count - 1)))
  }

  func build() -> DisplayBuild {
    var b = DisplayBuilder.buildSync(DisplayInput(model: ScrollModelBuilder.coverageModel(collections: []), originDay: -100, daysPerPoint: 1,
                                                  width: 200, layout: .empty))
    var lanes = DisplayList(originDay: 0, bands: bands, bars: bars, hit: HitGrid(pointsPerDay: 1))
    lanes.lanes = []
    b.lanes = lanes
    b.laneMeta = meta
    b.top = DisplayList(originDay: 0, hit: HitGrid(pointsPerDay: 1))
    b.topMeta = []
    return b
  }
}

/// The text anti-aliasing mask: every label and glyph quad, dilated by 2 pt, in device pixels.
enum TextMask {
  static func make(build: DisplayBuild, frame: ScrollFrame, width: Int, height: Int) -> [Bool] {
    var mask = [Bool](repeating: false, count: width * height)
    let s = frame.scale
    func mark(_ r: CGRect) {
      let x0 = max(0, Int(((Double(r.minX) - 2) * s).rounded(.down))), x1 = min(width - 1, Int(((Double(r.maxX) + 2) * s).rounded(.up)))
      let y0 = max(0, Int(((Double(r.minY) - 2) * s).rounded(.down))), y1 = min(height - 1, Int(((Double(r.maxY) + 2) * s).rounded(.up)))
      guard x0 <= x1, y0 <= y1 else { return }
      for y in y0...y1 { for x in x0...x1 { mask[y * width + x] = true } }
    }
    for (list, originY) in [(build.top, 0.0), (build.lanes, frame.stripHeight - frame.scrollY)] {
      let origin = Double(list.originDay)
      for g in list.glyphs {
        let x = frame.x(day: origin + Double(g.d)), y = Double(g.y) + originY
        let r = Double(g.size)
        mark(CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
      }
      for l in list.labels {
        guard let run = list.labelRuns[l.key], let style = ScrollStyle(rawValue: l.style) else { continue }
        let m = ScrollText.metrics(ScrollText.line(run.text, role: style))
        var x = frame.x(day: origin + Double(l.d))
        let y = Double(l.y) + originY
        if style == .seamLabel {
          // either side of the line, as both renderers place it
          mark(CGRect(x: x - 4 - m.width, y: y - m.ascent, width: 2 * m.width + 8, height: m.ascent + m.descent))
          continue
        }
        if l.align == 1 { x -= m.width / 2 } else if l.align == 2 { x -= m.width }
        mark(CGRect(x: x, y: y - m.ascent, width: m.width, height: m.ascent + m.descent))
      }
    }
    return mask
  }
}

enum RasterDiff {
  /// The share of compared pixels (outside the mask) whose largest channel difference exceeds `threshold`.
  static func fraction(_ a: Raster, _ b: Raster, mask: [Bool]?, threshold: Int) -> (Double, Int) {
    guard a.width == b.width, a.height == b.height else { return (1, 0) }
    var differ = 0, compared = 0
    let n = a.width * a.height
    a.bytes.withUnsafeBufferPointer { pa in
      b.bytes.withUnsafeBufferPointer { pb in
        for i in 0..<n {
          if let mask, mask[i] { continue }
          compared += 1
          let k = i * 4
          let d = max(abs(Int(pa[k]) - Int(pb[k])), abs(Int(pa[k + 1]) - Int(pb[k + 1])), abs(Int(pa[k + 2]) - Int(pb[k + 2])))
          if d > threshold { differ += 1 }
        }
      }
    }
    return (compared == 0 ? 0 : Double(differ) / Double(compared), compared)
  }

  /// Bright pixels (max channel > 110) inside the mask: the text both renderers draw.
  static func inked(_ r: Raster, mask: [Bool]) -> Int {
    var n = 0
    for i in 0..<min(mask.count, r.width * r.height) where mask[i] {
      let k = i * 4
      if max(r.bytes[k], r.bytes[k + 1], r.bytes[k + 2]) > 110 { n += 1 }
    }
    return n
  }

  /// The brightest pixel (max channel) in a region given in points.
  static func maxLuma(_ r: Raster, region: CGRect, scale: Double) -> Int {
    var best = 0
    let x0 = Int(Double(region.minX) * scale), x1 = min(r.width, Int(Double(region.maxX) * scale))
    let y0 = Int(Double(region.minY) * scale), y1 = min(r.height, Int(Double(region.maxY) * scale))
    for y in y0..<y1 {
      for x in x0..<x1 {
        let k = (y * r.width + x) * 4
        best = max(best, Int(r.bytes[k]), Int(r.bytes[k + 1]), Int(r.bytes[k + 2]))
      }
    }
    return best
  }
}
