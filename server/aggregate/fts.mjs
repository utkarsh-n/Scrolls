// OWNER: WP3
// fts.mjs — FTS5 candidate search and preliminary passage-hit counts (SPEC §4.4, §4.6).
//
// passage_fts indexes the JS-folded token string of every passage (FTS token i = JS token i) and adds
// accent-insensitivity (remove_diacritics 2), so a phrase MATCH returns a SUPERSET of the passages where the
// exact folded sequence occurs; materialization then matches tokens exactly in JS. FTS hits are never counts:
// they are labelled "preliminary: passages containing".

import { ftsPhrase } from '../../src/shared/tokenize.mjs';
import { stmt } from '../db/open.mjs';

/**
 * The MATCH expression for a set of token sequences: phrases OR-ed ("carry the zero" OR "carries the zero").
 * @param {string[][]} phrases folded token sequences
 * @returns {string}
 */
export function ftsQueryString(phrases) {
  const parts = [...new Set(phrases.filter((p) => p.length).map((p) => ftsPhrase(p)))];
  if (!parts.length) throw new RangeError('ftsQueryString: no non-empty phrase');
  return parts.join(' OR ');
}

const CANDIDATE_COLS = `p.id, p.document_id, p.field, p.field_class, p.time_role, p.quality, p.start_off, p.end_off,
  p.lang, p.token_count`;

function scopeSql(corpusId, collections) {
  const where = ['d.deleted_at IS NULL'];
  const params = [];
  if (corpusId !== null && corpusId !== undefined) { where.push('c.corpus_id = ?'); params.push(corpusId); }
  if (Array.isArray(collections)) { where.push('c.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(collections)); }
  return { where: where.join(' AND '), params };
}

/**
 * Candidate passages (rows) for token sequences, ordered by document, field and offset so a caller loads each
 * document's text once. A generator: candidate sets can be large.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{phrases: string[][], corpusId?: number|null, collections?: number[]|null}} args
 * @returns {Iterable<{id: number, document_id: number, field: string, field_class: string, time_role: string,
 *   quality: string, start_off: number, end_off: number, lang: string, token_count: number}>}
 */
export function* iterateCandidates(db, { phrases, corpusId = null, collections = null }) {
  const s = scopeSql(corpusId, collections);
  const sql = `SELECT ${CANDIDATE_COLS} FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE passage_fts MATCH ? AND ${s.where} ORDER BY p.document_id, p.field, p.start_off`;
  yield* stmt(db, sql).iterate(ftsQueryString(phrases), ...s.params);
}

/**
 * Candidate passage ids for an expression and its variants (phrase MATCH, variants OR-ed), ascending. Ids are
 * collected first so the caller can write while it works through them (no read cursor stays open).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{phrases: string[][], collections?: number[]|null, corpusId?: number|null}} args
 * @returns {number[]}
 */
export function ftsCandidates(db, { phrases, collections = null, corpusId = null }) {
  const s = scopeSql(corpusId, collections);
  const ids = stmt(db, `SELECT p.id FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE passage_fts MATCH ? AND ${s.where}`).all(ftsQueryString(phrases), ...s.params).map((r) => r.id);
  return ids.sort((a, b) => a - b);
}

/**
 * Up to `cap` candidate passages with their language (cheap on very common words: the scan stops at the cap).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{phrases: string[][], corpusId?: number|null, collections?: number[]|null, cap?: number}} args
 * @returns {Array<{id: number, lang: string}>}
 */
export function sampleCandidates(db, { phrases, corpusId = null, collections = null, cap = 2000 }) {
  const s = scopeSql(corpusId, collections);
  return stmt(db, `SELECT p.id, p.lang FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE passage_fts MATCH ? AND ${s.where} LIMIT ?`).all(ftsQueryString(phrases), ...s.params, cap);
}

/**
 * Passage rows (with their document's author and synthetic flag) for a list of ids, ordered by document,
 * field and offset.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @returns {object[]}
 */
export function passageRows(db, ids) {
  if (!ids.length) return [];
  return stmt(db, `SELECT ${CANDIDATE_COLS}, d.author, d.is_synthetic, d.y_lo, d.chrono_status, c.corpus_id, d.collection_id
    FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE p.id IN (SELECT value FROM json_each(?)) ORDER BY p.document_id, p.field, p.start_off`).all(JSON.stringify(ids));
}

/**
 * Preliminary hit counts: passages and documents whose folded text contains any of the phrases
 * (accent-insensitive, every passage quality), and how many of those documents are undated.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{phrases: string[][], corpusId?: number|null, collections?: number[]|null}} args
 * @returns {{passages: number, documents: number, undated: number}}
 */
export function passageHitCounts(db, { phrases, corpusId = null, collections = null }) {
  const s = scopeSql(corpusId, collections);
  const row = stmt(db, `SELECT count(*) AS passages, count(DISTINCT p.document_id) AS documents,
      count(DISTINCT CASE WHEN d.chrono_status = 'undated' THEN d.id END) AS undated
    FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
    JOIN collection c ON c.id = d.collection_id WHERE passage_fts MATCH ? AND ${s.where}`)
    .get(ftsQueryString(phrases), ...s.params);
  return { passages: row.passages, documents: row.documents, undated: row.undated };
}

/**
 * Number of candidate passages (for progress reporting).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{phrases: string[][], corpusId?: number|null, collections?: number[]|null}} args
 * @returns {number}
 */
export function countCandidates(db, args) {
  return passageHitCounts(db, args).passages;
}

/**
 * The term FTS stores for a folded JS token: unicode61 with remove_diacritics 2 strips Latin diacritics and
 * keeps other scripts' marks (verified on the vocabulary: 'zéro' → 'zero', 'क़लम' keeps its nukta).
 * @param {string} token
 * @returns {string}
 */
export function ftsTerm(token) {
  if (!/\p{Script=Latin}/u.test(token)) return token;
  return token.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/**
 * Per-passage instance counts of one FTS term (exact per passage, accent-insensitive): the very-frequent path.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} term
 * @returns {Array<{passage: number, n: number}>}
 */
export function termCounts(db, term) {
  return stmt(db, 'SELECT doc AS passage, count(*) AS n FROM passage_vocab_inst WHERE term = ? GROUP BY doc').all(term);
}

/**
 * Upper bound of the matches of single-token variants: instances of their FTS terms in the whole index.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} tokens
 * @returns {number}
 */
export function termInstanceEstimate(db, tokens) {
  let n = 0;
  for (const t of new Set(tokens.map(ftsTerm))) n += stmt(db, 'SELECT cnt FROM passage_vocab_row WHERE term = ?').get(t)?.cnt ?? 0;
  return n;
}
