// OWNER: WP0 — runtime shapes of every §7 response and every Canonical* input (SPEC §7, §12.3)
//
// Shapes are minimal: required keys and their types; extra keys are allowed (contracts change additively).
// A few honesty invariants are checked wherever they apply, whatever the shape:
//  · an object whose `gate` is not 'ok' carries no numeral: its `value` and `ci` must be null (rule 7);
//  · relationship-like objects obey the DB CHECKs binding evidence_status to origin (rule 5, D7);
//  · arcs drawn as feedback come only from feedback-capable relationship types, never from computed
//    similarity (rule 6); low/uncovered/pending tile cells carry no rate (rule 3).

import {
  ANNOTATION_KINDS, ANNOTATION_STATUS, ANNOTATION_TARGETS, BASES, CELL_STATES, CIPHER_STATUS, CORPUS_KINDS, DATE_ROLES,
  DECODERS, DOMAINS, DRIFT_METRICS, EVIDENCE_ROLES, EVIDENCE_STATUS, EXPRESSION_KINDS, EXPRESSION_STATES, FIELD_CLASSES,
  GATE_CODES, IMPORT_FORMATS, JOB_STATUS, LANE_FACETS, LANE_ORDERS, MODALITIES, ORIGINS, PASSAGE_FIELDS, PRECISIONS,
  PROVENANCE_QUALITY, QUALITIES, RATE_UNITS, REL_ACTIONS, REL_FAMILIES, REL_TYPE_BY_CODE, REVIEW_STATUS, RUN_STATUS,
  SAMPLINGS, SCORE_KINDS, SEVERITIES, STANCES, STRAND_TYPES, TAG_PROVENANCE, TAG_SCHEMES, TIERS, TIME_BASES,
  TIME_ROLES, UNITS, VARIANT_TYPES,
} from './vocab.mjs';

export const CONTRACT_VERSION = '1.3.0';

// ── Shape language ──────────────────────────────────────────────────────────────────────────────────
// 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'any' | 'null', unions with '|',
// 'string[]' etc., '@Name' / '@Name[]' for another shape; a plain object literal is a nested shape whose
// keys ending in '?' are optional; [spec] is an array of spec; the helpers below cover the rest.

/** @param {...unknown} values @returns {{$enum: unknown[]}} */
export const oneOf = (...values) => ({ $enum: values.flat() });
/** Object whose every value matches spec. */
export const mapOf = (spec) => ({ $map: spec });
/** Array whose every element matches spec. */
export const arrayOf = (spec) => ({ $array: spec });
/** null or spec. */
export const nullable = (spec) => ({ $nullable: spec });
/** Fixed-position array; `rest` validates any further elements. */
export const tuple = (specs, rest = null) => ({ $tuple: specs, $rest: rest });
/** spec plus a predicate returning error messages. */
export const refine = (spec, fn) => ({ $spec: spec, $refine: fn });

const enumOf = (list) => oneOf(...list);
const int = 'integer';
const str = 'string';
const bool = 'boolean';
const num = 'number';
const strN = 'string|null';
const intN = 'integer|null';
const numN = 'number|null';
const RATE_UNIT_NAMES = Object.keys(RATE_UNITS);

// ── Invariant helpers ───────────────────────────────────────────────────────────────────────────────

function relationshipRules(r) {
  const e = [];
  const st = r.evidence_status, origin = r.origin;
  if (st === 'documented') {
    if (origin !== 'source_dataset') e.push(`documented requires origin 'source_dataset' (got '${origin}')`);
    if (!r.source_dataset) e.push('documented requires source_dataset');
    if (!r.source_locator && r.provenance_quality !== 'source_unrecorded') {
      e.push("documented requires source_locator or provenance_quality 'source_unrecorded'");
    }
  }
  if (origin === 'source_dataset' && st !== 'documented') e.push("origin 'source_dataset' must be documented");
  if (st === 'computed' && origin !== 'algorithm') e.push("computed requires origin 'algorithm'");
  if (origin === 'algorithm' && (r.run_id === null || r.run_id === undefined || !r.method)) {
    e.push("origin 'algorithm' requires run_id and method");
  }
  if ((origin === 'machine_tagger' || origin === 'human') && st !== 'proposed') e.push(`origin '${origin}' must be proposed`);
  if (origin === 'machine_tagger' && !r.method) e.push("origin 'machine_tagger' requires method");
  if (origin === 'human' && typeof r.created_by === 'string' && !r.created_by.startsWith('human:')) {
    e.push("origin 'human' requires created_by 'human:<name>'");
  }
  if (r.rel_type !== undefined && !REL_TYPE_BY_CODE[r.rel_type]) e.push(`unknown rel_type '${r.rel_type}'`);
  return e;
}

function arcRules(a) {
  const e = [];
  const t = REL_TYPE_BY_CODE[a.rel_type];
  if (!t) e.push(`unknown rel_type '${a.rel_type}'`);
  if (a.feedback === true) {
    if (t && t.feedback_capable !== 1) e.push(`feedback arc from non-feedback-capable type '${a.rel_type}'`);
    if (a.evidence_status === 'computed') e.push('feedback arcs are never computed (similarity never establishes feedback)');
    if (a.date_conflict === true) e.push('a date conflict is never a feedback arc');
  }
  return e;
}

function cellRules(cell) {
  const [bin, n, , , denom, rate, lo, hi, state] = cell;
  const e = [];
  if (!CELL_STATES[state]) e.push(`unknown cell state ${state}`);
  if (state >= 3 && (rate !== null || lo !== null || hi !== null)) e.push(`state ${CELL_STATES[state]} carries no rate or CI`);
  if (state === 1 && !(n >= 1)) e.push('observed cell needs n ≥ 1');
  if (state === 2 && n !== 0) e.push('absent cell needs n = 0');
  if (state === 4 && denom !== 0) e.push('uncovered cell needs denom = 0');
  if (!(bin >= 0 && bin < 64)) e.push('bin index must be 0–63 within its tile');
  return e;
}

function dateParseRules(p) {
  const e = [];
  if ((p.precision === 'unknown') !== (p.lo_day === null)) e.push("precision 'unknown' iff lo_day is null");
  if (p.lo_day !== null && (p.hi_day === null || p.lo_day > p.hi_day)) e.push('lo_day must be ≤ hi_day');
  return e;
}

