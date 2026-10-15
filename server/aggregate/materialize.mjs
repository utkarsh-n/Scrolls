// OWNER: WP3
// materialize.mjs — tracked expressions and their materialization (SPEC §4.5, §4.6, D6):
// expression + enabled variants → FTS candidates → JS tokenization of each candidate passage → exact
// token-sequence match → occurrence rows (original offsets, proper-noun guard) → expr_doc rows.
//
// Expressions are created on the main connection (short interactive writes); counting runs in the
// `materialize` job (tasks/materialize.mjs) on the job's own connection. A run's rows become visible only
// when its analysis_run is 'succeeded' (visibility rule, §3); expression_state.run_id then points at it. An
// older run is never deleted or demoted: saved views may pin it (§4.0).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, fnv1a32 } from '../../src/shared/ids.mjs';
import { findSequence, tokenize } from '../../src/shared/tokenize.mjs';
import { EXPRESSION_KINDS } from '../../src/shared/vocab.mjs';
import { bumpDataVersion, dataVersion, nowIso, stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { inputFingerprint, makeTaskContext } from '../jobs/context.mjs';
import { passageText } from '../text/kwic.mjs';
import { authorTokens, documentNameRule, isCapitalized, nameFlag, nameIndex } from '../text/names.mjs';
import { TRANSLIT_RULE, transliterationCandidates } from '../text/translit.mjs';
import { generateVariants, kindOfTokens, scriptOfTokens, variantsHash } from '../text/variants.mjs';
import { claimFromAssertion } from '../adapters/stemm/wiktionary.mjs';
import { createTileCache, peekArtifact, sharedArtifact } from './cache.mjs';
import { corpusInputsKey } from './cube.mjs';
import { ExprDocAccumulator, writeExprDoc } from './exprdoc.mjs';
import { ftsCandidates, ftsTerm, passageRows, sampleCandidates, termCounts, termInstanceEstimate } from './fts.mjs';

/** Pipeline version recorded on every materialize run. */
export const PIPELINE_VERSION = 'materialize@1.1.0';

/**
 * The modules whose code decides what a materialization counts: matching, variants, the proper-noun guard, the
 * tokenizer, candidate lookup and the per-document rows (§13 rule 17, fix pass). Their hash is the run's code_hash and
 * part of its params, so a count made under older guard or matching code is stale and counted again.
 */
export const MATCHING_CODE_FILES = Object.freeze([
  new URL('./materialize.mjs', import.meta.url), new URL('./exprdoc.mjs', import.meta.url), new URL('./fts.mjs', import.meta.url),
  new URL('../text/names.mjs', import.meta.url), new URL('../text/variants.mjs', import.meta.url),
  new URL('../text/translit.mjs', import.meta.url), new URL('../text/kwic.mjs', import.meta.url),
  new URL('../../src/shared/tokenize.mjs', import.meta.url),
]);
let matchingHash = null;
/** sha256 (16 hex) of MATCHING_CODE_FILES as this process loaded them. */
export function matchingCodeHash() {
  if (matchingHash === null) {
    const h = createHash('sha256');
    for (const f of MATCHING_CODE_FILES) {
      try { h.update(readFileSync(f)); } catch { h.update(`missing:${f.href}`); }
    }
    matchingHash = h.digest('hex').slice(0, 16);
  }
  return matchingHash;
}
const STAGE = 'materialize';
const CHUNK = 400;                 // candidate passages per write transaction
const LATIN_LANGS = ['en', 'fr', 'es', 'de', 'la', 'it', 'pt'];
/** Passage languages written in each script (language ID output, server/text/langid.mjs). */
// Devanagari and Gujarati passages are always identified by their script (langid), so 'und' never holds them
const SCRIPT_LANGS = { Latn: [...LATIN_LANGS, 'und', 'und-Latn'], Deva: ['hi', 'sa', 'mr'], Gujr: ['gu'] };
const MAX_SURFACE = 200;
/** mmap window of a materialization's connection (the database file; WAL frames are read as before). */
const MMAP_BYTES = 2 ** 31;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ── corpora ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} slug
 * @returns {object|null} corpus row
 */
export function corpusBySlug(db, slug) {
  if (slug === null || slug === undefined || slug === '') return null;
  return stmt(db, 'SELECT * FROM corpus WHERE slug = ?').get(String(slug)) ?? null;
}

/**
 * Collections of a corpus (all collections when corpusId is null), by slug.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|null} corpusId
 * @returns {Array<{id: number, slug: string}>}
 */
export function corpusCollections(db, corpusId) {
  return corpusId === null || corpusId === undefined
    ? stmt(db, 'SELECT id, slug FROM collection ORDER BY slug').all()
    : stmt(db, 'SELECT id, slug FROM collection WHERE corpus_id = ? ORDER BY slug').all(corpusId);
}

/**
 * The collections a materialization reads: the corpus's collections except lexical entries (Wiktionary entry documents
 * hold external claims, never occurrences — §10.2). Keeping them out of the scope also keeps the input fingerprint
 * (§4.0) of every expression of the corpus when a word tracked later adds its Wiktionary entry document.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|null} corpusId
 * @returns {Array<{id: number, slug: string}>} by slug
 */
export function countedCollections(db, corpusId) {
  return corpusId === null || corpusId === undefined
    ? stmt(db, "SELECT id, slug FROM collection WHERE modality <> 'lexical' ORDER BY slug").all()
    : stmt(db, "SELECT id, slug FROM collection WHERE corpus_id = ? AND modality <> 'lexical' ORDER BY slug").all(corpusId);
}

// ── languages ───────────────────────────────────────────────────────────────────────────────────────

const languageGuesses = createTileCache({ max: 256 });

