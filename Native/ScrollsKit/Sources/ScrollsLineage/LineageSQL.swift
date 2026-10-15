// OWNER: N5
// The statement catalogue of ScrollsLineage (IOS-SPEC §1.4): every SQL text of the lineage area, with its scan policy,
// so SQLCatalogTests can EXPLAIN each one. Texts are the reference's (server/lineage/*.mjs, routes) unless noted.

import ScrollsStore

/// Statements of ScrollsLineage.
public enum LineageSQL: SQLCatalog {
  // ── boilerplate (lineage/boilerplate.mjs) ──
  static let collectionBySlug = SQL("lineage.collection.by-slug", "SELECT id FROM collection WHERE slug = ?")
  static let collectionByID = SQL("lineage.collection.by-id", "SELECT id FROM collection WHERE id = ?")
  static let boilerplateDocuments = SQL("lineage.boilerplate.documents", """
    SELECT d.id, d.dup_of, t.body_start, t.body_end FROM document d JOIN document_text t ON t.document_id = d.id
    WHERE d.deleted_at IS NULL AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?))) ORDER BY d.id
    """, scan: .scanOK(reason: "the pass reads every full-text document of its scope once"))
  static let boilerplateSize = SQL("lineage.boilerplate.size", """
    SELECT count(*) AS n, COALESCE(SUM(p.token_count), 0) AS t FROM passage p
    JOIN document_text x ON x.document_id = p.document_id JOIN document d ON d.id = p.document_id
    WHERE p.field = 'body' AND d.deleted_at IS NULL AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))
    """, scan: .scanOK(reason: "sizes the record store once per pass"))
  static let bodyPassages = SQL("lineage.boilerplate.body-passages",
    "SELECT id, start_off, end_off, quality FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off")
  static let flagBoilerplate = SQL("lineage.boilerplate.flag",
    "UPDATE passage SET quality = 'boilerplate' WHERE id = ? AND quality = 'ok'")
  /// store/bins.mjs rewriteDocTokens (the same text as ScrollsIngest's; Lineage does not depend on Ingest).
  static let deleteDocTokens = SQL("lineage.boilerplate.doc-tokens.delete", "DELETE FROM doc_tokens WHERE document_id = ?")
  static let insertDocTokens = SQL("lineage.boilerplate.doc-tokens.insert", """
    INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages)
      SELECT document_id, lang, field_class, SUM(token_count), COUNT(*) FROM passage
      WHERE document_id = ? AND quality = 'ok' GROUP BY lang, field_class
    """)
  static let canaryCount = SQL("lineage.boilerplate.canary", """
    SELECT count(*) AS n FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
    WHERE passage_fts MATCH ? AND p.quality = 'ok' AND d.deleted_at IS NULL
      AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))
    """)

  public static var all: [SQL] {
    [collectionBySlug, collectionByID, boilerplateDocuments, boilerplateSize, bodyPassages, flagBoilerplate, deleteDocTokens,
     insertDocTokens, canaryCount] + graphAll + traceAll
  }
}
