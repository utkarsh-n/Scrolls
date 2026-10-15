// OWNER: N3
// Statements of passages, occurrences and documents (passages.mjs, documents.mjs, kwic.mjs fieldValue), verbatim from
// the reference except that the original's length comes from TextStore (IOS-SPEC §1.4: only InlineTextStore names
// document_text.original).

import ScrollsStore

/// Statements of the reading area.
public enum ReadSQL: SQLCatalog {
  static let fieldValue = SQL("q.read.field-value", "SELECT value FROM document_field WHERE document_id = ? AND field = ?")
  static let documentDates = SQL("q.read.document-dates", """
    SELECT role, lo_day, hi_day, precision, basis, asserted_by, approx, rule, raw, is_chronology, note FROM date_assertion
      WHERE subject_type = 'document' AND subject_id = ? AND role <> 'ingestion' ORDER BY is_chronology DESC, id
    """)
  static let passage = SQL("q.read.passage", """
    SELECT document_id, ord, field, field_class, time_role, quality, start_off, end_off, page_no, lang, is_synthetic
      FROM passage WHERE id = ?
    """)
  static let passageDocument = SQL("q.read.passage-document", """
    SELECT d.id, d.title, d.author, d.kind, d.chrono_status, d.basis, d.y_lo, d.y_hi, d.date_label, d.precision, d.date_role,
        d.is_translation, d.lang_text, d.lang_declared, d.license, d.is_synthetic, c.slug AS collection_slug,
        c.license AS collection_license
      FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
    """)
  static let highlightsHead = """
    SELECT o.id AS occ, o.expression_id AS expr, o.start_off, o.end_off, o.name_flag, v.form AS variant
      FROM occurrence o JOIN analysis_run r ON r.id = o.run_id AND r.status = 'succeeded'
      LEFT JOIN expression_variant v ON v.id = o.variant_id
      WHERE o.passage_id = ? AND (o.run_id IN (SELECT run_id FROM expression_state WHERE expression_id = o.expression_id) OR o.id = ?)
    """
  static let highlights = SQL("q.read.highlights", "\(highlightsHead) ORDER BY o.start_off, o.id")
  static let highlightsOfExpr = SQL("q.read.highlights-expr",
    "\(highlightsHead) AND o.expression_id IN (SELECT value FROM json_each(?)) ORDER BY o.start_off, o.id")
  static let neighbour = SQL("q.read.neighbour",
    "SELECT id, start_off, end_off, quality FROM passage WHERE document_id = ? AND field = ? AND ord = ?")
  static let originalSHA = SQL("q.read.original-sha", "SELECT original_sha256 FROM document_text WHERE document_id = ?")
  static let relOutPassage = SQL("q.read.rel-out-passage",
    "SELECT count(*) AS n FROM relationship WHERE src_type = 'passage' AND src_ref = ?")
  static let relInPassage = SQL("q.read.rel-in-passage",
    "SELECT count(*) AS n FROM relationship WHERE dst_type = 'passage' AND dst_ref = ?")
  static let relOutDocument = SQL("q.read.rel-out-document",
    "SELECT count(*) AS n FROM relationship WHERE src_type = 'document' AND src_ref = ?")
  static let relInDocument = SQL("q.read.rel-in-document",
    "SELECT count(*) AS n FROM relationship WHERE dst_type = 'document' AND dst_ref = ?")
  static let annotationCount = SQL("q.read.annotation-count",
    "SELECT count(*) AS n FROM annotation WHERE target_type = 'passage' AND target_ref = ? AND status = 'active'")
  static let machine = SQL("q.read.machine", """
    SELECT DISTINCT 'cluster' AS kind, sc.id AS cluster, sc.label_auto AS label, cm.margin, sc.run_id AS run
      FROM occurrence o JOIN cluster_member cm ON cm.occurrence_id = o.id JOIN sense_cluster sc ON sc.id = cm.cluster_id
      JOIN analysis_run r ON r.id = sc.run_id AND r.status = 'succeeded' WHERE o.passage_id = ? ORDER BY sc.id
    """)
  static let occurrence = SQL("q.read.occurrence", """
    SELECT o.id, o.passage_id, o.document_id, o.expression_id, o.start_off, o.end_off, o.name_flag,
        o.run_id, d.is_synthetic FROM occurrence o JOIN document d ON d.id = o.document_id WHERE o.id = ?
    """)
  static let document = SQL("q.read.document", """
    SELECT d.id, d.ext_id, d.kind, d.title, d.native_title, d.author, c.slug AS collection_slug, c.name AS collection_name,
        d.has_full_text, d.chrono_status, d.basis, d.y_lo, d.y_hi, d.date_label, d.precision, d.date_role, d.is_translation,
        d.lang_text, d.lang_declared, d.dup_of, d.passage_count, d.token_count, d.community, d.culture, d.field, d.genre,
        d.source_url, d.license, c.license AS collection_license, c.export_text_allowed, d.is_synthetic, c.modality, d.deleted_at
      FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
    """)
  static let tags = SQL("q.read.tags",
    "SELECT scheme, value, weight, provenance, method FROM doc_tag WHERE document_id = ? ORDER BY scheme, value")
  static let aliases = SQL("q.read.aliases", "SELECT ext_id, title, note FROM document_alias WHERE document_id = ? ORDER BY ext_id")
  static let fields = SQL("q.read.fields", """
    SELECT field, id AS passage, field_class, time_role, quality, start_off AS start, end_off AS end FROM passage
      WHERE document_id = ? AND field <> 'body' ORDER BY field, ord
    """)
  static let bodyBounds = SQL("q.read.body-bounds", "SELECT body_start, body_end, original_sha256 FROM document_text WHERE document_id = ?")
  static let documentSynthetic = SQL("q.read.document-synthetic", "SELECT is_synthetic FROM document WHERE id = ?")

  public static let all: [SQL] = [
    fieldValue, documentDates, passage, passageDocument, highlights, highlightsOfExpr, neighbour, originalSHA, relOutPassage,
    relInPassage, relOutDocument, relInDocument, annotationCount, machine, occurrence, document, tags, aliases, fields, bodyBounds,
    documentSynthetic,
  ]
}