/**
 * Guess the language of a typed expression: Devanagari → hi, Gujarati → gu; Latin script → the language of
 * most passages that contain it in this corpus (en/fr/es/de/la/it/pt), else 'en'; symbols and other scripts
 * → null (any language). Latin guesses are kept per data version (each one reads up to 200 candidate passages).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} tokens folded tokens
 * @param {number|null} corpusId
 * @returns {string|null}
 */
export function guessLanguage(db, tokens, corpusId) {
  const script = scriptOfTokens(tokens);
  if (script === 'Deva') return 'hi';
  if (script === 'Gujr') return 'gu';
  if (script !== 'Latn') return null;
  const key = `${db.location?.() ?? ''}|${corpusId}|${dataVersion(db)}|${tokens.join(' ')}`;
  const hit = languageGuesses.get(key);
  if (hit !== undefined) return hit;
  // the language of the passages where the exact folded form occurs (FTS alone is accent-insensitive)
  let rows = [];
  try { rows = sampleCandidates(db, { phrases: [tokens], corpusId, cap: 200 }); } catch { rows = []; }
  let guess = 'en';
  if (rows.length) {
    const found = matchPassages(db, passageRows(db, rows.map((r) => r.id)), [{ id: 0, seq: tokens }], { guard: false });
    const votes = new Map();
    for (const { passage, matches } of found) {
      if (LATIN_LANGS.includes(passage.lang)) votes.set(passage.lang, (votes.get(passage.lang) ?? 0) + matches.length);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best) guess = best[0];
  }
  languageGuesses.set(key, guess);
  return guess;
}

/**
 * Passage languages an expression is counted in — and divided by (§4.6: "a French variant is never divided by
 * English tokens"): its variants' languages plus the unidentified buckets of their script (short Latin titles
 * are 'und-Latn'; Latin text no profile matches and other scripts are 'und'; Gujarati and Devanagari text is always
 * identified, so those scripts have no unidentified bucket). null = any language.
 * @param {{lang: string|null}} expr
 * @param {Array<{lang: string|null, enabled: number|boolean, norm: string}>} variants
 * @returns {string[]|null}
 */
export function strandLanguages(expr, variants) {
  if (!expr.lang) return null;
  const langs = new Set();
  for (const v of variants) {
    if (!(v.enabled === 1 || v.enabled === true)) continue;
    const script = scriptOfTokens(v.norm.split(' '));
    if ((v.variant_type ?? v.type) === 'transliteration') {
      // a transliteration is written in another script: it counts in that script's languages
      for (const l of SCRIPT_LANGS[script] ?? ['und']) langs.add(l);
      continue;
    }
    const l = v.lang ?? expr.lang;
    if (!l) return null;
    langs.add(l);
    // the unidentified buckets of the variant's script only (fix pass, §13 rules 2–3): Gujarati and Devanagari passages
    // are always identified by their script, so 'und' never holds them — it is Latin text no profile matched or another
    // script, and dividing a Gujarati or Hindi word by it made "absent" cells out of books in other scripts
    if (script === 'Latn') { langs.add('und'); langs.add('und-Latn'); } else if (script !== 'Gujr' && script !== 'Deva') langs.add('und');
  }
  if (!langs.size) langs.add(expr.lang);
  return [...langs].sort();
}

// ── expressions ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Track an expression (idempotent): the expression row, its identity variant, generated variants and an
 * expression_state row. Runs inside a write transaction on the caller's connection.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {{surface: string, lang?: string|null, kind?: string|null, corpus?: string|null, origin?: string,
 *   createdBy?: string}} req
 * @returns {{id: number, created: boolean}}
 * @throws {HttpError} 400 E_VALIDATION
 */
