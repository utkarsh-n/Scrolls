-- OWNER: WP0 — SPEC §3 DDL verbatim, with one correction: both FTS5 tables use the tokenizer of §0.1/§4.3/
-- src/shared/tokenize.mjs FTS_TOKENIZE ('L* N* Co M* So'); the §3 listing omitted 'So', which drops ◉ and emoji
-- and shifts token positions, breaking JS-token ↔ FTS-instance parity.
-- server/db/schema.sql — Scrolls schema_version 1 (executed verbatim by tests/db.schema.test.mjs)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- keys: schema_version='1', data_version (decimal; bumped by every committed write job),
--       tokenizer_version='u61m-1', segmenter_version='seg-1', icu_version, created_at

-- ════════════ 1. Provenance spine ════════════
CREATE TABLE corpus (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,                 -- 'demo' | 'cipher' | 'stemm' | 'user'
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('real','synthetic','user')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  description TEXT, license TEXT, created_at TEXT NOT NULL,
  CHECK ((kind = 'synthetic') = (is_synthetic = 1))
) STRICT;

CREATE TABLE source_adapter (
  id TEXT PRIMARY KEY,                       -- 'cipher.books','stemm.openalex','file.csv','demo'
  version TEXT NOT NULL, label TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('local-file','local-dataset','network')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  approved_at TEXT,                          -- explicit user opt-in time (network only)
  license TEXT, attribution TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  CHECK (access <> 'network' OR enabled = 0 OR approved_at IS NOT NULL)
) STRICT;

CREATE TABLE collection (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER NOT NULL REFERENCES corpus(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('literature','culture','stemm','etymology','imported','demo')),
  modality TEXT NOT NULL CHECK (modality IN ('text','titles','abstracts','lexical','baseline')),
  unit TEXT NOT NULL CHECK (unit IN ('tokens','works','entries','none')),   -- rate denominator
  sampling TEXT NOT NULL CHECK (sampling IN ('complete','prominence_selected','top_cited_per_cell',
                                             'relation_endpoints','curated','user')),
  rate_eligible INTEGER NOT NULL DEFAULT 1 CHECK (rate_eligible IN (0,1)),
  coverage_gate INTEGER,                     -- NULL = unit default (50,000 tokens · 30 works · 20 sampled works); demo 2,000
  export_text_allowed INTEGER NOT NULL DEFAULT 1 CHECK (export_text_allowed IN (0,1)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  license TEXT, attribution TEXT,
  selection_note TEXT,                       -- e.g. 'chosen by Wikipedia sitelinks (prominence)'
  caveats_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(caveats_json)),   -- copied from MANIFEST.json
  source_uri TEXT, retrieved_at TEXT, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE original_file (
  sha256 TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,                    -- originals/ab/<sha256>
  source_path TEXT,                          -- where it was read from (informational)
  byte_size INTEGER NOT NULL, encoding TEXT NOT NULL,
  had_bom INTEGER NOT NULL DEFAULT 0, stored_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collection(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  adapter_version TEXT NOT NULL,
  file_sha256 TEXT REFERENCES original_file(sha256),
  file_name TEXT,
  format TEXT NOT NULL CHECK (format IN ('txt','md','csv','tsv','json','jsonl','adapter')),
  mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json)),
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  status TEXT NOT NULL CHECK (status IN ('uploaded','previewed','validated','committing','committed',
                                         'failed','cancelled','reverted')),
  job_id INTEGER, created_at TEXT NOT NULL, committed_at TEXT
) STRICT;
CREATE UNIQUE INDEX import_once ON import_batch(collection_id, file_sha256) WHERE status = 'committed';

CREATE TABLE import_issue (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','rejected','fatal')),
  code TEXT NOT NULL,                        -- vocab.ISSUE_CODES
  line INTEGER, col INTEGER, field TEXT, value_excerpt TEXT,
  message TEXT NOT NULL, suggestion TEXT NOT NULL
) STRICT;
CREATE INDEX import_issue_batch ON import_issue(batch_id, severity);

