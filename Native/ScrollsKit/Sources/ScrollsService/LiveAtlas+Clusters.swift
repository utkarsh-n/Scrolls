// OWNER: N4 — stub written by N0
// Clusters in process (server/routes/clusters.mjs): sense clusters of an expression (k-means with stability, labels
// and transitions).
// The signatures are AtlasService's, frozen at M0 (IOS-SPEC §8.4.6). Until the package ports the area, every
// method answers NOT_IMPLEMENTED (501); the owner replaces the bodies here and nowhere else.

import Foundation
import ScrollsContracts
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func clusters(_ r: ClustersRequest) async throws -> ClustersResponse {
    throw ScrollsError.notImplemented(area: "Clusters (clusters, package N4)")
  }
}
