// OWNER: N4
// The statement catalogue of ScrollsAnalysis (IOS-SPEC §1.4): every SQL text of Compare, collocations and the token
// streams. The texts are the reference's own (server/analysis/{slices,compare,collocations,drift,tone,occvec,
// tokstream,labels}.mjs), so SQLite plans them — and orders their rows — as the reference does: the order of the scope's
// documents decides the order of sums, strata and bootstrap blocks, which the exact paths reproduce (§2.4).
// A scope's document condition has four worded variants (the reference's `scopeDocFilter`), one statement each.

import ScrollsStore

/// Statements of ScrollsAnalysis.
public enum AnalysisSQL: SQLCatalog {
  // ── the scope ──

  static let collections = SQL("analysis.scope.collections", """
    SELECT c.id, c.corpus_id, c.slug, c.name, c.domain, c.modality, c.unit, c.sampling, c.rate_eligible, c.coverage_gate,
      c.export_text_allowed, c.is_synthetic, c.license, c.selection_note, c.caveats_json, k.slug AS corpus_slug
    FROM collection c JOIN corpus k ON k.id = c.corpus_id
    """, scan: .scanOK(reason: "one row per collection (tens)"))
  static let corpusBySlug = SQL("analysis.scope.corpus", "SELECT id FROM corpus WHERE slug = ?")

  /// `scopeDocFilter(cutoffs).sql` as the reference words it.
  static func live(_ f: SliceRequests.ScopeFilter) -> String {
    switch f {
    case .live: "d.deleted_at IS NULL"
    case .at: "(d.deleted_at IS NULL OR d.deleted_at > ?)"
    case .batch: "d.deleted_at IS NULL AND (d.import_batch_id IS NULL OR d.import_batch_id <= ?)"
    case .atBatch: "(d.deleted_at IS NULL OR d.deleted_at > ?) AND (d.import_batch_id IS NULL OR d.import_batch_id <= ?)"
    }
  }
  static let filterNames: [(String, SliceRequests.ScopeFilter)] = [
    ("live", .live), ("at", .at("")), ("batch", .batch(0)), ("at-batch", .atBatch("", 0)),
  ]
  static func worded(_ id: String, _ text: (String) -> String) -> [SQL] {
    filterNames.map { name, f in SQL("\(id).\(name)", text(live(f))) }
  }

  static let scopeDocsVariants = worded("analysis.scope.docs") { live in """
    SELECT d.id, d.collection_id AS coll, d.kind, d.lang_text, d.author, d.y_lo, d.y_hi,
        d.chrono_status AS chrono, d.basis, d.precision, d.is_translation AS tr, d.dup_of AS dup, d.prominence,
        d.prominence_tercile AS tercile, d.is_synthetic AS syn, d.community, d.culture, d.field, d.title, d.date_label
      FROM document d WHERE \(live) AND d.collection_id IN (SELECT value FROM json_each(?))
    """ }
  static let scopeTokensVariants = worded("analysis.scope.tokens") { live in """
    SELECT t.document_id AS id, t.plang, t.field_class AS fc, t.tokens FROM doc_tokens t
      JOIN document d ON d.id = t.document_id
      WHERE \(live) AND d.collection_id IN (SELECT value FROM json_each(?))
    """ }
  static let scopeHits = SQL("analysis.scope.hits", """
    SELECT document_id AS id, plang, field_class AS fc, n, n_names AS names
      FROM expr_doc WHERE expression_id = ? AND run_id = ?
    """)
  static let sampleCellsVariants = worded("analysis.scope.sample-cells") { live in """
    SELECT d.id, json_extract(d.original_meta_json, '$.sample_cell') AS cell FROM document d
      WHERE d.collection_id IN (SELECT value FROM json_each(?)) AND \(live)
    """ }

  static func scopeDocs(_ f: SliceRequests.ScopeFilter) -> SQL { scopeDocsVariants[index(f)] }
  static func scopeTokens(_ f: SliceRequests.ScopeFilter) -> SQL { scopeTokensVariants[index(f)] }
  static func sampleCells(_ f: SliceRequests.ScopeFilter) -> SQL { sampleCellsVariants[index(f)] }
  private static func index(_ f: SliceRequests.ScopeFilter) -> Int {
    switch f {
    case .live: 0
    case .at: 1
    case .batch: 2
    case .atBatch: 3
    }
  }

  // ── expressions ──

