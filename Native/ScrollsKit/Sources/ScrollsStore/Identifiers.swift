// OWNER: N0
// Identifiers the Store needs below ScrollsJobs and ScrollsContracts' request types: the job id (the writer's lease
// names its job), the analysis stage of a run, and a run's status. All encode as their bare JSON value.

import Foundation
import ScrollsCore

/// A row id of `job` (a log table: commit order).
public struct JobID: RawRepresentable, Hashable, Sendable, Codable, Comparable, CustomStringConvertible {
  public let rawValue: Int64
  public init(rawValue: Int64) { self.rawValue = rawValue }
  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(Int64.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public static func < (a: JobID, b: JobID) -> Bool { a.rawValue < b.rawValue }
  public var description: String { "job \(rawValue)" }
}

/// An analysis stage (`vocab.STAGES`): the `stage` of an `analysis_run` row and of a `RunKey`.
public struct Stage: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public var description: String { rawValue }
  /// Whether the stage is one of `Vocab.stages`.
  public var isKnown: Bool { Vocab.stages.contains(rawValue) }
}

/// The status of an `analysis_run` (`vocab.RUN_STATUS`). Rows of a run are visible only once it is `succeeded`.
public enum RunStatus: String, Sendable, Codable, CaseIterable {
  case running, succeeded, failed, cancelled, superseded
}
