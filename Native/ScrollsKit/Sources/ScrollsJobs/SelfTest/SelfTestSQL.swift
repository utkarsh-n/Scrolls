// OWNER: N0
// The engine self-test's statement (EngineSelfTest.swift). It reads no table, so it is not an atlas catalogue entry
// (SQLCatalogTests EXPLAIN those against an atlas).

/// SQL of the engine self-test.
enum SelfTestSQL {
  /// ≈ 10⁹ VM steps: runs for minutes unless the deadline, a cancellation or an interrupt stops it.
  static let longCount =
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT count(*) FROM n"
}
