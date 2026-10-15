// OWNER: N2
// The statements of the bootstrap and source-load pipelines (bootstrap-cipher.mjs): installed packs, the A2 evidence
// merge, and the §6.8 reconciliation counts.

import ScrollsStore

/// Pipeline SQL.
public enum PipelineSQL: SQLCatalog {
  // installed packs (DP-3)
  public static let insertPackInstall = SQL("pipe.insertPackInstall", """
    INSERT INTO pack_install (pack_sha256, name, version, slot, member_count, journal_seq, installed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pack_sha256) DO NOTHING
    """)
  public static let packInstalls = SQL("pipe.packInstalls",
                                       "SELECT pack_sha256, name, version, slot, member_count, journal_seq, installed_at FROM pack_install ORDER BY installed_at, name",
                                       scan: .scanOK(reason: "a handful of packs"))

  // A2: a raw relation record restating a culture-works sibling → an external_record evidence row
  public static let docByExt = SQL("pipe.docByExt", """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ?
    """)
  public static let relationshipOf = SQL("pipe.relationshipOf", """
    SELECT id, current_rev FROM relationship WHERE rel_type = ? AND src_type = 'document' AND src_ref = ?
      AND dst_type = 'document' AND dst_ref = ? AND source_dataset = ? ORDER BY id LIMIT 1
    """)
  public static let evidenceSeen = SQL("pipe.evidenceSeen", """
    SELECT 1 FROM relationship_evidence WHERE relationship_id = ? AND role = 'external_record' AND detail_json = ?
    """)
  public static let insertEvidence = SQL("pipe.insertEvidence", """
    INSERT INTO relationship_evidence (id, relationship_id, passage_id, role, start_off, end_off, anchor_json, detail_json,
      added_by, added_at) VALUES (?, ?, NULL, 'external_record', NULL, NULL, NULL, ?, ?, ?)
    """)
  public static let insertRevision = SQL("pipe.insertRevision", """
    INSERT INTO relationship_revision (id, relationship_id, rev, actor, at, action, before_json, after_json, reason)
    VALUES (?, ?, ?, ?, ?, 'add_evidence', NULL, ?, ?)
    """)
  public static let bumpRev = SQL("pipe.bumpRev", "UPDATE relationship SET current_rev = ? WHERE id = ?")