-- ════════════ 2. Documents & text ════════════
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collection(id),
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  ext_id TEXT NOT NULL,                      -- 'pg:1342','cw:4948','W2945914100','ws-hi:12','mb:<uuid>'
  kind TEXT NOT NULL,                        -- vocab.DOC_KINDS
  title TEXT, native_title TEXT, author TEXT,
  genre TEXT, community TEXT, culture TEXT, field TEXT,
  lang_declared TEXT, lang_text TEXT, lang_confidence REAL,
  is_translation INTEGER NOT NULL DEFAULT 0 CHECK (is_translation IN (0,1)),
  original_lang TEXT,
  has_full_text INTEGER NOT NULL DEFAULT 0 CHECK (has_full_text IN (0,1)),
  -- chronology, denormalized from the date_assertion with is_chronology = 1
  lo_day INTEGER, hi_day INTEGER, y_lo INTEGER, y_hi INTEGER,
  precision TEXT NOT NULL DEFAULT 'unknown', basis TEXT NOT NULL DEFAULT 'unknown', date_role TEXT,
  chrono_status TEXT NOT NULL CHECK (chrono_status IN ('dated','undated','scheduled')),
  date_label TEXT NOT NULL DEFAULT 'undated',
  source_url TEXT, license TEXT,
  source_file_sha256 TEXT REFERENCES original_file(sha256),
  source_byte_start INTEGER, source_byte_end INTEGER,
  original_meta_json TEXT NOT NULL CHECK (json_valid(original_meta_json)),  -- verbatim record
  text_sha256 TEXT, dup_of INTEGER REFERENCES document(id),
  token_count INTEGER NOT NULL DEFAULT 0, passage_count INTEGER NOT NULL DEFAULT 0,
  prominence REAL,                           -- source-specific; NEVER an evidence weight
  prominence_tercile INTEGER CHECK (prominence_tercile IS NULL OR prominence_tercile IN (1,2,3)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL, deleted_at TEXT, -- soft delete only
  UNIQUE (collection_id, ext_id),
  CHECK ((chrono_status = 'undated') = (lo_day IS NULL)),
  CHECK (lo_day IS NULL OR (hi_day IS NOT NULL AND lo_day <= hi_day))
) STRICT;
CREATE INDEX doc_time    ON document(y_lo, y_hi) WHERE deleted_at IS NULL;
CREATE INDEX doc_facets  ON document(collection_id, kind, lang_text, culture);
CREATE INDEX doc_textsha ON document(text_sha256);
CREATE INDEX doc_batch   ON document(import_batch_id);

CREATE TABLE document_text (                -- full text: decoded original, never normalized
  document_id INTEGER PRIMARY KEY REFERENCES document(id),
  original TEXT NOT NULL,
  body_start INTEGER NOT NULL, body_end INTEGER NOT NULL,   -- UTF-16 units (e.g. inside Gutenberg markers)
  original_sha256 TEXT NOT NULL,             -- sha256 of `original` (UTF-8 bytes): annotation anchor key
  decoder TEXT NOT NULL                      -- 'utf-8' | 'windows-1252' | 'pages-joined-ff'
) STRICT;

CREATE TABLE document_field (               -- short text fields of metadata documents (verbatim)
  document_id INTEGER NOT NULL REFERENCES document(id),
  field TEXT NOT NULL CHECK (field IN ('title','native_title','summary','abstract','gloss','entry')),
  value TEXT NOT NULL,
  PRIMARY KEY (document_id, field)
) STRICT, WITHOUT ROWID;

