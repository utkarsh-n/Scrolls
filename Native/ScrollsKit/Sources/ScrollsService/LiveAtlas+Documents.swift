// OWNER: N3
// Documents in process (server/routes/documents.mjs): the document card (every `doc_tag` row, aliases, the date
// assertions with the chronology one marked, `original_meta_json` verbatim) and text slices of at most 20,000 UTF-16
// units of the original, read through `TextStore` (a chunked device atlas decodes only the chunks the slice covers).

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func document(_ id: DocumentID) async throws -> DocumentResponse {
    let text = TextAccess(store: self.text)
    return try await read { c in try Reading.document(c, text: text, id: id.rawValue) }
  }

  @concurrent
  public func documentText(_ id: DocumentID, from: Int?, to: Int?) async throws -> DocumentTextResponse {
    let text = TextAccess(store: self.text)
    return try await read { c in try Reading.documentText(c, text: text, id: id.rawValue, from: from, to: to) }
  }
}
