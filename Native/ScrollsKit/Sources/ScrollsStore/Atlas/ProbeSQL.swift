// OWNER: N0
// The probe's SQL (IOS-SPEC §1.4). Every statement works on temporary tables that the check creates and drops, or on
// literals, so none of it belongs in an atlas catalogue: `SQLCatalogTests` EXPLAINs catalogue entries against an atlas,
// where these tables never exist. Kept in one file so the inline-SQL lint still sees no SQL in Probe.swift.

import ScrollsCore

/// Statements of `Probe`'s checks, run on an in-memory connection.
enum ProbeSQL {
  /// FTS5 with the reference tokenizer string, and its instance-level vocabulary.
  static var createFTS: String {
    """
    CREATE VIRTUAL TABLE temp.probe_fts USING fts5(norm, content='', contentless_delete=1, detail=full,
      tokenize="\(Tokenizer.ftsTokenize)");
    CREATE VIRTUAL TABLE temp.probe_vocab USING fts5vocab(temp, probe_fts, instance);
    """
  }
  static let insertFTS = "INSERT INTO temp.probe_fts(rowid, norm) VALUES (1, ?)"
  static let vocabInstances = "SELECT term, offset FROM temp.probe_vocab ORDER BY offset"
  static let dropFTS = "DROP TABLE temp.probe_vocab; DROP TABLE temp.probe_fts;"

  /// rtree_i32 with BCE day numbers (third millennium BCE, the year 0 boundary, and a modern year).
  static let createRTree = """
    CREATE VIRTUAL TABLE temp.probe_rtree USING rtree_i32(id, lo_day, hi_day);
    INSERT INTO temp.probe_rtree VALUES (1, -1825000, -1824636), (2, -719528, -719163), (3, 20000, 20365);
    """
  static let rtreeQuery = "SELECT id FROM temp.probe_rtree WHERE lo_day <= -719000 AND hi_day >= -1825000 ORDER BY id"
  static let dropRTree = "DROP TABLE temp.probe_rtree"

  /// JSON1 on literals.
  static let json1 = #"SELECT json_valid('{"a":[1,2]}'), json_extract('{"a":{"b":"x"}}', '$.a.b')"#

  /// A contentless FTS5 table that accepts a DELETE (`contentless_delete=1`).
  static let createContentlessDelete = """
    CREATE VIRTUAL TABLE temp.probe_cd USING fts5(x, content='', contentless_delete=1);
    INSERT INTO temp.probe_cd(rowid, x) VALUES (1, 'alpha beta'), (2, 'beta gamma');
    DELETE FROM temp.probe_cd WHERE rowid = 1;
    """
  static let contentlessMatch = "SELECT count(*) FROM temp.probe_cd WHERE probe_cd MATCH 'beta'"
  static let dropContentlessDelete = "DROP TABLE temp.probe_cd"
}
