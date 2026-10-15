// OWNER: N2
// The engine half of N2's self-test steps (IOS-SPEC §2.7, §8.5 N2 acceptance), so the device rows are commands and the
// same code runs on the Mac in tests: each check builds in an isolated root of its own (never his atlas or notebook,
// §6.6) from the starter and packs bundled with this build.
//   bootstrap   Cipher phases A, A2 (and B when asked) from the starter, timed against their budgets (60 s; A2 by 90 s
//               after the start; B 20 min), then the reconciliation counts of SPEC §6.8 checked exactly;
//   resume      phase B suspended mid-way (as when he leaves the app) and resumed: no document twice, nothing lost;
//   starter     the starter rebuilt here = the bundled one, table by table (G6 for slot 0).
// A timing is judged only where `judgeTimings` says so (the device); elsewhere it is INFO — a proxy, never a device
// measurement. A row that cannot run here is PENDING with its reason, never PASS.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsSources
import ScrollsStore

/// One self-test row.
public struct SourceCheck: Sendable, Equatable {
  public enum Status: String, Sendable { case pass = "PASS", fail = "FAIL", info = "INFO", pending = "PENDING" }
  public var name: String
  public var status: Status
  public var detail: String

  public init(_ name: String, _ status: Status, _ detail: String) {
    self.name = name
    self.status = status
    self.detail = detail
  }
}

public enum SourceSelfTest {
  /// The budgets of §3.6 / §8.5 N2 (seconds).
  public static let phaseABudget = 60.0
  public static let phaseA2Budget = 90.0
  public static let phaseBBudget = 20.0 * 60

  /// The reconciliation counts of SPEC §6.8 (tests/cipher-mapping.test.mjs), as the frozen reference produced them.
  public static let expectedWorks = (documents: 94_385, undated: 8_227, scheduled: 28)
  public static let expectedEtymology = (etymons: 54_989, chain: 704, variants: 351, unresolved: 1_170)
  public static let expectedGutenberg = (documents: 691, aliases: 2, lifetimeEstimates: 116, undated: 8)
  public static let expectedWikisource = (hi: 450, gu: 375, hiUndated: 42, guUndated: 172)

  public static func seconds(_ d: Duration) -> Double { Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 }

  static func timing(_ name: String, _ s: Double, budget: Double, judge: Bool, _ detail: String) -> SourceCheck {
    let text = String(format: "%.1f s (budget %.0f s) · %@", s, budget, detail)
    if !judge { return SourceCheck(name, .info, "proxy, not a device measurement: \(text)") }
    return SourceCheck(name, s <= budget ? .pass : .fail, text)
  }

  static func exact(_ name: String, _ got: Int, _ want: Int) -> SourceCheck {
    SourceCheck(name, got == want ? .pass : .fail, "\(Format.int(got)) (reference \(Format.int(want)))")
  }

  static func atLeast(_ name: String, _ got: Int, _ floor: Int, _ note: String) -> SourceCheck {
    SourceCheck(name, got >= floor ? .pass : .fail, "\(Format.int(got)) (≥ \(Format.int(floor)): \(note))")
  }

  /// Runs Cipher's phases from `starter` in a fresh root under `root`; `through` the last phase to run.
  public static func bootstrap(root: URL, starter: URL, through last: BootstrapCipher.Phase, judgeTimings: Bool,
                               conditions: any DeviceConditionsSource = Unthrottled()) async -> [SourceCheck] {
    let engine: AtlasEngine
    let location: AtlasLocation
    do {
      location = try AtlasLocation.at(root: root)
      engine = try await AtlasEngine.open(location, origin: .starter(starter), conditions: conditions)
    } catch {
      return [SourceCheck("bootstrap", .fail, "the self-test atlas did not open: \(error)")]
    }
    let rows = await phases(engine, location, through: last, judgeTimings: judgeTimings)
    await engine.close()
    return rows
  }

  static func phases(_ engine: AtlasEngine, _ location: AtlasLocation, through last: BootstrapCipher.Phase,
                     judgeTimings: Bool) async -> [SourceCheck] {
    var rows: [SourceCheck] = []
    do {
      let t0 = ContinuousClock.now
      var ended: [BootstrapCipher.Phase: Duration] = [:]
      for phase in BootstrapCipher.Phase.allCases {
        let files = try await PackLibrary.files(phase.packs, atlasPath: location.atlasPath)
        let snap = try await engine.run(JobSpec(type: BootstrapCipher.type, params: ["phase": .string(phase.rawValue)],
                                                priority: phase.priority, journal: BootstrapCipher.journalOp(phase, files: files)))
        ended[phase] = ContinuousClock.now - t0
        guard snap.status == .succeeded else {
          rows.append(SourceCheck("phase \(phase.rawValue)", .fail,
                                  "\(snap.status.rawValue): \(snap.error?.message ?? snap.message ?? "no message")"))
          return rows
        }
        if phase == last { break }
      }
      if let a = ended[.a] { rows.append(timing("phase A (metadata)", seconds(a), budget: phaseABudget, judge: judgeTimings, "starter → titles, relations, etymology ready")) }
      if let a2 = ended[.a2] { rows.append(timing("phase A2 (genealogy) since start", seconds(a2), budget: phaseA2Budget, judge: judgeTimings, "A + A2")) }
      if let b = ended[.b], let a2 = ended[.a2] {
        rows.append(timing("phase B (full text)", seconds(b - a2), budget: phaseBBudget, judge: judgeTimings, "1,516 books + FTS merge + boilerplate pass"))
      }
      let metrics = try await engine.read { c in try BootstrapPhases.reconcile(c, expected: nil) }
      rows += reconciliation(metrics, through: last)
      let state = try await engine.read { try BootstrapCipher.state($0) }
      if last == .b, let b = state["boilerplate"]?["status"]?.stringValue, b != "done" {
        rows.append(SourceCheck("boilerplate pass", .pending, state["boilerplate"]?["reason"]?.stringValue ?? b))
      }
    } catch {
      rows.append(SourceCheck("bootstrap", .fail, "\(error)"))
    }
    return rows
  }

