// OWNER: WP3
// query.mjs — canonical timeline queries (SPEC §7.1 POST /api/timeline/query): a request becomes a canonical
// `def` (strands with their pinned runs, corpus, lanes, filters, toggles) whose hash is the queryKey; every tile,
// mark, shelf, bin and export of that key reads the SAME slice, built here once (`sliceWhere`), so numerators
// and denominators can never drift apart.
//
// The slice: documents of the corpus that are not deleted, in rate-eligible collections, passing the `f` filters
// and the toggles (translations, duplicates, estimated dates, synthetic); passage-level rows (expr_doc,
// doc_tokens, passage) in the counted field classes (text, title, abstract; + describes / apparatus when
// toggled) and in the strand's languages — an unidentified row of a document's running text counts in its document's
// text language (RF-1, langgate.mjs). Boilerplate, furniture and other non-'ok' passages never enter
// expr_doc or doc_tokens, so they are outside every count (reported under totals.excluded).

import { createHash } from 'node:crypto';
import { fitsDays, LEVELS, yearLabel } from '../../src/shared/dates.mjs';
import { canonicalJson, slugify } from '../../src/shared/ids.mjs';
import { TOKENIZER_VERSION } from '../../src/shared/tokenize.mjs';
import { formatFilter, parseFilter } from '../../src/shared/viewstate.mjs';
import { LANE_FACETS, LANE_ORDERS, STRAND_TYPES, TIME_BASES, TOGGLE_DEFAULTS } from '../../src/shared/vocab.mjs';
import { dataVersion, stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { SEGMENTER_VERSION } from '../text/segment.mjs';
import { facetSql, laneKey, laneLabel, NONE, orderLanes, orderNote, parseLaneKey, rowCols, selectionNote, trailValueSql,
  unitClassSql } from './lanes.mjs';
import { expressionClaims, freshness, getExpression, strandLanguages, variantsOf } from './materialize.mjs';
import { langAdmits, langAdmitsSql } from './langgate.mjs';
import { laneGate, RATE_UNIT_OF_CLASS } from './rates.mjs';
import { seamsFor } from './seams.mjs';
import { sliceCoverage, sliceGateRows } from './cube.mjs';
export { langsForCorpus } from './cube.mjs';
import { labelsForRef, peekLabelIndex } from './tagindex.mjs';
import { resolveCorpusScope, siblingExpressions } from './scope.mjs';
import { groupCaseSql, memberJoinSql, resolveClusterRun } from './clusterlanes.mjs';
import { shareCells, SHARE_GATE, SHARE_LANE_NOTE, strandExtras, trailLanesOf } from './trail.mjs';
import { groupLanes } from './clusterlanes.mjs';

/** Version of the canonical def (part of every queryKey). 2 = contract 1.3.0: corpus scopes, member strands, trail and cluster lanes. */
export const QUERY_VERSION = 2;
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const DEFAULT_MAX_LANES = 10;
const FILTER_COLUMNS = { kind: 'd.kind', coll: 'c.slug', culture: 'd.culture', field: 'd.field', community: 'd.community', basis: 'd.basis' };
const bad = (message, detail = null, hint = null) => new HttpError(400, 'E_VALIDATION', message, hint, detail);
/** A UTC instant as nowIso() writes it (deleted_at, saved_view.created_at), so string comparison orders them. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ── request → def ───────────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalize a POST /api/timeline/query body (§7.2). `f` may be the filter grammar string or a
 * ViewState.f object; toggles default to vocab.TOGGLE_DEFAULTS.
 * @param {object} body
 * @returns {{strands: Array<{type: string, ref: number|string}>, corpus: string, lanes: object, f: object, toggles: object,
 *   timeBasis: string, runs: object}}
 * @throws {HttpError} 400 E_VALIDATION
 */
export function canonicalRequest(body) {
  if (!body || typeof body !== 'object') throw bad('The request body must be a JSON object.');
  if (typeof body.corpus !== 'string' || !body.corpus) throw bad('corpus is required.', { field: 'corpus' });
  const strands = Array.isArray(body.strands) ? body.strands : null;
  if (!strands || !strands.length) throw bad('At least one strand is required.', { field: 'strands' }, 'Pin an expression, a theme, a work or a maker.');
  if (strands.length > 4) throw bad('At most 4 strands can be pinned.', { field: 'strands' });
  const outStrands = strands.map((s, i) => {
    if (!s || !STRAND_TYPES.includes(s.type)) throw bad(`strands[${i}].type must be one of ${STRAND_TYPES.join(', ')}.`, { field: `strands[${i}].type` });
    const numeric = s.type === 'expression' || s.type === 'work';
    const ref = numeric ? Number(s.ref ?? s.id) : String(s.ref ?? s.id ?? '');
    if (numeric ? !(Number.isInteger(ref) && ref > 0) : !ref) throw bad(`strands[${i}].ref is missing or invalid.`, { field: `strands[${i}].ref` });
    return { type: s.type, ref };
  });
  const lanesIn = body.lanes && typeof body.lanes === 'object' ? body.lanes : {};
  const facet = lanesIn.facet ?? 'domain';
  if (!LANE_FACETS.includes(facet)) throw bad(`lanes.facet must be one of ${LANE_FACETS.join(', ')}.`, { field: 'lanes.facet' });
  const order = lanesIn.order ?? 'first_observed';
  if (!LANE_ORDERS.includes(order)) throw bad(`lanes.order must be one of ${LANE_ORDERS.join(', ')}.`, { field: 'lanes.order' });
  const max = Math.max(1, Math.min(48, Number.isInteger(lanesIn.max) ? lanesIn.max : DEFAULT_MAX_LANES));
  const manual = Array.isArray(lanesIn.manual) ? lanesIn.manual.map(String).slice(0, 200) : [];
  // cluster lanes: the clustering run (a saved view pins it; default: the newest succeeded run of the expression)
  const run = lanesIn.run === undefined || lanesIn.run === null ? null : Number(lanesIn.run);
  if (run !== null && !(Number.isInteger(run) && run > 0)) throw bad('lanes.run must be a clustering run id.', { field: 'lanes.run' });
  const f = typeof body.f === 'string' ? parseFilter(body.f) : parseFilter(formatFilter(body.f ?? {}, { withDefaults: true }));
  const toggles = { ...TOGGLE_DEFAULTS };
  for (const k of Object.keys(TOGGLE_DEFAULTS)) {
    const v = body.toggles?.[k];
    if (v === 0 || v === 1) toggles[k] = v; else if (v === true || v === false) toggles[k] = v ? 1 : 0;
  }
  const timeBasis = body.timeBasis ?? 'publication';
  if (!TIME_BASES.includes(timeBasis)) throw bad(`timeBasis must be one of ${TIME_BASES.join(', ')}.`, { field: 'timeBasis' });
  const runs = body.runs?.materialize && typeof body.runs.materialize === 'object' ? { materialize: { ...body.runs.materialize } } : { materialize: {} };
  // A saved view opened "as saved" (D17) sends its import cutoff: only documents of batches ≤ it are counted (M1 gate),
  // and its save time: a document soft-deleted after the save (a reverted import) still counts
  const cut = body.cutoffs?.import_batch ?? null;
  if (cut !== null && !(Number.isInteger(cut) && cut > 0)) throw bad('cutoffs.import_batch must be a positive integer.', { field: 'cutoffs' });
  const at = body.cutoffs?.at ?? null;
  if (at !== null && !(typeof at === 'string' && ISO_INSTANT.test(at) && Number.isFinite(Date.parse(at)))) {
    throw bad('cutoffs.at must be the view\'s save time (an ISO 8601 UTC timestamp).', { field: 'cutoffs.at' });
  }
  const cutoffs = cut || at ? { ...(cut ? { import_batch: cut } : {}), ...(at ? { at } : {}) } : null;
  return { strands: outStrands, corpus: body.corpus, lanes: { facet, order, max, manual, ...(run ? { run } : {}) }, f, toggles, timeBasis, runs,
    ...(cutoffs ? { cutoffs } : {}) };
}

/**
 * One member of an expression strand: the sibling expression in one corpus with its pinned (or current) materialize
 * run and the languages it is counted in.
 */
function strandMember(db, expr, corpusId, corpusSlug, pinnedRuns, materialize) {
  const pinned = Number(pinnedRuns?.[expr.id]);
  const fr = freshness(db, expr.id);
  let run = fr.runId;
  if (Number.isInteger(pinned) && pinned > 0) {
    const ok = stmt(db, `SELECT 1 FROM analysis_run WHERE id = ? AND stage = 'materialize' AND status = 'succeeded'
      AND json_extract(params_json, '$.expression') = ?`).get(pinned, expr.id);
    if (!ok) throw bad(`Run ${pinned} is not a succeeded materialization of expression ${expr.id}.`, { field: 'runs' });
    run = pinned;
  } else if (!fr.fresh) {
    materialize.push({ expressionId: expr.id, hasRun: fr.runId !== null });
  }
  let m = {};
  if (run) { try { m = JSON.parse(stmt(db, 'SELECT metrics_json FROM analysis_run WHERE id = ?').get(run)?.metrics_json ?? '{}') ?? {}; } catch { m = {}; } }
  return { corpusId, corpus: corpusSlug, ref: expr.id, run: run ?? null, langs: strandLanguages(expr, variantsOf(db, expr.id)),
    sampled: m.sampled === true, ...(m.mode === 'fts-index' ? { accentInsensitive: true } : {}) };
}

/**
 * An expression strand: the expression in each corpus of the scope (its siblings in a virtual corpus). `run` is set
 * only when every member has a counted run (else the query waits for counting); `langs` is the union of the members'
 * languages and `langsByCorpus` keeps each member's own when they differ, so every corpus is counted exactly as alone.
 */
function expressionStrand(db, s, scope, req, materialize, track) {
  const expr = getExpression(db, s.ref);
  if (!expr) throw bad(`No expression ${s.ref}.`, { field: 'strands' }, 'Track it first with POST /api/expressions.');
  if (!scope.ids.includes(expr.corpus_id)) {
    if (!scope.virtual) throw bad(`Expression ${s.ref} was tracked in another corpus.`, { field: 'strands' }, `Track '${expr.surface}' in ${req.corpus}.`);
    throw bad(`Expression ${s.ref} belongs to a corpus outside '${req.corpus}' (the synthetic demo is never part of it).`, { field: 'strands' },
      `Track '${expr.surface}' in ${req.corpus}.`);
  }
  const sibs = scope.virtual ? siblingExpressions(db, expr, scope.members) : [{ corpusId: expr.corpus_id, corpus: scope.slug, expr }];
  const members = [];
  for (const sb of sibs) {
    if (!sb.expr) {
      track.push({ corpus: sb.corpus, surface: expr.surface, lang: expr.lang, kind: expr.kind, for: expr.id });
      members.push({ corpusId: sb.corpusId, corpus: sb.corpus, ref: null, run: null, langs: null, sampled: false });
      continue;
    }
    members.push(strandMember(db, sb.expr, sb.corpusId, sb.corpus, req.runs.materialize, materialize));
  }
  const counted = members.every((m) => m.run);
  const langSets = members.filter((m) => m.ref !== null).map((m) => m.langs);
  const anyLang = langSets.some((l) => l === null);
  const union = anyLang ? null : [...new Set(langSets.flat())].sort();
  const differ = langSets.some((l) => JSON.stringify(l) !== JSON.stringify(langSets[0]));
  return {
    type: 'expression', ref: expr.id, key: String(expr.id), surface: expr.surface, kind: expr.kind, lang: expr.lang,
    run: counted ? members[0].run : null, members, langs: union,
    ...(differ ? { langsByCorpus: Object.fromEntries(members.map((m) => [m.corpusId, m.langs])) } : {}),
    synthetic: expr.is_synthetic === 1, sampled: members.some((m) => m.sampled),
    ...(members.some((m) => m.accentInsensitive) ? { accentInsensitive: true } : {}),
  };
}

/**
 * Resolve a canonical request into a def: the corpora it reads (one corpus, or the members of a virtual corpus), each
 * strand's pinned materialize runs and languages, and for cluster lanes the clustering run. Reads only.
 * `materialize` lists expressions whose counts are missing or stale (the caller enqueues jobs); `track` lists siblings
 * a virtual corpus still needs (the caller tracks them, then resolves again).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof canonicalRequest>} req
 * @param {{scope?: object|null}} [opts] a resolved corpus scope (scope.resolveCorpusScope shape) instead of req.corpus
 * @returns {{def: object, materialize: Array<{expressionId: number, hasRun: boolean}>, track: object[]}}
 * @throws {HttpError} 400 for an unknown corpus, expression or work
 */
export function buildDef(db, req, { scope: scopeOverride = null } = {}) {
  // tests and tools may name the member corpora of a virtual scope themselves (the property tests compose two
  // synthetic corpora, since invented documents never live in a real corpus)
  const scope = scopeOverride ?? resolveCorpusScope(db, req.corpus);
  const inScope = JSON.stringify(scope.ids);
  const strands = [];
  const materialize = [];
  const track = [];
  for (const s of req.strands) {
    if (s.type === 'expression') {
      strands.push(expressionStrand(db, s, scope, req, materialize, track));
    } else if (s.type === 'theme') {
      const provs = stmt(db, `SELECT DISTINCT t.provenance FROM doc_tag t JOIN document d ON d.id = t.document_id
        JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'theme' AND t.value = ? AND c.corpus_id IN (SELECT value FROM json_each(?))
        ORDER BY CASE t.provenance WHEN 'documented_category' THEN 0 WHEN 'machine_tag' THEN 1 WHEN 'genre_heuristic' THEN 2 ELSE 3 END`)
        .all(s.ref, inScope).map((r) => r.provenance);
      for (const p of provs.length ? provs : ['documented_category']) {
        strands.push({ type: 'theme', ref: s.ref, provenance: p, key: `theme:${s.ref}@${p}`, run: null, langs: null, synthetic: scope.synthetic });
      }
    } else if (s.type === 'work') {
      const doc = stmt(db, `SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?
        AND c.corpus_id IN (SELECT value FROM json_each(?))`).get(s.ref, inScope);
      if (!doc) throw bad(`No work ${s.ref} in corpus ${req.corpus}.`, { field: 'strands' });
      strands.push({ type: 'work', ref: s.ref, key: `work:${s.ref}`, run: null, langs: null, synthetic: scope.synthetic });
    } else if (s.type === 'maker') {
      // a maker is named by its slug (search suggests `maker:<slug>`) or by its exact name; the maker index lists every
      // author and maker tag of a corpus with its slug (no scan of 270k authors per query, M1 gate) — until it is
      // built, the authors and tags are scanned
      const names = new Set();
      for (const id of scope.ids) {
        const index = peekLabelIndex(db, id, 'maker');
        const found = index ? labelsForRef(index, s.ref) : [...new Set([
          ...stmt(db, `SELECT DISTINCT d.author AS n FROM document d JOIN collection c ON c.id = d.collection_id
            WHERE c.corpus_id = ? AND d.author IS NOT NULL AND d.deleted_at IS NULL`).all(id).map((r) => r.n),
          ...stmt(db, `SELECT DISTINCT t.value AS n FROM doc_tag t JOIN document d ON d.id = t.document_id
            JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'maker' AND c.corpus_id = ? AND d.deleted_at IS NULL`).all(id).map((r) => r.n),
        ])].filter((n) => n === s.ref || slugify(n) === s.ref);
        for (const n of found) names.add(n);
      }
      if (!names.size) throw bad(`No maker '${s.ref}' in corpus ${req.corpus}.`, { field: 'strands' });
      strands.push({ type: 'maker', ref: s.ref, names: [...names].sort(), key: `maker:${s.ref}`, run: null, langs: null, synthetic: scope.synthetic });
    } else {
      throw bad(`Strand type '${s.type}' is not available on the timeline yet.`, { field: 'strands' },
        s.type === 'cluster' ? 'Context groups are lanes: ask for lanes {facet: "cluster"} with one expression strand.' : null);
    }
  }
  const def = { v: QUERY_VERSION, corpus: scope.slug, corpusId: scope.ids[0], corpusIds: scope.ids, virtual: scope.virtual,
    synthetic: scope.synthetic, strands, lanes: req.lanes, f: req.f, toggles: req.toggles, timeBasis: req.timeBasis,
    ...(req.cutoffs ? { cutoffs: req.cutoffs } : {}) };
  if (req.lanes.facet === 'cluster') def.cluster = clusterScope(db, def, req.lanes.run ?? null);
  return { def, materialize, track };
}

/**
 * def.cluster for a cluster-lane request: the run, its groups and the lane state. Cluster lanes need exactly one
 * expression strand of one corpus (groups are computed per corpus); a pinned run also pins the materialization it
 * grouped.
 */
function clusterScope(db, def, pinned) {
  const exprs = def.strands.filter((s) => s.type === 'expression');
  if (exprs.length !== 1 || def.strands.length !== 1 || def.virtual) {
    return { state: 'unavailable', run: null, groups: [], residual: [], suggestion: null,
      note: def.virtual ? 'Context groups are computed per corpus: open the expression in one corpus to see its groups as lanes.'
        : 'Context-group lanes need exactly one pinned expression.' };
  }
  const strand = exprs[0];
  const cl = resolveClusterRun(db, strand, pinned);
  // a pinned run (saved view) or a recount that found the same matches: the lanes read the count the groups were made of
  if (cl.state === 'ok' && (cl.pinned || cl.sameCounts) && cl.materialize && strand.run !== cl.materialize) {
    strand.members[0].run = cl.materialize;
    strand.run = cl.materialize;
  }
  if (cl.state === 'ok' && strand.sampled) {
    return { ...cl, state: 'gated', groups: [], residual: [], suggestion: null,
      gate: { gate: 'insufficient_occurrences', value: null, needed: { complete_occurrences: true }, have: { sampled: true }, suggestion: null },
      note: 'This expression is very frequent: its occurrence rows are a stratified sample, so counts per context group would not be complete.' };
  }
  return cl;
}
/**
 * buildDef for the read pool (POST /api/timeline/query resolves strands — pinned runs, freshness, maker names — off
 * the main thread). Read-query convention (§12.2).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{req: ReturnType<typeof canonicalRequest>}} args
 * @returns {{def: object, materialize: Array<{expressionId: number, hasRun: boolean}>}}
 */
export function resolveQuery(db, { req }) {
  return buildDef(db, req);
}

/**
 * The queryKey of a def: 16 hex characters of sha256 over its canonical JSON (pinned runs included, so a new
 * materialization or any filter change gives a new key).
 * @param {object} def
 * @returns {string}
 */
export function queryKeyOf(def) {
  return createHash('sha256').update(canonicalJson(def)).digest('hex').slice(0, 16);
}

// ── the slice (shared by every numerator and denominator) ───────────────────────────────────────────

/** Field classes counted under a def's toggles. */
export function fieldClassesOf(def) {
  return ['text', 'title', 'abstract', ...(def.toggles.ds ? ['describes'] : []), ...(def.toggles.ap ? ['apparatus'] : [])];
}

/** Whether a def reads the collections of relation endpoints (the Term trail's music-relations lane, works mode). */
export const readsEndpoints = (def) => def.lanes?.facet === 'trail';

/**
 * Document- and collection-level conditions of the slice (aliases d, c).
 * @param {object} def
 * @returns {{sql: string, params: any[]}}
 */
export function docWhere(def) {
  const ids = def.corpusIds ?? [def.corpusId];
  // as saved (D17): documents are only soft-deleted so that a view keeps counting those deleted after its save
  const savedAt = def.cutoffs?.at ?? null;
  const where = [savedAt ? '(d.deleted_at IS NULL OR d.deleted_at > ?)' : 'd.deleted_at IS NULL',
    ids.length === 1 ? 'c.corpus_id = ?' : 'c.corpus_id IN (SELECT value FROM json_each(?))',
    readsEndpoints(def) ? "(c.rate_eligible = 1 OR c.sampling = 'relation_endpoints')" : 'c.rate_eligible = 1'];
  const params = [...(savedAt ? [savedAt] : []), ids.length === 1 ? ids[0] : JSON.stringify(ids)];
  if (!def.toggles.tr) where.push('d.is_translation = 0');
  if (!def.toggles.dup) where.push('d.dup_of IS NULL');
  if (!def.toggles.est) where.push("d.basis <> 'estimated'");
  if (def.f.syn === 0) where.push('d.is_synthetic = 0');
  if (def.cutoffs?.import_batch) { where.push('(d.import_batch_id IS NULL OR d.import_batch_id <= ?)'); params.push(def.cutoffs.import_batch); }
  for (const [key, col] of Object.entries(FILTER_COLUMNS)) {
    const vals = def.f[key] ?? [];
    const inc = vals.filter((v) => !v.startsWith('-')), exc = vals.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
    if (inc.length) { where.push(`${col} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(inc)); }
    if (exc.length) { where.push(`(${col} IS NULL OR ${col} NOT IN (SELECT value FROM json_each(?)))`); params.push(JSON.stringify(exc)); }
  }
  return { sql: where.join(' AND '), params };
}

/**
 * The language condition of a strand: its languages (null = any), or — when the members of a virtual corpus count in
 * different languages — each corpus's own (`{byCorpus}`), so every corpus is sliced exactly as alone.
 * @param {object|null} strand
 * @returns {string[]|null|{byCorpus: Record<number, string[]|null>}}
 */
export function strandLangSpec(strand) {
  if (!strand) return null;
  return strand.langsByCorpus ? { byCorpus: strand.langsByCorpus } : strand.langs ?? null;
}

/**
 * Passage-level conditions of the slice: counted field classes, the strand's languages, the `lang` filter and, on the
 * Term trail, the rows that belong to a trail lane.
 * @param {object} def
 * @param {{plang: string, fc: string}} cols
 * @param {string[]|null|{byCorpus: object}} langs the strand's languages (null = any; see strandLangSpec)
 * @returns {{sql: string, params: any[]}}
 */
export function rowWhere(def, cols, langs) {
  const where = [`${cols.fc} IN (SELECT value FROM json_each(?))`];
  const params = [JSON.stringify(fieldClassesOf(def))];
  // RF-1: an unidentified row of a document's running text counts only in its document's text language (langgate.mjs)
  if (Array.isArray(langs)) { const g = langAdmitsSql(cols, langs); where.push(g.sql); params.push(...g.params); }
  else if (langs && langs.byCorpus) {
    const parts = [];
    for (const [id, l] of Object.entries(langs.byCorpus)) {
      if (l === null) { parts.push('c.corpus_id = ?'); params.push(Number(id)); }
      else { const g = langAdmitsSql(cols, l); parts.push(`(c.corpus_id = ? AND ${g.sql})`); params.push(Number(id), ...g.params); }
    }
    where.push(`(${parts.join(' OR ') || '0'})`);
  }
  const vals = def.f.lang ?? [];
  const inc = vals.filter((v) => !v.startsWith('-')), exc = vals.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
  if (inc.length) { where.push(`${cols.plang} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(inc)); }
  if (exc.length) { where.push(`${cols.plang} NOT IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(exc)); }
  if (def.lanes?.facet === 'trail') where.push(`${trailValueSql(cols)} IS NOT NULL`);
  return { sql: where.join(' AND '), params };
}

/**
 * The whole slice condition for a passage-level alias.
 * @param {object} def
 * @param {{plang: string, fc: string}} cols
 * @param {string[]|null|{byCorpus: object}} langs
 * @returns {{sql: string, params: any[]}}
 */
export function sliceWhere(def, cols, langs) {
  const a = docWhere(def), b = rowWhere(def, cols, langs);
  return { sql: `${a.sql} AND ${b.sql}`, params: [...a.params, ...b.params] };
}

/** Union of the strands' languages (null when any strand counts every language). */
export function unionLanguages(strands) {
  const out = new Set();
  for (const s of strands) {
    if (s.type !== 'expression') continue;
    if (!s.langs) return null;
    for (const l of s.langs) out.add(l);
  }
  return out.size ? [...out].sort() : null;
}

/** [expression id, run id] of every counted member of an expression strand. */
export const memberRuns = (strand) => (strand.members ?? [{ ref: strand.ref, run: strand.run }]).filter((m) => m.ref && m.run).map((m) => [m.ref, m.run]);

/**
 * The occurrence rows of a strand's members (alias `o`): `(o.expression_id, o.run_id)` of each counted member.
 * @param {object} strand
 * @param {string} [alias]
 * @returns {{sql: string, params: number[]}}
 */
export function occurrenceRunSql(strand, alias = 'o') {
  const pairs = memberRuns(strand);
  if (!pairs.length) return { sql: '0', params: [] };
  return { sql: `(${pairs.map(() => `(${alias}.expression_id = ? AND ${alias}.run_id = ?)`).join(' OR ')})`, params: pairs.flat() };
}

/** Whether a def's lanes are context groups with a usable run. */
export const clusterLanesOk = (def) => def.lanes?.facet === 'cluster' && def.cluster?.state === 'ok';

/**
 * The cols of numerator rows read through a strand source (alias e): on cluster lanes they carry the group (`e.grp`).
 * @param {object} def
 * @returns {{plang: string, fc: string, grp?: string}}
 */
export const srcCols = (def) => rowCols('e', false, def.lanes?.facet === 'cluster' ? 'e.grp' : null);

/**
 * Numerator source of a strand: rows (document_id, plang, field_class, n, n_names, n_passages[, grp]). Expression
 * strands read expr_doc of each member's pinned, succeeded run (visibility rule; a member's own languages when the
 * members differ); on cluster lanes they read the run's occurrences with each one's context group instead. Theme
 * strands count each tagged work once in its title rows (works unit). Work and maker strands are drawn as work marks
 * and never as rates.
 * @param {object} strand
 * @param {object|null} [def] needed for cluster lanes
 * @returns {{sql: string, params: any[]}|null}
 */
export function strandSource(strand, def = null) {
  if (strand.type === 'expression') {
    if (!strand.run) return null;
    if (def?.lanes?.facet === 'cluster') {
      if (!clusterLanesOk(def)) return null;
      const occ = occurrenceRunSql(strand);
      const grp = groupCaseSql(def.cluster, 'm.cluster_id');
      return {
        sql: `SELECT o.document_id, p.lang AS plang, p.field_class, SUM(o.name_flag = 0) AS n, SUM(o.name_flag = 1) AS n_names,
            count(DISTINCT o.passage_id) AS n_passages, ${grp} AS grp
          FROM occurrence o JOIN passage p ON p.id = o.passage_id ${memberJoinSql(def.cluster)}
          WHERE ${occ.sql} AND p.quality = 'ok' GROUP BY o.document_id, p.lang, p.field_class, grp`,
        params: occ.params,
      };
    }
    const branches = [], params = [];
    for (const m of strand.members ?? [{ ref: strand.ref, run: strand.run, langs: null }]) {
      if (!m.ref || !m.run) continue;
      const own = strand.langsByCorpus && Array.isArray(m.langs) ? ' AND x.plang IN (SELECT value FROM json_each(?))' : '';
      branches.push(`SELECT x.document_id, x.plang, x.field_class, x.n, x.n_names, x.n_passages FROM expr_doc x
        JOIN analysis_run r ON r.id = x.run_id AND r.status = 'succeeded' WHERE x.expression_id = ? AND x.run_id = ?${own}`);
      params.push(m.ref, m.run, ...(own ? [JSON.stringify(m.langs)] : []));
    }
    return branches.length ? { sql: branches.join(' UNION ALL '), params } : null;
  }
  if (strand.type === 'theme') {
    if (def?.lanes?.facet === 'cluster') return null;
    return {
      sql: `SELECT t.document_id, dt.plang, dt.field_class, 1 AS n, 0 AS n_names, dt.passages AS n_passages FROM doc_tag t
        JOIN doc_tokens dt ON dt.document_id = t.document_id AND dt.field_class = 'title'
        WHERE t.scheme = 'theme' AND t.value = ? AND t.provenance = ?`,
      params: [strand.ref, strand.provenance],
    };
  }
  return null;
}

/** Rate unit of a unit class, for a strand (theme strands are shares of works). */
export function unitOf(unitClass) {
  return RATE_UNIT_OF_CLASS[unitClass] ?? 'per_million_tokens';
}

/** The key the denominators of a lane are filed under: cluster lanes share their unit class's slice denominators. */
export const denomKeyOf = (def, laneKeyStr, uc) => (def.lanes?.facet === 'cluster' ? `~${uc}` : laneKeyStr);

/**
 * Coverage gates per lane (§1.2, §4.6): a lane's gate is the strictest gate among the collections whose
 * documents make up the lane in this slice; collection.coverage_gate overrides the unit default only for a
 * collection counted in the lane's own unit (rates.laneGate). The (lane, collection) pairs come from the slice cubes.
 * `rateless(key)`: lanes that carry counts but never a rate — a top-cited-per-cell sample (OpenAlex, D14) and relation
 * endpoints on the Term trail (works mode).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {{of(key: string, unitClass: string): number, byUnit: {text: number|null, titles: number|null, abstracts: number|null},
 *   cellSampled(key: string): boolean, rateless(key: string): boolean}}
 */
export function laneGatesOf(db, def) {
  const rows = sliceGateRows(db, def);
  const byLane = new Map();
  for (const r of rows) {
    const key = def.lanes.facet === 'cluster' ? `~${r.uc}` : laneKey(def.lanes.facet, r.lv, r.uc);
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key).push(r);
  }
  const cache = new Map();
  const of = (key, uc) => {
    const k = def.lanes.facet === 'cluster' ? `~${uc}` : key;
    if (!cache.has(k)) cache.set(k, laneGate(uc, byLane.get(k) ?? []));
    return cache.get(k);
  };
  const byUnit = { text: null, titles: null, abstracts: null };
  for (const [key, list] of byLane) {
    const uc = list[0].uc;
    if (uc in byUnit) byUnit[uc] = Math.max(byUnit[uc] ?? 0, of(key, uc));
  }
  // D14, §10.4, §13 rule 8 (M5 gate): a lane holding a top-cited-per-cell sample (OpenAlex) shows counts, never a rate
  // across calendar bins — those rates would compare OpenAlex's cells; within-cell shares are the share cells (C3)
  const cellSampled = new Set([...byLane].filter(([, list]) => list.some((r) => r.sampling === 'top_cited_per_cell')).map(([key]) => key));
  const endpoints = new Set([...byLane].filter(([, list]) => list.some((r) => r.sampling === 'relation_endpoints')).map(([key]) => key));
  return { of, byUnit, cellSampled: (key) => cellSampled.has(key), rateless: (key) => cellSampled.has(key) || endpoints.has(key) };
}

/** The lane note of a top-cited-per-cell lane (OpenAlex, §10.4). */
export const CELL_SAMPLE_NOTE = 'Top-cited sample: 200 works per field × period. Counts only on the Scroll: rates across its cells are not comparable; within-cell shares are in Compare.';
/** The lane note of the Term trail's relation-endpoint lane (works mode). */
export const ENDPOINTS_NOTE = 'Works that appear in documented sample/cover/version links: counted as works, never as a rate.';

/**
 * Unit classes whose collections are still indexing (a committing import batch): their unseen bins are
 * 'pending' — not yet looked — rather than absent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {Set<string>}
 */
export function pendingUnitClasses(db, def) {
  // also a collection the Cipher bootstrap marks pending/indexing (meta collection_status:<slug>, WP2): between its
  // ≈ 20 s chunks no batch is 'committing', yet the collection is still being loaded (M1 gate)
  const rows = stmt(db, `SELECT DISTINCT c.modality FROM collection c WHERE c.corpus_id IN (SELECT value FROM json_each(?)) AND (
      EXISTS (SELECT 1 FROM import_batch b WHERE b.collection_id = c.id AND b.status = 'committing')
      OR EXISTS (SELECT 1 FROM meta m WHERE m.key = 'collection_status:' || c.slug AND m.value IN ('pending', 'indexing')))`)
    .all(JSON.stringify(def.corpusIds ?? [def.corpusId]));
  const out = new Set(rows.map((r) => r.modality));
  if (out.has('abstracts')) out.add('cells');
  return out;
}

/** The lane-order legend sentence of a def (§1.3). */
export const orderNoteOf = (def) => (def.lanes.facet === 'trail' ? TRAIL_ORDER_NOTE : orderNote(def.lanes.order));
/** The Term trail's order note: its lanes have a fixed order. */
export const TRAIL_ORDER_NOTE = 'Lane order is fixed for the Term trail (etymology → literature → STEMM fields → culture), not a scale of meaning.';

// ── per-document rows of a strand (every chronology status) ─────────────────────────────────────────

/**
 * Per lane × document rows of a strand under the def's slice, with each document's chronology. `v` is the
 * counted value (matches, + name-guard hits when nm=1).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {object} strand
 * @param {{where?: string, params?: any[]}} [extra] more conditions on d / e
 * @returns {object[]}
 */
export function strandDocRows(db, def, strand, { where = '1', params = [] } = {}) {
  const src = strandSource(strand, def);
  if (!src) return [];
  const cols = srcCols(def);
  const slice = sliceWhere(def, cols, strandLangSpec(strand));
  const nm = def.toggles.nm ? 1 : 0;
  return stmt(db, `WITH src AS (${src.sql})
    SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc, e.document_id AS doc,
      SUM(e.n + ${nm} * e.n_names) AS v, SUM(e.n_names) AS names, SUM(e.n_passages) AS passages, d.chrono_status, d.lo_day,
      d.hi_day, d.y_lo, d.y_hi, d.precision, d.basis, d.date_label, d.author, d.title, d.kind, d.is_synthetic AS syn,
      d.is_translation AS tr
    FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${slice.sql} AND ${where}
    GROUP BY lv, uc, e.document_id`).all(...src.params, ...slice.params, ...params);
}

/**
 * Counted amount of rows in a unit class: matches for text/abstracts, works with ≥ 1 match for titles and for
 * OpenAlex cells (a work counts once whether its title or its abstract mentions the strand).
 * @param {string} unitClass
 * @param {Array<{v: number}>} rows
 * @returns {number}
 */
export function countValue(unitClass, rows) {
  let n = 0;
  const works = unitClass === 'titles' || unitClass === 'cells';
  for (const r of rows) n += works ? (r.v > 0 ? 1 : 0) : r.v;
  return n;
}

// ── POST /api/timeline/query (read pool) ────────────────────────────────────────────────────────────

const levelOfTier = (tier) => TIERS.indexOf(tier);

/** Whether a document interval fits one bin of a tier (L0–L3 by year, L4 month, L5 day). */
export function fitsTier(row, tier) {
  const level = levelOfTier(tier);
  if (level <= 3) {
    const w = LEVELS[level].width;
    return Math.floor(row.y_lo / w) === Math.floor(row.y_hi / w);
  }
  return fitsDays(row.lo_day, row.hi_day, level);
}

/**
 * Lanes, units, extent, totals, seams and gates of a resolved def (§7.2 POST /api/timeline/query), without the
 * queryKey/status/job envelope the route adds. Read-query convention (§12.2): runs in the read pool via
 * ctx.pool.run(moduleUrl, 'timelineQuery', { def }).
 *
 * Contract 1.3.0: `lanes.facet = 'trail'` answers the fixed Term trail lane set (every present lane, in order, no
 * folding; `trail` lists the absent ones and what fell outside every lane); `'cluster'` answers one lane per context
 * group (+ residual) with `lane_state` ('ok' · 'not_run' + suggestion.run · 'gated' + gate · 'unavailable'); every
 * query carries `baseline` and `claims` for a single-word strand (trail.strandExtras).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, rev_cutoff?: number|null}} args
 * @returns {object}
 */
export function timelineQuery(db, { def, rev_cutoff: revCutoff = null }) {
  const facet = def.lanes.facet;
  const collNames = Object.fromEntries(stmt(db, 'SELECT slug, name FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(def.corpusIds ?? [def.corpusId])).map((r) => [r.slug, r.name]));
  const gates = laneGatesOf(db, def);
  const pending = pendingUnitClasses(db, def);
  const lanes = new Map();
  const laneOf = (lv, uc) => {
    const key = laneKey(facet, lv, uc);
    let l = lanes.get(key);
    if (!l) {
      l = { key, value: lv, uc, label: laneLabel(facet, lv, uc, { collectionNames: collNames }), unit: unitOf(uc),
        n: 0, docs: 0, firstRow: null, lastRow: null, undated: 0, scheduled: 0, dated: 0, names: 0, synthetic: false,
        strands: {}, coverage: null };
      lanes.set(key, l);
    }
    return l;
  };

  const totals = { n: 0, dated: 0, undated: 0, scheduled: 0, names_excluded: 0, sampled: false,
    washes_by_tier: Object.fromEntries(TIERS.map((t) => [t, 0])), by_unit: { matches: 0, works: 0 } };
  const docRowsByStrand = new Map();
  for (const strand of def.strands) {
    if (strand.sampled) totals.sampled = true;
    const rows = strandDocRows(db, def, strand);
    docRowsByStrand.set(strand.key, rows);
    for (const r of rows) {
      const l = laneOf(r.lv, r.uc);
      const s = (l.strands[strand.key] ??= { n: 0, docs: 0, dated: 0, undated: 0, scheduled: 0, names: 0, first: null, last: null,
        washes_by_tier: Object.fromEntries(TIERS.map((t) => [t, 0])) });
      const amount = countValue(r.uc, [r]);
      if (!def.toggles.nm) { s.names += r.names; l.names += r.names; totals.names_excluded += r.names; }
      if (amount === 0) continue;
      s.n += amount; l.n += amount; totals.n += amount;
      totals.by_unit[r.uc === 'titles' || r.uc === 'cells' ? 'works' : 'matches'] += amount;
      s.docs++; l.docs++;
      if (r.syn) l.synthetic = true;
      if (r.chrono_status === 'undated') { s.undated += amount; l.undated += amount; totals.undated += amount; continue; }
      if (r.chrono_status === 'scheduled') { s.scheduled += amount; l.scheduled += amount; totals.scheduled += amount; continue; }
      s.dated += amount; l.dated += amount; totals.dated += amount;
      // OpenAlex share lanes do not use calendar bins (C3): no washes there
      if (r.uc !== 'cells') for (const t of TIERS) if (!fitsTier(r, t)) { s.washes_by_tier[t] += amount; totals.washes_by_tier[t] += amount; }
      if (!s.first || r.lo_day < s.first.lo_day) s.first = r;
      if (!s.last || r.hi_day > s.last.hi_day) s.last = r;
      if (!l.firstRow || r.lo_day < l.firstRow.lo_day) l.firstRow = r;
      if (!l.lastRow || r.hi_day > l.lastRow.hi_day) l.lastRow = r;
    }
  }

  // coverage of every lane in the union of the strands' languages
  const langSpec = def.strands.length === 1 ? strandLangSpec(def.strands[0]) : unionLanguages(def.strands);
  const coverage = sliceCoverage(db, def, langSpec);
  if (facet === 'cluster') {
    // every group lane divides by its unit class's slice: the coverage of `~text` is each text group lane's coverage
    const byUc = new Map(coverage.map((c) => [c.uc, c]));
    for (const l of lanes.values()) l.coverage = byUc.get(l.uc) ?? null;
  } else {
    for (const r of coverage) {
      const l = laneOf(r.lv, r.uc);
      l.coverage = r;
      if (r.syn) l.synthetic = true;
    }
  }

  const all = [...lanes.values()].map((l) => laneJson(def, l, gates, pending));
  let ordered, visible, folded, extra = {};
  if (facet === 'trail') ({ visible, extra } = trailLaneSet(db, def, all, docRowsByStrand, { gates, pending }));
  else if (facet === 'cluster') {
    const byUc = new Map(coverage.map((c) => [c.uc, c]));
    ({ visible, extra } = clusterLaneSet(db, def, all, { gates, pending, revCutoff, coverageOf: (uc) => byUc.get(uc) ?? null }));
  }
  if (visible) { ordered = visible; folded = []; } else {
    ordered = orderLanes(all.map((l) => ({ ...l, firstDay: l._firstDay })), def.lanes.order, def.lanes.manual);
    visible = ordered.slice(0, def.lanes.max);
    folded = ordered.slice(def.lanes.max);
  }
  const strip = (l) => { const { _firstDay, _lastDay, _yLo, _yHi, firstDay, ...rest } = l; return rest; };

  const units = [];
  for (const l of visible) {
    let u = units.find((x) => x.unit === l.unit);
    if (!u) units.push((u = { unit: l.unit, lanes: [] }));
    u.lanes.push(l.key);
  }
  const observed = ordered.filter((l) => l._yLo !== null && l._yLo !== undefined);
  const yLo = observed.length ? Math.min(...observed.map((l) => l._yLo)) : null;
  const yHi = observed.length ? Math.max(...observed.map((l) => l._yHi)) : null;
  const dayLo = observed.length ? Math.min(...observed.map((l) => l._firstDay)) : null;
  const dayHi = observed.length ? Math.max(...observed.map((l) => l._lastDay)) : null;
  const extras = strandExtras(db, def);

  return {
    dataVersion: dataVersion(db),
    units,
    lanes: visible.map(strip),
    other: { lanes: folded.length, n: folded.reduce((s, l) => s + l.n, 0), keys: folded.map((l) => l.key) },
    extent: { from: yLo === null ? null : yearLabel(yLo), to: yHi === null ? null : yearLabel(yHi), from_day: dayLo, to_day: dayHi },
    // C2 (fix pass): matches and works are different units; a reader is never shown their sum as "matches"
    totals: { ...totals, units_mixed: totals.by_unit.matches > 0 && totals.by_unit.works > 0, excluded: excludedCounts(db, def) },
    seams: seamsFor(db, def, visible),
    gates: {
      rates: { gate: 'ok', coverage_gate: { tokens: gates.byUnit.text ?? gates.byUnit.abstracts, works: gates.byUnit.titles },
        note: (gates.byUnit.text ?? 50000) < 50000 ? 'demo setting; real collections use 50,000 tokens' : null },
      cluster: clusterGate(def),
    },
    sampling_note: def.strands.some((x) => x.sampled)
      ? `Very frequent: counts are complete; contexts (marks, KWIC, drawer rows) are a stratified sample of ≤ 200 per language and decade.${
        def.strands.some((x) => x.accentInsensitive) ? ' Counts include accent variants (counted from the search index).' : ''}` : null,
    time_basis_note: def.timeBasis === 'referenced'
      ? 'Referenced time is not available on the timeline yet; publication time is shown.' : null,
    lane_order_note: orderNoteOf(def),
    ...extra,
    baseline: extras.baseline,
    claims: extras.claims,
    strand_extras: extras.by_strand,
    provenance: provenanceOf(db, def),
  };
}

/** gates.cluster of a query: the clustering gate of cluster lanes, or not_run elsewhere. */
function clusterGate(def) {
  const cl = def.cluster;
  if (!cl) return { gate: 'not_run', needed: { run: 'cluster' }, have: { runs: 0 }, suggestion: null };
  if (cl.state === 'ok') return { gate: 'ok', run: cl.run };
  if (cl.state === 'gated') return { ...cl.gate };
  return { gate: 'not_run', needed: { run: 'cluster' }, have: { runs: 0 }, suggestion: cl.suggestion ?? null };
}

/**
 * The Term trail's lanes (C2): every present lane in the fixed order, including lanes with no match (their coverage
 * still says whether the source was looked at); OpenAlex lanes with their cell fields and header note; the etymology
 * lane with its bands endpoint. Rows outside every trail lane are counted under trail.outside.
 */
function trailLaneSet(db, def, all, docRowsByStrand, { gates, pending }) {
  const { present, absent } = trailLanesOf(db, def);
  const byKey = new Map(all.map((l) => [l.key, l]));
  // the share cells of every strand, computed once for all OpenAlex lanes
  let shareMemo = null;
  const shares = () => (shareMemo ??= def.strands.map((s) => shareCells(db, def, s, docRowsByStrand.get(s.key) ?? [], strandLangSpec(s)).cells));
  const exprs = def.strands.filter((s) => s.type === 'expression');
  const visible = present.map((t) => {
    let l = byKey.get(t.key);
    if (!l) {
      l = laneJson(def, { key: t.key, value: t.key.slice(6), uc: t.kind === 'etymology' ? 'none' : trailUcOf(t), label: t.label,
        unit: t.unit, n: 0, docs: 0, firstRow: null, lastRow: null, undated: 0, scheduled: 0, names: 0, synthetic: false, strands: {},
        coverage: null }, gates, pending);
    }
    const out = { ...l, label: t.label, unit: t.unit, modality: t.modality, kind: t.kind, trail_field: t.field };
    if (t.kind === 'etymology') {
      Object.assign(out, { header: `${t.label} · bands, never counts`, bands: exprs.filter((s) => s.kind === 'word')
        .map((s) => ({ strand: s.ref, href: `/api/etymology?expr=${s.ref}` })), coverage: { docs: 0, span: null }, gate: null });
    }
    if (t.unit === 'share_of_sampled_works') {
      const fields = new Set();
      for (const cellsOfStrand of shares()) for (const c of cellsOfStrand.get(t.key) ?? []) fields.add(c.field);
      Object.assign(out, { header: `${t.label} · ${SHARE_LANE_NOTE}`, note: SHARE_LANE_NOTE, cell_fields: [...fields].sort(),
        cell_gate: SHARE_GATE });
    }
    if (t.kind === 'music-relations') Object.assign(out, { mode: 'works', rate_note: ENDPOINTS_NOTE });
    return out;
  });
  const outside = {};
  for (const s of def.strands) if (s.type === 'expression' && s.run) outside[s.key] = trailOutside(db, def, s);
  return { visible, extra: { trail: { lanes: visible.map((l) => l.key), absent, outside,
    member_corpora: def.virtual ? (def.corpusIds ?? []).length : 1,
    note: 'Lanes share a word, not a link: co-presence in two lanes is not transmission (§10.5).' } } };
}

const trailUcOf = (t) => ({ 'literature-text': 'text', 'stemm-text': 'text', 'stemm-abstracts': 'cells', 'culture-titles': 'titles',
  'music-relations': 'titles' }[t.kind] ?? 'text');

/**
 * Counted matches of a strand (in the slice the trail would count, relation endpoints aside) whose rows fall outside
 * every trail lane: user imports, describing passages, title stubs (matches in text, works in titles and abstracts).
 */
function trailOutside(db, def, strand) {
  const plain = { ...def, lanes: { ...def.lanes, facet: 'modality' } };
  const rows = strandDocRows(db, plain, strand, { where: `${trailValueSql(srcCols(plain))} IS NULL` });
  return rows.reduce((n, r) => n + countValue(r.uc, [r]), 0);
}

/**
 * Context-group lanes (C1): one per group of the run in `ord` order, then the residual lane; groups with no counted
 * occurrence in this slice are still listed (n 0). lane_state names why there are none.
 */
function clusterLaneSet(db, def, all, { gates, pending, revCutoff, coverageOf }) {
  const cl = def.cluster ?? { state: 'unavailable', note: null };
  if (cl.state !== 'ok') {
    return { visible: [], extra: { lane_state: cl.state, lane_note: cl.note ?? null,
      ...(cl.state === 'not_run' ? { suggestion: cl.suggestion ?? null } : {}), ...(cl.state === 'gated' ? { gate: cl.gate } : {}) } };
  }
  const byKey = new Map(all.map((l) => [l.key, l]));
  const ucs = [...new Set(all.map((l) => l.modality))].filter((m) => m === 'text' || m === 'titles' || m === 'abstracts');
  if (!ucs.length) ucs.push('text');
  const visible = [];
  for (const g of groupLanes(db, cl, { revCutoff })) {
    for (const uc of ucs) {
      const key = laneKey('cluster', g.value, uc);
      const l = byKey.get(key) ?? laneJson(def, { key, value: g.value, uc, label: g.text, unit: unitOf(uc), n: 0, docs: 0, firstRow: null,
        lastRow: null, undated: 0, scheduled: 0, names: 0, synthetic: false, strands: {}, coverage: coverageOf(uc) },
      gates, pending);
      visible.push({ ...l, label: g.label, label_text: uc === 'text' ? g.text : `${g.text} · ${uc}`, cluster_id: g.cluster_id, ord: g.ord,
        run: cl.run, status: g.status, tentative: g.tentative, stability: g.stability, group_size: g.size,
        note: 'machine label (editable) — a computed hypothesis over context words, not a meaning' });
    }
  }
  return { visible, extra: { lane_state: 'ok', cluster: { run: cl.run, groups: cl.groups.length, residual_groups: cl.residual.length,
    href: `/api/clusters?expr=${def.strands[0].ref}&run=${cl.run}`,
    note: 'Transitions (split, merge, emerge, vanish) are on GET /api/clusters.' } } };
}

function laneJson(def, l, gates, pending) {
  const c = l.coverage;
  const unitWord = l.uc === 'titles' || l.uc === 'cells' ? 'works' : 'tokens';
  const amount = c ? (unitWord === 'works' ? c.docs : c.tokens) : 0;
  const span = c && c.span_lo !== null ? [c.span_lo, c.span_hi] : null;
  const spanText = span ? `, ${yearLabel(span[0])}–${yearLabel(span[1])}` : '';
  const modality = l.uc === 'cells' ? 'abstracts' : l.uc === 'none' ? 'lexical' : l.uc;
  const selection = c ? selectionNote(String(c.samplings ?? '').split(',')) : null;
  // "Classroom · text · 14.4k tokens, 1890–1969"; a split lane's label already names its unit class
  const head = def.lanes.facet === 'modality' || def.lanes.facet === 'trail' || l.uc !== 'text' ? l.label : `${l.label} · ${modality}`;
  const word = amount === 1 ? unitWord.replace(/s$/, '') : unitWord;
  const header = `${head} · ${formatAmount(amount)} ${word}${spanText}${selection ? ` · ${selection}` : ''}`;
  const first = l.firstRow, last = l.lastRow;
  // the basis and document of the first/last record travel with the date (the Crossings card prints "first observed in
  // this corpus 1906 (stated)" without a passage lookup per lane); basis is the document's date basis, as on its date card
  const firstOf = (r) => (r ? { label: r.date_label, precision: r.precision, lo_day: r.lo_day, basis: r.basis ?? null, document: r.doc ?? null } : null);
  const lastOf = (r) => (r ? { label: r.date_label, precision: r.precision, hi_day: r.hi_day, basis: r.basis ?? null, document: r.doc ?? null } : null);
  const out = {
    key: l.key, label: l.label, unit: l.unit, modality, order_rule: def.lanes.order, header,
    coverage: { [unitWord]: amount, docs: c?.docs ?? 0, span, ...(unitWord === 'works' ? {} : { outside_chronology_tokens: c?.outside_tokens ?? 0 }) },
    n: l.n, docs: l.docs,
    first: firstOf(first),
    last: lastOf(last),
    undated: l.undated, scheduled: l.scheduled, undated_share: l.n ? Math.round((l.undated / l.n) * 1000) / 1000 : 0,
    undated_warning: l.n && l.undated / l.n >= 0.2 ? `⚠ ${Math.round((l.undated / l.n) * 100)}% of matches undated` : null,
    censor: {
      left: Boolean(first && c?.bin_lo !== null && c?.bin_lo !== undefined && Math.floor(first.y_lo / 10) <= c.bin_lo),
      right: Boolean(last && c?.bin_hi !== null && c?.bin_hi !== undefined && Math.floor(last.y_hi / 10) >= c.bin_hi),
    },
    gate: l.uc === 'none' ? null : l.uc === 'cells' ? SHARE_GATE : gates.of(l.key, l.uc),
    names_excluded: def.toggles.nm ? 0 : l.names,
    strands: Object.fromEntries(Object.entries(l.strands).map(([k, s]) => [k, {
      n: s.n, docs: s.docs, dated: s.dated, undated: s.undated, scheduled: s.scheduled, names_excluded: s.names,
      first: firstOf(s.first),
      last: lastOf(s.last),
      washes_by_tier: s.washes_by_tier,
    }])),
    synthetic: l.synthetic,
    _firstDay: first ? first.lo_day : null, _lastDay: last ? last.hi_day : null,
    _yLo: first ? first.y_lo : null, _yHi: last ? last.y_hi : null,
  };
  if (selection) out.selection = selection;
  if (l.uc !== 'cells' && gates.rateless?.(denomKeyOf(def, l.key, l.uc)) && def.lanes.facet !== 'trail') out.rate_note = CELL_SAMPLE_NOTE;
  if (pending.has(l.uc)) { out.state = 'pending'; out.note = 'indexing — not yet looked'; }
  return out;
}

function formatAmount(n) {
  if (!(n > 0)) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Number((n / 1e3).toFixed(n < 1e4 ? 1 : 0))}k`;
  return `${Number((n / 1e6).toFixed(n < 1e7 ? 1 : 0))}M`;
}

/**
 * Default exclusions, counted (honesty rule 9). Each excluded match is attributed to the FIRST rule (in this
 * order) that removes it, so the buckets add up: other language · not rate-eligible · retrospective
 * descriptions · editorial apparatus · translations · duplicates · estimated dates · proper-noun guard. A name-guard hit
 * in a row an earlier rule excludes counts under that rule, so `names` equals totals.names_excluded and turning every
 * toggle on adds exactly the sum of the buckets. Non-'ok' passages (boilerplate, furniture, front matter, low, gappy) are
 * listed apart: they never reach expr_doc's n. On the Term trail relation endpoints are counted (works mode) and rows outside every trail lane are
 * not exclusions here (trail.outside counts them). Each member corpus of a strand is read with its own languages.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {object} per strand key: { other_language, not_rate_eligible, describes, apparatus, translations,
 *   duplicates, estimated, names, passage_quality: {quality: n} }
 */
export function excludedCounts(db, def) {
  const out = {};
  const corpora = new Set(def.corpusIds ?? [def.corpusId]);
  const endpointsCount = readsEndpoints(def);
  for (const strand of def.strands) {
    if (strand.type !== 'expression' || !strand.run) continue;
    const e = { other_language: 0, not_rate_eligible: 0, describes: 0, apparatus: 0, translations: 0, duplicates: 0,
      estimated: 0, names: 0, passage_quality: {} };
    const listOk = (key, value) => {
      const vals = def.f[key] ?? [];
      const inc = vals.filter((v) => !v.startsWith('-')), exc = vals.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
      return (!inc.length || inc.includes(value)) && !exc.includes(value);
    };
    for (const m of strand.members ?? [{ ref: strand.ref, run: strand.run, langs: strand.langs }]) {
      if (!m.ref || !m.run) continue;
      const langs = strand.langsByCorpus ? m.langs : strand.langs;
      const rows = stmt(db, `SELECT x.plang, x.field_class, x.n, x.n_names, d.is_translation, d.dup_of, d.basis, d.deleted_at, d.import_batch_id,
          d.is_synthetic, c.rate_eligible, c.sampling, c.corpus_id, d.kind, c.slug, d.culture, d.field, d.community, d.lang_text
        FROM expr_doc x JOIN document d ON d.id = x.document_id JOIN collection c ON c.id = d.collection_id
        WHERE x.expression_id = ? AND x.run_id = ?`).all(m.ref, m.run);
      for (const r of rows) {
        const gone = r.deleted_at !== null && !(def.cutoffs?.at && r.deleted_at > def.cutoffs.at);
        if (gone || !corpora.has(r.corpus_id) || (def.f.syn === 0 && r.is_synthetic)) continue;
        if (def.cutoffs?.import_batch && r.import_batch_id !== null && r.import_batch_id > def.cutoffs.import_batch) continue;
        if (!listOk('kind', r.kind) || !listOk('coll', r.slug) || !listOk('culture', r.culture) || !listOk('field', r.field) ||
          !listOk('community', r.community) || !listOk('basis', r.basis) || !listOk('lang', r.plang)) continue;
        let bucket = null;
        if (!langAdmits(langs, r.plang, r.field_class, r.lang_text)) bucket = 'other_language';
        else if (!r.rate_eligible && !(endpointsCount && r.sampling === 'relation_endpoints')) bucket = 'not_rate_eligible';
        else if (r.field_class === 'describes' && !def.toggles.ds) bucket = 'describes';
        else if (r.field_class === 'apparatus' && !def.toggles.ap) bucket = 'apparatus';
        else if (r.is_translation && !def.toggles.tr) bucket = 'translations';
        else if (r.dup_of !== null && !def.toggles.dup) bucket = 'duplicates';
        else if (r.basis === 'estimated' && !def.toggles.est) bucket = 'estimated';
        // first rule wins (fix pass): a name-guard hit in a row another rule excludes is counted under that rule, so with
        // every toggle on the count rises by exactly Σ buckets + names (§13 rule 9)
        if (bucket) e[bucket] += r.n + r.n_names;
        else if (!def.toggles.nm) e.names += r.n_names;
      }
      const mm = stmt(db, 'SELECT metrics_json FROM analysis_run WHERE id = ?').get(m.run);
      let q = {};
      try { q = JSON.parse(mm?.metrics_json ?? '{}').excluded_quality ?? {}; } catch { q = {}; }
      for (const [k, v] of Object.entries(q)) e.passage_quality[k] = (e.passage_quality[k] ?? 0) + v;
    }
    out[strand.key] = e;
  }
  return out;
}

/**
 * The provenance block of every data response (§7). A virtual corpus lists its member corpora (`corpora`) and every
 * member's materialize run.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {{data_version: number, run_ids: object, tokenizer: string, segmenter: string, synthetic: boolean,
 *   collections: string[], licenses: string[], corpora?: string[]}}
 */
export function provenanceOf(db, def) {
  const ids = def.corpusIds ?? [def.corpusId];
  const eligible = readsEndpoints(def) ? "(rate_eligible = 1 OR sampling = 'relation_endpoints')" : 'rate_eligible = 1';
  const colls = stmt(db, `SELECT slug, license, is_synthetic FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?)) AND ${eligible}
    AND EXISTS (SELECT 1 FROM document d WHERE d.collection_id = collection.id AND d.deleted_at IS NULL) ORDER BY slug`).all(JSON.stringify(ids));
  const materialize = {};
  for (const s of def.strands ?? []) {
    if (s.type !== 'expression') continue;
    for (const m of s.members ?? [{ ref: s.ref, run: s.run }]) if (m.ref && m.run) materialize[m.ref] = m.run;
  }
  const runIds = Object.keys(materialize).length ? { materialize } : {};
  if (def.cluster?.run) runIds.cluster = def.cluster.run;
  const out = {
    data_version: dataVersion(db),
    run_ids: runIds,
    tokenizer: TOKENIZER_VERSION,
    segmenter: SEGMENTER_VERSION,
    synthetic: Boolean(def.synthetic) || colls.some((c) => c.is_synthetic === 1),
    collections: colls.map((c) => c.slug),
    licenses: [...new Set(colls.map((c) => c.license).filter(Boolean))],
  };
  if (def.virtual) {
    out.corpus = def.corpus;
    out.corpora = stmt(db, 'SELECT slug FROM corpus WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(ids)).map((r) => r.slug);
  }
  return out;
}

/**
 * Lane filter condition for a lane key: (facet value, unit class) of the def's facet.
 * @param {object} def
 * @param {string} key
 * @param {{plang: string, fc: string, grp?: string}} cols
 * @returns {{sql: string, params: any[]}}
 * @throws {HttpError} 400 when the key is not a lane of this facet
 */
export function laneWhere(def, key, cols) {
  let p;
  try { p = parseLaneKey(key); } catch (err) { throw bad(err.message, { field: 'lane' }); }
  if (p.facet !== def.lanes.facet) throw bad(`Lane '${key}' is not a ${def.lanes.facet} lane of this query.`, { field: 'lane' });
  const lv = facetSql(def.lanes.facet, cols);
  const parts = [p.value === null || p.value === NONE ? `${lv} IS NULL` : `${lv} = ?`, `${unitClassSql(def.lanes.facet, cols)} = ?`];
  const params = p.value === null ? [p.unitClass] : [p.value, p.unitClass];
  return { sql: `(${parts.join(' AND ')})`, params };
}

/**
 * A def from a saved ViewState (exports, saved views): strands resolve to their pinned runs (state.runs) or the
 * current ones. Read-only: missing counts are reported, never started.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} state ViewState (canonical)
 * @param {{scope?: object|null}} [opts] a resolved corpus scope instead of state.corpus (buildDef's option, for tests)
 * @returns {{def: object, missing: number[]}}
 */
export function defFromViewState(db, state, { scope = null } = {}) {
  const req = canonicalRequest({
    corpus: state.corpus,
    strands: (state.strands ?? []).map((s) => ({ type: s.type, ref: s.id })),
    lanes: { facet: state.lanes?.facet, order: state.lanes?.order, max: state.lanes?.max, manual: state.lanes?.manual,
      run: state.lanes?.facet === 'cluster' ? state.lanes?.run ?? state.runs?.cluster ?? null : null },
    f: formatFilter(state.f ?? {}, { withDefaults: true }),
    toggles: state.toggles,
    timeBasis: state.timeBasis,
    runs: { materialize: state.runs?.materialize ?? {} },
  });
  const { def, materialize, track } = buildDef(db, req, { scope });
  return { def, missing: [...materialize.filter((m) => !m.hasRun).map((m) => m.expressionId), ...track.map((t) => t.for)] };
}
