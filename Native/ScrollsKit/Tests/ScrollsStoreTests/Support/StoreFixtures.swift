// OWNER: N0
// Shared helpers of ScrollsStoreTests: fresh atlases in $TMPDIR (never in iCloud), the Node reference tree of the
// build mirror (located from this file's path), the committed mini-database fixture, and DDL parsing.

import Foundation
import ScrollsCore
@testable import ScrollsStore
import Synchronization

enum Fixtures {
  /// Tests/ScrollsStoreTests (this file is in Support/).
  static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  /// …/Scrolls (the mirror's copy of the Node reference sits next to Native/).
  static let scrollsRoot = testsDir.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
  /// The committed mini-database fixture (LogicalDumpTests).
  static let miniDir = testsDir.appendingPathComponent("Fixtures/mini-dump")

  /// $TMPDIR/scrolls-n0b-tests, pruned of directories older than an hour (earlier runs; no run takes that long).
  static let root: URL = {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n0b-tests")
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-3600)
    for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] {
      let url = root.appendingPathComponent(name)
      if let made = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date, made < cutoff {
        try? fm.removeItem(at: url)
      }
    }
    return root
  }()

  /// A new empty directory under $TMPDIR.
  static func tempDir(_ label: String = "store") throws -> URL {
    let d = root.appendingPathComponent("\(label)-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  /// A freshly migrated (and seeded) atlas file; returns its path.
  static func atlas(_ profile: StoreProfile = .device, seed: Bool = true, label: String = "atlas") throws -> String {
    let path = try tempDir(label).appendingPathComponent("atlas.sqlite").path
    let c = try Connection(path: path, mode: .readWrite, profile: profile)
    try Migrations.migrate(c)
    if seed {
      try c.transaction(.immediate) {
        let tx = WriteTx(connection: c, label: "seed")
        try SeedVocab.seed(tx)
        try tx.ids.flush()
      }
    }
    c.close()
    return path
  }

  /// Every `CHECK (…)` of every table of `sqlite_master`, whitespace-normalised: [(table, expression)].
  static func checkConstraints(_ c: Connection) throws -> [(table: String, expr: String)] {
    let tables = try c.prepared(dynamic: "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE TABLE%' ORDER BY name")
      .all { ($0.text(0), $0.text(1)) }
    var out: [(String, String)] = []
    for (name, sql) in tables {
      let text = stripComments(sql)
      var search = text.startIndex
      while let r = text.range(of: "CHECK", range: search..<text.endIndex) {
        guard let open = text[r.upperBound...].firstIndex(of: "(") else { break }
        var depth = 0
        var close = open
        for i in text[open...].indices {
          if text[i] == "(" { depth += 1 } else if text[i] == ")" {
            depth -= 1
            if depth == 0 { close = i; break }
          }
        }
        out.append((name, normalize(String(text[text.index(after: open)..<close]))))
        search = text.index(after: close)
      }
    }
    return out
  }

  /// Every trigger name.
  static func triggers(_ c: Connection) throws -> [String] {
    try c.prepared(dynamic: "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all { $0.text(0) }
  }

  static func stripComments(_ sql: String) -> String {
    sql.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
      guard let r = line.range(of: "--") else { return line }
      return line[..<r.lowerBound]
    }.joined(separator: "\n")
  }

  static func normalize(_ s: String) -> String {
    s.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).joined(separator: " ")
  }

  /// A Writer + ReadPool on a fresh atlas. The readers map 8 MB each (not 256 MB): the mapping budget is process-wide
  /// and tests run in parallel.
  static func store(_ profile: StoreProfile = .device, readers: Int = 3) throws -> (path: String, writer: Writer, reads: ReadPool) {
    let path = try atlas(profile)
    return (path, try Writer(path: path, profile: profile),
            try ReadPool(path: path, profile: profile, size: readers, mmapBytesPerReader: 8 << 20))
  }

  /// A deterministic pseudo-random generator (mulberry32 of ScrollsCore).
  struct Random {
    var m: Mulberry32
    init(_ seed: UInt32) { m = Mulberry32(seed: seed) }
    mutating func next(_ n: Int) -> Int { Int(m.next() * Double(n)) }
  }
}

/// A lock-protected value that closures can share (Mutex itself cannot be captured by escaping closures).
final class Locked<Value: Sendable>: Sendable {
  private let m: Mutex<Value>
  init(_ v: Value) { m = Mutex(v) }
  func withLock<R>(_ body: (inout Value) -> R) -> R { m.withLock { body(&$0) } }
  var value: Value { m.withLock { $0 } }
}
