// OWNER: WP3
// seams.mjs — the text → titles modality seam (SPEC §1.10, D15): when the visible lanes mix full text with
// titles or abstracts, a permanent seam stands at the last year with full text + 1. It can be collapsed to a
// ruler tick, never hidden: a change of medium must not read as a change of meaning.

import { sliceLastTextYear } from './cube.mjs';

/**
 * Seams for a def and its visible lanes (each lane has `modality` = its unit class).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def resolved query def (see query.mjs)
 * @param {Array<{modality: string}>} lanes visible lanes
 * @returns {Array<{kind: 'modality', year: number, last_covered_year: number, label: string, collapsible: true, hideable: false}>}
 */
export function seamsFor(db, def, lanes) {
  const mods = new Set(lanes.map((l) => l.modality));
  if (!mods.has('text') || !(mods.has('titles') || mods.has('abstracts'))) return [];
  // last_covered_year: the latest y_hi of a dated document with full-text tokens in this corpus (from the slice
  // cube). When every strand has languages, only documents whose full text is mostly (> 50% of tokens) in those
  // languages count (M1 gate: Cipher's Hindi/Gujarati Wikisource runs to 2023 and carries stray English passages, so
  // a corpus-wide seam put the end of English full text at 2023 instead of 1928).
  const exprs = (def.strands ?? []).filter((x) => x.type === 'expression');
  const langs = exprs.length && exprs.every((x) => Array.isArray(x.langs)) ? [...new Set(exprs.flatMap((x) => x.langs))].sort() : null;
  const last = sliceLastTextYear(db, def, langs);
  if (last === null) return [];
  return [{
    kind: 'modality', year: last + 1, last_covered_year: last,
    label: `Full text ends ${last} → after this line the evidence is titles and abstracts: a change of medium, not of meaning.`,
    collapsible: true, hideable: false,
  }];
}

/**
 * Seams of a query. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'seamsQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, lanes: Array<{modality: string}>}} args
 * @returns {{seams: object[]}}
 */
export function seamsQuery(db, { def, lanes }) {
  return { seams: seamsFor(db, def, lanes ?? []) };
}
