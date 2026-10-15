// OWNER: N0
// The statement catalogue (IOS-SPEC §1.4, platform graft): every SQL text of the engine is a `static let` of an
// `enum <Area>SQL: SQLCatalog`, so SQLCatalogTests can EXPLAIN every statement and find full scans.

/// Whether a statement may scan a large table (`passage`, `document`, `relationship`, …) without an index.
public enum ScanPolicy: Sendable, Hashable {
  case indexOnly
  case scanOK(reason: String)
}

/// One catalogued statement: a stable id (for logs and the catalogue test), its text and its scan policy.
public struct SQL: Sendable, Hashable {
  public let id: String
  public let text: String
  public let scan: ScanPolicy

  public init(_ id: String, _ text: String, scan: ScanPolicy = .indexOnly) {
    self.id = id
    self.text = text
    self.scan = scan
  }
}

/// One enum per area lists its statements; SQLCatalogTests reads them all.
public protocol SQLCatalog {
  static var all: [SQL] { get }
}
