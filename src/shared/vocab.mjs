// OWNER: WP0 — closed vocabularies shared by server and browser (SPEC §3, §3.1, §6.1, §7, §8.7)
//
// Every list here mirrors a CHECK constraint in server/db/schema.sql or a contract of SPEC §7. Arrays are
// frozen; lookups are plain objects. Nothing in this file may import node: modules (it is served at /shared).

const freeze = (x) => Object.freeze(x);
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

// ── Evidence and provenance (§6.1, D7) ─────────────────────────────────────────────────────────────
/** relationship.evidence_status — fixed at creation, immutable (DB trigger). */
export const EVIDENCE_STATUS = freeze(['documented', 'computed', 'proposed']);
/** relationship.review_status — the human layer; never changes the line style. */
export const REVIEW_STATUS = freeze(['unreviewed', 'confirmed', 'rejected', 'disputed']);
/** relationship.origin — CHECKs bind evidence_status to origin. */
export const ORIGINS = freeze(['source_dataset', 'algorithm', 'machine_tagger', 'human']);
/** relationship.provenance_quality — `source_unrecorded` is shown as DOC*. */
export const PROVENANCE_QUALITY = freeze(['complete', 'source_unrecorded']);
/** relationship.score_kind with the label every UI must print next to the number (none is a probability). */
export const SCORE_KINDS = freeze(['similarity', 'heuristic_strength', 'match_ratio', 'alignment_score', 'classifier_score']);
export const SCORE_KIND_LABELS = deepFreeze({
  similarity: 'similarity — not a probability',
  heuristic_strength: 'Cipher heuristic weight — not a probability',
  match_ratio: 'share of tokens matched — not a probability',
  alignment_score: 'alignment score — not a probability',
  classifier_score: 'classifier score — not a probability',
});
/** relationship.src_type / dst_type */
export const REL_ENDPOINT_TYPES = freeze(['document', 'passage', 'occurrence', 'expression', 'etymon', 'cluster']);
/** relationship_evidence.role */
export const EVIDENCE_ROLES = freeze(['source_span', 'target_span', 'citation_cue', 'supporting', 'contradicting', 'external_record']);
/** relationship_revision.action */
export const REL_ACTIONS = freeze(['create', 'confirm', 'reject', 'dispute', 'add_evidence', 'regroup', 'retract']);

/** rel_type.family */
export const REL_FAMILIES = freeze(['quotation', 'citation', 'adaptation', 'parody', 'reinterpretation',
  'allusion', 'similarity', 'containment', 'etymology', 'sense']);

/**
 * Role hue per family (§8.7): amber = reference to earlier material, violet = reinterpretation,
 * ivory2 = similarity / structure. Hue is always backed by the rel_type glyph and label.
 */
export const FAMILY_HUE = deepFreeze({
  quotation: 'amber', citation: 'amber', adaptation: 'amber', allusion: 'amber', etymology: 'amber',
  parody: 'violet', reinterpretation: 'violet',
  similarity: 'ivory2', containment: 'ivory2', sense: 'ivory2',
});

const rt = (code, family, directed, requires_precedence, implies_transmission, feedback_capable, glyph, short,
  label, inverse_label, description, brief = false) => ({
  code, family, label, inverse_label, directed, requires_precedence, implies_transmission, feedback_capable,
  glyph, description, short, brief,
});

/**
 * rel_type rows of §3.1 (seeded by server/db/seed-vocab.mjs). Canonical direction: src = later/dependent →
 * dst = earlier/source. `brief` marks the brief's eight relationship types (★). Integer flags match the DDL.
 */
