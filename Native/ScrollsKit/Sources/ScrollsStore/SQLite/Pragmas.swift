// OWNER: N0
// The PRAGMAs of each connection role (IOS-SPEC §1.4).

/// The PRAGMA sets of IOS-SPEC §1.4.
enum Pragmas {
  static let all = "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;"  // lint: sql-ok (connection PRAGMAs of IOS-SPEC §1.4, applied at open)
  static let wal = "PRAGMA journal_mode = WAL;"  // lint: sql-ok (connection PRAGMAs of IOS-SPEC §1.4, applied at open)
  static let writer = "PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536; PRAGMA mmap_size = 0; PRAGMA wal_autocheckpoint = 1000;"  // lint: sql-ok (connection PRAGMAs of IOS-SPEC §1.4, applied at open)
  static func reader(mmapBytes: Int) -> String {
    "PRAGMA query_only = 1; PRAGMA cache_size = -32768; PRAGMA mmap_size = \(max(0, mmapBytes));"  // lint: sql-ok (connection PRAGMAs of IOS-SPEC §1.4, applied at open)
  }
}
