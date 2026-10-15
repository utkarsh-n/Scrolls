// OWNER: N6
// The statement catalogue of ScrollsProvenance (IOS-SPEC §1.4): every SQL text of the provenance port, as the
// reference writes it in server/provenance/*.mjs, lineage/hypotheses.mjs, aggregate/scope.mjs and the parts of
// aggregate/query.mjs and clusterlanes.mjs a saved view reads. Document text is read through `TextStore`, never here.
// Ids of new rows come from `RowIDAllocator` (local range on the phone), so every INSERT names its id.

import ScrollsStore

/// Statements of ScrollsProvenance.
public enum ProvenanceSQL: SQLCatalog {
  // ── anchors ──
  static let textSha = SQL("prov.anchor.text-sha", "SELECT original_sha256 FROM document_text WHERE document_id = ?")
  static let fieldValue = SQL("prov.anchor.field", "SELECT value FROM document_field WHERE document_id = ? AND field = ?")
  static let passageInside = SQL("prov.anchor.passage-inside", """
    SELECT id, start_off, end_off FROM passage WHERE document_id = ? AND field = ?
      AND start_off <= ? AND end_off >= ? ORDER BY start_off DESC LIMIT 1
    """)
  static let passageFirst = SQL("prov.anchor.passage-first", """
    SELECT id, start_off, end_off FROM passage WHERE document_id = ? AND field = ?
      AND start_off <= ? AND end_off > ? ORDER BY start_off DESC LIMIT 1
    """)
  static let annotationsWithAnchorOfDoc = SQL("prov.reanchor.annotations", """
    SELECT id, target_type, target_ref, anchor_json FROM annotation
    WHERE anchor_json IS NOT NULL AND json_extract(anchor_json, '$.doc_id') = ? ORDER BY id
    """, scan: .scanOK(reason: "re-anchoring after re-segmentation is a maintenance pass over annotations (reference SQL)"))
  static let updateAnnotationAnchor = SQL("prov.reanchor.annotation.update",
    "UPDATE annotation SET target_ref = ?, anchor_json = ? WHERE id = ?")
  static let evidenceWithAnchorOfDoc = SQL("prov.reanchor.evidence", """
    SELECT id, relationship_id, passage_id, anchor_json FROM relationship_evidence
    WHERE anchor_json IS NOT NULL AND json_extract(anchor_json, '$.doc_id') = ? ORDER BY id
    """, scan: .scanOK(reason: "re-anchoring after re-segmentation is a maintenance pass over evidence spans (reference SQL)"))
  static let updateEvidenceAnchor = SQL("prov.reanchor.evidence.update",
    "UPDATE relationship_evidence SET passage_id = ?, start_off = ?, end_off = ?, anchor_json = ? WHERE id = ?")
  static let missingSrcPassages = SQL("prov.reanchor.missing-src", """
    SELECT r.id, r.src_ref FROM relationship r WHERE r.src_type = 'passage'
      AND NOT EXISTS (SELECT 1 FROM passage p WHERE p.id = CAST(r.src_ref AS INTEGER))
    """, scan: .scanOK(reason: "maintenance report of re-anchoring (reference SQL)"))
  static let missingDstPassages = SQL("prov.reanchor.missing-dst", """
    SELECT r.id, r.dst_ref FROM relationship r WHERE r.dst_type = 'passage'
      AND NOT EXISTS (SELECT 1 FROM passage p WHERE p.id = CAST(r.dst_ref AS INTEGER))
    """, scan: .scanOK(reason: "maintenance report of re-anchoring (reference SQL)"))

