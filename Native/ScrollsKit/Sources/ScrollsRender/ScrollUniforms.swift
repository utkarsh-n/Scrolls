// OWNER: N7
// The per-frame state of the Scroll and its GPU mirrors (IOS-SPEC §4.23): `ScrollFrame` is everything a frame needs
// besides the installed display lists — the time scale (centre day, days per point), the view and its strip, the lane
// scroll, the vantage and its fade, the dim of a stand-in tier, the selection, the playhead and the brush. Pan, pinch
// within a tier, scrub, Play and selection change only this. `SInstance`, `GInstance` and `SUniforms` mirror
// Shaders/ScrollShaderTypes.h field for field (4-byte scalars only; strides checked by ScrollsRenderTests).

import CoreGraphics
import ScrollsCore
import ScrollsScrollModel

/// One shape instance (= SInstance, 40 bytes).
nonisolated public struct SInstance: Sendable, Equatable {
  public var d0: Float, d1: Float, y0: Float, y1: Float, p0: Float, p1: Float
  public var styleFlags: UInt32
  public var patternKind: UInt32
  public var reveal: Int32
  public var id: UInt32

  public init(d0: Float, d1: Float, y0: Float, y1: Float, p0: Float = 0, p1: Float = 0, style: UInt16, flags: UInt16,
              pattern: UInt16 = 0, kind: ShapeKind, reveal: Int32, id: UInt32) {
    self.d0 = d0
    self.d1 = d1
    self.y0 = y0
    self.y1 = y1
    self.p0 = p0
    self.p1 = p1
    styleFlags = UInt32(style) | UInt32(flags) << 16
    patternKind = UInt32(pattern) | kind.rawValue << 16
    self.reveal = reveal
    self.id = id
  }

  public var style: UInt16 { UInt16(truncatingIfNeeded: styleFlags) }
  public var flags: UInt16 { UInt16(truncatingIfNeeded: styleFlags >> 16) }
  public var pattern: UInt16 { UInt16(truncatingIfNeeded: patternKind) }
  public var kind: ShapeKind { ShapeKind(rawValue: patternKind >> 16) ?? .span }
}

/// One glyph or label quad (= GInstance, 48 bytes).
nonisolated public struct GInstance: Sendable, Equatable {
  public var d: Float, y: Float, w: Float, h: Float, ox: Float, oy: Float
  public var u0: Float, v0: Float, u1: Float, v1: Float
  public var styleFlags: UInt32
  public var reveal: Int32

  public init(d: Float, y: Float, w: Float, h: Float, ox: Float, oy: Float, u0: Float, v0: Float, u1: Float, v1: Float,
              style: UInt16, flags: UInt16, reveal: Int32) {
    self.d = d
    self.y = y
    self.w = w
    self.h = h
    self.ox = ox
    self.oy = oy
    self.u0 = u0
    self.v0 = v0
    self.u1 = u1
    self.v1 = v1
    styleFlags = UInt32(style) | UInt32(flags) << 16
    self.reveal = reveal
  }

  public var style: UInt16 { UInt16(truncatingIfNeeded: styleFlags) }
  public var flags: UInt16 { UInt16(truncatingIfNeeded: styleFlags >> 16) }
}

/// Per-list, per-frame uniforms (= SUniforms, 72 bytes).
nonisolated public struct SUniforms: Sendable, Equatable {
  public var viewW: Float = 0, viewH: Float = 0
  public var centreRel: Float = 0
  public var ppd: Float = 1
  public var originY: Float = 0
  public var scale: Float = 1
  public var vantageDay: Int32 = 0
  public var vantageMode: UInt32 = 0
  public var fadeFrom: Int32 = .max
  public var fade: Float = 1
  public var dim: Float = 1
  public var ghost: Float = Visibility.ghostOpacity
  public var options: UInt32 = 0
  public var captionLo: Float = 1, captionHi: Float = 0
  public var patternX: Float = 0
  public var atlasW: Float = 2048, atlasH: Float = 2048

  public init() {}
}

/// How the vertex shader places a shape (= SKind).
nonisolated public enum ShapeKind: UInt32, Sendable {
  /// x from d0…d1 days, y from y0…y1 content points.
  case span = 0
  /// x centred on d0 with half-width p0 points (constant under zoom).
  case centre = 1
  /// a diamond centred on (d0, y0) with half-diagonal p0 points.
  case diamond = 2
  /// view points (the overlay).
  case view = 3
}

