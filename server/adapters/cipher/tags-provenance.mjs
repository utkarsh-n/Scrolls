// OWNER: WP2
// tags-provenance.mjs — doc_tag provenance for culture-work themes, motifs and moods (SPEC §6.5), and the
// index of Cipher's raw tagging batches ($T/tags/*.jsonl) that decides it.
//
// Why weight 0.55 means "genre": Cipher's build_culture.py (themes_from) and build_songs.py add a work's
// Wikidata genre (P136) labels at exactly 0.55 and nothing else at that weight (subjects 1.0, "about"
// categories 0.9/0.8, genre categories 0.6, settings 0.45, tagging-pass themes 1.0 − 0.08·position, film
// songs 0.35·w). So a 0.55 theme is a genre category name by construction.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fold, TAGGING_METHOD } from './source.mjs';

export const GENRE_WEIGHT = 0.55;
export const GENRE_MOOD_WEIGHT = 0.5;

// doc_tag.method is stored on every tag row (≈ 600k for the culture works), so these stay short; the long
// explanations are in Docs/CIPHER-MAPPING.md and METHOD_NOTES.
export const TAG_METHODS = Object.freeze({
  documented_category: 'Wikidata/Wikipedia categories (Cipher)',
  genre_heuristic: 'Wikidata genre label, weight 0.55 (Cipher)',
  genre_mood: 'genre-derived mood, weight 0.50 (Cipher)',
  machine_tag: TAGGING_METHOD,
  canon: 'canon list (Cipher)',
  maker: 'Wikidata maker (Cipher)',
});

/** The long form of each method, for tooltips and the mapping document. */
export const METHOD_NOTES = Object.freeze({
  [TAG_METHODS.documented_category]: 'Wikidata subjects (P921) and Wikipedia categories, weighted and merged by Cipher build_culture.py themes_from()',
  [TAG_METHODS.genre_heuristic]: 'a Wikidata genre (P136) label added at weight 0.55 by build_culture.py / build_songs.py: genre-derived, not a statement about the work',
  [TAG_METHODS.genre_mood]: 'mood implied by the genre (build_culture.py GENRE_MOOD) at half weight, for works the tagging pass did not reach',
  [TAG_METHODS.machine_tag]: 'themes, motifs, moods and meanings written by Claude sub-agents for the top ~1,500 works and tagged songs ($T/tags/*.jsonl); fallible annotations',
  [TAG_METHODS.canon]: 'canon lists named by Cipher (AFI 100, Best Picture, …)',
  [TAG_METHODS.maker]: 'director / author / artist as recorded by Cipher from Wikidata',
});

/**
 * Index the raw tagging batches: Wikidata/Cipher id → { themes:Set<folded>, motifs, mood, meaning,
 * siblings:[{title (folded), year, relation}] }. Later batches win for a repeated id (as in build_culture.py).
 * @param {string} tagsDir
 * @returns {Map<string, {themes: Set<string>, siblings: Array<{title: string, year: number|null, relation: string}>}>}
 */
