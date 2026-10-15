// OWNER: N4 — stub written by N0
// Constellation in process (server/routes/constellation.mjs): the constellation layout (overlay mode, ΔS-10).
// The signatures are AtlasService's, frozen at M0 (IOS-SPEC §8.4.6). Until the package ports the area, every
// method answers NOT_IMPLEMENTED (501); the owner replaces the bodies here and nowhere else.

import Foundation
import ScrollsContracts
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse {
    throw ScrollsError.notImplemented(area: "Constellation (constellation, package N4)")
  }
}
