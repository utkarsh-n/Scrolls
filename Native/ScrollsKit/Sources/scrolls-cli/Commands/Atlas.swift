// OWNER: N2 — stub written by N0
// `scrolls-cli atlas`: IOS-SPEC §3.5: `atlas build --starter … --packs … --notebook <pulled Notebook/> --out …`
// replays the same inputs the phone replays (G6), and writes .scrollsatlas / .scrollsarchive with ATLAS.json. Answers
// NOT_IMPLEMENTED until N2 lands it; the owner replaces `run` here and nowhere else.

import Foundation
import ScrollsContracts

enum AtlasCommand: CLICommand {
  static let name = "atlas"
  static let summary = "build a generation from a starter, packs and a pulled notebook"
  static let usage = "usage: scrolls-cli atlas build --starter <atlas> --packs <dir> --notebook <Notebook dir> --out <x.scrollsatlas>"

  static func run(_ args: [String]) async throws -> Int32 {
    throw ScrollsError.notImplemented(area: "scrolls-cli atlas (package N2)")
  }
}