  static let expression = SQL("analysis.expr.get",
    "SELECT id, surface, norm, kind, lang, corpus_id, is_synthetic FROM expression WHERE id = ?")
  static let pinnedRun = SQL("analysis.expr.pinned-run", """
    SELECT 1 FROM analysis_run WHERE id = ? AND stage = 'materialize' AND status = 'succeeded'
      AND json_extract(params_json, '$.expression') = ?
    """)
  static let stateRun = SQL("analysis.expr.state-run", """
    SELECT s.run_id AS run FROM expression_state s JOIN analysis_run r ON r.id = s.run_id
      WHERE s.expression_id = ? AND r.status = 'succeeded'
    """)
  static let newestRun = SQL("analysis.expr.newest-run", """
    SELECT r.id FROM analysis_run r WHERE r.stage = 'materialize' AND r.status = 'succeeded'
      AND EXISTS (SELECT 1 FROM expr_doc x WHERE x.expression_id = ? AND x.run_id = r.id) ORDER BY r.id DESC LIMIT 1
    """, scan: .scanOK(reason: "analysis_run holds tens to thousands of rows; newest first by rowid"))
  static let stateStatus = SQL("analysis.expr.state-status", "SELECT status FROM expression_state WHERE expression_id = ?")
  static let expressionVariants = SQL("analysis.expr.variants",
    "SELECT id, norm, lang, variant_type FROM expression_variant WHERE expression_id = ? AND enabled = 1 ORDER BY id")

  // ── passages and text ──

  static let field = SQL("analysis.text.field", "SELECT value FROM document_field WHERE document_id = ? AND field = ?")
  static let docOccurrences = SQL("analysis.passages.doc-occurrences", """
    SELECT o.id AS occ, o.passage_id, o.start_off, o.end_off, o.name_flag, p.field, p.field_class AS fc,
        p.lang, p.quality, p.start_off AS p_start, p.end_off AS p_end
      FROM occurrence o JOIN passage p ON p.id = o.passage_id
      WHERE o.expression_id = ? AND o.run_id = ? AND o.document_id = ? ORDER BY o.id
    """)

  // ── collocations ──

  static let slicePassages = SQL("analysis.colloc.passages", """
    SELECT p.id, p.document_id, p.field, p.field_class AS fc, p.lang, p.start_off, p.end_off, p.token_count
      FROM passage p WHERE p.document_id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok' ORDER BY p.id
    """)
  static let nameOccurrences = SQL("analysis.colloc.names", """
    SELECT o.passage_id AS pid, o.start_off, p.document_id, p.field, p.start_off AS p_start, p.end_off AS p_end
      FROM occurrence o JOIN passage p ON p.id = o.passage_id
      WHERE o.expression_id = ? AND o.run_id = ? AND o.name_flag = 1 AND o.document_id IN (SELECT value FROM json_each(?))
    """)
  static let storedCollocationRun = SQL("analysis.colloc.stored-run", """
    SELECT id FROM analysis_run WHERE stage = 'collocations' AND params_hash = ? AND input_fingerprint = ?
      AND status = 'succeeded' ORDER BY id DESC LIMIT 1
    """)
  static let storedCollocations = SQL("analysis.colloc.stored-rows", """
    SELECT collocate AS term, f_xy, f_y, g2, q_value AS q, log_dice AS logDice, ppmi FROM collocation
      WHERE run_id = ? AND expression_id = ? AND slice_key = ? ORDER BY log_dice DESC, g2 DESC
    """)
  static let runJob = SQL("analysis.run.job", "SELECT job_id FROM analysis_run WHERE id = ?")

  // ── runs and fingerprints (jobs/context.mjs inputFingerprint) ──

  static let collectionBatches = SQL("analysis.runs.batches", """
    SELECT c.slug, c.id, MAX(b.id) AS batch FROM collection c
      LEFT JOIN import_batch b ON b.collection_id = c.id AND b.status = 'committed' GROUP BY c.id ORDER BY c.slug
    """, scan: .scanOK(reason: "one row per collection (tens)"))
  static let meta = SQL("analysis.meta.get", "SELECT value FROM meta WHERE key = ?")

  // ── token streams (tokstream.mjs) ──

