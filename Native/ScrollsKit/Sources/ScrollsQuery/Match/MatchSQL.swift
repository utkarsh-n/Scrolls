// OWNER: N3
// Statements of tracked expressions, FTS candidates and materialization (materialize.mjs, fts.mjs, exprdoc.mjs), verbatim
// from the reference. Scoped variants (a corpus, a collection list, both or neither) are separate entries so each one is
// planned by SQLCatalogTests.

import ScrollsStore

/// Statements of ScrollsQuery's matching area.
public enum MatchSQL: SQLCatalog {
  // ── corpora and collections ──
  static let corpusBySlug = SQL("q.corpus.by-slug", "SELECT id, slug, name, is_synthetic, kind FROM corpus WHERE slug = ?")
  static let corpusByID = SQL("q.corpus.by-id", "SELECT id, slug, name, is_synthetic, kind FROM corpus WHERE id = ?")
  static let countedCollectionsAll = SQL("q.collections.counted.all",
    "SELECT id, slug FROM collection WHERE modality <> 'lexical' ORDER BY slug", scan: .scanOK(reason: "collections (tens)"))
  static let countedCollections = SQL("q.collections.counted",
    "SELECT id, slug FROM collection WHERE corpus_id = ? AND modality <> 'lexical' ORDER BY slug",
    scan: .scanOK(reason: "collections (tens)"))

