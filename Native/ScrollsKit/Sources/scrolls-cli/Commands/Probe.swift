// OWNER: N0
// `scrolls-cli probe`: the engine probe on this Mac (IOS-SPEC §1.4): SQLite version and compile options, FTS5 tokenizer
// parity, rtree_i32, JSON1, contentless_delete, sentence breaks, memory. The phone runs the same checks in
// `-selftest probe`; comparing the two is how a device mismatch is found.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

enum ProbeCommand: CLICommand {
  static let name = "probe"
  static let summary = "the engine probe on this Mac (SQLite, FTS5 parity, sentence breaks, memory)"
  static let usage = """
    usage: scrolls-cli probe [--texts <dir>] [--vm] [--json]
      --texts  a directory of sample texts whose sentence-break digests are compared (the bundled probe books)
      --vm     also measure the largest total file mapping (slow: maps 256 MB windows of a sparse file)
      --json   print the ProbeReport as JSON instead of a table
      Exit code 0 when every check passes, 1 otherwise.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["vm", "json"])
    let texts = a.value("texts").map { URL(fileURLWithPath: $0) }
    let report = Probe.run(sampleTexts: texts, measureVM: a.flag("vm"))
    if a.flag("json") {
      print(String(decoding: try ScrollsJSON.data(report), as: UTF8.self))
    } else {
      print("SQLite \(report.sqliteVersion) · ICU \(report.icuVersion)")
      for c in report.checks {
        print("\(c.status.rawValue.padding(toLength: 5, withPad: " ", startingAt: 0)) \(c.name): \(c.detail)")
      }
      print(report.passed ? "PASS" : "FAIL: \(report.failures)")
    }
    return report.passed ? 0 : 1
  }
}