  static let maxPassage = SQL("analysis.tokstream.max-passage", "SELECT MAX(id) AS id FROM passage")
  static let batchStatus = SQL("analysis.tokstream.batches",
    "SELECT status, COUNT(*) AS n, MAX(id) AS max FROM import_batch GROUP BY status ORDER BY status",
    scan: .scanOK(reason: "import_batch holds one row per import"))
  static let streamLanguages = SQL("analysis.tokstream.langs", """
    SELECT p.lang, count(*) AS passages, sum(p.token_count) AS tokens FROM passage p
      JOIN document d ON d.id = p.document_id WHERE p.quality = 'ok' AND d.deleted_at IS NULL GROUP BY p.lang ORDER BY p.lang
    """, scan: .scanOK(reason: "the token-stream job reads every passage once (a job, minutes)"))
  static let streamPassages = SQL("analysis.tokstream.passages", """
    SELECT p.id, p.document_id, p.field, p.start_off, p.end_off FROM passage p
      JOIN document d ON d.id = p.document_id WHERE p.quality = 'ok' AND p.lang = ? AND d.deleted_at IS NULL ORDER BY p.id
    """, scan: .scanOK(reason: "the token-stream job reads every passage of a language once, in id order"))

  // ── clustering runs read by Compare (drift.mjs, labels.mjs) ──

  static let clusterRunPinned = SQL("analysis.cluster.run-pinned", """
    SELECT r.id, r.representation, json_extract(r.scope_json, '$.modality') AS modality FROM analysis_run r
      WHERE r.id = ? AND r.stage = 'cluster' AND r.status = 'succeeded'
      AND (? IS NULL OR json_extract(r.scope_json, '$.modality') IS NULL OR json_extract(r.scope_json, '$.modality') = ?)
      AND EXISTS (SELECT 1 FROM sense_cluster c WHERE c.run_id = r.id AND c.expression_id = ?)
    """)
  static let clusterRunNewest = SQL("analysis.cluster.run-newest", """
    SELECT r.id, r.representation, json_extract(r.scope_json, '$.modality') AS modality FROM analysis_run r
      WHERE r.stage = 'cluster' AND r.status = 'succeeded' AND (? IS NULL OR r.finished_at <= ?)
      AND (? IS NULL OR json_extract(r.scope_json, '$.modality') IS NULL OR json_extract(r.scope_json, '$.modality') = ?)
      AND EXISTS (SELECT 1 FROM sense_cluster c WHERE c.run_id = r.id AND c.expression_id = ?)
      ORDER BY r.id DESC LIMIT 1
    """, scan: .scanOK(reason: "analysis_run holds tens to thousands of rows; newest first"))
  static let clustersOfRun = SQL("analysis.cluster.clusters", """
    SELECT c.id, c.ord, c.label_auto AS label, c.status, c.size,
        (SELECT v.body_md FROM annotation a JOIN annotation_revision v ON v.annotation_id = a.id AND v.rev = a.current_rev
          WHERE a.target_type = 'cluster' AND a.target_ref = CAST(c.id AS TEXT) AND a.kind = 'label' AND a.status = 'active'
          ORDER BY a.id DESC LIMIT 1) AS human_label
      FROM sense_cluster c WHERE c.run_id = ? AND c.expression_id = ? ORDER BY c.ord, c.id
    """, scan: .scanOK(reason: "sense_cluster holds a few rows per clustering run"))
  static let humanLabels = SQL("analysis.cluster.human-labels", """
    SELECT a.id, a.target_ref, a.author, r.body_md, r.rev, r.at, r.id AS rev_id
      FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id
      WHERE a.target_type = 'cluster' AND a.kind = 'label' AND a.status = 'active'
        AND a.target_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND r.rev = (SELECT MAX(r2.rev) FROM annotation_revision r2 WHERE r2.annotation_id = a.id AND (? IS NULL OR r2.id <= ?))
      ORDER BY a.id
    """)
  static let clusterDocCounts = SQL("analysis.cluster.doc-counts", """
    SELECT o.document_id AS doc, m.cluster_id AS cluster FROM cluster_member m
      JOIN sense_cluster c ON c.id = m.cluster_id JOIN occurrence o ON o.id = m.occurrence_id
      WHERE c.run_id = ? AND c.expression_id = ?
    """, scan: .scanOK(reason: "sense_cluster holds a few rows per run; members by the cluster key"))

  // ── stored drift and tone runs, spaces ──

