// OWNER: WP3
// washes.mjs — precision washes (SPEC §1.7, D2): matches in dated documents whose interval does not fit one bin
// of the tier. A wash is drawn across its whole interval and is never added to bars or rates; the conservation
// law Σ bin n + Σ wash n + undated + scheduled = total holds at every tier (tests/aggregate.binning.test.mjs).
//
// A wash overlapping several tiles is listed in each of them (so every tile draws it) with the same `key`; it is
// `owner: true` only in the tile holding its first bin — sum owners (or distinct keys) to count washes.

import { binOf, LEVELS, monthBinOfDay, yearLabel } from '../../src/shared/dates.mjs';
import { stmt } from '../db/open.mjs';
import { facetSql, laneKey, unitClassSql } from './lanes.mjs';
import { countValue, fitsTier, sliceWhere, srcCols, strandLangSpec, strandSource } from './query.mjs';

export const TILE_BINS = 64;
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/** Bin index of a day at a tier (L0–L3 by year, L4 month, L5 day). */
export function binOfDay(day, year, tier) {
  const level = TIERS.indexOf(tier);
  if (level <= 3) return binOf(year, level);
  return level === 4 ? monthBinOfDay(day) : day;
}

/**
 * Per lane × document rows of a strand for dated documents overlapping a bin range, with their intervals —
 * the input of washes (all tiers) and of bins at L4/L5.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {object} strand
 * @param {string} tier
 * @param {{b0: number, b1: number}} range bins at the tier
 * @param {{onlyUnbinned?: boolean}} [opts] L0–L3: only documents without a doc_bin row at the level
 * @returns {object[]}
 */
export function overlappingDocRows(db, def, strand, tier, { b0, b1 }, { onlyUnbinned = false } = {}) {
  const src = strandSource(strand, def);
  if (!src) return [];
  const level = TIERS.indexOf(tier);
  const cols = srcCols(def);
  const slice = sliceWhere(def, cols, strandLangSpec(strand));
  const nm = def.toggles.nm ? 1 : 0;
  let range, rangeParams;
  if (level <= 3) {
    const w = LEVELS[level].width;
    range = 'd.y_hi >= ? AND d.y_lo <= ?';
    rangeParams = [b0 * w, b1 * w + w - 1];
    if (onlyUnbinned) range += ' AND NOT EXISTS (SELECT 1 FROM doc_bin b WHERE b.document_id = d.id AND b.level = ?)';
    if (onlyUnbinned) rangeParams.push(level);
  } else {
    const [d0, d1] = dayRange(tier, b0, b1);
    range = 'd.hi_day >= ? AND d.lo_day <= ?';
    rangeParams = [d0, d1];
  }
  return stmt(db, `WITH src AS (${src.sql})
    SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc, e.document_id AS doc,
      SUM(e.n + ${nm} * e.n_names) AS v, SUM(e.n_names) AS names, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.precision,
      d.date_label, d.basis, d.author, d.is_synthetic AS syn, d.is_translation AS tr
    FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${slice.sql} AND d.chrono_status = 'dated' AND ${range}
    GROUP BY lv, uc, e.document_id`).all(...src.params, ...slice.params, ...rangeParams);
}

/**
 * Inclusive day range of bins [b0, b1] at L4 (months since year 0) or L5 (days).
 * @param {'L4'|'L5'} tier
 * @param {number} b0
 * @param {number} b1
 * @returns {[number, number]}
 */
export function dayRange(tier, b0, b1) {
  if (tier === 'L5') return [b0, b1];
  const startOfMonth = (mb) => {
    const y = Math.floor(mb / 12), m = mb - y * 12 + 1;
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, 1);
    return Math.floor(t.getTime() / 86400000);
  };
  return [startOfMonth(b0), startOfMonth(b1 + 1) - 1];
}

/**
 * Group non-fitting rows into washes. `n` follows the lane unit: matches (text) or works (titles).
 * @param {object} def
 * @param {object} strand
 * @param {string} tier
 * @param {object[]} rows overlappingDocRows output (fitting rows are skipped)
 * @returns {Array<{key: string, lane: string, strand: number|string, lo: string, hi: string, lo_day: number, hi_day: number,
 *   precision: string, label: string, n: number, docs: number, bin_lo: number, bin_hi: number, synthetic: boolean}>}
 */
export function groupWashes(def, strand, tier, rows) {
  const groups = new Map();
  for (const r of rows) {
    if (fitsTier(r, tier)) continue;
    const lane = laneKey(def.lanes.facet, r.lv, r.uc);
    const key = `${lane}|${strand.key}|${r.lo_day}|${r.hi_day}|${r.date_label}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, lane, uc: r.uc, strand: strand.type === 'expression' ? strand.ref : strand.key, lo: yearLabel(r.y_lo), hi: yearLabel(r.y_hi),
        lo_day: r.lo_day, hi_day: r.hi_day, precision: r.precision, label: r.date_label, rows: [], synthetic: false,
        bin_lo: binOfDay(r.lo_day, r.y_lo, tier), bin_hi: binOfDay(r.hi_day, r.y_hi, tier) };
      groups.set(key, g);
    }
    g.rows.push(r);
    if (r.syn) g.synthetic = true;
  }
  const out = [];
  for (const g of groups.values()) {
    const n = countValue(g.uc, g.rows);
    if (n === 0) continue;
    const { rows, uc, ...rest } = g;
    out.push({ ...rest, n, docs: rows.filter((r) => r.v > 0).length });
  }
  return out.sort((a, b) => a.lo_day - b.lo_day || a.hi_day - b.hi_day || a.lane.localeCompare(b.lane));
}

/**
 * Washes of every rate-able strand of a def over a bin range.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string} tier
 * @param {{b0: number, b1: number}} range
 * @returns {object[]}
 */
export function washesFor(db, def, tier, range) {
  const level = TIERS.indexOf(tier);
  const out = [];
  for (const strand of def.strands) {
    if (!strandSource(strand, def)) continue;
    // OpenAlex share lanes are never binned by calendar, so nothing washes there (C3)
    const rows = overlappingDocRows(db, def, strand, tier, range, { onlyUnbinned: level <= 3 }).filter((r) => r.uc !== 'cells');
    out.push(...groupWashes(def, strand, tier, rows));
  }
  return out;
}

/**
 * Washes for a query, tier and tile range (the "washes" shelf lists them). Read-query convention (§12.2):
 * runs in the read pool via ctx.pool.run(moduleUrl, 'washesQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, tier: string, b0: number, b1: number}} args
 * @returns {{washes: object[]}}
 */
export function washesQuery(db, { def, tier, b0, b1 }) {
  return { washes: washesFor(db, def, tier, { b0, b1 }) };
}