CREATE TABLE document_alias (
  document_id INTEGER NOT NULL REFERENCES document(id),
  ext_id TEXT NOT NULL, title TEXT, note TEXT,
  PRIMARY KEY (document_id, ext_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE doc_tag (                       -- catalogue / machine tags: NOT document text
  document_id INTEGER NOT NULL REFERENCES document(id),
  scheme TEXT NOT NULL CHECK (scheme IN ('theme','motif','mood','canon','locc','subject','field',
                                         'subfield','topic','keyword','maker')),
  value TEXT NOT NULL, weight REAL,
  provenance TEXT NOT NULL CHECK (provenance IN ('documented_category','machine_tag','genre_heuristic',
                                                 'catalog','adapter_machine')),
  method TEXT NOT NULL,
  run_id INTEGER REFERENCES analysis_run(id),
  PRIMARY KEY (document_id, scheme, value, provenance)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_tag_value ON doc_tag(scheme, value, provenance);

CREATE TABLE doc_minhash (document_id INTEGER PRIMARY KEY REFERENCES document(id), sig BLOB NOT NULL) STRICT;

-- ════════════ 3. Time ════════════
CREATE TABLE date_assertion (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','passage','expression','relationship')),
  subject_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('publication','creation','original_publication','publication_unspecified',
        'edition','release','recording','performance','referenced','authored_description','translation',
        'ingestion','language_period','first_attestation_claim','digitized')),
  lo_day INTEGER, hi_day INTEGER, lo_year INTEGER, hi_year INTEGER,
  precision TEXT NOT NULL CHECK (precision IN ('day','month','year','decade','century','millennium',
                                                'range','period','unknown')),
  basis TEXT NOT NULL CHECK (basis IN ('stated','estimated','derived','period','announced','unknown')),
  approx INTEGER NOT NULL DEFAULT 0 CHECK (approx IN (0,1)),      -- 'circa' qualifier
  raw TEXT, rule TEXT,                       -- verbatim input; grammar rule id
  asserted_by TEXT NOT NULL,                 -- 'adapter:cipher.books@1' | 'human:utkarsh' | 'import:17'
  is_chronology INTEGER NOT NULL DEFAULT 0 CHECK (is_chronology IN (0,1)),
  note TEXT,
  CHECK ((precision = 'unknown') = (lo_day IS NULL)),
  CHECK (lo_day IS NULL OR (hi_day IS NOT NULL AND lo_day <= hi_day))
) STRICT;
CREATE INDEX date_subject ON date_assertion(subject_type, subject_id, role);
CREATE UNIQUE INDEX one_chronology ON date_assertion(subject_type, subject_id) WHERE is_chronology = 1;
CREATE VIRTUAL TABLE date_rtree USING rtree_i32(id, lo_day, hi_day);   -- dated assertions only

CREATE TABLE language_period (
  lang TEXT PRIMARY KEY, label TEXT NOT NULL,
  lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  core_lo INTEGER, core_hi INTEGER, fuzz_years INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, note TEXT NOT NULL
) STRICT;

-- precision-aware bin membership: a document appears at level L only if its interval fits ONE bin
CREATE TABLE doc_bin (
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),   -- 0 millennium, 1 century, 2 decade, 3 year
  bin INTEGER NOT NULL,                                    -- floor(year / width)
  document_id INTEGER NOT NULL REFERENCES document(id),
  PRIMARY KEY (level, bin, document_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_bin_doc ON doc_bin(document_id);

CREATE TABLE doc_tokens (                    -- denominators: quality='ok' tokens per document × passage language × class
  document_id INTEGER NOT NULL REFERENCES document(id),
  plang TEXT NOT NULL,
  field_class TEXT NOT NULL CHECK (field_class IN ('text','title','abstract','describes','apparatus')),
  tokens INTEGER NOT NULL, passages INTEGER NOT NULL,
  PRIMARY KEY (document_id, plang, field_class)
) STRICT, WITHOUT ROWID;

-- ════════════ 4. Passages & search ════════════
CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  ord INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('body','title','native_title','summary','abstract','gloss','entry')),
  field_class TEXT NOT NULL CHECK (field_class IN ('text','title','abstract','describes','apparatus')),
  time_role TEXT NOT NULL CHECK (time_role IN ('document','describes','apparatus')),
  unit TEXT NOT NULL CHECK (unit IN ('paragraph','stanza','sentence_group','page_paragraph','field')),
  quality TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','furniture','boilerplate','front_matter','low','gappy')),
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,  -- UTF-16 units into document_text.original (body)
                                                         -- or into document_field.value (other fields)
  page_no INTEGER,
  lang TEXT NOT NULL DEFAULT 'und', lang_confidence REAL,
  token_count INTEGER NOT NULL,
  y_lo INTEGER, y_hi INTEGER,                -- denormalized from document
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  UNIQUE (document_id, field, ord),
  CHECK (start_off <= end_off)
) STRICT;
CREATE INDEX passage_doc  ON passage(document_id, field, start_off);
CREATE INDEX passage_time ON passage(y_lo, lang, field_class);

-- contentless FTS over the JS-folded token string (tokens joined by ' '); rowid = passage.id
CREATE VIRTUAL TABLE passage_fts USING fts5(norm, content='', contentless_delete=1, detail=full,
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M* So'");
CREATE VIRTUAL TABLE passage_vocab_row  USING fts5vocab(passage_fts, row);
CREATE VIRTUAL TABLE passage_vocab_inst USING fts5vocab(passage_fts, instance);

-- typeahead / substring over short labels only (titles, makers, expression surfaces, etymon forms, themes)
CREATE VIRTUAL TABLE label_tri USING fts5(label, kind UNINDEXED, ref UNINDEXED,
  tokenize="trigram remove_diacritics 1");

-- ════════════ 5. Expressions, occurrences, aggregation base ════════════
CREATE TABLE expression (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER REFERENCES corpus(id),   -- NULL = any corpus
  kind TEXT NOT NULL CHECK (kind IN ('word','phrase','quotation','symbol','motif','theme')),
  surface TEXT NOT NULL, norm TEXT NOT NULL, -- norm = folded tokens joined by ' '
  lang TEXT,                                 -- NULL = any language
  origin TEXT NOT NULL CHECK (origin IN ('user_query','demo','stemm_seed','import','tour')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX expr_key ON expression(kind, IFNULL(lang,''), norm, IFNULL(corpus_id,0));

CREATE TABLE expression_variant (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  form TEXT NOT NULL, norm TEXT NOT NULL, lang TEXT,
  variant_type TEXT NOT NULL CHECK (variant_type IN ('identity','inflection','spelling','hyphenation',
                 'transliteration','translation','descendant','user')),
  rule TEXT NOT NULL,                        -- 'identity' | 'en-inflect@1' | 'hi-oblique@1' | 'nukta-fold@1' | 'roots.tsv' | 'user'
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','computed','proposed')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
) STRICT;
-- fix of the proposal DDL: expressions are not allowed inside UNIQUE constraints, so this is an index
CREATE UNIQUE INDEX variant_key ON expression_variant(expression_id, IFNULL(lang,''), norm);

CREATE TABLE expression_state (
  expression_id INTEGER PRIMARY KEY REFERENCES expression(id),
  run_id INTEGER REFERENCES analysis_run(id),           -- materialize run behind current rows
  variants_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('none','previewing','materializing','ready','failed')),
  occ_total INTEGER, docs_total INTEGER,
  sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0,1)),
  names_excluded INTEGER NOT NULL DEFAULT 0,            -- proper_noun_guard exclusions
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE occurrence (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  variant_id INTEGER REFERENCES expression_variant(id),
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  document_id INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL, -- same coordinate base as the passage
  tok_index INTEGER NOT NULL,
  name_flag INTEGER NOT NULL DEFAULT 0 CHECK (name_flag IN (0,1)),   -- proper_noun_guard hit (excluded by default)
  sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0,1)),
  run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  UNIQUE (run_id, passage_id, start_off, expression_id)
) STRICT;
CREATE INDEX occ_expr    ON occurrence(expression_id, run_id, document_id);
CREATE INDEX occ_passage ON occurrence(passage_id);

