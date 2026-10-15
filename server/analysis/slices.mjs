// OWNER: WP4
// slices.mjs — what Compare and collocations read (SPEC §2.E, §4.6): request normalization, the expressions
// and their materialize runs, the documents of the slices' collections with their denominators
// (doc_tokens) and counts (expr_doc), per-slice aggregation in one modality, the index the gate widening
// searches, and passage text for KWIC.
//
// Slice membership is fit-or-wash (§13 rule 4): a document is in a slice only when its whole date interval
// [y_lo, y_hi] lies inside the slice's years; one that overlaps without fitting is a wash and is counted,
// never apportioned. Undated and scheduled documents never enter a slice.

import { parseFilter } from '../../src/shared/viewstate.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { RATE_UNITS, SAMPLING_LABELS, TOGGLE_DEFAULTS, VIRTUAL_CORPORA } from '../../src/shared/vocab.mjs';
import { badRequest, HttpError, notFound } from '../http/errors.mjs';
import { langAdmits } from '../aggregate/langgate.mjs';
import { strandLanguages as countedLanguages } from '../aggregate/materialize.mjs';
import { griesDP } from './intervals.mjs';

/** Years a slice may span (astronomical; §8.2 axis limits). */
export const MIN_YEAR = -10000;
export const MAX_YEAR = 2100;
/** Field classes counted per modality before the describes/apparatus toggles (§4.6, §6.5, §10.2). */
export const MODALITY_CLASSES = Object.freeze({
  text: ['text'], titles: ['title'], abstracts: ['abstract', 'title'], lexical: ['text', 'title'], baseline: [],
});
/** Default coverage gates by unit (§4.6; a collection's coverage_gate overrides). */
export const DEFAULT_GATES = Object.freeze({ tokens: 50000, works: 30, sampled_works: 20 });
/** A modality holding at least this share of a slice's evidence is that slice's dominant modality (§2.E). */
export const DOMINANT_MODALITY_SHARE = 0.8;
/** KWIC context on each side, in tokens (§4.4). */
export const KWIC_TOKENS = 12;

const FACET_KEYS = ['kind', 'culture', 'field', 'community', 'basis'];

// ── Request normalization ────────────────────────────────────────────────────────────────────────────

/**
 * Validate one slice of a request: {years: [lo, hi], f?: string}.
 * @param {unknown} raw
 * @param {'a'|'b'} which
 * @returns {{years: [number, number], f: string}}
 * @throws {HttpError} 400 E_VALIDATION
 */
export function normalizeSlice(raw, which) {
  const name = which.toUpperCase();
  const years = raw?.years;
  if (!Array.isArray(years) || years.length !== 2 || !years.every(Number.isSafeInteger) || years[0] > years[1]) {
    throw badRequest('E_VALIDATION', `Slice ${name} must have years [lo, hi] with lo ≤ hi.`,
      'Set both slices with A and B on a range, then C.', { field: `${which}.years` });
  }
  if (years[0] < MIN_YEAR || years[1] > MAX_YEAR) {
    throw badRequest('E_VALIDATION', `Slice ${name} must lie between ${MIN_YEAR} and ${MAX_YEAR}.`,
      'Years are astronomical (1 BCE = 0).', { field: `${which}.years` });
  }
  const f = raw.f ?? '';
  if (typeof f !== 'string' || f.length > 1000) {
    throw badRequest('E_VALIDATION', `Slice ${name} has a malformed filter.`, "Use the filter grammar, e.g. 'lang:en;kind:book'.",
      { field: `${which}.f` });
  }
  return { years: [years[0], years[1]], f };
}

/** A UTC instant as nowIso() writes it (a saved view's save time), as the timeline query accepts it (query.mjs). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const posInt = (x) => Number.isSafeInteger(x) && x > 0;

/**
 * RF-2 (D17): the pins and cutoffs of a saved view opened "as saved", in the timeline query's words — `runs.materialize`
 * (expression id → the counting run pinned at save), `runs.cluster` (the clustering run the view showed) and `cutoffs`
 * (`import_batch`, `at` = the save time, `annotation_rev`). Pins of expressions outside `expr` are not this comparison's and
 * are dropped, so a normalized request normalizes to itself. Absent → current data.
 * @param {object} body the request
 * @param {number[]} exprIds the compared expressions
 * @returns {{runs: {materialize?: Record<string, number>, cluster?: number}|null, cutoffs: {import_batch?: number, at?: string,
 *   annotation_rev?: number}|null}}
 * @throws {HttpError} 400 E_VALIDATION
 */