  // ── references (relationships.mjs resolveRef) ──
  static let refPassage = SQL("prov.ref.passage", """
    SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.is_synthetic, d.y_lo, d.y_hi, d.title, d.date_label
    FROM passage p JOIN document d ON d.id = p.document_id WHERE p.id = ? AND d.deleted_at IS NULL
    """)
  static let refDocument = SQL("prov.ref.document",
    "SELECT id, is_synthetic, y_lo, y_hi, title, date_label FROM document WHERE id = ? AND deleted_at IS NULL")
  static let refOccurrence = SQL("prov.ref.occurrence", """
    SELECT o.id, o.document_id, o.passage_id, p.is_synthetic, d.y_lo, d.y_hi, d.title, d.date_label
    FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id WHERE o.id = ?
    """)
  static let passageBounds = SQL("prov.ref.passage-bounds", "SELECT id, document_id, field, start_off, end_off FROM passage WHERE id = ?")
  static let refExpression = SQL("prov.ref.expression", "SELECT id, is_synthetic, surface FROM expression WHERE id = ?")
  static let refCluster = SQL("prov.ref.cluster", """
    SELECT c.id, c.label_auto, e.is_synthetic FROM sense_cluster c JOIN expression e ON e.id = c.expression_id WHERE c.id = ?
    """)
  static let refEtymon = SQL("prov.ref.etymon", "SELECT key, form FROM etymon WHERE key = ?")
  static let refRelationship = SQL("prov.ref.relationship", "SELECT id, is_synthetic FROM relationship WHERE id = ?")
  static let refHypothesisGroup = SQL("prov.ref.group", "SELECT id, is_synthetic, question FROM hypothesis_group WHERE id = ?")
  static let refSavedView = SQL("prov.ref.view", """
    SELECT v.slug, v.name, k.is_synthetic FROM saved_view v
    LEFT JOIN corpus k ON k.slug = json_extract(v.state_json, '$.corpus') WHERE v.slug = ? AND v.deleted_at IS NULL
    """)
  static let refTimeWindow = SQL("prov.ref.window", "SELECT id, label FROM time_window WHERE id = ?")
  static let refAnnotation = SQL("prov.ref.annotation", "SELECT id, is_synthetic FROM annotation WHERE id = ?")

