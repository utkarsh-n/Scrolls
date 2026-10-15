// OWNER: N1
// Port of server/ingest/summary.mjs (SPEC §5.7, contract shape `ImportSummary`): one builder for the dry run
// (projected: nothing written, data_version and run_id null) and the commit, so the two summaries compare field by field;
// the problems.csv lines; and the bridge to the frozen contract type `ImportSummary`.

import Foundation
import ScrollsContracts
import ScrollsCore

/// Rows seen, accepted (with and without warnings) and rejected (`rows` of runImport).
public struct RowTally: Sendable, Equatable {
  public var seen = 0
  public var accepted = 0
  public var acceptedWithWarnings = 0
  public var rejected = 0
  public init() {}
  public var json: JSONValue {
    ["seen": .number(Double(seen)), "accepted": .number(Double(accepted)), "accepted_with_warnings": .number(Double(acceptedWithWarnings)),
     "rejected": .number(Double(rejected))]
  }
}

/// Values of one date target that were not empty, and those that parsed.
public struct DateStat: Sendable, Equatable {
  public var nonEmpty = 0
  public var parsed = 0
}

/// The file facts of a summary.
public struct ImportFileFacts: Sendable, Equatable {
  public var name: String
  public var sha256: String?
  public var bytes: Int
  public var encoding: String
  public var format: String
  public var delimiter: String?
}

public enum ImportSummaries {
  /// problems.csv columns, in order (the contract fixture's header).
  public static let problemColumns = ["code", "severity", "line", "col", "field", "value_excerpt", "message", "suggestion"]
  /// The header line of problems.csv.
  public static let problemsHeader = problemColumns.joined(separator: ",") + "\n"

  /// One CSV cell (RFC 4180 quoting).
  public static func csvCell(_ v: String?) -> String {
    guard let s = v else { return "" }
    if s.utf16.contains(where: { $0 == 0x22 || $0 == 0x2C || $0 == 0x0D || $0 == 0x0A }) {
      return "\"" + JSString.split(s, "\"").joined(separator: "\"\"") + "\""
    }
    return s
  }

  /// One problems.csv line for an issue.
  public static func problemLine(_ i: Issue) -> String {
    [csvCell(i.code), csvCell(i.severity), csvCell(i.line.map(String.init)), csvCell(i.col.map(String.init)), csvCell(i.field),
     csvCell(i.valueExcerpt), csvCell(i.message), csvCell(i.suggestion)].joined(separator: ",") + "\n"
  }

  /// `mappingDecisions(mapping, dateStats)`: one per mapped target.
  public static func mappingDecisions(_ m: Mapping, _ dateStats: [String: DateStat]) -> JSONValue {
    .array(m.fields.map { target, spec in
      let st = dateStats[target]
      let rate: JSONValue = st.map { $0.nonEmpty > 0 ? .number(JSNumber.round(Double($0.parsed) / Double($0.nonEmpty) * 1000) / 1000) : .null } ?? .null
      var reason: String
      if let r = spec.reason { reason = r }
      else if let c = spec.constValue { reason = "constant \(JSString.slice(JSText.stringify(c), 0, 80))" }
      else { reason = "chosen in the mapping step" }
      if let st, st.nonEmpty > 0 { reason += "; \(Format.int(st.parsed)) of \(Format.int(st.nonEmpty)) values parse as dates" }
      return .object([
        "target": .string(target), "from": spec.from.map { .string(JSText.string($0)) } ?? .null,
        "transform": MappingRules.describe(spec.transforms).map(JSONValue.string) ?? .null, "parse_rate": rate, "reason": .string(reason),
      ])
    })
  }

  /// An issue as the summary lists it (`{code, severity, line, col, field, value_excerpt, message, suggestion}`).
  public static func issueJSON(_ i: Issue) -> JSONValue { Tally.issueJSON(i) }

  /// What `buildSummary` needs besides the counts.
  public struct Info: Sendable {
    public var batchID: Int64
    public var collection: String
    public var file: ImportFileFacts
    public var rows: RowTally
    public var mapping: Mapping
    public var dateStats: [String: DateStat] = [:]
    public var dataVersion: Int?
    public var runID: Int64?
    public var startedAt: String?
    public var finishedAt: String?
    public var durationMs: Int?
    public var projected = false
    /// The fatal problem (an Issue's JSON, or `{code, message, suggestion}` of a failed job).
    public var fatal: JSONValue = .null
    public var aborted: JSONValue = .null
    public var notes: [String] = []
    public var status: String?
  }

  /// `buildSummary(counts, info)`: the ImportSummary object (the reference's full shape).
  public static func build(_ counts: JSONValue, _ info: Info) -> JSONValue {
    let c = counts
    func n(_ v: JSONValue?) -> JSONValue { v ?? .number(0) }
    let docs = c["documents"]
    let rels = c["relationships"]
    let issues = c["issues"]
    let f = info.file
    return .object([
      "import_batch_id": .number(Double(info.batchID)),
      "collection": .string(info.collection),
      "file": .object(["name": .string(f.name), "sha256": f.sha256.map(JSONValue.string) ?? .null, "bytes": .number(Double(f.bytes)),
                       "encoding": .string(f.encoding), "format": .string(f.format), "delimiter": f.delimiter.map(JSONValue.string) ?? .null]),
      "rows": info.rows.json,
      "documents": .object(["created": n(docs?["created"]), "duplicates_flagged": n(docs?["duplicates_flagged"]),
                            "metadata_only": n(docs?["metadata_only"]), "translations": n(docs?["translations"]),
                            "near_duplicates": n(docs?["near_duplicates"])]),
      "passages": n(c["passages"]),
      "tokens": n(c["tokens"]),
      "dates": c["dates"] ?? .object([:]),
      "languages": c["languages"] ?? .object([:]),
      "relationships": .object(["documented": n(rels?["documented"]), "proposed": n(rels?["proposed"]),
                                "unresolved_targets": n(rels?["unresolved_targets"]), "rejected": n(rels?["rejected"])]),
      "mapping_decisions": mappingDecisions(info.mapping, info.dateStats),
      "problems": .object(["by_code": issues?["by_code"] ?? .object([:]), "total": n(issues?["total"]), "first": issues?["first"] ?? .array([]),
                           "download": .string("/api/imports/\(info.batchID)/problems.csv")]),
      "data_version": info.dataVersion.map { .number(Double($0)) } ?? .null,
      "run_id": info.runID.map { .number(Double($0)) } ?? .null,
      "started_at": info.startedAt.map(JSONValue.string) ?? .null,
      "finished_at": info.finishedAt.map(JSONValue.string) ?? .null,
      "duration_ms": info.durationMs.map { .number(Double($0)) } ?? .null,
      "projected": .bool(info.projected),
      "status": .string(info.status ?? (info.projected ? "validated" : "committed")),
      "fatal": info.fatal,
      "aborted": info.aborted,
      "notes": .array(info.notes.map(JSONValue.string)),
    ])
  }

  /// The frozen contract type from the full summary (`status`, `fatal`, `aborted`, `notes`, `projected` and the counts the
  /// contract has no member for stay in the full JSON, which `import_batch.summary_json` keeps).
  public static func contract(_ s: JSONValue) throws -> ImportSummary {
    try ScrollsJSON.decode(ImportSummary.self, from: s)
  }
}
