// OWNER: WP2
// themes.mjs — source adapter 'cipher.themes': culture-themes.tsv (theme, count, "other:value|…", example
// rows) → theme_assoc (SPEC §6.7). The values are Cipher's computed association strengths — normalised PMI
// shrunk by a shared-count factor, min(1, npmi·(0.6 + 0.4·min(1, ln shared / ln 40))), build_culture.py —
// stored in theme_assoc.npmi with that method; they are computed, never documented.
// This adapter yields no documents: the themes it describes are doc_tags of cipher.works. adapter-load
// writes its rows through themeAssocs().

import { CIPHER } from '../../config.mjs';
import { exists, lineRecords, readSource } from './source.mjs';
import { parseWeighted } from './tags-provenance.mjs';

export const id = 'cipher.themes';
export const version = '1.0.0';
export const label = 'Cipher theme associations';
export const access = 'local-dataset';
export const license = 'derived by Cipher from Wikidata (CC0)';
export const attribution = 'Cipher';
export const stagedDir = null;
// Theme associations live in theme_assoc; §6.2 names no collection for them.
export const collections = [];
export const METHOD = 'Cipher NPMI (build_culture.py): normalised PMI × shared-count factor, pairs sharing ≥ 3 works, npmi ≥ 0.2';

/** @returns {string[]} */
export function sourceFiles() {
  return [CIPHER.cultureThemes];
}

/**
 * Parsed rows of culture-themes.tsv.
 * @param {string} [file]
 * @returns {{rows: Array<{theme: string, count: number, assoc: Array<{other: string, value: number}>, examples: number[]}>, bad: number[]}}
 */
export function loadThemes(file = CIPHER.cultureThemes) {
  const rows = [];
  const bad = [];
  for (const rec of lineRecords(readSource(file).bytes)) {
    const c = rec.text.split('\t');
    if (c.length !== 4 || !c[0]) { bad.push(rec.index + 1); continue; }
    rows.push({
      theme: c[0],
      count: Number(c[1]),
      assoc: parseWeighted(c[2]).filter((a) => a.weight !== null).map((a) => ({ other: a.value, value: a.weight })),
      examples: c[3] ? c[3].split('|').map(Number).filter(Number.isInteger) : [],
    });
  }
  return { rows, bad };
}

/** @param {object} ctx @returns {Promise<object>} ProbeResult */
export async function probe() {
  if (!exists(CIPHER.cultureThemes)) {
    return { available: false, reason: `culture-themes.tsv not found at ${CIPHER.cultureThemes}`, manifest_ok: false,
      format_ok: false, counts: {}, caveats: [] };
  }
  const { rows, bad } = loadThemes();
  return { available: bad.length === 0, ...(bad.length ? { reason: `${bad.length} malformed rows (first: line ${bad[0]})` } : {}),
    manifest_ok: true, format_ok: bad.length === 0,
    counts: { themes: rows.length, associations: rows.reduce((s, r) => s + r.assoc.length, 0) },
    caveats: ['Association strengths are computed by Cipher (shrunk NPMI), not documented relations.'] };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: loadThemes().rows.length };
}

/** No documents: themes are doc_tags of culture works. */
// eslint-disable-next-line require-yield
export async function* documents() {}

/**
 * theme_assoc rows.
 * @returns {AsyncGenerator<{theme: string, other: string, npmi: number, count: number}>}
 */
export async function* themeAssocs(params = {}, ctx = {}) {
  ctx.keepOriginal?.(CIPHER.cultureThemes, readSource(CIPHER.cultureThemes));
  for (const r of loadThemes().rows) {
    for (const a of r.assoc) yield { theme: r.theme, other: a.other, npmi: a.value, count: r.count };
  }
}

/**
 * Theme labels for typeahead (label_tri kind 'theme').
 * @returns {AsyncGenerator<{label: string, count: number}>}
 */
export async function* themeLabels() {
  for (const r of loadThemes().rows) yield { label: r.theme, count: r.count };
}