export function normalizeAsSaved(body, exprIds) {
  const bad = (message, field) => badRequest('E_VALIDATION', message, 'Send the runs and cutoffs of GET /api/views/:slug, as the timeline query does.', { field });
  let runs = null;
  if (body.runs !== undefined && body.runs !== null) {
    if (!isObject(body.runs)) throw bad('runs must be {materialize: {<expression id>: <run id>}, cluster?: <run id>}.', 'runs');
    const m = body.runs.materialize ?? {};
    if (!isObject(m)) throw bad('runs.materialize must map expression ids to run ids.', 'runs.materialize');
    const materialize = {};
    for (const [k, v] of Object.entries(m)) {
      const id = Number(k);
      if (!posInt(id) || !posInt(v)) throw bad(`runs.materialize must map expression ids to run ids (got ${k}: ${JSON.stringify(v)}).`, 'runs.materialize');
      if (exprIds.includes(id)) materialize[String(id)] = v;
    }
    const cluster = body.runs.cluster ?? null;
    if (cluster !== null && !posInt(cluster)) throw bad('runs.cluster must be a clustering run id.', 'runs.cluster');
    runs = { ...(Object.keys(materialize).length ? { materialize } : {}), ...(cluster !== null ? { cluster } : {}) };
    if (!Object.keys(runs).length) runs = null;
  }
  let cutoffs = null;
  if (body.cutoffs !== undefined && body.cutoffs !== null) {
    if (!isObject(body.cutoffs)) throw bad('cutoffs must be {import_batch?, at?, annotation_rev?}.', 'cutoffs');
    const c = body.cutoffs;
    const out = {};
    if (c.import_batch !== undefined && c.import_batch !== null) {
      if (!posInt(c.import_batch)) throw bad('cutoffs.import_batch must be a positive integer.', 'cutoffs.import_batch');
      out.import_batch = c.import_batch;
    }
    if (c.at !== undefined && c.at !== null) {
      if (!(typeof c.at === 'string' && ISO_INSTANT.test(c.at) && Number.isFinite(Date.parse(c.at)))) {
        throw bad("cutoffs.at must be the view's save time (an ISO 8601 UTC timestamp).", 'cutoffs.at');
      }
      out.at = c.at;
    }
    if (c.annotation_rev !== undefined && c.annotation_rev !== null) {
      if (!(Number.isSafeInteger(c.annotation_rev) && c.annotation_rev >= 0)) throw bad('cutoffs.annotation_rev must be a non-negative integer.', 'cutoffs.annotation_rev');
      out.annotation_rev = c.annotation_rev;
    }
    cutoffs = Object.keys(out).length ? out : null;
  }
  return { runs, cutoffs };
}

/**
 * The document condition of a scope (alias `d`): live documents, or as saved (RF-2, the timeline's docWhere rule) the
 * documents of imports ≤ the cutoff, including those soft-deleted after the save time (a later revert, D17).
 * @param {{import_batch?: number, at?: string}|null} cutoffs
 * @returns {{sql: string, args: Array<string|number>}}
 */
export function scopeDocFilter(cutoffs) {
  const sql = [cutoffs?.at ? '(d.deleted_at IS NULL OR d.deleted_at > ?)' : 'd.deleted_at IS NULL'];
  const args = cutoffs?.at ? [cutoffs.at] : [];
  if (cutoffs?.import_batch) { sql.push('(d.import_batch_id IS NULL OR d.import_batch_id <= ?)'); args.push(cutoffs.import_batch); }
  return { sql: sql.join(' AND '), args };
}

/**
 * Toggles with their defaults (§7: tr ds ap dup nm est bp).
 * @param {unknown} raw
 * @returns {{tr: number, ds: number, ap: number, dup: number, nm: number, est: number, bp: number}}
 */
export function normalizeToggles(raw) {
  const out = { ...TOGGLE_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out)) {
      const v = raw[k];
      if (v === 0 || v === 1) out[k] = v;
      else if (v === '0' || v === '1') out[k] = Number(v);
      else if (v === true || v === false) out[k] = v ? 1 : 0;
    }
  }
  return out;
}

/**
 * Field classes counted for a modality under the toggles.
 * @param {string} modality
 * @param {{ds: number, ap: number}} toggles
 * @returns {Set<string>}
 */
export function fieldClassesFor(modality, toggles) {
  const set = new Set(MODALITY_CLASSES[modality] ?? ['text']);
  if (toggles.ds) set.add('describes');
  if (toggles.ap && modality === 'text') set.add('apparatus');
  return set;
}

// ── Expressions ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The expressions of a request, each with its enabled variants, its strand languages (null = any) and the
 * materialize run whose counts are read: the run a saved view pinned (as saved, RF-2), else expression_state.run_id when
 * that run succeeded, else the newest succeeded materialize run holding rows for it. Visibility rule (§3): only succeeded
 * runs.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @param {{pinned?: Record<string, number>|null}} [opts] expression id → pinned materialize run
 * @returns {Array<{id: number, surface: string, norm: string, kind: string, lang: string|null, corpus_id: number|null,
 *   synthetic: boolean, run: number, variants: Array<{id: number|null, norm: string, tokens: string[], lang: string|null}>,
 *   langs: Set<string>|null}>}
 * @throws {HttpError} 404 for an unknown expression, 400 for a pin that is not a succeeded count of it, 409 E_NOT_MATERIALIZED
 *   while counting has no finished run
 */
