// OWNER: N0
// The Swift side of the golden harness (IOS-SPEC §8.4.8): a family's cases from the committed, redacted subset
// (Tests/DifferentialTests/Golden/<family>/) or from ~/Developer/scrolls-golden/<ref>/private/<family>/, every file
// checked against MANIFEST.json's sha256 before a case is read; a comparison rule of §2.4; and the report
// Native/Reports/golden-<family>.json. A case is one JSONL line: the line is the input, its `out` member the expected
// output. A family whose files are absent is not run (`GoldenFamily.isAvailable` for the test's `.enabled(if:)`);
// a skip is never a pass.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore

/// The tiers of §2.2.
public enum GoldenTier: String, Sendable { case c0, g1, g2, g3, g4, g5, g6, g7, g8 }

/// How an output is compared with its golden (§2.4).
public enum GoldenRule: Sendable {
  /// Canonical JSON equal.
  case exact
  /// Numbers within `tol · max(1, |golden|)`; everything else exact.
  case relative(Double)
  /// Label arrays whose adjusted Rand index is at least `minARI`.
  case partition(minARI: Double)
  /// Row-major n × k matrices whose top-k subspaces' principal-angle cosines are all ≥ `minCos`.
  case subspace(k: Int, minCos: Double)
  /// Arrays of neighbour lists: each item's top-k Jaccard with the golden ≥ `minJaccard`.
  case topK(k: Int, minJaccard: Double)
  /// Numbers within `points` (display-list geometry); everything else exact.
  case geometry(points: Double)
}

/// One case that did not match.
public struct GoldenDiff: Codable, Sendable {
  public let index: Int
  public let path: String
  public let expected: JSONValue
  public let actual: JSONValue
  public let detail: String
}

/// The result of checking a family (the first 20 diffs are kept).
public struct GoldenReport: Codable, Sendable {
  public let family: String
  public let tier: String
  public let cases: Int
  public let mismatches: Int
  public let diffs: [GoldenDiff]
  public let passed: Bool
}

/// Why a family cannot be read.
public struct GoldenUnavailable: Error, Sendable, CustomStringConvertible {
  public let description: String
}

/// A golden family: decoded inputs and the raw expected outputs.
public struct GoldenFamily<Input: Decodable & Sendable, Expected: Codable & Sendable>: Sendable {
  public let name: String
  public let tier: GoldenTier
  /// Each case's line (the input) and its `out` member (the expected output).
  public let cases: [(input: JSONValue, expected: JSONValue)]

  /// Loads the family after checking every file against MANIFEST.json. Throws `GoldenUnavailable` when the family is
  /// not in the manifest or a file is missing or differs.
  public init(_ name: String, tier: GoldenTier) throws {
    self.name = name
    self.tier = tier
    let lines = try GoldenStore.lines(of: name)
    cases = lines.map { line in (line, line["out"] ?? .null) }
  }

  /// Whether every file of `name` is on this Mac (private families exist only where they were generated).
  public static func isAvailable(_ name: String) -> Bool { GoldenStore.available(name) }

  /// Runs every case and compares its output with the golden under `rule`. Writes the report when the caller
  /// (Tools/check.sh) passes SCROLLS_REPORTS_DIR.
  public func check(_ rule: GoldenRule, _ run: @Sendable (Input) async throws -> Expected) async throws -> GoldenReport {
    var diffs: [GoldenDiff] = []
    var mismatches = 0
    for (i, c) in cases.enumerated() {
      let actual: JSONValue
      do {
        actual = try ScrollsJSON.value(try await run(try ScrollsJSON.decode(Input.self, from: c.input)))
      } catch {
        mismatches += 1
        if diffs.count < 20 { diffs.append(GoldenDiff(index: i, path: "$", expected: c.expected, actual: .null, detail: "\(error)")) }
        continue
      }
      if let (path, detail) = GoldenCompare.difference(rule, expected: c.expected, actual: actual) {
        mismatches += 1
        if diffs.count < 20 { diffs.append(GoldenDiff(index: i, path: path, expected: c.expected, actual: actual, detail: detail)) }
      }
    }
    let report = GoldenReport(family: name, tier: tier.rawValue, cases: cases.count, mismatches: mismatches, diffs: diffs,
                              passed: mismatches == 0 && !cases.isEmpty)
    try GoldenStore.write(report)
    return report
  }
}

/// The committed subset and the private store, with MANIFEST.json's checks.
public enum GoldenStore {
  /// Tests/DifferentialTests/Golden beside this file.
  public static let committedDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Golden")

