// OWNER: N3
// The m1r snapshot for ScrollsQueryTests' snapshot suites: an APFS clone (`cp -c`) under $TMPDIR, made once per test
// process and opened read-only as a reference-profile database (InlineTextStore). Never opens a snapshot in place. The
// suites run when SCROLLS_QUERY_M1R=1 (Tools/check.d/read.sh sets it) and the snapshot exists; otherwise they are
// skipped, visibly.

import Foundation
import ScrollsStore
import Synchronization

enum M1R {
  static let snapshots = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SCROLLS_SNAPSHOTS"]
    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-snapshots").path)
  static let source = snapshots.appendingPathComponent("m1r/scrolls.db")

  /// Whether the snapshot suites run.
  static var enabled: Bool {
    ProcessInfo.processInfo.environment["SCROLLS_QUERY_M1R"] == "1" && FileManager.default.fileExists(atPath: source.path)
  }

  struct Failure: Error, CustomStringConvertible { let description: String }

  private static let made = Mutex<String?>(nil)

  /// A fresh clone of the snapshot (writable), for tests that change it.
  static func freshClone(_ name: String) throws -> String {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n3-tests")
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-7200)
    for entry in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] {
      let url = root.appendingPathComponent(entry)
      if let at = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date, at < cutoff { try? fm.removeItem(at: url) }
    }
    let dir = root.appendingPathComponent("\(name)-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(8))")
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let dst = dir.appendingPathComponent("scrolls.db")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = ["-c", source.path, dst.path]
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw Failure(description: "cp -c \(source.path) failed") }
    return dst.path
  }

  /// The shared read-only clone of this test process.
  static func clonePath() throws -> String {
    try made.withLock { m in
      if let m { return m }
      let p = try freshClone("m1r")
      m = p
      return p
    }
  }

  /// A read-only connection on the shared clone.
  static func open() throws -> Connection {
    try Connection(path: try clonePath(), mode: .readOnly, profile: .reference)
  }
}