export function loadTagIndex(tagsDir) {
  const index = new Map();
  let files = [];
  try { files = readdirSync(tagsDir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return index; }
  for (const f of files) {
    for (const line of readFileSync(path.join(tagsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; } // build_culture.py skips unreadable lines too
      if (!r || typeof r.q !== 'string') continue;
      index.set(r.q, {
        file: f,
        themes: new Set((r.themes ?? []).map((t) => fold(t))),
        siblings: (r.siblings ?? []).map((s) => ({ title: fold(s.title), year: Number.isInteger(s.year) ? s.year : null,
          relation: String(s.relation ?? '') })),
      });
    }
  }
  return index;
}

/**
 * documented_category, machine_tag or genre_heuristic for one theme tag (§6.5): machine_tag when the theme
 * is in that work's tagging batch; genre_heuristic at weight exactly 0.55 (a genre label, see header);
 * otherwise documented_category.
 * @param {{scheme: string, value: string, weight: number|null, row?: number, tagged?: {themes: Set<string>}|null}} tag
 * @returns {'documented_category'|'machine_tag'|'genre_heuristic'}
 */
export function tagProvenance({ scheme, value, weight, tagged = null }) {
  if (scheme === 'motif') return 'machine_tag';
  if (scheme === 'canon') return 'documented_category';
  if (scheme === 'maker') return 'catalog';
  if (scheme === 'mood') return weight === GENRE_MOOD_WEIGHT ? 'genre_heuristic' : 'machine_tag';
  if (tagged && tagged.themes.has(fold(value))) return 'machine_tag';
  if (weight === GENRE_WEIGHT) return 'genre_heuristic';
  return 'documented_category';
}

/**
 * Parse a `phrase:weight|…` list (themes, genre moods) or a plain `a|b|c` list (motifs, tagged moods).
 * Theme phrases may themselves contain ':' ("teenage pregnancy in:0.35"), so the weight is after the last one.
 * @param {string} field
 * @returns {Array<{value: string, weight: number|null}>}
 */
export function parseWeighted(field) {
  if (!field) return [];
  return field.split('|').filter(Boolean).map((item) => {
    const k = item.lastIndexOf(':');
    const w = k > 0 ? Number(item.slice(k + 1)) : NaN;
    return Number.isFinite(w) && /^\d+(?:\.\d+)?$/.test(item.slice(k + 1))
      ? { value: item.slice(0, k).trim(), weight: w }
      : { value: item.trim(), weight: null };
  }).filter((t) => t.value);
}

/**
 * Doc tags of one culture-works row (§6.5): maker (catalog), canon (documented_category), themes (by
 * provenance), motifs (machine_tag), moods (genre_heuristic when every value is at 0.50, else machine_tag).
 * @param {{maker: string, canon: string, themes: string, motifs: string, mood: string}} cols
 * @param {{themes: Set<string>}|null} tagged the work's tagging batch, if any
 * @returns {Array<{scheme: string, value: string, weight: number|null, provenance: string, method: string}>}
 */
export function workTags(cols, tagged) {
  const tags = [];
  for (const m of splitMakers(cols.maker)) tags.push({ scheme: 'maker', value: m, weight: null, provenance: 'catalog', method: TAG_METHODS.maker });
  for (const c of parseWeighted(cols.canon)) tags.push({ scheme: 'canon', value: c.value, weight: null, provenance: 'documented_category', method: TAG_METHODS.canon });
  for (const t of parseWeighted(cols.themes)) {
    const provenance = tagProvenance({ scheme: 'theme', value: t.value, weight: t.weight, tagged });
    tags.push({ scheme: 'theme', value: t.value, weight: t.weight, provenance, method: TAG_METHODS[provenance] });
  }
  for (const m of parseWeighted(cols.motifs)) tags.push({ scheme: 'motif', value: m.value, weight: null, provenance: 'machine_tag', method: TAG_METHODS.machine_tag });
  const moods = parseWeighted(cols.mood);
  const genreMoods = moods.length > 0 && moods.every((m) => m.weight === GENRE_MOOD_WEIGHT);
  for (const m of moods) {
    tags.push(genreMoods
      ? { scheme: 'mood', value: m.value, weight: m.weight, provenance: 'genre_heuristic', method: TAG_METHODS.genre_mood }
      : { scheme: 'mood', value: m.value, weight: m.weight, provenance: 'machine_tag', method: TAG_METHODS.machine_tag });
  }
  return tags;
}

const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);

/**
 * Makers of a `maker` cell: Cipher joins several with ", " ("Marta Kauffman, David Crane"); a trailing
 * "Jr." stays with its name.
 * @param {string} maker
 * @returns {string[]}
 */
export function splitMakers(maker) {
  if (!maker) return [];
  const parts = maker.split(', ').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && SUFFIXES.has(p.toLowerCase())) out[out.length - 1] += `, ${p}`;
    else out.push(p);
  }
  return [...new Set(out)];
}
