// OWNER: WP3 — contract 1.3.0 (C2, C3)
// trail.mjs — the Term trail (SPEC §10.5): an ordered, fixed lane set (vocab.TRAIL_LANES) from etymology bands through
// Cipher literature text, Gutenberg STEMM text and OpenAlex samples per field, to culture titles and music-relation
// endpoints. Every lane keeps its own unit and medium; nothing is pooled across units or modalities, and co-presence in
// two lanes is never drawn as transmission.
//
// OpenAlex lanes (unit share_of_sampled_works) carry within-cell presence shares on OpenAlex's own 30 bins (D14, §10.4):
// for each cell (OpenAlex field × period bin) k of the n sampled works whose title or abstract is in the strand's
// languages mention the strand, with a Wilson 95% CI; n < 20 is 'low' (k and n, no share). A cell is one top-cited
// sample: shares are side by side, never a rate, a trend or a comparison across cells.

import { TRAIL_LANES, COVERAGE_GATES, SHARE_LANE_NOTE } from '../../src/shared/vocab.mjs';
import { dayFromYMD, yearLabel } from '../../src/shared/dates.mjs';
import { series } from '../adapters/stemm/ngram.mjs';
import { createMemo } from './cache.mjs';
import { cubeCellWorks, cubesOf, docCells } from './cube.mjs';
import { expressionClaims } from './materialize.mjs';
import { wilsonCI } from './stats.mjs';

const memo = createMemo({ max: 16 });
const r4 = (x) => Math.round(x * 1e4) / 1e4;
/** The share gate of a cell: sampled works (§4.6, COVERAGE_GATES.sampled_works). */
export const SHARE_GATE = COVERAGE_GATES.sampled_works;
export { SHARE_LANE_NOTE };

/** Trail values present in a cube (any row, whatever the slice): which source lanes the corpus can show. */
function cubeTrailValues(cube) {
  return memo(`tv|${cube.corpusId}|${cube.n}|${cube.colls.map((c) => c.id).join(',')}`, () => {
    const out = new Set();
    const nf = cube.dicts.field.length + 1;
    const seen = new Set();
    const { coll, field, fc, del } = cube.cols;
    const FCS = ['text', 'title', 'abstract', 'describes', 'apparatus'];
    for (let r = 0; r < cube.n; r++) {
      if (del?.[r]) continue;   // a soft-deleted document (reverted import) shows no lane
      const code = (coll[r] * nf + field[r]) * 5 + fc[r];
      if (seen.has(code)) continue;
      seen.add(code);
      const c = cube.colls[coll[r]];
      const fcName = FCS[fc[r]];
      const textish = fcName !== 'title' && fcName !== 'abstract';
      const f = cube.dicts.field[field[r]];
      if (c.sampling === 'relation_endpoints') { if (fcName === 'title') out.add('music-relations'); }
      else if (c.sampling === 'top_cited_per_cell') { if (!textish && f) out.add(`stemm-abstracts:${f}`); }
      else if (c.domain === 'literature') { if (textish) out.add('literature-text'); }
      else if (c.domain === 'stemm') { if (textish && f) out.add(`stemm-text:${f}`); }
      else if (c.domain === 'culture') { if (fcName === 'title') out.add('culture-titles'); }
    }
    return out;
  });
}

/**
 * The trail lanes a def can show, in the fixed order, and the ones its corpora cannot (with the reason).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def a def with lanes.facet 'trail'
 * @returns {{present: object[], absent: Array<{key: string, label: string, reason: string}>}}
 */
