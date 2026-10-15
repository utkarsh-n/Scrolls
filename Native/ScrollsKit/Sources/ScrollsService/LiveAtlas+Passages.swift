// OWNER: N3
// Passages in process (server/routes/passages.mjs, GET /api/passages/:id): a passage at exact UTF-16 offsets read
// through `TextStore` (D4: offsets index the decoded original, or the field value for titles and summaries), its
// neighbours with `context`, highlights of the requested expressions' occurrences (relative to the passage text), the
// document card, the anchor, machine labels, and counts of relationships and annotations.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func passage(_ id: PassageID, _ r: PassageRequest) async throws -> PassageResponse {
    let text = TextAccess(store: self.text)
    return try await read { c in
      try Reading.passage(c, text: text, id: id.rawValue, context: r.context ?? false, expr: r.expr.map { [$0.rawValue] },
                          occ: r.occ?.rawValue)
    }
  }
}
