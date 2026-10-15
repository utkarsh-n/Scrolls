// OWNER: N5
// Statements of the lineage read paths (graph.mjs, path.mjs, genealogy.mjs) and of the reference helpers ported into
// ScrollsLineage (resolveRef). The reference composes `edgeWhere(f)` per request; here every filter is one fixed clause
// whose parameters switch it off (NULL types or statuses, a NULL cutoff), so each statement is a constant of the
// catalogue. Parameters are numbered: ?1/?2 the endpoint (type, ref), then `edgeParams` (?3 runs JSON, ?4 types JSON
// or NULL, ?5 statuses JSON or NULL, ?6 revision cutoff or NULL, ?7 rejected 0/1, ?8 kindred 0/1). Rows come back in
// relationship id order, the order of the reference's index scans on rel_src / rel_dst.

import ScrollsStore

extension LineageSQL {
  /// The relationship columns every edge reader selects (alias r), in `EdgeRow`'s order.
  static let edgeColumns = """
    r.id, r.rel_type, r.src_type, r.src_ref, r.dst_type, r.dst_ref, r.directed, r.evidence_status, r.origin, r.source_dataset,
    r.source_locator, r.provenance_quality, r.method, r.run_id, r.created_by, r.review_status, r.score, r.score_kind,
    r.date_conflict, r.src_year, r.dst_year, r.hypothesis_group_id, r.is_synthetic
    """

  /// graph.mjs `edgeWhere(f)` with parameters ?3…?8.
  static let edgeFilter = """
    (r.run_id IS NULL OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id
      AND (a.status = 'succeeded' OR a.id IN (SELECT value FROM json_each(?3)))))
    AND (?4 IS NULL OR r.rel_type IN (SELECT value FROM json_each(?4)))
    AND (?5 IS NULL OR r.evidence_status IN (SELECT value FROM json_each(?5)))
    AND (CASE WHEN ?6 IS NOT NULL THEN EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id
                AND v.rev = 1 AND v.id <= ?6)
              WHEN ?7 = 0 THEN r.review_status <> 'rejected' ELSE 1 END)
    AND (?8 = 1 OR r.rel_type NOT IN ('kindred', 'counterpart'))
    """

  static let cueColumn = "EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'citation_cue') AS cue"

  // ── graph.mjs edgesOf / path.mjs search / genealogy.mjs walk ──
  static let edgesFrom = SQL("lineage.graph.edges-from", """
    SELECT \(edgeColumns), \(cueColumn) FROM relationship r WHERE r.src_type = ?1 AND r.src_ref = ?2 AND \(edgeFilter) ORDER BY r.id
    """)
  static let edgesTo = SQL("lineage.graph.edges-to", """
    SELECT \(edgeColumns), \(cueColumn) FROM relationship r WHERE r.dst_type = ?1 AND r.dst_ref = ?2 AND \(edgeFilter) ORDER BY r.id
    """)
  /// path.mjs reads `r.*` without the cue flag, so its edges never carry `cue`.
  static let pathFrom = SQL("lineage.path.from", """
    SELECT \(edgeColumns), 0 AS cue FROM relationship r WHERE r.src_type = ?1 AND r.src_ref = ?2 AND \(edgeFilter) ORDER BY r.id
    """)
  static let undirectedTo = SQL("lineage.path.undirected-to", """
    SELECT \(edgeColumns), 0 AS cue FROM relationship r WHERE r.dst_type = ?1 AND r.dst_ref = ?2 AND r.directed = 0 AND \(edgeFilter)
    ORDER BY r.id
    """)
  /// graph.mjs: the members of a hypothesis group (?1 the group; ?2 is not used and is bound NULL).
  static let groupMembers = SQL("lineage.graph.group-members", """
    SELECT \(edgeColumns), 0 AS cue FROM relationship r WHERE r.hypothesis_group_id = ?1 AND \(edgeFilter) ORDER BY r.id
    """)
  static let groupRow = SQL("lineage.graph.group", "SELECT id, question FROM hypothesis_group WHERE id = ?")
  /// graph.mjs asOfRows: a link's revisions up to a cutoff.
  static let revisionsUpTo = SQL("lineage.graph.revisions-up-to",
    "SELECT actor, action FROM relationship_revision WHERE relationship_id = ? AND id <= ? ORDER BY rev")

  // ── graph.mjs nodeJson ──
  static let nodeDocument = SQL("lineage.graph.node-document",
    "SELECT id, title, kind, y_lo, precision, date_label, chrono_status, author FROM document WHERE id = ?")
  static let fieldValue = SQL("lineage.graph.field-value", "SELECT value FROM document_field WHERE document_id = ? AND field = ?")