export function trailLanesOf(db, def) {
  const values = new Set();
  for (const cube of cubesOf(db, def)) for (const v of cubeTrailValues(cube)) values.add(v);
  const words = def.strands.filter((s) => s.type === 'expression' && s.kind === 'word');
  const present = [], absent = [];
  for (const l of TRAIL_LANES) {
    const v = l.key.slice('trail:'.length);
    if (l.kind === 'etymology') {
      if (words.length) present.push(l);
      else absent.push({ key: l.key, label: l.label, reason: 'Etymology bands are listed for single words only.' });
    } else if (values.has(v)) present.push(l);
    else absent.push({ key: l.key, label: l.label, reason: `No ${l.label.toLowerCase()} is loaded in ${def.corpus}.` });
  }
  return { present, absent };
}

/** OpenAlex cell `field|lo-hi` → its field and years, or null. */
export function parseCell(cell) {
  const m = /^(.*)\|(-?\d+)-(-?\d+)$/.exec(String(cell ?? ''));
  return m ? { field: m[1], lo_year: Number(m[2]), hi_year: Number(m[3]) } : null;
}

/**
 * Within-cell shares of one strand on every OpenAlex lane of a trail def (C3).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {object} strand
 * @param {object[]} docRows query.strandDocRows(db, def, strand) (rows of unit class 'cells' are used)
 * @param {string[]|null|{byCorpus: object}} langs the strand's language spec
 * @returns {{cells: Map<string, object[]>, outside: Map<string, number>}} cells per lane (by year, then field) and,
 *   per lane, matched works without a cell
 */
export function shareCells(db, def, strand, docRows, langs) {
  const works = new Map(), all = new Map(), maps = [];
  for (const cube of cubesOf(db, def)) {
    if (cube.endpoints) continue;
    const cells = docCells(db, cube.corpusId);
    if (!cells.size) continue;
    maps.push(cells);
    for (const [k, a] of cubeCellWorks(cube, def, langs, cells)) {
      const w = works.get(k);
      if (w) w.n += a.n; else works.set(k, { ...a });
    }
    for (const [k, a] of cubeCellWorks(cube, def, null, cells)) all.set(k, (all.get(k) ?? 0) + a.n);
  }
  const cellOf = (doc) => { for (const m of maps) { const c = m.get(doc); if (c !== undefined) return c; } return null; };
  const hits = new Map(), outside = new Map();
  const seen = new Set();
  for (const r of docRows) {
    if (r.uc !== 'cells' || !(r.v > 0)) continue;
    const lane = `trail:${r.lv}`;
    const dk = `${lane}|${r.doc}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const cell = cellOf(r.doc);
    if (!cell || !parseCell(cell)) { outside.set(lane, (outside.get(lane) ?? 0) + 1); continue; }
    hits.set(`${lane}|${cell}`, (hits.get(`${lane}|${cell}`) ?? 0) + 1);
  }
  const cells = new Map();
  const add = (lane, c) => { const list = cells.get(lane); if (list) list.push(c); else cells.set(lane, [c]); };
  for (const [key, a] of works) {
    const c = parseCell(a.cell);
    if (c) add(a.lane, shareCell(c, a.cell, hits.get(key) ?? 0, a.n, all.get(key) ?? a.n, strand));
  }
  for (const [key, k] of hits) {
    if (works.has(key)) continue;
    // a matched work whose cell has no work in the strand's languages cannot occur (its matching row is one): kept honest anyway
    const i = key.indexOf('|');
    add(key.slice(0, i), shareCell(parseCell(key.slice(i + 1)), key.slice(i + 1), k, k, all.get(key) ?? k, strand));
  }
  for (const list of cells.values()) list.sort((x, y) => x.lo_year - y.lo_year || x.field.localeCompare(y.field));
  return { cells, outside };
}

function shareCell(c, cell, k, n, nCell, strand) {
  const base = { lo_year: c.lo_year, hi_year: c.hi_year, label: `${yearLabel(c.lo_year)}–${yearLabel(c.hi_year)}`, field: c.field, cell,
    k, n, n_cell: nCell, strand: strand.type === 'expression' ? strand.ref : strand.key, synthetic: Boolean(strand.synthetic) };
  if (n === 0) return { ...base, share: null, ci: null, state: 'uncovered', text: `no sampled work in the strand's languages (${nCell} sampled)` };
  if (n < SHARE_GATE) return { ...base, share: null, ci: null, state: 'low', text: `low coverage: ${k} of ${n} sampled works (gate ${SHARE_GATE}) — no share` };
  const ci = wilsonCI(k, n).map(r4);
  return { ...base, share: r4(k / n), ci, state: k > 0 ? 'observed' : 'absent',
    text: `${k} of ${n} sampled works (title or abstract) mention it · ${SHARE_LANE_NOTE}` };
}

/**
 * The year span of a tile (for placing share cells, which do not follow calendar bins).
 * @param {string} tier
 * @param {number} tile
 * @returns {[number, number]} inclusive astronomical years
 */
export function tileYears(tier, tile) {
  const level = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].indexOf(tier);
  const b0 = tile * 64, b1 = b0 + 63;
  if (level <= 3) { const w = [1000, 100, 10, 1][level]; return [b0 * w, b1 * w + w - 1]; }
  if (level === 4) return [Math.floor(b0 / 12), Math.floor(b1 / 12)];
  const year = (day) => new Date(day * 86400000).getUTCFullYear();
  return [year(b0), year(b1)];
}