export function resolveExpressions(db, ids, { pinned = null } = {}) {
  return ids.map((id) => {
    const e = db.prepare(`SELECT id, surface, norm, kind, lang, corpus_id, is_synthetic FROM expression WHERE id = ?`).get(id);
    if (!e) throw notFound(`Expression ${id}`);
    const pin = pinned?.[String(id)] ?? null;
    if (pin !== null && !db.prepare(`SELECT 1 FROM analysis_run WHERE id = ? AND stage = 'materialize' AND status = 'succeeded'
      AND json_extract(params_json, '$.expression') = ?`).get(pin, id)) {
      throw badRequest('E_VALIDATION', `Run ${pin} is not a succeeded materialization of expression ${id}.`, null, { field: 'runs' });
    }
    let run = pin ?? db.prepare(`SELECT s.run_id AS run FROM expression_state s JOIN analysis_run r ON r.id = s.run_id
      WHERE s.expression_id = ? AND r.status = 'succeeded'`).get(id)?.run ?? null;
    if (run === null) {
      run = db.prepare(`SELECT r.id FROM analysis_run r WHERE r.stage = 'materialize' AND r.status = 'succeeded'
        AND EXISTS (SELECT 1 FROM expr_doc x WHERE x.expression_id = ? AND x.run_id = r.id) ORDER BY r.id DESC LIMIT 1`).get(id)?.id ?? null;
    }
    if (run === null) {
      const st = db.prepare('SELECT status FROM expression_state WHERE expression_id = ?').get(id)?.status ?? 'none';
      throw new HttpError(409, 'E_NOT_MATERIALIZED', `Counting for '${e.surface}' has not finished (state: ${st}).`,
        'Compare is available once the expression is counted; the timeline shows the progress.', { expr: id, status: st });
    }
    const rows = db.prepare('SELECT id, norm, lang, variant_type FROM expression_variant WHERE expression_id = ? AND enabled = 1 ORDER BY id').all(id);
    const variants = (rows.length ? rows : [{ id: null, norm: e.norm, lang: e.lang, variant_type: null }])
      .map((v) => ({ id: v.id, norm: v.norm, tokens: v.norm.split(' ').filter(Boolean), lang: v.lang ?? e.lang ?? null, variant_type: v.variant_type ?? null }));
    return { id: e.id, surface: e.surface, norm: e.norm, kind: e.kind, lang: e.lang, corpus_id: e.corpus_id,
      synthetic: e.is_synthetic === 1, run, variants, langs: strandLanguages(e, variants) };
  });
}

/**
 * Passage languages an expression is counted in and divided by (§4.6: a French variant is never divided by
 * English tokens): exactly the timeline's rule (materialize.strandLanguages), so Compare's n and denominators equal
 * the tiles'. Fix pass: Compare kept its own copy, which still divided a Gujarati or Hindi word by the unidentified
 * ('und') tokens of Latin-script books — 40% of the Gujarati slice A for શૂન્ય. null = any language.
 * @param {{lang: string|null}} expr
 * @param {Array<{norm: string, lang: string|null, variant_type?: string|null}>} variants enabled variants
 * @returns {Set<string>|null}
 */
export function strandLanguages(expr, variants) {
  const langs = countedLanguages(expr, variants.map((v) => ({ ...v, enabled: 1 })));
  return langs === null ? null : new Set(langs);
}

// ── Scope: collections, documents, denominators and counts ───────────────────────────────────────────

/**
 * Every collection with its corpus slug.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<number, object>}
 */
export function loadCollections(db) {
  const out = new Map();
  for (const c of db.prepare(`SELECT c.*, k.slug AS corpus_slug FROM collection c JOIN corpus k ON k.id = c.corpus_id`).all()) {
    let caveats = [];
    try { caveats = JSON.parse(c.caveats_json); } catch { /* stored by the writer as JSON */ }
    out.set(c.id, { ...c, caveats, synthetic: c.is_synthetic === 1 });
  }
  return out;
}

function splitFilter(values) {
  const inc = [], exc = [];
  for (const v of values ?? []) (v.startsWith('-') ? exc : inc).push(v.startsWith('-') ? v.slice(1) : v);
  return { inc: inc.length ? new Set(inc) : null, exc: new Set(exc) };
}

function compileSpec(slice, which, { collections, corpusId, toggles, strandLangs }) {
  const warnings = [];
  const f = parseFilter(slice.f, warnings);
  const coll = splitFilter(f.coll);
  const facets = Object.fromEntries(FACET_KEYS.map((k) => [k, splitFilter(f[k])]));
  const lang = splitFilter(f.lang);
  for (const v of coll.inc ?? []) if (![...collections.values()].some((c) => c.slug === v)) warnings.push(`unknown collection '${v}' in the filter`);
  const collIds = new Set();
  const notRateEligible = [];
  for (const c of collections.values()) {
    if (corpusId !== null && c.corpus_id !== corpusId) continue;
    if (coll.inc && !coll.inc.has(c.slug)) continue;
    if (coll.exc.has(c.slug)) continue;
    if (f.syn === 0 && c.synthetic) continue;
    if (!c.rate_eligible || c.unit === 'none') { notRateEligible.push(c.slug); continue; }
    collIds.add(c.id);
  }
  // RF-1: the timeline's language rule (langgate.mjs): an unidentified row of a document's running text counts only in its
  // document's text language
  const langOk = (plang, fc, docLang) => langAdmits(strandLangs, plang, fc, docLang) && (!lang.inc || lang.inc.has(plang)) && !lang.exc.has(plang);
  return { which, years: slice.years, fStr: slice.f, f, warnings, collIds, notRateEligible, facets, langOk, toggles };
}

