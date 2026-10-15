// OWNER: WP4
// tfidf-hash.mjs — the fallback occurrence representation (SPEC §4.8): first-order TF-IDF context vectors
// hashed to 4,096 dimensions. Every occurrence's context is the ±10 tokens around the match, clipped at its
// passage, without stop-words, without the expression's own words and without tokens that hold no letter.
// A term goes to bin FNV-1a-32(term) mod 4096 with the sign taken from the hash's top bit; IDF comes from the
// clustered occurrences themselves (each context is one "document" of the slice). Vectors are sparse and
// L2-normalized. An occurrence with fewer than 3 usable context words is `context_thin`: it is excluded from
// clustering and counted.

import { fnv1a32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { langAdmits } from '../aggregate/langgate.mjs';
import { stopSet } from './collocations.mjs';
import { passageTextReader } from './slices.mjs';

/** Name recorded on runs and printed on every cluster card. */
export const TFIDF_REPRESENTATION = 'tfidf-hash-4096';
/** Hash dimensions (§4.8). */
export const HASH_DIM = 4096;
/** Context window on each side of an occurrence, in tokens (§4.4: occurrence vectors ±10). */
export const OCC_WINDOW = 10;
/** Fewer usable context words than this makes an occurrence `context_thin` (§4.8). */
export const MIN_CONTEXT_WORDS = 3;
/**
 * Pieces the tokenizer leaves when it splits an English contraction at the apostrophe ("don't" → don · t,
 * "I'll" → i · ll). They are not words, the stop-list does not hold them, and they mark dialogue rather than any
 * usage of the target, so they never enter a context (since cluster@1.1.0).
 */
export const CLITIC_FRAGMENTS = Object.freeze({
  en: Object.freeze(['s', 't', 'd', 'm', 'll', 're', 've', 'don', 'won', 'isn', 'aren', 'wasn', 'weren', 'doesn', 'didn', 'couldn',
    'wouldn', 'shouldn', 'hasn', 'haven', 'hadn', 'ain', 'mustn', 'needn', 'shan']),
});

/**
 * Words left out of every occurrence context of a language: its stop-words and its contraction fragments.
 * @param {string} lang
 * @returns {Set<string>}
 */
export function contextStopSet(lang) {
  const out = stopSet([lang]);
  for (const w of CLITIC_FRAGMENTS[String(lang).split('-')[0]] ?? []) out.add(w);
  return out;
}

const HAS_LETTER = /\p{L}/u;

/**
 * The usable context words of one match: tokens in [start − window, start) and [end, end + window) of its
 * passage (the passage clips the window), minus stop-words, the expression's own words and letterless tokens.
 * @param {string[]} tokens folded tokens of the passage
 * @param {number} start token index of the match's first token
 * @param {number} end token index after the match's last token
 * @param {{window?: number, stop?: Set<string>, exclude?: Set<string>}} [opts]
 * @returns {string[]} in passage order
 */
export function contextWords(tokens, start, end, { window = OCC_WINDOW, stop = new Set(), exclude = new Set() } = {}) {
  const out = [];
  const keep = (t) => t && !stop.has(t) && !exclude.has(t) && HAS_LETTER.test(t);
  for (let i = Math.max(0, start - window); i < start; i++) if (keep(tokens[i])) out.push(tokens[i]);
  for (let i = end; i < Math.min(tokens.length, end + window); i++) if (keep(tokens[i])) out.push(tokens[i]);
  return out;
}

/**
 * Bin and sign of a term: FNV-1a-32 mod dim, sign from the hash's top bit (independent of the low bits
 * when dim is a power of two ≤ 2³¹).
 * @param {string} term
 * @param {number} [dim]
 * @returns {{index: number, sign: 1|-1}}
 */
export function hashTerm(term, dim = HASH_DIM) {
  const h = fnv1a32(term) >>> 0;
  return { index: h % dim, sign: (h >>> 31) === 1 ? -1 : 1 };
}

/**
 * Smoothed IDF over a set of contexts (each context is one document): ln((1 + N) / (1 + df)) + 1.
 * @param {Iterable<string[]>} contexts
 * @returns {Map<string, number>} term → idf; `idf.unseen` holds the value for a term in no context
 */
export function idfFromContexts(contexts) {
  const df = new Map();
  let n = 0;
  for (const c of contexts) {
    n++;
    for (const t of new Set(c)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((1 + n) / (1 + d)) + 1);
  idf.unseen = Math.log(1 + n) + 1;
  return idf;
}

/**
 * Sparse L2-normalized TF-IDF hash vector of one context.
 * @param {string[]} contextTokens
 * @param {Map<string, number>} idf
 * @param {{dim?: number}} [opts]
 * @returns {{idx: Int32Array, val: Float32Array, dim: number}} indexes ascending; empty when no usable term
 */
export function tfidfHashSparse(contextTokens, idf, { dim = HASH_DIM } = {}) {
  const tf = new Map();
  for (const t of contextTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const bins = new Map();
  for (const [t, f] of tf) {
    const { index, sign } = hashTerm(t, dim);
    const w = f * (idf.get(t) ?? idf.unseen ?? 1);
    bins.set(index, (bins.get(index) ?? 0) + sign * w);
  }
  const keys = [...bins.keys()].filter((k) => bins.get(k) !== 0).sort((a, b) => a - b);
  let norm = 0;
  for (const k of keys) norm += bins.get(k) ** 2;
  norm = Math.sqrt(norm);
  const idx = new Int32Array(keys.length), val = new Float32Array(keys.length);
  keys.forEach((k, i) => { idx[i] = k; val[i] = bins.get(k) / norm; });
  return { idx, val, dim };
}

/**
 * Dense L2-normalized TF-IDF hash vector of one context (the sparse vector written out).
 * @param {string[]} contextTokens
 * @param {Map<string, number>} idf
 * @param {{dim?: number}} [opts]
 * @returns {Float32Array}
 */
export function tfidfHashVector(contextTokens, idf, { dim = HASH_DIM } = {}) {
  const s = tfidfHashSparse(contextTokens, idf, { dim });
  const out = new Float32Array(dim);
  for (let i = 0; i < s.idx.length; i++) out[s.idx[i]] = s.val[i];
  return out;
}

/**
 * Vectors for a set of contexts, sharing one IDF (the clustered slice, or the union of two expressions'
 * contexts when they are compared in one representation).
 * @param {string[][]} contexts
 * @param {{dim?: number, idf?: Map<string, number>}} [opts]
 * @returns {{vectors: Array<{idx: Int32Array, val: Float32Array, dim: number}>, idf: Map<string, number>, dim: number}}
 */
export function tfidfHashVectors(contexts, { dim = HASH_DIM, idf = idfFromContexts(contexts) } = {}) {
  return { vectors: contexts.map((c) => tfidfHashSparse(c, idf, { dim })), idf, dim };
}

// ── Occurrences and their contexts (the input of every representation) ───────────────────────────────

/** Field classes clustered by default; the describes / apparatus toggles add theirs (§4.6 default exclusions). */
export const CLUSTER_CLASSES = Object.freeze(['text', 'title', 'abstract']);

/**
 * Which passages and documents an expression's clustering reads, under the toggles (§4.6 default exclusions,
 * each counted): name-guard hits, translations, duplicates, estimated dates (only when est = 0), passages
 * that are not quality 'ok', describes/apparatus passages, other languages than the strand's, deleted
 * documents and collections that are not rate-eligible (relation endpoints, baselines).
 * @param {{tr: number, ds: number, ap: number, dup: number, nm: number, est: number}} toggles
 * @returns {{classes: Set<string>, reason: (row: object, langs: Set<string>|null) => string|null}}
 */
export function clusterFilter(toggles) {
  const classes = new Set(CLUSTER_CLASSES);
  if (toggles.ds) classes.add('describes');
  if (toggles.ap) classes.add('apparatus');
  const reason = (r, langs) => {
    if (r.deleted_at) return 'deleted';
    if (!r.rate_eligible) return 'not_rate_eligible';
    if (!toggles.nm && r.name_flag) return 'names';
    if (!toggles.tr && r.is_translation) return 'translations';
    if (!toggles.dup && r.dup_of !== null) return 'duplicates';
    if (!toggles.est && r.basis === 'estimated') return 'estimated';
    if (r.quality !== 'ok') return 'quality';
    if (!classes.has(r.field_class)) return r.field_class === 'describes' || r.field_class === 'apparatus' ? r.field_class : 'other_class';
    // RF-1: the timeline's language rule — an unidentified row of a document's running text in its document's language
    if (!langAdmits(langs, r.lang, r.field_class, r.lang_text)) return 'other_language';
    return null;
  };
  return { classes, reason };
}

/**
 * The counted occurrences of a resolved expression (slices.resolveExpressions) with their ±10 context words.
 * Occurrences come from the expression's succeeded materialize run (occurrence rows; for very frequent
 * expressions those rows are the stratified sample of §4.6, flagged `sampled`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} expr resolved expression {id, run, variants, langs}
 * @param {{toggles: object, window?: number, contexts?: boolean, collections?: number[]|null, checkpoint?: () => void}} opts
 *   collections: only these collection ids (the others are counted as excluded 'other_collection')
 * @returns {{items: Array<{occ: number, doc: number, passage: number, y_lo: number|null, y_hi: number|null, chrono: string,
 *   author: string|null, collection: number, modality: string, sampling: string|null, synthetic: boolean, sampled: boolean,
 *   context: string[]|null}>, excluded: Record<string, number>, sampled: boolean, collections: number[], langs: string[]}}
 */
export function loadOccurrenceContexts(db, expr, { toggles, window = OCC_WINDOW, contexts = true, collections = null, checkpoint = () => {} }) {
  const { reason } = clusterFilter(toggles);
  const only = collections ? new Set(collections) : null;
  const rows = db.prepare(`SELECT o.id AS occ, o.passage_id AS passage, o.document_id AS doc, o.start_off, o.end_off, o.tok_index,
      o.name_flag, o.sampled, o.variant_id, p.field, p.field_class, p.quality, p.lang, p.start_off AS p_start, p.end_off AS p_end,
      d.y_lo, d.y_hi, d.chrono_status AS chrono, d.is_translation, d.dup_of, d.basis, d.author, d.deleted_at, d.collection_id,
      d.is_synthetic, d.lang_text, c.rate_eligible, c.modality, c.sampling
    FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id
    JOIN collection c ON c.id = d.collection_id
    WHERE o.expression_id = ? AND o.run_id = ? ORDER BY o.passage_id, o.tok_index`).all(expr.id, expr.run);
  const lenOf = new Map(expr.variants.filter((v) => v.id !== null).map((v) => [v.id, v.tokens.length]));
  const exclude = new Set(expr.variants.flatMap((v) => v.tokens));
  const readText = passageTextReader(db);
  const excluded = {};
  const items = [];
  const langs = new Set(), colls = new Set();
  const stops = new Map();
  const stopOf = (lang) => { if (!stops.has(lang)) stops.set(lang, contextStopSet(lang)); return stops.get(lang); };
  let cache = { id: null, tokens: null, starts: null };
  rows.forEach((r, i) => {
    if (i % 500 === 0) checkpoint();
    const why = only && !only.has(r.collection_id) ? 'other_collection' : reason(r, expr.langs);
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; return; }
    let context = null;
    if (contexts) {
      if (cache.id !== r.passage) {
        const text = readText({ document_id: r.doc, field: r.field, start_off: r.p_start, end_off: r.p_end });
        const t = text === null ? { tokens: [], starts: new Int32Array(0) } : tokenize(text);
        cache = { id: r.passage, tokens: t.tokens, starts: t.starts };
      }
      const rel = r.start_off - r.p_start;
      let start = r.tok_index;
      if (cache.starts[start] !== rel) start = cache.starts.indexOf(rel);
      if (start < 0) { excluded.offset_mismatch = (excluded.offset_mismatch ?? 0) + 1; return; }
      const len = lenOf.get(r.variant_id) ?? expr.norm.split(' ').length;
      context = contextWords(cache.tokens, start, start + len, { window, stop: stopOf(r.lang), exclude });
    }
    langs.add(r.lang);
    colls.add(r.collection_id);
    items.push({ occ: r.occ, doc: r.doc, passage: r.passage, y_lo: r.chrono === 'dated' ? r.y_lo : null,
      y_hi: r.chrono === 'dated' ? r.y_hi : null, chrono: r.chrono, author: r.author ?? null, collection: r.collection_id,
      modality: r.modality, sampling: r.sampling ?? null, synthetic: r.is_synthetic === 1, sampled: r.sampled === 1, context });
  });
  return { items, excluded, sampled: items.some((x) => x.sampled), collections: [...colls].sort((a, b) => a - b), langs: [...langs].sort() };
}

/**
 * Coverage of an expression's scope by date interval: tokens of quality-'ok' passages in the strand's
 * languages and clustered field classes, per document date interval (dated documents of rate-eligible
 * collections of the expression's corpus — or of the given collections; translations and duplicates
 * excluded unless toggled in).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} expr resolved expression
 * @param {{toggles: object, collections?: number[]|null}} opts
 * @returns {(lo: number, hi: number) => number} tokens of documents whose interval fits [lo, hi]
 */
export function coverageIndex(db, expr, { toggles, collections = null }) {
  const { classes } = clusterFilter(toggles);
  // The collections are chosen first, so the query is driven by document(collection_id): with the choice inside the
  // query the planner scanned every dated document of every corpus (STEMM-loaded clone: 0.6–0.9 s against 6–200 ms, same rows).
  const wanted = collections ? new Set(collections.map(Number)) : null;
  const colls = db.prepare(`SELECT id FROM collection WHERE rate_eligible = 1 AND unit != 'none' AND (? IS NULL OR corpus_id = ?)
    ORDER BY id`).all(expr.corpus_id, expr.corpus_id).map((r) => r.id).filter((id) => !wanted || wanted.has(id));
  const rows = db.prepare(`SELECT d.y_lo, d.y_hi, t.plang, t.field_class, d.lang_text, SUM(t.tokens) AS tokens
    FROM collection c JOIN document d ON d.collection_id = c.id JOIN doc_tokens t ON t.document_id = d.id
    WHERE c.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL AND d.chrono_status = 'dated'
      AND (? = 1 OR d.is_translation = 0) AND (? = 1 OR d.dup_of IS NULL)
    GROUP BY d.y_lo, d.y_hi, t.plang, t.field_class, d.lang_text`).all(JSON.stringify(colls), toggles.tr ? 1 : 0, toggles.dup ? 1 : 0);
  const cover = rows.filter((r) => classes.has(r.field_class) && langAdmits(expr.langs, r.plang, r.field_class, r.lang_text));
  return (lo, hi) => {
    let s = 0;
    for (const r of cover) if (r.y_lo >= lo && r.y_hi <= hi) s += r.tokens;
    return s;
  };
}
