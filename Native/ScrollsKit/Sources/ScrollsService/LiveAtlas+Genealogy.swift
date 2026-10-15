// OWNER: N5
// Genealogy in process (server/routes/genealogy.mjs): the sampling family tree of a work or a maker, generation by
// generation, documented links only by default, ≤ 150 rows with a cursor. The logic is ScrollsLineage's `Genealogy`,
// whose JSON equals the reference's (G3 `g3.lineage`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsLineage
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse {
    let args = r.queryArgs
    let json = try await read { c in try Genealogy.query(c, args) }
    return try ScrollsJSON.decode(GenealogyResponse.self, from: json)
  }
}
