// OWNER: N7
// The Metal renderer of the data plane (IOS-SPEC §4.23). `install(_:)` turns a display build into instance buffers once
// (shapes sorted by the reference's paint layers, then emission order; labels through the LabelAtlas) and swaps them in
// for the next frame; `encode` draws a frame from uniforms only: per list one draw of the bg shapes, one of the data
// shapes and one of the labels (x-only zoom in the vertex shader, the vantage predicate from `revealDay` and the
// uniforms), then the overlay (veil, playhead, brush, selection, focus): seven instanced draws. Nothing here runs per
// frame on the CPU beyond ≤ 12 overlay quads and two uniform blocks, so pan, pinch, scrub and Play cost ≈ nothing on the
// main thread. The view is drawn on demand by its host (zero frames at rest).

import CoreGraphics
import Foundation
import Metal
import QuartzCore
import ScrollsCore
import ScrollsScrollModel
import Synchronization

/// GPU and instance statistics for PerfHUD and the self-tests.
nonisolated public struct RenderStats: Sendable, Equatable {
  public var shapes = 0
  public var labels = 0
  public var installs = 0
  public var frames = 0
  /// GPU time of the last frames (ms), newest last.
  public var gpuMilliseconds: [Double] = []
  /// Main-thread encode time of the last frames (ms), newest last.
  public var encodeMilliseconds: [Double] = []
  /// Bytes of instance buffers plus the label atlas.
  public var bytes = 0

  public init() {}
}

/// GPU times of completed frames, written from Metal's completion thread.
nonisolated final class GPUTimes: Sendable {
  private let times = Mutex<[Double]>([])

  func add(_ ms: Double) {
    times.withLock { t in
      t.append(ms)
      if t.count > 240 { t.removeFirst(t.count - 240) }
    }
  }

  var values: [Double] { times.withLock { $0 } }
}

/// The Metal Scroll.
public final class ScrollRenderer {
  public let device: MTLDevice
  public let queue: MTLCommandQueue
  public let atlas: LabelAtlas
  let shapePipeline: MTLRenderPipelineState
  let glyphPipeline: MTLRenderPipelineState
  public static let pixelFormat: MTLPixelFormat = .bgra8Unorm

  /// One list on the GPU.
  struct ListGPU {
    var list: DisplayList
    var shapes: MTLBuffer?
    var bgCount = 0
    var dataCount = 0
    var glyphs: MTLBuffer?
    var glyphCount = 0
  }

  private(set) var build: DisplayBuild?
  private var top: ListGPU?
  private var lanes: ListGPU?
  private let gpuTimes = GPUTimes()
  public private(set) var stats = RenderStats()

