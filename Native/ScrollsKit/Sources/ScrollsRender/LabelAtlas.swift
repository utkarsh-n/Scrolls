// OWNER: N7
// The label atlas (IOS-SPEC §4.20, §4.23): shaped label runs — whole CTLines rendered with the font cascade, never single
// glyphs, so Devanagari and Gujarati conjuncts are shaped — rasterised at 3× into one R8 2048² texture (4 MB) with a
// shelf packer. When the shelves are full the atlas starts over (the Scroll draws ≤ 150 labels a frame, so one install
// always fits). `ScrollText` is the one place that turns a run into a font and a line: the Metal atlas and the Canvas
// painter (DisplayListCanvas) shape every label identically.

import CoreGraphics
import CoreText
import Foundation
import Metal
import ScrollsScrollModel

/// Fonts and lines of the Scroll's text roles (`paint.mjs` text spec), shared by the atlas and the Canvas painter.
nonisolated public enum ScrollText {
  /// The cascade after the system font (IOS-SPEC §4.20): Devanagari and Gujarati shape with the Kohinoor faces.
  static let cascadeNames = ["KohinoorDevanagari-Regular", "KohinoorGujarati-Regular"]
  /// The cascade descriptors (made per font: CTFontDescriptor is immutable but not Sendable, so no global holds one).
  static var cascade: [CTFontDescriptor] { cascadeNames.map { CTFontDescriptorCreateWithNameAndSize($0 as CFString, 0) } }

  /// The font of a role at a size (nil = the role's own size).
  public static func font(role: ScrollStyle, size: Double? = nil) -> CTFont {
    let spec = role.textSpec
    let pt = CGFloat(size ?? spec.size)
    let base = CTFontCreateUIFontForLanguage(.system, pt, nil) ?? CTFontCreateWithName("Helvetica" as CFString, pt, nil)
    var attrs: [CFString: Any] = [kCTFontCascadeListAttribute: cascade]
    if spec.semibold { attrs[kCTFontTraitsAttribute] = [kCTFontWeightTrait: 0.3] }
    var desc = CTFontDescriptorCreateCopyWithAttributes(CTFontCopyFontDescriptor(base), attrs as CFDictionary)
    if spec.mono {
      // monospaced digits (kNumberSpacingType · kMonospacedNumbersSelector)
      desc = CTFontDescriptorCreateCopyWithFeature(desc, 6 as CFNumber, 0 as CFNumber)
    }
    return CTFontCreateWithFontDescriptor(desc, pt, nil)
  }

  /// The shaped line of a run. Its colour comes from the drawing context (the atlas rasterises coverage in white; the
  /// Canvas painter strokes the halo in the ground colour), never CoreText's default black.
  public static func line(_ text: String, role: ScrollStyle, size: Double? = nil) -> CTLine {
    let attr = NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font(role: role, size: size),
      NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
    ])
    return CTLineCreateWithAttributedString(attr)
  }

  /// Advance width, ascent and descent of a line in points.
  public static func metrics(_ line: CTLine) -> (width: Double, ascent: Double, descent: Double) {
    var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
    let w = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    return (Double(w), Double(ascent), Double(descent))
  }

  /// Where a label's quad sits relative to its anchor (points): leading, centred or trailing on the anchor, baseline at the
  /// anchor's y; caps (glyphs) centred on it both ways ("middle" baseline, 0.5 pt lower, as paint.mjs draws them).
  public static func placement(role: ScrollStyle, align: UInt8, width: Double, ascent: Double, descent: Double, pad: Double,
                               glyph: Bool) -> (ox: Double, oy: Double) {
    if glyph {
      return (-width / 2 - pad, 0.5 + (ascent - descent) / 2 - ascent - pad)
    }
    let ox: Double = switch align {
    case 1: -width / 2 - pad
    case 2: -width - pad
    default: -pad
    }
    return (ox, -ascent - pad)
  }
}

/// Shaped runs rasterised at 3× into one R8 texture.
public final class LabelAtlas {
  /// Atlas pixels per point.
  public static let pixelsPerPoint: Double = 3
  /// Room around each run (points): the 1.5 pt halo of caps samples into it.
  public static let pad: Double = 2
  public let size: Int
  public let texture: MTLTexture?

  /// A run's place in the atlas and its metrics in points.
  public struct Entry: Sendable, Equatable {
    public var u0: Float, v0: Float, u1: Float, v1: Float
    /// Advance width, ascent and descent of the line, in points.
    public var width: Double, ascent: Double, descent: Double
    /// The quad's size in points (the line plus `pad` on every side).
    public var quadW: Double, quadH: Double
  }

  struct Key: Hashable {
    var text: String
    var role: UInt16
    var size: Double
  }

  private var entries: [Key: Entry] = [:]
  private var x = 0, y = 0, rowH = 0
  /// How many times the atlas started over (renderer statistics).
  public private(set) var resets = 0

  public init(device: MTLDevice?, size: Int = 2048) {
    self.size = size
    if let device {
      let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: size, height: size, mipmapped: false)
      d.usage = [.shaderRead]
      d.storageMode = .shared
      texture = device.makeTexture(descriptor: d)
      texture?.label = "Scrolls label atlas"
    } else {
      texture = nil
    }
  }

  /// Bytes the atlas texture holds.
  public var bytes: Int { size * size }

  /// Starts over (every entry is dropped).
  public func reset() {
    entries.removeAll(keepingCapacity: true)
    x = 0
    y = 0
    rowH = 0
    resets += 1
  }

  /// The entry of a run, rasterising it when it is new; nil when the atlas is full (the caller resets and retries).
  public func entry(text: String, role: ScrollStyle, size pointSize: Double? = nil) -> Entry? {
    let key = Key(text: text, role: role.rawValue, size: pointSize ?? role.textSpec.size)
    if let e = entries[key] { return e }
    let line = ScrollText.line(text, role: role, size: pointSize)
    let m = ScrollText.metrics(line)
    let s = Self.pixelsPerPoint, pad = Self.pad
    let pw = Int(((m.width + 2 * pad) * s).rounded(.up)), ph = Int(((m.ascent + m.descent + 2 * pad) * s).rounded(.up))
    guard pw > 0, ph > 0, pw <= size, ph <= size else { return nil }
    if x + pw > size {
      x = 0
      y += rowH + 1
      rowH = 0
    }
    guard y + ph <= size else { return nil }
    let ox = x, oy = y
    x += pw + 1
    rowH = max(rowH, ph)
    if let texture {
      var pixels = [UInt8](repeating: 0, count: pw * ph)
      pixels.withUnsafeMutableBytes { raw in
        guard let ctx = CGContext(data: raw.baseAddress, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return }
        ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSmoothFonts(false)
        ctx.setAllowsAntialiasing(true)
        ctx.scaleBy(x: CGFloat(s), y: CGFloat(s))
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.textMatrix = .identity
        // the baseline sits exactly `pad + ascent` points below the quad's top (the bitmap is filled from the bottom)
        ctx.textPosition = CGPoint(x: pad, y: Double(ph) / s - pad - m.ascent)
        CTLineDraw(line, ctx)
      }
      texture.replace(region: MTLRegionMake2D(ox, oy, pw, ph), mipmapLevel: 0, withBytes: pixels, bytesPerRow: pw)
    }
    let e = Entry(u0: Float(ox) / Float(size), v0: Float(oy) / Float(size), u1: Float(ox + pw) / Float(size), v1: Float(oy + ph) / Float(size),
                  width: m.width, ascent: m.ascent, descent: m.descent, quadW: Double(pw) / s, quadH: Double(ph) / s)
    entries[key] = e
    return e
  }
}
