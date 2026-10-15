// OWNER: WP3
// coverage.mjs — denominators and coverage per lane and bin (SPEC §1.2 denom_i, §1.7): how much of the record
// was looked at. A denominator counts doc_tokens (quality='ok' passages only) of the documents that FIT the bin,
// under exactly the slice of the numerator (query.sliceWhere) and the strand's languages; works lanes count
// documents. Undated and scheduled documents never enter a denominator (they have no doc_bin row).

import { LEVELS } from '../../src/shared/dates.mjs';
import { stmt } from '../db/open.mjs';
import { sliceDenominators } from './cube.mjs';
import { facetSql, laneKey, rowCols, unitClassSql } from './lanes.mjs';
import { fitsTier, sliceWhere } from './query.mjs';

/**
 * The lane expression of doc_tokens rows (alias t) for SQL denominators: on cluster lanes every group shares its unit
 * class's slice, filed under `~<unit class>` (query.denomKeyOf).
 */
const denomLaneSql = (def, cols) => (def.lanes.facet === 'cluster' ? 'NULL' : facetSql(def.lanes.facet, cols));
const denomLaneKey = (def, lv, uc) => (def.lanes.facet === 'cluster' ? `~${uc}` : laneKey(def.lanes.facet, lv, uc));
import { stepClass } from './rates.mjs';
import { binOfDay, dayRange } from './washes.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/**
 * Per-document denominator rows at L4/L5 (documents spanning ≤ 31 days that overlap the range), binned in JS.
 * @returns {object[]} rows {lv, uc, bin, doc, tokens, syn, tr}
 */
function dayDocRows(db, def, langs, tier, { b0, b1 }, docIds = null) {
  const cols = rowCols('t');
  const slice = sliceWhere(def, cols, langs);
  const [d0, d1] = dayRange(tier, b0, b1);
  const docFilter = docIds ? 'AND t.document_id IN (SELECT value FROM json_each(?))' : '';
  const rows = stmt(db, `SELECT ${denomLaneSql(def, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc, t.document_id AS doc,
      SUM(t.tokens) AS tokens, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.is_synthetic AS syn, d.is_translation AS tr
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${slice.sql} AND d.chrono_status = 'dated' AND d.hi_day >= ? AND d.lo_day <= ? AND d.hi_day - d.lo_day <= 30 ${docFilter}
    GROUP BY lv, uc, t.document_id`).all(...slice.params, d0, d1, ...(docIds ? [JSON.stringify(docIds)] : []));
  const out = [];
  for (const r of rows) {
    if (!fitsTier(r, tier)) continue;
    const bin = binOfDay(r.lo_day, r.y_lo, tier);
    if (bin < b0 || bin > b1) continue;
    out.push({ ...r, bin });
  }
  return out;
}

/**
 * Denominators per lane × bin: tokens and documents of the slice in the strand's languages, counted over
 * documents that fit the bin. Every bin of the tier is computed at once from the slice cube (cube.mjs, shared by
 * the read workers and kept per data version); a request then filters by range.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string[]|null} langs
 * @param {string} tier
 * @param {{b0: number, b1: number}} range bins at the tier
 * @returns {Map<string, {lane: string, uc: string, bin: number, tokens: number, docs: number, syn: number, tr: number}>}
 *   keyed `${lane}|${bin}`
 */
export function denominators(db, def, langs, tier, range) {
  const out = new Map();
  for (const [k, d] of sliceDenominators(db, def, langs, tier)) {
    if (d.bin >= range.b0 && d.bin <= range.b1) out.set(k, { ...d });
  }
  return out;
}

/**
 * Slice tokens of each matched document per lane × bin (the sizes of Gries' DP).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string[]|null} langs
 * @param {string} tier
 * @param {{b0: number, b1: number}} range
 * @param {number[]} docIds
 * @returns {Map<string, number>} keyed `${lane}|${bin}|${doc}`
 */
export function docSizes(db, def, langs, tier, range, docIds) {
  const out = new Map();
  if (!docIds.length) return out;
  const level = TIERS.indexOf(tier);
  let rows;
  if (level <= 3) {
    const cols = rowCols('t');
    const slice = sliceWhere(def, cols, langs);
    rows = stmt(db, `SELECT ${denomLaneSql(def, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc, b.bin AS bin,
        t.document_id AS doc, SUM(t.tokens) AS tokens
      FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      JOIN doc_bin b ON b.document_id = d.id AND b.level = ?
      WHERE ${slice.sql} AND b.bin BETWEEN ? AND ? AND t.document_id IN (SELECT value FROM json_each(?))
      GROUP BY lv, uc, b.bin, t.document_id`).all(level, ...slice.params, range.b0, range.b1, JSON.stringify(docIds));
  } else {
    rows = dayDocRows(db, def, langs, tier, range, docIds);
  }
  for (const r of rows) out.set(`${denomLaneKey(def, r.lv, r.uc)}|${r.bin}|${r.doc}`, r.tokens);
  return out;
}

/**
 * Coverage tuple of a denominator: [bin, works, docs, tokens, stepClass] (works lanes count works; text lanes
 * count tokens; step classes of §1.7).
 * @param {{uc: string, bin: number, tokens: number, docs: number}} d
 * @param {number} [binIndex] the bin index to print (index within its tile in tile payloads)
 * @returns {[number, number, number, number, number]}
 */
export function coverageTuple(d, binIndex = d.bin) {
  const isWorks = d.uc === 'titles' || d.uc === 'cells';
  const works = isWorks ? d.docs : 0;
  return [binIndex, works, d.docs, d.tokens, isWorks ? stepClass(works, 'works') : stepClass(d.tokens, 'tokens')];
}

/**
 * Coverage track for a query: per lane, [bin, works, docs, tokens, stepClass] for every bin with coverage, in
 * the union of the strands' languages. Read-query convention (§12.2): runs in the read pool via
 * ctx.pool.run(moduleUrl, 'coverageQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, tier: string, b0: number, b1: number, langs?: string[]|null}} args
 * @returns {{tier: string, binWidth: number|null, coverage: Record<string, number[][]>}}
 */
export function coverageQuery(db, { def, tier, b0, b1, langs = null }) {
  const coverage = {};
  for (const d of denominators(db, def, langs, tier, { b0, b1 }).values()) (coverage[d.lane] ??= []).push(coverageTuple(d));
  for (const list of Object.values(coverage)) list.sort((a, b) => a[0] - b[0]);
  const level = TIERS.indexOf(tier);
  return { tier, binWidth: level <= 3 ? LEVELS[level].width : null, coverage };
}
