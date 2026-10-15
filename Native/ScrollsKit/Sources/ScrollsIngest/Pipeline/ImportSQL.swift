// OWNER: N1
// The statement catalogue of the import pipeline (IOS-SPEC §1.4): the SQL of server/ingest/{pipeline,dedupe,validate}.mjs
// and routes/imports.mjs, verbatim, plus explicit ORDER BY where the reference iterated rows in storage order (the dry
// run's duplicate indexes), so both sides read them in id order.

import ScrollsStore

/// Statements of the import pipeline.
public enum ImportSQL: SQLCatalog {
  // ── batches ──
  static let committedBatchForFile = SQL("import.batch.committed-file", """
    SELECT b.id, b.committed_at, b.file_name FROM import_batch b JOIN collection c ON c.id = b.collection_id
    WHERE c.slug = ? AND b.file_sha256 = ? AND b.status = 'committed' AND b.id IS NOT ? ORDER BY b.id LIMIT 1
    """)
  static let batchMarkFailed = SQL("import.batch.failed", """
    UPDATE import_batch SET status = 'failed', options_json = json_set(options_json, '$.failure', ?) WHERE id = ?
    """)
  static let batchPreviewed = SQL("import.batch.previewed", """
    UPDATE import_batch SET file_sha256 = ?, format = ?, adapter_id = ?, adapter_version = ?, status = 'previewed',
      options_json = ?, mapping_json = ? WHERE id = ?
    """)
  static let batchPreviewUpdate = SQL("import.batch.preview-update", """
    UPDATE import_batch SET format = ?, adapter_id = ?, options_json = ?, mapping_json = ? WHERE id = ?
    """)
  static let batchValidated = SQL("import.batch.validated", """
    UPDATE import_batch SET status = 'validated', format = ?, adapter_id = ?, mapping_json = ?, summary_json = ?
    WHERE id = ? AND status IN ('uploaded', 'previewed', 'validated', 'failed', 'cancelled')
    """)
  static let batchCommitJob = SQL("import.batch.commit-job", "UPDATE import_batch SET job_id = ?, mapping_json = ? WHERE id = ?")
  static let batchCommitting = SQL("import.batch.committing", """
    UPDATE import_batch SET status = 'committing', collection_id = ?, format = ?, adapter_id = ?, mapping_json = ?, job_id = ?
    WHERE id = ?
    """)
  static let batchSummary = SQL("import.batch.summary", "UPDATE import_batch SET summary_json = ? WHERE id = ?")
  static let batchStatusSummary = SQL("import.batch.status-summary", "UPDATE import_batch SET status = ?, summary_json = ? WHERE id = ?")
  static let batchReverted = SQL("import.batch.reverted", "UPDATE import_batch SET status = 'reverted' WHERE id = ?")
  static let previousMappings = SQL("import.batch.previous-mappings", """
    SELECT id, file_name, status, created_at, committed_at, format, mapping_json, options_json FROM import_batch
    WHERE adapter_id LIKE 'file.%' AND status IN ('validated', 'committed', 'reverted') AND id IS NOT ? ORDER BY id DESC LIMIT ?
    """, scan: .scanOK(reason: "import_batch is small (one row per load or import); the reference's query"))
  static let jobStatus = SQL("import.job.status", "SELECT id, status FROM job WHERE id = ?")

  // ── issues ──
  static let deleteIssues = SQL("import.issues.delete", "DELETE FROM import_issue WHERE batch_id = ?")
  static let countIssues = SQL("import.issues.count", "SELECT count(*) AS n FROM import_issue WHERE batch_id = ?")
  static let issuesOfBatch = SQL("import.issues.batch", """
    SELECT code, severity, line, col, field, value_excerpt, message, suggestion FROM import_issue WHERE batch_id = ? ORDER BY id
    """)

  // ── ids (dedupe.mjs, pipeline.mjs) ──
  static let collectionIDBySlug = SQL("import.collection.id", "SELECT id FROM collection WHERE slug = ?")
  static let existingExt = SQL("import.ext.existing", """
    SELECT d.id, d.deleted_at, d.import_batch_id FROM document d WHERE d.collection_id = ? AND d.ext_id = ?
    """)
  static let liveExtInCollectionSlug = SQL("import.ext.live-in-slug", """
    SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL LIMIT 1
    """)

