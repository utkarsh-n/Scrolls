// OWNER: N0
// Reads the G1-core golden families (IOS-SPEC §2.2, §8.4.8) for ScrollsCoreTests: the committed, redacted subset in
// Tests/DifferentialTests/Golden (located from this file's path, so `swift test` in any mirror finds it), and private
// families under ~/Developer/scrolls-golden/<ref>/private/. Every file is checked against MANIFEST.json's sha256 before a
// case is read, so a test proves it compares against exactly what Node wrote. A family whose files are absent is not
// run (the trait reports why); a skip is never a pass.

import CryptoKit
import Foundation
import ScrollsCore

enum Golden {
  struct Family {
    let name: String
    let cases: [JSONValue]
    let manifestCases: Int
  }

  struct Missing: Error, CustomStringConvertible { let description: String }

  /// Tests/DifferentialTests/Golden next to this test target.
  static let committedDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("DifferentialTests/Golden")

  static let goldenRoot: URL = {
    if let r = ProcessInfo.processInfo.environment["SCROLLS_GOLDEN_ROOT"] { return URL(fileURLWithPath: r) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-golden")
  }()

  static let manifest: JSONValue = {
    guard let data = try? Data(contentsOf: committedDir.appendingPathComponent("MANIFEST.json")),
      let m = try? JSONValue.parse(data)
    else { return .object([:]) }
    return m
  }()

  static func entry(_ name: String) -> JSONObject? { manifest["families"]?[name]?.objectValue }

  static func directory(of name: String) -> URL? {
    guard let e = entry(name) else { return nil }
    if e["private"] == .bool(true) {
      guard let ref = e["reference_commit"]?.stringValue else { return nil }
      return goldenRoot.appendingPathComponent(ref).appendingPathComponent("private").appendingPathComponent(name)
    }
    return committedDir.appendingPathComponent(name)
  }

  /// Whether every file of the family is present (private families exist only on the Mac that generated them).
  static func available(_ name: String) -> Bool {
    guard let dir = directory(of: name), let files = entry(name)?["files"]?.objectValue, !files.isEmpty else { return false }
    return files.keys.allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
  }

  /// Loads a family after checking each file's sha256 against the manifest.
  static func load(_ name: String) throws -> Family {
    guard let e = entry(name), let dir = directory(of: name), let files = e["files"]?.objectValue else {
      throw Missing(description: "golden family \(name) is not in MANIFEST.json")
    }
    var cases: [JSONValue] = []
    for file in files.keys.sorted() {
      let url = dir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { throw Missing(description: "missing \(url.path)") }
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sha == files[file]?.stringValue else {
        throw Missing(description: "\(url.path): sha256 \(sha) does not match MANIFEST.json (\(files[file]?.stringValue ?? "none"))")
      }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
        cases.append(try JSONValue.parse(Data(line)))
      }
    }
    let n = e["cases"]?.safeInteger ?? -1
    guard cases.count == n else { throw Missing(description: "\(name): read \(cases.count) cases, the manifest says \(n)") }
    return Family(name: name, cases: cases, manifestCases: n)
  }

  /// Collects mismatches of one family and writes the §8.4.8 report (first 20 diffs) when SCROLLS_REPORTS_DIR is set.
  final class Report {
    let family: String
    private(set) var cases = 0
    private(set) var failures = 0
    private(set) var diffs: [JSONValue] = []

    init(_ family: String) { self.family = family }

    func check(_ ok: Bool, _ what: @autoclosure () -> String, expected: @autoclosure () -> JSONValue,
               actual: @autoclosure () -> JSONValue) {
      cases += 1
      guard !ok else { return }
      failures += 1
      if diffs.count < 20 { diffs.append(["case": .string(what()), "expected": expected(), "actual": actual()]) }
    }

    var passed: Bool { failures == 0 && cases > 0 }

    var summary: String {
      "\(family): \(cases) checks, \(failures) mismatches" + (diffs.isEmpty ? "" : "; first: \(CanonicalJSON.string(diffs[0]))")
    }

    /// Writes Native/Reports/golden-<family>.json when the caller (Tools/check.sh) passes SCROLLS_REPORTS_DIR.
    func write() {
      guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
      let report: JSONValue = ["family": .string(family), "cases": .number(Double(cases)), "mismatches": .number(Double(failures)),
                               "diffs": .array(diffs), "passed": .bool(passed)]
      try? Data((CanonicalJSON.string(report) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
    }
  }
}

extension JSONValue {
  /// The double behind a golden's hex bit pattern ("400921fb54442d18").
  var hexDouble: Double? {
    guard let s = stringValue, let bits = UInt64(s, radix: 16) else { return nil }
    return Double(bitPattern: bits)
  }

  /// JSON integers as Int (golden offsets, days, counts).
  var int: Int? { safeInteger }

  var ints: [Int]? { arrayValue?.compactMap(\.safeInteger) }
  var strings: [String]? { arrayValue?.compactMap(\.stringValue) }
}

/// Decodes a golden delta list back to absolute values.
func undelta(_ d: [Int]) -> [Int] {
  var out: [Int] = []
  out.reserveCapacity(d.count)
  var acc = 0
  for x in d { acc += x; out.append(acc) }
  return out
}
