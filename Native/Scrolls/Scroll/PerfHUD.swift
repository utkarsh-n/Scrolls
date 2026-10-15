// OWNER: N7
// The performance HUD (`-perf`, IOS-SPEC §4.23): p50 and p95 of the main-thread frame time (recogniser → uniforms →
// encode) and of the GPU time (`MTLCommandBuffer.gpuStartTime`/`gpuEndTime`), the instance and label counts, the drawn
// tier, the last display build's time and its cause, and the frames drawn so far (zero at rest is a budget row). The
// numbers are the renderer's own; the HUD never draws data.

import ScrollsCore
import ScrollsRender
import ScrollsScrollModel
import SwiftUI

struct PerfHUD: View {
  let model: ScrollModel

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.5)) { _ in
      let main = ScrollRenderer.percentiles(model.mainFrameMilliseconds)
      let gpu = ScrollRenderer.percentiles(model.renderStats.gpuMilliseconds)
      VStack(alignment: .leading, spacing: 1) {
        Text("main p50 \(ms(main.p50)) · p95 \(ms(main.p95)) ms")
        Text("GPU p50 \(ms(gpu.p50)) · p95 \(ms(gpu.p95)) ms")
        Text("shapes \(Format.int(model.renderStats.shapes)) · labels \(Format.int(model.renderStats.labels))")
        Text("tier \(model.drawTier.code)\(model.dimmed ? " (stand-in)" : "") · build \(ms(model.lastBuildMilliseconds)) ms · \(model.rebuildCause)")
        Text("frames \(Format.int(model.renderStats.frames)) · installs \(Format.int(model.renderStats.installs))")
      }
      .font(.system(size: 9.5, weight: .medium, design: .monospaced))
      .foregroundStyle(Tokens.ink2.color)
      .padding(6)
      .background(Tokens.bg0.opacity(0.82), in: RoundedRectangle(cornerRadius: 6))
      .padding(.top, model.stripHeight + 22)
      .padding(.trailing, 8)
      .frame(maxWidth: .infinity, alignment: .topTrailing)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
      .accessibilityIdentifier("perfHUD")
    }
  }

  private func ms(_ x: Double) -> String { String(format: "%.2f", x) }
}

extension ScrollModel {
  /// The renderer's statistics, published by the gesture host after each frame.
  var renderStats: RenderStats { renderStatsBox.value }
}

/// A box the host writes the renderer's statistics into (read by the HUD on its own clock, never observed per frame).
final class RenderStatsBox {
  var value = RenderStats()
}