-- THE aggregation base: exact counts per expression × document × passage language × field class
CREATE TABLE expr_doc (
  expression_id INTEGER NOT NULL, document_id INTEGER NOT NULL,
  plang TEXT NOT NULL, field_class TEXT NOT NULL,
  n INTEGER NOT NULL, n_names INTEGER NOT NULL DEFAULT 0, n_passages INTEGER NOT NULL,
  first_off INTEGER, run_id INTEGER NOT NULL,
  PRIMARY KEY (expression_id, run_id, document_id, plang, field_class)
) STRICT, WITHOUT ROWID;

-- ════════════ 6. Etymology (deep time; roots.tsv) ════════════
CREATE TABLE etymon (
  key TEXT PRIMARY KEY,                      -- 'grc:γενεσις', 'ine-pro:*genh₁-', 'sa:शून्य'
  kind TEXT NOT NULL CHECK (kind IN ('etymon','root')),
  lang TEXT NOT NULL, form TEXT NOT NULL, roman TEXT, gloss TEXT,
  parent_semantics TEXT NOT NULL CHECK (parent_semantics IN
      ('none','single','listed_chain','listed_variants','listed_unresolved'))
) STRICT;
CREATE TABLE etymon_parent (
  key TEXT NOT NULL, parent_key TEXT NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY (key, parent_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE etymon_member (
  key TEXT NOT NULL, lang TEXT NOT NULL, word TEXT NOT NULL, norm TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (key, lang, word)
) STRICT, WITHOUT ROWID;
CREATE INDEX etymon_member_norm ON etymon_member(lang, norm);

-- ════════════ 7. Analysis ════════════
CREATE TABLE analysis_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,                       -- vocab.STAGES
  pipeline_version TEXT NOT NULL,            -- 'cluster@1.0.0'
  code_hash TEXT NOT NULL,                   -- sha256 of the stage module files (computed at boot)
  params_json TEXT NOT NULL CHECK (json_valid(params_json)), params_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  input_fingerprint TEXT NOT NULL,           -- sha256(scope + data_version + upstream runs + tokenizer + segmenter)
  data_version INTEGER NOT NULL,
  upstream_run_ids TEXT NOT NULL DEFAULT '[]',
  representation TEXT,                       -- 'ppmi-svd-pooled' | 'tfidf-hash-4096' | 'apple.NLEmbedding.en' | NULL
  model TEXT, model_version TEXT, seed INTEGER,
  tokenizer_version TEXT NOT NULL, segmenter_version TEXT NOT NULL, icu_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','superseded')),
  gate_json TEXT NOT NULL DEFAULT '{}', metrics_json TEXT,
  job_id INTEGER, started_at TEXT NOT NULL, finished_at TEXT, notes TEXT
) STRICT;
CREATE INDEX run_reuse ON analysis_run(stage, params_hash, input_fingerprint, status);

CREATE TABLE time_window (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  label TEXT NOT NULL, lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('fixed','merged_for_min_n','slice','custom')),
  n_occ INTEGER, tokens INTEGER
) STRICT;

