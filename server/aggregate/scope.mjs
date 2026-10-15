// OWNER: WP3 — contract 1.3.0 (C2)
// scope.mjs — which corpora a request reads. A slug names one corpus or a virtual corpus (vocab.VIRTUAL_CORPORA):
// `real` is every non-synthetic corpus that holds documents — the synthetic demo is never a member. An expression is
// tracked per corpus, so an expression strand in `real` stands for its siblings (same kind, language and folded form)
// in every member corpus; each sibling keeps its own variants, runs and exclusions, and a lane's count in `real` is the
// sum of the member corpora counted alone.

import { tokenize } from '../../src/shared/tokenize.mjs';
import { VIRTUAL_CORPORA } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { guessLanguage, trackExpression } from './materialize.mjs';
import { kindOfTokens } from '../text/variants.mjs';

/** @param {string} slug @returns {boolean} */
export const isVirtualCorpus = (slug) => Object.hasOwn(VIRTUAL_CORPORA, String(slug ?? ''));

/**
 * Member corpora of `real`: non-synthetic corpora with at least one live document, by id.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{id: number, slug: string, name: string}>}
 */
export function realMembers(db) {
  // per collection through its (collection_id, …) index: a join let SQLite scan every live document for an empty corpus
  return stmt(db, `SELECT k.id, k.slug, k.name FROM corpus k WHERE k.is_synthetic = 0 AND k.slug <> 'demo'
    AND EXISTS (SELECT 1 FROM collection c WHERE c.corpus_id = k.id AND EXISTS (SELECT 1 FROM document d INDEXED BY doc_facets
      WHERE d.collection_id = c.id AND d.deleted_at IS NULL))
    ORDER BY k.id`).all().map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
}

/**
 * The corpora a slug reads.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} slug
 * @returns {{slug: string, name: string, virtual: boolean, ids: number[], members: Array<{id: number, slug: string, name: string}>,
 *   synthetic: boolean}}
 * @throws {HttpError} 400 for an unknown slug or a virtual corpus without members
 */
export function resolveCorpusScope(db, slug) {
  if (isVirtualCorpus(slug)) {
    const v = VIRTUAL_CORPORA[slug];
    const members = realMembers(db);
    if (!members.length) {
      throw new HttpError(400, 'E_VALIDATION', `No real corpus holds documents yet, so '${slug}' is empty.`,
        'Load the Cipher corpus or a STEMM source first.', { field: 'corpus' });
    }
    return { slug, name: v.name, virtual: true, ids: members.map((m) => m.id), members, synthetic: false };
  }
  const k = stmt(db, 'SELECT id, slug, name, is_synthetic FROM corpus WHERE slug = ?').get(String(slug ?? ''));
  if (!k) {
    throw new HttpError(400, 'E_VALIDATION', `Unknown corpus '${slug}'.`, 'Use one of the corpora listed by GET /api/corpora, or real.', { field: 'corpus' });
  }
  return { slug: k.slug, name: k.name, virtual: false, ids: [k.id], members: [{ id: k.id, slug: k.slug, name: k.name }],
    synthetic: k.is_synthetic === 1 };
}

/**
 * The siblings of an expression in each member corpus: the expression with the same kind, language and folded form.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: string, lang: string|null, norm: string}} expr
 * @param {Array<{id: number, slug: string}>} members
 * @returns {Array<{corpusId: number, corpus: string, expr: object|null}>} in member order; expr null when not tracked there
 */
export function siblingExpressions(db, expr, members) {
  const q = stmt(db, `SELECT * FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ? AND corpus_id = ?`);
  return members.map((m) => ({ corpusId: m.id, corpus: m.slug, expr: q.get(expr.kind, expr.lang ?? '', expr.norm, m.id) ?? null }));
}

/**
 * Track an expression in every member corpus of a virtual corpus (idempotent). The language is decided once — an
 * existing sibling's, the request's, or a guess in the first member — so every sibling has the same variants.
 * Writes on the caller's connection (main thread, short transactions).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{surface: string, lang?: string|null, kind?: string|null, corpus: string, origin?: string, createdBy?: string}} req
 * @returns {{id: number, members: Array<{corpus: string, corpusId: number, id: number, created: boolean}>}} id = the first member's
 */
export function trackAcross(db, { surface, lang = null, kind = null, corpus, origin = 'user_query', createdBy = 'user' }) {
  const scope = resolveCorpusScope(db, corpus);
  const tokens = tokenize(String(surface ?? '').trim()).tokens;
  let l = lang === undefined || lang === null || lang === '' ? null : String(lang).toLowerCase();
  if (l === null && tokens.length) {
    const k = kind ?? kindOfTokens(tokens);
    const known = stmt(db, `SELECT DISTINCT lang FROM expression WHERE kind = ? AND norm = ? AND corpus_id IN (SELECT value FROM json_each(?))`)
      .all(k, tokens.join(' '), JSON.stringify(scope.ids));
    l = known.length === 1 ? known[0].lang : guessLanguage(db, tokens, scope.ids[0]);
  }
  const members = scope.members.map((m) => {
    const r = trackExpression(db, { surface, lang: l, kind, corpus: m.slug, origin, createdBy });
    return { corpus: m.slug, corpusId: m.id, id: r.id, created: r.created };
  });
  return { id: members[0].id, members };
}
