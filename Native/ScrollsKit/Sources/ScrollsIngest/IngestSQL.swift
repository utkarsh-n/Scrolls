// OWNER: N1
// The statement catalogue of ScrollsIngest (IOS-SPEC §1.4): every SQL text of DocumentWriter, its helpers
// (collections, batches, originals, rollback), the duplicate index and the import pipeline. Texts are the reference's
// (server/store/document-writer.mjs, dup-index.mjs, bins.mjs, server/ingest/*.mjs, routes/imports.mjs) with explicit
// ids where the reference relied on rowid assignment: entity ids come from `RowIDAllocator` (slot or local range on the
// device, max + 1 on a reference database), log ids are max + 1 (commit order). Document text is read only through
// `TextStore`. IngestSQLTests EXPLAIN every entry.

import ScrollsStore

/// Statements of ScrollsIngest.
public enum IngestSQL: SQLCatalog {
  // ── corpora, collections, batches, originals ──
  static let corpusBySlug = SQL("ingest.corpus.slug", "SELECT id, slug, is_synthetic FROM corpus WHERE slug = ?")
  static let corpusByID = SQL("ingest.corpus.id", "SELECT id, slug, is_synthetic FROM corpus WHERE id = ?")
  static let collectionBySlug = SQL("ingest.collection.slug", """
    SELECT id, corpus_id, adapter_id, slug, name, is_synthetic, export_text_allowed FROM collection WHERE slug = ?
    """)
  static let collectionByID = SQL("ingest.collection.id", """
    SELECT id, corpus_id, adapter_id, slug, name, is_synthetic, export_text_allowed FROM collection WHERE id = ?
    """)
  static let collectionCorpusSlug = SQL("ingest.collection.corpus-slug", """
    SELECT k.slug FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.slug = ?
    """)
  static let insertCollection = SQL("ingest.collection.insert", """
    INSERT INTO collection (id, corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, rate_eligible,
      coverage_gate, export_text_allowed, is_synthetic, license, attribution, selection_note, caveats_json, source_uri,
      retrieved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let adapterVersion = SQL("ingest.adapter.version", "SELECT version FROM source_adapter WHERE id = ?")
  static let insertAdapter = SQL("ingest.adapter.insert", """
    INSERT INTO source_adapter (id, version, label, access, license, attribution) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
    """)
  static let insertBatch = SQL("ingest.batch.insert", """
    INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, file_sha256, file_name, format,
      mapping_json, options_json, status, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let batchByID = SQL("ingest.batch.id", """
    SELECT id, collection_id, adapter_id, adapter_version, file_sha256, file_name, format, mapping_json, options_json,
      summary_json, status, job_id, created_at, committed_at FROM import_batch WHERE id = ?
    """)
  static let batchCommitted = SQL("ingest.batch.committed",
    "UPDATE import_batch SET status = 'committed', committed_at = ? WHERE id = ?")
  static let batchStatus = SQL("ingest.batch.status", "UPDATE import_batch SET status = ? WHERE id = ?")
  static let originalFile = SQL("ingest.original.get", "SELECT rel_path, byte_size FROM original_file WHERE sha256 = ?")
  static let insertOriginal = SQL("ingest.original.insert", """
    INSERT INTO original_file (sha256, rel_path, source_path, byte_size, encoding, had_bom, stored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING
    """)
  static let metaGet = SQL("ingest.meta.get", "SELECT value FROM meta WHERE key = ?")

  // ── resolving ext ids ──
  static let extInCollection = SQL("ingest.ext.collection", """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL
    """)
  static let aliasInCollection = SQL("ingest.ext.alias", """
    SELECT a.document_id AS id FROM document_alias a JOIN document d ON d.id = a.document_id
    JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND a.ext_id = ? AND d.deleted_at IS NULL
    ORDER BY a.document_id LIMIT 1
    """, scan: .scanOK(reason: "document_alias is keyed by (document_id, ext_id); alias lookups by ext_id scan it, as the reference does"))
  static let extAnywhere = SQL("ingest.ext.anywhere", """
    SELECT id FROM document WHERE ext_id = ? AND deleted_at IS NULL
    UNION SELECT a.document_id FROM document_alias a JOIN document d ON d.id = a.document_id
    WHERE a.ext_id = ? AND d.deleted_at IS NULL LIMIT 2
    """, scan: .scanOK(reason: "resolveExt without a collection (namespaced ids only): the reference's query"))
  static let extMapAliases = SQL("ingest.ext.map.aliases", """
    SELECT a.ext_id, a.document_id AS id FROM document_alias a JOIN document d ON d.id = a.document_id
    WHERE d.collection_id = ? AND d.deleted_at IS NULL
    """, scan: .scanOK(reason: "loads one collection's aliases once per writer (extMap)"))
  static let extMapDocuments = SQL("ingest.ext.map.documents",
    "SELECT ext_id, id FROM document WHERE collection_id = ? AND deleted_at IS NULL")

  // ── the writer ──
  static let insertIssue = SQL("ingest.issue.insert", """
    INSERT INTO import_issue (id, batch_id, severity, code, line, col, field, value_excerpt, message, suggestion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let docInCollection = SQL("ingest.doc.exists", "SELECT 1 FROM document WHERE collection_id = ? AND ext_id = ?")
  static let textShaDup = SQL("ingest.doc.textsha", """
    SELECT id FROM document WHERE text_sha256 = ? AND deleted_at IS NULL AND dup_of IS NULL ORDER BY id LIMIT 1
    """)
  static let liveSignature = SQL("ingest.doc.signature", """
    SELECT m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id
    WHERE m.document_id = ? AND d.collection_id = ? AND d.deleted_at IS NULL
    """)
  static let metaDupRow = SQL("ingest.doc.meta-row", """
    SELECT title, author, y_lo FROM document WHERE id = ? AND collection_id = ? AND deleted_at IS NULL AND has_full_text = 0
    """)
  static let insertDocument = SQL("ingest.doc.insert", """
    INSERT INTO document (id, collection_id, import_batch_id, ext_id, kind, title, native_title, author,
        genre, community, culture, field, lang_declared, lang_text, lang_confidence, is_translation, original_lang,
        has_full_text, lo_day, hi_day, y_lo, y_hi, precision, basis, date_role, chrono_status, date_label, source_url,
        license, source_file_sha256, source_byte_start, source_byte_end, original_meta_json, text_sha256, dup_of,
        token_count, passage_count, prominence, is_synthetic, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?)
    """)
  static let insertText = SQL("ingest.text.insert", """
    INSERT INTO document_text (document_id, original, body_start, body_end, original_sha256, decoder)
    VALUES (?, ?, ?, ?, ?, ?)
    """)
  static let insertField = SQL("ingest.field.insert", "INSERT INTO document_field (document_id, field, value) VALUES (?, ?, ?)")
  static let insertPassage = SQL("ingest.passage.insert", """
    INSERT INTO passage (id, document_id, ord, field, field_class, time_role, unit, quality,
        start_off, end_off, page_no, lang, lang_confidence, token_count, y_lo, y_hi, is_synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertFTS = SQL("ingest.fts.insert", "INSERT INTO passage_fts (rowid, norm) VALUES (?, ?)")
  static let insertDocTokens = SQL("ingest.doctokens.insert",
    "INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages) VALUES (?, ?, ?, ?, ?)")
  static let deleteDocTokens = SQL("ingest.doctokens.delete", "DELETE FROM doc_tokens WHERE document_id = ?")
  static let rewriteDocTokens = SQL("ingest.doctokens.rewrite", """
    INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages)
    SELECT document_id, lang, field_class, SUM(token_count), COUNT(*) FROM passage
    WHERE document_id = ? AND quality = 'ok' GROUP BY lang, field_class
    """)
  static let deleteDocBins = SQL("ingest.docbin.delete", "DELETE FROM doc_bin WHERE document_id = ?")
  static let insertDocBin = SQL("ingest.docbin.insert", "INSERT INTO doc_bin (level, bin, document_id) VALUES (?, ?, ?)")
  static let insertDate = SQL("ingest.date.insert", """
    INSERT INTO date_assertion (id, subject_type, subject_id, role, lo_day, hi_day, lo_year, hi_year,
        precision, basis, approx, raw, rule, asserted_by, is_chronology, note)
      VALUES (?, 'document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertRtree = SQL("ingest.rtree.insert", "INSERT INTO date_rtree (id, lo_day, hi_day) VALUES (?, ?, ?)")
  static let insertAlias = SQL("ingest.alias.insert", """
    INSERT INTO document_alias (document_id, ext_id, title, note) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    """)
  static let deleteAlias = SQL("ingest.alias.delete", "DELETE FROM document_alias WHERE document_id = ? AND ext_id = ?")
  static let insertTag = SQL("ingest.tag.insert", """
    INSERT INTO doc_tag (document_id, scheme, value, weight, provenance, method) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
    """)
  static let insertLabel = SQL("ingest.label.insert", "INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)")
  static let insertMinhash = SQL("ingest.minhash.insert", "INSERT INTO doc_minhash (document_id, sig) VALUES (?, ?)")

  // ── relationships and annotations ──
  static let docYears = SQL("ingest.doc.years", "SELECT y_lo, y_hi, chrono_status FROM document WHERE id = ?")
  static let docSynthetic = SQL("ingest.doc.synthetic", "SELECT is_synthetic FROM document WHERE id = ?")
  static let passageDocument = SQL("ingest.passage.doc", "SELECT document_id FROM passage WHERE id = ?")
  static let passageRow = SQL("ingest.passage.row", "SELECT id, document_id, field FROM passage WHERE id = ?")
  static let occurrenceDocument = SQL("ingest.occurrence.doc", "SELECT document_id FROM occurrence WHERE id = ?")
  static let originalSHA = SQL("ingest.text.sha", "SELECT original_sha256 FROM document_text WHERE document_id = ?")
  static let fieldValue = SQL("ingest.field.value", "SELECT value FROM document_field WHERE document_id = ? AND field = ?")
  static let passageForSpan = SQL("ingest.passage.span", """
    SELECT id FROM passage WHERE document_id = ? AND field = ? AND start_off <= ? AND end_off >= ?
    ORDER BY start_off DESC LIMIT 1
    """)
  static let hypothesisGroup = SQL("ingest.group.find", """
    SELECT id FROM hypothesis_group WHERE target_type = ? AND target_ref = ? AND question = ?
    """, scan: .scanOK(reason: "hypothesis_group is small (one row per question)"))
  static let insertHypothesisGroup = SQL("ingest.group.insert", """
    INSERT INTO hypothesis_group (id, target_type, target_ref, question, created_by, is_synthetic, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """)
  /// The repeat-load check of a relationship (M5 gate): `DUP_RELATIONSHIP_SQL`, verbatim (the unary `+` keeps rel_type
  /// and evidence_status off the rel_kind index, so the planner seeks an endpoint index).
  static let duplicateRelationship = SQL("ingest.rel.duplicate", """
    SELECT id FROM relationship WHERE src_type = ? AND src_ref = ? AND dst_type = ? AND dst_ref = ?
      AND +rel_type = ? AND +evidence_status = ? AND origin = ? AND created_by = ? AND IFNULL(source_dataset, '') = ?
      AND IFNULL(source_locator, '') = ? AND IFNULL(run_id, -1) = ? LIMIT 1
    """)
  static let insertRelationship = SQL("ingest.rel.insert", """
    INSERT INTO relationship (id, rel_type, src_type, src_ref, dst_type, dst_ref, directed,
        evidence_status, origin, source_dataset, source_locator, provenance_quality, method, run_id, created_by, score,
        score_kind, date_conflict, src_year, dst_year, hypothesis_group_id, license, attribution, provenance_note,
        is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertEvidence = SQL("ingest.rel.evidence", """
    INSERT INTO relationship_evidence (id, relationship_id, passage_id, role, start_off, end_off,
      anchor_json, detail_json, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertRevision = SQL("ingest.rel.revision", """
    INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, before_json, after_json, reason)
    VALUES (?, ?, 1, ?, ?, 'create', NULL, ?, NULL)
    """)
  static let duplicateAnnotation = SQL("ingest.ann.duplicate", """
    SELECT a.id FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = 1
    WHERE a.target_type = ? AND a.target_ref = ? AND a.kind = ? AND a.author = ? AND IFNULL(a.layer, '') = ? AND r.body_md = ?
    LIMIT 1
    """)
  static let insertAnnotation = SQL("ingest.ann.insert", """
    INSERT INTO annotation (id, target_type, target_ref, anchor_json, kind, author, is_machine,
        method, run_id, layer, supersedes, status, is_synthetic, current_rev, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?)
    """)
  static let supersede = SQL("ingest.ann.supersede", "UPDATE annotation SET status = 'superseded' WHERE id = ?")
  static let insertAnnotationRevision = SQL("ingest.ann.revision", """
    INSERT INTO annotation_revision (id, annotation_id, rev, body_md, stance, dimensions_json,
        tags_json, evidence_refs_json, reason, author, at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)
    """)
  static let insertAnnotationFTS = SQL("ingest.ann.fts", "INSERT INTO annotation_fts (rowid, body, tags) VALUES (?, ?, ?)")

  // ── rollback of a batch (rollbackBatch) ──
  static let batchDocuments = SQL("ingest.rollback.docs", "SELECT id FROM document WHERE import_batch_id = ?")
  static let passagesOfDocs = SQL("ingest.rollback.passages",
    "SELECT id FROM passage WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteFTSRows = SQL("ingest.rollback.fts", "DELETE FROM passage_fts WHERE rowid IN (SELECT value FROM json_each(?))")
  static let deleteEvidenceOfPassages = SQL("ingest.rollback.evidence",
    "DELETE FROM relationship_evidence WHERE passage_id IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "rollback of a failed batch: relationship_evidence has no passage index, as in the reference"))
  static let deleteClusterMembers = SQL("ingest.rollback.cluster-members", """
    DELETE FROM cluster_member WHERE occurrence_id IN (SELECT id FROM occurrence WHERE passage_id IN (SELECT value FROM json_each(?)))
    """)
  static let deleteOccurrences = SQL("ingest.rollback.occurrences",
    "DELETE FROM occurrence WHERE passage_id IN (SELECT value FROM json_each(?))")
  static let deleteExprDoc = SQL("ingest.rollback.expr-doc",
    "DELETE FROM expr_doc WHERE document_id IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "rollback of a failed batch: expr_doc is keyed by expression, as in the reference"))
  static let deleteRtreeOfDocs = SQL("ingest.rollback.rtree", """
    DELETE FROM date_rtree WHERE id IN (SELECT id FROM date_assertion WHERE (subject_type = 'document' AND subject_id IN
      (SELECT value FROM json_each(?))) OR (subject_type = 'passage' AND subject_id IN (SELECT value FROM json_each(?))))
    """)
  static let deleteDatesOfDocs = SQL("ingest.rollback.dates", """
    DELETE FROM date_assertion WHERE id IN (SELECT id FROM date_assertion WHERE (subject_type = 'document' AND subject_id IN
      (SELECT value FROM json_each(?))) OR (subject_type = 'passage' AND subject_id IN (SELECT value FROM json_each(?))))
    """)
  static let deleteDocBinsOf = SQL("ingest.rollback.doc-bin", "DELETE FROM doc_bin WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteDocTokensOf = SQL("ingest.rollback.doc-tokens",
    "DELETE FROM doc_tokens WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteMinhashOf = SQL("ingest.rollback.minhash",
    "DELETE FROM doc_minhash WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteTagsOf = SQL("ingest.rollback.tags", "DELETE FROM doc_tag WHERE document_id IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "rollback of a failed batch: doc_tag is keyed by document_id first (primary key)"))
  static let deleteAliasesOf = SQL("ingest.rollback.aliases",
    "DELETE FROM document_alias WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteFieldsOf = SQL("ingest.rollback.fields",
    "DELETE FROM document_field WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteTextOf = SQL("ingest.rollback.text",
    "DELETE FROM document_text WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteChunksOf = SQL("ingest.rollback.chunks",
    "DELETE FROM text_chunk WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteStorageOf = SQL("ingest.rollback.storage",
    "DELETE FROM text_storage WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deletePassagesOf = SQL("ingest.rollback.passage-rows",
    "DELETE FROM passage WHERE document_id IN (SELECT value FROM json_each(?))")
  static let deleteLabelsOf = SQL("ingest.rollback.labels", "DELETE FROM label_tri WHERE ref IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "label_tri is an FTS5 table without a ref index; rollback of a failed batch, as in the reference"))
  static let clearDupOf = SQL("ingest.rollback.dup-of", "UPDATE document SET dup_of = NULL WHERE dup_of IN (SELECT value FROM json_each(?))",
    scan: .scanOK(reason: "rollback of a failed batch: no dup_of index, as in the reference"))
  static let deleteDocsOf = SQL("ingest.rollback.documents", "DELETE FROM document WHERE id IN (SELECT value FROM json_each(?))")

  // ── the duplicate index (dup-index.mjs) ──
  static let batchesOfCollection = SQL("ingest.dup.batches", "SELECT id, status FROM import_batch WHERE collection_id = ? ORDER BY id",
    scan: .scanOK(reason: "import_batch is small"))
  static let signatureCount = SQL("ingest.dup.count", """
    SELECT count(*) AS n FROM doc_minhash m JOIN document d ON d.id = m.document_id WHERE d.collection_id = ? AND d.deleted_at IS NULL
    """)
  static let signaturesOfCollection = SQL("ingest.dup.signatures", """
    SELECT m.document_id AS id, m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id
    WHERE d.collection_id = ? AND d.deleted_at IS NULL
    """)
  static let metaKeysOfCollection = SQL("ingest.dup.meta", """
    SELECT id, title, author, y_lo FROM document WHERE collection_id = ? AND deleted_at IS NULL AND has_full_text = 0
    """)
  static let documentsSince = SQL("ingest.dup.since", """
    SELECT id, title, author, y_lo, has_full_text FROM document WHERE collection_id = ? AND id > ? AND deleted_at IS NULL
    """)
  static let signatureOf = SQL("ingest.dup.sig", "SELECT sig FROM doc_minhash WHERE document_id = ?")

  // ── FTS maintenance (ΔS-19: incremental merges, never one 'optimize' on the phone) ──
  static let ftsAutomergeOff = SQL("ingest.fts.automerge-off", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 0)")
  static let ftsAutomergeOn = SQL("ingest.fts.automerge-on", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 4)")
  static let ftsMerge = SQL("ingest.fts.merge", "INSERT INTO passage_fts (passage_fts, rank) VALUES ('merge', ?)")
  static let totalChanges = SQL("ingest.total-changes", "SELECT total_changes()")

  public static let all: [SQL] = [
    corpusBySlug, corpusByID, collectionBySlug, collectionByID, collectionCorpusSlug, insertCollection, adapterVersion,
    insertAdapter, insertBatch, batchByID, batchCommitted, batchStatus, originalFile, insertOriginal, metaGet,
    extInCollection, aliasInCollection, extAnywhere, extMapAliases, extMapDocuments,
    insertIssue, docInCollection, textShaDup, liveSignature, metaDupRow, insertDocument, insertText, insertField,
    insertPassage, insertFTS, insertDocTokens, deleteDocTokens, rewriteDocTokens, deleteDocBins, insertDocBin, insertDate,
    insertRtree, insertAlias, deleteAlias, insertTag, insertLabel, insertMinhash,
    docYears, docSynthetic, passageDocument, passageRow, occurrenceDocument, originalSHA, fieldValue, passageForSpan,
    hypothesisGroup, insertHypothesisGroup, duplicateRelationship, insertRelationship, insertEvidence, insertRevision,
    duplicateAnnotation, insertAnnotation, supersede, insertAnnotationRevision, insertAnnotationFTS,
    batchDocuments, passagesOfDocs, deleteFTSRows, deleteEvidenceOfPassages, deleteClusterMembers, deleteOccurrences,
    deleteExprDoc, deleteRtreeOfDocs, deleteDatesOfDocs, deleteDocBinsOf, deleteDocTokensOf, deleteMinhashOf, deleteTagsOf,
    deleteAliasesOf, deleteFieldsOf, deleteTextOf, deletePassagesOf, deleteLabelsOf, clearDupOf, deleteDocsOf,
    batchesOfCollection, signatureCount, signaturesOfCollection, metaKeysOfCollection, documentsSince, signatureOf,
    ftsAutomergeOff, ftsAutomergeOn, ftsMerge, totalChanges,
  ]

  /// Statements that exist only in the device profile (EXPLAINed against a device atlas).
  public static let deviceOnly: [SQL] = [deleteChunksOf, deleteStorageOf]
}
