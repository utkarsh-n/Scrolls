// OWNER: N0
// Launch arguments (IOS-SPEC §4.17, §2.7, §6.6): `-ui-testing` (deterministic, contract fixtures, no bootstrap),
// `-tour`, `-tourStep n`, `-corpus cipher`, `-strand <word>`, `-renderer canvas`, `-perf`, `-selftest <suite>`,
// `-atlasRoot <name>`, `-fakeThermal 0|1|2|3`, `-fakeLowPower` (LabKit's argument names), and `-engine fixtures`
// (N0: run the shell on MockAtlas without trying the live engine). Unknown arguments are ignored, so the system's
// own (`-UIPreferredContentSizeCategoryName …`, XCTest's) pass through.

import Foundation

/// Which renderer draws the Scroll.
nonisolated enum RendererChoice: String, Sendable, Codable {
  case metal, canvas
}

/// Which engine serves the shell.
nonisolated enum EngineChoice: String, Sendable, Codable {
  /// LiveAtlas on the atlas root, falling back to the contract fixtures (with the reason shown) if it cannot open.
  case live
  /// MockAtlas: the 65 contract fixtures, labelled as fixtures everywhere they are shown.
  case fixtures
}

/// The device self-test suites (`Tools/device-check.sh`).
nonisolated enum SelfTestSuite: String, Codable, Sendable, CaseIterable {
  case probe
  case firstMinute = "first-minute"
  case journey, perf, packs, generation, background, full
}

nonisolated struct LaunchArgs: Sendable, Equatable {
  var uiTesting = false
  var tour = false
  var tourStep: Int?
  var corpus: String?
  var strand: String?
  var renderer: RendererChoice = .metal
  var perf = false
  var selfTest: SelfTestSuite?
  var atlasRoot: String?
  var fakeThermal: Int?
  var fakeLowPower = false
  var engine: EngineChoice = .live
  /// `-qwen-demo`: open "Qwen on this iPhone" and run the demonstration (Q bring-up, IOS-SPEC-QWEN §2.9).
  var qwenDemo = false
  /// `-selftest qwen`: open it and run S4–S7 (Documents/qwen-selftest.json).
  var qwenSelfTest = false
  /// Arguments that named a known flag but carried an unusable value, in words (shown in Diagnostics).
  var problems: [String] = []

  /// The engine actually requested: UI tests always run on fixtures.
  var effectiveEngine: EngineChoice { uiTesting ? .fixtures : engine }

  /// Parses `ProcessInfo.processInfo.arguments` (the first element, the executable path, is skipped).
  static func parse(_ args: [String]) -> LaunchArgs {
    var out = LaunchArgs()
    var i = args.isEmpty ? 0 : 1
    func value() -> String? {
      guard i + 1 < args.count, !args[i + 1].hasPrefix("-") || Int(args[i + 1]) != nil else { return nil }
      i += 1
      return args[i]
    }
    while i < args.count {
      let arg = args[i]
      switch arg {
      case "-ui-testing": out.uiTesting = true
      case "-tour": out.tour = true
      case "-tourStep":
        if let v = value(), let n = Int(v), n >= 0 { out.tourStep = n } else { out.problems.append("-tourStep needs a step number") }
      case "-corpus":
        if let v = value() { out.corpus = v } else { out.problems.append("-corpus needs a corpus slug") }
      case "-strand":
        if let v = value() { out.strand = v } else { out.problems.append("-strand needs a word") }
      case "-renderer":
        if let v = value(), let r = RendererChoice(rawValue: v) { out.renderer = r } else { out.problems.append("-renderer takes metal or canvas") }
      case "-perf": out.perf = true
      case "-selftest" where i + 1 < args.count && args[i + 1] == "qwen":
        out.qwenSelfTest = true
        i += 1
      case "-qwen-demo": out.qwenDemo = true
      case "-selftest":
        if let v = value(), let s = SelfTestSuite(rawValue: v) {
          out.selfTest = s
        } else {
          out.problems.append("-selftest takes one of \(SelfTestSuite.allCases.map(\.rawValue).joined(separator: ", "))")
        }
      case "-atlasRoot":
        if let v = value(), isSafeRootName(v) { out.atlasRoot = v } else { out.problems.append("-atlasRoot needs a plain folder name") }
      case "-fakeThermal":
        // LabKit's convention: no value means 2 (serious).
        if let v = value() { if let n = Int(v), (0...3).contains(n) { out.fakeThermal = n } else { out.problems.append("-fakeThermal takes 0–3") } } else { out.fakeThermal = 2 }
      case "-fakeLowPower": out.fakeLowPower = true
      case "-engine":
        if let v = value(), let e = EngineChoice(rawValue: v) { out.engine = e } else { out.problems.append("-engine takes live or fixtures") }
      default: break
      }
      i += 1
    }
    return out
  }

  /// A self-test root is a single folder name: no path separators, no dot-folders.
  static func isSafeRootName(_ name: String) -> Bool {
    !name.isEmpty && name.count <= 64 && !name.hasPrefix(".")
      && name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
  }

  /// The arguments as they would be typed, for Diagnostics and result files.
  var summary: [String] {
    var out: [String] = []
    if uiTesting { out.append("-ui-testing") }
    if tour { out.append("-tour") }
    if let tourStep { out.append("-tourStep \(tourStep)") }
    if let corpus { out.append("-corpus \(corpus)") }
    if let strand { out.append("-strand \(strand)") }
    if renderer != .metal { out.append("-renderer \(renderer.rawValue)") }
    if perf { out.append("-perf") }
    if let selfTest { out.append("-selftest \(selfTest.rawValue)") }
    if let atlasRoot { out.append("-atlasRoot \(atlasRoot)") }
    if let fakeThermal { out.append("-fakeThermal \(fakeThermal)") }
    if fakeLowPower { out.append("-fakeLowPower") }
    if engine != .live { out.append("-engine \(engine.rawValue)") }
    if qwenDemo { out.append("-qwen-demo") }
    if qwenSelfTest { out.append("-selftest qwen") }
    return out
  }
}