export const REL_TYPES = deepFreeze([
  rt('exact_quotation', 'quotation', 1, 1, 1, 0, '“ ”', 'exact', 'quotes exactly', 'quoted exactly by',
    'A verified identical run of folded tokens (≥ 13 tokens globally, ≥ 8 in a targeted trace).', true),
  rt('near_quotation', 'quotation', 1, 1, 1, 0, '≈“ ”', 'near', 'quotes approximately', 'quoted approximately by',
    'Aligned near-identical wording (Smith–Waterman ≥ 0.75 of the shorter unit and 3-shingle Jaccard ≥ 0.5).', true),
  rt('shared_wording', 'similarity', 0, 0, 0, 0, '⇋', 'shared wording', 'shares wording with', 'shares wording with',
    'Shared wording whose direction is unknown (overlapping or missing dates). Not transmission.'),
  rt('samples', 'quotation', 1, 1, 1, 0, '♪', 'samples', 'samples', 'sampled by',
    'A recording reuses audio of an earlier recording, as stated by the source dataset.'),
  rt('interpolates', 'quotation', 1, 1, 1, 0, '♪≈', 'interpolates', 'interpolates', 'interpolated in',
    'A work re-performs part of an earlier work, as stated by the source dataset.'),
  rt('explicit_citation', 'citation', 1, 1, 1, 0, '§', 'cites', 'cites', 'cited by',
    'The later item names the earlier one as its source (a record, bibliography or attribution).', true),
  rt('adaptation_of', 'adaptation', 1, 1, 1, 0, '⟲', 'adapts', 'adapts', 'adapted as',
    'The later work is an adaptation of the earlier one.', true),
  rt('remake_of', 'adaptation', 1, 1, 1, 0, '⟲', 'remake', 'remakes', 'remade as',
    'The later work is a remake of the earlier one.'),
  rt('cover_of', 'adaptation', 1, 1, 1, 0, '⟲♪', 'cover', 'covers', 'covered as',
    'The later recording is a cover of the earlier one.'),
  rt('version_of', 'adaptation', 1, 0, 1, 0, '⟲', 'version', 'is a version of', 'has version',
    'Another version of the same work; order of release is not implied.'),
  rt('remix_of', 'adaptation', 1, 1, 1, 0, '⟲♪', 'remix', 'remixes', 'remixed as',
    'The later recording is a remix of the earlier one.'),
  rt('translation_of', 'adaptation', 1, 1, 1, 0, '⟲文', 'translation', 'translates', 'translated as',
    'The later text is a translation of the earlier one.'),
  rt('parody_of', 'parody', 1, 1, 1, 1, '◐', 'parody', 'parodies', 'parodied by',
    'The later work parodies the earlier one.', true),
  rt('recontextualizes', 'reinterpretation', 1, 1, 1, 1, '↻', 'recontextualizes', 'recontextualizes',
    'recontextualized by', 'The later work places the earlier material in a new context.', true),
  rt('answer_to', 'reinterpretation', 1, 1, 1, 1, '↩', 'answers', 'answers', 'answered by',
    'The later work is a stated answer to the earlier one.'),
  rt('reframes', 'reinterpretation', 1, 1, 0, 1, '↺', 'reframes', 'reframes', 'reframed by',
    'The later work changes how the earlier one is read (feedback-capable).'),
  rt('inspired_by', 'allusion', 1, 1, 1, 0, '✶', 'inspired', 'was inspired by', 'inspired',
    'A source states that the later work was inspired by the earlier one.'),
  rt('homage_to', 'allusion', 1, 1, 1, 0, '✶', 'homage', 'pays homage to', 'receives homage from',
    'The later work is a stated homage to the earlier one.'),
  rt('proposed_allusion', 'allusion', 1, 1, 1, 0, '?', 'allusion', 'may allude to', 'may be alluded to by',
    'A hypothesis that the later item alludes to the earlier one; never established by similarity alone.', true),
  rt('similar_contextual_usage', 'similarity', 0, 0, 0, 0, '∼', 'similar', 'is used in contexts similar to',
    'is used in contexts similar to', 'Similar usage contexts (computed). Not influence, ancestry or intent.', true),
  rt('kindred', 'similarity', 0, 0, 0, 0, '∼', 'kindred', 'is kindred with', 'is kindred with',
    'Cipher theme-similarity pair (computed by Cipher). Hidden from lineage by default; not transmission.'),
  rt('counterpart', 'similarity', 0, 0, 0, 0, '⇄', 'counterpart', 'is a counterpart of', 'is a counterpart of',
    'Proposed counterpart (Cipher tagging pass or title match). Hidden from lineage by default.'),
  rt('part_of', 'containment', 1, 0, 0, 0, '⊂', 'part of', 'is part of', 'contains',
    'Containment (a song from a film, a passage of a document).'),
  rt('descends_from', 'etymology', 1, 0, 1, 0, '⤷', 'descends', 'descends from', 'is an ancestor of',
    'Etymological descent as listed by Wiktionary (via kaikki.org). Periods, not dates.'),
  rt('sense_split', 'sense', 1, 1, 0, 0, '⑂', 'split', 'splits from', 'splits into',
    'A computed split in usage contexts; not a claim about speakers.'),
  rt('sense_merge', 'sense', 0, 0, 0, 0, '⑃', 'merge', 'converges with', 'converges with',
    'A computed convergence of usage contexts; not a claim about speakers.'),
]);
/** REL_TYPES keyed by code. */
export const REL_TYPE_BY_CODE = deepFreeze(Object.fromEntries(REL_TYPES.map((r) => [r.code, r])));

// ── Time (§3 date_assertion, §5.3) ─────────────────────────────────────────────────────────────────
export const DATE_ROLES = freeze(['publication', 'creation', 'original_publication', 'publication_unspecified',
  'edition', 'release', 'recording', 'performance', 'referenced', 'authored_description', 'translation',
  'ingestion', 'language_period', 'first_attestation_claim', 'digitized']);
