// OWNER: N3
// Occurrences in process (server/routes/passages.mjs, GET /api/occurrences/:id): one occurrence of a tracked expression
// — its passage, document, offsets, name-guard flag and the materialize run that wrote it.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func occurrence(_ id: OccurrenceID) async throws -> OccurrenceResponse {
    try await read { c in try Reading.occurrence(c, id.rawValue) }
  }
}
