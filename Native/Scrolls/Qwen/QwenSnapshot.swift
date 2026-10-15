// OWNER: Q (created by the bring-up, B2)
// The demonstration's own picture: Documents/qwen-demo.png, rendered with ImageRenderer from a plain stack (no List),
// so the result can be read off the phone with devicectl without a screenshot.

import ScrollsQwen
import SwiftUI

enum QwenSnapshot {
  @MainActor
  static func write(report: DemoReport, set: DemoSet, to url: URL) -> Bool {
    let renderer = ImageRenderer(content: QwenSnapshotView(report: report, set: set).frame(width: 430))
    renderer.scale = 2
    guard let image = renderer.uiImage, let data = image.pngData() else { return false }
    return (try? data.write(to: url, options: .atomic)) != nil
  }
}

struct QwenSnapshotView: View {
  let report: DemoReport
  let set: DemoSet

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(QwenCopy.screenTitle).font(.title2.weight(.semibold)).foregroundStyle(Tokens.ink.color)
      Text("\(report.info.device) · \(report.info.osBuild) · MLX on \(report.info.mlxDevice) · \(report.at)")
        .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      Text("\(set.passages.count) passages containing ‘\(set.word)’ · \(set.selection)").font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      if let e = report.embed {
        Text(String(format: "Read in %.2f s (%.1f contexts/s), %@, %d dims", e.seconds, e.windowsPerSecond, e.plan, e.dims))
          .font(Typography.code).foregroundStyle(Tokens.ink.color)
      }
      Text(QwenCopy.runtimeCheckHeader(passages: set.passages.count, builtOn: report.info.builtOn))
        .font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      if let g = report.grouping {
        Text(String(format: "k = 2 · silhouette %.3f · stability %.2f · margin %.3f · rule_v2 %@", g.gate.silhouette, g.gate.stability,
                    g.gate.margin, g.gate.passes ? "passes (provisional)" : "does not pass (\(g.gate.detail))"))
          .font(Typography.code).foregroundStyle(Tokens.ink2.color)
        ForEach(g.groups, id: \.index) { group in
          VStack(alignment: .leading, spacing: 6) {
            Text("Group \(group.index + 1) · \(group.members.count) passages").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
            if !group.cardWords.isEmpty {
              Text(QwenCopy.computedWords(group.cardWords)).font(Typography.meta).foregroundStyle(Tokens.ink.color)
            }
            QwenReadingCard(label: report.labels.first { $0.group == group.index }, builtOn: report.info.builtOn)
            ForEach(Array(group.members.prefix(4).enumerated()), id: \.offset) { _, m in
              if let p = set.passages.first(where: { $0.id == m.passage }) { QwenSnippet(passage: p, cos: m.cos) }
            }
          }
          .padding(10)
          .background(Tokens.bg1.color, in: RoundedRectangle(cornerRadius: 12))
        }
      }
      ForEach(Array(report.loads.enumerated()), id: \.offset) { _, l in
        Text(String(format: "%@ load %.2f s · footprint +%@", l.role.rawValue, l.seconds, l.residentDelta.map(QwenCopy.mb) ?? "n/a"))
          .font(Typography.code).foregroundStyle(Tokens.ink2.color)
      }
      ForEach(report.labels, id: \.group) { l in
        Text(String(format: "label %d: %d in, prefill %.1f tok/s · %d out, decode %.1f tok/s · %@", l.group + 1, l.result.tokensIn,
                    l.result.prefillTokensPerSecond, l.result.tokensOut, l.result.decodeTokensPerSecond, l.result.stop.rawValue))
          .font(Typography.code).foregroundStyle(Tokens.ink2.color)
      }
      if let peak = report.memory.compactMap(\.ledgerPeak).max() {
        Text("peak footprint (process ledger) \(QwenCopy.mb(peak)); total \(String(format: "%.1f s", report.totalSeconds))")
          .font(Typography.code).foregroundStyle(Tokens.ink2.color)
      }
      ForEach(report.problems, id: \.self) { Text($0).font(Typography.meta).foregroundStyle(Tokens.danger.color) }
    }
    .padding(16)
    .background(Tokens.bg0.color)
    .environment(\.colorScheme, .dark)
  }
}