  static let storedDriftRun = SQL("analysis.drift.stored-run", """
    SELECT id FROM analysis_run WHERE stage = 'drift' AND status = 'succeeded' AND params_hash = ?
      AND input_fingerprint = ? ORDER BY id DESC LIMIT 1
    """)
  static let driftResults = SQL("analysis.drift.results", """
    SELECT metric, value, ci_lo, ci_hi, null_percentile, gate, gate_detail_json FROM drift_result WHERE run_id = ? ORDER BY id
    """, scan: .scanOK(reason: "drift_result holds a few rows per drift run"))
  static let storedToneRun = SQL("analysis.tone.stored-run", """
    SELECT id, model_version, metrics_json FROM analysis_run WHERE stage = 'tone' AND status = 'succeeded'
      AND params_hash = ? AND input_fingerprint = ? ORDER BY id DESC LIMIT 1
    """)
  static let toneRows = SQL("analysis.tone.rows", """
    SELECT CAST(a.target_ref AS INTEGER) AS passage, p.document_id AS doc,
        json_extract(r.dimensions_json, '$.machine_tone') AS score
      FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = a.current_rev
      JOIN passage p ON p.id = CAST(a.target_ref AS INTEGER)
      WHERE a.run_id = ? AND a.kind = 'machine_tone' AND a.status = 'active'
    """, scan: .scanOK(reason: "annotation has no run index; machine tone rows are read once per comparison"))
  static let spaces = SQL("analysis.spaces.list", """
    SELECT s.id, s.run_id, s.lang, s.pooled, s.collections_json, s.tokens, s.vocab_size, s.dim
      FROM vector_space s JOIN analysis_run r ON r.id = s.run_id
      WHERE r.status = 'succeeded' AND (? IS NULL OR s.lang = ?) AND (? IS NULL OR s.pooled = ?) AND (? IS NULL OR s.run_id = ?)
      ORDER BY s.id DESC
    """, scan: .scanOK(reason: "vector_space holds one row per built space"))

  // ── human annotation counts ──

  static let humanCounts = SQL("analysis.human.counts", """
    SELECT a.target_type, a.target_ref, r.dimensions_json,
        CASE a.target_type WHEN 'document' THEN CAST(a.target_ref AS INTEGER)
          WHEN 'passage' THEN (SELECT p.document_id FROM passage p WHERE p.id = CAST(a.target_ref AS INTEGER))
          WHEN 'occurrence' THEN (SELECT o.document_id FROM occurrence o WHERE o.id = CAST(a.target_ref AS INTEGER)) END AS doc
      FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = a.current_rev
      WHERE a.status = 'active' AND a.is_machine = 0 AND a.target_type IN ('document', 'passage', 'occurrence')
        AND (json_extract(r.dimensions_json, '$.pragmatic_function') IS NOT NULL OR json_extract(r.dimensions_json, '$.stance') IS NOT NULL)
    """, scan: .scanOK(reason: "human annotations are hand-written: hundreds of rows"))
  static let humanAnnotationsAt = SQL("analysis.human.at", """
    SELECT a.id, a.status, CASE a.target_type WHEN 'document' THEN CAST(a.target_ref AS INTEGER)
        WHEN 'passage' THEN (SELECT p.document_id FROM passage p WHERE p.id = CAST(a.target_ref AS INTEGER))
        WHEN 'occurrence' THEN (SELECT o.document_id FROM occurrence o WHERE o.id = CAST(a.target_ref AS INTEGER)) END AS doc
      FROM annotation a WHERE a.is_machine = 0 AND a.target_type IN ('document', 'passage', 'occurrence')
        AND EXISTS (SELECT 1 FROM annotation_revision r WHERE r.annotation_id = a.id AND r.id <= ?)
    """, scan: .scanOK(reason: "human annotations are hand-written: hundreds of rows"))
  static let annotationRevisions = SQL("analysis.human.revisions",
    "SELECT id, rev, dimensions_json, at FROM annotation_revision WHERE annotation_id = ? ORDER BY rev")
  static let supersededBy = SQL("analysis.human.superseded-by",
    "SELECT id, created_at FROM annotation WHERE supersedes = ? ORDER BY id LIMIT 1",
    scan: .scanOK(reason: "annotation has no supersedes index; hundreds of rows"))
  static let firstRevision = SQL("analysis.human.first-revision",
    "SELECT id, at FROM annotation_revision WHERE annotation_id = ? AND rev = 1")

  public static let all: [SQL] = scopeDocsVariants + scopeTokensVariants + sampleCellsVariants + [
    collections, corpusBySlug, scopeHits, expression, pinnedRun, stateRun, newestRun, stateStatus, expressionVariants, field,
    docOccurrences, slicePassages, nameOccurrences, storedCollocationRun, storedCollocations, runJob, collectionBatches,
    meta, maxPassage, batchStatus, streamLanguages, streamPassages, clusterRunPinned, clusterRunNewest, clustersOfRun,
    humanLabels, clusterDocCounts, storedDriftRun, driftResults, storedToneRun, toneRows, spaces, humanCounts,
    humanAnnotationsAt, annotationRevisions, supersededBy, firstRevision,
  ]
}