function anchorRequired(a) {
  const t = a.target?.type;
  return (t === 'passage' || t === 'occurrence') && !a.anchor ? [`a ${t} target needs an anchor`] : [];
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────

const Provenance = {
  data_version: int, run_ids: 'object', tokenizer: str, segmenter: str, synthetic: bool,
  collections: 'string[]', licenses: 'string[]',
};
const Score = nullable({ value: num, kind: enumOf(SCORE_KINDS) });
const JobRef = { job: { id: int } };
const Issue = refine({
  code: str, severity: enumOf(SEVERITIES), 'line?': intN, 'col?': intN, 'field?': strN,
  'value_excerpt?': strN, message: str, suggestion: str,
}, (i) => (i.message && i.suggestion ? [] : ['an issue needs a non-empty message and suggestion']));
const DateParse = refine({
  lo_day: intN, hi_day: intN, lo_year: intN, hi_year: intN, precision: enumOf(PRECISIONS),
  basis: enumOf(BASES), approx: int, rule: str, raw: strN, label: str, warnings: 'string[]',
}, dateParseRules);
const DateRow = {
  role: enumOf(DATE_ROLES), label: str, precision: enumOf(PRECISIONS), basis: enumOf(BASES),
  asserted_by: str, is_chronology: bool,
};
const Anchor = {
  doc_id: int, sha256: str, field: str, start: int, end: int, quote: str, 'prefix?': str, 'suffix?': str,
};
const Variant = {
  id: int, form: str, type: enumOf(VARIANT_TYPES), 'rule?': str, status: enumOf(EVIDENCE_STATUS),
  enabled: bool, n: intN,
};
const ImportSummary = {
  import_batch_id: int, collection: str,
  file: { name: str, sha256: str, bytes: int, encoding: str, format: enumOf(IMPORT_FORMATS), 'delimiter?': strN },
  rows: { seen: int, accepted: int, accepted_with_warnings: int, rejected: int },
  documents: { created: int, duplicates_flagged: int, metadata_only: int, translations: int },
  passages: int, tokens: int, dates: 'object', languages: mapOf(int),
  relationships: { documented: int, proposed: int, unresolved_targets: int },
  mapping_decisions: arrayOf({ target: str, 'from?': strN, 'transform?': strN, 'parse_rate?': numN, 'reason?': strN }),
  problems: { by_code: mapOf(int), first: '@Issue[]', download: str },
  'data_version?': intN, 'run_id?': intN, 'started_at?': strN, 'finished_at?': strN, 'duration_ms?': intN,
};
const ImportPreview = {
  format: enumOf(IMPORT_FORMATS), encoding: str, delimiter: strN, header: 'boolean|null',
  columns: arrayOf({ name: str, samples: 'array', inferred: str }),
  sample_rows: 'array', suggested_mapping: 'object', issues: '@Issue[]',
};
const Lane = {
  // 1.3.0: a context-group lane's label is {machine, human|null} (label_text is its sentence)
  key: str, label: 'string|object', unit: enumOf(RATE_UNIT_NAMES), modality: enumOf(MODALITIES),
  order_rule: enumOf(LANE_ORDERS), coverage: 'object', n: int, docs: int, first: 'object|null',
  last: 'object|null', undated: int, scheduled: int, undated_share: num,
  censor: { left: bool, right: bool }, synthetic: bool,
  // 1.3.0 (Term trail, context groups): optional
  'kind?': str, 'label_text?': str, 'cell_fields?': 'string[]', 'cell_gate?': int, 'bands?': 'array', 'mode?': str,
  'cluster_id?': intN, 'ord?': intN, 'run?': int, 'status?': str, 'tentative?': bool, 'stability?': numN,
};
/** 1.3.0 (C3): one OpenAlex cell of a share lane — k of n sampled works, Wilson CI; low cells carry no share. */
const ShareCell = refine({
  lo_year: int, hi_year: int, field: str, cell: str, k: int, n: int, 'n_cell?': int, share: numN, ci: nullable(tuple([num, num])),
  state: oneOf('observed', 'absent', 'low', 'uncovered'), 'owner?': bool, 'label?': str, 'text?': str,
}, (c) => {
  const e = [];
  if (c.k > c.n) e.push('k must not exceed n');
  if (c.lo_year > c.hi_year) e.push('lo_year after hi_year');
  if (c.state === 'low' || c.state === 'uncovered') {
    if (c.share !== null || c.ci !== null) e.push(`a ${c.state} cell carries no share or CI`);
    if (c.state === 'low' && !(c.n > 0 && c.n < 20)) e.push('low needs 0 < n < 20');
    if (c.state === 'uncovered' && c.n !== 0) e.push('uncovered needs n = 0');
  } else {
    if (c.n < 20) e.push('a share needs n ≥ 20');
    if (c.share === null || c.ci === null) e.push('an observed or absent cell carries its share and CI');
    else {
      if (Math.abs(c.share - c.k / c.n) > 1e-3) e.push('share must be k / n');
      if (!(c.ci[0] >= 0 && c.ci[0] <= c.share + 1e-9 && c.share <= c.ci[1] + 1e-9 && c.ci[1] <= 1)) e.push('CI must bracket the share inside [0, 1]');
    }
    if ((c.state === 'absent') !== (c.k === 0)) e.push('absent iff k = 0');
  }
  return e;
});
/** 1.3.0 (C4): arcs of a summary per (lane pair, bin pair), by evidence status. */
const ArcBucket = refine({
  src_lane: strN, dst_lane: strN, src_bin: int, dst_bin: int, n: int,
  by_status: { documented: int, computed: int, proposed: int },
}, (b) => (b.by_status.documented + b.by_status.computed + b.by_status.proposed === b.n ? [] : ['by_status must add up to n']));
const Cell = refine(tuple([int, int, int, int, num, numN, numN, numN, int, int, numN]), cellRules);
const Wash = {
  lane: str, strand: 'integer|string', lo: str, hi: str, precision: enumOf(PRECISIONS), label: str, n: int,
};
const Arc = refine({
  rel_id: int, rel_type: str, family: enumOf(REL_FAMILIES), evidence_status: enumOf(EVIDENCE_STATUS),
  'provenance_quality?': enumOf(PROVENANCE_QUALITY), 'review_status?': enumOf(REVIEW_STATUS), 'cue?': bool,
  src: { 'passage?': intN, 'doc?': intN, y: intN, 'lane?': strN }, dst: { 'passage?': intN, 'doc?': intN, y: intN, 'lane?': strN },
  feedback: bool, 'date_conflict?': bool, synthetic: bool,
}, arcRules);
const PassageDocument = {
  id: int, title: strN, author: strN, kind: str, dates: '@DateRow[]',
  date_card: { label: str, precision: enumOf(PRECISIONS), basis: enumOf(BASES), role: strN, notes: 'array' },
  collection: str, license: strN, is_translation: bool, synthetic: bool,
};
const Measure = { metric: enumOf(DRIFT_METRICS), gate: enumOf(GATE_CODES), value: numN };
const RelationshipCard = refine({
  id: int, rel_type: str, family: enumOf(REL_FAMILIES), directed: bool, evidence_status: enumOf(EVIDENCE_STATUS),
  origin: enumOf(ORIGINS), created_by: str, method: strN, run_id: intN, source_dataset: strN, source_locator: strN,
  provenance_quality: enumOf(PROVENANCE_QUALITY), review_status: enumOf(REVIEW_STATUS), score: Score,
  hypothesis_group: intN, date_conflict: bool, license: strN, attribution: strN,
  src: { ref: str, 'doc?': 'any', 'y?': intN }, dst: { ref: str, 'doc?': 'any', 'y?': intN },
  evidence: arrayOf({ id: int, role: enumOf(EVIDENCE_ROLES), 'passage?': intN, 'start?': intN, 'end?': intN, 'quote?': strN }),
  revisions: arrayOf({ rev: int, action: enumOf(REL_ACTIONS), actor: str, 'at?': str, 'reason?': strN, 'annotation_id?': intN }),
  annotations: 'integer[]', caution: str, synthetic: bool,
}, relationshipRules);
const Job = {
  id: int, type: str, status: enumOf(JOB_STATUS), progress: num, 'phase?': strN, 'message?': strN,
  'counts?': 'object|null', 'run_id?': intN, 'result?': 'any', 'error?': 'any', created_at: str,
  'started_at?': strN, 'finished_at?': strN,
};
const Annotation = {
  id: int, target: { type: enumOf(ANNOTATION_TARGETS), ref: str }, kind: enumOf(ANNOTATION_KINDS),
  author: str, is_machine: bool, 'method?': strN, status: enumOf(ANNOTATION_STATUS), rev: int, body_md: str,
  'layer?': strN, 'supersedes?': intN, 'anchor?': 'object|null', 'dimensions?': 'object', 'tags?': 'string[]',
  created_at: str, synthetic: bool,
};
const list = (item) => ({ items: arrayOf(item), 'cursor?': strN });

// ── 1.2.0 (M5 gate): STEMM adapters, claims, etymology, SSE events ──
/** An external attestation claim (Wiktionary): a statement quoted from a source, never an occurrence (§10.2). */
const Claim = {
  label: str, display: oneOf('default', 'dimmed'), reasons: 'string[]', 'year_lo?': intN, 'year_hi?': intN,
  'precision?': strN, 'date_text?': strN, 'relation?': strN, 'span?': strN, 'url?': strN, 'license?': strN, 'attribution?': strN,
};
/** The claim marker the Scroll draws left of a strand (Expression.claims). */
const ClaimMarker = {
  label: str, date: { lo_year: intN, hi_year: intN, label: strN }, display: oneOf('default', 'dimmed'), reasons: 'string[]',
  source: str, license: strN, 'attribution?': strN, 'relation?': strN, 'highlight?': nullable({ passage: int, start: int, end: int }),
};
/** State of a chained STEMM load (GET /api/adapters items' `load`). */
const AdapterLoad = {
  status: oneOf('running', 'done', 'cancelled', 'failed', 'interrupted'), 'phase?': strN, 'part?': intN, 'progress?': numN,
  'message?': strN, 'counts?': 'object', 'coverage?': 'object|null', 'resume?': str, 'error?': 'any',
};
const Etymon = { key: str, lang: str, form: str, roman: strN, gloss: strN, kind: oneOf('etymon', 'root') };

/**
 * Every response, request and canonical input shape, by name. See ENDPOINTS for which endpoint uses which.
 * @type {Record<string, unknown>}
 */
export const SHAPES = Object.freeze({
  // shared pieces
  Provenance, Issue, DateParse, DateRow, Anchor, Variant, Lane, Cell, Wash, Arc, Measure, Job, Annotation, ShareCell, ArcBucket,
  ImportSummary, ImportPreview, PassageDocument,
  ErrorBody: { error: { code: str, message: str, hint: strN, detail: 'any' } },
  GatedValue: refine({ gate: enumOf(GATE_CODES), 'needed?': 'any', 'have?': 'any', 'suggestion?': 'any', value: numN },
    (g) => (g.gate !== 'ok' && !('needed' in g && 'have' in g && 'suggestion' in g) ? ['a gate needs needed, have and suggestion'] : [])),
  JobRef,

  // WP0
  Health: {
    ok: bool, version: str, contract: str, dataVersion: int, dbBytes: int,
    jobs: { running: int, queued: int }, readPool: { size: int, busy: int }, adapters: 'object',
    cipher: { status: enumOf(CIPHER_STATUS), 'phase?': strN, 'progress?': numN, 'message?': strN },
    // 1.3.0 (final gate): the boot-time check of originals/ (server/db/integrity.mjs); absent in mock mode
    'integrity?': {
      status: oneOf('checking', 'ok', 'missing_originals', 'unknown'), 'checked_at?': str, 'files?': int, 'missing_files?': int,
      'size_mismatch?': int, 'referenced_missing?': int, 'documents_affected?': int, 'reason?': str,
      'sample?': arrayOf({ sha256: str, rel_path: str, problem: oneOf('missing', 'size'), documents: int }),
    },
  },
  JobList: list('@Job'),
  JobCancel: { status: oneOf('cancelling', 'cancelled', 'finished', 'not_found') },
  JobProgressEvent: { job: int, type: str, phase: strN, fraction: num, message: strN, 'counts?': 'object|null' },
  JobDoneEvent: { job: int, status: enumOf(JOB_STATUS), 'run_id?': intN, 'error?': 'any', 'result?': 'any' },
  // 1.2.0 (M5 gate): the other channels of GET /api/events (WP0 open item 7)
  DataEvent: { dataVersion: int },
  BootstrapEvent: { status: enumOf(CIPHER_STATUS), 'phase?': strN, 'progress?': numN, 'message?': strN, 'ready?': 'string[]' },
  AdapterEvent: { id: str, loaded: bool, staged: bool, message: strN, 'job?': intN, 'progress?': numN, 'status?': strN },

  // WP1 imports (§5.2, §5.7)
  ImportCreated: { import_batch_id: int, preview: '@ImportPreview' },
  ImportMappingRequest: { mapping: 'object' },
  ImportValidation: { validation: '@ImportSummary' },

  // WP2 sources
  Corpus: {
    slug: str, name: str, kind: enumOf(CORPUS_KINDS), synthetic: bool,
    collections: arrayOf({
      slug: str, name: str, domain: enumOf(DOMAINS), modality: enumOf(MODALITIES), unit: enumOf(UNITS),
      sampling: enumOf(SAMPLINGS), rate_eligible: bool, docs: int, tokens: int, works: int, undated: int,
      scheduled: int, span: 'array|null', selection_note: strN, caveats: 'array', license: strN, status: str,
      'synthetic?': bool,
      // 1.2.0: how the collection's documents are dated (counts by date basis; after_1928 = dated after the text seam)
      'dating?': { stated: int, estimated: int, derived: int, period: int, announced: int, undated: int, after_1928: int },
    }),
    // 1.3.0 (C2): a virtual corpus (`real`) lists its member corpora and has no collections of its own
    'virtual?': bool, 'members?': 'string[]', 'available?': bool, 'description?': strN,
  },
  Corpora: arrayOf('@Corpus'),
  Facets: { facets: mapOf(arrayOf({ value: str, label: str, count: int })), 'provenance?': '@Provenance' },
  Adapters: arrayOf({
    id: str, version: str, access: oneOf('local-file', 'local-dataset', 'network'), staged: 'object|null',
    license: str, loaded: bool, 'last_load?': 'any',
    // 1.2.0 (M5 gate): probe and chained-load state
    'label?': str, 'available?': bool, 'reason?': str, 'command?': str, 'caveats?': 'array', 'attribution?': strN,
    'enabled?': bool, 'loadable?': bool, 'note?': str, 'load?': AdapterLoad, 'job?': nullable({ id: int, status: enumOf(JOB_STATUS) }),
    'complete?': bool,
  }),
  // 1.2.0 (M5 gate): GET /api/adapters/:id/claims — an adapter's external claims for a word or a tracked expression
  AdapterClaims: refine({
    available: bool, adapter: str, license: str, attribution: str, note: str, 'word?': strN, 'lang?': strN,
    'expression?': intN, 'loaded?': bool, 'claims?': arrayOf(Claim), 'reason?': str, 'command?': strN,
  }, (c) => (c.available ? (Array.isArray(c.claims) ? [] : ['available claims need a claims list'])
    : (c.reason ? [] : ['unavailable claims need a reason']))),
  Baseline: refine({ available: bool, 'word?': str, 'lang?': strN, 'reason?': str, 'label?': str, 'attribution?': str, 'decades?': 'array', 'caveats?': 'array' },
    (b) => (b.available ? (b.label && b.attribution && Array.isArray(b.decades) ? [] : ['an available baseline needs label, attribution and decades'])
      : (b.reason ? [] : ['an unavailable baseline needs a reason']))),
  Tour: { steps: 'array' },

  // WP3 search, timeline, passages, exports
  Search: {
    query: {
      surface: str, norm: str, tokens: 'string[]', kind: enumOf(EXPRESSION_KINDS),
      variants: arrayOf({ form: str, type: enumOf(VARIANT_TYPES), 'rule?': str, status: enumOf(EVIDENCE_STATUS) }),
    },
    suggestions: arrayOf({ type: str, label: str, ref: str, count: intN }),
    expression: 'object|null',
    hits: { passages: int, documents: int, undated: int, names_excluded: int, preliminary: bool },
    kwic: 'array',
    titles: arrayOf({ document_id: int, title: str, kind: str, year: intN, synthetic: bool }),
    empty_note: strN,
    provenance: '@Provenance',
  },
  ExpressionRequest: { surface: str, 'lang?': strN, 'kind?': enumOf(EXPRESSION_KINDS), 'corpus?': strN },
  Expression: {
    expression: { id: int, surface: str, norm: str, kind: enumOf(EXPRESSION_KINDS), lang: strN, synthetic: bool },
    variants: '@Variant[]',
    state: { status: enumOf(EXPRESSION_STATES), 'job?': intN },
    // 1.2.0 (M5 gate): Wiktionary attestation claims written on this expression (never occurrences)
    'claims?': arrayOf(ClaimMarker),
    // 1.3.0 (C2): in a virtual corpus, the expression in each member corpus with its own state
    'members?': arrayOf({ corpus: str, id: int, state: 'object' }),
  },
  // 1.2.0 (M5 gate): GET /api/etymology?expr= — roots.tsv families of an expression's words (periods, not dates)
  Etymology: refine({
    available: bool, 'expression?': int, 'word?': strN, 'lang?': strN,
    'families?': arrayOf({ ...Etymon, parent_semantics: str, parents: arrayOf(Etymon), members: 'array' }),
    // 1.3.0 (C5): every listed root once, with the families that list it
    'roots?': arrayOf({ ...Etymon, families: 'string[]', is_family: bool }),
    'reason?': str, 'note?': strN, source: str,
  }, (e) => (e.available ? (Array.isArray(e.families) ? [] : ['an available etymology lists families']) : (e.reason ? [] : ['an unavailable etymology needs a reason']))),
  VariantsPatch: { variants: arrayOf({ id: int, enabled: bool }) },
  TimelineQueryRequest: {
    strands: arrayOf({ type: enumOf(STRAND_TYPES), ref: 'integer|string' }), corpus: str,
    lanes: { facet: enumOf(LANE_FACETS), order: enumOf(LANE_ORDERS), 'max?': int, 'run?': intN },
    'f?': str, 'toggles?': 'object', 'timeBasis?': enumOf(TIME_BASES), 'rev_cutoff?': intN,
  },
  TimelineQuery: refine({
    queryKey: str, dataVersion: int, status: str, job: intN,
    units: arrayOf({ unit: enumOf(RATE_UNIT_NAMES), lanes: 'string[]' }),
    lanes: '@Lane[]', other: { lanes: int, n: int }, extent: { from: strN, to: strN },
    totals: { n: int, dated: int, undated: int, scheduled: int, names_excluded: int, sampled: bool, washes_by_tier: mapOf(int),
      // fix pass: matches (text, abstracts) and works (titles, OpenAlex cells, relation endpoints) apart; n adds them only when
      // one unit is present (units_mixed false)
      'by_unit?': { matches: int, works: int }, 'units_mixed?': bool },
    seams: 'array', gates: 'object', provenance: '@Provenance',
    // 1.3.0 (C1): cluster lanes — why there are none (with the run to start, or the gate)
    'lane_state?': oneOf('ok', 'not_run', 'gated', 'unavailable', 'pending'), 'lane_note?': strN,
    'suggestion?': nullable({ run: { stage: str, params: 'object' } }), 'gate?': 'object', 'cluster?': 'object',
    // 1.3.0 (C2): the Term trail's absent lanes and what fell outside every lane; baseline and claims of a single word
    'trail?': { lanes: 'string[]', absent: arrayOf({ key: str, label: str, reason: str }), outside: mapOf(int), 'note?': str },
    'baseline?': nullable({ available: bool, href: strN, 'reason?': strN }), 'claims?': arrayOf(ClaimMarker), 'strand_extras?': 'object',
  }, (q) => {
    const e = [];
    if (q.lane_state === 'not_run' && q.lanes.length) e.push('lane_state not_run carries no lanes');
    if (q.lane_state === 'gated' && (!q.gate || q.gate.gate === 'ok' || q.lanes.length)) e.push('a gated lane state carries its gate and no lanes');
    return e;
  }),
  Tiles: {
    queryKey: str, tier: enumOf(TIERS), binWidth: numN, dataVersion: int,
    tiles: arrayOf({
      tile: int, bin0: int,
      lanes: mapOf({ strands: mapOf('@Cell[]') }),
      coverage: mapOf(arrayOf(tuple([int, int, int, int, int]))),
      washes: '@Wash[]',
      // 1.2.0: first/last observed day per bin, days[lane][strand] = [[binIndexInTile, lo_day, hi_day]]
      'days?': mapOf(mapOf(arrayOf(tuple([int, int, int])))),
      // 1.3.0 (C3): OpenAlex share cells, cells[lane][strand] = cells overlapping the tile's years (owner: its first year here)
      'cells?': mapOf(mapOf(arrayOf(ShareCell))),
    }),
  },
  Marks: {
    marks: arrayOf({
      occ: intN, passage: int, doc: int, lane: str, strand: 'integer|string', lo_day: int, hi_day: int,
      precision: enumOf(PRECISIONS), basis: enumOf(BASES), kind: str, name_flag: bool, synthetic: bool,
    }),
    truncated: bool, total: int,
  },
  Arcs: refine({
    total: int, returned: int, hidden: mapOf(int), items: '@Arc[]', bundles: 'array',
    // 1.2.0 (M5 gate): tier budget, the "+N more arcs (filtered)" chip, re-reading halos and annotated feedback
    'budget?': int, 'chip?': nullable({ count: int, label: str }), 'halos?': 'array', 'annotated?': 'array', 'scope?': str,
    // 1.3.0 (C4): individual (≤ 1,500 arcs in range) or summary (buckets + ≤ 300 individual arcs)
    'mode?': oneOf('individual', 'summary'), 'buckets?': arrayOf(ArcBucket), 'individual?': '@Arc[]', 'candidates?': int,
    'bucket_level?': int, 'detail?': bool,
  }, (a) => {
    if (a.mode !== 'summary') return [];
    const e = [];
    if (!Array.isArray(a.buckets) || !Array.isArray(a.individual)) e.push('a summary carries buckets and individual arcs');
    else {
      if (a.buckets.reduce((s, b) => s + b.n, 0) !== a.total) e.push('summary buckets must add up to total');
      if (a.individual.length > 300) e.push('a summary draws at most 300 individual arcs');
    }
    return e;
  }),
  Shelf: { which: oneOf('undated', 'scheduled', 'washes'), total: int, items: 'array', 'cursor?': strN },
  BinDrawer: { denominator: 'object', rows: 'array', 'cursor?': strN },
  Passage: refine({
    id: int, field: enumOf(PASSAGE_FIELDS), start: int, end: int, text: str,
    'before?': 'object|null', 'after?': 'object|null',
    highlights: arrayOf({ start: int, end: int, 'expr?': intN, 'occ?': intN, 'variant?': strN }),
    lang: str, quality: enumOf(QUALITIES), time_role: enumOf(TIME_ROLES), document: '@PassageDocument',
    anchor: { doc_id: int, sha256: str, field: str, start: int, end: int },
    'machine?': 'array', 'relationships?': 'object', 'annotations?': int, synthetic: bool,
  }, (p) => {
    const e = [];
    if (p.start > p.end) e.push('passage start > end');
    for (const h of p.highlights) if (h.start < 0 || h.end > p.text.length || h.start >= h.end) e.push(`highlight ${h.start}–${h.end} outside the passage text`);
    return e;
  }),
  Document: {
    id: int, ext_id: str, kind: str, title: strN, collection: str, has_full_text: bool, dates: '@DateRow[]',
    'date_card?': 'object', tags: 'array', aliases: 'array', synthetic: bool,
  },
  DocumentText: { document_id: int, from: int, to: int, text: str, length: int },
  // 1.1.0 (M1 gate): an occurrence id → its passage, so a reloaded `sel=occ:N` opens the passage (offsets as in Passage.start)
  Occurrence: { id: int, passage: int, doc: int, expr: int, start: int, end: int, name_flag: bool, run_id: int, synthetic: bool },
  Kwic: {
    rows: arrayOf({ passage: int, doc: int, start: int, end: int, left: str, match: str, right: str, synthetic: bool }),
    'total?': int, 'cursor?': strN,
    // 1.2.0: what the rows were drawn from (null while a large corpus's slice cube is still being built)
    'denominator?': nullable({ 'tokens?': intN, 'works?': intN, 'docs?': intN, 'from?': intN, 'to?': intN, 'lane?': strN, 'note?': strN }),
  },
  // 1.1.0 (M1 gate, WP0 open item 7): the manifest that opens every export (JSON object, first JSONL line, CSV '#' block; §7.3)
  ExportManifest: {
    export_version: str, generated_at: str, view: strN, state: strN, data_version: int, run_ids: 'object',
    filters: 'string|object', toggles: 'object', synthetic_included: bool, licenses: 'string[]', attributions: 'string[]',
  },
  SnapshotRequest: { 'view?': strN, 'png?': str, 'svg?': str },
  Snapshot: { file: str, 'url?': str },

  // WP4 analysis
  CompareRequest: {
    expr: 'integer[]', a: { years: tuple([int, int]), 'f?': str }, b: { years: tuple([int, int]), 'f?': str },
    'measures?': 'string[]',
    // RF-2 (ref-freeze-1, additive): a saved view opened as saved sends its pins and cutoffs, as the timeline query does
    'runs?': { 'materialize?': 'object', 'cluster?': int }, 'cutoffs?': { 'import_batch?': int, 'at?': str, 'annotation_rev?': int },
  },
  Compare: {
    multiplicity: { k: int, notable_so_far: int, threshold_percentile: num },
    coverage: { a: 'object', b: 'object', composition_jsd: numN, caveats: 'string[]', modality_gate: enumOf(GATE_CODES), 'prominence?': 'object' },
    freq: 'object', passages: { a: 'array', b: 'array', seed: int }, collocates: 'object', clusters: 'object|null',
    measures: '@Measure[]', tone: 'object', 'human?': 'object', coverage_note: strN, provenance: '@Provenance',
    // 1.3.0 (final gate): Spearman ρ of the strand's per-decade rate against the Ngram baseline (§10.2)
    'baseline_rho?': '@BaselineRho',
    // RF-2 (ref-freeze-1, additive): present only for a comparison computed as saved — the pins and cutoffs it used
    'as_saved?': { runs: 'object', cutoffs: 'object', note: str },
  },
  /**
   * 1.3.0 (final gate): Compare's external-baseline correlation. Not possible → {available: false, reason}; possible →
   * a gate: ok carries ρ and its CI, any other gate carries no numeral (the generic rule) and needed/have/suggestion.
   */
  BaselineRho: refine({
    available: bool, 'reason?': str, 'note?': strN, 'gate?': enumOf(GATE_CODES), 'value?': numN, 'ci?': nullable(tuple([num, num])),
    'n_bins?': int, 'span?': nullable(tuple([int, int])), 'years?': tuple([int, int]), 'unit?': str, 'forms?': 'string[]',
    'forms_missing?': 'string[]', 'label?': strN, 'attribution?': strN, 'license?': strN, 'method?': str, 'text?': str,
    'series?': arrayOf({ decade: int, slice: oneOf('a', 'b'), n: int, tokens: int, rate: numN, low_coverage: bool,
      baseline_per_million: numN, volumes: int, thin: bool, shared: bool }),
  }, (b) => {
    const e = [];
    if (!b.available) {
      if (!b.reason) e.push('an unavailable baseline correlation states its reason');
      if (b.value !== undefined && b.value !== null) e.push('an unavailable baseline correlation carries no value');
      return e;
    }
    if (!b.gate) e.push('an available baseline correlation carries its gate');
    if (!Number.isInteger(b.n_bins)) e.push('an available baseline correlation counts its decades (n_bins)');
    if (b.gate === 'ok' && typeof b.value !== 'number') e.push('ρ is a number when the gate is ok');
    if (b.gate && b.gate !== 'ok' && !('needed' in b && 'have' in b && 'suggestion' in b)) e.push('a gated correlation names needed, have and suggestion');
    for (const r of b.series ?? []) if (r.low_coverage && r.rate !== null) e.push(`decade ${r.decade} is below the rate gate and carries a rate`);
    return e;
  }),
  Collocations: refine({ gate: enumOf(GATE_CODES), 'collocates?': 'array', 'needed?': 'any', 'have?': 'any', 'suggestion?': 'any' },
    (c) => (c.gate === 'ok' && !Array.isArray(c.collocates) ? ['collocates required when the gate is ok'] : [])),
  Clusters: refine({ gate: enumOf(GATE_CODES), 'run?': intN, 'representation?': strN, 'clusters?': 'array', 'transitions?': 'array',
    // 1.2.0 (M5 gate): additive fields of the real clustering runs
    'expression?': 'any', 'k?': intN, 'seed?': intN, 'windows?': 'array', 'shares?': 'array', 'convergence?': 'any', 'n?': intN,
    'docs?': intN, 'note?': strN, 'newer_run?': intN },
    (c) => (c.gate === 'ok' && !Array.isArray(c.clusters) ? ['clusters required when the gate is ok'] : [])),
  AnalysisRunRequest: { stage: str, 'params?': 'object', 'expr?': intN },
  AnalysisRunStarted: { job: { id: int }, 'run?': intN, 'reused?': bool },
  AnalysisRuns: list({
    id: int, stage: str, status: enumOf(RUN_STATUS), pipeline_version: str, params: 'object',
    started_at: str, 'finished_at?': strN, 'representation?': strN,
  }),
  Constellation: {
    nodes: arrayOf({ id: str, type: str, label: str, size: 'object', pos: 'number[]', present: 'object' }),
    edges: arrayOf({ s: str, t: str, kind: str, weight: 'object', measure: strN }),
    legend: 'object', layout: { key: str, algorithm: str, pinned: bool }, truncated: 'object',
    // 1.2.0 (M5 gate): additive (periods, presence diff, gates of gated edges)
    'periods?': 'object', 'diff?': 'object|null', 'gates?': 'object',
  },

  // WP5 lineage and provenance
  Lineage: {
    root: str,
    nodes: arrayOf({ id: str, label: str, 'type?': str, 'synthetic?': bool }),
    edges: arrayOf(refine({
      rel_id: int, src: str, dst: str, rel_type: str, family: enumOf(REL_FAMILIES),
      evidence_status: enumOf(EVIDENCE_STATUS), review_status: enumOf(REVIEW_STATUS), score: Score,
      method: strN, run_id: intN, hypothesis_group: intN, date_conflict: bool, synthetic: bool,
    }, (x) => (REL_TYPE_BY_CODE[x.rel_type] ? [] : [`unknown rel_type '${x.rel_type}'`]))),
    groups: arrayOf({ id: int, question: str, edges: 'integer[]' }),
    truncated: { nodes: int, reason: strN },
  },
  LineagePath: { path: 'array', cost: num, weakest: nullable(enumOf(EVIDENCE_STATUS)) },
  Genealogy: {
    seed: { doc: int, title: str, maker: strN, year: intN },
    generations: arrayOf({
      gen: int, total: int, returned: int, by_decade: mapOf(int),
      rows: arrayOf({
        doc: int, title: str, maker: strN, date: 'object',
        edges: arrayOf({ rel_id: int, rel_type: str, evidence_status: enumOf(EVIDENCE_STATUS), source_dataset: strN, locator: strN }),
      }),
    }),
    truncated: 'object', note: str,
  },
  Relationship: RelationshipCard,
  RelationshipRequest: { src: str, dst: str, rel_type: str, evidence: 'array', note: str, 'group?': intN },
  ReviewRequest: refine({ action: oneOf('confirm', 'reject', 'dispute'), note: str },
    (r) => (r.note.trim().length >= 10 ? [] : ['a review note needs at least 10 characters'])),
  Review: { review_status: enumOf(REVIEW_STATUS), revision: int, annotation_id: int },
  HypothesisGroup: { id: int, question: str, target: str, hypotheses: 'array', synthetic: bool },
  HypothesisGroupRequest: { target: str, question: str },
  Created: { id: int },
  TraceRequest: { passage: int, start: int, end: int },
  Trace: refine({ status: str, 'exact?': 'array', 'near?': 'array', 'similar_wording?': 'array',
    'created_relationships?': 'integer[]', 'job?': 'object', note: str,
    // 1.2.0: the near-quote index used, and why a widely shared span lists matches without making links
    'near_index?': nullable({ run: int }), 'exclusion?': nullable({ kind: oneOf('structure', 'widely_shared', 'production_line'), note: str, 'documents?': int }) },
  (t) => (t.status === 'done' ? (Array.isArray(t.exact) && Array.isArray(t.near) ? [] : ['a done trace lists exact and near'])
    : (t.job ? [] : ['an unfinished trace returns its job']))),
  AnnotationRequest: refine({
    target: { type: enumOf(ANNOTATION_TARGETS), ref: str }, 'anchor?': '@Anchor', kind: enumOf(ANNOTATION_KINDS),
    body_md: str, 'dimensions?': 'object', 'tags?': 'string[]', 'evidence_refs?': 'array', 'layer?': strN,
    'stance?': nullable(enumOf(STANCES)),
  }, anchorRequired),
  AnnotationPatch: { body_md: str, 'reason?': strN, 'dimensions?': 'object', 'tags?': 'string[]' },
  AnnotationRev: { id: int, rev: int },
  AnnotationReinterpreted: { id: int, supersedes: int },
  Annotations: list('@Annotation'),
  AnnotationRevisions: arrayOf({ rev: int, body_md: str, dimensions: 'object', tags: 'string[]', author: str, at: str, reason: strN }),
  ViewRequest: { name: str, state: 'object', 'comparisons_tried?': int, 'description?': strN },
  ViewSaved: { slug: str, url: str, dataVersion: int, runIds: 'object' },
  View: {
    slug: str, state: 'object', savedAt: str, dataVersion: int, currentDataVersion: int,
    drift: { dataChanged: bool, importsSince: 'array', 'revertedSince?': 'array', asSavedAvailable: bool, newerRuns: 'array', message: strN },
  },
  Views: list({ slug: str, name: str, savedAt: str, dataVersion: int }),

  // Canonical inputs (§12.3)
  CanonicalDocument: refine({
    ext_id: str, kind: str, 'title?': strN, 'native_title?': strN, 'author?': strN, 'genre?': strN, 'community?': strN,
    'culture?': strN, 'field?': strN, 'lang_declared?': strN, 'source_url?': strN, 'license?': strN, 'prominence?': numN,
    'text?': {
      original: str, decoder: enumOf(DECODERS), 'body_start?': int, 'body_end?': int,
      'regions?': arrayOf({ start: int, end: int, 'quality?': enumOf(QUALITIES), 'time_role?': enumOf(TIME_ROLES),
        'field_class?': enumOf(FIELD_CLASSES) }),
      'mode?': oneOf('auto', 'prose', 'verse'),
    },
    'fields?': { 'title?': str, 'native_title?': str, 'summary?': str, 'abstract?': str, 'gloss?': str, 'entry?': str },
    'field_roles?': { 'summary?': oneOf('describes', 'document'), 'abstract?': oneOf('describes', 'document') },
    dates: arrayOf({ role: enumOf(DATE_ROLES), 'raw?': strN, 'parsed?': '@DateParse', asserted_by: str,
      'is_chronology?': bool, 'note?': strN }),
    'aliases?': arrayOf({ ext_id: str, 'title?': strN, 'note?': strN }),
    'tags?': arrayOf({ scheme: enumOf(TAG_SCHEMES), value: str, 'weight?': numN, provenance: enumOf(TAG_PROVENANCE), method: str }),
    original_meta: 'object',
    'source_file?': { sha256: str, byte_start: int, byte_end: int },
  }, (d) => {
    const e = [];
    if (d.dates.filter((x) => x.is_chronology).length > 1) e.push('at most one date may be the chronology');
    for (const x of d.dates) if (x.raw === undefined && !x.parsed) e.push(`date '${x.role}' needs raw or parsed`);
    const t = d.text;
    if (t) {
      const n = t.original.length;
      const bs = t.body_start ?? 0, be = t.body_end ?? n;
      if (!(bs >= 0 && bs <= be && be <= n)) e.push('text body bounds outside the original');
      for (const r of t.regions ?? []) if (!(r.start >= 0 && r.start <= r.end && r.end <= n)) e.push(`region ${r.start}–${r.end} outside the original`);
    }
    return e;
  }),
  CanonicalRelationship: refine({
    src: 'object', dst: 'object', rel_type: str, evidence_status: enumOf(EVIDENCE_STATUS), origin: enumOf(ORIGINS),
    'source_dataset?': strN, 'source_locator?': strN, 'provenance_quality?': enumOf(PROVENANCE_QUALITY), 'method?': strN,
    'run_id?': intN, created_by: str, 'score?': Score, 'hypothesis_group?': nullable({ key: str, question: str }),
    'evidence?': arrayOf({ role: enumOf(EVIDENCE_ROLES), 'ext_id?': strN, 'passage?': 'any', 'start?': intN, 'end?': intN, 'quote?': strN }),
    'license?': strN, 'attribution?': strN, 'provenance_note?': strN,
  }, (r) => {
    const e = relationshipRules(r);
    for (const end of ['src', 'dst']) if (!r[end].ext_id && !r[end].ref) e.push(`${end} needs ext_id or ref`);
    return e;
  }),
  CanonicalAnnotation: refine({
    target: { type: enumOf(ANNOTATION_TARGETS), 'ext_id?': strN, 'ref?': strN },
    'anchor?': { field: str, start: int, end: int, quote: str }, kind: enumOf(ANNOTATION_KINDS), author: str,
    is_machine: bool, 'method?': strN, 'run_id?': intN, 'layer?': strN, body_md: str, 'stance?': nullable(enumOf(STANCES)),
    'dimensions?': 'object', 'tags?': 'string[]', 'evidence_refs?': 'array', 'supersedes_key?': strN,
  }, (a) => [...anchorRequired(a), ...(a.is_machine && !a.method ? ['machine annotations need a method'] : [])]),

  // Front end (§8.2)
  ViewState: {
    v: int, corpus: str, strands: 'array', lanes: 'object', f: 'object', toggles: 'object', timeBasis: enumOf(TIME_BASES),
    axis: 'object', tier: str, vantage: { day: int, strict: bool }, range: 'array|null', evidence: 'object',
    layers: 'object', selection: 'object|null', panels: 'object', compare: 'object|null', constellation: 'object',
    lineage: 'object', runs: 'object', asSaved: bool, reducedMotion: str,
  },
});

/**
 * Endpoint → shapes (§7.1). `response` validates the JSON body; `request` the JSON request body.
 * Mock fixtures live at tests/contract/<METHOD>__<path without its leading '/', '/' → '_', ':id' → '{id}'>.json
 * (GET /api/passages/:id → GET__api_passages_{id}.json; see fixtureFileName in server/http/mock.mjs). Seven
 * more §7.1 endpoints whose bodies are streams, downloads or 204 have fixtures too (EXTRA_ENDPOINTS in
 * tests/helpers/shape.mjs).
 */
export const ENDPOINTS = Object.freeze([
  ['GET', '/api/health', null, 'Health', 'WP0'],
  ['GET', '/api/jobs', null, 'JobList', 'WP0'],
  ['GET', '/api/jobs/:id', null, 'Job', 'WP0'],
  ['POST', '/api/jobs/:id/cancel', null, 'JobCancel', 'WP0'],
  ['POST', '/api/imports', null, 'ImportCreated', 'WP1'],
  ['GET', '/api/imports/:id/preview', null, 'ImportPreview', 'WP1'],
  ['PUT', '/api/imports/:id/mapping', 'ImportMappingRequest', 'ImportValidation', 'WP1'],
  ['POST', '/api/imports/:id/commit', 'ImportMappingRequest', 'JobRef', 'WP1'],
  ['POST', '/api/imports/:id/revert', null, 'JobRef', 'WP1'],
  ['GET', '/api/corpora', null, 'Corpora', 'WP2'],
  ['GET', '/api/facets', null, 'Facets', 'WP2'],
  ['GET', '/api/adapters', null, 'Adapters', 'WP2'],
  ['POST', '/api/adapters/:id/load', null, 'JobRef', 'WP2'],
  ['GET', '/api/adapters/:id/claims', null, 'AdapterClaims', 'WP2'],
  ['GET', '/api/baseline', null, 'Baseline', 'WP2'],
  ['GET', '/api/tour', null, 'Tour', 'WP2'],
  ['GET', '/api/search', null, 'Search', 'WP3'],
  ['POST', '/api/expressions', 'ExpressionRequest', 'Expression', 'WP3'],
  ['GET', '/api/expressions/:id', null, 'Expression', 'WP3'],
  ['PATCH', '/api/expressions/:id/variants', 'VariantsPatch', 'Expression', 'WP3'],
  ['POST', '/api/timeline/query', 'TimelineQueryRequest', 'TimelineQuery', 'WP3'],
  ['GET', '/api/timeline/tiles', null, 'Tiles', 'WP3'],
  ['GET', '/api/timeline/marks', null, 'Marks', 'WP3'],
  ['GET', '/api/timeline/arcs', null, 'Arcs', 'WP3'],
  ['GET', '/api/timeline/shelf', null, 'Shelf', 'WP3'],
  ['GET', '/api/timeline/bin', null, 'BinDrawer', 'WP3'],
  ['GET', '/api/passages/:id', null, 'Passage', 'WP3'],
  ['GET', '/api/documents/:id', null, 'Document', 'WP3'],
  ['GET', '/api/documents/:id/text', null, 'DocumentText', 'WP3'],
  ['GET', '/api/occurrences/:id', null, 'Occurrence', 'WP3'],
  ['GET', '/api/kwic', null, 'Kwic', 'WP3'],
  ['GET', '/api/etymology', null, 'Etymology', 'WP3'],
  ['POST', '/api/snapshots', 'SnapshotRequest', 'Snapshot', 'WP3'],
  ['POST', '/api/compare', 'CompareRequest', 'Compare', 'WP4'],
  ['GET', '/api/collocations', null, 'Collocations', 'WP4'],
  ['GET', '/api/clusters', null, 'Clusters', 'WP4'],
  ['POST', '/api/analysis/runs', 'AnalysisRunRequest', 'AnalysisRunStarted', 'WP4'],
  ['GET', '/api/analysis/runs', null, 'AnalysisRuns', 'WP4'],
  ['GET', '/api/constellation', null, 'Constellation', 'WP4'],
  ['GET', '/api/lineage', null, 'Lineage', 'WP5'],
  ['GET', '/api/lineage/path', null, 'LineagePath', 'WP5'],
  ['GET', '/api/genealogy', null, 'Genealogy', 'WP5'],
  ['GET', '/api/relationships/:id', null, 'Relationship', 'WP5'],
  ['POST', '/api/relationships', 'RelationshipRequest', 'Created', 'WP5'],
  ['POST', '/api/relationships/:id/review', 'ReviewRequest', 'Review', 'WP5'],
  ['POST', '/api/relationships/:id/evidence', null, 'Created', 'WP5'],
  ['GET', '/api/hypothesis-groups/:id', null, 'HypothesisGroup', 'WP5'],
  ['POST', '/api/hypothesis-groups', 'HypothesisGroupRequest', 'Created', 'WP5'],
  ['POST', '/api/trace', 'TraceRequest', 'Trace', 'WP5'],
  ['GET', '/api/annotations', null, 'Annotations', 'WP5'],
  ['POST', '/api/annotations', 'AnnotationRequest', 'AnnotationRev', 'WP5'],
  ['PATCH', '/api/annotations/:id', 'AnnotationPatch', 'AnnotationRev', 'WP5'],
  ['POST', '/api/annotations/:id/reinterpret', 'AnnotationRequest', 'AnnotationReinterpreted', 'WP5'],
  ['POST', '/api/annotations/:id/withdraw', null, 'AnnotationRev', 'WP5'],
  ['GET', '/api/annotations/:id/revisions', null, 'AnnotationRevisions', 'WP5'],
  ['POST', '/api/views', 'ViewRequest', 'ViewSaved', 'WP5'],
  ['GET', '/api/views', null, 'Views', 'WP5'],
  ['GET', '/api/views/:slug', null, 'View', 'WP5'],
].map(([method, path, request, response, owner]) => Object.freeze({ method, path, request, response, owner })));

// ── Validator ───────────────────────────────────────────────────────────────────────────────────────

const MAX_ERRORS = 50;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function primitiveOk(t, v) {
  switch (t) {
    case 'any': return v !== undefined;
    case 'null': return v === null;
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isSafeInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isPlain(v);
    case 'array': return Array.isArray(v);
    default: return null;
  }
}

function validateAlt(alt, v, path, errs) {
  if (alt.startsWith('@')) {
    const many = alt.endsWith('[]');
    const name = many ? alt.slice(1, -2) : alt.slice(1);
    if (!(name in SHAPES)) { errs.push(`${path}: unknown shape '${name}'`); return; }
    validate(many ? arrayOf(SHAPES[name]) : SHAPES[name], v, path, errs);
    return;
  }
  if (alt.endsWith('[]')) { validate(arrayOf(alt.slice(0, -2)), v, path, errs); return; }
  const okP = primitiveOk(alt, v);
  if (okP === null) errs.push(`${path}: unknown type '${alt}' in shape`);
  else if (!okP) errs.push(`${path}: expected ${alt}, got ${typeName(v)}`);
}

function validate(spec, v, path, errs) {
  if (errs.length >= MAX_ERRORS) return;
  if (typeof spec === 'string') {
    const alts = spec.split('|');
    if (alts.length === 1) { validateAlt(alts[0], v, path, errs); return; }
    let best = null;
    for (const alt of alts) {
      const e = [];
      validateAlt(alt, v, path, e);
      if (!e.length) return;
      if (alt.startsWith('@') && isPlain(v) || alt.endsWith('[]') && Array.isArray(v)) best = e;
    }
    errs.push(...(best ?? [`${path}: expected ${spec}, got ${typeName(v)}`]));
    return;
  }
  if (Array.isArray(spec)) { validate(arrayOf(spec[0]), v, path, errs); return; }
  if ('$enum' in spec) {
    if (!spec.$enum.includes(v)) errs.push(`${path}: expected one of ${spec.$enum.join('|')}, got ${JSON.stringify(v)}`);
    return;
  }
  if ('$nullable' in spec) { if (v !== null) validate(spec.$nullable, v, path, errs); return; }
  if ('$array' in spec) {
    if (!Array.isArray(v)) { errs.push(`${path}: expected array, got ${typeName(v)}`); return; }
    v.forEach((x, i) => validate(spec.$array, x, `${path}[${i}]`, errs));
    return;
  }
  if ('$map' in spec) {
    if (!isPlain(v)) { errs.push(`${path}: expected object, got ${typeName(v)}`); return; }
    for (const [k, x] of Object.entries(v)) validate(spec.$map, x, `${path}.${k}`, errs);
    return;
  }
  if ('$tuple' in spec) {
    if (!Array.isArray(v)) { errs.push(`${path}: expected array, got ${typeName(v)}`); return; }
    if (v.length < spec.$tuple.length || (!spec.$rest && v.length > spec.$tuple.length)) {
      errs.push(`${path}: expected ${spec.$tuple.length} elements, got ${v.length}`);
      return;
    }
    v.forEach((x, i) => validate(i < spec.$tuple.length ? spec.$tuple[i] : spec.$rest, x, `${path}[${i}]`, errs));
    return;
  }
  if ('$refine' in spec) {
    const before = errs.length;
    validate(spec.$spec, v, path, errs);
    if (errs.length === before) for (const m of spec.$refine(v)) errs.push(`${path}: ${m}`);
    return;
  }
  if (!isPlain(v)) { errs.push(`${path}: expected object, got ${typeName(v)}`); return; }
  for (const [rawKey, sub] of Object.entries(spec)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    if (v[key] === undefined) {
      if (!optional) errs.push(`${path}.${key}: missing`);
      continue;
    }
    validate(sub, v[key], `${path}.${key}`, errs);
  }
}

/** Gated objects anywhere in a payload carry no numeral (honesty rule 7). */
function gateNumerals(v, path, errs) {
  if (errs.length >= MAX_ERRORS || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.forEach((x, i) => gateNumerals(x, `${path}[${i}]`, errs)); return; }
  if (typeof v.gate === 'string' && v.gate !== 'ok' && GATE_CODES.includes(v.gate)) {
    for (const k of ['value', 'ci', 'ci_lo', 'ci_hi', 'null_percentile']) {
      if (k in v && v[k] !== null) errs.push(`${path}.${k}: gated (${v.gate}) but carries a value`);
    }
  }
  for (const [k, x] of Object.entries(v)) gateNumerals(x, `${path}.${k}`, errs);
}

/**
 * Validate an object against a named shape.
 * @param {string} shapeName a key of SHAPES
 * @param {unknown} obj
 * @returns {string[]} [] when valid, else messages like "$.lanes[0].unit: expected one of …"
 */
export function check(shapeName, obj) {
  if (!(shapeName in SHAPES)) return [`unknown shape '${shapeName}'`];
  const errs = [];
  validate(SHAPES[shapeName], obj, '$', errs);
  gateNumerals(obj, '$', errs);
  return errs.slice(0, MAX_ERRORS);
}
