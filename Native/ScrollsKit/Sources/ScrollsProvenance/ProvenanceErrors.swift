// OWNER: N6
// The reference's HttpError shapes for the provenance routes (server/provenance/*.mjs `invalid`, `HttpError(404 …)`,
// `HttpError(409 …)`), so error bodies compare byte for byte with the reference (G7). A detail object keeps the
// reference's members: `{field, ...extra}` for validation errors, `{field: 'anchor', ...}` for anchors.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Error constructors with the reference's wording conventions.
public enum ProvenanceError {
  /// 400 E_VALIDATION with `detail = {field, ...extra}` (annotations.mjs / relationships.mjs `invalid`).
  public static func invalid(_ message: String, field: String?, hint: String? = nil,
                             extra: [(String, JSONValue)] = []) -> ScrollsError {
    var detail = JSONObject()
    detail["field"] = field.map(JSONValue.string) ?? .null
    for (k, v) in extra { detail[k] = v }
    return ScrollsError(code: .validation, message: message, hint: hint, detail: .object(detail), status: 400)
  }

  /// 400 E_VALIDATION with `detail = {field: 'anchor', ...detail}` (anchors.mjs `invalid`).
  public static func anchor(_ message: String, hint: String? = nil, detail extra: [(String, JSONValue)] = []) -> ScrollsError {
    invalid(message, field: "anchor", hint: hint, extra: extra)
  }

  /// 404 E_NOT_FOUND with the reference's own sentence (`No annotation 12.`) and an optional detail.
  public static func notFound(_ message: String, hint: String? = nil, detail: JSONValue = .null) -> ScrollsError {
    ScrollsError(code: .notFound, message: message, hint: hint, detail: detail, status: 404)
  }

  /// 404 E_NOT_FOUND with `detail = {field}`.
  public static func notFound(_ message: String, hint: String? = nil, field: String) -> ScrollsError {
    notFound(message, hint: hint, detail: .object(["field": .string(field)]))
  }

  /// 409 with a provenance code (E_MACHINE_ANNOTATION, E_ANNOTATION_SUPERSEDED, E_ANNOTATION_WITHDRAWN).
  public static func conflict(_ code: String, _ message: String, hint: String?, detail: JSONValue) -> ScrollsError {
    ScrollsError(code: ErrorCode(rawValue: code), message: message, hint: hint, detail: detail, status: 409)
  }

  /// A SQLite constraint failure as the reference answers it (errors.mjs `toErrorBody`): 409 E_CONSTRAINT with the
  /// message after "constraint failed:".
  public static func constraint(_ e: StoreError) -> ScrollsError {
    var message = e.message
    if let r = message.range(of: "constraint failed:", options: [.caseInsensitive]) {
      message = String(message[r.upperBound...]).trimmingPrefixSpaces()
    }
    return ScrollsError(code: .constraint, message: message,
                        hint: "The database refused this change; see the message for the rule it would break.",
                        detail: .null, status: 409)
  }
}

extension String {
  func trimmingPrefixSpaces() -> String {
    var s = Substring(self)
    while let f = s.first, f == " " || f == "\t" || f == "\n" { s = s.dropFirst() }
    return String(s)
  }
}

// MARK: - the reference's shape check (contracts.mjs `check`), for the shapes these routes validate

/// A minimal port of `contracts.mjs` `validate`: the messages are the reference's (`$.kind: expected one of …`).
enum Shape: Sendable {
  case string, integer, number, boolean, object, array, stringArray, stringOrNull
  case oneOf([String])
  indirect case nullable(Shape)
  indirect case fields([(String, Shape, optional: Bool)])
  indirect case refine(Shape, @Sendable (JSONValue) -> [String])

  static let anchor = Shape.fields([
    ("doc_id", .integer, false), ("sha256", .string, false), ("field", .string, false), ("start", .integer, false),
    ("end", .integer, false), ("quote", .string, false), ("prefix", .string, true), ("suffix", .string, true),
  ])

  static let annotationRequest = Shape.refine(.fields([
    ("target", .fields([("type", .oneOf(Vocab.annotationTargets), false), ("ref", .string, false)]), false),
    ("anchor", .anchor, true),
    ("kind", .oneOf(Vocab.annotationKinds), false),
    ("body_md", .string, false),
    ("dimensions", .object, true),
    ("tags", .stringArray, true),
    ("evidence_refs", .array, true),
    ("layer", .stringOrNull, true),
    ("stance", .nullable(.oneOf(Vocab.stances)), true),
  ]), { v in
    let t = v["target"]?["type"]?.stringValue
    let hasAnchor = v["anchor"].map { !$0.isFalsy } ?? false
    if (t == "passage" || t == "occurrence"), !hasAnchor { return ["a \(t!) target needs an anchor"] }
    return []
  })