  public static var goldenRoot: URL {
    if let r = ProcessInfo.processInfo.environment["SCROLLS_GOLDEN_ROOT"] { return URL(fileURLWithPath: r) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/scrolls-golden")
  }

  public static var manifest: JSONValue {
    (try? JSONValue.parse(Data(contentsOf: committedDir.appendingPathComponent("MANIFEST.json")))) ?? .object([:])
  }

  static func entry(_ name: String) -> JSONObject? { manifest["families"]?[name]?.objectValue }

  static func directory(_ name: String) -> URL? {
    guard let e = entry(name) else { return nil }
    if e["private"] == .bool(true) {
      guard let ref = e["reference_commit"]?.stringValue else { return nil }
      return goldenRoot.appendingPathComponent(ref).appendingPathComponent("private").appendingPathComponent(name)
    }
    return committedDir.appendingPathComponent(name)
  }

  static func available(_ name: String) -> Bool {
    guard let dir = directory(name), let files = entry(name)?["files"]?.objectValue, !files.isEmpty else { return false }
    return files.keys.allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
  }

  /// Every case line of a family, files in name order, each file's sha256 checked first.
  static func lines(of name: String) throws -> [JSONValue] {
    guard let e = entry(name), let dir = directory(name), let files = e["files"]?.objectValue else {
      throw GoldenUnavailable(description: "golden family \(name) is not in MANIFEST.json")
    }
    var out: [JSONValue] = []
    for file in files.keys.sorted() {
      let url = dir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { throw GoldenUnavailable(description: "missing \(url.path)") }
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sha == files[file]?.stringValue else {
        throw GoldenUnavailable(description: "\(url.path): sha256 \(sha) does not match MANIFEST.json")
      }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty { out.append(try JSONValue.parse(Data(line))) }
    }
    if let n = e["cases"]?.safeInteger, n != out.count {
      throw GoldenUnavailable(description: "\(name): read \(out.count) cases, MANIFEST.json says \(n)")
    }
    return out
  }

  /// Writes `golden-<family>.json` into SCROLLS_REPORTS_DIR when it is set.
  static func write(_ report: GoldenReport) throws {
    guard let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] else { return }
    let url = URL(fileURLWithPath: dir).appendingPathComponent("golden-\(report.family).json")
    try Data(CanonicalJSON.string(try ScrollsJSON.value(report)).utf8).write(to: url)
  }
}

/// The §2.4 comparisons.
public enum GoldenCompare {
  /// nil when `actual` matches `expected` under `rule`, else the path and the reason.
  public static func difference(_ rule: GoldenRule, expected: JSONValue, actual: JSONValue) -> (String, String)? {
    switch rule {
    case .exact:
      return CanonicalJSON.string(expected) == CanonicalJSON.string(actual)
        ? nil : ("$", ContractRoundTrip.firstDifference(expected, actual))
    case .relative(let tol):
      return numbers(expected, actual, "$") { a, b in abs(a - b) <= tol * max(1, abs(b)) }
    case .geometry(let points):
      return numbers(expected, actual, "$") { a, b in abs(a - b) <= points }
    case .partition(let minARI):
      guard let e = expected.arrayValue?.map(CanonicalJSON.string), let a = actual.arrayValue?.map(CanonicalJSON.string),
        e.count == a.count
      else { return ("$", "label arrays of different lengths") }
      let ari = adjustedRandIndex(e, a)
      return ari >= minARI ? nil : ("$", "adjusted Rand index \(ari) < \(minARI)")
    case .subspace(let k, let minCos):
      guard let e = matrix(expected), let a = matrix(actual), e.count == a.count else { return ("$", "matrices of different shapes") }
      let cosines = principalCosines(e, a, k: k)
      guard let worst = cosines.min() else { return ("$", "empty subspace") }
      return worst >= minCos ? nil : ("$", "smallest principal-angle cosine \(worst) < \(minCos)")
    case .topK(let k, let minJaccard):
      guard let e = expected.arrayValue, let a = actual.arrayValue, e.count == a.count else { return ("$", "lists of different lengths") }
      for (i, (x, y)) in zip(e, a).enumerated() {
        let sx = Set((x.arrayValue ?? []).prefix(k).map(CanonicalJSON.string))
        let sy = Set((y.arrayValue ?? []).prefix(k).map(CanonicalJSON.string))
        let union = sx.union(sy).count
        let j = union == 0 ? 1 : Double(sx.intersection(sy).count) / Double(union)
        if j < minJaccard { return ("$[\(i)]", "top-\(k) Jaccard \(j) < \(minJaccard)") }
      }
      return nil
    }
  }

  private static func numbers(_ e: JSONValue, _ a: JSONValue, _ path: String,
                              _ close: (Double, Double) -> Bool) -> (String, String)? {
    switch (e, a) {
    case (.number(let x), .number(let y)):
      return close(y, x) ? nil : (path, "\(y) vs golden \(x)")
    case (.array(let x), .array(let y)):
      guard x.count == y.count else { return (path, "\(y.count) elements, golden \(x.count)") }
      for (i, (xv, yv)) in zip(x, y).enumerated() { if let d = numbers(xv, yv, "\(path)[\(i)]", close) { return d } }
      return nil
    case (.object(let x), .object(let y)):
      guard Set(x.keys) == Set(y.keys) else { return (path, "keys \(y.keys.sorted()) vs golden \(x.keys.sorted())") }
      for k in x.keys.sorted() { if let d = numbers(x[k]!, y[k]!, "\(path).\(k)", close) { return d } }
      return nil
    default:
      return e == a ? nil : (path, "\(CanonicalJSON.string(a).prefix(80)) vs golden \(CanonicalJSON.string(e).prefix(80))")
    }
  }