function facetsPass(doc, spec) {
  if (spec.f.syn === 0 && doc.syn) return false;
  for (const k of FACET_KEYS) {
    const { inc, exc } = spec.facets[k];
    const v = doc[k] ?? '';
    if (inc && !inc.has(v)) return false;
    if (exc.has(v)) return false;
  }
  return true;
}

function assignTerciles(docs) {
  const byColl = new Map();
  for (const d of docs.values()) {
    if (d.tercile !== null || d.prominence === null) continue;
    if (!byColl.has(d.coll)) byColl.set(d.coll, []);
    byColl.get(d.coll).push(d);
  }
  for (const list of byColl.values()) {
    list.sort((x, y) => x.prominence - y.prominence || x.id - y.id);
    list.forEach((d, i) => { d.tercile = 1 + Math.min(2, Math.floor(3 * i / list.length)); });
  }
}

/**
 * Load what both slices need: their collections' documents with denominators and the expressions' counts. As saved
 * (`cutoffs`, RF-2) only the documents the saved view counted: imports ≤ its cutoff, soft-deleted ones still counted when
 * they were deleted after its save time — the timeline's rule, so Compare equals the Scroll it was opened from.
 * @param {import('node:sqlite').DatabaseSync} db read connection
 * @param {{exprs: ReturnType<typeof resolveExpressions>, slices: Array<{years: [number, number], f: string}>,
 *   toggles: object, corpus?: string|null, cutoffs?: {import_batch?: number, at?: string}|null}} req
 * @returns {object} scope
 */
export function loadScope(db, { exprs, slices, toggles, corpus = null, cutoffs = null }) {
  const collections = loadCollections(db);
  let corpusId = null;
  if (corpus) {
    corpusId = db.prepare('SELECT id FROM corpus WHERE slug = ?').get(corpus)?.id ?? null;
    if (corpusId === null && Object.hasOwn(VIRTUAL_CORPORA, corpus)) {
      // contract 1.3.0 C2: 'real' is a view over several corpora; a comparison stays inside one corpus and one medium
      throw badRequest('E_VALIDATION', `Compare reads one corpus at a time; '${corpus}' spans ${corpus === 'real' ? 'every real corpus' : 'several corpora'}.`,
        "Compare the expression in one member corpus (its id is in the strand's members), e.g. cipher or stemm.", { field: 'corpus' });
    }
    if (corpusId === null) throw badRequest('E_VALIDATION', `Unknown corpus '${corpus}'.`, 'Use demo, cipher, stemm or user.', { field: 'corpus' });
  } else {
    const ids = new Set(exprs.map((e) => e.corpus_id));
    if (ids.size === 1 && !ids.has(null)) corpusId = [...ids][0];
  }
  let strandLangs = null;
  for (const e of exprs) {
    if (e.langs === null) { strandLangs = null; break; }
    strandLangs = new Set([...(strandLangs ?? []), ...e.langs]);
  }
  const specs = slices.map((s, i) => compileSpec(s, i === 0 ? 'a' : 'b', { collections, corpusId, toggles, strandLangs }));
  const union = [...new Set(specs.flatMap((s) => [...s.collIds]))];
  const idsJson = JSON.stringify(union);

  const docs = new Map();
  const live = scopeDocFilter(cutoffs);
  for (const r of db.prepare(`SELECT d.id, d.collection_id AS coll, d.kind, d.lang_text, d.author, d.y_lo, d.y_hi,
      d.chrono_status AS chrono, d.basis, d.precision, d.is_translation AS tr, d.dup_of AS dup, d.prominence,
      d.prominence_tercile AS tercile, d.is_synthetic AS syn, d.community, d.culture, d.field, d.title, d.date_label
    FROM document d WHERE ${live.sql} AND d.collection_id IN (SELECT value FROM json_each(?))`).iterate(...live.args, idsJson)) {
    docs.set(r.id, { ...r, tr: r.tr === 1, dup: r.dup !== null, syn: r.syn === 1, tok: [], hits: [] });
  }
  for (const t of db.prepare(`SELECT t.document_id AS id, t.plang, t.field_class AS fc, t.tokens FROM doc_tokens t
    JOIN document d ON d.id = t.document_id
    WHERE ${live.sql} AND d.collection_id IN (SELECT value FROM json_each(?))`).iterate(...live.args, idsJson)) {
    docs.get(t.id)?.tok.push(t);
  }
  for (const e of exprs) {
    for (const h of db.prepare(`SELECT document_id AS id, plang, field_class AS fc, n, n_names AS names
      FROM expr_doc WHERE expression_id = ? AND run_id = ?`).iterate(e.id, e.run)) {
      docs.get(h.id)?.hits.push({ ...h, expr: e.id });
    }
  }
  assignTerciles(docs);
  return { collections, corpusId, exprs, strandLangs, specs, docs, toggles, cutoffs };
}

