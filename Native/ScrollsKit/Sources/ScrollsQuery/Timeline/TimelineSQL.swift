// OWNER: N3
// Statements of the timeline area (query.mjs, tiles.mjs, shelf.mjs, bin.mjs, marks.mjs) that do not depend on the def.

import ScrollsStore

/// Statements of the timeline.
public enum TimelineSQL: SQLCatalog {
  static let collectionNames = SQL("q.tl.collection-names",
    "SELECT slug, name FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "collections (tens)"))
  static let pendingModalities = SQL("q.tl.pending", """
    SELECT DISTINCT c.modality FROM collection c WHERE c.corpus_id IN (SELECT value FROM json_each(?)) AND (
        EXISTS (SELECT 1 FROM import_batch b WHERE b.collection_id = c.id AND b.status = 'committing')
        OR EXISTS (SELECT 1 FROM meta m WHERE m.key = 'collection_status:' || c.slug AND m.value IN ('pending', 'indexing')))
    """, scan: .scanOK(reason: "collections (tens)"))
  static let provenanceRate = SQL("q.tl.provenance.rate", """
    SELECT slug, license, is_synthetic FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?)) AND rate_eligible = 1
      AND EXISTS (SELECT 1 FROM document d WHERE d.collection_id = collection.id AND d.deleted_at IS NULL) ORDER BY slug
    """, scan: .scanOK(reason: "collections (tens), one indexed probe each"))
  static let provenanceTrail = SQL("q.tl.provenance.trail", """
    SELECT slug, license, is_synthetic FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?))
      AND (rate_eligible = 1 OR sampling = 'relation_endpoints')
      AND EXISTS (SELECT 1 FROM document d WHERE d.collection_id = collection.id AND d.deleted_at IS NULL) ORDER BY slug
    """, scan: .scanOK(reason: "collections (tens), one indexed probe each"))
  static let corporaSlugs = SQL("q.tl.corpora-slugs", "SELECT slug FROM corpus WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
    scan: .scanOK(reason: "corpora (a handful)"))
  static let excludedRows = SQL("q.tl.excluded", """
    SELECT x.plang, x.field_class, x.n, x.n_names, d.is_translation, d.dup_of, d.basis, d.deleted_at, d.import_batch_id,
        d.is_synthetic, c.rate_eligible, c.sampling, c.corpus_id, d.kind, c.slug, d.culture, d.field, d.community, d.lang_text
      FROM expr_doc x JOIN document d ON d.id = x.document_id JOIN collection c ON c.id = d.collection_id
      WHERE x.expression_id = ? AND x.run_id = ?
    """)
  static let dataVersion = SQL("q.tl.data-version", "SELECT value FROM meta WHERE key = 'data_version'")
  static let queryDefGet = SQL("q.tl.querydef.get", "SELECT def_json FROM query_def WHERE key = ?")
  static let queryDefPut = SQL("q.tl.querydef.put", """
    INSERT INTO query_def (key, def_json, created_at, last_used) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_used = excluded.last_used
    """)
  static let datedExtent = SQL("q.tl.dated-extent", """
    SELECT MIN(d.y_lo) AS lo, MAX(d.y_hi) AS hi, MIN(d.lo_day) AS dlo, MAX(d.hi_day) AS dhi FROM document d
      JOIN collection c ON c.id = d.collection_id WHERE c.corpus_id IN (SELECT value FROM json_each(?)) AND d.chrono_status = 'dated'
      AND d.deleted_at IS NULL
    """, scan: .scanOK(reason: "the dated extent of a corpus (washes shelf, aggregate export)"))
  static let firstPassages = SQL("q.tl.first-passages", """
    SELECT o.document_id AS doc, MIN(o.passage_id) AS passage FROM occurrence o JOIN passage p ON p.id = o.passage_id
      WHERE o.expression_id = ? AND o.run_id = ? AND p.quality = 'ok' AND o.document_id IN (SELECT value FROM json_each(?))
      GROUP BY o.document_id
    """)
  static let firstTitlePassages = SQL("q.tl.first-title-passages", """
    SELECT document_id AS doc, MIN(id) AS passage FROM passage WHERE field_class = 'title'
      AND document_id IN (SELECT value FROM json_each(?)) GROUP BY document_id
    """)
  static let chronologyRaws = SQL("q.tl.chronology-raws", """
    SELECT subject_id AS doc, raw FROM date_assertion WHERE subject_type = 'document' AND is_chronology = 1
      AND subject_id IN (SELECT value FROM json_each(?))
    """)

  public static let all: [SQL] = [
    collectionNames, pendingModalities, provenanceRate, provenanceTrail, corporaSlugs, excludedRows, dataVersion, queryDefGet,
    queryDefPut, datedExtent, firstPassages, firstTitlePassages, chronologyRaws,
  ]
}

/// The composed statements of tiles, washes and denominators.
enum TilesSQL {
  static func numerators(src: String, lv: String, uc: String, nm: Int, slice: String) -> String {
    """
    WITH src AS (\(src))
        SELECT \(lv) AS lv, \(uc) AS uc, b.bin AS bin, e.document_id AS doc,
          SUM(e.n + \(nm) * e.n_names) AS v, SUM(e.n_names) AS names, d.author, d.basis, d.is_synthetic AS syn,
          d.is_translation AS tr, d.lo_day, d.hi_day
        FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
        JOIN doc_bin b ON b.document_id = d.id AND b.level = ?
        WHERE \(slice) AND b.bin BETWEEN ? AND ?
        GROUP BY lv, uc, b.bin, e.document_id
    """
  }

