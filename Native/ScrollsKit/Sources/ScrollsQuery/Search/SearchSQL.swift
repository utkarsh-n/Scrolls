// OWNER: N3
// Statements of search (routes/search.mjs): candidate passages inside the default slice, document facts, trigram
// typeahead over label_tri (suggests, never counts), etymology families, annotation mentions and unloaded adapters.

import ScrollsStore

/// Statements of search.
public enum SearchSQL: SQLCatalog {
  static let docInfo = SQL("q.search.doc-info", """
    SELECT d.id, d.title, d.kind, d.author, d.y_lo, d.y_hi, d.lo_day, d.hi_day, d.precision, d.date_label,
        d.chrono_status, d.is_synthetic, d.community, d.culture, d.field, d.basis, c.slug AS collection, c.domain, c.export_text_allowed
      FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id IN (SELECT value FROM json_each(?))
    """)
  static let trigram = SQL("q.search.trigram", """
    SELECT l.label, l.ref FROM label_tri l JOIN document d ON d.id = CAST(substr(l.ref, 10) AS INTEGER)
      JOIN collection c ON c.id = d.collection_id
      WHERE label_tri MATCH ? AND l.kind = ? AND l.ref LIKE 'document:%' AND c.corpus_id = ? AND d.deleted_at IS NULL LIMIT ?
    """)
  static let anyEtymon = SQL("q.search.any-etymon", "SELECT 1 FROM etymon LIMIT 1", scan: .scanOK(reason: "one row"))
  static let etymologyByLang = SQL("q.search.etymology-lang", """
    SELECT DISTINCT m.key, e.lang, e.form, e.gloss FROM etymon_member m JOIN etymon e ON e.key = m.key
      WHERE m.lang = ? AND m.norm = ? LIMIT 5
    """)
  static let etymologyAnyLang = SQL("q.search.etymology-any", """
    SELECT DISTINCT m.key, e.lang, e.form, e.gloss FROM etymon_member m JOIN etymon e ON e.key = m.key
      WHERE m.norm = ? LIMIT 5
    """, scan: .scanOK(reason: "etymon_member is indexed by (lang, norm); without a language a scan of a few thousand rows"))
  static let annotationMentions = SQL("q.search.annotations", """
    SELECT count(DISTINCT a.id) AS n FROM annotation_fts f JOIN annotation_revision v ON v.id = f.rowid
      JOIN annotation a ON a.id = v.annotation_id AND a.current_rev = v.rev WHERE annotation_fts MATCH ?
    """)
  static let unloadedAdapters = SQL("q.search.adapters", """
    SELECT a.label FROM source_adapter a WHERE a.id LIKE 'stemm.%' AND a.enabled = 1 AND NOT EXISTS
      (SELECT 1 FROM import_batch b WHERE b.adapter_id = a.id AND b.status = 'committed') ORDER BY a.id
    """, scan: .scanOK(reason: "source adapters (a handful)"))

  /// `sliceFilter`: candidate passages that lie inside the def's slice (same SQL as every timeline count).
  static func sliceFilter(doc: String, row: String) -> String {
    """
    SELECT p.id FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
        WHERE p.id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok' AND \(doc) AND \(row)
    """
  }

  public static let all: [SQL] = [docInfo, trigram, anyEtymon, etymologyByLang, etymologyAnyLang, annotationMentions, unloadedAdapters]
}
