// OWNER: N0
// The Store's statement catalogue (meta, id counters, journal bookkeeping, vocab seed, text chunks, migrations).

import Foundation

/// Statements of ScrollsStore.
public enum StoreSQL: SQLCatalog {
  // meta (the reference's open.mjs getMeta / setMeta / bumpDataVersion)
  static let getMeta = SQL("store.meta.get", "SELECT value FROM meta WHERE key = ?")
  static let setMeta = SQL("store.meta.set",
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  static let bumpDataVersion = SQL("store.meta.bump", """
    INSERT INTO meta(key, value) VALUES ('data_version', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value
    """)
  static let tableNamed = SQL("store.master.table", "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    scan: .scanOK(reason: "sqlite_master is small"))
  static let tableCount = SQL("store.master.count", "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
    scan: .scanOK(reason: "sqlite_master is small"))
  static let masterTables = SQL("store.master.tables",
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name", scan: .scanOK(reason: "sqlite_master is small"))

  // id counters and journal bookkeeping (device profile)
  static let readIDCounter = SQL("store.idcounter.read", "SELECT next FROM id_counter WHERE tbl = ? AND slot = ?")
  static let upsertIDCounter = SQL("store.idcounter.upsert",
    "INSERT INTO id_counter(tbl, slot, next) VALUES (?, ?, ?) ON CONFLICT(tbl, slot) DO UPDATE SET next = excluded.next")
  static let insertJournalApplied = SQL("store.journal.applied",
    "INSERT INTO journal_applied(seq, op, applied_at, max_ids_json) VALUES (?, ?, ?, ?)")
  /// The largest id of each cutoff table (`RowIDPolicy.cutoffTables`, in that order).
  static let cutoffMaxIDs = SQL("store.journal.cutoff-max-ids", """
    SELECT (SELECT max(id) FROM import_batch), (SELECT max(id) FROM relationship_revision),
      (SELECT max(id) FROM annotation_revision)
    """)

  // WAL
  static let checkpointPassive = SQL("store.wal.passive", "PRAGMA wal_checkpoint(PASSIVE)", scan: .scanOK(reason: "checkpoint"))
  static let checkpointTruncate = SQL("store.wal.truncate", "PRAGMA wal_checkpoint(TRUNCATE)", scan: .scanOK(reason: "checkpoint"))

  // vocab seed (the reference's seed-vocab.mjs)
  static let upsertRelType = SQL("store.seed.reltype", """
    INSERT INTO rel_type (code, family, label, inverse_label, directed, requires_precedence,
        implies_transmission, feedback_capable, glyph, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET family = excluded.family, label = excluded.label,
        inverse_label = excluded.inverse_label, directed = excluded.directed,
        requires_precedence = excluded.requires_precedence, implies_transmission = excluded.implies_transmission,
        feedback_capable = excluded.feedback_capable, glyph = excluded.glyph, description = excluded.description
    """)
  static let upsertLanguagePeriod = SQL("store.seed.period", """
    INSERT INTO language_period (lang, label, lo_year, hi_year, core_lo, core_hi, fuzz_years, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lang) DO UPDATE SET label = excluded.label, lo_year = excluded.lo_year, hi_year = excluded.hi_year,
        core_lo = excluded.core_lo, core_hi = excluded.core_hi, fuzz_years = excluded.fuzz_years,
        source = excluded.source, note = excluded.note
    """)
  static let upsertDimension = SQL("store.seed.dimension", """
    INSERT INTO dimension_def (key, label, type, options_json, builtin, created_by)
      VALUES (?, ?, ?, ?, 1, 'system')
      ON CONFLICT(key) DO UPDATE SET label = excluded.label, type = excluded.type,
        options_json = excluded.options_json, builtin = 1
    """)
  static let corpusBySlug = SQL("store.seed.corpus.get", "SELECT id FROM corpus WHERE slug = ?")
  static let insertCorpus = SQL("store.seed.corpus.insert", """
    INSERT INTO corpus (id, slug, name, kind, is_synthetic, description, license, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let updateCorpus = SQL("store.seed.corpus.update",
    "UPDATE corpus SET name = ?, description = ?, license = ? WHERE id = ?")

  // text store
  static let inlineOriginal = SQL("store.text.inline", "SELECT original FROM document_text WHERE document_id = ?")
  static let originalSHA = SQL("store.text.sha", "SELECT original_sha256 FROM document_text WHERE document_id = ?")
  static let textStorage = SQL("store.text.storage",
    "SELECT layout, utf16_len, utf8_len, chunk_count FROM text_storage WHERE document_id = ?")
  static let chunksCovering = SQL("store.text.chunks", """
    SELECT ord, start_off, end_off, codec, z FROM text_chunk
    WHERE document_id = ? AND end_off > ? AND start_off < ? ORDER BY ord
    """)
  static let insertChunk = SQL("store.text.chunk.insert",
    "INSERT INTO text_chunk(document_id, ord, start_off, end_off, codec, z) VALUES (?, ?, ?, ?, ?, ?)")
  static let insertTextStorage = SQL("store.text.storage.insert",
    "INSERT INTO text_storage(document_id, layout, utf16_len, utf8_len, chunk_count) VALUES (?, ?, ?, ?, ?)")

  // integrity
  static let quickCheck = SQL("store.integrity.quick", "PRAGMA quick_check(100)", scan: .scanOK(reason: "integrity check"))

  public static let all: [SQL] = [
    getMeta, setMeta, bumpDataVersion, tableNamed, tableCount, masterTables, readIDCounter, upsertIDCounter,
    insertJournalApplied, cutoffMaxIDs, checkpointPassive, checkpointTruncate, upsertRelType, upsertLanguagePeriod,
    upsertDimension, corpusBySlug, insertCorpus, updateCorpus, inlineOriginal, originalSHA, textStorage, chunksCovering,
    insertChunk, insertTextStorage, quickCheck,
  ]
}

/// The `meta` table (the reference's getMeta / setMeta / dataVersion).
public enum Meta {
  /// The value of `key`, or nil.
  public static func get(_ c: Connection, _ key: String) throws -> String? {
    let s = try c.prepared(StoreSQL.getMeta)
    return try s.bindingFirst([.text(key)]) { $0.text(0) }
  }

  /// Sets `key` (insert or update).
  public static func set(_ c: Connection, _ key: String, _ value: String) throws {
    let s = try c.prepared(StoreSQL.setMeta)
    try s.bind(.text(key), .text(value))
    try s.run()
  }

  /// The committed data version (0 before the first write).
  public static func dataVersion(_ c: Connection) throws -> Int { Int(try get(c, "data_version") ?? "0") ?? 0 }
}

/// Timestamps as the reference writes them: `new Date().toISOString()` (UTC, milliseconds, `Z`).
public enum StoreClock {
  public static func isoNow() -> String { iso(Date()) }

  public static func iso(_ date: Date) -> String {
    date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .gmt))
  }
}