// ── Per-document measures ────────────────────────────────────────────────────────────────────────────

/**
 * Denominator and count of one document in one modality under a slice's language filter.
 * Token units count tokens and matches in the strand's languages only (a French variant is never divided
 * by English tokens); work units count the work once and a match in any language of its title.
 */
function measureDoc(doc, spec, m) {
  let units = 0, n = 0, names = 0;
  const byLang = new Map();
  if (m.unit === 'tokens') {
    for (const t of doc.tok) {
      if (!m.classes.has(t.fc) || !spec.langOk(t.plang, t.fc, doc.lang_text)) continue;
      units += t.tokens;
      const e = byLang.get(t.plang) ?? { units: 0, n: 0 };
      e.units += t.tokens;
      byLang.set(t.plang, e);
    }
  } else {
    units = 1;
    byLang.set(doc.lang_text ?? 'und', { units: 1, n: 0 });
  }
  for (const h of doc.hits) {
    const langOk = m.unit === 'works' || spec.langOk(h.plang, h.fc, doc.lang_text);
    if (!langOk) continue;
    if (!m.classes.has(h.fc)) continue;
    const c = h.n + (spec.toggles.nm ? h.names : 0);
    n += c;
    if (!spec.toggles.nm) names += h.names;
    const key = m.unit === 'tokens' ? h.plang : (doc.lang_text ?? 'und');
    const e = byLang.get(key) ?? { units: 0, n: 0 };
    e.n += c;
    byLang.set(key, e);
  }
  return { units, n, names, byLang };
}

/** Measure config of a modality in a scope. */
export function modalityConfig(scope, modality, collIds) {
  const units = new Set();
  for (const id of collIds) {
    const c = scope.collections.get(id);
    if (c && c.modality === modality) units.add(c.unit === 'tokens' ? 'tokens' : 'works');
  }
  const unit = units.has('tokens') ? 'tokens' : 'works';
  return { modality, unit, classes: fieldClassesFor(modality, scope.toggles) };
}

function placeDoc(doc, years) {
  if (doc.chrono !== 'dated') return doc.chrono; // 'undated' | 'scheduled'
  const [lo, hi] = years;
  if (doc.y_lo >= lo && doc.y_hi <= hi) return 'in';
  if (doc.y_lo <= hi && doc.y_hi >= lo) return 'wash';
  return 'out';
}

function exclusionOf(doc, toggles) {
  if (!toggles.tr && doc.tr) return 'translations';
  if (!toggles.dup && doc.dup) return 'duplicates';
  if (!toggles.est && doc.basis === 'estimated') return 'estimated';
  return null;
}

/**
 * Evidence per modality in a slice (before choosing the compared modality): occurrences and covered
 * documents of every modality among the slice's included documents.
 * @param {object} scope
 * @param {object} spec
 * @returns {Record<string, {n: number, docs: number, units: number}>}
 */
export function modalityEvidence(scope, spec) {
  const out = {};
  for (const doc of scope.docs.values()) {
    if (!spec.collIds.has(doc.coll) || !facetsPass(doc, spec)) continue;
    if (placeDoc(doc, spec.years) !== 'in' || exclusionOf(doc, scope.toggles)) continue;
    const c = scope.collections.get(doc.coll);
    const cfg = modalityConfig(scope, c.modality, spec.collIds);
    const m = measureDoc(doc, spec, cfg);
    if (!(m.units > 0)) continue;
    const e = out[c.modality] ?? (out[c.modality] = { n: 0, docs: 0, units: 0 });
    e.n += m.n;
    e.docs++;
    e.units += m.units;
  }
  return out;
}

const share = (map, total) => {
  const out = {};
  if (!(total > 0)) return out;
  for (const [k, v] of Object.entries(map)) if (v > 0) out[k] = Number((v / total).toFixed(4));
  return out;
};
const bump = (obj, key, by = 1) => { obj[key] = (obj[key] ?? 0) + by; };

/**
 * Aggregate one slice in one modality: denominators, counts, documents, authors, dispersion, composition,
 * prominence terciles, date-basis mix, every exclusion counted (§13 rule 9), and the coverage gate.
 * @param {object} scope
 * @param {object} spec
 * @param {string} modality
 * @returns {object} slice stats
 */