export function trackExpression(db, { surface, lang = null, kind = null, corpus = null, origin = 'user_query', createdBy = 'user' }) {
  const text = typeof surface === 'string' ? surface.trim() : '';
  const tokens = tokenize(text).tokens;
  if (!tokens.length) {
    throw new HttpError(400, 'E_VALIDATION', 'The expression is empty.', 'Type a word, a phrase or a symbol.', { field: 'surface' });
  }
  if (text.length > MAX_SURFACE) {
    throw new HttpError(400, 'E_VALIDATION', `The expression is longer than ${MAX_SURFACE} characters.`,
      'Track a shorter phrase; use the targeted trace for long quotations.', { field: 'surface' });
  }
  if (kind !== null && kind !== undefined && !EXPRESSION_KINDS.includes(kind)) {
    throw new HttpError(400, 'E_VALIDATION', `Unknown expression kind '${kind}'.`, `Use one of ${EXPRESSION_KINDS.join(', ')}.`, { field: 'kind' });
  }
  const corp = corpus === null || corpus === undefined ? null : corpusBySlug(db, corpus);
  if (corpus && !corp) throw new HttpError(400, 'E_VALIDATION', `Unknown corpus '${corpus}'.`, 'Use demo, cipher, stemm or user.', { field: 'corpus' });
  const norm = tokens.join(' ');
  const k = kind ?? kindOfTokens(tokens);
  const l = lang === undefined || lang === null || lang === '' ? guessLanguage(db, tokens, corp?.id ?? null) : String(lang).toLowerCase();
  return tx(db, () => {
    const existing = stmt(db, `SELECT id FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ?
      AND IFNULL(corpus_id, 0) = ?`).get(k, l ?? '', norm, corp?.id ?? 0);
    if (existing) return { id: existing.id, created: false };
    const r = stmt(db, `INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(corp?.id ?? null, k, text, norm, l, origin, corp?.is_synthetic ?? 0, createdBy, nowIso());
    const id = Number(r.lastInsertRowid);
    const insV = stmt(db, `INSERT INTO expression_variant (expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    insV.run(id, text, norm, l, 'identity', 'identity', 'documented', 1);
    for (const v of generateVariants(text, { lang: l })) insV.run(id, v.form, v.norm, l, v.type, v.rule, v.status, v.enabled ? 1 : 0);
    const vars = variantsOf(db, id);
    stmt(db, `INSERT INTO expression_state (expression_id, run_id, variants_hash, status, updated_at) VALUES (?, NULL, ?, 'none', ?)
      ON CONFLICT (expression_id) DO NOTHING`).run(id, variantsHash(vars), nowIso());
    return { id, created: true };
  });
}

/** @returns {object|null} expression row */
export function getExpression(db, id) {
  return stmt(db, 'SELECT * FROM expression WHERE id = ?').get(Number(id)) ?? null;
}

/** Variant rows of an expression, identity first. */
export function variantsOf(db, id) {
  return stmt(db, `SELECT * FROM expression_variant WHERE expression_id = ?
    ORDER BY CASE variant_type WHEN 'identity' THEN 0 ELSE 1 END, id`).all(Number(id));
}

/**
 * Enable or disable variants (PATCH /api/expressions/:id/variants). At least one variant must stay enabled.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {number} id
 * @param {Array<{id: number, enabled: boolean}>} changes
 * @returns {boolean} whether the enabled set changed
 * @throws {HttpError} 400 E_VALIDATION
 */
export function setVariantsEnabled(db, id, changes) {
  if (!Array.isArray(changes) || !changes.length) {
    throw new HttpError(400, 'E_VALIDATION', 'variants must be a non-empty list of {id, enabled}.', null, { field: 'variants' });
  }
  return tx(db, () => {
    const before = variantsHash(variantsOf(db, id));
    const upd = stmt(db, 'UPDATE expression_variant SET enabled = ? WHERE id = ? AND expression_id = ?');
    for (const c of changes) {
      if (!Number.isInteger(c?.id) || typeof c.enabled !== 'boolean') {
        throw new HttpError(400, 'E_VALIDATION', 'Each change needs an integer id and a boolean enabled.', null, { field: 'variants' });
      }
      if (upd.run(c.enabled ? 1 : 0, c.id, id).changes !== 1) {
        throw new HttpError(400, 'E_VALIDATION', `Variant ${c.id} does not belong to expression ${id}.`, null, { field: 'variants' });
      }
    }
    const vars = variantsOf(db, id);
    if (!vars.some((v) => v.enabled === 1)) {
      throw new HttpError(400, 'E_VALIDATION', 'At least one variant must stay enabled.', 'Enable the identity form or another variant.', { field: 'variants' });
    }
    const after = variantsHash(vars);
    stmt(db, 'UPDATE expression_state SET variants_hash = ?, updated_at = ? WHERE expression_id = ?').run(after, nowIso(), id);
    return before !== after;
  });
}

/**
 * The run scope and params of a materialization: the collections of the expression's corpus and the enabled
 * variant set. Two runs with the same params and input fingerprint count the same thing.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} expr expression row
 * @param {object[]} [variants]
 * @returns {{scope: object, params: object}}
 */
export function materializeSpec(db, expr, variants = variantsOf(db, expr.id)) {
  const corpus = expr.corpus_id === null ? null : stmt(db, 'SELECT slug FROM corpus WHERE id = ?').get(expr.corpus_id)?.slug ?? null;
  const collections = countedCollections(db, expr.corpus_id).map((c) => c.slug);
  const enabled = variants.filter((v) => v.enabled === 1).map((v) => `${v.lang ?? ''}:${v.norm}`).sort();
  return {
    scope: { corpus, collections, expression: expr.id },
    params: { expression: expr.id, kind: expr.kind, lang: expr.lang, norm: expr.norm, variants: enabled,
      name_overrides: Object.fromEntries([...nameOverrides(expr)].sort((a, b) => (a[0] < b[0] ? -1 : 1))), code: matchingCodeHash() },
  };
}

/**
 * Whether the expression's current counts are fresh: its run exists, succeeded, and was computed from the same
 * variant set over the same committed imports (input fingerprint, §4.0).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {{runId: number|null, fresh: boolean}}
 */
export function freshness(db, id) {
  const expr = getExpression(db, id);
  if (!expr) return { runId: null, fresh: false };
  const st = stmt(db, `SELECT s.run_id, r.params_hash, r.input_fingerprint FROM expression_state s
    JOIN analysis_run r ON r.id = s.run_id AND r.status = 'succeeded' WHERE s.expression_id = ?`).get(id);
  if (!st) return { runId: null, fresh: false };
  const { scope, params } = materializeSpec(db, expr);
  const fresh = st.params_hash === sha256(canonicalJson(params)) && st.input_fingerprint === inputFingerprint(db, { scope });
  return { runId: st.run_id, fresh };
}

/**
 * The newest materialize job of an expression, if any (DB row; the caller overlays live queue state).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {{id: number, status: string}|null}
 */
export function latestMaterializeJob(db, id) {
  return stmt(db, `SELECT id, status FROM job WHERE type = 'materialize' AND json_extract(params_json, '$.expressionId') = ?
    ORDER BY id DESC LIMIT 1`).get(Number(id)) ?? null;
}

/**
 * The Expression payload of §7.2: expression, variants with their counts (n per variant from the current run;
 * null when not counted), and the materialization state.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{job?: {id: number, status: string}|null}} [opts] live state of the newest job, when known
 * @returns {object|null}
 */
/**
 * Wiktionary attestation claims written on an expression (date_assertion role first_attestation_claim, asserted by
 * wiktionary; contract 1.2.0, M5 gate): the markers the Scroll draws left of the strand. Never occurrences, never a
 * date for the word in this corpus (§1.7, §10.2).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id expression id
 * @returns {Array<object>} ClaimMarker[] (default display first, then by year)
 */
export function expressionClaims(db, id) {
  const rows = stmt(db, `SELECT * FROM date_assertion WHERE subject_type = 'expression' AND subject_id = ?
    AND role = 'first_attestation_claim' AND asserted_by = 'wiktionary' ORDER BY lo_year, id`).all(Number(id));
  return rows.map((r) => claimFromAssertion(r)).map((c) => ({
    label: c.label, date: { lo_year: c.year_lo ?? null, hi_year: c.year_hi ?? null, label: c.date_text ?? null },
    display: c.display === 'default' ? 'default' : 'dimmed', reasons: c.reasons ?? [], source: 'wiktionary',
    license: c.license ?? null, attribution: c.attribution ?? null, relation: c.relation ?? null, highlight: c.highlight ?? null,
  })).sort((a, b) => (a.display === 'default' ? 0 : 1) - (b.display === 'default' ? 0 : 1) || (a.date.lo_year ?? 0) - (b.date.lo_year ?? 0));
}

export function expressionPayload(db, id, { job = undefined } = {}) {
  const expr = getExpression(db, id);
  if (!expr) return null;
  const st = stmt(db, `SELECT s.*, r.metrics_json, r.status AS run_status FROM expression_state s
    LEFT JOIN analysis_run r ON r.id = s.run_id WHERE s.expression_id = ?`).get(id);
  const metrics = st?.run_status === 'succeeded' && st.metrics_json ? JSON.parse(st.metrics_json) : null;
  const j = job === undefined ? latestMaterializeJob(db, id) : job;
  const active = j && (j.status === 'queued' || j.status === 'running' || j.status === 'cancelling');
  const status = active ? 'materializing' : metrics ? 'ready' : j?.status === 'failed' ? 'failed' : 'none';
  return {
    expression: { id: expr.id, surface: expr.surface, norm: expr.norm, kind: expr.kind, lang: expr.lang,
      corpus: expr.corpus_id === null ? null : stmt(db, 'SELECT slug FROM corpus WHERE id = ?').get(expr.corpus_id)?.slug ?? null,
      synthetic: expr.is_synthetic === 1 },
    variants: variantsOf(db, id).map((v) => {
      const out = { id: v.id, form: v.form, type: v.variant_type, status: v.evidence_status, enabled: v.enabled === 1,
        n: metrics && v.enabled === 1 && metrics.by_variant?.[v.id] !== undefined ? metrics.by_variant[v.id] : null };
      if (v.variant_type !== 'identity') out.rule = v.rule;
      if (v.lang) out.lang = v.lang;
      return out;
    }),
    state: {
      status, job: active ? j.id : null, run: metrics ? st.run_id : null,
      n: metrics?.occ_total ?? null, docs: metrics?.docs_total ?? null, names_excluded: metrics?.names_excluded ?? null,
    },
    claims: expr.is_synthetic === 1 ? [] : expressionClaims(db, id),
  };
}

/**
 * Make sure an expression's counts are (being) brought up to date: enqueue a materialize job when its run is
 * missing or stale and none is queued or running. Main thread (needs the job queue).
 * @param {import('node:sqlite').DatabaseSync} db main connection
 * @param {{enqueue: Function, get: Function}} jobs the JobQueue
 * @param {number} id expression id
 * @returns {{job: {id: number, status: string}|null, runId: number|null, fresh: boolean}}
 */
export function ensureMaterialized(db, jobs, id) {
  const fr = freshness(db, id);
  const last = latestMaterializeJob(db, id);
  const live = last ? (jobs.get(last.id) ?? last) : null;
  const active = live && ['queued', 'running', 'cancelling'].includes(live.status);
  if (active) return { job: { id: live.id, status: live.status }, runId: fr.runId, fresh: fr.fresh };
  if (fr.fresh) return { job: live ? { id: live.id, status: live.status } : null, runId: fr.runId, fresh: true };
  const jobId = jobs.enqueue('materialize', { expressionId: id });
  return { job: { id: jobId, status: 'queued' }, runId: fr.runId, fresh: false };
}

/**
 * Transliterations found in the corpus vocabulary (§4.5): added once, disabled — offered in the variant panel,
 * never counted until enabled. Runs in the materialize job (a vocabulary scan does not belong on the main thread).
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {object} expr expression row
 * @returns {number} variants added
 */
export function offerTransliterations(db, expr) {
  if (expr.norm.includes(' ')) return 0;
  if (stmt(db, "SELECT 1 FROM expression_variant WHERE expression_id = ? AND variant_type = 'transliteration' LIMIT 1").get(expr.id)) return 0;
  const found = transliterationCandidates(db, expr.surface);
  if (!found.length) return 0;
  return tx(db, () => {
    const ins = stmt(db, `INSERT INTO expression_variant (expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled)
      VALUES (?, ?, ?, NULL, 'transliteration', ?, 'computed', 0) ON CONFLICT DO NOTHING`);
    let n = 0;
    for (const t of found) n += ins.run(expr.id, t.form, t.norm, TRANSLIT_RULE).changes;
    return n;
  });
}

// ── proper-noun guard overrides ─────────────────────────────────────────────────────────────────────

/** Per-match overrides stored on the expression: key `doc:field:start` → 'count' | 'exclude'. */
export function nameOverrides(expr) {
  let meta = {};
  try { meta = JSON.parse(expr.meta_json ?? '{}'); } catch { meta = {}; }
  return new Map(Object.entries(meta.name_overrides ?? {}));
}

/**
 * Record a per-match override of the proper-noun guard ("The Selfish Gene" → counted). Takes effect at the
 * next materialization.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {number} id expression id
 * @param {Array<{document_id: number, field: string, start: number, counted: boolean}>} overrides
 */
export function setNameOverrides(db, id, overrides) {
  tx(db, () => {
    const expr = getExpression(db, id);
    if (!expr) throw new HttpError(404, 'E_NOT_FOUND', `No expression ${id}.`);
    const meta = JSON.parse(expr.meta_json ?? '{}');
    meta.name_overrides ??= {};
    for (const o of overrides) {
      if (!Number.isInteger(o?.document_id) || typeof o.field !== 'string' || !Number.isInteger(o.start) || typeof o.counted !== 'boolean') {
        throw new HttpError(400, 'E_VALIDATION', 'Each name override needs document_id, field, start and counted.', null, { field: 'names' });
      }
      meta.name_overrides[`${o.document_id}:${o.field}:${o.start}`] = o.counted ? 'count' : 'exclude';
    }
    stmt(db, 'UPDATE expression SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), id);
  });
}

// ── matching ────────────────────────────────────────────────────────────────────────────────────────

/**
 * All matches of the variant token sequences in a token array. At one start position the longest sequence
 * wins (so "hacker's" counts once, as the possessive variant); overlapping matches at different starts count.
 * @param {string[]} tokens
 * @param {Array<{id: number, seq: string[]}>} seqs
 * @returns {Array<{i: number, len: number, variantId: number}>} sorted by i
 */
export function matchTokens(tokens, seqs) {
  const best = new Map();
  for (const { id, seq } of seqs) {
    for (let i = findSequence(tokens, seq); i >= 0; i = findSequence(tokens, seq, i + 1)) {
      const cur = best.get(i);
      if (!cur || seq.length > cur.len) best.set(i, { i, len: seq.length, variantId: id });
    }
  }
  return [...best.values()].sort((a, b) => a.i - b.i);
}

/**
 * Exact matches inside candidate passages, with absolute offsets and proper-noun-guard flags.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} passages rows from fts.passageRows (document author included)
 * @param {Array<{id: number, seq: string[]}>} seqs enabled variants
 * @param {{guard?: boolean, names?: {set: Set<string>, maxTokens: number}|null, overrides?: Map<string, string>}} [opts]
 *   `names` = corpusNames() (the title rule of the proper-noun guard)
 * @returns {Array<{passage: object, matches: Array<{start: number, end: number, tokIndex: number, variantId: number, nameFlag: boolean}>}>}
 */
export function matchPassages(db, passages, seqs, { guard = true, names = null, overrides = new Map() } = {}) {
  const out = [];
  let authorDoc = null, authorSet = null;
  for (const p of passages) {
    const text = passageText(db, p);   // '' when the document has no text: no match
    const tok = tokenize(text);
    const hits = matchTokens(tok.tokens, seqs);
    if (!hits.length) continue;
    if (authorDoc !== p.document_id) { authorDoc = p.document_id; authorSet = authorTokens(p.author); }
    const matches = hits.map((h) => {
      const s = tok.starts[h.i], e = tok.ends[h.i + h.len - 1];
      // a possessive ("Gene's" = gene + s) is the word with its clitic: guarded like the word (fix pass)
      const word = h.len === 1 || (h.len === 2 && tok.tokens[h.i + 1] === 's');
      const wordEnd = tok.ends[h.i];
      let flag = guard && word && nameFlag(text, s, wordEnd, { authorSet, fieldClass: p.field_class, tok, names });
      const o = overrides.get(`${p.document_id}:${p.field}:${p.start_off + s}`);
      if (o === 'count') flag = false; else if (o === 'exclude') flag = true;
      return { start: p.start_off + s, end: p.start_off + e, tokIndex: h.i, variantId: h.variantId, nameFlag: Boolean(flag),
        word, cap: isCapitalized(text.slice(s, wordEnd)), overridden: o === 'count' || o === 'exclude' };
    });
    out.push({ passage: p, matches });
  }
  return out;
}

/**
 * Known maker names of a corpus for the title rule of the proper-noun guard: authors and maker tags of its
 * rate-eligible collections (relation endpoints such as MusicBrainz artist credits are not name evidence). Built
 * from ≈ 200k rows on Cipher (≈ 1 s), so it is a shared artifact: once per state of the corpus's inputs, for every
 * read worker and job, kept across restarts in $SCROLLS_DATA/cache/.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|null} corpusId null = every corpus
 * @returns {{set: Set<string>, maxTokens: number}}
 */
export function corpusNames(db, corpusId) {
  return sharedArtifact(db, namesSpec(corpusId));
}

/**
 * corpusNames when its file is ready (or it is in memory), else null — never builds (warm.mjs loads it into every
 * read worker).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|null} corpusId
 * @returns {{set: Set<string>, maxTokens: number}|null}
 */
export function peekCorpusNames(db, corpusId) {
  return peekArtifact(db, namesSpec(corpusId));
}

/** The sharedArtifact spec of a corpus's maker-name index (warm.mjs ensures it). */
export function namesSpec(corpusId) {
  return {
    name: `names1-c${corpusId ?? 'all'}`,
    ...(corpusId === null ? {} : { key: (d) => corpusInputsKey(d, corpusId, { scope: 'rate' }) }),
    build: (d) => nameIndex(makerNameRows(d, corpusId)),
    encode: (v) => Buffer.from(JSON.stringify({ names: [...v.set], maxTokens: v.maxTokens })),
    decode: (bytes) => {
      const o = JSON.parse(bytes.toString('utf8'));
      return { set: new Set(o.names), maxTokens: o.maxTokens };
    },
  };
}

/** Raw maker strings (distinct author fields and maker tags) of a corpus's rate-eligible collections. */
export function makerNameRows(db, corpusId) {
  const scope = corpusId === null ? '' : 'AND c.corpus_id = ?';
  const args = corpusId === null ? [] : [corpusId];
  const names = stmt(db, `SELECT DISTINCT d.author AS n FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE d.author IS NOT NULL AND c.rate_eligible = 1 ${scope}`).all(...args).map((r) => r.n);
  for (const r of stmt(db, `SELECT DISTINCT t.value AS n FROM doc_tag t JOIN document d ON d.id = t.document_id
    JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'maker' AND c.rate_eligible = 1 ${scope}`).all(...args)) names.push(r.n);
  return names;
}

// ── the materialize job ─────────────────────────────────────────────────────────────────────────────

/** Above this many matches the occurrence rows are a stratified sample (§4.6). */
export const SAMPLE_ABOVE = 300000;
/** Occurrence rows kept per (passage language, decade) group once sampling. */
export const SAMPLE_PER_GROUP = 200;

/** Sampling group of a passage: its language and its document's decade (or chronology status). */
const groupOf = (p) => `${p.lang}|${p.chrono_status === 'dated' ? Math.floor(p.y_lo / 10) : p.chrono_status}`;
/** A stable pseudo-random rank of a match, so samples are reproducible. */
const rankOf = (passageId, start) => fnv1a32(`${passageId}:${start}`);

/**
 * Materialize one tracked expression inside the materialize job: occurrence + expr_doc rows of a new run,
 * then expression_state points at it and data_version is bumped (all in the final transaction).
 *
 * Counts in expr_doc are always complete. Occurrence rows are complete too, unless the expression is very
 * frequent (> `sampleAbove` matches, §4.6): then they are a stratified sample of ≤ 200 per (passage language,
 * decade), `sampled = 1`. A single word that frequent is counted from the FTS index (passage_vocab_inst): exact
 * per passage but accent-insensitive and without the proper-noun guard — the run's metrics say so.
 * @param {import('node:sqlite').DatabaseSync} db the job's writable connection
 * @param {{expressionId: number, sampleAbove?: number, samplePerGroup?: number}} args thresholds default to §4.6 (tests lower them)
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @returns {object} result_json: { run, occurrences, counted, documents, names_excluded, candidates, sampled, mode }
 */
export function materialize(db, { expressionId, sampleAbove = SAMPLE_ABOVE, samplePerGroup = SAMPLE_PER_GROUP }, ctx) {
  const expr = getExpression(db, expressionId);
  if (!expr) throw new HttpError(404, 'E_NOT_FOUND', `No expression ${expressionId}.`);
  const variants = variantsOf(db, expr.id);
  const enabled = variants.filter((v) => v.enabled === 1);
  if (!enabled.length) throw new HttpError(400, 'E_VALIDATION', `Expression ${expr.id} has no enabled variant.`);
  const seqs = enabled.map((v) => ({ id: v.id, seq: v.norm.split(' ') }));
  const { scope, params } = materializeSpec(db, expr, variants);
  ctx.progress(0, 'candidates', `finding passages containing '${expr.surface}'`);
  // Profiled at the 1.3.0 performance round: most of a materialization is reading the originals of the books its
  // candidate passages lie in (exact offsets need the text); memory-mapped reads cut that by about a quarter. Reads only:
  // the job's writes still go through the WAL.
  try { db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`); } catch { /* an in-memory or read-only database */ }
  offerTransliterations(db, expr);
  const runId = ctx.startRun(STAGE, { pipelineVersion: PIPELINE_VERSION, params, scope, codeFiles: MATCHING_CODE_FILES });
  const metrics = { mode: 'exact', sample_above: sampleAbove, sample_per_group: samplePerGroup, candidates: 0, passages_matched: 0, occ_all: 0, occ_total: 0, names_excluded: 0, sampled: false,
    by_variant: {}, names_by_variant: {}, excluded_quality: {}, docs: new Set() };
  for (const v of enabled) { metrics.by_variant[v.id] = 0; metrics.names_by_variant[v.id] = 0; }

  // the index can count single words; a longer variant that starts with one of them (the possessive "zero s")
  // is already counted by that word's instances
  const singles = seqs.filter((x) => x.seq.length === 1);
  const words = new Set(singles.map((x) => x.seq[0]));
  const indexable = singles.length > 0 && seqs.every((x) => x.seq.length === 1 || words.has(x.seq[0]));
  if (indexable && termInstanceEstimate(db, [...words]) > sampleAbove) {
    countFromIndex(db, expr, singles, seqs, runId, metrics, ctx, samplePerGroup);
  } else {
    countExactly(db, expr, seqs, runId, metrics, ctx, sampleAbove, samplePerGroup);
  }

  const result = { run: runId, occurrences: metrics.occ_all, counted: metrics.occ_total, documents: metrics.docs.size,
    names_excluded: metrics.names_excluded, candidates: metrics.candidates, sampled: metrics.sampled, mode: metrics.mode };
  const metricsJson = { ...metrics, docs_total: metrics.docs.size, docs: undefined };
  tx(db, () => {
    stmt(db, `INSERT INTO expression_state (expression_id, run_id, variants_hash, status, occ_total, docs_total, sampled,
        names_excluded, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?)
      ON CONFLICT (expression_id) DO UPDATE SET run_id = excluded.run_id, variants_hash = excluded.variants_hash,
        status = 'ready', occ_total = excluded.occ_total, docs_total = excluded.docs_total, sampled = excluded.sampled,
        names_excluded = excluded.names_excluded, updated_at = excluded.updated_at`)
      .run(expr.id, runId, variantsHash(variants), metrics.occ_total, metrics.docs.size, metrics.sampled ? 1 : 0,
        metrics.names_excluded, nowIso());
    ctx.finishRun(runId, 'succeeded', { metrics: metricsJson });
    bumpDataVersion(db);
  });
  ctx.progress(1, 'done', `${metrics.occ_total} occurrences in ${metrics.docs.size} documents${metrics.sampled ? ' (contexts sampled)' : ''}`);
  return result;
}

const insOccSql = `INSERT INTO occurrence (expression_id, variant_id, passage_id, document_id, start_off, end_off, tok_index,
  name_flag, sampled, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The exact path: JS tokenization of every candidate passage. Switches to sampled occurrence rows past the cap. */
function countExactly(db, expr, seqs, runId, metrics, ctx, sampleAbove, perGroup) {
  const ids = ftsCandidates(db, { phrases: seqs.map((s) => s.seq), corpusId: expr.corpus_id,
    collections: countedCollections(db, expr.corpus_id).map((c) => c.id) });
  metrics.candidates = ids.length;
  const names = corpusNames(db, expr.corpus_id);
  const overrides = nameOverrides(expr);
  const insOcc = stmt(db, insOccSql);
  const acc = new ExprDocAccumulator();
  const groups = new Map();   // group → ranks of every match (used once sampling)
  // rule (d) of the proper-noun guard needs a whole document: its body-text occurrences are noted while counting
  const guardable = !expr.norm.includes(' ');
  const docNames = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    ctx.checkpoint();
    const found = matchPassages(db, passageRows(db, ids.slice(i, i + CHUNK)), seqs, { names, overrides });
    tx(db, () => {
      for (const { passage: p, matches } of found) {
        metrics.passages_matched++;
        for (const m of matches) {
          metrics.occ_all++;
          if (!metrics.sampled && metrics.occ_all > sampleAbove) {
            // too many to keep every context: drop the rows so far and keep a stratified sample (second pass)
            metrics.sampled = true;
            stmt(db, 'DELETE FROM occurrence WHERE run_id = ?').run(runId);
          }
          // every match's rank is kept from the start: the cut of a group must see all of its matches
          const g = groupOf(p);
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(rankOf(p.id, m.start));
          const occId = metrics.sampled ? null
            : Number(insOcc.run(expr.id, m.variantId, p.id, p.document_id, m.start, m.end, m.tokIndex, m.nameFlag ? 1 : 0, 0, runId).lastInsertRowid);
          if (p.quality !== 'ok') {
            metrics.excluded_quality[p.quality] = (metrics.excluded_quality[p.quality] ?? 0) + 1;
            continue;
          }
          acc.add(p, m);
          if (m.nameFlag) { metrics.names_excluded++; metrics.names_by_variant[m.variantId]++; } else {
            metrics.occ_total++;
            metrics.by_variant[m.variantId]++;
            metrics.docs.add(p.document_id);
          }
          if (guardable) noteForNameRule(docNames, p, m, occId);
        }
      }
      writeExprDoc(db, runId, expr.id, acc.drain());
    });
    ctx.progress(Math.min(0.99, (i + CHUNK) / Math.max(1, ids.length)) * (metrics.sampled ? 0.5 : 1), 'counting',
      `counting… ${Math.min(ids.length, i + CHUNK)} / ${ids.length} passages`);
  }
  const flipped = guardable ? applyDocumentNameRule(db, { exprId: expr.id, runId, docNames, metrics }) : new Set();
  if (!metrics.sampled) return;
  // second pass: keep the SAMPLE_PER_GROUP lowest-ranked matches of each group (stable, reproducible)
  const cut = new Map();
  for (const [g, ranks] of groups) cut.set(g, ranks.length > perGroup ? ranks.sort((a, b) => a - b)[perGroup - 1] : Infinity);
  for (let i = 0; i < ids.length; i += CHUNK) {
    ctx.checkpoint();
    const found = matchPassages(db, passageRows(db, ids.slice(i, i + CHUNK)), seqs, { names, overrides });
    tx(db, () => {
      for (const { passage: p, matches } of found) {
        const limit = cut.get(groupOf(p));
        for (const m of matches) {
          if (rankOf(p.id, m.start) > limit) continue;
          const name = m.nameFlag || flipped.has(`${p.id}:${m.start}`);
          insOcc.run(expr.id, m.variantId, p.id, p.document_id, m.start, m.end, m.tokIndex, name ? 1 : 0, Number.isFinite(limit) ? 1 : 0, runId);
        }
      }
    });
    ctx.progress(0.5 + Math.min(0.49, (i + CHUNK) / Math.max(1, ids.length) / 2), 'sampling', 'keeping a stratified sample of contexts');
  }
}

/** Note a body-text occurrence of a single word for rule (d) of the proper-noun guard (names.documentNameRule). */
function noteForNameRule(docNames, p, m, occId) {
  if (!m.word) return;
  let d = docNames.get(p.document_id);
  if (!d) { d = { flagged: 0, lower: 0, capitalized: 0, otherCounted: 0, candidates: [] }; docNames.set(p.document_id, d); }
  if (p.field_class !== 'text') { if (!m.nameFlag) d.otherCounted++; return; }
  if (m.nameFlag) d.flagged++;
  else if (!m.cap) d.lower++;
  else if (m.overridden) d.otherCounted++;                 // a reader said "count this one": it stays counted
  else { d.capitalized++; d.candidates.push({ pid: p.id, lang: p.lang, start: m.start, variantId: m.variantId, occId }); }
}

/**
 * Rule (d) of the proper-noun guard (fix pass): in a document whose body text never writes the word in lower case and
 * where at least NAME_RECURRENCE_MIN occurrences are flagged names, its other capitalized occurrences (sentence-initial
 * ones above all) are names too. Their occurrence rows, the document's text rows of expr_doc and the run's metrics move
 * from counted to excluded-as-names. Returns the `passage:start` keys moved (the sampled second pass keeps them as names).
 */
function applyDocumentNameRule(db, { exprId, runId, docNames, metrics }) {
  const moved = new Set();
  const docs = [...docNames].filter(([, d]) => documentNameRule(d));
  if (!docs.length) return moved;
  tx(db, () => {
    const occ = stmt(db, 'UPDATE occurrence SET name_flag = 1 WHERE id = ?');
    // (a match a reader chose to count stays counted, so a row keeps its passages unless nothing is left in it)
    const row = stmt(db, `UPDATE expr_doc SET n = n - ?1, n_names = n_names + ?1, n_passages = CASE WHEN n - ?1 <= 0 THEN 0 ELSE n_passages END
      WHERE expression_id = ?2 AND run_id = ?3 AND document_id = ?4 AND plang = ?5 AND field_class = 'text'`);
    for (const [doc, d] of docs) {
      const byLang = new Map();
      for (const c of d.candidates) {
        moved.add(`${c.pid}:${c.start}`);
        if (c.occId !== null && !metrics.sampled) occ.run(c.occId);
        byLang.set(c.lang, (byLang.get(c.lang) ?? 0) + 1);
        metrics.occ_total--;
        metrics.names_excluded++;
        metrics.by_variant[c.variantId]--;
        metrics.names_by_variant[c.variantId]++;
      }
      // every counted body-text match of the document was a candidate (lower === 0): its text rows count none now
      for (const [lang, k] of byLang) row.run(k, exprId, runId, doc, lang);
      if (!d.otherCounted) metrics.docs.delete(doc);
    }
  });
  metrics.names_by_document_rule = moved.size;
  return moved;
}

/**
 * The very-frequent path for single words: per-passage counts from passage_vocab_inst (accent-insensitive, no
 * name guard), then a stratified sample of exact matches as occurrence rows.
 */
function countFromIndex(db, expr, singles, seqs, runId, metrics, ctx, perGroup) {
  metrics.mode = 'fts-index';
  metrics.sampled = true;
  metrics.counts_include_accent_variants = true;
  metrics.name_guard = 'not applied: counts come from the FTS index';
  const termOwner = new Map();   // FTS term → the first variant that folds to it
  for (const s of singles) { const t = ftsTerm(s.seq[0]); if (!termOwner.has(t)) termOwner.set(t, s.id); }
  const perPassage = new Map();  // passage → { n, variant }
  for (const [term, variantId] of termOwner) {
    for (const r of termCounts(db, term)) {
      const cur = perPassage.get(r.passage);
      if (cur) cur.n += r.n; else perPassage.set(r.passage, { n: r.n, variant: variantId });
    }
  }
  const ids = [...perPassage.keys()].sort((a, b) => a - b);
  metrics.candidates = ids.length;
  const acc = new ExprDocAccumulator();
  const byGroup = new Map();
  const counted = new Set(countedCollections(db, expr.corpus_id).map((c) => c.id));
  for (let i = 0; i < ids.length; i += CHUNK) {
    ctx.checkpoint();
    const rows = passageRows(db, ids.slice(i, i + CHUNK)).filter((p) => counted.has(p.collection_id));
    tx(db, () => {
      for (const p of rows) {
        const { n, variant } = perPassage.get(p.id);
        metrics.passages_matched++;
        metrics.occ_all += n;
        if (p.quality !== 'ok') { metrics.excluded_quality[p.quality] = (metrics.excluded_quality[p.quality] ?? 0) + n; continue; }
        acc.add(p, { start: p.start_off, nameFlag: false }, n);
        metrics.occ_total += n;
        metrics.by_variant[variant] += n;
        metrics.docs.add(p.document_id);
        const g = groupOf(p);
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(p);
      }
      writeExprDoc(db, runId, expr.id, acc.drain());
    });
    ctx.progress(Math.min(0.8, ((i + CHUNK) / Math.max(1, ids.length)) * 0.8), 'counting', `counting from the index… ${Math.min(ids.length, i + CHUNK)} / ${ids.length} passages`);
  }
  // contexts: per group, passages in a stable pseudo-random order until SAMPLE_PER_GROUP exact matches
  const names = corpusNames(db, expr.corpus_id);
  const insOcc = stmt(db, insOccSql);
  for (const passages of byGroup.values()) {
    ctx.checkpoint();
    passages.sort((a, b) => rankOf(a.id, 0) - rankOf(b.id, 0));
    let kept = 0;
    tx(db, () => {
      for (const p of passages) {
        if (kept >= perGroup) break;
        const [found] = matchPassages(db, [p], seqs, { names });
        for (const m of found?.matches ?? []) {
          if (kept >= perGroup) break;
          insOcc.run(expr.id, m.variantId, p.id, p.document_id, m.start, m.end, m.tokIndex, m.nameFlag ? 1 : 0, 1, runId);
          kept++;
        }
      }
    });
  }
}

/**
 * Run a materialization synchronously on a writable connection, outside the job queue (tests, scripts,
 * benchmarks). Same code path as the job; a throwaway job id of 0 is recorded on the run.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} expressionId
 * @param {{sampleAbove?: number, samplePerGroup?: number}} [opts] the very-frequent thresholds (tests lower them)
 * @returns {object} the job result
 */
export function materializeInline(db, expressionId, { sampleAbove = SAMPLE_ABOVE, samplePerGroup = SAMPLE_PER_GROUP } = {}) {
  const ctx = makeTaskContext({ db, jobId: 0, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {},
    type: STAGE, codeFiles: [new URL(import.meta.url)] });
  try {
    return materialize(db, { expressionId, sampleAbove, samplePerGroup }, ctx);
  } catch (err) {
    ctx._closeOpenRuns('failed');
    throw err;
  }
}