CREATE TABLE collocation (
  run_id INTEGER NOT NULL REFERENCES analysis_run(id), expression_id INTEGER NOT NULL,
  slice_key TEXT NOT NULL, collocate TEXT NOT NULL,
  f_xy INTEGER NOT NULL, f_x INTEGER NOT NULL, f_y INTEGER NOT NULL, n_tokens INTEGER NOT NULL,
  g2 REAL NOT NULL, q_value REAL NOT NULL, log_dice REAL NOT NULL, ppmi REAL NOT NULL,
  PRIMARY KEY (run_id, expression_id, slice_key, collocate)
) STRICT, WITHOUT ROWID;

CREATE TABLE vector_space (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  lang TEXT NOT NULL, lo_year INTEGER, hi_year INTEGER, pooled INTEGER NOT NULL CHECK (pooled IN (0,1)),
  collections_json TEXT NOT NULL, tokens INTEGER NOT NULL, docs INTEGER NOT NULL, authors INTEGER NOT NULL,
  vocab_size INTEGER NOT NULL, dim INTEGER NOT NULL,
  rel_path TEXT NOT NULL                     -- derived/spaces/<id>.f32 + .vocab.tsv
) STRICT;
CREATE TABLE space_alignment (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  from_space INTEGER NOT NULL REFERENCES vector_space(id), to_space INTEGER NOT NULL REFERENCES vector_space(id),
  method TEXT NOT NULL CHECK (method = 'orthogonal_procrustes'),
  anchors INTEGER NOT NULL, mean_anchor_cos REAL NOT NULL, rel_path TEXT NOT NULL
) STRICT;

