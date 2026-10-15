// OWNER: N2
// `scrolls-cli bench` (IOS-SPEC §2.7 `full`, §5): the engine's source-load timings on the Mac, in a temporary root:
// the starter built from nothing (seeded vocabulary + the demo world), then Cipher's bootstrap phases from that starter
// with the packs of --packs (default ~/Developer/scrolls-packs/current), each with the SPEC §6.8 reconciliation counts.
// Mac timings are proxies for the phone (the budgets are the A17 Pro's); timings never fail the gate, counts do.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import ScrollsStore

enum BenchCommand: CLICommand {
  static let name = "bench"
  static let summary = "engine timings"
  static let usage = """
    usage: scrolls-cli bench [--packs <dir>] [--through A|A2|B] [--json]
      Builds a starter, then runs Cipher's phases through the one named (default A2) on a temporary root; prints one
      row per timing and count (--json: canonical JSON). Exit 1 when a count differs from the reference's.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["json"])
    let packs = URL(fileURLWithPath: a.value("packs")
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-packs/current").path)
    guard let through = BootstrapCipher.Phase(rawValue: a.value("through") ?? "A2") else { throw UsageError("--through is A, A2 or B") }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-bench-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    var rows: [SourceCheck] = []
    let t0 = ContinuousClock.now
    let starter = root.appendingPathComponent("starter.atlas")
    let report = try await StarterBuild.build(root: root.appendingPathComponent("starter-work"), into: starter)
    rows.append(SourceCheck("starter (seeded vocabulary + demo world)", report["status"]?.stringValue == "built" ? .info : .fail,
                            String(format: "%.1f s", SourceSelfTest.seconds(ContinuousClock.now - t0))))
    PackLibrary.addSearchDirectory(packs)
    rows += await SourceSelfTest.bootstrap(root: root.appendingPathComponent("boot"), starter: starter, through: through,
                                           judgeTimings: false)
    if a.flag("json") {
      print(CanonicalJSON.string(.array(rows.map { .object(["name": .string($0.name), "status": .string($0.status.rawValue),
                                                            "detail": .string($0.detail)]) })))
    } else {
      for r in rows { print("\(r.status.rawValue.padding(toLength: 8, withPad: " ", startingAt: 0)) \(r.name): \(r.detail)") }
    }
    return rows.contains { $0.status == .fail } ? 1 : 0
  }
}
