// OWNER: N0
// Runs a self-test suite and writes what `Tools/device-check.sh` copies back (IOS-SPEC §2.7):
// `Documents/selftest/<run>/result.json`, `<run>` being the UTC start time yyyyMMdd'T'HHmmss'Z', with
// {suite, status, rows: [{name, status, detail}], signposts, peak_phys_footprint, thermal, …}. The probe suite also
// writes `Documents/Diagnostics/probe.json`. Status is PASS only when every row is PASS or INFO; any FAIL makes it
// FAIL; anything left PENDING or SKIP makes it PENDING. A self-test is launched with `-selftest <suite>` and runs once
// the engine has opened; it can also be started from Diagnostics.

import Foundation
import Observation
import ScrollsCore

/// A finished run, as written to result.json.
nonisolated struct SelfTestResult: Codable, Sendable, Equatable {
  enum Status: String, Codable, Sendable { case pass = "PASS", fail = "FAIL", pending = "PENDING" }

  let suite: String
  let status: Status
  let run: String
  let startedAt: String
  let finishedAt: String
  let device: String
  let os: String
  let build: String
  let engine: String
  let launchArguments: [String]
  let rows: [SelfTestRow]
  let signposts: [String: SignpostSummary]
  let peakPhysFootprint: UInt64?
  let thermal: [ThermalSample]

  enum CodingKeys: String, CodingKey {
    case suite, status, run, device, os, build, engine, rows, signposts, thermal
    case startedAt = "started_at", finishedAt = "finished_at", launchArguments = "launch_arguments"
    case peakPhysFootprint = "peak_phys_footprint"
  }

  /// PASS only when every row is PASS or INFO.
  static func status(of rows: [SelfTestRow]) -> Status {
    if rows.contains(where: { $0.status == .fail }) { return .fail }
    if rows.isEmpty || rows.contains(where: { $0.status == .pending || $0.status == .skip }) { return .pending }
    return .pass
  }
}

@MainActor @Observable
final class SelfTestRunner {
  enum State: Equatable {
    case idle
    case running(step: String, done: Int, total: Int)
    case finished(SelfTestResult)
    case failedToWrite(String)
  }

  private(set) var state: State = .idle
  /// Rows so far, in order (the Diagnostics screen shows them as they arrive).
  private(set) var rows: [SelfTestRow] = []

  /// The run folder name for a start time: UTC yyyyMMdd'T'HHmmss'Z' (what device-check.sh sorts on).
  nonisolated static func runName(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return f.string(from: date)
  }

  /// Runs every registered step of `suite`, then writes result.json (and probe.json for the probe suite).
  @discardableResult
  func run(_ suite: SelfTestSuite, model: AppModel) async -> SelfTestResult? {
    if case .running = state { return nil }
    let started = Date.now
    let run = Self.runName(started)
    let dir = DiagnosticsFiles.selfTests.appending(path: run, directoryHint: .isDirectory)
    PerfLog.shared.recording = true
    rows = []
    let steps = SelfTestCatalog.steps(for: suite)
    let ctx = SelfTestContext(model: model, suite: suite, runDirectory: dir)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      state = .failedToWrite("Could not create \(dir.lastPathComponent): \(error.localizedDescription)")
      return nil
    }
    for (i, step) in steps.enumerated() {
      state = .running(step: step.name, done: i, total: steps.count)
      let produced = await step.run(ctx)
      rows.append(contentsOf: produced.isEmpty ? [.pending(step.name, "the step returned no rows")] : produced)
    }
    if steps.isEmpty {
      rows.append(.pending(suite.rawValue, "no package has registered steps for this suite yet"))
    }
    PerfLog.shared.sampleFootprint()
    let perf = PerfLog.shared.snapshot
    let result = SelfTestResult(
      suite: suite.rawValue, status: SelfTestResult.status(of: rows), run: run, startedAt: started.ISO8601Format(),
      finishedAt: Date.now.ISO8601Format(), device: Device.modelIdentifier, os: ProcessInfo.processInfo.operatingSystemVersionString,
      build: "\(Bundle.main.shortVersion) (\(Bundle.main.buildNumber)) engine \(BuildInfo.engineVersion) \(BuildInfo.gitCommit)",
      engine: model.engine.description, launchArguments: model.launch.summary, rows: rows,
      signposts: perf.signposts, peakPhysFootprint: perf.peakPhysFootprint, thermal: perf.thermal)
    do {
      let data = try DiagnosticsFiles.encoder.encode(result)
      if suite == .probe {
        try FileManager.default.createDirectory(at: DiagnosticsFiles.diagnostics, withIntermediateDirectories: true)
        try data.write(to: DiagnosticsFiles.diagnostics.appending(path: "probe.json"), options: .atomic)
        try data.write(to: dir.appending(path: "probe.json"), options: .atomic)
      }
      try PerfLog.shared.writeLastRun(to: DiagnosticsFiles.diagnostics)
      // result.json last: device-check.sh copies the folder as soon as it appears.
      try data.write(to: dir.appending(path: "result.json"), options: .atomic)
      state = .finished(result)
    } catch {
      state = .failedToWrite("Could not write the result: \(error.localizedDescription)")
    }
    return result
  }

  /// The newest probe.json on this device, if any (Diagnostics shows it at launch).
  nonisolated static func lastProbe() -> SelfTestResult? {
    let url = DiagnosticsFiles.diagnostics.appending(path: "probe.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(SelfTestResult.self, from: data)
  }
}