export const PRECISIONS = freeze(['day', 'month', 'year', 'decade', 'century', 'millennium', 'range', 'period', 'unknown']);
export const BASES = freeze(['stated', 'estimated', 'derived', 'period', 'announced', 'unknown']);
export const CHRONO_STATUS = freeze(['dated', 'undated', 'scheduled']);
/** x-basis of the Scroll (§1.1). */
export const TIME_BASES = freeze(['publication', 'referenced']);
/** date_assertion.subject_type */
export const DATE_SUBJECTS = freeze(['document', 'passage', 'expression', 'relationship']);

/** language_period rows of §3.1 (astronomical years). Labels end "— period of the language, not a date". */
export const LANGUAGE_PERIODS = deepFreeze([
  { lang: 'ine-pro', label: 'Proto-Indo-European — period of the language, not a date', lo_year: -4499, hi_year: -2499,
    core_lo: null, core_hi: null, fuzz_years: 500, source: 'SPEC §3.1 (conventional periodization)',
    note: 'reconstructed, not attested' },
  { lang: 'sa', label: 'Sanskrit (Vedic → Classical) — period of the language, not a date', lo_year: -1499, hi_year: 1000,
    core_lo: -499, core_hi: 1000, fuzz_years: 300, source: 'SPEC §3.1 (conventional periodization)',
    note: 'dhātus are grammatical roots' },
  { lang: 'grc', label: 'Ancient Greek — period of the language, not a date', lo_year: -799, hi_year: 600,
    core_lo: null, core_hi: null, fuzz_years: 100, source: 'SPEC §3.1 (conventional periodization)',
    note: 'conventional span of attested Ancient Greek' },
  { lang: 'la', label: 'Latin (Old → Medieval; Wiktionary lemmas) — period of the language, not a date', lo_year: -699,
    hi_year: 1500, core_lo: -74, core_hi: 200, fuzz_years: 100, source: 'SPEC §3.1 (conventional periodization)',
    note: 'Wiktionary Latin includes Late/Medieval forms; core = Classical' },
]);

// ── Corpora and collections (§3, §6.2) ─────────────────────────────────────────────────────────────
export const CORPUS_KINDS = freeze(['real', 'synthetic', 'user']);
/** corpus rows seeded by seed-vocab.mjs. */
export const CORPORA = deepFreeze([
  { slug: 'demo', name: 'Synthetic demonstration — carry the zero', kind: 'synthetic', is_synthetic: 1,
    description: 'Invented people, texts, dates and links (SPEC §9).', license: 'CC0 (synthetic)' },
  { slug: 'cipher', name: 'Cipher corpus (public-domain texts + culture metadata; no lyrics)', kind: 'real',
    is_synthetic: 0, description: 'Local Cipher datasets read in place.', license: 'per collection' },
  { slug: 'stemm', name: 'STEMM sources (staged files)', kind: 'real', is_synthetic: 0,
    description: 'Science, technology, engineering, mathematics and medicine sources staged under sources/.',
    license: 'per collection' },
  { slug: 'user', name: 'Your imports', kind: 'user', is_synthetic: 0,
    description: 'Files you imported.', license: 'per import' },
]);
/**
 * 1.3.0: virtual corpora — read-only views over several corpora, never a corpus row. `real` is every
 * non-synthetic corpus holding documents; the synthetic demo is never a member.
 */
