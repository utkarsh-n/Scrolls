// OWNER: N7
// The coverage track (IOS-SPEC §4.3, §4.7; SPEC §1.7, D15): under the ruler, 10 pt of the summed coverage of the shown
// lanes per bin in five grey STEP classes (0 · < 10k · < 100k · < 1M · ≥ 1M tokens; works 0 · < 10 · < 100 · < 1,000 ·
// ≥ 1,000) — a stated step scale, never a log axis — with hatching where no shown lane has sources and sparse dots while
// a lane is still indexing. The track itself is drawn by the renderer from the top display list (so the snapshot, SVG
// and G5 see the same cells), and a tap on a cell answers with its sentence ("coverage 1910–1919: 38k tokens (step
// class 3 of 4)"). This view is the track's accessibility element: the classes in view, in words.

import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum CoverageCopy {
  static let label = "Coverage"
  static let legend = "Five grey step classes; hatched where no shown lane has sources; dots while a lane is still indexing."
  static let none = "no coverage in view"

  static func stepWords(unit: String) -> [String] {
    unit == "works" ? ["none", "fewer than 10 works", "fewer than 100 works", "fewer than 1,000 works", "1,000 works or more"]
      : ["none", "fewer than 10k tokens", "fewer than 100k tokens", "fewer than 1M tokens", "1M tokens or more"]
  }
}

struct CoverageTrack: View {
  let model: ScrollModel

  var body: some View {
    Color.clear
      .frame(width: model.timelineWidth, height: model.coverageHeight)
      .offset(y: model.rulerHeight)
      .allowsHitTesting(false)
      .accessibilityElement()
      .accessibilityLabel(CoverageCopy.label)
      .accessibilityValue(value)
      .accessibilityHint(CoverageCopy.legend)
  }

  /// "tokens: 1910–1919 fewer than 100k tokens; 1920–1929 1M tokens or more …" for the bins in view (at most 12).
  private var value: String {
    guard let build = model.build else { return CoverageCopy.none }
    let sc = model.axis.scale(width: model.timelineWidth)
    var parts: [String] = []
    for row in build.model.coverageTrack {
      let words = CoverageCopy.stepWords(unit: row.unit)
      let cells = row.cells.filter { Double($0.hiDay) >= sc.loDay && Double($0.loDay) <= sc.hiDay }.prefix(12)
      for c in cells { parts.append("\(build.model.tier.label(ofBin: c.bin)) \(words[min(4, max(0, c.cls))])") }
    }
    return parts.isEmpty ? CoverageCopy.none : parts.joined(separator: "; ")
  }
}