export function sliceStats(scope, spec, modality) {
  const cfg = modalityConfig(scope, modality, spec.collIds);
  const rateUnit = cfg.unit === 'tokens' ? 'per_million_tokens' : 'per_thousand_works';
  const st = {
    which: spec.which, years: spec.years, f: spec.fStr, modality, unit: cfg.unit, rateUnit, scale: RATE_UNITS[rateUnit].scale,
    classes: [...cfg.classes], units: 0, unitsNoTr: 0, n: 0, k: 0, names: 0, docs: 0, evidenceDocs: 0, perDoc: [],
    authors: new Set(), evidenceAuthors: new Set(), strata: new Map(), kinds: {}, langs: {}, colls: {}, basis: {}, terciles: {},
    excluded: { translations: { docs: 0, n: 0 }, duplicates: { docs: 0, n: 0 }, estimated: { docs: 0, n: 0 },
      washes: { docs: 0, n: 0 }, other_modality: { docs: 0, n: 0, modalities: {} }, describes: 0, apparatus: 0, names: 0,
      not_rate_eligible: spec.notRateEligible },
    undated: { docs: 0, n: 0 }, scheduled: { docs: 0, n: 0 }, matching: 0, translationsIncluded: 0,
    collections: new Set(), gateUnits: 0, sampling: new Set(), synthetic: false, topDoc: null, filterWarnings: spec.warnings,
  };
  for (const doc of scope.docs.values()) {
    if (!spec.collIds.has(doc.coll) || !facetsPass(doc, spec)) continue;
    const coll = scope.collections.get(doc.coll);
    const place = placeDoc(doc, spec.years);
    if (coll.modality !== modality) {
      if (place === 'in' && !exclusionOf(doc, scope.toggles)) {
        const m = measureDoc(doc, spec, modalityConfig(scope, coll.modality, spec.collIds));
        if (m.units > 0) {
          st.excluded.other_modality.docs++;
          st.excluded.other_modality.n += m.n;
          bump(st.excluded.other_modality.modalities, coll.modality);
        }
      }
      continue;
    }
    const m = measureDoc(doc, spec, cfg);
    if (!(m.units > 0) && !(m.n > 0)) continue;
    const ex = exclusionOf(doc, scope.toggles);
    if (!ex) st.matching++;
    if (place === 'out') continue;
    if (ex) {
      if (place === 'in') { st.excluded[ex].docs++; st.excluded[ex].n += m.n; }
      continue;
    }
    if (place === 'undated' || place === 'scheduled') { st[place].docs++; st[place].n += m.n; continue; }
    if (place === 'wash') { st.excluded.washes.docs++; st.excluded.washes.n += m.n; continue; }
    if (!(m.units > 0)) continue;

    // included
    if (doc.tr) st.translationsIncluded++; else st.unitsNoTr += m.units;
    st.units += m.units;
    st.n += m.n;
    st.names += m.names;
    st.docs++;
    st.collections.add(coll.slug);
    st.sampling.add(coll.id);
    if (doc.syn) st.synthetic = true;
    if (doc.author) st.authors.add(doc.author);
    if (m.n > 0) {
      st.k++;
      st.evidenceDocs++;
      if (doc.author) st.evidenceAuthors.add(doc.author);
      if (!st.topDoc || m.n > st.topDoc.n) st.topDoc = { id: doc.id, n: m.n };
    }
    st.perDoc.push({ id: doc.id, units: m.units, n: m.n });
    for (const h of doc.hits) {
      if (!cfg.classes.has(h.fc) && (h.fc === 'describes' || h.fc === 'apparatus') && (cfg.unit === 'works' || spec.langOk(h.plang, h.fc, doc.lang_text))) {
        st.excluded[h.fc] += h.n;
      }
    }
    for (const [plang, e] of m.byLang) {
      const key = `${doc.kind}|${plang}|${coll.slug}`;
      const s = st.strata.get(key) ?? { n: 0, units: 0, k: 0 };
      s.units += e.units;
      s.n += e.n;
      if (cfg.unit === 'works' && e.n > 0) s.k += 1;
      st.strata.set(key, s);
      bump(st.langs, plang, e.units);
    }
    bump(st.kinds, doc.kind, m.units);
    bump(st.colls, coll.slug, m.units);
    bump(st.basis, doc.basis);
    const t = doc.tercile ?? 'unknown';
    const te = st.terciles[t] ?? (st.terciles[t] = { n: 0, units: 0, k: 0 });
    te.n += m.n;
    te.units += m.units;
    if (m.n > 0) te.k++;
    const gate = coll.coverage_gate ?? (cfg.unit === 'tokens' ? DEFAULT_GATES.tokens
      : coll.sampling === 'top_cited_per_cell' ? DEFAULT_GATES.sampled_works : DEFAULT_GATES.works);
    st.gateUnits = Math.max(st.gateUnits, gate);
  }
  st.excluded.names = st.names;
  if (!st.gateUnits) {
    // nothing covered: the gate of the slice's collections in this modality, so the card can say what is needed
    for (const id of spec.collIds) {
      const c = scope.collections.get(id);
      if (c?.modality !== modality) continue;
      st.gateUnits = Math.max(st.gateUnits, c.coverage_gate ?? (cfg.unit === 'tokens' ? DEFAULT_GATES.tokens : DEFAULT_GATES.works));
    }
    st.gateUnits ||= cfg.unit === 'tokens' ? DEFAULT_GATES.tokens : DEFAULT_GATES.works;
  }
  st.rateN = cfg.unit === 'tokens' ? st.n : st.k;
  st.topDocShare = st.n > 0 && st.topDoc ? st.topDoc.n / st.n : null;
  st.dp = st.n > 0 ? griesDP(st.perDoc.map((d) => ({ n: cfg.unit === 'tokens' ? d.n : (d.n > 0 ? 1 : 0), size: d.units }))) : null;
  st.mix = share(st.kinds, st.units);
  st.languages = share(st.langs, st.units);
  st.collectionMix = share(st.colls, st.units);
  st.basisMix = share(st.basis, st.docs);
  st.undatedShare = st.matching > 0 ? st.undated.docs / st.matching : 0;
  st.composition = Object.fromEntries([...st.strata].map(([k, v]) => [k, v.units]));
  st.selection = [...st.sampling].map((id) => scope.collections.get(id))
    .filter((c) => !['complete', 'user'].includes(c.sampling))
    .map((c) => ({ collection: c.slug, sampling: c.sampling, label: SAMPLING_LABELS[c.sampling] ?? c.sampling, note: c.selection_note ?? null }));
  return st;
}

