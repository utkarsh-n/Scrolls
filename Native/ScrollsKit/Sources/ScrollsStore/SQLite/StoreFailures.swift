// OWNER: N0
// The contract errors the Store raises itself (ErrorBody codes of contract 1.3.0). Every ScrollsError the Store makes is
// built here, so the Store has one place that depends on the shape of ScrollsContracts' error type.

import Foundation
import ScrollsContracts
import ScrollsCore

/// Contract errors raised by the SQLite layer.
public enum StoreFailures {
  /// QUERY_TIMEOUT: the reference's read-pool timeout (`readpool.mjs`), same message and hint.
  public static func queryTimeout(_ limit: Duration) -> ScrollsError {
    let ms = Int(limit.components.seconds) * 1000 + Int(limit.components.attoseconds / 1_000_000_000_000_000)
    return ScrollsError(code: .queryTimeout,
                        message: "The query took longer than \(ms) ms and was stopped.",
                        hint: "Narrow the time range or filters, or wait for indexing jobs to finish, then retry.",
                        detail: .object(["timeoutMs": .number(Double(ms))]), status: 503)
  }

  /// E_ATLAS_SWAPPING: the read pool is drained for a generation swap (IOS-SPEC §3.5 step 6).
  public static func swapping() -> ScrollsError {
    ScrollsError(code: .atlasSwapping,
                 message: "The atlas is being replaced by a new generation.",
                 hint: "Try again in a moment; nothing was changed.", detail: nil, status: 503)
  }

  /// E_PROBE_REFUSED: the probe found this phone's SQLite incompatible (IOS-SPEC §1.4).
  public static func probeRefused(_ details: String) -> ScrollsError {
    ScrollsError(code: .probeRefused,
                 message: "This phone's SQLite tokenizes differently from the one Scrolls was built against (\(details)). Nothing was changed.",
                 hint: "Report this with Settings → Diagnostics → Probe.", detail: nil)
  }
}
