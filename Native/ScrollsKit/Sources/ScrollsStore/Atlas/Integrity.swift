// OWNER: N0
// Integrity checks (IOS-SPEC §1.3 db/integrity → ScrollsStore/Integrity.swift): `PRAGMA quick_check(100)` when an atlas
// opens (and on a generation before its swap), the full quick_check and text verification as maintenance work.

import Foundation
import ScrollsContracts

/// The result of a quick_check.
public struct IntegrityReport: Codable, Sendable, Equatable {
  public let ok: Bool
  /// "ok", or up to `limit` problem descriptions.
  public let messages: [String]
  public let at: String
}

/// SQLite integrity and text verification.
public enum Integrity {
  /// `PRAGMA quick_check(limit)` (≤ `limit` messages). Runs on any connection; a reader is enough.
  public static func quickCheck(_ c: Connection, limit: Int = 100) throws -> IntegrityReport {
    let sql = limit == 100 ? try c.prepared(StoreSQL.quickCheck) : try c.prepared(dynamic: "PRAGMA quick_check(\(max(1, limit)))")  // lint: sql-ok (PRAGMA argument is the requested message limit)
    let messages = try sql.all { $0.text(0) }
    return IntegrityReport(ok: messages == ["ok"], messages: messages, at: StoreClock.isoNow())
  }

  /// Verifies the stored text of `documents` against their `original_sha256` (D18); returns those that differ.
  public static func verifyText(_ documents: [DocumentID], text: any TextStore, on c: Connection) throws -> [DocumentID] {
    try documents.filter { try !text.verify($0, on: c) }
  }
}
