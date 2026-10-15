// OWNER: N7
// The UIKit host of the Scroll (IOS-SPEC §4.5, §4.23): the MTKView of `ScrollRenderer` (paused; drawn on demand), the
// recognisers, momentum, the rubber band and the display link.
//
// Gestures (§4.5):
//   · one-finger pan, direction-locked after 10 pt (|dx| > 1.2·|dy| → time, else the lanes scroll); momentum at
//     `UIScrollView.DecelerationRate.normal`, stopping below 5 pt/s; a 0.55 rubber band beyond 10000 BCE – 2100 CE;
//     no momentum under Reduce Motion;
//   · pinch: x only, around the centroid's day, the centroid's travel pans at the same time; clamped to
//     [0.05 pt/yr, 40 pt/day] with a `.boundary` at the limits;
//   · tap (the topmost hit; a second tap within 180 ms is a double tap: one tier in), two-finger tap (one tier out);
//   · long press on a mark: `UIContextMenuInteraction` (preview and actions, MarkPreview.swift);
//   · long press on the ruler, then drag: the brush.
// Pan and pinch recognise simultaneously with each other only. Nothing here rebuilds a list: gestures change the
// model's axis and the next frame's uniforms. Frames: zero at rest; a `CADisplayLink` (80–120 Hz, 60 under Low Power or
// thermal `.serious`, LabKit's `FramePacing`) runs only while a gesture, momentum, Play, a fade or an axis animation is
// in progress; any other change draws exactly one frame.

import LabKitCore
import MetalKit
import QuartzCore
import ScrollsRender
import ScrollsScrollModel
import UIKit

final class ScrollGestureHost: UIView, MTKViewDelegate, UIGestureRecognizerDelegate {
  let model: ScrollModel
  private(set) var renderer: ScrollRenderer?
  private(set) var metalView: MTKView?
  private var displayLink: CADisplayLink?
  private var installedSeq = -1

  // pan
  private enum PanAxis { case undecided, time, lanes }
  private var panAxis = PanAxis.undecided
  private var lastTranslation = CGPoint.zero
  /// The centre day the finger asks for, before the rubber band.
  private var rawCenter = 0.0
  // momentum (points per second along x)
  private var velocity = 0.0
  private var momentum = false
  private var lastTick: CFTimeInterval = 0
  // pinch
  private var pinchLast: CGFloat = 1
  private var pinchCentroid = CGPoint.zero
  private var pinchHitLimit = false
  // taps
  private var pendingTap: (point: CGPoint, work: DispatchWorkItem)?
  // brush
  private var brushAnchorDay: Double?
  private var brushMoved = false
  // frames drawn (the idle-frames self-test reads it)
  private(set) var framesDrawn = 0
  private var activeGestures = 0
  /// The size the last layout pass drew for; a pass at the same size needs no new frame.
  private var lastLaidOutSize = CGSize.zero
  /// Main-thread time of the last frames (recogniser → uniforms → encode), ms.
  private(set) var encodeTimes: [Double] = []

  static let rubberBand = 0.55
  static let doubleTapInterval: TimeInterval = 0.18
  static let stopVelocity = 5.0

