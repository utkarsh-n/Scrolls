// OWNER: N2
// `scrolls-cli starter` (IOS-SPEC §3.3 slot 0, §3.6): the bundled starter atlas, built by this engine from nothing:
// the seeded vocabulary and corpora, then the SYNTHETIC demo world through the ordinary import path (`demo-load`: the
// demo pack written from the engine resources, slot-0 ids), then the demo's pipeline where this build has it (the tour's
// expressions tracked and materialized through AtlasService; a part that is not built yet is listed under `pending`,
// never faked). Output: a directory `starter.atlas/` holding `atlas.sqlite` (WAL checkpointed into it) and
// `ATLAS.json` (generation facts and the LogicalDump fingerprints the phone's G6 check compares with).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsSources
import ScrollsStore

enum StarterCommand: CLICommand {
  static let name = "starter"
  static let summary = "build the bundled starter atlas (demo world and its runs)"
  static let usage = """
    usage: scrolls-cli starter --out <starter.atlas> [--keep <work dir>]
      Builds slot 0 (seeded vocab, the demo world and its runs) into a new directory <starter.atlas>/ with atlas.sqlite
      and ATLAS.json, and prints a report as canonical JSON. --keep leaves the work root (Atlas/, Notebook/) for inspection.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args)
    let out = URL(fileURLWithPath: try a.required("out")).standardizedFileURL
    try AtlasLocation.refuseICloud(out)
    guard !FileManager.default.fileExists(atPath: out.path) else { throw UsageError("\(out.path) exists; remove it first") }
    let work = a.value("keep").map { URL(fileURLWithPath: $0) }
      ?? FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-starter-\(UUID().uuidString)")
    defer { if a.value("keep") == nil { try? FileManager.default.removeItem(at: work) } }
    let t0 = ContinuousClock.now
    let report = try await StarterBuild.build(root: work, into: out)
    var o = report
    o["seconds"] = .number(Double((ContinuousClock.now - t0).components.seconds))
    print(CanonicalJSON.string(.object(o)))
    return report["status"]?.stringValue == "built" ? 0 : 1
  }
}
