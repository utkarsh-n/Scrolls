// OWNER: Q (created by the bring-up, B2)
// "Qwen on this iPhone" (Diagnostics; launch argument -qwen-demo; IOS-SPEC-QWEN §2.9 M1a): the model files and their
// sha256, load times, the live demonstration (60 real 'bank' passages read on the device, k-means k = 2, a Qwen3-4B
// label per group), timings and memory, and the S4–S7 self-test. Every generated line carries the machine badge;
// the groups carry the computed badge. Nothing here is evidence.

import ScrollsQwen
import ScrollsQwenRuntime
import OfflineIntelligence
import SwiftUI

nonisolated enum QwenScreenCopy {
  static let models = "Models"
  static let verifyAgain = "Check the sha256 again"
  static let demo = "Live demonstration"
  static let run = "Run the demonstration"
  static let runAgain = "Run it again"
  static let cancel = "Stop"
  static let unload = "Unload now"
  static let selfTest = "Self-test (S4–S7)"
  static let runSelfTest = "Run the self-test"
  static let timings = "Timings"
  static let memory = "Memory"
  static let events = "Model events"
  static let files = "Written"
  static let simulatorNote = "This is the iOS Simulator: MLX runs on the Mac's CPU here, so speeds and memory are not the phone's. On the phone it runs on the GPU."
  static let gateNote = "k is fixed at 2 for this demonstration. The atlas's own test for groups (rule_v2, provisional) on these vectors:"
  static let notGrouped = "Groups appear after the run."
}

struct QwenScreen: View {
  var autorun: QwenAutorun?
  @State private var host = QwenHost.shared
  @State private var didAutorun = false

