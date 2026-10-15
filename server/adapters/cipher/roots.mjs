// OWNER: WP2
// roots.mjs — source adapter 'cipher.roots': roots.tsv (54,989 families from Wiktionary via kaikki.org,
// CC BY-SA; columns key, kind, lang, form, roman, gloss, roots, members) → etymon, etymon_parent,
// etymon_member (SPEC §6.7).
// Etymology is periods, not dates: nothing here dates a word. A multi-parent list is never read as competing
// hypotheses or as one parent; `parent_semantics` records what the list measurably is:
//   none (0 parents) · single (1) · listed_chain (a Sanskrit dhātu and a PIE root — likely a chain written
//   flat, not stated) · listed_variants (every parent form within edit distance 2 of the first — variant
//   reconstructions) · listed_unresolved (the rest: components or alternatives, not recorded).
// This adapter yields no documents; adapter-load writes the etymon tables through etymons().

import { CIPHER } from '../../config.mjs';
import { normString } from '../../../src/shared/tokenize.mjs';
import { exists, lineRecords, readSource } from './source.mjs';

export const id = 'cipher.roots';
export const version = '1.0.0';
export const label = 'Cipher etymology (roots.tsv)';
export const access = 'local-dataset';
export const license = 'CC BY-SA';
export const attribution = 'Wiktionary via kaikki.org (CC BY-SA)';
export const stagedDir = null;
// Etymology lives in the etymon tables; §6.2 names no collection for it.
export const collections = [];
const COLUMNS = ['key', 'kind', 'lang', 'form', 'roman', 'gloss', 'roots', 'members'];

/** @returns {string[]} */
export function sourceFiles() {
  return [CIPHER.roots];
}

/** Levenshtein distance, bounded: returns max+1 as soon as the distance exceeds `max`. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const formOf = (key) => key.slice(key.indexOf(':') + 1);

/**
 * parent_semantics of a parent-key list (see header).
 * @param {string[]} parents
 * @returns {'none'|'single'|'listed_chain'|'listed_variants'|'listed_unresolved'}
 */
export function parentSemantics(parents) {
  if (parents.length === 0) return 'none';
  if (parents.length === 1) return 'single';
  if (parents.some((p) => p.startsWith('sa:')) && parents.some((p) => p.startsWith('ine-pro:'))) return 'listed_chain';
  const first = [...formOf(parents[0])];
  if (parents.slice(1).every((p) => editDistance(first, [...formOf(p)]) <= 2)) return 'listed_variants';
  return 'listed_unresolved';
}

/**
 * Parsed roots.tsv rows.
 * @param {string} [file]
 * @returns {{rows: object[], bad: number[]}}
 */
export function loadRoots(file = CIPHER.roots) {
  const rows = [];
  const bad = [];
  for (const rec of lineRecords(readSource(file).bytes)) {
    const c = rec.text.split('\t');
    if (c.length !== COLUMNS.length || !c[0]) { bad.push(rec.index + 1); continue; }
    const parents = c[6] ? [...new Set(c[6].split('|').filter(Boolean))] : [];
    const members = [];
    const seen = new Set();
    for (const m of c[7] ? c[7].split('|') : []) {
      const k = m.indexOf(':');
      if (k <= 0) continue;
      const lang = m.slice(0, k), word = m.slice(k + 1);
      if (!word || seen.has(`${lang}\u0000${word}`)) continue;
      seen.add(`${lang}\u0000${word}`);
      members.push({ lang, word, norm: normString(word), rank: members.length + 1 });
    }
    rows.push({
      key: c[0], kind: c[1] === 'root' ? 'root' : 'etymon', lang: c[2], form: c[3], roman: c[4] || null, gloss: c[5] || null,
      parents: parents.map((key, ord) => ({ key, ord })), parent_semantics: parentSemantics(parents), members,
    });
  }
  return { rows, bad };
}

/** @returns {Promise<object>} ProbeResult */
export async function probe() {
  if (!exists(CIPHER.roots)) {
    return { available: false, reason: `roots.tsv not found at ${CIPHER.roots}`, manifest_ok: false, format_ok: false,
      counts: {}, caveats: [] };
  }
  const { rows, bad } = loadRoots();
  const counts = { families: rows.length };
  for (const r of rows) counts[r.parent_semantics] = (counts[r.parent_semantics] ?? 0) + 1;
  return { available: bad.length === 0, ...(bad.length ? { reason: `${bad.length} malformed rows (first: line ${bad[0]})` } : {}),
    manifest_ok: true, format_ok: bad.length === 0, counts,
    caveats: ['Latin, Ancient Greek, Sanskrit and PIE only; language periods, not dates; member order is a frequency heuristic.'] };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: loadRoots().rows.length };
}

/** No documents: etymology lives in the etymon tables. */
// eslint-disable-next-line require-yield
export async function* documents() {}

/**
 * Etymon rows with their parents and members.
 * @returns {AsyncGenerator<object>}
 */
export async function* etymons(params = {}, ctx = {}) {
  ctx.keepOriginal?.(CIPHER.roots, readSource(CIPHER.roots));
  yield* loadRoots().rows;
}

/**
 * Wiktionary locator of an etymon (descent edges are virtual until reviewed, §6.7): the reconstruction page
 * for PIE, else the lemma page.
 * @param {string} key e.g. 'ine-pro:*kewh₁-', 'la:virus'
 * @returns {string}
 */
export function wiktionaryLocator(key) {
  const lang = key.slice(0, key.indexOf(':'));
  const form = formOf(key);
  if (lang === 'ine-pro') return `https://en.wiktionary.org/wiki/Reconstruction:Proto-Indo-European/${encodeURIComponent(form.replace(/^\*/, ''))}`;
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(form)}`;
}
