// OWNER: N0
// IOS-SPEC §1.2 rule 2: under NonisolatedNonsendingByDefault a plain `nonisolated async` function runs on its caller's
// actor, so a kernel called from the main actor would block the UI. Every kernel (materialize, tiles, cube build,
// compare, k-means, rSVD, cooc, winnow, layout, display build) starts with `EngineAssert.offMain()`.

import Foundation

/// Debug-build guards for engine invariants.
public enum EngineAssert {
  /// Traps in Debug builds when called on the main thread. Free in Release.
  @inline(__always)
  public static func offMain(_ file: StaticString = #fileID, _ line: UInt = #line) {
    #if DEBUG
      precondition(!Thread.isMainThread, "engine kernel called on the main thread", file: file, line: line)
    #endif
  }
}
