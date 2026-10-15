// OWNER: N0
// The error of every AtlasService method: the reference's error body `{"error": {code, message, hint, detail}}`
// (server/http/errors.mjs). The HTTP status travels beside it, not in the body, so G7 can compare statuses.

import ScrollsCore

/// A stable machine code: `QUERY_TIMEOUT`, `E_NOT_FOUND`, `E_VALIDATION`, … (Docs/API.md "Error codes").
public struct ErrorCode: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public var description: String { rawValue }

  public static let badJSON = ErrorCode(rawValue: "E_BAD_JSON")
  public static let badID = ErrorCode(rawValue: "E_BAD_ID")
  public static let badStatus = ErrorCode(rawValue: "E_BAD_STATUS")
  public static let badCursor = ErrorCode(rawValue: "E_BAD_CURSOR")
  public static let badLimit = ErrorCode(rawValue: "E_BAD_LIMIT")
  public static let validation = ErrorCode(rawValue: "E_VALIDATION")
  public static let jobType = ErrorCode(rawValue: "E_JOB_TYPE")
  public static let notFound = ErrorCode(rawValue: "E_NOT_FOUND")
  public static let constraint = ErrorCode(rawValue: "E_CONSTRAINT")
  public static let inputsChanged = ErrorCode(rawValue: "E_INPUTS_CHANGED")
  public static let range = ErrorCode(rawValue: "E_RANGE")
  public static let queryUnknown = ErrorCode(rawValue: "E_QUERY_UNKNOWN")
  public static let notMaterialized = ErrorCode(rawValue: "E_NOT_MATERIALIZED")
  public static let busy = ErrorCode(rawValue: "E_BUSY")
  public static let queryTimeout = ErrorCode(rawValue: "QUERY_TIMEOUT")
  public static let notImplemented = ErrorCode(rawValue: "NOT_IMPLEMENTED")
  public static let internalError = ErrorCode(rawValue: "E_INTERNAL")
  /// The atlas root is under Documents/, an App Group or iCloud (ΔS-3; the CLI keeps E_DB_IN_ICLOUD).
  public static let dbInICloud = ErrorCode(rawValue: "E_DB_IN_ICLOUD")
  /// Phone only: the probe found this phone's SQLite or ICU different from the build's (§1.4); nothing was changed.
  public static let probeRefused = ErrorCode(rawValue: "E_PROBE_REFUSED")
  /// Phone only: the atlas failed its integrity check at open (`quick_check`, pack or original sha256).
  public static let integrityFailed = ErrorCode(rawValue: "E_INTEGRITY_FAILED")
  /// Phone only: the read pool is drained while a new generation is swapped in (§3.5 step 6); retry shortly.
  public static let atlasSwapping = ErrorCode(rawValue: "E_ATLAS_SWAPPING")
  /// The atlas was written by a newer schema than this engine knows; nothing was changed.
  public static let schemaNewer = ErrorCode(rawValue: "E_SCHEMA_NEWER")
  /// The atlas's schema hash differs from the bundled `schema.sql` at the same version.
  public static let schemaMismatch = ErrorCode(rawValue: "E_SCHEMA_MISMATCH")
  /// The file is a SQLite database that is not a Scrolls atlas (tables but no `meta`).
  public static let dbForeign = ErrorCode(rawValue: "E_DB_FOREIGN")
  /// A job failed because a job it waits for (`after:`) did not succeed.
  public static let dependency = ErrorCode(rawValue: "E_DEPENDENCY")
}

/// An error answer of the in-process API, with the reference's body fields and the HTTP status the reference would
/// have sent (nil when it is not known, for example a decoded body).
public struct ScrollsError: Error, Sendable, Equatable, CustomStringConvertible {
  public let code: ErrorCode
  public let message: String
  /// What the reader can do about it; null in the body when there is nothing to suggest.
  public let hint: String?
  /// Structured detail (`{field: 'runs'}`, the validation messages …); null when there is none.
  public let detail: JSONValue
  /// The status the reference answers with (400, 403, 404, 409, 413, 503, 500, 501 …). Not part of the body.
  public let status: Int?

  public init(code: ErrorCode, message: String, hint: String? = nil, detail: JSONValue = .null, status: Int? = nil) {
    self.code = code
    self.message = message
    self.hint = hint
    self.detail = detail
    self.status = status
  }

  /// The stub answer of an area that is not ported yet (reference: 501 NOT_IMPLEMENTED).
  public static func notImplemented(area: String) -> ScrollsError {
    ScrollsError(code: .notImplemented, message: "\(area) is not implemented yet.",
                 hint: "This part of the engine is still a stub (IOS-SPEC §8.1).", detail: .null, status: 501)
  }

  /// 404 E_NOT_FOUND, worded as the reference's `notFound(what)`.
  public static func notFound(_ what: String) -> ScrollsError {
    ScrollsError(code: .notFound, message: "\(what) not found.", status: 404)
  }

  /// 400 with a code (E_VALIDATION by default), as the reference's `badRequest`.
  public static func badRequest(_ code: ErrorCode = .validation, _ message: String, hint: String? = nil,
                                detail: JSONValue = .null) -> ScrollsError {
    ScrollsError(code: code, message: message, hint: hint, detail: detail, status: 400)
  }

  public var description: String { "\(code.rawValue): \(message)" + (hint.map { " (\($0))" } ?? "") }
}

extension ScrollsError: Codable {
  private enum Keys: String, CodingKey { case code, message, hint, detail }

  /// Decodes the inner error object `{code, message, hint, detail}`.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    code = try c.decode(ErrorCode.self, forKey: .code)
    message = try c.decode(String.self, forKey: .message)
    hint = try c.decodeIfPresent(String.self, forKey: .hint)
    detail = try c.decodeIfPresent(JSONValue.self, forKey: .detail) ?? .null
    status = nil
  }

  /// Encodes the inner error object; `hint` and `detail` are always written (null when empty), as the reference does.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(code, forKey: .code)
    try c.encode(message, forKey: .message)
    if let hint { try c.encode(hint, forKey: .hint) } else { try c.encodeNil(forKey: .hint) }
    try c.encode(detail, forKey: .detail)
  }
}

/// The error body `{"error": {...}}` (contract shape `ErrorBody`).
public struct ErrorBody: Codable, Sendable, Equatable {
  public var error: ScrollsError
  public init(error: ScrollsError) { self.error = error }
}