CREATE TABLE sense_cluster (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL REFERENCES expression(id), ord INTEGER NOT NULL,
  label_auto TEXT NOT NULL,                  -- 'machine label: column · digit · place'
  distinctive_json TEXT NOT NULL,            -- [{term, z, f_in, f_out}]
  size INTEGER NOT NULL, n_docs INTEGER NOT NULL, top_doc_share REAL NOT NULL,
  stability REAL, silhouette REAL, first_year INTEGER, last_year INTEGER,
  status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis','unstable','residual'))
) STRICT;
CREATE TABLE cluster_member (
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id),
  occurrence_id INTEGER NOT NULL REFERENCES occurrence(id),
  cos REAL NOT NULL, margin REAL NOT NULL,
  PRIMARY KEY (cluster_id, occurrence_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cluster_member_occ ON cluster_member(occurrence_id);
CREATE TABLE cluster_share (
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id), window_id INTEGER NOT NULL REFERENCES time_window(id),
  n INTEGER NOT NULL, share REAL NOT NULL, ci_lo REAL NOT NULL, ci_hi REAL NOT NULL,
  PRIMARY KEY (cluster_id, window_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE cluster_transition (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  kind TEXT NOT NULL CHECK (kind IN ('emerge','split','merge','vanish','unknown_gap','convergence')),
  from_cluster INTEGER, to_cluster INTEGER, window_id INTEGER NOT NULL REFERENCES time_window(id),
  score REAL, ci_lo REAL, ci_hi REAL, note TEXT
) STRICT;

CREATE TABLE drift_result (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL,
  slice_a_json TEXT NOT NULL, slice_b_json TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('rate_ratio','sense_share_jsd','neighbor_overlap',
                                         'aligned_displacement','convergence')),
  value REAL, ci_lo REAL, ci_hi REAL, null_percentile REAL,
  n_a INTEGER, n_b INTEGER, docs_a INTEGER, docs_b INTEGER, authors_a INTEGER, authors_b INTEGER,
  gate TEXT NOT NULL CHECK (gate IN ('ok','insufficient_occurrences','insufficient_documents',
        'insufficient_authors','insufficient_coverage','single_source','unaligned','slice_too_small',
        'composition_mismatch','modality_mismatch','sampling_design','no_cluster_structure','not_run')),
  gate_detail_json TEXT NOT NULL, caveats_json TEXT NOT NULL DEFAULT '[]',
  CHECK (gate = 'ok' OR (value IS NULL AND ci_lo IS NULL AND ci_hi IS NULL AND null_percentile IS NULL))
) STRICT;

CREATE TABLE compare_log (                   -- discloses repeated slicing (multiplicity)
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, expression_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, measures_json TEXT NOT NULL,
  notable_count INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
) STRICT;
CREATE INDEX compare_log_key ON compare_log(session_id, expression_key);

-- ════════════ 8. Relationships ════════════
CREATE TABLE rel_type (
  code TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('quotation','citation','adaptation','parody','reinterpretation',
                                         'allusion','similarity','containment','etymology','sense')),
  label TEXT NOT NULL, inverse_label TEXT NOT NULL,
  directed INTEGER NOT NULL CHECK (directed IN (0,1)),
  requires_precedence INTEGER NOT NULL CHECK (requires_precedence IN (0,1)),
  implies_transmission INTEGER NOT NULL CHECK (implies_transmission IN (0,1)),
  feedback_capable INTEGER NOT NULL CHECK (feedback_capable IN (0,1)),
  glyph TEXT NOT NULL, description TEXT NOT NULL
) STRICT;

