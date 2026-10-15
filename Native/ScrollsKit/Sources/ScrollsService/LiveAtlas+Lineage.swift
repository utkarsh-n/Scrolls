// OWNER: N5
// Lineage in process (server/routes/lineage.mjs): the bounded lineage graph of a root (a passage, document, expression,
// … or 'shared:<key>' for a widely shared text) and the chain of custody between two items. Both read on the
// interactive reader; the logic is ScrollsLineage's port (`LineageGraph`, `ChainOfCustody`), whose JSON equals the
// reference's (G3 `g3.lineage`) and is decoded here into the contract types.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsLineage
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func lineage(_ r: LineageRequest) async throws -> LineageResponse {
    let text = self.text, path = location.atlasPath, args = r.queryArgs
    let json = try await read { c in try LineageGraph.query(LineageReader(c, text: text, atlasPath: path), args) }
    return try ScrollsJSON.decode(LineageResponse.self, from: json)
  }

  @concurrent
  public func lineagePath(_ r: LineagePathRequest) async throws -> LineagePathResponse {
    let args = r.queryArgs
    let json = try await read { c in try ChainOfCustody.query(c, args) }
    return try ScrollsJSON.decode(LineagePathResponse.self, from: json)
  }
}