/// The overlay's style ids (= O_* in Scroll.metal), above every `ScrollStyle`.
nonisolated public enum OverlayStyle: UInt16, Sendable {
  case playhead = 200, selection, brush, focus, playheadGlow, veil
}

/// Everything a frame needs besides the installed lists. Pan, pinch within a tier, scrub, Play and selection change
/// only this (≤ 0.1 ms of CPU per frame).
nonisolated public struct ScrollFrame: Sendable, Equatable {
  /// The day under the view's centre (fractional while panning).
  public var centerDay: Double
  public var daysPerPoint: Double
  /// The drawable's size in points (the whole Scroll: ruler strip + lanes).
  public var viewSize: CGSize
  /// Pixels per point.
  public var scale: Double
  /// Height of the top strip (ruler + coverage track) above the lanes.
  public var stripHeight: Double
  /// Lane-stack points scrolled off the top.
  public var scrollY: Double
  /// Points at the bottom covered by the inspector (the lanes stop above it).
  public var occludedBottom: Double
  /// The reading clock; nil = no vantage (everything shown).
  public var vantage: Vantage?
  /// Primitives revealed after this day (and up to the vantage) are drawn at `fade` (Play's 150 ms fade-in).
  public var fadeFrom: Int32?
  public var fade: Float
  /// 0.4 while an older tier stands in for one still loading, else 1.
  public var dim: Float
  public var highContrast: Bool
  public var differentiateWithoutColour: Bool
  /// The selected primitives of the lanes list.
  public var selection: [PrimID]
  /// A brushed or saved range in days.
  public var brush: ClosedRange<Double>?
  /// A focus ring in view points (keyboard or VoiceOver focus).
  public var focus: CGRect?
  /// The veil over later time after the playhead (the reference's 0.22 strict / 0.12 context); false hides it.
  public var veil: Bool

  public init(centerDay: Double, daysPerPoint: Double, viewSize: CGSize, scale: Double, stripHeight: Double, scrollY: Double = 0,
              occludedBottom: Double = 0, vantage: Vantage? = nil, fadeFrom: Int32? = nil, fade: Float = 1, dim: Float = 1,
              highContrast: Bool = false, differentiateWithoutColour: Bool = false, selection: [PrimID] = [],
              brush: ClosedRange<Double>? = nil, focus: CGRect? = nil, veil: Bool = true) {
    self.centerDay = centerDay
    self.daysPerPoint = daysPerPoint
    self.viewSize = viewSize
    self.scale = scale
    self.stripHeight = stripHeight
    self.scrollY = scrollY
    self.occludedBottom = occludedBottom
    self.vantage = vantage
    self.fadeFrom = fadeFrom
    self.fade = fade
    self.dim = dim
    self.highContrast = highContrast
    self.differentiateWithoutColour = differentiateWithoutColour
    self.selection = selection
    self.brush = brush
    self.focus = focus
    self.veil = veil
  }

  /// The view x of a day.
  public func x(day: Double) -> Double { (day - centerDay) / daysPerPoint + Double(viewSize.width) / 2 }
  /// The day at a view x.
  public func day(x: Double) -> Double { centerDay + (x - Double(viewSize.width) / 2) * daysPerPoint }
  /// The bottom of the lanes area in view points.
  public var lanesBottom: Double { max(stripHeight, Double(viewSize.height) - occludedBottom) }

  /// The uniforms of one list drawn at view y `originY` (0 for the top strip; `stripHeight − scrollY` for the lanes).
  public func uniforms(list: DisplayList, originY: Double) -> SUniforms {
    var u = SUniforms()
    u.viewW = Float(viewSize.width)
    u.viewH = Float(viewSize.height)
    u.centreRel = Float(centerDay - Double(list.originDay))
    u.ppd = Float(1 / daysPerPoint)
    u.originY = Float(originY)
    u.scale = Float(scale)
    if let v = vantage {
      u.vantageDay = v.day
      u.vantageMode = v.mode == .strict ? 1 : 2
      u.fadeFrom = fadeFrom ?? .max
      u.fade = fadeFrom == nil ? 1 : fade
    }
    u.dim = dim
    u.options = (highContrast ? 1 : 0) | (differentiateWithoutColour ? 2 : 0)
    u.patternX = Float(-(centerDay - Double(list.originDay)) / daysPerPoint + Double(viewSize.width) / 2)
    return u
  }
}
