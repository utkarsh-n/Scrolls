// OWNER: N3
// Exports in process (server/routes/exports.mjs, GET /api/export): occurrences, passages, aggregates (Σ bins + Σ washes
// + undated + scheduled = total, per lane), relationships and annotations as JSON, JSONL (the manifest is the first
// line) or CSV (the manifest as `#` lines), each with its manifest first: export version, view, state, data version,
// runs with their params, filters, toggles, synthetic_included, licences and attributions. Collections with
// `export_text_allowed = 0` export ids, offsets and locators only, in every format. The portable HTML bundle is later
// (ΔS-14). Exports run on a job reader with the reference's 30 s budget.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func export(_ r: ExportRequest) async throws -> ExportResponse {
    let view = r.view.flatMap { $0.isEmpty ? nil : $0 }, state = r.state.flatMap { $0.isEmpty ? nil : $0 }
    if view == nil && state == nil {
      throw ScrollsError.badRequest(.validation, "An export needs view=<slug> or state=<…>.",
                                    hint: "Export from a saved view, or pass the current state.",
                                    detail: .object(["field": .string("state")]))
    }
    let text = TextAccess(store: self.text)
    let file = try await reads.read(.interactive, deadline: .seconds(30)) { c in
      try Exports.export(c, text: text, view: view, state: state, what: r.what ?? "occurrences", format: r.format ?? "json",
                         tier: r.tier ?? "L2")
    }
    return ExportResponse(contentType: file.contentType, fileName: file.fileName, rows: file.rows, data: Data(file.body.utf8))
  }
}
