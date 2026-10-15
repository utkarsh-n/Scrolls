// OWNER: Q (created by the bring-up, B2)
// The app's Qwen host (IOS-SPEC-QWEN §2.1 `Scrolls/Qwen`): owns the MLX runtime (models pushed into
// Documents/Models/<name>/, sha-verified before any load), the memory guard, and the two bring-up runs —
// the live demonstration ("Qwen on this iPhone", -qwen-demo → Documents/qwen-demo.json + qwen-demo.png) and the
// self-test (-selftest qwen → Documents/qwen-selftest.json). Heavy work runs off the main actor; the screen observes.

import Foundation
import Observation
import OfflineIntelligence
import ScrollsQwen
import ScrollsQwenRuntime
import SwiftUI
import UIKit

@MainActor @Observable
final class QwenHost {
  private static var instance: QwenHost?
  static var shared: QwenHost {
    if let instance { return instance }
    let h = QwenHost()
    instance = h
    return h
  }
  /// nil until something used Qwen in this process (the scene-phase hook must not create the runtime).
  static var ifCreated: QwenHost? { instance }

  enum Phase: Equatable {
    case idle
    case running(String, Double?)
    case finished
  }

  let runtime: MLXQwenRuntime
  @ObservationIgnored let guardian: QwenMemoryGuard
  private(set) var models: [ModelStatus] = []
  private(set) var generationChoice: OfflineModelChoice
  private(set) var switchingModel = false
  private(set) var verifying = false
  private(set) var phase: Phase = .idle
  private(set) var demo: DemoReport?
  private(set) var demoSet: DemoSet?
  private(set) var selfTest: SelfTestReport?
  private(set) var written: [String] = []
  private(set) var problem: String?
  private(set) var events: [String] = []
  @ObservationIgnored private var work: Task<Void, Never>?
  @ObservationIgnored private var started = false

  private init() {
    let choice = OfflineModelChoice.persisted()
    generationChoice = choice
    runtime = MLXQwenRuntime(generationChoice: choice)
    guardian = QwenMemoryGuard(manager: runtime.manager)
    demoSet = Self.loadDemoSet()
    demo = Self.read(DemoReport.self, "qwen-demo.json")
    selfTest = Self.read(SelfTestReport.self, "qwen-selftest.json")
  }

  var info: RuntimeInfo { runtime.info }
  var isRunning: Bool { if case .running = phase { true } else { false } }

  func start() {
    guard !started else { return }
    started = true
    guardian.setOwnerCancellation { [weak self] in await self?.cancel() }
    guardian.start()
    let events = runtime.manager.events
    Task { [weak self] in
      for await e in events { self?.note(e) }
    }
    refreshModels()
  }

  private func note(_ e: ModelEvent) {
    let line: String = switch e {
    case .loading(let r): "loading \(r.rawValue)"
    case .resident(let r, let delta, let s): String(format: "%@ resident in %.2f s (footprint +%@)", r.rawValue, s, QwenCopy.mb(delta))
    case .unloaded(let r, let why, let after): "\(r.rawValue) unloaded (\(why.rawValue)); footprint \(after.map(QwenCopy.mb) ?? "n/a")"
    case .paused(let t): "thermal \(t.word): work restricted"
    case .refused(let r, let needed, let available): QwenCopy.refused(role: r, needed: needed, available: available)
    }
    events.append(line)
    if events.count > 40 { events.removeFirst(events.count - 40) }
  }

  // MARK: models

  func refreshModels(force: Bool = false) {
    guard !verifying else { return }
    verifying = true
    let store = runtime.store
    Task.detached(priority: .userInitiated) {
      let statuses = ScrollsQwen.ModelCatalog.all.map { store.verify($0, force: force) }
      await MainActor.run {
        QwenHost.shared.models = statuses
        QwenHost.shared.verifying = false
      }
    }
  }

  func selectGenerationChoice(_ choice: OfflineModelChoice) {
    guard !isRunning, !switchingModel, choice != generationChoice else { return }
    switchingModel = true
    let runtime = runtime
    Task {
      do {
        try await runtime.setGenerationChoice(choice)
        choice.persist()
        generationChoice = choice
        refreshModels()
      } catch {
        problem = "Could not switch the text model: \(error.localizedDescription)"
      }
      switchingModel = false
    }
  }

