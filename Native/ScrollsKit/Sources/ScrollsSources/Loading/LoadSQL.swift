// OWNER: N2
// The statements of source loads (adapter-load.mjs, bootstrap-cipher.mjs, document-writer.mjs's collection and batch
// helpers): source_adapter rows, collections, import batches, pack originals, the etymon tables, theme associations,
// typeahead labels, terciles and the load state kept in meta.

import ScrollsStore

/// Source-load SQL.
public enum LoadSQL: SQLCatalog {
  public static let upsertAdapter = SQL("load.upsertAdapter", """
    INSERT INTO source_adapter (id, version, label, access, enabled, license, attribution) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, label = excluded.label, access = excluded.access,
      license = excluded.license, attribution = excluded.attribution
    """)
  public static let adapterRow = SQL("load.adapterRow", "SELECT enabled, approved_at, config_json FROM source_adapter WHERE id = ?")
  public static let setAdapterEnabled = SQL("load.setAdapterEnabled", "UPDATE source_adapter SET enabled = ?, approved_at = ? WHERE id = ?")
  public static let corpusBySlug = SQL("load.corpusBySlug", "SELECT id, is_synthetic FROM corpus WHERE slug = ?")
  public static let collectionBySlug = SQL("load.collectionBySlug",
                                           "SELECT id, corpus_id, is_synthetic, adapter_id FROM collection WHERE slug = ?")
  public static let insertCollection = SQL("load.insertCollection", """
    INSERT INTO collection (id, corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, rate_eligible,
      coverage_gate, export_text_allowed, is_synthetic, license, attribution, selection_note, caveats_json, source_uri,
      retrieved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """)
  public static let updateCollectionCaveats = SQL("load.updateCollectionCaveats",
                                                  "UPDATE collection SET caveats_json = ?, retrieved_at = ? WHERE id = ?")
  public static let insertBatch = SQL("load.insertBatch", """
    INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, file_sha256, file_name, format, mapping_json,
      options_json, status, job_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'adapter', '{}', ?, 'committing', ?, ?)
    """)
  public static let setBatchStatus = SQL("load.setBatchStatus", "UPDATE import_batch SET status = ? WHERE id = ?")
  public static let insertOriginal = SQL("load.insertOriginal", """
    INSERT INTO original_file (sha256, rel_path, source_path, byte_size, encoding, had_bom, stored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING
    """)
  public static let loadedExtIds = SQL("load.loadedExtIds", """
    SELECT d.ext_id FROM document d JOIN import_batch b ON b.id = d.import_batch_id
    WHERE d.collection_id = ? AND b.status = 'committed' AND d.deleted_at IS NULL
    """)
  public static let documentCount = SQL("load.documentCount",
                                        "SELECT count(*) FROM document WHERE collection_id = ? AND deleted_at IS NULL")
  public static let insertEtymon = SQL("load.insertEtymon", """
    INSERT INTO etymon (key, kind, lang, form, roman, gloss, parent_semantics) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
    """)
  public static let insertEtymonParent = SQL("load.insertEtymonParent",
                                             "INSERT INTO etymon_parent (key, parent_key, ord) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
  public static let insertEtymonMember = SQL("load.insertEtymonMember",
                                             "INSERT INTO etymon_member (key, lang, word, norm, rank) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
  public static let insertLabel = SQL("load.insertLabel", "INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)")
  public static let anyThemeAssoc = SQL("load.anyThemeAssoc", "SELECT 1 FROM theme_assoc LIMIT 1", scan: .scanOK(reason: "LIMIT 1 probe"))
  public static let upsertThemeAssoc = SQL("load.upsertThemeAssoc", """
    INSERT INTO theme_assoc (theme, other, npmi) VALUES (?, ?, ?) ON CONFLICT(theme, other) DO UPDATE SET npmi = excluded.npmi
    """)
  public static let terciles = SQL("load.terciles", """
    UPDATE document SET prominence_tercile = x.t FROM (SELECT id, NTILE(3) OVER (PARTITION BY kind ORDER BY prominence) AS t
      FROM document WHERE collection_id = ? AND prominence IS NOT NULL AND deleted_at IS NULL) AS x WHERE x.id = document.id
    """, scan: .scanOK(reason: "one collection's documents, once per load"))
  public static let metaLike = SQL("load.metaLike", "SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key",
                                   scan: .scanOK(reason: "meta is a few hundred rows"))

  public static let all: [SQL] = [
    upsertAdapter, adapterRow, setAdapterEnabled, corpusBySlug, collectionBySlug, insertCollection, updateCollectionCaveats,
    insertBatch, setBatchStatus, insertOriginal, loadedExtIds, documentCount, insertEtymon, insertEtymonParent,
    insertEtymonMember, insertLabel, anyThemeAssoc, upsertThemeAssoc, terciles, metaLike,
  ]
}