/**
 * The tile holding a year's first bin at a tier: the one tile that owns a share cell starting that year (tiles of
 * months and days share boundary years, so a year range alone would name two).
 * @param {string} tier
 * @param {number} year astronomical
 * @returns {number}
 */
export function ownerTile(tier, year) {
  const level = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].indexOf(tier);
  if (level <= 3) return Math.floor(Math.floor(year / [1000, 100, 10, 1][level]) / 64);
  if (level === 4) return Math.floor((year * 12) / 64);
  return Math.floor(dayFromYMD(year, 1, 1) / 64);
}

/**
 * Baseline and claim markers of a def's single-word strands (C2): the external Ngram baseline (a different corpus, its
 * own track) when the word is English, and the Wiktionary claims written on the expression in any member corpus
 * (display rule as built: default or dimmed with reasons). Claims are never occurrences.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {{baseline: object|null, claims: object[], by_strand: Record<string, {baseline: object|null, claims: object[]}>}}
 */
export function strandExtras(db, def) {
  const by = {};
  for (const s of def.strands) {
    if (s.type !== 'expression' || s.synthetic) continue;
    const single = s.kind === 'word';
    const english = String(s.lang ?? '').split('-')[0] === 'en';
    let baseline = null;
    if (single && english) {
      let b;
      try { b = series(s.surface, { lang: 'en' }); } catch (err) { b = { available: false, reason: `The Ngram store could not be read (${err.message}).` }; }
      baseline = { available: Boolean(b.available), href: `/api/baseline?word=${encodeURIComponent(s.surface)}&lang=en`,
        ...(b.available ? {} : { reason: b.reason ?? null }) };
    } else if (!single) {
      baseline = { available: false, href: null, reason: 'No external baseline: the Ngram store holds single words only.' };
    }
    const seen = new Set(), claims = [];
    for (const m of s.members ?? [{ ref: s.ref }]) {
      if (!m.ref) continue;
      for (const c of expressionClaims(db, m.ref)) {
        const k = `${c.label}|${c.date.lo_year}|${c.date.hi_year}`;
        if (seen.has(k)) continue;
        seen.add(k);
        claims.push(c);
      }
    }
    claims.sort((a, b) => (a.display === 'default' ? 0 : 1) - (b.display === 'default' ? 0 : 1) || (a.date.lo_year ?? 0) - (b.date.lo_year ?? 0));
    by[s.key] = { baseline, claims };
  }
  const first = Object.values(by).find((x) => x.baseline || x.claims.length) ?? null;
  return { baseline: first?.baseline ?? null, claims: first?.claims ?? [], by_strand: by };
}
