// OWNER: N5
// Statements of the targeted trace (server/lineage/trace.mjs) and of the links it writes (lineage/classify.mjs).

import ScrollsStore

extension LineageSQL {
  static let originalSHA = SQL("lineage.trace.original-sha", "SELECT original_sha256 FROM document_text WHERE document_id = ?")
  static let bodyBounds = SQL("lineage.trace.body-bounds", "SELECT body_start, body_end FROM document_text WHERE document_id = ?")
  static let documentCollection = SQL("lineage.trace.document-collection",
    "SELECT c.id, c.slug FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?")
  static let reuseRuns = SQL("lineage.trace.reuse-runs",
    "SELECT id, scope_json FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' ORDER BY id DESC",
    scan: .scanOK(reason: "analysis_run is small; the reference reads every reuse-index run newest first"))
  static let traceCandidates = SQL("lineage.trace.candidates", """
    SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.unit FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id
    WHERE passage_fts MATCH ? AND p.quality = 'ok' AND p.document_id <> ? AND d.deleted_at IS NULL AND d.dup_of IS NULL
    ORDER BY bm25(passage_fts) LIMIT ?
    """)
  static let tracePassage = SQL("lineage.trace.passage", """
    SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.unit FROM passage p JOIN document d ON d.id = p.document_id
    WHERE p.id = ? AND p.quality = 'ok' AND p.document_id <> ? AND d.deleted_at IS NULL AND d.dup_of IS NULL
    """)
  static let traceDocument = SQL("lineage.trace.document", """
    SELECT id, title, author, lo_day, hi_day, y_lo, y_hi, chrono_status, is_synthetic, date_label FROM document WHERE id = ?
    """)
  static let vocabDocs = SQL("lineage.trace.vocab-docs", "SELECT doc FROM passage_vocab_row WHERE term = ?")

  // ── the trace job's writes (classify.mjs, trace.mjs) ──
  static let existingLink = SQL("lineage.trace.existing", """
    SELECT r.id FROM relationship r JOIN analysis_run a ON a.id = r.run_id WHERE r.rel_type = ? AND r.src_type = 'passage'
      AND r.src_ref = ? AND r.dst_type = 'passage' AND r.dst_ref = ? AND r.origin = 'algorithm' AND a.status = 'succeeded'
    ORDER BY r.id LIMIT 1
    """)
  static let passageField = SQL("lineage.trace.passage-field", "SELECT field FROM passage WHERE id = ?")
  static let insertAlgorithmRelationship = SQL("lineage.classify.insert-relationship", """
    INSERT INTO relationship (id, rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      provenance_quality, method, run_id, created_by, review_status, score, score_kind, date_conflict, src_year, dst_year,
      hypothesis_group_id, is_synthetic, current_rev, created_at)
    VALUES (?, ?, 'passage', ?, 'passage', ?, ?, ?, 'algorithm', 'complete', ?, ?, ?, 'unreviewed', ?, ?, ?, ?, ?, ?, ?, 1, ?)
    """)
  static let insertEvidence = SQL("lineage.classify.insert-evidence", """
    INSERT INTO relationship_evidence (id, relationship_id, passage_id, role, start_off, end_off, anchor_json, detail_json,
      added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  /// classify.mjs writeCreateRevisions: the rows of a run that have no revision yet (in id order).
  static let runRowsWithoutRevision = SQL("lineage.classify.rows-without-revision", """
    SELECT r.id, r.created_by, json_object('rel_type', r.rel_type, 'src', r.src_type || ':' || r.src_ref, 'dst', r.dst_type || ':' || r.dst_ref,
        'evidence_status', r.evidence_status, 'origin', r.origin, 'method', r.method, 'run_id', r.run_id,
        'score', CASE WHEN r.score IS NULL THEN NULL ELSE json_object('value', r.score, 'kind', r.score_kind) END)
    FROM relationship r WHERE r.run_id = ? AND NOT EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id)
    ORDER BY r.id
    """, scan: .scanOK(reason: "relationship has no run_id index in schema.sql; the reference's writeCreateRevisions scans it the same way"))
  static let insertCreateRevision = SQL("lineage.classify.insert-create-revision", """
    INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, before_json, after_json, reason)
    VALUES (?, ?, 1, ?, ?, 'create', NULL, ?, NULL)
    """)
  static let insertHypothesisGroup = SQL("lineage.classify.insert-group", """
    INSERT INTO hypothesis_group (id, target_type, target_ref, question, created_by, is_synthetic, created_at)
    VALUES (?, 'passage', ?, ?, ?, ?, ?)
    """)
  static let setGroup = SQL("lineage.classify.set-group", "UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?")

  static var traceAll: [SQL] {
    [originalSHA, bodyBounds, documentCollection, reuseRuns, traceCandidates, tracePassage, traceDocument, vocabDocs, existingLink,
     passageField, insertAlgorithmRelationship, insertEvidence, runRowsWithoutRevision, insertCreateRevision, insertHypothesisGroup,
     setGroup]
  }
}