  /// The §6.8 counts of the phases that ran.
  static func reconciliation(_ m: JSONValue, through last: BootstrapCipher.Phase) -> [SourceCheck] {
    func n(_ path: String...) -> Int {
      var v: JSONValue? = m
      for k in path { v = v?[k] }
      return v?.safeInteger ?? 0
    }
    var rows = [
      exact("works", n("works", "documents"), expectedWorks.documents),
      exact("works undated", n("works", "undated"), expectedWorks.undated),
      exact("works scheduled", n("works", "scheduled"), expectedWorks.scheduled),
      exact("etymon families", n("etymology", "etymons"), expectedEtymology.etymons),
      exact("etymology listed_chain", n("etymology", "by_semantics", "listed_chain"), expectedEtymology.chain),
      exact("etymology listed_variants", n("etymology", "by_semantics", "listed_variants"), expectedEtymology.variants),
      exact("etymology listed_unresolved", n("etymology", "by_semantics", "listed_unresolved"), expectedEtymology.unresolved),
      atLeast("theme associations", n("themes", "associations"), 1, "loaded"),
    ]
    if last != .a {
      rows.append(atLeast("music relation endpoints", n("music_relations", "documents"), 150_000, "reference 179,005"))
      rows.append(atLeast("endpoints aliased onto works", n("music_relations", "aliases_on_works"), 10_000, "aliases, not copies"))
      rows.append(exact("music relations not documented", n("music_relations", "non_documented"), 0))
    }
    if last == .b {
      rows.append(exact("Gutenberg books", n("gutenberg", "documents"), expectedGutenberg.documents))
      rows.append(exact("Gutenberg aliases", n("gutenberg", "aliases"), expectedGutenberg.aliases))
      rows.append(exact("Gutenberg lifetime estimates", n("gutenberg", "lifetime_estimates"), expectedGutenberg.lifetimeEstimates))
      rows.append(exact("Gutenberg undated", n("gutenberg", "undated"), expectedGutenberg.undated))
      rows.append(atLeast("French translations flagged", n("gutenberg", "translations", "fr"), 90, "SPEC §6.8"))
      rows.append(exact("licence canary in ok passages", n("gutenberg", "canary_ok_passages"), 0))
      rows.append(exact("Wikisource hi", n("wikisource_hi", "documents"), expectedWikisource.hi))
      rows.append(exact("Wikisource gu", n("wikisource_gu", "documents"), expectedWikisource.gu))
      rows.append(exact("Wikisource hi undated", n("wikisource_hi", "undated"), expectedWikisource.hiUndated))
      rows.append(exact("Wikisource gu undated", n("wikisource_gu", "undated"), expectedWikisource.guUndated))
    }
    return rows
  }

  /// The starter rebuilt in `root` against the bundled one (`bundled` = starter.atlas/): ATLAS.json fingerprints equal
  /// table by table (G6 for slot 0).
  public static func starterParity(root: URL, bundled: URL) async -> [SourceCheck] {
    do {
      let want = try GenerationManifest.read(at: bundled.appendingPathComponent(GenerationManifest.fileName))
      let out = root.appendingPathComponent("starter.atlas")
      let t0 = ContinuousClock.now
      let report = try await StarterBuild.build(root: root.appendingPathComponent("work"), into: out)
      let took = seconds(ContinuousClock.now - t0)
      guard report["status"]?.stringValue == "built" else {
        return [SourceCheck("starter rebuilt here", .fail, CanonicalJSON.string(.object(report)))]
      }
      let got = try GenerationManifest.read(at: out.appendingPathComponent(GenerationManifest.fileName))
      let differ = got.differingTables(want)
      var rows = [SourceCheck("starter rebuilt here", .info, String(format: "%.1f s; %d tables fingerprinted", took, got.fingerprints.count))]
      rows.append(SourceCheck("starter here = bundled (G6, slot 0)", differ.isEmpty ? .pass : .fail,
                              differ.isEmpty ? "\(got.fingerprints.count) tables equal (LogicalDump sha256)"
                                : "differ: \(differ.joined(separator: ", "))"))
      return rows
    } catch {
      return [SourceCheck("starter rebuilt here", .fail, "\(error)")]
    }
  }
}
