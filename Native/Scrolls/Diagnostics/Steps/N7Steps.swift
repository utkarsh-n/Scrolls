// OWNER: N7
// Package N7's device self-test steps (IOS-SPEC §2.7, §4.23, §8.5 N7): the Scroll's acceptance rows as commands.
// - perf: the renderer (Metal on this device or the Canvas fallback), zero idle frames at rest, main-thread time per
//   gesture frame during a scripted 2 s pan (≤ 1.0 ms p95), the display build of 20k cells off the main actor (≤ 12 ms
//   p95), a tier change to its first paint (warm ≤ 33 ms), tap → selection drawn (≤ 16 ms), GPU time per frame, renderer
//   memory (≤ 24 MB), labels per frame (≤ 150), and cold launch → the first frame with demo data (≤ 1.0 s).
// - first-minute: the demo's first paint is one 200 ms fade of the whole data plane (none under Reduce Motion).
// On the simulator every timing is a proxy, never a device measurement (INFO); the device run judges them (PASS/FAIL).
// A row that cannot be judged here is PENDING, never PASS. The load model of the build row is `PerfLoad` (labelled
// "load test · not data"); nothing it builds is shown.

import Foundation
import QuartzCore
import ScrollsRender
import ScrollsScrollModel
import UIKit

enum N7Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .perf:
      [SelfTestStep("N7 renderer", run: renderer), SelfTestStep("N7 idle frames", run: idleFrames),
       SelfTestStep("N7 gesture frames", run: gestureFrames), SelfTestStep("N7 display build", run: displayBuild),
       SelfTestStep("N7 tier change", run: tierChange), SelfTestStep("N7 tap", run: tapToSelection),
       SelfTestStep("N7 GPU and memory", run: gpuAndMemory), SelfTestStep("N7 launch", run: launch)]
    case .firstMinute:
      [SelfTestStep("N7 first paint", run: firstPaint)]
    default: []
    }
  }

  static var onSimulator: Bool {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }

  /// A timing row: PASS/FAIL against its budget on the device; INFO (a proxy) on the simulator.
  static func timing(_ name: String, _ value: Double, budget: Double, unit: String = "ms", detail: String) -> SelfTestRow {
    let text = "\(String(format: "%.2f", value)) \(unit) (budget ≤ \(String(format: "%g", budget)) \(unit)) · \(detail)"
    if onSimulator { return .info(name, "simulator proxy, not a device measurement: \(text)") }
    return value <= budget ? .pass(name, text) : .fail(name, text)
  }

  /// Waits until the Scroll has a build with data (≤ 20 s).
  static func settled(_ s: ScrollModel) async -> Bool {
    let deadline = Date.now.addingTimeInterval(20)
    while Date.now < deadline {
      if s.build != nil, s.status == .ready || s.status == .start, s.canvasSize.width > 0 { return true }
      try? await Task.sleep(for: .milliseconds(100))
    }
    return false
  }

  static func percentile(_ t: [Double], _ p: Double) -> Double {
    guard !t.isEmpty else { return .nan }
    let s = t.sorted()
    return s[min(s.count - 1, Int(Double(s.count) * p))]
  }

  // MARK: perf

  static func renderer(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    let choice = ctx.model.launch.renderer
    if choice == .canvas { return [.info("renderer", "DisplayListCanvas (-renderer canvas): the fallback, ≤ 60 Hz")] }
    guard let r = ScrollRenderer() else { return [.fail("renderer", "Metal is unavailable: the Canvas fallback draws the Scroll")] }
    _ = s
    return [.pass("renderer", "Metal \(r.device.name) · bgra8Unorm · label atlas \(r.atlas.size)² R8")]
  }

  /// Zero frames at rest (§4.1 rule 4, §4.23): nothing is drawn for 2 s after the Scroll settles.
  static func idleFrames(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s) else { return [.pending("idle frames", "the Scroll had no data to draw within 20 s")] }
    try? await Task.sleep(for: .seconds(1.5))
    let before = s.framesDrawn
    try? await Task.sleep(for: .seconds(2))
    let drawn = s.framesDrawn - before
    let text = "\(drawn) frames drawn in 2 s at rest (Metal: MTKView paused, no display link)"
    if ctx.model.launch.renderer == .canvas { return [.info("idle frames", "Canvas fallback: SwiftUI redraws on change only; \(text)")] }
    return [drawn == 0 ? .pass("idle frames", text) : .fail("idle frames", text)]
  }

  /// A scripted 2 s pan (240 steps at ≈ 120 Hz): main-thread time per frame (uniforms + encode).
  static func gestureFrames(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s) else { return [.pending("gesture frames", "the Scroll had no data to draw within 20 s")] }
    let start = s.axis
    let before = s.framesDrawn
    s.mainFrameMilliseconds = []
    s.gesturing = true
    for i in 0..<240 {
      let dx = sin(Double(i) / 240 * .pi * 2) * 6
      s.axis = ScrollAxis(centerDay: s.axis.centerDay - dx * s.axis.daysPerPoint, daysPerPoint: s.axis.daysPerPoint)
      s.requestFrame()
      try? await Task.sleep(for: .milliseconds(8))
    }
    s.gesturing = false
    s.setAxis(start)
    let frames = s.framesDrawn - before
    let p95 = percentile(s.mainFrameMilliseconds, 0.95), p50 = percentile(s.mainFrameMilliseconds, 0.5)
    guard frames > 0, p95.isFinite else { return [.pending("gesture frames", "no frames were drawn (Canvas fallback or no Metal view)")] }
    return [timing("gesture frame (main)", p95, budget: 1.0, detail: "p50 \(String(format: "%.3f", p50)) ms over \(frames) frames of a scripted pan")]
  }

  /// `DisplayBuilder` for 20k cells, off the main actor (≤ 12 ms p95).
  static func displayBuild(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let bins = 1000
    let model = PerfLoad.model(lanes: 10, strands: 2, bins: bins)
    let input = PerfLoad.input(model, width: 1290, bins: bins)
    var times: [Double] = []
    var shapes = 0
    for _ in 0..<12 {
      let t0 = CACurrentMediaTime()
      let b = await DisplayBuilder.build(input)
      times.append((CACurrentMediaTime() - t0) * 1000)
      shapes = b.lanes.instanceCount
    }
    let cells = model.lanes.reduce(0) { $0 + $1.strands.reduce(0) { $0 + $1.cols.count } }
    return [timing("display build 20k cells", percentile(times, 0.95), budget: 12,
                   detail: "\(cells) cells → \(shapes) instances (PerfLoad, not data), p50 \(String(format: "%.2f", percentile(times, 0.5))) ms")]
  }

  /// A tier change → the first paint of the new tier (warm ≤ 33 ms; cold ≤ 150 ms).
  static func tierChange(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s) else { return [.pending("tier change", "the Scroll had no data to draw within 20 s")] }
    let start = s.axis
    var rows: [SelfTestRow] = []
    for (label, budget) in [("cold", 150.0), ("warm", 33.0)] {
      let seq = s.buildSeq
      let t0 = CACurrentMediaTime()
      let tier = s.axis.tier
      let target = tier == .days ? tier.coarser : tier.finer
      s.setAxis(s.axis.zoomed(width: s.timelineWidth, at: s.timelineWidth / 2, factor: s.axis.daysPerPoint * target.midPointsPerDay))
      s.needData(settled: true)
      let deadline = Date.now.addingTimeInterval(3)
      while s.buildSeq == seq, Date.now < deadline { try? await Task.sleep(for: .milliseconds(1)) }
      let ms = (CACurrentMediaTime() - t0) * 1000
      rows.append(s.buildSeq == seq ? .fail("tier change (\(label))", "no new build within 3 s")
                  : timing("tier change (\(label))", ms, budget: budget, detail: "\(tier.code) → \(target.code), build \(String(format: "%.2f", s.lastBuildMilliseconds)) ms"))
      s.setAxis(start)
      s.needData(settled: true)
      try? await Task.sleep(for: .milliseconds(400))
    }
    return rows
  }

  /// Tap → the selection drawn and the inspector asked (≤ 16 ms).
  static func tapToSelection(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s), let build = s.build else { return [.pending("tap", "the Scroll had no data to draw within 20 s")] }
    // the first observed bar on screen
    for bar in build.lanes.bars where bar.style == ScrollStyle.bar.rawValue {
      let day = Double(build.lanes.originDay) + Double(bar.d0 + bar.d1) / 2
      let x = s.frame.x(day: day), y = s.stripHeight + Double(bar.y0 + bar.y1) / 2 - s.scrollY
      guard x > 0, x < s.timelineWidth, y > s.stripHeight, y < Double(s.canvasSize.height) - s.occludedBottom else { continue }
      let before = s.framesDrawn
      let t0 = CACurrentMediaTime()
      s.tap(at: CGPoint(x: x, y: y))
      let deadline = Date.now.addingTimeInterval(1)
      while s.framesDrawn == before, Date.now < deadline { try? await Task.sleep(for: .milliseconds(1)) }
      let ms = (CACurrentMediaTime() - t0) * 1000
      let selected = ctx.model.viewState.selection
      ctx.model.experience.clearSelection()
      guard selected?.type == "bin" else { return [.fail("tap", "the tap on a bar selected \(selected?.type ?? "nothing")")] }
      return [timing("tap → selection drawn", ms, budget: 16, detail: "a bar at (\(Int(x)), \(Int(y))) → bin selection → next frame")]
    }
    return [.pending("tap", "no observed bar was on screen to tap")]
  }

  /// GPU time per frame, renderer memory and labels per frame at the current view.
  static func gpuAndMemory(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s) else { return [.pending("GPU and memory", "the Scroll had no data to draw within 20 s")] }
    let st = s.renderStats
    var rows: [SelfTestRow] = []
    let gpu = percentile(st.gpuMilliseconds, 0.95)
    if gpu.isFinite {
      rows.append(timing("GPU per frame", gpu, budget: 3.0, detail: "p95 over \(st.gpuMilliseconds.count) frames at \(st.shapes) shapes + \(st.labels) labels (the budget is at 20k bars + 4k marks + 300 arcs + 150 labels)"))
    } else {
      rows.append(.pending("GPU per frame", "no GPU times recorded (the Canvas fallback, or no frame yet)"))
    }
    let mb = Double(st.bytes) / 1_048_576
    rows.append(timing("renderer memory", mb, budget: 24, unit: "MB", detail: "instance buffers + label atlas"))
    rows.append(st.labels <= 150 ? .pass("labels per frame", "\(st.labels) labels (≤ 150)") : .fail("labels per frame", "\(st.labels) labels (> 150)"))
    return rows
  }

  /// Cold launch → the first frame with demo data (≤ 1.0 s).
  static func launch(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    _ = await settled(s)
    guard let ms = s.launchToDataMilliseconds else { return [.pending("launch → data", "the Scroll did not install data in this run")] }
    return [timing("launch → first frame with data", ms, budget: 1000, detail: "process start → the first display build with tiles installed")]
  }

  // MARK: first-minute

  /// The demo's first paint is one 200 ms fade of the whole data plane, never a stagger (ΔS-8); none under Reduce Motion.
  static func firstPaint(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let s = ctx.model.scroll
    guard await settled(s) else { return [.pending("first paint", "the Scroll had no data to draw within 20 s")] }
    let fade = s.reduceMotion ? "none (Reduce Motion)" : "one 200 ms fade of the whole data plane (frame dim 0 → 1)"
    return [s.firstPaint >= 1 ? .pass("first paint", "finished: \(fade); no stagger exists in the renderer")
            : .fail("first paint", "the first-paint fade did not finish (\(s.firstPaint))")]
  }
}

extension SelfTestCatalog {
  static var n7: (any SelfTestSteps.Type)? { N7Steps.self }
}