  init(model: ScrollModel, metal: Bool) {
    self.model = model
    super.init(frame: .zero)
    isOpaque = false
    backgroundColor = .clear
    isMultipleTouchEnabled = true
    if metal, let r = ScrollRenderer() {
      renderer = r
      let v = MTKView(frame: .zero, device: r.device)
      v.colorPixelFormat = ScrollRenderer.pixelFormat
      v.framebufferOnly = true
      v.isPaused = true
      v.enableSetNeedsDisplay = true
      v.autoResizeDrawable = true
      v.clearColor = MTLClearColor(red: 0x0E / 255.0, green: 0x10 / 255.0, blue: 0x13 / 255.0, alpha: 1)
      v.delegate = self
      v.isUserInteractionEnabled = false
      v.translatesAutoresizingMaskIntoConstraints = false
      v.accessibilityElementsHidden = true
      addSubview(v)
      NSLayoutConstraint.activate([
        v.leadingAnchor.constraint(equalTo: leadingAnchor), v.trailingAnchor.constraint(equalTo: trailingAnchor),
        v.topAnchor.constraint(equalTo: topAnchor), v.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
      metalView = v
    }
    installRecognisers()
    model.onFrameNeeded = { [weak self] in self?.requestFrame() }
    model.onAnimationNeeded = { [weak self] in self?.startDisplayLink() }
    accessibilityIdentifier = "scrollCanvas"
    isAccessibilityElement = false
    shouldGroupAccessibilityChildren = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  isolated deinit {
    displayLink?.invalidate()
  }

  // MARK: Layout and frames

  override func layoutSubviews() {
    super.layoutSubviews()
    // No writes that invalidate layout here: setting contentScaleFactor from layoutSubviews re-entered layout forever on
    // his iPhone (the scene-create watchdog killed the app at launch). The scale is set when the view joins a window.
    guard bounds.size != lastLaidOutSize else { return }
    lastLaidOutSize = bounds.size
    requestFrame()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let w = window {
      model.canvasOrigin = convert(CGPoint.zero, to: w)
      if let v = metalView, v.contentScaleFactor != w.screen.scale { v.contentScaleFactor = w.screen.scale }
    }
    requestFrame()
  }

  /// Draw exactly one frame soon (on the next display refresh), unless the display link draws anyway.
  func requestFrame() {
    if displayLink != nil { return }
    metalView?.setNeedsDisplay()
  }

  private func startDisplayLink() {
    guard displayLink == nil else { return }
    let link = CADisplayLink(target: DisplayLinkProxy(self), selector: #selector(DisplayLinkProxy.step(_:)))
    let fps = Float(FramePacing.preferredFPS(DeviceConditions.current))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: min(80, fps), maximum: fps, preferred: fps)
    link.add(to: .main, forMode: .common)
    displayLink = link
    lastTick = CACurrentMediaTime()
  }

  private func stopDisplayLink() {
    displayLink?.invalidate()
    displayLink = nil
  }

  fileprivate func step(_ link: CADisplayLink) {
    let now = CACurrentMediaTime()
    let dt = max(0, min(0.05, now - lastTick))
    lastTick = now
    if momentum { advanceMomentum(dt) }
    let moving = model.tick(now: now)
    drawNow()
    if !moving && !momentum && activeGestures == 0 && !model.isPlaying { stopDisplayLink() }
  }

  private func drawNow() {
    guard let v = metalView else { return }
    v.draw()
  }

  // MARK: MTKViewDelegate

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { requestFrame() }

  func draw(in view: MTKView) {
    guard let renderer, let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable else { return }
    let t0 = CACurrentMediaTime()
    if installedSeq != model.buildSeq {
      renderer.install(model.build)
      installedSeq = model.buildSeq
    }
    var f = model.frame
    f.viewSize = view.bounds.size
    f.scale = Double(view.contentScaleFactor)
    renderer.render(frame: f, pass: pass, drawable: drawable)
    framesDrawn += 1
    model.framesDrawn += 1
    model.renderStatsBox.value = renderer.stats
    let ms = (CACurrentMediaTime() - t0) * 1000
    encodeTimes.append(ms)
    if encodeTimes.count > 240 { encodeTimes.removeFirst(encodeTimes.count - 240) }
    model.mainFrameMilliseconds = encodeTimes
  }

  // MARK: Recognisers

  private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
  private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
  private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
  private lazy var twoFingerTap = UITapGestureRecognizer(target: self, action: #selector(onTwoFingerTap(_:)))
  private lazy var brushPress = UILongPressGestureRecognizer(target: self, action: #selector(onBrush(_:)))

  private func installRecognisers() {
    pan.maximumNumberOfTouches = 1
    pan.delegate = self
    pinch.delegate = self
    twoFingerTap.numberOfTouchesRequired = 2
    tap.require(toFail: twoFingerTap)
    brushPress.minimumPressDuration = 0.4
    brushPress.allowableMovement = 10
    brushPress.delegate = self
    for r in [pan, pinch, tap, twoFingerTap, brushPress] as [UIGestureRecognizer] { addGestureRecognizer(r) }
    addInteraction(UIContextMenuInteraction(delegate: self))
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    (g === pan && other === pinch) || (g === pinch && other === pan)
  }

  override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if g === brushPress { return g.location(in: self).y < model.rulerHeight }
    return true
  }

  private func began() {
    activeGestures += 1
    model.gesturing = true
    momentum = false
    model.axisAnimation = nil
    startDisplayLink()
  }

  private func ended() {
    activeGestures = max(0, activeGestures - 1)
    if activeGestures == 0 {
      model.gesturing = false
      model.scheduleCommit()
      model.needData(settled: !momentum)
    }
  }

  // MARK: Pan

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    let t = g.translation(in: self)
    switch g.state {
    case .began:
      began()
      cancelPendingTap()
      panAxis = abs(t.x) > 1.2 * abs(t.y) ? .time : .lanes
      lastTranslation = .zero
      rawCenter = model.axis.centerDay
      if model.isPlaying && panAxis == .time { model.pause() }
      apply(t)
    case .changed:
      apply(t)
    case .ended, .cancelled, .failed:
      apply(t)
      if panAxis == .time {
        let v = Double(g.velocity(in: self).x)
        if g.state == .ended, !model.reduceMotion, abs(v) > Self.stopVelocity {
          velocity = v
          momentum = true
        } else {
          settleRubberBand()
        }
      }
      panAxis = .undecided
      ended()
    default: break
    }
  }

  private func apply(_ t: CGPoint) {
    let dx = Double(t.x - lastTranslation.x), dy = Double(t.y - lastTranslation.y)
    lastTranslation = t
    switch panAxis {
    case .time: panTime(dx)
    case .lanes: model.scrollLanes(by: -dy)
    case .undecided: break
    }
  }

  /// Pans by `dx` points with the rubber band beyond the domain.
  private func panTime(_ dx: Double) {
    let dpp = model.axis.daysPerPoint
    rawCenter -= dx * dpp
    let (lo, hi) = centreLimits()
    var c = rawCenter
    if c < lo { c = lo - (lo - c) * Self.rubberBand }
    if c > hi { c = hi + (c - hi) * Self.rubberBand }
    if (rawCenter < lo || rawCenter > hi), model.axis.centerDay >= lo, model.axis.centerDay <= hi {
      model.boundary(ScrollCopy.domainEdge)
    }
    // the rubber band is drawn unclamped; `setAxis` would clamp it, so the axis is set directly here
    model.axis = ScrollAxis(centerDay: c, daysPerPoint: dpp)
    model.needData()
  }

  /// The centre days that keep the visible range inside 10000 BCE – 2100 CE at this zoom.
  private func centreLimits() -> (Double, Double) {
    let half = model.timelineWidth / 2 * model.axis.daysPerPoint
    return (ScrollAxis.minDay + half, max(ScrollAxis.minDay + half, ScrollAxis.maxDay - half))
  }

  private func settleRubberBand() {
    let (lo, hi) = centreLimits()
    let c = model.axis.centerDay
    if c < lo || c > hi {
      model.animate(to: ScrollAxis(centerDay: min(hi, max(lo, c)), daysPerPoint: model.axis.daysPerPoint))
    }
  }

  private func advanceMomentum(_ dt: Double) {
    // UIScrollView.DecelerationRate.normal is the velocity kept per millisecond.
    let rate = Double(UIScrollView.DecelerationRate.normal.rawValue)
    velocity *= pow(rate, dt * 1000)
    rawCenter = model.axis.centerDay
    panTime(velocity * dt)
    let (lo, hi) = centreLimits()
    let c = model.axis.centerDay
    if abs(velocity) < Self.stopVelocity || c < lo || c > hi {
      momentum = false
      velocity = 0
      settleRubberBand()
      model.scheduleCommit()
      model.needData(settled: true)
    }
  }

  // MARK: Pinch (x only)

  @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
    let loc = g.location(in: self)
    switch g.state {
    case .began:
      began()
      cancelPendingTap()
      model.pinching = true
      pinchLast = g.scale
      pinchCentroid = loc
      pinchHitLimit = false
      if model.isPlaying { model.pause() }
    case .changed:
      let factor = Double(g.scale / max(0.001, pinchLast))
      pinchLast = g.scale
      let dx = Double(loc.x - pinchCentroid.x)
      pinchCentroid = loc
      let before = model.axis
      var next = before.zoomed(width: model.timelineWidth, at: Double(loc.x), factor: factor)
      next = ScrollAxis(centerDay: next.centerDay - dx * next.daysPerPoint, daysPerPoint: next.daysPerPoint).clamped(width: model.timelineWidth)
      if !pinchHitLimit, next.daysPerPoint == before.daysPerPoint, abs(factor - 1) > 0.01 {
        pinchHitLimit = true
        model.boundary(factor < 1 ? ScrollCopy.widest : ScrollCopy.narrowest)
      }
      model.axis = next
      model.needData()
    case .ended, .cancelled, .failed:
      model.pinching = false
      ended()
    default: break
    }
  }

  // MARK: Taps

  @objc private func onTap(_ g: UITapGestureRecognizer) {
    let p = g.location(in: self)
    if let pending = pendingTap, hypot(pending.point.x - p.x, pending.point.y - p.y) < 30 {
      cancelPendingTap()
      model.zoomTier(1, at: Double(p.x))
      return
    }
    cancelPendingTap()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.pendingTap = nil
      self.model.tap(at: p)
    }
    pendingTap = (p, work)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.doubleTapInterval, execute: work)
  }