  // ── annotations ──
  static let annotationColumns = """
    id, target_type, target_ref, anchor_json, kind, author, is_machine, method, run_id, layer, supersedes, status,
    is_synthetic, current_rev, created_at
    """
  static let dimensionDef = SQL("prov.dim.get", "SELECT key, type, options_json FROM dimension_def WHERE key = ?")
  static let insertCustomDimension = SQL("prov.dim.custom", """
    INSERT INTO dimension_def (key, label, type, options_json, builtin, created_by) VALUES (?, ?, ?, NULL, 0, ?)
    """)
  static let insertDimension = SQL("prov.dim.define", """
    INSERT INTO dimension_def (key, label, type, options_json, builtin, created_by) VALUES (?, ?, ?, ?, 0, ?)
    """)
  static let insertAnnotationFTS = SQL("prov.ann.fts", "INSERT INTO annotation_fts (rowid, body, tags) VALUES (?, ?, ?)")
  static let insertAnnotationRevision = SQL("prov.ann.rev.insert", """
    INSERT INTO annotation_revision (id, annotation_id, rev, body_md, stance, dimensions_json, tags_json, evidence_refs_json,
      reason, author, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertAnnotation = SQL("prov.ann.insert", """
    INSERT INTO annotation (id, target_type, target_ref, anchor_json, kind, author, is_machine, method, run_id, layer, supersedes,
      status, is_synthetic, current_rev, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, 'active', ?, 1, ?)
    """)
  static let annotationById = SQL("prov.ann.get", "SELECT \(annotationColumns) FROM annotation WHERE id = ?")
  static let supersededBy = SQL("prov.ann.superseded-by",
    "SELECT id, created_at FROM annotation WHERE supersedes = ? ORDER BY id LIMIT 1",
    scan: .scanOK(reason: "annotation has no supersedes index (reference schema); the notebook is small"))
  static let revisionsOf = SQL("prov.ann.revs", """
    SELECT id, rev, body_md, stance, dimensions_json, tags_json, evidence_refs_json, reason, author, at
    FROM annotation_revision WHERE annotation_id = ? ORDER BY rev
    """)
  static let firstRevision = SQL("prov.ann.rev1", "SELECT id, at FROM annotation_revision WHERE annotation_id = ? AND rev = 1")
  static let setAnnotationRev = SQL("prov.ann.set-rev", "UPDATE annotation SET current_rev = ? WHERE id = ?")
  static let supersedeAnnotation = SQL("prov.ann.supersede", "UPDATE annotation SET status = 'superseded' WHERE id = ?")
  static let withdrawAnnotation = SQL("prov.ann.withdraw", "UPDATE annotation SET current_rev = ?, status = 'withdrawn' WHERE id = ?")
  static let counterAnnotation = SQL("prov.ann.countered", """
    SELECT 1 FROM annotation WHERE target_type = 'annotation' AND target_ref = ? AND kind = 'evidence_against'
      AND status = 'active' LIMIT 1
    """)
  /// GET /api/annotations: the reference assembles its WHERE from the query; here every filter is a parameter that is
  /// NULL when absent (?1 after-id, ?2/?3 target, ?4/?5 doc, ?6 kinds JSON, ?7 author, ?8 layer, ?9 machine, ?10 FTS
  /// match, ?11 as-of, ?12 from, ?13 to, ?14 limit). Rows come in id order, as the reference pages them.
  static let listAnnotations = SQL("prov.ann.list", """
    SELECT \(annotationColumns) FROM annotation a
    WHERE a.id > ?1
      AND (?2 IS NULL OR (a.target_type = ?2 AND a.target_ref = ?3))
      AND (?4 IS NULL OR ((a.target_type = 'document' AND a.target_ref = ?5) OR json_extract(a.anchor_json, '$.doc_id') = ?4))
      AND (?6 IS NULL OR a.kind IN (SELECT value FROM json_each(?6)))
      AND (?7 IS NULL OR a.author = ?7)
      AND (?8 IS NULL OR a.layer = ?8)
      AND (?9 IS NULL OR a.is_machine = ?9)
      AND (?10 IS NULL OR a.id IN (SELECT r.annotation_id FROM annotation_fts f JOIN annotation_revision r ON r.id = f.rowid
                                   WHERE annotation_fts MATCH ?10))
      AND (?11 IS NULL OR a.created_at <= ?11)
      AND (?12 IS NULL OR a.created_at >= ?12)
      AND (?13 IS NULL OR a.created_at <= ?13)
    ORDER BY a.id LIMIT ?14
    """, scan: .scanOK(reason: "the reference pages annotations in id order with the same filters; the notebook is small"))

  // ── relationships ──
  static let relationshipColumns = """
    r.id, r.rel_type, r.src_type, r.src_ref, r.dst_type, r.dst_ref, r.directed, r.evidence_status, r.origin, r.source_dataset,
    r.source_locator, r.provenance_quality, r.method, r.run_id, r.created_by, r.review_status, r.score, r.score_kind,
    r.date_conflict, r.src_year, r.dst_year, r.hypothesis_group_id, r.license, r.attribution, r.provenance_note,
    r.is_synthetic, r.current_rev, r.created_at
    """
  static let relationshipVisible = SQL("prov.rel.visible", """
    SELECT \(relationshipColumns) FROM relationship r WHERE r.id = ? AND (r.run_id IS NULL
      OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id AND a.status IN ('succeeded', 'superseded')))
    """)
  static let insertEvidence = SQL("prov.rel.evidence.insert", """
    INSERT INTO relationship_evidence (id, relationship_id, passage_id, role, start_off, end_off, anchor_json, detail_json,
      added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertRelRevision = SQL("prov.rel.rev.insert", """
    INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, before_json, after_json, reason, annotation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertCreateRevision = SQL("prov.rel.rev.create", """
    INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, before_json, after_json, reason)
      VALUES (?, ?, 1, ?, ?, 'create', NULL, ?, ?)
    """)
  static let setRelRevAndReview = SQL("prov.rel.set-review", "UPDATE relationship SET current_rev = ?, review_status = ? WHERE id = ?")
  static let setRelRev = SQL("prov.rel.set-rev", "UPDATE relationship SET current_rev = ? WHERE id = ?")
  static let setRelGroup = SQL("prov.rel.set-group", "UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?")
  static let insertHumanRelationship = SQL("prov.rel.propose", """
    INSERT INTO relationship (id, rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
        source_dataset, source_locator, provenance_quality, method, run_id, created_by, review_status, score, score_kind,
        date_conflict, src_year, dst_year, hypothesis_group_id, license, attribution, provenance_note, is_synthetic,
        current_rev, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', 'human', NULL, NULL, 'complete', NULL, NULL, ?, 'unreviewed', NULL, NULL, ?, ?, ?,
        ?, NULL, NULL, ?, ?, 1, ?)
    """)
  static let relRevisionActions = SQL("prov.rel.rev.actions",
    "SELECT actor, action FROM relationship_revision WHERE relationship_id = ? ORDER BY rev")
  static let relEvidenceStatus = SQL("prov.rel.status", "SELECT evidence_status FROM relationship WHERE id = ?")
  static let evidenceOf = SQL("prov.rel.evidence", """
    SELECT id, role, passage_id, start_off, end_off, anchor_json, detail_json, added_by, added_at
    FROM relationship_evidence WHERE relationship_id = ? ORDER BY id
    """)
  static let evidenceCount = SQL("prov.rel.evidence-count", "SELECT count(*) FROM relationship_evidence WHERE relationship_id = ?")
  static let revisionsOfRelationship = SQL("prov.rel.revs", """
    SELECT rev, action, actor, at, reason, annotation_id, before_json, after_json
    FROM relationship_revision WHERE relationship_id = ? ORDER BY rev
    """)
  static let annotationsOfRelationship = SQL("prov.rel.annotations",
    "SELECT id FROM annotation WHERE target_type = 'relationship' AND target_ref = ? ORDER BY id")
  static let runSummary = SQL("prov.rel.run", "SELECT stage, pipeline_version, params_json, status FROM analysis_run WHERE id = ?")

  // ── hypothesis groups ──
  static let groupById = SQL("prov.group.get", "SELECT id, target_type, target_ref FROM hypothesis_group WHERE id = ?")
  static let groupRow = SQL("prov.group.row", """
    SELECT id, target_type, target_ref, question, created_by, is_synthetic, created_at FROM hypothesis_group WHERE id = ?
    """)
  static let relationshipsOfGroup = SQL("prov.group.rels", """
    SELECT \(relationshipColumns) FROM relationship r WHERE r.hypothesis_group_id = ? AND (r.run_id IS NULL
      OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id AND a.status IN ('succeeded', 'superseded'))) ORDER BY r.id
    """)
  static let groupByQuestion = SQL("prov.group.find",
    "SELECT id FROM hypothesis_group WHERE target_type = ? AND target_ref = ? AND question = ?",
    scan: .scanOK(reason: "hypothesis_group has no index (reference schema); groups are few"))
  static let insertGroup = SQL("prov.group.insert", """
    INSERT INTO hypothesis_group (id, target_type, target_ref, question, created_by, is_synthetic, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    """)

  // ── what a saved view reads of the query layer ──
  static let realMembers = SQL("prov.scope.real", """
    SELECT k.id, k.slug, k.name FROM corpus k WHERE k.is_synthetic = 0 AND k.slug <> 'demo'
      AND EXISTS (SELECT 1 FROM collection c WHERE c.corpus_id = k.id AND EXISTS (SELECT 1 FROM document d INDEXED BY doc_facets
        WHERE d.collection_id = c.id AND d.deleted_at IS NULL))
    ORDER BY k.id
    """, scan: .scanOK(reason: "corpus and collection are tiny; documents are probed through doc_facets"))
  static let corpusBySlug = SQL("prov.scope.corpus", "SELECT id, slug, name, is_synthetic FROM corpus WHERE slug = ?")
  static let siblingExpression = SQL("prov.scope.sibling",
    "SELECT id FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ? AND corpus_id = ?")
  static let expressionById = SQL("prov.scope.expression", "SELECT id, corpus_id, kind, lang, norm, surface FROM expression WHERE id = ?")
  static let countedRun = SQL("prov.scope.counted-run", """
    SELECT s.run_id FROM expression_state s JOIN analysis_run r ON r.id = s.run_id AND r.status = 'succeeded'
    WHERE s.expression_id = ?
    """)
  static let runMetrics = SQL("prov.scope.run-metrics", "SELECT metrics_json FROM analysis_run WHERE id = ?")
  static let pinnedMaterialize = SQL("prov.scope.pinned-materialize", """
    SELECT 1 FROM analysis_run WHERE id = ? AND stage = 'materialize' AND status = 'succeeded'
      AND json_extract(params_json, '$.expression') = ?
    """)
  static let workInScope = SQL("prov.scope.work", """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
      AND c.corpus_id IN (SELECT value FROM json_each(?))
    """)
  static let makerNames = SQL("prov.scope.makers", """
    SELECT DISTINCT d.author FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE c.corpus_id = ? AND d.author IS NOT NULL AND d.deleted_at IS NULL
    UNION
    SELECT DISTINCT t.value FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      WHERE t.scheme = 'maker' AND c.corpus_id = ? AND d.deleted_at IS NULL
    """, scan: .scanOK(reason: "maker strands without the label index scan the corpus's authors (the reference's fallback)"))
  static let pinnedClusterRun = SQL("prov.scope.cluster-pinned", """
    SELECT id, params_json, gate_json FROM analysis_run WHERE id = ? AND stage = 'cluster' AND status = 'succeeded'
      AND json_extract(scope_json, '$.expression') = ?
    """)
  static let latestClusterRun = SQL("prov.scope.cluster-latest", """
    SELECT id, params_json, gate_json FROM analysis_run WHERE stage = 'cluster' AND status = 'succeeded'
      AND json_extract(scope_json, '$.expression') = ? ORDER BY id DESC LIMIT 1
    """, scan: .scanOK(reason: "analysis_run is small (tens to thousands of runs)"))
  static let exprDocRows = SQL("prov.scope.expr-doc", """
    SELECT document_id, plang, field_class, n, n_names, n_passages FROM expr_doc
    WHERE expression_id = ? AND run_id = ? ORDER BY document_id, plang, field_class
    """)

  // ── saved views ──
  static let viewColumns = """
    id, slug, parent_slug, name, description, state_json, state_hash, data_version, max_import_batch, run_ids_json,
    annotation_rev_cutoff, relationship_rev_cutoff, comparisons_tried, created_by, created_at, deleted_at
    """
  static let runRow = SQL("prov.view.run", "SELECT id, stage, status, scope_json, params_hash FROM analysis_run WHERE id = ?")
  static let readyRun = SQL("prov.view.ready-run", "SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'")
  static let latestRunOfStage = SQL("prov.view.latest-run",
    "SELECT id FROM analysis_run WHERE stage = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1")
  static let newerRun = SQL("prov.view.newer-run", """
    SELECT id FROM analysis_run WHERE stage = ? AND status = 'succeeded' AND id > ? AND scope_json = ? ORDER BY id DESC LIMIT 1
    """)
  static let collectionsOfCorpora = SQL("prov.view.collections",
    "SELECT c.id, c.slug FROM collection c WHERE c.corpus_id IN (SELECT value FROM json_each(?)) ORDER BY c.id",
    scan: .scanOK(reason: "collection is tiny"))
  static let docsNow = "d.collection_id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL"
  static let docsAsSaved = """
    d.collection_id IN (SELECT value FROM json_each(?)) AND d.import_batch_id <= ? AND (d.deleted_at IS NULL OR d.deleted_at > ?)
      AND EXISTS (SELECT 1 FROM import_batch b WHERE b.id = d.import_batch_id AND (b.committed_at IS NULL OR b.committed_at <= ?))
    """
  static let countDocs = SQL("prov.view.count-docs",
    "SELECT count(*), COALESCE(SUM(d.passage_count), 0) FROM document d WHERE \(docsNow)",
    scan: .scanOK(reason: "a view's counts read every document of its collections (reference viewCounts)"))
  static let countDocsAsSaved = SQL("prov.view.count-docs-as-saved",
    "SELECT count(*), COALESCE(SUM(d.passage_count), 0) FROM document d WHERE \(docsAsSaved)",
    scan: .scanOK(reason: "a view's counts read every document of its collections (reference viewCounts)"))
  static let countTokens = SQL("prov.view.count-tokens", """
    SELECT COALESCE(SUM(t.tokens), 0) FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE t.field_class = 'text' AND \(docsNow)
    """, scan: .scanOK(reason: "a view's counts read every document of its collections (reference viewCounts)"))
  static let countTokensAsSaved = SQL("prov.view.count-tokens-as-saved", """
    SELECT COALESCE(SUM(t.tokens), 0) FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE t.field_class = 'text' AND \(docsAsSaved)
    """, scan: .scanOK(reason: "a view's counts read every document of its collections (reference viewCounts)"))
  static let countStrand = SQL("prov.view.count-strand", """
    SELECT COALESCE(SUM(e.n), 0), COUNT(DISTINCT e.document_id) FROM expr_doc e JOIN document d ON d.id = e.document_id
    WHERE e.expression_id = ? AND e.run_id = ? AND \(docsNow)
    """)
  static let countStrandAsSaved = SQL("prov.view.count-strand-as-saved", """
    SELECT COALESCE(SUM(e.n), 0), COUNT(DISTINCT e.document_id) FROM expr_doc e JOIN document d ON d.id = e.document_id
    WHERE e.expression_id = ? AND e.run_id = ? AND \(docsAsSaved)
    """)
  static let viewBySlug = SQL("prov.view.get", "SELECT \(viewColumns) FROM saved_view WHERE slug = ?")
  static let viewById = SQL("prov.view.by-id", "SELECT \(viewColumns) FROM saved_view WHERE id = ?")
  static let corpusSynthetic = SQL("prov.view.corpus-syn", "SELECT is_synthetic FROM corpus WHERE slug = ?")
  static let importsSince = SQL("prov.view.imports-since", """
    SELECT b.id, b.file_name, c.slug, b.committed_at FROM import_batch b LEFT JOIN collection c ON c.id = b.collection_id
    WHERE b.status = 'committed' AND b.id > ? ORDER BY b.id
    """)
  static let revertedSince = SQL("prov.view.reverted-since", """
    SELECT b.id, b.file_name, c.slug, MAX(d.deleted_at) FROM import_batch b JOIN document d ON d.import_batch_id = b.id
      LEFT JOIN collection c ON c.id = b.collection_id
    WHERE b.status = 'reverted' AND b.id <= ? AND d.deleted_at > ? GROUP BY b.id ORDER BY b.id
    """, scan: .scanOK(reason: "reverted batches are few; their documents are found through import_batch_id"))
  static let annotationRevisionsSince = SQL("prov.view.ann-since", "SELECT count(*) FROM annotation_revision WHERE id > ?")
  static let relationshipRevisionsSince = SQL("prov.view.rel-since", "SELECT count(*) FROM relationship_revision WHERE id > ?")
  static let slugsLike = SQL("prov.view.slugs", "SELECT slug FROM saved_view WHERE slug = ? OR slug LIKE ? ESCAPE '\\'",
    scan: .scanOK(reason: "LIKE over the saved views (tens to hundreds)"))
  static let slugExists = SQL("prov.view.exists", "SELECT 1 FROM saved_view WHERE slug = ?")
  static let maxCommittedBatch = SQL("prov.view.max-batch",
    "SELECT COALESCE(MAX(id), 0) FROM import_batch WHERE status = 'committed'",
    scan: .scanOK(reason: "import_batch is small"))
  static let maxAnnotationRevision = SQL("prov.view.max-ann-rev", "SELECT COALESCE(MAX(id), 0) FROM annotation_revision")
  static let maxRelationshipRevision = SQL("prov.view.max-rel-rev", "SELECT COALESCE(MAX(id), 0) FROM relationship_revision")
  static let insertView = SQL("prov.view.insert", """
    INSERT INTO saved_view (id, slug, parent_slug, name, description, state_json, state_version, state_hash, data_version,
        max_import_batch, run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff, comparisons_tried, snapshot_svg,
        created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    """)
  static let listViews = SQL("prov.view.list", """
    SELECT v.id, v.slug, v.name, v.description, v.parent_slug, v.created_at, v.data_version, v.state_json, k.is_synthetic
    FROM saved_view v LEFT JOIN corpus k ON k.slug = json_extract(v.state_json, '$.corpus')
    WHERE v.deleted_at IS NULL AND v.id < ? AND (? IS NULL OR lower(v.name) LIKE ? OR lower(v.slug) LIKE ?)
    ORDER BY v.id DESC LIMIT ?
    """, scan: .scanOK(reason: "saved views are listed newest first (tens to hundreds)"))
  static let softDeleteView = SQL("prov.view.delete", "UPDATE saved_view SET deleted_at = ? WHERE id = ?")

  // ── journal: stable keys and portable cutoffs (IOS-SPEC §6.3, §6.4) ──
  static let docKey = SQL("prov.key.doc",
    "SELECT c.slug, d.ext_id FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?")
  static let docByKey = SQL("prov.key.doc-by",
    "SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ?")
  static let exprKey = SQL("prov.key.expr",
    "SELECT e.kind, e.lang, e.norm, k.slug FROM expression e LEFT JOIN corpus k ON k.id = e.corpus_id WHERE e.id = ?")
  static let exprByKey = SQL("prov.key.expr-by", """
    SELECT e.id FROM expression e LEFT JOIN corpus k ON k.id = e.corpus_id
    WHERE e.kind = ? AND IFNULL(e.lang, '') = ? AND e.norm = ? AND IFNULL(k.slug, '') = ?
    """)
  static let runKey = SQL("prov.key.run", "SELECT stage, params_hash, input_fingerprint, code_hash FROM analysis_run WHERE id = ?")
  static let runByKey = SQL("prov.key.run-by", """
    SELECT id FROM analysis_run WHERE stage = ? AND params_hash = ? AND input_fingerprint = ? AND code_hash = ?
      AND status IN ('succeeded', 'superseded') ORDER BY id DESC LIMIT 1
    """)
  static let clusterKey = SQL("prov.key.cluster", "SELECT run_id, ord FROM sense_cluster WHERE id = ?")
  static let clusterByKey = SQL("prov.key.cluster-by", "SELECT id FROM sense_cluster WHERE run_id = ? AND ord = ?",
    scan: .scanOK(reason: "sense clusters of one run (a handful)"))
  static let occurrenceRow = SQL("prov.key.occurrence", "SELECT expression_id, document_id FROM occurrence WHERE id = ?")
  static let occurrenceSpan = SQL("prov.key.occurrence-span", """
    SELECT p.field, o.start_off, o.end_off FROM occurrence o JOIN passage p ON p.id = o.passage_id WHERE o.id = ?
    """)
  static let packsInstalled = SQL("prov.view.packs", "SELECT pack_sha256 FROM pack_install ORDER BY installed_at, pack_sha256",
    scan: .scanOK(reason: "a handful of installed packs"))
  static let occurrenceAt = SQL("prov.key.occurrence-at", """
    SELECT o.id FROM occurrence o WHERE o.expression_id = ? AND o.document_id = ? AND o.start_off >= ? AND o.end_off <= ?
    ORDER BY o.run_id DESC, o.start_off LIMIT 1
    """, scan: .scanOK(reason: "occurrences of one expression in one document"))
  static let relKeyRow = SQL("prov.key.rel", """
    SELECT rel_type, src_type, src_ref, dst_type, dst_ref, source_dataset, source_locator, origin, run_id FROM relationship WHERE id = ?
    """)
  static let relFirstRevision = SQL("prov.key.rel-rev1", "SELECT id FROM relationship_revision WHERE relationship_id = ? AND rev = 1")
  static let relCreatedIn = SQL("prov.key.rel-created",
    "SELECT relationship_id FROM relationship_revision WHERE id > ? AND id <= ? AND rev = 1 AND action = 'create' ORDER BY id LIMIT 1")
  static let relOfRun = SQL("prov.key.rel-of-run", """
    SELECT id FROM relationship WHERE run_id = ? AND src_type = ? AND src_ref = ? AND dst_type = ? AND dst_ref = ? LIMIT 1
    """, scan: .scanOK(reason: "rel_src index narrows to one endpoint"))
  static let annotationFirstRevisionId = SQL("prov.key.ann-rev1", "SELECT id FROM annotation_revision WHERE annotation_id = ? AND rev = 1")
  static let annotationCreatedIn = SQL("prov.key.ann-created",
    "SELECT annotation_id FROM annotation_revision WHERE id > ? AND id <= ? AND rev = 1 ORDER BY id LIMIT 1")
  static let appliedAt = SQL("prov.journal.applied", "SELECT max_ids_json, op FROM journal_applied WHERE seq = ?")
  static let appliedBefore = SQL("prov.journal.applied-before",
    "SELECT max_ids_json FROM journal_applied WHERE seq < ? ORDER BY seq DESC LIMIT 1")
  static let appliedCovering = SQL("prov.journal.applied-covering", """
    SELECT seq, op FROM journal_applied WHERE CAST(json_extract(max_ids_json, '$.' || ?) AS INTEGER) >= ? ORDER BY seq LIMIT 1
    """, scan: .scanOK(reason: "journal_applied holds one row per act (thousands at most)"))
  static let appliedMaxBefore = SQL("prov.journal.max-before", """
    SELECT MAX(CAST(json_extract(max_ids_json, '$.' || ?) AS INTEGER)) FROM journal_applied WHERE seq < ?
    """, scan: .scanOK(reason: "journal_applied holds one row per act (thousands at most)"))
  static let insertPortable = SQL("prov.view.portable.insert",
    "INSERT INTO saved_view_portable (view_id, portable_json, created_at) VALUES (?, ?, ?)")
  static let portableOf = SQL("prov.view.portable", "SELECT portable_json FROM saved_view_portable WHERE view_id = ?")
  static let groupsWithQuestion = SQL("prov.key.groups", "SELECT id, target_type, target_ref, question FROM hypothesis_group WHERE id = ?")
  static let timeWindowKey = SQL("prov.key.window", "SELECT run_id, label FROM time_window WHERE id = ?")
  static let timeWindowByKey = SQL("prov.key.window-by", "SELECT id FROM time_window WHERE run_id = ? AND label = ? LIMIT 1",
    scan: .scanOK(reason: "time windows of one run"))

  public static let all: [SQL] = [
    textSha, fieldValue, passageInside, passageFirst, annotationsWithAnchorOfDoc, updateAnnotationAnchor, evidenceWithAnchorOfDoc,
    updateEvidenceAnchor, missingSrcPassages, missingDstPassages, refPassage, refDocument, refOccurrence, passageBounds,
    refExpression, refCluster, refEtymon, refRelationship, refHypothesisGroup, refSavedView, refTimeWindow, refAnnotation,
    dimensionDef, insertCustomDimension, insertDimension, insertAnnotationFTS, insertAnnotationRevision, insertAnnotation,
    annotationById, supersededBy, revisionsOf, firstRevision, setAnnotationRev, supersedeAnnotation, withdrawAnnotation,
    counterAnnotation, listAnnotations, relationshipVisible, insertEvidence, insertRelRevision, insertCreateRevision,
    setRelRevAndReview, setRelRev, setRelGroup, insertHumanRelationship, relRevisionActions, relEvidenceStatus, evidenceOf,
    evidenceCount, revisionsOfRelationship, annotationsOfRelationship, runSummary, groupById, groupRow, relationshipsOfGroup,
    groupByQuestion, insertGroup, realMembers, corpusBySlug, siblingExpression, expressionById, countedRun, runMetrics,
    pinnedMaterialize, workInScope, makerNames, pinnedClusterRun, latestClusterRun, exprDocRows, runRow, readyRun,
    latestRunOfStage, newerRun, collectionsOfCorpora, countDocs, countDocsAsSaved, countTokens, countTokensAsSaved, countStrand,
    countStrandAsSaved, viewBySlug, viewById, corpusSynthetic, importsSince, revertedSince, annotationRevisionsSince,
    relationshipRevisionsSince, slugsLike, slugExists, maxCommittedBatch, maxAnnotationRevision, maxRelationshipRevision,
    insertView, listViews, softDeleteView, docKey, docByKey, exprKey, exprByKey, runKey, runByKey, clusterKey, clusterByKey,
    occurrenceRow, occurrenceSpan, packsInstalled, occurrenceAt, relKeyRow, relFirstRevision, relCreatedIn, relOfRun, annotationFirstRevisionId,
    annotationCreatedIn, appliedAt, appliedBefore, appliedCovering, appliedMaxBefore, insertPortable, portableOf,
    groupsWithQuestion, timeWindowKey, timeWindowByKey,
  ]
}
