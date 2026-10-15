// OWNER: N0
// Typed row ids of contract 1.3.0 (IOS-SPEC §8.4.5). Each is a bare JSON number on the wire; the types only keep a
// passage id from being passed where a document id is wanted. Job ids belong to ScrollsJobs (`JobID`); contract
// payloads carry them as plain integers.

/// The shared shape of the typed ids: a row id (< 2³¹ by IOS-SPEC N-11) that encodes as a bare JSON number.
public protocol ContractID: RawRepresentable, Hashable, Sendable, Codable, Comparable, CustomStringConvertible,
  ExpressibleByIntegerLiteral where RawValue == Int64
{
  init(rawValue: Int64)
}

extension ContractID {
  public init(_ value: Int) { self.init(rawValue: Int64(value)) }
  public init(integerLiteral value: Int64) { self.init(rawValue: value) }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    let d = try c.decode(Double.self)
    guard let v = Int64(exactly: d) else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "\(Self.self): \(d) is not an integer id")
    }
    self.init(rawValue: v)
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
  public var description: String { String(rawValue) }
}

/// `document.id`.
public struct DocumentID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `passage.id`.
public struct PassageID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `expression.id`.
public struct ExpressionID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `occurrence.id`.
public struct OccurrenceID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `relationship.id`.
public struct RelationshipID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `annotation.id`.
public struct AnnotationID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `analysis_run.id`.
public struct RunID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `import_batch.id`.
public struct ImportBatchID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `collection.id`.
public struct CollectionID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `hypothesis_group.id`.
public struct HypothesisGroupID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
/// `relationship_evidence.id`.
public struct EvidenceID: ContractID { public let rawValue: Int64; public init(rawValue: Int64) { self.rawValue = rawValue } }