  // §6.8 reconciliation
  public static let docCount = SQL("pipe.docCount", "SELECT count(*) FROM document WHERE collection_id = ? AND deleted_at IS NULL")
  public static let docChrono = SQL("pipe.docChrono",
                                    "SELECT count(*) FROM document WHERE collection_id = ? AND chrono_status = ?")
  public static let glosses = SQL("pipe.glosses", """
    SELECT count(*) FROM annotation a JOIN document d ON a.target_type = 'document' AND d.id = CAST(a.target_ref AS INTEGER)
    WHERE d.collection_id = ? AND a.kind = 'machine_gloss'
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let siblingsByTypeStatus = SQL("pipe.siblingsByTypeStatus", """
    SELECT r.rel_type, r.evidence_status, count(*) FROM relationship r
      JOIN document d ON r.src_type = 'document' AND d.id = CAST(r.src_ref AS INTEGER)
    WHERE d.collection_id = ? AND r.created_by = ? GROUP BY r.rel_type, r.evidence_status
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let siblingsWith = SQL("pipe.siblingsWith", """
    SELECT sum(r.provenance_quality = 'source_unrecorded'), sum(r.source_locator IS NOT NULL), sum(r.date_conflict = 1)
    FROM relationship r JOIN document d ON r.src_type = 'document' AND d.id = CAST(r.src_ref AS INTEGER)
    WHERE d.collection_id = ? AND r.created_by = ?
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let aliasCount = SQL("pipe.aliasCount", """
    SELECT count(*) FROM document_alias a JOIN document d ON d.id = a.document_id WHERE d.collection_id = ?
    """, scan: .scanOK(reason: "reconciliation"))
  public static let relationEndpointAliases = SQL("pipe.relationEndpointAliases", """
    SELECT count(*) FROM document_alias a JOIN document d ON d.id = a.document_id
    WHERE d.collection_id = ? AND a.note LIKE 'relation endpoint%'
    """, scan: .scanOK(reason: "reconciliation"))
  public static let translations = SQL("pipe.translations", """
    SELECT lang_declared, count(*) FROM document WHERE collection_id = ? AND is_translation = 1 GROUP BY lang_declared
    """, scan: .scanOK(reason: "reconciliation"))
  public static let byBasis = SQL("pipe.byBasis", "SELECT basis, count(*) FROM document WHERE collection_id = ? GROUP BY basis",
                                  scan: .scanOK(reason: "reconciliation"))
  public static let lifetimeEstimates = SQL("pipe.lifetimeEstimates", """
    SELECT count(*) FROM date_assertion a JOIN document d ON a.subject_type = 'document' AND a.subject_id = d.id
    WHERE d.collection_id = ? AND a.rule = 'cipher_lifetime_year'
    """, scan: .scanOK(reason: "reconciliation"))
  public static let passagesByQuality = SQL("pipe.passagesByQuality", """
    SELECT p.quality, count(*) FROM passage p JOIN document d ON d.id = p.document_id WHERE d.collection_id = ? GROUP BY p.quality
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let passagesByTimeRole = SQL("pipe.passagesByTimeRole", """
    SELECT count(*) FROM passage p JOIN document d ON d.id = p.document_id WHERE d.collection_id = ? AND p.time_role = ?
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let canaryOK = SQL("pipe.canaryOK", """
    SELECT count(*) FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
    WHERE passage_fts MATCH ? AND d.collection_id = ? AND p.quality = 'ok'
    """)
  public static let textTokens = SQL("pipe.textTokens", """
    SELECT COALESCE(SUM(t.tokens), 0) FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE d.collection_id = ? AND t.field_class = 'text'
    """, scan: .scanOK(reason: "reconciliation"))
  public static let relationsByQuality = SQL("pipe.relationsByQuality", """
    SELECT rel_type, provenance_quality, count(*) FROM relationship WHERE created_by = ? GROUP BY rel_type, provenance_quality
    """, scan: .scanOK(reason: "reconciliation, once per bootstrap phase"))
  public static let relationsNonDocumented = SQL("pipe.relationsNonDocumented", """
    SELECT sum(evidence_status <> 'documented'), sum(date_conflict = 1) FROM relationship WHERE created_by = ?
    """, scan: .scanOK(reason: "reconciliation"))
  public static let evidenceAddedBy = SQL("pipe.evidenceAddedBy", "SELECT count(*) FROM relationship_evidence WHERE added_by = ?",
                                          scan: .scanOK(reason: "reconciliation"))
  public static let etymonCount = SQL("pipe.etymonCount", "SELECT count(*) FROM etymon", scan: .scanOK(reason: "reconciliation"))
  public static let etymonBySemantics = SQL("pipe.etymonBySemantics",
                                            "SELECT parent_semantics, count(*) FROM etymon GROUP BY parent_semantics",
                                            scan: .scanOK(reason: "reconciliation"))
  public static let etymonMembers = SQL("pipe.etymonMembers", "SELECT count(*) FROM etymon_member", scan: .scanOK(reason: "reconciliation"))
  public static let themeAssocs = SQL("pipe.themeAssocs", "SELECT count(*) FROM theme_assoc", scan: .scanOK(reason: "reconciliation"))

  public static let all: [SQL] = [
    insertPackInstall, packInstalls, docByExt, relationshipOf, evidenceSeen, insertEvidence, insertRevision, bumpRev, docCount,
    docChrono, glosses, siblingsByTypeStatus, siblingsWith, aliasCount, relationEndpointAliases, translations, byBasis,
    lifetimeEstimates, passagesByQuality, passagesByTimeRole, canaryOK, textTokens, relationsByQuality, relationsNonDocumented,
    evidenceAddedBy, etymonCount, etymonBySemantics, etymonMembers, themeAssocs,
  ]
}
