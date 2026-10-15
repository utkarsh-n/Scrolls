// OWNER: N7
// Reads the G5 golden families (IOS-SPEC §2.2) for ScrollsScrollModelTests: the committed subset in
// Tests/DifferentialTests/Golden (found from this file's path, so `swift test` in any mirror finds it) and the private
// families under ~/Developer/scrolls-golden/<ref>/private/. Every file is checked against MANIFEST.json's sha256 before a
// case is read. A family whose files are absent is not run (the test says why); a skip is never a pass.

import CryptoKit
import Foundation
import ScrollsCore

enum G5Golden {
  struct Missing: Error, CustomStringConvertible { let description: String }

  /// `SCROLLS_G5_DEV_DIR` (a `run.mjs --out` directory) reads a generator's output before it is committed: its
  /// MANIFEST.json and families, private ones under its private/. Never set by the gates.
  static let devDir: URL? = ProcessInfo.processInfo.environment["SCROLLS_G5_DEV_DIR"].map { URL(fileURLWithPath: $0) }

  static let committedDir: URL = devDir ?? URL(fileURLWithPath: #filePath)
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
      if let devDir { return devDir.appendingPathComponent("private").appendingPathComponent(name) }
      guard let ref = e["reference_commit"]?.stringValue else { return nil }
      return goldenRoot.appendingPathComponent(ref).appendingPathComponent("private").appendingPathComponent(name)
    }
    return committedDir.appendingPathComponent(name)
  }

  /// Whether every file of the family is present.
  static func available(_ name: String) -> Bool {
    guard let dir = directory(of: name), let files = entry(name)?["files"]?.objectValue, !files.isEmpty else { return false }
    return files.keys.allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
  }

  /// The family's cases after checking each file's sha256 against the manifest.
  static func load(_ name: String) throws -> [JSONValue] {
    guard let e = entry(name), let dir = directory(of: name), let files = e["files"]?.objectValue else {
      throw Missing(description: "golden family \(name) is not in MANIFEST.json")
    }
    var cases: [JSONValue] = []
    for file in files.keys.sorted() {
      let url = dir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { throw Missing(description: "missing \(url.path)") }
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sha == files[file]?.stringValue else {
        throw Missing(description: "\(url.path): sha256 \(sha) does not match MANIFEST.json")
      }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
        cases.append(try JSONValue.parse(Data(line)))
      }
    }
    let n = e["cases"]?.safeInteger ?? -1
    guard cases.count == n else { throw Missing(description: "\(name): read \(cases.count) cases, the manifest says \(n)") }
    return cases
  }

  /// Mismatches of one family and the §8.4.8 report (first 20 diffs) written when SCROLLS_REPORTS_DIR is set.
  final class Report: @unchecked Sendable {
    let family: String
    private let lock = NSLock()
    private(set) var checks = 0
    private(set) var failures = 0
    private(set) var diffs: [JSONValue] = []
    /// Accepted divergences seen, by id (counted, never failures; each is registered in DIVERGENCES.json or requested).
    private(set) var accepted: [String: Int] = [:]

    init(_ family: String) { self.family = family }

    func check(_ ok: Bool, _ what: @autoclosure () -> String, expected: @autoclosure () -> JSONValue = .null,
               actual: @autoclosure () -> JSONValue = .null) {
      lock.lock()
      defer { lock.unlock() }
      checks += 1
      guard !ok else { return }
      failures += 1
      if diffs.count < 20 { diffs.append(["case": .string(what()), "expected": expected(), "actual": actual()]) }
    }

    func accept(_ dv: String) {
      lock.lock()
      accepted[dv, default: 0] += 1
      lock.unlock()
    }

    var passed: Bool { failures == 0 && checks > 0 }

    var summary: String {
      "\(family): \(checks) checks, \(failures) mismatches" + (accepted.isEmpty ? "" : ", accepted \(accepted.sorted { $0.key < $1.key })")
        + (diffs.isEmpty ? "" : "; first: \(CanonicalJSON.string(diffs[0]))")
    }

    func write() {
      guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
      var acc = JSONObject()
      for (k, v) in accepted { acc[k] = .number(Double(v)) }
      let report: JSONValue = ["family": .string(family), "tier": "g5", "cases": .number(Double(checks)),
                               "mismatches": .number(Double(failures)), "diffs": .array(diffs), "accepted": .object(acc),
                               "passed": .bool(passed)]
      try? Data((CanonicalJSON.string(report) + "\n").utf8)
        .write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
    }
  }
}
