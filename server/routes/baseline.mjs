// OWNER: WP2
// routes/baseline.mjs — GET /api/baseline?word=&from=&to=&lang= (SPEC §7.1, §10.2): the Google Books Ngram series of
// one word, or {available: false, reason}. The baseline is a different corpus on its own track: it is never mixed
// into Scrolls counts. Runs in the read pool (the store is opened read-only per worker).
// `lang` (optional, additive): the store is English-only, so another language answers {available: false}.

import { badRequest } from '../http/errors.mjs';
import { series } from '../adapters/stemm/ngram.mjs';

const MODULE_URL = import.meta.url;

/**
 * @param {import('node:sqlite').DatabaseSync} db unused: the store is a separate read-only file
 * @param {{word: string, from?: number|null, to?: number|null, lang?: string|null}} args
 * @returns {object} Baseline shape
 */
export function baselineQuery(db, { word, from = null, to = null, lang = null }) {
  return series(word, { from, to, lang });
}

const year = (v, name) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < -10000 || n > 2100) throw badRequest('E_VALIDATION', `${name} must be a year.`, 'Use e.g. from=1800&to=2019.');
  return n;
};

export const routes = [
  {
    method: 'GET',
    path: '/api/baseline',
    heavy: true,
    async handler(req, ctx) {
      const word = String(req.query.word ?? '').trim();
      if (!word) throw badRequest('E_VALIDATION', 'word is required.', 'Use /api/baseline?word=virus.');
      if (word.length > 120) throw badRequest('E_VALIDATION', 'word is too long.', 'The baseline holds single words.');
      const lang = req.query.lang ? String(req.query.lang).trim() : null;
      if (lang && !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(lang)) throw badRequest('E_VALIDATION', 'lang must be a language code.', 'Use e.g. lang=en.');
      const from = year(req.query.from, 'from'), to = year(req.query.to, 'to');
      if (from !== null && to !== null && from > to) throw badRequest('E_VALIDATION', 'from must not be after to.', 'Swap the two years.');
      return { json: await ctx.pool.run(MODULE_URL, 'baselineQuery', { word, from, to, lang }) };
    },
  },
];
