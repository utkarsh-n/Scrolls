// OWNER: N0
// Signposts, memory and thermal samples (IOS-SPEC §4.23 PerfHUD, §5, §3.8). Every measured interval is an
// `os_signpost` interval (Instruments) and, under `-perf` or a self-test, also a duration kept here, so the device
// run's result.json and `Documents/Diagnostics/last-run.json` carry the same numbers: p50/p95 per signpost, the peak
// `task_vm_info.phys_footprint`, and the thermal states seen. Nothing here is estimated: a value that was not measured
// is absent.

import Foundation
import OSLog
import os

/// One thermal state change.
nonisolated struct ThermalSample: Codable, Sendable, Equatable {
  /// ISO 8601 time of the change.
  let at: String
  /// "nominal", "fair", "serious", "critical".
  let state: String
}

/// Summary of one signpost's measured durations.
nonisolated struct SignpostSummary: Codable, Sendable, Equatable {
  let count: Int
  let p50Ms: Double
  let p95Ms: Double
  let maxMs: Double

  enum CodingKeys: String, CodingKey {
    case count, p50Ms = "p50_ms", p95Ms = "p95_ms", maxMs = "max_ms"
  }
}

/// What a run measured, as written to last-run.json and into self-test results.
nonisolated struct PerfSnapshot: Codable, Sendable, Equatable {
  let signposts: [String: SignpostSummary]
  /// Peak `phys_footprint` in bytes over the samples taken (nil before the first sample).
  let peakPhysFootprint: UInt64?
  let thermal: [ThermalSample]

  enum CodingKeys: String, CodingKey {
    case signposts, peakPhysFootprint = "peak_phys_footprint", thermal
  }
}

@MainActor
final class PerfLog {
  static let shared = PerfLog()

  /// Signposts for Instruments (Scrolls.tracetemplate reads the "perf" category).
  nonisolated static let signposter = OSSignposter(subsystem: "com.utkarsh.scrolls", category: "perf")

  /// Keep durations and samples (set by `-perf` and by self-tests); signposts are always emitted.
  var recording = false {
    didSet { recording ? startSampling() : stopSampling() }
  }

  private var durations: [String: [Double]] = [:]
  private var peakFootprint: UInt64?
  private var thermal: [ThermalSample] = []
  private var sampler: Task<Void, Never>?
  private var thermalObserver: NSObjectProtocol?

  private init() {}

  // MARK: Intervals

  /// Measures `body` as a signpost interval and, while recording, keeps its duration under `name`.
  func measure<T>(_ name: StaticString, _ body: () async throws -> T) async rethrows -> T {
    let state = Self.signposter.beginInterval(name)
    let clock = ContinuousClock()
    let start = clock.now
    defer {
      Self.signposter.endInterval(name, state)
      record("\(name)", ms: Self.milliseconds(clock.now - start))
    }
    return try await body()
  }

  /// Keeps a duration measured elsewhere (for example launch → first frame from the process start time).
  func record(_ name: String, ms: Double) {
    guard recording, ms.isFinite, ms >= 0 else { return }
    durations[name, default: []].append(ms)
  }

  /// Emits a signpost event with no duration ("first-frame").
  nonisolated static func event(_ name: StaticString) {
    signposter.emitEvent(name)
  }

  static func milliseconds(_ d: Duration) -> Double {
    let (s, attos) = d.components
    return Double(s) * 1000 + Double(attos) / 1e15
  }

  // MARK: Memory and thermal

  /// Samples the footprint once a second and logs thermal changes while recording.
  private func startSampling() {
    guard sampler == nil else { return }
    noteThermal(ProcessInfo.processInfo.thermalState)
    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
    ) { _ in
      MainActor.assumeIsolated { PerfLog.shared.noteThermal(ProcessInfo.processInfo.thermalState) }
    }
    sampler = Task { [weak self] in
      while !Task.isCancelled {
        self?.sampleFootprint()
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  private func stopSampling() {
    sampler?.cancel()
    sampler = nil
    if let thermalObserver { NotificationCenter.default.removeObserver(thermalObserver) }
    thermalObserver = nil
  }

  /// Takes one footprint sample now.
  func sampleFootprint() {
    guard let f = Self.physFootprint() else { return }
    peakFootprint = max(peakFootprint ?? 0, f)
  }

  private func noteThermal(_ state: ProcessInfo.ThermalState) {
    let name = Self.thermalName(state)
    guard thermal.last?.state != name else { return }
    thermal.append(ThermalSample(at: Date.now.ISO8601Format(), state: name))
  }

  nonisolated static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
  }

  /// `task_vm_info.phys_footprint` of this process, in bytes (what jetsam counts).
  nonisolated static func physFootprint() -> UInt64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return kr == KERN_SUCCESS ? info.phys_footprint : nil
  }

  /// `os_proc_available_memory()`: bytes the process may still allocate before jetsam (0 when the system does not
  /// report it, as on the simulator).
  nonisolated static func availableMemory() -> UInt64 {
    UInt64(os_proc_available_memory())
  }

  /// When this process started (`kinfo_proc.p_starttime`), for launch → first-frame.
  nonisolated static func processStart() -> Date? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return nil }
    let tv = info.kp_proc.p_starttime
    return Date(timeIntervalSince1970: TimeInterval(tv.tv_sec) + TimeInterval(tv.tv_usec) / 1e6)
  }

  // MARK: Output

  /// Everything measured so far.
  var snapshot: PerfSnapshot {
    var summaries: [String: SignpostSummary] = [:]
    for (name, values) in durations where !values.isEmpty {
      let sorted = values.sorted()
      func pct(_ p: Double) -> Double { sorted[min(sorted.count - 1, Int((p * Double(sorted.count - 1)).rounded()))] }
      summaries[name] = SignpostSummary(count: sorted.count, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: sorted.last ?? 0)
    }
    return PerfSnapshot(signposts: summaries, peakPhysFootprint: peakFootprint, thermal: thermal)
  }

  /// Writes `Documents/Diagnostics/last-run.json`.
  func writeLastRun(to diagnostics: URL) throws {
    try FileManager.default.createDirectory(at: diagnostics, withIntermediateDirectories: true)
    let data = try DiagnosticsFiles.encoder.encode(snapshot)
    try data.write(to: diagnostics.appending(path: "last-run.json"), options: .atomic)
  }
}

/// Where diagnostics files live (§3.9) and how they are encoded.
nonisolated enum DiagnosticsFiles {
  /// `Documents/` (visible in Files and Finder; nothing precious).
  static var documents: URL { URL.documentsDirectory }
  /// `Documents/Diagnostics/`: probe.json, last-run.json, bgtasks.jsonl.
  static var diagnostics: URL { documents.appending(path: "Diagnostics", directoryHint: .isDirectory) }
  /// `Documents/selftest/`: one folder per self-test run, pulled by `Tools/device-check.sh`.
  static var selfTests: URL { documents.appending(path: "selftest", directoryHint: .isDirectory) }

  static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return e
  }

  /// Appends one JSON object as a line (for bgtasks.jsonl).
  static func appendLine<T: Encodable>(_ value: T, to file: URL) throws {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var line = try e.encode(value)
    line.append(0x0A)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: file) {
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: line)
    } else {
      try line.write(to: file, options: .atomic)
    }
  }
}
