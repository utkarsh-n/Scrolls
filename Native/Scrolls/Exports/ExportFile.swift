// OWNER: N3
// One export as a `Transferable` (IOS-SPEC §3.10 "Out"): a ShareLink hands the system a file representation whose export
// runs lazily — the engine builds the file (`AtlasService.export`, manifest first, `export_text_allowed = 0` respected)
// only when the share sheet asks for it, into tmp/, and the system copies it where he chooses.

import CoreTransferable
import Foundation
import ScrollsContracts
import ScrollsService
import UniformTypeIdentifiers

/// What and how to export, for the current view state (SPEC §8.2 hash).
nonisolated struct ExportFile: Transferable, Sendable {
  let atlas: any AtlasService
  /// The view state hash (`v=1&c=…`), as the export's `state`.
  let state: String
  /// occurrences · aggregates · passages · relationships · annotations
  let what: String
  /// json · jsonl · csv
  let format: String
  /// The tier of an aggregates export.
  let tier: String

  static let jsonl = UTType(filenameExtension: "jsonl", conformingTo: .data) ?? .data

  /// Writes the export into a fresh file under tmp/ and returns it.
  func write() async throws -> URL {
    let r = try await atlas.export(ExportRequest(state: state, what: what, format: format, tier: tier))
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent(r.fileName ?? ExportsCopy.fileName(what, format))
    try r.data.write(to: url, options: .atomic)
    return url
  }

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .json) { item in SentTransferredFile(try await item.write()) }
      .exportingCondition { $0.format == "json" }
    FileRepresentation(exportedContentType: jsonl) { item in SentTransferredFile(try await item.write()) }
      .exportingCondition { $0.format == "jsonl" }
    FileRepresentation(exportedContentType: .commaSeparatedText) { item in SentTransferredFile(try await item.write()) }
      .exportingCondition { $0.format == "csv" }
  }
}
