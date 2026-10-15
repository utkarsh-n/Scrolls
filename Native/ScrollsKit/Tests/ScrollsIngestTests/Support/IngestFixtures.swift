// OWNER: N1
// Shared helpers of ScrollsIngestTests: fresh atlases in $TMPDIR (never in iCloud), the golden families of N1
// (committed under Tests/DifferentialTests/Golden, private ones under ~/Developer/scrolls-golden/<ref>/private), the
// reference tree of the build mirror (located from this file's path), and a writer on a fresh lease.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsIngest
import ScrollsStore

enum IngestFixtures {
  /// Tests/ScrollsIngestTests (this file is in Support/).
  static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  /// …/ScrollsKit/Tests
  static let allTests = testsDir.deletingLastPathComponent()
  /// …/Scrolls (the mirror's copy of the Node reference sits next to Native/).
  static let scrollsRoot = allTests.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  /// The committed golden families.
  static let goldenDir = allTests.appendingPathComponent("DifferentialTests/Golden")
  /// The reference's ingest fixtures (tests/fixtures/ingest).
  static let ingestFixtures = scrollsRoot.appendingPathComponent("tests/fixtures/ingest")
  /// The fixed clock of the reference's tests.
  static let now = ISO8601DateFormatter().date(from: "2026-10-04T12:00:00Z")!

  /// $TMPDIR/scrolls-n1-tests, pruned of directories older than an hour.
  static let root: URL = {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-n1-tests")
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

  static func tempDir(_ label: String) throws -> URL {
    let d = root.appendingPathComponent("\(label)-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  // MARK: golden families

  static let manifest: JSONValue = (try? JSONValue.parse(Data(contentsOf: goldenDir.appendingPathComponent("MANIFEST.json")))) ?? .null

  /// Where a family's files are: the committed folder, or the private folder of the manifest's reference commit.
  static func familyDir(_ family: String) -> URL? {
    let entry = manifest["families"]?[family]
    if entry?["private"]?.boolValue == true {
      let base = ProcessInfo.processInfo.environment["SCROLLS_GOLDEN_ROOT"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-golden")
      let ref = entry?["reference_commit"]?.stringValue ?? manifest["reference_commit"]?.stringValue ?? ""
      let dir = base.appendingPathComponent(ref).appendingPathComponent("private").appendingPathComponent(family)
      return FileManager.default.fileExists(atPath: dir.path) ? dir : nil
    }
    let dir = goldenDir.appendingPathComponent(family)
    return FileManager.default.fileExists(atPath: dir.path) ? dir : nil
  }

  /// Every case of a family in file order (nil when the family is absent: a private family off this Mac).
  static func cases(_ family: String) throws -> [JSONValue]? {
    guard let dir = familyDir(family) else { return nil }
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".jsonl") }.sorted()
    var out: [JSONValue] = []
    for f in files {
      let data = try Data(contentsOf: dir.appendingPathComponent(f))
      for line in data.split(separator: 0x0A) where !line.isEmpty { out.append(try JSONValue.parse(Data(line))) }
    }
    if let n = manifest["families"]?[family]?["cases"]?.safeInteger, n != out.count {
      throw FixtureError("\(family): \(out.count) cases, MANIFEST.json says \(n)")
    }
    return out
  }

  struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }

  /// Writes `Reports/golden-<family>.json` (`{family, cases, mismatches, diffs, passed}`) when check.sh asks.
  static func report(_ family: String, cases: Int, mismatches: Int, diffs: [String]) {
    guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
    let v: JSONValue = .object(["family": .string(family), "cases": .number(Double(cases)), "mismatches": .number(Double(mismatches)),
                                "diffs": .array(diffs.prefix(20).map(JSONValue.string)), "passed": .bool(mismatches == 0)])
    try? Data((CanonicalJSON.string(v) + "\n").utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
  }

  // MARK: atlases and writers

  /// A freshly migrated atlas with the seeded vocabulary and the file importers; returns its path.
  static func atlas(_ profile: StoreProfile, label: String) async throws -> (path: String, writer: Writer) {
    let path = try tempDir(label).appendingPathComponent("atlas.sqlite").path
    let c = try Connection(path: path, mode: .readWrite, profile: profile)
    try Migrations.migrate(c)
    c.close()
    let w = try Writer(path: path, profile: profile)
    try await w.write("seed") { tx in
      try SeedVocab.seed(tx)
      try Collections.registerFileAdapters(tx.connection)
    }
    return (path, w)
  }

  /// Decodes a contract value from a golden JSON value.
  static func decode<T: Decodable>(_ type: T.Type, _ v: JSONValue) throws -> T { try ScrollsJSON.decode(type, from: v) }
}
