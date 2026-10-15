// OWNER: N2 — stub written by N0
// Baseline in process (server/routes/baseline.mjs): the Ngram baseline series and its rho, from the attached read-only
// Ngram file.
// The signatures are AtlasService's, frozen at M0 (IOS-SPEC §8.4.6). Until the package ports the area, every
// method answers NOT_IMPLEMENTED (501); the owner replaces the bodies here and nowhere else.

import Foundation
import ScrollsContracts
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func baseline(_ r: BaselineRequest) async throws -> BaselineResponse {
    throw ScrollsError.notImplemented(area: "Baseline (baseline, package N2)")
  }
}
