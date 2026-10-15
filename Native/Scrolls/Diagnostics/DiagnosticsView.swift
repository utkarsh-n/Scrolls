// OWNER: N0
// Diagnostics (IOS-SPEC §2.7, §3.7–§3.9, §8.4.10): the build, the engine and where its answers come from, the launch
// arguments, the probe, the self-test suites, background-task grants, measured performance and the device's
// conditions. It reports; it changes nothing except running a self-test, which never writes into his notebook.

import ScrollsCore
import SwiftUI

nonisolated enum DiagnosticsCopy {
  static let title = "Diagnostics"
  static let build = "Build"
  static let engine = "Engine"
  static let launch = "Launch arguments"
  static let none = "none"
  static let probe = "Probe"
  static let qwen = "Qwen on this iPhone"
  static let selfTests = "Self-tests"
  static let selfTestsFooter = "A suite writes Documents/selftest/<run>/result.json, the file Tools/device-check.sh copies back."
  static let run = "Run"
  static let background = "Background tasks"
  static let performance = "Performance"
  static let notRecording = "Not recording: launch with -perf, or run a self-test."
  static let conditions = "Conditions"
  static let files = "Files"
  static let done = "Done"
  static let maintenanceRegistered = "maintenance handler registered"
  static let maintenanceMissing = "maintenance handler not registered"
  static let lastGrants = "Last grants"
  static let noGrants = "iOS has not granted background time yet."
}

struct DiagnosticsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var grants: [String] = BackgroundTasks.recentGrants(limit: 5)

  var body: some View {
    NavigationStack {
      List {
        Section(DiagnosticsCopy.build) {
          LabeledContent("Scrolls", value: "\(Bundle.main.shortVersion) (\(Bundle.main.buildNumber))")
          LabeledContent("Engine version", value: BuildInfo.engineVersion)
          LabeledContent("Commit", value: String(BuildInfo.gitCommit.prefix(12)))
          LabeledContent("Device", value: Device.modelIdentifier)
        }
        Section(DiagnosticsCopy.engine) {
          Text(model.engine.description).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          if let health = model.jobs.health {
            LabeledContent("Contract", value: health.contract)
            LabeledContent("Data version", value: Format.int(health.dataVersion))
            LabeledContent("Cipher", value: [health.cipher.status, health.cipher.message].compactMap { $0 }.joined(separator: " · "))
          }
        }
        Section(DiagnosticsCopy.launch) {
          Text(model.launch.summary.isEmpty ? DiagnosticsCopy.none : model.launch.summary.joined(separator: " "))
            .font(Typography.code)
          ForEach(model.launch.problems, id: \.self) { problem in
            Text(problem).font(Typography.meta).foregroundStyle(Tokens.danger.color)
          }
        }
        Section(DiagnosticsCopy.probe) {
          NavigationLink(DiagnosticsCopy.probe) { ProbeView() }
            .accessibilityIdentifier("probeLink")
          NavigationLink(DiagnosticsCopy.qwen) { QwenScreen() }
            .accessibilityIdentifier("qwenLink")
        }
        Section {
          ForEach(SelfTestSuite.allCases, id: \.self) { suite in
            HStack {
              Text(suite.rawValue).font(Typography.code)
              Spacer()
              Button(DiagnosticsCopy.run) { Task { await model.selfTests.run(suite, model: model) } }
                .disabled(isRunning)
            }
          }
          if case .finished(let result) = model.selfTests.state {
            Text("\(result.suite) · \(result.status.rawValue) · \(result.run)").font(Typography.meta)
            ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in SelfTestRowView(row: row) }
          } else if case .running(let step, let done, let total) = model.selfTests.state {
            CountingLabel(step, fraction: total > 0 ? Double(done) / Double(total) : nil)
          }
        } header: {
          Text(DiagnosticsCopy.selfTests)
        } footer: {
          Text(DiagnosticsCopy.selfTestsFooter)
        }
        Section(DiagnosticsCopy.background) {
          Text(BackgroundTasks.maintenanceRegistered ? DiagnosticsCopy.maintenanceRegistered : DiagnosticsCopy.maintenanceMissing)
          LabeledContent(DiagnosticsCopy.lastGrants, value: grants.isEmpty ? DiagnosticsCopy.noGrants : "")
          ForEach(grants, id: \.self) { Text($0).font(Typography.code) }
        }
        Section(DiagnosticsCopy.performance) {
          let snapshot = PerfLog.shared.snapshot
          if snapshot.signposts.isEmpty {
            Text(DiagnosticsCopy.notRecording).foregroundStyle(Tokens.ink2.color)
          }
          ForEach(snapshot.signposts.keys.sorted(), id: \.self) { name in
            if let s = snapshot.signposts[name] {
              LabeledContent(name, value: "p50 \(Format.number(s.p50Ms)) ms · p95 \(Format.number(s.p95Ms)) ms · n \(s.count)")
            }
          }
          if let footprint = PerfLog.physFootprint() {
            LabeledContent("phys_footprint now", value: ByteCount.text(footprint))
          }
        }
        Section(DiagnosticsCopy.conditions) {
          LabeledContent("Thermal", value: PerfLog.thermalName(ProcessInfo.processInfo.thermalState))
          LabeledContent("Low Power Mode", value: ProcessInfo.processInfo.isLowPowerModeEnabled ? "on" : "off")
          LabeledContent("Job workers", value: model.engineHost.conditions.summary)
        }
        Section(DiagnosticsCopy.files) {
          Text(DiagnosticsFiles.diagnostics.path(percentEncoded: false)).font(Typography.code).textSelection(.enabled)
        }
      }
      .scrollContentBackground(.hidden)
      .background(Tokens.bg0.color)
      .navigationTitle(DiagnosticsCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button(DiagnosticsCopy.done) { dismiss() } }
      }
    }
    .accessibilityIdentifier("diagnostics")
  }

  private var isRunning: Bool {
    if case .running = model.selfTests.state { return true }
    return false
  }
}