export const VIRTUAL_CORPORA = deepFreeze({
  real: { slug: 'real', name: 'All real corpora (Term trail)', kind: 'real', is_synthetic: 0,
    description: 'Every non-synthetic corpus holding documents (the synthetic demo is never included); counts are the sum of each corpus counted alone.' },
});
export const DOMAINS = freeze(['literature', 'culture', 'stemm', 'etymology', 'imported', 'demo']);
export const MODALITIES = freeze(['text', 'titles', 'abstracts', 'lexical', 'baseline']);
/** collection.unit — the rate denominator. */
export const UNITS = freeze(['tokens', 'works', 'entries', 'none']);
/** Rate units carried by lanes and cells (§1.2 item 8). */
export const RATE_UNITS = deepFreeze({
  per_million_tokens: { collectionUnit: 'tokens', scale: 1e6, label: 'per million tokens', short: '/M tokens' },
  per_thousand_works: { collectionUnit: 'works', scale: 1e3, label: 'per 1,000 works', short: '/1k works' },
  share_of_sampled_works: { collectionUnit: 'works', scale: 1, label: 'share of sampled works in the cell', short: 'of sampled works' },
  per_million_baseline: { collectionUnit: 'none', scale: 1e6, label: 'per million (Google Books eng)', short: '/M (Google Books)' },
  // 1.3.0 (Term trail): lanes that are drawn but never carry a rate
  count_of_works: { collectionUnit: 'works', scale: 0, label: 'works (counted, never a rate)', short: 'works' },
  period_bands: { collectionUnit: 'none', scale: 0, label: 'periods of languages, not dates', short: 'periods' },
});
export const SAMPLINGS = freeze(['complete', 'prominence_selected', 'top_cited_per_cell', 'relation_endpoints', 'curated', 'user']);
/** Lane-header wording for selection (§1.3, honesty rule 14). */
export const SAMPLING_LABELS = deepFreeze({
  complete: 'complete collection',
  prominence_selected: 'selected by prominence',
  top_cited_per_cell: 'top-cited sample per field × period',
  relation_endpoints: 'works that appear in documented links',
  curated: 'curated selection',
  user: 'your import',
});
/** Coverage gates by unit (§1.2, §4.6); `collection.coverage_gate` overrides (demo 2,000 tokens). */
export const COVERAGE_GATES = deepFreeze({ tokens: 50000, works: 30, sampled_works: 20, demo_tokens: 2000 });
/** Coverage step classes (§1.7): upper bounds of classes 1–3; class 4 = at or above the last bound. */
export const COVERAGE_STEPS = deepFreeze({ tokens: [10000, 100000, 1000000], works: [10, 100, 1000] });
export const ADAPTER_ACCESS = freeze(['local-file', 'local-dataset', 'network']);

// ── Documents, passages, tags (§3) ─────────────────────────────────────────────────────────────────
/**
 * Known document kinds. `document.kind` has no CHECK: imports may bring their own kinds, so this list is
 * what the UI knows how to label, not a closed set.
 */
export const DOC_KINDS = freeze(['book', 'song', 'film', 'tv', 'sport', 'channel', 'paper', 'abstract', 'entry',
  'article', 'essay', 'poem', 'verse', 'letter', 'memo', 'bulletin', 'newsletter', 'notice', 'broadside',
  'manual', 'notebook', 'zine', 'flyer', 'review', 'interview', 'post', 'blog', 'transcript', 'record', 'document',
  // 1.2.0 (M5 gate): issues of science periodicals on the Gutenberg STEMM shelf (stemm.gutenberg-stemm)
  'periodical']);
export const DOC_FIELDS = freeze(['title', 'native_title', 'summary', 'abstract', 'gloss', 'entry']);
export const PASSAGE_FIELDS = freeze(['body', 'title', 'native_title', 'summary', 'abstract', 'gloss', 'entry']);
export const FIELD_CLASSES = freeze(['text', 'title', 'abstract', 'describes', 'apparatus']);
export const TIME_ROLES = freeze(['document', 'describes', 'apparatus']);
export const PASSAGE_UNITS = freeze(['paragraph', 'stanza', 'sentence_group', 'page_paragraph', 'field']);
export const QUALITIES = freeze(['ok', 'furniture', 'boilerplate', 'front_matter', 'low', 'gappy']);
export const DECODERS = freeze(['utf-8', 'windows-1252', 'pages-joined-ff']);
export const TAG_SCHEMES = freeze(['theme', 'motif', 'mood', 'canon', 'locc', 'subject', 'field', 'subfield', 'topic',
  'keyword', 'maker']);
export const TAG_PROVENANCE = freeze(['documented_category', 'machine_tag', 'genre_heuristic', 'catalog', 'adapter_machine']);

// ── Expressions (§3, §4.5) ─────────────────────────────────────────────────────────────────────────
export const EXPRESSION_KINDS = freeze(['word', 'phrase', 'quotation', 'symbol', 'motif', 'theme']);
export const EXPRESSION_ORIGINS = freeze(['user_query', 'demo', 'stemm_seed', 'import', 'tour']);
export const VARIANT_TYPES = freeze(['identity', 'inflection', 'spelling', 'hyphenation', 'transliteration',
  'translation', 'descendant', 'user']);
export const EXPRESSION_STATES = freeze(['none', 'previewing', 'materializing', 'ready', 'failed']);
export const ETYMON_KINDS = freeze(['etymon', 'root']);
export const PARENT_SEMANTICS = freeze(['none', 'single', 'listed_chain', 'listed_variants', 'listed_unresolved']);

// ── Analysis (§3 §4.8–4.11) ────────────────────────────────────────────────────────────────────────
/** analysis_run.stage — job types where a job exists, plus the synthetic Cipher provenance stage. */
export const STAGES = freeze(['import', 'demo-load', 'bootstrap-cipher', 'adapter-load', 'cipher_load', 'materialize',
  'tokstream', 'collocations', 'vectors', 'align', 'cluster', 'drift', 'tone', 'layout', 'boilerplate',
  'reuse-index', 'trace', 'export']);
