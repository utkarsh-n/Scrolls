// OWNER: N0
// Device self-tests (IOS-SPEC §2.7, §6.6, §8.4.10 item 4). A suite is a list of steps; each step returns rows
// {name, status, detail}. N0's steps here are the M0 probe: the engine's own probe (`Store/Probe.swift`: SQLite version
// and compile options, FTS5 tokenizer parity, rtree_i32, JSON1, contentless_delete, the Final_Sigma fold, sentence
// hashes of sample books, memory and the largest file mapping), then what only the app can check: sentence breaks on
// this OS's ICU against the Node reference, the Kohinoor faces, NaturalLanguage availability, the background-task
// identifiers, the display and the self-test isolation. Every other package adds its steps in its own
// `Diagnostics/Steps/<Pkg>Steps.swift` by declaring its member of `SelfTestCatalog` (see there); this file never
// needs editing for that. A row that cannot run here is PENDING with its reason — never PASS.

import Darwin
import NaturalLanguage
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore
import UIKit

/// One result row (`result.json` rows).
nonisolated struct SelfTestRow: Codable, Sendable, Equatable, Identifiable {
  enum Status: String, Codable, Sendable {
    case pass = "PASS", fail = "FAIL", pending = "PENDING", info = "INFO", skip = "SKIP"
  }
  var name: String
  var status: Status
  var detail: String

  var id: String { name }

  static func pass(_ name: String, _ detail: String) -> SelfTestRow { SelfTestRow(name: name, status: .pass, detail: detail) }
  static func fail(_ name: String, _ detail: String) -> SelfTestRow { SelfTestRow(name: name, status: .fail, detail: detail) }
  static func pending(_ name: String, _ detail: String) -> SelfTestRow { SelfTestRow(name: name, status: .pending, detail: detail) }
  static func info(_ name: String, _ detail: String) -> SelfTestRow { SelfTestRow(name: name, status: .info, detail: detail) }
}

/// What a step can use.
@MainActor
struct SelfTestContext {
  let model: AppModel
  let suite: SelfTestSuite
  /// `Documents/selftest/<run>/`: a step may leave files here; they are copied back with result.json.
  let runDirectory: URL
}

/// A named step of a suite.
struct SelfTestStep {
  let name: String
  let run: @MainActor (SelfTestContext) async -> [SelfTestRow]

  init(_ name: String, run: @escaping @MainActor (SelfTestContext) async -> [SelfTestRow]) {
    self.name = name
    self.run = run
  }
}

/// A package's steps for each suite (one conformer per package, `Diagnostics/Steps/<Pkg>Steps.swift`).
@MainActor protocol SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep]
}

/// The packages' step providers. A package registers by declaring its member in an extension of `SelfTestCatalog`
/// in its own Steps file, for example `extension SelfTestCatalog { static var n3: (any SelfTestSteps.Type)? { N3Steps.self } }`;
/// a member on the concrete type takes precedence over the `nil` default below.
struct SelfTestCatalog: SelfTestCatalogDefaults {
  /// N0 first, then the packages in merge order (§8.6).
  static var providers: [(package: String, steps: (any SelfTestSteps.Type)?)] {
    [("N0", N0Steps.self), ("N1", n1), ("N2", n2), ("N3", n3), ("N4", n4), ("N5", n5), ("N6", n6), ("N7", n7), ("N8", n8),
     ("I", integrator)]
  }

  /// Every registered step of a suite; `full` runs every suite's steps.
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    let suites = suite == .full ? SelfTestSuite.allCases.filter { $0 != .full } : [suite]
    return suites.flatMap { s in providers.compactMap(\.steps).flatMap { $0.steps(for: s) } }
  }
}

@MainActor protocol SelfTestCatalogDefaults {}
extension SelfTestCatalogDefaults {
  static var n1: (any SelfTestSteps.Type)? { nil }
  static var n2: (any SelfTestSteps.Type)? { nil }
  static var n3: (any SelfTestSteps.Type)? { nil }
  static var n4: (any SelfTestSteps.Type)? { nil }
  static var n5: (any SelfTestSteps.Type)? { nil }
  static var n6: (any SelfTestSteps.Type)? { nil }
  static var n7: (any SelfTestSteps.Type)? { nil }
  static var n8: (any SelfTestSteps.Type)? { nil }
  static var integrator: (any SelfTestSteps.Type)? { nil }
}

