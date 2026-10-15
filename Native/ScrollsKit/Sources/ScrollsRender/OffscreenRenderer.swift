// OWNER: N7
// Renders a display build and a frame with Metal into an offscreen texture and reads the pixels back (macOS and iOS):
// G8's Metal side (ScrollsRenderTests, TOOLCHAINS=metal), the device self-test's renderer check, and the Metal half of
// a snapshot when the Canvas painter is not wanted. `CanvasRaster` is the Core Graphics twin: the same frame through
// `ScrollPainter` into a bitmap of the same size, so the two can be compared pixel for pixel.

import CoreGraphics
import Foundation
import ImageIO
import Metal
import ScrollsScrollModel
import UniformTypeIdentifiers

/// An RGBA8 raster (premultiplied, sRGB-encoded bytes, top row first).
nonisolated public struct Raster: Sendable {
  public var width: Int
  public var height: Int
  /// 4 bytes per pixel: R, G, B, A.
  public var bytes: [UInt8]

  public init(width: Int, height: Int, bytes: [UInt8]) {
    self.width = width
    self.height = height
    self.bytes = bytes
  }

  /// The raster as a CGImage.
  public var image: CGImage? {
    let data = Data(bytes) as CFData
    guard let provider = CGDataProvider(data: data) else { return nil }
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }

  /// PNG bytes of the raster.
  public var png: Data? { image.flatMap(Raster.png) }

  /// PNG bytes of an image.
  public static func png(_ image: CGImage) -> Data? {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest) ? out as Data : nil
  }
}

/// Metal into a texture, read back.
public final class OffscreenRenderer {
  public let renderer: ScrollRenderer

  public init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
    guard let r = ScrollRenderer(device: device) else { return nil }
    renderer = r
  }

  /// Installs `build` and renders `frame` at its size × scale; waits for the GPU.
  public func render(_ build: DisplayBuild?, frame: ScrollFrame) -> Raster? {
    let pw = Int((Double(frame.viewSize.width) * frame.scale).rounded()), ph = Int((Double(frame.viewSize.height) * frame.scale).rounded())
    guard pw > 0, ph > 0 else { return nil }
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: ScrollRenderer.pixelFormat, width: pw, height: ph, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = .shared
    guard let tex = renderer.device.makeTexture(descriptor: d) else { return nil }
    renderer.install(build)
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = tex
    guard let cb = renderer.render(frame: frame, pass: pass) else { return nil }
    cb.waitUntilCompleted()
    var bgra = [UInt8](repeating: 0, count: pw * ph * 4)
    tex.getBytes(&bgra, bytesPerRow: pw * 4, from: MTLRegionMake2D(0, 0, pw, ph), mipmapLevel: 0)
    // BGRA → RGBA
    var i = 0
    while i < bgra.count {
      bgra.swapAt(i, i + 2)
      i += 4
    }
    return Raster(width: pw, height: ph, bytes: bgra)
  }
}

/// The Core Graphics twin of `OffscreenRenderer`: `ScrollPainter` into a bitmap.
nonisolated public enum CanvasRaster {
  public static func render(_ build: DisplayBuild?, frame: ScrollFrame) -> Raster? {
    let pw = Int((Double(frame.viewSize.width) * frame.scale).rounded()), ph = Int((Double(frame.viewSize.height) * frame.scale).rounded())
    guard pw > 0, ph > 0 else { return nil }
    var bytes = [UInt8](repeating: 0, count: pw * ph * 4)
    let ok = bytes.withUnsafeMutableBytes { raw -> Bool in
      guard let ctx = CGContext(data: raw.baseAddress, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      // view points, y down
      ctx.translateBy(x: 0, y: CGFloat(ph))
      ctx.scaleBy(x: CGFloat(frame.scale), y: -CGFloat(frame.scale))
      ScrollPainter.paint(build: build, frame: frame, in: ctx)
      return true
    }
    return ok ? Raster(width: pw, height: ph, bytes: bytes) : nil
  }
}