  // ── genealogy.mjs ──
  static let genealogyDocument = SQL("lineage.genealogy.document", """
    SELECT d.id, d.title, d.author, d.kind, d.y_lo, d.y_hi, d.precision, d.date_label, d.chrono_status, d.is_synthetic,
      d.collection_id, c.slug AS collection, c.rate_eligible FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE d.id = ? AND d.deleted_at IS NULL
    """)
  static let makerWorksByNames = SQL("lineage.genealogy.maker-works", """
    SELECT d.id FROM document d WHERE d.deleted_at IS NULL AND d.id IN (
        SELECT id FROM document WHERE author IN (SELECT value FROM json_each(?1))
        UNION SELECT document_id FROM doc_tag WHERE scheme = 'maker' AND value IN (SELECT value FROM json_each(?1)))
      ORDER BY d.y_lo IS NULL, d.y_lo, d.id LIMIT 500
    """, scan: .scanOK(reason: "author has no index in schema.sql; the reference's maker lookup scans document"))
  static let makerNamesLike = SQL("lineage.genealogy.maker-names", """
    SELECT DISTINCT author AS name FROM document WHERE author LIKE ?1 AND deleted_at IS NULL
      UNION SELECT DISTINCT value FROM doc_tag WHERE scheme = 'maker' AND value LIKE ?1
    """, scan: .scanOK(reason: "a maker slug from a search suggestion is resolved by LIKE, as the reference does"))
  /// `SELECT id FROM passage WHERE document_id = ?` in the order of its covering index passage_doc.
  static let documentPassageIDs = SQL("lineage.genealogy.document-passages",
    "SELECT id FROM passage WHERE document_id = ? ORDER BY field, start_off, id")
  static let passageDocument = SQL("lineage.genealogy.passage-document", "SELECT document_id FROM passage WHERE id = ?")

  // ── provenance/relationships.mjs resolveRef ──
  static let refPassage = SQL("lineage.ref.passage", """
    SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.is_synthetic, d.y_lo, d.y_hi, d.title, d.date_label
    FROM passage p JOIN document d ON d.id = p.document_id WHERE p.id = ? AND d.deleted_at IS NULL
    """)
  static let refDocument = SQL("lineage.ref.document",
    "SELECT id, is_synthetic, y_lo, y_hi, title, date_label FROM document WHERE id = ? AND deleted_at IS NULL")
  static let refOccurrence = SQL("lineage.ref.occurrence", """
    SELECT o.id, o.document_id, o.passage_id, p.is_synthetic, d.y_lo, d.y_hi, d.title, d.date_label
    FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id WHERE o.id = ?
    """)
  static let refPassageBounds = SQL("lineage.ref.passage-bounds",
    "SELECT id, document_id, field, start_off, end_off FROM passage WHERE id = ?")
  static let refExpression = SQL("lineage.ref.expression", "SELECT id, is_synthetic, surface FROM expression WHERE id = ?")
  static let refCluster = SQL("lineage.ref.cluster", """
    SELECT c.id, c.label_auto, e.is_synthetic FROM sense_cluster c JOIN expression e ON e.id = c.expression_id WHERE c.id = ?
    """)
  static let refEtymon = SQL("lineage.ref.etymon", "SELECT key, form FROM etymon WHERE key = ?")
  static let refRelationship = SQL("lineage.ref.relationship", "SELECT id, is_synthetic FROM relationship WHERE id = ?")
  static let refHypothesisGroup = SQL("lineage.ref.group", "SELECT id, is_synthetic, question FROM hypothesis_group WHERE id = ?")
  static let refSavedView = SQL("lineage.ref.view", """
    SELECT v.slug, v.name, k.is_synthetic FROM saved_view v
    LEFT JOIN corpus k ON k.slug = json_extract(v.state_json, '$.corpus') WHERE v.slug = ? AND v.deleted_at IS NULL
    """)
  static let refTimeWindow = SQL("lineage.ref.window", "SELECT id, label FROM time_window WHERE id = ?")
  static let refAnnotation = SQL("lineage.ref.annotation", "SELECT id, is_synthetic FROM annotation WHERE id = ?")

  static var graphAll: [SQL] {
    [edgesFrom, edgesTo, pathFrom, undirectedTo, groupMembers, groupRow, revisionsUpTo, nodeDocument, fieldValue, genealogyDocument,
     makerWorksByNames, makerNamesLike, documentPassageIDs, passageDocument, refPassage, refDocument, refOccurrence,
     refPassageBounds, refExpression, refCluster, refEtymon, refRelationship, refHypothesisGroup, refSavedView, refTimeWindow,
     refAnnotation]
  }
}