export const RUN_STATUS = freeze(['running', 'succeeded', 'failed', 'cancelled', 'superseded']);
/** Gate codes (drift_result.gate CHECK, §4.11). A gated measure has no value. */
export const GATE_CODES = freeze(['ok', 'insufficient_occurrences', 'insufficient_documents', 'insufficient_authors',
  'insufficient_coverage', 'single_source', 'unaligned', 'slice_too_small', 'composition_mismatch',
  'modality_mismatch', 'sampling_design', 'no_cluster_structure', 'not_run']);
export const DRIFT_METRICS = freeze(['rate_ratio', 'sense_share_jsd', 'neighbor_overlap', 'aligned_displacement', 'convergence']);
export const TRANSITION_KINDS = freeze(['emerge', 'split', 'merge', 'vanish', 'unknown_gap', 'convergence']);
export const CLUSTER_STATUS = freeze(['hypothesis', 'unstable', 'residual']);
export const WINDOW_SCHEMES = freeze(['fixed', 'merged_for_min_n', 'slice', 'custom']);

// ── Interpretation (§3 §2.F, §3.1) ─────────────────────────────────────────────────────────────────
export const ANNOTATION_TARGETS = freeze(['passage', 'occurrence', 'document', 'expression', 'cluster', 'relationship',
  'hypothesis_group', 'saved_view', 'time_window', 'annotation']);
export const ANNOTATION_KINDS = freeze(['interpretation', 'evidence_for', 'evidence_against', 'hypothesis', 'question',
  'correction', 'label', 'machine_tag', 'machine_tone', 'machine_gloss']);
/** Kinds listed under "Machine annotations (fallible)"; they cannot be edited, only countered. */
export const MACHINE_ANNOTATION_KINDS = freeze(['machine_tag', 'machine_tone', 'machine_gloss']);
export const ANNOTATION_STATUS = freeze(['active', 'superseded', 'withdrawn']);
export const STANCES = freeze(['supports', 'contradicts', 'neutral', 'alternative']);
export const DIMENSION_TYPES = freeze(['enum', 'scale', 'text', 'bool']);
/** Built-in dimension_def rows (§3.1). `options` is stored as options_json. */
export const DIMENSIONS = deepFreeze([
  { key: 'lexical_sense', label: 'Lexical sense', type: 'text', options: null },
  { key: 'topic', label: 'Topic', type: 'text', options: null },
  { key: 'referent', label: 'Referent', type: 'text', options: null },
  { key: 'pragmatic_function', label: 'Pragmatic function', type: 'enum',
    // 'contested' added at the M1 gate (contract 1.1.0): §9.4 labels one 2011–2024 reading 'contested'
    options: ['sincere', 'ironic', 'parodic', 'reclaimed', 'pejorative', 'neutral', 'contested'] },
  { key: 'tone', label: 'Tone', type: 'scale', options: { min: -2, max: 2, step: 1 } },
  { key: 'stance', label: 'Stance', type: 'enum', options: ['endorses', 'opposes', 'neutral', 'mixed'] },
  { key: 'social_association', label: 'Social association', type: 'text', options: null },
  { key: 'perspective', label: 'Perspective (reading as…)', type: 'text', options: null },
  { key: 'personal_reading', label: 'Personal reading', type: 'text', options: null },
  { key: 'reframes_target', label: 'Reframes its target', type: 'bool', options: null },
]);

/**
 * Words the UI must never apply to historical people (§2.D, honesty rule 11); scanned by ui.copy.test.mjs.
 */
export const MENTAL_STATE_VERBS = freeze(['thought', 'felt', 'intended', 'meant to', 'wanted', 'believed']);
/**
 * Claims Scrolls never makes in its own voice (honesty rule 11): say "first observed in this corpus" and
 * "estimated shift in usage contexts" instead. Quoting an external source's claim (a Wiktionary entry) is
 * labelled "(external claim)" and is not Scrolls' voice.
 */
export const FORBIDDEN_PHRASES = freeze(['meaning changed', 'coined', 'born']);

// ── Jobs (§4.12, §12.2) ────────────────────────────────────────────────────────────────────────────
/**
 * Job types → { writes, priority, owner }. Keys equal the task module basenames under
 * server/jobs/tasks/ (worker.mjs imports `tasks/<type>.mjs` for every key). Priority 1 = interactive …
 * 9 = background bootstrap. `writes` = needs the single writer lock.
 */
