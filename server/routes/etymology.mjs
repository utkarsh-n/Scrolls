// OWNER: WP3 — added at the M5 integration gate (contract 1.2.0; WP6 need)
// routes/etymology.mjs — the etymology families of a tracked expression (SPEC §1.7, §6.7, §10.5):
//
//   GET /api/etymology?expr=<expression id>   → Etymology
//
// Families come from Cipher's roots data (roots.tsv → etymon, etymon_parent, etymon_member): every etymon or root
// whose member list holds one of the expression's enabled single-word variants in its language. Each family
// carries its listed parents and `parent_semantics`, so the Scroll can draw the listed-roots bracket. These are
// language periods, not dates, and a multi-parent list is never presented as competing hypotheses (§13 rule 12).
//
// Contract 1.3.0 (C5): `roots` lists every listed parent once, with `families` naming the etyma that list it (and
// `is_family` when it is itself one of the families), so a PIE root listed by two etyma (la:virus and *wisós) is drawn
// once. `families[].parents` stay as before; a parent listed by more than one family there carries `shared: true`.

import { HttpError } from '../http/errors.mjs';
import { stmt } from '../db/open.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { getExpression, variantsOf } from '../aggregate/materialize.mjs';

const SOURCE = 'Wiktionary via kaikki.org (CC BY-SA), as listed in Cipher\'s roots data';
const NO_FAMILY = "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)";
const MAX_FAMILIES = 8;

const etymonOf = (r) => ({ key: r.key, lang: r.lang, form: r.form, roman: r.roman ?? null, gloss: r.gloss ?? null, kind: r.kind });

/**
 * Families of an expression (single-word variants only; phrases and symbols have none).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exprId
 * @returns {object} Etymology
 */
export function etymologyOf(db, exprId) {
  const expr = getExpression(db, exprId);
  if (!expr) throw new HttpError(404, 'E_NOT_FOUND', `No expression ${exprId}.`, 'Track the word first (POST /api/expressions).');
  const base = { expression: expr.id, word: expr.surface, lang: expr.lang ?? null, source: SOURCE };
  const words = [];
  for (const v of variantsOf(db, exprId)) {
    if (v.enabled !== 1) continue;
    const toks = tokenize(v.form).tokens;
    if (toks.length !== 1) continue;
    const lang = String(v.lang ?? expr.lang ?? '').slice(0, 2);
    if (lang) words.push({ lang, norm: toks[0] });
  }
  if (!words.length) {
    const reason = expr.lang ? 'Etymology families are listed for single words only.' : 'Etymology families are listed for words of a known language.';
    return { available: false, ...base, reason };
  }
  if (!stmt(db, 'SELECT 1 FROM etymon LIMIT 1').get()) {
    return { available: false, ...base, reason: "Cipher's roots data is not loaded yet (bootstrap phase A loads it)." };
  }
  const members = new Map();     // etymon key → [{lang, word, rank}]
  for (const w of words) {
    for (const m of stmt(db, 'SELECT key, lang, word, rank FROM etymon_member WHERE lang = ? AND norm = ? ORDER BY rank').all(w.lang, w.norm)) {
      if (!members.has(m.key)) members.set(m.key, []);
      const list = members.get(m.key);
      if (!list.some((x) => x.lang === m.lang && x.word === m.word)) list.push({ lang: m.lang, word: m.word, rank: m.rank });
    }
  }
  const families = [];
  for (const [key, list] of [...members].sort((a, b) => Math.min(...a[1].map((x) => x.rank)) - Math.min(...b[1].map((x) => x.rank)))) {
    const e = stmt(db, 'SELECT * FROM etymon WHERE key = ?').get(key);
    if (!e) continue;
    const parents = stmt(db, `SELECT e.* FROM etymon_parent p JOIN etymon e ON e.key = p.parent_key
      WHERE p.key = ? AND p.parent_key <> p.key ORDER BY p.ord`).all(key).map(etymonOf);
    families.push({ ...etymonOf(e), parent_semantics: e.parent_semantics, parents, members: list });
    if (families.length >= MAX_FAMILIES) break;
  }
  return { available: true, ...base, families, roots: dedupeRoots(families), note: families.length ? null : NO_FAMILY };
}

/**
 * Every listed parent once (C5), in first-listed order, with the families that list it; marks the parents that more
 * than one family lists (`shared`).
 * @param {object[]} families
 * @returns {Array<object>} roots: Etymon + {families: string[], is_family: boolean}
 */
export function dedupeRoots(families) {
  const byKey = new Map();
  const familyKeys = new Set(families.map((f) => f.key));
  for (const f of families) {
    for (const p of f.parents) {
      const r = byKey.get(p.key);
      if (r) { if (!r.families.includes(f.key)) r.families.push(f.key); } else byKey.set(p.key, { ...p, families: [f.key], is_family: familyKeys.has(p.key) });
    }
  }
  for (const f of families) for (const p of f.parents) if (byKey.get(p.key).families.length > 1) p.shared = true;
  return [...byKey.values()];
}

/** @type {Array<{method: string, path: string, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/etymology',
    async handler(req, ctx) {
      const raw = req.query.expr ?? req.query.expression;
      const id = Number(String(raw ?? '').replace(/^expression:/, ''));
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'E_VALIDATION', 'expr must be an expression id.', 'Use ?expr=12.', { field: 'expr' });
      // index lookups only (etymon_member(lang, norm), primary keys): cheap enough for the main connection
      return { json: etymologyOf(ctx.db, id) };
    },
  },
];