  // ── expressions ──
  static let exprColumns = "id, corpus_id, kind, surface, norm, lang, origin, is_synthetic, meta_json"
  static let exprByID = SQL("q.expr.get", "SELECT \(exprColumns) FROM expression WHERE id = ?")
  static let exprByKey = SQL("q.expr.by-key", """
    SELECT id FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ? AND IFNULL(corpus_id, 0) = ?
    """)
  static let exprInCorpus = SQL("q.expr.in-corpus", """
    SELECT \(exprColumns) FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ? AND corpus_id = ?
    """)
  static let exprLangsInScope = SQL("q.expr.langs-in-scope", """
    SELECT DISTINCT lang FROM expression WHERE kind = ? AND norm = ? AND corpus_id IN (SELECT value FROM json_each(?))
    """, scan: .scanOK(reason: "expression is small (tracked words)"))
  static let insertExpression = SQL("q.expr.insert", """
    INSERT INTO expression (id, corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let insertVariant = SQL("q.variant.insert", """
    INSERT INTO expression_variant (id, expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    """)
  static let variantExists = SQL("q.variant.exists",
    "SELECT 1 FROM expression_variant WHERE expression_id = ? AND IFNULL(lang, '') = ? AND norm = ?")
  static let insertState = SQL("q.state.insert", """
    INSERT INTO expression_state (expression_id, run_id, variants_hash, status, updated_at) VALUES (?, NULL, ?, 'none', ?)
      ON CONFLICT (expression_id) DO NOTHING
    """)
  static let variantsOf = SQL("q.variant.of", """
    SELECT id, expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled FROM expression_variant
    WHERE expression_id = ? ORDER BY CASE variant_type WHEN 'identity' THEN 0 ELSE 1 END, id
    """)
  static let hasTransliteration = SQL("q.variant.has-translit",
    "SELECT 1 FROM expression_variant WHERE expression_id = ? AND variant_type = 'transliteration' LIMIT 1")
  static let setVariantEnabled = SQL("q.variant.set-enabled",
    "UPDATE expression_variant SET enabled = ? WHERE id = ? AND expression_id = ?")
  static let setStateHash = SQL("q.state.set-hash",
    "UPDATE expression_state SET variants_hash = ?, updated_at = ? WHERE expression_id = ?")
  static let setExprMeta = SQL("q.expr.set-meta", "UPDATE expression SET meta_json = ? WHERE id = ?")
  static let freshness = SQL("q.state.freshness", """
    SELECT s.run_id, r.params_hash, r.input_fingerprint FROM expression_state s
      JOIN analysis_run r ON r.id = s.run_id AND r.status = 'succeeded' WHERE s.expression_id = ?
    """)
  static let statePayload = SQL("q.state.payload", """
    SELECT s.run_id, r.metrics_json, r.status AS run_status FROM expression_state s
      LEFT JOIN analysis_run r ON r.id = s.run_id WHERE s.expression_id = ?
    """)
  static let latestMaterializeJob = SQL("q.job.latest-materialize", """
    SELECT id, status FROM job WHERE type = 'materialize' AND json_extract(params_json, '$.expressionId') = ?
      ORDER BY id DESC LIMIT 1
    """, scan: .scanOK(reason: "job has no params index; newest rows first"))
  static let runMetrics = SQL("q.run.metrics", "SELECT metrics_json FROM analysis_run WHERE id = ?")
  static let runParams = SQL("q.run.params", "SELECT params_json, pipeline_version FROM analysis_run WHERE id = ?")
  static let pinnedMaterializeRun = SQL("q.run.pinned-materialize", """
    SELECT 1 FROM analysis_run WHERE id = ? AND stage = 'materialize' AND status = 'succeeded'
      AND json_extract(params_json, '$.expression') = ?
    """)
  static let pinnedAmong = SQL("q.run.pinned-among", """
    SELECT id FROM analysis_run WHERE id IN (SELECT value FROM json_each(?)) AND stage = 'materialize'
      AND status = 'succeeded' AND json_extract(params_json, '$.expression') = ? ORDER BY id DESC LIMIT 1
    """)
  static let claims = SQL("q.expr.claims", """
    SELECT id, subject_id, lo_year, hi_year, precision, approx, raw, rule, note FROM date_assertion
      WHERE subject_type = 'expression' AND subject_id = ? AND role = 'first_attestation_claim' AND asserted_by = 'wiktionary'
      ORDER BY lo_year, id
    """)
  static let collectionBatches = SQL("q.fingerprint.batches", """
    SELECT c.slug, c.id, MAX(b.id) AS batch FROM collection c
      LEFT JOIN import_batch b ON b.collection_id = c.id AND b.status = 'committed' GROUP BY c.id ORDER BY c.slug
    """, scan: .scanOK(reason: "one row per collection (tens)"))

  // ── FTS candidates (fts.mjs): MATCH, then the scope ──
  static let ftsFrom = """
    FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
      JOIN collection c ON c.id = d.collection_id WHERE passage_fts MATCH ? AND d.deleted_at IS NULL
    """
  static func scoped(_ corpus: Bool, _ collections: Bool) -> String {
    (corpus ? " AND c.corpus_id = ?" : "") + (collections ? " AND c.id IN (SELECT value FROM json_each(?))" : "")
  }
  static let candidates: [SQL] = [(false, false), (true, false), (false, true), (true, true)].map { s in
    SQL("q.fts.candidates.\(s.0 ? "k" : "-")\(s.1 ? "c" : "-")", "SELECT p.id \(ftsFrom)\(scoped(s.0, s.1))")
  }
  static let samples: [SQL] = [(false, false), (true, false), (false, true), (true, true)].map { s in
    SQL("q.fts.sample.\(s.0 ? "k" : "-")\(s.1 ? "c" : "-")", "SELECT p.id, p.lang \(ftsFrom)\(scoped(s.0, s.1)) LIMIT ?")
  }
  static let hitCounts: [SQL] = [(false, false), (true, false), (false, true), (true, true)].map { s in
    SQL("q.fts.hits.\(s.0 ? "k" : "-")\(s.1 ? "c" : "-")", """
      SELECT count(*) AS passages, count(DISTINCT p.document_id) AS documents,
        count(DISTINCT CASE WHEN d.chrono_status = 'undated' THEN d.id END) AS undated \(ftsFrom)\(scoped(s.0, s.1))
      """)
  }
  /// Index: corpus (bit 0), collections (bit 1).
  static func scopeIndex(corpus: Bool, collections: Bool) -> Int { (corpus ? 1 : 0) + (collections ? 2 : 0) }

  static let candidateColumns = """
    p.id, p.document_id, p.field, p.field_class, p.time_role, p.quality, p.start_off, p.end_off, p.lang, p.token_count
    """
  static let passageRows = SQL("q.fts.passage-rows", """
    SELECT \(candidateColumns), d.author, d.is_synthetic, d.y_lo, d.chrono_status, c.corpus_id, d.collection_id
      FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
      WHERE p.id IN (SELECT value FROM json_each(?)) ORDER BY p.document_id, p.field, p.start_off
    """)
  static let termCounts = SQL("q.fts.term-counts",
    "SELECT doc AS passage, count(*) AS n FROM passage_vocab_inst WHERE term = ? GROUP BY doc")
  static let termRow = SQL("q.fts.term-row", "SELECT cnt FROM passage_vocab_row WHERE term = ?")

  // ── maker names (the title rule) ──
  static let makerAuthors = SQL("q.names.authors", """
    SELECT DISTINCT d.author AS n FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE d.author IS NOT NULL AND c.rate_eligible = 1 AND c.corpus_id = ?
    """, scan: .scanOK(reason: "the maker-name artifact, built once per inputs of the corpus"))
  static let makerTags = SQL("q.names.tags", """
    SELECT DISTINCT t.value AS n FROM doc_tag t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'maker' AND c.rate_eligible = 1 AND c.corpus_id = ?
    """, scan: .scanOK(reason: "the maker-name artifact, built once per inputs of the corpus"))
  static let makerAuthorsAll = SQL("q.names.authors.all", """
    SELECT DISTINCT d.author AS n FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE d.author IS NOT NULL AND c.rate_eligible = 1
    """, scan: .scanOK(reason: "the maker-name artifact of expressions without a corpus"))
  static let makerTagsAll = SQL("q.names.tags.all", """
    SELECT DISTINCT t.value AS n FROM doc_tag t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'maker' AND c.rate_eligible = 1
    """, scan: .scanOK(reason: "the maker-name artifact of expressions without a corpus"))

  // ── materialization writes ──
  static let insertOccurrence = SQL("q.occ.insert", """
    INSERT INTO occurrence (id, expression_id, variant_id, passage_id, document_id, start_off, end_off, tok_index, name_flag,
      sampled, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  static let deleteRunOccurrences = SQL("q.occ.delete-run", "DELETE FROM occurrence WHERE run_id = ?",
    scan: .scanOK(reason: "occurrence(run_id) has no index of its own; once per very frequent run"))
  static let flagOccurrence = SQL("q.occ.flag-name", "UPDATE occurrence SET name_flag = 1 WHERE id = ?")
  static let upsertExprDoc = SQL("q.exprdoc.upsert", """
    INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_names, n_passages, first_off, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (expression_id, run_id, document_id, plang, field_class) DO UPDATE SET n = n + excluded.n,
        n_names = n_names + excluded.n_names, n_passages = n_passages + excluded.n_passages,
        first_off = MIN(IFNULL(first_off, excluded.first_off), IFNULL(excluded.first_off, first_off))
    """)
  static let nameRuleExprDoc = SQL("q.exprdoc.name-rule", """
    UPDATE expr_doc SET n = n - ?1, n_names = n_names + ?1, n_passages = CASE WHEN n - ?1 <= 0 THEN 0 ELSE n_passages END
      WHERE expression_id = ?2 AND run_id = ?3 AND document_id = ?4 AND plang = ?5 AND field_class = 'text'
    """)
  static let upsertStateReady = SQL("q.state.ready", """
    INSERT INTO expression_state (expression_id, run_id, variants_hash, status, occ_total, docs_total, sampled,
        names_excluded, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?)
      ON CONFLICT (expression_id) DO UPDATE SET run_id = excluded.run_id, variants_hash = excluded.variants_hash,
        status = 'ready', occ_total = excluded.occ_total, docs_total = excluded.docs_total, sampled = excluded.sampled,
        names_excluded = excluded.names_excluded, updated_at = excluded.updated_at
    """)
  static let runState = SQL("q.run.state", "SELECT metrics_json, status FROM analysis_run WHERE id = ?")

  // ── text ──
  static let vocabRange = SQL("q.translit.vocab-range", "SELECT term, doc FROM passage_vocab_row WHERE term >= ? AND term < ?",
    scan: .scanOK(reason: "fts5vocab range scan of one initial, cached per vocabulary state"))
  static let vocabBatches = SQL("q.translit.batches", """
    SELECT b.status, count(*) AS n, max(b.id) AS m FROM import_batch b JOIN collection c ON c.id = b.collection_id
      WHERE c.modality <> 'lexical' GROUP BY b.status ORDER BY b.status
    """, scan: .scanOK(reason: "import batches (hundreds)"))

  public static let all: [SQL] = [
    corpusBySlug, corpusByID, countedCollectionsAll, countedCollections, exprByID, exprByKey, exprInCorpus, exprLangsInScope,
    insertExpression, insertVariant, variantExists, insertState, variantsOf, hasTransliteration, setVariantEnabled,
    setStateHash, setExprMeta, freshness, statePayload, latestMaterializeJob, runMetrics, runParams, pinnedMaterializeRun,
    pinnedAmong, claims, collectionBatches, passageRows, termCounts, termRow, makerAuthors, makerTags, makerAuthorsAll,
    makerTagsAll, insertOccurrence, deleteRunOccurrences, flagOccurrence, upsertExprDoc, nameRuleExprDoc, upsertStateReady,
    runState, vocabRange, vocabBatches,
  ] + candidates + samples + hitCounts
}

/// The text area's statements (field values; the vocabulary scans live in MatchSQL).
enum TextSQL {
  static let vocabRange = MatchSQL.vocabRange
  static let vocabBatches = MatchSQL.vocabBatches
}