  // MARK: runs

  func runDemo() {
    guard !isRunning, !switchingModel else { return }
    guard let set = demoSet else { problem = "bank-demo.json is missing from the app bundle"; return }
    problem = nil
    phase = .running("Starting…", nil)
    let runtime = runtime
    let build = Self.appBuild
    work = Task.detached(priority: .userInitiated) {
      let report = await QwenDemoRunner.run(set: set, runtime: runtime, appBuild: build) { s in
        Task { @MainActor in QwenHost.shared.phase = .running(s.text, s.fraction) }
      }
      await MainActor.run { QwenHost.shared.finishDemo(report, set: set) }
    }
  }

  private func finishDemo(_ report: DemoReport, set: DemoSet) {
    demo = report
    phase = .finished
    work = nil
    var files: [String] = []
    let json = URL.documentsDirectory.appendingPathComponent("qwen-demo.json")
    do {
      try ReportFile.write(report, to: json)
      files.append("Documents/qwen-demo.json")
    } catch {
      problem = "could not write qwen-demo.json: \(error)"
    }
    if QwenSnapshot.write(report: report, set: set, to: URL.documentsDirectory.appendingPathComponent("qwen-demo.png")) {
      files.append("Documents/qwen-demo.png")
    }
    written = files
    refreshModels()
  }

  func runSelfTest() {
    guard !isRunning, !switchingModel else { return }
    guard let set = demoSet else { problem = "bank-demo.json is missing from the app bundle"; return }
    problem = nil
    phase = .running("Self-test…", nil)
    let runtime = runtime
    let build = Self.appBuild
    let parity = Self.loadParity()
    work = Task.detached(priority: .userInitiated) {
      let report = await QwenSelfTest.run(demo: set, parity: parity, runtime: runtime, appBuild: build) { s in
        Task { @MainActor in QwenHost.shared.phase = .running(s.text, s.fraction) }
      }
      await MainActor.run { QwenHost.shared.finishSelfTest(report) }
    }
  }

  private func finishSelfTest(_ report: SelfTestReport) {
    selfTest = report
    phase = .finished
    work = nil
    do {
      try ReportFile.write(report, to: URL.documentsDirectory.appendingPathComponent("qwen-selftest.json"))
      written = ["Documents/qwen-selftest.json"]
    } catch {
      problem = "could not write qwen-selftest.json: \(error)"
    }
  }

  func cancel() {
    work?.cancel()
  }

  func unloadNow() {
    let runtime = runtime
    Task { await runtime.unload(.user) }
  }

  /// Background: stop at the next boundary and unload inside a background task (§2.6).
  func enteredBackground() {
    work?.cancel()
    let app = UIApplication.shared
    let box = BackgroundTaskBox()
    box.id = app.beginBackgroundTask(withName: "qwen-unload") { app.endBackgroundTask(box.id) }
    let runtime = runtime
    Task {
      await runtime.unload(.background)
      app.endBackgroundTask(box.id)
    }
  }

  // MARK: resources and files

  static var appBuild: String {
    let b = Bundle.main
    return "Scrolls \(b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(b.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))"
  }

  static func resource(_ name: String) -> URL? {
    if let folder = Bundle.main.url(forResource: "Qwen", withExtension: nil) {
      let u = folder.appendingPathComponent(name)
      if FileManager.default.fileExists(atPath: u.path) { return u }
    }
    let ns = name as NSString
    return Bundle.main.url(forResource: ns.deletingPathExtension, withExtension: ns.pathExtension)
  }

  static func loadDemoSet() -> DemoSet? {
    resource("bank-demo.json").flatMap { try? DemoSet.load($0) }
  }

  static func loadParity() -> ParitySample? {
    resource("qwen-parity.json").flatMap { try? JSONDecoder().decode(ParitySample.self, from: Data(contentsOf: $0)) }
  }

  static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
    let url = URL.documentsDirectory.appendingPathComponent(name)
    return (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
  }
}

private final class BackgroundTaskBox: @unchecked Sendable {
  var id: UIBackgroundTaskIdentifier = .invalid
}
