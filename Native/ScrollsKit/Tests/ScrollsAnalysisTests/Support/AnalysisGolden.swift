// OWNER: N4
// Reads N4's golden families (IOS-SPEC §2.2) for ScrollsAnalysisTests: the committed, redacted subset in
// Tests/DifferentialTests/Golden (found from this file's path), each file checked against MANIFEST.json's sha256 before a
// case is read, and compares values by the §2.4 rules: strings and integers exact, floats within 1e-9·max(1, |x|).
// Writes Reports/golden-<family>.json when SCROLLS_REPORTS_DIR is set (Tools/check.sh), as ScrollsCoreTests do.

import CryptoKit
import Foundation
import ScrollsCore

enum AnalysisGolden {
  struct Missing: Error, CustomStringConvertible { let description: String }

  static let committedDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("DifferentialTests/Golden")

  static let manifest: JSONValue = {
    guard let data = try? Data(contentsOf: committedDir.appendingPathComponent("MANIFEST.json")),
          let m = try? JSONValue.parse(data) else { return .object([:]) }
    return m
  }()

  static func available(_ name: String) -> Bool { manifest["families"]?[name] != nil }

  /// The cases of a committed family, after checking every file against the manifest.
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
      guard sha == files[file]?.stringValue else { throw Missing(description: "\(url.path): sha256 does not match MANIFEST.json") }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty { cases.append(try JSONValue.parse(Data(line))) }
    }
    guard cases.count == e["cases"]?.safeInteger else { throw Missing(description: "\(name): case count differs from the manifest") }
    return cases
  }

  /// A difference between two JSON values under the §2.4 rules, or nil. `{"$num": "Infinity"}` stands for a non-finite
  /// number; `{"$redacted": sha, "len": n}` matches a string with that sha256 and UTF-16 length.
  static func diff(_ expected: JSONValue, _ actual: JSONValue, path: String = "$", tolerance: Double = 1e-9) -> String? {
    switch (expected, actual) {
    case (.number(let x), .number(let y)):
      if x == y { return nil }
      if x.rounded() == x && y.rounded() == y && abs(x) < 9e15 { return "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))" }
      return abs(x - y) <= tolerance * max(1, abs(x)) ? nil : "\(path): \(JSNumber.format(x)) ≠ \(JSNumber.format(y))"
    case (.object(let o), _) where o["$num"] != nil:
      let want = o["$num"]?.stringValue ?? ""
      if case .number(let y) = actual, JSNumber.format(y) == want { return nil }
      if actual == .null && (want == "NaN") { return nil }
      return "\(path): \(want) ≠ \(CanonicalJSON.string(actual))"
    case (.object(let o), .string(let s)) where o["$redacted"] != nil:
      let sha = SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
      return sha == o["$redacted"]?.stringValue && s.utf16.count == o["len"]?.safeInteger ? nil : "\(path): redacted text differs"
    case (.string(let a), .string(let b)):
      return a.utf16.elementsEqual(b.utf16) ? nil : "\(path): \"\(a)\" ≠ \"\(b)\""
    case (.array(let a), .array(let b)):
      if a.count != b.count { return "\(path): \(a.count) items ≠ \(b.count) items" }
      for i in a.indices { if let d = diff(a[i], b[i], path: "\(path)[\(i)]", tolerance: tolerance) { return d } }
      return nil
    case (.object(let a), .object(let b)):
      let ka = Set(a.keys), kb = Set(b.keys)
      if ka != kb {
        return "\(path): keys \(ka.subtracting(kb).sorted()) missing, \(kb.subtracting(ka).sorted()) extra"
      }
      for k in a.keys.sorted() { if let d = diff(a[k]!, b[k]!, path: "\(path).\(k)", tolerance: tolerance) { return d } }
      return nil
    default:
      return expected == actual ? nil : "\(path): \(CanonicalJSON.string(expected)) ≠ \(CanonicalJSON.string(actual))"
    }
  }

  /// Writes Reports/golden-<family>.json when Tools/check.sh passes SCROLLS_REPORTS_DIR.
  static func report(_ family: String, cases: Int, mismatches: [String]) {
    guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
    let report: JSONValue = ["family": .string(family), "cases": .number(Double(cases)), "mismatches": .number(Double(mismatches.count)),
                             "diffs": .array(mismatches.prefix(20).map(JSONValue.string)), "passed": .bool(mismatches.isEmpty && cases > 0)]
    try? Data((CanonicalJSON.string(report) + "\n").utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("golden-\(family).json"))
  }
}