  static let annotationPatch = Shape.fields([
    ("body_md", .string, false), ("reason", .stringOrNull, true), ("dimensions", .object, true), ("tags", .stringArray, true),
  ])

  static let reviewRequest = Shape.fields([
    ("action", .oneOf(["confirm", "reject", "dispute"]), false), ("note", .string, false),
  ])

  /// `check(shape, obj)`: every message, in the reference's order (at most 50).
  func check(_ v: JSONValue?) -> [String] {
    var errs: [String] = []
    validate(v, "$", &errs)
    return Array(errs.prefix(50))
  }

  private func validate(_ v: JSONValue?, _ path: String, _ errs: inout [String]) {
    if errs.count >= 50 { return }
    switch self {
    case .string: if v?.stringValue == nil { errs.append("\(path): expected string, got \(Shape.typeName(v))") }
    case .integer: if !Shape.isSafeInteger(v) { errs.append("\(path): expected integer, got \(Shape.typeName(v))") }
    case .number:
      if case .number(let n)? = v, n.isFinite {} else { errs.append("\(path): expected number, got \(Shape.typeName(v))") }
    case .boolean: if v?.boolValue == nil { errs.append("\(path): expected boolean, got \(Shape.typeName(v))") }
    case .object: if v?.objectValue == nil { errs.append("\(path): expected object, got \(Shape.typeName(v))") }
    case .array: if v?.arrayValue == nil { errs.append("\(path): expected array, got \(Shape.typeName(v))") }
    case .stringArray:
      guard let a = v?.arrayValue else { errs.append("\(path): expected array, got \(Shape.typeName(v))"); return }
      for (i, x) in a.enumerated() where x.stringValue == nil {
        errs.append("\(path)[\(i)]: expected string, got \(Shape.typeName(x))")
      }
    case .stringOrNull:
      if v?.stringValue == nil, v?.isNull != true { errs.append("\(path): expected string|null, got \(Shape.typeName(v))") }
    case .oneOf(let values):
      if let s = v?.stringValue, values.contains(where: { JSString.equal($0, s) }) { return }
      errs.append("\(path): expected one of \(values.joined(separator: "|")), got \(v.map(CanonicalJSON.string) ?? "undefined")")
    case .nullable(let inner): if v?.isNull != true { inner.validate(v, path, &errs) }
    case .fields(let fields):
      guard let o = v?.objectValue else { errs.append("\(path): expected object, got \(Shape.typeName(v))"); return }
      for (key, sub, optional) in fields {
        guard let x = o[key] else {
          if !optional { errs.append("\(path).\(key): missing") }
          continue
        }
        sub.validate(x, "\(path).\(key)", &errs)
      }
    case .refine(let inner, let rule):
      let before = errs.count
      inner.validate(v, path, &errs)
      if errs.count == before, let v { for m in rule(v) { errs.append("\(path): \(m)") } }
    }
  }

  static func typeName(_ v: JSONValue?) -> String {
    guard let v else { return "undefined" }
    switch v {
    case .null: return "null"
    case .array: return "array"
    case .number(let n): return n.isFinite && n == n.rounded(.towardZero) ? "integer" : "number"
    case .string: return "string"
    case .bool: return "boolean"
    case .object: return "object"
    }
  }

  static func isSafeInteger(_ v: JSONValue?) -> Bool {
    guard case .number(let n)? = v else { return false }
    return JSNumber.isSafeInteger(n)
  }
}

extension Optional where Wrapped == JSONValue {
  /// `x ?? fallback` in JavaScript: a member that is absent or null reads as nullish.
  var nonNull: JSONValue? { self.flatMap { $0.isNull ? nil : $0 } }
}

extension JSONValue {
  /// JavaScript falsiness: null, false, 0, NaN and "" (objects and arrays are truthy).
  var isFalsy: Bool {
    switch self {
    case .null: true
    case .bool(let b): !b
    case .number(let n): n == 0 || n.isNaN
    case .string(let s): s.isEmpty
    case .array, .object: false
    }
  }

  /// `v ?? …` in JavaScript: null reads as absent.
  var nonNullValue: JSONValue? { isNull ? nil : self }

  /// `Number.isInteger(v)` as an Int (nil for non-integers and non-numbers).
  var integer: Int? {
    guard case .number(let n) = self, n.isFinite, n == n.rounded(.towardZero), abs(n) < 9.2e18 else { return nil }
    return Int(n)
  }
}