  /// nil when this machine has no Metal device or the shaders cannot load (the app falls back to the Canvas renderer).
  public init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
    guard let device, let queue = device.makeCommandQueue(),
      let library = try? device.makeDefaultLibrary(bundle: .module)
    else { return nil }
    self.device = device
    self.queue = queue
    atlas = LabelAtlas(device: device)
    func pipeline(_ v: String, _ f: String) -> MTLRenderPipelineState? {
      let d = MTLRenderPipelineDescriptor()
      d.vertexFunction = library.makeFunction(name: v)
      d.fragmentFunction = library.makeFunction(name: f)
      let c = d.colorAttachments[0]!
      c.pixelFormat = Self.pixelFormat
      c.isBlendingEnabled = true
      c.rgbBlendOperation = .add
      c.alphaBlendOperation = .add
      c.sourceRGBBlendFactor = .one
      c.sourceAlphaBlendFactor = .one
      c.destinationRGBBlendFactor = .oneMinusSourceAlpha
      c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
      return try? device.makeRenderPipelineState(descriptor: d)
    }
    guard let s = pipeline("shapeVertex", "shapeFragment"), let g = pipeline("glyphVertex", "glyphFragment") else { return nil }
    shapePipeline = s
    glyphPipeline = g
  }

  // MARK: install

  /// Swaps in a new build (nil clears the Scroll). Called on a data, filter, tier or layout change, never on pan.
  public func install(_ build: DisplayBuild?) {
    self.build = build
    guard let build else {
      top = nil
      lanes = nil
      return
    }
    var t = makeList(build.top, meta: build.topMeta)
    var l = makeList(build.lanes, meta: build.laneMeta)
    if t == nil || l == nil {
      // the atlas filled up: start over with only this build's labels
      atlas.reset()
      t = makeList(build.top, meta: build.topMeta)
      l = makeList(build.lanes, meta: build.laneMeta)
    }
    top = t
    lanes = l
    stats.installs += 1
    stats.shapes = (top.map { $0.bgCount + $0.dataCount } ?? 0) + (lanes.map { $0.bgCount + $0.dataCount } ?? 0)
    stats.labels = (top?.glyphCount ?? 0) + (lanes?.glyphCount ?? 0)
    stats.bytes = (top?.shapes?.length ?? 0) + (lanes?.shapes?.length ?? 0) + (top?.glyphs?.length ?? 0) + (lanes?.glyphs?.length ?? 0)
      + atlas.bytes
  }

  /// The shape instances of a list in paint order (bg layer, then data; emission order within each) and its labels.
  /// nil when the atlas is full.
  private func makeList(_ list: DisplayList, meta: [PrimMeta]) -> ListGPU? {
    let (bg, data) = Self.shapeInstances(list, meta: meta)
    guard let glyphs = glyphInstances(list, meta: meta) else { return nil }
    var g = ListGPU(list: list)
    let all = bg + data
    if !all.isEmpty {
      g.shapes = all.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }
    }
    g.bgCount = bg.count
    g.dataCount = data.count
    if !glyphs.isEmpty {
      g.glyphs = glyphs.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }
    }
    g.glyphCount = glyphs.count
    return g
  }

  /// Converts a list's typed instances into GPU shapes, split by layer. Pure (tests and the Canvas painter use it).
  nonisolated public static func shapeInstances(_ list: DisplayList, meta: [PrimMeta]) -> (bg: [SInstance], data: [SInstance]) {
    var bg: [SInstance] = [], data: [SInstance] = []
    bg.reserveCapacity(list.bands.count + list.bars.count / 4)
    data.reserveCapacity(list.bars.count + list.ticks.count + list.washes.count + list.diamonds.count)
    func put(_ s: SInstance, _ id: PrimID) {
      if meta[Int(id.rawValue)].layer == .bg { bg.append(s) } else { data.append(s) }
    }
    for p in list.bands where p.style != ScrollStyle.none.rawValue {
      put(SInstance(d0: p.d0, d1: p.d1, y0: p.y0, y1: p.y1, style: p.style, flags: p.flags, pattern: p.pattern, kind: .span,
                    reveal: p.revealDay, id: p.id.rawValue), p.id)
    }
    for p in list.washes {
      put(SInstance(d0: p.d0, d1: p.d1, y0: p.y0, y1: p.y1, p0: p.featherLo, p1: p.featherHi, style: p.style, flags: p.flags,
                    kind: .span, reveal: p.revealDay, id: p.id.rawValue), p.id)
    }
    for p in list.bars {
      let pattern: UInt16 = p.style == ScrollStyle.bar.rawValue || p.style == ScrollStyle.barSparse.rawValue ? barPattern(flags: p.flags).rawValue : 0
      put(SInstance(d0: p.d0, d1: p.d1, y0: p.y0, y1: p.y1, style: p.style, flags: p.flags, pattern: pattern, kind: .span,
                    reveal: p.revealDay, id: p.id.rawValue), p.id)
    }
    for p in list.ticks {
      let style = ScrollStyle(rawValue: p.style) ?? .none
      let half: Float = switch style {
      case .rulerMajor, .rulerMinor, .seamTick: 1
      case .markEst: 1.5
      default: max(p.width / 2, 0.5)
      }
      put(SInstance(d0: p.d, d1: p.d, y0: p.y0, y1: p.y1, p0: half, style: p.style, flags: p.flags, kind: .centre,
                    reveal: p.revealDay, id: p.id.rawValue), p.id)
    }
    for p in list.diamonds {
      put(SInstance(d0: p.d, d1: p.d, y0: p.y, y1: p.y, p0: p.size, style: p.style, flags: p.flags, kind: .diamond,
                    reveal: p.revealDay, id: p.id.rawValue), p.id)
    }
    // paint order within each layer = emission order
    bg.sort { $0.id < $1.id }
    data.sort { $0.id < $1.id }
    return (bg, data)
  }

  /// The label quads of a list (glyph caps and texts); nil when the atlas is full.
  private func glyphInstances(_ list: DisplayList, meta: [PrimMeta]) -> [GInstance]? {
    var out: [GInstance] = []
    out.reserveCapacity(list.glyphs.count + list.labels.count)
    for g in list.glyphs {
      guard let run = list.labelRuns[g.glyph], let style = ScrollStyle(rawValue: g.style) else { continue }
      guard let e = atlas.entry(text: run.text, role: style, size: Double(g.size)) else { return nil }
      let pl = ScrollText.placement(role: style, align: 1, width: e.width, ascent: e.ascent, descent: e.descent, pad: LabelAtlas.pad, glyph: true)
      out.append(GInstance(d: g.d, y: g.y, w: Float(e.quadW), h: Float(e.quadH), ox: Float(pl.ox), oy: Float(pl.oy),
                           u0: e.u0, v0: e.v0, u1: e.u1, v1: e.v1, style: g.style, flags: g.flags, reveal: g.revealDay))
    }
    for l in list.labels {
      guard let run = list.labelRuns[l.key], let style = ScrollStyle(rawValue: l.style) else { continue }
      guard let e = atlas.entry(text: run.text, role: style) else { return nil }
      let pl = ScrollText.placement(role: style, align: l.align, width: e.width, ascent: e.ascent, descent: e.descent, pad: LabelAtlas.pad, glyph: false)
      out.append(GInstance(d: l.d, y: l.y, w: Float(e.quadW), h: Float(e.quadH), ox: Float(pl.ox), oy: Float(pl.oy),
                           u0: e.u0, v0: e.v0, u1: e.u1, v1: e.v1, style: l.style, flags: l.flags, reveal: l.revealDay))
    }
    return out
  }

  // MARK: frames

  /// Encodes one frame into `pass` (cleared to bg-0) on a new command buffer, presents `drawable` if given, and returns
  /// the buffer (committed).
  @discardableResult
  public func render(frame: ScrollFrame, pass: MTLRenderPassDescriptor, drawable: MTLDrawable? = nil) -> MTLCommandBuffer? {
    let t0 = CACurrentMediaTime()
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0x0E / 255.0, green: 0x10 / 255.0, blue: 0x13 / 255.0, alpha: 1)
    pass.colorAttachments[0].storeAction = .store
    guard let cb = queue.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return nil }
    cb.label = "Scroll frame"
    encode(enc, frame: frame)
    enc.endEncoding()
    if let drawable { cb.present(drawable) }
    let times = gpuTimes
    cb.addCompletedHandler { b in times.add((b.gpuEndTime - b.gpuStartTime) * 1000) }
    cb.commit()
    stats.frames += 1
    stats.encodeMilliseconds.append((CACurrentMediaTime() - t0) * 1000)
    if stats.encodeMilliseconds.count > 240 { stats.encodeMilliseconds.removeFirst() }
    stats.gpuMilliseconds = gpuTimes.values
    return cb
  }

  /// The seven draws of a frame.
  public func encode(_ enc: MTLRenderCommandEncoder, frame: ScrollFrame) {
    let w = Double(frame.viewSize.width), h = Double(frame.viewSize.height), s = frame.scale
    guard w > 0, h > 0 else { return }
    let lanesBottom = frame.lanesBottom
    func scissor(_ y0: Double, _ y1: Double) {
      let py0 = max(0, Int((y0 * s).rounded())), py1 = min(Int((h * s).rounded()), Int((y1 * s).rounded()))
      enc.setScissorRect(MTLScissorRect(x: 0, y: py0, width: max(1, Int((w * s).rounded())), height: max(0, py1 - py0)))
    }
    let caption = seamCaption(frame)
    if let lanes {
      scissor(frame.stripHeight, lanesBottom)
      draw(lanes, enc: enc, uniforms: uniforms(frame, lanes.list, originY: frame.stripHeight - frame.scrollY, caption: nil))
    }
    if let top {
      scissor(0, frame.stripHeight)
      draw(top, enc: enc, uniforms: uniforms(frame, top.list, originY: 0, caption: caption))
    }
    scissor(0, lanesBottom)
    let overlay = Self.overlay(frame: frame, build: build)
    if !overlay.isEmpty {
      var u = frame.uniforms(list: top?.list ?? DisplayList.empty(originDay: 0, pointsPerDay: 1), originY: 0)
      u.vantageMode = 0
      enc.setRenderPipelineState(shapePipeline)
      overlay.withUnsafeBytes { enc.setVertexBytes($0.baseAddress!, length: $0.count, index: 0) }
      enc.setVertexBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      enc.setFragmentBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: overlay.count)
    }
  }

  private func uniforms(_ frame: ScrollFrame, _ list: DisplayList, originY: Double, caption: (Double, Double)?) -> SUniforms {
    var u = frame.uniforms(list: list, originY: originY)
    if let caption {
      u.captionLo = Float(caption.0)
      u.captionHi = Float(caption.1)
    }
    u.atlasW = Float(atlas.size)
    u.atlasH = Float(atlas.size)
    return u
  }

  private func draw(_ g: ListGPU, enc: MTLRenderCommandEncoder, uniforms: SUniforms) {
    var u = uniforms
    if let shapes = g.shapes, g.bgCount + g.dataCount > 0 {
      enc.setRenderPipelineState(shapePipeline)
      enc.setVertexBuffer(shapes, offset: 0, index: 0)
      enc.setVertexBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      enc.setFragmentBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      if g.bgCount > 0 { enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: g.bgCount) }
      if g.dataCount > 0 {
        enc.setVertexBufferOffset(g.bgCount * MemoryLayout<SInstance>.stride, index: 0)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: g.dataCount)
      }
    }
    if let glyphs = g.glyphs, g.glyphCount > 0, let tex = atlas.texture {
      enc.setRenderPipelineState(glyphPipeline)
      enc.setVertexBuffer(glyphs, offset: 0, index: 0)
      enc.setVertexBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      enc.setFragmentBytes(&u, length: MemoryLayout<SUniforms>.stride, index: 1)
      enc.setFragmentTexture(tex, index: 0)
      enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: g.glyphCount)
    }
  }

  /// The seam caption's box in view x this frame (ruler labels under it give way), if a caption is drawn.
  func seamCaption(_ frame: ScrollFrame) -> (Double, Double)? {
    guard let build, let top else { return nil }
    for m in build.topMeta where m.style == .seamLabel {
      guard case .label(let li) = m.slot, li < top.list.labels.count else { continue }
      let l = top.list.labels[li]
      guard let run = top.list.labelRuns[l.key] else { continue }
      let wpt = DisplayBuilder.seamLabelWidth(run.text)
      let ax = frame.x(day: Double(top.list.originDay) + Double(l.d))
      let place = Seams.captionPlace(seamX: ax, width: wpt, visible: (0, Double(frame.viewSize.width)))
      return (place.x0, place.x1)
    }
    return nil
  }

  /// The median and 95th percentile of a list of times.
  nonisolated public static func percentiles(_ t: [Double]) -> (p50: Double, p95: Double) {
    guard !t.isEmpty else { return (0, 0) }
    let s = t.sorted()
    return (s[s.count / 2], s[min(s.count - 1, Int(Double(s.count) * 0.95))])
  }
}
