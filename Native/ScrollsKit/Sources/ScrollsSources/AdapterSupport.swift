// OWNER: N2
// What some adapters offer beyond the frozen `SourceAdapter` (the optional members of api.mjs and the loader-side
// record keys of adapter-load.mjs), as separate protocols so the frozen one never changes:
// - etymology rows (`cipher.roots` → etymon tables) and theme associations (`cipher.themes` → theme_assoc), which are
//   not documents;
// - aliases onto documents of other collections (`cipher.relations` endpoints that are culture works);
// - a record's source line (`_line`) and the issues an adapter found in a record (`_issues`), carried through
//   `AdapterContext.warn` as `RecordIssue` details so the loader writes them after the record's batch;
// - binding: an adapter value that knows which packs to read (`SourceFiles`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// One `etymon` row with its parents and members (roots.tsv).
public struct EtymonRecord: Sendable, Equatable {
  public struct Member: Sendable, Equatable {
    public var lang: String
    public var word: String
    public var norm: String
    public var rank: Int
  }
  public var key: String
  public var kind: String
  public var lang: String
  public var form: String
  public var roman: String?
  public var gloss: String?
  /// Parent keys in their listed order.
  public var parents: [String]
  public var parentSemantics: String
  public var members: [Member]
}

/// One `theme_assoc` row (culture-themes.tsv).
public struct ThemeAssocRecord: Sendable, Equatable {
  public var theme: String
  public var other: String
  public var npmi: Double
  public var count: Int
}

/// An alias onto a document of another collection.
public struct AliasRecord: Sendable, Equatable {
  public var target: DocKey
  public var alias: CanonicalAlias
  public init(target: DocKey, alias: CanonicalAlias) {
    self.target = target
    self.alias = alias
  }
}

/// An adapter whose load also writes the etymon tables.
public protocol EtymonSource: SourceAdapter {
  func etymons(_ params: JSONValue, _ context: AdapterContext) async throws -> [EtymonRecord]
}

/// An adapter whose load also writes theme associations and their typeahead labels.
public protocol ThemeAssocSource: SourceAdapter {
  func themeAssocs(_ params: JSONValue, _ context: AdapterContext) async throws -> [ThemeAssocRecord]
  func themeLabels(_ params: JSONValue, _ context: AdapterContext) async throws -> [String]
}

/// An adapter that adds aliases to documents of other collections before its relationships resolve.
public protocol AliasSource: SourceAdapter {
  func aliases(_ params: JSONValue, _ context: AdapterContext) async throws -> [AliasRecord]
}

/// An adapter whose documents name their source line (the import issue's `line`).
public protocol SourceLines: SourceAdapter {
  func line(of document: CanonicalDocument) -> Int?
}

/// An adapter value bound to the packs it reads.
public protocol PackBoundAdapter: SourceAdapter {
  /// The packs this value reads (`.none` for the registry's unbound value).
  var files: SourceFiles { get }
  /// The same adapter reading `files`.
  func bound(to files: SourceFiles) -> Self
  /// The packs (by name) whose members it reads, in lookup order.
  static var packNames: [String] { get }
}

/// Caveats of an adapter's collections (the reference's `CollectionSpec.caveats`, which the frozen Swift
/// `CollectionSpec` does not carry); the loader writes them, with the probe's, into `collection.caveats_json`.
public protocol CollectionCaveats: SourceAdapter {
  var collectionCaveats: [String: [String]] { get }
}

/// An issue an adapter found in one record (the reference's `_issues`), sent through `AdapterContext.warn` with
/// `detail` = `jsonValue`; the loader turns it back into an `Issue` and writes it after the record's batch.
public struct RecordIssue: Sendable, Equatable {
  public var code: String
  public var severity: String
  public var field: String?
  public var message: String
  public var suggestion: String
  public var extId: String?
  public var line: Int?

  public init(code: String, severity: String = "warning", field: String? = nil, message: String, suggestion: String,
              extId: String? = nil, line: Int? = nil) {
    self.code = code
    self.severity = severity
    self.field = field
    self.message = message
    self.suggestion = suggestion
    self.extId = extId
    self.line = line
  }

  public var jsonValue: JSONValue {
    var o: JSONObject = ["code": .string(code), "severity": .string(severity), "message": .string(message),
                         "suggestion": .string(suggestion), "record_issue": .bool(true)]
    if let field { o["field"] = .string(field) }
    if let extId { o["ext_id"] = .string(extId) }
    if let line { o["line"] = .number(Double(line)) }
    return .object(o)
  }

  /// The issue of a `warn` call: a RecordIssue detail when the adapter sent one, otherwise the reference's generic
  /// adapter warning (`value_excerpt` = the detail's ext_id).
  public static func issue(code: String, message: String, detail: JSONValue?) -> Issue {
    if let d = detail, d["record_issue"]?.boolValue == true {
      return Issue(code: code, severity: d["severity"]?.stringValue ?? "warning", line: d["line"]?.safeInteger, col: nil,
                   field: d["field"]?.stringValue, valueExcerpt: d["ext_id"]?.stringValue, message: message,
                   suggestion: d["suggestion"]?.stringValue ?? "See the message; the record was skipped or kept as noted.")
    }
    return Issue(code: code, severity: "warning", line: nil, col: nil, field: nil, valueExcerpt: detail?["ext_id"]?.stringValue,
                 message: message,
                 suggestion: detail?["suggestion"]?.stringValue ?? "See the message; the record was skipped or kept as noted.")
  }
}

extension AdapterContext {
  /// Sends a record's issue to the loader.
  public func report(_ issue: RecordIssue) {
    warn(issue.code, issue.message, issue.jsonValue)
  }
}

/// Batches of up to 500 records into a `BoundedChannel` (§1.5): `append` sends a full batch (suspending while the
/// writer is behind), `flush` sends the rest.
public struct BatchSender<Element: Sendable> {
  public static var batchSize: Int { 500 }
  private let channel: BoundedChannel<[Element]>
  private var buffer: [Element] = []

  public init(_ channel: BoundedChannel<[Element]>) {
    self.channel = channel
    buffer.reserveCapacity(Self.batchSize)
  }

  public mutating func append(_ e: Element) async throws {
    buffer.append(e)
    if buffer.count >= Self.batchSize { try await flush() }
  }

  public mutating func flush() async throws {
    guard !buffer.isEmpty else { return }
    let batch = buffer
    buffer.removeAll(keepingCapacity: true)
    try await channel.send(batch)
  }
}

/// The probe result of an adapter whose pack is not on this phone.
extension AdapterProbeResult {
  public static func packMissing(_ packs: [String]) -> AdapterProbeResult {
    AdapterProbeResult(available: false,
                       reason: "the \(packs.joined(separator: " and ")) pack\(packs.count == 1 ? " is" : "s are") not on this phone",
                       manifestOK: false, formatOK: false)
  }

  public static func memberMissing(_ member: String) -> AdapterProbeResult {
    AdapterProbeResult(available: false, reason: "\(member) is not in the pack", manifestOK: false, formatOK: false)
  }
}