/// N0's steps: the probe suite, the stall rule in the perf suite, and the engine and isolation rows every suite
/// starts with.
enum N0Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    let common = [SelfTestStep("environment", run: environment), SelfTestStep("isolation", run: isolation)]
    switch suite {
    case .probe: break
    case .perf: return common + [SelfTestStep("engine steps", run: engineSteps), SelfTestStep("stall rule", run: stallRule)]
    default: return common + [SelfTestStep("engine steps", run: engineSteps)]
    }
    return common + [
      SelfTestStep("engine probe", run: engineProbe),
      SelfTestStep("engine timings", run: engineTimings),
      SelfTestStep("sentence breaks", run: sentenceBreaks),
      SelfTestStep("Indic faces", run: indicFaces),
      SelfTestStep("NaturalLanguage", run: naturalLanguage),
      SelfTestStep("background tasks", run: backgroundTasks),
      SelfTestStep("display", run: display),
    ]
  }

  // MARK: Engine

  static func environment(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    var rows = [SelfTestRow.info("device", "\(Device.modelIdentifier) · iOS \(UIDevice.current.systemVersion)")]
    rows.append(.info("build", "Scrolls \(Bundle.main.shortVersion) (\(Bundle.main.buildNumber)) · engine \(BuildInfo.engineVersion) · commit \(BuildInfo.gitCommit.prefix(12))"))
    rows.append(.info("engine", ctx.model.engine.description))
    #if targetEnvironment(simulator)
      rows.append(.info("simulator", "run on the simulator: timings, memory and thermal rows are proxies, not device measurements"))
    #endif
    return rows
  }

  /// Self-tests never write into his notebook or his atlas (N-22, §6.6).
  static func isolation(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    switch ctx.model.engine.kind {
    case .fixtures:
      return [.pass("isolation", "contract fixtures (MockAtlas): nothing is written")]
    case .live(let root):
      if let root, ctx.model.launch.atlasRoot != nil {
        return [.pass("isolation", "isolated atlas root \(root)")]
      }
      return [.fail("isolation", "the self-test ran on the live atlas; device suites must run with -atlasRoot")]
    case .unavailable(let reason):
      return [.pending("isolation", "no engine open: \(reason)")]
    }
  }

  /// The engine's probe: through `AtlasPlatform` when a live atlas is open, otherwise run in process without an
  /// atlas (it opens only an in-memory database). With `measureVM` it also maps the 256 MB windows (§3.8).
  static func engineProbe(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    await ctx.model.engineHost.probeRows()
  }

  /// The Store and Jobs device rows (§8.4.10 item 2): a cancelled read and a cancelled job acknowledged ≤ 500 ms,
  /// QUERY_TIMEOUT at a 300 ms deadline, and the decode cost of a 32,768-unit chunk of a bundled book, each measured in
  /// a scratch atlas under the temporary directory (never his atlas).
  static func engineTimings(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let book = EngineLaunchOptions.bundledProbeSamples?.appending(path: "en-third-class-in-indian-railways.txt")
    let sample = book.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    return await EngineSelfTest.acknowledgements(in: FileManager.default.temporaryDirectory, sample: sample)
      .map(EngineHost.row)
  }

  /// The stall rule (§3.7): one 30 s SQL statement in a job advances its progress at least 15 times, never standing
  /// still for 2 s.
  static func stallRule(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    await EngineSelfTest.stallRule(in: FileManager.default.temporaryDirectory, seconds: 30).map(EngineHost.row)
  }

  /// The engine's own steps of a suite (`AtlasPlatform.runSelfTest`), when a live atlas is open.
  static func engineSteps(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    await ctx.model.engineHost.engineSteps(ctx.suite)
  }

  // MARK: Text parity on this OS's ICU

  /// Sentence starts (`SentenceBreaker`, NSString enclosing ranges + the ।/॥ pass) against Node's Intl.Segmenter on the
  /// 45 edge cases of the committed golden family g1.sentences (MANIFEST reference_commit 10c23d1). On the phone this
  /// checks iOS's ICU, which the Mac goldens cannot (DV-3).
  static func sentenceBreaks(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    var mismatches: [String] = []
    for (text, expected) in SentenceGolden.edgeCases {
      let got = SentenceBreaker.starts(text)
      if got != expected { mismatches.append("\(text.prefix(24))…: \(got) ≠ \(expected)") }
    }
    let n = SentenceGolden.edgeCases.count
    return [mismatches.isEmpty
      ? .pass("sentence breaks", "\(n)/\(n) golden edge cases equal Node's Intl.Segmenter")
      : .fail("sentence breaks", "\(n - mismatches.count)/\(n) equal; first: \(mismatches.prefix(3).joined(separator: " · "))")]
  }

  // MARK: Fonts and languages

  /// Kohinoor Devanagari and Gujarati for the passage cascade (§4.20); a missing face falls back to the system cascade.
  static func indicFaces(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    Typography.indicFaces.map { face in
      Typography.faceExists(face)
        ? .pass("font \(face)", "installed")
        : .info("font \(face)", "missing: the system cascade is used for this script")
    }
  }

  /// Apple's English sentiment model and word embedding (the Tone gate, §4.10). Absence is information, not failure.
  static func naturalLanguage(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let sentiment = NLTagger.availableTagSchemes(for: .paragraph, language: .english).contains(.sentimentScore)
    let embedding = NLEmbedding.wordEmbedding(for: .english) != nil
    return [
      .info("NL sentiment (en)", sentiment ? "available" : "not on this device (Tone shows its gate card)"),
      .info("NL word embedding (en)", embedding ? "available" : "not on this device (modern-reader neighbours gated)"),
    ]
  }

  // MARK: Background tasks and display

  static func backgroundTasks(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    let wanted = [BackgroundTasks.maintenanceIdentifier, BackgroundTasks.jobIdentifierPattern]
    let missing = wanted.filter { !permitted.contains($0) }
    var rows = [missing.isEmpty
      ? SelfTestRow.pass("BG identifiers", wanted.joined(separator: ", "))
      : SelfTestRow.fail("BG identifiers", "missing from Info.plist: \(missing.joined(separator: ", "))")]
    rows.append(BackgroundTasks.maintenanceRegistered
      ? .pass("BG maintenance handler", "registered at launch")
      : .fail("BG maintenance handler", "not registered"))
    return rows
  }

  static func display(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
      return [.pending("display", "no window scene")]
    }
    let screen = scene.screen
    let insets = scene.windows.first?.safeAreaInsets ?? .zero
    let size = screen.bounds.size
    return [.info("display", "\(Int(size.width)) × \(Int(size.height)) pt @\(Int(screen.scale))x · max \(screen.maximumFramesPerSecond) fps · safe area \(Int(insets.top))/\(Int(insets.bottom))")]
  }
}