// ── The index the gate widening searches ─────────────────────────────────────────────────────────────

/**
 * Dated documents of a slice's filters in one modality, ignoring its years: evidence documents one by one
 * (for occurrence, document, author and top-document gates) and coverage aggregated by (y_lo, y_hi) (for
 * token gates), plus the collection's span, which bounds any widening.
 * @param {object} scope
 * @param {object} spec
 * @param {string} modality
 * @returns {{evidence: Array<{y_lo: number, y_hi: number, n: number, author: string|null}>,
 *   cover: Array<{y_lo: number, y_hi: number, units: number, unitsNoTr: number, docs: number, authors: string[]}>,
 *   bounds: [number, number]|null}}
 */
export function wideningIndex(scope, spec, modality) {
  const cfg = modalityConfig(scope, modality, spec.collIds);
  const evidence = [];
  const cover = new Map();
  let minY = Infinity, maxY = -Infinity;
  for (const doc of scope.docs.values()) {
    if (!spec.collIds.has(doc.coll) || !facetsPass(doc, spec) || doc.chrono !== 'dated') continue;
    if (scope.collections.get(doc.coll).modality !== modality || exclusionOf(doc, scope.toggles)) continue;
    const m = measureDoc(doc, spec, cfg);
    if (!(m.units > 0)) continue;
    minY = Math.min(minY, doc.y_lo);
    maxY = Math.max(maxY, doc.y_hi);
    if (m.n > 0) evidence.push({ y_lo: doc.y_lo, y_hi: doc.y_hi, n: m.n, author: doc.author ?? null });
    const key = `${doc.y_lo}|${doc.y_hi}`;
    const c = cover.get(key) ?? { y_lo: doc.y_lo, y_hi: doc.y_hi, units: 0, unitsNoTr: 0, docs: 0, authors: [] };
    c.units += m.units;
    if (!doc.tr) c.unitsNoTr += m.units;
    c.docs++;
    if (doc.author) c.authors.push(doc.author);
    cover.set(key, c);
  }
  return { evidence, cover: [...cover.values()], bounds: Number.isFinite(minY) ? [minY, maxY] : null, unit: cfg.unit };
}

/**
 * Statistics of a candidate window [lo, hi] over a widening index (fit-or-wash, like the slices).
 * Author counts stop early once `authorsNeeded` is reached.
 * @param {ReturnType<typeof wideningIndex>} index
 * @param {number} lo
 * @param {number} hi
 * @param {{authorsNeeded?: number, coverAuthorsNeeded?: number}} [opts]
 * @returns {{n: number, docs: number, authors: number, top_doc_share: number|null, units: number, unitsNoTr: number,
 *   cover_docs: number, cover_authors: number}}
 */
export function windowStats(index, lo, hi, { authorsNeeded = Infinity, coverAuthorsNeeded = 0 } = {}) {
  let n = 0, docs = 0, top = 0, units = 0, unitsNoTr = 0, coverDocs = 0;
  const authors = new Set();
  for (const e of index.evidence) {
    if (e.y_lo < lo || e.y_hi > hi) continue;
    n += e.n;
    docs++;
    if (e.n > top) top = e.n;
    if (e.author && authors.size < authorsNeeded) authors.add(e.author);
  }
  const coverAuthors = new Set();
  for (const c of index.cover) {
    if (c.y_lo < lo || c.y_hi > hi) continue;
    units += c.units;
    unitsNoTr += c.unitsNoTr;
    coverDocs += c.docs;
    if (coverAuthors.size < coverAuthorsNeeded) for (const a of c.authors) { coverAuthors.add(a); if (coverAuthors.size >= coverAuthorsNeeded) break; }
  }
  return { n, docs, authors: authors.size, top_doc_share: n > 0 ? top / n : null, units, unitsNoTr, cover_docs: coverDocs,
    cover_authors: coverAuthors.size };
}

// ── Passage text and KWIC ────────────────────────────────────────────────────────────────────────────