  var body: some View {
    List {
      header
      modelsSection
      demoSection
      if let report = host.demo, let set = host.demoSet { QwenDemoResults(report: report, set: set) }
      selfTestSection
      if !host.events.isEmpty {
        Section(QwenScreenCopy.events) {
          ForEach(Array(host.events.enumerated()), id: \.offset) { _, e in Text(e).font(Typography.code) }
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Tokens.bg0.color)
    .navigationTitle(QwenCopy.screenTitle)
    .accessibilityIdentifier("qwenScreen")
    .task {
      host.start()
      guard !didAutorun, let autorun else { return }
      didAutorun = true
      switch autorun {
      case .demo: host.runDemo()
      case .selfTest: host.runSelfTest()
      }
    }
  }

  private var header: some View {
    Section {
      Text(QwenCopy.demoIntro(model: ScrollsQwen.ModelCatalog.generation(host.generationChoice).display))
        .font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      Text(QwenCopy.noNetwork).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      LabeledContent("Runs on", value: "\(host.info.device) · \(host.info.osBuild)")
      LabeledContent("MLX", value: "\(host.info.mlxDevice) · \(host.info.runtime)")
      if host.info.builtOn == .simulator {
        Text(QwenScreenCopy.simulatorNote).font(Typography.meta).foregroundStyle(Tokens.amber.color)
      }
      if let p = host.problem { Text(p).font(Typography.meta).foregroundStyle(Tokens.danger.color) }
    }
  }

  private var modelsSection: some View {
    Section {
      Picker("Text model", selection: Binding(get: { host.generationChoice }, set: { host.selectGenerationChoice($0) })) {
        ForEach(OfflineModelChoice.allCases) { choice in Text(choice.title).tag(choice) }
      }
      .disabled(host.isRunning || host.switchingModel)
      .accessibilityIdentifier("qwenGenerationModelChoice")
      Text(host.generationChoice.detail).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      Text("Context groups use Qwen3-Embedding. It unloads before the selected text model loads.")
        .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      ForEach(ScrollsQwen.ModelCatalog.all, id: \.name) { spec in
        let status = host.models.first { $0.spec.name == spec.name }
        VStack(alignment: .leading, spacing: 4) {
          Text(spec.display).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
          Text("\(spec.name) · \(spec.role.rawValue) · \(QwenCopy.mb(spec.bytes)) · \(spec.files.count) files")
            .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          Text("weights sha256 \(spec.sha256)").font(Typography.code).foregroundStyle(Tokens.ink3.color)
          statusLine(status)
          if (spec.role == .embedder || host.demo?.labels.first?.result.modelName == spec.display),
             let load = host.demo?.loads.last(where: { $0.role == spec.role }) {
            Text(String(format: "last load %.2f s · footprint +%@", load.seconds, load.residentDelta.map(QwenCopy.mb) ?? "n/a"))
              .font(Typography.count).foregroundStyle(Tokens.ink2.color)
          }
        }
        .accessibilityIdentifier("qwenModel-\(spec.name)")
      }
      HStack {
        Button(QwenScreenCopy.verifyAgain) { host.refreshModels(force: true) }.disabled(host.verifying || host.isRunning)
        Spacer()
        Button(QwenScreenCopy.unload) { host.unloadNow() }.disabled(host.isRunning)
      }
      .buttonStyle(.borderless)
    } header: {
      Text(QwenScreenCopy.models)
    } footer: {
      Text("Local model files: bundled Models, or checked files in Documents/Models. No download is required.")
    }
  }

  @ViewBuilder private func statusLine(_ s: ModelStatus?) -> some View {
    if host.verifying && s == nil {
      Text("checking sha256…").font(Typography.meta).foregroundStyle(Tokens.ink2.color)
    } else if let s {
      switch s.state {
      case .verified:
        Text(s.verification.map { "✓ \($0.summary) · \(String(format: "%.1f s", $0.seconds))" } ?? "sha256 matches")
          .font(Typography.meta).foregroundStyle(Tokens.ok.color)
      case .missing:
        Text(QwenCopy.modelsMissing).font(Typography.meta).foregroundStyle(Tokens.danger.color)
      default:
        Text(s.verification?.summary ?? QwenCopy.unverified).font(Typography.meta).foregroundStyle(Tokens.danger.color)
      }
    }
  }

  private var demoSection: some View {
    Section {
      if let set = host.demoSet {
        Text(QwenCopy.runtimeCheckHeader(passages: set.passages.count, builtOn: host.info.builtOn))
          .font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          .accessibilityIdentifier("qwenRuntimeCheckHeader")
        Text("\(set.passages.count) passages · \(set.selection)").font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      if case .running(let text, let fraction) = host.phase {
        VStack(alignment: .leading, spacing: 6) {
          Text(text).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          if let fraction { ProgressView(value: fraction) } else { ProgressView() }
        }
        .accessibilityIdentifier("qwenProgress")
        Button(QwenScreenCopy.cancel, role: .destructive) { host.cancel() }
      } else {
        Button(host.demo == nil ? QwenScreenCopy.run : QwenScreenCopy.runAgain) { host.runDemo() }
          .accessibilityIdentifier("qwenRunDemo")
      }
      if !host.written.isEmpty {
        Text("\(QwenScreenCopy.files): \(host.written.joined(separator: ", "))").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    } header: {
      Text(QwenScreenCopy.demo)
    }
  }

  private var selfTestSection: some View {
    Section {
      Button(QwenScreenCopy.runSelfTest) { host.runSelfTest() }.disabled(host.isRunning)
      if let r = host.selfTest {
        Text("\(r.status) · \(r.at) · \(String(format: "%.0f s", r.totalSeconds)) · \(QwenCopy.whereRan(r.info.builtOn))")
          .font(Typography.meta).foregroundStyle(r.status == "PASS" ? Tokens.ok.color : Tokens.amber.color)
        ForEach(r.rows) { row in
          VStack(alignment: .leading, spacing: 2) {
            Text("\(row.status.rawValue) · \(row.id) · \(row.name)").font(Typography.cardTitle)
              .foregroundStyle(row.status == .fail ? Tokens.danger.color : Tokens.ink.color)
            Text(row.detail).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          }
        }
      }
    } header: {
      Text(QwenScreenCopy.selfTest)
    } footer: {
      Text("Written to Documents/qwen-selftest.json")
    }
  }
}

enum QwenAutorun: Equatable { case demo, selfTest }

/// The results of one demonstration run (also the content of qwen-demo.png).
struct QwenDemoResults: View {
  let report: DemoReport
  let set: DemoSet

  var body: some View {
    Section {
      Text("\(report.status) · \(report.at) · \(String(format: "%.1f s", report.totalSeconds)) · \(QwenCopy.whereRan(report.info.builtOn))")
        .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      ForEach(report.problems, id: \.self) { Text($0).font(Typography.meta).foregroundStyle(Tokens.danger.color) }
      if let e = report.embed {
        Text(String(format: "Read %d passages in %.2f s (%.1f contexts/s), plan %@, %d dims; %d–%d tokens per window (median %d)",
                    e.windows, e.seconds, e.windowsPerSecond, e.plan, e.dims, e.tokensMin, e.tokensMax, e.tokensMedian))
          .font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      }
      if let g = report.grouping {
        Text(QwenScreenCopy.gateNote).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        Text(String(format: "silhouette %.3f · stability %.2f · cloud without groups %.3f · margin %.3f → %@",
                    g.gate.silhouette, g.gate.stability, g.gate.reference, g.gate.margin,
                    g.gate.passes ? "passes (provisional)" : "does not pass (\(g.gate.detail))"))
          .font(Typography.code).foregroundStyle(Tokens.ink2.color)
      }
    } header: {
      Text("Result")
    }
    if let g = report.grouping {
      ForEach(g.groups, id: \.index) { group in
        QwenGroupSection(group: group, label: report.labels.first { $0.group == group.index }, set: set,
                         builtOn: report.info.builtOn, total: g.groups.count)
      }
    }
    Section(QwenScreenCopy.timings) {
      ForEach(Array(report.loads.enumerated()), id: \.offset) { _, l in
        Text(String(format: "%@ load %.2f s · footprint +%@", l.role.rawValue, l.seconds, l.residentDelta.map(QwenCopy.mb) ?? "n/a"))
          .font(Typography.code)
      }
      ForEach(report.labels, id: \.group) { l in
        Text(String(format: "label %d: %d prompt tokens, prefill %.1f tok/s; %d out, decode %.1f tok/s; grammar %@ (%d ms); stop %@",
                    l.group + 1, l.result.tokensIn, l.result.prefillTokensPerSecond, l.result.tokensOut,
                    l.result.decodeTokensPerSecond, l.result.grammar, l.result.grammarCompileMs, l.result.stop.rawValue))
          .font(Typography.code)
      }
    }
    Section(QwenScreenCopy.memory) {
      ForEach(Array(report.memory.enumerated()), id: \.offset) { _, m in
        Text("\(m.label): footprint \(m.footprint.map(QwenCopy.mb) ?? "n/a") · ledger peak \(m.ledgerPeak.map(QwenCopy.mb) ?? "n/a") · available \(m.available.map(QwenCopy.mb) ?? "n/a") · MLX \(m.mlxActive.map(QwenCopy.mb) ?? "n/a") + cache \(m.mlxCache.map(QwenCopy.mb) ?? "n/a") · \(m.thermal)")
          .font(Typography.code)
      }
    }
  }
}

struct QwenGroupSection: View {
  let group: DemoGroup
  let label: DemoLabel?
  let set: DemoSet
  let builtOn: BuiltOn
  let total: Int

  var body: some View {
    Section {
      // §3.6: computed words first (log-odds over the group's passages), Qwen's label beside them in a machine card
      if !group.cardWords.isEmpty {
        Text(QwenCopy.computedWords(group.cardWords)).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      }
      Text(QwenCopy.computedBadge(builtOn)).font(Typography.badge).foregroundStyle(Tokens.ink3.color)
      QwenReadingCard(label: label, builtOn: builtOn)
      ForEach(Array(group.members.prefix(6).enumerated()), id: \.offset) { _, m in
        if let p = set.passages.first(where: { $0.id == m.passage }) { QwenSnippet(passage: p, cos: m.cos) }
      }
      if group.members.count > 6 {
        Text("and \(group.members.count - 6) more passages in this group").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    } header: {
      Text("Group \(group.index + 1) of \(total) · \(group.members.count) passages")
    }
  }
}

struct QwenReadingCard: View {
  let label: DemoLabel?
  let builtOn: BuiltOn

  // Rule 19's machine card: opaque bg-1, a 1 pt dotted ink-3 border, the `cpu` glyph and the chip "machine reading";
  // never glass, never amber, violet or cyan. Rule 27's footer closes it.
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "cpu").foregroundStyle(Tokens.ink3.color).accessibilityLabel(QwenCopy.machineChip)
        Text(QwenCopy.machineChip).font(Typography.badge).foregroundStyle(Tokens.ink2.color)
          .padding(.horizontal, 6).padding(.vertical, 2)
          .overlay(Capsule().strokeBorder(Tokens.ink3.color, lineWidth: 1))
      }
      Text(label?.badge ?? QwenCopy.machineBadge(builtOn)).font(Typography.badge).foregroundStyle(Tokens.ink2.color)
        .accessibilityIdentifier("qwenMachineBadge")
      if let v = label?.verified, let l = v.label {
        Text("Qwen label: \(l)").font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
        if let gloss = v.gloss { Text(gloss).font(Typography.cardBody).foregroundStyle(Tokens.ink.color) }
        Text("cites \(v.cites.joined(separator: ", ")) of the five passages it was shown").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        ForEach(v.withheld, id: \.self) { Text($0).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
      } else if let label {
        Text(QwenCopy.notShown).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
        ForEach((label.verified?.withheld ?? []) + label.rejection, id: \.self) {
          Text($0).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        }
      } else {
        Text("No label for this group.").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
      Text(QwenCopy.machineFooter(builtOn, model: label?.result.modelName ?? "Qwen3-4B (2025)"))
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Tokens.bg1.color, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.ink3.color, style: StrokeStyle(lineWidth: 1, dash: [1, 3])))
  }
}

struct QwenSnippet: View {
  let passage: DemoPassage
  let cos: Double

  static func attributed(_ p: (left: String, mid: String, right: String)) -> AttributedString {
    var mid = AttributedString(p.mid)
    mid.foregroundColor = Tokens.cyan.color
    mid.inlinePresentationIntent = .stronglyEmphasized
    return AttributedString(p.left) + mid + AttributedString(p.right)
  }

  var body: some View {
    let parts = Excerpt.parts(passage.text, target: passage.target, words: 12)
    VStack(alignment: .leading, spacing: 2) {
      Text(Self.attributed(parts)).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      Text("\(passage.title ?? "untitled") · \(passage.author ?? "unknown author") · \(passage.yearText) · cos \(String(format: "%.2f", cos))")
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
    }
  }
}