/// Byte counts in words ("1.2 GiB", "512 MiB").
nonisolated enum ByteCount {
  static func text(_ bytes: UInt64) -> String {
    let units = ["B", "KiB", "MiB", "GiB", "TiB"]
    var value = Double(bytes)
    var i = 0
    while value >= 1024, i < units.count - 1 {
      value /= 1024
      i += 1
    }
    return i == 0 ? "\(bytes) B" : "\(Format.number(value)) \(units[i])"
  }
}

/// This device's model identifier ("iPhone16,2").
nonisolated enum Device {
  static var modelIdentifier: String {
    #if targetEnvironment(simulator)
      if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return "\(sim) (simulator)" }
    #endif
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
  }
}

nonisolated extension Bundle {
  var shortVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
  var buildNumber: String { object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }
}

/// Node's sentence starts for the golden edge cases (UTF-16 offsets), copied from
/// Native/ScrollsKit/Tests/DifferentialTests/Golden/g1.sentences/cases-0000.jsonl (source "edge"). Regenerate this
/// table from that file when the family changes; never edit a case by hand.
nonisolated enum SentenceGolden {
  static let edgeCases: [(String, [Int])] = [
    ("Hello there. Mr. Smith went to Washington. He said \"Hi!\" Then left.  Next one…\nNew line here", [13, 17, 43, 57, 69, 79]),
    ("One. Two. Three.", [5, 10]),
    ("No terminator", []),
    ("Ends with space. ", []),
    ("  Leading spaces. Then more.", [18]),
    ("e.g. this is fine. i.e. ok.", []),
    ("The U.S.A. is large. It is.", [21]),
    ("Pi is 3.14. Yes.", [12]),
    ("What? Really! Yes.", [6, 14]),
    ("He said: “Go.” She went.", [15]),
    ("It's 5 p.m. Now.", [12]),
    ("Line one\nLine two\n\nParagraph two. Done.", [9, 18, 19, 34]),
    ("Ellipsis... then text. More…", [23]),
    ("Dr. No. Mr. Yes.", [4, 8, 12]),
    ("(Parens.) After.", [10]),
    ("राम घर गया। सीता आई॥ फिर क्या?", [11, 12, 20, 21]),
    ("એક। બે॥ ત્રણ.", [3, 4, 7, 8]),
    ("।।॥ start dandas", [3, 4]),
    ("end dandas ।॥", []),
    ("mixed। English. हिन्दी।", [6, 7, 16]),
    ("中文句子。第二句！第三句？", [5, 9]),
    ("Árbol. Ñandú. ¿Qué? ¡Sí!", [7, 14, 20]),
    ("Ça va. Très bien.", [7]),
    ("Number 1. Number 2.", [10]),
    ("A.B.C. D.", [7]),
    ("Quote ends.\"\nNext", [13]),
    ("Tabs.\tNext.", [6]),
    ("Form\u{c}feed. Next.", [11]),
    ("Emoji 🙂. Next.", [10]),
    ("", []),
    (".", []),
    ("।", []),
    (" ", []),
    ("a", []),
    ("a.", []),
    ("a. b", []),
    ("CHAPTER I.\n\nIt was a dark night. The end.", [11, 12, 33]),
    ("Sentence one.Sentence two.", []),
    ("Lower. lower case after.", []),
    ("Vol. 3. Page 4.", [5, 8]),
    ("St. Paul. St. Peter.", [4, 10, 14]),
    ("one.\u{2028}two.", [5]),
    ("x\u{85}y. z.", [2]),
    ("ΟΔΟΣ. ΣΑΣ.", [6]),
    ("Was it? It was.", [8]),
  ]
}