  /// The adjusted Rand index of two labelings (Hubert & Arabie).
  public static func adjustedRandIndex(_ x: [String], _ y: [String]) -> Double {
    let n = x.count
    guard n > 1 else { return 1 }
    var table: [String: [String: Int]] = [:]
    var rows: [String: Int] = [:], cols: [String: Int] = [:]
    for (a, b) in zip(x, y) {
      table[a, default: [:]][b, default: 0] += 1
      rows[a, default: 0] += 1
      cols[b, default: 0] += 1
    }
    func c2(_ v: Int) -> Double { Double(v) * Double(v - 1) / 2 }
    let index = table.values.flatMap(\.values).reduce(0) { $0 + c2($1) }
    let sumRows = rows.values.reduce(0) { $0 + c2($1) }
    let sumCols = cols.values.reduce(0) { $0 + c2($1) }
    let expected = sumRows * sumCols / c2(n)
    let maxIndex = (sumRows + sumCols) / 2
    return maxIndex == expected ? 1 : (index - expected) / (maxIndex - expected)
  }

  private static func matrix(_ v: JSONValue) -> [[Double]]? {
    v.arrayValue?.map { row in (row.arrayValue ?? []).compactMap(\.numberValue) }
  }

  /// Cosines of the principal angles between the column spaces of the first `k` columns of `a` and `b` (n × k each):
  /// orthonormalize both (modified Gram–Schmidt), then the singular values of QaᵀQb (Jacobi on its Gram matrix).
  public static func principalCosines(_ a: [[Double]], _ b: [[Double]], k: Int) -> [Double] {
    let qa = orthonormalColumns(a, k), qb = orthonormalColumns(b, k)
    let ka = qa.first?.count ?? 0, kb = qb.first?.count ?? 0
    guard ka > 0, kb > 0 else { return [] }
    var m = Array(repeating: Array(repeating: 0.0, count: kb), count: ka)
    for r in 0..<qa.count { for i in 0..<ka { for j in 0..<kb { m[i][j] += qa[r][i] * qb[r][j] } } }
    var g = Array(repeating: Array(repeating: 0.0, count: kb), count: kb)
    for i in 0..<kb { for j in 0..<kb { for r in 0..<ka { g[i][j] += m[r][i] * m[r][j] } } }
    return symmetricEigenvalues(g).map { $0 > 0 ? min(1, $0.squareRoot()) : 0 }
  }

  private static func orthonormalColumns(_ x: [[Double]], _ k: Int) -> [[Double]] {
    let n = x.count, cols = min(k, x.first?.count ?? 0)
    var q: [[Double]] = Array(repeating: [], count: n)
    var basis: [[Double]] = []
    for c in 0..<cols {
      var v = (0..<n).map { x[$0][c] }
      for u in basis {
        let d = zip(u, v).reduce(0) { $0 + $1.0 * $1.1 }
        for i in 0..<n { v[i] -= d * u[i] }
      }
      let norm = v.reduce(0) { $0 + $1 * $1 }.squareRoot()
      guard norm > 1e-12 else { continue }
      basis.append(v.map { $0 / norm })
    }
    for i in 0..<n { q[i] = basis.map { $0[i] } }
    return q
  }

  /// Eigenvalues of a small symmetric matrix by cyclic Jacobi rotations.
  private static func symmetricEigenvalues(_ input: [[Double]]) -> [Double] {
    var a = input
    let n = a.count
    for _ in 0..<100 {
      var off = 0.0
      for i in 0..<n { for j in 0..<n where i != j { off += a[i][j] * a[i][j] } }
      if off < 1e-22 { break }
      for p in 0..<n {
        for q in (p + 1)..<n where abs(a[p][q]) > 1e-300 {
          let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
          let t = (theta >= 0 ? 1 : -1) / (abs(theta) + (theta * theta + 1).squareRoot())
          let c = 1 / (t * t + 1).squareRoot(), s = t * c
          for k in 0..<n {
            let akp = a[k][p], akq = a[k][q]
            a[k][p] = c * akp - s * akq
            a[k][q] = s * akp + c * akq
          }
          for k in 0..<n {
            let apk = a[p][k], aqk = a[q][k]
            a[p][k] = c * apk - s * aqk
            a[q][k] = s * apk + c * aqk
          }
        }
      }
    }
    return (0..<n).map { a[$0][$0] }
  }
}