CREATE TABLE hypothesis_group (
  id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_ref TEXT NOT NULL,
  question TEXT NOT NULL, created_by TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  rel_type TEXT NOT NULL REFERENCES rel_type(code),
  src_type TEXT NOT NULL CHECK (src_type IN ('document','passage','occurrence','expression','etymon','cluster')),
  src_ref TEXT NOT NULL,                     -- canonical: the LATER / dependent item (decimal id or etymon key)
  dst_type TEXT NOT NULL CHECK (dst_type IN ('document','passage','occurrence','expression','etymon','cluster')),
  dst_ref TEXT NOT NULL,                     -- canonical: the EARLIER / source item
  directed INTEGER NOT NULL CHECK (directed IN (0,1)),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','computed','proposed')),
  origin TEXT NOT NULL CHECK (origin IN ('source_dataset','algorithm','machine_tagger','human')),
  source_dataset TEXT,                       -- 'wikipedia','wikidata','musicbrainz','itwofs','openalex','wiktionary',
                                             -- 'import:<collection>','demo-records'
  source_locator TEXT,
  provenance_quality TEXT NOT NULL DEFAULT 'complete'
      CHECK (provenance_quality IN ('complete','source_unrecorded')),
  method TEXT,
  run_id INTEGER REFERENCES analysis_run(id),
  created_by TEXT NOT NULL,                  -- 'adapter:cipher.works@1' | 'run:42' | 'human:utkarsh'
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
      CHECK (review_status IN ('unreviewed','confirmed','rejected','disputed')),
  score REAL,
  score_kind TEXT CHECK (score_kind IN ('similarity','heuristic_strength','match_ratio','alignment_score',
                                        'classifier_score')),
  date_conflict INTEGER NOT NULL DEFAULT 0 CHECK (date_conflict IN (0,1)),
  src_year INTEGER, dst_year INTEGER,        -- denormalized for drawing
  hypothesis_group_id INTEGER REFERENCES hypothesis_group(id),
  license TEXT, attribution TEXT, provenance_note TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  -- structural guarantees: inferred lineage can never be stored as documented
  CHECK (evidence_status <> 'documented' OR (origin = 'source_dataset' AND source_dataset IS NOT NULL
         AND (source_locator IS NOT NULL OR provenance_quality = 'source_unrecorded'))),
  CHECK (origin <> 'source_dataset' OR evidence_status = 'documented'),
  CHECK (evidence_status <> 'computed' OR origin = 'algorithm'),
  CHECK (origin <> 'algorithm' OR (run_id IS NOT NULL AND method IS NOT NULL)),
  CHECK (origin <> 'machine_tagger' OR (evidence_status = 'proposed' AND method IS NOT NULL)),
  CHECK (origin <> 'human' OR (evidence_status = 'proposed' AND created_by LIKE 'human:%')),
  CHECK (score IS NULL OR score_kind IS NOT NULL)
) STRICT;
CREATE INDEX rel_src   ON relationship(src_type, src_ref);
CREATE INDEX rel_dst   ON relationship(dst_type, dst_ref);
CREATE INDEX rel_kind  ON relationship(rel_type, evidence_status, review_status);
CREATE INDEX rel_group ON relationship(hypothesis_group_id) WHERE hypothesis_group_id IS NOT NULL;
CREATE TRIGGER rel_evidence_immutable
BEFORE UPDATE OF rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
                 source_dataset, method, run_id ON relationship
BEGIN SELECT RAISE(ABORT, 'relationship evidence fields are immutable; create a new relationship'); END;
CREATE TRIGGER rel_no_delete BEFORE DELETE ON relationship
WHEN NOT EXISTS (SELECT 1 FROM analysis_run r WHERE r.id = OLD.run_id AND r.status IN ('cancelled','failed'))
BEGIN SELECT RAISE(ABORT, 'relationships are never deleted; reject them instead'); END;

CREATE TABLE relationship_evidence (
  id INTEGER PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  passage_id INTEGER REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('source_span','target_span','citation_cue','supporting',
                                     'contradicting','external_record')),
  start_off INTEGER, end_off INTEGER,
  anchor_json TEXT,                          -- {doc_id, sha256, field, start, end, quote, prefix, suffix}
  detail_json TEXT, added_by TEXT NOT NULL, added_at TEXT NOT NULL
) STRICT;
CREATE INDEX rel_ev ON relationship_evidence(relationship_id);

CREATE TABLE relationship_revision (
  id INTEGER PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  rev INTEGER NOT NULL,
  actor TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','confirm','reject','dispute','add_evidence','regroup','retract')),
  before_json TEXT, after_json TEXT NOT NULL, reason TEXT,
  annotation_id INTEGER REFERENCES annotation(id),
  UNIQUE (relationship_id, rev)
) STRICT;
CREATE TRIGGER relrev_no_update BEFORE UPDATE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;
CREATE TRIGGER relrev_no_delete BEFORE DELETE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;

-- ════════════ 9. Interpretation ════════════
CREATE TABLE dimension_def (
  key TEXT PRIMARY KEY, label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('enum','scale','text','bool')),
  options_json TEXT, builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL
) STRICT;

CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('passage','occurrence','document','expression','cluster',
        'relationship','hypothesis_group','saved_view','time_window','annotation')),
  target_ref TEXT NOT NULL,
  anchor_json TEXT,                          -- REQUIRED for passage/occurrence: {doc_id, sha256, field, start, end,
                                             --   quote, prefix(≤32), suffix(≤32)} — survives re-segmentation
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','evidence_for','evidence_against','hypothesis','question',
        'correction','label','machine_tag','machine_tone','machine_gloss')),
  author TEXT NOT NULL,
  is_machine INTEGER NOT NULL CHECK (is_machine IN (0,1)),
  method TEXT, run_id INTEGER REFERENCES analysis_run(id),
  layer TEXT,
  supersedes INTEGER REFERENCES annotation(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  CHECK (is_machine = 0 OR method IS NOT NULL),
  CHECK (target_type NOT IN ('passage','occurrence') OR anchor_json IS NOT NULL)
) STRICT;
CREATE INDEX ann_target ON annotation(target_type, target_ref, status);

CREATE TABLE annotation_revision (
  id INTEGER PRIMARY KEY,
  annotation_id INTEGER NOT NULL REFERENCES annotation(id),
  rev INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  stance TEXT CHECK (stance IN ('supports','contradicts','neutral','alternative')),
  dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions_json)),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  reason TEXT, author TEXT NOT NULL, at TEXT NOT NULL,
  UNIQUE (annotation_id, rev)
) STRICT;
CREATE TRIGGER annrev_no_update BEFORE UPDATE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;
CREATE TRIGGER annrev_no_delete BEFORE DELETE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;
CREATE VIRTUAL TABLE annotation_fts USING fts5(body, tags, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M* So'");   -- rowid = annotation_revision.id

-- ════════════ 10. App state, jobs, caches ════════════
CREATE TABLE saved_view (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,                 -- 'carry-the-zero-3f9a'; re-save → 'carry-the-zero-3f9a~2'
  parent_slug TEXT, name TEXT NOT NULL, description TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)), state_version INTEGER NOT NULL, state_hash TEXT NOT NULL,
  data_version INTEGER NOT NULL, max_import_batch INTEGER NOT NULL,
  run_ids_json TEXT NOT NULL CHECK (json_valid(run_ids_json)),
  annotation_rev_cutoff INTEGER NOT NULL,    -- max annotation_revision.id visible at save
  relationship_rev_cutoff INTEGER NOT NULL,  -- max relationship_revision.id visible at save
  comparisons_tried INTEGER NOT NULL DEFAULT 0,
  snapshot_svg TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
) STRICT;
CREATE TRIGGER view_immutable BEFORE UPDATE OF slug, state_json, state_hash, data_version, max_import_batch,
  run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff ON saved_view
BEGIN SELECT RAISE(ABORT, 'saved views are immutable; save a new revision (slug~n)'); END;

CREATE TABLE job (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                        -- vocab.JOB_TYPES
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  writes INTEGER NOT NULL CHECK (writes IN (0,1)),   -- 1 = needs the single writer lock
  priority INTEGER NOT NULL DEFAULT 5,       -- 1 = interactive … 9 = background bootstrap
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelling','cancelled','interrupted')),
  progress REAL NOT NULL DEFAULT 0, phase TEXT, message TEXT, counts_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER REFERENCES analysis_run(id),
  result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT
) STRICT;
CREATE INDEX job_status ON job(status, priority, created_at);
CREATE TABLE job_event (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  phase TEXT, progress REAL, message TEXT, data_json TEXT
) STRICT;
CREATE INDEX job_event_job ON job_event(job_id, id);

CREATE TABLE query_def (key TEXT PRIMARY KEY, def_json TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used TEXT NOT NULL) STRICT;
CREATE TABLE tile_cache (key TEXT PRIMARY KEY,          -- queryKey|tier|tile|data_version
  body_gz BLOB NOT NULL, bytes INTEGER NOT NULL, last_used TEXT NOT NULL) STRICT;
CREATE TABLE layout_cache (key TEXT PRIMARY KEY, positions_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE theme_assoc (theme TEXT NOT NULL, other TEXT NOT NULL, npmi REAL NOT NULL,
  PRIMARY KEY (theme, other)) STRICT, WITHOUT ROWID;