export const JOB_TYPES = deepFreeze({
  '_noop': { writes: false, priority: 5, owner: 'WP0' },
  'import': { writes: true, priority: 2, owner: 'WP1' },
  'revert': { writes: true, priority: 2, owner: 'WP1' },
  'bootstrap-cipher': { writes: true, priority: 9, owner: 'WP2' },
  'adapter-load': { writes: true, priority: 6, owner: 'WP2' },
  'demo-load': { writes: true, priority: 1, owner: 'WP2' },
  'materialize': { writes: true, priority: 1, owner: 'WP3' },
  'export': { writes: false, priority: 3, owner: 'WP3' },
  'tokstream': { writes: false, priority: 5, owner: 'WP4' },
  'collocations': { writes: true, priority: 3, owner: 'WP4' },
  'vectors': { writes: true, priority: 6, owner: 'WP4' },
  'cluster': { writes: true, priority: 3, owner: 'WP4' },
  'drift': { writes: true, priority: 4, owner: 'WP4' },
  'tone': { writes: true, priority: 5, owner: 'WP4' },
  'layout': { writes: true, priority: 2, owner: 'WP4' },
  'boilerplate': { writes: true, priority: 8, owner: 'WP5' },
  'reuse-index': { writes: true, priority: 7, owner: 'WP5' },
  'trace': { writes: true, priority: 1, owner: 'WP5' },
  'gc-runs': { writes: true, priority: 9, owner: 'WP5' },
});
export const JOB_STATUS = freeze(['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'interrupted']);
/**
 * Cipher bootstrap status in /api/health `cipher.status` and the `bootstrap` SSE event (§6.8, §7.2 example
 * "fulltext" with phase "B"). While the job runs, its phase decides: phase B (full text) → 'fulltext', any
 * other phase (A metadata, A2 genealogy) → 'metadata'. 'absent' = Cipher files not found.
 */
export const CIPHER_STATUS = freeze(['absent', 'disabled', 'not_started', 'queued', 'metadata', 'fulltext', 'ready',
  'failed', 'cancelled', 'interrupted']);
export const JOB_EVENT_LEVELS = freeze(['info', 'warn', 'error']);

// ── Imports and issues (§5) ────────────────────────────────────────────────────────────────────────
export const IMPORT_FORMATS = freeze(['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'adapter']);
export const IMPORT_STATUS = freeze(['uploaded', 'previewed', 'validated', 'committing', 'committed', 'failed',
  'cancelled', 'reverted']);
export const SEVERITIES = freeze(['info', 'warning', 'rejected', 'fatal']);

/**
 * Issue codes → { severity, template }. Templates use `{name}` placeholders filled by the producer
 * (see `fillTemplate`); every issue also carries a non-empty `suggestion`. Severity is the default
 * effect: `rejected` = the row is skipped, `fatal` = the batch fails with zero documents.
 */
export const ISSUE_CODES = deepFreeze({
  E_ENCODING: { severity: 'fatal',
    template: 'Line {line}: bytes are not valid UTF-8 ({byte} at byte {offset}).' },
  W_ENCODING_FALLBACK: { severity: 'warning',
    template: 'Bytes are not valid UTF-8 ({byte} at byte {offset}); read as Windows-1252.' },
  E_CSV_QUOTE: { severity: 'fatal',
    template: 'An unclosed quote starts on line {line}, column {col} and runs to the end of the file.' },
  E_ROW_RAGGED: { severity: 'rejected', template: 'Row {line} has {have} fields, the header has {expected}.' },
  W_TRUNCATED_ROW: { severity: 'warning', template: 'Row {line} has {have} fields, the header has {expected}; missing fields are empty.' },
  E_JSON_PARSE: { severity: 'rejected', template: 'Line {line}, column {col}: {detail}.' },
  E_MISSING_TEXT: { severity: 'rejected', template: 'Row {line} has no text and no title.' },
  E_DATE_UNPARSEABLE: { severity: 'warning', template: "Row {line} date '{value}' was not recognised; row imported as undated." },
  E_DATE_AMBIGUOUS: { severity: 'warning', template: "Row {line} date '{value}' is ambiguous; row imported as undated." },
  E_DATE_INVALID: { severity: 'warning', template: 'Row {line} date {value} does not exist; row imported as undated.' },
  E_FIELD_TYPE: { severity: 'warning', template: "Row {line} '{field}' is {have}; expected {expected}. The field was ignored." },
  E_ROW_TOO_LARGE: { severity: 'rejected', template: 'Row {line} {field} is {size} (limit 20 MB).' },
  E_DUP_FILE: { severity: 'fatal', template: 'Already imported on {date} as batch {batch}.' },
  E_DUP_ID: { severity: 'rejected', template: "Row {line} repeats id '{value}' first seen on line {first_line}." },
  W_LANG_MISMATCH: { severity: 'warning',
    template: 'Declared {declared}, but the text reads as {detected} ({scores}). Marked as a translation.' },
  W_TRANSLATION_CREDITED: { severity: 'info',
    template: "'{title}': {reason}. Dated by the original work and kept out of text-language chronology by default." },
  W_MIXED_LANGUAGE: { severity: 'info', template: "Document '{title}' has passages in {mix}." },
  W_DATE_FUTURE: { severity: 'info', template: "Date '{value}' is after the import time; shown on the Scheduled shelf." },
  W_AMBIGUOUS_HUNDREDS: { severity: 'warning', template: "'{value}' was read as the whole century {from}–{to}." },
  W_DATE_SEASON: { severity: 'info', template: "'{value}' was read as {from}–{to} (northern-hemisphere season)." },
  W_DUP_CONTENT: { severity: 'warning', template: 'Same text as document {other}; excluded from counts by default.' },
  W_NEAR_DUP: { severity: 'warning', template: 'Nearly the same text as document {other} (MinHash Jaccard {jaccard}).' },
  W_DUP_METADATA: { severity: 'warning', template: 'Same title, author and year as document {other}.' },
  W_NO_GUTENBERG_MARKERS: { severity: 'warning', template: 'No Project Gutenberg START/END markers; the whole file is the body.' },
  W_SHA_MISMATCH: { severity: 'rejected', template: 'File {file} does not match its catalogue sha256; row skipped.' },
  // Not in the §5.5 table: DocumentWriter reports a relationship or annotation whose endpoint resolves to nothing.
  W_UNRESOLVED_TARGET: { severity: 'warning', template: "{kind} {end} '{value}' was not found; the {kind} was not created." },
  // Fix pass (brief §12): an import whose file holds no record (a header row only, an empty array)
  W_NO_RECORDS: { severity: 'warning', template: 'The file holds no records: nothing will be imported.' },
  // Fix pass (§13 rule 1): real data never links into the synthetic demo — invented material stays inside it
  W_SYNTHETIC_TARGET: { severity: 'warning', template: "{kind} {end} '{value}' is in the synthetic demo (invented material); the {kind} was not created." },
});

// ── Lanes, filters, view (§1.3, §7, §8.2) ──────────────────────────────────────────────────────────
export const LANE_FACETS = freeze(['domain', 'community', 'kind', 'culture', 'language', 'collection', 'field',
  'modality', 'cluster', 'date_basis', 'trail']);
/** Header labels per facet (`culture` is never called "community"). */
export const LANE_FACET_LABELS = deepFreeze({
  domain: 'Domain', community: 'Community', kind: 'Kind', culture: 'country of origin (Wikidata)',
  language: 'Language (detected per passage)', collection: 'Collection', field: 'STEMM field', modality: 'Modality',
  cluster: 'Context group (machine label, editable)', date_basis: 'Date basis',
  trail: 'Term trail (fixed lanes, one unit each)',
});
export const LANE_ORDERS = freeze(['first_observed', 'total_n', 'alphabetical', 'manual']);
export const LANE_ORDER_NOTE = 'Lane order is a sorting choice (first observed), not a scale of meaning.';

/**
 * STEMM lanes of the shared field taxonomy (§10.3). WP2's data/field-taxonomy.json is the full mapping;
 * this list fixes lane keys, labels and order.
 */
export const STEMM_LANES = deepFreeze([
  { key: 'mathematics', label: 'Mathematics', locc: ['QA'], stemm_fields: ['mathematics'], openalex: [26],
    wiktionary: ['mathematics'] },
  { key: 'computing', label: 'Computing', locc: ['QA', 'T', 'TK'], stemm_fields: ['computing'], openalex: [17],
    wiktionary: ['computing'] },
  { key: 'physical-sciences', label: 'Physical sciences', locc: ['QB', 'QC', 'QD', 'TP'],
    stemm_fields: ['astronomy', 'physics', 'chemistry'], openalex: [31, 16, 25], wiktionary: ['astronomy', 'physics', 'chemistry'] },
  { key: 'earth-environment', label: 'Earth & environment', locc: ['QE'], stemm_fields: ['earth-sciences'],
    openalex: [19, 23], wiktionary: ['earth-sciences'] },
  { key: 'life-sciences', label: 'Life sciences', locc: ['QH', 'QK', 'QL', 'QM', 'QP', 'QR'], stemm_fields: ['biology'],
    openalex: [13, 11, 24, 28], wiktionary: ['biology'] },
  { key: 'medicine-health', label: 'Medicine & health', locc: ['R'], stemm_fields: ['medicine'],
    openalex: [27, 29, 30, 36, 35, 34], wiktionary: ['medicine'] },
  { key: 'engineering-technology', label: 'Engineering & technology', locc: ['T', 'TA–TN', 'TR', 'TS'],
    stemm_fields: ['engineering-technology'], openalex: [22, 21, 15], wiktionary: ['engineering-technology'] },
  { key: 'general-science', label: 'General science', locc: ['Q', 'AP'], stemm_fields: ['general-science'],
    openalex: [], wiktionary: [] },
]);

/**
 * 1.3.0: the Term trail's ordered, fixed lane set (§10.5). Each lane has its own unit and medium and is never pooled
 * with another: `kind` names the evidence (etymology bands, Cipher literature text, Gutenberg STEMM text per field,
 * OpenAlex top-cited samples per field, culture-work titles, music-relation endpoints).
 */
export const TRAIL_LANES = deepFreeze([
  { key: 'trail:etymology', kind: 'etymology', label: 'Etymology — periods, not dates', unit: 'period_bands', modality: 'lexical', field: null },
  { key: 'trail:literature-text', kind: 'literature-text', label: 'Literature · text (Cipher Gutenberg + Wikisource)', unit: 'per_million_tokens',
    modality: 'text', field: null },
  ...STEMM_LANES.map((f) => ({ key: `trail:stemm-text:${f.key}`, kind: 'stemm-text', label: `${f.label} · text (Gutenberg STEMM)`,
    unit: 'per_million_tokens', modality: 'text', field: f.key })),
  ...STEMM_LANES.filter((f) => f.openalex.length).map((f) => ({ key: `trail:stemm-abstracts:${f.key}`, kind: 'stemm-abstracts',
    label: `${f.label} · OpenAlex top-cited sample`, unit: 'share_of_sampled_works', modality: 'abstracts', field: f.key })),
  { key: 'trail:culture-titles', kind: 'culture-titles', label: 'Culture · titles (songs, films, TV, books)', unit: 'per_thousand_works',
    modality: 'titles', field: null },
  { key: 'trail:music-relations', kind: 'music-relations', label: 'Music relations · works in documented links', unit: 'count_of_works',
    modality: 'titles', field: null },
]);
/** The lane header note of OpenAlex share lanes (C3; D14). */
export const SHARE_LANE_NOTE = 'share of the top-cited sample in each cell — not a trend';

/** Filter keys of the `f` grammar (§7) and ViewState.f (§8.2). */
export const FILTER_KEYS = freeze(['lang', 'kind', 'coll', 'culture', 'field', 'community', 'basis', 'syn']);
/** Toggles of §7 with their defaults: tr translations, ds describes, ap apparatus, dup duplicates,
 *  nm name-guard hits, est estimated dates, bp boilerplate. */
export const TOGGLE_DEFAULTS = deepFreeze({ tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 });
export const TIERS = freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
export const STRAND_TYPES = freeze(['expression', 'theme', 'work', 'maker', 'cluster', 'baseline']);
/** Start-cap glyph per strand slot (§1.1 D3). */
export const STRAND_GLYPHS = freeze(['circle', 'square', 'triangle', 'diamond']);
export const STRAND_GLYPH_CHARS = deepFreeze({ circle: '●', square: '■', triangle: '▲', diamond: '◆' });
export const SELECTION_TYPES = freeze(['occurrence', 'passage', 'cluster', 'relationship', 'document', 'bin']);
export const RIGHT_PANELS = freeze(['lineage', 'genealogy', 'constellation', 'compare', 'notebook', 'import', 'adapters']);
export const CONSTELLATION_SIZES = freeze(['occurrences', 'documents', 'authors']);

/** Tile cell states (§7.2 tiles tuple index 8). */
export const CELL_STATES = deepFreeze({ 1: 'observed', 2: 'absent', 3: 'low', 4: 'uncovered', 5: 'pending' });
export const CELL_STATE_CODES = deepFreeze({ observed: 1, absent: 2, low: 3, uncovered: 4, pending: 5 });
/** Tile cell flag bits (§7.2 tiles tuple index 9). */
export const CELL_FLAGS = deepFreeze({ sparse: 1, single_source: 2, estimated_majority: 4, sampled: 8, synthetic: 16,
  names_excluded: 32, translations_included: 64 });
/** Index of each field in a tile cell tuple (§7.2). */
export const CELL_FIELDS = freeze(['bin', 'n', 'docs', 'authors', 'denom', 'rate', 'ci_lo', 'ci_hi', 'state', 'flags', 'dp']);

/**
 * Fill `{name}` placeholders of a template; unknown placeholders are left visible so a missing value is
 * noticed rather than silently blanked.
 * @param {string} template
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
export function fillTemplate(template, vars = {}) {
  return template.replace(/\{([a-z_]+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}
