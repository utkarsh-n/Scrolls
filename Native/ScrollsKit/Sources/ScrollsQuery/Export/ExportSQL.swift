// OWNER: N3
// Statements of exports (export/manifest.mjs, arcs.mjs relationshipsTouching / strandDocIds).

import ScrollsStore

/// Statements of exports.
public enum ExportSQL: SQLCatalog {
  static let savedView = SQL("q.export.saved-view", "SELECT slug, state_json FROM saved_view WHERE slug = ? AND deleted_at IS NULL")
  static let runInfo = SQL("q.export.run-info", "SELECT params_json, pipeline_version FROM analysis_run WHERE id = ?")
  static let collections = SQL("q.export.collections", """
    SELECT slug, license, attribution, adapter_id FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?)) ORDER BY slug
    """, scan: .scanOK(reason: "collections (tens)"))
  static let variantForms = SQL("q.export.variant-forms", "SELECT id, form FROM expression_variant WHERE expression_id = ?")
  static let annotations = SQL("q.export.annotations", "SELECT id, target_type, target_ref, anchor_json, kind, author, is_machine, method, layer, supersedes, status, is_synthetic, current_rev, created_at FROM annotation ORDER BY id",
    scan: .scanOK(reason: "every annotation of the atlas (an export)"))
  static let revisions = SQL("q.export.revisions", """
    SELECT rev, body_md, stance, dimensions_json, tags_json, reason, author, at FROM annotation_revision
      WHERE annotation_id = ? ORDER BY rev
    """)
  static let docCorpus = SQL("q.export.doc-corpus", """
    SELECT c.corpus_id AS k, c.export_text_allowed AS allowed FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
    """)
  static let passageDoc = SQL("q.export.passage-doc", "SELECT document_id AS d FROM passage WHERE id = ?")
  static let occurrenceDoc = SQL("q.export.occurrence-doc", "SELECT document_id AS d FROM occurrence WHERE id = ?")
  static let exprCorpus = SQL("q.export.expr-corpus", "SELECT corpus_id AS k FROM expression WHERE id = ?")
  static let relationshipEnds = SQL("q.export.relationship-ends", "SELECT src_type, src_ref, dst_type, dst_ref FROM relationship WHERE id = ?")
  static let groupTarget = SQL("q.export.group-target", "SELECT target_type, target_ref FROM hypothesis_group WHERE id = ?")
  static let clusterCorpus = SQL("q.export.cluster-corpus",
    "SELECT e.corpus_id AS k FROM sense_cluster c JOIN expression e ON e.id = c.expression_id WHERE c.id = ?")
  static let windowScope = SQL("q.export.window-scope",
    "SELECT r.scope_json FROM time_window w JOIN analysis_run r ON r.id = w.run_id WHERE w.id = ?")
  static let viewCorpus = SQL("q.export.view-corpus",
    "SELECT json_extract(state_json, '$.corpus') AS c FROM saved_view WHERE slug = ? OR CAST(id AS TEXT) = ?",
    scan: .scanOK(reason: "saved views (dozens)"))
  static let corpusSlugs = SQL("q.export.corpus-slugs", "SELECT slug FROM corpus WHERE id IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "corpora (a handful)"))
  static let relationships = SQL("q.export.relationships", """
    SELECT r.id, r.rel_type, r.src_type, r.src_ref, r.dst_type, r.dst_ref, r.evidence_status, r.review_status, r.origin,
        r.source_dataset, r.source_locator, r.provenance_quality, r.method, r.run_id, r.score, r.score_kind, r.date_conflict,
        r.src_year, r.dst_year, r.license, r.attribution, r.is_synthetic,
        (SELECT count(*) FROM relationship_evidence e WHERE e.relationship_id = r.id) AS ev_rows,
        EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'citation_cue') AS cue FROM relationship r
      WHERE r.id IN (
        SELECT id FROM relationship WHERE src_type = 'document' AND src_ref IN (SELECT value FROM json_each(?))
        UNION SELECT id FROM relationship WHERE dst_type = 'document' AND dst_ref IN (SELECT value FROM json_each(?))
        UNION SELECT x.id FROM relationship x JOIN passage p ON p.id = CAST(x.src_ref AS INTEGER)
          WHERE x.src_type = 'passage' AND p.document_id IN (SELECT value FROM json_each(?))
        UNION SELECT x.id FROM relationship x JOIN passage p ON p.id = CAST(x.dst_ref AS INTEGER)
          WHERE x.dst_type = 'passage' AND p.document_id IN (SELECT value FROM json_each(?))
        UNION SELECT x.id FROM relationship x JOIN occurrence o ON o.id = CAST(x.src_ref AS INTEGER)
          WHERE x.src_type = 'occurrence' AND o.document_id IN (SELECT value FROM json_each(?))
        UNION SELECT x.id FROM relationship x JOIN occurrence o ON o.id = CAST(x.dst_ref AS INTEGER)
          WHERE x.dst_type = 'occurrence' AND o.document_id IN (SELECT value FROM json_each(?)))
      AND (r.run_id IS NULL OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id
        AND (a.status = 'succeeded' OR a.id IN (SELECT value FROM json_each(?)))))
      AND r.src_type IN ('document', 'passage', 'occurrence') AND r.dst_type IN ('document', 'passage', 'occurrence')
      ORDER BY r.id
    """, scan: .scanOK(reason: "the passage and occurrence ends join through CAST(ref); an export over a view's documents"))
  static let saveSnapshotSVG = SQL("q.export.snapshot-svg", "UPDATE saved_view SET snapshot_svg = ? WHERE slug = ?")
  static let viewCorpusSynthetic = SQL("q.export.corpus-synthetic", "SELECT is_synthetic FROM corpus WHERE slug = ?")

  /// Documents of a maker strand under the def's slice (arcs.mjs strandDocIds).
  static func makerDocs(_ docWhere: String) -> String {
    """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id
          WHERE (d.author IN (SELECT value FROM json_each(?)) OR d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'maker'
            AND value IN (SELECT value FROM json_each(?)))) AND \(docWhere)
    """
  }

  public static let all: [SQL] = [
    savedView, runInfo, collections, variantForms, annotations, revisions, docCorpus, passageDoc, occurrenceDoc, exprCorpus,
    relationshipEnds, groupTarget, clusterCorpus, windowScope, viewCorpus, corpusSlugs, relationships, saveSnapshotSVG,
    viewCorpusSynthetic,
  ]
}