  private func cancelPendingTap() {
    pendingTap?.work.cancel()
    pendingTap = nil
  }

  @objc private func onTwoFingerTap(_ g: UITapGestureRecognizer) {
    cancelPendingTap()
    model.zoomTier(-1, at: Double(g.location(in: self).x))
  }

  // MARK: The ruler brush

  @objc private func onBrush(_ g: UILongPressGestureRecognizer) {
    let x = Double(g.location(in: self).x)
    let day = model.frame.day(x: x)
    switch g.state {
    case .began:
      began()
      brushAnchorDay = day
      brushMoved = false
      model.brush = day...day
      model.app.experience.haptics.play(.select)
      model.requestFrame()
    case .changed:
      guard let a = brushAnchorDay else { return }
      brushMoved = brushMoved || abs(model.frame.x(day: a) - x) > 4
      model.brush = min(a, day)...max(a, day)
      model.requestFrame()
    case .ended:
      if brushMoved, let b = model.brush { model.commitBrush(b) } else { model.brush = nil }
      brushAnchorDay = nil
      model.requestFrame()
      ended()
    case .cancelled, .failed:
      model.brush = nil
      brushAnchorDay = nil
      model.requestFrame()
      ended()
    default: break
    }
  }

  // MARK: Accessibility

  override var accessibilityElements: [Any]? {
    get { ScrollAccessibility.elements(for: self, model: model) }
    set {}
  }