  // ── the dry run's projector (validate.mjs) ──
  static let textShaLive = SQL("import.proj.textsha", """
    SELECT id FROM document WHERE text_sha256 = ? AND deleted_at IS NULL AND dup_of IS NULL ORDER BY id LIMIT 1
    """)
  static let extOrAliasInCollection = SQL("import.proj.ext", """
    SELECT 1 FROM document WHERE collection_id = ? AND ext_id = ? AND deleted_at IS NULL
    UNION SELECT 1 FROM document_alias a JOIN document d ON d.id = a.document_id
    WHERE d.collection_id = ? AND a.ext_id = ? AND d.deleted_at IS NULL LIMIT 1
    """)
  static let extOrAliasInSlug = SQL("import.proj.ext-slug", """
    SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL
    UNION SELECT 1 FROM document_alias a JOIN document d ON d.id = a.document_id JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND a.ext_id = ? AND d.deleted_at IS NULL LIMIT 1
    """)
  static let liveDocument = SQL("import.proj.doc-live", "SELECT 1 FROM document WHERE id = ? AND deleted_at IS NULL")
  static let documentSynthetic = SQL("import.proj.doc-synthetic", "SELECT is_synthetic FROM document WHERE id = ?")
  static let syntheticExtInSlug = SQL("import.proj.ext-synthetic", """
    SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ?
    AND d.is_synthetic = 1 AND d.deleted_at IS NULL LIMIT 1
    """)
  static let collectionSynthetic = SQL("import.proj.collection-synthetic", """
    SELECT k.is_synthetic FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.id = ?
    """)
  static let signatureCount = SQL("import.proj.sig-count", """
    SELECT count(*) AS n FROM doc_minhash m JOIN document d ON d.id = m.document_id WHERE d.collection_id = ? AND d.deleted_at IS NULL
    """)
  static let signatures = SQL("import.proj.sigs", """
    SELECT m.document_id AS id, m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id
    WHERE d.collection_id = ? AND d.deleted_at IS NULL ORDER BY m.document_id
    """)
  static let metadataRows = SQL("import.proj.meta", """
    SELECT id, title, author, y_lo FROM document WHERE collection_id = ? AND deleted_at IS NULL AND has_full_text = 0 ORDER BY id
    """)

  // ── collections (routes/imports.mjs) ──
  static let collectionWithCorpus = SQL("import.collection.with-corpus", """
    SELECT c.id, k.slug AS corpus_slug FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.slug = ?
    """)

  // ── revert ──
  static let revertDocuments = SQL("import.revert.documents",
    "UPDATE document SET deleted_at = ? WHERE import_batch_id = ? AND deleted_at IS NULL")
  static let revertOrphans = SQL("import.revert.orphans", """
    SELECT d.id, d.dup_of AS old FROM document d JOIN document r ON r.id = d.dup_of
    WHERE r.import_batch_id = ? AND d.deleted_at IS NULL ORDER BY d.id
    """, scan: .scanOK(reason: "documents flagged as duplicates are few; the reference's query"))
  static let setDupOf = SQL("import.revert.dup-of", "UPDATE document SET dup_of = ? WHERE id = ?")

  public static let all: [SQL] = [
    committedBatchForFile, batchMarkFailed, batchPreviewed, batchPreviewUpdate, batchValidated, batchCommitJob, batchCommitting,
    batchSummary, batchStatusSummary, batchReverted, previousMappings, jobStatus, deleteIssues, countIssues, issuesOfBatch,
    collectionIDBySlug, existingExt, liveExtInCollectionSlug, textShaLive, extOrAliasInCollection, extOrAliasInSlug, liveDocument,
    documentSynthetic, syntheticExtInSlug, collectionSynthetic, signatureCount, signatures, metadataRows, collectionWithCorpus,
    revertDocuments, revertOrphans, setDupOf,
  ]
}
