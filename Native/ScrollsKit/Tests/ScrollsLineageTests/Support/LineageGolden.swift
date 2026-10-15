// OWNER: N5
// Reads N5's golden families (IOS-SPEC §2.2) for ScrollsLineageTests: the committed subset in
// Tests/DifferentialTests/Golden (found from this file's path, so `swift test` in any mirror finds it). Every file is
// checked against MANIFEST.json's sha256 before a case is read, so a test compares against exactly what Node wrote. A
// report per family goes to $SCROLLS_REPORTS_DIR/golden-<family>.json (check.sh reads them into its table).

import CryptoKit
import Foundation
import ScrollsCore

enum LineageGolden {
  struct Missing: Error, CustomStringConvertible { let description: String }

  /// Tests/DifferentialTests/Golden next to this test target.
  static let committedDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("DifferentialTests/Golden")

  static let manifest: JSONValue = {
    guard let data = try? Data(contentsOf: committedDir.appendingPathComponent("MANIFEST.json")),
      let m = try? JSONValue.parse(data)
    else { return .object([:]) }
    return m
  }()

  static func available(_ name: String) -> Bool { manifest["families"]?[name]?.objectValue != nil }

  /// The cases of a family, after checking each file's sha256 and the case count against the manifest.
  static func load(_ name: String) throws -> [JSONValue] {
    guard let e = manifest["families"]?[name]?.objectValue, let files = e["files"]?.objectValue else {
      throw Missing(description: "golden family \(name) is not in MANIFEST.json")
    }
    let dir = committedDir.appendingPathComponent(name)
    var cases: [JSONValue] = []
    for file in files.keys.sorted() {
      let url = dir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { throw Missing(description: "missing \(url.path)") }
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sha == files[file]?.stringValue else {
        throw Missing(description: "\(url.path): sha256 \(sha) does not match MANIFEST.json")
      }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty { cases.append(try JSONValue.parse(Data(line))) }
    }
    guard cases.count == e["cases"]?.safeInteger else {
      throw Missing(description: "\(name): read \(cases.count) cases, the manifest says \(e["cases"]?.safeInteger ?? -1)")
    }
    return cases
  }

  /// Mismatches of one family; writes the report (first 20 diffs) when SCROLLS_REPORTS_DIR is set.
  final class Report: @unchecked Sendable {
    let family: String
    private(set) var checks = 0
    private(set) var failures = 0
    private(set) var diffs: [JSONValue] = []
    init(_ family: String) { self.family = family }

    func check(_ ok: Bool, _ what: @autoclosure () -> String, expected: @autoclosure () -> JSONValue = .null,
               actual: @autoclosure () -> JSONValue = .null) {
      checks += 1
      guard !ok else { return }
      failures += 1
      if diffs.count < 20 { diffs.append(["case": .string(what()), "expected": expected(), "actual": actual()]) }
    }

    var passed: Bool { failures == 0 && checks > 0 }
    var summary: String {
      "\(family): \(checks) checks, \(failures) mismatches" + (diffs.isEmpty ? "" : "; first: \(CanonicalJSON.string(diffs[0]))")
    }

    func write() {
      guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
      let report: JSONValue = ["family": .string(family), "cases": .number(Double(checks)),
                               "mismatches": .number(Double(failures)), "diffs": .array(diffs), "passed": .bool(passed)]
      try? Data((CanonicalJSON.string(report) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
    }
  }
}

extension JSONValue {
  /// A JSON array of u32 values.
  var u32s: [UInt32]? { arrayValue?.map { UInt32(exactly: $0.numberValue ?? -1) ?? .max } }
  var ints: [Int]? { arrayValue?.compactMap(\.safeInteger) }
  var int: Int? { safeInteger }
}

/// sha256 (hex) of the little-endian bytes of a u32 array (the generator's `u32sha`).
func u32sha(_ a: [UInt32]) -> String {
  var le = a.map { $0.littleEndian }
  let data = le.withUnsafeMutableBytes { Data($0) }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func u32json(_ a: [UInt32]) -> JSONValue { .array(a.map { .number(Double($0)) }) }
