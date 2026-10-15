// OWNER: N0
// C0 (IOS-SPEC §2.2): every JSON body of the contract fixtures — variant bodies, SSE event payloads, variant requests
// and example requests — decodes into its Swift mirror and encodes back to the same canonical JSON. A field missing
// from a Swift type makes its fixture fail instead of disappearing. ScrollsContractsTests and DifferentialTests run it.

import Foundation
import ScrollsCore

/// The C0 round trip over a directory of contract fixtures.
public enum ContractRoundTrip {
  /// One JSON body of a fixture and the shape it must round-trip as.
  public struct Body: Sendable {
    public let file: String
    public let variant: String
    /// 'body', 'request', 'example_request' or 'event <i> (<name>)'.
    public let part: String
    public let shape: String
    public let value: JSONValue
    public init(file: String, variant: String, part: String, shape: String, value: JSONValue) {
      self.file = file
      self.variant = variant
      self.part = part
      self.shape = shape
      self.value = value
    }
  }

  /// A body whose round trip differs, with the first difference.
  public struct Mismatch: Sendable, CustomStringConvertible {
    public let body: Body
    public let detail: String
    public var description: String { "\(body.file) [\(body.variant)] \(body.part) as \(body.shape): \(detail)" }
  }

  /// The result over every fixture.
  public struct Result: Sendable {
    public let fixtures: Int
    public let bodies: [Body]
    public let mismatches: [Mismatch]
    /// Bodies with no shape and no Swift mirror.
    public let unshaped: [String]
    public var passed: Bool { mismatches.isEmpty && unshaped.isEmpty && !bodies.isEmpty }
  }

  /// Runs C0 over every `*.json` fixture of `directory`.
  public static func run(directory: URL) throws -> Result {
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
    var bodies: [Body] = []
    var unshaped: [String] = []
    for name in names {
      let json = try JSONValue.parse(try Data(contentsOf: directory.appendingPathComponent(name)))
      let (b, u) = self.bodies(ofFixture: name, json)
      bodies += b
      unshaped += u
    }
    return Result(fixtures: names.count, bodies: bodies, mismatches: bodies.compactMap(check), unshaped: unshaped)
  }

  /// Every JSON body of one fixture with the shape it must round-trip as: a variant's own `shape`, else ErrorBody for
  /// a status ≥ 400, else the endpoint's response (server/http/mock.mjs `variantShape`); the Swift mirrors of the
  /// unshaped JSON bodies and requests (`ContractCatalog.unshapedBodies`, `.unshapedRequests`) cover the rest.
  public static func bodies(ofFixture file: String, _ fixture: JSONValue) -> (bodies: [Body], unshaped: [String]) {
    var out: [Body] = []
    var unshaped: [String] = []
    let key = "\(fixture["method"]?.stringValue ?? "") \(fixture["path"]?.stringValue ?? "")"
    let response = fixture["response"]?.stringValue
    let request = fixture["request"]?.stringValue ?? ContractCatalog.unshapedRequests[key]
    if let ex = fixture["example_request"], !ex.isNull {
      if let request { out.append(Body(file: file, variant: "-", part: "example_request", shape: request, value: ex)) }
      else { unshaped.append("\(file) example_request") }
    }
    for (name, variant) in (fixture["variants"]?.objectValue ?? [:]).sorted(by: { $0.key < $1.key }) {
      let status = variant["status"]?.safeInteger ?? 200
      if let body = variant["body"] {
        let declared = variant.objectValue?.keys.contains("shape") == true
        let shape = declared ? variant["shape"]?.stringValue : (status >= 400 ? "ErrorBody" : response)
        if let shape = shape ?? ContractCatalog.unshapedBodies[key] {
          out.append(Body(file: file, variant: name, part: "body", shape: shape, value: body))
        } else {
          unshaped.append("\(file) [\(name)] body")
        }
      }
      if let req = variant["request"] {
        if let request { out.append(Body(file: file, variant: name, part: "request", shape: request, value: req)) }
        else { unshaped.append("\(file) [\(name)] request") }
      }
      for (i, event) in (variant["events"]?.arrayValue ?? []).enumerated() {
        guard let data = event["data"] else { continue }
        if let shape = event["shape"]?.stringValue {
          out.append(Body(file: file, variant: name, part: "event \(i) (\(event["event"]?.stringValue ?? "?"))", shape: shape,
                          value: data))
        } else {
          unshaped.append("\(file) [\(name)] event \(i)")
        }
      }
    }
    return (out, unshaped)
  }

  /// Decode → encode → canonical JSON equal, for one body; nil when it round-trips.
  public static func check(_ b: Body) -> Mismatch? {
    do {
      let back = try ContractCatalog.roundTrip(shape: b.shape, b.value)
      return CanonicalJSON.string(b.value) == CanonicalJSON.string(back)
        ? nil : Mismatch(body: b, detail: firstDifference(b.value, back))
    } catch {
      return Mismatch(body: b, detail: "\(error)")
    }
  }

  /// The first path at which two values differ, in words.
  public static func firstDifference(_ a: JSONValue, _ b: JSONValue, path: String = "$") -> String {
    switch (a, b) {
    case (.object(let x), .object(let y)):
      for k in Set(x.keys).union(y.keys).sorted() {
        guard let xv = x[k] else { return "\(path).\(k): added by Swift (\(CanonicalJSON.string(y[k] ?? .null).prefix(80)))" }
        guard let yv = y[k] else { return "\(path).\(k): dropped by Swift (was \(CanonicalJSON.string(xv).prefix(80)))" }
        if CanonicalJSON.string(xv) != CanonicalJSON.string(yv) { return firstDifference(xv, yv, path: "\(path).\(k)") }
      }
      return "\(path): differs"
    case (.array(let x), .array(let y)):
      if x.count != y.count { return "\(path): \(x.count) elements, Swift wrote \(y.count)" }
      for (i, (xv, yv)) in zip(x, y).enumerated() where CanonicalJSON.string(xv) != CanonicalJSON.string(yv) {
        return firstDifference(xv, yv, path: "\(path)[\(i)]")
      }
      return "\(path): differs"
    default:
      return "\(path): \(CanonicalJSON.string(a).prefix(80)) → \(CanonicalJSON.string(b).prefix(80))"
    }
  }

  /// The report Tools/check.sh shows (`Reports/c0-contracts.json`): counts by shape and the first 20 differences.
  public static func report(_ r: Result) -> JSONValue {
    var byShape: [String: Int] = [:]
    for b in r.bodies { byShape[b.shape, default: 0] += 1 }
    return .object(JSONObject([
      ("tier", "c0"),
      ("fixtures", .number(Double(r.fixtures))),
      ("bodies", .number(Double(r.bodies.count))),
      ("mismatches", .number(Double(r.mismatches.count))),
      ("unshaped", .array(r.unshaped.map(JSONValue.string))),
      ("by_shape", .object(JSONObject(byShape.map { ($0.key, JSONValue.number(Double($0.value))) }))),
      ("diffs", .array(r.mismatches.prefix(20).map { .string($0.description) })),
      ("passed", .bool(r.passed)),
    ]))
  }
}