  static func overlapping(src: String, lv: String, uc: String, nm: Int, slice: String, range: String) -> String {
    """
    WITH src AS (\(src))
        SELECT \(lv) AS lv, \(uc) AS uc, e.document_id AS doc,
          SUM(e.n + \(nm) * e.n_names) AS v, SUM(e.n_names) AS names, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.precision,
          d.date_label, d.basis, d.author, d.is_synthetic AS syn, d.is_translation AS tr
        FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
        WHERE \(slice) AND d.chrono_status = 'dated' AND \(range)
        GROUP BY lv, uc, e.document_id
    """
  }

  static func docSizes(lane: String, uc: String, slice: String) -> String {
    """
    SELECT \(lane) AS lv, \(uc) AS uc, b.bin AS bin,
            t.document_id AS doc, SUM(t.tokens) AS tokens
          FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
          JOIN doc_bin b ON b.document_id = d.id AND b.level = ?
          WHERE \(slice) AND b.bin BETWEEN ? AND ? AND t.document_id IN (SELECT value FROM json_each(?))
          GROUP BY lv, uc, b.bin, t.document_id
    """
  }

  static func dayDocRows(lane: String, uc: String, slice: String, docFilter: Bool) -> String {
    """
    SELECT \(lane) AS lv, \(uc) AS uc, t.document_id AS doc,
          SUM(t.tokens) AS tokens, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.is_synthetic AS syn, d.is_translation AS tr
        FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
        WHERE \(slice) AND d.chrono_status = 'dated' AND d.hi_day >= ? AND d.lo_day <= ? AND d.hi_day - d.lo_day <= 30 \(docFilter ? "AND t.document_id IN (SELECT value FROM json_each(?))" : "")
        GROUP BY lv, uc, t.document_id
    """
  }
}

/// Wrappers over a strand's occurrence statement (marks.mjs, bin.mjs, kwic.mjs, search, exports).
enum OccSQL {
  /// `WITH m AS (q) SELECT count(*) AS n FROM m WHERE COUNTED`.
  static func count(_ q: String, extra: String = "") -> String {
    "WITH m AS (\(q)) SELECT count(*) AS n FROM m WHERE \(SliceSQL.counted)\(extra)"
  }
  /// `WITH m AS (q) SELECT * FROM m WHERE COUNTED [extra] ORDER BY … [LIMIT ? [OFFSET ?]]`.
  static func rows(_ q: String, extra: String = "", order: String, limit: Bool, offset: Bool = false) -> String {
    "WITH m AS (\(q)) SELECT * FROM m WHERE \(SliceSQL.counted)\(extra) ORDER BY \(order)\(limit ? " LIMIT ?" : "")\(offset ? " OFFSET ?" : "")"
  }
  /// `WITH m AS (q) SELECT DISTINCT doc FROM m WHERE COUNTED [extra] LIMIT ?` (search titles).
  static func distinctDocs(_ q: String, extra: String) -> String {
    "WITH m AS (\(q)) SELECT DISTINCT doc FROM m WHERE \(SliceSQL.counted)\(extra) LIMIT ?"
  }
  /// Work marks of theme, work and maker strands: one per work, at its title passage.
  static func workMarks(pick: String, lv: String, uc: String, slice: String, lane: String, extra: String) -> String {
    """
    SELECT NULL AS occ, MIN(p.id) AS passage, d.id AS doc, \(lv) AS lv, \(uc) AS uc,
          d.lo_day, d.hi_day, d.precision, d.basis, d.is_synthetic AS syn, 0 AS name_flag
        FROM document d JOIN collection c ON c.id = d.collection_id JOIN passage p ON p.document_id = d.id AND p.field_class = 'title' AND p.quality = 'ok'
        WHERE \(pick) AND \(slice) AND \(lane) AND \(extra) GROUP BY d.id ORDER BY d.lo_day, d.id
    """
  }
  static let pickTheme = "d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'theme' AND value = ? AND provenance = ?)"
  static let pickWork = "d.id = ?"
  static let pickMaker = """
    (d.author IN (SELECT value FROM json_each(?)) OR d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'maker'
          AND value IN (SELECT value FROM json_each(?))))
    """
  /// Passage export rows (manifest.mjs passageRows).
  static func passageGroups(_ q: String) -> String {
    """
    WITH m AS (\(q)) SELECT passage, doc, field, p_start, p_end, plang, lv, uc, title, date_label, precision,
            basis, date_role, syn, collection, export_text_allowed, count(*) AS n, (SELECT source_url FROM document WHERE id = doc) AS source_url
          FROM m WHERE \(SliceSQL.counted) GROUP BY passage ORDER BY MIN(lo_day IS NULL), MIN(lo_day), passage LIMIT ?
    """
  }
  /// Occurrence export rows (manifest.mjs occurrenceRows).
  static func exportOccurrences(_ q: String) -> String {
    """
    WITH m AS (\(q)) SELECT m.*, (SELECT source_url FROM document WHERE id = m.doc) AS source_url FROM m
          WHERE \(SliceSQL.counted) ORDER BY lo_day IS NULL, lo_day, occ LIMIT ?
    """
  }
}