/**
 * A reader of passage text that caches each document's original (body) and fields.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {(p: {document_id: number, field: string, start_off: number, end_off: number}) => string|null}
 */
export function passageTextReader(db) {
  const bodies = new Map(), fields = new Map();
  const body = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
  const field = db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?');
  return (p) => {
    let src;
    if (p.field === 'body') {
      if (!bodies.has(p.document_id)) {
        if (bodies.size > 64) bodies.clear();
        bodies.set(p.document_id, body.get(p.document_id)?.original ?? null);
      }
      src = bodies.get(p.document_id);
    } else {
      const key = `${p.document_id}|${p.field}`;
      if (!fields.has(key)) fields.set(key, field.get(p.document_id, p.field)?.value ?? null);
      src = fields.get(key);
    }
    return src === null || src === undefined ? null : src.slice(p.start_off, p.end_off);
  };
}

/**
 * A KWIC row around [relStart, relEnd) of a passage text: up to 12 tokens of context on each side,
 * clipped at the passage (§4.4). Offsets stay relative to the passage text (left.length === start).
 * @param {string} text passage text
 * @param {number} relStart
 * @param {number} relEnd
 * @param {{window?: number}} [opts]
 * @returns {{start: number, end: number, left: string, match: string, right: string}}
 */
export function kwicAround(text, relStart, relEnd, { window = KWIC_TOKENS } = {}) {
  const { starts, ends } = tokenize(text);
  let first = 0;
  while (first < starts.length && ends[first] <= relStart) first++;
  let last = first;
  while (last < starts.length && starts[last] < relEnd) last++;
  const leftFrom = first - window > 0 ? starts[first - window] : 0;
  const rightTo = last + window - 1 < ends.length ? ends[last + window - 1] : text.length;
  return { start: relStart, end: relEnd, left: text.slice(leftFrom, relStart), match: text.slice(relStart, relEnd),
    right: text.slice(relEnd, Math.max(relEnd, rightTo)) };
}

/**
 * The lane key of a document for a facet ('collection:demo-world', 'community:hiphop').
 * @param {object} doc scope document
 * @param {object} coll collection row
 * @param {string} facet
 * @returns {string}
 */
export function laneOf(doc, coll, facet) {
  const v = facet === 'collection' ? coll.slug : facet === 'language' ? doc.lang_text : facet === 'domain' ? coll.domain
    : facet === 'modality' ? coll.modality : facet === 'date_basis' ? doc.basis : doc[facet];
  return `${facet}:${v ?? 'unknown'}`;
}

// ── Representative passages ──────────────────────────────────────────────────────────────────────────

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Up to `count` KWIC rows from a slice, at most one per document (§2.E item 3): documents with matches are
 * drawn in a seeded order and one of each document's counted matches is drawn; the seed is printed with
 * the rows so the draw can be reproduced, and a new seed reshuffles.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} scope
 * @param {object} spec
 * @param {object} stats sliceStats()
 * @param {{rng: () => number, count?: number, laneFacet?: string, readText: Function}} opts
 * @returns {object[]} rows {passage, doc, occ, start, end, left, match, right, title, date, lane, collection, kind, synthetic, context_group}
 */
export function samplePassages(db, scope, spec, stats, { rng, count = 5, laneFacet = 'collection', readText }) {
  const classes = new Set(stats.classes);
  const docs = shuffle(stats.perDoc.filter((d) => d.n > 0).map((d) => d.id).sort((x, y) => x - y), rng);
  const q = db.prepare(`SELECT o.id AS occ, o.passage_id, o.start_off, o.end_off, o.name_flag, p.field, p.field_class AS fc,
      p.lang, p.quality, p.start_off AS p_start, p.end_off AS p_end
    FROM occurrence o JOIN passage p ON p.id = o.passage_id
    WHERE o.expression_id = ? AND o.run_id = ? AND o.document_id = ? ORDER BY o.id`);
  const out = [];
  let tried = 0;
  for (const docId of docs) {
    if (out.length >= count || tried >= 60) break;
    tried++;
    const doc = scope.docs.get(docId);
    const occs = scope.exprs.flatMap((e) => q.all(e.id, e.run, docId)).filter((o) => o.quality === 'ok' && classes.has(o.fc)
      && (stats.unit === 'works' || spec.langOk(o.lang, o.fc, doc.lang_text)) && (scope.toggles.nm || !o.name_flag));
    if (!occs.length) continue;
    const o = occs[Math.floor(rng() * occs.length)];
    const text = readText({ document_id: docId, field: o.field, start_off: o.p_start, end_off: o.p_end });
    if (text === null) continue;
    const coll = scope.collections.get(doc.coll);
    out.push({ passage: o.passage_id, doc: docId, occ: o.occ, ...kwicAround(text, o.start_off - o.p_start, o.end_off - o.p_start),
      title: doc.title, date: { label: doc.date_label, precision: doc.precision }, lane: laneOf(doc, coll, laneFacet),
      collection: coll.slug, kind: doc.kind, synthetic: doc.syn, context_group: null });
  }
  return out;
}