  override func accessibilityPerformMagicTap() -> Bool {
    model.togglePlay()
    return true
  }

  override func accessibilityPerformEscape() -> Bool {
    if model.app.viewState.selection != nil {
      model.app.experience.clearSelection()
      return true
    }
    if model.app.coordinator.inspectorDetent != .peek {
      model.app.coordinator.inspectorDetent = .peek
      return true
    }
    return false
  }

  override var accessibilityCustomRotors: [UIAccessibilityCustomRotor]? {
    get { ScrollAccessibility.rotors(for: self, model: model) }
    set {}
  }

  override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
    get { ScrollAccessibility.actions(model: model) }
    set {}
  }

  // MARK: Hardware keyboard (SPEC §8.5 map, the Scroll's keys)

  override var canBecomeFirstResponder: Bool { true }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var handled = false
    for p in presses {
      guard let key = p.key else { continue }
      handled = model.handleKey(key.charactersIgnoringModifiers, shift: key.modifierFlags.contains(.shift)) || handled
    }
    if !handled { super.pressesBegan(presses, with: event) }
  }
}

/// Breaks the display link's retain cycle (CADisplayLink retains its target).
private final class DisplayLinkProxy: NSObject {
  weak var host: ScrollGestureHost?
  init(_ host: ScrollGestureHost) { self.host = host }
  @objc func step(_ link: CADisplayLink) { host?.step(link) }
}
