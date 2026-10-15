// OWNER: WP2
// field-map.mjs — source field labels → STEMM lanes of data/field-taxonomy.json (SPEC §10.3). One shared
// taxonomy for LoCC classes (Gutenberg), gutenberg-stemm fields, OpenAlex field ids and Wiktionary fields.

import { readFileSync } from 'node:fs';
import { STEMM_LANES } from '../../../src/shared/vocab.mjs';

const TAXONOMY_URL = new URL('../../../data/field-taxonomy.json', import.meta.url);
let taxonomy = null;

/** The parsed taxonomy file (cached). @returns {object} */
export function fieldTaxonomy() {
  taxonomy ??= JSON.parse(readFileSync(TAXONOMY_URL, 'utf8'));
  return taxonomy;
}

const LANE_KEYS = new Set(STEMM_LANES.map((l) => l.key));

/**
 * The STEMM lane key for a source label (LoCC class, gutenberg-stemm field, OpenAlex field id, Wiktionary
 * field), or null when the label is not a STEMM field.
 * @param {{source: 'locc'|'stemm'|'openalex'|'wiktionary', value: string|number, subjects?: string[]}} label
 * @returns {string|null}
 */
export function laneForField({ source, value, subjects = [] }) {
  const t = fieldTaxonomy();
  if (value === null || value === undefined || value === '') return null;
  let lane = null;
  if (source === 'locc') {
    const v = String(value).trim().toUpperCase();
    const rule = t.locc.filter((r) => v.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    lane = rule ? rule.lane : null;
    if (lane && v.startsWith('TK') && subjects.some((s) => t.computing_subjects.some((c) => s.toLowerCase().includes(c)))) lane = 'computing';
  } else if (source === 'stemm') {
    lane = t.stemm_fields[String(value)] ?? null;
  } else if (source === 'openalex') {
    lane = t.openalex_fields[String(Number(value))] ?? null;
  } else if (source === 'wiktionary') {
    lane = t.wiktionary_fields[String(value)] ?? null;
  }
  return lane && LANE_KEYS.has(lane) ? lane : null;
}

/**
 * The first STEMM lane among several LoCC classes ("PR; QA"), or null.
 * @param {string} loccField semicolon-separated LoCC classes
 * @param {string[]} [subjects]
 * @returns {string|null}
 */
export function laneForLocc(loccField, subjects = []) {
  for (const c of String(loccField ?? '').split(/[;,]\s*/)) {
    if (!/^[QRT]/i.test(c.trim())) continue;
    const lane = laneForField({ source: 'locc', value: c, subjects });
    if (lane) return lane;
  }
  return null;
}
